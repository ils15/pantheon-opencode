/**
 * The explicit V2 tool surface for native Jev Decisions.
 *
 * This is the one production call site for the native Decisions scaffold. The
 * surface is an explicit tool invocation, which resolves the hook path's
 * correlation problem by construction: the model calls the tool during its own
 * turn, so there is no queued/steer ambiguity to prove. Egress still passes the
 * full gate chain before the host's `experimental.generate.decisions` is ever
 * invoked — user-level config (`enabled`, `egress_consent`), exactly one
 * cap-valid native candidate from the budget ledger, the host permission
 * kill-switch on the `decision.egress` action, and the bounded request
 * preparer. Transport is the host's own provider layer: this module never
 * touches fetch, endpoints, or credentials.
 *
 * The gate chain lives in {@link runGatedNativeJevCall} so a second caller (the
 * J1 risk-score shadow gate in `jev-risk-gate.ts`) reuses the exact same
 * config → route → permission → reserve → decide → reconcile sequence instead
 * of duplicating it; only the request preparer is caller-supplied.
 *
 * Settlement follows the fetch runner's fail-closed contract: reserve before
 * the call, reconcile from the host-reported cost after it, and leave the
 * reservation pending (budget held for the period) when no evidence can be
 * minted. A failed or unreconciled call is a refusal, never a retry.
 */
import { readUserDecisionRouterConfig } from '../../scripts/install/decision-router-config.mjs'
import {
  checkJevEnvelope,
  consumeJevDecisionResult,
  isJevDecisionPreset,
  JEV_EXPLICIT_ENVELOPE_KEYS,
  JEV_PRESET_ENVELOPE_KEYS,
  type JevDecisionPreparation,
  type JevHostSkill,
  type NativeJevRouteFailure,
  type NativeJevRouteSelection,
  prepareJevDecisionRequest,
  prepareJevPresetRequest,
  resolveNativeJevRoute,
} from './jev-decisions.ts'
import {
  buildJevReviewRequest,
  encodeQualityScoreReason,
  evaluateQualityScoreDecision,
  J4_QUALITY_SCORE_POINT,
  type QualityScoreEvaluation,
  qualityVerdict,
  REVIEW_ENVELOPE_KEYS,
} from './jev-quality-score.ts'
import {
  buildJevRankRequest,
  buildJevVerifyRequest,
  consumeJevRankResult,
  consumeJevVerifyResult,
  RANK_ENVELOPE_KEYS,
  VERIFY_ENVELOPE_KEYS,
} from './jev-rank-verify.ts'
import { mapGateFailureToSkipReason } from './jev-risk-gate.ts'
import {
  openLocalDecisionBudgetLedger,
  type ReservationResult,
  resolveLocalDecisionBudgetDbPath,
} from './local-decision-budget.ts'
import {
  assertDecisionEgressPermission,
  buildDecisionEgressRequest,
} from './local-decision-egress-gate.ts'
import { verifyNativeUsageForReservation } from './local-decision-usage-evidence.internal.ts'
import { observeShadow, type ShadowSink } from './v2-decision-shadow.ts'
import type { NativeDecisionRequest, ResolvedNativeDecisionRoute } from './v2-native-decisions.ts'
import type { V2ToolDef } from './v2-tools.ts'

export interface V2JevDecisionRuntime {
  /**
   * Raw host model catalog (`ctx.model.list`); still wired, but the route no
   * longer consults it — field evidence (2.2.5): decision models are not chat
   * models and never appear in the catalog. Removed with the 2.0 runtime
   * reshaping.
   */
  readonly listModels: () => Promise<unknown>
  /** The host's native Decisions API (`ctx.experimental.generate.decisions`). */
  readonly decide: (request: NativeDecisionRequest) => Promise<unknown>
  /**
   * Allowlisted specialist callers for explicit-questions mode (parsed from
   * `PANTHEON_JEV_SPECIALIST_CALLERS` by the plugin wiring). Empty/absent =
   * Zeus only. Preset and v3.1 modes (skills, delegation, review, rank,
   * verify) stay Zeus-only regardless.
   */
  readonly specialistCallers?: readonly string[]
  /**
   * Raw host skill registry (`ctx.skill.list()`); optional. Its entries extend
   * the skills preset so installed Agent Skills become decidable.
   */
  readonly listSkills?: () => Promise<unknown>
  /** Host permission kill-switch (`ctx.permission.assert`), when present. */
  readonly permissionAssert?: (input: Record<string, unknown>) => Promise<unknown>
  /**
   * Shadow-record sink for the J4 output-quality review telemetry
   * (`jev-quality-score.ts`); optional. The plugin wires the in-memory,
   * bounded telemetry collector here; absent sink → no J4 records, nothing
   * else changes.
   */
  readonly shadowSink?: ShadowSink
}

