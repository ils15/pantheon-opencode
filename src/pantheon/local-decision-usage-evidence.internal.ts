/**
 * Internal, parser-issued usage capabilities for the native Decisions route.
 * This module is deliberately not exported from the package entrypoints;
 * callers cannot provide a cost value — the cost comes from the host's own
 * DecisionResult, and this module only mints the opaque capability the ledger
 * accepts. The legacy direct-fetch receipt verifier was removed with the fetch
 * runner.
 */

/** Providers that can appear in usage details: native Decisions routes. */
export type UsageProvider = 'typesafe-jev' | 'opencode-console' | 'jev-free'

export interface ParsedUsageCounts {
  provider: UsageProvider
  model: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
}

export interface UsageReservationBinding {
  reservationId: string
  provider: UsageProvider
  model: string
  period: string
}

declare const verifiedUsageEvidenceBrand: unique symbol
export type VerifiedUsageEvidence = {
  readonly [verifiedUsageEvidenceBrand]: true
}

export interface VerifiedUsageEvidenceDetails extends ParsedUsageCounts {
  reservationId: string
  period: string
  actualCostMicros: number
  pricingSnapshot: 'host-reported'
}

const RESERVATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const UTC_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/
const evidenceDetails = new WeakMap<object, VerifiedUsageEvidenceDetails>()

/**
 * Budget providers with a native host Decisions route. `openai-decisions` is
 * absent: direct OpenAI has no native route, so it can never settle one.
 */
function isNativeUsageProvider(value: string): value is UsageProvider {
  return value === 'typesafe-jev' || value === 'opencode-console' || value === 'jev-free'
}

/**
 * Mint a reconciliation capability from a native host Decisions result.
 *
 * On the native route the host is the billing authority (it owns the provider
 * credentials and the Console ledger), so the host-reported `cost` plays the
 * role the fetch path's provider receipt played. Absent cost is a real zero —
 * the free Console variant and hosts that do not price Decisions both land
 * here, and reconciling at zero releases the reservation instead of burning
 * the period's budget. A result that produced no answer settles nothing: an
 * error payload is not evidence that a decision was paid for.
 */
export function verifyNativeUsageForReservation(
  bindingInput: unknown,
  result: unknown,
): VerifiedUsageEvidence | null {
  try {
    if (
      !isPlainRecord(bindingInput) ||
      !hasExactKeys(bindingInput, ['model', 'period', 'provider', 'reservationId'])
    ) {
      return null
    }
    const provider = bindingInput.provider
    const model = bindingInput.model
    const reservationId = bindingInput.reservationId
    const period = bindingInput.period
    if (
      typeof provider !== 'string' ||
      !isNativeUsageProvider(provider) ||
      typeof model !== 'string' ||
      model.length === 0 ||
      typeof reservationId !== 'string' ||
      !RESERVATION_ID.test(reservationId) ||
      typeof period !== 'string' ||
      !UTC_PERIOD.test(period)
    ) {
      return null
    }
    if (
      !isPlainRecord(result) ||
      !Array.isArray(result.answers) ||
      result.answers.length === 0 ||
      !result.answers.every((answer) => isPlainRecord(answer))
    ) {
      return null
    }

    let actualCostMicros = 0
    if (result.cost !== undefined) {
      if (!isNonNegativeFinite(result.cost)) return null
      actualCostMicros = Math.round(result.cost * 1_000_000)
      if (!Number.isSafeInteger(actualCostMicros)) return null
    }
    let inputTokens = 0
    let outputTokens = 0
    if (result.tokens !== undefined) {
      if (!isPlainRecord(result.tokens)) return null
      const { input, output } = result.tokens
      if (
        (input !== undefined && !isNonNegativeFinite(input)) ||
        (output !== undefined && !isNonNegativeFinite(output))
      ) {
        return null
      }
      inputTokens = typeof input === 'number' ? input : 0
      outputTokens = typeof output === 'number' ? output : 0
    }

    const evidence = Object.freeze(Object.create(null)) as VerifiedUsageEvidence
    evidenceDetails.set(
      evidence,
      Object.freeze({
        provider,
        model,
        inputTokens,
        outputTokens,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        reservationId,
        period,
        actualCostMicros,
        pricingSnapshot: 'host-reported',
      }),
    )
    return evidence
  } catch {
    return null
  }
}

/** Ledger-only runtime check: plain objects and serialized capabilities fail. */
export function getVerifiedUsageEvidenceDetails(
  value: unknown,
): Readonly<VerifiedUsageEvidenceDetails> | null {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return null
  return evidenceDetails.get(value as object) ?? null
}

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort()
  const expected = [...expectedKeys].sort()
  return (
    actualKeys.length === expected.length &&
    actualKeys.every((key, index) => key === expected[index])
  )
}
