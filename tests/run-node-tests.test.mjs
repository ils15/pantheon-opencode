/**
 * run-node-tests.test.mjs — the zero-test guard for the Node test suites.
 *
 * `node --test <glob>` exits 0 when the glob matches nothing (Node >= 22). This repo hit
 * that for real: `tests/` was missing from the published `files` allow-list, so a package
 * consumer running `npm test` got a green gate that had executed nothing. This file locks
 * in the guard that makes that failure mode impossible.
 *
 * The assertions below run the guard as a subprocess, because the guard's whole job is a
 * process-level contract: what it prints, and what it exits with. Testing it in-process
 * would not exercise the exit codes that matter.
 *
 * Run: node --test tests/run-node-tests.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const GUARD = join(ROOT, 'scripts/run-node-tests.mjs')

/**
 * Run the guard and return its combined output plus exit status.
 *
 * NODE_TEST_CONTEXT is stripped because Node sets it (to `child-v8`) inside a running test
 * file, and a nested `node --test` inherits it and then refuses to run any files. Real
 * invocations (`npm run test:node`) start from a plain shell with no such variable, so
 * clearing it reproduces the environment the guard actually ships in.
 */
function runGuard(args) {
  const env = { ...process.env }
  delete env.NODE_TEST_CONTEXT

  const run = spawnSync(process.execPath, [GUARD, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
  })
  assert.ok(!run.error, `guard must start: ${run.error?.message}`)
  return { status: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` }
}

/**
 * Write a throwaway file inside the repo so the guard's ROOT-relative globbing sees it.
 * Returns both the absolute dir (for cleanup) and the repo-relative glob (for the guard).
 */
function scratchFile(name, contents) {
  const absDir = mkdtempSync(join(ROOT, 'tests/.guard-selftest-'))
  writeFileSync(join(absDir, name), contents)
  const relDir = `tests/${basename(absDir)}`
  return { absDir, glob: `${relDir}/*.mjs` }
}

test('fails non-zero when the glob matches no files', () => {
  const { status, output } = runGuard(['--label', 'selftest', 'tests/.no-such-dir-xyz/*.mjs'])

  assert.equal(status, 1, 'must not report success with zero collected tests')
  assert.match(output, /matched 0 test files/)
  assert.match(output, /refusing to report success/)
})

test('fails non-zero when matched files declare no test cases', () => {
  // Node counts a test file that declares no cases as ONE passing "test", so a suite whose
  // files were all emptied out still exits 0 upstream. The guard must not be fooled by it.
  const scratch = scratchFile('empty.test.mjs', '// no test cases here\nexport const x = 1\n')
  try {
    const { status, output } = runGuard(['--label', 'selftest', scratch.glob])

    assert.equal(status, 1, 'must not report success when zero test CASES were collected')
    assert.match(output, /collected 0 tests/)
  } finally {
    rmSync(scratch.absDir, { recursive: true, force: true })
  }
})

test('passes and does not false-positive when real tests are collected', () => {
  const scratch = scratchFile(
    'real.test.mjs',
    "import { test } from 'node:test'\ntest('runs', () => {})\n",
  )
  try {
    const { status, output } = runGuard(['--label', 'selftest', scratch.glob])

    assert.equal(status, 0, `real tests must pass: ${output}`)
    assert.doesNotMatch(output, /zero-test-guard/, 'guard must stay quiet on a healthy run')
  } finally {
    rmSync(scratch.absDir, { recursive: true, force: true })
  }
})

test('rejects an invocation with no glob at all', () => {
  const { status, output } = runGuard(['--label', 'selftest'])

  assert.equal(status, 1)
  assert.match(output, /at least one glob is required/)
})

test('reports the label so the failing npm script is identifiable in CI output', () => {
  const { output } = runGuard(['--label', 'test:node', 'tests/.no-such-dir-xyz/*.mjs'])

  assert.match(output, /test:node/, 'the npm script name must appear in the failure output')
})

test('every node test script routes through the guard', () => {
  const pkg = JSON.parse(
    spawnSync('node', ['-p', 'JSON.stringify(require("./package.json").scripts)'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).stdout,
  )

  const guarded = ['test:node', 'coverage', 'test:hooks', 'test:tool-canary']
  for (const name of guarded) {
    assert.match(
      pkg[name],
      /run-node-tests\.mjs/,
      `${name} must run through the zero-test guard, got: ${pkg[name]}`,
    )
  }
})
