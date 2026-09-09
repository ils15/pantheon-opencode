/**
 * Exact provider usage contract and the independent V1/V2 capability probes.
 *
 * This module deliberately does not inspect credentials, call a provider, read
 * the TUI, calculate percentages, or derive token counts from text. A provider
 * is supported only when it supplies the complete numeric contract below.
 *
 * @module provider-capabilities
 */

/** The only capability statuses exposed by the usage contract. */
export const USAGE_STATUS = {
  SUPPORTED: 'SUPPORTED',
  UNSUPPORTED: 'UNSUPPORTED',
} as const

export type UsageStatus = (typeof USAGE_STATUS)[keyof typeof USAGE_STATUS]

/** Exact token counters supplied by the provider. No totals are inferred. */
export interface ExactProviderUsage {
  inputTokens: number
  outputTokens: number
}

/** Exact context limit supplied by the provider. */
export interface ExactProviderLimit {
  contextTokens: number
}

/**
 * Minimum complete provider payload accepted by either capability probe.
 * `resetAt`, when present, is an exact non-negative numeric provider value;
 * date strings and other reset representations are unsupported.
 */
export interface ExactProviderUsageData {
  sessionId: string
  providerId: string
  modelId: string
  usage: ExactProviderUsage
  limit: ExactProviderLimit
  resetAt?: number
}

/** Stream event metadata required for de-duplication and freshness ordering. */
export interface ProviderUsageEvent extends ExactProviderUsageData {
  eventId: string
  partId: string
  /** Optional provider sequence. When supplied, it must be an integer. */
  sequence?: number
  /** Optional provider observation time in milliseconds or another numeric scale. */
  observedAt?: number
}

/** A complete snapshot that has passed the exact contract validation. */
export interface ProviderUsageSnapshot extends ProviderUsageEvent {}

export type CapabilityProbeVersion = 'v1' | 'v2'

export type CapabilityProbeReason =
  | 'MISSING_SESSION_ID'
  | 'MISSING_PROVIDER_ID'
  | 'MISSING_MODEL_ID'
  | 'MISSING_USAGE'
  | 'MISSING_LIMIT'
  | 'INVALID_USAGE'
  | 'INVALID_LIMIT'
  | 'INVALID_RESET'

export type ProviderCapabilityResult =
  | {
      apiVersion: CapabilityProbeVersion
      status: typeof USAGE_STATUS.SUPPORTED
      data: ExactProviderUsageData
    }
  | {
      apiVersion: CapabilityProbeVersion
      status: typeof USAGE_STATUS.UNSUPPORTED
      reason: CapabilityProbeReason
    }

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function hasOnlyKeys(value: UnknownRecord, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function unsupported(
  apiVersion: CapabilityProbeVersion,
  reason: CapabilityProbeReason,
): ProviderCapabilityResult {
  return { apiVersion, status: USAGE_STATUS.UNSUPPORTED, reason }
}

/**
 * Validate the complete exact payload without coercion or estimation.
 *
 * This is intentionally shared only as a validator. V1 and V2 entry points
 * below remain separate capability probes and do not fall back to one another.
 */
function probeExactData(
  apiVersion: CapabilityProbeVersion,
  input: unknown,
): ProviderCapabilityResult {
  if (!isRecord(input)) return unsupported(apiVersion, 'MISSING_SESSION_ID')

  if (!isNonEmptyString(input.sessionId)) {
    return unsupported(apiVersion, 'MISSING_SESSION_ID')
  }
  if (!isNonEmptyString(input.providerId)) {
    return unsupported(apiVersion, 'MISSING_PROVIDER_ID')
  }
  if (!isNonEmptyString(input.modelId)) {
    return unsupported(apiVersion, 'MISSING_MODEL_ID')
  }
  if (!isRecord(input.usage)) return unsupported(apiVersion, 'MISSING_USAGE')
  if (!isRecord(input.limit)) return unsupported(apiVersion, 'MISSING_LIMIT')
  if (!hasOnlyKeys(input.usage, ['inputTokens', 'outputTokens'])) {
    return unsupported(apiVersion, 'INVALID_USAGE')
  }
  if (!hasOnlyKeys(input.limit, ['contextTokens'])) {
    return unsupported(apiVersion, 'INVALID_LIMIT')
  }

  const usage = input.usage
  if (!isFiniteNonNegativeNumber(usage.inputTokens)) {
    return unsupported(apiVersion, 'INVALID_USAGE')
  }
  if (!isFiniteNonNegativeNumber(usage.outputTokens)) {
    return unsupported(apiVersion, 'INVALID_USAGE')
  }

  const limit = input.limit
  if (!isFiniteNonNegativeNumber(limit.contextTokens)) {
    return unsupported(apiVersion, 'INVALID_LIMIT')
  }

  let resetAt: number | undefined
  if ('reset' in input) return unsupported(apiVersion, 'INVALID_RESET')
  if ('resetAt' in input) {
    const value = input.resetAt
    if (!isFiniteNonNegativeNumber(value)) return unsupported(apiVersion, 'INVALID_RESET')
    resetAt = value
  }

  const data: ExactProviderUsageData = {
    sessionId: input.sessionId,
    providerId: input.providerId,
    modelId: input.modelId,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    },
    limit: { contextTokens: limit.contextTokens },
  }
  if (resetAt !== undefined) data.resetAt = resetAt

  return { apiVersion, status: USAGE_STATUS.SUPPORTED, data }
}

/**
 * Probe the V1 exact payload shape supplied by a caller.
 *
 * V1 does not inherit V2 capability, credentials, cache, or lifecycle data.
 * The caller must pass the exact payload after its host-specific extraction.
 */
export function probeV1Capability(input: unknown): ProviderCapabilityResult {
  return probeExactData('v1', input)
}

/**
 * Probe the V2 exact payload shape supplied by a caller.
 *
 * V2 is intentionally independent from V1: no V1 event, retry, cache, or
 * fallback value is consulted when the exact payload is absent.
 */
export function probeV2Capability(input: unknown): ProviderCapabilityResult {
  return probeExactData('v2', input)
}

/** Validate one complete stream event using the same exact data contract. */
export function validateProviderUsageEvent(input: unknown): ProviderUsageEvent | null {
  if (!isRecord(input)) return null
  if (!isNonEmptyString(input.eventId) || !isNonEmptyString(input.partId)) return null

  const data = probeExactData('v1', input)
  if (data.status !== USAGE_STATUS.SUPPORTED) return null

  let sequence: number | undefined
  if ('sequence' in input) {
    const value = input.sequence
    if (!isFiniteNonNegativeNumber(value) || !Number.isInteger(value)) return null
    sequence = value
  }
  let observedAt: number | undefined
  if ('observedAt' in input) {
    const value = input.observedAt
    if (!isFiniteNonNegativeNumber(value)) return null
    observedAt = value
  }

  const event: ProviderUsageEvent = {
    ...data.data,
    eventId: input.eventId,
    partId: input.partId,
  }
  if (sequence !== undefined) event.sequence = sequence
  if (observedAt !== undefined) event.observedAt = observedAt
  return event
}
