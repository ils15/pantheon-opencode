/**
 * bench-aggregate.test.mjs — TDD contract tests for bench/lib/aggregate.mjs
 * (beta-10 latency slice, Phase 0 baseline harness).
 *
 * Locked contracts:
 *   - root + children token aggregation counts each session's messages ONCE
 *     (no double counting through parent aggregates or tree traversal)
 *   - a failed / interrupted / timeout / non-zero-exit run is NOT counted as
 *     completed and never enters the median/p80 pools
 *   - an unavailable metric is reported as {status:'unavailable', reason} —
 *     never as zero
 *
 * Run: node --test tests/bench-aggregate.test.mjs
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'

const {
  aggregateSessionTree,
  median,
  percentile,
  runIsCompleted,
  summarizeRuns,
  summarizeRunsByArm,
} = await import('../bench/lib/aggregate.mjs')

// ─── median / percentile ─────────────────────────────────────────────────

test('median of an odd-sized sample is the middle value', () => {
  assert.equal(median([5, 1, 3]), 3)
})

test('median of an even-sized sample is the mean of the two middle values', () => {
  assert.equal(median([4, 1, 3, 2]), 2.5)
})

test('median does not mutate the input array', () => {
  const values = [3, 1, 2]
  median(values)
  assert.deepEqual(values, [3, 1, 2])
})

test('median of an empty sample throws — empty is upstream "unavailable", never 0', () => {
  assert.throws(() => median([]), /empty/i)
})

test('percentile(0.8) uses nearest-rank over the sorted sample', () => {
  // sorted: [10,20,30,40,50] → ceil(0.8*5)=4 → 4th value = 40
  assert.equal(percentile([50, 10, 30, 20, 40], 0.8), 40)
  // sorted: [1..10] → ceil(8)=8 → 8th value = 8
  assert.equal(percentile([10, 5, 3, 8, 1, 9, 2, 4, 7, 6], 0.8), 8)
})

test('paired arm summaries keep candidate and control samples separate', () => {
  const summaries = summarizeRunsByArm([
    { arm: 'control', scenario: 'B', status: 'completed', wallMs: 200, childrenCount: 1 },
    { arm: 'candidate', scenario: 'B', status: 'completed', wallMs: 100, childrenCount: 0 },
    { arm: 'candidate', scenario: 'B', status: 'failed', wallMs: 300, childrenCount: null },
  ])
  assert.equal(summaries.control.runs, 1)
  assert.equal(summaries.control.wallMs.median, 200)
  assert.equal(summaries.candidate.runs, 2)
  assert.equal(summaries.candidate.completed, 1)
  assert.equal(summaries.candidate.failures, 1)
  assert.equal(summaries.candidate.wallMs.median, 100)
})

// ─── runIsCompleted ──────────────────────────────────────────────────────

test('a clean run with a succeeded root session is completed', () => {
  assert.equal(
    runIsCompleted({ exitCode: 0, timedOut: false, rootSession: { idle_outcome: 'succeeded' } }),
    true,
  )
})

test('a root session that ended failed or interrupted is NOT completed', () => {
  assert.equal(
    runIsCompleted({ exitCode: 0, timedOut: false, rootSession: { idle_outcome: 'failed' } }),
    false,
  )
  assert.equal(
    runIsCompleted({ exitCode: 0, timedOut: false, rootSession: { idle_outcome: 'interrupted' } }),
    false,
  )
})

test('a timed-out run is NOT completed even with exit code 0 from a killed child', () => {
  assert.equal(
    runIsCompleted({ exitCode: null, timedOut: true, rootSession: { idle_outcome: 'succeeded' } }),
    false,
  )
})

test('a non-zero exit run is NOT completed', () => {
  assert.equal(
    runIsCompleted({ exitCode: 1, timedOut: false, rootSession: { idle_outcome: 'succeeded' } }),
    false,
  )
})

test('a run whose root session cannot be found in the db is NOT completed', () => {
  assert.equal(runIsCompleted({ exitCode: 0, timedOut: false, rootSession: null }), false)
})

// ─── aggregateSessionTree ────────────────────────────────────────────────

const TREE_SESSIONS = [
  { id: 'root', parent_id: null, idle_outcome: 'succeeded' },
  { id: 'child1', parent_id: 'root', idle_outcome: 'succeeded' },
  { id: 'child2', parent_id: 'root', idle_outcome: 'succeeded' },
  { id: 'grandchild', parent_id: 'child1', idle_outcome: 'succeeded' },
]

const TREE_MESSAGES = [
  {
    session_id: 'root',
    tokens: { input: 100, output: 10, reasoning: 1, cache: { read: 5, write: 2 } },
  },
  {
    session_id: 'root',
    tokens: { input: 200, output: 20, reasoning: 2, cache: { read: 6, write: 3 } },
  },
  {
    session_id: 'child1',
    tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 1, write: 0 } },
  },
  {
    session_id: 'child2',
    tokens: { input: 70, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
  },
  {
    session_id: 'grandchild',
    tokens: { input: 30, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
  },
]

test('tree aggregation sums root + descendants exactly once per session', () => {
  const agg = aggregateSessionTree(TREE_SESSIONS, TREE_MESSAGES, 'root')
  assert.equal(agg.childrenCount, 3)
  assert.equal(agg.tokens.input, 100 + 200 + 50 + 70 + 30)
  assert.equal(agg.tokens.output, 10 + 20 + 5 + 7 + 3)
})

test('messages of sessions outside the tree are never counted (double-count guard)', () => {
  const withStray = [
    ...TREE_MESSAGES,
    {
      session_id: 'unrelated-session',
      tokens: { input: 99999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  ]
  const agg = aggregateSessionTree(TREE_SESSIONS, withStray, 'root')
  assert.equal(agg.tokens.input, 450)
})

test('cache and reasoning tokens are carried through when present', () => {
  const agg = aggregateSessionTree(TREE_SESSIONS, TREE_MESSAGES, 'root')
  assert.equal(agg.tokens.cacheRead, 5 + 6 + 1 + 0 + 0)
  assert.equal(agg.tokens.cacheWrite, 2 + 3 + 0 + 0 + 0)
  assert.equal(agg.tokens.reasoning, 3)
})

test('cycles in the parent chain cannot double count (visited-once traversal)', () => {
  const cyclic = [
    { id: 'root', parent_id: null, idle_outcome: 'succeeded' },
    { id: 'a', parent_id: 'root', idle_outcome: 'succeeded' },
    { id: 'b', parent_id: 'a', idle_outcome: 'succeeded' },
    // hostile row: makes b a (re)child of root
    { id: 'a', parent_id: 'b', idle_outcome: 'succeeded' },
  ]
  const msgs = [
    {
      session_id: 'a',
      tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    {
      session_id: 'b',
      tokens: { input: 20, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  ]
  const agg = aggregateSessionTree(cyclic, msgs, 'root')
  assert.equal(agg.tokens.input, 30)
})

// ─── summarizeRuns ───────────────────────────────────────────────────────

function run(overrides) {
  return {
    scenario: 'A',
    status: 'completed',
    wallMs: 1000,
    tokens: {
      status: 'ok',
      input: 100,
      output: 10,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    toolCalls: { shell: 3 },
    childrenCount: 1,
    failureReason: null,
    ...overrides,
  }
}

test('summarizeRuns reports median + p80 over completed runs only', () => {
  const summary = summarizeRuns([
    run({ wallMs: 1000 }),
    run({ wallMs: 2000 }),
    run({ wallMs: 3000 }),
    run({ wallMs: 4000, status: 'failed', failureReason: 'timeout', tokens: null }),
  ])
  assert.equal(summary.runs, 4)
  assert.equal(summary.completed, 3)
  assert.equal(summary.failures, 1)
  assert.equal(summary.wallMs.median, 2000)
  assert.equal(summary.wallMs.p80, 3000)
  assert.equal(summary.tokens.status, 'ok')
  assert.equal(summary.tokens.completeRuns, 3)
})

test('per-scenario first-request proxy reports medians and refuses partial coverage', () => {
  const summary = summarizeRuns([
    run({
      scenario: 'B',
      firstRequest: { status: 'ok', input: 100, cacheRead: 20, contextTokens: 120 },
    }),
    run({
      scenario: 'B',
      firstRequest: { status: 'ok', input: 90, cacheRead: 30, contextTokens: 120 },
    }),
  ])
  assert.deepEqual(summary.perScenario.B.firstRequest, {
    status: 'ok',
    contextTokens: { median: 120, p80: 120, n: 2 },
    input: { median: 95, p80: 100, n: 2 },
    cacheRead: { median: 25, p80: 30, n: 2 },
    completeRuns: 2,
    completedRuns: 2,
  })

  const incomplete = summarizeRuns([
    run({
      scenario: 'B',
      firstRequest: { status: 'ok', input: 100, cacheRead: 20, contextTokens: 120 },
    }),
    run({ scenario: 'B', firstRequest: { status: 'unavailable', reason: 'missing cache field' } }),
  ])
  assert.equal(incomplete.perScenario.B.firstRequest.status, 'unavailable')
  assert.equal(incomplete.perScenario.B.firstRequest.completeRuns, 1)
  assert.equal('contextTokens' in incomplete.perScenario.B.firstRequest, false)
})

test('summarizeRuns keeps per-name tool call totals over completed runs', () => {
  const summary = summarizeRuns([
    run({ toolCalls: { shell: 3, edit: 1 } }),
    run({ toolCalls: { shell: 2 } }),
  ])
  assert.deepEqual(summary.toolCalls, { shell: 5, edit: 1 })
})

test('summarizeRuns of zero completed runs yields unavailable metrics, not zeros', () => {
  const summary = summarizeRuns([run({ status: 'failed', failureReason: 'timeout', tokens: null })])
  assert.equal(summary.completed, 0)
  assert.equal(summary.wallMs.status, 'unavailable')
  assert.ok(summary.wallMs.reason.length > 0)
  assert.equal(summary.tokens.status, 'unavailable')
})

test('unavailable or incomplete token records never become numeric zero totals', () => {
  const summary = summarizeRuns([
    run({ tokens: { status: 'unavailable', reason: 'ledger missing' } }),
    run({ tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0 } }),
  ])
  assert.equal(summary.completed, 2)
  assert.equal(summary.tokens.status, 'unavailable')
})

test('mixed complete and incomplete token runs make the whole total unavailable', () => {
  const summary = summarizeRuns([
    run({
      tokens: { status: 'ok', input: 100, output: 10, reasoning: 0, cacheRead: 3, cacheWrite: 0 },
    }),
    run({
      tokens: {
        status: 'unavailable',
        reason: 'incomplete token fields: cacheRead',
        tokenMessages: 2,
        tokenFieldMessages: { input: 2, output: 2, reasoning: 2, cacheRead: 1, cacheWrite: 2 },
      },
    }),
  ])
  assert.deepEqual(summary.tokens, {
    status: 'unavailable',
    reason: 'token fields unavailable or incomplete for one or more completed runs',
    completeRuns: 1,
    completedRuns: 2,
  })
})

test('summarizeRuns splits per scenario', () => {
  const summary = summarizeRuns([
    run({ scenario: 'A', wallMs: 1000 }),
    run({ scenario: 'B', wallMs: 500 }),
    run({ scenario: 'B', wallMs: 700 }),
  ])
  assert.equal(summary.perScenario.A.runs, 1)
  assert.equal(summary.perScenario.B.runs, 2)
  assert.equal(summary.perScenario.B.wallMs.median, 600)
})
