/**
 * guardrails-doctor.test.mjs — the five "green while broken" preconditions are
 * executable, and each one is proven to FAIL on a seeded defect.
 *
 * Why the assertions are shaped this way: a check that never ran also produces
 * no failure, so every test below seeds a real defect in a throwaway repo and
 * asserts the SPECIFIC finding (id + status + evidence), never a bare non-zero
 * exit code that an unrelated check could supply. The doctor-level tests prove
 * the checks are wired into the real entry point: a provisioned repo must come
 * back PASS, a repo with the exact v1.0→2.3.4 defect must come back as a
 * blocking error, and a repo where hooks were never installed must come back
 * as a non-blocking warn. None of them assert against the ambient checkout —
 * see the note above the provisioned-checkout doctor test.
 *
 * Run: node --test tests/guardrails-doctor.test.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveRuntimePython } from '../scripts/doctor.mjs'
import {
  classifyWorktreeCollisions,
  collectGuardrailFindings,
  EPHEMERAL_MERGE_LOCK_REL,
  EPHEMERAL_MERGE_LOCK_STALE_MS,
  IGNORE_PROBE_PATHS,
  INDEX_LOCK_STALE_MS,
  inspectHookReachability,
  inspectIgnorePrecondition,
  inspectRuntimeLocks,
  inspectSharedCheckout,
  parseLockToken,
  STEP_LEDGER_LOCK_REL,
  STEP_LEDGER_LOCK_STALE_MS,
} from '../scripts/guardrails.mjs'
import { REQUIRED_HOOKS } from '../scripts/verify-git-hooks.mjs'
import { provisionCheckout } from './helpers/provisioned-checkout.mjs'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const GUARDRAILS_CLI = join(REPO_ROOT, 'scripts', 'guardrails.mjs')
const DOCTOR_CLI = join(REPO_ROOT, 'scripts', 'doctor.mjs')

/** Doctor resolves the user config from HOME; isolate it like the repo's other doctor tests. */
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'pantheon-guardrails-home-'))
const RUNTIME_PYTHON = resolveRuntimePython({ target: REPO_ROOT, env: process.env })

/**
 * Above `/proc/sys/kernel/pid_max` on Linux (4194304), so `kill(pid, 0)` can
 * never succeed: a deterministically dead lock owner.
 */
const DEAD_PID = 4_194_303

const fixtures = []
after(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true })
  rmSync(ISOLATED_HOME, { recursive: true, force: true })
})

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}

/**
 * A throwaway git repo with the given hook wiring, inside its own container so
 * linked worktrees can be siblings and are removed with it. Hooks are created
 * AFTER the initial commit, so the fixture commit never runs a hook under test.
 *
 * @param {object} options
 * @param {string|null} options.hooksPath value for `core.hooksPath` (null = unset)
 * @param {string} options.hooksDir      directory that receives the hook files
 * @param {string[]} options.hooks       hook names to create
 * @param {boolean} options.executable   whether the created hooks are executable
 * @param {string|null} options.gitignore `.gitignore` contents (null = no file)
 */
