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
  assert.equal(opts.agentsDir, null)
  assert.equal(opts.controlAgentsDir, null)
  assert.equal(opts.skillsDir, null)
  assert.equal(opts.promptFile, null)
  assert.equal(opts.paired, false)
  assert.equal(opts.rootAgent, null)
  assert.equal(opts.controlRootAgent, null)
  assert.equal(opts.out, null)
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

test('paired root-agent runs require scenario B, both agents, and a safe output path', () => {
  const opts = parseBenchArgs([
    '--scenario',
    'B',
    '--runs',
    '5',
    '--profile',
    'double-injection',
    '--global-agents',
    'AGENTS.global.md',
    '--project-agents',
    'AGENTS.md',
    '--root-agent',
    'talos',
    '--control-root-agent',
    'zeus',
    '--agents-dir',
    'src/agents',
    '--skills-dir',
    'src/skills',
    '--paired',
    '--out',
    'bench/results/phase3-root-paired-20261014.json',
  ])
  assert.equal(opts.paired, true)
  assert.equal(opts.rootAgent, 'talos')
  assert.equal(opts.controlRootAgent, 'zeus')
  assert.equal(opts.agentsDir, 'src/agents')
  assert.equal(opts.skillsDir, 'src/skills')
  assert.equal(opts.out, 'bench/results/phase3-root-paired-20261014.json')
  assert.deepEqual(opts.scenarios, ['B'])

  assert.throws(() => parseBenchArgs(['--paired']), UsageError)
  assert.throws(
    () =>
      parseBenchArgs([
        '--paired',
        '--root-agent',
        'talos',
        '--control-root-agent',
        'zeus',
        '--profile',
        'double-injection',
        '--global-agents',
        'AGENTS.global.md',
        '--project-agents',
        'AGENTS.md',
        '--agents-dir',
        'src/agents',
        '--skills-dir',
        'src/skills',
        '--out',
        'bench/results/paired.json',
      ]),
    /scenario B/i,
  )
  assert.throws(
    () =>
      parseBenchArgs([
        '--paired',
        '--scenario',
        'B',
        '--root-agent',
        'talos',
        '--control-root-agent',
        'zeus',
        '--profile',
        'double-injection',
        '--global-agents',
        'AGENTS.global.md',
        '--project-agents',
        'AGENTS.md',
        '--skills-dir',
        'src/skills',
        '--out',
        'bench/results/paired.json',
      ]),
    /agents-dir/i,
  )
  assert.throws(
    () =>
      parseBenchArgs([
        '--paired',
        '--scenario',
        'B',
        '--root-agent',
        'talos',
        '--control-root-agent',
        'zeus',
        '--profile',
        'double-injection',
        '--global-agents',
        'AGENTS.global.md',
        '--project-agents',
        'AGENTS.md',
        '--agents-dir',
        'src/agents',
        '--skills-dir',
        'src/skills',
        '--out',
        '../paired.json',
      ]),
    /bench\/results/i,
  )
  assert.throws(
    () =>
      parseBenchArgs([
        '--paired',
        '--scenario',
        'B',
        '--root-agent',
        'talos',
        '--control-root-agent',
        'zeus',
        '--agents-dir',
        'src/agents',
        '--skills-dir',
        'src/skills',
        '--out',
        'bench/results/paired.json',
      ]),
    /double-injection/i,
  )
})

test('paired runs can give control and candidate separate agent prompt directories', () => {
  const opts = parseBenchArgs([
    '--scenario',
    'B',
    '--profile',
    'double-injection',
    '--global-agents',
    'global.md',
    '--project-agents',
    'project.md',
    '--root-agent',
    'zeus',
    '--control-root-agent',
    'zeus',
    '--agents-dir',
    'candidate-agents',
    '--control-agents-dir',
    'control-agents',
    '--routing-parity',
    '--skills-dir',
    'skills',
    '--paired',
    '--out',
    'bench/results/f5-paired.json',
  ])
  assert.equal(opts.agentsDir, 'candidate-agents')
  assert.equal(opts.controlAgentsDir, 'control-agents')
  assert.equal(opts.routingParity, true)
  assert.equal(opts.rootAgent, opts.controlRootAgent)

  assert.throws(
    () => parseBenchArgs(['--control-agents-dir', 'control-agents']),
    /require --paired/,
  )
  assert.throws(() => parseBenchArgs(['--routing-parity']), /require --paired/)
})

test('a task prompt fixture is available only in paired runs', () => {
  const opts = parseBenchArgs([
    '--scenario',
    'B',
    '--profile',
    'double-injection',
    '--global-agents',
    'global.md',
    '--project-agents',
    'project.md',
    '--root-agent',
    'zeus',
    '--control-root-agent',
    'zeus',
    '--agents-dir',
    'candidate-agents',
    '--skills-dir',
    'skills',
    '--paired',
    '--prompt-file',
    'bench/fixtures/task.md',
    '--out',
    'bench/results/f5-followup.json',
  ])
  assert.equal(opts.promptFile, 'bench/fixtures/task.md')
  assert.throws(() => parseBenchArgs(['--prompt-file', 'task.md']), /require --paired/)
  assert.throws(() => parseBenchArgs(['--paired', '--prompt-file']), /requires a value/)
})
