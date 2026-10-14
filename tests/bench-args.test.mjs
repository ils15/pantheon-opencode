/**
 * bench-args.test.mjs — contract tests for bench/lib/args.mjs
 * (beta-10 latency slice, harness complement).
 *
 * Locked contracts:
 *   - the profile is always explicit; a project fixture is only accepted under
 *     the double-injection profile (a fixture that would never load is refused)
 *   - an unknown flag is a hard usage error, never silently ignored
 *   - defaults mirror the fixed protocol (5 runs/scenario, host profile)
 *
 * Run: node --test tests/bench-args.test.mjs
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

const { DEFAULT_LABEL, DEFAULT_RUNS, PROFILES, UsageError, parseBenchArgs } = await import(
  '../bench/lib/args.mjs'
)

test('defaults are the fixed protocol: 5 runs, host profile, baseline label', () => {
  const opts = parseBenchArgs([])
  assert.equal(opts.runs, DEFAULT_RUNS)
  assert.equal(opts.runs, 5)
  assert.equal(opts.profile, 'host')
  assert.equal(opts.label, DEFAULT_LABEL)
  assert.equal(opts.globalAgents, null)
  assert.equal(opts.projectAgents, null)
  assert.deepEqual(PROFILES, ['host', 'double-injection'])
})

test('an unknown flag is rejected as a usage error (never ignored)', () => {
  assert.throws(() => parseBenchArgs(['--profle', 'host']), UsageError)
  assert.throws(() => parseBenchArgs(['--runs', '5', '--oops']), UsageError)
})

test('a flag with a missing value is rejected', () => {
  assert.throws(() => parseBenchArgs(['--runs']), UsageError)
  assert.throws(() => parseBenchArgs(['--label', '--runs', '3']), UsageError)
})

test('--runs must be a positive integer', () => {
  assert.throws(() => parseBenchArgs(['--runs', '0']), UsageError)
  assert.throws(() => parseBenchArgs(['--runs', '1.5']), UsageError)
  assert.throws(() => parseBenchArgs(['--runs', 'abc']), UsageError)
  assert.equal(parseBenchArgs(['--runs', '7']).runs, 7)
})

test('--profile rejects an unknown profile', () => {
  assert.throws(() => parseBenchArgs(['--profile', 'dupla']), UsageError)
  assert.equal(
    parseBenchArgs(['--profile', 'double-injection', '--project-agents', 'p.md']).profile,
    'double-injection',
  )
})

test('a project fixture is only accepted under double-injection', () => {
  // host profile: a project fixture would never be loaded — refuse it.
  assert.throws(() => parseBenchArgs(['--project-agents', 'p.md']), UsageError)
  // double-injection requires the project fixture.
  assert.throws(() => parseBenchArgs(['--profile', 'double-injection']), UsageError)
  const opts = parseBenchArgs([
    '--profile',
    'double-injection',
    '--global-agents',
    'g.md',
    '--project-agents',
    'p.md',
    '--label',
    'candidate',
  ])
  assert.equal(opts.globalAgents, 'g.md')
  assert.equal(opts.projectAgents, 'p.md')
  assert.equal(opts.label, 'candidate')
})

test('--label must be filesystem-safe', () => {
  assert.throws(() => parseBenchArgs(['--label', 'a/b']), UsageError)
  assert.throws(() => parseBenchArgs(['--label', '../x']), UsageError)
  assert.throws(() => parseBenchArgs(['--label', '-x']), UsageError)
  assert.equal(parseBenchArgs(['--label', 'f1.double-injection']).label, 'f1.double-injection')
})

test('--scenarios restricts the interleave to a validated subset', () => {
  assert.deepEqual(parseBenchArgs([]).scenarios, ['A', 'B'])
  assert.deepEqual(parseBenchArgs(['--scenarios', 'B']).scenarios, ['B'])
  assert.deepEqual(parseBenchArgs(['--scenarios', 'b,a']).scenarios, ['A', 'B'])
  assert.deepEqual(parseBenchArgs(['--scenarios', 'B,A,B']).scenarios, ['A', 'B'])
  assert.throws(() => parseBenchArgs(['--scenarios', 'C']), UsageError)
  assert.throws(() => parseBenchArgs(['--scenarios', '']), UsageError)
  assert.throws(() => parseBenchArgs(['--scenarios']), UsageError)
})
