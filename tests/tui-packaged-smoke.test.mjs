import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
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
  const activeIntervals = new Set()
  const activeTimeouts = new Set()
  const handlers = new Map()
  const originalUsageApiKey = process.env.PANTHEON_OPENCODE_API_KEY
  let providerFetches = 0
  const originalTimers = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    fetch: globalThis.fetch,
  }
  const unhandledRejections = []
  const onUnhandledRejection = (reason) => unhandledRejections.push(reason)
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
    slots: {
      register(registration) {
        registrations.push(registration)
        if (registration.order === 60) throw new Error('optional usage slot unavailable')
      },
    },
    kv: { get: () => undefined, set: () => {} },
  }

  try {
    globalThis.setInterval = (callback) => {
      const timer = { callback }
      activeIntervals.add(timer)
      return timer
    }
    globalThis.clearInterval = (timer) => activeIntervals.delete(timer)
    globalThis.setTimeout = (callback) => {
      const timer = { callback }
      activeTimeouts.add(timer)
      return timer
    }
    globalThis.clearTimeout = (timer) => activeTimeouts.delete(timer)
    process.env.PANTHEON_OPENCODE_API_KEY = 'tui-smoke-test-key'
    globalThis.fetch = async () => {
      providerFetches += 1
      return { ok: false }
    }
    process.on('unhandledRejection', onUnhandledRejection)
    globalThis.Bun = {
      TOML: {
        parse: () => {
          configWasParsed()
          return {
            ui: { show_status: false },
            anthropic: {
              enabled: true,
              credentials_path: join(project, 'missing-credentials.json'),
            },
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
    const sidebar = registrations
      .map((registration) => registration.slots.sidebar_content)
      .find((slot) => typeof slot === 'function')
    assert.equal(typeof sidebar, 'function', 'the sidebar registers before optional config I/O')

    // Let the optional config read and provider selection finish. The usage
    // slot is deliberately made unavailable to exercise fail-open startup.
    await parsedConfig
    await delay(25)

    assert.equal(
      activeIntervals.size,
      0,
      'a failed optional usage-slot registration leaves no refresh interval',
    )
    assert.equal(
      providerFetches,
      0,
      'a failed optional usage-slot registration does not start provider polling',
    )
    assert.equal(
      unhandledRejections.length,
      0,
      'an optional usage-slot failure does not reject TUI startup',
    )

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

    assert.equal(disposers.length, 2, 'the plugin registers event and usage cleanup handlers')
    for (const dispose of disposers) dispose()
    await delay(25)
    assert.equal(activeIntervals.size, 0, 'clean exit clears the usage refresh interval')
    assert.equal(
      activeTimeouts.size,
      0,
      'clean exit prevents pending provider polls from rescheduling',
    )
    assert.equal(
      [...handlers.values()].reduce((count, registered) => count + registered.length, 0),
      0,
      'clean exit removes live tool event listeners',
    )
  } finally {
    process.off('unhandledRejection', onUnhandledRejection)
    globalThis.setInterval = originalTimers.setInterval
    globalThis.clearInterval = originalTimers.clearInterval
    globalThis.setTimeout = originalTimers.setTimeout
    globalThis.clearTimeout = originalTimers.clearTimeout
    globalThis.fetch = originalTimers.fetch
    if (originalUsageApiKey === undefined) delete process.env.PANTHEON_OPENCODE_API_KEY
    else process.env.PANTHEON_OPENCODE_API_KEY = originalUsageApiKey
    if (originalBun === undefined) delete globalThis.Bun
    else globalThis.Bun = originalBun
    rmSync(project, { recursive: true, force: true })
  }
})
