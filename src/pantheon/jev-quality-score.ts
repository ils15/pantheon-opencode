/**
 * J4 output-quality scoring — advisory, on-demand review of a delegated
 * result through the native Jev route (the jev-dsh-decision pattern).
 *
 * After a delegation completes, Zeus can explicitly request a review through
 * the `pantheon_jev_decide` tool's `mode: "review"`: ONE typed round-trip that
 * asks TWO questions — a `score` ("quality of this delegated result against
 * the criteria", the full 2..10 rubric bound) and a `predicate` (`noul`,
 * "does this result need human review?") — through the SAME gate chain every
 * other consumer runs (user-level config, egress consent, budget-ledger
 * reservation, the host permission kill-switch on `decision.egress`).
 *
 * ## Advisory contract
 *
 * The verdict ({@link qualityVerdict}) is PURE policy and its
 * `flag-for-review` outcome is advisory telemetry plus a flag the tool output
 * may surface — it NEVER blocks, retries, or alters the delegated result. The
 * verdict follows the host's explicit review answer only: a LOW quality score
 * with an explicit no-review answer records without flagging (the score is
 * surfaced for Zeus to weigh; this module does not second-guess it). There is
 * no automatic hook: review happens when Zeus asks, matching the reference
 * design's on-demand scoring.
 *
 * ## Sanitization contract (J1/J3 discipline, one step stricter)
 *
 * The result itself NEVER leaves the machine — the request has NO content
 * field at all (structural, not a scrub): the state is an exact bounded
 * template over shape metrics only (the delegate id, the result kind
 * `ok|empty|error`, the output character count, the task duration, the
 * criteria count), and the criteria are the ONLY free text admitted, riding
 * the score question's instructions. Criteria are caller-provided instruction
 * strings (1–120 chars each, at most {@link J4_MAX_CRITERIA} of them) that
 * come from the tool schema, never user text; hostile shapes — paths, path
 * separators, credential assignments and key material, control characters,
 * over-length — are rejected `CRITERIA_INVALID`, never sanitized on the way
 * in. The delegate id must be a canonical Pantheon agent token; the metrics
 * must be bounded non-negative integers (a `null` duration means "unknown").
 *
 * ## DSH hard caps, mirrored
 *
 * The reference design's request bounds are mirrored where this surface can
 * enforce them: at most 4 criteria per call ({@link J4_MAX_CRITERIA}), each a
 * bounded 1–120-char instruction string, ONE request per review (no retry, no
 * queue — settlement is the shared runner's fail-closed contract), and
 * redacted errors everywhere (gate failures surface reason codes; call
 * failures carry the error CLASS only — the host's message text never crosses
 * into the tool output).
 *
 * "The agent's explanation is not Jev's raw output": the consumer reuses the
 * tool's strict validation (`consumeJevDecisionResult`) — an answer counts
 * only when its name and type match the prepared questions, duplicates become
 * errors, and unbounded host metadata never reaches the evaluation.
 *
 * @module jev-quality-score
 */

import { consumeJevDecisionResult } from './jev-decisions.ts'
import { PANTHEON_AGENTS } from './v2-delegation-enforce.ts'
import type { NativeDecisionRequest, ResolvedNativeDecisionRoute } from './v2-native-decisions.ts'

/** Telemetry point id for the output-quality review (J-series: Jev uplift). */
export const J4_QUALITY_SCORE_POINT = 'J4'

/** Question names of the two prepared questions, matched on consumption. */
export const QUALITY_QUESTION_NAME = 'quality'
/**
 * Field report (beta.13→16): the review question was literally named 'noul'
 * — the decision model's internal archetype leaked into a user-visible
 * payload. The name is ours to choose; `quality` says what it measures.
 */
export const REVIEW_QUESTION_NAME = 'needs_review'

/** DSH hard-cap mirror: at most 4 criteria per review request. */
export const J4_MAX_CRITERIA = 4
/** A rubric needs at least one named criterion. */
export const J4_MIN_CRITERIA = 1
/** Each criterion is a bounded instruction string (1–120 chars). */
export const J4_CRITERIA_MAX_LENGTH = 120

/** Rubric levels offered to the host: the full 2..10 score-question bound. */
export const J4_QUALITY_LEVEL_COUNT = 9

/**
 * Predicate probability at or above which `noul` counts as "needs review".
 */
