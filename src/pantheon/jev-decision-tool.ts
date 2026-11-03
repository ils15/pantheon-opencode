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
  consumeJevDecisionResult,
  isJevDecisionPreset,
  type JevDecisionPreparation,
  type JevHostSkill,
  type NativeJevRouteFailure,
  type NativeJevRouteSelection,
  prepareJevDecisionRequest,
  prepareJevPresetRequest,
  resolveNativeJevRoute,
} from './jev-decisions.ts'
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
   * Raw host skill registry (`ctx.skill.list()`); optional. Its entries extend
   * the skills preset so installed Agent Skills become decidable.
   */
  readonly listSkills?: () => Promise<unknown>
  /** Host permission kill-switch (`ctx.permission.assert`), when present. */
  readonly permissionAssert?: (input: Record<string, unknown>) => Promise<unknown>
}

/** Logical permission resource: no endpoint URL exists on the native route. */
export function nativeJevPermissionResource(providerID: string, id: string): string {
  return `pantheon-native-decisions://${providerID}/${id}`
}

export type JevDecisionRunFailure =
  | 'CALLER_NOT_ZEUS'
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
  | 'USAGE_UNRECONCILED'

interface JevToolContext {
  sessionID?: unknown
  messageID?: unknown
  agent?: unknown
}

function refusal(reasonCode: JevDecisionRunFailure): string {
  return JSON.stringify({ advisory: false, effect: 'none', reasonCode })
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

// ─── Shared gate chain ───────────────────────────────────────────────────

/**
 * Every gate-chain failure the shared runner can produce. It is
 * {@link JevDecisionRunFailure} minus `CALLER_NOT_ZEUS`: the caller check is a
 * property of the explicit tool surface, not of the gate chain, so the J1
 * shadow observer can run the same chain for any agent.
 */
export type GatedNativeJevFailure = Exclude<JevDecisionRunFailure, 'CALLER_NOT_ZEUS'>

/** The minimal runtime slice the gate chain needs. */
export type GatedNativeJevRuntime = Pick<V2JevDecisionRuntime, 'decide'> & {
  /** Host permission kill-switch (`ctx.permission.assert`), when present. */
  readonly permissionAssert?: (input: Record<string, unknown>) => Promise<unknown>
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
      return {
        ok: false,
        reasonCode: 'DECISION_CALL_FAILED',
        detail: err instanceof Error ? err.name : 'UnknownFailure',
      }
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
  if (context?.agent !== 'zeus') return refusal('CALLER_NOT_ZEUS')

  const requested = (input ?? {}) as { mode?: unknown; questions?: unknown }
  const result = await runGatedNativeJevCall({
    sessionID: context?.sessionID,
    messageID: context?.messageID,
    agent: 'zeus',
    runtime,
    prepare: async (route) =>
      requested.mode === undefined
        ? prepareJevDecisionRequest(route, input ?? {})
        : isJevDecisionPreset(requested.mode)
          ? prepareJevPresetRequest(
              route,
              requested.mode,
              input ?? {},
              requested.mode === 'skills' ? await readHostSkills(runtime) : undefined,
            )
          : { ok: false as const, reasonCode: 'PRESET_INVALID' as const },
  })
  if (!result.ok) {
    if (result.detail === undefined) return refusal(result.reasonCode)
    // Refusal with the error CLASS only (`TypeError`, `RangeError`, …): the
    // message can carry paths, config or provider detail and never crosses
    // into the chat.
    return JSON.stringify({
      advisory: false,
      effect: 'none',
      reasonCode: result.reasonCode,
      detail: result.detail,
    })
  }

  const advice = consumeJevDecisionResult(result.call.response, result.call.request)
  return JSON.stringify({
    advisory: true,
    effect: 'none',
    reason: 'JEV_DECISION',
    route: {
      providerID: result.call.selection.route.model.providerID,
      id: result.call.selection.route.model.id,
      billing: result.call.selection.route.billing,
    },
    ...(requested.mode === undefined ? {} : { preset: requested.mode }),
    answers: advice.answers,
    missing: advice.missing,
    usage: { costUsd: advice.costUsd, tokens: advice.tokens },
    frozen: result.call.frozen,
  })
}

const TOOL_DESCRIPTION =
  'Zeus-only advisory typed decisions via the host native Jev route (OpenCode Console or a ' +
  'configured decision model). Two ways to ask: pass `mode: "skills"` to stack skills for the ' +
  'state text (local prefilter shortlist, catalog fallback, plus every skill installed in the ' +
  'host), `mode: "delegation"` to pick ' +
  'a specialist, or pass explicit typed `questions` (choice, score, predicate). Returns ' +
  'probabilistic answers with confidence. Requires decision-router egress consent and budget ' +
  'caps; asks host permission first. It never dispatches agents, runs skills, executes tools, ' +
  'or alters permissions — results are advisory only.'

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

const JEV_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'state'],
  properties: {
    schemaVersion: { type: 'integer', const: 1 },
    state: { type: 'string', minLength: 1, maxLength: 12_000 },
    mode: { type: 'string', enum: ['skills', 'delegation'] },
    questions: { type: 'array', minItems: 1, maxItems: 4, items: questionSchema },
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
