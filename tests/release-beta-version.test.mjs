import assert from 'node:assert/strict'
import { test } from 'node:test'
import { betaVersion, nextStableVersion } from '../scripts/release-beta-version.mjs'

const SHA_A = `abcdef1${'2'.repeat(33)}`
const SHA_B = `1234567${'8'.repeat(33)}`

test('beta is based on published stable 1.2.1, not the branch version', () => {
  assert.equal(betaVersion('1.2.1', 'patch', 42, SHA_A), '1.2.2-beta.42.abcdef1')
})

test('published stable 1.3.4 produces the next patch beta', () => {
  assert.equal(betaVersion('1.3.4', 'patch', 7, SHA_B), '1.3.5-beta.7.1234567')
})

test('explicit minor and major release intents are semver bumps', () => {
  assert.equal(nextStableVersion('1.3.4', 'minor'), '1.4.0')
  assert.equal(nextStableVersion('1.3.4', 'major'), '2.0.0')
  assert.equal(betaVersion('1.3.4', 'minor', 8, SHA_A), '1.4.0-beta.8.abcdef1')
  assert.equal(betaVersion('1.3.4', 'major', 9, SHA_A), '2.0.0-beta.9.abcdef1')
})

test('a prerelease baseline keeps its release line for the next beta', () => {
  assert.equal(betaVersion('1.5.0-beta.2', 'patch', 3, SHA_A), '1.5.0-beta.3.abcdef1')
  assert.equal(betaVersion('1.5.0-BETA.2', 'patch', 3, SHA_A.toUpperCase()), '1.5.0-beta.3.abcdef1')
})

test('invalid published versions and release metadata fail closed', () => {
  assert.throws(() => nextStableVersion('1.2.1-beta.1', 'patch'), /stable semver/)
  assert.throws(() => betaVersion('1.2.1', 'patch', 0, SHA_A), /PR number/)
  assert.throws(() => betaVersion('1.2.1', 'patch', 1, 'abcdef1'), /full commit SHA/)
  assert.throws(() => betaVersion('1.2.1', 'patch', 1, 'not-a-sha'), /full commit SHA/)
})
