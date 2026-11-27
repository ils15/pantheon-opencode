#!/usr/bin/env node
/**
 * verify-step-ledger-mutations.mjs — mutation evidence for the Step-Ledger gates.
 *
 * The S1 review rejected probe evidence that only lived in a chat transcript.
 * This script is the committed, re-runnable form: each mutant disables exactly
 * one mechanism in `step-dependencies.ts` / `step-ledger.ts` /
 * `ephemeral-merge.ts` and MUST turn a named test red. A mutant that survives
 * means the corresponding gate is not actually enforced by the suite.
 *
 * Usage:
 *   node scripts/verify-step-ledger-mutations.mjs
 *   node scripts/verify-step-ledger-mutations.mjs --runs 5 --only S3-token-check-removed
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
const HOOK = 'scripts/hooks/check-pantheon-runtime-staged.mjs'
const MERGE = 'src/pantheon/ephemeral-merge.ts'
const MERGE_SLICE = 'tests/pantheon/ephemeral-merge.test.ts'

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
        // Anchored on the whole function head: `acquireLedgerLock(lockPath)` also
        // appears in `restoreLedgerSnapshotUnderLock`, so the bare line stops
        // being unique as soon as another lock helper exists.
        from: 'export function updateStepLedger<T>(\n  workspaceDir: string,\n  mutator: (store: StepLedgerStore) => T,\n): T {\n  const filePath = resolveLedgerPath(workspaceDir)\n  const lockPath = resolveLockPath(filePath)\n  const token = acquireLedgerLock(lockPath)',
        // The token literal is split so this shipped script never looks like a
        // credential to `scripts/redaction-gate.mjs` (which scans the tarball).
        to: "export function updateStepLedger<T>(\n  workspaceDir: string,\n  mutator: (store: StepLedgerStore) => T,\n): T {\n  const filePath = resolveLedgerPath(workspaceDir)\n  const lockPath = resolveLockPath(filePath)\n  const token = 'mutant' + '-no-lock'",
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
  {
    id: 'F1-anchor-removed',
    description: 'init_step stops anchoring the baseline, so GC can prune it',
    expect: 'F1 an anchored baseline survives',
    edits: [
      {
        file: LEDGER,
        from: '          const anchor =\n            ckpt.ok && ckpt.treeHash\n              ? await anchorCheckpointTree(cwd, ckpt.treeHash, key)\n              : undefined',
        to: '          const anchor = undefined',
      },
    ],
  },
  {
    id: 'F1-missing-baseline-check-removed',
    description: 'rollback no longer detects a pruned baseline',
    expect: 'F1 a pruned baseline fails loudly',
    edits: [
      {
        file: LEDGER,
        from: '          if (!(await checkpointTreeExists(cwd, step.baselineTree))) {',
        to: '          if (false) {',
      },
    ],
  },
  {
    id: 'F2-exact-name-predicate-reverted',
    description: 'the runtime-state predicate only matches `.pantheon/` children',
    expect: 'F2 the runtime-state predicate matches the exact',
    edits: [
      {
        file: CHECKPOINT,
        from: "  return rel === '.pantheon' || rel.startsWith('.pantheon/')",
        to: "  return rel.startsWith('.pantheon/')",
      },
    ],
  },
  {
    id: 'F4-nested-runtime-root-check-removed',
    description: 'a nested .pantheon/ under an exception prefix is no longer rejected',
    expect: 'F8 exceptions are segment-bounded',
    slice: 'tests/pantheon/precommit-runtime-guard.test.mjs',
    edits: [
      {
        file: HOOK,
        from: "  return path.split('/').slice(1).includes(RUNTIME_ROOT)",
        to: '  return false',
      },
    ],
  },
  {
    id: 'F5-key-encoding-removed',
    description: 'ref names fall back to lossy sanitization (auth:1 collides with auth_1)',
    expect: 'F5 ref names are injective',
    edits: [
      {
        file: CHECKPOINT,
        from: `  const readable = stepKey.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 96) || 'step'\n  const digest = createHash('sha256').update(stepKey).digest('hex').slice(0, 12)\n  return \`\${BASELINE_REF_PREFIX}\${readable}-\${digest}\``,
        to: `  return \`\${BASELINE_REF_PREFIX}\${stepKey.replace(/[^a-zA-Z0-9._-]/g, '_')}\``,
      },
    ],
  },
  {
    id: 'F8-floor-removed',
    description: 'the guard falls back to git-only policy (open when .gitignore says nothing)',
    expect: 'F8 the floor blocks runtime state with no .gitignore',
    slice: 'tests/pantheon/precommit-runtime-guard.test.mjs',
    edits: [
      {
        file: HOOK,
        from: "  if (matchesException(path) && !ignoredPaths.has(path)) return 'allowed'\n  return 'blocked'",
        to: "  if (matchesException(path) && !ignoredPaths.has(path)) return 'allowed'\n  return ignoredPaths.has(path) ? 'blocked' : 'allowed'",
      },
    ],
  },
  // --- S3: protected ephemeral merge (ephemeral-merge.ts) -------------------
  {
    id: 'S3-token-check-removed',
    description: 'merge_ephemeral apply accepts any (or no) confirmToken',
    slice: MERGE_SLICE,
    expect:
      'S3-6 apply requires a token that is single-use, expiring, and invalid after any change',
    edits: [
      {
        file: MERGE,
        from: '  const verdict = validateToken(storeKey, input.confirmToken, computedToken, now)\n  if (!verdict.ok) {',
        to: '  const verdict = validateToken(storeKey, input.confirmToken, computedToken, now)\n  if (!verdict.ok && false) {',
      },
    ],
  },
  {
    id: 'S3-single-use-removed',
    description: 'a merge token is never burned, so it stays usable forever',
    slice: MERGE_SLICE,
    expect: 'S3-A2 two concurrent applies with one token: exactly one wins',
    edits: [
      {
        file: MERGE,
        // Anchored on the apply-path indentation: the discard path burns its own
        // token with the same two lines at a shallower indent.
        from: '        const record = tokenStore().get(storeKey)\n        if (record) record.consumed = true',
        to: '        const record = tokenStore().get(storeKey)\n        if (record) void record',
      },
    ],
  },
  {
    id: 'S3-drift-check-removed',
    description: 'apply ignores HEAD drift past ephemeral.baseHead',
    slice: MERGE_SLICE,
    expect: 'S3-2 apply refuses head_drift and leaves git status byte-identical',
    edits: [
      {
        file: MERGE,
        from: "  if (headDrift) {\n    return refuse(base, 'head_drift', {",
        to: "  if (headDrift && false) {\n    return refuse(base, 'head_drift', {",
      },
    ],
  },
  {
    id: 'S3-lease-check-removed',
    description: 'apply ignores dirty/lease/branch overlaps',
    slice: MERGE_SLICE,
    expect:
      "S3-4 apply refuses a second live pantheon/eph branch on the same file (source:'branch')",
    edits: [
      {
        file: MERGE,
        from: "  if (leaseConflicts.length > 0) {\n    return refuse(base, 'lease_conflict', {",
        to: "  if (leaseConflicts.length > 0 && false) {\n    return refuse(base, 'lease_conflict', {",
      },
    ],
  },
  {
    id: 'S3-recovery-reset-removed',
    description: 'recovery skips `git reset --merge`, leaving an unmerged index behind',
    slice: MERGE_SLICE,
    expect:
      'S3-5b an injected mid-apply conflict is aborted and the tree is restored byte-identically',
    edits: [
      {
        file: MERGE,
        from: "  const reset = await git(root, ['reset', '--merge'])\n  resetApplied = reset.ok",
        to: "  const reset = await git(root, ['rev-parse', 'HEAD'])\n  resetApplied = reset.ok",
      },
    ],
  },
  {
    id: 'S3-recovery-restore-skipped',
    description: 'recovery trusts `git reset --merge` and never restores the checkpoint',
    slice: MERGE_SLICE,
    expect:
      'S3-5b an injected mid-apply conflict is aborted and the tree is restored byte-identically',
    edits: [
      {
        file: MERGE,
        from: '      const restore = await restoreGitCheckpoint(root, preMerge.treeHash)',
        to: '      const restore = { ok: true, reason: undefined }',
      },
    ],
  },
  {
    id: 'S3-unstage-skipped',
    description: 'apply leaves the squash staged instead of review-first (D05)',
    slice: MERGE_SLICE,
    expect:
      'S3-A1 apply leaves the squash unstaged, records ephemeral metadata, emits step:merge, and keeps the branch',
    edits: [
      {
        file: MERGE,
        from: "    const unstaged = await git(root, ['reset'])",
        to: "    const unstaged = await git(root, ['status'])",
      },
    ],
  },
  // --- review round 2: B1 ref resolution, B2 foreign merge, B3 ledger write --
  {
    id: 'B1-symbolic-guard-removed',
    description: 'a short branch name shadowed by a tag is accepted instead of refused',
    slice: MERGE_SLICE,
    expect: 'S3-B1 a same-named tag or refs/pantheon ref is refused, never merged',
    edits: [
      {
        file: MERGE,
        from: '  if (!branchSymbolic.ok || branchSymbolic.stdout.trim() !== branchRef) {',
        to: '  if (false && branchSymbolic.ok) {',
      },
    ],
  },
  {
    id: 'B1-short-ref-merge',
    description: 'the squash re-resolves the ref instead of the reviewed sha (force-push wins)',
    slice: MERGE_SLICE,
    expect: 'S3-B1c a force-push inside the merge window still merges the reviewed sha',
    edits: [
      {
        file: MERGE,
        from: "        const merge = await git(root, ['merge', '--squash', '--no-edit', branchSha])",
        to: "        const merge = await git(root, ['merge', '--squash', '--no-edit', branchRef])",
      },
    ],
  },
  {
    id: 'B2-preflight-merge-state-ignored',
    description: 'apply no longer notices that a foreign merge is in progress',
    slice: MERGE_SLICE,
    expect: 'S3-B2 apply refuses merge_in_progress and leaves the user merge untouched',
    edits: [
      {
        file: MERGE,
        from: '  const mergeInProgress = mergeStateBefore.mergeHead || mergeStateBefore.mergeMsg',
        to: '  const mergeInProgress = false && (mergeStateBefore.mergeHead || mergeStateBefore.mergeMsg)',
      },
    ],
  },
  {
    id: 'B2-foreign-abort-restored',
    description: 'recovery proceeds on a MERGE_HEAD it does not own (resets the user merge)',
    slice: MERGE_SLICE,
    expect: 'S3-5e recovery leaves a merge it does not own completely untouched',
    edits: [
      {
        file: MERGE,
        from: '  if (stateBefore.mergeHead) {',
        to: '  if (false) {',
      },
    ],
  },
  {
    id: 'B3-metadata-write-uncaught',
    description: 'a ledger write failure after the squash escapes instead of being reported',
    slice: MERGE_SLICE,
    expect: 'S3-B3 a ledger write failure after the squash still reports the merge as landed',
    edits: [
      {
        file: MERGE,
        from: '  } catch (err: unknown) {\n    const structured = describeLedgerError(err)',
        to: '  } catch (err: unknown) {\n    throw err\n    const structured = describeLedgerError(err)',
      },
    ],
  },
  {
    id: 'S1-status-fail-open',
    description: 'an unreadable git status is reported as an empty (clean) tree again',
    slice: MERGE_SLICE,
    expect: 'S3-S1 an unreadable git status refuses instead of reporting a clean tree',
    edits: [
      {
        file: MERGE,
        from: "  if (!res.ok) {\n    return { ok: false, reason: unavailableReason('git status', res) }\n  }",
        to: '  if (!res.ok) {\n    return { ok: true, value: [] }\n  }',
      },
    ],
  },
  {
    id: 'S2-merge-lock-stale-break',
    description:
      'the merge lock reverts to the ledger rule (2 s stale break, no liveness, no heartbeat)',
    slice: MERGE_SLICE,
    expect: 'S3-L1 two processes cannot share the merge window, and neither erases the other',
    edits: [
      {
        file: MERGE,
        from: 'const MERGE_LOCK_STALE_MS = 10 * 60 * 1000',
        to: 'const MERGE_LOCK_STALE_MS = 2_000',
      },
      {
        file: MERGE,
        from: '    if (ownerPid !== undefined && !pidIsAlive(ownerPid)) {',
        to: '    if (false) {',
      },
      {
        file: MERGE,
        from: '      const timer = setInterval(() => {\n',
        to: '      const timer = setInterval(() => {\n        return\n',
      },
    ],
  },
  {
    id: 'S2-merge-lock-liveness-removed',
    description: 'a dead lock owner is no longer detected, so its lock waits for the stale timeout',
    slice: MERGE_SLICE,
    expect: "S3-L3 a dead holder's lock is reclaimed immediately, not after the stale timeout",
    edits: [
      {
        file: MERGE,
        from: '    if (ownerPid !== undefined && !pidIsAlive(ownerPid)) {',
        to: '    if (false) {',
      },
    ],
  },
  {
    id: 'S3-lock-ownership-reverify-removed',
    description:
      'the post-window ownership check always passes, so an evicted writer reports success',
    slice: MERGE_SLICE,
    expect: 'S3-L2 an evicted writer aborts with lock_lost instead of reporting success',
    edits: [
      {
        file: MERGE,
        from: '  if (mergeLockToken(handle.path) === handle.token) return',
        to: '  if (mergeLockToken(handle.path) === handle.token || true) return',
      },
    ],
  },
  {
    id: 'B1-sha-not-in-token',
    description:
      'the token ignores the reviewed commit sha (a same-content force-push stays valid)',
    slice: MERGE_SLICE,
    expect: 'S3-B1d a same-content force-push before apply invalidates the token (sha binding)',
    edits: [
      {
        file: MERGE,
        from: '        fingerprint.branchSha,\n',
        to: '',
      },
    ],
  },
  {
    id: 'S1-refname-short-reverted',
    description: 'the other-branch scan uses %(refname:short), so a shadowing tag disables it',
    slice: MERGE_SLICE,
    expect: 'S3-B1e a tag shadowing another live branch does not disable the overlap gate',
    edits: [
      {
        file: MERGE,
        from: "    '--format=%(refname)',",
        to: "    '--format=%(refname:short)',",
      },
    ],
  },
  {
    id: 'S2-reverify-removed',
    description: 'the queued apply no longer re-checks HEAD inside the lock',
    slice: MERGE_SLICE,
    expect: 'S3-S2b a writer that moved HEAD while queued is detected before the merge',
    edits: [
      {
        file: MERGE,
        from: '        if (headSeen !== headNow) {',
        to: '        if (false && headSeen !== headNow) {',
      },
    ],
  },
  {
    id: 'S3-preview-token-deferred',
    description: 'the token is minted only after a successful preview, so discard can deadlock',
    slice: MERGE_SLICE,
    expect: 'S3-S3 a preview that cannot run still mints the token discard needs',
    edits: [
      {
        file: MERGE,
        from: "  if (mode === 'preview') {\n    tokenStore().set(storeKey, {",
        to: "  if (false && mode === 'preview') {\n    tokenStore().set(storeKey, {",
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

function runSlice(slice = SLICE) {
  try {
    return execFileSync(process.execPath, [TSX, slice], {
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

console.log(
  `Running ${selected.length} mutant(s) x ${options.runs} run(s) against each mutant's slice\n`,
)

for (const mutant of selected) {
  let originals = new Map()
  try {
    // Disk backup so a hard crash still leaves a recoverable copy next to the repo.
    const firstFile = join(root, mutant.edits[0].file)
    copyFileSync(firstFile, backupPath)
    originals = applyEdits(mutant)
    for (let run = 1; run <= options.runs; run += 1) {
      const output = runSlice(mutant.slice)
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
