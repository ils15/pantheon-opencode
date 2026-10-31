/**
 * V2 decision policy — deterministic selection, gates, shadow/active and budget.
 *
 * The policy is deliberately separate from the heuristic: it answers "may this
 * point be evaluated at all, and in which mode?" and never inspects prompt,
 * response or any other content. It uses no clock, no randomness and no
 * network, so the same request always yields the same decision.
 *
 * This phase has no effect path. Even an admitted decision reports
 * `effect: 'none'`; activation, any observable effect and the wiring of the
 * points that have no production call site belong to later phases and are not
 * implemented here.
 */

import {
  DECISION_POINT_IDS,
  type DecisionPointId,
  type DecisionPointMode,
  type DecisionPointStatus,
} from './v2-decision-registry.ts'

export const DECISION_POLICY_VERSION = 'v2-decision-policy/1'
export const DEFAULT_DECISIONS_PER_TURN = 32

export type PolicyMode = 'shadow' | 'active'

export type PolicyDenialReason =
  | 'UNKNOWN_POINT'
  | 'DEFERRED_POINT'
  | 'MIGRATION_NOT_SHADOW'
  | 'POINT_OFF'
  | 'GATE_CLOSED'
  | 'ACTIVE_NOT_ALLOWED'
  | 'BUDGET_EXHAUSTED'

export type PolicyReasonCode = 'SHADOW' | 'ACTIVE' | PolicyDenialReason

export interface DecisionBudgetSnapshot {
  readonly maxPerTurn: number
  readonly used: number
  readonly remaining: number
}

/** Per-turn decision budget. Deterministic: no clock, no persistence. */
export interface DecisionBudget {
  tryConsume(): boolean
  remaining(): number
  resetTurn(): void
  snapshot(): DecisionBudgetSnapshot
}

export function createDecisionBudget(
  maxPerTurn: number = DEFAULT_DECISIONS_PER_TURN,
): DecisionBudget {
  if (!Number.isInteger(maxPerTurn) || maxPerTurn < 0 || maxPerTurn > 10_000) {
    throw new RangeError('maxPerTurn must be an integer in 0..10000')
  }
  let used = 0
  return {
    tryConsume() {
      if (used >= maxPerTurn) return false
      used += 1
      return true
    },
    remaining() {
      return maxPerTurn - used
    },
    resetTurn() {
      used = 0
    },
    snapshot() {
      return Object.freeze({ maxPerTurn, used, remaining: maxPerTurn - used })
    },
  }
}

export interface DecisionPolicyConfig {
  /** Global mode. Defaults to shadow; `active` also requires `allowActive`. */
  readonly mode?: PolicyMode
  readonly allowActive?: boolean
  readonly budget?: DecisionBudget
  /** Condition ids (C6, C7, …) that are currently closed. */
  readonly closedGates?: readonly string[]
}

export interface DecisionPolicyRequest {
  readonly point: string
  readonly pointMode: DecisionPointMode
  readonly status: DecisionPointStatus
  readonly requiredGates?: readonly string[]
}

export interface PolicyDecision {
  readonly version: typeof DECISION_POLICY_VERSION
  readonly point: string
  readonly admitted: boolean
  readonly mode: PolicyMode
  readonly effect: 'none'
  readonly reasonCode: PolicyReasonCode
}

/** Whether a string names a registry point. */
export function isDecisionPointId(value: unknown): value is DecisionPointId {
  return typeof value === 'string' && (DECISION_POINT_IDS as readonly string[]).includes(value)
}

function deny(point: string, mode: PolicyMode, reasonCode: PolicyDenialReason): PolicyDecision {
  return Object.freeze({
    version: DECISION_POLICY_VERSION,
    point,
    admitted: false,
    mode,
    effect: 'none',
    reasonCode,
  })
}

/**
 * Decide whether a point may be evaluated in this turn.
 *
 * Order is fixed so the outcome is reproducible: unknown point, deferred
 * status, migration mode, off mode, closed gate, activation permission, budget.
 * `effect` is always `none` — admission is not an effect.
 */
export function evaluateDecisionPolicy(
  config: DecisionPolicyConfig,
  request: DecisionPolicyRequest,
): PolicyDecision {
  const requestedMode: PolicyMode = config.mode === 'active' ? 'active' : 'shadow'

  if (!isDecisionPointId(request.point)) {
    return deny(request.point, requestedMode, 'UNKNOWN_POINT')
  }
  if (request.status === 'deferred') {
    return deny(request.point, requestedMode, 'DEFERRED_POINT')
  }
  if (request.pointMode === 'migration') {
    return deny(request.point, requestedMode, 'MIGRATION_NOT_SHADOW')
  }
  if (request.pointMode === 'off') {
    return deny(request.point, requestedMode, 'POINT_OFF')
  }

  const closed = new Set(config.closedGates ?? [])
  for (const gate of request.requiredGates ?? []) {
    if (closed.has(gate)) return deny(request.point, requestedMode, 'GATE_CLOSED')
  }

  if (requestedMode === 'active' && config.allowActive !== true) {
    return deny(request.point, requestedMode, 'ACTIVE_NOT_ALLOWED')
  }

  const budget = config.budget
  if (budget && !budget.tryConsume()) {
    return deny(request.point, requestedMode, 'BUDGET_EXHAUSTED')
  }

  return Object.freeze({
    version: DECISION_POLICY_VERSION,
    point: request.point,
    admitted: true,
    mode: requestedMode,
    effect: 'none',
    reasonCode: requestedMode === 'active' ? 'ACTIVE' : 'SHADOW',
  })
}