/** Logical permission resource: no endpoint URL exists on the native route. */
export function nativeJevPermissionResource(providerID: string, id: string): string {
  return `pantheon-native-decisions://${providerID}/${id}`
}

export const SPECIALIST_CALLERS_FLAG_ENV = 'PANTHEON_JEV_SPECIALIST_CALLERS'

/**
 * Parse the caller allowlist from the flag's CSV value. Unset/empty = Zeus
 * only (the default). Preset and v3.1 modes (skills, delegation, review,
 * rank, verify) stay Zeus-only regardless of the flag: owner/skill selection,
 * result scoring, candidate ranking and claim verification are orchestration
 * decisions; specialists may ask bounded typed questions mid-task, nothing
 * else. Lives in the plugin wiring (which owns flag reads); this module
 * receives the parsed list via the runtime.
 */
export function specialistCallerAllowlist(flagValue: string | undefined): readonly string[] {
  const raw = String(flagValue ?? '').trim()
  if (!raw) return []
  const parsed = raw
    .split(',')
    .map((name) => name.trim())
    .filter((name) => /^[a-z][a-z0-9-]{0,31}$/.test(name))
  return [...new Set(parsed)]
}

export type JevDecisionRunFailure =
  | 'CALLER_NOT_ALLOWED'
  | 'REVIEW_INPUT_INVALID'
  | 'CRITERIA_INVALID'
  | 'RANK_INPUT_INVALID'
  | 'CANDIDATE_INVALID'
  | 'VERIFY_INPUT_INVALID'
  | 'CLAIM_INVALID'
  | 'CONTEXT_UNAVAILABLE'
  | 'CONFIG_UNAVAILABLE'
  | 'DISABLED'
  | 'CONSENT_MISSING'
  | 'CAP_OR_PERIOD_DENIED'
  | NativeJevRouteFailure
  | 'PERMISSION_UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'STATE_INVALID'
  | 'QUESTIONS_INVALID'
  | 'PRESET_INVALID'
  | 'RESERVATION_DENIED'
  | 'DECISION_CALL_FAILED'
  | 'USAGE_EVIDENCE_UNAVAILABLE'
  | 'USAGE_UNRECONCILED'

interface JevToolContext {
  sessionID?: unknown
  messageID?: unknown
  agent?: unknown
}

