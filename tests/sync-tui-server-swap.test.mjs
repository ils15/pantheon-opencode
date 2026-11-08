/**
 * sync-tui-server-swap.test.mjs — the postinstall copy keeps ./server and
 * ./tui canonical.
 *
 * Root cause fixed on PR #294: scripts/install/plugin.mjs repointed the
 * copy's exports at the server bundle, but sync-tui.mjs's own
 * copyPluginFiles (postinstall + `npm update` path) only had the `./tui`
 * swap — a sync running after `init` silently reverted the copy to the
 * previous generation's server entry, so the host never attached the
 * copy's server half (the TUI runtime's reactive channel stays dead
 * without it). Since 2.0 there is a single generation: both exports are
 * canonical and no version is selected.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { copyPluginFiles } from '../scripts/sync-tui.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('postinstall sync keeps the ./server and ./tui exports canonical', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-sync-tui-server-swap-'))
  const source = join(REPO_ROOT, 'src', 'plugins', 'tui')
  try {
    copyPluginFiles(source, target)
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    assert.equal(pkg.exports['./server'], './dist/server.js')
    assert.equal(pkg.exports['./tui'], './dist/tui.js')
    assert.equal(pkg.exports['./server-v2'], undefined)
    assert.equal(pkg.exports['./tui-v2'], undefined)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
