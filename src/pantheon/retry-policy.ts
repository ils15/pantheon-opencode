/**
 * R1 — Per-error-type retry + provider cooldown (LiteLLM pattern).
 *
 * Pure library (no SDK, no I/O). When a delegation fails, the error is
 * classified (auth | rate_limit | timeout | other), the per-error-type
 * retry policy from routing.yml `retry_policy` is applied with exponential
 * backoff, and provider cooldown state (routing.yml `cooldown`) is tracked
 * in-memory: after `allowed_fails` consecutive failures a provider is
 * skipped for `cooldown_time_seconds`; a success resets the counter.
 *
 * YAGNI: no usage-based routing, no Redis — a simple in-memory cooldown
 * map plus config.
 *
 * @module retry-policy
 */

// ─── Types ─────────────────────────────────────────────────────────────

/** Error classes a delegation failure can be classified into. */
export type ErrorType = 'auth' | 'rate_limit' | 'timeout' | 'other'

/** Max retries per error class (routing.yml `retry_policy`). */
export interface RetryPolicy {
  auth: number
  rate_limit: number
  timeout: number
  other: number
}

/** Provider cooldown config (routing.yml `cooldown`). */
export interface CooldownConfig {
  /** Consecutive failures before the provider is skipped. */
  allowedFails: number
  /** How long the provider stays skipped, in seconds. */
  cooldownTimeSeconds: number
}

/** Defaults matching routing.yml `retry_policy`. */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  auth: 0,
  rate_limit: 3,
  timeout: 2,
  other: 1,
}

/** Defaults matching routing.yml `cooldown`. */
export const DEFAULT_COOLDOWN: CooldownConfig = {
  allowedFails: 3,
  cooldownTimeSeconds: 60,
}

// ─── Error classification ──────────────────────────────────────────────

const AUTH_RE = /(auth|unauthorized|401|403|api[ _-]?key|invalid credential|permission denied)/i
const RATE_LIMIT_RE = /(rate[ _-]?limit|429|too many requests|quota|throttl)/i
const TIMEOUT_RE = /(timeout|timed out|deadline|504|408|etimedout)/i

/**
 * Classify a thrown error into one of the four retry-policy buckets.
 * Message-based matching (LiteLLM pattern); unknown errors → 'other'.
 */
export function classifyError(err: unknown): ErrorType {
  const message = err instanceof Error ? err.message : String(err ?? '')
  if (AUTH_RE.test(message)) return 'auth'
  if (RATE_LIMIT_RE.test(message)) return 'rate_limit'
  if (TIMEOUT_RE.test(message)) return 'timeout'
  return 'other'
}

// ─── Exponential backoff ───────────────────────────────────────────────

/**
 * Exponential backoff delay for a retry attempt (0-based): base * 2^attempt,
 * capped at maxMs. attempt 0 → base, attempt 1 → 2x base, etc.
 */
export function computeBackoffMs(attempt: number, baseMs = 1000, maxMs = 30_000): number {
  const delay = baseMs * 2 ** attempt
  return Math.min(delay, maxMs)
}

// ─── Provider cooldown tracker ─────────────────────────────────────────

interface CooldownEntry {
  fails: number
  cooldownUntil: number
}

/**
 * In-memory provider cooldown state. After `allowedFails` consecutive
 * failures a provider is skipped until `cooldownUntil`; a success resets
 * the counter. The clock is injectable for tests.
 */
export class ProviderCooldownTracker {
  private readonly state = new Map<string, CooldownEntry>()
  readonly config: CooldownConfig

  constructor(config: CooldownConfig = DEFAULT_COOLDOWN) {
    this.config = config
  }

  /** Record one failure for a provider; trips cooldown at allowedFails. */
  recordFailure(provider: string): void {
    const entry = this.state.get(provider) ?? { fails: 0, cooldownUntil: 0 }
    entry.fails += 1
    if (entry.fails >= this.config.allowedFails) {
      entry.cooldownUntil = Date.now() + this.config.cooldownTimeSeconds * 1000
    }
    this.state.set(provider, entry)
  }

