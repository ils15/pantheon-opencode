/**
 * Host kill-switch contract for the single decision-egress action.
 *
 * `permission.assert` is a host kill-switch layered on top of the user-level
 * config, never consent itself. The native `pantheon_jev_decide` tool asks it
 * with the logical resource `pantheon-native-decisions://<providerID>/<id>`
 * after its own config/route/ledger gates pass.
 *
 * - Deny is observable: the host throws (`Permission.BlockedError`, whose
 *   message is `Permission denied: <action>` unless an evaluate hook supplied a
 *   reason) or, defensively, resolves an explicit denial marker.
 * - Allow is NOT observable as a positive value. The measured host contract
 *   (`Permission.assert` in the bundled opencode host) resolves `undefined` when
 *   every rule admits the request. A resolved non-denial therefore only means
 *   "the host did not block it"; the configuration gates remain the authority.
 *
 * The custom action has no default rule, and the measured v2.2.0 canary showed
 * the host is NOT deny-by-default for it: an assertion with no matching rule
 * resolved allow. The config/consent gate is therefore the source of truth for
 * authorization, and an explicit `deny` rule is the kill-switch; the fix for a
 * blocked host is an explicit user permission rule for `decision.egress`, not a
 * bypass in this plugin. This module never retries, downgrades, or reinterprets
 * a denial. Pantheon owns no transport: there is no endpoint to fall back to.
 */
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
 * The only shape the native tool sends to `permission.assert`. The resource is
 * a logical URI (the host owns any real endpoint), so permission rules can
 * target the native route without exposing a URL.
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
 * host's allow path is indistinguishable from `undefined`; the config gates
 * are what actually authorize egress.
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
