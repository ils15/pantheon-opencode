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
 * 3. **A declared endpoint that is not provably wired must SAY so.** Every
 *    endpoint carries an explicit wire status, and
 *    {@link findUnverifiedEgressEndpoints} returns the ones that are neither
 *    declared `unwired` nor exercised by a real path. The exercised-path list is
 *    empty and must stay honest: no probe issued a decision request, so no
 *    endpoint can be marked `wired` without failing that check. Verification of
 *    this surface therefore covers only the paths a probe exercised — none —
 *    and the absence of a probe is recorded, not inferred as safety. Of the
 *    ten `permission.evaluate` paths, `.egress` is unreachable in the probed
 *    host: a tool declaring that permission registers but is never advertised to
 *    the provider (PROBE-F §3.9).
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

export type V2DecisionEgressWireStatus = 'unwired' | 'wired'

interface DeclaredEgressEndpoint {
  readonly url: string
  readonly wireStatus: V2DecisionEgressWireStatus
}

/**
 * Fixed endpoints retained from the private provider matrix, each with its own
 * wire status. `unwired` is about THIS surface: phase 7 adds no transport, and
 * no code path here can issue a request. It is not a statement that the
 * endpoint strings were removed.
 */
const DECLARED_EGRESS_ENDPOINTS: readonly DeclaredEgressEndpoint[] = Object.freeze([
  { url: 'https://api.openai.com/v1/decisions', wireStatus: 'unwired' },
  { url: 'https://api.typesafe.ai/v1/systemone', wireStatus: 'unwired' },
  { url: 'https://opencode.ai/inference/systemone/v1/systemone', wireStatus: 'unwired' },
])

/**
 * Paths a probe actually exercised end to end. Empty, and that is the claim:
 * no probe issued a decision request, so no endpoint may be reported as wired.
 * Adding an entry here is a measurement claim and needs a probe artifact.
 */
export const V2_DECISION_EGRESS_EXERCISED_PATHS: readonly string[] = Object.freeze([])

/** Per-endpoint wire status. Derived from the declaration, never hand-kept. */
export const V2_DECISION_EGRESS_ENDPOINT_WIRE_STATUS: Readonly<
  Record<string, V2DecisionEgressWireStatus>
> = Object.freeze(
  Object.fromEntries(DECLARED_EGRESS_ENDPOINTS.map(({ url, wireStatus }) => [url, wireStatus])),
)

/**
 * Endpoints whose wire status is not verifiable: neither declared `unwired` nor
 * covered by an exercised path. An unknown or missing status is unverified too —
 * silence is not evidence of inertia.
 */
export function findUnverifiedEgressEndpoints(
  endpoints: readonly string[],
  endpointWireStatus: Readonly<Record<string, V2DecisionEgressWireStatus>>,
  exercisedPaths: readonly string[] = V2_DECISION_EGRESS_EXERCISED_PATHS,
): readonly string[] {
  const exercised = new Set(exercisedPaths)
  return Object.freeze(
    endpoints.filter((endpoint) => {
      const status = endpointWireStatus[endpoint]
      if (status === 'unwired') return false
      if (status === 'wired') return !exercised.has(endpoint)
      return true
    }),
  )
}

export const V2_DECISION_EGRESS_TRANSPORT = Object.freeze({
  wireStatus: 'unwired',
  wired: false,
  note:
    'Endpoints are retained inert (UNWIRED) in this surface. No transport, retry or fallback ' +
    'exists here, and this module never claims the transport was removed. Verification covers ' +
    'only the paths a probe exercised — none — and every declared endpoint carries an explicit ' +
    'wire status so an unverified endpoint fails a test instead of passing silently.',
  endpoints: Object.freeze(DECLARED_EGRESS_ENDPOINTS.map(({ url }) => url)),
  endpointWireStatus: V2_DECISION_EGRESS_ENDPOINT_WIRE_STATUS,
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
