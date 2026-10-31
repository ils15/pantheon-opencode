/**
 * Consent/config gate and host assertion contract for the single
 * decision-provider egress action.
 *
 * Source of truth: the user-level decision-router configuration. Egress
 * requires `enabled`, `egress_consent: true`, exactly one enabled and cap-valid
 * provider/model candidate, a confirmed UTC budget period, and positive
 * user/provider/model caps. Local mode, missing consent, or an unconfirmed
 * period means no request, and the host is not even asked.
 *
 * `permission.assert` is a host kill-switch layered on top, never consent:
 *
 * - Deny is observable: the host throws (`Permission.BlockedError`, whose
 *   message is `Permission denied: <action>` unless an evaluate hook supplied a
 *   reason) or, defensively, resolves an explicit denial marker.
 * - Allow is NOT observable as a positive value. The measured host contract
 *   (`Permission.assert` in the bundled opencode host) resolves `undefined` when
 *   every rule admits the request. A resolved non-denial therefore only means
 *   "the host did not block it"; the configuration above remains the authority.
 *
 * The custom action has no default rule, and the measured v2.2.0 canary showed
 * the host is NOT deny-by-default for it: an assertion with no matching rule
 * resolved allow. The config/consent gate above is therefore the source of
 * truth for authorization, and an explicit `deny` rule is the kill-switch; the
 * fix for a blocked host is an explicit user permission rule for
 * `decision.egress`, not a bypass in this plugin. This module never retries,
 * downgrades, or reinterprets a denial.
 *
 * `assert` is called by the plugin in the same process it protects. It is not a
 * boundary against hostile same-process code; the fixed endpoints, redirect
 * refusal, timeout, response cap, and accounting ledger are the real protection
 * against an accidental or over-broad egress.
 *
 * Canary note: a real host canary of v2.2.0 observed that `permission.assert`
 * reaches the `evaluate` hook on the allow path and is not invoked for an
 * explicit deny, that an assertion with no rule for this custom action resolved
 * allow rather than deny, and that the host accepts a rule under root
 * `permission`/`permissions` or `agents.<id>.permissions` while ignoring an
 * `agents.<id>.permission` map. Egress therefore must not depend on an
 * evaluate-hook decision, and the plugin does not mint or consume an
 * allowance.
 */
import {
  readUserDecisionRouterConfig,
  resolveUserDecisionRouterCandidate,
  type UserDecisionRouterCandidate,
} from '../../scripts/install/decision-router-config.mjs'
import {
  openLocalDecisionBudgetLedger,
  resolveLocalDecisionBudgetDbPath,
} from './local-decision-budget.ts'
import {
  DECISION_PROVIDER_ADAPTERS,
  type DecisionProviderId,
} from './local-decision-provider-matrix.ts'

/**
 * Custom host action, distinct from `webfetch`. It has no default host rule; the
 * measured host resolves an unruled assertion as allow, so only an explicit
 * `deny` rule blocks it.
 */
export const DECISION_EGRESS_ACTION = 'decision.egress'

/** Namespaced prefix that marks a Pantheon-internal assertion, not a real call. */
export const DECISION_EGRESS_SOURCE_PREFIX = 'pantheon-decision:'

export interface DecisionEgressSource {
  type: 'tool'
  id: string
  messageID: string
}

/** Reason codes shared with the provider runner's fallback contract. */
export type DecisionEgressGateReason =
  | 'CONFIG_UNAVAILABLE'
  | 'DISABLED'
  | 'CONSENT_MISSING'
  | 'NO_ELIGIBLE_CANDIDATE'
  | 'CAP_OR_PERIOD_DENIED'
  | 'PERMISSION_UNAVAILABLE'
  | 'PERMISSION_DENIED'

export type PermissionAssert = (input: Record<string, unknown>) => Promise<unknown>

export type DecisionEgressAssertion = 'allow' | 'deny'

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/** Synthetic, stable source accepted by the host for this action. */
export function decisionPermissionSource(
  sessionID: string,
  messageID: string,
): DecisionEgressSource {
  return {
    type: 'tool',
    id: `${DECISION_EGRESS_SOURCE_PREFIX}${sessionID}:${messageID}`,
    messageID,
  }
}

/**
 * The only shape the provider runner and the cached-turn recheck send to
 * `permission.assert`. Keeping it in one place prevents the prompt-source
 * schema mismatch the canary caught.
 */
export function buildDecisionEgressRequest(input: {
  sessionID: string
  messageID: string
  endpoint: string
  /** Current agent, only when the caller actually knows it. */
  agent?: string | undefined
}): Record<string, unknown> {
  const request: Record<string, unknown> = {
    sessionID: input.sessionID,
    action: DECISION_EGRESS_ACTION,
    resources: [input.endpoint],
    save: [],
    source: decisionPermissionSource(input.sessionID, input.messageID),
  }
  // The host only uses `agent` to resolve that agent's rules. Emit it only when
  // the caller knows the current agent; never invent a default such as `zeus`.
  const agent = nonEmptyString(input.agent)
  if (agent !== undefined) request.agent = agent
  return request
}

const DENIAL_VALUES = new Set(['deny', 'denied', 'reject', 'rejected', 'blocked'])

