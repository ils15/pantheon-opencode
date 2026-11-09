import assert from 'node:assert/strict'
import test from 'node:test'

import { CANONICAL_SECTIONS, splitSections, validateSection } from '../scripts/changelog-format.mjs'

// A representative canonical section: What's New highlights on top, KaC
// subsections in order, Known Issues last.
const VALID = `### 🆕 What's New
- **Typed decision router with a real budget**: delegation, skills, ORDER, rank, verify and review modes.
- **J1 risk gate with a ladder**: off / shadow / warn / enforce.

### Added
- **routing** — \`mode: "order"\` on \`pantheon_jev_decide\`: real top-K ordering of 2-4 candidates.
- **skills** — \`agent-forge\`: forge an OpenCode agent on demand.

### Changed
- **routing** — the J1 escalation ladder: off / shadow / warn / enforce via \`PANTHEON_J1_RISK_SCORE\`.
- 💥 **install** — dropped support for the OpenCode V1 contract.

### Deprecated
- **OpenCode V1 contract (1.19.x)** — supported through this release, deprecated afterward.

### Removed
- The lexical skills prefilter.

### Fixed
- **routing** — "Agent not found: zeus": installer heals the stale agent-source field.
- **tui** — the version embed ships at the release version.

### Security
- The input envelope is closed on every path.

### ⚠️ Known Issues
- The offline J2 scorecard harness reports honest negatives only.`

// ---------------------------------------------------------------------------
// validateSection — canonical bodies pass
// ---------------------------------------------------------------------------

test('a canonical section produces no violations', () => {
  assert.deepEqual(validateSection(VALID, { label: 'v1.7.0' }), [])
})

test('a section without What\u2019s New or Known Issues is valid', () => {
  const body = `### Added
- **routing** — real top-K ordering.

### Fixed
- **routing** — the stale agent-source field.`
  assert.deepEqual(validateSection(body, { label: 'v0.1.0' }), [])
})

test('the full What\u2019s New allowance (6 bullets) passes', () => {
  const bullets = Array.from({ length: 6 }, (_, i) => `- **Feature ${i + 1}**: does the thing.`)
  const body = `### 🆕 What's New\n${bullets.join('\n')}\n\n### Added\n- **routing** — order mode.`
  assert.deepEqual(validateSection(body, { label: 'v0.1.0' }), [])
})

// ---------------------------------------------------------------------------
// validateSection — structural violations
// ---------------------------------------------------------------------------

test('an empty body is a violation', () => {
  const violations = validateSection('   \n\n', { label: 'v0.1.0' })
  assert.equal(violations.length, 1)
  assert.match(violations[0], /v0\.1\.0: section is empty/)
})

test('an unknown H3 heading is a violation', () => {
  const body = `### Bugs
- Something.`
  const violations = validateSection(body, { label: 'v0.1.0' })
  assert.equal(violations.length, 1)
  assert.match(violations[0], /H3 "Bugs" is not in the canonical set/)
})

test('an H2 inside the section is a violation', () => {
  const body = `## 🐞 Fixed
- **routing** — the stale field.`
  const violations = validateSection(body, { label: 'v0.1.0' })
  assert.match(violations.join('\n'), /H2 inside the section/)
})

test('a duplicated H3 heading is a violation', () => {
  const body = `### Fixed
- **a** — first.

### Fixed
- **b** — second.`
  const violations = validateSection(body, { label: 'v0.1.0' })
  assert.match(violations.join('\n'), /duplicated/)
})

test('an out-of-order H3 heading is a violation', () => {
  const body = `### Fixed
- **routing** — the stale field.

### Added
- **routing** — order mode.`
  const violations = validateSection(body, { label: 'v0.1.0' })
  assert.match(violations.join('\n'), /out of canonical order/)
})

test('What\u2019s New must be the first section when present', () => {
  const body = `### Added
- **routing** — order mode.

### 🆕 What's New
- **Router**: budgeted.`
  const violations = validateSection(body, { label: 'v0.1.0' })
  assert.match(violations.join('\n'), /out of canonical order|must be the first/)
})

