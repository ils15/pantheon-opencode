/**
 * Shadow layer: proven no-op.
 *
 * The central assertion is transactional: a decision function that tries to
 * mutate the admission payload leaves it deeply equal to its pre-call value.
 * The host-shape case uses the measured F-08 payload (`skills: "undefined"`),
 * not a fabricated array, so the test exercises the shape the host really sends.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-shadow.test.ts
 */
import { strict as assert } from 'node:assert'
import { observeShadow } from '../../src/pantheon/v2-decision-shadow.ts'
import { HOST_PROMPT_PAYLOAD_F08, HOST_PROMPT_PAYLOAD_F08_NESTED } from './v2-decision-fixtures.ts'

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
  checks += 1
  void name
}

check('a shadow record has exactly the observable no-op shape', () => {
  const record = observeShadow('P1', HOST_PROMPT_PAYLOAD_F08, () => ({
    decision: 'choice',
    reason: 'UNIQUE_MAX_EVIDENCE',
  }))
  assert.deepEqual(record, {
    point: 'P1',
    decision: 'choice',
    effect: 'none',
    reason: 'UNIQUE_MAX_EVIDENCE',
  })
  assert.equal(Object.isFrozen(record), true)
})

check('a mutating decision cannot change the admission payload (F-08 shape)', () => {
  const payload = structuredClone(HOST_PROMPT_PAYLOAD_F08)
  const before = structuredClone(payload)
  const record = observeShadow('P2', payload, (isolated) => {
    const copy = isolated as { prompt: { skills: unknown; agents: unknown }; sessionID: string }
    copy.prompt.skills = ['fabricated-array']
    copy.prompt.agents = 'fabricated'
    copy.sessionID = 'mutated'
    return { decision: 'choice', reason: 'UNIQUE_MAX_EVIDENCE' }
  })
  assert.deepEqual(payload, before, 'admission payload must be byte-for-byte untouched')
  assert.equal(record.effect, 'none')
  assert.equal(record.decision, 'unavailable')
  assert.equal(record.reason, 'decision_error')
})

check('the decision function receives an isolated copy, not the payload', () => {
  let seen: unknown
  observeShadow('P7', HOST_PROMPT_PAYLOAD_F08_NESTED, (isolated) => {
    seen = isolated
    return { decision: 'noul', reason: 'UNIQUE_MAX_EVIDENCE' }
  })
  assert.notEqual(seen, HOST_PROMPT_PAYLOAD_F08_NESTED)
  assert.deepEqual(seen, HOST_PROMPT_PAYLOAD_F08_NESTED)
})

check('nested fields are isolated too', () => {
  const payload = structuredClone(HOST_PROMPT_PAYLOAD_F08_NESTED)
  const before = structuredClone(payload)
  observeShadow('P2', payload, (isolated) => {
    const copy = isolated as { metadata: { nested: { keep: boolean } } }
    copy.metadata.nested.keep = false
    return { decision: 'choice', reason: 'UNIQUE_MAX_EVIDENCE' }
  })
  assert.deepEqual(payload, before)
})

check('an unclonable payload is never handed to the decision function', () => {
  let called = false
  const payload = { skills: 'undefined', callback: () => 1 }
  const record = observeShadow('P1', payload, () => {
    called = true
    return { decision: 'choice', reason: 'UNIQUE_MAX_EVIDENCE' }
  })
  assert.equal(called, false)
  assert.equal(record.reason, 'payload_not_clonable')
  assert.equal(record.effect, 'none')
  assert.deepEqual(Object.keys(payload), ['skills', 'callback'])
})

check('a throwing decision is contained', () => {
  const record = observeShadow('P2', HOST_PROMPT_PAYLOAD_F08, () => {
    throw new Error('decision exploded')
  })
  assert.equal(record.decision, 'unavailable')
  assert.equal(record.reason, 'decision_error')
  assert.equal(record.effect, 'none')
})

check('a malformed decision result is contained', () => {
  const results = [
    null,
    undefined,
    'choice',
    {},
    { decision: 'choice' },
    { decision: 'has space', reason: 'UNIQUE_MAX_EVIDENCE' },
    { decision: 'choice', reason: 'has space' },
  ]
  for (const result of results) {
    const record = observeShadow('P2', {}, () => result as { decision: string; reason: string })
    assert.equal(record.effect, 'none', JSON.stringify(result))
    assert.equal(record.decision, 'unavailable', JSON.stringify(result))
  }
})

check('a throwing observer never reaches the caller', () => {
  const record = observeShadow(
    'P2',
    HOST_PROMPT_PAYLOAD_F08,
    () => ({ decision: 'choice', reason: 'UNIQUE_MAX_EVIDENCE' }),
    () => {
      throw new Error('sink exploded')
    },
  )
  assert.equal(record.decision, 'choice')
  assert.equal(record.effect, 'none')
})

check('the observer sees the same frozen record the caller receives', () => {
  let observed: unknown
  const record = observeShadow(
    'P9',
    { sessionID: 'ses_fixture' },
    () => ({ decision: 'noul', reason: 'UNIQUE_MAX_EVIDENCE' }),
    (value) => {
      observed = value
    },
  )
  assert.equal(observed, record)
})

check('invalid point ids are recorded without leaking the raw value', () => {
  const record = observeShadow('user typed a secret', {}, () => ({
    decision: 'choice',
    reason: 'UNIQUE_MAX_EVIDENCE',
  }))
  assert.equal(record.point, 'unknown-point')
})

console.log(`V2 decision shadow: ${checks} groups passed`)
