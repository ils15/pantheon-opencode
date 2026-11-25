/**
 * Regression tests for the 2.3.1 migration guards (incident: `opencode plugin
 * add pantheon-opencode` resolved the V1-era 1.5.2 package, which has no
 * `./tui` export and no V2 agents).
 *
 *   1. Legacy cleanup: a copied `plugins/pantheon-tui` directory is removed, and
 *      `~/.npm/_npx/<hash>` entries are removed ONLY when their installed
 *      pantheon-opencode version is below 2.3.0 — the containing hash directory
 *      goes with it (re-resolution requires it), while at/above-minimum entries
 *      and unrelated packages are untouched. Dry-run reports without deleting,
 *      removals are backed up under `.pantheon/backups/`, and a second run is a
 *      no-op.
 *   2. Load-time guard: a sub-minimum or V1-shaped package yields the actionable
 *      message, a supported package yields silence, and the shipped entry
 *      (`src/plugin/index.js`) actually calls the guard.
 */

import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  assertSupportedPantheonInstall,
  inspectPantheonInstall,
  MIN_SUPPORTED_PANTHEON_VERSION,
} from '../src/pantheon/install-guard.mjs'
import { migrateLegacyStoresAndPurgeStale } from '../src/pantheon/legacy-store-migration.mjs'

const REPO_ROOT = process.cwd()

