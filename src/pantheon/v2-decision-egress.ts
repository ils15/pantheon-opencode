/**
 * V2 decision egress — opt-in only, default OFF (PLAN §7 Fase 7, D11).
 *
 * Two facts this module makes checkable instead of assumed:
 *
 * 1. **The default is off, and "off" is a value.** Every refusal below is a
 *    named reason, not a missing return. Absent configuration is `NO_CONFIG`,
 *    which is deliberately distinct from `DISABLED`: a user who never wrote a
 *    file has not opted in *or* out of anything, and either way nothing egresses.
 *
 * 2. **The provider endpoints are retained inert (UNWIRED).** The fixed
 *    OpenAI/TypeSafe URLs in the private provider matrix stay where they are and
 *    are not wired by this surface. This module asserts no transport of its own
 *    and does not claim the transport was removed — only that it is not wired
 *    here. The removed third-party gateway is not a provider id, not a model row
 *    and not a budget row of the decision router; that absence is asserted from
 *    the config maps in the egress tests, not from this module.
 *
 * Selection cardinality is delegated to `explainUserDecisionRouterAutoSelection`
 * (D5), so 0, 1 and 2+ eligible candidates are three distinct outcomes here too
 * and an ambiguous Auto selection can never be read as "the single one".
 *
 * The gate is pure: no clock, no filesystem, no network, no ledger write. The
 * caller supplies the configuration and the cap-eligible candidates.
 */
import {
  type AutoSelectionExplanation,
  explainUserDecisionRouterAutoSelection,
  migrateUserDecisionRouterConfig,
  type UserDecisionRouterCandidate,
  type UserDecisionRouterConfig,
} from '../../scripts/install/decision-router-config.mjs'

/** Egress is off unless every gate below is explicitly satisfied. */
export const V2_DECISION_EGRESS_DEFAULT = 'off' as const

export type V2DecisionEgressOffReason =
  | 'NO_CONFIG'
  | 'DISABLED'
  | 'LOCAL_SELECTION'
  | 'CONSENT_MISSING'
  | 'NO_ELIGIBLE_CANDIDATE'
  | 'AMBIGUOUS_CANDIDATES'
  | 'CONFIG_UNAVAILABLE'

export type V2DecisionEgressState =
  | { mode: 'off'; reason: V2DecisionEgressOffReason; candidates: number }
  | {
      mode: 'opt-in'
      reason: 'EXPLICIT_OPT_IN'
      provider: string
      candidate: UserDecisionRouterCandidate
    }

/**
 * Fixed endpoints retained from the private provider matrix. `wired: false` is
 * about THIS surface: phase 7 adds no transport, and no code path here can
 * issue a request. It is not a statement that the endpoint strings were removed.
 */
export const V2_DECISION_EGRESS_TRANSPORT = Object.freeze({
  wireStatus: 'unwired',
  wired: false,
  note:
    'Endpoints are retained inert (UNWIRED) in this surface. No transport, retry or fallback ' +
    'exists here, and this module never claims the transport was removed.',
  endpoints: Object.freeze([
    'https://api.openai.com/v1/decisions',
    'https://api.typesafe.ai/v1/systemone',
    'https://opencode.ai/inference/systemone/v1/systemone',
  ]),
})

/**
 * Resolve the egress posture of a configuration.
 *
 * Order is fixed so the reason is reproducible: disabled, then local selection,
 * then consent, then candidate cardinality. Every branch that is not
 * `EXPLICIT_OPT_IN` returns `mode: 'off'`.
 */
export function resolveV2DecisionEgress(
  config: unknown,
  capEligibleCandidates: readonly UserDecisionRouterCandidate[] = [],
): V2DecisionEgressState {
  const preference: UserDecisionRouterConfig = migrateUserDecisionRouterConfig(config)
  const candidates = preference.enabled_candidates.length
  if (!preference.enabled) {
    return { mode: 'off', reason: 'DISABLED', candidates }
  }
  if (preference.selection.mode === 'local') {
    return { mode: 'off', reason: 'LOCAL_SELECTION', candidates }
  }
  if (!preference.egress_consent) {
    return { mode: 'off', reason: 'CONSENT_MISSING', candidates }
  }

  if (preference.selection.mode === 'auto') {
    const explained: AutoSelectionExplanation = explainUserDecisionRouterAutoSelection(
      preference,
      capEligibleCandidates,
    )
    if (explained.outcome === 'ambiguous') {
      return { mode: 'off', reason: 'AMBIGUOUS_CANDIDATES', candidates: explained.count }
    }
    if (explained.outcome !== 'single') {
      return { mode: 'off', reason: 'NO_ELIGIBLE_CANDIDATE', candidates: 0 }
    }
    return {
      mode: 'opt-in',
      reason: 'EXPLICIT_OPT_IN',
      provider: explained.candidate.provider,
      candidate: explained.candidate,
    }
  }

  const selected = preference.selection
  const match = capEligibleCandidates.find(
    (candidate) => candidate.provider === selected.provider && candidate.model === selected.model,
  )
  if (match === undefined) {
    return { mode: 'off', reason: 'NO_ELIGIBLE_CANDIDATE', candidates }
  }
  return {
    mode: 'opt-in',
    reason: 'EXPLICIT_OPT_IN',
    provider: selected.provider,
    candidate: match,
  }
}

/** True only for an explicit opt-in. Any other state means zero requests. */
export function v2DecisionEgressMaySend(state: V2DecisionEgressState): boolean {
  return state.mode === 'opt-in' && state.reason === 'EXPLICIT_OPT_IN'
}

/**
 * The invariant a caller must not be able to violate by accident: a state that
 * is not an explicit opt-in cannot be converted into permission.
 */
export function assertV2DecisionEgressOptIn(state: V2DecisionEgressState): void {
  if (!v2DecisionEgressMaySend(state)) {
    throw new Error(`Decision egress is off (${state.mode === 'off' ? state.reason : 'unknown'})`)
  }
}
