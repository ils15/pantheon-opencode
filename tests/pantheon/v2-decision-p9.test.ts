/**
 * P9 — memory decision at compaction, on the measured carrier.
 *
 * The measured compaction payload (PROBE-A, host 2.2.5) carries a **top-level**
 * `sessionID` string and no nested `session` object (F-01); text crosses in
 * `payload.system` as an **array** of parts (F-02) and the persisted summary is
 * correlated with the following turn by the `compaction` message id (F-03).
 *
 * These tests pin the two properties that make the adapter safe to wire later:
 * the decision is keyed by the top-level `sessionID` and never by a nested
 * session id, and a payload without a top-level id produces **no decision at
 * all**. The carrier is measured on top-level **and child** sessions: PROBE-G
 * fired the hook in a real child 3/3 with the child's `sessionID` at top level
 * and the same `system` part array, so no child-specific branch exists. The
 * `reason:"overflow"` path was **not inducible** in 6 error shapes (PROBE-G
 * §3.2) and remains unmeasured, and the `messages` channel was never exercised
 * (PM-05).
 *
 * Run with: npx tsx tests/pantheon/v2-decision-p9.test.ts
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  COMPACTION_PRIORITY_THRESHOLDS,
  evaluateCompactionMemoryPoint,
} from '../../src/pantheon/v2-decision-points/p9-memory-compaction.ts'
import type { ShadowRecord } from '../../src/pantheon/v2-decision-shadow.ts'

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
  checks += 1
  void name
}

const REASON_TOKEN = /^[a-z0-9][a-z0-9.:-]{0,63}$/

/** The measured payload shape: top-level `sessionID`, `system` array of 4 parts. */
const measuredPayload = (sessionID: string): Record<string, unknown> => ({
  sessionID,
  model: { id: 'fixture', providerID: 'fixture' },
  system: [
    { type: 'text', text: 'part one' },
    { type: 'text', text: 'part two' },
    { type: 'text', text: 'part three' },
    { type: 'text', text: 'part four' },
  ],
  messages: [{ id: 'msg_fixture_p9', role: 'user', content: [] }],
  options: {},
  agent: 'build',
  tools: [],
})

const CANDIDATES = [
  { id: 'objective', score: 0.9, justification: 'stated goal' },
  { id: 'constraint', score: 0.6, justification: 'user constraint' },
  { id: 'colour', score: 0.2, justification: 'incidental detail' },
  { id: 'noise', score: 0, justification: 'no support' },
]

check('the decision is keyed by the top-level sessionID, not a nested session id', () => {
  const records: ShadowRecord[] = []
  const result = evaluateCompactionMemoryPoint(
    {
      payload: { ...measuredPayload('ses_top_level'), session: { id: 'ses_nested_decoy' } },
      candidates: CANDIDATES,
    },
    (record) => records.push(record),
  )

  assert.equal(result.sessionID, 'ses_top_level')
  assert.equal(result.decisionKey, 'ses_top_level')
  assert.notEqual(result.decisionKey, 'ses_nested_decoy')
  assert.equal(result.record.point, 'P9')
  assert.equal(result.record.effect, 'none')
  assert.equal(result.record.decision, 'memory.retain')
  assert.equal(records.length, 1)
})

check('a missing top-level session id produces no decision', () => {
  // Nested `session.id` is a decoy: the measured payload has no such field and
  // reading it would key the decision by a carrier that was never observed.
  const nestedOnly = {
    payload: { ...measuredPayload('unused'), sessionID: undefined, session: { id: 'ses_nested' } },
    candidates: CANDIDATES,
  }
  const withoutId: Record<string, unknown> = measuredPayload('unused')
  delete withoutId.sessionID

  for (const input of [nestedOnly, { payload: withoutId, candidates: CANDIDATES }]) {
    const result = evaluateCompactionMemoryPoint(input)
    assert.equal(result.sessionID, null)
    assert.equal(result.decisionKey, null)
    assert.equal(result.memoryDecision, null, 'no decision is invented')
    assert.equal(result.record.decision, 'refusal')
    assert.equal(result.reason, 'compaction.session.absent')
    assert.equal(result.record.effect, 'none')
  }

  // No payload at all is also no decision, and it is named as such.
  for (const input of [undefined, {}, { candidates: CANDIDATES }]) {
    const result = evaluateCompactionMemoryPoint(input)
    assert.equal(result.sessionID, null)
    assert.equal(result.decisionKey, null)
    assert.equal(result.memoryDecision, null)
    assert.equal(result.record.decision, 'refusal')
    assert.equal(result.reason, 'compaction.payload.absent')
  }
})

