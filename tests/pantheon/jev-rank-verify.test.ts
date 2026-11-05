/**
 * Focused offline tests for the v3.1 rank and verify primitives on
 * `pantheon_jev_decide`.
 *
 * `mode: "rank"` ranks 2-8 named candidates through ONE typed round-trip: one
 * choice question picks the best candidate and one score question rates that
 * candidate's fit. The host Decisions API returns one scalar answer per
 * question, so a per-candidate score column (and therefore a runner-up or a
 * full ordering) is NOT expressible — the tool returns `{ winner, winnerFit }`
 * and says exactly that.
 *
 * `mode: "verify"` checks 1-4 named claims through ONE predicate question per
 * claim: probability >= 0.5 is PASS, below is FAIL, and every refusal, timeout,
 * duplicate or malformed answer is BLOCK — fail-closed. Claims are
 * caller-provided bounded strings in the J4 criteria sanitization class:
 * hostile shapes are rejected `CLAIM_INVALID`, never scrubbed.
 *
 * Both modes run the same shared gate chain (no new telemetry points: they are
 * tool modes, not shadow gates) and reuse the tool's strict answer consumer.
 *
 * Run with: npx tsx tests/pantheon/jev-rank-verify.test.ts
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DECISION_ROUTER_MODELS,
  writeUserDecisionRouterConfig,
} from '../../scripts/install/decision-router-config.mjs'
import type { V2JevDecisionRuntime } from '../../src/pantheon/jev-decision-tool.ts'
import {
  createV2JevDecisionDefinition,
  runJevDecision,
} from '../../src/pantheon/jev-decision-tool.ts'
import {
  buildJevRankRequest,
  buildJevVerifyRequest,
  CLAIM_MAX_LENGTH,
  consumeJevRankResult,
  consumeJevVerifyResult,
  prepareJevRankRequest,
  prepareJevVerifyRequest,
  RANK_FIT_LEVEL_COUNT,
  RANK_FIT_QUESTION_NAME,
  RANK_MAX_CANDIDATES,
  RANK_MIN_CANDIDATES,
  RANK_WINNER_QUESTION_NAME,
  VERIFY_MAX_CLAIMS,
  VERIFY_MIN_CLAIMS,
  VERIFY_PASS_THRESHOLD,
} from '../../src/pantheon/jev-rank-verify.ts'
import {
  openLocalDecisionBudgetLedger,
  resolveLocalDecisionBudgetDbPath,
} from '../../src/pantheon/local-decision-budget.ts'
import type {
  NativeDecisionRequest,
  ResolvedNativeDecisionRoute,
} from '../../src/pantheon/v2-native-decisions.ts'

let checks = 0
function check(name: string, fn: () => void | Promise<void>): void {
  const result = fn()
  if (result instanceof Promise) {
    throw new Error('use checkAsync for async checks')
  }
  checks += 1
  void name
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  await fn()
  checks += 1
  void name
}

/** An assert message that survives `JSON.stringify(undefined)`. */
function label(value: unknown): string {
  return JSON.stringify(value) ?? String(value)
}

const ROUTE: ResolvedNativeDecisionRoute = Object.freeze({
  model: Object.freeze({ providerID: 'opencode', id: 'jev-1.13' }),
  kind: 'opencode-console-jev',
  billing: 'OpenCode Console',
})

const BENIGN_CANDIDATES = [
  { id: 'parser-v2', description: 'the streaming parser rewrite' },
  { id: 'parser_v1' },
]

function rankInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    mode: 'rank',
    state: 'pick the parser implementation for the streaming ingestion task',
    candidates: BENIGN_CANDIDATES.map((candidate) => ({ ...candidate })),
    ...overrides,
  }
}

function verifyInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    mode: 'verify',
    claims: [
      { name: 'claim_a', claim: 'the parser module compiles without errors' },
      { name: 'claim_b', claim: 'the fixture suite runs offline' },
    ],
    ...overrides,
  }
}

// ─── Constants ───────────────────────────────────────────────────────────

function testConstants(): void {
  assert.equal(RANK_MIN_CANDIDATES, 2, 'a ranking needs at least two candidates')
  assert.equal(RANK_MAX_CANDIDATES, 8)
  assert.equal(RANK_WINNER_QUESTION_NAME, 'winner')
  assert.equal(RANK_FIT_QUESTION_NAME, 'fit')
  assert.equal(RANK_FIT_LEVEL_COUNT, 9, 'the fit rubric mirrors the 2..10 bound')
  assert.equal(VERIFY_MIN_CLAIMS, 1)
  assert.equal(
    VERIFY_MAX_CLAIMS,
    4,
    'one predicate question per claim, within the 4-question bound',
  )
  assert.equal(CLAIM_MAX_LENGTH, 200)
  assert.equal(VERIFY_PASS_THRESHOLD, 0.5)
}

// ─── Rank request building ───────────────────────────────────────────────

function testRankBuildBoundedShape(): void {
  const built = buildJevRankRequest(rankInput())
  assert.ok(built.ok)
  if (!built.ok) return
  const request = built.request
  assert.equal(request.input.length, 1, 'exactly one text part')
  assert.equal(request.input[0]?.type, 'text')
  assert.equal(
    (request.input[0] as { text: string }).text,
    'pick the parser implementation for the streaming ingestion task',
    'the state is carried verbatim',
  )
  assert.equal(request.questions.length, 2, 'exactly TWO questions: one round-trip')
  const [choice, score] = request.questions
  assert.ok(choice && score)
  assert.equal(choice.type, 'choice')
  assert.equal(choice.name, RANK_WINNER_QUESTION_NAME)
  assert.deepEqual(
    choice.choices?.map((option) => option.value),
    ['parser-v2', 'parser_v1'],
    'the candidate ids are the choice values, in input order',
  )
  assert.equal(choice.choices?.[0]?.description, 'the streaming parser rewrite')
  assert.equal(choice.choices?.[1]?.description, undefined)
  assert.equal(score.type, 'score')
  assert.equal(score.name, RANK_FIT_QUESTION_NAME)
  assert.equal(score.levels?.length, RANK_FIT_LEVEL_COUNT)
  assert.ok(choice.instructions.length > 0 && choice.instructions.length <= 2000)
  assert.ok(score.instructions.length > 0 && score.instructions.length <= 2000)
}

