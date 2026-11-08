/**
 * J3 turn-complexity escalation — shadow classification of delegate dispatches
 * through the native Jev route, with an explicit, separately-reviewed
 * activation mechanism.
 *
 * When `PANTHEON_J3_ESCALATION` is enabled, the plugin's `execute.before` hook
 * fires ONE bounded native Jev decision per delegate dispatch (the native
 * `subagent` tool assembling the Brief) through {@link runGatedNativeJevCall}
 * — the SAME gate chain `pantheon_jev_decide` runs (user-level config, egress
 * consent, budget-ledger reservation, the host permission kill-switch on
 * `decision.egress`) — and records the verdict as a shadow record into the
 * decision telemetry sink.
 *
 * ## Shadow contract
 *
 * In this phase the verdict NEVER changes the dispatched model. The override
 * decision is computed and recorded; applying it is the separately-reviewed
 * activation step. The mechanism — set the per-agent override for the delegate
 * BEFORE dispatch through the existing model-override mechanism
 * (`model-overrides.applyV2ModelOverride`), restore the previous model
 * after — is implemented in {@link applyEscalationOverride} and
 * {@link clearEscalationOverride}, and the shadow observer has NO path to
 * them: its options carry no agent draft and its body never calls them. The
 * mechanism is proved by direct exercise in tests only. The cheap target is a
 * compile-time constant ({@link J3_ESCALATION_CHEAP_MODEL}) validated by the
 * same capability table the override mechanism uses; decision models are NOT
 * eligible targets (they are not chat models and never appear in the host
 * catalog — the catalog is never consulted for any decision here).
 *
 * ## Rails (all local, no Jev call involved)
 *
 * Three independent local rails force the verdict to `main` regardless of the
 * reported complexity — mirroring the hermes discipline that a wrong `cheap`
 * costs task quality while a wrong `main` only costs tokens:
 *
 * 1. **Risk words** ({@link J3_RISK_WORDS}, exported as a fixture for tests):
 *    a Brief mentioning deploy/migrate/drop/delete/prod/production/payment/
 *    secret/credential never goes cheap. Matching is case-insensitive
 *    SUBSTRING match on purpose — inflections and plurals rail too, and
 *    over-matching biases to the safe direction.
 * 2. **User-pinned model**: an explicit per-agent override for the delegate in
 *    the project-scoped model configuration (the same file
 *    `pantheon_model` writes) is never overridden. If the configuration cannot
 *    be read, the delegate is treated as pinned (fail-safe to main).
 * 3. **Context length**: a Brief longer than {@link J3_CONTEXT_LENGTH_RAIL}
 *    never downgrades.
 *
 * ## Fail-safe policy
 *
 * The verdict is PURE policy ({@link escalationVerdict}): complexity at or
 * below the documented threshold AND no rail tripped → `cheap`; anything else
 * — including a null complexity from a malformed, refused or timed-out
 * classification — → `main`. The main model is never downgraded by
 * uncertainty.
 *
 * ## Sanitization contract (identical to J1)
 *
 * The decision request carries NO user content: no Brief text, no task
 * description, no paths. The state text is the exact bounded template over
 * four structural fields — the delegate id (accepted only as a canonical
 * Pantheon agent token; anything else is `INPUT_INVALID`), the sha256 of the
 * Brief text (an opaque correlation value), its character length, and the
 * local risk-word boolean. The Brief text itself never leaves this machine.
 *
 * ## No delay, no retry, no queue
 *
 * The hook fires the observer without awaiting it (fire-and-observe); the
 * observer bounds its own wait at {@link J3_ESCALATION_TIMEOUT_MS} with an
 * AbortController and records `skip-timeout` at the deadline. In a future
 * active phase the same deadline is the dispatch rule: a classification still
 * in flight when the dispatch resolves the model is `main` — dispatch is never
 * delayed. Exactly one call is ever fired: no retry, no queue.
 *
 * @module jev-escalation
 */

