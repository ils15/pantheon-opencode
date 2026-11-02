import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hostEvidenceWarning,
  KNOWN_BROKEN_HOSTS,
  SUPPORTED_FAMILIES,
  validateMatrix,
} from '../scripts/release-gates.mjs'

test('host support is family-level and a missing measurement is not a failure', () => {
  // 2.0 removed the V1 plugin line, so the 1.19.x family (which the v1
  // permission-proof canary was the only evidence for) is no longer a
  // supported family — only the 2.x V2 sandbox leg remains.
  assert.deepEqual([...SUPPORTED_FAMILIES], ['2.x'])
  assert.deepEqual([...KNOWN_BROKEN_HOSTS], ['2.0.22'])

  // No evidence rows at all: every supported family is simply unmeasured.
  assert.doesNotThrow(() => validateMatrix([]))

  // An unlisted 2.x minor is valid evidence and needs no per-version blessing.
  assert.doesNotThrow(() => validateMatrix([{ host: '2.99.0', line: '2.x', kind: 'sandbox-v2' }]))
})

test('only known-broken hosts, unknown kinds and mismatched families are rejected', () => {
  assert.throws(
    () => validateMatrix([{ host: '2.0.22', line: '2.x', kind: 'sandbox-v2' }]),
    /known broken/,
  )
  assert.throws(
    () => validateMatrix([{ host: '3.0.0', line: '3.x', kind: 'sandbox-v2' }]),
    /undeclared family/,
  )
  assert.throws(
    () => validateMatrix([{ host: '1.19.4', line: '2.x', kind: 'sandbox-v2' }]),
    /belong to the 2\.x family/,
  )
  // The v1-permission kind (and with it the 1.19.x family) was removed with
  // the V1 plugin line in 2.0: any row still claiming it is stale evidence.
  assert.throws(
    () => validateMatrix([{ host: '2.1.0', line: '2.x', kind: 'v1-permission' }]),
    /unknown kind/,
  )
  assert.throws(
    () => validateMatrix([{ host: '1.19.4', line: '1.19.x', kind: 'v1-permission' }]),
    /undeclared family/,
  )
  assert.throws(
    () => validateMatrix([{ host: '2.1.0', line: '3.x', kind: 'v1-permission' }]),
    /undeclared family/,
  )
  assert.throws(
    () => validateMatrix([{ host: '1.19.4', line: '1.19.x', kind: 'sandbox-v2' }]),
    /undeclared family/,
  )
})

test('zero measured hosts is reported but does not fail the family-level gate', () => {
  assert.match(hostEvidenceWarning([]), /no measured hosts/)
  assert.match(hostEvidenceWarning([]), /unmeasured/)
  assert.equal(hostEvidenceWarning([{ host: '2.0.29' }]), null)
})
