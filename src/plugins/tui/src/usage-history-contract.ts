export const MAX_HISTORY_BUCKETS = 366
export const MAX_HISTORY_MODELS = 64
export const MAX_HISTORY_QUERY_MS = 5_000

export type UsageHistoryRpcPeriod = '7d' | '15d' | '30d' | 'total'

interface UsageHistorySourceTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

interface UsageHistorySourceBucket extends UsageHistorySourceTotals {
  date: string
  estimatedUsd?: number
  pricingComplete: boolean
}

interface UsageHistorySourceModel {
  providerID: string
  modelID: string
  totals: UsageHistorySourceTotals
  buckets: UsageHistorySourceBucket[]
  estimatedUsd?: number
  pricingComplete: boolean
}

interface UsageHistorySourceResult {
  period: UsageHistoryRpcPeriod
  coverageStart: string | null
  partial: boolean
  rows: number
  buckets: UsageHistorySourceBucket[]
  totals: UsageHistorySourceTotals
  models: UsageHistorySourceModel[]
  pricing: {
    status: 'empty' | 'unavailable' | 'partial' | 'complete'
    complete: boolean
    estimatedUsd?: number
    unpricedModels: number
  }
}

export interface UsageHistoryRpcTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

export interface UsageHistoryRpcBucket extends UsageHistoryRpcTotals {
  date: string
  estimatedUsd?: number
  pricingComplete: boolean
}

export interface UsageHistoryRpcModel {
  providerID: string
  modelID: string
  totals: UsageHistoryRpcTotals
  estimatedUsd?: number
  pricingComplete: boolean
}

export interface UsageHistoryRpcAvailable {
  status: 'available' | 'partial'
  period: UsageHistoryRpcPeriod
  coverageStart: string | null
  partial: boolean
  truncated: boolean
  rows: number
  buckets: UsageHistoryRpcBucket[]
  totals: UsageHistoryRpcTotals
  models: UsageHistoryRpcModel[]
  pricing: {
    status: 'empty' | 'unavailable' | 'partial' | 'complete'
    complete: boolean
    billed: false
    estimatedUsd?: number
    unpricedModels: number
  }
}

export interface UsageHistoryRpcUnavailable {
  status: 'unavailable'
  reason: 'invalid_period' | 'history_unavailable' | 'history_timeout'
}

export type UsageHistoryRpcResult = UsageHistoryRpcAvailable | UsageHistoryRpcUnavailable

export const USAGE_HISTORY_PERIODS: readonly UsageHistoryRpcPeriod[] = ['7d', '15d', '30d', 'total']

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

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

function safeLabel(value: string, markTruncated: () => void): string {
  if (!SAFE_LABEL.test(value)) {
    markTruncated()
    return 'unknown'
  }
  return value
}

function projectTotals(
  value: UsageHistorySourceTotals,
  markTruncated: () => void,
): UsageHistoryRpcTotals {
  return {
    input: safeCount(value.input, markTruncated),
    output: safeCount(value.output, markTruncated),
    cacheRead: safeCount(value.cacheRead, markTruncated),
    cacheWrite: safeCount(value.cacheWrite, markTruncated),
    total: safeCount(value.total, markTruncated),
  }
}

/** Project cost-command output to a bounded, non-identifying TUI contract. */
export function projectUsageHistoryResult(
  result: UsageHistorySourceResult,
): UsageHistoryRpcAvailable {
  let unsafeOrTruncated = false
  const markTruncated = (): void => {
    unsafeOrTruncated = true
  }
  const sourceBuckets = result.buckets
  const sourceModels = result.models
  if (sourceBuckets.length > MAX_HISTORY_BUCKETS || sourceModels.length > MAX_HISTORY_MODELS) {
    markTruncated()
  }
  const buckets = sourceBuckets.slice(-MAX_HISTORY_BUCKETS).flatMap((bucket) => {
    if (!ISO_DATE.test(bucket.date)) {
      markTruncated()
      return []
    }
    const estimatedUsd = safeEstimate(bucket.estimatedUsd, markTruncated)
    return [
      {
        date: bucket.date,
        ...projectTotals(bucket, markTruncated),
        ...(estimatedUsd === undefined ? {} : { estimatedUsd }),
        pricingComplete: bucket.pricingComplete === true,
      },
    ]
  })
  const models = sourceModels.slice(0, MAX_HISTORY_MODELS).map((model) => {
    const estimatedUsd = safeEstimate(model.estimatedUsd, markTruncated)
    return {
      providerID: safeLabel(model.providerID, markTruncated),
      modelID: safeLabel(model.modelID, markTruncated),
      totals: projectTotals(model.totals, markTruncated),
      ...(estimatedUsd === undefined ? {} : { estimatedUsd }),
      pricingComplete: model.pricingComplete === true,
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
  return {
    status: result.partial || truncated ? 'partial' : 'available',
    period: result.period,
    coverageStart,
    partial: result.partial,
    truncated,
    rows,
    buckets,
    totals,
    models,
    pricing: {
      status: result.pricing.status,
      complete: result.pricing.complete === true,
      billed: false,
      ...(pricingEstimate === undefined ? {} : { estimatedUsd: pricingEstimate }),
      unpricedModels,
    },
  }
}

export function isUsageHistoryPeriod(value: unknown): value is UsageHistoryRpcPeriod {
  return typeof value === 'string' && USAGE_HISTORY_PERIODS.includes(value as UsageHistoryRpcPeriod)
}