import { createHash } from 'node:crypto'
import { type GatedNativeJevRuntime, runGatedNativeJevCall } from './jev-decision-tool.ts'
import { consumeJevDecisionResult } from './jev-decisions.ts'
import { mapGateFailureToSkipReason } from './jev-risk-gate.ts'
import { observeShadow, type ShadowSink } from './decision-shadow.ts'
import { PANTHEON_AGENTS } from './delegation-policy.ts'
import { applyV2ModelOverride, readV2ModelConfiguration } from './model-overrides.ts'
import type { NativeDecisionRequest } from './native-decisions.ts'

/** On/off switch read by the plugin wiring. Any other value means off. */
export const J3_ESCALATION_FLAG_ENV = 'PANTHEON_J3_ESCALATION'

/** Telemetry point id for the turn-complexity escalation (J-series). */
export const J3_ESCALATION_POINT = 'J3'

/** Wall-clock bound for one classification. The hook never waits on it. */
export const J3_ESCALATION_TIMEOUT_MS = 2_000

/** Question name of the prepared score question, matched on consumption. */
export const ESCALATION_QUESTION_NAME = 'complexity'

/** Score levels offered to the host: the full 2..10 question bound. */
export const J3_COMPLEXITY_LEVEL_COUNT = 9

/**
 * The cheap threshold — the ONE documented policy knob of the verdict.
 *
 * `complexity ≤ 4` is "confidently easy": the lower third of the offered
 * 9-level scale (1 trivial … 9 sprawling). Deliberately conservative because
 * the failure modes are asymmetric — a wrong `cheap` sends a heavyweight
 * delegation to a weak model (task quality lost), while a wrong `main` only
 * costs tokens. This encodes the reference design's sticky-cheap bias: the
 * classifier must be CONFIDENT before anything goes cheap, and everything
 * else — including every unsure, malformed or timed-out answer — stays on the
 * main model.
 */
export const J3_ESCALATION_CHEAP_THRESHOLD = 4

/**
 * The context-length rail: a Brief longer than this is never downgraded, no
 * matter the score. 8,000 chars (~2/3 of the 12,000-char state bound of
 * `pantheon_jev_decide`) is the documented conservative line — routine briefs
 * sit far below it, and anything near the state ceiling is by construction
 * heavyweight work.
 */
export const J3_CONTEXT_LENGTH_RAIL = 8_000

/**
 * The risk-word fixture (also the runtime word list). Words whose presence in
 * the Brief forces the verdict to `main` regardless of the reported score.
 * Exported so tests exercise exactly the list the policy ships with.
 */
export const J3_RISK_WORDS: readonly string[] = Object.freeze([
  'deploy',
  'migrate',
  'drop',
  'delete',
  'prod',
  'production',
  'payment',
  'secret',
  'credential',
])

/**
 * The model a `cheap` verdict dispatches to at activation time. A compile-time
 * constant, NOT a catalog lookup: decision models are not chat models and
 * never appear in `model.list()`, so no decision here ever consults the
 * catalog. `opencode/mimo-v2.6-flash` is the OpenCode Zen free tier's current
 * low-effort model — validated through the same capability table
 * (`presets.capabilityEntry`) the override mechanism applies, which is what
 * makes the override a real, resolvable model choice.
 */
export const J3_ESCALATION_CHEAP_MODEL = 'opencode/mimo-v2.6-flash'

/** Bound for the composed state text (the template is ~320 chars). */
export const J3_ESCALATION_STATE_MAX_LENGTH = 512

const FLAG_ON = new Set(['1', 'on', 'true', 'shadow'])
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
/** Largest state_chars printed into the template (8 digits). */
const STATE_LENGTH_MAX = 100_000_000

/** Whether the operator explicitly enabled the flag. Absence means off. */
export function j3EscalationEnabledFromEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env[J3_ESCALATION_FLAG_ENV] ?? '').trim().toLowerCase()
  return FLAG_ON.has(raw)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether one Brief text trips the risk-word rail. Case-insensitive substring
 * matching is deliberate: inflections and plurals ('redeployment', 'secrets',
 * 'payments') rail too, and over-matching biases to `main` — the safe
 * direction for a downgrade decision.
 */
