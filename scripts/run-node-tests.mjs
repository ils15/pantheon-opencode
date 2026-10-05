#!/usr/bin/env node
/**
 * Run `node --test` over an explicit file list, and FAIL when zero tests are collected.
 *
 * Why this exists: `node --test <glob>` exits 0 when the glob matches nothing (Node >= 22).
 * A test script whose file set is absent from the checkout -- or absent from the published
 * package, because the `files` allow-list omits it -- therefore reports success while
 * collecting nothing. That is the worst possible failure mode for a release gate: it
 * manufactures confidence.
 *
 * This runner closes that hole from two independent sides:
 *   1. It expands the globs ITSELF and refuses to start the runner with zero files, so the
 *      runner is never handed an unexpanded pattern that silently matches nothing.
 *   2. After a run that exited 0, it re-reads the collected count from the machine-readable
 *      TAP summary and fails closed when that count is 0, unparseable, or missing.
 *
 * Side 2 is deliberately independent of side 1: a future Node change to `--test` glob
 * handling, a glob that expands to a directory of empty files, or an emptied test file all
 * still get caught.
 *
 * Human-readable output is unchanged: the default `spec` reporter still goes to stdout, and
 * the TAP reporter is diverted to a scratch file that is read once and deleted.
 *
 * Usage:
 *   node scripts/run-node-tests.mjs [--label <name>] [-- <node flags...>] <glob>...
 *
 * Examples:
 *   node scripts/run-node-tests.mjs 'tests/*.mjs' 'tests/pantheon/*.mjs'
 *   node scripts/run-node-tests.mjs -- --experimental-test-coverage 'tests/*.mjs'
 */
import { spawnSync } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

function usage(message) {
  console.error(`zero-test-guard: ${message}`)
  console.error(
    'usage: node scripts/run-node-tests.mjs [--label <name>] [-- <node flags...>] <glob>...',
  )
  process.exit(1)
}

/** Parse `[--label <name>] [-- <node flags...>] <glob>...`. */
function parseArgs(argv) {
  const separator = argv.indexOf('--')
  const own = separator === -1 ? argv : argv.slice(0, separator)
  const nodeFlags = separator === -1 ? [] : argv.slice(separator + 1)

  let label = 'node tests'
  const globs = []
  for (let i = 0; i < own.length; i++) {
    if (own[i] === '--label') {
      const value = own[i + 1]
      if (value === undefined) usage('--label requires a value')
      label = value
      i += 1
      continue
    }
    if (own[i].startsWith('-')) usage(`unknown option ${own[i]}`)
    globs.push(own[i])
  }
  if (globs.length === 0) usage('at least one glob is required')
  return { label, globs, nodeFlags }
}

/**
 * Expand globs to a deduped, ordered file list.
 * Order follows the positional order of the globs so that the suite runs in the same order
 * as the shell used to; within a glob, matches are sorted for determinism.
 */
function expand(globs) {
  const files = []
  const seen = new Set()
  for (const pattern of globs) {
    const matches = globSync(pattern, { cwd: ROOT })
      .filter((match) => !match.includes('node_modules') && !match.includes('__pycache__'))
      .sort()
    for (const match of matches) {
      if (seen.has(match)) continue
      seen.add(match)
      files.push(match)
    }
  }
  return files
}

function reportMissingFiles(label, globs) {
  console.error(`zero-test-guard: ${label} matched 0 test files — refusing to report success.`)
  console.error(`  globs: ${globs.join(' ')}`)
  console.error('  This is the "test suite silently passes when it collects nothing" failure.')
  console.error('  Either the test files are missing from this checkout, or they are missing')
  console.error('  from the published package (check the "files" allow-list in package.json).')
}

function reportZeroCollected(label, files) {
  console.error(`zero-test-guard: ${label} collected 0 tests — refusing to report success.`)
  console.error(`  ${files.length} file(s) matched, but not one test case was collected:`)
  for (const file of files) console.error(`    ${file}`)
}

/**
 * Count the real test cases collected in a TAP summary.
 *
 * Node counts a test FILE that declares no test cases as one passing "test"
 * (`ok 1 - tests/foo.test.mjs`), so the summary's `# tests N` is >= the file count and
 * can never reach 0 once any file matched. Relying on it alone would let a suite whose
 * every test file was emptied out report success.
 *
 * The reliable discriminator is the subtest NAME: a file-level placeholder is named with
 * the file path that was passed to the runner, a real test case is named with its test
 * name. So a top-level subtest whose name is one of our matched paths is a placeholder
 * and is not counted as a collected case.
 *
 * Returns null when the summary cannot be read or parsed -- the caller fails closed.
 */
function countCollectedTests(tapPath, files) {
  let tap = ''
  try {
    tap = readFileSync(tapPath, 'utf8')
  } catch {
    return null
  }
  // The summary count is still asserted to exist: without it the stream is not TAP.
  if (!/^#\s*tests\s+\d+\s*$/m.test(tap)) return null

  const placeholders = new Set(files)
  let collected = 0
  for (const match of tap.matchAll(/^# Subtest: (.+)$/gm)) {
    if (placeholders.has(match[1].trim())) continue
    collected += 1
  }
  return collected
}

const { label, globs, nodeFlags } = parseArgs(process.argv.slice(2))
const files = expand(globs)

if (files.length === 0) {
  reportMissingFiles(label, globs)
  process.exit(1)
}

const scratch = mkdtempSync(join(tmpdir(), 'pantheon-node-tests-'))
const tapPath = join(scratch, 'summary.tap')

try {
  const run = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=tap',
      `--test-reporter-destination=${tapPath}`,
      ...nodeFlags,
      ...files,
    ],
    { cwd: ROOT, stdio: 'inherit' },
  )

  if (run.error) {
    console.error(`zero-test-guard: could not start the test runner: ${run.error.message}`)
    process.exit(1)
  }
  if (run.signal) {
    console.error(`zero-test-guard: the test runner was killed by ${run.signal}`)
    process.exit(1)
  }
  // Real failures keep the runner's own exit code; the guard only speaks up when the
  // runner claimed success it cannot justify.
  if (run.status !== 0) process.exit(run.status)

  const collected = countCollectedTests(tapPath, files)
  if (collected === null) {
    console.error('zero-test-guard: could not read the collected test count from the TAP summary.')
    console.error('  Failing closed: an unreadable summary cannot certify that any test ran.')
    process.exit(1)
  }
  if (collected === 0) {
    reportZeroCollected(label, files)
    process.exit(1)
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
