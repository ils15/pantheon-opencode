import assert from 'node:assert/strict'
import test from 'node:test'
import { extractSection } from '../scripts/changelog-extract.mjs'
import { mergeUnreleasedIntoVersion } from '../scripts/changelog-merge.mjs'

test('merges Unreleased notes into an existing version without duplicating its heading', () => {
  const source = `# Changelog

## [Unreleased]

<!-- Add new changes here. Running versioning.mjs will move this section to a versioned entry and reset the template below. -->

## 🆕 What's New

- New measured improvement.

## 🐞 Fixed

## ⚠️ Known Issues

- Current host identity limitation.

## [v1.6.0-beta.10] - 2026-10-12

&lt;!-- Add new changes here. Running node scripts/versioning.mjs apply will
     move this section to a versioned entry and reset the template below. --&gt;
<!-- Keep this editorial note. -->

## 🆕 What's New

- Existing beta feature.

## ⚠️ Known Issues

- Existing limitation.

## [v1.6.0-beta.9] - 2026-10-12

- Previous beta.
`

  const result = mergeUnreleasedIntoVersion(source, '1.6.0-beta.10')
  assert.ok(result?.changed)
  assert.equal((result.content.match(/^## \[v1\.6\.0-beta\.10\]/gm) ?? []).length, 1)
  assert.match(result.content, /^## \[Unreleased\]\n\n<!-- Add new changes here\./m)
  assert.match(result.content, /- Current host identity limitation\.\n\n## \[v1\.6\.0-beta\.9\]/)

  const release = extractSection(result.content, '1.6.0-beta.10')
  assert.ok(release.found)
  assert.match(release.body, /- Existing beta feature\.[\s\S]*- New measured improvement\./)
  assert.match(release.body, /- Existing limitation\.[\s\S]*- Current host identity limitation\./)
  assert.doesNotMatch(release.body, /Add new changes here/)
  assert.match(release.body, /<!-- Keep this editorial note\. -->/)

  const repeated = mergeUnreleasedIntoVersion(result.content, 'v1.6.0-beta.10')
  assert.deepEqual(repeated, { changed: false, content: result.content })
})

test('returns null when the requested version section has not been promoted', () => {
  assert.equal(
    mergeUnreleasedIntoVersion(
      '## [Unreleased]\n\n## [v1.6.0-beta.10] - 2026-10-12\n',
      '1.6.0-beta.11',
    ),
    null,
  )
})

test('rejects malformed versions and duplicate version sections', () => {
  assert.throws(
    () => mergeUnreleasedIntoVersion('## [Unreleased]\n', '../beta'),
    /invalid changelog version/,
  )
  const duplicate = [
    '## [Unreleased]',
    '## [v1.6.0-beta.10] - 2026-10-12',
    '## [1.6.0-beta.10] - 2026-10-13',
  ].join('\n')
  assert.throws(
    () => mergeUnreleasedIntoVersion(duplicate, '1.6.0-beta.10'),
    /duplicate version sections/,
  )
})
