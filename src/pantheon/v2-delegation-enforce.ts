/** Caller/target policy for V2's permission.evaluate hook. */

export const PANTHEON_AGENTS: ReadonlySet<string> = new Set([
  'zeus',
  'athena',
  'apollo',
  'hermes',
  'aphrodite',
  'demeter',
  'themis',
  'prometheus',
  'hephaestus',
  'nyx',
  'gaia',
  'iris',
  'mnemosyne',
  'talos',
])

export interface V2PermissionEvent {
  sessionID?: unknown
  resources?: unknown
  /** Optional event identity is checked but never used as authority. */
  agent?: unknown
  /** Permission effect reported by the V2 host event. */
  effect?: unknown
}

export interface AuthoritativeSession {
  id?: unknown
  agent?: unknown
  parentID?: unknown
}

export type V2DelegationDecision = 'allow' | 'deny' | 'passthrough' | 'preserve-deny'

function agentName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const valueNormalized = value.trim().toLowerCase()
  return valueNormalized.length === 0 ? undefined : valueNormalized
}

/** Extract the target from the host's resource string or `{ target }` entry. */
export function v2ResourceTarget(resource: unknown): string | undefined {
  if (typeof resource === 'string') return agentName(resource)
  if (resource === null || typeof resource !== 'object' || Array.isArray(resource)) return undefined
  return agentName((resource as { target?: unknown }).target)
}

/**
 * Decide whether a permission evaluation is a Pantheon-managed delegation.
 * Native/custom-to-native/custom calls are left entirely to host permissions.
 */
export function evaluateV2Delegation(
  event: V2PermissionEvent,
  session: AuthoritativeSession | undefined,
  existingStatus?: unknown,
): V2DelegationDecision {
  if (existingStatus === 'deny') return 'preserve-deny'

  if (!Array.isArray(event.resources) || event.resources.length === 0) return 'deny'
  const rawTargets = event.resources.map(v2ResourceTarget)
  if (rawTargets.some((target) => target === undefined)) return 'deny'
  const targets = rawTargets.filter((target): target is string => target !== undefined)
  const pantheonTargets = targets.filter((target) => PANTHEON_AGENTS.has(target))
  if (pantheonTargets.length === 0) return 'passthrough'
  const sessionID = typeof event.sessionID === 'string' ? event.sessionID : undefined
  const caller = agentName(session?.agent)
  if (
    sessionID === undefined ||
    session === undefined ||
    session.id !== sessionID ||
    caller === undefined
  ) {
    return 'deny'
  }
  const eventCaller = agentName(event.agent)
  if (eventCaller !== undefined && eventCaller !== caller) return 'deny'
  if (session.parentID !== undefined && session.parentID !== null && session.parentID !== '') {
    return 'deny'
  }

  const callerMayTarget = (target: string): boolean =>
    caller === 'zeus' || ((caller === 'athena' || caller === 'hermes') && target === 'apollo')
  return pantheonTargets.every(callerMayTarget) ? 'allow' : 'deny'
}
