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
 * Settlement follows the fetch runner's fail-closed contract: reserve before
 * the call, reconcile from the host-reported cost after it, and leave the
 * reservation pending (budget held for the period) when no evidence can be
 * minted. A failed or unreconciled call is a refusal, never a retry.
 */
import { readUserDecisionRouterConfig } from '../../scripts/install/decision-router-config.mjs'
import {
  consumeJevDecisionResult,
  isJevDecisionPreset,
  type JevDecisionCatalogEntry,
  type NativeJevRouteFailure,
  prepareJevDecisionRequest,
  prepareJevPresetRequest,
  resolveNativeJevRoute,
} from './jev-decisions.ts'
import {
  openLocalDecisionBudgetLedger,
  resolveLocalDecisionBudgetDbPath,
} from './local-decision-budget.ts'
import {
  assertDecisionEgressPermission,
  buildDecisionEgressRequest,
} from './local-decision-egress-gate.ts'
import { verifyNativeUsageForReservation } from './local-decision-usage-evidence.internal.ts'
import type { NativeDecisionRequest } from './v2-native-decisions.ts'
import type { V2ToolDef } from './v2-tools.ts'

export interface V2JevDecisionRuntime {
  /** Raw host model catalog (`ctx.model.list`); may resolve to anything. */
  readonly listModels: () => Promise<unknown>
  /** The host's native Decisions API (`ctx.experimental.generate.decisions`). */
  readonly decide: (request: NativeDecisionRequest) => Promise<unknown>
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
  | 'CATALOG_UNAVAILABLE'
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

async function readCatalog(runtime: V2JevDecisionRuntime): Promise<JevDecisionCatalogEntry[]> {
  const raw = await runtime.listModels()
  if (!Array.isArray(raw)) throw new TypeError('Model catalog is not a list')
  const entries: JevDecisionCatalogEntry[] = []
  for (const model of raw) {
    if (model === null || typeof model !== 'object' || Array.isArray(model)) continue
    const record = model as Record<string, unknown>
    if (!isNonBlankString(record.providerID) || !isNonBlankString(record.id)) continue
    if (typeof record.type !== 'string') continue
    entries.push({
      providerID: record.providerID,
      id: record.id,
      type: record.type,
    } as JevDecisionCatalogEntry)
  }
  return entries
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
  const sessionID = context?.sessionID
  const messageID = context?.messageID
  if (!isNonBlankString(sessionID) || !isNonBlankString(messageID)) {
    return refusal('CONTEXT_UNAVAILABLE')
  }

  let config: ReturnType<typeof readUserDecisionRouterConfig>
  try {
    config = readUserDecisionRouterConfig()
  } catch {
    return refusal('CONFIG_UNAVAILABLE')
  }
  if (!config.enabled) return refusal('DISABLED')
  if (!config.egress_consent) return refusal('CONSENT_MISSING')

  let catalog: JevDecisionCatalogEntry[]
  try {
    catalog = await readCatalog(runtime)
  } catch {
    return refusal('CATALOG_UNAVAILABLE')
  }

  const ledger = openLocalDecisionBudgetLedger({ dbPath: resolveLocalDecisionBudgetDbPath() })
  try {
    const selection = resolveNativeJevRoute(
      config,
      catalog,
      (provider, model) => ledger.canReserve(provider, model).status === 'eligible',
    )
    if (!selection.ok) return refusal(selection.reasonCode)

    if (typeof runtime.permissionAssert !== 'function') return refusal('PERMISSION_UNAVAILABLE')
    const assertion = await assertDecisionEgressPermission(
      runtime.permissionAssert,
      buildDecisionEgressRequest({
        sessionID,
        messageID,
        endpoint: nativeJevPermissionResource(
          selection.selection.route.model.providerID,
          selection.selection.route.model.id,
        ),
        agent: 'zeus',
      }),
    )
    if (assertion === 'deny') return refusal('PERMISSION_DENIED')

    const requested = (input ?? {}) as { mode?: unknown; questions?: unknown }
    const prepared =
      requested.mode === undefined
        ? prepareJevDecisionRequest(selection.selection.route, input ?? {})
        : isJevDecisionPreset(requested.mode)
          ? prepareJevPresetRequest(selection.selection.route, requested.mode, input ?? {})
          : { ok: false as const, reasonCode: 'PRESET_INVALID' as const }
    if (!prepared.ok) return refusal(prepared.reasonCode)

    const reservation = ledger.reserve(
      selection.selection.accountingProvider,
      selection.selection.model,
    )
    if (reservation.status !== 'reserved') return refusal('RESERVATION_DENIED')

    let response: unknown
    try {
      response = await runtime.decide(prepared.request)
    } catch {
      return refusal('DECISION_CALL_FAILED')
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
    if (evidence === null) return refusal('USAGE_UNRECONCILED')
    const reconciliation = ledger.reconcileVerified(reservation.reservationId, evidence)
    if (reconciliation.status !== 'reconciled') return refusal('USAGE_UNRECONCILED')

    const advice = consumeJevDecisionResult(response, prepared.request)
    return JSON.stringify({
      advisory: true,
      effect: 'none',
      reason: 'JEV_DECISION',
      route: {
        providerID: selection.selection.route.model.providerID,
        id: selection.selection.route.model.id,
        billing: selection.selection.route.billing,
      },
      ...(requested.mode === undefined ? {} : { preset: requested.mode }),
      answers: advice.answers,
      missing: advice.missing,
      usage: { costUsd: advice.costUsd, tokens: advice.tokens },
      frozen: reconciliation.frozen,
    })
  } finally {
    ledger.close()
  }
}

const TOOL_DESCRIPTION =
  'Zeus-only advisory typed decisions via the host native Jev route (OpenCode Console or a ' +
  'configured decision model). Two ways to ask: pass `mode: "skills"` to stack skills for the ' +
  'state text (local prefilter shortlist, whole catalog fallback), `mode: "delegation"` to pick ' +
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
