import { PANTHEON_AGENTS } from './v2-delegation-enforce.ts'

/** Explicit opt-in for the local advisory API. Unset and any value except `1` disable it. */
export const LOCAL_DECISION_ROUTER_ENV = 'PANTHEON_LOCAL_DECISION_ROUTER'
export const LOCAL_DECISION_ROUTER_POLICY_VERSION = 'local-decision-router/v1'

export const LOCAL_DECISION_COMPLEXITY_DIMENSIONS = [
  'boundedness',
  'reversibility',
  'dependencies',
  'uncertainty',
  'verification',
] as const

export type LocalDecisionComplexityDimensions = Readonly<
  Record<(typeof LOCAL_DECISION_COMPLEXITY_DIMENSIONS)[number], 0 | 1 | 2>
>

export type LocalDecisionGateStatus =
  | 'none'
  | 'review_required'
  | 'human_approval_required'
  | 'unresolved'

/** Versioned structured input; domain entries are exact canonical specialist IDs. */
export interface LocalDecisionInput {
  schemaVersion: 1
  domains: readonly string[]
  complexity: LocalDecisionComplexityDimensions
  gateStatus: LocalDecisionGateStatus
}

export type LocalDecisionRouteReasonCode =
  | 'DISABLED'
  | 'INVALID_INPUT'
  | 'NO_DOMAIN'
  | 'AMBIGUOUS_DOMAIN'
  | 'UNKNOWN_DOMAIN'
  | 'UNROUTABLE_ROLE'
  | 'CANONICAL_ROLE'

export type LocalDecisionComplexityReasonCode =
  | 'DISABLED'
  | 'INVALID_INPUT'
  | 'INVALID_COMPLEXITY'
  | 'CLASSIFIED_FROM_STRUCTURED_DIMENSIONS'

export interface LocalDecisionRecommendation {
  schemaVersion: 1
  policyVersion: typeof LOCAL_DECISION_ROUTER_POLICY_VERSION
  decision: 'route' | 'abstain'
  /** Non-null only when `decision` is `route`, and always a canonical specialist ID. */
  agent: string | null
  reasonCode: LocalDecisionRouteReasonCode
  complexity: {
    label: 'low' | 'medium' | 'high' | 'abstain'
    reasonCode: LocalDecisionComplexityReasonCode
  }
  /** Security/authorization status is carried separately and never changes complexity. */
  gateStatus: LocalDecisionGateStatus
}

const ROUTABLE_AGENTS: ReadonlySet<string> = new Set(
  [...PANTHEON_AGENTS].filter((agent) => agent !== 'zeus'),
)

const GATE_STATUSES: ReadonlySet<string> = new Set([
  'none',
  'review_required',
  'human_approval_required',
  'unresolved',
])

const INPUT_KEYS = ['complexity', 'domains', 'gateStatus', 'schemaVersion']
const COMPLEXITY_KEYS = [...LOCAL_DECISION_COMPLEXITY_DIMENSIONS].sort()

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort()
  const expectedKeys = [...keys].sort()
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  )
}

function isValidInputShape(input: unknown): input is LocalDecisionInput {
  if (!isPlainRecord(input) || !hasExactKeys(input, INPUT_KEYS)) return false
  if (
    input.schemaVersion !== 1 ||
    typeof input.gateStatus !== 'string' ||
    !GATE_STATUSES.has(input.gateStatus)
  ) {
    return false
  }
  if (
    !Array.isArray(input.domains) ||
    !input.domains.every((domain) => typeof domain === 'string')
  ) {
    return false
  }
  if (!isPlainRecord(input.complexity) || !hasExactKeys(input.complexity, COMPLEXITY_KEYS)) {
    return false
  }
  return classifyLocalDecisionComplexity(input.complexity).label !== 'abstain'
}

