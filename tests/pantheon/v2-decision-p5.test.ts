/**
 * P5 — `verify` in the `execute.after` position, in shadow.
 *
 * The verdict vocabulary is exactly PASS / FAIL / BLOCK. `failed_to_respond`
 * during a mandatory verification is BLOCK, never PASS; during an advisory
 * verification it is FAIL. The adapter is a recorder: `execute.before` remains
 * the only hard barrier, so this module can neither deny, delay nor mutate
 * admission — and the tests assert that structurally rather than by promise.
 *
 * Fixtures are synthetic. No prompt, tool output or user content is used.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-p5.test.ts
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { evaluateThemisPoint } from '../../src/pantheon/v2-decision-points/p5-themis-verify.ts'
import type { ShadowRecord } from '../../src/pantheon/v2-decision-shadow.ts'

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
  checks += 1
  void name
}

const REASON_TOKEN = /^[a-z0-9][a-z0-9.:-]{0,63}$/

/** A `execute.after` event in the shape `v2-execute-after.ts` documents. */
const EXECUTE_AFTER_EVENT = {
  tool: 'write',
  sessionID: 'ses_fixture_p5',
  agent: 'hermes',
  messageID: 'msg_fixture_p5',
  id: 'call_fixture_p5',
  input: { path: 'src/example.ts' },
  status: 'completed',
  result: { output: 'ok' },
} as const

const REQUIREMENTS = [
  { id: 'themis.types', mandatory: true },
  { id: 'themis.tests', mandatory: false },
] as const

check('explicit verdicts pass through unchanged', () => {
  const result = evaluateThemisPoint({
    execution: EXECUTE_AFTER_EVENT,
    requirements: REQUIREMENTS,
    responses: { 'themis.types': 'PASS', 'themis.tests': 'FAIL' },
  })
  assert.equal(result.record.point, 'P5')
  assert.equal(result.record.effect, 'none')
  assert.equal(result.verdict, 'FAIL')
  assert.deepEqual(
    result.verdicts.map((outcome) => [outcome.requirementId, outcome.verdict]),
    [
      ['themis.types', 'PASS'],
      ['themis.tests', 'FAIL'],
    ],
  )
})

check('failed_to_respond on a mandatory verification is BLOCK', () => {
  for (const response of [undefined, null, { kind: 'unknown' }, 42]) {
    const result = evaluateThemisPoint({
      execution: EXECUTE_AFTER_EVENT,
      requirements: [{ id: 'themis.mandatory', mandatory: true }],
      responses: { 'themis.mandatory': response },
    })
    assert.equal(result.verdict, 'BLOCK')
    assert.equal(result.verdicts[0]?.verdict, 'BLOCK')
    assert.equal(result.verdicts[0]?.reasonCode, 'FAILED_TO_RESPOND')
    assert.equal(result.record.effect, 'none')
  }
})

check('failed_to_respond on an advisory verification is FAIL, never PASS', () => {
  const result = evaluateThemisPoint({
    execution: EXECUTE_AFTER_EVENT,
    requirements: [{ id: 'themis.advisory', mandatory: false }],
  })
  assert.equal(result.verdict, 'FAIL')
  assert.equal(result.verdicts[0]?.reasonCode, 'FAILED_TO_RESPOND')
  assert.notEqual(result.verdict, 'PASS')
})

check('an unrecognized verdict is never promoted to PASS', () => {
  const mandatory = evaluateThemisPoint({
    execution: EXECUTE_AFTER_EVENT,
    requirements: [{ id: 'themis.mandatory', mandatory: true }],
    responses: { 'themis.mandatory': 'pass' },
  })
  assert.equal(mandatory.verdict, 'BLOCK')
  assert.equal(mandatory.verdicts[0]?.reasonCode, 'UNRECOGNIZED_VERDICT')

  const advisory = evaluateThemisPoint({
    execution: EXECUTE_AFTER_EVENT,
    requirements: [{ id: 'themis.advisory', mandatory: false }],
    responses: { 'themis.advisory': 'maybe' },
  })
  assert.equal(advisory.verdict, 'FAIL')
})

check('BLOCK dominates FAIL, and FAIL dominates PASS', () => {
  const blockWins = evaluateThemisPoint({
    execution: EXECUTE_AFTER_EVENT,
    requirements: [
      { id: 'a', mandatory: false },
      { id: 'b', mandatory: true },
      { id: 'c', mandatory: true },
    ],
    responses: { a: 'PASS', c: 'PASS' },
  })
  assert.equal(blockWins.verdict, 'BLOCK')

  const allPass = evaluateThemisPoint({
    execution: EXECUTE_AFTER_EVENT,
    requirements: [
      { id: 'a', mandatory: true },
      { id: 'b', mandatory: false },
    ],
    responses: { a: 'PASS', b: 'PASS' },
  })
  assert.equal(allPass.verdict, 'PASS')
  assert.equal(allPass.record.decision, 'verify.pass')
})

