#!/usr/bin/env node
/**
 * verify-step-ledger-mutations.mjs — mutation evidence for the Step-Ledger gates.
 *
 * The S1 review rejected probe evidence that only lived in a chat transcript.
 * This script is the committed, re-runnable form: each mutant disables exactly
 * one mechanism in `step-dependencies.ts` / `step-ledger.ts` and MUST turn a
 * named test red. A mutant that survives means the corresponding gate is not
 * actually enforced by the suite.
 *
 * Usage:
 *   node scripts/verify-step-ledger-mutations.mjs
 *   node scripts/verify-step-ledger-mutations.mjs --runs 5 --only lock-bypass
 *
 * It temporarily rewrites the source file(s), runs the narrow slice, restores
 * the original bytes in a `finally`, and exits non-zero if any expectation
 * fails. Never touches `git`, never runs a global suite.
 */

import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SLICE = 'tests/pantheon/step-ledger-dependencies.test.ts'
const TSX = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs')

const LEDGER = 'src/pantheon/step-ledger.ts'
const DEPS = 'src/pantheon/step-dependencies.ts'
const CHECKPOINT = 'src/pantheon/git-checkpoint.ts'

/**
 * @type {Array<{
 *   id: string,
 *   description: string,
 *   /** Named test that must go red, or `null` when another layer must absorb the mutant. *\/
 *   expect: string | null,
 *   edits: Array<{file: string, from: string, to: string}>,
 * }>}
 */
