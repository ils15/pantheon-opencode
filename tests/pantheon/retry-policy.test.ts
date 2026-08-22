/**
 * Tests for R1 — per-error-type retry + provider cooldown (LiteLLM pattern).
 *
 * retry-policy.ts provides:
 *   - classifyError(): maps a thrown error to auth | rate_limit | timeout | other
 *   - RetryPolicyEngine.decide(): applies the per-error-type retry policy with
 *     exponential backoff, and skips providers in cooldown
 *   - ProviderCooldownTracker: after `allowed_fails` consecutive failures a
 *     provider is skipped for `cooldown_time_seconds`; a success resets it
 *
 * Required behaviors (TDD):
 *   (a) auth errors → 0 retries (a credential problem will not fix itself)
 *   (b) rate_limit → N retries with exponential backoff
 *   (c) provider in cooldown → skipped (no retry, no dispatch)
 *   (d) cooldown expiry → provider usable again
 *
 * Run with: npx tsx tests/pantheon/retry-policy.test.ts
 */
import { strict as assert } from 'node:assert'

import {
  classifyError,
  computeBackoffMs,
  DEFAULT_COOLDOWN,
  DEFAULT_RETRY_POLICY,
  ProviderCooldownTracker,
  RetryPolicyEngine,
} from '../../src/pantheon/retry-policy.ts'

// ─── Harness ───────────────────────────────────────────────────────────

const results: { name: string; passed: boolean; error?: string }[] = []

