#!/usr/bin/env node
/**
 * guardrails.mjs — the executable form of preconditions that used to be prose.
 *
 * Why this exists (the class of bug it makes impossible): a gate can be GREEN
 * while not working. This session found five of those — a `core.hooksPath`
 * pointing at a generated, untracked directory that never existed in a linked
 * worktree (git skipped every hook silently), stale locks nobody could see, two
 * sessions in one checkout, and an ignore rule nobody had verified. Prose in a
 * skill file cannot fail; a check that exits non-zero can.
 *
 * Four checks, each one line of PASS/WARN/FAIL with the exact fix:
 *   1. hooks-reachable   — `git rev-parse --git-path hooks` resolves, the dir
 *                          exists, and commit-msg + pre-commit are executable.
 *                          A configured-but-unusable pointer is a FAIL; a
 *                          checkout where hooks were never installed (no
 *                          `core.hooksPath`, no runnable `.git/hooks`) is a
 *                          WARN — see inspectHookReachability.
 *   2. runtime-locks     — `.git/index.lock`,
 *                          `.pantheon/ledger/.step-ledger.lock` and
 *                          `.pantheon/.ephemeral-merge.lock`: age, owner pid,
 *                          dead owner, or age past the primitive's own
 *                          threshold.
 *   3. shared-checkout   — the same branch checked out in >1 worktree, a
 *                          worktree path that resolves to the primary while a
 *                          session marker exists, and any dirty worktree.
 *   4. ignore-rules      — `.pantheon/` runtime state is really ignored, so the
 *                          runtime-state hook cannot fail open.
 *
 * `fail` = a real defect (this CLI exits 1; doctor maps it to a blocking error
 * and exits 2). `warn` = advisory (busy-but-alive lock, dirty worktree, ignore
 * rule that is only satisfied per-path, hooks that were never installed).
 *
 * Usage:
 *   node scripts/guardrails.mjs [--cwd <dir>] [--json] [--help]
 *
 * Exit codes: 0 = no FAIL findings, 1 = at least one FAIL, 2 = usage error.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectGitHooks, REQUIRED_HOOKS } from './verify-git-hooks.mjs'

// ---------------------------------------------------------------------------
// Lock primitives — the thresholds are MIRRORS of the owning modules.
// ---------------------------------------------------------------------------
// `scripts/guardrails.mjs` is ESM and the primitives are TypeScript, so the
// constants cannot be imported. A mirror is only safe with a parity test:
// tests/guardrails-doctor.test.mjs reads both sources and fails when this file
// and the primitive disagree — the alternative (guessing a threshold) is
// exactly the "derive policy from config you do not control" failure.
//
//   src/pantheon/step-ledger.ts    LOCK_STALE_MS = 2_000
//   src/pantheon/ephemeral-merge.ts MERGE_LOCK_STALE_MS = 10 * 60 * 1000

/** `.pantheon/ledger/.step-ledger.lock` — a ledger write takes milliseconds. */
export const STEP_LEDGER_LOCK_STALE_MS = 2_000
/** `.pantheon/.ephemeral-merge.lock` — heartbeat-refreshed merge window. */
export const EPHEMERAL_MERGE_LOCK_STALE_MS = 10 * 60 * 1000
/**
 * `.git/index.lock` has no Pantheon primitive: git core holds it for one index
 * write and never breaks it automatically. A minute is already pathological
 * (a crashed `git add`/`git commit`), and the only recovery is to remove it.
 */
export const INDEX_LOCK_STALE_MS = 60_000

export const STEP_LEDGER_LOCK_REL = '.pantheon/ledger/.step-ledger.lock'
export const EPHEMERAL_MERGE_LOCK_REL = '.pantheon/.ephemeral-merge.lock'

/** Runtime-state paths the ignore rule must cover for the staged-state hook. */
export const IGNORE_PROBE_PATHS = [
  '.pantheon/ledger/step-ledger.json',
  '.pantheon/.ephemeral-merge.lock',
  '.pantheon/board',
]

/** @typedef {'pass'|'warn'|'fail'} FindingStatus */
/**
 * @typedef {object} Finding
 * @property {string} id       stable check id (also the `--json` machine key)
 * @property {string} code     snake_case finding code for doctor's JSON
 * @property {FindingStatus} status
 * @property {string} detail   one-line evidence
 * @property {string} fix      exact command that fixes it (or re-verifies it)
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return {
    ok: result.status === 0,
    status: result.status,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim(),
  }
}

/** True when `cwd` is inside a git work tree (the checks are git-shaped). */
export function isGitRepo(cwd) {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']).out === 'true'
}

