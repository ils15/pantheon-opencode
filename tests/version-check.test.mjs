import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, syncToSource, MANIFESTS } from '../scripts/version-check.mjs'

const SCRIPT = fileURLToPath(new URL('../scripts/version-check.mjs', import.meta.url))

/** Run the CLI against a fixture root; returns {status, stdout, stderr}. */
function runCli(args, root) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, encoding: 'utf-8' })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const TOML_FIXTURE = `[build-system]
requires = ["setuptools>=64"]

[project]
name = "pantheon"
version = "1.1.0"
requires-python = ">=3.11"
`

const PLUGIN_FIXTURE = `{
  "name": "pantheon",
  "publisher": "ils15",
  "version": "1.1.0",
  "displayName": "Pantheon",
  "description": "Fixture plugin"
}
`

const TUI_PKG_FIXTURE = `{
  "name": "pantheon-tui",
  "type": "module",
  "version": "1.2.0",
  "license": "MIT"
}
`

const SOURCE_PKG = '1.2.1'

/** Build a fixture tree: package.json (source) + 3 manifests, returns the root. */
function makeFixture({ pyproject = '1.1.0', plugin = '1.1.0', tui = '1.2.0' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'version-check-'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'pantheon-opencode', version: SOURCE_PKG }, null, 2) + '\n')
  writeFileSync(join(root, 'pyproject.toml'), TOML_FIXTURE.replace('1.1.0', pyproject))
  writeFileSync(join(root, 'plugin.json'), PLUGIN_FIXTURE.replace('1.1.0', plugin))
  const tuiDir = join(root, 'src', 'plugins', 'tui')
  mkdirSyncRecursive(tuiDir)
  writeFileSync(join(tuiDir, 'package.json'), TUI_PKG_FIXTURE.replace('1.2.0', tui))
  return root
}

function mkdirSyncRecursive(dir) {
  mkdirSync(dir, { recursive: true })
}

test('compareVersions reads package.json as the source of truth', () => {
  const root = makeFixture()
  try {
    const result = compareVersions(root)
    assert.equal(result.source, SOURCE_PKG)
    assert.equal(result.manifests.length, 3)
    assert.deepEqual(
      result.manifests.map((m) => m.name),
      MANIFESTS.map((m) => m.name),
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('all manifests in sync → ok=true', () => {
  const root = makeFixture({ pyproject: '1.2.1', plugin: '1.2.1', tui: '1.2.1' })
  try {
    const result = compareVersions(root)
    assert.equal(result.ok, true)
    for (const m of result.manifests) assert.equal(m.ok, true, `${m.name} should be in sync`)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('divergent manifests → ok=false with per-manifest flags', () => {
  const root = makeFixture() // pyproject 1.1.0, plugin 1.1.0, tui 1.2.0 vs source 1.2.1
  try {
    const result = compareVersions(root)
    assert.equal(result.ok, false)
    const byName = Object.fromEntries(result.manifests.map((m) => [m.name, m]))
    assert.equal(byName['pyproject.toml'].version, '1.1.0')
    assert.equal(byName['plugin.json'].version, '1.1.0')
    assert.equal(byName['src/plugins/tui/package.json'].version, '1.2.0')
    for (const m of result.manifests) assert.equal(m.ok, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing manifest file → version null and ok=false', () => {
  const root = makeFixture()
  try {
    rmSync(join(root, 'plugin.json'))
    const result = compareVersions(root)
    assert.equal(result.ok, false)
    const plugin = result.manifests.find((m) => m.name === 'plugin.json')
    assert.equal(plugin.version, null)
    assert.equal(plugin.ok, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('syncToSource rewrites every divergent manifest to the source version', () => {
  const root = makeFixture()
  try {
    const changed = syncToSource(root)
    assert.equal(changed, 3, 'three manifests must be rewritten')
    const result = compareVersions(root)
    assert.equal(result.ok, true)
    for (const m of result.manifests) assert.equal(m.version, SOURCE_PKG)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('syncToSource is idempotent — second run changes nothing', () => {
  const root = makeFixture({ pyproject: '1.2.1', plugin: '1.2.1', tui: '1.2.1' })
  try {
    assert.equal(syncToSource(root), 0)
    assert.equal(syncToSource(root), 0)
    assert.equal(compareVersions(root).ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sync preserves sibling fields (JSON) — displayName must survive', () => {
  const root = makeFixture()
  try {
    syncToSource(root)
    const plugin = JSON.parse(readFileSync(join(root, 'plugin.json'), 'utf-8'))
    assert.equal(plugin.version, SOURCE_PKG)
    assert.equal(plugin.displayName, 'Pantheon')
    assert.equal(plugin.name, 'pantheon')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sync preserves sibling fields (TOML) — name and requires-python must survive', () => {
  const root = makeFixture()
  try {
    syncToSource(root)
    const toml = readFileSync(join(root, 'pyproject.toml'), 'utf-8')
    assert.match(toml, /version = "1\.2\.1"/)
    assert.match(toml, /name = "pantheon"/)
    assert.match(toml, /requires-python = ">=3\.11"/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI exits 0 and prints sync confirmation when all manifests match', () => {
  const root = makeFixture({ pyproject: '1.2.1', plugin: '1.2.1', tui: '1.2.1' })
  try {
    const { status, stdout } = runCli([], root)
    assert.equal(status, 0)
    assert.match(stdout, /All manifests match package\.json v1\.2\.1/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI exits 1 and prints a divergence table when manifests differ', () => {
  const root = makeFixture() // divergent by default
  try {
    const { status, stdout } = runCli([], root)
    assert.equal(status, 1)
    assert.match(stdout, /Source of truth: package\.json → v1\.2\.1/)
    assert.match(stdout, /pyproject\.toml/)
    assert.match(stdout, /DIVERGENT/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('CLI --fix syncs all manifests to the source version and exits 0', () => {
  const root = makeFixture()
  try {
    const { status, stdout } = runCli(['--fix'], root)
    assert.equal(status, 0)
    assert.match(stdout, /Synced 3 manifest\(s\) to v1\.2\.1/)
    assert.equal(compareVersions(root).ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
