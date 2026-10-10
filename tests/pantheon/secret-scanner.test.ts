import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_SECRET_SCAN_INPUT_BYTES,
  SECRET_SCAN_PATTERN_COUNT,
  scanSecretPayload,
  scanSecretText,
} from '../../src/pantheon/secret-scanner.ts'

const samples = [
  {
    name: 'AWS access key',
    positive: `AKIA${'IOSFODNN7EXAMPLE'}`,
    boundary: `AKIA${'IOSFODNN7EXAMPL'}`,
    status: 'block',
  },
  {
    name: 'GitHub token',
    positive: `ghp${'_'}${'abcdefghijklmnopqrstuvwxyz0123456789'}`,
    boundary: `ghp${'_'}${'abcdefghijklmnopqrstuvwxyz012345678'}`,
    status: 'block',
  },
  {
    name: 'GitLab token',
    positive: `glpat${'-'}${'abcdefghij0123456789'}`,
    boundary: `glpat${'-'}${'abcdefghi0123456789'}`,
    status: 'block',
  },
  {
    name: 'generic API token',
    positive: `sk${'-'}${'abcdefghijklmnopqrst'}`,
    boundary: `sk${'-'}${'abcdefghijklmnopqrs'}`,
    status: 'block',
  },
  {
    name: 'live API token',
    positive: `sk_live_${'abcdefghijklmnopqrst'}`,
    boundary: `sk_live_${'abcdefghijklmnopqrs'}`,
    status: 'block',
  },
  {
    name: 'test API token',
    positive: `sk_test_${'abcdefghijklmnopqrst'}`,
    boundary: `sk_test_${'abcdefghijklmnopqrs'}`,
    status: 'block',
  },
  {
    name: 'messaging token',
    positive: `${'xox'}${'b-'}${'1234567890'}-${'1234567890123'}-${'abcdefghijklmnopqrstuvwx'}`,
    boundary: `${'xox'}${'b-'}${'123456789'}-${'1234567890'}-${'abcdefghijklmnopqrstuvwx'}`,
    status: 'block',
  },
  {
    name: 'bearer token',
    positive: `Bearer ${'abcdefghij0123456789'}`,
    boundary: `Bearer ${'abcdefghi0123456789'}`,
    status: 'block',
  },
  {
    name: 'JWT',
    positive: `eyJ${'hbGciOiJIUzI1NiJ9'}.${'eyJzdWIiOiIxIn0'}.${'eyJzaWcifQ'}`,
    boundary: `eyJ${'hbGciOiJIUzI1NiJ9'}.${'not-a-jwt'}`,
    status: 'block',
  },
  {
    name: 'Bifrost token',
    positive: `sk${'-'}bf${'-'}${'abcdefgh'}`,
    boundary: `sk${'-'}bf${'-'}${'abcdefg'}`,
    status: 'block',
  },
  {
    name: 'API key assignment',
    positive: `my_api_key_extra=${'abcdefghij012345'}`,
    boundary: `my_api_key_extra=${'abcdefghi012345'}`,
    status: 'advisory',
  },
  {
    name: 'password assignment',
    positive: `db_password='${'abcdefgh'}'`,
    boundary: `db_password='${'abcdefg'}'`,
    status: 'advisory',
  },
  {
    name: 'secret assignment',
    positive: `configured_secret_value='${'abcdefgh'}'`,
    boundary: `configured_secret_value='${'abcdefg'}'`,
    status: 'advisory',
  },
  {
    name: 'Bifrost header name',
    positive: `x${'-'}bf${'-'}vk`,
    boundary: `x${'-'}bf${'-'}v`,
    status: 'advisory',
  },
] as const

test('compiles the complete 14-pattern runtime policy', () => {
  assert.equal(SECRET_SCAN_PATTERN_COUNT, 14)
})

for (const sample of samples) {
  test(`${sample.name}: matches positive and preserves confidence`, () => {
    const result = scanSecretPayload({ tool_input: { content: sample.positive } })
    assert.equal(result.status, sample.status)
    if (result.status === 'block' || result.status === 'advisory') {
      assert.ok(result.findings.length > 0)
      assert.ok(result.findings.every((finding) => finding.masked.includes('****')))
      assert.ok(result.findings.every((finding) => !finding.masked.includes(sample.positive)))
    }
  })

  test(`${sample.name}: rejects the immediately-short boundary`, () => {
    assert.equal(scanSecretPayload({ tool_input: { content: sample.boundary } }).status, 'clean')
  })
}

