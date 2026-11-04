/**
 * The v3.1 rank and verify primitives on the native Jev route (tool modes on
 * `pantheon_jev_decide`, built after the J4 review-mode pattern).
 *
 * ## Rank — `mode: "rank"`, one choice + one score, `{ winner, winnerFit }`
 *
 * Zeus can rank 2–8 named candidates for a state in ONE typed round-trip: one
 * `choice` question (`winner`) over the candidate ids picks the best candidate
 * and one `score` question (`fit`, the 2..10 rubric bound) rates that
 * candidate's fit. THE HONEST LIMITATION: the host Decisions API returns one
 * scalar answer per question (`NativeDecisionRequest` is tied to the 2.2.5
 * host types), so per-candidate scores are not expressible in a single
 * round-trip — one score question per candidate would break the 4-question
 * bound above four candidates, and one ambiguous "score each candidate"
 * question has no per-candidate answer structure to pair back. Rank therefore
 * returns `{ winner, winnerFit }` and NOTHING more: no runner-up, no full
 * ordering. A caller that needs a deeper order uses the explicit-questions
 * mode with its own typed questions.
 *
 * ## Verify — `mode: "verify"`, one predicate per claim, fail-closed BLOCK
 *
 * Zeus can check 1–4 named claims in ONE typed round-trip: one `predicate`
 * question per claim (within the 4-question bound), the claim text riding that
 * question's instructions. The consumer maps each answer: probability
 * ≥ {@link VERIFY_PASS_THRESHOLD} → `PASS`, below → `FAIL`, and every refusal,
 * timeout, duplicate or malformed answer → `BLOCK` (fail-closed: an
 * unanswered mandatory claim must never read as verified). The tool itself
 * never acts on a verdict — `effect` stays `none` — and a gate-chain refusal
 * stays the standard bounded refusal JSON; a caller that REQUIRES a verdict
 * treats every refusal as `BLOCK` at its own call site.
 *
 * ## Sanitization contract (the J4 criteria class)
 *
 * Both modes take bounded caller-provided fields only: rank's candidate ids
 * are strict tokens (they become choice values), its state rides the same
 * 12,000-char bound and verbatim-carriage rule as the presets, and verify's
 * claim texts are the only free text, riding the predicate instructions. The
 * hostility scan mirrors the J4 criteria scan (paths, credential assignments,
 * key material, control characters, over-length): hostile shapes are REJECTED
 * — `CANDIDATE_INVALID` / `CLAIM_INVALID` — never sanitized on the way in.
 * Neither mode has a telemetry point (they are tool modes, not shadow gates)
 * and both reuse the tool's strict answer consumer
 * (`consumeJevDecisionResult`): one answer per question name, duplicates
 * become errors, unbounded host metadata never crosses.
 *
 * @module jev-rank-verify
 */

import { consumeJevDecisionResult } from './jev-decisions.ts'
import type { NativeDecisionRequest, ResolvedNativeDecisionRoute } from './v2-native-decisions.ts'
import { NATIVE_DECISION_MAX_PROMPT_LENGTH } from './v2-native-decisions.ts'

// ─── Bounds ──────────────────────────────────────────────────────────────

/** A ranking needs at least two candidates to choose between. */
export const RANK_MIN_CANDIDATES = 2
/** Above eight, ranking degrades to explicit questions with a real rubric. */
export const RANK_MAX_CANDIDATES = 8

/** Question name of the rank's choice question. */
export const RANK_WINNER_QUESTION_NAME = 'winner'
/** Question name of the rank's fit score question. */
export const RANK_FIT_QUESTION_NAME = 'fit'

/** The fit rubric mirrors the documented 2..10 score-question bound. */
export const RANK_FIT_LEVEL_COUNT = 9

/** At least one claim per verify call; one predicate question per claim. */
export const VERIFY_MIN_CLAIMS = 1
/** One predicate question per claim, within the 4-question bound. */
export const VERIFY_MAX_CLAIMS = 4
/** Each claim is a bounded 1–200-char instruction string. */
export const CLAIM_MAX_LENGTH = 200

/** Predicate probability at or above which a claim counts as PASS. */
export const VERIFY_PASS_THRESHOLD = 0.5

const CANDIDATE_ID_MAX_LENGTH = 64
const CLAIM_NAME_MAX_LENGTH = 64
const DESCRIPTION_MAX_LENGTH = 500

/** Candidate ids become choice values: strict bounded tokens only. */
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

const RANK_FIT_LABELS: readonly string[] = Object.freeze([
  'unusable',
  'poor',
  'weak',
  'fair',
  'adequate',
  'good',
  'strong',
  'excellent',
  'exemplary',
])

