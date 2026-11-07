/**
 * J1 risk-score advisory gate — shadow-only observation of write/execute tool
 * calls through the native Jev route.
 *
 * When `PANTHEON_J1_RISK_SCORE` is enabled, the plugin's `execute.before` hook
 * fires ONE bounded native Jev decision per write/execute tool call through
 * {@link runGatedNativeJevCall} — the SAME gate chain `pantheon_jev_decide`
 * runs (user-level config, egress consent, budget-ledger reservation, the host
 * permission kill-switch on `decision.egress`) — and records the outcome as a
 * shadow record into the decision telemetry sink. The record is the whole
 * effect: this gate never denies, never asks, never narrows a permission, and
 * never delays the tool call. The 'flag' verdict
 * ({@link RISK_GATE_FLAG_VERDICT}) is reserved for a future active phase and
 * is unreachable while the gate is shadow-only.
 *
 * ## Sanitization contract
 *
 * The decision request carries NO user content: no task text, no file paths,
 * no tool input values. The state text is the exact bounded template over
 * three fields — the tool name (accepted only as a bounded
 * `[A-Za-z0-9._:-]` token; anything else is `INPUT_INVALID`), the scope class
 * (`write` | `execute` | `read`), and the sha256 of the serialized tool input
 * (an opaque, bounded correlation value). Hostile names — paths, traversal,
 * shell metacharacters, injection prose, oversize strings — are rejected
 * outright, so no content slot exists in the first place. This mirrors the
 * redaction discipline of the decision telemetry: an allowlist of bounded
 * shapes, never a scrub of known-bad patterns.
 *
 * ## Fail-open
 *
 * Every failure mode — flag off, config disabled, consent missing, route or
 * ledger denied, permission denied, decide throwing, the 2s deadline — skips
 * the observation and records one `skip-…` reason token. The hook registers
 * the observer only when the flag is on AND the host runtime exposes the
 * native Decisions API, so a flag-off process pays zero overhead and a
 * capability-less host behaves exactly as before.
 *
 * ## No delay, no retry, no queue
 *
 * The hook fires the observer without awaiting it (fire-and-observe); the
 * observer bounds its own wait at {@link J1_RISK_GATE_TIMEOUT_MS} with an
 * AbortController, records `skip-timeout` at the deadline, and lets the
 * abandoned gate chain settle its own ledger reservation in the background.
 * Exactly one call is ever fired: no retry, no queue.
 *
 * @module jev-risk-gate
 */

import { createHash } from 'node:crypto'
import {
  type GatedNativeJevFailure,
  type GatedNativeJevRuntime,
  runGatedNativeJevCall,
} from './jev-decision-tool.ts'
import { consumeJevDecisionResult } from './jev-decisions.ts'
import { observeShadow, type ShadowSink } from './v2-decision-shadow.ts'
import { secretScanApplies } from './v2-hook-engine.ts'
import type { NativeDecisionRequest } from './v2-native-decisions.ts'

/** On/off switch read by the plugin wiring. Any other value means off. */
export const J1_RISK_GATE_FLAG_ENV = 'PANTHEON_J1_RISK_SCORE'

/** Telemetry point id for the risk-score gate (J-series: the Jev uplift). */
export const J1_RISK_GATE_POINT = 'J1'

/** Wall-clock bound for one observation. The hook never waits on it. */
export const J1_RISK_GATE_TIMEOUT_MS = 2_000

/**
 * Reserved verdict for a future active phase. NOT reachable: the gate is
 * shadow-only in this release, {@link riskGateVerdict} never returns it, and
 * nothing in the wiring consults it. Kept as a named constant so the active
 * phase cannot invent a second name for the same concept.
 */
export const RISK_GATE_FLAG_VERDICT = 'flag' as const

export type RiskGateScope = 'write' | 'execute' | 'read'

/** Question names of the two prepared questions, matched on consumption. */
export const RISK_QUESTION_NAME = 'risk'
export const INTENT_QUESTION_NAME = 'intent'

/** Score levels offered to the host; within the 2..10 question bound. */
export const J1_RISK_SCORE_LEVEL_COUNT = 5

