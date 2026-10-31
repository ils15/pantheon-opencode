/**
 * Sanitised telemetry (closes D10).
 *
 * The test is adversarial on purpose: a record carrying prompt, response, user
 * content, message bodies, an API key and a secret-bearing field name must lose
 * all of it. Nothing is scrubbed by pattern — the allowlist simply has no slot
 * for it, and values must be short tokens or bounded numbers.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-telemetry.test.ts
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  createTelemetrySink,
  sanitizeTelemetry,
  TELEMETRY_FIELDS,
  TELEMETRY_SCHEMA_VERSION,
} from '../../src/pantheon/v2-decision-telemetry.ts'
import { HOSTILE_TELEMETRY } from './v2-decision-fixtures.ts'

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
  checks += 1
  void name
}

const ALLOWED = new Set(TELEMETRY_FIELDS as readonly string[])
const SECRETS = [
  'secret password',
  'private content',
  'someone@example.test',
  'sk-live-not-a-real-key',
  'user said: my password is hunter2',
  'must never be echoed',
]

check('a minimal record sanitises to the allowlist', () => {
  const result = sanitizeTelemetry({
    point: 'P1',
    decision: 'choice',
    reason: 'UNIQUE_MAX_EVIDENCE',
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(result.event, {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      point: 'P1',
      decision: 'choice',
      effect: 'none',
      reason: 'UNIQUE_MAX_EVIDENCE',
    })
    for (const key of Object.keys(result.event)) assert.equal(ALLOWED.has(key), true, key)
  }
})

check('prompt, response, message, user and credential fields never survive', () => {
  for (const hostile of HOSTILE_TELEMETRY) {
    const result = sanitizeTelemetry(hostile)
    const serialised = JSON.stringify(result)
    for (const secret of SECRETS) {
      assert.equal(
        serialised.includes(secret),
        false,
        `telemetry leaked content for ${secret.slice(0, 12)}…`,
      )
    }
    if (result.ok) {
      for (const key of Object.keys(result.event)) assert.equal(ALLOWED.has(key), true, key)
    }
    assert.equal(serialised.includes('prompt'), false)
    assert.equal(serialised.includes('response'), false)
    assert.equal(serialised.includes('messages'), false)
    assert.equal(serialised.includes('apiKey'), false)
  }
})

check('a free-form reason is dropped, never truncated into the event', () => {
  const result = sanitizeTelemetry({
    point: 'P3',
    decision: 'choice',
    reason: 'the user said the password is hunter2',
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reasonCode, 'MISSING_REQUIRED_FIELD')
})

check('hostile field names are neither echoed nor counted as content', () => {
  const result = sanitizeTelemetry({
    point: 'P2',
    decision: 'choice',
    reason: 'UNIQUE_MAX_EVIDENCE',
    'my secret field': 'value',
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.droppedFieldCount, 1)
    assert.equal(JSON.stringify(result).includes('my secret field'), false)
  }
})

check('dropped fields are counted, never echoed by name', () => {
  const result = sanitizeTelemetry({
    point: 'P1',
    decision: 'choice',
    reason: 'UNIQUE_MAX_EVIDENCE',
    prompt: 'x',
    messages: 'y',
  })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.droppedFieldCount, 2)
    const serialised = JSON.stringify(result)
    assert.equal(serialised.includes('prompt'), false)
    assert.equal(serialised.includes('messages'), false)
  }
})

check('an event claiming a measured effect is rejected outright', () => {
  for (const effect of ['active', 'applied', 'none ', true, 1]) {
    const result = sanitizeTelemetry({
      point: 'P1',
      decision: 'choice',
      reason: 'UNIQUE_MAX_EVIDENCE',
      effect,
    })
    assert.equal(result.ok, false, JSON.stringify(effect))
    if (!result.ok) assert.equal(result.reasonCode, 'EFFECT_NOT_MEASURED')
  }
})

check('the literal effect none is accepted but not trusted as a claim', () => {
  const result = sanitizeTelemetry({
    point: 'P1',
    decision: 'choice',
    reason: 'UNIQUE_MAX_EVIDENCE',
    effect: 'none',
  })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.event.effect, 'none')
})

check('unknown points, unsafe tokens and wrong schema versions are dropped', () => {
  const cases: unknown[] = [
    { point: 'P99', decision: 'choice', reason: 'X' },
    { point: 'P1', decision: 'choice decision', reason: 'X' },
    { point: 'P1', decision: 'choice', reason: 'X', schemaVersion: 2 },
    { point: 'P1', decision: 'choice', reason: 'X', mode: 'turbo' },
    { point: 'P1', decision: 'choice', reason: 'X', durationMs: -1 },
    { point: 'P1', decision: 'choice', reason: 'X', durationMs: 60_001 },
    { point: 'P1', decision: 'choice', reason: 'X', candidateCount: 1.5 },
    { point: 'P1', decision: 'choice', reason: 'X', candidateCount: 10_001 },
  ]
  for (const input of cases) {
    const result = sanitizeTelemetry(input)
    if (result.ok) {
      assert.equal(result.droppedFieldCount > 0, true, JSON.stringify(input))
    } else {
      assert.equal(result.reasonCode, 'MISSING_REQUIRED_FIELD', JSON.stringify(input))
    }
  }
})

check('non-records and arrays are rejected', () => {
  for (const input of [null, undefined, 'x', 1, [], () => 1]) {
    const result = sanitizeTelemetry(input)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reasonCode, 'INVALID_INPUT')
  }
})

check('the sink keeps only sanitised events and is bounded', () => {
  const sink = createTelemetrySink(2)
  const first = sink.emit({
    point: 'P1',
    decision: 'choice',
    reason: 'UNIQUE_MAX_EVIDENCE',
    prompt: 'secret',
  })
  assert.equal(first.ok, true)
  sink.emit({ point: 'P2', decision: 'choice', reason: 'UNIQUE_MAX_EVIDENCE' })
  sink.emit({ point: 'P3', decision: 'choice', reason: 'UNIQUE_MAX_EVIDENCE' })
  assert.equal(sink.size(), 2)
  assert.equal(sink.events().length, 2)
  assert.equal(JSON.stringify(sink.events()).includes('secret'), false)
  assert.equal(sink.emit({ point: 'P1', decision: 'choice', reason: 'x' }).ok, true)
  assert.equal(sink.size(), 2, 'a full sink does not grow')
})

check('the telemetry module performs no I/O', () => {
  const source = readFileSync(
    new URL('../../src/pantheon/v2-decision-telemetry.ts', import.meta.url),
    'utf8',
  )
  for (const forbidden of ['node:fs', 'node:http', 'node:https', 'node:net', 'fetch(']) {
    assert.equal(source.includes(forbidden), false, forbidden)
  }
})

console.log(`V2 decision telemetry: ${checks} groups passed`)
