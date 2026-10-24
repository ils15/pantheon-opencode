import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const serverPath = join(process.cwd(), 'src/plugins/tui/dist/server-v2.js')
const { default: quotaPlugin } = await import(pathToFileURL(serverPath).href)
const SECRET_SENTINEL = 'quota-test-secret-sentinel'

function createEventSource() {
  const events = []
  const waiters = []
  let closed = 0
  let signal

  function waitForEvent(abortSignal) {
    if (events.length > 0) return Promise.resolve(events.shift())
    return new Promise((resolve) => {
      const waiter = (event) => {
        waiters.splice(waiters.indexOf(waiter), 1)
        abortSignal.removeEventListener('abort', onAbort)
        resolve(event)
      }
      const onAbort = () => {
        const index = waiters.indexOf(waiter)
        if (index >= 0) waiters.splice(index, 1)
        resolve(undefined)
      }
      waiters.push(waiter)
      abortSignal.addEventListener('abort', onAbort, { once: true })
    })
  }

  return {
    get closed() {
      return closed
    },
    get signal() {
      return signal
    },
    subscribe(options = {}) {
      signal = options.signal
      return {
        async *[Symbol.asyncIterator]() {
          try {
            while (!signal?.aborted) {
              const event = await waitForEvent(signal)
              if (!event) return
              yield event
            }
          } finally {
            closed += 1
          }
        },
      }
    },
    emit(event) {
      const waiter = waiters.shift()
      if (waiter) waiter(event)
      else events.push(event)
    },
  }
}

function createContext({ active = {}, credentials = {}, resolve, list = [], failResolve } = {}) {
  const eventSource = createEventSource()
  const activeCalls = []
  const resolveCalls = []
  let definition
  let handlers
  let rpcDisposed = 0

  const knownIntegrations = ['anthropic', 'openai'].map((id) => ({
    id,
    connections: list
      .filter((connection) => connection.integrationID === id)
      .map(({ integrationID, ...connection }) => connection),
  }))
  for (const integration of list.filter(
    (connection) => !knownIntegrations.some((known) => known.id === connection.integrationID),
  )) {
    knownIntegrations.push({ id: integration.integrationID, connections: [integration] })
  }

  const context = {
    integration: {
      list: async () => ({ location: {}, data: knownIntegrations }),
      connection: {
        active: async (integrationID) => {
          activeCalls.push(integrationID)
          return active[integrationID]
        },
        resolve: async (connection) => {
          resolveCalls.push(connection.id)
          if (failResolve) throw new Error(failResolve)
          if (resolve) return resolve(connection)
          return credentials[connection.id]
        },
      },
    },
    event: { subscribe: (options) => eventSource.subscribe(options) },
    rpc: {
      register: async (rpcDefinition, rpcHandlers) => {
        definition = rpcDefinition
        handlers = rpcHandlers
        return {
          dispose: async () => {
            rpcDisposed += 1
          },
        }
      },
    },
  }

  return {
    context,
    activeCalls,
    resolveCalls,
    eventSource,
    get definition() {
      return definition
    },
    get handlers() {
      return handlers
    },
    get rpcDisposed() {
      return rpcDisposed
    },
  }
}

function credentialConnection(integrationID, id, method = 'oauth') {
  return { integrationID, type: 'credential', id, label: 'test connection', method }
}

async function setup(fake) {
  const cleanup = await quotaPlugin.setup(fake.context)
  return cleanup
}

async function status(fake) {
  try {
    return await fake.handlers.status({})
  } catch {
    // Never let a host error value (which may contain secrets) reach test output.
    return { requestFailed: true }
  }
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve))
}

