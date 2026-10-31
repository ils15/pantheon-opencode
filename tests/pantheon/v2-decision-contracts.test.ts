/**
 * Contracts for `ask`, `rank` and `verify`.
 *
 * Assertions cover the binding limits (1–255 labels, 2–10 levels), refusal as
 * success, failed_to_respond as BLOCK under mandatory verification, and the
 * determinism/serialisability of rank.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-contracts.test.ts
 */
import { strict as assert } from 'node:assert'
import {
  ASK_CHOICE_MAX_LABELS,
  ASK_SCORE_MAX_LEVELS,
  ASK_SCORE_MIN_LEVELS,
  escapeAskLabel,
  evaluateAskAnswer,
  rankCandidates,
  renderChoiceLabels,
  resolveVerify,
  validateAsk,
} from '../../src/pantheon/v2-decision-contracts.ts'
import {
  INVALID_QUESTIONS,
  INVALID_RANK_CANDIDATES,
  RANK_CANDIDATES,
  VALID_CHOICE,
  VALID_NOUL,
  VALID_REFUSAL,
  VALID_SCORE,
} from './v2-decision-fixtures.ts'

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
  checks += 1
  void name
}

// ─── ask: validation ───────────────────────────────────────────────────

check('valid questions validate', () => {
  for (const question of [VALID_CHOICE, VALID_NOUL, VALID_SCORE, VALID_REFUSAL]) {
    const result = validateAsk(question)
    assert.equal(result.ok, true, `${question.mode} should validate`)
  }
})

check('invalid questions fail with their specific code', () => {
  for (const fixture of INVALID_QUESTIONS) {
    const result = validateAsk(fixture.question)
    assert.equal(result.ok, false, fixture.name)
    if (!result.ok) assert.equal(result.code, fixture.code, fixture.name)
  }
})

check('choice accepts exactly 255 labels', () => {
  const labels = Array.from({ length: ASK_CHOICE_MAX_LABELS }, (_, index) => `label-${index}`)
  const result = validateAsk({ mode: 'choice', id: 'q', text: 't', labels })
  assert.equal(result.ok, true)
})

check('choice rejects 256 labels', () => {
  const labels = Array.from({ length: ASK_CHOICE_MAX_LABELS + 1 }, (_, index) => `label-${index}`)
  const result = validateAsk({ mode: 'choice', id: 'q', text: 't', labels })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.code, 'TOO_MANY_LABELS')
})

check('score accepts the 2..10 boundaries', () => {
  for (const levels of [ASK_SCORE_MIN_LEVELS, ASK_SCORE_MAX_LEVELS]) {
    const result = validateAsk({ mode: 'score', id: 'q', text: 't', levels })
    assert.equal(result.ok, true, `levels=${levels}`)
  }
})

check('labels are trimmed once and stored without surrounding whitespace', () => {
  const result = validateAsk({
    mode: 'choice',
    id: 'q',
    text: 't',
    labels: ['  alpha  ', 'beta'],
  })
  assert.equal(result.ok, true)
  if (result.ok && result.question.mode === 'choice') {
    assert.deepEqual(result.question.labels, ['alpha', 'beta'])
  }
})

check('label rendering escapes quotes and numbers from one', () => {
  assert.equal(escapeAskLabel('a "b" \\ c'), 'a \\"b\\" \\\\ c')
  const lines = renderChoiceLabels({
    mode: 'choice',
    id: 'q',
    text: 't',
    labels: ['a "b"', 'c'],
  })
  assert.deepEqual(lines, ['1. "a \\"b\\""', '2. "c"'])
})

// ─── ask: answers ──────────────────────────────────────────────────────

check('noul resolves both binary values', () => {
  assert.deepEqual(evaluateAskAnswer(VALID_NOUL, { kind: 'noul', value: 0 }), {
    status: 'noul',
    questionId: 'fixture-noul',
    value: 0,
  })
  assert.deepEqual(evaluateAskAnswer(VALID_NOUL, { kind: 'noul', value: 1 }), {
    status: 'noul',
    questionId: 'fixture-noul',
    value: 1,
  })
})

check('noul rejects two and string truthiness', () => {
  for (const answer of [
    { kind: 'noul', value: 2 },
    { kind: 'noul', value: '1' },
    { kind: 'noul', value: true },
    { kind: 'choice', index: 1 },
    'yes',
  ]) {
    const result = evaluateAskAnswer(VALID_NOUL, answer)
    assert.equal(result.status, 'failed', JSON.stringify(answer))
    if (result.status === 'failed') assert.equal(result.reasonCode, 'INVALID_ANSWER')
  }
})

check('choice resolves the 1-based index to its label', () => {
  const result = evaluateAskAnswer(VALID_CHOICE, { kind: 'choice', index: 2 })
  assert.deepEqual(result, {
    status: 'choice',
    questionId: 'fixture-choice',
    index: 2,
    label: 'beta "quoted"',
  })
})

check('choice rejects zero, len+1 and fractional indices', () => {
  const cases: [number, string][] = [
    [0, 'OUT_OF_RANGE'],
    [VALID_CHOICE.mode === 'choice' ? VALID_CHOICE.labels.length + 1 : 4, 'OUT_OF_RANGE'],
    [1.5, 'INVALID_ANSWER'],
    [Number.NaN, 'INVALID_ANSWER'],
  ]
  for (const [index, reasonCode] of cases) {
    const result = evaluateAskAnswer(VALID_CHOICE, { kind: 'choice', index })
    assert.equal(result.status, 'failed', `index=${index}`)
    if (result.status === 'failed') assert.equal(result.reasonCode, reasonCode)
  }
})

