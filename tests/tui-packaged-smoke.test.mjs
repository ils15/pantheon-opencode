import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

test('packaged TUI bundle registers its slots, handles a task event, and disposes cleanly', async () => {
  const {
    createLiveDelegationStore,
    default: plugin,
    registerLiveDelegationEvents,
  } = await import(pathToFileURL(join(root, 'src/plugins/tui/dist/tui.js')).href)
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

    const taskEvent = {
      properties: {
        part: {
          id: 'part_smoke',
          sessionID: 'ses_smoke',
          messageID: 'msg_smoke',
          type: 'tool',
          callID: 'call_smoke',
          tool: 'task',
          state: {
            status: 'running',
            input: { subagent_type: 'apollo', prompt: 'smoke interaction' },
            time: { start: Date.now() },
          },
        },
      },
    }

    // The live event adapter notifies the same store subscription the sidebar
    // uses, and an identical task part does not invalidate it twice.
    const liveStore = createLiveDelegationStore()
    let sidebarInvalidations = 0
    const unsubscribeSidebar = liveStore.subscribe(() => {
      sidebarInvalidations += 1
    })
    const liveHandlers = new Map()
    const unsubscribeLive = registerLiveDelegationEvents(
      {
        event: {
          on(name, callback) {
            const registered = liveHandlers.get(name) ?? []
            registered.push(callback)
            liveHandlers.set(name, registered)
            return () =>
              liveHandlers.set(
                name,
                registered.filter((entry) => entry !== callback),
              )
          },
        },
      },
      liveStore,
    )
    const taskUpdate = liveHandlers.get('message.part.updated')?.[0]
    assert.equal(
      typeof taskUpdate,
      'function',
      'the live store registers a task-part update handler',
    )
    taskUpdate(taskEvent)
    assert.equal(sidebarInvalidations, 1, 'a task event invalidates the sidebar store once')
    taskUpdate(taskEvent)
    assert.equal(
      sidebarInvalidations,
      1,
      'a duplicate task event does not invalidate the sidebar store',
    )
    unsubscribeLive()
    unsubscribeSidebar()

    await dispose()
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
    rmSync(project, { recursive: true, force: true })
    rmSync(xdg, { recursive: true, force: true })
  }
})
