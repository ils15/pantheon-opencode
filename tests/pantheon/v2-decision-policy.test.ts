/**
 * Deterministic policy: selection, gates, shadow/active and budget.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-policy.test.ts
 */
import { strict as assert } from 'node:assert'
import {
  createDecisionBudget,
  DECISION_POLICY_VERSION,
  evaluateDecisionPolicy,
} from '../../src/pantheon/v2-decision-policy.ts'
import { DECISION_POINT_REGISTRY } from '../../src/pantheon/v2-decision-registry.ts'

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
  checks += 1
  void name
}

const shadowPoint = {
  point: 'P1',
  pointMode: 'shadow' as const,
  status: 'measured' as const,
}

check('shadow is the default and never claims an effect', () => {
  const decision = evaluateDecisionPolicy({}, shadowPoint)
  assert.equal(decision.admitted, true)
  assert.equal(decision.mode, 'shadow')
  assert.equal(decision.effect, 'none')
  assert.equal(decision.reasonCode, 'SHADOW')
  assert.equal(decision.version, DECISION_POLICY_VERSION)
})

check('the same request always yields the same decision', () => {
  const first = evaluateDecisionPolicy({ closedGates: ['C6'] }, shadowPoint)
  const second = evaluateDecisionPolicy({ closedGates: ['C6'] }, shadowPoint)
  assert.deepEqual(first, second)
})

check('active mode requires explicit permission', () => {
  const denied = evaluateDecisionPolicy({ mode: 'active' }, shadowPoint)
  assert.equal(denied.admitted, false)
  assert.equal(denied.reasonCode, 'ACTIVE_NOT_ALLOWED')
  assert.equal(denied.effect, 'none')

  const allowed = evaluateDecisionPolicy({ mode: 'active', allowActive: true }, shadowPoint)
  assert.equal(allowed.admitted, true)
  assert.equal(allowed.mode, 'active')
  assert.equal(allowed.reasonCode, 'ACTIVE')
  assert.equal(allowed.effect, 'none', 'admission is not an effect')
})

check('a closed required gate denies admission', () => {
  const decision = evaluateDecisionPolicy(
    { closedGates: ['C6', 'C8'] },
    { ...shadowPoint, requiredGates: ['C6'] },
  )
  assert.equal(decision.admitted, false)
  assert.equal(decision.reasonCode, 'GATE_CLOSED')
})

check('a gate is only consulted when the point requires it', () => {
  const decision = evaluateDecisionPolicy(
    { closedGates: ['C6'] },
    { ...shadowPoint, requiredGates: ['C9'] },
  )
  assert.equal(decision.admitted, true)
})

check('unknown points are denied', () => {
  const decision = evaluateDecisionPolicy({}, { ...shadowPoint, point: 'P99' })
  assert.equal(decision.admitted, false)
  assert.equal(decision.reasonCode, 'UNKNOWN_POINT')
})

check('deferred points are denied with no effect', () => {
  const decision = evaluateDecisionPolicy(
    {},
    { point: 'P7', pointMode: 'migration', status: 'deferred' },
  )
  assert.equal(decision.admitted, false)
  assert.equal(decision.reasonCode, 'DEFERRED_POINT')
  assert.equal(decision.effect, 'none')
})

check('off points are denied', () => {
  const decision = evaluateDecisionPolicy({}, { point: 'P8', pointMode: 'off', status: 'premise' })
  assert.equal(decision.admitted, false)
  assert.equal(decision.reasonCode, 'POINT_OFF')
})

check('migration is never admitted as shadow', () => {
  const decision = evaluateDecisionPolicy(
    {},
    { point: 'P7', pointMode: 'migration', status: 'measured' },
  )
  assert.equal(decision.admitted, false)
  assert.equal(decision.reasonCode, 'MIGRATION_NOT_SHADOW')
})

check('budget denies after the per-turn allowance is consumed', () => {
  const budget = createDecisionBudget(2)
  const config = { budget }
  assert.equal(evaluateDecisionPolicy(config, shadowPoint).admitted, true)
  assert.equal(evaluateDecisionPolicy(config, shadowPoint).admitted, true)
  const exhausted = evaluateDecisionPolicy(config, shadowPoint)
  assert.equal(exhausted.admitted, false)
  assert.equal(exhausted.reasonCode, 'BUDGET_EXHAUSTED')
  assert.deepEqual(budget.snapshot(), { maxPerTurn: 2, used: 2, remaining: 0 })
})

check('budget resets per turn and never goes negative', () => {
  const budget = createDecisionBudget(1)
  assert.equal(budget.tryConsume(), true)
  assert.equal(budget.tryConsume(), false)
  assert.equal(budget.remaining(), 0)
  budget.resetTurn()
  assert.equal(budget.remaining(), 1)
  assert.equal(budget.tryConsume(), true)
})

check('an invalid budget size is rejected at construction', () => {
  for (const size of [-1, 1.5, Number.NaN, 10_001]) {
    assert.throws(() => createDecisionBudget(size))
  }
})

check('every registry point has a policy outcome and deferred/off stay denied', () => {
  for (const point of DECISION_POINT_REGISTRY) {
    const decision = evaluateDecisionPolicy(
      {},
      { point: point.id, pointMode: point.mode, status: point.status },
    )
    assert.equal(decision.effect, 'none', point.id)
    if (point.status === 'deferred' || point.mode === 'off') {
      assert.equal(decision.admitted, false, point.id)
    }
  }
})

console.log(`V2 decision policy: ${checks} groups passed`)
