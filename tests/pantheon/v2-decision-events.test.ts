/**
 * Event-consumption contract (F-11/F-13, PLAN §5.2).
 *
 * These tests are adversarial about the two ways this contract was violated in
 * the past: registering a callback (never invoked) and reading the legacy
 * envelope field (absent from the measured shape). The fake envelope exposes a
 * throwing getter for that field, so any read is observable as a failure.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-events.test.ts
 */
import { strict as assert } from 'node:assert'
import {
  consumeDecisionEvents,
  type DecisionEvent,
  type DecisionEventSource,
  type EventSubscribeOptions,
  type HostEventEnvelope,
  P7_TURN_END_EVENT_TYPE,
  readEventSessionID,
} from '../../src/pantheon/v2-decision-events.ts'
import { HOST_EVENT_ENVELOPES_F13 } from './v2-decision-fixtures.ts'

let checks = 0
const check = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  await fn()
  checks += 1
  void name
}

async function* iterate(items: readonly unknown[]): AsyncIterable<HostEventEnvelope> {
  for (const item of items) yield item as HostEventEnvelope
}

interface SubscribeRecord {
  calls: EventSubscribeOptions[]
  argumentCounts: number[]
}

function sourceOf(items: readonly unknown[], record?: SubscribeRecord): DecisionEventSource {
  return {
    subscribe(...args: [EventSubscribeOptions]) {
      const options = args[0]
      record?.calls.push(options)
      record?.argumentCounts.push(args.length)
      return iterate(items)
    },
  }
}

function collecting() {
  const events: DecisionEvent[] = []
  return { events, onEvent: (event: DecisionEvent) => events.push(event) }
}