function refusal(reasonCode: JevDecisionRunFailure, detail?: string): string {
  return JSON.stringify(
    detail === undefined
      ? { advisory: false, effect: 'none', reasonCode }
      : { advisory: false, effect: 'none', reasonCode, detail },
  )
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Map a review-mode refusal to its telemetry skip token. */
function reviewRefusalSkipReason(reasonCode: JevDecisionRunFailure): string {
  if (reasonCode === 'REVIEW_INPUT_INVALID') return 'skip-review-input-invalid'
  if (reasonCode === 'CRITERIA_INVALID') return 'skip-criteria-invalid'
  return mapGateFailureToSkipReason(reasonCode)
}

// ─── Shared gate chain ───────────────────────────────────────────────────

/**
 * Every gate-chain failure the shared runner can produce. It is
 * {@link JevDecisionRunFailure} minus the tool-surface properties:
 * `CALLER_NOT_ALLOWED` (the caller check) and the input validation of the
 * prebuilt-request modes — the review mode (`REVIEW_INPUT_INVALID` /
 * `CRITERIA_INVALID`) and the v3.1 rank and verify modes
 * (`RANK_INPUT_INVALID` / `CANDIDATE_INVALID` / `VERIFY_INPUT_INVALID` /
 * `CLAIM_INVALID`). All of these are properties of the explicit tool surface,
 * whose input the caller supplies directly, not of the gate chain; the
 * J1/J3 shadow observers run the same chain for any agent and can never
 * produce them.
 */
export type GatedNativeJevFailure = Exclude<
  JevDecisionRunFailure,
  | 'CALLER_NOT_ALLOWED'
  | 'REVIEW_INPUT_INVALID'
  | 'CRITERIA_INVALID'
  | 'RANK_INPUT_INVALID'
  | 'CANDIDATE_INVALID'
  | 'VERIFY_INPUT_INVALID'
  | 'CLAIM_INVALID'
>

/** The minimal runtime slice the gate chain needs. */
export type GatedNativeJevRuntime = Pick<V2JevDecisionRuntime, 'decide'> & {
  /** Host permission kill-switch (`ctx.permission.assert`), when present. */
  readonly permissionAssert?: (input: Record<string, unknown>) => Promise<unknown>
  /**
   * Allowlisted specialist callers for explicit-questions mode (parsed from
   * `PANTHEON_JEV_SPECIALIST_CALLERS` by the plugin wiring). Empty/absent =
   * Zeus only. Preset modes stay Zeus-only regardless.
   */
  readonly specialistCallers?: readonly string[]
}

/** One completed, settled native Jev call: gates passed, usage reconciled. */
export interface GatedNativeJevCall {
  /** The route the config + ledger gates selected. */
  readonly selection: NativeJevRouteSelection
  /** The prepared, bounded request this call ran. */
  readonly request: NativeDecisionRequest
  /** The raw host response; consume it through `consumeJevDecisionResult`. */
  readonly response: unknown
  /** The frozen ledger reconciliation state. */
  readonly frozen: boolean
}

export type GatedNativeJevCallResult =
  | { readonly ok: true; readonly call: GatedNativeJevCall }
  | {
      readonly ok: false
      readonly reasonCode: GatedNativeJevFailure
      /** Sanitized error CLASS only (`TypeError`, …); set for call failures. */
      readonly detail?: string
      /** Host's provider-layer reason class (`rate_limit`, …); no message text. */
      readonly providerReason?: string
      /** Integer HTTP status from the provider layer, when the host sets one. */
      readonly status?: number
      /** Positive retry window in ms, when the host sets one (rate limits). */
      readonly retryAfterMs?: number
    }

/**
 * Run ONE native Jev decision through the full gate chain — the exact chain
 * `runJevDecision` has always run, extracted so a second caller (the J1
 * risk-score shadow gate) reuses it instead of duplicating it:
 * user-level config (`enabled`, `egress_consent`) → route via
 * `resolveNativeJevRoute` with the ledger's admission check → host permission
 * kill-switch on `decision.egress` → caller-supplied request preparation →
 * reservation → the single host call → usage verification and reconciliation.
 *
 * The request preparer is injected because the two callers prepare differently
 * (the tool from model input, J1 from a prebuilt bounded request); everything
 * before and after it is shared. Settlement keeps the fetch runner's
 * fail-closed contract: reserve before the call, reconcile from the
 * host-reported cost after it, leave the reservation pending when no evidence
 * can be minted.
 *
 * Rejects only when the budget ledger itself cannot be opened (the explicit
 * tool surface propagates that as a tool error, unchanged); every gate failure
 * is a structured `{ ok: false }` result, never a throw.
 */
export async function runGatedNativeJevCall(params: {
  readonly sessionID: unknown
  readonly messageID: unknown
  /** Current agent, only when the caller actually knows it. */
  readonly agent?: unknown
  readonly runtime: GatedNativeJevRuntime
  readonly prepare: (
    route: ResolvedNativeDecisionRoute,
  ) => JevDecisionPreparation | Promise<JevDecisionPreparation>
}): Promise<GatedNativeJevCallResult> {
  if (!isNonBlankString(params.sessionID) || !isNonBlankString(params.messageID)) {
    return { ok: false, reasonCode: 'CONTEXT_UNAVAILABLE' }
  }
  const sessionID = params.sessionID
  const messageID = params.messageID
  const agent =
    typeof params.agent === 'string' && params.agent.trim().length > 0 ? params.agent : undefined

  let config: ReturnType<typeof readUserDecisionRouterConfig>
  try {
    config = readUserDecisionRouterConfig()
  } catch {
    return { ok: false, reasonCode: 'CONFIG_UNAVAILABLE' }
  }
  if (!config.enabled) return { ok: false, reasonCode: 'DISABLED' }
  if (!config.egress_consent) return { ok: false, reasonCode: 'CONSENT_MISSING' }

  const ledger = openLocalDecisionBudgetLedger({ dbPath: resolveLocalDecisionBudgetDbPath() })
  try {
    const selection = resolveNativeJevRoute(
      config,
      (provider, model) => ledger.canReserve(provider, model).status === 'eligible',
    )
    if (!selection.ok) return { ok: false, reasonCode: selection.reasonCode }

    // Cloudflare Workers AI has no supported native-usage evidence parser yet.
    // Reject its Jev route before permission, request preparation, or budget
    // reservation; otherwise the provider could be called and leave a pending
    // reservation when reconciliation cannot be verified.
    if (selection.selection.provider === 'cloudflare-workers-jev') {
      return { ok: false, reasonCode: 'USAGE_EVIDENCE_UNAVAILABLE' }
    }

    if (typeof params.runtime.permissionAssert !== 'function') {
      return { ok: false, reasonCode: 'PERMISSION_UNAVAILABLE' }
    }
    const assertion = await assertDecisionEgressPermission(
      params.runtime.permissionAssert,
      buildDecisionEgressRequest({
        sessionID,
        messageID,
        endpoint: nativeJevPermissionResource(
          selection.selection.route.model.providerID,
          selection.selection.route.model.id,
        ),
        ...(agent === undefined ? {} : { agent }),
      }),
    )
    if (assertion === 'deny') return { ok: false, reasonCode: 'PERMISSION_DENIED' }

    const prepared = await params.prepare(selection.selection.route)
    if (!prepared.ok) return { ok: false, reasonCode: prepared.reasonCode }

    const reservation: ReservationResult = ledger.reserve(
      selection.selection.accountingProvider,
      selection.selection.model,
    )
    if (reservation.status !== 'reserved') return { ok: false, reasonCode: 'RESERVATION_DENIED' }

    let response: unknown
    try {
      response = await params.runtime.decide(prepared.request)
    } catch (err) {
      // Provider-layer errors carry bounded, non-content facts that change
      // what the user does next: the host's reason class (`rate_limit` vs
      // auth vs unknown) and, for rate limits, the retry window. The error
      // message text NEVER crosses (it carries URLs and subscription prose).
      const failure: {
        ok: false
        reasonCode: 'DECISION_CALL_FAILED'
        detail: string
        providerReason?: string
        status?: number
        retryAfterMs?: number
      } = {
        ok: false,
        reasonCode: 'DECISION_CALL_FAILED',
        detail: err instanceof Error ? err.name : 'UnknownFailure',
      }
      const errRecord = err as { reason?: unknown; status?: unknown; retryAfterMs?: unknown }
      if (typeof errRecord.reason === 'string' && /^[a-z_]{1,32}$/i.test(errRecord.reason)) {
        failure.providerReason = errRecord.reason
      }
      if (typeof errRecord.status === 'number' && Number.isInteger(errRecord.status)) {
        failure.status = errRecord.status
      }
      if (
        typeof errRecord.retryAfterMs === 'number' &&
        Number.isFinite(errRecord.retryAfterMs) &&
        errRecord.retryAfterMs > 0
      ) {
        failure.retryAfterMs = Math.round(errRecord.retryAfterMs)
      }
      return failure
    }

    const evidence = verifyNativeUsageForReservation(
      {
        reservationId: reservation.reservationId,
        provider: selection.selection.accountingProvider,
        model: selection.selection.model,
        period: reservation.period,
      },
      response,
    )
    if (evidence === null) return { ok: false, reasonCode: 'USAGE_UNRECONCILED' }
    const reconciliation = ledger.reconcileVerified(reservation.reservationId, evidence)
    if (reconciliation.status !== 'reconciled') {
      return { ok: false, reasonCode: 'USAGE_UNRECONCILED' }
    }

    return {
      ok: true,
      call: {
        selection: selection.selection,
        request: prepared.request,
        response,
        frozen: reconciliation.frozen,
      },
    }
  } finally {
    ledger.close()
  }
}

/**
 * Read the host's installed skills for the stacking preset. Anything that is
 * not a plain {id, description?} record is skipped; a missing or hostile
 * registry degrades to the catalog-only preset. Reading the registry applies
 * no trust: installation already was the user's manual, reviewed act.
 */
async function readHostSkills(runtime: V2JevDecisionRuntime): Promise<JevHostSkill[] | undefined> {
  if (typeof runtime.listSkills !== 'function') return undefined
  let raw: unknown
  try {
    raw = await runtime.listSkills()
  } catch {
    return undefined
  }
  if (!Array.isArray(raw)) return undefined
  const skills: JevHostSkill[] = []
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as { id?: unknown; description?: unknown }
    if (typeof record.id !== 'string' || record.id.length === 0) continue
    skills.push({
      id: record.id,
      ...(typeof record.description === 'string' && record.description.length > 0
        ? { description: record.description }
        : {}),
    })
  }
  return skills
}

