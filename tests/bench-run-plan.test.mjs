import { strict as assert } from 'node:assert'
import { test } from 'node:test'

const { buildRunPlan } = await import('../bench/lib/run-plan.mjs')

test('paired scenario B order interleaves control then candidate for each pair', () => {
  const plan = buildRunPlan(3, ['B'], { controlRootAgent: 'zeus', rootAgent: 'talos' })
  assert.deepEqual(
    plan.map(({ pair, arm, agent }) => [pair, arm, agent]),
    [
      [1, 'control', 'zeus'],
      [1, 'candidate', 'talos'],
      [2, 'control', 'zeus'],
      [2, 'candidate', 'talos'],
      [3, 'control', 'zeus'],
      [3, 'candidate', 'talos'],
    ],
  )
})

test('the existing non-paired scenario order remains unchanged', () => {
  assert.deepEqual(buildRunPlan(2, ['A', 'B']), [
    { scenario: 'A', arm: null, agent: 'zeus', pair: 1 },
    { scenario: 'B', arm: null, agent: 'zeus', pair: 1 },
    { scenario: 'A', arm: null, agent: 'zeus', pair: 2 },
    { scenario: 'B', arm: null, agent: 'zeus', pair: 2 },
  ])
})