export const J4_REVIEW_THRESHOLD = 0.5

/** Bound for the composed state text (the template is ~370 chars at worst). */
export const J4_QUALITY_SCORE_STATE_MAX_LENGTH = 512

/** Upper bound for the structural metrics printed into the template. */
const METRICS_MAX = 100_000_000

export type QualityScoreResultKind = 'ok' | 'empty' | 'error'

const RESULT_KINDS: ReadonlySet<string> = new Set(['ok', 'empty', 'error'])

const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

export interface QualityScoreRequestInput {
  /** The canonical Pantheon agent id whose result is being reviewed. */
  readonly delegateId: string
  /** The result's shape class — the only "what happened" that crosses. */
  readonly resultSummaryKind: QualityScoreResultKind
  /** Structural metrics only: never content. */
  readonly resultMetrics: {
    readonly outputChars: number
    readonly taskDurationMs: number | null
  }
  /** Named criteria; the ONLY free text the request admits. */
  readonly criteria: readonly string[]
}

export type QualityScoreRequestFailure = 'CRITERIA_INVALID' | 'INPUT_INVALID'

export type QualityScorePreparedRequest =
  | {
      readonly ok: true
      /** The request body; the caller attaches the resolved route's `model`. */
      readonly request: Omit<NativeDecisionRequest, 'model'>
    }
  | { readonly ok: false; readonly reasonCode: QualityScoreRequestFailure }

const QUALITY_LABELS = [
  'unusable',
  'poor',
  'weak',
  'fair',
  'adequate',
  'good',
  'strong',
  'excellent',
  'exemplary',
] as const

const QUALITY_INSTRUCTIONS_PREFIX =
  'Rate the quality of this delegated result against the criteria listed below; the criteria ' +
  'are required and the structural metrics in the state are context only. Judge the result ' +
  'itself, not the delegation that produced it. Advisory only; nothing is enforced.'

const REVIEW_INSTRUCTIONS =
  'Does this delegated result need human review before it is used? Answer as a probability: ' +
  'higher means review is more warranted. A yes is advisory only; it never blocks, retries, ' +
  'or alters the result.'

/** Path separators in any position: a criterion is prose, never a location. */
const PATH_PATTERN = /[/\\]/

/**
 * Control characters (C0 and DEL — newlines and tabs included): criteria are
 * single-line prose. An explicit code-point scan, not a regex, so the hostile
 * input check stays lint-clean without a rule suppression.
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= METRICS_MAX
}

/** Whether one criterion is a hostile shape (rejected, never scrubbed). */
function isHostileCriterion(criterion: string): boolean {
  if (PATH_PATTERN.test(criterion)) return true
  if (hasControlCharacter(criterion)) return true
  if (KEY_MATERIAL_PATTERNS.some((pattern) => pattern.test(criterion))) return true
  return CREDENTIAL_ASSIGNMENT_PATTERN.test(criterion)
}

/**
 * Build the bounded review request — the sanitization contract made
 * structural. One text part (the exact metrics template), ONE score question
 * (the 2..10 quality rubric, criteria listed in its instructions) and ONE
 * predicate question (`noul`). No file parts, no JSON parts, no content
 * field. Hostile input is rejected, never sanitized on the way in.
 */