function testRankCandidateBounds(): void {
  const eight = Array.from({ length: 8 }, (_, index) => ({ id: `c${index + 1}` }))
  const nine = Array.from({ length: 9 }, (_, index) => ({ id: `c${index + 1}` }))
  assert.ok(buildJevRankRequest(rankInput({ candidates: eight })).ok, 'the 8-candidate cap holds')
  assert.deepEqual(
    buildJevRankRequest(rankInput({ candidates: nine })),
    { ok: false, reasonCode: 'CANDIDATE_INVALID' },
    'more than 8 candidates is rejected',
  )
  assert.deepEqual(buildJevRankRequest(rankInput({ candidates: [eight[0] ?? {}] })), {
    ok: false,
    reasonCode: 'CANDIDATE_INVALID',
  })
  assert.deepEqual(buildJevRankRequest(rankInput({ candidates: [] })), {
    ok: false,
    reasonCode: 'CANDIDATE_INVALID',
  })
  // `undefined` candidates is the missing-field case (RANK_INPUT_INVALID,
  // covered by the envelope test); every other non-array shape is hostile.
  for (const candidates of ['c1 c2', 4, null, [{ id: 'a' }, 'b'], [[{ id: 'a' }]]]) {
    assert.deepEqual(
      buildJevRankRequest(rankInput({ candidates })),
      { ok: false, reasonCode: 'CANDIDATE_INVALID' },
      label(candidates),
    )
  }
}

function testRankCandidateIdValidation(): void {
  const base = { state: 'state text' }
  // Duplicate ids cannot form a choice list.
  assert.deepEqual(
    buildJevRankRequest(rankInput({ candidates: [{ id: 'same' }, { id: 'same' }] })),
    { ok: false, reasonCode: 'CANDIDATE_INVALID' },
  )
  const hostileIds = [
    '../escape',
    '/etc/passwd',
    'has space',
    'injection; drop table users',
    `${'a'.repeat(65)}`,
    '',
    '   ',
    42,
    null,
    undefined,
    { id: 'a' },
  ]
  for (const id of hostileIds) {
    assert.deepEqual(
      buildJevRankRequest(rankInput({ candidates: [{ id }, { id: 'ok' }] })),
      { ok: false, reasonCode: 'CANDIDATE_INVALID' },
      label(id),
    )
  }
  const benignIds = ['c1', 'parser-v2', 'skill_one', 'a.b:c-d', 'Model2']
  for (const id of benignIds) {
    const built = buildJevRankRequest(rankInput({ candidates: [{ id }, { id: 'other' }] }))
    assert.ok(built.ok, label(id))
  }
  void base
}

function testRankHostileDescriptionsRejected(): void {
  const hostile = [
    'the output matches /etc/passwd',
    'reads C:\\Users\\data',
    'see ~/notes.md for the goal',
    '../../escape',
    'password=hunter2',
    'API_KEY: sk-abcdefghijklmnopqrs',
    'the token = ghp_abcdefghijklmnopqrst',
    '-----BEGIN RSA PRIVATE KEY-----',
    'goal one\ngoal two',
    'tab\tseparated',
  ]
  for (const description of hostile) {
    assert.deepEqual(
      buildJevRankRequest(rankInput({ candidates: [{ id: 'c1', description }, { id: 'c2' }] })),
      { ok: false, reasonCode: 'CANDIDATE_INVALID' },
      label(description),
    )
  }
  const benign = [
    'handles secrets without echoing them',
    'no credential material appears in the output',
    'the streaming parser rewrite',
    'goal: ship the parser module',
  ]
  for (const description of benign) {
    const built = buildJevRankRequest(
      rankInput({ candidates: [{ id: 'c1', description }, { id: 'c2' }] }),
    )
    assert.ok(built.ok, label(description))
  }
}

function testRankDescriptionBound(): void {
  assert.ok(
    buildJevRankRequest(
      rankInput({ candidates: [{ id: 'c1', description: 'x'.repeat(500) }, { id: 'c2' }] }),
    ).ok,
    '500-char descriptions are admitted',
  )
  assert.deepEqual(
    buildJevRankRequest(
      rankInput({ candidates: [{ id: 'c1', description: 'x'.repeat(501) }, { id: 'c2' }] }),
    ),
    { ok: false, reasonCode: 'CANDIDATE_INVALID' },
  )
  // A description that is not a bounded string is rejected, never coerced.
  for (const description of [42, null, {}, ['a'], true]) {
    assert.deepEqual(
      buildJevRankRequest(rankInput({ candidates: [{ id: 'c1', description }, { id: 'c2' }] })),
      { ok: false, reasonCode: 'CANDIDATE_INVALID' },
    )
  }
}

function testRankStateValidation(): void {
  for (const state of [undefined, '', '   ', 42, null, 'x'.repeat(12_001)]) {
    assert.deepEqual(
      buildJevRankRequest(rankInput({ state })),
      { ok: false, reasonCode: 'STATE_INVALID' },
      label(state),
    )
  }
  assert.ok(
    buildJevRankRequest(rankInput({ state: 'x'.repeat(12_000) })).ok,
    'the 12,000-char state bound holds',
  )
}

function testRankEnvelope(): void {
  // Any smuggled slot refuses the preparation — no content field beyond the
  // bounded envelope (schemaVersion, mode, state, candidates).
  for (const [key, value] of [
    ['questions', [{ type: 'choice', name: 'q', instructions: 'i', choices: [{ value: 'a' }] }]],
    ['criteria', ['a']],
    ['delegateId', 'apollo'],
    ['claims', [{ name: 'n', claim: 'c' }]],
    ['resultMetrics', { outputChars: 1 }],
    ['unexpected', true],
  ]) {
    assert.deepEqual(
      buildJevRankRequest(rankInput({ [key]: value })),
      { ok: false, reasonCode: 'RANK_INPUT_INVALID' },
      key,
    )
  }
  // Missing candidates is a malformed rank.
  const partial = rankInput()
  delete partial.candidates
  assert.deepEqual(buildJevRankRequest(partial), { ok: false, reasonCode: 'RANK_INPUT_INVALID' })
  for (const input of [null, undefined, 'rank', 42]) {
    assert.deepEqual(buildJevRankRequest(input), { ok: false, reasonCode: 'RANK_INPUT_INVALID' })
  }
}