check('an empty or control-laden session id is refused, not normalized', () => {
  for (const sessionID of ['', '   ', 'ses_top\nsecond']) {
    const result = evaluateCompactionMemoryPoint({
      payload: { ...measuredPayload('unused'), sessionID },
      candidates: CANDIDATES,
    })
    assert.equal(result.decisionKey, null)
    assert.equal(result.memoryDecision, null)
    assert.equal(result.record.decision, 'refusal')
    assert.equal(result.reason, 'compaction.session.invalid')
  }
})

check('the measured system array is read; the dead string branch is refused', () => {
  const measured = evaluateCompactionMemoryPoint({
    payload: measuredPayload('ses_fixture_p9'),
    candidates: CANDIDATES,
  })
  assert.equal(measured.systemPartCount, 4)
  assert.equal(measured.memoryDecision?.retain, 1)

  // On 2.2.5 `system` is always an array; a string is a shape drift, and the
  // adapter must not push into it or fall back to reading it as text.
  const payload = { ...measuredPayload('ses_fixture_p9'), system: 'a single string' }
  const stringCarrier = evaluateCompactionMemoryPoint({ payload, candidates: CANDIDATES })
  assert.equal(stringCarrier.memoryDecision, null)
  assert.equal(stringCarrier.record.decision, 'refusal')
  assert.equal(stringCarrier.reason, 'compaction.system.unsupported')
  assert.equal(payload.system, 'a single string', 'the carrier is never rewritten')

  for (const system of [undefined, null, {}, ['plain string part'], [{ type: 'text' }]]) {
    const result = evaluateCompactionMemoryPoint({
      payload: { ...measuredPayload('ses_fixture_p9'), system },
      candidates: CANDIDATES,
    })
    assert.equal(result.memoryDecision, null)
    assert.equal(result.record.decision, 'refusal')
    assert.match(result.reason, REASON_TOKEN)
  }
})

check('retention policy is deterministic and explicit', () => {
  const result = evaluateCompactionMemoryPoint({
    payload: measuredPayload('ses_fixture_p9'),
    candidates: CANDIDATES,
  })
  assert.equal(result.memoryDecision?.retain, 1)
  assert.deepEqual(result.memoryDecision?.retainedIds, ['objective', 'constraint', 'colour'])
  // Highest retained score 0.9 clears both declared thresholds → level 3.
  assert.deepEqual([...COMPACTION_PRIORITY_THRESHOLDS], [0.5, 0.75])
  assert.equal(result.memoryDecision?.priority, 3)
  assert.equal(result.reason, 'compaction.memory.retained')
  assert.equal(result.record.effect, 'none')
})

check('priority levels follow the declared thresholds', () => {
  const levelOf = (score: number): number | null => {
    const result = evaluateCompactionMemoryPoint({
      payload: measuredPayload('ses_fixture_p9'),
      candidates: [{ id: 'only', score, justification: 'single item' }],
    })
    return result.memoryDecision?.priority ?? null
  }
  assert.equal(levelOf(0.9), 3)
  assert.equal(levelOf(0.75), 3)
  assert.equal(levelOf(0.6), 2)
  assert.equal(levelOf(0.5), 2)
  assert.equal(levelOf(0.2), 1)
})

check('an empty source is a discard decision; an absent source is no decision', () => {
  const empty = evaluateCompactionMemoryPoint({
    payload: measuredPayload('ses_fixture_p9'),
    candidates: [],
  })
  assert.deepEqual(empty.memoryDecision, { retain: 0, priority: null, retainedIds: [] })
  assert.equal(empty.record.decision, 'memory.discard')
  assert.equal(empty.reason, 'compaction.memory.none')

  const unsupported = evaluateCompactionMemoryPoint({
    payload: measuredPayload('ses_fixture_p9'),
    candidates: { id: 'a' },
  })
  assert.equal(unsupported.memoryDecision, null)
  assert.equal(unsupported.reason, 'compaction.memory.source.unsupported')
  assert.equal(unsupported.record.decision, 'refusal')

  const retainer = evaluateCompactionMemoryPoint({
    payload: measuredPayload('ses_fixture_p9'),
    candidates: [
      { id: 'a', score: 0, justification: 'no support' },
      { id: 'b', score: -1, justification: 'refuted' },
    ],
  })
  assert.deepEqual(retainer.memoryDecision, { retain: 0, priority: null, retainedIds: [] })
  assert.equal(retainer.reason, 'compaction.memory.discarded')
})

