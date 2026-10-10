import assert from 'node:assert/strict'
import test from 'node:test'

import {
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
    positive: `xoxb-${'1234567890'}-${'1234567890123'}-${'abcdefghijklmnopqrstuvwx'}`,
    boundary: `xoxb-${'123456789'}-${'1234567890'}-${'abcdefghijklmnopqrstuvwx'}`,
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
  const result = scanSecretPayload({ tool_input: { content: 'a'.repeat(5_242_880) } })
  assert.deepEqual(result, { status: 'invalid' })
})