const WINNER_INSTRUCTIONS =
  'Choose the single best candidate from the listed options for the described state. ' +
  'Answer with exactly one candidate id. Advisory only; nothing is dispatched or executed.'

const FIT_INSTRUCTIONS =
  'Rate how well the candidate you chose as the best fits the described state. ' +
  'Higher means a better fit; judge from the state and the candidate descriptions alone. ' +
  'Advisory only; nothing is enforced.'

/**
 * The verify request's only input part: a fixed template with NO free-text
 * slot — the claims ride the predicate questions' instructions, so the state
 * part cannot carry them twice (or be mistaken for a content field).
 */
const VERIFY_STATE_TEMPLATE =
  'Advisory claim verification. Each claim is stated in its own question below; ' +
  'assess each claim on its own terms from the claim text alone. Nothing is enforced.'

// ─── Hostility scan (mirrors the J4 criteria scan) ───────────────────────

/** Path separators in any position: caller prose is never a location. */
const PATH_PATTERN = /[/\\]/

/**
 * Control characters (C0 and DEL — newlines and tabs included): these are
 * single-line prose fields. An explicit code-point scan, not a regex, so the
 * hostile-input check stays lint-clean without a rule suppression.
 */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/** Key material shapes: PEM headers, AWS/SDK/Git token literals, key files. */
const KEY_MATERIAL_PATTERNS: readonly RegExp[] = Object.freeze([
  /-----BEGIN/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\b[a-z0-9._-]+\.(?:key|pem|p12|pfx|kdbx)\b/i,
])

/**
 * Credential ASSIGNMENT shapes only: naming a concept is prose ("handles
 * secrets without echoing them" stays admissible); binding a value to it
 * ("password=hunter2") is a credential shape and is rejected.
 */
const CREDENTIAL_ASSIGNMENT_PATTERN =
  /\b(?:password|passwd|secret|token|api[-_]?key|credential)s?\s*[:=]\s*\S+/i

function isHostileProse(value: string): boolean {
  if (PATH_PATTERN.test(value)) return true
  if (hasControlCharacter(value)) return true
  if (KEY_MATERIAL_PATTERNS.some((pattern) => pattern.test(value))) return true
  return CREDENTIAL_ASSIGNMENT_PATTERN.test(value)
}

function isBoundedNonBlankString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ─── Rank: request building ──────────────────────────────────────────────

const RANK_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'mode',
  'state',
  'candidates',
])

export type JevRankBuildFailure = 'RANK_INPUT_INVALID' | 'CANDIDATE_INVALID' | 'STATE_INVALID'

export type JevRankBuild =
  | { readonly ok: true; readonly request: Omit<NativeDecisionRequest, 'model'> }
  | { readonly ok: false; readonly reasonCode: JevRankBuildFailure }

export type JevRankPreparation =
  | { readonly ok: true; readonly request: NativeDecisionRequest }
  | { readonly ok: false; readonly reasonCode: JevRankBuildFailure }

/**
 * Validate the rank tool input and build the model-less request. The state is
 * carried verbatim under the same bound and rule as the presets; the
 * candidates ride the winner question's choice values (ids, strict tokens)
 * and choice descriptions (bounded prose, hostility-scanned). Unknown
 * envelope keys — `questions`, review fields, anything else — refuse the
 * preparation: no second payload slot exists.
 */
