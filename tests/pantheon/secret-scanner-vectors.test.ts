import assert from 'node:assert/strict'
import test from 'node:test'

import { scanSecretText } from '../../src/pantheon/secret-scanner.ts'

type GoldenVector = {
  name: string
  positive: string
  negative: string
  boundary: string
  shellExitCode: 1 | 2
  confidence: 'high' | 'low'
  pattern: string
  masked: string
}

// Golden outcomes transcribed from the historical shell policy at
// 5db0cbe^:scripts/hooks/scan-secrets.sh. Its decision codes were 0 clean,
// 1 advisory and 2 block. Construct positives in pieces so the fixture source
// itself never contains an unredacted credential-shaped literal.
const token = (...parts: string[]): string => parts.join('')
const vectors: GoldenVector[] = [
  {
    name: 'AWS access key',
    positive: token('AKIA', 'IOSFODNN7EXAMPLE'),
    negative: token('AKIA', 'IOSFODNN7EXAMPL!'),
    boundary: token('AKIA', 'IOSFODNN7EXAMPL'),
    shellExitCode: 2,
    confidence: 'high',
    pattern: 'aws-access-key',
    masked: 'AKIA****MPLE',
  },
  {
    name: 'GitHub token',
    positive: token('ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'),
    negative: token('ghx_', 'abcdefghijklmnopqrstuvwxyz0123456789'),
    boundary: token('ghp_', 'abcdefghijklmnopqrstuvwxyz012345678'),
    shellExitCode: 2,
    confidence: 'high',
    pattern: 'github-token',
    masked: 'ghp_****6789',
  },
  {
    name: 'GitLab token',
    positive: token('glpat-', 'abcdefghij0123456789'),
    negative: token('glpat!', 'abcdefghij0123456789'),
    boundary: token('glpat-', 'abcdefghi0123456789'),
    shellExitCode: 2,
    confidence: 'high',
    pattern: 'gitlab-token',
    masked: 'glpa****6789',
  },
  {
    name: 'generic API token',
    positive: token('sk-', 'abcdefghijklmnopqrst'),
    negative: token('sx-', 'abcdefghijklmnopqrst'),
    boundary: token('sk-', 'abcdefghijklmnopqrs'),
    shellExitCode: 2,
    confidence: 'high',
    pattern: 'api-token',
    masked: 'sk-a****qrst',
  },
  {
    name: 'live API token',
    positive: token('sk_live_', 'abcdefghijklmnopqrst'),
    negative: token('sk_live-', 'abcdefghijklmnopqrst'),
    boundary: token('sk_live_', 'abcdefghijklmnopqrs'),
    shellExitCode: 2,
    confidence: 'high',
    pattern: 'live-api-token',
    masked: 'sk_l****qrst',
  },
  {
    name: 'test API token',
    positive: token('sk_test_', 'abcdefghijklmnopqrst'),
    negative: token('sk_test-', 'abcdefghijklmnopqrst'),
    boundary: token('sk_test_', 'abcdefghijklmnopqrs'),
    shellExitCode: 2,
    confidence: 'high',
    pattern: 'test-api-token',
    masked: 'sk_t****qrst',
  },
  {
    name: 'messaging token',
    positive: token(
      'xox',
      'b-',
      '1234567890',
      '-',
      '1234567890123',
      '-',
      'abcdefghijklmnopqrstuvwx',
    ),
    negative: token(
      'xox',
      'z-',
      '1234567890',
      '-',
      '1234567890123',
      '-',
      'abcdefghijklmnopqrstuvwx',
    ),
    boundary: token('xox', 'b-', '123456789', '-', '1234567890', '-', 'abcdefghijklmnopqrstuvwx'),
    shellExitCode: 2,
    confidence: 'high',
    pattern: 'messaging-token',
    masked: 'xoxb****uvwx',
  },
  {
    name: 'bearer token',
    positive: token('Bearer ', 'abcdefghij0123456789'),
    negative: token('Bearer', 'abcdefghij0123456789'),
    boundary: token('Bearer ', 'abcdefghi0123456789'),
    shellExitCode: 2,
    confidence: 'high',
    pattern: 'bearer-token',
    masked: 'Bear****6789',
  },
  {
    name: 'JWT',
    positive: [
      token('eyJ', 'hbGciOiJIUzI1NiJ9'),
      token('eyJ', 'zdWIiOiIxIn0'),
      token('eyJ', 'zaWcifQ'),
    ].join('.'),
    negative: token('eyJ', 'hbGciOiJIUzI1NiJ9.', 'eyJ', 'zdWIiOiIxIn0'),
    boundary: token('eyJ', 'hbGciOiJIUzI1NiJ9.not-a-jwt'),
    shellExitCode: 2,
    confidence: 'high',
    pattern: 'jwt',
    masked: 'eyJh****cifQ',
  },
  {
    name: 'Bifrost token',
    positive: token('sk-bf-', 'abcdefgh'),
    negative: token('sk-bfx-', 'abcdefgh'),
    boundary: token('sk-bf-', 'abcdefg'),
    shellExitCode: 2,
    confidence: 'high',
    pattern: 'bifrost-token',
    masked: 'sk-b****efgh',
  },
  {
    name: 'API key assignment',
    positive: token('my_api_key_extra=', 'abcdefghij012345'),
    negative: token('my_api_key_extra=>', 'abcdefghij012345'),
    boundary: token('my_api_key_extra=', 'abcdefghi012345'),
    shellExitCode: 1,
    confidence: 'low',
    pattern: 'api-key-assignment',
    masked: 'my_a****2345',
  },
  {
    name: 'password assignment',
    positive: token("db_password='", 'abcdefgh', "'"),
    negative: token('db_password=', 'abcdefgh'),
    boundary: token("db_password='", 'abcdefg', "'"),
    shellExitCode: 1,
    confidence: 'low',
    pattern: 'password-assignment',
    masked: "db_p****fgh'",
  },
  {
    name: 'secret assignment',
    positive: token("configured_secret_value='", 'abcdefgh', "'"),
    negative: token('configured_secret_value=', 'abcdefgh'),
    boundary: token("configured_secret_value='", 'abcdefg', "'"),
    shellExitCode: 1,
    confidence: 'low',
    pattern: 'secret-assignment',
    masked: "conf****fgh'",
  },
  {
    name: 'Bifrost header',
    positive: token('x-bf-', 'vk'),
    negative: token('x-bf-', 'no'),
    boundary: token('x-bf-', 'v'),
    shellExitCode: 1,
    confidence: 'low',
    pattern: 'bifrost-header',
    masked: '****',
  },
]

