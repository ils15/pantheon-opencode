import assert from 'node:assert/strict'
import test from 'node:test'
import { getSharedBus, type ThemisReflexEventPayload } from '../../src/pantheon/bus.ts'
import { ThemisReflexController } from '../../src/pantheon/themis-reflex.ts'

test('ThemisReflexController passes immediately when no discrepancies', () => {
  const controller = new ThemisReflexController()
  const decision = controller.evaluate('task-100', 'hermes', [])
  assert.equal(decision.action, 'pass')
  assert.equal(decision.verdict, 'PASS')
})

test('ThemisReflexController emits retry prompt on first and second discrepancy', () => {
  const controller = new ThemisReflexController({ maxRetries: 2 })
  const bus = getSharedBus()
  const events: ThemisReflexEventPayload[] = []
  const unsub = bus.on('themis:reflex:discrepancy', (e) => events.push(e))

  try {
    // Attempt 1
    const d1 = controller.evaluate('task-101', 'hermes', [
      { file: 'src/calc.ts', error: 'Type mismatch: expected number, got string' },
    ])
    assert.equal(d1.action, 'retry')
    assert.equal(d1.attempt, 1)
    assert.match(d1.prompt, /Attempt 1\/2/)
    assert.match(d1.prompt, /Type mismatch/)

    // Attempt 2
    const d2 = controller.evaluate('task-101', 'hermes', [
      { file: 'src/calc.ts', error: 'Unused variable x' },
    ])
    assert.equal(d2.action, 'retry')
    assert.equal(d2.attempt, 2)
    assert.match(d2.prompt, /Attempt 2\/2/)

    // Attempt 3: Exhausted
    const d3 = controller.evaluate('task-101', 'hermes', [
      { file: 'src/calc.ts', error: 'Still broken' },
    ])
    assert.equal(d3.action, 'escalate')
    assert.equal(d3.verdict, 'FAIL')
    assert.match(d3.reason, /exhausted/)

    assert.equal(events.length, 3)
    assert.equal(events[0].taskID, 'task-101')
  } finally {
    unsub()
  }
})

test('ThemisReflexController emits resolved event when fix succeeds on retry', () => {
  const controller = new ThemisReflexController({ maxRetries: 2 })
  const bus = getSharedBus()
  let resolvedEvent: ThemisReflexEventPayload | null = null
  const unsub = bus.on('themis:reflex:resolved', (e) => {
    resolvedEvent = e
  })

  try {
    // Attempt 1 fails
    controller.evaluate('task-102', 'demeter', [
      { file: 'src/db.ts', error: 'SyntaxError: Unexpected token' },
    ])
    assert.equal(resolvedEvent, null)

    // Attempt 2 succeeds (empty discrepancies)
    const success = controller.evaluate('task-102', 'demeter', [])
    assert.equal(success.action, 'pass')
    assert.equal(success.verdict, 'PASS')
    assert.ok(resolvedEvent !== null)
    assert.equal(resolvedEvent.taskID, 'task-102')
    assert.equal(resolvedEvent.agent, 'demeter')
  } finally {
    unsub()
  }
})
