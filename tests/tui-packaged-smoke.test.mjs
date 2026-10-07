import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

test('packaged TUI bundle registers its sidebar, handles a task event, and disposes cleanly', async () => {
  const {
    createLiveDelegationStore,
    default: plugin,
    registerLiveDelegationEvents,
  } = await import(pathToFileURL(join(root, 'src/plugins/tui/dist/tui.js')).href)
  const project = mkdtempSync(join(tmpdir(), 'pantheon-tui-smoke-'))
  const originalBun = globalThis.Bun
  const registrations = []
  const disposers = []
  const handlers = new Map()
  let configWasParsed
  const parsedConfig = new Promise((resolve) => {
    configWasParsed = resolve
  })

  const api = {
    state: { path: { worktree: project, directory: project, config: project, state: project } },
    client: {
      file: { read: async () => ({ data: { content: '' } }) },
      process: { exec: async () => ({ stdout: '' }) },
    },
    event: {
      on(name, callback) {
        const registered = handlers.get(name) ?? []
        registered.push(callback)
        handlers.set(name, registered)
        return () =>
          handlers.set(
            name,
            registered.filter((entry) => entry !== callback),
          )
      },
    },
    lifecycle: { onDispose: (dispose) => disposers.push(dispose) },
    slots: { register: (registration) => registrations.push(registration) },
    kv: { get: () => undefined, set: () => {} },
  }

  try {
    globalThis.Bun = {
      TOML: {
        parse: () => {
          configWasParsed()
          return {
            anthropic: { enabled: false },
            openai: { enabled: false },
            opencodego: { enabled: false },
          }
        },
      },
    }
    writeFileSync(join(project, 'usage-bar.toml'), '')
    assert.equal(plugin.id, 'pantheon.tui')
    await plugin.setup()
    plugin.tui(api)
    // Let the plugin's fire-and-forget config read and provider selection
    // finish before removing its temporary config directory.
    await parsedConfig
    await new Promise((resolve) => setImmediate(resolve))

    const sidebar = registrations
      .map((registration) => registration.slots.sidebar_content)
      .find((slot) => typeof slot === 'function')
    assert.equal(typeof sidebar, 'function', 'the packaged plugin exposes its sidebar render slot')

    const event = handlers.get('message.part.updated')?.[0]
    assert.equal(typeof event, 'function', 'the packaged plugin subscribes to live tool events')
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

    // SDK listener return values are ignored. Verify the production event
    // registration adapter notifies the same store subscription the sidebar
    // uses, and that an identical task part does not invalidate it twice.
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

    assert.equal(
      event(taskEvent),
      undefined,
      'the SDK event listener does not rely on a return value',
    )

    assert.equal(disposers.length, 1, 'the plugin registers a clean-exit disposer')
    for (const dispose of disposers) dispose()
    assert.equal(
      [...handlers.values()].reduce((count, registered) => count + registered.length, 0),
      0,
      'clean exit removes live tool event listeners',
    )
  } finally {
    if (originalBun === undefined) delete globalThis.Bun
    else globalThis.Bun = originalBun
    rmSync(project, { recursive: true, force: true })
  }
})