check('the source the rank contract rejects is reported, never repaired', () => {
  const result = evaluateCompactionMemoryPoint({
    payload: measuredPayload('ses_fixture_p9'),
    candidates: [
      { id: 'dup', score: 1, justification: 'x' },
      { id: 'dup', score: 2, justification: 'y' },
    ],
  })
  assert.equal(result.memoryDecision, null)
  assert.equal(result.record.decision, 'refusal')
  assert.equal(result.reason, 'memory.rank.duplicate.id')
})

check('correlation comes from the caller, never from the payload', () => {
  const payload = { ...measuredPayload('ses_fixture_p9'), messageID: 'msg_from_payload' }
  const unlabelled = evaluateCompactionMemoryPoint({ payload, candidates: CANDIDATES })
  assert.equal(unlabelled.compactionMessageID, null, 'the payload carries no message id (F-01)')

  const labelled = evaluateCompactionMemoryPoint({
    payload,
    candidates: CANDIDATES,
    compactionMessageID: 'msg_compaction_0001',
  })
  assert.equal(labelled.compactionMessageID, 'msg_compaction_0001')
  assert.equal(labelled.decisionKey, 'ses_fixture_p9')
})

check('the payload is never mutated and the record is always a no-op', () => {
  const payload = measuredPayload('ses_fixture_p9')
  const candidates = structuredClone(CANDIDATES)
  const beforePayload = structuredClone(payload)
  const beforeCandidates = structuredClone(candidates)

  const result = evaluateCompactionMemoryPoint({
    payload,
    candidates,
    compactionMessageID: 'msg_compaction_0001',
  })
  assert.deepEqual(payload, beforePayload)
  assert.deepEqual(candidates, beforeCandidates)
  assert.equal(result.record.effect, 'none')
})

check('a hostile input is contained as a record, never thrown', () => {
  const result = evaluateCompactionMemoryPoint({
    payload: { ...measuredPayload('ses_fixture_p9'), runner: () => 1 },
    candidates: CANDIDATES,
  })
  assert.equal(result.record.decision, 'unavailable')
  assert.equal(result.reason, 'payload_not_clonable')
  assert.equal(result.memoryDecision, null)
  assert.equal(result.decisionKey, null)
})

check('every reason is a record token', () => {
  const samples = [
    evaluateCompactionMemoryPoint(undefined),
    evaluateCompactionMemoryPoint({}),
    evaluateCompactionMemoryPoint({ payload: measuredPayload('ses_fixture_p9') }),
    evaluateCompactionMemoryPoint({ payload: measuredPayload('ses_fixture_p9'), candidates: [] }),
    evaluateCompactionMemoryPoint({
      payload: measuredPayload('ses_fixture_p9'),
      candidates: CANDIDATES,
    }),
  ]
  for (const result of samples) {
    assert.match(result.reason, REASON_TOKEN)
    assert.equal(result.record.point, 'P9')
    assert.equal(result.record.effect, 'none')
  }
})

check('the P9 module reads only the measured carrier', () => {
  const source = readFileSync(
    new URL('../../src/pantheon/v2-decision-points/p9-memory-compaction.ts', import.meta.url),
    'utf8',
  )
  // No nested session id, no absent host catalog context, no network.
  const nestedIdField = `.${['session', 'id'].join('.')}`
  assert.equal(source.includes(nestedIdField), false)
  assert.equal(source.includes(['session', 'id'].join('?.')), false)
  assert.equal(source.includes(['ctx', 'catalog'].join('.')), false)
  for (const forbidden of ['node:http', 'node:https', 'node:net', 'undici', 'fetch(']) {
    assert.equal(source.includes(forbidden), false, forbidden)
  }
  // The unmeasured scope is named, not designed for.
  assert.equal(source.includes('overflow'), true)
  assert.equal(source.includes('UNKNOWN'), true)
})

console.log(`V2 decision P9: ${checks} groups passed`)
