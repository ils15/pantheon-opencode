/**
 * P4 — `rank` over memory candidates in shadow, plus the retrieval comparison.
 *
 * The candidate source was never measured, so the adapter consumes the shared
 * `rank` contract unchanged and fails closed on anything else. Fixtures are
 * synthetic; no prompt, response or memory content is included.
 *
 * The embeddings-versus-BM25 comparison is recorded as NOT RUN: there is no
 * offline embedding model and no network here, and hand-authored vectors would
 * measure the fixture rather than embeddings. BM25 stays the baseline.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-p4.test.ts
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  evaluateMemoryPoint,
  MEMORY_RETRIEVAL_COMPARISON,
} from '../../src/pantheon/v2-decision-points/p4-memory.ts'
import type { ShadowRecord } from '../../src/pantheon/v2-decision-shadow.ts'

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
  checks += 1
  void name
}

const REASON_TOKEN = /^[a-z0-9][a-z0-9.:-]{0,63}$/

const CANDIDATES = [
  { id: 'zeta', score: 0.4, justification: 'one supporting fact' },
  { id: 'alpha', score: 0.9, justification: 'two independent facts' },
  { id: 'beta', score: 0.9, justification: 'two independent facts' },
]

check('candidates are ranked deterministically with per-item justification', () => {
  const source = structuredClone(CANDIDATES)
  const before = structuredClone(source)
  const records: ShadowRecord[] = []
  const result = evaluateMemoryPoint(source, (record) => records.push(record))

  assert.equal(result.record.decision, 'rank')
  assert.equal(result.record.effect, 'none')
  assert.equal(result.record.point, 'P4')
  assert.equal(result.reason, 'memory.ranked')
  assert.equal(result.memorySource, 'candidates')
  assert.deepEqual(result.rankedMemoryIds, ['alpha', 'beta', 'zeta'])
  assert.deepEqual(source, before, 'the source is never mutated')
  assert.equal(records.length, 1)
  assert.equal(records[0]?.effect, 'none')

  assert.deepEqual(
    evaluateMemoryPoint(source).rankedMemoryIds,
    result.rankedMemoryIds,
    'the same source always ranks the same way',
  )
})

check('an absent source fails closed; it is not an empty ranking', () => {
  for (const absent of [undefined, null]) {
    const result = evaluateMemoryPoint(absent)
    assert.equal(result.record.decision, 'refusal')
    assert.equal(result.reason, 'memory.source.absent')
    assert.equal(result.memorySource, 'none')
    assert.deepEqual(result.rankedMemoryIds, [])
  }
})

check('a source that is not a candidate array fails closed unchanged', () => {
  for (const unsupported of [{ candidates: CANDIDATES }, 'candidates', 42, { id: 'a' }]) {
    const result = evaluateMemoryPoint(unsupported)
    assert.equal(result.record.decision, 'refusal')
    assert.equal(result.reason, 'memory.source.unsupported')
    assert.equal(result.memorySource, 'none')
    assert.deepEqual(result.rankedMemoryIds, [])
  }
})

check('an empty source is reported as empty, not as a ranking', () => {
  const result = evaluateMemoryPoint([])
  assert.equal(result.reason, 'memory.source.empty')
  assert.equal(result.memorySource, 'candidates')
  assert.deepEqual(result.rankedMemoryIds, [])
})

check('a source the rank contract rejects is reported, never repaired', () => {
  const cases: ReadonlyArray<readonly [unknown[], string]> = [
    [[{ score: 1, justification: 'x' }], 'memory.rank.invalid.id'],
    [
      [
        { id: 'dup', score: 1, justification: 'x' },
        { id: 'dup', score: 2, justification: 'y' },
      ],
      'memory.rank.duplicate.id',
    ],
    [[{ id: 'a b', score: 1, justification: 'x' }], 'memory.rank.invalid.id'],
    [
      [{ id: 'a', score: Number.POSITIVE_INFINITY, justification: 'x' }],
      'memory.rank.invalid.score',
    ],
    [[{ id: 'a', score: 1, justification: ' ' }], 'memory.rank.missing.justification'],
    [[{ id: 'a', score: 1 }], 'memory.rank.missing.justification'],
  ]
  for (const [source, reason] of cases) {
    const result = evaluateMemoryPoint(source)
    assert.equal(result.record.decision, 'refusal')
    assert.equal(result.reason, reason)
    assert.deepEqual(result.rankedMemoryIds, [])
  }
})

check('a hostile source is contained as a record, never thrown into admission', () => {
  const result = evaluateMemoryPoint([{ id: 'a', score: 1, justification: 'x', run: () => 1 }])
  assert.equal(result.record.decision, 'unavailable')
  assert.equal(result.reason, 'payload_not_clonable')
  assert.equal(result.memorySource, 'none')
  assert.deepEqual(result.rankedMemoryIds, [])
})

check('every reason is a record token', () => {
  const samples = [
    evaluateMemoryPoint(undefined),
    evaluateMemoryPoint({}),
    evaluateMemoryPoint([]),
    evaluateMemoryPoint(CANDIDATES),
    evaluateMemoryPoint([{ id: 'a' }]),
  ]
  for (const result of samples) {
    assert.match(result.reason, REASON_TOKEN)
    assert.equal(result.record.effect, 'none')
  }
})

check('the embeddings comparison is recorded as NOT RUN with BM25 as baseline', () => {
  assert.equal(MEMORY_RETRIEVAL_COMPARISON.baseline, 'bm25')
  assert.equal(MEMORY_RETRIEVAL_COMPARISON.embeddings, 'not_run')
  assert.match(MEMORY_RETRIEVAL_COMPARISON.reason, /offline/)
  assert.match(MEMORY_RETRIEVAL_COMPARISON.reason, /no embedding model/)
  assert.equal(Object.isFrozen(MEMORY_RETRIEVAL_COMPARISON), true)
  // A not-run comparison carries no number that could be mistaken for a result.
  for (const value of Object.values(MEMORY_RETRIEVAL_COMPARISON)) {
    assert.notEqual(typeof value, 'number')
  }
})

check('the P4 module stays offline and free of an embedding client', () => {
  const source = readFileSync(
    new URL('../../src/pantheon/v2-decision-points/p4-memory.ts', import.meta.url),
    'utf8',
  )
  for (const forbidden of ['node:http', 'node:https', 'node:net', 'undici', 'fetch(']) {
    assert.equal(source.includes(forbidden), false, forbidden)
  }
  for (const client of ['openai', '@ai-sdk', 'langchain']) {
    assert.equal(source.includes(client), false, client)
  }
})

console.log(`V2 decision P4: ${checks} groups passed`)
