/**
 * sync-tui-server-swap.test.mjs — the postinstall copy also repoints ./server.
 *
 * Root cause fixed on PR #294: scripts/install/plugin.mjs swapped
 * `exports['./server']` → `./server-v2` in the V2 copy, but sync-tui.mjs's
 * own copyPluginFiles (postinstall + `npm update` path) only had the `./tui`
 * swap — a sync running after `init` silently reverted the copy to the V1
 * server and the `pantheon.quota` RPC disappeared.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { copyPluginFiles } from '../scripts/sync-tui.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('postinstall sync repoints the ./server export at the V2 server bundle', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-sync-tui-server-swap-'))
  const source = join(REPO_ROOT, 'src', 'plugins', 'tui')
  try {
    copyPluginFiles(source, target, 'v2')
    const v2Package = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    assert.equal(v2Package.exports['./server'], './dist/server-v2.js')
    assert.equal(v2Package.exports['./tui'], './dist/tui-v2.js')

    copyPluginFiles(source, target, 'v1')
    const v1Package = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    assert.equal(v1Package.exports['./server'], './dist/server.js')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