async function testAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    results.push({ name, passed: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ name, passed: false, error: msg })
  }
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  // ── classifyError ────────────────────────────────────────────────────
  await testAsync('classifyError: auth signatures → "auth"', async () => {
    assert.equal(classifyError(new Error('401 unauthorized')), 'auth')
    assert.equal(classifyError(new Error('invalid api key')), 'auth')
    assert.equal(classifyError(new Error('Authentication failed: 403')), 'auth')
    assert.equal(classifyError(new Error('permission denied')), 'auth')
  })

  await testAsync('classifyError: rate-limit signatures → "rate_limit"', async () => {
    assert.equal(classifyError(new Error('429 too many requests')), 'rate_limit')
    assert.equal(classifyError(new Error('rate limit exceeded')), 'rate_limit')
    assert.equal(classifyError(new Error('quota exceeded')), 'rate_limit')
    assert.equal(classifyError(new Error('throttled')), 'rate_limit')
  })

  await testAsync('classifyError: timeout signatures → "timeout"', async () => {
    assert.equal(classifyError(new Error('request timed out')), 'timeout')
    assert.equal(classifyError(new Error('ETIMEDOUT')), 'timeout')
    assert.equal(classifyError(new Error('deadline exceeded')), 'timeout')
    assert.equal(classifyError(new Error('504 gateway timeout')), 'timeout')
  })

  await testAsync('classifyError: unknown errors → "other"', async () => {
    assert.equal(classifyError(new Error('something exploded')), 'other')
    assert.equal(classifyError('plain string failure'), 'other')
    assert.equal(classifyError(undefined), 'other')
  })

  // ── (a) auth errors → 0 retries ─────────────────────────────────────
  await testAsync('(a) auth error → 0 retries (policy auth: 0)', async () => {
    const engine = new RetryPolicyEngine(DEFAULT_RETRY_POLICY)
    const decision = engine.decide('opencode', new Error('401 unauthorized'), 0)
    assert.equal(decision.shouldRetry, false, 'auth must never retry')
    assert.equal(decision.reason, 'policy')
    assert.equal(decision.retriesRemaining, 0)
  })

  // ── (b) rate_limit → N retries with backoff ─────────────────────────
  await testAsync('(b) rate_limit → 3 retries with exponential backoff', async () => {
    const engine = new RetryPolicyEngine(DEFAULT_RETRY_POLICY, undefined, 1000)
    const err = new Error('429 rate limit')

    const first = engine.decide('opencode', err, 0)
    assert.equal(first.shouldRetry, true)
    assert.equal(first.retriesRemaining, 3)
    assert.equal(first.delayMs, 1000, 'first retry delay = base (1s)')

    const second = engine.decide('opencode', err, 1)
    assert.equal(second.shouldRetry, true)
    assert.equal(second.retriesRemaining, 2)
    assert.equal(second.delayMs, 2000, 'second retry delay = 2x base')

    const third = engine.decide('opencode', err, 2)
    assert.equal(third.shouldRetry, true)
    assert.equal(third.retriesRemaining, 1)
    assert.equal(third.delayMs, 4000, 'third retry delay = 4x base')

    const exhausted = engine.decide('opencode', err, 3)
    assert.equal(exhausted.shouldRetry, false, 'after 3 retries the budget is exhausted')
    assert.equal(exhausted.retriesRemaining, 0)
  })

  await testAsync('computeBackoffMs: caps at maxMs and never exceeds', async () => {
    assert.equal(computeBackoffMs(0, 1000, 30_000), 1000)
    assert.equal(computeBackoffMs(4, 1000, 30_000), 16_000)
    assert.equal(computeBackoffMs(10, 1000, 30_000), 30_000, 'capped at maxMs')
  })

  // ── (c) provider in cooldown → skipped ──────────────────────────────
  await testAsync('(c) provider in cooldown → skipped (no retry, no dispatch)', async () => {
    const cooldown = new ProviderCooldownTracker({ allowedFails: 2, cooldownTimeSeconds: 60 })
    const engine = new RetryPolicyEngine(DEFAULT_RETRY_POLICY, cooldown)

    // 2 consecutive failures trip the cooldown
    engine.recordFailure('opencode', new Error('429 rate limit'))
    assert.equal(cooldown.isInCooldown('opencode'), false, '1 fail < allowed_fails')
    engine.recordFailure('opencode', new Error('429 rate limit'))
    assert.equal(cooldown.isInCooldown('opencode'), true, '2 fails >= allowed_fails → cooldown')

    // Even a retryable error type is skipped while in cooldown
    const decision = engine.decide('opencode', new Error('429 rate limit'), 0)
    assert.equal(decision.shouldRetry, false, 'cooldown overrides the retry policy')
    assert.equal(decision.reason, 'cooldown')
  })

  // ── (d) cooldown expiry → provider usable again ─────────────────────
  await testAsync('(d) cooldown expiry → provider usable again', async () => {
    const cooldown = new ProviderCooldownTracker({ allowedFails: 1, cooldownTimeSeconds: 60 })
    const engine = new RetryPolicyEngine(DEFAULT_RETRY_POLICY, cooldown)

    engine.recordFailure('opencode', new Error('timeout'))
    assert.equal(cooldown.isInCooldown('opencode'), true, 'in cooldown right after the trip')

    // Simulate the cooldown window elapsing (injectable clock)
    const after = Date.now() + 61_000
    assert.equal(cooldown.isInCooldown('opencode', after), false, 'expired cooldown is not active')
    assert.equal(cooldown.remainingCooldownMs('opencode', after), 0)

    const decision = engine.decide('opencode', new Error('timeout'), 0, after)
    assert.equal(decision.shouldRetry, true, 'provider usable again after cooldown expiry')
    assert.equal(decision.reason, 'policy')
  })

  await testAsync('recordSuccess resets the failure counter (no spurious cooldown)', async () => {
    const cooldown = new ProviderCooldownTracker({ allowedFails: 3, cooldownTimeSeconds: 60 })
    cooldown.recordFailure('opencode')
    cooldown.recordFailure('opencode')
    cooldown.recordSuccess('opencode')
    assert.equal(cooldown.failCount('opencode'), 0, 'success resets the counter')
    assert.equal(cooldown.isInCooldown('opencode'), false)
  })

  await testAsync('DEFAULT_RETRY_POLICY: auth 0, rate_limit 3, timeout 2, other 1', async () => {
    assert.equal(DEFAULT_RETRY_POLICY.auth, 0)
    assert.equal(DEFAULT_RETRY_POLICY.rate_limit, 3)
    assert.equal(DEFAULT_RETRY_POLICY.timeout, 2)
    assert.equal(DEFAULT_RETRY_POLICY.other, 1)
    assert.equal(DEFAULT_COOLDOWN.allowedFails, 3)
    assert.equal(DEFAULT_COOLDOWN.cooldownTimeSeconds, 60)
  })

  // ═══════════════════════════════════════════════════════════════════════

  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed)

  console.log('')
  for (const r of results) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? `: ${r.error}` : ''}`)
  }
  console.log(`\nResults: ${passed} passed, ${failed.length} failed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main()