/** Bound for the composed state text (the template is ~220 chars). */
export const J1_RISK_GATE_STATE_MAX_LENGTH = 512

/** Predicate probability at or above which the intent counts as consistent. */
export const RISK_GATE_INTENT_THRESHOLD = 0.5

const FLAG_ON = new Set(['1', 'on', 'true', 'shadow'])
const TOOL_NAME_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
const SCOPES: ReadonlySet<string> = new Set(['write', 'execute', 'read'])

/**
 * Tools whose call can run commands or reach the network. A NAME allowlist:
 * an unknown tool is `read` (never observed) — the opposite bias of the
 * secret scan, which must scan unknown names because it blocks; J1 spends
 * budget per observation, so it observes only what it can classify.
 */
const EXECUTE_TOOLS: ReadonlySet<string> = new Set([
  'bash',
  'shell',
  'sh',
  'zsh',
  'fish',
  'powershell',
  'cmd',
  'webfetch',
])
const WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write',
  'edit',
  'multiedit',
  'notebookedit',
  'patch',
  'apply_patch',
  'hashline_edit',
])

/**
 * The escalation ladder (field beta.14: the operator wants iterative
 * escalation, not a binary flag). `on`/`1`/`true` map to `shadow` for
 * back-compatibility with the shipped setup.
 *   off     — nothing fires (hard zero)
 *   shadow  — observe + record; invisible in the session (today's behavior)
 *   warn    — RESERVED (needs a V2 client channel; currently behaves as shadow)
 *   enforce — an affirmative high-risk score DENIES the tool call (the host
 *             surfaces the block message in the session); gate unavailability
 *             never blocks (fail-open, documented)
 */
export type J1RiskGateMode = 'off' | 'shadow' | 'warn' | 'enforce'

export const J1_ENFORCE_THRESHOLD_ENV = 'PANTHEON_J1_ENFORCE_THRESHOLD'
export const J1_ENFORCE_THRESHOLD_DEFAULT = 0.8

export function j1ModeFromEnv(
  env: Record<string, string | undefined> = process.env,
): J1RiskGateMode {
  const raw = (env[J1_RISK_GATE_FLAG_ENV] ?? '').trim().toLowerCase()
  if (raw === 'enforce') return 'enforce'
  if (raw === 'warn') return 'warn'
  return FLAG_ON.has(raw) ? 'shadow' : 'off'
}

/** Back-compatible: any non-off mode counts as enabled. */
export function j1RiskGateEnabledFromEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return j1ModeFromEnv(env) !== 'off'
}

/**
 * The enforce-mode deny threshold (0..1). Invalid or out-of-range values fall
 * back to the documented default — an operator typo must not disable the gate.
 */
export function j1EnforceThresholdFromEnv(
  env: Record<string, string | undefined> = process.env,
): number {
  const text = (env[J1_ENFORCE_THRESHOLD_ENV] ?? '').trim()
  if (text === '') return J1_ENFORCE_THRESHOLD_DEFAULT
  const raw = Number(text)
  if (!Number.isFinite(raw) || raw < 0 || raw > 1) return J1_ENFORCE_THRESHOLD_DEFAULT
  return raw
}

/**
 * Classify a tool name into the request's scope class. Unknown or non-string
 * names are `read` — never observed, never guessed into write/execute.
 */
export function classifyRiskGateScope(tool: unknown): RiskGateScope {
  if (typeof tool !== 'string') return 'read'
  const normalized = tool.trim().toLowerCase()
  if (EXECUTE_TOOLS.has(normalized)) return 'execute'
  if (WRITE_TOOLS.has(normalized)) return 'write'
  return 'read'
}

/**
 * Whether one tool call is a J1 observation target: a write/execute scope AND
 * the secret scan's own exfil-capable gate. The second condition reuses the
 * scan's read-only denylist (`v2-hook-engine.secretScanApplies`) so a tool the
 * scan never inspects can never be observed either — one list, two consumers.
 */
