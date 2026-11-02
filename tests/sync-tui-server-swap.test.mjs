/**
 * sync-tui-server-swap.test.mjs — the postinstall copy keeps ./server canonical.
 *
 * Root cause fixed on PR #294: scripts/install/plugin.mjs repointed
 * `exports['./server']` at the server bundle, but sync-tui.mjs's own
 * copyPluginFiles (postinstall + `npm update` path) did not — a sync running
 * after `init` silently reverted the copy to the old server bundle and the
 * `pantheon.quota` RPC disappeared. Since 2.0 both paths copy the package
 * verbatim: the canonical ./tui and ./server exports already point at the
 * compiled bundles, so the divergence cannot recur. This test pins that.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { copyPluginFiles } from '../scripts/sync-tui.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('postinstall sync keeps the ./server and ./tui exports on the compiled bundles', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-sync-tui-server-swap-'))
  const source = join(REPO_ROOT, 'src', 'plugins', 'tui')
  try {
    copyPluginFiles(source, target)
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'))
    assert.equal(pkg.exports['./server'], './dist/server.js')
    assert.equal(pkg.exports['./tui'], './dist/tui.js')
    // The deprecated aliases ride along and resolve to the same bundles.
    assert.equal(pkg.exports['./server-v2'], './dist/server.js')
    assert.equal(pkg.exports['./tui-v2'], './dist/tui.js')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
