/**
 * hooks-worktree.test.mjs — tripwire for git hooks in linked worktrees.
 *
 * The defect it locks down (v1.0 → 2.3.4): `core.hooksPath` lives in the
 * SHARED `.git/config`, so every worktree inherits the pointer, but
 * `git worktree add` materialises only TRACKED files. Husky v9's target
 * (`.husky/_`) is generated and untracked, so in a fresh worktree git found no
 * hooks directory and skipped every hook SILENTLY: a non-conventional commit
 * exited 0, unguarded. Parallel specialists work exclusively in worktrees, so
 * commitlint and the `pantheon-runtime-state` / `generated-artifacts` guards
 * were decorative exactly where the work happens.
 *
 * The fix points `core.hooksPath` at the tracked `.husky` directory and makes
 * the two tracked hooks self-sufficient. Every assertion below runs in a
 * throwaway `git worktree add` created in `mkdtempSync` — never the primary
 * checkout — because a worktree is the only place the defect reproduces.
 *
 * Run: node --test tests/hooks-worktree.test.mjs
 */

import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { HOOKS_PATH, inspectGitHooks, REQUIRED_HOOKS } from '../scripts/verify-git-hooks.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))
const NON_CONVENTIONAL_MESSAGE = 'this message is not conventional at all'

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' })
}

/** Create a detached worktree of HEAD, run `fn`, and always clean both up. */
function withFreshWorktree(fn) {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-hooks-wt-'))
  const worktree = join(root, 'wt')
  try {
    git(['worktree', 'add', '--detach', worktree, 'HEAD'], repoRoot)
    // `git worktree add` materialises only HEAD. Overlay the working tree's
    // hook scripts so an UNCOMMITTED hook edit is exercised here (dev loop)
    // instead of being silently replaced by the previous commit — the same
    // "green that proves nothing" trap this file exists to kill. In CI HEAD is
    // the working tree, so the overlay is a no-op. `git ls-files` assertions
    // below still prove the hooks are tracked.
    for (const hook of REQUIRED_HOOKS) {
      cpSync(join(repoRoot, HOOKS_PATH, hook), join(worktree, HOOKS_PATH, hook))
    }
    return fn(worktree, root)
  } finally {
    try {
      git(['worktree', 'remove', '--force', worktree], repoRoot)
    } catch {
      // Best effort: a test may have already broken the worktree.
    }
    rmSync(root, { recursive: true, force: true })
  }
}

/** A stub `commitlint` in the worktree's node_modules/.bin. */
function stubCommitlint(worktree, { exitCode }) {
  const bin = join(worktree, 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  const stub = join(bin, 'commitlint')
  writeFileSync(
    stub,
    `#!/usr/bin/env sh\necho "COMMITLINT_STUB_${exitCode}" >&2\nexit ${exitCode}\n`,
  )
  chmodSync(stub, 0o755)
  return stub
}

test('prepare sets core.hooksPath to the TRACKED hooks directory, not a generated one', () => {
  const prepare = packageJson.scripts?.prepare ?? ''
  const match = prepare.match(/git config core\.hooksPath\s+([^\s&]+)/)
  assert.ok(
    match,
    `package.json#scripts.prepare must set core.hooksPath (got: "${prepare}"). ` +
      'A relative path is resolved against the worktree root, so the hooks it ' +
      'names must be tracked — otherwise git skips them silently in every worktree.',
  )
  assert.equal(match[1], HOOKS_PATH, 'prepare must point at the tracked hook directory')
  assert.doesNotMatch(
    prepare,
    /(^|[\s&;|])husky(\s|$)/,
    'prepare must not delegate to the husky CLI: its .husky/_ target is generated and untracked',
  )
  for (const hook of REQUIRED_HOOKS) {
    const tracked = git(['ls-files', '--', `${HOOKS_PATH}/${hook}`], repoRoot).trim()
    assert.equal(tracked, `${HOOKS_PATH}/${hook}`, `${hook} must be tracked, not generated`)
  }
})

test('a fresh `git worktree add` inherits a hooks directory that exists and is runnable', () => {
  withFreshWorktree((worktree) => {
    // Resolve the hooks directory for the committed configuration without
    // mutating the shared .git/config (CI runs `npm ci --ignore-scripts`).
    const report = inspectGitHooks({ cwd: worktree, hooksPath: HOOKS_PATH })
    assert.deepEqual(report.problems, [], 'a worktree must never point at a missing hooks dir')
    assert.equal(report.ok, true)
    assert.equal(report.hooksDir, resolve(worktree, HOOKS_PATH))
    for (const hook of REQUIRED_HOOKS) {
      assert.ok(
        existsSync(join(report.hooksDir, hook)),
        `${hook} must exist in a fresh worktree (got ${report.hooksDir})`,
      )
    }

    // If this checkout is configured at all (a developer clone), it must not
    // still point at the generated `_` directory.
    const configured = spawnSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd: repoRoot,
      encoding: 'utf8',
    })
    if (configured.status === 0) {
      assert.equal(configured.stdout.trim(), HOOKS_PATH, 'core.hooksPath must be the tracked dir')
    }
  })
})