function testRankPreparerAttachesModel(): void {
  const prepared = prepareJevRankRequest(ROUTE, rankInput())
  assert.ok(prepared.ok)
  if (!prepared.ok) return
  assert.deepEqual(prepared.request.model, { providerID: 'opencode', id: 'jev-1.13' })
  assert.deepEqual(Object.keys(prepared.request).sort(), ['input', 'model', 'questions'])
}

// ─── Rank consumption ────────────────────────────────────────────────────

function rankRequest(): NativeDecisionRequest {
  const prepared = prepareJevRankRequest(ROUTE, rankInput())
  assert.ok(prepared.ok)
  if (!prepared.ok) throw new Error('unreachable')
  return prepared.request
}

function testRankConsumeValid(): void {
  const verdict = consumeJevRankResult(
    {
      answers: [
        { type: 'choice', name: 'winner', choice: 'parser_v1', confidence: 0.7 },
        { type: 'score', name: 'fit', score: 7, confidence: 0.8 },
      ],
      cost: 0.000002,
    },
    rankRequest(),
  )
  assert.deepEqual(verdict, { winner: 'parser_v1', winnerFit: 7 })
}

function testRankConsumeMalformed(): void {
  // An out-of-pool choice is dropped by the strict consumer.
  assert.deepEqual(
    consumeJevRankResult(
      { answers: [{ type: 'choice', name: 'winner', choice: 'not-a-candidate' }] },
      rankRequest(),
    ),
    { winner: null, winnerFit: null },
  )
  // Error answers are skipped, never guessed.
  assert.deepEqual(
    consumeJevRankResult(
      {
        answers: [
          { type: 'error', name: 'winner', reason: 'model_declined' },
          { type: 'error', name: 'fit', reason: 'model_declined' },
        ],
      },
      rankRequest(),
    ),
    { winner: null, winnerFit: null },
  )
  // Missing and malformed response shapes yield nulls.
  assert.deepEqual(consumeJevRankResult({ answers: [] }, rankRequest()), {
    winner: null,
    winnerFit: null,
  })
  assert.deepEqual(consumeJevRankResult(null, rankRequest()), { winner: null, winnerFit: null })
  assert.deepEqual(consumeJevRankResult({ answers: 'no' }, rankRequest()), {
    winner: null,
    winnerFit: null,
  })
  // Duplicate answers become errors in the shared consumer and are skipped.
  assert.deepEqual(
    consumeJevRankResult(
      {
        answers: [
          { type: 'choice', name: 'winner', choice: 'parser_v1' },
          { type: 'choice', name: 'winner', choice: 'parser-v2' },
        ],
      },
      rankRequest(),
    ),
    { winner: null, winnerFit: null },
  )
  // A score answer carrying garbage is dropped.
  assert.deepEqual(
    consumeJevRankResult(
      { answers: [{ type: 'score', name: 'fit', score: 'high' }] },
      rankRequest(),
    ),
    { winner: null, winnerFit: null },
  )
}

// ─── Verify request building ─────────────────────────────────────────────

function testVerifyBuildBoundedShape(): void {
  const built = buildJevVerifyRequest(verifyInput())
  assert.ok(built.ok)
  if (!built.ok) return
  const request = built.request
  assert.equal(request.input.length, 1, 'exactly one text part')
  const state = (request.input[0] as { text: string }).text
  assert.equal(
    state.includes('the parser module compiles'),
    false,
    'the claims ride the question instructions, never the state part',
  )
  assert.equal(request.questions.length, 2, 'one predicate question per claim')
  const [first, second] = request.questions
  assert.ok(first && second)
  assert.equal(first.type, 'predicate')
  assert.equal(first.name, 'claim_a')
  assert.equal(first.choices, undefined)
  assert.equal(first.levels, undefined)
  assert.equal(second.type, 'predicate')
  assert.equal(second.name, 'claim_b')
  // Each claim text rides its own question's instructions, exactly once.
  assert.equal(first.instructions.includes('the parser module compiles without errors'), true)
  assert.equal(second.instructions.includes('the fixture suite runs offline'), true)
  for (const question of request.questions) {
    assert.ok(question.instructions.length > 0 && question.instructions.length <= 2000)
  }
}

function testVerifyClaimBounds(): void {
  const four = Array.from({ length: 4 }, (_, index) => ({
    name: `claim_${index + 1}`,
    claim: `claim ${index + 1} holds`,
  }))
  const five = Array.from({ length: 5 }, (_, index) => ({
    name: `claim_${index + 1}`,
    claim: `claim ${index + 1} holds`,
  }))
  assert.ok(buildJevVerifyRequest(verifyInput({ claims: four })).ok, 'the 4-claim cap holds')
  assert.deepEqual(buildJevVerifyRequest(verifyInput({ claims: five })), {
    ok: false,
    reasonCode: 'CLAIM_INVALID',
  })
  assert.deepEqual(buildJevVerifyRequest(verifyInput({ claims: [] })), {
    ok: false,
    reasonCode: 'CLAIM_INVALID',
  })
  // `undefined` claims is the missing-field case (VERIFY_INPUT_INVALID,
  // covered by the envelope test); every other non-array shape is hostile.
  for (const claims of ['a b', 2, null, [{ name: 'a' }], [['x']]]) {
    assert.deepEqual(
      buildJevVerifyRequest(verifyInput({ claims })),
      { ok: false, reasonCode: 'CLAIM_INVALID' },
      label(claims),
    )
  }
}

