/**
 * The deterministic local advisory decision for one turn.
 *
 * The production V2 prompt hook uses `decideLocalForTurn` only. It is
 * deterministic and local-only: no provider branch, no consent/credential/
 * permission path, no transport, no cache — the legacy provider-capable
 * `decideForTurn` and its one-call-per-turn cache were removed with the
 * direct-fetch provider runner (the native route is the explicit
 * `pantheon_jev_decide` tool, which correlates its own turn).
 */
import {
  isUserDecisionRouterEnabled,
  readUserDecisionRouterConfig,
  type UserDecisionRouterConfig,
} from '../../scripts/install/decision-router-config.mjs'
import { hasDelegationSignal, recommendLocalDecisionAgent } from './local-decision-agents.ts'
import { selectPantheonSkills } from './local-decision-skills.ts'
import { type LocalDecisionPolicy, loadLocalDecisionPolicy } from './local-orchestration.ts'

export type TurnDecisionSource = 'local'

export interface TurnDecision {
  schemaVersion: 1
  active: boolean
  source: TurnDecisionSource
  skillIds: string[]
  agent: string | null
  reasonCode: string
}

export interface TurnDecisionInput {
  request: unknown
  sessionID: unknown
  messageID: unknown
}

const MAX_REQUEST_LENGTH = 20_000

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

/**
 * Produce the deterministic local recommendation without entering the
 * provider, consent, credential, permission, or transport path. The legacy
 * per-turn `enabled` preference gates this advisory behavior; provider-selection
 * and egress settings do not.
 */
export async function decideLocalForTurn(input: TurnDecisionInput): Promise<TurnDecision> {
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