const run = async (): Promise<void> => {
  await check('subscribe receives exactly one argument: { signal }', async () => {
    const record: SubscribeRecord = { calls: [], argumentCounts: [] }
    const controller = new AbortController()
    await consumeDecisionEvents(sourceOf([], record), {
      types: [P7_TURN_END_EVENT_TYPE],
      signal: controller.signal,
      onEvent: () => {},
    })
    assert.equal(record.argumentCounts.length, 1)
    assert.deepEqual(record.argumentCounts, [1])
    const options = record.calls[0]
    assert.ok(options)
    assert.deepEqual(Object.keys(options), ['signal'])
    assert.equal(typeof options, 'object')
    assert.equal(options.signal, controller.signal)
  })

  await check('the stream is consumed and filtered client-side', async () => {
    const collector = collecting()
    const summary = await consumeDecisionEvents(sourceOf(HOST_EVENT_ENVELOPES_F13), {
      types: [P7_TURN_END_EVENT_TYPE],
      signal: new AbortController().signal,
      onEvent: collector.onEvent,
    })
    assert.deepEqual(collector.events, [
      { type: 'session.execution.succeeded', sessionID: 'ses_fixture_0001' },
    ])
    assert.equal(summary.delivered, 4)
    assert.equal(summary.matched, 1)
    assert.equal(summary.skippedType, 2)
    assert.equal(summary.skippedMissingSession, 1)
    assert.equal(summary.failure, null)
  })

  await check('a second type is matched without touching the host filter', async () => {
    const collector = collecting()
    const summary = await consumeDecisionEvents(sourceOf(HOST_EVENT_ENVELOPES_F13), {
      types: ['session.execution.succeeded', 'session.compaction.ended'],
      signal: new AbortController().signal,
      onEvent: collector.onEvent,
    })
    assert.equal(summary.matched, 2)
    assert.deepEqual(
      collector.events.map((event) => event.sessionID),
      ['ses_fixture_0001', 'ses_fixture_0002'],
    )
  })

  await check('the legacy envelope field is never read', async () => {
    const forbidden = Object.defineProperty(
      {
        id: 'evt_trap',
        type: 'session.execution.succeeded',
        data: { sessionID: 'ses_trap' },
      },
      'properties',
      {
        enumerable: false,
        get() {
          throw new Error('legacy envelope field was read')
        },
      },
    )
    const collector = collecting()
    const summary = await consumeDecisionEvents(sourceOf([forbidden]), {
      types: ['session.execution.succeeded'],
      signal: new AbortController().signal,
      onEvent: collector.onEvent,
    })
    assert.equal(summary.failure, null)
    assert.equal(summary.matched, 1)
    assert.deepEqual(collector.events[0], {
      type: 'session.execution.succeeded',
      sessionID: 'ses_trap',
    })
  })

  await check('the session carrier is read from data.sessionID only', () => {
    assert.equal(readEventSessionID({ data: { sessionID: 'ses_1' } }), 'ses_1')
    assert.equal(readEventSessionID({ data: { sessionID: '  ses_1  ' } }), 'ses_1')
    assert.equal(readEventSessionID({ data: {} }), null)
    assert.equal(readEventSessionID({ data: { sessionID: 1 } }), null)
    assert.equal(readEventSessionID({ sessionID: 'top-level-not-the-carrier' }), null)
    assert.equal(readEventSessionID(null), null)
  })

  await check('aborting the controller ends consumption without dispose', async () => {
    const controller = new AbortController()
    const collector = collecting()
    const summary = await consumeDecisionEvents(
      sourceOf([
        { type: 'session.execution.succeeded', data: { sessionID: 'ses_a' } },
        { type: 'session.execution.succeeded', data: { sessionID: 'ses_b' } },
      ]),
      {
        types: ['session.execution.succeeded'],
        signal: controller.signal,
        onEvent: (event) => {
          collector.onEvent(event)
          controller.abort()
        },
      },
    )
    assert.equal(collector.events.length, 1)
    assert.equal(summary.aborted, true)
    assert.equal(summary.delivered, 1)
  })

  await check('an already-aborted signal subscribes to nothing', async () => {
    const controller = new AbortController()
    controller.abort()
    const record: SubscribeRecord = { calls: [], argumentCounts: [] }
    const summary = await consumeDecisionEvents(sourceOf([], record), {
      types: ['session.execution.succeeded'],
      signal: controller.signal,
      onEvent: () => {},
    })
    assert.equal(record.calls.length, 0)
    assert.equal(summary.aborted, true)
  })

  await check('a throwing handler is counted and never stops the stream', async () => {
    let calls = 0
    const summary = await consumeDecisionEvents(
      sourceOf([
        { type: 'session.execution.succeeded', data: { sessionID: 'ses_a' } },
        { type: 'session.execution.succeeded', data: { sessionID: 'ses_b' } },
      ]),
      {
        types: ['session.execution.succeeded'],
        signal: new AbortController().signal,
        onEvent: () => {
          calls += 1
          if (calls === 1) throw new Error('handler exploded')
        },
      },
    )
    assert.equal(calls, 2)
    assert.equal(summary.matched, 2)
    assert.equal(summary.handlerErrors, 1)
  })

  await check('a throwing subscribe fails closed without throwing', async () => {
    const summary = await consumeDecisionEvents(
      {
        subscribe() {
          throw new Error('host API missing')
        },
      },
      {
        types: ['session.execution.succeeded'],
        signal: new AbortController().signal,
        onEvent: () => {},
      },
    )
    assert.equal(summary.failure, 'SUBSCRIBE_FAILED')
    assert.equal(summary.matched, 0)
  })

  await check('a throwing stream fails closed after the delivered prefix', async () => {
    async function* broken(): AsyncIterable<HostEventEnvelope> {
      yield { type: 'session.execution.succeeded', data: { sessionID: 'ses_a' } }
      throw new Error('stream broke')
    }
    const collector = collecting()
    const summary = await consumeDecisionEvents(
      { subscribe: () => broken() },
      {
        types: ['session.execution.succeeded'],
        signal: new AbortController().signal,
        onEvent: collector.onEvent,
      },
    )
    assert.equal(summary.failure, 'STREAM_FAILED')
    assert.equal(summary.delivered, 1)
    assert.equal(summary.matched, 1)
    assert.equal(collector.events.length, 1)
  })

  await check('maxEvents bounds consumption', async () => {
    const summary = await consumeDecisionEvents(sourceOf(HOST_EVENT_ENVELOPES_F13), {
      types: ['session.execution.succeeded'],
      signal: new AbortController().signal,
      onEvent: () => {},
      maxEvents: 2,
    })
    assert.equal(summary.delivered, 2)
  })

  await check('malformed envelopes are skipped, never coerced', async () => {
    const summary = await consumeDecisionEvents(
      sourceOf([null, 'event', { type: 42, data: { sessionID: 'ses_a' } }]),
      {
        types: ['session.execution.succeeded'],
        signal: new AbortController().signal,
        onEvent: () => {},
      },
    )
    assert.equal(summary.delivered, 3)
    assert.equal(summary.matched, 0)
    assert.equal(summary.skippedType, 3)
    assert.equal(summary.failure, null)
  })

  console.log(`V2 decision events: ${checks} groups passed`)
}

await run()
