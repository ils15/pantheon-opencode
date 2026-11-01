/**
 * Local and legacy provider-capable advisory decisions per turn.
 *
 * The production V2 prompt hook uses `decideLocalForTurn`; it is deterministic
 * and local-only. `decideForTurn` retains its provider-capable branch for the
 * offline adapter/gate tests, but it has no production call site.
 */
import {
  isUserDecisionRouterEnabled,
  readUserDecisionRouterConfig,
  type UserDecisionRouterConfig,
} from '../../scripts/install/decision-router-config.mjs'
import {
  hasDelegationSignal,
  listEligibleDecisionAgents,
  recommendLocalDecisionAgent,
} from './local-decision-agents.ts'
import {
  assertDecisionEgressPermission,
  buildDecisionEgressRequest,
  isDecisionAssertionDenial,
  type PermissionAssert,
  resolveDecisionEgressConsent,
} from './local-decision-egress-gate.ts'
import {
  buildDecisionPayload,
  DECISION_PROVIDER_ADAPTERS,
  type DecisionPayload,
  type DecisionProviderId,
  runProviderDecision,
} from './local-decision-provider.internal.ts'
import { selectPantheonSkills } from './local-decision-skills.ts'
import { type LocalDecisionPolicy, loadLocalDecisionPolicy } from './local-orchestration.ts'
import { PANTHEON_SKILL_CATALOG } from './pantheon-decision-catalog.ts'

export type TurnDecisionSource = 'local' | DecisionProviderId

export interface TurnDecision {
  schemaVersion: 1
  active: boolean
  source: TurnDecisionSource
  skillIds: string[]
  agent: string | null
  reasonCode: string
}

type PermissionOutcome = 'allowed' | 'denied'

interface TurnCacheEntry {
  decision: TurnDecision
  expiresAt: number
  /**
   * Assert outcome memoized per caller gate identity. The gate function is the
   * only stable caller identity available here, so an interactive
   * `permission.assert` is asked at most once per gate for a cached turn.
   */
  permissions: WeakMap<PermissionAssert, PermissionOutcome>
}

export interface TurnDecisionInput {
  request: unknown
  sessionID: unknown
  messageID: unknown
  permissionAssert?: PermissionAssert | undefined
}

const MAX_REQUEST_LENGTH = 20_000
const CACHE_MAX_ENTRIES = 128
const CACHE_TTL_MS = 10 * 60_000
const turnCache = new Map<string, TurnCacheEntry>()
const inFlight = new Map<string, Promise<TurnDecision>>()

function inactive(reasonCode: string): TurnDecision {
  return {
    schemaVersion: 1,
    active: false,
    source: 'local',
    skillIds: [],
    agent: null,
    reasonCode,
  }
}

function cacheKey(sessionID: string, messageID: string): string {
  return `${sessionID}\u0000${messageID}`
}

function readCache(key: string, now: number): TurnCacheEntry | undefined {
  const entry = turnCache.get(key)
  if (entry === undefined) return undefined
  if (entry.expiresAt <= now) {
    turnCache.delete(key)
    return undefined
  }
  return entry
}

function writeCache(key: string, entry: TurnCacheEntry, now: number): void {
  if (turnCache.size >= CACHE_MAX_ENTRIES && !turnCache.has(key)) {
    const oldest = turnCache.keys().next().value
    if (oldest !== undefined) turnCache.delete(oldest)
  }
  entry.expiresAt = now + CACHE_TTL_MS
  turnCache.set(key, entry)
}

/** Test-only cache reset. It cannot initiate a provider request. */
export function clearTurnDecisionCache(): void {
  turnCache.clear()
  inFlight.clear()
}

function readConfig(): UserDecisionRouterConfig | undefined {
  try {
    return readUserDecisionRouterConfig()
  } catch {
    return undefined
  }
}

function localDecision(
  request: string,
  policy: LocalDecisionPolicy | undefined,
  reasonCode: string,
): TurnDecision {
  const skills = selectPantheonSkills(request)
  const agent = hasDelegationSignal(request)
    ? recommendLocalDecisionAgent(request, policy).agent
    : null
  return {
    schemaVersion: 1,
    active: true,
    source: 'local',
    skillIds: skills.skillIds,
    agent,
    reasonCode,
  }
}

