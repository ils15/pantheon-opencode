import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractSection } from '../scripts/changelog-extract.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/changelog-extract.mjs', import.meta.url))

const CHANGELOG = `# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

No changes yet.

## [1.0.0] - 2026-07-24

### Major Changes
- **OpenCode-only**: Removed all multi-platform support (Claude Code, Cursor).

### Token Optimization
- Instructions tokens reduced 10.3k → 7.5k (-18%)

## [0.9.0] - 2026-06-01

### Added
- Legacy section content

## [v0.8.0]

### Added
- v-prefixed heading without a date
`

/** Fixture: write CHANGELOG.md to a temp dir, return its absolute path. */
function makeChangelogFile(text = CHANGELOG) {
  const root = mkdtempSync(join(tmpdir(), 'changelog-extract-'))
  writeFileSync(join(root, 'CHANGELOG.md'), text)
  return join(root, 'CHANGELOG.md')
}

function runCli(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf-8' })
}

test('extracts the body of an existing version section', () => {
  const { found, body } = extractSection(CHANGELOG, '1.0.0')
  assert.equal(found, true)
  assert.match(body, /### Major Changes/)
  assert.match(body, /- \*\*OpenCode-only\*\*/)
  assert.match(body, /### Token Optimization/)
  assert.doesNotMatch(body, /No changes yet\./)
  assert.doesNotMatch(body, /Legacy section content/)
})

test('non-existent version → found=false and body=null', () => {
  const { found, body } = extractSection(CHANGELOG, '9.9.9')
  assert.equal(found, false)
  assert.equal(body, null)
})

test('accepts a leading v in the version argument', () => {
  const plain = extractSection(CHANGELOG, '1.0.0')
  const withV = extractSection(CHANGELOG, 'v1.0.0')
  assert.equal(withV.found, true)
  assert.equal(withV.body, plain.body)
})

test('Unreleased heading is never matched as a version section', () => {
  assert.equal(extractSection(CHANGELOG, 'Unreleased').found, false)
  assert.equal(extractSection(CHANGELOG, 'unreleased').found, false)
  // a numeric version must never accidentally pick the Unreleased section
  const { body } = extractSection(CHANGELOG, '1.0.0')
  assert.doesNotMatch(body, /No changes yet\./)
})

test('section body stops at the next ## [ boundary', () => {
  const first = extractSection(CHANGELOG, '1.0.0')
  const second = extractSection(CHANGELOG, '0.9.0')
  assert.doesNotMatch(first.body, /Legacy section content/)
  assert.match(second.body, /Legacy section content/)
  assert.doesNotMatch(second.body, /v-prefixed heading without a date/)
})

test('body preserves ### subheadings', () => {
  const { body } = extractSection(CHANGELOG, '1.0.0')
  const subheadings = body.match(/^### .+$/gm) ?? []
  assert.deepEqual(subheadings, ['### Major Changes', '### Token Optimization'])
})

test('tolerates a v-prefixed heading without a date (## [v0.8.0])', () => {
  const { found, body } = extractSection(CHANGELOG, '0.8.0')
  assert.equal(found, true)
  assert.match(body, /v-prefixed heading without a date/)
})

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

test('CLI prints the section body for an existing version (exit 0)', () => {
  const changelog = makeChangelogFile()
  const { status, stdout, stderr } = runCli(['--changelog', changelog, '1.0.0'])
  assert.equal(status, 0, stderr)
  assert.match(stdout, /### Major Changes/)
  assert.doesNotMatch(stdout, /## \[1\.0\.0\]/)
})

test('CLI accepts --changelog=<path> syntax', () => {
  const changelog = makeChangelogFile()
  const { status, stdout } = runCli([`--changelog=${changelog}`, 'v0.9.0'])
  assert.equal(status, 0)
  assert.match(stdout, /Legacy section content/)
})

test('CLI fails with exit 1 when the version section is missing', () => {
  const changelog = makeChangelogFile()
  const { status, stdout, stderr } = runCli(['--changelog', changelog, '9.9.9'])
  assert.equal(status, 1)
  assert.equal(stdout, '')
  assert.match(stderr, /9\.9\.9/)
  assert.match(stderr, /Add the section in the version-bump PR/)
})

test('CLI fails with exit 1 when CHANGELOG.md is unreadable', () => {
  const { status, stderr } = runCli(['--changelog', '/nonexistent/CHANGELOG.md', '1.0.0'])
  assert.equal(status, 1)
  assert.match(stderr, /cannot read/)
})

test('CLI prints usage and exits 2 when no version is given', () => {
  const changelog = makeChangelogFile()
  const { status, stderr } = runCli(['--changelog', changelog])
  assert.equal(status, 2)
  assert.match(stderr, /Usage:/)
})
