import type {
  UsageHistoryRpcBucket,
  UsageHistoryRpcModel,
  UsageHistoryRpcResult,
  UsageHistoryRpcTotals,
} from './usage-history-contract'
import type { ActiveContextCostResult } from './usage-view-model'

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function isTotals(value: unknown): value is UsageHistoryRpcTotals {
  const totals = asRecord(value)
  return (
    totals !== null &&
    ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(
      (key) =>
        typeof totals[key] === 'number' && Number.isSafeInteger(totals[key]) && totals[key] >= 0,
    )
  )
}

function isHistoryBucket(value: unknown): value is UsageHistoryRpcBucket {
  const bucket = asRecord(value)
  return (
    bucket !== null &&
    typeof bucket.date === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(bucket.date) &&
    isTotals(bucket) &&
    typeof bucket.pricingComplete === 'boolean' &&
    (bucket.estimatedUsd === undefined ||
      (typeof bucket.estimatedUsd === 'number' && Number.isFinite(bucket.estimatedUsd)))
  )
}

function isHistoryModel(value: unknown): value is UsageHistoryRpcModel {
  const model = asRecord(value)
  return (
    model !== null &&
    typeof model.providerID === 'string' &&
    typeof model.modelID === 'string' &&
    isTotals(model.totals) &&
    typeof model.pricingComplete === 'boolean' &&
    (model.estimatedUsd === undefined ||
      (typeof model.estimatedUsd === 'number' && Number.isFinite(model.estimatedUsd)))
  )
}

export function isUsageHistoryRpcResult(value: unknown): value is UsageHistoryRpcResult {
  const result = asRecord(value)
  if (!result) return false
  if (result.status === 'unavailable') {
    return ['invalid_period', 'history_unavailable', 'history_timeout'].includes(
      String(result.reason),
    )
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
    Array.isArray(result.buckets) &&
    result.buckets.every(isHistoryBucket) &&
    isTotals(result.totals) &&
    Array.isArray(result.models) &&
    result.models.every(isHistoryModel) &&
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

export function isActiveContextCostResult(value: unknown): value is ActiveContextCostResult {
  const result = asRecord(value)
  if (result?.billed !== false) return false
  if (result.cacheDiscountApplied !== false) return false
  if (result.basis !== 'pre-cache-context-tokens-times-input-price') return false
  if (result.status === 'estimated') {
    return typeof result.estimatedUsd === 'number' && Number.isFinite(result.estimatedUsd)
  }
  return (
    result.status === 'unavailable' &&
    [
      'invalid-context-token-count',
      'missing-model-identity',
      'no-pricing',
      'unknown-model',
      'ambiguous-model',
      'missing-cache-price',
    ].includes(String(result.reason))
  )
}