function buildPayload(
  request: string,
  eligibleAgents: readonly string[],
  includeAgents: boolean,
): DecisionPayload | null {
  return buildDecisionPayload({
    request,
    skillIds: PANTHEON_SKILL_CATALOG.map((entry) => entry.id),
    ...(includeAgents && eligibleAgents.length > 0 ? { agentIds: eligibleAgents } : {}),
  })
}

/**
 * A cached/in-flight provider decision was minted under an earlier caller's
 * permission assertion. Reuse therefore needs authority for *this* caller: the
 * outcome is memoized per gate function identity, so the same (possibly
 * interactive) gate is not prompted twice for one cached turn, while a
 * different or missing gate is evaluated afresh. A missing or denying assertion
 * downgrades the turn to inactive instead of handing out a remote
 * recommendation (no new egress happens here).
 *
 * The config/consent gate is re-read on every reuse before the assertion: it is
 * local (config file plus ledger reads, no network), and revoking consent,
 * disabling the router, or dropping caps must take effect immediately rather
 * than after the 10-minute cache expires.
 *
 * The assertion is the host's kill-switch; the user-level config remains the
 * source of truth. A resolved non-denial is the host's allow path (`undefined`
 * on the measured host), so it is treated as allowed. No allowance is minted or
 * consumed: the v2.2.0 canary showed the evaluate hook runs on the allow path
 * and is skipped for an explicit deny, so egress never depends on it.
 */
async function reuseDeniedReason(
  entry: TurnCacheEntry,
  permissionAssert: TurnDecisionInput['permissionAssert'],
  sessionID: string,
  messageID: string,
): Promise<string | null> {
  if (entry.decision.source === 'local') return null
  const adapter = DECISION_PROVIDER_ADAPTERS[entry.decision.source]
  if (adapter === undefined || !adapter.egressEligible) return 'PERMISSION_DENIED'
  const consent = resolveDecisionEgressConsent()
  if (!consent.ok) return consent.reasonCode
  if (typeof permissionAssert !== 'function') return 'PERMISSION_UNAVAILABLE'
  const memo = entry.permissions.get(permissionAssert)
  if (memo === 'denied') return 'PERMISSION_DENIED'
  if (memo === 'allowed') return null
  const outcome = await assertDecisionEgressPermission(
    permissionAssert,
    buildDecisionEgressRequest({ sessionID, messageID, endpoint: adapter.endpoint }),
  )
  if (outcome === 'deny') {
    entry.permissions.set(permissionAssert, 'denied')
    return 'PERMISSION_DENIED'
  }
  entry.permissions.set(permissionAssert, 'allowed')
  return null
}

/**
 * Record the gate outcome for the computing caller so the in-flight path can
 * reuse it instead of asserting a second time.
 */
function recordPermission(
  entry: TurnCacheEntry,
  permissionAssert: PermissionAssert,
): PermissionAssert {
  return async (input) => {
    let result: unknown
    try {
      result = await permissionAssert(input)
    } catch (error) {
      entry.permissions.set(permissionAssert, 'denied')
      throw error
    }
    entry.permissions.set(
      permissionAssert,
      isDecisionAssertionDenial(result) ? 'denied' : 'allowed',
    )
    return result
  }
}

/**
 * Compute (or reuse) the advisory turn decision. The request text is used only
 * in memory and, when every gate passes, in the bounded provider payload.
 */