export function isRiskGateTarget(tool: unknown): tool is string {
  if (!secretScanApplies(tool)) return false
  const scope = classifyRiskGateScope(tool)
  return scope === 'write' || scope === 'execute'
}

/**
 * sha256 hex of the serialized tool input — an opaque correlation value, the
 * only content-derived field that ever leaves this process. The hash is a
 * DETERMINISTIC pseudonymization (unsalted SHA-256 — same input, same hash by
 * design, so approvals can be pinned to the exact call), NOT anonymization:
 * someone holding the dictionary can reconstruct the input. Unserializable
 * inputs hash a stable marker; this never throws.
 */
export function hashToolInput(input: unknown): string {
  let serialized: string
  if (typeof input === 'string') {
    serialized = input
  } else {
    try {
      const json = JSON.stringify(input)
      serialized = json === undefined ? String(input) : json
    } catch {
      serialized = 'unserializable-tool-input'
    }
  }
  return createHash('sha256').update(serialized, 'utf8').digest('hex')
}

export type RiskGateRequestFailure = 'INPUT_INVALID'

export type RiskGatePreparedRequest =
  | {
      readonly ok: true
      /** The request body; the caller attaches the resolved route's `model`. */
      readonly request: Omit<NativeDecisionRequest, 'model'>
    }
  | { readonly ok: false; readonly reasonCode: RiskGateRequestFailure }

const RISK_LEVELS = Object.freeze(
  Array.from({ length: J1_RISK_SCORE_LEVEL_COUNT }, (_, index) => {
    const labels = ['routine', 'low', 'moderate', 'high', 'critical'] as const
    return Object.freeze({ label: labels[index] ?? `level-${index}` })
  }),
)

const RISK_INSTRUCTIONS =
  'Rate how risky this single tool call is for the current task, judging only the ' +
  'tool class: routine and reversible at the low end, destructive or exfiltrating ' +
  'at the high end. Advisory only; nothing is enforced.'
const INTENT_INSTRUCTIONS =
  'Is a call of this tool class plausibly consistent with continuing the current ' +
  'task? Answer as a probability. Advisory only; nothing is enforced.'

const QUESTIONS = Object.freeze([
  Object.freeze({
    type: 'score' as const,
    name: RISK_QUESTION_NAME,
    instructions: RISK_INSTRUCTIONS,
    levels: RISK_LEVELS,
  }),
  Object.freeze({
    type: 'predicate' as const,
    name: INTENT_QUESTION_NAME,
    instructions: INTENT_INSTRUCTIONS,
  }),
])

/**
 * Build the bounded decision request — the sanitization contract made
 * structural. The state is the exact template over the three admitted fields;
 * the tool name must already be a bounded token (paths, metacharacters and
 * prose are `INPUT_INVALID`, never sanitized on the way in); the hash must be
 * lowercase sha256 hex. Two questions only: one score (2–10 levels), one
 * predicate. No file parts, no JSON parts, no extra fields.
 */
