import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  applyBetaVersion,
  nextBetaVersion,
  nextStableVersion,
} from '../scripts/release-beta-version.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

// ---------------------------------------------------------------------------
// nextBetaVersion
// ---------------------------------------------------------------------------

test('nextBetaVersion advances an existing committed beta line', () => {
  assert.equal(nextBetaVersion('1.5.0-beta.2'), '1.5.0-beta.3')
  assert.equal(nextBetaVersion('2.0.0-beta.9'), '2.0.0-beta.10')
  // Input is trimmed before parsing.
  assert.equal(nextBetaVersion('  1.5.0-beta.2\n'), '1.5.0-beta.3')
})

test('nextBetaVersion starts a fresh beta line from a stable version', () => {
  assert.equal(nextBetaVersion('1.4.3'), '1.4.4-beta.1')
})

test('nextBetaVersion derives the next patch beta from another prerelease', () => {
  assert.equal(nextBetaVersion('1.5.0-rc.1'), '1.5.1-beta.1')
  assert.equal(nextBetaVersion('1.5.0-alpha.3'), '1.5.1-beta.1')
})

test('nextBetaVersion rejects inputs that cannot be derived', () => {
  for (const value of ['', 'not-a-version', '1.5', 'v1.5.0', '1.5.0-']) {
    assert.throws(() => nextBetaVersion(value), /cannot derive a beta version/, value)
  }
})

// ---------------------------------------------------------------------------
// nextStableVersion
// ---------------------------------------------------------------------------

test('nextStableVersion computes explicit release intents', () => {
  assert.equal(nextStableVersion('1.3.4', 'minor'), '1.4.0')
  assert.equal(nextStableVersion('1.3.4', 'major'), '2.0.0')
  assert.equal(nextStableVersion('1.3.4', 'patch'), '1.3.5')
  assert.equal(nextStableVersion('1.3.4'), '1.3.5')
})

test('nextStableVersion fails closed on invalid input', () => {
  assert.throws(() => nextStableVersion('1.2.1-beta.1', 'patch'), /stable semver/)
  assert.throws(() => nextStableVersion('nope', 'patch'), /stable semver/)
  assert.throws(() => nextStableVersion('1.2.1', 'bogus'), /patch, minor, or major/)
})

// ---------------------------------------------------------------------------
// applyBetaVersion + CLI fixture
// ---------------------------------------------------------------------------

/**
 * Write the six versioned manifests/locks into a temp root.
 *
 * @param {string} root fixture directory
 * @param {string} version initial version for every entry
 */
function writeFixture(root, version) {
  const manifest = (name, value) => `${JSON.stringify({ name, version: value }, null, 2)}\n`
  const lock = (name, value) =>
    `${JSON.stringify(
      {
        name,
        version: value,
        lockfileVersion: 3,
        packages: { '': { name, version: value } },
      },
      null,
      2,
    )}\n`

  writeFileSync(join(root, 'package.json'), manifest('pantheon-opencode', version))
  writeFileSync(join(root, 'plugin.json'), manifest('pantheon', version))
  writeFileSync(
    join(root, 'pyproject.toml'),
    `[project]\nname = "pantheon"\nversion = "${version}"\n`,
  )
  mkdirSync(join(root, 'src/plugins/tui'), { recursive: true })
  writeFileSync(join(root, 'src/plugins/tui/package.json'), manifest('pantheon-tui', version))
  writeFileSync(join(root, 'package-lock.json'), lock('pantheon-opencode', version))
  writeFileSync(join(root, 'src/plugins/tui/package-lock.json'), lock('pantheon-tui', version))
}

/** Write a CHANGELOG.md with a populated [Unreleased] section to promote. */
function writeChangelog(root) {
  writeFileSync(
    join(root, 'CHANGELOG.md'),
    [
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '### Added',
      '',
      '- An unreleased change.',
      '',
      '## [v1.5.0-beta.2] - 2026-01-01',
      '',
      '- A previous beta change.',
      '',
    ].join('\n'),
  )
}

/** Build a fixture that also contains a copy of scripts/ so the CLI can run. */
function makeRepoFixture(version) {
  const root = mkdtempSync(join(tmpdir(), 'beta-fixture-'))
  cpSync(join(REPO_ROOT, 'scripts'), join(root, 'scripts'), { recursive: true })
  writeFixture(root, version)
  writeChangelog(root)
  return root
}

test('applyBetaVersion writes the committed beta version into every manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'beta-apply-'))
  try {
    writeFixture(root, '1.5.0-beta.2')
    applyBetaVersion(root, '1.5.0-beta.3')
    assert.equal(
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
      '1.5.0-beta.3',
    )
    assert.equal(
      JSON.parse(readFileSync(join(root, 'src/plugins/tui/package.json'), 'utf8')).version,
      '1.5.0-beta.3',
    )
    assert.match(readFileSync(join(root, 'pyproject.toml'), 'utf8'), /version = "1\.5\.0-beta\.3"/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('applyBetaVersion accepts the legacy beta scheme for recovery writes', () => {
  const root = mkdtempSync(join(tmpdir(), 'beta-legacy-'))
  try {
    writeFixture(root, '1.4.3-beta.3.aaaaaaa')
    applyBetaVersion(root, '1.4.3-beta.4.bbbbbbb')
    assert.equal(
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
      '1.4.3-beta.4.bbbbbbb',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('applyBetaVersion fails closed before touching invalid fixtures', () => {
  const root = mkdtempSync(join(tmpdir(), 'beta-invalid-'))
  try {
    assert.throws(() => applyBetaVersion(root, 'not-semver'), /invalid release semver/)
    assert.throws(() => applyBetaVersion(root, '1.4.3'), /release version must be/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI: versioning.mjs apply --beta bumps manifests and promotes CHANGELOG', () => {
  const root = makeRepoFixture('1.5.0-beta.2')
  try {
    const result = spawnSync(process.execPath, ['scripts/versioning.mjs', 'apply', '--beta'], {
      cwd: root,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version,
      '1.5.0-beta.3',
    )
    assert.equal(
      JSON.parse(readFileSync(join(root, 'src/plugins/tui/package.json'), 'utf8')).version,
      '1.5.0-beta.3',
    )
    assert.equal(
      JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).version,
      '1.5.0-beta.3',
    )
    assert.match(readFileSync(join(root, 'pyproject.toml'), 'utf8'), /version = "1\.5\.0-beta\.3"/)

    const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
    assert.match(changelog, /^## \[v1\.5\.0-beta\.3\] - \d{4}-\d{2}-\d{2}$/m)
    assert.match(changelog, /^## \[Unreleased\]$/m)
    assert.match(changelog, /## 🆕 What's New/)
    assert.match(changelog, /- An unreleased change\./)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