function makeRepo({
  hooksPath = '.husky',
  hooksDir = '.husky',
  hooks = REQUIRED_HOOKS,
  executable = true,
  gitignore = '.pantheon/\n',
} = {}) {
  const container = mkdtempSync(join(tmpdir(), 'pantheon-guardrails-'))
  fixtures.push(container)
  const root = join(container, 'repo')
  mkdirSync(root)
  git(['init', '--quiet'], root)
  git(['config', 'user.email', 'test@pantheon.dev'], root)
  git(['config', 'user.name', 'Pantheon Test'], root)
  if (gitignore !== null) writeFileSync(join(root, '.gitignore'), gitignore)
  writeFileSync(join(root, 'README.md'), '# fixture\n')

  // Hooks are TRACKED (like .husky in this repository) and committed before
  // core.hooksPath is set, so the fixture commit runs no hook under test and
  // the fixture stays clean for the shared-checkout assertion.
  if (hooks.length > 0) mkdirSync(join(root, hooksDir), { recursive: true })
  for (const hook of hooks) {
    const file = join(root, hooksDir, hook)
    writeFileSync(file, '#!/usr/bin/env sh\nexit 0\n')
    chmodSync(file, executable ? 0o755 : 0o644)
  }
  git(['add', '-A'], root)
  git(['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'chore: fixture'], root)

  if (hooksPath !== null) git(['config', 'core.hooksPath', hooksPath], root)
  return root
}

function finding(findings, id, code) {
  const match = findings.filter(
    (item) => item.id === id && (code === undefined || item.code === code),
  )
  assert.equal(
    match.length,
    1,
    `expected exactly one "${id}"${code ? ` (${code})` : ''} finding, got ${JSON.stringify(findings)}`,
  )
  return match[0]
}

function writeLock(repo, relPath, contents, ageMs = 0) {
  const lockPath = join(repo, relPath)
  mkdirSync(dirname(lockPath), { recursive: true })
  writeFileSync(lockPath, contents)
  if (ageMs > 0) {
    const stamp = new Date(Date.now() - ageMs)
    utimesSync(lockPath, stamp, stamp)
  }
  return lockPath
}

// ---------------------------------------------------------------------------
// 1. Hook reachability — the defect this session actually hit
// ---------------------------------------------------------------------------

test('the healthy wiring passes: git resolves the tracked hooks dir and can exec both hooks', () => {
  const repo = makeRepo()
  const result = inspectHookReachability({ cwd: repo })
  assert.equal(result.status, 'pass', JSON.stringify(result))
  assert.match(result.detail, /\.husky/)
  assert.match(result.fix, /npm run hooks:install/)
})

test('the v1.0→2.3.4 defect fails: core.hooksPath points at a directory that does not exist', () => {
  // Exactly the shipped bug: .husky/_ is generated/untracked, so a linked
  // worktree materialises nothing there and git skips every hook silently.
  const repo = makeRepo({ hooksPath: '.husky/_', hooksDir: '.husky' })
  const result = inspectHookReachability({ cwd: repo })
  assert.equal(result.status, 'fail', 'a missing hooks dir must never be green')
  assert.match(result.detail, /does not exist/)
  assert.match(result.detail, /\.husky\/_/)
  assert.match(result.fix, /^npm run hooks:install$/, 'the failure must name the exact fix')
})

test('a non-executable hook fails: presence is not runnability', () => {
  const repo = makeRepo({ executable: false })
  const result = inspectHookReachability({ cwd: repo })
  assert.equal(result.status, 'fail')
  assert.match(result.detail, /not executable/)
})

test('a missing required hook fails even when the directory exists', () => {
  const repo = makeRepo({ hooks: ['commit-msg'] })
  const result = inspectHookReachability({ cwd: repo })
  assert.equal(result.status, 'fail')
  assert.match(result.detail, /missing hook: .*pre-commit/)
})

test('unset core.hooksPath is reachable when .git/hooks really provides both hooks', () => {
  // Reachability answers "will git exec them?", not "who configured it": a
  // plain clone with hooks in .git/hooks runs them. The strict
  // (`requireConfigured`) form still belongs to `npm run hooks:install`.
  const repo = makeRepo({ hooksPath: null, hooks: [] })
  for (const hook of REQUIRED_HOOKS) {
    const file = join(repo, '.git', 'hooks', hook)
    writeFileSync(file, '#!/usr/bin/env sh\nexit 0\n')
    chmodSync(file, 0o755)
  }
  const result = inspectHookReachability({ cwd: repo })
  assert.equal(result.status, 'pass', JSON.stringify(result))
  assert.match(result.detail, /core\.hooksPath unset/)
})

test('a checkout that never configured hooks WARNS: unconfigured is not "configured but broken"', () => {
  // A pristine `git clone` (and every CI checkout — `npm ci --ignore-scripts`
  // never runs `prepare`) has no `core.hooksPath` and only `*.sample` files in
  // `.git/hooks`. Hooks do not run there, but nothing was MISconfigured, and
  // the fix is `npm run hooks:install`, not "repair the pointer".
  const repo = makeRepo({ hooksPath: null, hooks: [] })
  const result = inspectHookReachability({ cwd: repo })
  assert.equal(result.status, 'warn', JSON.stringify(result))
  assert.match(result.detail, /core\.hooksPath is not configured/)
  assert.match(result.detail, /not a broken hook configuration/)
  assert.match(result.fix, /^npm run hooks:install$/)
})

test('the CLI exits non-zero on a seeded hook defect and zero on the healthy repo', () => {
  const healthy = spawnSync(process.execPath, [GUARDRAILS_CLI, '--cwd', makeRepo()], {
    encoding: 'utf8',
  })
  assert.equal(healthy.status, 0, healthy.stdout + healthy.stderr)

  const broken = spawnSync(
    process.execPath,
    [GUARDRAILS_CLI, '--cwd', makeRepo({ hooksPath: '.husky/_', hooksDir: '.husky' })],
    { encoding: 'utf8' },
  )
  assert.equal(broken.status, 1, 'a broken hook wiring must exit non-zero')
  assert.match(broken.stdout, /\[FAIL\] hooks-reachable: .*— fix: npm run hooks:install/)
})

// ---------------------------------------------------------------------------
// 2. Stale / foreign locks
// ---------------------------------------------------------------------------

test('absent locks are PASS findings — the check ran, it did not skip', () => {
  const findings = inspectRuntimeLocks({ cwd: makeRepo() })
  assert.equal(findings.length, 3, 'one finding per lock path, exactly as many as were stat-ed')
  for (const item of findings) {
    assert.equal(item.status, 'pass', `${item.id}: ${item.detail}`)
    assert.match(item.detail, /^no lock at /)
  }
})

test('a dead lock owner is stale regardless of age', () => {
  const repo = makeRepo()
  writeLock(repo, STEP_LEDGER_LOCK_REL, `${DEAD_PID}:a-real-uuid\n`)
  const result = finding(inspectRuntimeLocks({ cwd: repo }), 'lock-step-ledger')
  assert.equal(result.status, 'fail')
  assert.match(result.detail, new RegExp(`pid ${DEAD_PID} is dead`))
  assert.equal(result.fix, `rm -f ${STEP_LEDGER_LOCK_REL}`)
})

test('each lock is judged by its OWN primitive threshold, not a shared guess', () => {
  // Identical token, identical 5s age, two different primitives:
  //   step-ledger breaks after 2s  → stale (fail)
  //   ephemeral-merge tolerates 10min → live writer (warn)
  const repo = makeRepo()
  const age = 5_000
  writeLock(repo, STEP_LEDGER_LOCK_REL, `${process.pid}:a-real-uuid\n`, age)
  writeLock(repo, EPHEMERAL_MERGE_LOCK_REL, `${process.pid}:a-real-uuid\n`, age)

  const findings = inspectRuntimeLocks({ cwd: repo })
  const ledger = finding(findings, 'lock-step-ledger')
  const merge = finding(findings, 'lock-ephemeral-merge')
  assert.equal(ledger.status, 'fail', 'a 5s ledger lock is past its 2s threshold')
  assert.match(ledger.detail, /threshold/)
  assert.equal(merge.status, 'warn', 'a 5s merge lock is inside its 10min threshold')
  assert.match(merge.detail, new RegExp(`pid ${process.pid}`))
  assert.notEqual(STEP_LEDGER_LOCK_STALE_MS, EPHEMERAL_MERGE_LOCK_STALE_MS)
})

test('a live, fresh lock is advisory (WARN) — a writer is active, not broken', () => {
  const repo = makeRepo()
  writeLock(repo, STEP_LEDGER_LOCK_REL, `${process.pid}:a-real-uuid\n`)
  const result = finding(inspectRuntimeLocks({ cwd: repo }), 'lock-step-ledger')
  assert.equal(result.status, 'warn')
  assert.match(result.detail, /writer is active/)
})

test('an orphaned .git/index.lock (no token, past a minute) fails with the exact fix', () => {
  const repo = makeRepo()
  writeLock(repo, '.git/index.lock', '', INDEX_LOCK_STALE_MS + 60_000)
  const result = finding(inspectRuntimeLocks({ cwd: repo }), 'lock-index')
  assert.equal(result.status, 'fail')
  assert.match(result.detail, /ownerless/)
  assert.equal(result.fix, 'rm -f .git/index.lock')
})

test('lock tokens are parsed as <pid>:<uuid>, and unknown shapes never crash', () => {
  assert.deepEqual(parseLockToken('1234:abc'), { pid: 1234, token: '1234:abc' })
  assert.deepEqual(parseLockToken('garbage'), { token: 'garbage' })
  assert.deepEqual(parseLockToken(''), {})
})

// ---------------------------------------------------------------------------
// 3. Shared-checkout risk
// ---------------------------------------------------------------------------

test('one worktree, clean, on one branch passes', () => {
  const findings = inspectSharedCheckout({ cwd: makeRepo() })
  assert.equal(findings.length, 1)
  assert.equal(findings[0].status, 'pass')
  assert.match(findings[0].detail, /1 worktree\(s\), one per branch, none dirty/)
})

test('the same branch checked out in two worktrees FAILS (two writers, one history)', () => {
  const repo = makeRepo()
  const root = dirname(repo)
  const first = join(root, `${repo.split('/').pop()}-wt1`)
  const second = join(root, `${repo.split('/').pop()}-wt2`)
  git(['worktree', 'add', '--quiet', '-b', 'feat/dup', first], repo)
  git(['worktree', 'add', '--quiet', '--force', second, 'feat/dup'], repo)

  const findings = inspectSharedCheckout({ cwd: repo })
  const collision = finding(findings, 'shared-checkout', 'guardrail_shared_branch')
  assert.equal(collision.status, 'fail')
  assert.match(collision.detail, /branch "feat\/dup" is checked out in 2 worktrees/)
  assert.match(collision.fix, /^git worktree remove --force /)
})

test('two branches in two worktrees pass; a dirty lane is an advisory', () => {
  const repo = makeRepo()
  const root = dirname(repo)
  const lane = join(root, `${repo.split('/').pop()}-lane`)
  git(['worktree', 'add', '--quiet', '-b', 'feat/lane', lane], repo)

  const clean = inspectSharedCheckout({ cwd: repo })
  assert.equal(clean.length, 1)
  assert.equal(clean[0].status, 'pass', JSON.stringify(clean))

  writeFileSync(join(lane, 'in-progress.txt'), 'work\n')
  const dirty = inspectSharedCheckout({ cwd: repo })
  const warn = finding(dirty, 'shared-checkout', 'guardrail_worktree_dirty')
  assert.equal(warn.status, 'warn')
  assert.match(warn.detail, new RegExp(lane.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('two entries resolving to the primary path FAIL and report the session marker', () => {
  // `git worktree list` cannot emit one path twice, so the path-collision arm
  // is driven through the classifier `inspectSharedCheckout` itself calls.
  const repo = makeRepo()
  mkdirSync(join(repo, '.pantheon', 'ledger'), { recursive: true })
  writeFileSync(
    join(repo, '.pantheon', 'ledger', 'step-ledger.json'),
    JSON.stringify({ version: 1, steps: { 'step-a': { state: 'in_progress' } } }),
  )
  const findings = classifyWorktreeCollisions([
    { path: repo, branch: 'main', head: 'a' },
    { path: `${repo}/`, branch: 'main-alias', head: 'a' },
  ])
  const collision = finding(findings, 'shared-checkout', 'guardrail_shared_path')
  assert.equal(collision.status, 'fail')
  assert.match(collision.detail, /2 worktree entries resolve to /)
  assert.match(collision.detail, /\(the primary checkout\)/)
  assert.match(collision.detail, /session marker: step-ledger: step "step-a" in_progress/)
})

// ---------------------------------------------------------------------------
// 4. Ignore-rule precondition
// ---------------------------------------------------------------------------

test('runtime state ignored by the root rule passes, and .pantheon/* is accepted', () => {
  for (const rule of ['.pantheon/\n', '.pantheon/*\n']) {
    const result = inspectIgnorePrecondition({ cwd: makeRepo({ gitignore: rule }) })
    assert.equal(result.status, 'pass', `${JSON.stringify(rule)}: ${result.detail}`)
  }
})

test('no ignore rule WARNS with the exact line to add — the hook would fail open', () => {
  const result = inspectIgnorePrecondition({ cwd: makeRepo({ gitignore: null }) })
  assert.equal(result.status, 'warn')
  assert.match(result.detail, /NOT ignored/)
  for (const probe of IGNORE_PROBE_PATHS) assert.match(result.detail, new RegExp(probe, 'i'))
  assert.equal(result.fix, `printf '%s\\n' '.pantheon/*' >> .gitignore`)
})

// ---------------------------------------------------------------------------
// Aggregation, thresholds, and the real entry points
// ---------------------------------------------------------------------------

test('collectGuardrailFindings reports every check id — no check can be silently absent', () => {
  const ids = collectGuardrailFindings({ cwd: makeRepo() }).map((item) => item.id)
  for (const id of [
    'hooks-reachable',
    'lock-index',
    'lock-step-ledger',
    'lock-ephemeral-merge',
    'shared-checkout',
    'ignore-rules',
  ]) {
    assert.ok(ids.includes(id), `missing ${id} (got ${ids.join(', ')})`)
  }
})

test('doctor exit codes are provisioned, not ambient: 0 alone, 2 when two worktrees share a branch', () => {
  // The exit-code contract is a claim about the repository doctor inspected, so
  // the repository is provisioned here. The ambient checkout's worktree list
  // belongs to every session on this machine: two of them legitimately holding
  // one branch is a state the guardrail MUST fail, and it must not be the reason
  // this suite goes red.
  const checkout = provisionCheckout(REPO_ROOT)
  try {
    const alone = runDoctor(['--profile', 'lite', '--target', checkout.root])
    assert.equal(alone.report.summary.exit_code, 0, JSON.stringify(alone.report.summary))
    const pass = alone.report.findings.find(
      (item) => item.check === 'shared-checkout' && item.code === 'guardrail_shared_checkout',
    )
    assert.ok(pass, JSON.stringify(alone.report.findings.map((item) => item.code)))
    assert.equal(pass.category, 'pass', JSON.stringify(pass))
    assert.match(pass.message, /1 worktree\(s\), one per branch, none dirty/)

    const first = join(checkout.container, 'wt1')
    const second = join(checkout.container, 'wt2')
    git(['worktree', 'add', '--quiet', '-b', 'feat/dup', first], checkout.root)
    git(['worktree', 'add', '--quiet', '--force', second, 'feat/dup'], checkout.root)

    const duplicated = runDoctor(['--profile', 'lite', '--target', checkout.root])
    assert.equal(duplicated.report.status, 'error')
    assert.equal(duplicated.report.summary.exit_code, 2, 'two writers on one branch must block')
    const collision = duplicated.report.findings.find(
      (item) => item.check === 'shared-checkout' && item.code === 'guardrail_shared_branch',
    )
    assert.ok(collision, JSON.stringify(duplicated.report.findings.map((item) => item.code)))
    assert.equal(collision.category, 'error', JSON.stringify(collision))
    assert.match(collision.message, /branch "feat\/dup" is checked out in 2 worktrees/)
  } finally {
    // The worktrees live inside the container, so removing it removes them too.
    checkout.cleanup()
  }
})

test('the mirrored stale thresholds still match their owning modules', () => {
  // The thresholds are copied because the primitives are TypeScript. This is the
  // parity tripwire: change LOCK_STALE_MS in the primitive and this fails
  // instead of the doctor quietly judging locks by a wrong number.
  const ledgerSource = readFileSync(join(REPO_ROOT, 'src/pantheon/step-ledger.ts'), 'utf8')
  assert.match(ledgerSource, /const LOCK_STALE_MS = 2_000/)
  assert.equal(STEP_LEDGER_LOCK_STALE_MS, 2_000)

  const mergeSource = readFileSync(join(REPO_ROOT, 'src/pantheon/ephemeral-merge.ts'), 'utf8')
  assert.match(mergeSource, /const MERGE_LOCK_STALE_MS = 10 \* 60 \* 1000/)
  assert.equal(EPHEMERAL_MERGE_LOCK_STALE_MS, 10 * 60 * 1000)

  assert.ok(existsSync(join(REPO_ROOT, 'scripts/guardrails.mjs')))
})

function runDoctor(extraArgs) {
  const child = spawnSync(process.execPath, [DOCTOR_CLI, '--json', ...extraArgs], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      LANG: 'C',
      LC_ALL: 'C',
      PANTHEON_HOME: ISOLATED_HOME,
      PANTHEON_PYTHON: RUNTIME_PYTHON,
    },
    timeout: 300_000,
  })
  const report = JSON.parse(child.stdout)
  return { child, report }
}

// The doctor-level positive path runs against a repo THIS TEST provisions, not
// against the ambient checkout. `test-suite` installs with
// `npm ci --ignore-scripts`, so `prepare` never runs, `core.hooksPath` is never
// set, and the CI clone really would skip every hook — the guardrail is right
// about that clone. Asserting PASS there encoded a dev-machine assumption and
// turned an environment fact into a red suite. The contract under test is the
// guardrail's, so the repo it inspects is provisioned here.
test('doctor reports the guardrails for a checkout whose hooks are tracked and reachable', () => {
  const { report } = runDoctor(['--target', makeRepo()])
  const codes = report.findings.map((item) => item.code)
  for (const code of [
    'guardrail_hooks_reachable',
    'guardrail_lock_index',
    'guardrail_lock_step_ledger',
    'guardrail_lock_ephemeral_merge',
  ]) {
    assert.ok(codes.includes(code), `doctor must report ${code} (got ${codes.join(', ')})`)
  }
  const hooks = report.findings.find((item) => item.code === 'guardrail_hooks_reachable')
  assert.equal(
    hooks.category,
    'pass',
    `hooks tracked in .husky must be reachable: ${hooks.message}`,
  )
})

test('doctor WARNS, and does not block, where hooks were never installed', () => {
  // The pristine-clone condition, provisioned explicitly: no `core.hooksPath`,
  // no runnable hook in `.git/hooks`. "Not configured" must not be reported as
  // the shipped "configured but broken" defect — doctor keeps it advisory.
  const { report } = runDoctor(['--target', makeRepo({ hooksPath: null, hooks: [] })])
  const hooks = report.findings.find((item) => item.code === 'guardrail_hooks_reachable')
  assert.ok(hooks, 'the guardrail finding must still be present in doctor --json')
  assert.equal(hooks.category, 'warn', JSON.stringify(hooks))
  assert.match(hooks.message, /core\.hooksPath is not configured/)
  assert.match(hooks.message, /npm run hooks:install/)
})

// Informational, and deliberately not an assertion about this machine: on a dev
// checkout `prepare` set `core.hooksPath=.husky` (pass), while a pristine clone
// or CI checkout has no hooks at all (warn). Both are legitimate environments,
// so this records the state as a diagnostic and asserts only that the finding
// is well-formed. The environment-independent contract lives in the two
// provisioned-repo tests above.
test('the ambient checkout hook state is reported, not asserted', (t) => {
  const result = inspectHookReachability({ cwd: REPO_ROOT })
  t.diagnostic(`${result.code}: ${result.status} — ${result.detail}`)
  assert.equal(result.code, 'guardrail_hooks_reachable')
  assert.ok(['pass', 'warn', 'fail'].includes(result.status), result.status)
  assert.ok(result.fix.length > 0, 'every finding carries the exact fix/verify command')
})

test('doctor fails on a repo seeded with the hooks defect, naming the finding', () => {
  const broken = makeRepo({ hooksPath: '.husky/_', hooksDir: '.husky' })
  const { report } = runDoctor(['--target', broken])
  const hooks = report.findings.find((item) => item.code === 'guardrail_hooks_reachable')
  assert.ok(hooks, 'the guardrail finding must be present in doctor --json')
  assert.equal(hooks.category, 'error', JSON.stringify(hooks))
  assert.match(hooks.message, /SKIP every hook/)
  assert.equal(report.status, 'error')
  assert.equal(report.summary.exit_code, 2)
})

test('the CLI --json form is machine-readable and exits 0 with no FAIL finding', () => {
  const child = spawnSync(process.execPath, [GUARDRAILS_CLI, '--cwd', makeRepo(), '--json'], {
    encoding: 'utf8',
  })
  assert.equal(child.status, 0)
  const report = JSON.parse(child.stdout)
  assert.equal(report.ok, true)
  assert.equal(report.summary.fail, 0)
  assert.equal(report.findings.length, 6)
  for (const item of report.findings) {
    assert.ok(item.code.startsWith('guardrail_'), JSON.stringify(item))
    assert.ok(item.fix.length > 0, 'every finding carries the exact fix/verify command')
  }
})

test('inspection is read-only: a foreign lock is never deleted', () => {
  const repo = makeRepo()
  const lock = writeLock(repo, STEP_LEDGER_LOCK_REL, `${DEAD_PID}:uuid\n`)
  collectGuardrailFindings({ cwd: repo })
  assert.ok(existsSync(lock), 'inspection must never delete a foreign lock')
  unlinkSync(lock)
})
