import { readFile } from 'node:fs/promises'
import { load } from 'js-yaml'
import {
  classifyLocalDecisionComplexity,
  LOCAL_DECISION_COMPLEXITY_DIMENSIONS,
  LOCAL_DECISION_ROUTER_POLICY_VERSION,
  type LocalDecisionComplexityDimensions,
  type LocalDecisionGateStatus,
} from './local-decision-router.ts'
import { isAgentAllowed, type PermissionTaskConfig } from './permission-globs.ts'
import { PANTHEON_AGENTS } from './v2-delegation-enforce.ts'

export interface LocalDecisionAgentPolicy {
  canDelegateTo: readonly string[]
  canReceiveDelegation: boolean
  capabilities: readonly string[]
  skills: readonly string[]
}

export interface LocalDecisionPolicy {
  agents: Readonly<Record<string, LocalDecisionAgentPolicy>>
  permissionTask: PermissionTaskConfig
}

export interface LocalOrchestrationInput {
  schemaVersion: 1
  candidateAgents: readonly string[]
  domain: string | null
  candidateSkillIds: readonly string[]
  candidateResourceIds: readonly string[]
  memorySearchRelevant: boolean
  gateStatus: LocalDecisionGateStatus
  complexity: LocalDecisionComplexityDimensions
}

export type LocalOrchestrationReasonCode =
  | 'CALLER_NOT_ZEUS'
  | 'INVALID_INPUT'
  | 'POLICY_UNAVAILABLE'
  | 'NO_ELIGIBLE_CANDIDATE'
  | 'AMBIGUOUS_CANDIDATE'
  | 'DOMAIN_NOT_ELIGIBLE'
  | 'ADVISORY_ROUTE'
  | 'PROVIDER_RECOMMENDATION'
  | 'PROVIDER_ABSTENTION'

export interface LocalOrchestrationPlan {
  schemaVersion: 1
  policyVersion: typeof LOCAL_DECISION_ROUTER_POLICY_VERSION
  decision: 'recommend' | 'abstain'
  reasonCode: LocalOrchestrationReasonCode
  agent: string | null
  skillIds: string[]
  resourceIds: string[]
  recommendMemorySearch: boolean
  gateStatus: LocalDecisionGateStatus
  complexity: ReturnType<typeof classifyLocalDecisionComplexity>
  action: 'advisory_only'
}

const GATE_STATUSES = new Set<LocalDecisionGateStatus>([
  'none',
  'review_required',
  'human_approval_required',
  'unresolved',
])
const INPUT_KEYS = [
  'candidateAgents',
  'candidateResourceIds',
  'candidateSkillIds',
  'complexity',
  'domain',
  'gateStatus',
  'memorySearchRelevant',
  'schemaVersion',
]
const RESOURCE_IDS = new Set(['pantheon://agents', 'pantheon://routing', 'pantheon://skills'])

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function hasUsablePolicy(policy: LocalDecisionPolicy | undefined): policy is LocalDecisionPolicy {
  if (
    policy === undefined ||
    !isRecord(policy.agents) ||
    !isRecord(policy.permissionTask) ||
    !isRecord(policy.agents.zeus)
  ) {
    return false
  }
  const grants = Object.entries(policy.permissionTask)
  return (
    grants.length > 0 &&
    grants.every(([, action]) => action === 'allow' || action === 'deny') &&
    stringArray(policy.agents.zeus.canDelegateTo) &&
    stringArray(policy.agents.zeus.capabilities)
  )
}

function parsePolicy(raw: unknown): LocalDecisionPolicy | undefined {
  if (!isRecord(raw) || !isRecord(raw.agents) || !isRecord(raw.permission)) return undefined
  const permission = raw.permission.task
  if (!isRecord(permission)) return undefined

  const permissionTask: Record<string, 'allow' | 'deny'> = {}
  for (const [pattern, action] of Object.entries(permission)) {
    if (action !== 'allow' && action !== 'deny') return undefined
    permissionTask[pattern] = action
  }
  if (Object.keys(permissionTask).length === 0) return undefined

  const agents: Record<string, LocalDecisionAgentPolicy> = {}
  for (const [id, value] of Object.entries(raw.agents)) {
    if (!PANTHEON_AGENTS.has(id) || !isRecord(value)) continue
    const canDelegateTo =
      value.subagent_can_delegate_to === undefined && value.can_delegate === false
        ? []
        : value.subagent_can_delegate_to
    if (
      typeof value.can_receive_delegation !== 'boolean' ||
      !stringArray(canDelegateTo) ||
      !stringArray(value.skills) ||
      !stringArray(value.capabilities)
    ) {
      return undefined
    }
    if (
      canDelegateTo.some((target) => !PANTHEON_AGENTS.has(target)) ||
      value.skills.some((skill) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skill))
    ) {
      return undefined
    }
    agents[id] = {
      canDelegateTo,
      canReceiveDelegation: value.can_receive_delegation,
      capabilities: value.capabilities,
      skills: value.skills,
    }
  }
  if (agents.zeus === undefined) return undefined
  return { agents, permissionTask }
}

let policyCache: Promise<LocalDecisionPolicy | undefined> | undefined

/**
 * Load only local, non-secret policy metadata; missing or invalid policy abstains.
 * `routing.yml` is a static package asset, so the parsed policy is cached for
 * the process lifetime. Failures are not cached: the next prompt retries, and a
 * test/admin can call `clearLocalDecisionPolicyCache()` to invalidate safely.
 */
export async function loadLocalDecisionPolicy(): Promise<LocalDecisionPolicy | undefined> {
  if (policyCache === undefined) {
    policyCache = readLocalDecisionPolicy().then(
      (policy) => {
        if (policy === undefined) policyCache = undefined
        return policy
      },
      () => {
        policyCache = undefined
        return undefined
      },
    )
  }
  return policyCache
}