  /** Record a success — resets the failure counter (no spurious cooldown). */
  recordSuccess(provider: string): void {
    this.state.delete(provider)
  }

  /**
   * Whether the provider is currently skipped. Expired cooldowns are
   * cleared; entries that never tripped (cooldownUntil 0) are kept so the
   * consecutive-failure counter survives the check.
   */
  isInCooldown(provider: string, now = Date.now()): boolean {
    const entry = this.state.get(provider)
    if (entry === undefined) return false
    if (entry.cooldownUntil > now) return true
    if (entry.cooldownUntil > 0) this.state.delete(provider)
    return false
  }

  /** Remaining cooldown time in ms (0 when not in cooldown). */
  remainingCooldownMs(provider: string, now = Date.now()): number {
    const entry = this.state.get(provider)
    if (entry === undefined) return 0
    return Math.max(0, entry.cooldownUntil - now)
  }

  /** Current consecutive failure count for a provider. */
  failCount(provider: string): number {
    return this.state.get(provider)?.fails ?? 0
  }
}

// ─── Retry policy engine ───────────────────────────────────────────────

export type RetryDecisionReason = 'policy' | 'cooldown'

export interface RetryDecision {
  shouldRetry: boolean
  /** Retries still available for this error class (0 when exhausted). */
  retriesRemaining: number
  /** Backoff delay to wait before the next attempt (ms). */
  delayMs: number
  /** Why the decision was made: policy budget or provider cooldown. */
  reason: RetryDecisionReason
}

/**
 * Combines error classification, the per-error-type retry policy, and the
 * provider cooldown tracker into one decision point. Enforcement: when a
 * delegation fails, call `decide(provider, err, attemptsUsed)`; when the
 * result is content, call `recordSuccess`; when the budget is exhausted,
 * call `recordFailure` so the cooldown can trip.
 */
export class RetryPolicyEngine {
  private readonly cooldown: ProviderCooldownTracker
  readonly policy: RetryPolicy
  readonly backoffBaseMs: number

  constructor(
    policy: RetryPolicy = DEFAULT_RETRY_POLICY,
    cooldown?: ProviderCooldownTracker,
    backoffBaseMs = 1000,
  ) {
    this.policy = policy
    this.backoffBaseMs = backoffBaseMs
    this.cooldown = cooldown ?? new ProviderCooldownTracker()
  }

  /**
   * Decide whether a failed dispatch should be retried.
   *
   * @param provider provider name (cooldown key, e.g. "opencode")
   * @param err the failure (classified into auth/rate_limit/timeout/other)
   * @param attemptsUsed retries already consumed for this dispatch
   * @param now injectable clock (tests)
   */
  decide(provider: string, err: unknown, attemptsUsed: number, now = Date.now()): RetryDecision {
    if (this.cooldown.isInCooldown(provider, now)) {
      return { shouldRetry: false, retriesRemaining: 0, delayMs: 0, reason: 'cooldown' }
    }
    const type = classifyError(err)
    const retriesRemaining = Math.max(0, this.policy[type] - attemptsUsed)
    if (retriesRemaining <= 0) {
      return { shouldRetry: false, retriesRemaining: 0, delayMs: 0, reason: 'policy' }
    }
    return {
      shouldRetry: true,
      retriesRemaining,
      delayMs: computeBackoffMs(attemptsUsed, this.backoffBaseMs),
      reason: 'policy',
    }
  }

  /** Record a failure (feeds the cooldown tracker). */
  recordFailure(provider: string, _err: unknown): void {
    this.cooldown.recordFailure(provider)
  }

  /** Record a success (resets the provider's failure counter). */
  recordSuccess(provider: string): void {
    this.cooldown.recordSuccess(provider)
  }
}
