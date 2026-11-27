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
 * Policy = deny-by-default under `.pantheon/`, and the allowlist is **git's own
 * answer**: a path that `git check-ignore --no-index` reports as ignored is
 * blocked, and a path that `.gitignore` un-ignores (the ADR series, the
 * `code-mode` npm payload) passes. Asking git removes the hand-written glob
 * conversion entirely, so directory-enabler rules cannot accidentally whitelist
 * their contents (e.g. `!.pantheon/code-mode/` must NOT un-ignore
 * `code-mode/.pantheon/state.json`).
 *
 * A path already in `HEAD` is grandfathered (existing tracked files must not
 * break `pre-commit run --all-files`). Pre-commit passes candidate filenames as
 * argv; without argv the staged set is used.
 *
 * Exit codes: 0 = clean/grandfathered, 1 = staged runtime state (or an
 * unreadable repository state that cannot be checked safely).
 */

import { spawnSync } from 'node:child_process'

/** True for `.pantheon` itself and anything under it (exact name included). */
function isPantheonRuntimePath(path) {
  return path === '.pantheon' || path.startsWith('.pantheon/')
}

function git(args, { input } = {}) {
  return spawnSync('git', args, { encoding: 'utf8', input })
}

function splitNull(text) {
  return (text ?? '').split('\u0000').filter(Boolean)
}

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

const trackedResult = git(['ls-tree', '-r', '--name-only', '-z', 'HEAD'])
const tracked = new Set(splitNull(trackedResult.stdout))

const normalised = candidates.map((path) => path.replace(/\\/g, '/'))
const runtimePaths = normalised.filter(isPantheonRuntimePath)

// Ask git which of these paths `.gitignore` still ignores. `--no-index` makes
// the answer independent of the staging area; each path is unambiguous, so a
// directory-enabler rule cannot leak its contents through.
const ignored = new Set()
if (runtimePaths.length > 0) {
  const check = spawnSync('git', ['check-ignore', '--no-index', '-z', '--stdin'], {
    encoding: 'utf8',
    input: `${runtimePaths.join('\u0000')}\u0000`,
  })
  if (check.status !== 0 && check.status !== 1) {
    console.error(
      `[pantheon-runtime-state] git check-ignore failed (${String(check.stderr ?? '').trim()}); refusing to guess.`,
    )
    process.exit(1)
  }
  for (const path of splitNull(check.stdout)) ignored.add(path)
}

const blocked = []
const grandfathered = []
for (const path of runtimePaths) {
  if (tracked.has(path)) {
    grandfathered.push(path)
    continue
  }
  // `.pantheon` itself is the runtime root: never versionable, even though
  // `.pantheon/*` matches only its children.
  const isIgnored = path === '.pantheon' || ignored.has(path)
  if (isIgnored) blocked.push(path)
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
    '[pantheon-runtime-state] It never belongs in history — it is ignored by .gitignore and only reappears through a force-add.',
  )
  console.error('[pantheon-runtime-state] Unstage with: git restore --staged <path>')
  console.error(
    '[pantheon-runtime-state] Versioned exceptions are whatever .gitignore un-ignores: the ADR series and .pantheon/code-mode/** (but not a nested .pantheon/).',
  )
  process.exit(1)
}