/** `git rev-parse --show-toplevel` (canonical, symlink-resolved path). */
export function gitTopLevel(cwd) {
  const result = git(cwd, ['rev-parse', '--show-toplevel'])
  return result.ok ? realpathSync(result.out) : null
}

/**
 * Liveness for a lock owner pid. `EPERM` means the process exists and belongs
 * to another user: alive, not stale.
 */
export function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/** Locks are `<pid>:<uuid>` (step-ledger) or `<pid>:<uuid>` (merge window). */
export function parseLockToken(text) {
  const token = (text ?? '').trim()
  if (token === '') return {}
  const [rawPid] = token.split(':')
  const pid = Number(rawPid)
  return Number.isInteger(pid) && pid > 0 ? { pid, token } : { token }
}

function formatAge(ms) {
  if (!Number.isFinite(ms)) return 'unknown age'
  const seconds = ms / 1000
  if (seconds < 1) return `${Math.round(ms)}ms`
  if (seconds < 90) return `${seconds.toFixed(1)}s`
  return `${Math.round(seconds / 60)}m`
}

// ---------------------------------------------------------------------------
// 1. Hook reachability
// ---------------------------------------------------------------------------

/**
 * Reachability — not "does the directory exist" and not "is it configured":
 * will git, standing in `cwd`, find a hooks directory and be able to exec the
 * two hooks the repository relies on?
 *
 * `requireConfigured: false` because an unset `core.hooksPath` that still
 * resolves to a real hooks dir containing both hooks IS reachable; the defect
 * this catches is a pointer to a directory that is missing or unusable.
 *
 * Three states, and only the middle one is a FAIL:
 *   pass — git resolves executable commit-msg + pre-commit where it looks.
 *   fail — `core.hooksPath` IS SET and resolves to a missing, non-directory, or
 *          non-executable hooks location. That is the shipped v1.0→2.3.4
 *          pointer-at-a-generated-dir defect: someone configured the wiring and
 *          it does not work, so every hook is skipped while nothing complains.
 *   warn — nothing was configured (no `core.hooksPath`, and `.git/hooks` has no
 *          runnable hooks), so hooks do not run either, but there is no broken
 *          configuration to report: this is a checkout where hooks were never
 *          installed (a pristine `git clone`, and every CI checkout running
 *          `npm ci --ignore-scripts`, which never runs `prepare`). Failing here
 *          would report an unconfigured clone as a defective repository and
 *          train readers to ignore the finding; the fix is still named.
 * "Not configured" and "configured but broken" are different observations and
 * must not collapse into one status.
 */
export function inspectHookReachability({ cwd }) {
  const report = inspectGitHooks({ cwd, requireConfigured: false })
  const fix = 'npm run hooks:install'
  if (report.ok) {
    const source = report.hooksPath ? `core.hooksPath=${report.hooksPath}` : 'core.hooksPath unset'
    return {
      id: 'hooks-reachable',
      code: 'guardrail_hooks_reachable',
      status: 'pass',
      detail: `git will exec ${REQUIRED_HOOKS.join(' + ')} from ${report.hooksDir} (${source})`,
      fix,
    }
  }
  const base = { id: 'hooks-reachable', code: 'guardrail_hooks_reachable' }
  if (!report.hooksPath && report.hooksDir) {
    return {
      ...base,
      status: 'warn',
      detail:
        `core.hooksPath is not configured and ${report.hooksDir} provides no required hook ` +
        `(${report.problems.join('; ')}) — hooks are not installed in this checkout, ` +
        'which is not a broken hook configuration',
      fix,
    }
  }
  return {
    ...base,
    status: 'fail',
    detail: `git would SKIP every hook: ${report.problems.join('; ')}`,
    fix,
  }
}

// ---------------------------------------------------------------------------
// 2. Stale / foreign locks
// ---------------------------------------------------------------------------