export function buildJevRankRequest(input: unknown): JevRankBuild {
  if (!isRecord(input)) return { ok: false, reasonCode: 'RANK_INPUT_INVALID' }
  for (const key of Object.keys(input)) {
    if (!RANK_ENVELOPE_KEYS.has(key)) return { ok: false, reasonCode: 'RANK_INPUT_INVALID' }
  }
  const state = input.state
  if (!isBoundedNonBlankString(state, NATIVE_DECISION_MAX_PROMPT_LENGTH)) {
    return { ok: false, reasonCode: 'STATE_INVALID' }
  }
  const rawCandidates = input.candidates
  // A MISSING candidates field is a malformed rank; a PRESENT-but-hostile
  // candidates array keeps its precise CANDIDATE_INVALID (the review-mode
  // discipline).
  if (rawCandidates === undefined) return { ok: false, reasonCode: 'RANK_INPUT_INVALID' }
  if (!Array.isArray(rawCandidates)) return { ok: false, reasonCode: 'CANDIDATE_INVALID' }
  if (rawCandidates.length < RANK_MIN_CANDIDATES || rawCandidates.length > RANK_MAX_CANDIDATES) {
    return { ok: false, reasonCode: 'CANDIDATE_INVALID' }
  }
  const seen = new Set<string>()
  const choices: Array<{ value: string; description?: string }> = []
  for (const raw of rawCandidates) {
    if (!isRecord(raw)) return { ok: false, reasonCode: 'CANDIDATE_INVALID' }
    const extraKeys = Object.keys(raw).filter((key) => key !== 'id' && key !== 'description')
    if (extraKeys.length > 0) return { ok: false, reasonCode: 'CANDIDATE_INVALID' }
    const id = raw.id
    if (
      typeof id !== 'string' ||
      id.length > CANDIDATE_ID_MAX_LENGTH ||
      !TOKEN_PATTERN.test(id) ||
      seen.has(id)
    ) {
      return { ok: false, reasonCode: 'CANDIDATE_INVALID' }
    }
    seen.add(id)
    const description = raw.description
    if (description === undefined) {
      choices.push({ value: id })
    } else if (
      isBoundedNonBlankString(description, DESCRIPTION_MAX_LENGTH) &&
      !isHostileProse(description)
    ) {
      choices.push({ value: id, description })
    } else {
      return { ok: false, reasonCode: 'CANDIDATE_INVALID' }
    }
  }
  const request = {
    input: Object.freeze([Object.freeze({ type: 'text' as const, text: state })]),
    questions: Object.freeze([
      Object.freeze({
        type: 'choice' as const,
        name: RANK_WINNER_QUESTION_NAME,
        instructions: WINNER_INSTRUCTIONS,
        choices: Object.freeze(choices.map((choice) => Object.freeze(choice))),
      }),
      Object.freeze({
        type: 'score' as const,
        name: RANK_FIT_QUESTION_NAME,
        instructions: FIT_INSTRUCTIONS,
        levels: Object.freeze(RANK_FIT_LABELS.map((label) => Object.freeze({ label }))),
      }),
    ]),
  } satisfies Omit<NativeDecisionRequest, 'model'>
  return { ok: true, request: Object.freeze(request) }
}

/** `prepareJevPresetRequest` contract: route plus tool input in, request out. */
export function prepareJevRankRequest(
  route: ResolvedNativeDecisionRoute,
  input: unknown,
): JevRankPreparation {
  const built = buildJevRankRequest(input)
  if (!built.ok) return built
  return {
    ok: true,
    request: {
      model: route.model,
      input: built.request.input,
      questions: built.request.questions,
    },
  }
}

// ─── Verify: request building ────────────────────────────────────────────

const VERIFY_ENVELOPE_KEYS: ReadonlySet<string> = new Set(['schemaVersion', 'mode', 'claims'])

export type JevVerifyBuildFailure = 'VERIFY_INPUT_INVALID' | 'CLAIM_INVALID'

export type JevVerifyBuild =
  | { readonly ok: true; readonly request: Omit<NativeDecisionRequest, 'model'> }
  | { readonly ok: false; readonly reasonCode: JevVerifyBuildFailure }

export type JevVerifyPreparation =
  | { readonly ok: true; readonly request: NativeDecisionRequest }
  | { readonly ok: false; readonly reasonCode: JevVerifyBuildFailure }

function verifyInstructions(claim: string): string {
  return (
    'Assess the following claim on its own terms and answer the probability that it holds. ' +
    `Claim: "${claim}". Higher means the claim is more likely to hold. ` +
    'This is advisory verification; nothing is enforced.'
  )
}

/**
 * Validate the verify tool input and build the model-less request: one
 * predicate question per claim, named after the claim, the claim text riding
 * that question's instructions. The verify mode takes NO state text — any
 * smuggled slot (`state`, `candidates`, review fields) refuses the
 * preparation `VERIFY_INPUT_INVALID`; hostile claim shapes keep the precise
 * `CLAIM_INVALID`.
 */
