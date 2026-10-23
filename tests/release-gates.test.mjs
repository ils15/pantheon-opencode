import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hostEvidenceWarning,
  KNOWN_BROKEN_HOSTS,
  SUPPORTED_FAMILIES,
  validateMatrix,
} from '../scripts/release-gates.mjs'

test('host support is family-level and a missing measurement is not a failure', () => {
  assert.deepEqual([...SUPPORTED_FAMILIES], ['1.19.x', '2.x'])
  assert.deepEqual([...KNOWN_BROKEN_HOSTS], ['2.0.22'])

  // No evidence rows at all: every supported family is simply unmeasured.
  assert.doesNotThrow(() => validateMatrix([]))

  // An unlisted 2.x minor is valid evidence and needs no per-version blessing.
  assert.doesNotThrow(() => validateMatrix([{ host: '2.99.0', line: '2.x', kind: 'sandbox-v2' }]))
  assert.doesNotThrow(() =>
    validateMatrix([{ host: '1.19.9', line: '1.19.x', kind: 'v1-permission' }]),
  )
})

test('only known-broken hosts and mismatched families are rejected', () => {
  assert.throws(
    () => validateMatrix([{ host: '2.0.22', line: '2.x', kind: 'sandbox-v2' }]),
    /known broken/,
  )
  assert.throws(
    () => validateMatrix([{ host: '3.0.0', line: '3.x', kind: 'sandbox-v2' }]),
    /undeclared family/,
  )
  assert.throws(
    () => validateMatrix([{ host: '1.18.0', line: '1.19.x', kind: 'v1-permission' }]),
    /belong to the 1\.19\.x family/,
  )
  assert.throws(
    () => validateMatrix([{ host: '1.19.4', line: '2.x', kind: 'sandbox-v2' }]),
    /belong to the 2\.x family/,
  )
  assert.throws(
    () => validateMatrix([{ host: '2.1.0', line: '2.x', kind: 'v1-permission' }]),
    /cannot run on the 2\.x family/,
  )
  assert.throws(
    () => validateMatrix([{ host: '1.19.4', line: '1.19.x', kind: 'sandbox-v2' }]),
    /cannot run on the 1\.19\.x family/,
  )
})

test('zero measured hosts is reported but does not fail the family-level gate', () => {
  assert.match(hostEvidenceWarning([]), /no measured hosts/)
  assert.match(hostEvidenceWarning([]), /unmeasured/)
  assert.equal(hostEvidenceWarning([{ host: '2.0.29' }]), null)
})