export function containsRiskWord(briefText: unknown): boolean {
  if (typeof briefText !== 'string' || briefText.length === 0) return false
  const haystack = briefText.toLowerCase()
  return J3_RISK_WORDS.some((word) => haystack.includes(word))
}

/**
 * The delegate target of a native `subagent` dispatch event: the canonical
 * lowercase agent id, or `undefined` for anything else (wrong tool, malformed
 * input, non-canonical target). Mirrors the origin registry's own target
 * validation so the observer and the delegation policy agree on what a
 * dispatch is.
 */
export function subagentDispatchTarget(event: unknown): string | undefined {
  if (!isRecord(event)) return undefined
  if (event.tool !== 'subagent') return undefined
  const input = event.input
  if (!isRecord(input)) return undefined
  const agent = input.agent
  if (typeof agent !== 'string') return undefined
  const normalized = agent.trim().toLowerCase()
  return PANTHEON_AGENTS.has(normalized) ? normalized : undefined
}

/** Whether one event is a delegate dispatch the observer may classify. */
export function isSubagentDispatchEvent(event: unknown): boolean {
  return subagentDispatchTarget(event) !== undefined
}

/**
 * Extract the Brief text from a dispatch input: the first non-empty string
 * among the host's task-bearing fields, the raw string itself, or (nothing
 * string-shaped) a serialized form of the whole input. The result is hashed,
 * measured and scanned locally — it is never sent anywhere.
 */
const BRIEF_TEXT_KEYS: readonly string[] = Object.freeze([
  'prompt',
  'description',
  'message',
  'task',
  'instructions',
])

function serializeBrief(brief: unknown): string {
  if (typeof brief === 'string') return brief
  try {
    const json = JSON.stringify(brief)
    return json === undefined ? String(brief) : json
  } catch {
    return 'unserializable-subagent-brief'
  }
}