function testVerifyClaimNameValidation(): void {
  const hostileNames = [
    '../escape',
    '/etc/passwd',
    'has space',
    `${'a'.repeat(65)}`,
    '',
    '   ',
    42,
    null,
    undefined,
  ]
  for (const name of hostileNames) {
    assert.deepEqual(
      buildJevVerifyRequest(verifyInput({ claims: [{ name, claim: 'a bounded claim' }] })),
      { ok: false, reasonCode: 'CLAIM_INVALID' },
      label(name),
    )
  }
  // Duplicate claim names would collide as question names.
  assert.deepEqual(
    buildJevVerifyRequest(
      verifyInput({
        claims: [
          { name: 'same', claim: 'one' },
          { name: 'same', claim: 'two' },
        ],
      }),
    ),
    { ok: false, reasonCode: 'CLAIM_INVALID' },
  )
  const benign = ['claim_a', 'noul-check', 'x9', 'A.b:c-d_e']
  for (const name of benign) {
    assert.ok(
      buildJevVerifyRequest(verifyInput({ claims: [{ name, claim: 'a bounded claim' }] })).ok,
      label(name),
    )
  }
}

function testVerifyClaimTextValidation(): void {
  const base = { name: 'claim_a' }
  assert.ok(
    buildJevVerifyRequest(verifyInput({ claims: [{ ...base, claim: 'x'.repeat(200) }] })).ok,
    'a 200-char claim is admitted',
  )
  assert.deepEqual(
    buildJevVerifyRequest(verifyInput({ claims: [{ ...base, claim: 'x'.repeat(201) }] })),
    { ok: false, reasonCode: 'CLAIM_INVALID' },
  )
  for (const claim of ['', '   ', 42, null, undefined, {}, ['a'], true]) {
    assert.deepEqual(
      buildJevVerifyRequest(verifyInput({ claims: [{ ...base, claim }] })),
      { ok: false, reasonCode: 'CLAIM_INVALID' },
      label(claim),
    )
  }
}

function testVerifyHostileClaimsRejected(): void {
  const hostile = [
    'the output matches /etc/passwd',
    'reads C:\\Users\\data',
    'see ~/notes.md for the goal',
    '../../escape',
    'password=hunter2',
    'API_KEY: sk-abcdefghijklmnopqrs',
    'the token = ghp_abcdefghijklmnopqrst',
    '-----BEGIN RSA PRIVATE KEY-----',
    'vault.key was rotated',
    'line one\nline two',
    'tab\tseparated',
  ]
  for (const claim of hostile) {
    assert.deepEqual(
      buildJevVerifyRequest(verifyInput({ claims: [{ name: 'claim_a', claim }] })),
      { ok: false, reasonCode: 'CLAIM_INVALID' },
      label(claim),
    )
  }
  const benign = [
    'handles secrets without echoing them',
    'no credential material appears in the output',
    'the parser module compiles without errors',
    'goal: ship the parser module',
  ]
  for (const claim of benign) {
    assert.ok(
      buildJevVerifyRequest(verifyInput({ claims: [{ name: 'claim_a', claim }] })).ok,
      label(claim),
    )
  }
}

function testVerifyEnvelope(): void {
  for (const [key, value] of [
    ['state', 'smuggled state text'],
    ['candidates', [{ id: 'c1' }]],
    ['questions', [{ type: 'predicate', name: 'q', instructions: 'i' }]],
    ['criteria', ['a']],
    ['delegateId', 'apollo'],
    ['unexpected', true],
  ]) {
    assert.deepEqual(
      buildJevVerifyRequest(verifyInput({ [key]: value })),
      { ok: false, reasonCode: 'VERIFY_INPUT_INVALID' },
      key,
    )
  }
  const partial = verifyInput()
  delete partial.claims
  assert.deepEqual(buildJevVerifyRequest(partial), {
    ok: false,
    reasonCode: 'VERIFY_INPUT_INVALID',
  })
  for (const input of [null, undefined, 'verify', 42]) {
    assert.deepEqual(buildJevVerifyRequest(input), {
      ok: false,
      reasonCode: 'VERIFY_INPUT_INVALID',
    })
  }
}

function testVerifyPreparerAttachesModel(): void {
  const prepared = prepareJevVerifyRequest(ROUTE, verifyInput())
  assert.ok(prepared.ok)
  if (!prepared.ok) return
  assert.deepEqual(prepared.request.model, { providerID: 'opencode', id: 'jev-1.13' })
  assert.deepEqual(Object.keys(prepared.request).sort(), ['input', 'model', 'questions'])
}

// ─── Verify consumption ──────────────────────────────────────────────────

function verifyRequest(): NativeDecisionRequest {
  const prepared = prepareJevVerifyRequest(ROUTE, verifyInput())
  assert.ok(prepared.ok)
  if (!prepared.ok) throw new Error('unreachable')
  return prepared.request
}

function testVerifyConsumeVerdicts(): void {
  // Threshold: >= 0.5 is PASS, below is FAIL.
  assert.deepEqual(
    consumeJevVerifyResult(
      {
        answers: [
          { type: 'predicate', name: 'claim_a', probability: 0.8 },
          { type: 'predicate', name: 'claim_b', probability: 0.3 },
        ],
      },
      verifyRequest(),
    ),
    { claim_a: 'PASS', claim_b: 'FAIL' },
  )
  // The boundary itself is PASS.
  assert.deepEqual(
    consumeJevVerifyResult(
      {
        answers: [
          { type: 'predicate', name: 'claim_a', probability: 0.5 },
          { type: 'predicate', name: 'claim_b', probability: 0.49999 },
        ],
      },
      verifyRequest(),
    ),
    { claim_a: 'PASS', claim_b: 'FAIL' },
  )
}

