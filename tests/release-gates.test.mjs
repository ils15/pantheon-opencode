import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  changelogGate,
  hostEvidenceWarning,
  KNOWN_BROKEN_HOSTS,
  SUPPORTED_FAMILIES,
  validateMatrix,
} from '../scripts/release-gates.mjs'

const CANONICAL_FIXTURE = `# Changelog

## [v9.9.9] - 2026-01-01

### 🆕 What's New
- **Order mode**: real top-K ordering of candidates.

### Added
- **routing** — \`mode: "order"\` on \`pantheon_jev_decide\`.

### Fixed
- **tui** — the version embed ships at the release version.

### Security
- The input envelope is closed on every path.
`

// A prose intro before the first ### heading: exactly the shape the v1.7.0
// release had when it was hand-edited.
const VIOLATING_FIXTURE = `# Changelog

## [v9.9.8] - 2026-01-01

Free-form intro bullets nobody framed.

### Added
- **routing** — order mode.
`

function withTempEvidenceDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'release-gates-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function fixtureChangelog(dir, text) {
  const path = join(dir, 'CHANGELOG.md')
  writeFileSync(path, text)
  return path
}

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

test('changelog gate passes a canonical section and records zero format violations', () => {
  withTempEvidenceDir((dir) => {
    const changelogPath = fixtureChangelog(dir, CANONICAL_FIXTURE)
    const result = changelogGate({
      version: '9.9.9',
      evidenceDir: dir,
      changelogPath,
      recovery: false,
    })
    const check = result.checks.find((c) => c.name === 'changelog-section')
    assert.equal(check.status, 'PASS')
    assert.equal(result.details.mode, 'committed-section')
    assert.equal(result.details.formatViolations, 0)
    // The evidence keeps the exact release body (gate e writes changelog.md).
    const evidence = readFileSync(join(dir, 'changelog.md'), 'utf8')
    assert.match(evidence, /### 🆕 What's New/)
  })
})

test('changelog gate fails a section that violates the canonical format', () => {
  withTempEvidenceDir((dir) => {
    const changelogPath = fixtureChangelog(dir, VIOLATING_FIXTURE)
    assert.throws(
      () =>
        changelogGate({
          version: '9.9.8',
          evidenceDir: dir,
          changelogPath,
          recovery: false,
        }),
      /canonical format/,
    )
  })
})

test('changelog gate still fails when the version section is missing', () => {
  withTempEvidenceDir((dir) => {
    const changelogPath = fixtureChangelog(dir, CANONICAL_FIXTURE)
    assert.throws(
      () =>
        changelogGate({
          version: '1.2.3',
          evidenceDir: dir,
          changelogPath,
          recovery: false,
        }),
      /exited 1/,
    )
  })
})
