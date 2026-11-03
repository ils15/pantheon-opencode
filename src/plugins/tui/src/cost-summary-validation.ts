import type { CostSummaryRpcResult, CostSummaryRpcUnavailableReason } from './cost-summary-contract'

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

const REASONS: readonly CostSummaryRpcUnavailableReason[] = [
  'invalid_period',
  'ledger_unavailable',
  'ledger_unsupported',
  'ledger_corrupt',
  'ledger_timeout',
]

function isTotals(value: unknown): boolean {
  const totals = asRecord(value)
  return (
    totals !== null &&
    ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(
      (key) =>
        typeof totals[key] === 'number' && Number.isSafeInteger(totals[key]) && totals[key] >= 0,
    )
  )
}

function isAgent(value: unknown): boolean {
  const agent = asRecord(value)
  return (
    agent !== null &&
    typeof agent.agent === 'string' &&
    agent.agent.length > 0 &&
    isTotals(agent) &&
    typeof agent.pricingComplete === 'boolean' &&
    (agent.estimatedUsd === undefined ||
      (typeof agent.estimatedUsd === 'number' && Number.isFinite(agent.estimatedUsd)))
  )
}

/** Client-side guard: only a well-formed, aggregate-only cost summary renders. */
export function isCostSummaryRpcResult(value: unknown): value is CostSummaryRpcResult {
  const result = asRecord(value)
  if (!result) return false
  if (result.status === 'unavailable') {
    return REASONS.includes(String(result.reason) as CostSummaryRpcUnavailableReason)
  }
  if (result.status !== 'available' && result.status !== 'partial') return false
  const pricing = asRecord(result.pricing)
  return (
    ['7d', '15d', '30d', 'total'].includes(String(result.period)) &&
    (result.coverageStart === null || typeof result.coverageStart === 'string') &&
    typeof result.partial === 'boolean' &&
    typeof result.truncated === 'boolean' &&
    typeof result.rows === 'number' &&
    Number.isSafeInteger(result.rows) &&
    result.rows >= 0 &&
    isTotals(result.totals) &&
    Array.isArray(result.agents) &&
    result.agents.every(isAgent) &&
    pricing !== null &&
    ['empty', 'unavailable', 'partial', 'complete'].includes(String(pricing.status)) &&
    typeof pricing.complete === 'boolean' &&
    pricing.billed === false &&
    typeof pricing.unpricedModels === 'number' &&
    Number.isSafeInteger(pricing.unpricedModels) &&
    pricing.unpricedModels >= 0 &&
    (pricing.estimatedUsd === undefined ||
      (typeof pricing.estimatedUsd === 'number' && Number.isFinite(pricing.estimatedUsd)))
  )
}
