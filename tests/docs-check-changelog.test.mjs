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
