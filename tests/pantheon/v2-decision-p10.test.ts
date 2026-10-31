/**
 * P10 — per-counsellor claim verification via `verify`, in shadow.
 *
 * Each claim declares `{ id, mandatory }` and carries the response a verifier
 * already produced. The verdict is resolved by the shared contract: an explicit
 * PASS / FAIL / BLOCK, and `failed_to_respond` becomes BLOCK when the claim is
 * mandatory and FAIL when it is advisory.
 *
 * Two properties are structural. First, no response text is retained: the
 * result carries verdicts and reason codes only, so claim content cannot leak
 * into a sink or a log. Second, an unusable counsellor — no claims, duplicate
 * ids, missing mandatory flag — yields **no aggregate verdict** rather than a
 * PASS over claims that were never counted.
 *
 * Fixtures are synthetic. No counsellor output is used.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-p10.test.ts
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { evaluateClaimsPoint } from '../../src/pantheon/v2-decision-points/p10-claims.ts'
import type { ShadowRecord } from '../../src/pantheon/v2-decision-shadow.ts'

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
  checks += 1
  void name
}

const REASON_TOKEN = /^[a-z0-9][a-z0-9.:-]{0,63}$/

const COUNCIL = [
  {
    id: 'athena',
    claims: [
      { id: 'plan.cited', mandatory: true, response: 'PASS' },
      { id: 'files.counted', mandatory: false, response: 'FAIL' },
    ],
  },
  {
    id: 'demeter',
    claims: [{ id: 'schema.checked', mandatory: true, response: 'PASS' }],
  },
]

check('each claim gets its own explicit verdict', () => {
  const records: ShadowRecord[] = []
  const result = evaluateClaimsPoint({ counsellors: structuredClone(COUNCIL) }, (record) =>
    records.push(record),
  )

  assert.equal(result.record.point, 'P10')
  assert.equal(result.record.effect, 'none')
  assert.deepEqual(
    result.claimVerdicts.map((verdict) => [verdict.counsellorId, verdict.claimId, verdict.verdict]),
    [
      ['athena', 'plan.cited', 'PASS'],
      ['athena', 'files.counted', 'FAIL'],
      ['demeter', 'schema.checked', 'PASS'],
    ],
  )
  assert.deepEqual(
    result.byCounsellor.map((entry) => [entry.counsellorId, entry.verdict]),
    [
      ['athena', 'FAIL'],
      ['demeter', 'PASS'],
    ],
  )
  assert.equal(result.aggregate, 'FAIL')
  assert.equal(result.reason, 'claims.verified')
  assert.equal(records.length, 1)
})

check('failed_to_respond is BLOCK for a mandatory claim and FAIL for an advisory one', () => {
  const result = evaluateClaimsPoint({
    counsellors: [
      {
        id: 'apollo',
        claims: [
          { id: 'mandatory.absent', mandatory: true },
          { id: 'advisory.absent', mandatory: false },
          { id: 'mandatory.garbled', mandatory: true, response: 'looks fine' },
        ],
      },
    ],
  })
  assert.deepEqual(
    result.claimVerdicts.map((verdict) => [verdict.claimId, verdict.verdict, verdict.reasonCode]),
    [
      ['mandatory.absent', 'BLOCK', 'FAILED_TO_RESPOND'],
      ['advisory.absent', 'FAIL', 'FAILED_TO_RESPOND'],
      ['mandatory.garbled', 'BLOCK', 'UNRECOGNIZED_VERDICT'],
    ],
  )
  assert.equal(result.byCounsellor[0]?.verdict, 'BLOCK')
  assert.equal(result.aggregate, 'BLOCK')
  assert.equal(result.record.decision, 'verify.block')
})

check('a counsellor with no claims cancels the aggregate instead of passing it', () => {
  const result = evaluateClaimsPoint({
    counsellors: [
      { id: 'athena', claims: [{ id: 'plan.cited', mandatory: true, response: 'PASS' }] },
      { id: 'empty', claims: [] },
    ],
  })
  assert.equal(result.aggregate, null)
  assert.equal(result.record.decision, 'refusal')
  assert.equal(result.reason, 'claims.counsellor.empty')
  assert.equal(result.byCounsellor.find((entry) => entry.counsellorId === 'empty')?.verdict, null)
  // The claims that were counted are still reported, so the gap is visible.
  assert.equal(result.claimVerdicts.length, 1)
})

check('an unusable council yields no verdict at all', () => {
  const inputs = [
    undefined,
    {},
    { counsellors: 'council' },
    { counsellors: [] },
    { counsellors: [{ id: 'athena' }] },
    { counsellors: [{ id: 'athena', claims: [{ id: 'x', mandatory: 'yes' }] }] },
    { counsellors: [{ id: 'a b', claims: [{ id: 'x', mandatory: true }] }] },
    {
      counsellors: [
        { id: 'athena', claims: [{ id: 'x', mandatory: true }] },
        { id: 'athena', claims: [{ id: 'y', mandatory: true }] },
      ],
    },
    {
      counsellors: [
        {
          id: 'athena',
          claims: [
            { id: 'x', mandatory: true },
            { id: 'x', mandatory: false },
          ],
        },
      ],
    },
  ]
  for (const input of inputs) {
    const result = evaluateClaimsPoint(input)
    assert.equal(result.aggregate, null)
    assert.equal(result.record.decision, 'refusal')
    assert.match(result.reason, REASON_TOKEN)
    assert.equal(result.record.effect, 'none')
  }
})

check('no claim response is retained in the result', () => {
  const result = evaluateClaimsPoint({ counsellors: structuredClone(COUNCIL) })
  const serialized = JSON.stringify(result)
  for (const forbidden of ['response', 'claim text', 'plan.cited is quoted']) {
    assert.equal(serialized.includes(forbidden), false, forbidden)
  }
  for (const verdict of result.claimVerdicts) {
    assert.deepEqual(Object.keys(verdict).sort(), [
      'claimId',
      'counsellorId',
      'mandatory',
      'reasonCode',
      'verdict',
    ])
  }
})

check('the input is never mutated and a throwing observer is contained', () => {
  const input = { counsellors: structuredClone(COUNCIL) }
  const before = structuredClone(input)
  const result = evaluateClaimsPoint(input, () => {
    throw new Error('observer failure')
  })
  assert.deepEqual(input, before)
  assert.equal(result.aggregate, 'FAIL')
  assert.equal(result.record.effect, 'none')
})

check('a hostile input is contained as a record, never thrown', () => {
  const result = evaluateClaimsPoint({
    counsellors: [{ id: 'athena', claims: [{ id: 'x', mandatory: true, responder: () => 1 }] }],
  })
  assert.equal(result.record.decision, 'unavailable')
  assert.equal(result.reason, 'payload_not_clonable')
  assert.equal(result.aggregate, null)
  assert.deepEqual(result.claimVerdicts, [])
})

check('every reason is a record token', () => {
  const samples = [
    evaluateClaimsPoint(undefined),
    evaluateClaimsPoint({ counsellors: [] }),
    evaluateClaimsPoint({ counsellors: structuredClone(COUNCIL) }),
    evaluateClaimsPoint({ counsellors: [{ id: 'empty', claims: [] }] }),
  ]
  for (const result of samples) {
    assert.match(result.reason, REASON_TOKEN)
    assert.equal(result.record.point, 'P10')
    assert.equal(result.record.effect, 'none')
  }
})

check('the P10 module stays offline and catalog-free', () => {
  const source = readFileSync(
    new URL('../../src/pantheon/v2-decision-points/p10-claims.ts', import.meta.url),
    'utf8',
  )
  assert.equal(source.includes(['ctx', 'catalog'].join('.')), false)
  for (const forbidden of ['node:http', 'node:https', 'node:net', 'undici', 'fetch(']) {
    assert.equal(source.includes(forbidden), false, forbidden)
  }
})

console.log(`V2 decision P10: ${checks} groups passed`)