assert.equal(vectors.length, 14, 'one golden vector must cover every historical pattern')

function historicalExitCode(status: 'clean' | 'invalid' | 'block' | 'advisory'): number {
  if (status === 'block') return 2
  if (status === 'advisory') return 1
  return 0
}

for (const vector of vectors) {
  test(`historical vector ${vector.name}: positive decision and redaction`, () => {
    const result = scanSecretText(vector.positive)
    assert.equal(historicalExitCode(result.status), vector.shellExitCode)
    assert.equal(result.status, vector.shellExitCode === 2 ? 'block' : 'advisory')
    if (result.status !== 'block' && result.status !== 'advisory') return
    assert.deepEqual(result.findings, [
      { confidence: vector.confidence, pattern: vector.pattern, masked: vector.masked },
    ])
    assert.equal(JSON.stringify(result).includes(vector.positive), false)
  })

  test(`historical vector ${vector.name}: negative stays clean`, () => {
    const result = scanSecretText(vector.negative)
    assert.deepEqual(result, { status: 'clean' })
    assert.equal(historicalExitCode(result.status), 0)
  })

  test(`historical vector ${vector.name}: boundary stays clean`, () => {
    const result = scanSecretText(vector.boundary)
    assert.deepEqual(result, { status: 'clean' })
    assert.equal(historicalExitCode(result.status), 0)
  })
}
