import { strict as assert } from 'node:assert'

import {
  type ProviderUsageEvent,
  type ProviderUsageSnapshot,
  USAGE_STATUS,
} from '../../src/pantheon/provider-capabilities.ts'
import { createProviderStreamTracker } from '../../src/pantheon/provider-stream-tracker.ts'

const results: { name: string; passed: boolean; error?: string }[] = []

function test(name: string, fn: () => void): void {
  try {
    fn()
    results.push({ name, passed: true })
  } catch (error: unknown) {
    results.push({
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function event(overrides: Partial<ProviderUsageEvent> = {}): ProviderUsageEvent {
  return {
    eventId: 'event-1',
    partId: 'part-1',
    sessionId: 'session-1',
    providerId: 'provider-1',
    modelId: 'model-1',
    usage: { inputTokens: 100, outputTokens: 25 },
    limit: { contextTokens: 1000 },
    sequence: 1,
    ...overrides,
  }
}

test('publishes only complete exact snapshots through the injected sink', () => {
  const published: ProviderUsageSnapshot[] = []
  const tracker = createProviderStreamTracker({
    onSnapshot: (snapshot) => published.push(snapshot),
  })

  const result = tracker.ingest(event())

  assert.equal(result.status, USAGE_STATUS.SUPPORTED)
  assert.equal(result.published, true)
  assert.equal(published.length, 1)
  assert.deepEqual(published[0]?.usage, { inputTokens: 100, outputTokens: 25 })
  assert.deepEqual(published[0]?.limit, { contextTokens: 1000 })
  assert.equal('percentage' in (published[0] ?? {}), false)
  assert.equal('costUsd' in (published[0] ?? {}), false)
})

test('malformed, partial, textual, negative, non-finite, and reset-invalid events never publish', () => {
  const published: ProviderUsageSnapshot[] = []
  const tracker = createProviderStreamTracker({
    onSnapshot: (snapshot) => published.push(snapshot),
  })
  const cases: unknown[] = [
    { ...event(), usage: { inputTokens: 100 } },
    { ...event(), usage: { inputTokens: '100', outputTokens: 25 } },
    { ...event(), usage: { inputTokens: Number.NaN, outputTokens: 25 } },
    { ...event(), usage: { inputTokens: Infinity, outputTokens: 25 } },
    { ...event(), usage: { inputTokens: 100, outputTokens: -Infinity } },
    { ...event(), limit: { contextTokens: -1 } },
    { ...event(), limit: { contextTokens: Infinity } },
    { ...event(), limit: { contextTokens: -Infinity } },
    { ...event(), resetAt: undefined },
    { ...event(), resetAt: Number.NaN },
    { ...event(), resetAt: Infinity },
    { ...event(), resetAt: -Infinity },
    { ...event(), resetAt: -1 },
    { ...event(), resetAt: 'later' },
    { ...event(), resetAt: null },
    { ...event(), resetAt: true },
    { ...event(), resetAt: { at: 123 } },
    { ...event(), resetAt: [123] },
    { ...event(), reset: undefined },
    { ...event(), reset: {} },
    { ...event(), reset: { at: 123 } },
    { ...event(), reset: 'later' },
    { ...event(), eventId: '' },
    { ...event(), partId: '' },
    { type: 'session.idle', properties: { sessionId: 'session-1' } },
  ]

  for (const input of cases) {
    const result = tracker.ingest(input)
    assert.equal(result.status, USAGE_STATUS.UNSUPPORTED)
    assert.equal(result.published, false)
  }
  assert.equal(published.length, 0)
  assert.equal(tracker.getSnapshot('session-1', 'provider-1', 'model-1'), undefined)
})

test('deduplicates event IDs and part IDs within an isolated stream', () => {
  const published: ProviderUsageSnapshot[] = []
  const tracker = createProviderStreamTracker({
    onSnapshot: (snapshot) => published.push(snapshot),
  })

  assert.equal(tracker.ingest(event()).published, true)
  assert.equal(tracker.ingest(event({ eventId: 'event-2', sequence: 2 })).published, false)
  assert.equal(
    tracker.ingest(event({ eventId: 'event-3', partId: 'part-2', sequence: 3 })).published,
    true,
  )
  assert.equal(
    tracker.ingest(event({ eventId: 'event-4', partId: 'part-2', sequence: 4 })).published,
    false,
  )
  assert.equal(published.length, 2)
})

test('accepts newer events after an out-of-order event and ignores stale regressions', () => {
  const published: ProviderUsageSnapshot[] = []
  const tracker = createProviderStreamTracker({
    onSnapshot: (snapshot) => published.push(snapshot),
  })

  assert.equal(
    tracker.ingest(event({ eventId: 'event-2', partId: 'part-2', sequence: 2 })).published,
    true,
  )
  const stale = tracker.ingest(event({ eventId: 'event-1', partId: 'part-1', sequence: 1 }))
  assert.equal(stale.status, USAGE_STATUS.SUPPORTED)
  assert.equal(stale.published, false)
  assert.equal(
    tracker.ingest(event({ eventId: 'event-3', partId: 'part-3', sequence: 3 })).published,
    true,
  )

  assert.equal(published.length, 2)
  assert.equal(tracker.getSnapshot('session-1', 'provider-1', 'model-1')?.eventId, 'event-3')
})

test('uses observedAt to reject stale events when no sequence is available', () => {
  const tracker = createProviderStreamTracker()

  const first = event({ observedAt: 200 })
  delete first.sequence
  const second = event({ eventId: 'event-2', partId: 'part-2', observedAt: 100 })
  delete second.sequence

  assert.equal(tracker.ingest(first).published, true)
  const stale = tracker.ingest(second)
  assert.equal(stale.status, USAGE_STATUS.SUPPORTED)
  assert.equal(stale.reason, 'STALE')
  assert.equal(stale.published, false)
})

test('isolates duplicate IDs and snapshots by session, provider, and model', () => {
  const tracker = createProviderStreamTracker()
  assert.equal(tracker.ingest(event()).published, true)
  assert.equal(
    tracker.ingest(event({ sessionId: 'session-2', providerId: 'provider-2', modelId: 'model-2' }))
      .published,
    true,
  )

  assert.equal(tracker.getSnapshot('session-1', 'provider-1', 'model-1')?.sessionId, 'session-1')
  assert.equal(tracker.getSnapshot('session-2', 'provider-2', 'model-2')?.sessionId, 'session-2')
  assert.equal(tracker.getSnapshot('session-1', 'provider-2', 'model-2'), undefined)
})

test('a scoped tracker rejects cross-session/provider/model events without changing its snapshot', () => {
  const tracker = createProviderStreamTracker({
    sessionId: 'session-1',
    providerId: 'provider-1',
    modelId: 'model-1',
  })

  assert.equal(tracker.ingest(event()).published, true)
  const result = tracker.ingest(event({ sessionId: 'session-2', sequence: 2 }))
  assert.equal(result.status, USAGE_STATUS.UNSUPPORTED)
  assert.equal(result.published, false)
  assert.equal(tracker.getSnapshot('session-1', 'provider-1', 'model-1')?.eventId, 'event-1')
})

const failed = results.filter((result) => !result.passed)
for (const result of results) {
  console.log(
    `  ${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.error ? `: ${result.error}` : ''}`,
  )
}
console.log(`\nResults: ${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length === 0 ? 0 : 1)