/**
 * Run one explicit, gate-checked native Jev decision. Every failure path
 * returns a bounded refusal JSON; the only caller-visible success output is
 * the validated advice with `effect: 'none'`.
 *
 * The `mode: "review"` branch (J4 output-quality scoring, advisory only)
 * validates and builds its bounded request BEFORE the gate chain — the same
 * prebuilt-request pattern the J1/J3 observers use — so a malformed review
 * never spends gate work, and its failure codes stay tool-surface properties.
 * It records ONE J4 telemetry record per run (q-token on an answered review,
 * skip tokens on every refusal path) and returns the evaluation plus the
 * verdict flag; the verdict never blocks, retries, or alters anything.
 */
export async function runJevDecision(
  input: unknown,
  toolContext: unknown,
  runtime: V2JevDecisionRuntime,
): Promise<string> {
  const context =
    toolContext !== null && typeof toolContext === 'object' && !Array.isArray(toolContext)
      ? (toolContext as JevToolContext)
      : undefined
  const caller = context?.agent
  if (typeof caller !== 'string' || caller.length === 0)
    return refusal('CALLER_NOT_ALLOWED', 'CALLER_NOT_ALLOWLISTED')
  const allowlist = runtime.specialistCallers ?? []
  if (caller !== 'zeus' && !allowlist.includes(caller)) {
    return refusal(
      'CALLER_NOT_ALLOWED',
      'CALLER_NOT_ALLOWLISTED — allowlist this caller via PANTHEON_JEV_SPECIALIST_CALLERS (then restart) or ask Zeus to route',
    )
  }

  const requested = (input ?? {}) as { mode?: unknown; questions?: unknown }
  // Preset modes stay orchestrator-owned even when the flag widens the
  // caller matrix: owner/skill selection and result scoring are
  // orchestration decisions; allowlisted specialists may ask bounded typed
  // questions only.
  if (caller !== 'zeus' && requested.mode !== undefined) {
    return refusal('CALLER_NOT_ALLOWED')
  }
  // The ONE envelope gate every path passes through before its builder:
  // schemaVersion required, unknown keys rejected — explicit questions,
  // presets, review, rank and verify alike (beta.10 claimed this contract;
  // beta.12 applies it uniformly). Builders keep their semantic checks.
  const envelopeKeys =
    requested.mode === undefined
      ? JEV_EXPLICIT_ENVELOPE_KEYS
      : requested.mode === 'review'
        ? REVIEW_ENVELOPE_KEYS
        : requested.mode === 'rank'
          ? RANK_ENVELOPE_KEYS
          : requested.mode === 'verify'
            ? VERIFY_ENVELOPE_KEYS
            : isJevDecisionPreset(requested.mode)
              ? JEV_PRESET_ENVELOPE_KEYS
              : undefined
  if (envelopeKeys !== undefined) {
    const envelope = checkJevEnvelope(input, envelopeKeys)
    if (!envelope.ok) {
      const reasonCode: JevDecisionRunFailure =
        requested.mode === undefined
          ? 'QUESTIONS_INVALID'
          : requested.mode === 'review'
            ? 'REVIEW_INPUT_INVALID'
            : requested.mode === 'rank'
              ? 'RANK_INPUT_INVALID'
              : requested.mode === 'verify'
                ? 'VERIFY_INPUT_INVALID'
                : 'PRESET_INVALID'
      return refusal(reasonCode, envelope.detail)
    }
  }

  // Review mode (J4): the bounded request is built before any gate work, and
  // an invalid review input is a tool-surface refusal — same class as the
  // caller check, never a gate failure. The v3.1 rank and verify modes follow
  // the same prebuilt-request pattern (no gate work for a malformed input);
  // neither has a telemetry point — they are tool modes, not shadow gates.
  let prebuilt: Omit<NativeDecisionRequest, 'model'> | undefined
  let candidateSource: JevDecisionPreparation['candidateSource'] | undefined
  if (requested.mode === 'review') {
    const prepared = buildJevReviewRequest(input ?? {})
    if (!prepared.ok) {
      observeShadow(
        J4_QUALITY_SCORE_POINT,
        prepared.reasonCode,
        () => ({
          decision: 'unavailable',
          reason: reviewRefusalSkipReason(prepared.reasonCode),
        }),
        runtime.shadowSink,
      )
      return refusal(prepared.reasonCode)
    }
    prebuilt = prepared.request
  } else if (requested.mode === 'rank') {
    const prepared = buildJevRankRequest(input ?? {})
    if (!prepared.ok) return refusal(prepared.reasonCode, prepared.detail)
    prebuilt = prepared.request
  } else if (requested.mode === 'verify') {
    const prepared = buildJevVerifyRequest(input ?? {})
    if (!prepared.ok) return refusal(prepared.reasonCode)
    prebuilt = prepared.request
  }
  const result = await runGatedNativeJevCall({
    sessionID: context?.sessionID,
    messageID: context?.messageID,
    agent: caller,
    runtime,
    prepare: async (route) =>
      prebuilt !== undefined
        ? {
            ok: true as const,
            request: {
              model: route.model,
              input: prebuilt.input,
              questions: prebuilt.questions,
            },
          }
        : requested.mode === undefined
          ? prepareJevDecisionRequest(route, input ?? {})
          : isJevDecisionPreset(requested.mode)
            ? (async () => {
                const prepared = prepareJevPresetRequest(
                  route,
                  requested.mode,
                  input ?? {},
                  requested.mode === 'skills' ? await readHostSkills(runtime) : undefined,
                )
                if (prepared.ok) candidateSource = prepared.candidateSource
                return prepared
              })()
            : { ok: false as const, reasonCode: 'PRESET_INVALID' as const },
  })
  if (!result.ok) {
    if (requested.mode === 'review') {
      // The review observed a gate refusal: one skip record, the refusal
      // itself is unchanged.
      observeShadow(
        J4_QUALITY_SCORE_POINT,
        result.reasonCode,
        () => ({
          decision: 'unavailable',
          reason: reviewRefusalSkipReason(result.reasonCode),
        }),
        runtime.shadowSink,
      )
    }
    if (result.detail === undefined && result.providerReason === undefined) {
      return refusal(result.reasonCode)
    }
    // Refusal with the error CLASS only (`TypeError`, `RangeError`, …) plus
    // the bounded provider facts (`rate_limit`, status, retry window): the
    // message can carry paths, config or provider detail and never crosses
    // into the chat.
    return JSON.stringify({
      advisory: false,
      effect: 'none',
      reasonCode: result.reasonCode,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
      ...(result.providerReason === undefined ? {} : { providerReason: result.providerReason }),
      ...(result.status === undefined ? {} : { status: result.status }),
      ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }),
    })
  }

  const advice = consumeJevDecisionResult(result.call.response, result.call.request)
  if (requested.mode === 'review') {
    // J4 advisory evaluation: strict validation, the verdict is telemetry
    // plus a returned flag — it never blocks, retries, or alters the result.
    const evaluation: QualityScoreEvaluation = evaluateQualityScoreDecision(
      result.call.response,
      result.call.request,
    )
    observeShadow(
      J4_QUALITY_SCORE_POINT,
      evaluation,
      (isolated) => {
        const scored = isolated as QualityScoreEvaluation
        return {
          decision: qualityVerdict(scored),
          reason: encodeQualityScoreReason(scored),
        }
      },
      runtime.shadowSink,
    )
    return JSON.stringify({
      advisory: true,
      effect: 'none',
      reason: 'JEV_DECISION',
      caller,
      route: {
        providerID: result.call.selection.route.model.providerID,
        id: result.call.selection.route.model.id,
        billing: result.call.selection.route.billing,
      },
      mode: 'review',
      quality: evaluation.quality,
      needsReview: evaluation.needsReview,
      verdict: qualityVerdict(evaluation),
      answers: advice.answers,
      missing: advice.missing,
      usage: { costUsd: advice.costUsd, tokens: advice.tokens },
      frozen: result.call.frozen,
    })
  }
  if (requested.mode === 'rank') {
    // v3.1 rank: the winner choice plus that candidate's fit score. The host
    // API answers one scalar per question, so no runner-up or full ordering is
    // returned — see jev-rank-verify.ts for the honest limitation.
    const rank = consumeJevRankResult(result.call.response, result.call.request)
    return JSON.stringify({
      advisory: true,
      effect: 'none',
      reason: 'JEV_DECISION',
      caller,
      route: {
        providerID: result.call.selection.route.model.providerID,
        id: result.call.selection.route.model.id,
        billing: result.call.selection.route.billing,
      },
      mode: 'rank',
      winner: rank.winner,
      winnerFit: rank.winnerFit,
      answers: advice.answers,
      missing: advice.missing,
      usage: { costUsd: advice.costUsd, tokens: advice.tokens },
      frozen: result.call.frozen,
    })
  }
  if (requested.mode === 'verify') {
    // v3.1 verify: one PASS/FAIL/BLOCK verdict per claim, fail-closed. The
    // tool never acts on the verdicts; a caller that requires a verdict
    // treats a refusal (which never reaches this branch) as BLOCK.
    const results = consumeJevVerifyResult(result.call.response, result.call.request)
    return JSON.stringify({
      advisory: true,
      effect: 'none',
      reason: 'JEV_DECISION',
      caller,
      route: {
        providerID: result.call.selection.route.model.providerID,
        id: result.call.selection.route.model.id,
        billing: result.call.selection.route.billing,
      },
      mode: 'verify',
      results,
      answers: advice.answers,
      missing: advice.missing,
      usage: { costUsd: advice.costUsd, tokens: advice.tokens },
      frozen: result.call.frozen,
    })
  }
  return JSON.stringify({
    advisory: true,
    effect: 'none',
    reason: 'JEV_DECISION',
    caller,
    route: {
      providerID: result.call.selection.route.model.providerID,
      id: result.call.selection.route.model.id,
      billing: result.call.selection.route.billing,
    },
    ...(requested.mode === undefined ? {} : { preset: requested.mode }),
    ...(candidateSource === undefined ? {} : { candidateSource }),
    answers: advice.answers,
    missing: advice.missing,
    usage: { costUsd: advice.costUsd, tokens: advice.tokens },
    frozen: result.call.frozen,
  })
}