export function buildQualityScoreRequest(
  input: QualityScoreRequestInput,
): QualityScorePreparedRequest {
  const record = isRecord(input) ? input : undefined
  const delegateId = record?.delegateId
  if (
    typeof delegateId !== 'string' ||
    !TOKEN_PATTERN.test(delegateId) ||
    !PANTHEON_AGENTS.has(delegateId)
  ) {
    return { ok: false, reasonCode: 'INPUT_INVALID' }
  }
  const resultSummaryKind = record?.resultSummaryKind
  if (typeof resultSummaryKind !== 'string' || !RESULT_KINDS.has(resultSummaryKind)) {
    return { ok: false, reasonCode: 'INPUT_INVALID' }
  }
  const metrics = record?.resultMetrics
  if (!isRecord(metrics)) return { ok: false, reasonCode: 'INPUT_INVALID' }
  if (!isBoundedCount(metrics.outputChars)) return { ok: false, reasonCode: 'INPUT_INVALID' }
  const taskDurationMs = metrics.taskDurationMs
  if (taskDurationMs !== null && !isBoundedCount(taskDurationMs)) {
    return { ok: false, reasonCode: 'INPUT_INVALID' }
  }
  const criteria = record?.criteria
  if (!Array.isArray(criteria)) return { ok: false, reasonCode: 'CRITERIA_INVALID' }
  if (criteria.length < J4_MIN_CRITERIA || criteria.length > J4_MAX_CRITERIA) {
    return { ok: false, reasonCode: 'CRITERIA_INVALID' }
  }
  for (const criterion of criteria) {
    if (
      typeof criterion !== 'string' ||
      criterion.length < 1 ||
      criterion.length > J4_CRITERIA_MAX_LENGTH ||
      criterion.trim().length === 0 ||
      isHostileCriterion(criterion)
    ) {
      return { ok: false, reasonCode: 'CRITERIA_INVALID' }
    }
  }

  const state =
    'Advisory quality review of one delegated result. ' +
    `delegate: ${delegateId}. result_kind: ${resultSummaryKind}. output_chars: ${metrics.outputChars}. ` +
    `task_duration_ms: ${taskDurationMs === null ? 'na' : String(taskDurationMs)}. ` +
    `criteria_count: ${criteria.length}. ` +
    'The result content never leaves this machine; the criteria are listed in the quality ' +
    'question; judge from the structural fields and the criteria alone.'
  if (state.length > J4_QUALITY_SCORE_STATE_MAX_LENGTH) {
    return { ok: false, reasonCode: 'INPUT_INVALID' }
  }
  const qualityInstructions =
    QUALITY_INSTRUCTIONS_PREFIX +
    ` Criteria: ${criteria.map((criterion, index) => `(${index + 1}) ${criterion}`).join('; ')}.`
  return {
    ok: true,
    request: Object.freeze({
      input: Object.freeze([Object.freeze({ type: 'text' as const, text: state })]),
      questions: Object.freeze([
        Object.freeze({
          type: 'score' as const,
          name: QUALITY_QUESTION_NAME,
          instructions: qualityInstructions,
          levels: Object.freeze(QUALITY_LABELS.map((label) => Object.freeze({ label }))),
        }),
        Object.freeze({
          type: 'predicate' as const,
          name: REVIEW_QUESTION_NAME,
          instructions: REVIEW_INSTRUCTIONS,
        }),
      ]),
    }),
  }
}

export interface QualityScoreEvaluation {
  /**
   * The host's score for the `quality` question; `null` when the answer is
   * missing, mistyped, duplicated or an error. A raw ordinal on the prepared
   * 2..10 rubric, surfaced for Zeus to weigh — never a gate.
   */
  readonly quality: number | null
  /**
   * Whether the `noul` predicate holds (probability ≥ 0.5); `null` under the
   * same failures.
   */
  readonly needsReview: boolean | null
}

/**
 * Consume a host Decisions response against the prepared request.
 *
 * Validation is strict and borrowed wholesale from the tool's own consumer
 * (`consumeJevDecisionResult`): an answer counts only when its name and type
 * match the prepared questions, score answers carry a non-negative finite
 * score, predicate answers a probability in [0, 1], and duplicates become
 * errors. Anything else — and any unknown response shape — is `null`, never a
 * guess. Extra fields on answers never cross into the evaluation.
 */
export function evaluateQualityScoreDecision(
  response: unknown,
  prepared: NativeDecisionRequest,
): QualityScoreEvaluation {
  const advice = consumeJevDecisionResult(response, prepared)
  let quality: number | null = null
  let needsReview: boolean | null = null
  for (const answer of advice.answers) {
    if (answer.type === 'error') continue
    if (answer.type === 'score' && answer.name === QUALITY_QUESTION_NAME) {
      quality = answer.score ?? null
    } else if (answer.type === 'predicate' && answer.name === REVIEW_QUESTION_NAME) {
      needsReview = (answer.probability ?? 0) >= J4_REVIEW_THRESHOLD
    }
  }
  return { quality, needsReview }
}

/**
 * The verdict of one review: `recorded` or `flag-for-review`. PURE and
 * advisory — the flag is telemetry plus a tool-output field the caller may
 * surface; nothing is ever blocked, retried, or altered. An affirmative
 * `needsReview` is the ONE flagging condition; a negative or absent answer
 * records, and the quality score never flags on its own.
 */
export type QualityVerdict = 'recorded' | 'flag-for-review'

