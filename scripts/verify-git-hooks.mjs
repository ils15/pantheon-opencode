#!/usr/bin/env node
/**
 * verify-git-hooks.mjs — assert that git will REALLY run Pantheon's hooks here.
 *
 * Why this exists (the bug it makes impossible):
 * `core.hooksPath` is stored in the SHARED `.git/config`, so every linked
 * worktree inherits the pointer — but `git worktree add` materialises only
 * TRACKED files. Husky v9's target (`.husky/_`) is generated and untracked, so
 * a fresh worktree pointed at a directory that did not exist, and git then
 * skipped EVERY hook silently: commitlint, the secret scan, the
 * `pantheon-runtime-state` guard and the generated-artifacts gate. In a real
 * worktree a non-conventional commit exited 0 with no warning (v1.0 → 2.3.4),
 * while the same commit in the primary checkout was rejected.
 *
 * The fix points `core.hooksPath` at the TRACKED `.husky` directory and makes
 * the two hook scripts self-sufficient (no `.husky/_`, no shim). This verifier
 * is the tripwire: it fails when the configured hooks directory is missing, or
 * when a required hook is absent or not executable.
 *
 * Usage:
 *   node scripts/verify-git-hooks.mjs            # verify the current checkout
 *   node scripts/verify-git-hooks.mjs --apply    # set core.hooksPath, then verify
 *
 * Exit codes: 0 = hooks will run, 1 = they would be skipped (message explains).
 */

import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** The tracked hooks directory. Single source of truth for prepare/verifier/tests. */
export const HOOKS_PATH = '.husky'

/** Hooks the repository actually relies on (see .pre-commit-config.yaml). */
export const REQUIRED_HOOKS = ['commit-msg', 'pre-commit']

const FIX_HINT = `Fix: git config core.hooksPath ${HOOKS_PATH}   (or: npm run hooks:install)`

function git(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return {
    ok: result.status === 0,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim(),
  }
}

/**
 * Inspect a checkout exactly the way git will:
 * resolve the hooks directory for `hooksPath` (an explicit argument simulates
 * a configuration without mutating the shared `.git/config`) and check that
 * every required hook exists and is executable.
 *
 * Read-only. Returns `{ ok, hooksDir, hooksPath, problems }`.
 */
export function inspectGitHooks({ cwd = process.cwd(), hooksPath } = {}) {
  const configured = git(['config', '--get', 'core.hooksPath'], cwd)
  const effective = hooksPath ?? (configured.ok ? configured.out : '')
  const revParse = effective
    ? git(['-c', `core.hooksPath=${effective}`, 'rev-parse', '--git-path', 'hooks'], cwd)
    : git(['rev-parse', '--git-path', 'hooks'], cwd)

  const problems = []
  if (!revParse.ok) {
    problems.push(revParse.err || 'git rev-parse --git-path hooks failed')
    return { ok: false, hooksDir: '', hooksPath: effective, problems }
  }

  const hooksDir = resolve(cwd, revParse.out)
  if (!effective) {
    problems.push(`core.hooksPath is not set in ${cwd}; hooks would come from ${hooksDir}`)
  }
  if (!existsSync(hooksDir)) {
    problems.push(
      `hooks directory does not exist: ${hooksDir} (core.hooksPath=${effective || 'unset'})`,
    )
  } else if (!statSync(hooksDir).isDirectory()) {
    problems.push(`hooks path is not a directory: ${hooksDir}`)
  } else {
    for (const hook of REQUIRED_HOOKS) {
      const file = join(hooksDir, hook)
      if (!existsSync(file)) {
        problems.push(`missing hook: ${file}`)
        continue
      }
      try {
        accessSync(file, constants.X_OK)
      } catch {
        problems.push(`hook is not executable: ${file}`)
      }
    }
  }

  return { ok: problems.length === 0, hooksDir, hooksPath: effective, problems }
}

/** Point the repository (shared .git/config) at the tracked hooks directory. */
export function applyHooksPath(cwd = process.cwd(), hooksPath = HOOKS_PATH) {
  return git(['config', 'core.hooksPath', hooksPath], cwd)
}

function main(argv) {
  const cwd = process.cwd()
  if (argv.includes('--apply')) {
    const applied = applyHooksPath(cwd)
    if (!applied.ok) {
      console.error(
        `[git-hooks] could not set core.hooksPath: ${applied.err || 'git config failed'}`,
      )
      return 1
    }
  }
  const report = inspectGitHooks({ cwd })
  if (report.ok) {
    console.log(`[git-hooks] OK: git will run ${REQUIRED_HOOKS.join(', ')} from ${report.hooksDir}`)
    return 0
  }
  for (const problem of report.problems) console.error(`[git-hooks] ${problem}`)
  console.error(`[git-hooks] git would SKIP these hooks silently. ${FIX_HINT}`)
  return 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