const MUTANTS = [
  {
    id: 'validation-disabled',
    description: 'dependency validation always passes',
    expect: 'S1-1 rejects unknown and self dependencies',
    edits: [{ file: DEPS, from: 'ok: issues.length === 0,', to: 'ok: true,' }],
  },
  {
    id: 'init-never-pending',
    description: 'init_step ignores unmet dependencies and always starts in_progress',
    expect: 'S1-2 status.graph.ready',
    edits: [
      {
        file: LEDGER,
        from: "const state: StepState =\n              deps.length > 0 && unmetDeps.length > 0 ? 'pending' : 'in_progress'",
        to: "const state: StepState = 'in_progress'",
      },
    ],
  },
  {
    id: 'launch-gate-removed',
    description: 'execute_step skips both the pre-read gate and the atomic claim re-check',
    expect: 'S1-4 execute_step and spawn_ephemeral refuse',
    edits: [
      {
        file: LEDGER,
        from: 'if (!launchGate.ok) return jsonResult({ ...launchGate, stepKey: key })',
        to: '',
      },
      {
        file: LEDGER,
        from: 'if (!gate.ok) return { ok: false as const, gate }',
        to: '',
      },
    ],
  },
  {
    id: 'cascade-refusal-inverted',
    description: 'rollback never refuses on done dependents',
    expect: 'S1-5 rollback refuses done dependents',
    edits: [
      {
        file: LEDGER,
        from: 'if (preflightDone.length > 0 && !cascade) {',
        to: 'if (preflightDone.length > 0 && cascade) {',
      },
      {
        file: LEDGER,
        from: "if (decision.kind === 'refused') {",
        to: "if (decision.kind === 'impossible') {",
      },
      {
        file: LEDGER,
        from: 'if (lateDone.length > 0 && !cascade) {',
        to: 'if (lateDone.length > 0 && cascade) {',
      },
    ],
  },
  {
    id: 'lock-bypass',
    description: 'updateStepLedger writes without acquiring the lock',
    expect: 'S1-6 two concurrent updateStepLedger writers',
    edits: [
      {
        file: LEDGER,
        from: 'const token = acquireLedgerLock(lockPath)',
        to: "const token = 'mutant:no-lock'",
      },
    ],
  },
  {
    id: 'dedupe-removed',
    description: 'normalizeDependencies keeps duplicate declarations',
    expect: 'S1-7 dedupes dependencies',
    edits: [
      {
        file: DEPS,
        from: 'if (!key || RESERVED_KEYS.has(key) || seen.has(key)) continue',
        to: 'if (!key || RESERVED_KEYS.has(key)) continue',
      },
    ],
  },
  {
    id: 'verification-failures-removed',
    description: 'failed verifications are no longer counted separately',
    expect: 'S1-7 dedupes dependencies',
    edits: [
      {
        file: LEDGER,
        from: 'if (exitCode !== 0) {\n              entry.verificationFailures = (entry.verificationFailures ?? 0) + 1\n            }',
        to: '',
      },
    ],
  },
  {
    id: 'complete-gate-removed',
    description: 'complete_step no longer requires declared dependencies to be done',
    expect: 'C3 a cascade-blocked dependent',
    edits: [
      {
        file: LEDGER,
        from: "if (unmet.length > 0) {\n              return { kind: 'unmet' as const, unmet, step: entry }\n            }\n            const gate = canTransitionStepToDone(entry)",
        to: 'const gate = canTransitionStepToDone(entry)',
      },
    ],
  },
  {
    id: 'late-refusal-compensation-skipped',
    description: 'a late refusal after the restore leaves the tree rolled back (no compensation)',
    expect: 'R-a late refusal',
    edits: [
      {
        file: LEDGER,
        from: "            const compensation = await preserveLedgerBytes(cwd, () =>\n              compensateRollbackTree(cwd, preRollback),\n            )\n            return jsonResult({\n              ok: false,\n              error: 'dependents_done',",
        to: "            const compensation = { restored: false }\n            return jsonResult({\n              ok: false,\n              error: 'dependents_done',",
      },
    ],
  },
  {
    id: 'post-restore-missing-compensation-skipped',
    description: 'a step that vanishes mid-rollback leaves the tree rolled back (no compensation)',
    expect: 'R-a post-restore missing entry',
    edits: [
      {
        file: LEDGER,
        from: `            const compensation = await preserveLedgerBytes(cwd, () =>\n              compensateRollbackTree(cwd, preRollback),\n            )\n            return jsonResult({\n              ok: false,\n              error: \`Step "\${key}" is not initialized\`,`,
        to: `            const compensation = { restored: false }\n            return jsonResult({\n              ok: false,\n              error: \`Step "\${key}" is not initialized\`,`,
      },
    ],
  },
  {
    id: 'lock-owner-reverify-removed',
    description: 'a writer whose lock was evicted still commits its mutation',
    expect: 'M2/M4 the lock is owner-checked',
    edits: [
      {
        file: LEDGER,
        from: '    assertLockStillOwned(lockPath, token)\n',
        to: '',
      },
    ],
  },
  {
    id: 'both-ledger-restore-protections-removed',
    description:
      'checkpoints capture .pantheon again AND the primary restore is unprotected (the reviewer repro)',
    expect: 'D1 rollback keeps every ledger step',
    edits: [
      {
        file: CHECKPOINT,
        from: "    await runGit(root, ['add', '-A'], { GIT_INDEX_FILE: tmpIndex })\n    // `.pantheon/` is runtime state, never work-tree state: a checkpoint must\n    // not capture the ledger (or board/memory/deepwork) it would later restore.\n    await dropPantheonRuntimeState(root, tmpIndex)\n",
        to: "    await runGit(root, ['add', '-A'], { GIT_INDEX_FILE: tmpIndex })\n",
      },
      {
        file: CHECKPOINT,
        from: "    await runGit(root, ['read-tree', treeHash], { GIT_INDEX_FILE: tmpIndex })\n    await dropPantheonRuntimeState(root, tmpIndex)\n",
        to: "    await runGit(root, ['read-tree', treeHash], { GIT_INDEX_FILE: tmpIndex })\n",
      },
      {
        file: LEDGER,
        from: 'const rb = await preserveLedgerBytes(cwd, () => restoreGitCheckpoint(cwd, baselineTree))',
        to: 'const rb = await restoreGitCheckpoint(cwd, baselineTree)',
      },
    ],
  },
  {
    id: 'primary-restore-ledger-preservation-removed',
    description:
      'the primary restore loses its byte-preservation (the checkpoint exclusion still protects)',
    expect: null,
    edits: [
      {
        file: LEDGER,
        from: 'const rb = await preserveLedgerBytes(cwd, () => restoreGitCheckpoint(cwd, baselineTree))',
        to: 'const rb = await restoreGitCheckpoint(cwd, baselineTree)',
      },
    ],
  },
  {
    id: 'checkpoint-includes-pantheon',
    description:
      'checkpoints and restores handle .pantheon again (the D1 tree assertion catches it)',
    expect: 'D1 rollback keeps every ledger step',
    edits: [
      {
        file: CHECKPOINT,
        from: "    await runGit(root, ['add', '-A'], { GIT_INDEX_FILE: tmpIndex })\n    // `.pantheon/` is runtime state, never work-tree state: a checkpoint must\n    // not capture the ledger (or board/memory/deepwork) it would later restore.\n    await dropPantheonRuntimeState(root, tmpIndex)\n",
        to: "    await runGit(root, ['add', '-A'], { GIT_INDEX_FILE: tmpIndex })\n",
      },
      {
        file: CHECKPOINT,
        from: "    await runGit(root, ['read-tree', treeHash], { GIT_INDEX_FILE: tmpIndex })\n    await dropPantheonRuntimeState(root, tmpIndex)\n",
        to: "    await runGit(root, ['read-tree', treeHash], { GIT_INDEX_FILE: tmpIndex })\n",
      },
    ],
  },
  {
    id: 'L1-restore-pantheon-exclusion-removed',
    description: 'restore applies .pantheon/ from a legacy checkpoint again',
    expect: 'L1 a legacy checkpoint cannot roll back',
    edits: [
      {
        file: CHECKPOINT,
        from: "    await runGit(root, ['read-tree', treeHash], { GIT_INDEX_FILE: tmpIndex })\n    await dropPantheonRuntimeState(root, tmpIndex)\n    await runGit(root, ['checkout-index', '--all', '--force'], { GIT_INDEX_FILE: tmpIndex })",
        to: "    await runGit(root, ['read-tree', treeHash], { GIT_INDEX_FILE: tmpIndex })\n    await runGit(root, ['checkout-index', '--all', '--force'], { GIT_INDEX_FILE: tmpIndex })",
      },
    ],
  },
  {
    id: 'L2-capture-pantheon-exclusion-removed',
    description: 'capture includes .pantheon/ again',
    expect: 'L2 capture excludes .pantheon',
    edits: [
      {
        file: CHECKPOINT,
        from: "    await runGit(root, ['add', '-A'], { GIT_INDEX_FILE: tmpIndex })\n    // `.pantheon/` is runtime state, never work-tree state: a checkpoint must\n    // not capture the ledger (or board/memory/deepwork) it would later restore.\n    await dropPantheonRuntimeState(root, tmpIndex)\n",
        to: "    await runGit(root, ['add', '-A'], { GIT_INDEX_FILE: tmpIndex })\n",
      },
    ],
  },
  {
    id: 'L3-scrub-strip-removed',
    description: 'the scrub reports every legacy checkpoint as already clean',
    expect: 'L3 scrub rewrites legacy checkpoints',
    edits: [
      {
        file: CHECKPOINT,
        from: '    if (!(await treeContainsPantheon(root, treeHash))) {',
        to: '    if (true) {',
      },
    ],
  },
]