/** Test/admin seam: drop the process policy cache without discharging any state. */
export function clearLocalDecisionPolicyCache(): void {
  policyCache = undefined
}

async function readLocalDecisionPolicy(): Promise<LocalDecisionPolicy | undefined> {
  try {
    const routingUrl = new URL('../routing.yml', import.meta.url)
    const parsed = load(await readFile(routingUrl, 'utf8'))
    return parsePolicy(parsed)
  } catch {
    return undefined
  }
}

function isValidInput(value: unknown): value is LocalOrchestrationInput {
  if (!isRecord(value) || !exactKeys(value, INPUT_KEYS) || value.schemaVersion !== 1) return false
  if (
    !stringArray(value.candidateAgents) ||
    value.candidateAgents.length > 14 ||
    !stringArray(value.candidateSkillIds) ||
    value.candidateSkillIds.length > 64 ||
    !stringArray(value.candidateResourceIds) ||
    value.candidateResourceIds.length > 32 ||
    (value.domain !== null && typeof value.domain !== 'string') ||
    typeof value.memorySearchRelevant !== 'boolean' ||
    typeof value.gateStatus !== 'string' ||
    !GATE_STATUSES.has(value.gateStatus as LocalDecisionGateStatus) ||
    !isRecord(value.complexity)
  ) {
    return false
  }
  return (
    exactKeys(value.complexity, LOCAL_DECISION_COMPLEXITY_DIMENSIONS) &&
    classifyLocalDecisionComplexity(value.complexity).label !== 'abstain'
  )
}

function abstain(
  reasonCode: LocalOrchestrationReasonCode,
  gateStatus: LocalDecisionGateStatus = 'unresolved',
  complexity?: unknown,
): LocalOrchestrationPlan {
  return {
    schemaVersion: 1,
    policyVersion: LOCAL_DECISION_ROUTER_POLICY_VERSION,
    decision: 'abstain',
    reasonCode,
    agent: null,
    skillIds: [],
    resourceIds: [],
    recommendMemorySearch: false,
    gateStatus,
    complexity: classifyLocalDecisionComplexity(complexity),
    action: 'advisory_only',
  }
}

/** Build an advisory plan from structured candidate IDs; this function never dispatches. */
export function recommendLocalOrchestration(
  input: unknown,
  callerAgent: unknown,
  policy: LocalDecisionPolicy | undefined,
): LocalOrchestrationPlan {
  try {
    return evaluateLocalOrchestration(input, callerAgent, policy)
  } catch {
    return abstain('INVALID_INPUT')
  }
}

function evaluateLocalOrchestration(
  input: unknown,
  callerAgent: unknown,
  policy: LocalDecisionPolicy | undefined,
): LocalOrchestrationPlan {
  if (callerAgent !== 'zeus') return abstain('CALLER_NOT_ZEUS')
  if (!hasUsablePolicy(policy)) {
    return abstain('POLICY_UNAVAILABLE')
  }
  if (!isValidInput(input)) return abstain('INVALID_INPUT')

  const gateStatus = input.gateStatus
  const complexity = classifyLocalDecisionComplexity(input.complexity)
  const zeus = policy.agents.zeus
  if (zeus === undefined) return abstain('POLICY_UNAVAILABLE', gateStatus, input.complexity)
  const eligible = [...new Set(input.candidateAgents)].filter((candidate) => {
    const target = policy.agents[candidate]
    return (
      candidate !== 'zeus' &&
      PANTHEON_AGENTS.has(candidate) &&
      target?.canReceiveDelegation === true &&
      zeus.canDelegateTo.includes(candidate) &&
      isAgentAllowed(policy.permissionTask, candidate)
    )
  })

  if (eligible.length === 0) return abstain('NO_ELIGIBLE_CANDIDATE', gateStatus, input.complexity)

  let agent: string
  if (input.domain !== null) {
    if (!eligible.includes(input.domain)) {
      return abstain('DOMAIN_NOT_ELIGIBLE', gateStatus, input.complexity)
    }
    agent = input.domain
  } else if (eligible.length === 1) {
    const [onlyEligible] = eligible
    if (onlyEligible === undefined) {
      return abstain('NO_ELIGIBLE_CANDIDATE', gateStatus, input.complexity)
    }
    agent = onlyEligible
  } else {
    return abstain('AMBIGUOUS_CANDIDATE', gateStatus, input.complexity)
  }

  const agentPolicy = policy.agents[agent]
  if (agentPolicy === undefined) return abstain('POLICY_UNAVAILABLE', gateStatus, input.complexity)
  const skillIds = input.candidateSkillIds.filter(
    (skill, index, all) => all.indexOf(skill) === index && agentPolicy.skills.includes(skill),
  )
  const allowedResources = new Set(RESOURCE_IDS)
  for (const skill of skillIds) allowedResources.add(`pantheon://skills/${skill}`)
  if (PANTHEON_AGENTS.has(agent)) allowedResources.add(`pantheon://agents/${agent}`)
  const resourceIds = input.candidateResourceIds.filter(
    (resource, index, all) => all.indexOf(resource) === index && allowedResources.has(resource),
  )

  return {
    schemaVersion: 1,
    policyVersion: LOCAL_DECISION_ROUTER_POLICY_VERSION,
    decision: 'recommend',
    reasonCode: 'ADVISORY_ROUTE',
    agent,
    skillIds,
    resourceIds,
    recommendMemorySearch:
      input.memorySearchRelevant && zeus.capabilities.includes('memory_recall'),
    gateStatus,
    complexity,
    action: 'advisory_only',
  }
}
