import assert from 'node:assert/strict'
import test from 'node:test'

import {
  hostEvidenceWarning,
  KNOWN_BROKEN_HOSTS,
  SUPPORTED_FAMILIES,
  validateMatrix,
} from '../scripts/release-gates.mjs'

test('host support is family-level and a missing measurement is not a failure', () => {
  assert.deepEqual([...SUPPORTED_FAMILIES], ['2.x'])
  assert.deepEqual([...KNOWN_BROKEN_HOSTS], ['2.0.22'])

  // No evidence rows at all: the supported family is simply unmeasured.
  assert.doesNotThrow(() => validateMatrix([]))

  // An unlisted 2.x minor is valid evidence and needs no per-version blessing.
  assert.doesNotThrow(() => validateMatrix([{ host: '2.99.0', line: '2.x', kind: 'sandbox-v2' }]))
  // A 1.x row names a family this gate no longer declares: refused.
  assert.throws(
    () => validateMatrix([{ host: '1.19.9', line: '1.19.x', kind: 'v1-permission' }]),
    /undeclared family/,
  )
})

test('zero measured hosts is reported but does not fail the family-level gate', () => {
  assert.match(hostEvidenceWarning([]), /no measured hosts/)
  assert.match(hostEvidenceWarning([]), /unmeasured/)
  assert.equal(hostEvidenceWarning([{ host: '2.0.29' }]), null)
})
