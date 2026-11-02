/**
 * tui-packaged-smoke.test.mjs — the packaged TUI bundle loads and registers.
 *
 * A cheap smoke over the COMMITTED dist bundle (not the TSX sources): it must
 * expose the 2.x TUI plugin API contract — `id`, a `setup(context)` that
 * registers the sidebar slot and returns a disposer, and the `contextBlockRows`
 * named export doctor's Context-block capability check scans for.
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToURLFix()

function fileURLToURLFix() {
  return fileURLToPath(new URL('..', import.meta.url))
}

test('packaged TUI bundle registers its sidebar slot and disposes cleanly', async () => {
  const { default: plugin, contextBlockRows } = await import(
    pathToFileURL(join(root, 'src/plugins/tui/dist/tui.js')).href
  )
  assert.equal(plugin.id, 'pantheon.tui')
  assert.equal(typeof contextBlockRows, 'function', 'the Context-block marker export is present')

  const registered = []
  const context = {
    // Minimal context: the setup path only needs location resolution and the
    // slot registrar; quota/runtime paths degrade behind the rpc seam.
    state: { path: { worktree: root, directory: root, config: root, state: root } },
    client: {
      rpc: () => () => {},
      file: { read: async () => ({ data: { content: '' } }) },
    },
    storage: {
      store: (_key, options) => [() => options.initial, () => {}],
      memory: (_key, options) => [() => options.initial, () => {}],
    },
    ui: {
      slot: (registration) => {
        registered.push(registration)
        return () => {}
      },
    },
  }

  const dispose = plugin.setup(context)
  assert.equal(typeof dispose, 'function', 'setup returns a disposer')
  const slots = registered.map((registration) => registration.append)
  assert.ok(slots.includes('sidebar.content'), 'the sidebar slot is registered')
  assert.ok(slots.includes('prompt.footer'), 'the prompt footer slot is registered')
  assert.ok(slots.includes('session.panel'), 'the dispatch panel slot is registered')

  dispose()
})