const TOOL_DESCRIPTION =
  'Zeus-only advisory typed decisions via the host native Jev route (OpenCode Console or a ' +
  'configured decision model). Required: schemaVersion: 1 and a non-empty state (<=12000 chars). ' +
  'Ways to ask: pass `mode: "skills"` to stack skills for the ' +
  'state text (local prefilter shortlist, catalog fallback, plus every skill installed in the ' +
  'host), `mode: "delegation"` to pick ' +
  'a specialist, `mode: "review"` to score a finished delegated result against named criteria ' +
  '(advisory quality score + needs-review flag; the result content itself is never sent — ' +
  'shape metrics and criteria only), `mode: "rank"` to pick the best of 2-20 named candidates ' +
  '(returns the winner and its fit score; no full ordering), `mode: "verify"` to check 1-4 ' +
  'named claims, with optional `state` evidence the claims are judged against ' +
  '(verdicts PASS, FAIL, or UNVERIFIABLE for the 0.35-0.65 band; any refusal, timeout or ' +
  'malformed answer is BLOCK, fail-closed), or pass explicit typed `questions` (choice, score, ' +
  'predicate). Invalid-input refusals carry a `detail` token naming the exact cause. Returns ' +
  'probabilistic answers with confidence. Requires decision-router egress ' +
  'consent and budget caps; asks host permission first. It never dispatches agents, runs ' +
  'skills, executes tools, blocks, retries, or alters permissions — results are advisory only.'

const questionSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'name', 'instructions'],
  properties: {
    type: { type: 'string', enum: ['choice', 'score', 'predicate'] },
    name: { type: 'string', minLength: 1, maxLength: 64 },
    instructions: { type: 'string', minLength: 1, maxLength: 2000 },
    choices: {
      type: 'array',
      minItems: 2,
      maxItems: 16,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['value'],
        properties: {
          value: { type: 'string', minLength: 1, maxLength: 64 },
          description: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
    },
    levels: {
      type: 'array',
      minItems: 2,
      maxItems: 10,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label'],
        properties: {
          label: { type: 'string', minLength: 1, maxLength: 64 },
          description: { type: 'string', minLength: 1, maxLength: 500 },
        },
      },
    },
  },
}

const REVIEW_METRICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['outputChars', 'taskDurationMs'],
  properties: {
    outputChars: { type: 'integer', minimum: 0, maximum: 100_000_000 },
    taskDurationMs: { type: ['integer', 'null'], minimum: 0, maximum: 100_000_000 },
  },
} as const

const RANK_CANDIDATE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$',
    },
    description: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const

const VERIFY_CLAIM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'claim'],
  properties: {
    name: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$',
    },
    claim: { type: 'string', minLength: 1, maxLength: 200 },
  },
} as const

