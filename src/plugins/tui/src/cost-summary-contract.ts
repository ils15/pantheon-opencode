import type { UsageHistoryPeriod, UsageHistoryPricing, UsageTokenTotals } from './cost-data'
import type { UsageHistoryRpcPeriod, UsageHistoryRpcTotals } from './usage-history-contract'

/** Per-agent rows shown by the panel before the tail is summarised. */
export const MAX_COST_AGENTS = 32

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** Source-level projection input, structurally the `queryCostSummary` result. */
export interface CostSummarySourceAgent {
  agent: string
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  tokensCacheWrite: number
  tokensTotal: number
  estimatedUsd?: number
  pricingComplete: boolean
  unpricedReason?: string
}

export interface CostSummarySourceResult {
  period: UsageHistoryPeriod
  coverageStart: string | null
  partial: boolean
  rows: number
  scanned: number
  assistantRows: number
  agents: CostSummarySourceAgent[]
  totals: UsageTokenTotals
  pricing: UsageHistoryPricing
}

/** One attributed agent row of the RPC contract. */
export interface CostSummaryRpcAgent {
  agent: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  estimatedUsd?: number
  pricingComplete: boolean
}

export interface CostSummaryRpcAvailable {
  /**
   * `partial` when the window is only partly covered, the projection was
   * truncated, or some model groups lack a catalog price — the same honesty
   * rule the cost tool applies to its `(partial)` totals.
   */
  status: 'available' | 'partial'
  period: UsageHistoryRpcPeriod
  coverageStart: string | null
  partial: boolean
  truncated: boolean
  rows: number
  totals: UsageHistoryRpcTotals
  agents: CostSummaryRpcAgent[]
  pricing: {
    status: 'empty' | 'unavailable' | 'partial' | 'complete'
    complete: boolean
    billed: false
    estimatedUsd?: number
    unpricedModels: number
  }
}

export type CostSummaryRpcUnavailableReason =
  | 'invalid_period'
  | 'ledger_unavailable'
  | 'ledger_unsupported'
  | 'ledger_corrupt'
  | 'ledger_timeout'

export interface CostSummaryRpcUnavailable {
  status: 'unavailable'
  reason: CostSummaryRpcUnavailableReason
}

export type CostSummaryRpcResult = CostSummaryRpcAvailable | CostSummaryRpcUnavailable

export function isCostSummaryUnavailableReason(
  value: unknown,
): value is CostSummaryRpcUnavailableReason {
  return (
    value === 'invalid_period' ||
    value === 'ledger_unavailable' ||
    value === 'ledger_unsupported' ||
    value === 'ledger_corrupt' ||
    value === 'ledger_timeout'
  )
}

function safeCount(value: number, markTruncated: () => void): number {
  if (!Number.isFinite(value) || value < 0) {
    markTruncated()
    return 0
  }
  if (!Number.isSafeInteger(value)) {
    markTruncated()
    return Math.min(Math.floor(value), MAX_SAFE_INTEGER)
  }
  return value
}

function safeEstimate(value: number | undefined, markTruncated: () => void): number | undefined {
  if (value === undefined) return undefined
  if (!Number.isFinite(value) || value < 0) {
    markTruncated()
    return undefined
  }
  const rounded = Math.round(value * 1e8) / 1e8
  if (!Number.isFinite(rounded)) {
    markTruncated()
    return undefined
  }
  return rounded
}

/** Agent labels the ledger cannot vouch for read as `unknown`, never verbatim. */
function safeAgentLabel(value: string, markTruncated: () => void): string {
  if (!SAFE_LABEL.test(value)) {
    markTruncated()
    return 'unknown'
  }
  return value
}

function projectTotals(value: UsageTokenTotals, markTruncated: () => void): UsageHistoryRpcTotals {
  return {
    input: safeCount(value.input, markTruncated),
    output: safeCount(value.output, markTruncated),
    cacheRead: safeCount(value.cacheRead, markTruncated),
    cacheWrite: safeCount(value.cacheWrite, markTruncated),
    total: safeCount(value.total, markTruncated),
  }
}

/**
 * Project the ledger read into the bounded, non-identifying panel contract.
 *
 * A ledger that was found but yields no attributable tokens is a diagnosis, not
 * an empty report: rows scanned with no assistant match, or assistant rows
 * whose aggregates carry no token at all, map to `ledger_unsupported` — the
 * UNSUPPORTED analogue of the cost tool. Cache-only usage counts as usage, so
 * the diagnosis fires only when every token column is zero.
 */
export function projectCostSummaryResult(result: CostSummarySourceResult): CostSummaryRpcResult {
  const markUnsupported = (): CostSummaryRpcUnavailable => ({
    status: 'unavailable',
    reason: 'ledger_unsupported',
  })
  if (result.scanned > 0) {
    if (result.assistantRows === 0) return markUnsupported()
    const totals = result.totals
    if (
      totals.input === 0 &&
      totals.output === 0 &&
      totals.cacheRead === 0 &&
      totals.cacheWrite === 0
    ) {
      return markUnsupported()
    }
  }

  let unsafeOrTruncated = false
  const markTruncated = (): void => {
    unsafeOrTruncated = true
  }
  const sortedAgents = [...result.agents].sort(
    (left, right) => right.tokensTotal - left.tokensTotal,
  )
  if (sortedAgents.length > MAX_COST_AGENTS) markTruncated()
  const agents = sortedAgents.slice(0, MAX_COST_AGENTS).map((agent) => {
    const estimatedUsd = safeEstimate(agent.estimatedUsd, markTruncated)
    return {
      agent: safeAgentLabel(agent.agent, markTruncated),
      input: safeCount(agent.tokensInput, markTruncated),
      output: safeCount(agent.tokensOutput, markTruncated),
      cacheRead: safeCount(agent.tokensCacheRead, markTruncated),
      cacheWrite: safeCount(agent.tokensCacheWrite, markTruncated),
      total: safeCount(agent.tokensTotal, markTruncated),
      ...(estimatedUsd === undefined ? {} : { estimatedUsd }),
      pricingComplete: agent.pricingComplete === true,
    }
  })
  let coverageStart = result.coverageStart
  if (coverageStart !== null && !ISO_DATE.test(coverageStart)) {
    markTruncated()
    coverageStart = null
  }
  const pricingEstimate = safeEstimate(result.pricing.estimatedUsd, markTruncated)
  const rows = safeCount(result.rows, markTruncated)
  const totals = projectTotals(result.totals, markTruncated)
  const unpricedModels = safeCount(result.pricing.unpricedModels, markTruncated)
  const truncated = unsafeOrTruncated
  const empty = rows === 0
  const pricingComplete = result.pricing.status === 'complete'
  return {
    status: result.partial || truncated || (!empty && !pricingComplete) ? 'partial' : 'available',
    period: result.period,
    coverageStart,
    partial: result.partial === true,
    truncated,
    rows,
    totals,
    agents,
    pricing: {
      status: result.pricing.status,
      complete: pricingComplete,
      billed: false,
      ...(pricingEstimate === undefined ? {} : { estimatedUsd: pricingEstimate }),
      unpricedModels,
    },
  }
}