function testVerifyConsumeFailClosed(): void {
  // A host refusal answer (error type) is BLOCK, never a guess.
  assert.deepEqual(
    consumeJevVerifyResult(
      {
        answers: [
          { type: 'error', name: 'claim_a', reason: 'model_declined' },
          { type: 'predicate', name: 'claim_b', probability: 0.9 },
        ],
      },
      verifyRequest(),
    ),
    { claim_a: 'BLOCK', claim_b: 'PASS' },
  )
  // A missing answer (timeout, dropped reply) is BLOCK.
  assert.deepEqual(
    consumeJevVerifyResult(
      { answers: [{ type: 'predicate', name: 'claim_a', probability: 0.9 }] },
      verifyRequest(),
    ),
    { claim_a: 'PASS', claim_b: 'BLOCK' },
  )
  // Duplicate answers become errors in the shared consumer: BLOCK.
  assert.deepEqual(
    consumeJevVerifyResult(
      {
        answers: [
          { type: 'predicate', name: 'claim_a', probability: 0.9 },
          { type: 'predicate', name: 'claim_a', probability: 0.1 },
          { type: 'predicate', name: 'claim_b', probability: 0.9 },
        ],
      },
      verifyRequest(),
    ),
    { claim_a: 'BLOCK', claim_b: 'PASS' },
  )
  // A malformed probability (outside [0, 1]) is dropped by the strict
  // consumer and lands in missing: BLOCK.
  assert.deepEqual(
    consumeJevVerifyResult(
      {
        answers: [
          { type: 'predicate', name: 'claim_a', probability: 1.5 },
          { type: 'predicate', name: 'claim_b', probability: 'high' },
        ],
      },
      verifyRequest(),
    ),
    { claim_a: 'BLOCK', claim_b: 'BLOCK' },
  )
  // Every unusable response shape fails closed to BLOCK for every claim.
  for (const response of [null, undefined, 42, {}, { answers: [] }, { answers: 'no' }]) {
    assert.deepEqual(consumeJevVerifyResult(response, verifyRequest()), {
      claim_a: 'BLOCK',
      claim_b: 'BLOCK',
    })
  }
}

// ─── Tool round-trips (offline gate chain, sandboxed HOME) ───────────────

const CURRENT_PERIOD = new Date().toISOString().slice(0, 7)
const CAPS = { monthlyCapMicros: 5_000_000, perDecisionCapMicros: 1_000_000 }
const ONE_DECISION_CAP = { monthlyCapMicros: 1_000_000, perDecisionCapMicros: 1_000_000 }
const PROVIDER = 'opencode-console-jev'
const MODEL = DECISION_ROUTER_MODELS[PROVIDER][0] as string
const CLOUDFLARE_PROVIDER = 'cloudflare-workers-jev'
const CLOUDFLARE_MODEL = DECISION_ROUTER_MODELS[CLOUDFLARE_PROVIDER][0] as string

function hostReply(answers: readonly unknown[]): unknown {
  return Object.freeze({
    answers: Object.freeze([...answers]),
    cost: 0.000002,
    tokens: Object.freeze({ input: 12, output: 8 }),
  })
}

const RANK_REPLY = hostReply([
  { type: 'choice', name: 'winner', choice: 'parser_v1', confidence: 0.7 },
  { type: 'score', name: 'fit', score: 7, confidence: 0.8 },
])

const VERIFY_REPLY = hostReply([
  { type: 'predicate', name: 'claim_a', probability: 0.8 },
  { type: 'predicate', name: 'claim_b', probability: 0.3 },
])

interface Stub {
  runtime: V2JevDecisionRuntime
  decideCalls: NativeDecisionRequest[]
  permissionRequests: Record<string, unknown>[]
  records: Array<Record<string, unknown>>
}

function stubRuntime(
  overrides: Partial<V2JevDecisionRuntime> = {},
  response: unknown = RANK_REPLY,
): Stub {
  const decideCalls: NativeDecisionRequest[] = []
  const permissionRequests: Record<string, unknown>[] = []
  const records: Array<Record<string, unknown>> = []
  return {
    decideCalls,
    permissionRequests,
    records,
    runtime: {
      decide: async (request) => {
        decideCalls.push(request)
        return response
      },
      permissionAssert: async (request) => {
        permissionRequests.push(request)
        return undefined
      },
      shadowSink: (record) => {
        records.push(record as Record<string, unknown>)
      },
      ...overrides,
    },
  }
}

function sandbox(): { root: string; config: string; state: string } {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-jev-rank-verify-'))
  return { root, config: join(root, 'config'), state: join(root, 'state') }
}

async function withSandbox<T>(
  paths: { root: string; config: string },
  run: () => Promise<T>,
): Promise<T> {
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'] as const
  const previous = new Map<string, string | undefined>()
  for (const key of keys) previous.set(key, process.env[key])
  process.env.HOME = paths.root
  process.env.XDG_CONFIG_HOME = paths.config
  process.env.XDG_STATE_HOME = join(paths.root, 'state')
  try {
    return await run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(paths.root, { recursive: true, force: true })
  }
}

function writeEnabledConfig({ consent = true, enabled = true } = {}): void {
  writeUserDecisionRouterConfig({
    schema_version: 2,
    enabled,
    selection: { mode: 'explicit', provider: PROVIDER, model: MODEL },
    egress_consent: consent,
    enabled_candidates: [{ provider: PROVIDER, model: MODEL }],
  })
}

function confirmCaps(): void {
  const ledger = openLocalDecisionBudgetLedger({ dbPath: resolveLocalDecisionBudgetDbPath() })
  try {
    ledger.configureUserCaps(CAPS)
    ledger.configureProviderCaps('opencode-console', CAPS)
    ledger.configureModelCaps('opencode-console', MODEL, CAPS)
    // Admission requires a confirmed UTC period; without it every reservation
    // is denied and no rank or verify reaches the host call.
    if (ledger.confirmBudgetPeriod(null, CURRENT_PERIOD).status !== 'confirmed') {
      throw new Error('the rank/verify sandbox could not confirm the budget period')
    }
  } finally {
    ledger.close()
  }
}

function writeCloudflareEnabledConfig(): void {
  writeUserDecisionRouterConfig({
    schema_version: 2,
    enabled: true,
    selection: { mode: 'explicit', provider: CLOUDFLARE_PROVIDER, model: CLOUDFLARE_MODEL },
    egress_consent: true,
    enabled_candidates: [{ provider: CLOUDFLARE_PROVIDER, model: CLOUDFLARE_MODEL }],
  })
}

function confirmCloudflareCaps(): void {
  const ledger = openLocalDecisionBudgetLedger({ dbPath: resolveLocalDecisionBudgetDbPath() })
  try {
    ledger.configureUserCaps(ONE_DECISION_CAP)
    ledger.configureProviderCaps('cloudflare-workers-ai', ONE_DECISION_CAP)
    ledger.configureModelCaps('cloudflare-workers-ai', CLOUDFLARE_MODEL, ONE_DECISION_CAP)
    if (ledger.confirmBudgetPeriod(null, CURRENT_PERIOD).status !== 'confirmed') {
      throw new Error('the Cloudflare sandbox could not confirm the budget period')
    }
  } finally {
    ledger.close()
  }
}

