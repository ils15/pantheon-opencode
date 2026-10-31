/**
 * P1 (agent) shadow adapter.
 *
 * The measured prompt payload carries `agents: "undefined"` — the string, in
 * every observed prompt hook (F-08) — so the default path has no agent
 * candidate at all and the heuristic refuses with `no.candidates`. A populated
 * `prompt.agents` was never observed (PM-07), so any candidate list here is a
 * premise, not a measurement, and no candidate carries evidence: the heuristic
 * refuses with `insufficient.evidence` instead of inventing support.
 *
 * Shadow by construction: the admission payload is cloned and frozen by
 * `observeShadow`, the record always says `effect: 'none'`, and no failure is
 * rethrown into admission.
 */

import { normalizeMeasuredValue } from '../local-decision-prompt.ts'
import { decideHeuristic, type HeuristicOutcome } from '../v2-decision-heuristic.ts'
import {
  observeShadow,
  type ShadowDecision,
  type ShadowRecord,
  type ShadowSink,
} from '../v2-decision-shadow.ts'

export type AgentSource = 'agents' | 'none'

export interface AgentPointResult {
  readonly record: ShadowRecord
  /** `agents` when the payload carried a real list, `none` otherwise. */
  readonly agentSource: AgentSource
  readonly agentIds: readonly string[]
  /** Token explaining the decision; always present. */
  readonly reason: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function agentIdentifier(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value
  if (!isRecord(value)) return undefined
  for (const candidate of [value.name, value.id, value.slug]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate
  }
  return undefined
}

/** Read `prompt.agents` with the measured sentinel normalized to absent (F-08). */
function promptAgents(admission: unknown): string[] {
  if (!isRecord(admission)) return []
  const prompt = admission.prompt
  if (!isRecord(prompt)) return []
  const list = normalizeMeasuredValue(prompt.agents)
  if (!Array.isArray(list)) return []
  const ids: string[] = []
  for (const item of list) {
    const identifier = agentIdentifier(item)
    if (identifier !== undefined && !ids.includes(identifier)) ids.push(identifier)
  }
  return ids
}

/** Heuristic reason codes as shadow-record tokens (underscores are not tokens). */
function tokenOf(reasonCode: HeuristicOutcome['reasonCode']): string {
  return reasonCode.toLowerCase().split('_').join('.')
}

/**
 * Observe P1 in shadow.
 *
 * @param admission Host admission payload (never mutated).
 * @param sink      Optional shadow-record observer.
 */
export function evaluateAgentPoint(admission: unknown, sink?: ShadowSink): AgentPointResult {
  const agentIds = promptAgents(admission)
  const outcome = decideHeuristic({
    candidates: agentIds.map((id) => ({ id, evidence: [] })),
    minimumEvidence: 1,
  })
  const decision: ShadowDecision = {
    decision: outcome.kind === 'choice' ? 'choice' : 'refusal',
    reason: tokenOf(outcome.reasonCode),
  }
  return {
    record: observeShadow('P1', admission, () => decision, sink),
    agentSource: agentIds.length > 0 ? 'agents' : 'none',
    agentIds,
    reason: decision.reason,
  }
}
