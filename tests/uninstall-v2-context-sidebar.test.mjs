/**
 * uninstall-v2-context-sidebar.test.mjs — uninstall must undo the V2 Context
 * sidebar negation it installed.
 *
 * `init` (V2, global, `plugins` component) appends the exact directive
 * `-opencode.sidebar.context` to `<configDir>/cli.json` so Pantheon's TUI
 * plugin can draw the Context block itself. Removing the plugin without
 * removing that directive leaves the host's NATIVE block disabled with no
 * replacement — an orphaned negation. These tests pin:
 *   (a) uninstall removes the directive and preserves every other entry and key,
 *   (b) a cli.json created only by Pantheon is removed entirely,
 *   (c) a user cli.json with other keys stays (plugins emptied, nothing else),
 *   (d) unparseable JSON is never touched,
 *   (e) a dry run reports the action without writing.
 *
 * Run: node --test tests/uninstall-v2-context-sidebar.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CONTEXT_SIDEBAR_NEGATION } from '../scripts/install/opencode.mjs'
import { uninstallOpenCode } from '../scripts/uninstall.mjs'

const THIRD_PARTY_OBJECT = { package: './plugins/acme-local.ts', options: { retries: 2 } }

/**
 * Build a FLAT config dir (the global V2 layout: config dir === target), which
 * is where a V2 install writes cli.json.
 */
function globalConfigDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-uninstall-sidebar-'))
  mkdirSync(join(dir, 'agents'), { recursive: true })
  return dir
}

function writeCliConfig(dir, config) {
  writeFileSync(join(dir, 'cli.json'), JSON.stringify(config))
}

function readCliConfig(dir) {
  return JSON.parse(readFileSync(join(dir, 'cli.json'), 'utf8'))
}

test('uninstall removes the negation and preserves other entries, keys and order', () => {
  const dir = globalConfigDir()
  try {
    writeCliConfig(dir, {
      theme: { name: 'opencode', mode: 'system' },
      plugins: ['alpha-plugin', THIRD_PARTY_OBJECT, CONTEXT_SIDEBAR_NEGATION],
      session: { sidebar: 'auto' },
    })

    uninstallOpenCode(dir, false)

    const written = readCliConfig(dir)
    assert.deepEqual(
      written.plugins,
      ['alpha-plugin', THIRD_PARTY_OBJECT],
      'only the exact directive is dropped; object form and order survive',
    )
    assert.deepEqual(
      Object.keys(written),
      ['theme', 'plugins', 'session'],
      'key order is preserved',
    )
    assert.deepEqual(written.theme, { name: 'opencode', mode: 'system' })
    assert.deepEqual(written.session, { sidebar: 'auto' })
    assert.match(
      readFileSync(join(dir, 'cli.json'), 'utf8'),
      /^\{\n {2}"theme"/,
      'the file is re-serialized by the installer (keys/values kept, byte layout not)',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a cli.json that only ever held our directive is removed entirely', () => {
  const dir = globalConfigDir()
  try {
    writeCliConfig(dir, { plugins: [CONTEXT_SIDEBAR_NEGATION] })

    const result = uninstallOpenCode(dir, false)

    assert.equal(existsSync(join(dir, 'cli.json')), false, 'the empty stub is not left behind')
    assert.ok(
      result.paths.includes(join(dir, 'cli.json')),
      'the removal is part of the reviewed plan',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a user cli.json with other keys survives with an empty plugins array', () => {
  const dir = globalConfigDir()
  try {
    writeCliConfig(dir, {
      plugins: [CONTEXT_SIDEBAR_NEGATION],
      theme: { name: 'mine' },
    })

    uninstallOpenCode(dir, false)

    assert.deepEqual(readCliConfig(dir), { plugins: [], theme: { name: 'mine' } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('unparseable cli.json is never touched', () => {
  const dir = globalConfigDir()
  try {
    const broken = '{"plugins": ["-opencode.sidebar.context"],\n'
    writeFileSync(join(dir, 'cli.json'), broken)

    uninstallOpenCode(dir, false)

    assert.equal(readFileSync(join(dir, 'cli.json'), 'utf8'), broken, 'bytes are untouched')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a dry run reports the negation removal and writes nothing', () => {
  const dir = globalConfigDir()
  try {
    writeCliConfig(dir, { plugins: ['alpha-plugin', CONTEXT_SIDEBAR_NEGATION] })
    const before = readFileSync(join(dir, 'cli.json'), 'utf8')

    const result = uninstallOpenCode(dir, true)

    assert.equal(readFileSync(join(dir, 'cli.json'), 'utf8'), before, 'dry run never writes')
    assert.ok(result.paths.includes(join(dir, 'cli.json')), 'the path is in the preview plan')
    assert.equal(result.backupDir, undefined, 'no backup is created by a preview')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a project-scoped install leaves a project cli.json alone when it has no negation', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-uninstall-sidebar-project-'))
  try {
    const configDir = join(target, '.opencode')
    mkdirSync(configDir, { recursive: true })
    writeCliConfig(configDir, { plugins: ['alpha-plugin'] })

    uninstallOpenCode(target, false)

    assert.deepEqual(readCliConfig(configDir), { plugins: ['alpha-plugin'] })
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