function zeusContext(): Record<string, unknown> {
  return { sessionID: 'ses_rv', messageID: 'msg_rv', agent: 'zeus' }
}

function parseToolOutput(output: string): Record<string, unknown> {
  return JSON.parse(output) as Record<string, unknown>
}

async function testToolRankRoundTrip(): Promise<void> {
  const paths = sandbox()
  await withSandbox(paths, async () => {
    writeEnabledConfig()
    confirmCaps()
    const stub = stubRuntime({}, RANK_REPLY)
    const output = parseToolOutput(await runJevDecision(rankInput(), zeusContext(), stub.runtime))
    assert.equal(output.advisory, true)
    assert.equal(output.effect, 'none')
    assert.equal(output.reason, 'JEV_DECISION')
    assert.equal(output.mode, 'rank')
    assert.equal(output.caller, 'zeus')
    assert.equal(output.winner, 'parser_v1')
    assert.equal(output.winnerFit, 7)
    assert.deepEqual(output.missing, [])
    assert.equal(output.frozen, false, 'usage reconciled below the caps')
    assert.equal(stub.decideCalls.length, 1, 'exactly ONE decide call: one round-trip')
    assert.equal(stub.permissionRequests.length, 1, 'the permission kill-switch was asked')
    // Rank and verify are tool modes, not shadow gates: NO telemetry records.
    assert.equal(stub.records.length, 0, 'no new telemetry points')
    // The wire request keeps its bounded shape: state verbatim, candidates as
    // choice values, model attached — no extra slots.
    const request = stub.decideCalls[0] as unknown as Record<string, unknown>
    assert.deepEqual(Object.keys(request).sort(), ['input', 'model', 'questions'])
    assert.deepEqual(stub.permissionRequests[0]?.agent, 'zeus')
  })
}

async function testToolRankInputRefusal(): Promise<void> {
  const paths = sandbox()
  await withSandbox(paths, async () => {
    writeEnabledConfig()
    confirmCaps()
    // Malformed rank input refuses BEFORE any gate work, with the precise token.
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        ((partial) => {
          delete partial.candidates
          return partial
        })(rankInput()),
        'RANK_INPUT_INVALID',
      ],
      [rankInput({ candidates: [{ id: 'only-one' }] }), 'CANDIDATE_INVALID'],
      [rankInput({ candidates: [{ id: '../escape' }, { id: 'ok' }] }), 'CANDIDATE_INVALID'],
      [rankInput({ state: '' }), 'STATE_INVALID'],
    ]
    for (const [input, reasonCode] of cases) {
      const stub = stubRuntime()
      const output = parseToolOutput(await runJevDecision(input, zeusContext(), stub.runtime))
      assert.deepEqual(output, { advisory: false, effect: 'none', reasonCode })
      assert.equal(stub.decideCalls.length, 0, 'no host call for a malformed rank')
      assert.equal(stub.permissionRequests.length, 0, 'no permission asked for a malformed rank')
      assert.equal(stub.records.length, 0, 'no telemetry for a malformed rank')
    }
  })
}

async function testToolRankGateRefusalContract(): Promise<void> {
  const paths = sandbox()
  await withSandbox(paths, async () => {
    // Config disabled: the standard bounded refusal, unchanged.
    writeEnabledConfig({ enabled: false })
    const disabled = stubRuntime()
    const output = parseToolOutput(
      await runJevDecision(rankInput(), zeusContext(), disabled.runtime),
    )
    assert.deepEqual(output, { advisory: false, effect: 'none', reasonCode: 'DISABLED' })
    assert.equal(disabled.decideCalls.length, 0)
    assert.equal(disabled.records.length, 0, 'no new telemetry points on refusals')

    // The host call throwing: refusal carries the sanitized error CLASS only.
    writeEnabledConfig()
    confirmCaps()
    let decideAttempts = 0
    const throwing = stubRuntime({
      decide: async () => {
        decideAttempts += 1
        throw new RangeError('route unavailable: /v1/decisions jev-1.13')
      },
    })
    const thrown = parseToolOutput(
      await runJevDecision(rankInput(), zeusContext(), throwing.runtime),
    )
    assert.deepEqual(thrown, {
      advisory: false,
      effect: 'none',
      reasonCode: 'DECISION_CALL_FAILED',
      detail: 'RangeError',
    })
    assert.equal(decideAttempts, 1, 'exactly one attempt: never retried')

    // Unreconciled usage fails closed.
    const unreconciled = stubRuntime({}, { answers: [], cost: 0 })
    assert.deepEqual(
      parseToolOutput(await runJevDecision(rankInput(), zeusContext(), unreconciled.runtime)),
      { advisory: false, effect: 'none', reasonCode: 'USAGE_UNRECONCILED' },
    )
  })
}

async function testCloudflareUsageEvidenceFailsClosedBeforeEgress(): Promise<void> {
  const paths = sandbox()
  await withSandbox(paths, async () => {
    writeCloudflareEnabledConfig()
    confirmCloudflareCaps()
    const stub = stubRuntime()
    assert.deepEqual(
      parseToolOutput(await runJevDecision(rankInput(), zeusContext(), stub.runtime)),
      { advisory: false, effect: 'none', reasonCode: 'USAGE_EVIDENCE_UNAVAILABLE' },
    )
    assert.equal(stub.decideCalls.length, 0, 'Cloudflare provider is never called')
    assert.equal(stub.permissionRequests.length, 0, 'no egress permission is requested')

    const ledger = openLocalDecisionBudgetLedger({ dbPath: resolveLocalDecisionBudgetDbPath() })
    try {
      assert.deepEqual(ledger.listUncertainReservations(), [], 'the rejected call reserved nothing')
      assert.equal(
        ledger.reserve('cloudflare-workers-ai', CLOUDFLARE_MODEL).status,
        'reserved',
        'the rejected call did not consume the only available decision reservation',
      )
    } finally {
      ledger.close()
    }
  })
}

