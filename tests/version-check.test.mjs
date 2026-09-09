import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { commitPreparedUpdates } from '../scripts/manifest-inventory.mjs'
import { compareVersions, MANIFESTS, syncToSource } from '../scripts/version-check.mjs'

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

/** Build a fixture tree: four manifests plus both lockfiles. */
function makeFixture({
  pyproject = '1.1.0',
  plugin = '1.1.0',
  tui = '1.2.0',
  rootLock = SOURCE_PKG,
  tuiLock = tui,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'version-check-'))
  writeFileSync(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'pantheon-opencode', version: SOURCE_PKG }, null, 2)}\n`,
  )
  writeFileSync(join(root, 'pyproject.toml'), TOML_FIXTURE.replace('1.1.0', pyproject))
  writeFileSync(join(root, 'plugin.json'), PLUGIN_FIXTURE.replace('1.1.0', plugin))
  const tuiDir = join(root, 'src', 'plugins', 'tui')
  mkdirSyncRecursive(tuiDir)
  writeFileSync(join(tuiDir, 'package.json'), TUI_PKG_FIXTURE.replace('1.2.0', tui))
  writeFileSync(
    join(root, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: 'pantheon-opencode',
        version: rootLock,
        lockfileVersion: 3,
        packages: {
          '': { name: 'pantheon-opencode', version: rootLock, dependencies: { fixture: '^1.0.0' } },
        },
        dependencies: { fixture: { version: '1.0.0', integrity: 'sha512-fixture-root' } },
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    join(tuiDir, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: 'pantheon-tui',
        version: tuiLock,
        lockfileVersion: 3,
        packages: {
          '': { name: 'pantheon-tui', version: tuiLock, dependencies: { fixture: '^1.0.0' } },
        },
        dependencies: { fixture: { version: '1.0.0', integrity: 'sha512-fixture-tui' } },
      },
      null,
      2,
    )}\n`,
  )
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
    assert.equal(changed, 4, 'three manifests and the TUI lock must be rewritten')
    const result = compareVersions(root)
    assert.equal(result.ok, true)
    for (const m of result.manifests) assert.equal(m.version, SOURCE_PKG)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing lockfile is a hard preflight failure before --fix writes', () => {
  const root = makeFixture()
  const before = readFileSync(join(root, 'package.json'), 'utf8')
  try {
    rmSync(join(root, 'package-lock.json'))
    assert.throws(() => syncToSource(root), /missing: package-lock\.json/i)
    assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), before)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an internally divergent lock fails closed without partial writes', () => {
  const root = makeFixture()
  try {
    const lockPath = join(root, 'package-lock.json')
    const paths = [
      'package.json',
      'pyproject.toml',
      'plugin.json',
      'src/plugins/tui/package.json',
      'package-lock.json',
      'src/plugins/tui/package-lock.json',
    ].map((file) => join(root, file))
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    lock.packages[''].version = '9.9.9'
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
    const before = new Map(paths.map((path) => [path, readFileSync(path, 'utf8')]))
    assert.equal(compareVersions(root).ok, false)
    assert.throws(() => syncToSource(root), /top-level version diverges/i)
    for (const [path, content] of before) assert.equal(readFileSync(path, 'utf8'), content, path)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a lock divergent from its manifest is repairable when internally consistent', () => {
  const root = makeFixture()
  try {
    const lockPath = join(root, 'package-lock.json')
    const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
    lock.version = '9.9.9'
    lock.packages[''].version = '9.9.9'
    writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
    assert.equal(compareVersions(root).ok, false)
    assert.equal(syncToSource(root), 5)
    const fixed = JSON.parse(readFileSync(lockPath, 'utf8'))
    assert.equal(fixed.version, SOURCE_PKG)
    assert.equal(fixed.packages[''].version, SOURCE_PKG)
    assert.equal(fixed.dependencies.fixture.integrity, 'sha512-fixture-root')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('prepared batch failure leaves every original file unchanged', () => {
  const root = makeFixture()
  try {
    const packagePath = join(root, 'package.json')
    const before = readFileSync(packagePath, 'utf8')
    assert.throws(
      () =>
        commitPreparedUpdates([
          { path: packagePath, content: `${before} ` },
          { path: join(root, 'missing.json'), content: '{}' },
        ]),
      /ENOENT|no such file/i,
    )
    assert.equal(readFileSync(packagePath, 'utf8'), before)
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
    assert.match(stdout, /Synced 4 metadata entries to v1\.2\.1/)
    assert.equal(compareVersions(root).ok, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