export function buildJevVerifyRequest(input: unknown): JevVerifyBuild {
  if (!isRecord(input)) return { ok: false, reasonCode: 'VERIFY_INPUT_INVALID' }
  for (const key of Object.keys(input)) {
    if (!VERIFY_ENVELOPE_KEYS.has(key)) return { ok: false, reasonCode: 'VERIFY_INPUT_INVALID' }
  }
  const rawClaims = input.claims
  if (rawClaims === undefined) return { ok: false, reasonCode: 'VERIFY_INPUT_INVALID' }
  if (!Array.isArray(rawClaims)) return { ok: false, reasonCode: 'CLAIM_INVALID' }
  if (rawClaims.length < VERIFY_MIN_CLAIMS || rawClaims.length > VERIFY_MAX_CLAIMS) {
    return { ok: false, reasonCode: 'CLAIM_INVALID' }
  }
  const seen = new Set<string>()
  const questions: Array<{
    type: 'predicate'
    name: string
    instructions: string
  }> = []
  for (const raw of rawClaims) {
    if (!isRecord(raw)) return { ok: false, reasonCode: 'CLAIM_INVALID' }
    const extraKeys = Object.keys(raw).filter((key) => key !== 'name' && key !== 'claim')
    if (extraKeys.length > 0) return { ok: false, reasonCode: 'CLAIM_INVALID' }
    const name = raw.name
    if (
      typeof name !== 'string' ||
      name.length > CLAIM_NAME_MAX_LENGTH ||
      !TOKEN_PATTERN.test(name) ||
      seen.has(name)
    ) {
      return { ok: false, reasonCode: 'CLAIM_INVALID' }
    }
    const claim = raw.claim
    if (!isBoundedNonBlankString(claim, CLAIM_MAX_LENGTH) || isHostileProse(claim)) {
      return { ok: false, reasonCode: 'CLAIM_INVALID' }
    }
    seen.add(name)
    questions.push({ type: 'predicate', name, instructions: verifyInstructions(claim) })
  }
  const request = {
    input: Object.freeze([Object.freeze({ type: 'text' as const, text: VERIFY_STATE_TEMPLATE })]),
    questions: Object.freeze(questions.map((question) => Object.freeze(question))),
  } satisfies Omit<NativeDecisionRequest, 'model'>
  return { ok: true, request: Object.freeze(request) }
}

/** `prepareJevPresetRequest` contract: route plus tool input in, request out. */
export function prepareJevVerifyRequest(
  route: ResolvedNativeDecisionRoute,
  input: unknown,
): JevVerifyPreparation {
  const built = buildJevVerifyRequest(input)
  if (!built.ok) return built
  return {
    ok: true,
    request: {
      model: route.model,
      input: built.request.input,
      questions: built.request.questions,
    },
  }
}

// ─── Consumption ─────────────────────────────────────────────────────────

export interface JevRankVerdict {
  /**
   * The host's chosen candidate id; `null` when the answer is missing,
   * mistyped, duplicated, an error, or outside the prepared candidate ids.
   */
  readonly winner: string | null
  /**
   * The host's fit score for the winner, on the prepared 2..10 rubric;
   * `null` under the same failures.
   */
  readonly winnerFit: number | null
}

/**
 * Consume a host Decisions response against the prepared rank request.
 * Strict validation is borrowed wholesale from the tool's consumer
 * (`consumeJevDecisionResult`): an answer counts only when its name and type
 * match the prepared questions, duplicates become errors, and anything else
 * is `null`, never a guess.
 */
export function consumeJevRankResult(
  response: unknown,
  request: NativeDecisionRequest,
): JevRankVerdict {
  const advice = consumeJevDecisionResult(response, request)
  let winner: string | null = null
  let winnerFit: number | null = null
  for (const answer of advice.answers) {
    if (answer.type === 'error') continue
    if (answer.type === 'choice' && answer.name === RANK_WINNER_QUESTION_NAME) {
      winner = answer.choice ?? null
    } else if (answer.type === 'score' && answer.name === RANK_FIT_QUESTION_NAME) {
      winnerFit = answer.score ?? null
    }
  }
  return Object.freeze({ winner, winnerFit })
}

/**
 * The verdict of one verified claim. `BLOCK` is the fail-closed answer: a
 * host refusal, timeout, duplicate or malformed reply must never read as
 * verified (or as refuted — an unverifiable claim is unverifiable, not
 * false).
 */
export type VerifyClaimVerdict = 'PASS' | 'FAIL' | 'BLOCK'

/**
 * Consume a host Decisions response against the prepared verify request:
 * one verdict per claim name. Probability ≥ {@link VERIFY_PASS_THRESHOLD} is
 * `PASS`, below is `FAIL`; error answers, missing answers and any unusable
 * response shape are `BLOCK` — fail-closed.
 */
export function consumeJevVerifyResult(
  response: unknown,
  request: NativeDecisionRequest,
): Readonly<Record<string, VerifyClaimVerdict>> {
  const advice = consumeJevDecisionResult(response, request)
  const verdicts: Record<string, VerifyClaimVerdict> = {}
  for (const question of request.questions) {
    const answer = advice.answers.find((candidate) => candidate.name === question.name)
    if (answer !== undefined && answer.type === 'predicate') {
      verdicts[question.name] = (answer.probability ?? 0) >= VERIFY_PASS_THRESHOLD ? 'PASS' : 'FAIL'
    } else {
      verdicts[question.name] = 'BLOCK'
    }
  }
  return Object.freeze(verdicts)
}