async function testToolVerifyRoundTrip(): Promise<void> {
  const paths = sandbox()
  await withSandbox(paths, async () => {
    writeEnabledConfig()
    confirmCaps()
    const stub = stubRuntime({}, VERIFY_REPLY)
    const output = parseToolOutput(await runJevDecision(verifyInput(), zeusContext(), stub.runtime))
    assert.equal(output.advisory, true)
    assert.equal(output.effect, 'none')
    assert.equal(output.reason, 'JEV_DECISION')
    assert.equal(output.mode, 'verify')
    assert.equal(output.caller, 'zeus')
    assert.deepEqual(output.results, { claim_a: 'PASS', claim_b: 'FAIL' })
    assert.deepEqual(output.missing, [])
    assert.equal(output.frozen, false)
    assert.equal(stub.decideCalls.length, 1, 'exactly ONE decide call: one round-trip')
    assert.equal(stub.permissionRequests.length, 1, 'the permission kill-switch was asked')
    assert.equal(stub.records.length, 0, 'no new telemetry points')
    // The claims ride the question instructions and nowhere else.
    const decideJson = JSON.stringify(stub.decideCalls[0])
    const claimText = 'the parser module compiles without errors'
    assert.equal(decideJson.includes(claimText), true, 'the claim is the verify payload')
    assert.equal(
      decideJson.split(claimText).length - 1,
      1,
      'the claim appears exactly once (its question instructions)',
    )
    const request = stub.decideCalls[0] as unknown as Record<string, unknown>
    assert.deepEqual(Object.keys(request).sort(), ['input', 'model', 'questions'])
    const inputText = JSON.stringify(request.input)
    assert.equal(inputText.includes(claimText), false, 'no claim text in the state part')
  })
}

async function testToolVerifyFailClosed(): Promise<void> {
  const paths = sandbox()
  await withSandbox(paths, async () => {
    writeEnabledConfig()
    confirmCaps()
    // Host refusal answers and missing answers are BLOCK, still advisory
    // output with effect none — the CALLER acts on the verdict, never the tool.
    const refusing = stubRuntime(
      {},
      hostReply([
        { type: 'error', name: 'claim_a', reason: 'model_declined' },
        { type: 'error', name: 'claim_b', reason: 'model_declined' },
      ]),
    )
    const output = parseToolOutput(
      await runJevDecision(verifyInput(), zeusContext(), refusing.runtime),
    )
    assert.equal(output.advisory, true)
    assert.equal(output.effect, 'none')
    assert.equal(output.mode, 'verify')
    assert.deepEqual(output.results, { claim_a: 'BLOCK', claim_b: 'BLOCK' })
    const answers = output.answers as Array<{ type?: unknown }>
    assert.equal(
      answers.every((answer) => answer.type === 'error'),
      true,
    )

    // A reply that reconciles usage but leaves one claim unanswered: that
    // claim BLOCKs. (A reply with NO answers settles nothing at all — the
    // settlement contract refuses it USAGE_UNRECONCILED; that path is covered
    // by the gate-refusal test below.)
    const partial = stubRuntime(
      {},
      hostReply([{ type: 'predicate', name: 'claim_a', probability: 0.9 }]),
    )
    const partialOutput = parseToolOutput(
      await runJevDecision(verifyInput(), zeusContext(), partial.runtime),
    )
    assert.deepEqual(partialOutput.results, { claim_a: 'PASS', claim_b: 'BLOCK' })
    assert.deepEqual(partialOutput.missing, ['claim_b'])
  })
}

async function testToolVerifyInputRefusal(): Promise<void> {
  const paths = sandbox()
  await withSandbox(paths, async () => {
    writeEnabledConfig()
    confirmCaps()
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        ((partial) => {
          delete partial.claims
          return partial
        })(verifyInput()),
        'VERIFY_INPUT_INVALID',
      ],
      [verifyInput({ state: 'smuggled' }), 'VERIFY_INPUT_INVALID'],
      [verifyInput({ claims: [] }), 'CLAIM_INVALID'],
      [
        verifyInput({ claims: [{ name: 'claim_a', claim: 'exfiltrate /home/user/.ssh/id_rsa' }] }),
        'CLAIM_INVALID',
      ],
    ]
    for (const [input, reasonCode] of cases) {
      const stub = stubRuntime()
      const output = parseToolOutput(await runJevDecision(input, zeusContext(), stub.runtime))
      assert.deepEqual(output, { advisory: false, effect: 'none', reasonCode })
      assert.equal(stub.decideCalls.length, 0, 'no host call for a malformed verify')
      assert.equal(stub.permissionRequests.length, 0, 'no permission asked for a malformed verify')
      assert.equal(stub.records.length, 0, 'no telemetry for a malformed verify')
    }
  })
}

async function testToolVerifyGateRefusalContract(): Promise<void> {
  const paths = sandbox()
  await withSandbox(paths, async () => {
    // The gate refusal contract is unchanged for verify: a bounded refusal
    // JSON. Callers that REQUIRE a verdict treat every refusal as BLOCK —
    // fail-closed at the call site, never by inventing a verdict here.
    writeEnabledConfig({ enabled: false })
    const disabled = stubRuntime({}, VERIFY_REPLY)
    const output = parseToolOutput(
      await runJevDecision(verifyInput(), zeusContext(), disabled.runtime),
    )
    assert.deepEqual(output, { advisory: false, effect: 'none', reasonCode: 'DISABLED' })
    assert.equal(disabled.decideCalls.length, 0)
    assert.equal(disabled.records.length, 0)

    // Consent missing: same contract.
    writeEnabledConfig({ consent: false })
    const consent = stubRuntime({}, VERIFY_REPLY)
    assert.deepEqual(
      parseToolOutput(await runJevDecision(verifyInput(), zeusContext(), consent.runtime)),
      { advisory: false, effect: 'none', reasonCode: 'CONSENT_MISSING' },
    )
  })
}