export function qualityVerdict(input: {
  readonly quality: number | null
  readonly needsReview: boolean | null
}): QualityVerdict {
  void input.quality // the score is surfaced, never enforced
  return input.needsReview === true ? 'flag-for-review' : 'recorded'
}

const REASON_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

function formatScoreToken(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 1000) return 'na'
  const text = String(Math.round(value * 100) / 100)
  return TOKEN_PATTERN.test(text) ? text : 'na'
}

/**
 * Encode the evaluation into ONE telemetry reason token (the sink's allowlist
 * has no slot for structured fields, and that is its strength): e.g.
 * `q-7-review-yes`, `q-na-review-na`. Always a bounded token; a score outside
 * 0..1000 or not finitely representable encodes as `na`.
 */
export function encodeQualityScoreReason(input: {
  readonly quality: number | null
  readonly needsReview: boolean | null
}): string {
  const score = input.quality === null ? 'na' : formatScoreToken(input.quality)
  const review = input.needsReview === null ? 'na' : input.needsReview ? 'yes' : 'no'
  const reason = `q-${score}-review-${review}`
  return REASON_TOKEN.test(reason) ? reason : 'invalid-reason'
}

// ─── Tool-surface preparation (the review mode) ──────────────────────────

/**
 * The review tool input's envelope: the mode selector plus the review fields.
 * ANY other key — `state`, `questions`, or a smuggled content field — refuses
 * the preparation, so no content slot exists even at the input boundary.
 */
export const REVIEW_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'mode',
  'delegateId',
  'resultSummaryKind',
  'resultMetrics',
  'criteria',
])

export type JevReviewPreparationFailure = 'REVIEW_INPUT_INVALID' | 'CRITERIA_INVALID'

export type JevReviewBuild =
  | { readonly ok: true; readonly request: Omit<NativeDecisionRequest, 'model'> }
  | { readonly ok: false; readonly reasonCode: JevReviewPreparationFailure }

export type JevReviewPreparation =
  | { readonly ok: true; readonly request: NativeDecisionRequest }
  | { readonly ok: false; readonly reasonCode: JevReviewPreparationFailure }

/**
 * Validate the review tool input and build the model-less request. The
 * tool-surface failure code for a malformed review is
 * {@link JevReviewPreparationFailure} — `REVIEW_INPUT_INVALID` for the
 * envelope and the structural fields (the review mode takes NO state text),
 * `CRITERIA_INVALID` for hostile criteria, so Zeus can tell the criteria are
 * the problem. The casts only bridge the untyped tool input: the builder
 * re-validates every field at runtime.
 */
export function buildJevReviewRequest(input: unknown): JevReviewBuild {
  if (!isRecord(input)) return { ok: false, reasonCode: 'REVIEW_INPUT_INVALID' }
  for (const key of Object.keys(input)) {
    if (!REVIEW_ENVELOPE_KEYS.has(key)) return { ok: false, reasonCode: 'REVIEW_INPUT_INVALID' }
  }
  // A MISSING review field is a malformed review (REVIEW_INPUT_INVALID); a
  // PRESENT-but-hostile criteria array keeps its precise CRITERIA_INVALID.
  for (const key of ['delegateId', 'resultSummaryKind', 'resultMetrics', 'criteria']) {
    if (input[key] === undefined) return { ok: false, reasonCode: 'REVIEW_INPUT_INVALID' }
  }
  const built = buildQualityScoreRequest({
    delegateId: input.delegateId as string,
    resultSummaryKind: input.resultSummaryKind as QualityScoreResultKind,
    resultMetrics: input.resultMetrics as QualityScoreRequestInput['resultMetrics'],
    criteria: input.criteria as readonly string[],
  })
  if (!built.ok) {
    return {
      ok: false,
      reasonCode:
        built.reasonCode === 'CRITERIA_INVALID' ? 'CRITERIA_INVALID' : 'REVIEW_INPUT_INVALID',
    }
  }
  return { ok: true, request: built.request }
}

/**
 * Prepare the review request — the `prepareJevPresetRequest` contract: the
 * resolved route plus the tool input in, the bounded `NativeDecisionRequest`
 * (model attached) or a structured failure out.
 */
export function prepareJevReviewRequest(
  route: ResolvedNativeDecisionRoute,
  input: unknown,
): JevReviewPreparation {
  const built = buildJevReviewRequest(input)
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