check('score resolves in range and rejects boundaries outside it', () => {
  assert.deepEqual(evaluateAskAnswer(VALID_SCORE, { kind: 'score', level: 5 }), {
    status: 'score',
    questionId: 'fixture-score',
    level: 5,
  })
  for (const level of [0, 6, -1]) {
    const result = evaluateAskAnswer(VALID_SCORE, { kind: 'score', level })
    assert.equal(result.status, 'failed', `level=${level}`)
    if (result.status === 'failed') assert.equal(result.reasonCode, 'OUT_OF_RANGE')
  }
})

check('refusal is success for every mode', () => {
  for (const question of [VALID_CHOICE, VALID_NOUL, VALID_SCORE, VALID_REFUSAL]) {
    const result = evaluateAskAnswer(question, { kind: 'refusal' })
    assert.equal(result.status, 'refusal', question.mode)
    if (result.status === 'refusal') {
      assert.equal(
        result.reasonCode,
        question.mode === 'refusal' ? 'REFUSAL_MODE' : 'ANSWERED_REFUSAL',
      )
    }
  }
})

check('a non-refusal answer cannot satisfy a refusal-mode question', () => {
  const result = evaluateAskAnswer(VALID_REFUSAL, { kind: 'noul', value: 1 })
  assert.equal(result.status, 'failed')
})

check('missing answers fail as failed_to_respond', () => {
  for (const answer of [undefined, null]) {
    const result = evaluateAskAnswer(VALID_CHOICE, answer)
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') assert.equal(result.reasonCode, 'FAILED_TO_RESPOND')
  }
})

check('malformed answers fail closed as invalid', () => {
  for (const answer of [{}, { kind: 1 }, [], 'PASS', 1]) {
    const result = evaluateAskAnswer(VALID_CHOICE, answer)
    assert.equal(result.status, 'failed', JSON.stringify(answer))
    if (result.status === 'failed') assert.equal(result.reasonCode, 'INVALID_ANSWER')
  }
})

check('an invalid question is reported separately from a model failure', () => {
  const result = evaluateAskAnswer(
    { mode: 'choice', id: 'q', text: 't', labels: ['a', 'a'] },
    { kind: 'choice', index: 1 },
  )
  assert.equal(result.status, 'invalid_question')
  if (result.status === 'invalid_question') assert.equal(result.reasonCode, 'DUPLICATE_LABEL')
})

check('questions are independent: an earlier index cannot leak into the next question', () => {
  const first = evaluateAskAnswer(VALID_CHOICE, { kind: 'choice', index: 3 })
  assert.equal(first.status, 'choice')
  const second = evaluateAskAnswer(
    { mode: 'choice', id: 'second', text: 't', labels: ['only'] },
    { kind: 'choice', index: 3 },
  )
  assert.equal(second.status, 'failed')
})

// ─── verify ────────────────────────────────────────────────────────────

check('explicit verdicts pass through unchanged', () => {
  for (const verdict of ['PASS', 'FAIL', 'BLOCK'] as const) {
    const result = resolveVerify({ id: 'v', mandatory: true }, verdict)
    assert.deepEqual(result, {
      requirementId: 'v',
      verdict,
      reasonCode: 'VERDICT',
      mandatory: true,
    })
  }
})

check('failed_to_respond blocks mandatory verification', () => {
  for (const response of [undefined, null, {}, { confidence: 0.99 }, '', 'PASS ']) {
    const result = resolveVerify({ id: 'v', mandatory: true }, response)
    assert.equal(result.verdict, 'BLOCK', JSON.stringify(response))
    assert.notEqual(result.reasonCode, 'VERDICT')
  }
})

check('advisory verification never promotes a missing verdict to PASS', () => {
  for (const response of [undefined, null, {}, { confidence: 0.99 }, 'ok']) {
    const result = resolveVerify({ id: 'v', mandatory: false }, response)
    assert.equal(result.verdict, 'FAIL', JSON.stringify(response))
  }
})

check('a certainty scalar is not a verdict', () => {
  const result = resolveVerify({ id: 'v', mandatory: true }, { confidence: 1 })
  assert.equal(result.verdict, 'BLOCK')
  assert.equal(result.reasonCode, 'FAILED_TO_RESPOND')
})

// ─── rank ──────────────────────────────────────────────────────────────

check('rank orders by score descending and id ascending on ties', () => {
  const result = rankCandidates(RANK_CANDIDATES)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.deepEqual(
      result.ordered.map((candidate) => [candidate.rank, candidate.id]),
      [
        [1, 'alpha'],
        [2, 'beta'],
        [3, 'zeta'],
      ],
    )
  }
})

check('rank output is deterministic and JSON-serialisable', () => {
  const first = rankCandidates(RANK_CANDIDATES)
  const second = rankCandidates(RANK_CANDIDATES)
  assert.deepEqual(first, second)
  assert.deepEqual(JSON.parse(JSON.stringify(first)), first)
})

check('rank rejects malformed candidate sets', () => {
  for (const fixture of INVALID_RANK_CANDIDATES) {
    const result = rankCandidates(fixture.candidates)
    assert.equal(result.ok, false, fixture.name)
  }
})

check('rank does not mutate its input', () => {
  const input = [
    { id: 'b', score: 1, justification: 'x' },
    { id: 'a', score: 2, justification: 'y' },
  ]
  const before = JSON.stringify(input)
  rankCandidates(input)
  assert.equal(JSON.stringify(input), before)
})

console.log(`V2 decision contracts: ${checks} groups passed`)