test('findings use the shell masking rule and never return a raw match', () => {
  const token = `sk${'-'}${'abcdefghijklmnopqrst'}`
  const result = scanSecretText(token)
  assert.equal(result.status, 'block')
  if (result.status !== 'block') return
  assert.equal(result.findings[0]?.masked, `${token.slice(0, 4)}****${token.slice(-4)}`)

  const shortHeader = scanSecretText(`x${'-'}bf${'-'}vk`)
  assert.equal(shortHeader.status, 'advisory')
  if (shortHeader.status === 'advisory') assert.equal(shortHeader.findings[0]?.masked, '****')
})

test('safe text and JSON payloads with non-string fields are allowed', () => {
  assert.equal(scanSecretText('ordinary tool input').status, 'clean')
  assert.equal(scanSecretPayload({ tool_input: { count: 3, enabled: false } }).status, 'clean')
})

test('line-oriented shell semantics do not allow patterns to span newlines', () => {
  const bearer = `Bearer ${'abcdefghij0123456789'}`
  assert.equal(scanSecretText(`Bearer\n${'abcdefghij0123456789'}`).status, 'clean')
  assert.equal(scanSecretText(`password='four\nmoretext'`).status, 'clean')
  assert.equal(scanSecretText(bearer).status, 'block')
})

test('large repeated partial markers are scanned without regex backtracking', () => {
  assert.equal(scanSecretText('eyJ'.repeat(4_000)).status, 'clean')
  assert.equal(scanSecretText('password'.repeat(4_000)).status, 'clean')
})

test('malformed scanner inputs fail closed without echoing their content', () => {
  assert.equal(scanSecretText(null).status, 'invalid')
  assert.equal(scanSecretText({ args: 'not serialized' }).status, 'invalid')
  assert.equal(scanSecretPayload(undefined).status, 'invalid')
  assert.equal(scanSecretPayload({ tool_input: 'not-an-args-object' }).status, 'invalid')
  assert.equal(scanSecretPayload({ tool_input: null }).status, 'invalid')
  assert.equal(scanSecretPayload({ tool_input: [] }).status, 'invalid')
  assert.equal(scanSecretPayload({}).status, 'invalid')

  const cyclic: { self?: unknown } = {}
  cyclic.self = cyclic
  assert.equal(scanSecretPayload(cyclic).status, 'invalid')
})

for (const size of [1_024, 10_240, 102_400, 262_144, 1_048_576, 5_242_880]) {
  test(`scans ${size} bytes of safe input`, () => {
    assert.equal(scanSecretText('a'.repeat(size)).status, 'clean')
  })
}

test('rejects scanner text above the 5 MiB input boundary without returning content', () => {
  const result = scanSecretText('a'.repeat(5_242_881))
  assert.deepEqual(result, { status: 'invalid' })
  assert.doesNotMatch(JSON.stringify(result), /a{32}/)
})

test('uses UTF-8 byte size for the 5 MiB scanner boundary', () => {
  assert.equal(scanSecretText('é'.repeat(2_621_440)).status, 'clean')
  assert.deepEqual(scanSecretText('é'.repeat(2_621_441)), { status: 'invalid' })
})

test('serialized payloads above 5 MiB fail closed', () => {
  const result = scanSecretPayload({
    tool_input: { content: 'a'.repeat(MAX_SECRET_SCAN_INPUT_BYTES) },
  })
  assert.deepEqual(result, { status: 'invalid' })
})

test('rejects oversized payloads before calling JSON.stringify', () => {
  const payloads = [
    { tool_input: {}, extra: 'a'.repeat(MAX_SECRET_SCAN_INPUT_BYTES + 1) },
    {
      tool_input: {
        batches: Array.from({ length: 5_200 }, () => 'a'.repeat(1_024)),
      },
    },
  ]

  for (const payload of payloads) {
    const stringify = JSON.stringify
    let stringifyCalls = 0
    JSON.stringify = ((value: unknown) => {
      stringifyCalls++
      return stringify(value)
    }) as typeof JSON.stringify
    try {
      assert.deepEqual(scanSecretPayload(payload), { status: 'invalid' })
      assert.equal(stringifyCalls, 0, 'oversized data must be rejected before serialization')
    } finally {
      JSON.stringify = stringify
    }
  }
})

test('accepts an exactly-at-limit serialized payload and rejects one byte over', () => {
  const emptyPayload = { tool_input: { content: '' } }
  const fixedBytes = Buffer.byteLength(JSON.stringify(emptyPayload), 'utf8')
  const contentBytes = MAX_SECRET_SCAN_INPUT_BYTES - fixedBytes
  const exact = { tool_input: { content: 'a'.repeat(contentBytes) } }
  assert.equal(Buffer.byteLength(JSON.stringify(exact), 'utf8'), MAX_SECRET_SCAN_INPUT_BYTES)
  assert.equal(scanSecretPayload(exact).status, 'clean')

  const over = { tool_input: { content: `${'a'.repeat(contentBytes)}a` } }
  assert.deepEqual(scanSecretPayload(over), { status: 'invalid' })
})

