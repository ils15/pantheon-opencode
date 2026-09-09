import { strict as assert } from 'node:assert'

import {
  type ExactProviderUsageData,
  probeV1Capability,
  probeV2Capability,
  USAGE_STATUS,
} from '../../src/pantheon/provider-capabilities.ts'

const results: { name: string; passed: boolean; error?: string }[] = []

function test(name: string, fn: () => void): void {
  try {
    fn()
    results.push({ name, passed: true })
  } catch (error: unknown) {
    results.push({
      name,
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function exactData(overrides: Partial<ExactProviderUsageData> = {}): ExactProviderUsageData {
  return {
    sessionId: 'session-1',
    providerId: 'provider-1',
    modelId: 'model-1',
    usage: { inputTokens: 100, outputTokens: 25 },
    limit: { contextTokens: 1000 },
    ...overrides,
  }
}

function assertUnsupported(input: unknown): void {
  assert.equal(probeV1Capability(input).status, USAGE_STATUS.UNSUPPORTED)
  assert.equal(probeV2Capability(input).status, USAGE_STATUS.UNSUPPORTED)
}

function assertInvalidReset(input: unknown): void {
  const v1 = probeV1Capability(input)
  const v2 = probeV2Capability(input)

  assert.equal(v1.status, USAGE_STATUS.UNSUPPORTED)
  assert.equal(v2.status, USAGE_STATUS.UNSUPPORTED)
  if (v1.status === USAGE_STATUS.UNSUPPORTED) assert.equal(v1.reason, 'INVALID_RESET')
  if (v2.status === USAGE_STATUS.UNSUPPORTED) assert.equal(v2.reason, 'INVALID_RESET')
}

test('V1 and V2 independently recognize the exact provider usage contract', () => {
  const input = exactData()

  const v1 = probeV1Capability(input)
  const v2 = probeV2Capability(input)

  assert.equal(v1.status, USAGE_STATUS.SUPPORTED)
  assert.equal(v2.status, USAGE_STATUS.SUPPORTED)
  if (v1.status === USAGE_STATUS.SUPPORTED && v2.status === USAGE_STATUS.SUPPORTED) {
    assert.deepEqual(v1.data, input)
    assert.deepEqual(v2.data, input)
    assert.equal('resetAt' in v1.data, false)
    assert.equal('resetAt' in v2.data, false)
  }
})

test('lifecycle or generic events without exact usage and limit are unsupported', () => {
  assertUnsupported({ type: 'session.idle', properties: { sessionId: 'session-1' } })
  assertUnsupported({ type: 'message.updated', sessionId: 'session-1' })
  assertUnsupported({ sessionId: 'session-1', providerId: 'provider-1', modelId: 'model-1' })
})

test('percent-only, stringified, partial, non-finite, and negative values are unsupported', () => {
  const cases: unknown[] = [
    { ...exactData(), usage: { percent: 42 }, limit: { contextTokens: 1000 } },
    { ...exactData(), usage: { inputTokens: '100', outputTokens: 25 } },
    { ...exactData(), limit: { contextTokens: '1000' } },
    { ...exactData(), usage: { inputTokens: 100 } },
    { ...exactData(), usage: { inputTokens: Number.NaN, outputTokens: 25 } },
    { ...exactData(), usage: { inputTokens: Infinity, outputTokens: 25 } },
    { ...exactData(), usage: { inputTokens: 100, outputTokens: -Infinity } },
    { ...exactData(), usage: { inputTokens: 100, outputTokens: 25, totalTokens: Number.NaN } },
    { ...exactData(), limit: { contextTokens: -1 } },
    { ...exactData(), limit: { contextTokens: Infinity } },
    { ...exactData(), limit: { contextTokens: -Infinity } },
    { ...exactData(), limit: { contextTokens: 1000, remainingTokens: 900 } },
  ]

  for (const input of cases) assertUnsupported(input)
})

test('missing identity and invalid reset metadata are unsupported', () => {
  for (const field of ['sessionId', 'providerId', 'modelId']) {
    const input = exactData()
    delete (input as unknown as Record<string, unknown>)[field]
    assertUnsupported(input)
  }

  const invalidResets: unknown[] = [
    { ...exactData(), resetAt: undefined },
    { ...exactData(), resetAt: Number.NaN },
    { ...exactData(), resetAt: Infinity },
    { ...exactData(), resetAt: -Infinity },
    { ...exactData(), resetAt: -1 },
    { ...exactData(), resetAt: 'tomorrow' },
    { ...exactData(), resetAt: null },
    { ...exactData(), resetAt: true },
    { ...exactData(), resetAt: { at: 123 } },
    { ...exactData(), resetAt: [123] },
    { ...exactData(), reset: undefined },
    { ...exactData(), reset: {} },
    { ...exactData(), reset: { at: 123 } },
    { ...exactData(), reset: 'tomorrow' },
  ]

  for (const input of invalidResets) assertInvalidReset(input)
})

test('probes do not substitute credentials, cache, fallback, or textual data', () => {
  const input = {
    sessionId: 'session-1',
    providerId: '',
    modelId: 'model-1',
    usageText: 'input=100 output=25',
    cachedUsage: { inputTokens: 100, outputTokens: 25 },
    fallback: exactData(),
  }

  assertUnsupported(input)
})

const failed = results.filter((result) => !result.passed)
for (const result of results) {
  console.log(
    `  ${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.error ? `: ${result.error}` : ''}`,
  )
}
console.log(`\nResults: ${results.length - failed.length} passed, ${failed.length} failed`)
process.exit(failed.length === 0 ? 0 : 1)