test('tracked hooks are self-contained: shebang, no dependency on the generated shim', () => {
  for (const hook of REQUIRED_HOOKS) {
    const source = readFileSync(join(repoRoot, HOOKS_PATH, hook), 'utf8')
    assert.match(source, /^#!\//, `${hook} must carry a shebang so git can exec it directly`)
    // Comments may explain the old chain; executable lines may not use it.
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    assert.doesNotMatch(
      code,
      /_\/h\b|husky\.sh/,
      `${hook} must not source husky's generated shim (.husky/_/h, husky.sh)`,
    )
    const mode = git(['ls-files', '-s', '--', `${HOOKS_PATH}/${hook}`], repoRoot)
    assert.match(mode, /^100755 /, `${hook} must be tracked as executable`)
  }
})

test('an unprovisioned worktree fails the commit LOUDLY instead of skipping hooks', () => {
  withFreshWorktree((worktree) => {
    const before = git(['rev-list', '--count', 'HEAD'], worktree).trim()
    const result = spawnSync(
      'git',
      [
        // CI clones have no committer identity configured.
        '-c',
        'user.name=Pantheon Test',
        '-c',
        'user.email=test@pantheon.dev',
        '-c',
        `core.hooksPath=${HOOKS_PATH}`,
        'commit',
        '--allow-empty',
        '-m',
        NON_CONVENTIONAL_MESSAGE,
      ],
      {
        cwd: worktree,
        encoding: 'utf8',
        env: { ...process.env, HUSKY: '' },
      },
    )
    assert.notEqual(result.status, 0, 'the commit must be rejected: hooks are the only gate')
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
    assert.match(
      output,
      /npm ci/,
      `a hook that cannot run must say so, with the exact fix (got: ${output.trim()})`,
    )
    assert.equal(
      git(['rev-list', '--count', 'HEAD'], worktree).trim(),
      before,
      'nothing may be committed when the hooks cannot run',
    )
  })
})

test('git dispatches the tracked commit-msg hook inside a worktree', () => {
  withFreshWorktree((worktree) => {
    stubCommitlint(worktree, { exitCode: 1 })
    // Isolate the commit-msg dispatch: the pre-commit chain (pre-commit
    // framework + node_modules) is covered by its own assertions.
    writeFileSync(join(worktree, HOOKS_PATH, 'pre-commit'), '#!/usr/bin/env sh\nexit 0\n')
    chmodSync(join(worktree, HOOKS_PATH, 'pre-commit'), 0o755)

    const result = spawnSync(
      'git',
      [
        // CI clones have no committer identity configured.
        '-c',
        'user.name=Pantheon Test',
        '-c',
        'user.email=test@pantheon.dev',
        '-c',
        `core.hooksPath=${HOOKS_PATH}`,
        'commit',
        '--allow-empty',
        '-m',
        NON_CONVENTIONAL_MESSAGE,
      ],
      { cwd: worktree, encoding: 'utf8', env: { ...process.env, HUSKY: '' } },
    )
    assert.notEqual(result.status, 0, 'commitlint failure must abort the commit')
    assert.match(
      `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
      /COMMITLINT_STUB_1/,
      'the tracked commit-msg hook must have run (not been skipped)',
    )
  })
})

test('commit-msg hook: fail-closed without deps, mirrors husky (PATH, HUSKY=0)', () => {
  withFreshWorktree((worktree) => {
    const hook = join(worktree, HOOKS_PATH, 'commit-msg')
    const messageFile = join(worktree, 'COMMIT_EDITMSG.txt')
    writeFileSync(messageFile, NON_CONVENTIONAL_MESSAGE)
    const run = (env = {}) =>
      spawnSync(hook, [messageFile], {
        cwd: worktree,
        encoding: 'utf8',
        env: { ...process.env, HUSKY: '', ...env },
      })

    // 1. Nothing installed: never pass silently, name the fix.
    const unprovisioned = run()
    assert.notEqual(unprovisioned.status, 0, 'a hook that cannot run must not exit 0')
    assert.match(unprovisioned.stderr, /npm ci/, 'the failure must name the exact fix')

    // 2. Dependencies present: the framework decides (here: a stub failure).
    stubCommitlint(worktree, { exitCode: 1 })
    const failing = run()
    assert.notEqual(failing.status, 0)
    assert.match(failing.stderr, /COMMITLINT_STUB_1/)

    // 3. A passing linter must let the commit through.
    stubCommitlint(worktree, { exitCode: 0 })
    const passing = run()
    assert.equal(passing.status, 0, passing.stderr)

    // 4. HUSKY=0 opt-out is honoured, exactly like husky's shim.
    stubCommitlint(worktree, { exitCode: 1 })
    const bypassed = run({ HUSKY: '0' })
    assert.equal(bypassed.status, 0, 'HUSKY=0 must bypass the hook')
  })
})

test('pre-commit hook refuses to run without node_modules instead of failing opaquely', () => {
  withFreshWorktree((worktree) => {
    const hook = join(worktree, HOOKS_PATH, 'pre-commit')
    const result = spawnSync(hook, [], {
      cwd: worktree,
      encoding: 'utf8',
      env: { ...process.env, HUSKY: '' },
    })
    assert.equal(result.status, 1, 'an unprovisioned worktree must fail the commit')
    assert.match(result.stderr, /npm ci/, 'the message must contain the exact command to fix')
    assert.match(result.stderr, /node_modules/, 'the message must name what is missing')

    const bypassed = spawnSync(hook, [], {
      cwd: worktree,
      encoding: 'utf8',
      env: { ...process.env, HUSKY: '0' },
    })
    assert.equal(bypassed.status, 0, 'HUSKY=0 must bypass the dependency preflight too')
  })
})