export function extractBriefText(input: unknown): string {
  if (typeof input === 'string') return input
  if (isRecord(input)) {
    for (const key of BRIEF_TEXT_KEYS) {
      const value = input[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
  }
  return serializeBrief(input)
}

export type EscalationRequestFailure = 'INPUT_INVALID'

export type EscalationPreparedRequest =
  | {
      readonly ok: true
      /** The request body; the caller attaches the resolved route's `model`. */
      readonly request: Omit<NativeDecisionRequest, 'model'>
    }
  | { readonly ok: false; readonly reasonCode: EscalationRequestFailure }

const COMPLEXITY_LABELS = [
  'trivial',
  'simple',
  'routine',
  'moderate',
  'involved',
  'complex',
  'heavy',
  'critical',
  'sprawling',
] as const

const COMPLEXITY_LEVELS = Object.freeze(
  Array.from({ length: J3_COMPLEXITY_LEVEL_COUNT }, (_, index) => {
    return Object.freeze({ label: COMPLEXITY_LABELS[index] ?? `level-${index}` })
  }),
)

const COMPLEXITY_INSTRUCTIONS =
  'Rate how complex this delegated dispatch is for the specialist agent, judging from the ' +
  'structural hints in the state (dispatch size and risk markers): routine and self-contained ' +
  'at the low end, broad multi-step work at the high end. Advisory only; nothing is enforced.'

const QUESTIONS = Object.freeze([
  Object.freeze({
    type: 'score' as const,
    name: ESCALATION_QUESTION_NAME,
    instructions: COMPLEXITY_INSTRUCTIONS,
    levels: COMPLEXITY_LEVELS,
  }),
])

/**
 * Build the bounded classification request — the sanitization contract made
 * structural. The state is the exact template over the four admitted fields;
 * the delegate id must already be a canonical Pantheon agent token (paths,
 * metacharacters, prose and unknown agents are `INPUT_INVALID`, never
 * sanitized on the way in); the hash must be lowercase sha256 hex; the length
 * a bounded non-negative integer; the risk flag a boolean. ONE score question
 * only. No file parts, no JSON parts, no extra fields.
 */
export function classifyTurnComplexity(request: {
  readonly stateHash: string
  readonly stateLength: number
  readonly hasRiskWord: boolean
  readonly delegateId: string
}): EscalationPreparedRequest {
  const input = isRecord(request) ? request : undefined
  const delegateId = input?.delegateId
  if (
    typeof delegateId !== 'string' ||
    !TOKEN_PATTERN.test(delegateId) ||
    !PANTHEON_AGENTS.has(delegateId)
  ) {
    return { ok: false, reasonCode: 'INPUT_INVALID' }
  }
  const stateHash = input?.stateHash
  if (typeof stateHash !== 'string' || !SHA256_HEX.test(stateHash)) {
    return { ok: false, reasonCode: 'INPUT_INVALID' }
  }
  const stateLength = input?.stateLength
  if (
    typeof stateLength !== 'number' ||
    !Number.isInteger(stateLength) ||
    stateLength < 0 ||
    stateLength > STATE_LENGTH_MAX
  ) {
    return { ok: false, reasonCode: 'INPUT_INVALID' }
  }
  const hasRiskWord = input?.hasRiskWord
  if (typeof hasRiskWord !== 'boolean') {
    return { ok: false, reasonCode: 'INPUT_INVALID' }
  }
  const state =
    'Advisory complexity probe for one delegated dispatch. ' +
    `delegate: ${delegateId}. state_sha256: ${stateHash}. state_chars: ${stateLength}. ` +
    `risk_word_present: ${hasRiskWord ? 'yes' : 'no'}. ` +
    'The request carries no task content; the Brief text never leaves this machine; ' +
    'judge from the structural fields alone.'
  if (state.length > J3_ESCALATION_STATE_MAX_LENGTH) {
    return { ok: false, reasonCode: 'INPUT_INVALID' }
  }
  return {
    ok: true,
    request: Object.freeze({
      input: Object.freeze([Object.freeze({ type: 'text' as const, text: state })]),
      questions: QUESTIONS,
    }),
  }
}

export interface EscalationEvaluation {
  /**
   * The host's score for the `complexity` question; `null` when the answer is
   * missing, mistyped, duplicated or an error. A raw ordinal on the prepared
   * scale, not a probability.
   */
  readonly complexity: number | null
}

/**
 * Consume a host Decisions response against the prepared request.
 *
 * Validation is strict and borrowed wholesale from the tool's own consumer
 * (`consumeJevDecisionResult`): the answer counts only when its name and type
 * match the prepared question, the score is a non-negative finite number, and
 * duplicates become errors. Anything else — and any unknown response shape —
 * is `null`, never a guess. Extra fields on answers never cross into the
 * evaluation.
 */
export function evaluateEscalationDecision(
  response: unknown,
  request: NativeDecisionRequest,
): EscalationEvaluation {
  const advice = consumeJevDecisionResult(response, request)
  let complexity: number | null = null
  for (const answer of advice.answers) {
    if (answer.type === 'error') continue
    if (answer.type === 'score' && answer.name === ESCALATION_QUESTION_NAME) {
      complexity = answer.score ?? null
    }
  }
  return { complexity }
}

export type EscalationVerdict = 'cheap' | 'main'

/** The three local rails, computed by the caller before the verdict. */
export interface EscalationRails {
  readonly hasRiskWord: boolean
  readonly pinnedModel: boolean
  readonly stateLength: number
}

/**
 * The PURE policy. Any rail tripped → `main`, regardless of the score (risk
 * words never cheap, pinned models never overridden, large context never
 * downgrades). A null complexity — unsure, malformed, refused, timed out — is
 * `main`: the main model is never downgraded by uncertainty. Otherwise
 * `complexity ≤ J3_ESCALATION_CHEAP_THRESHOLD` (inclusive) is `cheap` and
 * everything above is `main`.
 */
export function escalationVerdict(input: {
  readonly complexity: number | null
  readonly rails: EscalationRails
}): EscalationVerdict {
  if (input.complexity === null) return 'main'
  if (input.rails.hasRiskWord) return 'main'
  if (input.rails.pinnedModel) return 'main'
  if (input.rails.stateLength > J3_CONTEXT_LENGTH_RAIL) return 'main'
  return input.complexity <= J3_ESCALATION_CHEAP_THRESHOLD ? 'cheap' : 'main'
}

const REASON_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

function formatScoreToken(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 1000) return 'na'
  const text = String(Math.round(value * 100) / 100)
  return TOKEN_PATTERN.test(text) ? text : 'na'
}

/**
 * Encode the verdict into ONE telemetry reason token (the sink's allowlist has
 * no slot for structured fields, and that is its strength): e.g.
 * `esc-cheap-c2`, `esc-main-c7`, `esc-main-c-na`. Always a bounded
 * `[A-Za-z0-9._:-]` token; a score outside 0..1000 or not finitely
 * representable encodes as `c-na`.
 */
export function encodeEscalationReason(input: {
  readonly verdict: EscalationVerdict | null
  readonly complexity: number | null
}): string {
  const verdict = input.verdict === 'cheap' ? 'esc-cheap' : 'esc-main'
  const score = input.complexity === null ? 'na' : formatScoreToken(input.complexity)
  const reason = score === 'na' ? `${verdict}-c-na` : `${verdict}-c${score}`
  return REASON_TOKEN.test(reason) ? reason : 'invalid-reason'
}

// ─── The activation mechanism (NOT reachable from the shadow path) ──────

/**
 * One applied escalation override: the agent it was set on and the model that
 * was there before, so the caller can restore it after the dispatch resolved.
 */
export interface EscalationOverrideHandle {
  readonly agentId: string
  readonly previousModel: unknown
}

/**
 * The ACTIVATION mechanism — never called by the shadow observer. Rides the
 * existing per-agent model-override mechanism
 * (`model-overrides.applyV2ModelOverride`): for a `cheap` verdict, sets the
 * delegate's model to {@link J3_ESCALATION_CHEAP_MODEL} on the agent draft
 * BEFORE dispatch, exactly the way a project preset or `pantheon_model` does,
 * and returns a handle carrying the previous model. Any other verdict — and
 * any agent the override mechanism refuses (unknown id, unsupported model) —
 * touches nothing and returns no handle. The parent model is never touched:
 * the override applies only to the delegate's own draft entry.
 */
export function applyEscalationOverride(
  agent: { readonly id: string; model?: unknown },
  verdict: EscalationVerdict | undefined,
): EscalationOverrideHandle | undefined {
  if (verdict !== 'cheap') return undefined
  if (agent === null || typeof agent !== 'object') return undefined
  const previousModel = agent.model
  applyV2ModelOverride(agent, { model: J3_ESCALATION_CHEAP_MODEL })
  // The mechanism refuses unknown agents and unsupported models by leaving
  // the draft untouched; only a real application returns a handle.
  if (agent.model === previousModel) return undefined
  return { agentId: agent.id, previousModel }
}

/**
 * The clear half of the activation mechanism: restore the model the delegate
 * had before {@link applyEscalationOverride} ran. A mismatched or absent
 * handle is a no-op, so a stale handle can never clobber another agent.
 */
export function clearEscalationOverride(
  agent: { readonly id: string; model?: unknown },
  handle: EscalationOverrideHandle | undefined,
): void {
  if (handle === undefined) return
  if (agent === null || typeof agent !== 'object') return
  if (agent.id !== handle.agentId) return
  agent.model = handle.previousModel
}

/**
 * Whether the user pinned a model for the delegate in the project-scoped
 * model configuration (the same file `pantheon_model` writes and the agent
 * transform reads). A configuration that cannot be read counts as pinned —
 * fail-safe to main, never cheap on uncertainty.
 */
function defaultIsPinnedModel(delegateId: string): boolean {
  try {
    const configuration = readV2ModelConfiguration()
    return Object.hasOwn(configuration.overrides, delegateId)
  } catch {
    return true
  }
}

/** The `execute.before` fields the observer reads; `input` is hashed, never sent. */
interface J3SubagentEvent {
  tool?: unknown
  sessionID?: unknown
  messageID?: unknown
  agent?: unknown
  input?: unknown
}

export interface J3EscalationObserverOptions {
  /** The same runtime the `pantheon_jev_decide` tool uses. */
  readonly runtime: GatedNativeJevRuntime
  /** Shadow-record sink (the plugin wraps it with the telemetry mode). */
  readonly sink?: ShadowSink
  readonly timeoutMs?: number
  /**
   * The pinned-model rail. Defaults to the project-scoped model-override
   * reader; tests inject the seam.
   */
  readonly isPinnedModel?: (delegateId: string) => boolean
}

function recordSkip(sink: ShadowSink | undefined, skipReason: string): void {
  observeShadow(
    J3_ESCALATION_POINT,
    skipReason,
    () => ({
      decision: 'unavailable',
      reason: skipReason,
    }),
    sink,
  )
}

function abortDeadline(signal: AbortSignal): Promise<'timeout'> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve('timeout')
      return
    }
    signal.addEventListener('abort', () => resolve('timeout'), { once: true })
  })
}