check('no declared requirement means no verdict at all', () => {
  for (const requirements of [undefined, null, [], 'themis', [{ id: 'a' }], [{ id: 'a b' }]]) {
    const result = evaluateThemisPoint({ execution: EXECUTE_AFTER_EVENT, requirements })
    assert.equal(result.verdict, null)
    assert.deepEqual(result.verdicts, [])
    assert.equal(result.record.decision, 'refusal')
    assert.equal(result.verificationSource, 'none')
    assert.match(result.reason, REASON_TOKEN)
  }
})

check('duplicate requirement ids fail closed instead of double-counting', () => {
  const result = evaluateThemisPoint({
    execution: EXECUTE_AFTER_EVENT,
    requirements: [
      { id: 'dup', mandatory: true },
      { id: 'dup', mandatory: false },
    ],
    responses: { dup: 'PASS' },
  })
  assert.equal(result.verdict, null)
  assert.deepEqual(result.verdicts, [])
  assert.equal(result.reason, 'themis.requirements.duplicate')
})

check('the adapter cannot deny, delay or mutate admission', () => {
  const payload = {
    execution: structuredClone(EXECUTE_AFTER_EVENT),
    requirements: REQUIREMENTS.map((requirement) => ({ ...requirement })),
    responses: { 'themis.types': 'BLOCK' },
  }
  const before = structuredClone(payload)
  const result = evaluateThemisPoint(payload)

  // A BLOCK verdict is recorded, and it still changes nothing.
  assert.equal(result.verdict, 'BLOCK')
  assert.equal(result.record.effect, 'none')
  assert.deepEqual(payload, before, 'the execute.after payload is never mutated')

  // No admission directive of any kind is returned.
  for (const forbidden of ['allow', 'deny', 'block', 'admission', 'result', 'output', 'input']) {
    assert.equal(forbidden in result, false, forbidden)
  }
  // Not a promise: the adapter cannot delay the tool result.
  assert.equal('then' in result, false)
  assert.equal(typeof (result as unknown as Promise<unknown>).then, 'undefined')
})

check('a throwing observer cannot become an admission failure', () => {
  const records: ShadowRecord[] = []
  const result = evaluateThemisPoint(
    {
      execution: EXECUTE_AFTER_EVENT,
      requirements: [{ id: 'a', mandatory: true }],
      responses: { a: 'PASS' },
    },
    (record) => {
      records.push(record)
      throw new Error('observer failure')
    },
  )
  assert.equal(result.verdict, 'PASS')
  assert.equal(records.length, 1)
})

check('an unclonable payload is contained as a record, never thrown', () => {
  const result = evaluateThemisPoint({
    execution: { ...EXECUTE_AFTER_EVENT, run: () => 1 },
    requirements: [{ id: 'a', mandatory: true }],
    responses: { a: 'PASS' },
  })
  assert.equal(result.record.decision, 'unavailable')
  assert.equal(result.reason, 'payload_not_clonable')
  assert.equal(result.verdict, null)
  assert.deepEqual(result.verdicts, [])
})

check('every reason is a record token and every record is a no-op', () => {
  const samples = [
    evaluateThemisPoint(undefined),
    evaluateThemisPoint({}),
    evaluateThemisPoint({ execution: EXECUTE_AFTER_EVENT, requirements: REQUIREMENTS }),
    evaluateThemisPoint({
      execution: EXECUTE_AFTER_EVENT,
      requirements: REQUIREMENTS,
      responses: { 'themis.types': 'PASS', 'themis.tests': 'PASS' },
    }),
  ]
  for (const result of samples) {
    assert.match(result.reason, REASON_TOKEN)
    assert.equal(result.record.effect, 'none')
    assert.equal(result.record.point, 'P5')
  }
})

check('the P5 module is offline and mirrors no admission surface', () => {
  const source = readFileSync(
    new URL('../../src/pantheon/v2-decision-points/p5-themis-verify.ts', import.meta.url),
    'utf8',
  )
  for (const forbidden of ['node:http', 'node:https', 'node:net', 'undici', 'fetch(']) {
    assert.equal(source.includes(forbidden), false, forbidden)
  }
  assert.equal(source.includes(['ctx', 'catalog'].join('.')), false)
  // Only `execute.after` is in scope: the hard barrier is never touched.
  assert.equal(source.includes('execute.before'), true, 'the invariant is documented')
})

console.log(`V2 decision P5: ${checks} groups passed`)