test('V2 quota RPC uses the closed integration allowlist and only the selected active credential', async (t) => {
  const oldConnection = credentialConnection('anthropic', 'old-login')
  const selectedConnection = credentialConnection('anthropic', 'active-login')
  const untrustedConnection = credentialConnection('other-provider', 'untrusted-login')
  const fake = createContext({
    active: {
      anthropic: selectedConnection,
      openai: { type: 'env', name: 'OPENAI_API_KEY' },
    },
    list: [oldConnection, selectedConnection, untrustedConnection],
    credentials: {
      'active-login': {
        type: 'oauth',
        methodID: 'oauth-method',
        access: SECRET_SENTINEL,
        refresh: SECRET_SENTINEL,
        expires: 123,
        metadata: { opaque: SECRET_SENTINEL },
      },
    },
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.deepEqual(fake.activeCalls, ['anthropic', 'openai'])
  assert.deepEqual(fake.resolveCalls, ['active-login'])
  assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
  assert.equal(JSON.stringify(fake.definition).includes(SECRET_SENTINEL), false)
  assert.deepEqual(result.providers, [
    { provider: 'anthropic', authentication: 'connected', quota: 'not_implemented' },
    { provider: 'openai', authentication: 'not_connected', quota: 'not_implemented' },
  ])
})

test('V2 quota resolver rejects untrusted or mismatched credential connections', async (t) => {
  const connection = (id, method = 'oauth') => credentialConnection('anthropic', id, method)
  const cases = [
    {
      name: 'needs_auth active connection',
      active: { ...connection('needs-auth'), status: { status: 'needs_auth' } },
      listed: [connection('needs-auth')],
      resolved: { type: 'oauth', access: SECRET_SENTINEL },
      expectResolve: false,
    },
    {
      name: 'unlisted active connection',
      active: connection('unlisted'),
      listed: [connection('listed')],
      resolved: { type: 'oauth', access: SECRET_SENTINEL },
      expectResolve: false,
    },
    {
      name: 'active method mismatches the listed connection',
      active: connection('method-mismatch', 'oauth'),
      listed: [connection('method-mismatch', 'key')],
      resolved: { type: 'oauth', access: SECRET_SENTINEL },
      expectResolve: false,
    },
    {
      name: 'external connection method',
      active: connection('external', 'external'),
      listed: [connection('external', 'external')],
      resolved: { type: 'oauth', access: SECRET_SENTINEL },
      expectResolve: false,
    },
    {
      name: 'OAuth method resolves a key credential',
      active: connection('oauth-key-mismatch', 'oauth'),
      listed: [connection('oauth-key-mismatch', 'oauth')],
      resolved: { type: 'key', key: SECRET_SENTINEL },
      expectResolve: true,
    },
    {
      name: 'key method resolves an OAuth credential',
      active: connection('key-oauth-mismatch', 'key'),
      listed: [connection('key-oauth-mismatch', 'key')],
      resolved: { type: 'oauth', access: SECRET_SENTINEL },
      expectResolve: true,
    },
  ]

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const fake = createContext({
        active: { anthropic: scenario.active },
        list: scenario.listed,
        credentials: { [scenario.active.id]: scenario.resolved },
      })
      const cleanup = await setup(fake)
      subtest.after(cleanup)

      const result = await status(fake)

      assert.equal(result.providers[0].authentication, 'not_connected')
      assert.deepEqual(fake.resolveCalls, scenario.expectResolve ? [scenario.active.id] : [])
      assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
    })
  }
})

test('V2 quota status deduplicates concurrent resolution and expires its in-memory cache', async (t) => {
  const active = {
    anthropic: credentialConnection('anthropic', 'anthropic-login', 'key'),
    openai: credentialConnection('openai', 'openai-login', 'key'),
  }
  let releaseResolve
  const resolveGate = new Promise((resolve) => {
    releaseResolve = resolve
  })
  const fake = createContext({
    active,
    list: Object.values(active),
    resolve: async () => {
      await resolveGate
      return { type: 'key', key: SECRET_SENTINEL, metadata: { opaque: 'ignored' } }
    },
  })
  const cleanup = await setup(fake)
  t.after(cleanup)
  const originalNow = Date.now
  let now = 10_000
  Date.now = () => now

  try {
    const first = status(fake)
    const concurrent = status(fake)
    while (fake.resolveCalls.length < 2) await flush()
    assert.equal(fake.resolveCalls.length, 2)
    releaseResolve()
    const [firstResult, concurrentResult] = await Promise.all([first, concurrent])
    assert.equal(JSON.stringify(firstResult).includes(SECRET_SENTINEL), false)
    assert.equal(JSON.stringify(concurrentResult).includes(SECRET_SENTINEL), false)
    assert.equal(JSON.stringify(firstResult) === JSON.stringify(concurrentResult), true)

    await status(fake)
    assert.equal(fake.resolveCalls.length, 2)

    now += 30_001
    await status(fake)
    assert.equal(fake.resolveCalls.length, 4)
  } finally {
    Date.now = originalNow
  }
})

test('V2 quota status invalidates resolved credentials on auth/integration events and cleans up', async () => {
  const connection = credentialConnection('anthropic', 'anthropic-login')
  const fake = createContext({
    active: { anthropic: connection },
    list: [connection],
    credentials: { 'anthropic-login': { type: 'oauth', access: SECRET_SENTINEL } },
  })
  const cleanup = await setup(fake)

  await status(fake)
  assert.deepEqual(fake.resolveCalls, ['anthropic-login'])
  for (const type of ['credential.switched', 'credential.updated', 'integration.updated']) {
    fake.eventSource.emit({ type, data: {} })
    await flush()
    await status(fake)
  }
  assert.deepEqual(fake.resolveCalls, [
    'anthropic-login',
    'anthropic-login',
    'anthropic-login',
    'anthropic-login',
  ])

  await cleanup()
  assert.equal(fake.eventSource.signal.aborted, true)
  assert.equal(fake.eventSource.closed, 1)
  assert.equal(fake.rpcDisposed, 1)
  await status(fake)
  assert.equal(fake.resolveCalls.length, 4)
})

test('V2 quota RPC converts host credential failures to safe normalized status', async (t) => {
  const connection = credentialConnection('anthropic', 'anthropic-login')
  const fake = createContext({
    active: { anthropic: connection },
    list: [connection],
    failResolve: SECRET_SENTINEL,
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
  assert.deepEqual(result.providers, [
    { provider: 'anthropic', authentication: 'unavailable', quota: 'not_implemented' },
    { provider: 'openai', authentication: 'not_connected', quota: 'not_implemented' },
  ])
})
