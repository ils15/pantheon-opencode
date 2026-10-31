/**
 * Heuristic: evidence counts only, refusal on ties and insufficient evidence.
 *
 * The file also asserts the structural rule from product decision #1: the
 * outcome carries no scalar certainty field.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-heuristic.test.ts
 */
import { strict as assert } from 'node:assert'
import { decideHeuristic } from '../../src/pantheon/v2-decision-heuristic.ts'

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
  checks += 1
  void name
}

check('a unique maximum wins', () => {
  const outcome = decideHeuristic({
    candidates: [
      { id: 'alpha', evidence: ['F-01', 'F-02'] },
      { id: 'beta', evidence: ['F-03'] },
    ],
  })
  assert.deepEqual(outcome, {
    kind: 'choice',
    candidateId: 'alpha',
    evidenceCount: 2,
    reasonCode: 'UNIQUE_MAX_EVIDENCE',
  })
})

check('duplicate evidence ids count once', () => {
  const outcome = decideHeuristic({
    candidates: [
      { id: 'alpha', evidence: ['F-01', 'F-01', 'F-01'] },
      { id: 'beta', evidence: ['F-02'] },
    ],
  })
  assert.equal(outcome.kind, 'refusal')
  if (outcome.kind === 'refusal') assert.equal(outcome.reasonCode, 'TIE')
})

check('a tie refuses instead of inventing a tie-break', () => {
  const outcome = decideHeuristic({
    candidates: [
      { id: 'zeta', evidence: ['F-01'] },
      { id: 'alpha', evidence: ['F-02'] },
    ],
  })
  assert.deepEqual(outcome, {
    kind: 'refusal',
    reasonCode: 'TIE',
    candidateIds: ['alpha', 'zeta'],
  })
})

check('a winner below the evidence floor refuses', () => {
  const outcome = decideHeuristic({
    candidates: [{ id: 'alpha', evidence: ['F-01'] }],
    minimumEvidence: 2,
  })
  assert.equal(outcome.kind, 'refusal')
  if (outcome.kind === 'refusal') {
    assert.equal(outcome.reasonCode, 'INSUFFICIENT_EVIDENCE')
    assert.deepEqual(outcome.candidateIds, ['alpha'])
  }
})

check('zero evidence everywhere is insufficient, not a choice', () => {
  const outcome = decideHeuristic({
    candidates: [
      { id: 'alpha', evidence: [] },
      { id: 'beta', evidence: [] },
    ],
  })
  assert.equal(outcome.kind, 'refusal')
  if (outcome.kind === 'refusal') assert.equal(outcome.reasonCode, 'INSUFFICIENT_EVIDENCE')
})

check('no candidates refuses', () => {
  const outcome = decideHeuristic({ candidates: [] })
  assert.deepEqual(outcome, { kind: 'refusal', reasonCode: 'NO_CANDIDATES', candidateIds: [] })
})

check('malformed requests refuse as invalid input', () => {
  const requests: unknown[] = [
    null,
    {},
    { candidates: 'nope' },
    { candidates: [{ id: 'a b', evidence: [] }] },
    { candidates: [{ id: 'alpha', evidence: 'F-01' }] },
    { candidates: [{ id: 'alpha', evidence: [1] }] },
    {
      candidates: [
        { id: 'alpha', evidence: [] },
        { id: 'alpha', evidence: ['F-01'] },
      ],
    },
    { candidates: [{ id: 'alpha', evidence: ['F-01'] }], minimumEvidence: 0 },
    { candidates: [{ id: 'alpha', evidence: ['F-01'] }], minimumEvidence: 101 },
    { candidates: [{ id: 'alpha', evidence: ['F-01'] }], minimumEvidence: 1.5 },
  ]
  for (const request of requests) {
    const outcome = decideHeuristic(request)
    assert.equal(outcome.kind, 'refusal', JSON.stringify(request))
    if (outcome.kind === 'refusal') assert.equal(outcome.reasonCode, 'INVALID_INPUT')
  }
})

check('the outcome carries no scalar certainty field', () => {
  const outcomes = [
    decideHeuristic({ candidates: [{ id: 'alpha', evidence: ['F-01'] }] }),
    decideHeuristic({ candidates: [] }),
  ]
  for (const outcome of outcomes) {
    assert.equal(Object.hasOwn(outcome, 'confidence'), false)
    assert.equal(JSON.stringify(outcome).includes('confidence'), false)
  }
})

check('the decision is deterministic', () => {
  const request = {
    candidates: [
      { id: 'beta', evidence: ['F-02'] },
      { id: 'alpha', evidence: ['F-01'] },
    ],
  }
  assert.deepEqual(decideHeuristic(request), decideHeuristic(request))
})

console.log(`V2 decision heuristic: ${checks} groups passed`)
