#!/usr/bin/env node
/**
 * check-pantheon-runtime-staged.mjs — pre-commit guard against committing
 * `.pantheon/` runtime state.
 *
 * Why: `.pantheon/*` has been ignored since v1.0, yet `ecebfbb` (2026-08-05)
 * force-added a release-audit snapshot, and the only way to remove it was a
 * history rewrite. The project decided not to rewrite history, so the class is
 * closed at the commit boundary instead: a staged runtime path is rejected
 * before it can enter a commit.
 *
 * Policy: **deny by default**. Every path under `.pantheon/` is blocked unless
 * it matches one of the versioned exceptions below or is already tracked in
 * `HEAD`. The floor is in code on purpose: deriving it from `.gitignore` made
 * the guard fail open in any repository without Pantheon's ignore rules (no
 * `.gitignore` at all, or an unrelated one), which is exactly the force-add
 * scenario this hook exists to stop.
 *
 * `git check-ignore --no-index` is used only as corroboration: a path that git
 * still ignores is blocked even when it matches an exception prefix, so the
 * exception list can never whitelist runtime state that `.gitignore` keeps out.
 * A test asserts parity between this list and the `.gitignore` un-ignore rules,
 * so the two cannot drift apart.
 *
 * Exit codes: 0 = clean/grandfathered, 1 = staged runtime state (or an
 * unreadable repository state that cannot be checked safely).
 */

import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/** Runtime root: everything under it is blocked by default. */
export const RUNTIME_ROOT = '.pantheon'

/**
 * Versioned exceptions, relative to `.pantheon/` and matched on a path-segment
 * boundary (never a bare `startsWith`): the ADR series and the code-mode npm
 * payload. Keep in sync with the `.gitignore` un-ignore rules — the parity test
 * fails when either side changes alone.
 */
export const EXCEPTION_PREFIXES = ['code-mode', 'memory-bank/adr']

/** True for `.pantheon` itself and anything under it (exact name included). */
export function isPantheonRuntimePath(path) {
  return path === RUNTIME_ROOT || path.startsWith(`${RUNTIME_ROOT}/`)
}

/** True when `.pantheon` appears as a segment beyond the first one. */
export function hasNestedRuntimeRoot(path) {
  return path.split('/').slice(1).includes(RUNTIME_ROOT)
}

/** True when `path` is inside an exception prefix, on a segment boundary. */
export function matchesException(path) {
  if (!path.startsWith(`${RUNTIME_ROOT}/`)) return false
  const relative = path.slice(RUNTIME_ROOT.length + 1)
  return EXCEPTION_PREFIXES.some(
    (prefix) => relative === prefix || relative.startsWith(`${prefix}/`),
  )
}

/**
 * Classify one candidate. Order matters: grandfathering wins (existing tracked
 * files must not break), then nested runtime state (a `.pantheon` inside an
 * exception is still runtime state), then the exception list, then the floor.
 */
export function classifyPath(path, trackedPaths, ignoredPaths) {
  if (trackedPaths.has(path)) return 'grandfathered'
  if (hasNestedRuntimeRoot(path)) return 'blocked'
  if (matchesException(path) && !ignoredPaths.has(path)) return 'allowed'
  return 'blocked'
}

function git(args, { input } = {}) {
  return spawnSync('git', args, { encoding: 'utf8', input })
}

function splitNull(text) {
  return (text ?? '').split('\u0000').filter(Boolean)
}

function main() {
  const headCheck = git(['rev-parse', '--verify', 'HEAD'])
  if (headCheck.status !== 0) {
    console.error(
      '[pantheon-runtime-state] cannot read HEAD: this repository has no commits yet, so tracked and new paths cannot be distinguished.',
    )
    console.error(
      '[pantheon-runtime-state] Create the first commit explicitly (git commit --allow-empty -m "init"), then commit again.',
    )
    console.error(
      '[pantheon-runtime-state] If you are certain nothing under .pantheon/ is staged, skip once with SKIP=pantheon-runtime-state git commit ...',
    )
    process.exit(1)
  }

  const rootResult = git(['rev-parse', '--show-toplevel'])
  if (rootResult.status !== 0) {
    console.error('[pantheon-runtime-state] not inside a git work tree; refusing to guess.')
    process.exit(1)
  }

  const candidates =
    process.argv.length > 2
      ? process.argv.slice(2)
      : splitNull(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).stdout)

  const tracked = new Set(splitNull(git(['ls-tree', '-r', '--name-only', '-z', 'HEAD']).stdout))

  const normalised = candidates.map((path) => path.replace(/\\/g, '/'))
  const runtimePaths = normalised.filter(isPantheonRuntimePath)

  // Corroboration only (see the header). A git failure cannot make the guard
  // fail open: the floor already denies everything that is not excepted.
  const ignored = new Set()
  if (runtimePaths.length > 0) {
    const check = spawnSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], {
      encoding: 'utf8',
      input: `${runtimePaths.join('\u0000')}\u0000`,
    })
    if (check.status === 0 || check.status === 1) {
      for (const path of splitNull(check.stdout)) ignored.add(path)
    } else {
      console.error(
        '[pantheon-runtime-state] note: `git check-ignore` failed; continuing with the deny-by-default floor only.',
      )
    }
  }

  const blocked = []
  const grandfathered = []
  for (const path of runtimePaths) {
    const verdict = classifyPath(path, tracked, ignored)
    if (verdict === 'grandfathered') grandfathered.push(path)
    else if (verdict === 'blocked') blocked.push(path)
  }

  for (const path of grandfathered) {
    console.error(
      `[pantheon-runtime-state] note: ${path} is already tracked; left alone (remove it deliberately if it is runtime state)`,
    )
  }

  if (blocked.length > 0) {
    console.error('[pantheon-runtime-state] refusing to commit .pantheon/ runtime state:')
    for (const path of blocked) console.error(`[pantheon-runtime-state]   - ${path}`)
    console.error(
      '[pantheon-runtime-state] .pantheon/ holds live state (ledger, board, memory DB, deepwork, session state, checkpoints).',
    )
    console.error(
      '[pantheon-runtime-state] Runtime state never belongs in history, with or without a .gitignore entry — it only gets in through a force-add.',
    )
    console.error('[pantheon-runtime-state] Unstage with: git restore --staged <path>')
    console.error(
      '[pantheon-runtime-state] Versioned exceptions: .pantheon/memory-bank/adr/** and .pantheon/code-mode/** (a nested .pantheon/ inside them is still runtime state).',
    )
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
