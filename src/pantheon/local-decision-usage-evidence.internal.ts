/**
 * Internal, parser-issued usage capabilities. This module is deliberately not
 * exported from the package entrypoints; callers cannot provide a cost value.
 */

export type ReconciliableUsageProvider = 'openai-decisions' | 'typesafe-jev'

/** Providers that can appear in usage details: fetch receipts or native routes. */
export type UsageProvider = ReconciliableUsageProvider | 'opencode-console' | 'jev-free'

export interface UsageReservationBinding {
  reservationId: string
  provider: ReconciliableUsageProvider
  model: string
  period: string
}

declare const verifiedUsageEvidenceBrand: unique symbol
export type VerifiedUsageEvidence = {
  readonly [verifiedUsageEvidenceBrand]: true
}

export interface ParsedUsageCounts {
  provider: UsageProvider
  model: string
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  cacheWriteInputTokens: number
}

export interface VerifiedUsageEvidenceDetails extends ParsedUsageCounts {
  reservationId: string
  period: string
  actualCostMicros: number
  pricingSnapshot: '2026-10-30' | 'host-reported'
}

const MODEL_IDS: Readonly<Record<ReconciliableUsageProvider, string>> = Object.freeze({
  'openai-decisions': 'gpt-6-luna',
  'typesafe-jev': 'jev-1.14.0',
})
const RESERVATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const UTC_PERIOD = /^\d{4}-(0[1-9]|1[0-2])$/
const evidenceDetails = new WeakMap<object, VerifiedUsageEvidenceDetails>()

/**
 * Validate only official usage fields for providers with a documented price
 * snapshot, then mint an opaque capability bound to one reservation identity.
 * Console models and zero-cost results deliberately produce no capability.
 */
export function verifyProviderUsageForReservation(
  bindingInput: unknown,
  response: unknown,
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
      !isReconciliableProvider(provider) ||
      model !== MODEL_IDS[provider] ||
      typeof reservationId !== 'string' ||
      !RESERVATION_ID.test(reservationId) ||
      typeof period !== 'string' ||
      !UTC_PERIOD.test(period)
    ) {
      return null
    }
    const parsed = parseProviderUsageCounts(provider, response)
    if (!parsed || parsed.model !== model) return null
    if (parsed.cachedInputTokens !== 0 || parsed.cacheWriteInputTokens !== 0) return null
    const actualCostMicros = priceUsageMicros(parsed)
    if (actualCostMicros === null || actualCostMicros <= 0) return null

    const evidence = Object.freeze(Object.create(null)) as VerifiedUsageEvidence
    evidenceDetails.set(
      evidence,
      Object.freeze({
        ...parsed,
        reservationId,
        period,
        actualCostMicros,
        pricingSnapshot: '2026-10-30',
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

/** Shared strict usage parser used by the isolated provider-contract tests. */
export function parseProviderUsageCounts(
  provider: unknown,
  response: unknown,
): ParsedUsageCounts | null {
  try {
    if (
      !isReconciliableProvider(provider) ||
      !isPlainRecord(response) ||
      response.model !== MODEL_IDS[provider] ||
      !isPlainRecord(response.usage)
    ) {
      return null
    }
    const usage = response.usage
    if (provider === 'openai-decisions') {
      if (
        !hasExactKeys(usage, [
          'input_tokens',
          'input_tokens_details',
          'output_tokens',
          'output_tokens_details',
          'total_tokens',
        ]) ||
        !isPlainRecord(usage.input_tokens_details) ||
        !hasExactKeys(usage.input_tokens_details, ['cache_write_tokens', 'cached_tokens']) ||
        !isPlainRecord(usage.output_tokens_details) ||
        !hasExactKeys(usage.output_tokens_details, ['reasoning_tokens']) ||
        !isNonNegativeSafeInteger(usage.input_tokens) ||
        !isNonNegativeSafeInteger(usage.output_tokens) ||
        !isNonNegativeSafeInteger(usage.total_tokens) ||
        !isNonNegativeSafeInteger(usage.input_tokens_details.cache_write_tokens) ||
        !isNonNegativeSafeInteger(usage.input_tokens_details.cached_tokens) ||
        !isNonNegativeSafeInteger(usage.output_tokens_details.reasoning_tokens) ||
        !Number.isSafeInteger(usage.input_tokens + usage.output_tokens) ||
        usage.input_tokens + usage.output_tokens !== usage.total_tokens ||
        usage.input_tokens_details.cache_write_tokens + usage.input_tokens_details.cached_tokens >
          usage.input_tokens ||
        usage.output_tokens_details.reasoning_tokens > usage.output_tokens
      ) {
        return null
      }
    } else if (
      !hasExactKeys(usage, ['input_tokens', 'output_tokens']) ||
      !isNonNegativeSafeInteger(usage.input_tokens) ||
      !isNonNegativeSafeInteger(usage.output_tokens)
    ) {
      return null
    }
    return {
      provider,
      model: MODEL_IDS[provider],
      inputTokens: usage.input_tokens as number,
      outputTokens: usage.output_tokens as number,
      cachedInputTokens:
        provider === 'openai-decisions'
          ? ((usage.input_tokens_details as Record<string, number>).cached_tokens as number)
          : 0,
      cacheWriteInputTokens:
        provider === 'openai-decisions'
          ? ((usage.input_tokens_details as Record<string, number>).cache_write_tokens as number)
          : 0,
    }
  } catch {
    return null
  }
}

function priceUsageMicros(usage: ParsedUsageCounts): number | null {
  // Snapshot: GPT-6 Luna standard rates are $0.10/M input and $0.50/M output;
  // TypeSafe Jev 1.14 is $0.042/M input and $0 output. Discounts are not applied.
  const numerator =
    usage.provider === 'openai-decisions'
      ? BigInt(usage.inputTokens) + 5n * BigInt(usage.outputTokens)
      : 42n * BigInt(usage.inputTokens)
  const denominator = usage.provider === 'openai-decisions' ? 10n : 1_000n
  const roundedMicros = (numerator + denominator - 1n) / denominator
  if (roundedMicros <= 0n || roundedMicros > BigInt(Number.MAX_SAFE_INTEGER)) return null
  return Number(roundedMicros)
}

function isReconciliableProvider(value: unknown): value is ReconciliableUsageProvider {
  return value === 'openai-decisions' || value === 'typesafe-jev'
}

/**
 * Budget providers with a native host Decisions route. `openai-decisions` is
 * absent: direct OpenAI has no native route, so it can never settle one.
 */
function isNativeUsageProvider(value: string): value is Exclude<UsageProvider, 'openai-decisions'> {
  return value === 'typesafe-jev' || value === 'opencode-console' || value === 'jev-free'
}

/**
 * Mint a reconciliation capability from a native host Decisions result.
 *
 * On the native route the host is the billing authority (it owns the provider
 * credentials and the Console ledger), so the host-reported `cost` plays the
 * role the fetch path's provider receipt plays. Absent cost is a real zero —
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

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
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