/**
 * One schema, four disjoint payloads: the state branch (presets and explicit
 * questions carry the state text), the review branch (J4 takes structural
 * shape metrics, a delegate id and named criteria — never a state text, never
 * result content; the criteria are the only free text, bounded at the DSH
 * caps: at most 4, each 1–120 chars), the rank branch (v3.1: a state plus
 * 2–8 named candidates) and the verify branch (v3.1: 1–4 named claims, no
 * state). The preparers are the authority; the schema is the model-facing
 * contract.
 */
const JEV_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion'],
  anyOf: [
    { required: ['state'] },
    { required: ['delegateId', 'resultSummaryKind', 'resultMetrics', 'criteria'] },
    { required: ['candidates'] },
    { required: ['claims'] },
  ],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    state: { type: 'string', minLength: 1, maxLength: 12_000 },
    mode: { type: 'string', enum: ['skills', 'delegation', 'review', 'rank', 'verify'] },
    questions: { type: 'array', minItems: 1, maxItems: 4, items: questionSchema },
    delegateId: {
      type: 'string',
      minLength: 1,
      maxLength: 64,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$',
    },
    resultSummaryKind: { type: 'string', enum: ['ok', 'empty', 'error'] },
    resultMetrics: REVIEW_METRICS_SCHEMA,
    criteria: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: { type: 'string', minLength: 1, maxLength: 120 },
    },
    candidates: {
      type: 'array',
      minItems: 2,
      maxItems: 20,
      items: RANK_CANDIDATE_SCHEMA,
    },
    claims: {
      type: 'array',
      minItems: 1,
      maxItems: 4,
      items: VERIFY_CLAIM_SCHEMA,
    },
  },
}

/** Create the V2 tool definition; registration is the caller's decision. */
export function createV2JevDecisionDefinition(runtime: V2JevDecisionRuntime): V2ToolDef {
  return {
    name: 'pantheon_jev_decide',
    description: TOOL_DESCRIPTION,
    input: JEV_INPUT_SCHEMA,
    output: {},
    execute: async (input: Record<string, unknown>, context: unknown) => ({
      output: await runJevDecision(input, context, runtime),
    }),
  }
}
