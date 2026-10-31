/**
 * P3 (complexity) shadow behaviour — closes D1 and D4 with assertions.
 *
 * D1: the same complexity vector produces a different decision and reason for
 * each gate status, so `gateStatus` is observably part of the decision instead
 * of a field that is merely copied through.
 *
 * D4: the label is the maximum over the dimensions (higher = more complex) and
 * the ordinal level rises with it; the polarity is asserted over the whole
 * vector space, not one example.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-p3.test.ts
 */
import { strict as assert } from 'node:assert'
import { LOCAL_DECISION_COMPLEXITY_DIMENSIONS } from '../../src/pantheon/local-decision-router.ts'
import {
  COMPLEXITY_LABEL_LEVEL,
  type ComplexityLabel,
  evaluateComplexityPoint,
} from '../../src/pantheon/v2-decision-points/p3-complexity.ts'

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
  checks += 1
  void name
}

const dimensions = (score: 0 | 1 | 2, overrides: Record<string, 0 | 1 | 2> = {}) => ({
  boundedness: score,
  reversibility: score,
  dependencies: score,
  uncertainty: score,
  verification: score,
  ...overrides,
})

const low = dimensions(0)
const high = dimensions(0, { verification: 2 })

check('D1: gateStatus changes the decision observably', () => {
  const gates = ['none', 'review_required', 'human_approval_required', 'unresolved'] as const
  const outcomes = gates.map((gateStatus) => {
    const result = evaluateComplexityPoint({ complexity: low, gateStatus })
    assert.equal(result.gateStatus, gateStatus)
    assert.equal(result.label, 'low', 'the gate never changes the label itself')
    return `${result.record.decision}/${result.record.reason}`
  })
  assert.deepEqual(outcomes, [
    'score.low/gate.none',
    'advisory.low/gate.review.required',
    'refusal/gate.human.approval.required',
    'refusal/gate.unresolved',
  ])
  assert.equal(new Set(outcomes).size, gates.length, 'every gate outcome is distinct')
})

check('D1: the refusal gates are refusals, not a silent score', () => {
  for (const gateStatus of ['human_approval_required', 'unresolved'] as const) {
    const result = evaluateComplexityPoint({ complexity: high, gateStatus })
    assert.equal(result.record.decision, 'refusal', gateStatus)
    assert.equal(result.record.effect, 'none', gateStatus)
  }
})

check('D1: an unknown gate or an invalid vector refuses with its own reason', () => {
  assert.equal(
    evaluateComplexityPoint({ complexity: low, gateStatus: 'later' }).reason,
    'invalid.gate',
  )
  assert.equal(
    evaluateComplexityPoint({ complexity: { boundedness: 0 } }).reason,
    'complexity.invalid',
  )
  assert.equal(evaluateComplexityPoint(null).reason, 'complexity.invalid')
})

check('D4: the label is the maximum over the dimensions', () => {
  const expected: Record<number, ComplexityLabel> = { 0: 'low', 1: 'medium', 2: 'high' }
  let vectors = 0
  for (const boundedness of [0, 1, 2] as const) {
    for (const reversibility of [0, 1, 2] as const) {
      for (const dependencies of [0, 1, 2] as const) {
        for (const uncertainty of [0, 1, 2] as const) {
          for (const verification of [0, 1, 2] as const) {
            const complexity = {
              boundedness,
              reversibility,
              dependencies,
              uncertainty,
              verification,
            }
            const max = Math.max(...Object.values(complexity))
            const result = evaluateComplexityPoint({ complexity, gateStatus: 'none' })
            assert.equal(result.label, expected[max])
            assert.equal(result.level, COMPLEXITY_LABEL_LEVEL[result.label as 'low'])
            vectors += 1
          }
        }
      }
    }
  }
  assert.equal(vectors, 3 ** LOCAL_DECISION_COMPLEXITY_DIMENSIONS.length)
})

check('D4: raising any dimension never lowers the label or the level', () => {
  const level = (label: ComplexityLabel): number =>
    label === 'abstain' ? 0 : COMPLEXITY_LABEL_LEVEL[label]
  for (const dimension of LOCAL_DECISION_COMPLEXITY_DIMENSIONS) {
    for (let from = 0; from < 2; from += 1) {
      const before = evaluateComplexityPoint({
        complexity: dimensions(0, { [dimension]: from as 0 | 1 }),
        gateStatus: 'none',
      })
      const after = evaluateComplexityPoint({
        complexity: dimensions(0, { [dimension]: (from + 1) as 1 | 2 }),
        gateStatus: 'none',
      })
      assert.ok(level(after.label) >= level(before.label), dimension)
    }
  }
  assert.ok(COMPLEXITY_LABEL_LEVEL.low < COMPLEXITY_LABEL_LEVEL.medium)
  assert.ok(COMPLEXITY_LABEL_LEVEL.medium < COMPLEXITY_LABEL_LEVEL.high)
})

check('shadow: the input is untouched and the record says effect none', () => {
  const input = { complexity: high, gateStatus: 'none' }
  const before = structuredClone(input)
  const result = evaluateComplexityPoint(input)
  assert.deepEqual(input, before)
  assert.deepEqual(result.record, {
    point: 'P3',
    decision: 'score.high',
    effect: 'none',
    reason: 'gate.none',
  })
})

console.log(`V2 decision P3: ${checks} groups passed`)