export function buildRiskGateRequest(input: {
  readonly toolName: string
  readonly toolInputHash: string
  readonly scope: RiskGateScope
}): RiskGatePreparedRequest {
  const toolName = input?.toolName
  const toolInputHash = input?.toolInputHash
  const scope = input?.scope
  if (scope === undefined || typeof scope !== 'string' || !SCOPES.has(scope)) {
    return { ok: false, reasonCode: 'INPUT_INVALID' }
  }
  if (typeof toolName !== 'string' || !TOOL_NAME_TOKEN.test(toolName)) {
    return { ok: false, reasonCode: 'INPUT_INVALID' }
  }
  if (typeof toolInputHash !== 'string' || !SHA256_HEX.test(toolInputHash)) {
    return { ok: false, reasonCode: 'INPUT_INVALID' }
  }
  const state =
    'Advisory risk probe for one tool call. ' +
    `tool_name: ${toolName}. scope: ${scope}. tool_input_sha256: ${toolInputHash}. ` +
    'The request carries no file paths, no tool arguments and no task content; ' +
    'judge from the tool class alone.'
  if (state.length > J1_RISK_GATE_STATE_MAX_LENGTH) {
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

export interface RiskGateEvaluation {
  /**
   * The host's score for the `risk` question; `null` when the answer is
   * missing, mistyped, duplicated or an error. An ordinal, not a probability.
   */
  readonly riskScore: number | null
  /**
   * Whether the `intent` predicate holds (probability ≥ 0.5); `null` under the
   * same failures.
   */
  readonly intentConsistent: boolean | null
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
export function evaluateRiskGateDecision(
  response: unknown,
  request: NativeDecisionRequest,
): RiskGateEvaluation {
  const advice = consumeJevDecisionResult(response, request)
  let riskScore: number | null = null
  let intentConsistent: boolean | null = null
  for (const answer of advice.answers) {
    if (answer.type === 'error') continue
    if (answer.type === 'score' && answer.name === RISK_QUESTION_NAME) {
      riskScore = answer.score ?? null
    } else if (answer.type === 'predicate' && answer.name === INTENT_QUESTION_NAME) {
      intentConsistent = (answer.probability ?? 0) >= RISK_GATE_INTENT_THRESHOLD
    }
  }
  return { riskScore, intentConsistent }
}

export type RiskGateVerdict = 'observe' | 'flag'

/**
 * The policy: in shadow mode the verdict is ALWAYS `observe` — for every risk
 * score, for every intent answer, for nulls. Shadow never denies and never
 * asks; a high score changes the record's reason, nothing else. The `flag`
 * verdict ({@link RISK_GATE_FLAG_VERDICT}) is reserved for a future active
 * phase and is unreachable here by construction: `shadow` admits only `true`
 * and no branch below returns anything but `observe`.
 */
export function riskGateVerdict(input: {
  readonly riskScore: number | null
  readonly intentConsistent: boolean | null
  readonly shadow: true
}): RiskGateVerdict {
  void input // every evaluation is admitted while the gate is shadow-only
  return 'observe'
}

function formatScoreToken(value: number): string {
  if (!Number.isFinite(value) || value < 0 || value > 1000) return 'na'
  const text = String(Math.round(value * 100) / 100)
  return TOOL_NAME_TOKEN.test(text) ? text : 'na'
}

/**
 * Encode the evaluation into ONE telemetry reason token (the sink's allowlist
 * has no slot for structured fields, and that is its strength): e.g.
 * `risk-3-intent-yes`, `risk-na-intent-na`. Always a bounded
 * `[A-Za-z0-9._:-]` token; a score outside 0..1000 or not finitely
 * representable encodes as `na`.
 */
export function encodeRiskGateReason(input: {
  readonly riskScore: number | null
  readonly intentConsistent: boolean | null
}): string {
  const score = input.riskScore === null ? 'na' : formatScoreToken(input.riskScore)
  const intent = input.intentConsistent === null ? 'na' : input.intentConsistent ? 'yes' : 'no'
  return `risk-${score}-intent-${intent}`
}

const SKIP_REASON_BY_GATE_FAILURE: Readonly<Record<GatedNativeJevFailure, string>> = Object.freeze({
  CONTEXT_UNAVAILABLE: 'skip-context-unavailable',
  CONFIG_UNAVAILABLE: 'skip-config-unavailable',
  DISABLED: 'skip-config-disabled',
  CONSENT_MISSING: 'skip-consent-missing',
  CAP_OR_PERIOD_DENIED: 'skip-reservation-denied',
  NO_ELIGIBLE_CANDIDATE: 'skip-route-unavailable',
  PERMISSION_UNAVAILABLE: 'skip-permission-unavailable',
  PERMISSION_DENIED: 'skip-permission-denied',
  STATE_INVALID: 'skip-request-invalid',
  QUESTIONS_INVALID: 'skip-request-invalid',
  PRESET_INVALID: 'skip-request-invalid',
  RESERVATION_DENIED: 'skip-reservation-denied',
  DECISION_CALL_FAILED: 'skip-decision-call-failed',
  USAGE_EVIDENCE_UNAVAILABLE: 'skip-usage-evidence-unavailable',
  USAGE_UNRECONCILED: 'skip-usage-unreconciled',
  ORDER_INPUT_INVALID: 'skip-request-invalid',
  ORDER_CANDIDATE_INVALID: 'skip-request-invalid',
})

/** Map a gate failure to its telemetry reason token; unknown → fail-open. */
export function mapGateFailureToSkipReason(reasonCode: string): string {
  return SKIP_REASON_BY_GATE_FAILURE[reasonCode as GatedNativeJevFailure] ?? 'skip-gate-unavailable'
}

/** The `execute.before` fields the observer reads; `input` is hashed, never read. */
interface J1ExecuteBeforeEvent {
  tool?: unknown
  sessionID?: unknown
  messageID?: unknown
  agent?: unknown
  input?: unknown
}

export interface J1RiskGateObserverOptions {
  /** The same runtime the `pantheon_jev_decide` tool uses. */
  readonly runtime: GatedNativeJevRuntime
  /** Shadow-record sink (the plugin wraps it with the telemetry mode). */
  readonly sink?: ShadowSink
  readonly timeoutMs?: number
}

function recordSkip(sink: ShadowSink | undefined, skipReason: string): void {
  observeShadow(
    J1_RISK_GATE_POINT,
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
 * Create the J1 observer: one async, self-bounding observation per
 * `execute.before` event. The returned function NEVER throws and NEVER
 * records more than one shadow record per event; a read-scope or malformed
 * event records nothing at all.
 *
 * The gate chain runs unawaited races against the deadline; on timeout the
 * observer records `skip-timeout` and abandons while the abandoned chain
 * settles its own ledger reservation in the background (settlement of an
 * already-fired call — not a retry, and it writes no record).
 */
export interface J1Verdict {
  /** 'block' only in enforce mode with an affirmative high-risk score. */
  block: boolean
  riskScore: number | null
  reason: string
}

export function createJ1RiskGateObserver(
  options: J1RiskGateObserverOptions & {
    /** enforce: the caller awaits and denies on { block: true }. */
    mode?: J1RiskGateMode
    threshold?: number
  },
): (event: unknown) => Promise<J1Verdict | undefined> {
  const timeoutMs = options.timeoutMs ?? J1_RISK_GATE_TIMEOUT_MS
  const sink = options.sink
  const enforce = options.mode === 'enforce'
  const threshold = options.threshold ?? J1_ENFORCE_THRESHOLD_DEFAULT
  return async (event: unknown): Promise<J1Verdict | undefined> => {
    try {
      const payload = (event ?? {}) as J1ExecuteBeforeEvent
      if (!isRiskGateTarget(payload.tool)) return undefined
      const tool = payload.tool
      const scope = classifyRiskGateScope(tool)
      const built = buildRiskGateRequest({
        toolName: tool,
        toolInputHash: hashToolInput(payload.input),
        scope,
      })
      if (!built.ok) {
        recordSkip(sink, 'skip-input-invalid')
        return undefined
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
          return undefined
        }
        if (!outcome.ok) {
          recordSkip(sink, mapGateFailureToSkipReason(outcome.reasonCode))
          return undefined
        }
        const evaluation = evaluateRiskGateDecision(outcome.call.response, outcome.call.request)
        observeShadow(
          J1_RISK_GATE_POINT,
          evaluation,
          (isolated) => ({
            decision: 'observe',
            reason: encodeRiskGateReason(isolated as RiskGateEvaluation),
          }),
          sink,
        )
        if (enforce) {
          const risk = evaluation.riskScore
          const block = risk !== null && risk >= threshold
          return {
            block,
            riskScore: risk,
            reason: block
              ? `J1 enforce: risco ${risk.toFixed(2)} >= threshold ${threshold}`
              : 'allow',
          }
        }
        return
      } finally {
        clearTimeout(timer)
      }
    } catch {
      // Fail-open: the gate chain rejects only when the budget ledger cannot
      // be opened; any other unexpected failure lands here too. One skip
      // record, no detail, no propagation into the tool call.
      recordSkip(sink, 'skip-gate-unavailable')
      return undefined
    }
  }
}
