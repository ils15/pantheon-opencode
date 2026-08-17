import assert from 'node:assert/strict'
import { test } from 'node:test'
import { betaVersion, nextStableVersion } from '../scripts/release-beta-version.mjs'

test('beta is based on published stable 1.2.1, not the branch version', () => {
  assert.equal(betaVersion('1.2.1', 'patch', 42, 'abcdef123456'), '1.2.2-beta.42.abcdef1')
})

test('published stable 1.3.4 produces the next patch beta', () => {
  assert.equal(betaVersion('1.3.4', 'patch', 7, '123456789'), '1.3.5-beta.7.1234567')
})

test('explicit minor and major release intents are semver bumps', () => {
  assert.equal(nextStableVersion('1.3.4', 'minor'), '1.4.0')
  assert.equal(nextStableVersion('1.3.4', 'major'), '2.0.0')
  assert.equal(betaVersion('1.3.4', 'minor', 8, 'abcdef123'), '1.4.0-beta.8.abcdef1')
  assert.equal(betaVersion('1.3.4', 'major', 9, 'abcdef123'), '2.0.0-beta.9.abcdef1')
})

test('invalid published versions and release metadata fail closed', () => {
  assert.throws(() => nextStableVersion('1.2.1-beta.1', 'patch'), /stable semver/)
  assert.throws(() => betaVersion('1.2.1', 'patch', 0, 'abcdef1'), /PR number/)
  assert.throws(() => betaVersion('1.2.1', 'patch', 1, 'not-a-sha'), /commit SHA/)
})