/**
 * Create the J3 observer: one async, self-bounding classification per delegate
 * dispatch. The returned function NEVER throws and NEVER records more than one
 * shadow record per event; a non-dispatch or malformed event records nothing
 * at all.
 *
 * The gate chain runs unawaited races against the deadline; on timeout the
 * observer records `skip-timeout` and abandons while the abandoned chain
 * settles its own ledger reservation in the background (settlement of an
 * already-fired call — not a retry, and it writes no record).
 *
 * SHADOW CONTRACT: the verdict computed here is recorded and nothing else.
 * The observer carries no agent draft, and nothing in this function or its
 * options can reach {@link applyEscalationOverride} — the dispatched model
 * cannot change in this phase.
 */
export function createJ3EscalationObserver(
  options: J3EscalationObserverOptions,
): (event: unknown) => Promise<void> {
  const timeoutMs = options.timeoutMs ?? J3_ESCALATION_TIMEOUT_MS
  const sink = options.sink
  const isPinnedModel = options.isPinnedModel ?? defaultIsPinnedModel
  return async (event: unknown): Promise<void> => {
    try {
      const delegateId = subagentDispatchTarget(event)
      if (delegateId === undefined) return
      const payload = (event ?? {}) as J3SubagentEvent
      const briefText = extractBriefText(payload.input)
      const stateLength = briefText.length
      const hasRiskWord = containsRiskWord(briefText)
      const built = classifyTurnComplexity({
        delegateId,
        stateHash: createHash('sha256').update(briefText, 'utf8').digest('hex'),
        stateLength,
        hasRiskWord,
      })
      if (!built.ok) {
        recordSkip(sink, 'skip-input-invalid')
        return
      }
      const rails: EscalationRails = {
        hasRiskWord,
        pinnedModel: isPinnedModel(delegateId),
        stateLength,
      }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
      try {
        const outcome = await Promise.race([
          runGatedNativeJevCall({
            sessionID: payload.sessionID,
            messageID: payload.messageID,
            agent: typeof payload.agent === 'string' ? payload.agent : undefined,
            runtime: options.runtime,
            prepare: (route) => ({
              ok: true as const,
              request: {
                model: route.model,
                input: built.request.input,
                questions: built.request.questions,
              },
            }),
          }),
          abortDeadline(controller.signal),
        ])
        if (outcome === 'timeout') {
          recordSkip(sink, 'skip-timeout')
          return
        }
        if (!outcome.ok) {
          recordSkip(sink, mapGateFailureToSkipReason(outcome.reasonCode))
          return
        }
        const evaluation = evaluateEscalationDecision(outcome.call.response, outcome.call.request)
        const verdict = escalationVerdict({ complexity: evaluation.complexity, rails })
        observeShadow(
          J3_ESCALATION_POINT,
          evaluation,
          (isolated) => ({
            decision: 'observe',
            reason: encodeEscalationReason({
              verdict,
              complexity: (isolated as EscalationEvaluation).complexity,
            }),
          }),
          sink,
        )
      } finally {
        clearTimeout(timer)
      }
    } catch {
      // Fail-open: the gate chain rejects only when the budget ledger cannot
      // be opened; any other unexpected failure lands here too. One skip
      // record, no detail, no propagation into the dispatch.
      recordSkip(sink, 'skip-gate-unavailable')
    }
  }
}