/**
 * Inspect one lock file. Three independent signals, in priority order:
 *   1. owner pid parsed from the token and dead  → stale (a crashed writer)
 *   2. age past the primitive's own threshold   → stale (unrefreshed writer)
 *   3. owner pid alive and fresh                 → busy, advisory only
 * An absent lock is a PASS: the check still ran (it stat'ed the path), and the
 * finding records that, so a green result can never come from a skipped check.
 */
export function inspectLockFile({ cwd, relPath, staleMs, id }) {
  const lockPath = join(cwd, relPath)
  const code = `guardrail_lock_${id.replaceAll('-', '_')}`
  const fix = `rm -f ${relPath}`
  const base = { id: `lock-${id}`, code }

  if (!existsSync(lockPath)) {
    return { ...base, status: 'pass', detail: `no lock at ${relPath}`, fix: `test ! -e ${relPath}` }
  }

  let stats
  try {
    stats = statSync(lockPath)
  } catch {
    return { ...base, status: 'pass', detail: `${relPath} vanished during inspection`, fix }
  }

  const age = Date.now() - stats.mtimeMs
  let token = {}
  try {
    token = parseLockToken(readFileSync(lockPath, 'utf8'))
  } catch {
    /* unreadable owner: fall back to age, exactly like the primitives do */
  }
  const owner = token.pid === undefined ? 'ownerless/unparseable' : `pid ${token.pid}`

  if (token.pid !== undefined && !pidIsAlive(token.pid)) {
    return {
      ...base,
      status: 'fail',
      detail: `${relPath} is stale: owner ${owner} is dead (age ${formatAge(age)})`,
      fix,
    }
  }
  if (age > staleMs) {
    return {
      ...base,
      status: 'fail',
      detail: `${relPath} is stale: age ${formatAge(age)} > threshold ${formatAge(staleMs)} (${owner})`,
      fix,
    }
  }
  return {
    ...base,
    status: 'warn',
    detail: `${relPath} is held by ${owner}, age ${formatAge(age)} — a writer is active`,
    fix: `test ! -e ${relPath}`,
  }
}

/** Every lock this repository's gates can leave behind. */
export function inspectRuntimeLocks({ cwd }) {
  return [
    inspectLockFile({ cwd, relPath: '.git/index.lock', staleMs: INDEX_LOCK_STALE_MS, id: 'index' }),
    inspectLockFile({
      cwd,
      relPath: STEP_LEDGER_LOCK_REL,
      staleMs: STEP_LEDGER_LOCK_STALE_MS,
      id: 'step-ledger',
    }),
    inspectLockFile({
      cwd,
      relPath: EPHEMERAL_MERGE_LOCK_REL,
      staleMs: EPHEMERAL_MERGE_LOCK_STALE_MS,
      id: 'ephemeral-merge',
    }),
  ]
}

// ---------------------------------------------------------------------------
// 3. Shared-checkout risk
// ---------------------------------------------------------------------------

/** Parse `git worktree list --porcelain` into one entry per checkout. */
export function listWorktrees(cwd) {
  const result = git(cwd, ['worktree', 'list', '--porcelain'])
  if (!result.ok) return []
  const entries = []
  let current = null
  for (const line of result.out.split('\n')) {
    if (line === '') {
      if (current) entries.push(current)
      current = null
      continue
    }
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current)
      current = { path: line.slice('worktree '.length), head: null, branch: null, bare: false }
      continue
    }
    if (!current) continue
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length)
    else if (line.startsWith('branch ')) current.branch = line.slice('branch refs/heads/'.length)
    else if (line === 'bare') current.bare = true
  }
  if (current) entries.push(current)
  return entries
}

/**
 * "Another session is working here" markers this repository actually has: a
 * long-lived owner file (forward-compatible) and an `in_progress` step in that
 * checkout's ledger — the step ledger is the scheduler's own claim record.
 */
export function sessionMarkers(checkoutPath) {
  const markers = []
  for (const relPath of ['.pantheon/session-owner.json', '.pantheon/session-owner']) {
    if (existsSync(join(checkoutPath, relPath))) markers.push(relPath)
  }
  const ledgerPath = join(checkoutPath, '.pantheon', 'ledger', 'step-ledger.json')
  try {
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    const active = Object.entries(ledger?.steps ?? {}).filter(
      ([, entry]) => entry?.state === 'in_progress',
    )
    for (const [key] of active) markers.push(`step-ledger: step "${key}" in_progress`)
  } catch {
    /* unreadable or absent ledger: no claim evidence, never a crash */
  }
  return markers
}

function canonicalPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Shared-checkout risk: the invariant is one specialist per checkout. Three
 * failures it can see:
 *   - one branch checked out in several worktrees (two writers, one history),
 *   - two worktree entries resolving to the same physical path (two sessions
 *     in one directory, whatever the paths are called),
 *   - a dirty worktree (a lane that was already in use).
 */

/**
 * The collision half of the check, with the listing and the probes injected:
 * `git worktree list` cannot be made to emit two entries for one path, so the
 * path-collision arm is exercised through this function (which is exactly what
 * `inspectSharedCheckout` calls) rather than through an unseedable fixture.
 */
export function classifyWorktreeCollisions(
  worktrees,
  { canonicalize = canonicalPath, markerProbe = sessionMarkers } = {},
) {
  const findings = []
  const fixList = (path) => `git worktree remove --force ${path}`

  // (a) one branch, several worktrees
  const byBranch = new Map()
  for (const entry of worktrees) {
    if (!entry.branch) continue
    byBranch.set(entry.branch, [...(byBranch.get(entry.branch) ?? []), entry])
  }
  for (const [branch, entries] of byBranch) {
    if (entries.length < 2) continue
    const paths = entries.map((entry) => entry.path)
    findings.push({
      id: 'shared-checkout',
      code: 'guardrail_shared_branch',
      status: 'fail',
      detail: `branch "${branch}" is checked out in ${entries.length} worktrees: ${paths.join(', ')}`,
      fix: fixList(paths.at(-1)),
    })
  }

  // (b) the same physical path twice (a worktree resolving to the primary)
  const byPath = new Map()
  for (const entry of worktrees) {
    const canonical = canonicalize(entry.path)
    byPath.set(canonical, [...(byPath.get(canonical) ?? []), entry])
  }
  const primary = worktrees.length > 0 ? canonicalize(worktrees[0].path) : null
  for (const [canonical, entries] of byPath) {
    if (entries.length < 2) continue
    const markers = entries.flatMap((entry) => markerProbe(entry.path))
    findings.push({
      id: 'shared-checkout',
      code: 'guardrail_shared_path',
      status: 'fail',
      detail:
        `${entries.length} worktree entries resolve to ${canonical}` +
        (canonical === primary ? ' (the primary checkout)' : '') +
        `; session marker: ${markers.length > 0 ? markers.join(', ') : 'none'}`,
      fix: fixList(entries.at(-1).path),
    })
  }
  return findings
}

export function inspectSharedCheckout({ cwd }) {
  const worktrees = listWorktrees(cwd)
  const base = { id: 'shared-checkout', code: 'guardrail_shared_checkout' }

  if (worktrees.length === 0) {
    return [
      {
        ...base,
        status: 'warn',
        detail: 'could not list worktrees (git worktree list failed)',
        fix: 'git worktree list',
      },
    ]
  }

  const findings = classifyWorktreeCollisions(worktrees)

  // (c) dirty lanes
  const dirty = []
  for (const entry of worktrees) {
    const status = git(entry.path, ['status', '--porcelain'])
    if (status.ok && status.out !== '') {
      dirty.push(`${entry.path} (${status.out.split('\n').length} path(s))`)
    }
  }
  if (dirty.length > 0) {
    findings.push({
      ...base,
      code: 'guardrail_worktree_dirty',
      status: 'warn',
      detail: `dirty worktree(s): ${dirty.join(', ')}`,
      fix: 'git -C <worktree> status --short',
    })
  }

  if (findings.length === 0) {
    findings.push({
      ...base,
      status: 'pass',
      detail: `${worktrees.length} worktree(s), one per branch, none dirty`,
      fix: 'git worktree list',
    })
  }
  return findings
}

// ---------------------------------------------------------------------------
// 4. Ignore-rule precondition
// ---------------------------------------------------------------------------

/**
 * The runtime-state hook (`scripts/hooks/check-pantheon-runtime-staged.mjs`)
 * corroborates its denylist with `git check-ignore`. If runtime state is not
 * ignored, that corroboration fails open — advisory, but with the exact fix.
 *
 * Note on the literal probe: this repository uses `.pantheon/*`, which ignores
 * the CONTENTS of the directory, not the directory entry itself, so
 * `git check-ignore .pantheon` exits 1 while every runtime file is ignored.
 * Both are reported; PASS is decided by the paths the hook actually needs.
 */
