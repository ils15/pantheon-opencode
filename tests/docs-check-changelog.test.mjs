import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('../scripts/docs-check-changelog.mjs', import.meta.url))
const fixtures = []

test.after(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true, force: true })
})

function checkChangelog(emojiHeadings) {
  const root = mkdtempSync(join(tmpdir(), 'docs-check-changelog-'))
  fixtures.push(root)
  const changelog = `# Changelog

## [Unreleased]

## [v1.1.0-beta.1] - 2026-11-01

${emojiHeadings.flatMap((heading) => [heading, '- generated note']).join('\n')}

## [v1.0.0] - 2026-10-01

### Deprecated
- No deprecated features.

### Removed
- No removed features.
`
  const path = join(root, 'CHANGELOG.md')
  writeFileSync(path, changelog)
  return spawnSync(process.execPath, [SCRIPT, path], { encoding: 'utf8' })
}

test('accepts the two official generated emoji changelog headings', () => {
  const result = checkChangelog(["## 🆕 What's New", '## 🐞 Fixed'])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /docs:check-changelog OK/)
})

test('rejects unsupported emoji changelog headings', () => {
  const result = checkChangelog([
    '## 🆕 Updates',
    '## ⚠️ Known Issues',
    '## 🧪 Experimental',
    '## 🇺🇸 Updates',
    '## 1️⃣ Updates',
  ])

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /emoji H2 is not allowed \(## 🆕 Updates\)/)
  assert.match(result.stderr, /emoji H2 is not allowed \(## ⚠️ Known Issues\)/)
  assert.match(result.stderr, /emoji H2 is not allowed \(## 🧪 Experimental\)/)
  assert.match(result.stderr, /emoji H2 is not allowed \(## 🇺🇸 Updates\)/)
  assert.match(result.stderr, /emoji H2 is not allowed \(## 1️⃣ Updates\)/)
})

test('preserves ordinary non-emoji legacy H2 semantics', () => {
  const result = checkChangelog(['## Updates'])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /docs:check-changelog OK/)
})

// ---------------------------------------------------------------------------
// Canonical format on the maintained sections ([Unreleased] + newest stable)
// ---------------------------------------------------------------------------

function checkChangelogText(text) {
  const root = mkdtempSync(join(tmpdir(), 'docs-check-changelog-'))
  fixtures.push(root)
  const path = join(root, 'CHANGELOG.md')
  writeFileSync(path, text)
  return spawnSync(process.execPath, [SCRIPT, path], { encoding: 'utf8' })
}

const CANONICAL_UNRELEASED = `# Changelog

## [Unreleased]

### Added
- **routing** — order mode on the local router.

## [v1.0.0] - 2026-10-01

### Fixed
- **tui** — the version embed ships at the release version.
`

test('a maintained [Unreleased] with canonical content passes', () => {
  const result = checkChangelogText(CANONICAL_UNRELEASED)
  assert.equal(result.status, 0, result.stderr)
})

test('a maintained [Unreleased] that violates the canonical format fails', () => {
  const result = checkChangelogText(
    CANONICAL_UNRELEASED.replace('- **routing** — order mode on the local router.', 'TODO list'),
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /\[Unreleased\]: placeholder marker/)
})

test('a template-comment [Unreleased] stays valid', () => {
  const result = checkChangelogText(
    CANONICAL_UNRELEASED.replace(
      '### Added\n- **routing** — order mode on the local router.',
      '<!-- Add new changes here. -->',
    ),
  )
  assert.equal(result.status, 0, result.stderr)
})

test('a bullet shape violation in the newest stable fails at PR time', () => {
  const result = checkChangelogText(
    CANONICAL_UNRELEASED.replace(
      '## [v1.0.0] - 2026-10-01\n\n### Fixed\n- **tui** — the version embed ships at the release version.',
      '## [v1.0.0] - 2026-10-01\n\n### Fixed\n- plain bullet with no bold lead',
    ),
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /\[v1\.0\.0\]: "Fixed" bullet must open with a bold scope/)
})
