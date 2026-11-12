import assert from 'node:assert/strict'
import test from 'node:test'
import { getSharedBus, PantheonBus } from '../../src/pantheon/bus.ts'

test('PantheonBus on/emit delivers typed events to listeners', () => {
  const bus = new PantheonBus()
  const received: unknown[] = []

  const unsubscribe = bus.on('job:created', (payload) => {
    received.push(payload)
  })

  bus.emit('job:created', {
    taskID: 'task-1',
    alias: 'apo-1',
    agent: 'apollo',
    timestamp: 1000,
  })

  assert.equal(received.length, 1)
  assert.equal((received[0] as any).alias, 'apo-1')

  unsubscribe()
  bus.emit('job:created', {
    taskID: 'task-2',
    alias: 'apo-2',
    agent: 'apollo',
    timestamp: 2000,
  })
  assert.equal(received.length, 1, 'listener was unsubscribed')
})

test('PantheonBus once fires exactly once and cleans up', () => {
  const bus = new PantheonBus()
  let count = 0

  bus.once('job:terminal', () => {
    count++
  })

  bus.emit('job:terminal', {
    taskID: 'task-1',
    alias: 'her-1',
    agent: 'hermes',
    state: 'completed',
    timestamp: 1000,
  })

  bus.emit('job:terminal', {
    taskID: 'task-1',
    alias: 'her-1',
    agent: 'hermes',
    state: 'completed',
    timestamp: 1001,
  })

  assert.equal(count, 1)
  assert.equal(bus.listenerCount('job:terminal'), 0)
})

test('PantheonBus waitFor resolves on matching event', async () => {
  const bus = new PantheonBus()

  const promise = bus.waitFor('job:terminal', (payload) => payload.taskID === 'target-task')

  bus.emit('job:terminal', {
    taskID: 'other-task',
    alias: 'dem-1',
    agent: 'demeter',
    state: 'completed',
    timestamp: 100,
  })

  bus.emit('job:terminal', {
    taskID: 'target-task',
    alias: 'her-2',
    agent: 'hermes',
    state: 'completed',
    timestamp: 200,
  })

  const result = await promise
  assert.equal(result.taskID, 'target-task')
  assert.equal(result.alias, 'her-2')
})

test('getSharedBus returns persistent process singleton', () => {
  const bus1 = getSharedBus()
  const bus2 = getSharedBus()
  assert.equal(bus1, bus2)
})