function writeJson(filePath, value) {
  mkdirSync(join(filePath, '..'), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function seedNpxInstall(home, hash, { name = 'pantheon-opencode', version } = {}) {
  const pkgDir = join(home, '.npm', '_npx', hash, 'node_modules', name)
  writeJson(join(pkgDir, 'package.json'), { name, version })
  writeFileSync(join(pkgDir, 'index.js'), 'export default {}\n')
  return join(home, '.npm', '_npx', hash)
}

function seedLegacyConfig(configDir) {
  mkdirSync(join(configDir, 'plugins', 'pantheon-tui', 'dist'), { recursive: true })
  writeFileSync(join(configDir, 'plugins', 'pantheon-tui', 'dist', 'tui.js'), 'export default {}\n')
  writeJson(join(configDir, 'opencode.json'), { plugins: ['pantheon-opencode'] })
}

test('migration removes the copied legacy TUI and only below-minimum npx installs', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-npx-cleanup-'))
  try {
    const home = join(root, 'home')
    const configDir = join(home, '.config', 'opencode')
    seedLegacyConfig(configDir)

    const legacyHashDir = seedNpxInstall(home, 'aaaa1111', { version: '1.5.2' })
    const supportedHashDir = seedNpxInstall(home, 'bbbb2222', {
      version: MIN_SUPPORTED_PANTHEON_VERSION,
    })
    const unrelatedHashDir = seedNpxInstall(home, 'cccc3333', {
      name: 'unrelated-package',
      version: '0.0.1',
    })

    // Dry run: reports the targets and deletes nothing.
    const dry = migrateLegacyStoresAndPurgeStale(configDir, {
      dryRun: true,
      isGlobalConfig: true,
      cleanCopiedInstallArtifacts: true,
      homeDir: home,
    })
    assert.ok(dry.staleFilesDeleted.includes(legacyHashDir), 'dry run missed the npx V1 install')
    assert.ok(
      dry.staleFilesDeleted.includes(join(configDir, 'plugins', 'pantheon-tui')),
      'dry run missed the copied TUI',
    )
    assert.equal(existsSync(legacyHashDir), true)
    assert.equal(existsSync(join(configDir, 'plugins', 'pantheon-tui')), true)

    // Real run.
    migrateLegacyStoresAndPurgeStale(configDir, {
      isGlobalConfig: true,
      cleanCopiedInstallArtifacts: true,
      homeDir: home,
    })
    assert.equal(existsSync(join(configDir, 'plugins', 'pantheon-tui')), false)
    assert.equal(
      existsSync(legacyHashDir),
      false,
      'the below-minimum npx hash directory must be removed for re-resolution',
    )
    assert.equal(
      existsSync(supportedHashDir),
      true,
      'an npx entry at the supported version must be preserved',
    )
    assert.equal(existsSync(unrelatedHashDir), true, 'unrelated npx packages must be preserved')

    const backupsDir = join(configDir, '.pantheon', 'backups')
    assert.equal(
      existsSync(backupsDir),
      true,
      'removal must leave a backup under .pantheon/backups',
    )

    // Second run is a no-op.
    const second = migrateLegacyStoresAndPurgeStale(configDir, {
      isGlobalConfig: true,
      cleanCopiedInstallArtifacts: true,
      homeDir: home,
    })
    const secondTouches = second.staleFilesDeleted.filter((entry) =>
      entry.includes(`${join('.npm', '_npx')}`),
    )
    assert.deepEqual(secondTouches, [], 'a second run must not re-report npx cleanup')
    assert.equal(existsSync(supportedHashDir), true)
    assert.equal(existsSync(unrelatedHashDir), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('migration leaves the npx cache alone when legacy-artifact cleanup is off', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-npx-scope-'))
  try {
    const home = join(root, 'home')
    const configDir = join(home, '.config', 'opencode')
    mkdirSync(configDir, { recursive: true })
    const legacyHashDir = seedNpxInstall(home, 'dddd4444', { version: '1.5.2' })

    migrateLegacyStoresAndPurgeStale(configDir, { isGlobalConfig: true, homeDir: home })
    assert.equal(existsSync(legacyHashDir), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function seedPackage(rootDir, { version, tui = true, roster = true } = {}) {
  const manifest = {
    name: 'pantheon-opencode',
    version,
    exports: { '.': './src/plugin/index.js' },
  }
  if (tui) manifest.exports['./tui'] = './src/plugins/tui/dist/tui.js'
  writeJson(join(rootDir, 'package.json'), manifest)
  if (tui) {
    mkdirSync(join(rootDir, 'src', 'plugins', 'tui', 'dist'), { recursive: true })
    writeFileSync(join(rootDir, 'src', 'plugins', 'tui', 'dist', 'tui.js'), 'export default {}\n')
  }
  if (roster) {
    writeJson(join(rootDir, 'src', 'agents', 'roster.json'), { agents: { zeus: {} } })
  }
  return rootDir
}

test('an installed version below the 2.3.0 floor fails with the actionable message', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-guard-v1-'))
  try {
    seedPackage(root, { version: '1.5.2', tui: false, roster: false })
    const detection = inspectPantheonInstall({ packageRoot: root })
    assert.equal(detection.ok, false)

    assert.throws(
      () => assertSupportedPantheonInstall({ packageRoot: root }),
      (error) => {
        assert.match(error.message, /Pantheon 2\.3\.x required but pantheon-opencode@1\.5\.2/)
        assert.match(
          error.message,
          /pin "pantheon-opencode@2\.3\.0" \(explicit version, not @latest\)/,
        )
        assert.match(error.message, /~\/\.cache\/opencode\/npm\/pantheon-opencode@\*/)
        assert.match(error.message, /restart OpenCode/)
        return true
      },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the guard reports the host version when one is supplied', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-guard-host-'))
  try {
    seedPackage(root, { version: '1.5.2', tui: false, roster: false })
    assert.throws(
      () => assertSupportedPantheonInstall({ packageRoot: root, hostVersion: '2.0.30' }),
      /Loaded host: opencode 2\.0\.30/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a 2.3.0-shaped package is silent', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-guard-ok-'))
  try {
    seedPackage(root, { version: MIN_SUPPORTED_PANTHEON_VERSION })
    const detection = inspectPantheonInstall({ packageRoot: root })
    assert.equal(detection.ok, true)
    assert.equal(detection.version, MIN_SUPPORTED_PANTHEON_VERSION)
    assert.doesNotThrow(() => assertSupportedPantheonInstall({ packageRoot: root }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a supported version with the V1 shape still fails loud', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-guard-shape-'))
  try {
    seedPackage(root, { version: '2.3.0', tui: false, roster: false })
    assert.throws(
      () => assertSupportedPantheonInstall({ packageRoot: root }),
      /Pantheon 2\.3\.x required but pantheon-opencode@2\.3\.0 is loaded/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('an unreadable package root never fails the load', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-guard-empty-'))
  try {
    assert.equal(inspectPantheonInstall({ packageRoot: root }).ok, true)
    assert.doesNotThrow(() => assertSupportedPantheonInstall({ packageRoot: root }))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the shipped plugin entry wires the install guard', () => {
  const bundle = readFileSync(join(REPO_ROOT, 'src', 'plugin', 'index.js'), 'utf8')
  assert.match(bundle, /assertSupportedPantheonInstall/)
  assert.match(bundle, /Pantheon 2\.3\.x required/)
})

test('migration unpins stale version refs, cleans global copied AGENTS.md while preserving user rules, and sweeps stale opencode npm caches', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-unpin-agents-'))
  try {
    const home = join(root, 'home')
    const configDir = join(home, '.config', 'opencode')
    const cacheNpmDir = join(home, '.cache', 'opencode', 'npm')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(
      join(cacheNpmDir, 'pantheon-opencode@1.5.2', '100', 'node_modules', 'pantheon-opencode'),
      {
        recursive: true,
      },
    )
    mkdirSync(
      join(cacheNpmDir, 'pantheon-opencode@next', '100', 'node_modules', 'pantheon-opencode'),
      {
        recursive: true,
      },
    )
    mkdirSync(
      join(cacheNpmDir, 'pantheon-opencode@2.3.0', '200', 'node_modules', 'pantheon-opencode'),
      {
        recursive: true,
      },
    )

    writeJson(
      join(
        cacheNpmDir,
        'pantheon-opencode@1.5.2',
        '100',
        'node_modules',
        'pantheon-opencode',
        'package.json',
      ),
      { name: 'pantheon-opencode', version: '1.5.2' },
    )
    writeJson(
      join(
        cacheNpmDir,
        'pantheon-opencode@next',
        '100',
        'node_modules',
        'pantheon-opencode',
        'package.json',
      ),
      { name: 'pantheon-opencode', version: '1.5.0-beta.9' },
    )
    writeJson(
      join(
        cacheNpmDir,
        'pantheon-opencode@2.3.0',
        '200',
        'node_modules',
        'pantheon-opencode',
        'package.json',
      ),
      { name: 'pantheon-opencode', version: '2.3.0' },
    )

    writeJson(join(configDir, 'opencode.json'), {
      plugins: ['pantheon-opencode@1.5.2', 'npx pantheon-tui', 'other-plugin'],
    })
    writeFileSync(
      join(configDir, 'opencode.jsonc'),
      `{\n  // Keep user comment\n  "plugins": [\n    "pantheon-opencode@1.5.0-beta.9",\n    "pantheon-opencode",\n    "other-plugin"\n  ]\n}\n`,
    )
    writeJson(join(configDir, 'tui.json'), {
      plugins: ['plugins/pantheon-tui/dist/tui.js', 'npx -y pantheon-tui@1.5.2'],
    })

    writeFileSync(
      join(configDir, 'AGENTS.md'),
      `# My Global Custom Rules\nAlways speak Portuguese.\n\n<!-- pantheon:generated:begin — old -->\n| @talos | Old |\n<!-- pantheon:generated:end -->\n`,
    )
    writeFileSync(
      join(configDir, 'AGENTS.global.md'),
      `<!-- pantheon:generated:begin -->\n# Pantheon Agent System — OpenCode\n| @gaia | Old |\n<!-- pantheon:generated:end -->\n`,
    )

    migrateLegacyStoresAndPurgeStale(configDir, {
      isGlobalConfig: true,
      cleanCopiedInstallArtifacts: true,
      homeDir: home,
    })

    const cfgJson = JSON.parse(readFileSync(join(configDir, 'opencode.json'), 'utf8'))
    assert.deepEqual(cfgJson.plugins, ['pantheon-opencode', 'other-plugin'])

    const cfgJsonc = readFileSync(join(configDir, 'opencode.jsonc'), 'utf8')
    assert.match(cfgJsonc, /\/\/ Keep user comment/)
    assert.doesNotMatch(cfgJsonc, /1\.5\.0-beta\.9/)
    assert.match(cfgJsonc, /"pantheon-opencode"/)

    assert.equal(existsSync(join(configDir, 'tui.json')), false)
    assert.equal(existsSync(join(configDir, 'AGENTS.global.md')), false)
    assert.equal(
      readFileSync(join(configDir, 'AGENTS.md'), 'utf8'),
      '# My Global Custom Rules\nAlways speak Portuguese.\n',
    )

    assert.equal(existsSync(join(cacheNpmDir, 'pantheon-opencode@1.5.2')), false)
    assert.equal(existsSync(join(cacheNpmDir, 'pantheon-opencode@next')), false)
    assert.equal(existsSync(join(cacheNpmDir, 'pantheon-opencode@2.3.0')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('below-2.0.0 OpenCode host fails loud with upgrade guidance', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-guard-host-v1-'))
  try {
    seedPackage(root, { version: MIN_SUPPORTED_PANTHEON_VERSION })
    assert.throws(
      () => assertSupportedPantheonInstall({ packageRoot: root, hostVersion: '1.9.9' }),
      /OpenCode >= 2\.0\.0 required \(loaded: opencode 1\.9\.9\)/,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