export function inspectIgnorePrecondition({ cwd }) {
  const evidence = []
  let covered = 0
  for (const probe of IGNORE_PROBE_PATHS) {
    const result = git(cwd, ['check-ignore', '-v', '--', probe])
    if (result.ok && result.out !== '') {
      covered++
      evidence.push(result.out.split('\t')[0] || result.out)
    }
  }
  const dirProbe = git(cwd, ['check-ignore', '-v', '--', '.pantheon'])
  const dirIgnored = dirProbe.ok
  const base = { id: 'ignore-rules', code: 'guardrail_ignore_rules' }
  const fix = `printf '%s\\n' '.pantheon/*' >> .gitignore`

  if (covered === IGNORE_PROBE_PATHS.length) {
    const rule = evidence[0] ?? 'ignore rule present'
    return {
      ...base,
      status: 'pass',
      detail:
        `runtime state ignored (${rule}); git check-ignore .pantheon ` +
        `${dirIgnored ? 'also matches' : 'does not match — the pattern ignores its contents, which is what the hook needs'}`,
      fix: 'git check-ignore -v .pantheon/ledger/step-ledger.json',
    }
  }
  const missing = IGNORE_PROBE_PATHS.filter((probe) => {
    const result = git(cwd, ['check-ignore', '-q', '--', probe])
    return !result.ok
  })
  return {
    ...base,
    status: 'warn',
    detail: `runtime state is NOT ignored (${missing.join(', ')}) — the runtime-state hook fails open`,
    fix,
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Stable order; tests assert on ids, never on incidental ordering. */
export const GUARDRAIL_CHECK_IDS = [
  'hooks-reachable',
  'lock-index',
  'lock-step-ledger',
  'lock-ephemeral-merge',
  'shared-checkout',
  'ignore-rules',
]

/**
 * Run every guardrail in `cwd`. Returns findings only — rendering (doctor /
 * CLI / JSON) is the caller's business, so one implementation is tested once.
 */
export function collectGuardrailFindings({ cwd }) {
  if (!isGitRepo(cwd)) return []
  return [
    inspectHookReachability({ cwd }),
    ...inspectRuntimeLocks({ cwd }),
    ...inspectSharedCheckout({ cwd }),
    inspectIgnorePrecondition({ cwd }),
  ]
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const LABEL = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' }

function formatLine(finding) {
  const suffix = finding.status === 'pass' ? ` (verify: ${finding.fix})` : ` — fix: ${finding.fix}`
  return `[${LABEL[finding.status]}] ${finding.id}: ${finding.detail}${suffix}`
}

export function main(argv) {
  let cwd = process.cwd()
  let json = false
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: node scripts/guardrails.mjs [--cwd <dir>] [--json]\n\n' +
          '  hooks-reachable, runtime locks, shared-checkout risk, ignore-rule precondition.\n' +
          '  Exit 0 = no FAIL finding, 1 = at least one FAIL, 2 = usage error.',
      )
      return 0
    }
    if (arg === '--json') {
      json = true
      continue
    }
    if (arg === '--cwd') {
      const value = argv[index + 1]
      if (!value) {
        console.error('[guardrails] --cwd requires a directory')
        return 2
      }
      cwd = resolve(value)
      index++
      continue
    }
    console.error(`[guardrails] unknown argument: ${arg}`)
    return 2
  }

  if (!isGitRepo(cwd)) {
    const message = `[guardrails] not a git work tree: ${cwd} — nothing to verify`
    if (json)
      console.log(JSON.stringify({ ok: true, cwd, findings: [], skipped: 'not-a-git-repo' }))
    else console.log(message)
    return 0
  }

  const findings = collectGuardrailFindings({ cwd })
  const failed = findings.filter((finding) => finding.status === 'fail')
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: failed.length === 0,
          cwd,
          summary: {
            pass: findings.filter((f) => f.status === 'pass').length,
            warn: findings.filter((f) => f.status === 'warn').length,
            fail: failed.length,
          },
          findings,
        },
        null,
        2,
      ),
    )
  } else {
    for (const finding of findings) console.log(formatLine(finding))
  }
  return failed.length === 0 ? 0 : 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