async function testToolModesAreZeusOnly(): Promise<void> {
  const paths = sandbox()
  await withSandbox(paths, async () => {
    writeEnabledConfig()
    confirmCaps()
    // Rank and verify are modes: orchestrator-owned like every preset mode.
    const rankStub = stubRuntime()
    const rankDenied = parseToolOutput(
      await runJevDecision(rankInput(), { ...zeusContext(), agent: 'apollo' }, rankStub.runtime),
    )
    assert.deepEqual(rankDenied, {
      advisory: false,
      effect: 'none',
      reasonCode: 'CALLER_NOT_ALLOWED',
    })
    assert.equal(rankStub.decideCalls.length, 0, 'a non-Zeus caller never spends the gate chain')

    const verifyStub = stubRuntime({}, VERIFY_REPLY)
    const verifyDenied = parseToolOutput(
      await runJevDecision(
        verifyInput(),
        { ...zeusContext(), agent: 'apollo' },
        verifyStub.runtime,
      ),
    )
    assert.deepEqual(verifyDenied, {
      advisory: false,
      effect: 'none',
      reasonCode: 'CALLER_NOT_ALLOWED',
    })
    assert.equal(verifyStub.decideCalls.length, 0)
  })
}

// ─── Schema contract ─────────────────────────────────────────────────────

function testSchemaDeclaresRankAndVerify(): void {
  const definition = createV2JevDecisionDefinition(stubRuntime().runtime)
  const schema = definition.input as {
    properties?: Record<string, unknown>
    anyOf?: Array<{ required?: string[] }>
  }
  const mode = schema.properties?.mode as { enum?: string[] } | undefined
  assert.ok(mode, 'the mode property is declared')
  assert.deepEqual(
    mode.enum,
    ['skills', 'delegation', 'review', 'rank', 'verify'],
    'the mode enum gains rank and verify',
  )
  const branches = (schema.anyOf ?? []).map((branch) => branch.required ?? [])
  const rankBranch = branches.find((required) => required.includes('candidates'))
  const verifyBranch = branches.find((required) => required.includes('claims'))
  assert.ok(rankBranch, 'a rank branch is declared')
  assert.ok(verifyBranch, 'a verify branch is declared')
  assert.deepEqual(rankBranch, ['candidates'])
  assert.deepEqual(verifyBranch, ['claims'])

  const candidates = schema.properties?.candidates as {
    minItems?: number
    maxItems?: number
    items?: { required?: string[]; properties?: Record<string, unknown> }
  }
  assert.ok(candidates, 'the candidates property is declared')
  assert.equal(candidates.minItems, RANK_MIN_CANDIDATES)
  assert.equal(candidates.maxItems, RANK_MAX_CANDIDATES)
  assert.deepEqual(candidates.items?.required, ['id'])

  const claims = schema.properties?.claims as {
    minItems?: number
    maxItems?: number
    items?: { required?: string[]; properties?: Record<string, unknown> }
  }
  assert.ok(claims, 'the claims property is declared')
  assert.equal(claims.minItems, VERIFY_MIN_CLAIMS)
  assert.equal(claims.maxItems, VERIFY_MAX_CLAIMS)
  assert.deepEqual(claims.items?.required, ['name', 'claim'])
}

// ─── Runner ──────────────────────────────────────────────────────────────

check('constants: bounds, question names, fit rubric, threshold, claim length', testConstants)
check(
  'rank builder: bounded shape (state verbatim + ONE choice + ONE score)',
  testRankBuildBoundedShape,
)
check('rank builder: candidate count bounds and type strictness', testRankCandidateBounds)
check(
  'rank builder: candidate ids are bounded unique tokens, hostile shapes rejected',
  testRankCandidateIdValidation,
)
check(
  'rank builder: hostile candidate descriptions rejected, benign prose admitted',
  testRankHostileDescriptionsRejected,
)
check('rank builder: description bound and type strictness', testRankDescriptionBound)
check('rank builder: state is bounded non-blank or STATE_INVALID', testRankStateValidation)
check('rank builder: envelope rejects smuggled slots and garbage input', testRankEnvelope)
check(
  'rank preparer: attaches the resolved route model (preset contract)',
  testRankPreparerAttachesModel,
)
check('rank consumer: valid answers yield winner and winnerFit', testRankConsumeValid)
check('rank consumer: malformed, missing, duplicate answers yield nulls', testRankConsumeMalformed)
check(
  'verify builder: one predicate question per claim, claim rides instructions only',
  testVerifyBuildBoundedShape,
)
check('verify builder: claim count bounds and type strictness', testVerifyClaimBounds)
check(
  'verify builder: claim names are bounded unique tokens, hostile shapes rejected',
  testVerifyClaimNameValidation,
)
check('verify builder: claim text bound and type strictness', testVerifyClaimTextValidation)
check(
  'verify builder: hostile claims rejected CLAIM_INVALID, benign prose admitted',
  testVerifyHostileClaimsRejected,
)
check('verify builder: envelope rejects smuggled slots and garbage input', testVerifyEnvelope)
check(
  'verify preparer: attaches the resolved route model (preset contract)',
  testVerifyPreparerAttachesModel,
)
check('verify consumer: threshold mapping (>= 0.5 PASS, below FAIL)', testVerifyConsumeVerdicts)
check(
  'verify consumer: error, missing, duplicate, malformed all BLOCK',
  testVerifyConsumeFailClosed,
)
await checkAsync(
  'tool: rank round-trip (one call, no telemetry, bounded wire request)',
  testToolRankRoundTrip,
)
await checkAsync(
  'tool: malformed rank input refuses before any gate work',
  testToolRankInputRefusal,
)
await checkAsync(
  'tool: rank gate refusals keep the standard refusal contract',
  testToolRankGateRefusalContract,
)
await checkAsync(
  'Cloudflare: usage evidence unavailable refuses before permission, provider call, or reservation',
  testCloudflareUsageEvidenceFailsClosedBeforeEgress,
)
await checkAsync(
  'tool: verify round-trip (one call, results map, claims in instructions only)',
  testToolVerifyRoundTrip,
)
await checkAsync(
  'tool: verify fail-closed BLOCK on refusals and missing answers',
  testToolVerifyFailClosed,
)
await checkAsync(
  'tool: malformed verify input refuses before any gate work',
  testToolVerifyInputRefusal,
)
await checkAsync(
  'tool: verify gate refusals keep the standard refusal contract',
  testToolVerifyGateRefusalContract,
)
await checkAsync('tool: rank and verify are orchestrator-owned modes', testToolModesAreZeusOnly)
check(
  'schema contract: rank and verify declared with disjoint payloads',
  testSchemaDeclaresRankAndVerify,
)

console.log(`Jev rank + verify: ${checks} checks passed`)
