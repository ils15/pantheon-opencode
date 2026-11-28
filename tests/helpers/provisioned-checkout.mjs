/**
 * provisioned-checkout.mjs — a throwaway, self-contained checkout of this repo.
 *
 * Why this exists: doctor-level tests used to assert HEALTH against whatever
 * checkout the suite happened to run in. Two consequences, both observed:
 *   - CI runs `npm ci --ignore-scripts`, so `prepare` never sets
 *     `core.hooksPath` and the CI clone legitimately has no hooks;
 *   - a developer machine running two sessions can legitimately have two
 *     worktrees on one branch, which the shared-checkout guardrail must FAIL.
 * Either turns an ambient assertion red while the code under test is correct,
 * and a suite that goes red because another session is working teaches people
 * to ignore red. Tests that need a healthy repository therefore provision one.
 *
 * The fixture is read from the WORKING TREE (via `git ls-files`), not from HEAD:
 * it must carry the code and data the current run is testing, uncommitted edits
 * included, or a local edit could pass/fail for the wrong reason.
 *
 * `core.hooksPath` is pointed at the TRACKED hooks directory afterwards, so the
 * provisioned checkout is the configured-and-reachable case the repository
 * itself ships (and not a leftover `*.sample`-only `.git/hooks`). The fixture
 * commit runs no hook under test: hooks are wired only after it exists.
 */

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Copy `source`'s tracked files into a fresh repo, commit them, and wire hooks.
 *
 * @param {string} source repository root to copy (its working tree)
 * @param {object} [options]
 * @param {string|null} [options.hooksPath] value for `core.hooksPath` (null = leave unset)
 * @returns {{ root: string, container: string, cleanup: () => void }}
 */
export function provisionCheckout(source, { hooksPath = '.husky' } = {}) {
  const container = mkdtempSync(join(tmpdir(), 'pantheon-provisioned-'))
  const root = join(container, 'repo')
  mkdirSync(root)

  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: source, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  for (const relative of tracked) {
    const from = join(source, relative)
    // A tracked file can be deleted in the working tree; the fixture reproduces
    // the tree as it is, not as it was committed.
    if (!existsSync(from)) continue
    const to = join(root, relative)
    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
    // Mode matters: `.husky/*` must stay executable or the guardrail is right
    // to call the fixture broken.
    chmodSync(to, statSync(from).mode & 0o777)
  }

  const git = (args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' })
  git(['init', '--quiet'])
  git([
    '-c',
    'user.email=pantheon-test@pantheon.dev',
    '-c',
    'user.name=Pantheon Test',
    'add',
    '-A',
  ])
  git([
    '-c',
    'user.email=pantheon-test@pantheon.dev',
    '-c',
    'user.name=Pantheon Test',
    '-c',
    'core.hooksPath=/dev/null',
    'commit',
    '--quiet',
    '-m',
    'chore: provisioned checkout',
  ])
  if (hooksPath !== null) git(['config', 'core.hooksPath', hooksPath])

  return {
    root,
    container,
    cleanup: () => rmSync(container, { recursive: true, force: true }),
  }
}
