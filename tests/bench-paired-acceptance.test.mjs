import { strict as assert } from 'node:assert'
import { test } from 'node:test'

const { assessPairedRun, summarizePairedRunsByArm } = await import(
  '../bench/lib/paired-acceptance.mjs'
)

function candidate(overrides = {}) {
  return {
    arm: 'candidate',
    completed: true,
    requestedAgent: 'talos',
    observedAgent: 'talos',
    rootAvailable: true,
    rootParentId: null,
    childrenCount: 0,
    toolCalls: {},
    instructions: {
      status: 'ok',
      entryCount: 2,
      entries: [
        { bytes: 10, sha256: 'global-hash' },
        { bytes: 20, sha256: 'project-hash' },
      ],
    },
    globalInstructionFixture: { bytes: 10, sha256: 'global-hash' },
    projectInstructionFixture: { bytes: 20, sha256: 'project-hash' },
    ...overrides,
  }
}

test('candidate eligibility requires completed root identity, no parent, no child, and tool ledger', () => {
  assert.deepEqual(assessPairedRun(candidate()), {
    status: 'eligible',
    checks: {
      runtimeCompleted: true,
      rootAgentMatches: true,
      rootHasNoParent: true,
      doubleInjectionProvenance: true,
      hasNoChildren: true,
      didNotAttemptSubagent: true,
    },
  })
})

test('wrong identity, parent, child, or delegation attempt makes the candidate ineligible', () => {
  for (const override of [
    { observedAgent: 'zeus' },
    { rootParentId: 'ses_parent' },
    { childrenCount: 1 },
    { toolCalls: { subagent: 1 } },
    { completed: false },
  ]) {
    assert.equal(assessPairedRun(candidate(override)).status, 'ineligible')
  }
})

test('missing identity, children, or tool-call ledger is unavailable rather than passing', () => {
  for (const override of [
    { rootAvailable: false, observedAgent: null, rootParentId: null },
    { childrenCount: null },
    { toolCalls: { status: 'unavailable', reason: 'ledger missing' } },
  ]) {
    assert.equal(assessPairedRun(candidate(override)).status, 'unavailable')
  }
})

test('unavailable or mismatched D4 instruction provenance cannot enter a paired summary', () => {
  const unavailable = candidate({ instructions: { status: 'unavailable', reason: 'missing' } })
  assert.equal(assessPairedRun(unavailable).status, 'unavailable')

  const mismatch = candidate({
    instructions: {
      status: 'ok',
      entryCount: 2,
      entries: [
        { bytes: 10, sha256: 'wrong-global' },
        { bytes: 20, sha256: 'project-hash' },
      ],
    },
  })
  assert.equal(assessPairedRun(mismatch).status, 'ineligible')
})

test('paired arm metrics contain only completed acceptance-eligible runs', () => {
  const runs = [
    {
      arm: 'control',
      status: 'completed',
      wallMs: 200,
      tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      armAcceptance: { status: 'eligible' },
    },
    {
      arm: 'candidate',
      status: 'completed',
      wallMs: 100,
      tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      armAcceptance: { status: 'eligible' },
    },
    {
      arm: 'candidate',
      status: 'completed',
      wallMs: 50,
      tokens: { input: 1, output: 1, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
      armAcceptance: { status: 'ineligible' },
    },
    {
      arm: 'candidate',
      status: 'failed',
      wallMs: 300,
      tokens: null,
      armAcceptance: { status: 'unavailable' },
    },
  ]
  const summaries = summarizePairedRunsByArm(runs)
  assert.equal(summaries.control.runs, 1)
  assert.equal(summaries.control.metrics.wallMs.median, 200)
  assert.equal(summaries.candidate.runs, 3)
  assert.equal(summaries.candidate.eligible, 1)
  assert.equal(summaries.candidate.ineligible, 1)
  assert.equal(summaries.candidate.unavailable, 1)
  assert.equal(summaries.candidate.metrics.wallMs.median, 100)
})