/** @internal Provider-capable legacy helper; not called by the production prompt hook. */
export async function decideForTurn(input: TurnDecisionInput): Promise<TurnDecision> {
  const request = typeof input.request === 'string' ? input.request : ''
  const sessionID = typeof input.sessionID === 'string' ? input.sessionID.trim() : ''
  const messageID = typeof input.messageID === 'string' ? input.messageID.trim() : ''
  if (
    request.trim().length === 0 ||
    request.length > MAX_REQUEST_LENGTH ||
    sessionID.length === 0 ||
    messageID.length === 0
  ) {
    return inactive('INVALID_INPUT')
  }

  const config = readConfig()
  if (config === undefined || !isUserDecisionRouterEnabled(config)) return inactive('DISABLED')

  const key = cacheKey(sessionID, messageID)
  const cached = readCache(key, Date.now())
  if (cached !== undefined) {
    const denied = await reuseDeniedReason(cached, input.permissionAssert, sessionID, messageID)
    return denied === null ? cached.decision : inactive(denied)
  }
  const pending = inFlight.get(key)
  if (pending !== undefined) {
    const decision = await pending
    const settled = readCache(key, Date.now())
    const entry = settled ?? { decision, expiresAt: 0, permissions: new WeakMap() }
    const denied = await reuseDeniedReason(entry, input.permissionAssert, sessionID, messageID)
    return denied === null ? decision : inactive(denied)
  }

  const entry: TurnCacheEntry = {
    decision: inactive('INVALID_INPUT'),
    expiresAt: 0,
    permissions: new WeakMap(),
  }
  const computation = computeTurn(input, request, sessionID, messageID, key, config, entry).finally(
    () => inFlight.delete(key),
  )
  inFlight.set(key, computation)
  return computation
}

/**
 * Produce the existing deterministic local recommendation without entering the
 * provider, consent, credential, permission, or transport path. The legacy
 * per-turn `enabled` preference gates this advisory behavior; provider-selection
 * and egress settings do not.
 */
export async function decideLocalForTurn(
  input: Pick<TurnDecisionInput, 'request' | 'sessionID' | 'messageID'>,
): Promise<TurnDecision> {
  const request = typeof input.request === 'string' ? input.request : ''
  const sessionID = typeof input.sessionID === 'string' ? input.sessionID.trim() : ''
  const messageID = typeof input.messageID === 'string' ? input.messageID.trim() : ''
  if (
    request.trim().length === 0 ||
    request.length > MAX_REQUEST_LENGTH ||
    sessionID.length === 0 ||
    messageID.length === 0
  ) {
    return inactive('INVALID_INPUT')
  }

  const config = readConfig()
  if (config === undefined || !isUserDecisionRouterEnabled(config)) return inactive('DISABLED')

  const policy = await loadLocalDecisionPolicy().catch(() => undefined)
  return localDecision(request, policy, 'LOCAL_SELECTION')
}

async function computeTurn(
  input: TurnDecisionInput,
  request: string,
  sessionID: string,
  messageID: string,
  key: string,
  config: UserDecisionRouterConfig,
  entry: TurnCacheEntry,
): Promise<TurnDecision> {
  const policy = await loadLocalDecisionPolicy().catch(() => undefined)
  const local = localDecision(request, policy, 'LOCAL_SELECTION')

  const delegationSignal = hasDelegationSignal(request)
  const eligibleAgents = delegationSignal ? listEligibleDecisionAgents(policy) : []

  if (config.selection.mode === 'local' || !config.egress_consent) {
    entry.decision = local
    writeCache(key, entry, Date.now())
    return local
  }

  const payload = buildPayload(request, eligibleAgents, delegationSignal)
  const permissionAssert =
    typeof input.permissionAssert === 'function'
      ? recordPermission(entry, input.permissionAssert)
      : undefined
  const provider = await runProviderDecision({
    payload,
    permissionAssert,
    sessionID,
    messageID,
  }).catch(() => null)

  const providerAgent = provider?.status === 'decided' ? provider.agent : null
  const providerSkills =
    providerAgent !== null
      ? (provider?.skillIds ?? []).filter((skill) =>
          (policy?.agents[providerAgent]?.skills ?? []).includes(skill),
        )
      : (provider?.skillIds ?? [])

  const decision: TurnDecision =
    provider !== null && provider.status === 'decided'
      ? {
          schemaVersion: 1,
          active: true,
          source: provider.provider ?? 'local',
          skillIds: providerSkills.length > 0 ? providerSkills : local.skillIds,
          agent: provider.agent,
          reasonCode: provider.reasonCode,
        }
      : provider !== null && provider.status === 'abstain'
        ? {
            schemaVersion: 1,
            active: true,
            source: provider.provider ?? 'local',
            skillIds: local.skillIds,
            agent: null,
            reasonCode: provider.reasonCode,
          }
        : {
            ...local,
            reasonCode: provider?.reasonCode ?? 'LOCAL_FALLBACK',
          }

  entry.decision = decision
  writeCache(key, entry, Date.now())
  return decision
}
