import test from 'node:test'
import assert from 'node:assert/strict'
import { checkCodeModeManifest, validateCodeModeManifest } from '../scripts/doctor.mjs'

test('doctor manifest validator exports the required checks', () => {
  assert.equal(typeof checkCodeModeManifest, 'function')
  assert.equal(typeof validateCodeModeManifest, 'function')
})

test('doctor rejects malformed manifest data', () => {
  assert.equal(validateCodeModeManifest('/tmp/code-mode-does-not-exist').ok, false)
})