test('counts escaped UTF-8 object keys and compact array values at the exact limit', () => {
  const emptyKeyPayload = { tool_input: { '': [3, false, ''] } }
  const fixedBytes = Buffer.byteLength(JSON.stringify(emptyKeyPayload), 'utf8') - 2
  const availableBytes = MAX_SECRET_SCAN_INPUT_BYTES - fixedBytes - 2
  const keyPattern = 'é\n"'
  const patternBytes = Buffer.byteLength(JSON.stringify(keyPattern), 'utf8') - 2
  const key = `${keyPattern.repeat(Math.floor(availableBytes / patternBytes))}${'a'.repeat(availableBytes % patternBytes)}`
  const exact = { tool_input: { [key]: [3, false, ''] } }
  assert.equal(Buffer.byteLength(JSON.stringify(exact), 'utf8'), MAX_SECRET_SCAN_INPUT_BYTES)
  assert.equal(scanSecretPayload(exact).status, 'clean')
})

test('counts escaped and multibyte JSON strings without invoking accessors', () => {
  const payload = { tool_input: { content: `${'é'.repeat(20)}\n\u0000"\\` } }
  assert.equal(scanSecretPayload(payload).status, 'clean')

  const fixedBytes = Buffer.byteLength(JSON.stringify({ tool_input: { content: '' } }), 'utf8')
  const availableBytes = MAX_SECRET_SCAN_INPUT_BYTES - fixedBytes
  const escapedPattern = 'é\n"\\'
  const patternBytes = Buffer.byteLength(JSON.stringify(escapedPattern), 'utf8') - 2
  const content = `${escapedPattern.repeat(Math.floor(availableBytes / patternBytes))}${'a'.repeat(availableBytes % patternBytes)}`
  const exactEscapedPayload = { tool_input: { content } }
  assert.equal(
    Buffer.byteLength(JSON.stringify(exactEscapedPayload), 'utf8'),
    MAX_SECRET_SCAN_INPUT_BYTES,
  )
  assert.equal(scanSecretPayload(exactEscapedPayload).status, 'clean')

  let getterCalls = 0
  const withGetter = { tool_input: {} } as { tool_input: object; get extra(): string }
  Object.defineProperty(withGetter, 'extra', {
    enumerable: true,
    get() {
      getterCalls++
      return 'should not be read'
    },
  })
  assert.deepEqual(scanSecretPayload(withGetter), { status: 'invalid' })
  assert.equal(getterCalls, 0)
})

test('fails closed for proxies, BigInt, serialization hooks, and excessive depth', () => {
  let proxyTraps = 0
  const proxied = new Proxy(
    { tool_input: {} },
    {
      getPrototypeOf() {
        proxyTraps++
        return Object.prototype
      },
    },
  )
  assert.deepEqual(scanSecretPayload(proxied), { status: 'invalid' })
  assert.equal(proxyTraps, 0)

  const nestedProxy = new Proxy(
    {},
    {
      getPrototypeOf() {
        proxyTraps++
        return Object.prototype
      },
    },
  )
  assert.deepEqual(scanSecretPayload({ tool_input: { nested: nestedProxy } }), {
    status: 'invalid',
  })
  assert.equal(proxyTraps, 0)
  assert.deepEqual(scanSecretPayload({ tool_input: { count: 1n } }), { status: 'invalid' })

  let toJSONCalls = 0
  const withToJSON = { tool_input: {} } as { tool_input: object; toJSON(): object }
  Object.defineProperty(withToJSON, 'toJSON', {
    value() {
      toJSONCalls++
      return {}
    },
  })
  assert.deepEqual(scanSecretPayload(withToJSON), { status: 'invalid' })
  assert.equal(toJSONCalls, 0)

  let deeplyNested: unknown = 'safe'
  for (let index = 0; index < 600; index++) deeplyNested = { child: deeplyNested }
  assert.deepEqual(scanSecretPayload({ tool_input: { nested: deeplyNested } }), {
    status: 'invalid',
  })

  const stringify = JSON.stringify
  JSON.stringify = (() => {
    throw new Error('serialization details must not escape')
  }) as typeof JSON.stringify
  try {
    assert.deepEqual(scanSecretPayload({ tool_input: {} }), { status: 'invalid' })
  } finally {
    JSON.stringify = stringify
  }
})
