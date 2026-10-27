/**
 * tui-copy-registration.test.mjs — the V2 init registers the copied
 * pantheon-tui plugin in config["plugins"].
 *
 * OpenCode 2.x loads server-side RPC of a local plugin folder ONLY from the
 * `config.plugins` list (sandbox probe evidence). Without the entry the host
 * never loads the copy's server and `pantheon.quota` stays `rpc.unavailable`.
 * ensureTuiCopyRegistered must be idempotent: never duplicate the entry and
 * never drop other entries.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ensureTuiCopyRegistered } from '../scripts/install/opencode.mjs'

function makeTuiCopy(config) {
  const { tuiCopyDir } = config
  if (tuiCopyDir === undefined) return undefined
  mkdirSync(tuiCopyDir, { recursive: true })
  writeFileSync(join(tuiCopyDir, 'package.json'), '{}\n')
  return tuiCopyDir
}

function registered(config) {
  return Array.isArray(config.plugins) ? config.plugins : []
}

async function withTempCopy(label, fn) {
  const root = mkdtempSync(join(tmpdir(), `pantheon-tui-copy-${label}-`))
  const tuiCopyDir = join(root, '.opencode', 'plugins', 'pantheon-tui')
  try {
    return await fn(tuiCopyDir, root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('ensureTuiCopyRegistered registers the copy and is idempotent across re-runs', async () => {
  await withTempCopy('idempotent', async (tuiCopyDir) => {
    makeTuiCopy({ tuiCopyDir })

    const config = {}
    ensureTuiCopyRegistered(config, { tuiCopyDir })
    assert.deepEqual(registered(config), [tuiCopyDir], 'missing directive created the list')

    // A re-run with the entry already present (as a re-written init would see)
    // must not duplicate it.
    config.plugins = [tuiCopyDir]
    ensureTuiCopyRegistered(config, { tuiCopyDir })
    assert.deepEqual(registered(config), [tuiCopyDir], 'existing entry must not be duplicated')
  })
})

test('ensureTuiCopyRegistered preserves other plugin entries', async () => {
  await withTempCopy('preserve', async (tuiCopyDir) => {
    makeTuiCopy({ tuiCopyDir })
    const thirdParty = 'npm:@acme/kept-plugin'
    const thirdPartyObject = { package: './vendor/acme', options: { enabled: true } }

    const config = { plugins: [thirdParty, thirdPartyObject] }
    ensureTuiCopyRegistered(config, { tuiCopyDir })
    assert.ok(
      registered(config).includes(tuiCopyDir),
      'the TUI copy must be registered for the host to load its server',
    )
    assert.equal(
      registered(config).length,
      3,
      `existing entries must be preserved: ${JSON.stringify(registered(config))}`,
    )
    assert.ok(registered(config).includes(thirdParty))
    assert.ok(registered(config).includes(thirdPartyObject))
  })
})

test('ensureTuiCopyRegistered does not register a missing copy directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-tui-copy-missing-'))
  try {
    const dangling = join(root, 'plugins', 'pantheon-tui')
    assert.equal(existsSync(dangling), false)
    const config = { plugins: ['npm:@acme/kept-plugin'] }
    ensureTuiCopyRegistered(config, { tuiCopyDir: dangling })
    assert.deepEqual(
      registered(config),
      ['npm:@acme/kept-plugin'],
      'a plugins-component-less install must not get a dangling entry',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ensureTuiCopyRegistered ignores non-array plugin lists', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-tui-copy-shape-'))
  try {
    const tuiCopyDir = join(root, 'plugins', 'pantheon-tui')
    mkdirSync(tuiCopyDir, { recursive: true })
    // A corrupt/foreign shape must not throw out of the config merge; the
    // existing writer normalizes it to an array before appending the copy.
    const config = { plugins: 'not-an-array' }
    ensureTuiCopyRegistered(config, { tuiCopyDir })
    assert.deepEqual(registered(config), [tuiCopyDir])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