export function classifyLocalDecisionComplexity(
  value: unknown,
): LocalDecisionRecommendation['complexity'] {
  if (!isPlainRecord(value) || !hasExactKeys(value, COMPLEXITY_KEYS)) {
    return { label: 'abstain', reasonCode: 'INVALID_COMPLEXITY' }
  }

  const scores = LOCAL_DECISION_COMPLEXITY_DIMENSIONS.map((dimension) => value[dimension])
  if (
    !scores.every(
      (score) => typeof score === 'number' && Number.isInteger(score) && score >= 0 && score <= 2,
    )
  ) {
    return { label: 'abstain', reasonCode: 'INVALID_COMPLEXITY' }
  }

  const label = scores.includes(2) ? 'high' : scores.includes(1) ? 'medium' : 'low'
  return { label, reasonCode: 'CLASSIFIED_FROM_STRUCTURED_DIMENSIONS' }
}

function createAbstention(
  reasonCode: LocalDecisionRouteReasonCode,
  complexityReasonCode: LocalDecisionComplexityReasonCode,
  gateStatus: LocalDecisionGateStatus = 'unresolved',
): LocalDecisionRecommendation {
  return {
    schemaVersion: 1,
    policyVersion: LOCAL_DECISION_ROUTER_POLICY_VERSION,
    decision: 'abstain',
    agent: null,
    reasonCode,
    complexity: { label: 'abstain', reasonCode: complexityReasonCode },
    gateStatus,
  }
}

function evaluateEnabledInput(input: unknown): LocalDecisionRecommendation {
  if (!isValidInputShape(input)) {
    const gateStatus =
      isPlainRecord(input) &&
      typeof input.gateStatus === 'string' &&
      GATE_STATUSES.has(input.gateStatus)
        ? (input.gateStatus as LocalDecisionGateStatus)
        : 'unresolved'
    const complexity = isPlainRecord(input)
      ? classifyLocalDecisionComplexity(input.complexity)
      : { label: 'abstain' as const, reasonCode: 'INVALID_COMPLEXITY' as const }
    const complexityReasonCode =
      complexity.reasonCode === 'INVALID_COMPLEXITY' ? 'INVALID_COMPLEXITY' : 'INVALID_INPUT'
    return createAbstention('INVALID_INPUT', complexityReasonCode, gateStatus)
  }

  const gateStatus = input.gateStatus
  const complexity = classifyLocalDecisionComplexity(input.complexity)

  if (input.domains.length === 0) {
    return { ...createAbstention('NO_DOMAIN', complexity.reasonCode, gateStatus), complexity }
  }
  if (input.domains.length !== 1) {
    return {
      ...createAbstention('AMBIGUOUS_DOMAIN', complexity.reasonCode, gateStatus),
      complexity,
    }
  }

  const [domain] = input.domains
  if (typeof domain !== 'string') {
    return createAbstention('INVALID_INPUT', complexity.reasonCode, gateStatus)
  }
  if (domain === 'zeus') {
    return {
      ...createAbstention('UNROUTABLE_ROLE', complexity.reasonCode, gateStatus),
      complexity,
    }
  }
  if (!ROUTABLE_AGENTS.has(domain)) {
    return {
      ...createAbstention('UNKNOWN_DOMAIN', complexity.reasonCode, gateStatus),
      complexity,
    }
  }

  return {
    schemaVersion: 1,
    policyVersion: LOCAL_DECISION_ROUTER_POLICY_VERSION,
    decision: 'route',
    agent: domain,
    reasonCode: 'CANONICAL_ROLE',
    complexity,
    gateStatus,
  }
}

/**
 * Return a local advisory recommendation only when explicitly enabled.
 *
 * This function never calls a provider, dispatches an agent, or changes permissions.
 * The default-off environment gate intentionally leaves native host dispatch untouched.
 */
export function recommendLocalDecision(
  input: LocalDecisionInput,
  env: Readonly<Record<string, string | undefined>> = process.env,
): LocalDecisionRecommendation {
  try {
    if (env[LOCAL_DECISION_ROUTER_ENV] !== '1') {
      return createAbstention('DISABLED', 'DISABLED')
    }
    return evaluateEnabledInput(input)
  } catch {
    // Malformed accessors and injected env are invalid data; never route on failure.
    return createAbstention('INVALID_INPUT', 'INVALID_INPUT')
  }
}