/**
 * The host words a denial as prose (`Permission denied: decision.egress`), not
 * only as an enum value. Matching it is what makes a returned host denial — as
 * a bare string or inside `message`/`error` — recognizable as deny.
 */
const DENIAL_PATTERN = /permission\s+denied|not\s+allowed|forbidden|(?<!not\s)blocked/i

/**
 * Defensive read of an assertion result.
 *
 * The measured contract signals deny by throwing and allow by resolving
 * `undefined`, so this only recognizes the explicit denial shapes a future or
 * alternative host could return. A resolved non-denial is treated as allow
 * because allow has no positive representation to check for.
 */
export function isDecisionAssertionDenial(result: unknown): boolean {
  if (result === false) return true
  if (typeof result === 'string') {
    return DENIAL_VALUES.has(result.trim().toLowerCase()) || DENIAL_PATTERN.test(result)
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return false
  const record = result as Record<string, unknown>
  if (record.denied === true || record.allowed === false || record.ok === false) return true
  for (const key of ['effect', 'decision', 'status', 'result']) {
    const value = record[key]
    if (typeof value === 'string' && DENIAL_VALUES.has(value.trim().toLowerCase())) return true
  }
  for (const key of ['message', 'error']) {
    const value = record[key]
    if (typeof value === 'string' && DENIAL_PATTERN.test(value)) return true
  }
  return false
}

/**
 * Ask the host's kill-switch and normalize the outcome.
 *
 * A throw is a deny. A resolved explicit denial marker is a deny. Everything
 * else is `allow` — not because the host promised consent, but because the
 * host's allow path is indistinguishable from `undefined`; the config gate
 * above is what actually authorizes egress.
 */
export async function assertDecisionEgressPermission(
  permissionAssert: PermissionAssert,
  request: Record<string, unknown>,
): Promise<DecisionEgressAssertion> {
  let result: unknown
  try {
    result = await permissionAssert(request)
  } catch {
    return 'deny'
  }
  return isDecisionAssertionDenial(result) ? 'deny' : 'allow'
}

export interface CapValidDecisionCandidate {
  provider: DecisionProviderId
  adapter: (typeof DECISION_PROVIDER_ADAPTERS)[DecisionProviderId]
  candidate: UserDecisionRouterCandidate
}

/**
 * Single cap-valid selection shared by the provider runner and the cached-turn
 * recheck. Opens the ledger, keeps only enabled, egress-eligible candidates
 * whose period and caps admit a reservation, resolves the preference, and
 * requires the resolved model to match the fixed matrix row.
 *
 * Throws when the ledger cannot be opened or queried; callers map that to
 * `CAP_OR_PERIOD_DENIED`. Returns `null` when no candidate qualifies.
 */
export function selectCapValidDecisionCandidate(
  config: ReturnType<typeof readUserDecisionRouterConfig>,
): CapValidDecisionCandidate | null {
  const ledger = openLocalDecisionBudgetLedger({ dbPath: resolveLocalDecisionBudgetDbPath() })
  try {
    const valid: UserDecisionRouterCandidate[] = []
    for (const candidate of config.enabled_candidates) {
      const provider = candidate.provider as DecisionProviderId
      const adapter = DECISION_PROVIDER_ADAPTERS[provider]
      if (adapter === undefined || !adapter.egressEligible) continue
      if (ledger.canReserve(adapter.accountingProvider, candidate.model).status !== 'eligible') {
        continue
      }
      valid.push(candidate)
    }
    const selected = resolveUserDecisionRouterCandidate(config, valid)
    if (selected === null) return null
    const provider = selected.provider as DecisionProviderId
    const adapter = DECISION_PROVIDER_ADAPTERS[provider]
    if (adapter === undefined || !adapter.egressEligible) return null
    if (selected.model !== adapter.model) return null
    return { provider, adapter, candidate: selected }
  } finally {
    ledger.close()
  }
}

export type DecisionEgressConsent =
  | { ok: true; selected: CapValidDecisionCandidate }
  | {
      ok: false
      reasonCode: Exclude<DecisionEgressGateReason, 'PERMISSION_UNAVAILABLE' | 'PERMISSION_DENIED'>
    }

/**
 * Evaluate the consent/config gate without touching the network or the host.
 *
 * Callers run this BEFORE `permission.assert`: an invalid configuration is not
 * worth an interactive prompt, and the host must not be asked to approve a
 * request that the user's own configuration already forbids.
 */
export function resolveDecisionEgressConsent(): DecisionEgressConsent {
  let config: ReturnType<typeof readUserDecisionRouterConfig>
  try {
    config = readUserDecisionRouterConfig()
  } catch {
    return { ok: false, reasonCode: 'CONFIG_UNAVAILABLE' }
  }
  if (!config.enabled) return { ok: false, reasonCode: 'DISABLED' }
  if (!config.egress_consent || config.selection.mode === 'local') {
    return { ok: false, reasonCode: 'CONSENT_MISSING' }
  }

  let selected: CapValidDecisionCandidate | null
  try {
    selected = selectCapValidDecisionCandidate(config)
  } catch {
    return { ok: false, reasonCode: 'CAP_OR_PERIOD_DENIED' }
  }
  if (selected === null) return { ok: false, reasonCode: 'NO_ELIGIBLE_CANDIDATE' }
  return { ok: true, selected }
}
