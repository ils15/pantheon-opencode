import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

test('packaged TUI bundle registers its slots, handles a task event, and disposes cleanly', async () => {
  // Since 2.0 the bundle is the plugin lifecycle: slots in, panels out,
  // clean dispose. Delegation reactivity is collector-driven and covered by
  // the sidebar/dispatch model suites, not by a client-side live store.
  const { default: plugin } = await import(
    pathToFileURL(join(root, 'src/plugins/tui/dist/tui.js')).href
  )
  const project = mkdtempSync(join(tmpdir(), 'pantheon-tui-smoke-'))
  // Hermetic "What's new" state: the packaged window reads its last-seen
  // version under $XDG_CONFIG_HOME; a tmp config dir with the CURRENT version
  // marked seen keeps the window closed and the run read-only.
  const xdg = mkdtempSync(join(tmpdir(), 'pantheon-tui-smoke-xdg-'))
  mkdirSync(join(xdg, 'opencode', '.pantheon'), { recursive: true })
  const distVersion = JSON.parse(
    readFileSync(join(root, 'src', 'plugins', 'tui', 'package.json'), 'utf8'),
  ).version
  writeFileSync(
    join(xdg, 'opencode', '.pantheon', 'whats-new.json'),
    `${JSON.stringify({ seenVersion: distVersion, updatedAt: new Date().toISOString() })}\n`,
  )
  const slots = []
  const context = {
    location: { directory: project, worktree: project },
    data: {
      location: { vcs: { sync: async () => ({}) } },
      session: { list: () => [], status: () => undefined, sync: async () => ({}) },
    },
    ui: {
      slot(registration) {
        slots.push(registration)
        return () => {}
      },
      toast: { show: () => {} },
    },
    keymap: { layer: () => () => {} },
  }
  const previousXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = xdg

  try {
    assert.equal(plugin.id, 'pantheon.tui')
    const dispose = await plugin.setup(context)
    assert.equal(typeof dispose, 'function', 'setup returns its clean-exit disposer')

    const slotFor = (name) => slots.find((slot) => slot.append === name)
    assert.equal(
      typeof slotFor('sidebar.content')?.render,
      'function',
      'the packaged plugin exposes its sidebar render slot',
    )
    assert.equal(
      typeof slotFor('session.panel')?.render,
      'function',
      'the packaged plugin exposes the dispatch panel slot',
    )
    assert.equal(
      typeof slotFor('prompt.footer')?.render,
      'function',
      'the packaged plugin contributes its prompt footer',
    )

    await dispose()
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
    rmSync(project, { recursive: true, force: true })
    rmSync(xdg, { recursive: true, force: true })
  }
})