test('content before the first H3 heading is a violation', () => {
  const body = `Free-form intro bullets nobody framed.
- **Typed router**: budgeted.

### Added
- **routing** — order mode.`
  const violations = validateSection(body, { label: 'v0.1.0' })
  assert.match(violations.join('\n'), /content before the first ### heading/)
})

test('a leading HTML comment is accepted with allowLeadingComment', () => {
  const body = `<!-- Add new changes here. Running \`node scripts/versioning.mjs apply\` will
     move this section to a versioned entry. -->`
  const violations = validateSection(body, { label: 'Unreleased', allowLeadingComment: true })
  assert.deepEqual(violations, [])
})

test('an HTML comment without allowLeadingComment is a violation', () => {
  const body = `<!-- template comment -->`
  const violations = validateSection(body, { label: 'v0.1.0' })
  assert.match(violations.join('\n'), /content before the first ### heading/)
})

test('an empty subsection is a violation', () => {
  const body = `### Added

### Fixed
- **routing** — the stale field.`
  const violations = validateSection(body, { label: 'v0.1.0' })
  assert.match(violations.join('\n'), /"Added" subsection is empty/)
})

// ---------------------------------------------------------------------------
// validateSection — bullet rules
// ---------------------------------------------------------------------------

test('What\u2019s New with more than 6 bullets is a violation', () => {
  const bullets = Array.from({ length: 7 }, (_, i) => `- **Feature ${i + 1}**: does the thing.`)
  const body = `### 🆕 What's New\n${bullets.join('\n')}`
  const violations = validateSection(body, { label: 'v0.1.0' })
  assert.match(violations.join('\n'), /What's New has 7 bullets \(max 6\)/)
})

test('a What\u2019s New bullet over 140 chars is a violation', () => {
  const long = 'x'.repeat(150)
  const body = `### 🆕 What's New\n- **Too long**: ${long}`
  const violations = validateSection(body, { label: 'v0.1.0' })
  assert.match(violations.join('\n'), /What's New bullet is \d+ chars \(max 140\)/)
})

test('a What\u2019s New bullet must open with a bold summary', () => {
  const body = `### 🆕 What's New
- plain sentence without a bold lead`
  const violations = validateSection(body, { label: 'v0.1.0' })
  assert.match(violations.join('\n'), /bold summary/)
})

test('Added bullets must match the - **scope** — text shape', () => {
  const body = `### Added
- plain bullet with no scope`
  const violations = validateSection(body, { label: 'v0.1.0' })
  assert.match(violations.join('\n'), /- \*\*scope\*\* — text/)
})

test('an unscoped bold bullet (- **subject**) passes strict sections', () => {
  const body = `### Added
- **document RELEASING**`
  assert.deepEqual(validateSection(body, { label: 'v0.1.0' }), [])
})

test('a breaking bullet keeps the 💥 prefix and passes the shape', () => {
  const body = `### Added
- 💥 **install** — dropped the V1 contract.`
  assert.deepEqual(validateSection(body, { label: 'v0.1.0' }), [])
})

test('a multi-line bullet counts continuation lines in the length check', () => {
  const line = `- **routing** — ${'x'.repeat(100)}`
  const body = `### Added\n${line}\n  continued tail of the same bullet ${'y'.repeat(120)}`
  const violations = validateSection(body, { label: 'v0.1.0' })
  assert.match(violations.join('\n'), /bullet is \d+ chars \(max 200\)/)
})

test('placeholder markers are violations', () => {
  const body = `### Added
- **routing** — TODO describe the feature.`
  const violations = validateSection(body, { label: 'v0.1.0' })
  assert.match(violations.join('\n'), /placeholder/)
})

test('Deprecated, Removed, Security and Known Issues accept loose prose bullets', () => {
  const body = `### Deprecated
- The V1 contract.

### Removed
- The lexical prefilter.

### Security
- Input envelope closed.

### ⚠️ Known Issues
- Honest negatives only.`
  assert.deepEqual(validateSection(body, { label: 'v0.1.0' }), [])
})

test('Closed Issues bullets keep the - #N shape', () => {
  const body = `### ✅ Closed Issues
- #12 - real-time Delegations panel
- #13`
  assert.deepEqual(validateSection(body, { label: 'v0.1.0' }), [])
})

test('a Closed Issues bullet with another shape is a violation', () => {
  const body = `### ✅ Closed Issues
- fixed the thing`
  const violations = validateSection(body, { label: 'v0.1.0' })
  assert.match(violations.join('\n'), /- #N/)
})

// ---------------------------------------------------------------------------
// splitSections
// ---------------------------------------------------------------------------

test('splitSections parses version sections in file order', () => {
  const text = `# Changelog

## [Unreleased]

### Added
- **x** — thing.

## [v1.7.0] - 2026-11-07

### Fixed
- **tui** — stamp.

## [v1.6.2] - 2026-11-03

### Added
- **install** — sweep.`
  const sections = splitSections(text)
  assert.deepEqual(
    sections.map((s) => s.name),
    ['Unreleased', '1.7.0', '1.6.2'],
  )
  assert.match(sections[1].body, /- \*\*tui\*\* — stamp\./)
  // The body carries the subsections verbatim (the release body is 1:1).
  assert.match(sections[1].body, /### Fixed/)
})

test('CANONICAL_SECTIONS pins the approved order', () => {
  assert.deepEqual(
    [...CANONICAL_SECTIONS],
    [
      "🆕 What's New",
      'Added',
      'Changed',
      'Deprecated',
      'Removed',
      'Fixed',
      'Security',
      '⚠️ Known Issues',
      '✅ Closed Issues',
    ],
  )
})
