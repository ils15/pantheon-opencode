/** V2 caller/target policy and one-shot host tool-origin correlation. */

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
  action?: unknown
  resources?: unknown
  /** Optional event identity is cross-checked against the host tool event. */
  agent?: unknown
  source?: unknown
  /** Mutable decision fields exposed by OpenCode V2's evaluate hook. */
  effect?: unknown
  message?: unknown
}

export interface V2SubagentOrigin {
  sessionID: string
  messageID: string
  callID: string
  caller: string
  target: string
}

interface StoredV2SubagentOrigin extends V2SubagentOrigin {
  capturedAt: number
}

const ORIGIN_TTL_MS = 60_000
const MAX_PENDING_ORIGINS = 256

function originKey(sessionID: string, messageID: string, callID: string): string {
  return JSON.stringify([sessionID, messageID, callID])
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * One-shot correlation between the host's tool.execute.before event and the
 * permission evaluation emitted from inside that same native tool call.
 * Entries are short-lived and bounded; missing, stale, or uncorrelated origin
 * data can only make admission fail closed.
 */
export class V2SubagentOriginRegistry {
  private readonly entries = new Map<string, StoredV2SubagentOrigin>()

  capture(rawEvent: unknown, now = Date.now()): V2SubagentOrigin | undefined {
    this.prune(now)
    if (rawEvent === null || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) {
      return undefined
    }
    const event = rawEvent as {
      tool?: unknown
      sessionID?: unknown
      messageID?: unknown
      id?: unknown
      agent?: unknown
      input?: unknown
    }
    if (event.tool !== 'subagent' || event.input === null || typeof event.input !== 'object') {
      return undefined
    }
    const input = event.input as { agent?: unknown }
    const sessionID = nonEmptyString(event.sessionID)
    const messageID = nonEmptyString(event.messageID)
    const callID = nonEmptyString(event.id)
    const caller = agentName(event.agent)
    const target = agentName(input.agent)
    if (
      sessionID === undefined ||
      messageID === undefined ||
      callID === undefined ||
      caller === undefined ||
      target === undefined ||
      !PANTHEON_AGENTS.has(target) ||
      this.entries.size >= MAX_PENDING_ORIGINS
    ) {
      return undefined
    }

    const origin = { sessionID, messageID, callID, caller, target }
    this.entries.set(originKey(sessionID, messageID, callID), { ...origin, capturedAt: now })
    return origin
  }

  /** Remove and return the matching origin, so one tool event authorizes once. */
  consume(event: V2PermissionEvent, now = Date.now()): V2SubagentOrigin | undefined {
    this.prune(now)
    const source = event.source as { type?: unknown; messageID?: unknown; id?: unknown } | undefined
    if (source?.type !== 'tool') return undefined
    const sessionID = nonEmptyString(event.sessionID)
    const messageID = nonEmptyString(source.messageID)
    const callID = nonEmptyString(source.id)
    if (sessionID === undefined || messageID === undefined || callID === undefined) return undefined
    const key = originKey(sessionID, messageID, callID)
    const origin = this.entries.get(key)
    this.entries.delete(key)
    if (origin === undefined) return undefined
    const { capturedAt: _capturedAt, ...result } = origin
    return result
  }

  /** Cleanup when a subagent tool exits without reaching permission.evaluate. */
  forget(rawEvent: unknown): void {
    if (rawEvent === null || typeof rawEvent !== 'object' || Array.isArray(rawEvent)) return
    const event = rawEvent as {
      tool?: unknown
      sessionID?: unknown
      messageID?: unknown
      id?: unknown
    }
    if (event.tool !== 'subagent') return
    const sessionID = nonEmptyString(event.sessionID)
    const messageID = nonEmptyString(event.messageID)
    const callID = nonEmptyString(event.id)
    if (sessionID === undefined || messageID === undefined || callID === undefined) return
    this.entries.delete(originKey(sessionID, messageID, callID))
  }

  private prune(now: number): void {
    for (const [key, origin] of this.entries) {
      if (now - origin.capturedAt > ORIGIN_TTL_MS) this.entries.delete(key)
    }
  }
}

export interface AuthoritativeSession {
  id?: unknown
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
  origin?: V2SubagentOrigin,
): V2DelegationDecision {
  if (existingStatus === 'deny') return 'preserve-deny'

  if (!Array.isArray(event.resources) || event.resources.length === 0) return 'deny'
  const rawTargets = event.resources.map(v2ResourceTarget)
  if (rawTargets.some((target) => target === undefined)) return 'deny'
  const targets = rawTargets.filter((target): target is string => target !== undefined)
  const pantheonTargets = targets.filter((target) => PANTHEON_AGENTS.has(target))
  if (pantheonTargets.length === 0) return 'passthrough'
  if (event.action !== 'subagent' || targets.length !== 1 || origin === undefined) return 'deny'
  const sessionID = typeof event.sessionID === 'string' ? event.sessionID : undefined
  const caller = agentName(origin.caller)
  if (
    sessionID === undefined ||
    session === undefined ||
    session.id !== sessionID ||
    caller === undefined ||
    origin.sessionID !== sessionID ||
    origin.target !== pantheonTargets[0]
  ) {
    return 'deny'
  }
  const source = event.source as { type?: unknown; messageID?: unknown; id?: unknown } | undefined
  if (
    source?.type !== 'tool' ||
    source.messageID !== origin.messageID ||
    source.id !== origin.callID
  ) {
    return 'deny'
  }
  const eventCaller = agentName(event.agent)
  if (eventCaller !== undefined && eventCaller !== caller) return 'deny'
  if (session.parentID !== undefined && session.parentID !== null) {
    return 'deny'
  }

  const callerMayTarget = (target: string): boolean =>
    caller === 'zeus' || ((caller === 'athena' || caller === 'hermes') && target === 'apollo')
  return pantheonTargets.every(callerMayTarget) ? 'allow' : 'deny'
}
