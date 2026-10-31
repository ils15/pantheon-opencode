/**
 * P6 — `rank` + `score` over council candidates, in shadow.
 *
 * Ranking is the shared deterministic contract (score descending, id ascending,
 * justification per candidate). The `score` question is a real validated
 * `ask.score`; shadow has no responder, so an unanswered question is recorded
 * as such instead of a fabricated level. Nothing is selected or applied.
 *
 * Fixtures are synthetic. No prompt or counsellor output is used.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-p6.test.ts
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  COUNCIL_SCORE_LEVELS,
  evaluateCouncilPoint,
} from '../../src/pantheon/v2-decision-points/p6-council.ts'
import type { ShadowRecord } from '../../src/pantheon/v2-decision-shadow.ts'

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
  checks += 1
  void name
}

const REASON_TOKEN = /^[a-z0-9][a-z0-9.:-]{0,63}$/

const COUNCILLORS = [
  { id: 'apollo', score: 0.4, justification: 'found two files' },
  { id: 'demeter', score: 0.9, justification: 'cited the migration' },
  { id: 'athena', score: 0.9, justification: 'cited the plan' },
]

check('candidates are ranked deterministically with per-item justification', () => {
  const candidates = structuredClone(COUNCILLORS)
  const before = structuredClone(candidates)
  const records: ShadowRecord[] = []
  const result = evaluateCouncilPoint({ candidates }, (record) => records.push(record))

  assert.equal(result.record.point, 'P6')
  assert.equal(result.record.effect, 'none')
  assert.equal(result.record.decision, 'rank')
  assert.deepEqual(result.rankedIds, ['athena', 'demeter', 'apollo'])
  assert.deepEqual(candidates, before, 'candidates are never mutated')
  assert.equal(records.length, 1)

  assert.deepEqual(
    evaluateCouncilPoint({ candidates }).rankedIds,
    result.rankedIds,
    'the same candidates always rank the same way',
  )
})

check('a score question is built over the top-ranked candidate', () => {
  const result = evaluateCouncilPoint({ candidates: COUNCILLORS })
  assert.equal(result.question?.mode, 'score')
  assert.equal(result.question?.id, 'p6.council')
  assert.equal(result.question?.levels, COUNCIL_SCORE_LEVELS)
  assert.equal(COUNCIL_SCORE_LEVELS >= 2 && COUNCIL_SCORE_LEVELS <= 10, true)
  // Shadow has no responder: the question is the observation, no level is invented.
  assert.equal(result.score, null)
  assert.equal(result.record.decision, 'rank')
  assert.equal(result.reason, 'council.no.answer')
})

check('a supplied answer is resolved through the shared contract and recorded', () => {
  const answered = evaluateCouncilPoint({
    candidates: COUNCILLORS,
    answer: { kind: 'score', level: 3 },
  })
  assert.equal(answered.score, 3)
  assert.equal(answered.record.decision, 'score')
  assert.equal(answered.reason, 'council.score.resolved')
  assert.equal(answered.record.effect, 'none')

  const refused = evaluateCouncilPoint({
    candidates: COUNCILLORS,
    answer: { kind: 'refusal' },
  })
  assert.equal(refused.score, null)
  assert.equal(refused.record.decision, 'refusal')
  assert.equal(refused.reason, 'council.score.refused')

  for (const answer of [{ kind: 'score', level: 0 }, { kind: 'score', level: 99 }, {}, null]) {
    const failed = evaluateCouncilPoint({ candidates: COUNCILLORS, answer })
    assert.equal(failed.score, null)
    assert.equal(failed.record.decision, 'refusal')
    assert.match(failed.reason, REASON_TOKEN)
  }
})

check('an absent, empty or unsupported source fails closed', () => {
  for (const candidates of [undefined, null]) {
    const result = evaluateCouncilPoint({ candidates })
    assert.equal(result.reason, 'council.source.absent')
    assert.equal(result.councilSource, 'none')
    assert.deepEqual(result.rankedIds, [])
    assert.equal(result.question, null)
  }
  const empty = evaluateCouncilPoint({ candidates: [] })
  assert.equal(empty.reason, 'council.source.empty')
  assert.equal(empty.councilSource, 'candidates')

  for (const candidates of [{ id: 'a' }, 'councillors', 42]) {
    const result = evaluateCouncilPoint({ candidates })
    assert.equal(result.reason, 'council.source.unsupported')
    assert.equal(result.councilSource, 'none')
  }
})

check('a source the rank contract rejects is reported, never repaired', () => {
  const result = evaluateCouncilPoint({
    candidates: [
      { id: 'dup', score: 1, justification: 'x' },
      { id: 'dup', score: 2, justification: 'y' },
    ],
  })
  assert.equal(result.record.decision, 'refusal')
  assert.equal(result.reason, 'council.rank.duplicate.id')
  assert.deepEqual(result.rankedIds, [])
  assert.equal(result.question, null)
})

check('an invalid requested level count is refused before a question exists', () => {
  for (const levels of [1, 11, 2.5, '5']) {
    const result = evaluateCouncilPoint({ candidates: COUNCILLORS, levels })
    assert.equal(result.record.decision, 'refusal')
    assert.equal(result.reason, 'council.question.invalid.levels')
    assert.equal(result.question, null)
    assert.equal(result.score, null)
  }
})

check('a hostile input is contained as a record, never thrown', () => {
  const result = evaluateCouncilPoint({
    candidates: [{ id: 'a', score: 1, justification: 'x', run: () => 1 }],
  })
  assert.equal(result.record.decision, 'unavailable')
  assert.equal(result.reason, 'payload_not_clonable')
  assert.deepEqual(result.rankedIds, [])
  assert.equal(result.score, null)
})

check('every reason is a record token and every record is a no-op', () => {
  const samples = [
    evaluateCouncilPoint(undefined),
    evaluateCouncilPoint({}),
    evaluateCouncilPoint({ candidates: [] }),
    evaluateCouncilPoint({ candidates: COUNCILLORS }),
    evaluateCouncilPoint({ candidates: COUNCILLORS, answer: { kind: 'score', level: 2 } }),
  ]
  for (const result of samples) {
    assert.match(result.reason, REASON_TOKEN)
    assert.equal(result.record.effect, 'none')
    assert.equal(result.record.point, 'P6')
  }
})

check('the P6 module stays offline and catalog-free', () => {
  const source = readFileSync(
    new URL('../../src/pantheon/v2-decision-points/p6-council.ts', import.meta.url),
    'utf8',
  )
  assert.equal(source.includes(['ctx', 'catalog'].join('.')), false)
  for (const forbidden of ['node:http', 'node:https', 'node:net', 'undici', 'fetch(']) {
    assert.equal(source.includes(forbidden), false, forbidden)
  }
})

console.log(`V2 decision P6: ${checks} groups passed`)