function parseArgs(argv) {
  const options = { runs: 1, only: undefined }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--runs') options.runs = Math.max(1, Number(argv[i + 1] ?? 1) || 1)
    if (arg === '--only') options.only = argv[i + 1]
  }
  return options
}

function runSlice() {
  try {
    return execFileSync(process.execPath, [TSX, SLICE], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
    })
  } catch (err) {
    return `${err.stdout ?? ''}${err.stderr ?? ''}`
  }
}

function applyEdits(mutant) {
  const originals = new Map()
  // Phase 1: read every target and validate every anchor before writing a
  // single byte, so a bad mutant can never leave a partial mutation behind.
  for (const edit of mutant.edits) {
    const path = join(root, edit.file)
    if (!originals.has(path)) originals.set(path, readFileSync(path, 'utf8'))
    if (!originals.get(path).includes(edit.from)) {
      throw new Error(`[${mutant.id}] anchor not found in ${edit.file}: ${edit.from.slice(0, 70)}`)
    }
  }
  // Phase 2: apply in memory, then flush.
  const updated = new Map(originals)
  for (const edit of mutant.edits) {
    const path = join(root, edit.file)
    const current = updated.get(path) ?? ''
    const index = current.indexOf(edit.from)
    updated.set(path, current.slice(0, index) + edit.to + current.slice(index + edit.from.length))
  }
  for (const [path, content] of updated) writeFileSync(path, content)
  return originals
}

function restore(originals) {
  for (const [path, content] of originals) writeFileSync(path, content)
}

const options = parseArgs(process.argv.slice(2))
const selected = options.only ? MUTANTS.filter((mutant) => mutant.id === options.only) : MUTANTS
if (selected.length === 0) {
  console.error(`No mutant matches --only ${String(options.only)}`)
  process.exit(2)
}

const backupPath = join(root, '.step-ledger-mutation-backup')
let failures = 0

console.log(`Running ${selected.length} mutant(s) x ${options.runs} run(s) against ${SLICE}\n`)

for (const mutant of selected) {
  let originals = new Map()
  try {
    // Disk backup so a hard crash still leaves a recoverable copy next to the repo.
    const firstFile = join(root, mutant.edits[0].file)
    copyFileSync(firstFile, backupPath)
    originals = applyEdits(mutant)
    for (let run = 1; run <= options.runs; run += 1) {
      const output = runSlice()
      if (!/ℹ (tests|pass) \d/.test(output)) {
        failures += 1
        console.log(`FAIL  ${mutant.id} [run ${run}] — mutant crashed, expectation unproven`)
        console.log(`      ${output.trim().split('\n').slice(-4).join(' / ')}`)
        continue
      }
      // `expect: null` marks a redundancy check: another layer must absorb this
      // mutant, so the slice has to stay green.
      const caught =
        mutant.expect === null ? !/^✖ /m.test(output) : output.includes(`✖ ${mutant.expect}`)
      if (caught) {
        console.log(
          `ok    ${mutant.id} [run ${run}] — ${mutant.description} => ${
            mutant.expect === null ? 'absorbed (slice stayed green)' : `red: ${mutant.expect}`
          }`,
        )
      } else {
        failures += 1
        console.log(
          `FAIL  ${mutant.id} [run ${run}] — ${mutant.description} ${
            mutant.expect === null
              ? 'was NOT absorbed by the other layer'
              : `did NOT break ${mutant.expect}`
          }`,
        )
      }
    }
  } catch (err) {
    failures += 1
    console.log(`FAIL  ${mutant.id} — ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    if (originals.size > 0) restore(originals)
    rmSync(backupPath, { force: true })
  }
}

console.log(
  failures === 0
    ? `\nAll ${selected.length} mutant(s) were caught by their named assertion.`
    : `\n${failures} mutation check(s) failed — a gate is not enforced by the suite.`,
)
process.exit(failures === 0 ? 0 : 1)
