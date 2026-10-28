import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { pathToFileURL, URL } from 'node:url'
import { format } from 'node:util'
import Ajv from 'ajv'

const serverPath = join(process.cwd(), 'src/plugins/tui/dist/server-v2.js')
const { createQuotaPlugin } = await import(pathToFileURL(serverPath).href)
const quotaPlugin = createQuotaPlugin(async () => ({ reason: 'cli_identity_unavailable' }))
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

function createContext({
  active = {},
  credentials = {},
  providerSettings = {},
  resolve,
  list = [],
  failResolve,
  failActive,
} = {}) {
  const eventSource = createEventSource()
  const activeCalls = []
  const resolveCalls = []
  let definition
  let handlers
  let rpcDisposed = 0
  const rpcEvents = []

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
    provider: {
      get: async ({ providerID }) =>
        Object.hasOwn(providerSettings, providerID)
          ? {
              data: {
                id: providerID,
                settings: { apiKey: providerSettings[providerID] },
              },
            }
          : { data: { id: providerID, settings: {} } },
    },
    integration: {
      list: async () => ({ location: {}, data: knownIntegrations }),
      connection: {
        active: async (integrationID) => {
          activeCalls.push(integrationID)
          if (failActive === integrationID) throw new Error('active lookup failed')
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
          events: {
            emit: async (name, payload) => rpcEvents.push({ name, payload }),
          },
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
    rpcEvents,
  }
}

function credentialConnection(integrationID, id, method = 'oauth') {
  return { integrationID, type: 'credential', id, label: 'test connection', method }
}

function provider(result, id) {
  return result.providers.find((item) => item.provider === id)
}

async function setup(fake, plugin = quotaPlugin) {
  const cleanup = await plugin.setup(fake.context)
  return cleanup
}

async function status(fake, signal = new AbortController().signal) {
  try {
    const result = await fake.handlers.status({}, { signal })
    const validate = new Ajv().compile(fake.definition.methods.status.output)
    assert.equal(validate(result), true, JSON.stringify(validate.errors))
    return result
  } catch {
    // Never let a host error value (which may contain secrets) reach test output.
    return { requestFailed: true }
  }
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve))
}

test('blocked connected sources require a resolved credential and never serialize its secret', async (t) => {
  const oldConnection = credentialConnection('xiaomi-mimo', 'old-login', 'key')
  const selectedConnection = credentialConnection('xiaomi-mimo', 'active-login', 'key')
  const untrustedConnection = credentialConnection('other-provider', 'untrusted-login')
  const fake = createContext({
    active: {
      'xiaomi-mimo': selectedConnection,
      openai: { type: 'env', name: 'OPENAI_API_KEY' },
    },
    list: [oldConnection, selectedConnection, untrustedConnection],
    credentials: {
      'active-login': {
        type: 'key',
        key: SECRET_SENTINEL,
      },
    },
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.deepEqual(fake.activeCalls, ['xiaomi-mimo'])
  assert.deepEqual(fake.resolveCalls, ['active-login'])
  assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
  assert.equal(JSON.stringify(fake.definition).includes(SECRET_SENTINEL), false)
  assert.equal(result.providers.length, 1)
  assert.deepEqual(provider(result, 'xiaomi-mimo'), {
    provider: 'xiaomi-mimo',
    label: 'Xiaomi MiMo',
    scope: 'account',
    authentication: 'connected',
    state: 'unavailable',
    reason: 'unsupported',
    metrics: [],
  })
  assert.equal(provider(result, 'openai'), undefined)
})

test('V2 quota resolver rejects untrusted or mismatched credential connections', async (t) => {
  const connection = (id, method = 'oauth') => credentialConnection('deepseek', id, method)
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
        active: { deepseek: scenario.active },
        list: scenario.listed,
        credentials: { [scenario.active.id]: scenario.resolved },
      })
      const cleanup = await setup(fake)
      subtest.after(cleanup)

      const result = await status(fake)

      assert.equal(provider(result, 'deepseek'), undefined)
      assert.deepEqual(fake.resolveCalls, scenario.expectResolve ? [scenario.active.id] : [])
      assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
    })
  }
})

test('V2 quota status omits unconfigured providers and stops querying after credential removal', async (t) => {
  const connection = credentialConnection('deepseek', 'deepseek-login', 'key')
  const credentials = { 'deepseek-login': { type: 'key', key: SECRET_SENTINEL } }
  const listedButInactive = credentialConnection('openrouter', 'inactive-login', 'key')
  const fake = createContext({
    active: { deepseek: connection },
    list: [connection, listedButInactive],
    credentials,
  })
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async (url) => {
    fetchCalls += 1
    assert.equal(url, 'https://api.deepseek.com/user/balance')
    return Response.json({
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: '1' }],
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const connected = await status(fake)
  assert.deepEqual(
    connected.providers.map(({ provider }) => provider),
    ['deepseek'],
  )
  assert.equal(provider(connected, 'deepseek').state, 'available')
  assert.equal(provider(connected, 'openrouter'), undefined)
  assert.deepEqual(fake.resolveCalls, ['deepseek-login'])
  assert.equal(fetchCalls, 1)

  credentials['deepseek-login'] = undefined
  fake.eventSource.emit({ type: 'credential.updated', data: {} })
  await flush()
  const removed = await status(fake)
  assert.deepEqual(removed.providers, [])
  assert.deepEqual(fake.resolveCalls, ['deepseek-login', 'deepseek-login'])
  assert.equal(fetchCalls, 1)
})

test('V2 quota does not surface or invoke a local CLI-only source', async (t) => {
  let cliCalls = 0
  const plugin = createQuotaPlugin(async () => {
    cliCalls += 1
    return { percentage: 0.5 }
  })
  const fake = createContext()
  const cleanup = await setup(fake, plugin)
  t.after(cleanup)

  const result = await status(fake)
  assert.equal(provider(result, 'alibaba-token-plan'), undefined)
  assert.equal(cliCalls, 0)
})

test('V2 quota omits OAuth connections whose resolved access credential is blank', async (t) => {
  const connection = credentialConnection('anthropic', 'blank-oauth-login', 'oauth')
  const fake = createContext({
    active: { anthropic: connection },
    list: [connection],
    credentials: { 'blank-oauth-login': { type: 'oauth', access: ' \t\n ' } },
  })
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('must not call provider')
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.deepEqual(result.providers, [])
  assert.deepEqual(fake.resolveCalls, ['blank-oauth-login'])
  assert.equal(fetchCalls, 0)
})

test('V2 quota status deduplicates concurrent resolution and expires its in-memory cache', async (t) => {
  const active = {
    deepseek: credentialConnection('deepseek', 'deepseek-login', 'key'),
    openrouter: credentialConnection('openrouter', 'openrouter-login', 'key'),
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
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) =>
    url === 'https://api.deepseek.com/user/balance'
      ? Response.json({
          is_available: true,
          balance_infos: [{ currency: 'USD', total_balance: '1' }],
        })
      : Response.json({ data: { limit: 10, limit_remaining: 8, usage: 2 } })
  t.after(() => {
    globalThis.fetch = originalFetch
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

test('V2 quota status invalidates resolved credentials on auth/integration/provider events and cleans up', async (t) => {
  const connection = credentialConnection('deepseek', 'deepseek-login', 'key')
  const fake = createContext({
    active: { deepseek: connection },
    list: [connection],
    credentials: { 'deepseek-login': { type: 'key', key: SECRET_SENTINEL } },
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    Response.json({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '1' }] })
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)

  await status(fake)
  assert.deepEqual(fake.resolveCalls, ['deepseek-login'])
  for (const type of [
    'credential.switched',
    'credential.updated',
    'integration.updated',
    'provider.updated',
  ]) {
    fake.eventSource.emit({ type, data: {} })
    await flush()
    await status(fake)
  }
  assert.deepEqual(fake.resolveCalls, [
    'deepseek-login',
    'deepseek-login',
    'deepseek-login',
    'deepseek-login',
    'deepseek-login',
  ])
  assert.deepEqual(fake.rpcEvents, [
    { name: 'credentials_changed', payload: {} },
    { name: 'credentials_changed', payload: {} },
    { name: 'credentials_changed', payload: {} },
    { name: 'credentials_changed', payload: {} },
  ])

  await cleanup()
  assert.equal(fake.eventSource.signal.aborted, true)
  assert.equal(fake.eventSource.closed, 1)
  assert.equal(fake.rpcDisposed, 1)
  await status(fake)
  assert.equal(fake.resolveCalls.length, 5)
})

test('credential switch racing resolution prevents sending the stale credential to an adapter', async (t) => {
  const connection = credentialConnection('deepseek', 'deepseek-old-login', 'key')
  const fake = createContext({
    active: { deepseek: connection },
    list: [connection],
    credentials: { 'deepseek-old-login': { type: 'key', key: SECRET_SENTINEL } },
  })
  let releaseActive
  const activeGate = new Promise((resolve) => {
    releaseActive = resolve
  })
  const originalActive = fake.context.integration.connection.active
  fake.context.integration.connection.active = async (integrationID) => {
    const result = await originalActive(integrationID)
    if (integrationID === 'deepseek') await activeGate
    return result
  }
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    return Response.json({
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: '1' }],
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const pendingStatus = status(fake)
  while (!fake.activeCalls.includes('deepseek')) await flush()
  fake.eventSource.emit({ type: 'credential.switched', data: {} })
  await flush()
  releaseActive()

  const result = await pendingStatus
  assert.equal(provider(result, 'deepseek'), undefined)
  assert.equal(fetchCalls, 0)
  assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
})

test('RPC cancellation aborts the last in-flight adapter request without stranding work', async (t) => {
  const connection = credentialConnection('deepseek', 'deepseek-login', 'key')
  const fake = createContext({
    active: { deepseek: connection },
    list: [connection],
    credentials: { 'deepseek-login': { type: 'key', key: SECRET_SENTINEL } },
  })
  const originalFetch = globalThis.fetch
  let fetchSignal
  let fetchSettled = false
  globalThis.fetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      fetchSignal = options.signal
      const onAbort = () => {
        fetchSettled = true
        reject(options.signal.reason)
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
      if (options.signal.aborted) onAbort()
    })
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)
  const requestController = new AbortController()
  const pendingStatus = fake.handlers.status({}, { signal: requestController.signal })

  for (let attempt = 0; attempt < 100 && !fetchSignal; attempt += 1) await flush()
  assert.ok(fetchSignal, 'provider fetch should start')
  requestController.abort()

  await assert.rejects(pendingStatus)
  assert.equal(fetchSignal.aborted, true)
  assert.equal(fetchSettled, true)
})

test('RPC cancellation preserves a deduplicated request while another caller still needs it', async (t) => {
  const connection = credentialConnection('deepseek', 'deepseek-login', 'key')
  const fake = createContext({
    active: { deepseek: connection },
    list: [connection],
    credentials: { 'deepseek-login': { type: 'key', key: SECRET_SENTINEL } },
  })
  const originalFetch = globalThis.fetch
  let fetchSignal
  let resolveFetch
  let fetchCalls = 0
  globalThis.fetch = async (_url, options) => {
    fetchCalls += 1
    fetchSignal = options.signal
    return new Promise((resolve) => {
      resolveFetch = () =>
        resolve(
          Response.json({
            is_available: true,
            balance_infos: [{ currency: 'USD', total_balance: '1' }],
          }),
        )
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)
  const firstController = new AbortController()
  const secondController = new AbortController()
  const first = fake.handlers.status({}, { signal: firstController.signal })
  const second = fake.handlers.status({}, { signal: secondController.signal })

  for (let attempt = 0; attempt < 100 && !fetchSignal; attempt += 1) await flush()
  assert.ok(fetchSignal, 'provider fetch should start')
  for (let attempt = 0; attempt < 5; attempt += 1) await flush()
  firstController.abort()
  assert.equal(fetchSignal.aborted, false)
  resolveFetch()

  await assert.rejects(first)
  const result = await second
  assert.equal(provider(result, 'deepseek').state, 'available')
  assert.equal(fetchCalls, 1)
})

test('plugin shutdown aborts provider requests already in flight', async (t) => {
  const connection = credentialConnection('deepseek', 'deepseek-login', 'key')
  const fake = createContext({
    active: { deepseek: connection },
    list: [connection],
    credentials: { 'deepseek-login': { type: 'key', key: SECRET_SENTINEL } },
  })
  const originalFetch = globalThis.fetch
  let fetchSignal
  let fetchSettled = false
  globalThis.fetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      fetchSignal = options.signal
      options.signal.addEventListener(
        'abort',
        () => {
          fetchSettled = true
          reject(options.signal.reason)
        },
        { once: true },
      )
    })
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  let cleaned = false
  const dispose = async () => {
    if (cleaned) return
    cleaned = true
    await cleanup()
  }
  t.after(dispose)
  const pendingStatus = fake.handlers.status({}, { signal: new AbortController().signal })

  for (let attempt = 0; attempt < 100 && !fetchSignal; attempt += 1) await flush()
  assert.ok(fetchSignal, 'provider fetch should start')
  await dispose()
  const result = await pendingStatus

  assert.equal(fetchSignal.aborted, true)
  assert.equal(fetchSettled, true)
  assert.equal(provider(result, 'deepseek').state, 'unavailable')
})

test('credential invalidation aborts the active adapter request', async (t) => {
  const connection = credentialConnection('deepseek', 'deepseek-login', 'key')
  const fake = createContext({
    active: { deepseek: connection },
    list: [connection],
    credentials: { 'deepseek-login': { type: 'key', key: SECRET_SENTINEL } },
  })
  const originalFetch = globalThis.fetch
  let fetchSignal
  let fetchSettled = false
  globalThis.fetch = async (_url, options) =>
    new Promise((_resolve, reject) => {
      fetchSignal = options.signal
      options.signal.addEventListener(
        'abort',
        () => {
          fetchSettled = true
          reject(options.signal.reason)
        },
        { once: true },
      )
    })
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)
  const pendingStatus = fake.handlers.status({}, { signal: new AbortController().signal })

  for (let attempt = 0; attempt < 100 && !fetchSignal; attempt += 1) await flush()
  assert.ok(fetchSignal, 'provider fetch should start')
  fake.eventSource.emit({ type: 'credential.updated', data: {} })
  for (let attempt = 0; attempt < 100 && !fetchSignal.aborted; attempt += 1) await flush()
  const result = await pendingStatus

  assert.equal(fetchSignal.aborted, true)
  assert.equal(fetchSettled, true)
  assert.equal(provider(result, 'deepseek').state, 'unavailable')
})

test('V2 quota reports credential resolution failures separately from an empty eligible list', async (t) => {
  const connection = credentialConnection('deepseek', 'deepseek-login', 'key')
  const fake = createContext({
    active: { deepseek: connection },
    list: [connection],
    failResolve: SECRET_SENTINEL,
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const emittedLines = []
  const originalWarn = console.warn
  console.warn = (...values) => {
    emittedLines.push(format(...values))
  }
  let result
  try {
    result = await status(fake)
  } finally {
    console.warn = originalWarn
  }

  assert.ok(emittedLines.some((line) => line.includes('credential resolution failed (exception)')))
  assert.equal(
    emittedLines.some((line) => line.includes(SECRET_SENTINEL)),
    false,
  )
  assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
  assert.equal(result.credential_resolution_failed, true)
  assert.deepEqual(result.providers, [])
  assert.equal(provider(result, 'deepseek'), undefined)
  assert.equal(provider(result, 'openai'), undefined)

  const emptyFake = createContext()
  const emptyCleanup = await setup(emptyFake)
  t.after(emptyCleanup)
  const empty = await status(emptyFake)
  assert.deepEqual(empty.providers, [])
  assert.equal(empty.credential_resolution_failed, undefined)
})

test('DeepSeek balance adapter projects only validated provider balance and status fields', async (t) => {
  const connection = credentialConnection('deepseek', 'deepseek-login', 'key')
  const fake = createContext({
    active: { deepseek: connection },
    list: [connection],
    credentials: {
      'deepseek-login': {
        type: 'key',
        key: SECRET_SENTINEL,
        metadata: { ignored: SECRET_SENTINEL },
      },
    },
  })
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return Response.json({
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: '4.25', granted_balance: '9' }],
      secret: SECRET_SENTINEL,
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://api.deepseek.com/user/balance')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.headers.authorization, `Bearer ${SECRET_SENTINEL}`)
  assert.deepEqual(provider(result, 'deepseek').metrics, [
    { kind: 'provider_status', status: 'available', label: 'Service status' },
    { kind: 'balance', amount: 4.25, currency: 'USD', label: 'Total balance' },
  ])
  assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
  assert.equal(JSON.stringify(fake.definition).includes(SECRET_SENTINEL), false)
})

test('Ollama Cloud keeps included and purchased balance separate from legacy quota windows', async (t) => {
  const connection = credentialConnection('ollama-cloud', 'ollama-login', 'key')
  const fake = createContext({
    active: { 'ollama-cloud': connection },
    list: [connection],
    credentials: { 'ollama-login': { type: 'key', key: SECRET_SENTINEL } },
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://ollama.com/api/balance')
    return Response.json({
      included: {
        balance_usd: 72.5,
        allowance_usd: 100,
        session: { remaining_percent: 75, resets_at: '2026-10-25T00:00:00Z' },
      },
      purchased: { balance_usd: 25 },
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.deepEqual(provider(result, 'ollama-cloud').metrics, [
    { kind: 'balance', amount: 72.5, currency: 'USD', label: 'Included balance' },
    { kind: 'balance', amount: 25, currency: 'USD', label: 'Purchased balance' },
    {
      kind: 'provider_quota',
      used: 25,
      remaining: 75,
      unit: '%',
      label: 'Session quota',
      period: 'session',
      resetsAt: Date.parse('2026-10-25T00:00:00Z'),
    },
  ])
})

test('OpenRouter reports selected-key budget, not account credits', async (t) => {
  const connection = credentialConnection('openrouter', 'openrouter-login', 'key')
  const fake = createContext({
    active: { openrouter: connection },
    list: [connection],
    credentials: { 'openrouter-login': { type: 'key', key: SECRET_SENTINEL } },
  })
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    return Response.json({ data: { limit: 20, limit_remaining: 12.5, usage: 7.5 } })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.deepEqual(calls, ['https://openrouter.ai/api/v1/key'])
  assert.equal(provider(result, 'openrouter').scope, 'selected_key')
  assert.deepEqual(provider(result, 'openrouter').metrics, [
    {
      kind: 'provider_quota',
      used: 7.5,
      remaining: 12.5,
      unit: 'USD',
      label: 'Selected key budget',
    },
  ])
})

test('OpenRouter with no selected-key limit reports spend, not fabricated remaining quota', async (t) => {
  const connection = credentialConnection('openrouter', 'openrouter-login', 'key')
  const fake = createContext({
    active: { openrouter: connection },
    list: [connection],
    credentials: { 'openrouter-login': { type: 'key', key: SECRET_SENTINEL } },
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    Response.json({ data: { limit: null, limit_remaining: null, usage: 2.75 } })
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.deepEqual(provider(result, 'openrouter').metrics, [
    {
      kind: 'key_usage',
      amount: 2.75,
      currency: 'USD',
      label: 'Selected key spend',
      period: 'reported',
    },
  ])
})

test('remote adapters deduplicate/cache status reads and cap simultaneous requests', async (t) => {
  const connections = [
    credentialConnection('deepseek', 'deepseek-login', 'key'),
    credentialConnection('ollama-cloud', 'ollama-login', 'key'),
    credentialConnection('openrouter', 'openrouter-login', 'key'),
    credentialConnection('chutes', 'chutes-login', 'key'),
  ]
  const active = Object.fromEntries(
    connections.map((connection) => [connection.integrationID, connection]),
  )
  const credentials = Object.fromEntries(
    connections.map((connection) => [connection.id, { type: 'key', key: SECRET_SENTINEL }]),
  )
  const fake = createContext({ active, list: connections, credentials })
  const originalFetch = globalThis.fetch
  let activeFetches = 0
  let maximumFetches = 0
  let calls = 0
  globalThis.fetch = async (url) => {
    calls += 1
    activeFetches += 1
    maximumFetches = Math.max(maximumFetches, activeFetches)
    await new Promise((resolve) => setImmediate(resolve))
    activeFetches -= 1
    const requestUrl = new URL(String(url))
    const hostname = requestUrl.hostname
    if (hostname === 'deepseek.com' || hostname.endsWith('.deepseek.com'))
      return Response.json({
        is_available: true,
        balance_infos: [{ currency: 'USD', total_balance: '1' }],
      })
    if (hostname === 'ollama.com' || hostname.endsWith('.ollama.com'))
      return Response.json({ included: { balance_usd: 1 }, purchased: {} })
    if (hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai'))
      return Response.json({ data: { limit: null, usage: 1 } })
    return Response.json({ quota: 2, used: 1 })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  await status(fake)
  assert.equal(maximumFetches <= 3, true)
  assert.equal(maximumFetches > 1, true)
  assert.equal(calls, 4)
  await status(fake)
  assert.equal(calls, 4)
})

test('Chutes AI adapter normalizes its upstream quota/used response', async (t) => {
  const connection = credentialConnection('chutes', 'chutes-login', 'key')
  const fake = createContext({
    active: { chutes: connection },
    list: [connection],
    credentials: { 'chutes-login': { type: 'key', key: SECRET_SENTINEL } },
  })
  const originalFetch = globalThis.fetch
  let captured
  globalThis.fetch = async (url, options) => {
    captured = { url, options }
    return Response.json({ quota: 100, used: 35 })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.equal(captured.url, 'https://api.chutes.ai/users/me/quota_usage/me')
  assert.equal(captured.options.headers.authorization, `Bearer ${SECRET_SENTINEL}`)
  assert.deepEqual(provider(result, 'chutes').metrics, [
    { kind: 'provider_quota', used: 35, remaining: 65, unit: 'units', label: 'Daily quota' },
  ])
})

test('NanoGPT keeps subscription windows and USD balance as separate metrics', async (t) => {
  const connection = credentialConnection('nanogpt', 'nanogpt-login', 'key')
  const fake = createContext({
    active: { nanogpt: connection },
    list: [connection],
    credentials: { 'nanogpt-login': { type: 'key', key: SECRET_SENTINEL } },
  })
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    if (url.endsWith('/usage')) {
      return Response.json({
        active: true,
        limits: { daily: 100, monthly: 1000 },
        daily: { used: 25, remaining: 75 },
        monthly: { used: 200, remaining: 800 },
      })
    }
    return Response.json({ usd_balance: '12.50', nano_balance: '999' })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.deepEqual(calls, [
    'https://nano-gpt.com/api/subscription/v1/usage',
    'https://nano-gpt.com/api/check-balance',
  ])
  assert.deepEqual(provider(result, 'nanogpt').metrics, [
    { kind: 'provider_status', status: 'active', label: 'Subscription status' },
    {
      kind: 'provider_quota',
      used: 25,
      remaining: 75,
      unit: 'units',
      label: 'Daily subscription limit',
      period: 'daily',
    },
    {
      kind: 'provider_quota',
      used: 200,
      remaining: 800,
      unit: 'units',
      label: 'Monthly subscription limit',
      period: 'monthly',
    },
    { kind: 'balance', amount: 12.5, currency: 'USD', label: 'Account balance' },
  ])
})

test('Synthetic projects rolling and weekly quotas without exposing remote labels or bodies', async (t) => {
  const connection = credentialConnection('synthetic', 'synthetic-login', 'key')
  const fake = createContext({
    active: { synthetic: connection },
    list: [connection],
    credentials: { 'synthetic-login': { type: 'key', key: SECRET_SENTINEL } },
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    assert.equal(url, 'https://api.synthetic.new/v2/quotas')
    return Response.json({
      rollingFiveHourLimit: { max: 100, remaining: 65, nextTickAt: '2026-10-25T00:00:00Z' },
      weeklyTokenLimit: { maxCredits: '$10.00', remainingCredits: '$3.25' },
      private: SECRET_SENTINEL,
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.deepEqual(provider(result, 'synthetic').metrics, [
    {
      kind: 'provider_quota',
      used: 35,
      remaining: 65,
      unit: 'units',
      label: 'Rolling five-hour limit',
    },
    {
      kind: 'provider_quota',
      used: 6.75,
      remaining: 3.25,
      unit: 'USD',
      label: 'Weekly credit limit',
    },
  ])
  assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
})

test('Kilo Gateway reports pass credit quota and uses balance only without a pass', async (t) => {
  const connection = credentialConnection('kilo-gateway', 'kilo-login', 'key')
  const fake = createContext({
    active: { 'kilo-gateway': connection },
    list: [connection],
    credentials: { 'kilo-login': { type: 'key', key: SECRET_SENTINEL } },
  })
  const originalFetch = globalThis.fetch
  const calls = []
  let noPass = false
  globalThis.fetch = async (url) => {
    calls.push(url)
    if (
      noPass &&
      url === 'https://app.kilo.ai/api/trpc/kiloPass.getState?batch=1&input=%7B%220%22%3Anull%7D'
    ) {
      return Response.json([{ result: { data: { json: { subscription: null } } } }])
    }
    if (url === 'https://api.kilo.ai/api/profile/balance') return Response.json({ balance: 3.5 })
    return Response.json([
      {
        result: {
          data: {
            json: {
              subscription: {
                currentPeriodBaseCreditsUsd: 10,
                currentPeriodUsageUsd: 4,
                currentPeriodBonusCreditsUsd: 2,
              },
            },
          },
        },
      },
    ])
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.deepEqual(calls, [
    'https://app.kilo.ai/api/trpc/kiloPass.getState?batch=1&input=%7B%220%22%3Anull%7D',
  ])
  assert.deepEqual(provider(result, 'kilo-gateway').metrics, [
    { kind: 'provider_quota', used: 4, remaining: 8, unit: 'USD', label: 'Kilo Pass credits' },
  ])

  noPass = true
  const balanceFake = createContext({
    active: { 'kilo-gateway': connection },
    list: [connection],
    credentials: { 'kilo-login': { type: 'key', key: SECRET_SENTINEL } },
  })
  const balanceCleanup = await setup(balanceFake)
  t.after(balanceCleanup)
  const balanceResult = await status(balanceFake)
  assert.deepEqual(calls.slice(-2), [
    'https://app.kilo.ai/api/trpc/kiloPass.getState?batch=1&input=%7B%220%22%3Anull%7D',
    'https://api.kilo.ai/api/profile/balance',
  ])
  assert.deepEqual(provider(balanceResult, 'kilo-gateway').metrics, [
    { kind: 'balance', amount: 3.5, currency: 'USD', label: 'Gateway balance' },
  ])
})

test('Kimi Code uses its fixed regional route and normalizes usage windows', async (t) => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    return Response.json({ data: { usage: { used: 2, limit: 10, name: 'ignored remote label' } } })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const cases = [
    ['kimi-code-global', 'https://api.kimi.ai/coding/v1/usages'],
    ['kimi-code-cn', 'https://api.kimi.com/coding/v1/usages'],
  ]
  for (const [id, expectedUrl] of cases) {
    await t.test(id, async (subtest) => {
      const connection = credentialConnection(id, `${id}-login`, 'key')
      const fake = createContext({
        active: { [id]: connection },
        list: [connection],
        credentials: { [connection.id]: { type: 'key', key: SECRET_SENTINEL } },
      })
      const cleanup = await setup(fake)
      subtest.after(cleanup)
      const result = await status(fake)
      assert.equal(calls.at(-1), expectedUrl)
      assert.deepEqual(provider(result, id).metrics, [
        {
          kind: 'provider_quota',
          used: 2,
          remaining: 8,
          unit: 'units',
          label: 'Provider-reported window',
        },
      ])
      assert.equal(JSON.stringify(result).includes('ignored remote label'), false)
    })
  }
})

test('MiniMax Token Plan uses distinct fixed global and CN routes and count semantics', async (t) => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    const isCn = url === 'https://api.minimaxi.com/v1/token_plan/remains'
    return Response.json({
      base_resp: { status_code: 0, status_msg: 'success' },
      model_remains: [
        {
          model_name: 'MiniMax-M*',
          current_interval_total_count: 100,
          current_interval_usage_count: isCn ? 30 : 60,
          remains_time: 3600,
          current_weekly_total_count: 500,
          current_weekly_usage_count: isCn ? 150 : 300,
          weekly_remains_time: 7200,
        },
      ],
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cases = [
    [
      'minimax-plan-global',
      'minimax-coding-plan',
      'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
      40,
      200,
    ],
    [
      'minimax-plan-cn',
      'minimax-china-coding-plan',
      'https://api.minimaxi.com/v1/token_plan/remains',
      30,
      150,
    ],
  ]
  for (const [id, integrationID, expectedUrl, fiveHourUsed, weeklyUsed] of cases) {
    await t.test(id, async (subtest) => {
      const connection = credentialConnection(integrationID, `${id}-login`, 'key')
      const fake = createContext({
        active: { [integrationID]: connection },
        list: [connection],
        credentials: { [connection.id]: { type: 'key', key: SECRET_SENTINEL } },
      })
      const cleanup = await setup(fake)
      subtest.after(cleanup)
      const result = await status(fake)
      assert.equal(calls.at(-1), expectedUrl)
      const metrics = provider(result, id).metrics
      assert.deepEqual(metrics, [
        {
          kind: 'provider_quota',
          used: fiveHourUsed,
          remaining: 100 - fiveHourUsed,
          unit: 'requests',
          label: '5-hour token-plan quota',
        },
        {
          kind: 'provider_quota',
          used: weeklyUsed,
          remaining: 500 - weeklyUsed,
          unit: 'requests',
          label: 'Weekly token-plan quota',
        },
      ])
    })
  }
})

test('Z.ai and Zhipu coding-plan adapters use fixed URLs and direct API-key auth', async (t) => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return Response.json({
      data: {
        limits: [
          {
            type: 'TOKENS_LIMIT',
            percentage: 25,
            unit: 3,
            nextResetTime: Date.parse('2026-11-01T12:30:00Z'),
          },
        ],
      },
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cases = [
    ['zai-coding-plan', 'https://api.z.ai/api/monitor/usage/quota/limit'],
    ['zhipu-coding-plan', 'https://bigmodel.cn/api/monitor/usage/quota/limit'],
  ]
  for (const [id, expectedUrl] of cases) {
    await t.test(id, async (subtest) => {
      const connection = credentialConnection(id, `${id}-login`, 'key')
      const fake = createContext({
        active: { [id]: connection },
        list: [connection],
        credentials: { [connection.id]: { type: 'key', key: SECRET_SENTINEL } },
      })
      const cleanup = await setup(fake)
      subtest.after(cleanup)
      const result = await status(fake)
      const call = calls.at(-1)
      assert.equal(call.url, expectedUrl)
      assert.equal(call.options.headers.authorization, SECRET_SENTINEL)
      assert.deepEqual(provider(result, id).metrics, [
        {
          kind: 'provider_quota',
          used: 25,
          remaining: 75,
          unit: '%',
          label: '5-hour coding-plan quota',
          resetsAt: Date.parse('2026-11-01T12:30:00Z'),
        },
      ])
    })
  }
})

test('provider metric contract covers adapter maxima and rejects oversized output', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const cases = [
    {
      id: 'kimi-code-global',
      valid: {
        data: {
          usage: { limit: 100, used: 1 },
          limits: Array.from({ length: 12 }, (_, index) => ({ limit: 100, used: index + 2 })),
        },
      },
      invalid: {
        data: {
          usage: { limit: 100, used: 1 },
          limits: Array.from({ length: 13 }, (_, index) => ({ limit: 100, used: index + 2 })),
        },
      },
      maxMetrics: 13,
    },
    ...['zai-coding-plan', 'zhipu-coding-plan'].map((id) => ({
      id,
      valid: {
        data: {
          limits: Array.from({ length: 16 }, (_, index) => ({
            type: 'TOKENS_LIMIT',
            percentage: index,
            unit: 3,
          })),
        },
      },
      invalid: {
        data: {
          limits: Array.from({ length: 17 }, (_, index) => ({
            type: 'TOKENS_LIMIT',
            percentage: index,
            unit: 3,
          })),
        },
      },
      maxMetrics: 16,
    })),
  ]

  for (const scenario of cases) {
    await t.test(scenario.id, async (subtest) => {
      const connection = credentialConnection(scenario.id, `${scenario.id}-login`, 'key')
      const fake = createContext({
        active: { [scenario.id]: connection },
        list: [connection],
        credentials: { [connection.id]: { type: 'key', key: SECRET_SENTINEL } },
      })
      let payload = scenario.valid
      globalThis.fetch = async () => Response.json(payload)
      const cleanup = await setup(fake)
      subtest.after(cleanup)

      const result = await status(fake)
      const actual = provider(result, scenario.id)
      assert.equal(actual.state, 'available')
      assert.equal(actual.metrics.length, scenario.maxMetrics)

      if (scenario.maxMetrics === 16) {
        const validate = new Ajv().compile(fake.definition.methods.status.output)
        const boundary = {
          ...result,
          providers: result.providers.map((item) =>
            item.provider === scenario.id
              ? { ...item, metrics: Array.from({ length: 16 }, () => actual.metrics[0]) }
              : item,
          ),
        }
        assert.equal(validate(boundary), true)
        const overLimit = {
          ...boundary,
          providers: boundary.providers.map((item) =>
            item.provider === scenario.id
              ? { ...item, metrics: [...item.metrics, actual.metrics[0]] }
              : item,
          ),
        }
        assert.equal(validate(overLimit), false)
      }

      payload = scenario.invalid
      fake.eventSource.emit({ type: 'integration.updated', data: {} })
      await flush()
      const malformed = await status(fake)
      assert.equal(provider(malformed, scenario.id).state, 'unavailable')
      assert.equal(provider(malformed, scenario.id).reason, 'provider_error')
      assert.deepEqual(provider(malformed, scenario.id).metrics, [])
    })
  }
})

test('OpenAI never requests ChatGPT quota for generic OAuth, token-sharing, or API-key credentials', async (t) => {
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('must not call provider')
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const cases = [
    { name: 'generic OAuth', method: 'oauth', methodID: 'unknown-openai-oauth' },
    { name: 'token sharing', method: 'oauth', methodID: 'chatgpt-token-sharing' },
    { name: 'API key', method: 'key' },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const connection = credentialConnection('openai', `openai-${scenario.name}`, scenario.method)
      const fake = createContext({
        active: { openai: connection },
        list: [connection],
        credentials: {
          [connection.id]:
            scenario.method === 'oauth'
              ? {
                  type: 'oauth',
                  methodID: scenario.methodID,
                  access: SECRET_SENTINEL,
                }
              : { type: 'key', key: SECRET_SENTINEL },
        },
      })
      const cleanup = await setup(fake)
      subtest.after(cleanup)
      const result = await status(fake)
      if (scenario.method === 'oauth') {
        assert.equal(provider(result, 'openai').authentication, 'connected')
        assert.equal(provider(result, 'openai').state, 'unavailable')
        assert.equal(provider(result, 'openai').reason, 'eligibility_unverified')
      } else {
        assert.equal(provider(result, 'openai'), undefined)
      }
      assert.deepEqual(fake.resolveCalls, scenario.method === 'oauth' ? [connection.id] : [])
      assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
    })
  }
  assert.equal(fetchCalls, 0)
})

test('OpenAI requests ChatGPT quota only for source-verified Codex OAuth methods', async (t) => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return Response.json({
      rate_limit: {
        primary_window: {
          used_percent: 20,
          limit_window_seconds: 18_000,
          reset_at: 1_798_827_000,
        },
        secondary_window: {
          used_percent: 62,
          limit_window_seconds: 604_800,
          reset_at: 1_799_172_300,
        },
      },
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  for (const methodID of ['chatgpt-browser', 'chatgpt-headless']) {
    await t.test(methodID, async (subtest) => {
      const connection = credentialConnection('openai', `openai-${methodID}`, 'oauth')
      const fake = createContext({
        active: { openai: connection },
        list: [connection],
        credentials: {
          [connection.id]: { type: 'oauth', methodID, access: SECRET_SENTINEL },
        },
      })
      const cleanup = await setup(fake)
      subtest.after(cleanup)

      const result = await status(fake)
      const call = calls.at(-1)
      assert.equal(call.url, 'https://chatgpt.com/backend-api/wham/usage')
      assert.equal(call.options.method, 'GET')
      assert.equal(call.options.headers.authorization, `Bearer ${SECRET_SENTINEL}`)
      assert.equal(call.options.headers['x-opencode-session'], undefined)
      assert.equal(call.options.headers['user-agent'], 'OpenCode-Quota-Toast/1.0')
      assert.deepEqual(provider(result, 'openai').metrics, [
        {
          kind: 'provider_quota',
          used: 20,
          remaining: 80,
          unit: '%',
          label: '5-hour ChatGPT quota',
          period: '5h',
          resetsAt: 1_798_827_000_000,
        },
        {
          kind: 'provider_quota',
          used: 62,
          remaining: 38,
          unit: '%',
          label: 'Weekly ChatGPT quota',
          period: 'week',
          resetsAt: 1_799_172_300_000,
        },
      ])
      assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
    })
  }
  assert.equal(calls.length, 2)
})

test('OpenCode Go accepts the legacy integration alias and trims the selected key', async (t) => {
  const connection = credentialConnection('opencode', 'legacy-go-login', 'key')
  const fake = createContext({
    active: { opencode: connection },
    list: [connection],
    credentials: { 'legacy-go-login': { type: 'key', key: '  go-api-key  \n' } },
  })
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return Response.json({
      usage: Object.fromEntries(
        ['rolling', 'weekly', 'monthly'].map((window) => [
          window,
          { status: 'ok', percent: 25, resetsAt: '2026-10-26T00:00:00Z' },
        ]),
      ),
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://opencode.ai/zen/go/v1/usage')
  assert.equal(calls[0].options.method, 'GET')
  assert.equal(calls[0].options.headers.accept, 'application/json')
  assert.equal(calls[0].options.headers.authorization, 'Bearer go-api-key')
  assert.equal(calls[0].options.headers['x-opencode-session'], 'pantheon-quota')
  assert.equal(calls[0].options.headers['user-agent'], 'Pantheon-Quota/1.0')
  assert.notEqual(calls[0].options.headers['x-opencode-session'], connection.id)
  assert.equal(provider(result, 'opencode-go').state, 'available')
  assert.deepEqual(
    provider(result, 'opencode-go').metrics.map((metric) => metric.resetsAt),
    Array(3).fill(Date.parse('2026-10-26T00:00:00Z')),
  )
  const validate = new Ajv().compile(fake.definition.methods.status.output)
  const replaceFirstGoMetric = (transform) => ({
    ...result,
    providers: result.providers.map((item) =>
      item.provider === 'opencode-go'
        ? {
            ...item,
            metrics: item.metrics.map((metric, index) =>
              index === 0 ? transform(metric) : metric,
            ),
          }
        : item,
    ),
  })
  assert.equal(validate(replaceFirstGoMetric(({ resetsAt: _resetsAt, ...metric }) => metric)), true)
  for (const invalidReset of [Infinity, NaN, '2026-10-26T00:00:00Z']) {
    assert.equal(
      validate(replaceFirstGoMetric((metric) => ({ ...metric, resetsAt: invalidReset }))),
      false,
    )
  }
  assert.deepEqual(fake.resolveCalls, ['legacy-go-login'])
})

test('OpenCode Go uses OPENCODE_API_KEY before provider settings and saved credentials', async (t) => {
  const previousEnvironmentKey = process.env.OPENCODE_API_KEY
  process.env.OPENCODE_API_KEY = 'environment-go-key'
  t.after(() => {
    if (previousEnvironmentKey === undefined) delete process.env.OPENCODE_API_KEY
    else process.env.OPENCODE_API_KEY = previousEnvironmentKey
  })
  const connection = credentialConnection('opencode-go', 'saved-go-key', 'key')
  const fake = createContext({
    active: { 'opencode-go': connection },
    list: [connection],
    credentials: { 'saved-go-key': { type: 'key', key: 'saved-api-key' } },
    providerSettings: { 'opencode-go': 'provider-settings-key' },
  })
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return Response.json({
      usage: Object.fromEntries(
        ['rolling', 'weekly', 'monthly'].map((window) => [window, { status: 'ok', percent: 10 }]),
      ),
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.equal(provider(result, 'opencode-go').state, 'available')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'https://opencode.ai/zen/go/v1/usage')
  assert.equal(calls[0].options.headers.authorization, 'Bearer environment-go-key')
  assert.deepEqual(fake.resolveCalls, [])
})

test('OpenCode Go uses effective provider settings before saved credentials without requiring a login', async (t) => {
  const previousEnvironmentKey = process.env.OPENCODE_API_KEY
  delete process.env.OPENCODE_API_KEY
  t.after(() => {
    if (previousEnvironmentKey === undefined) delete process.env.OPENCODE_API_KEY
    else process.env.OPENCODE_API_KEY = previousEnvironmentKey
  })
  const fake = createContext({ providerSettings: { 'opencode-go': 'provider-settings-key' } })
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return Response.json({
      usage: Object.fromEntries(
        ['rolling', 'weekly', 'monthly'].map((window) => [window, { status: 'ok', percent: 10 }]),
      ),
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.equal(provider(result, 'opencode-go').state, 'available')
  assert.equal(request.url, 'https://opencode.ai/zen/go/v1/usage')
  assert.equal(request.options.headers.authorization, 'Bearer provider-settings-key')
  assert.deepEqual(fake.activeCalls, [])
  assert.deepEqual(fake.resolveCalls, [])
})

test('OpenCode Go uses the legacy opencode provider setting when its Go provider setting is absent', async (t) => {
  const previousEnvironmentKey = process.env.OPENCODE_API_KEY
  delete process.env.OPENCODE_API_KEY
  t.after(() => {
    if (previousEnvironmentKey === undefined) delete process.env.OPENCODE_API_KEY
    else process.env.OPENCODE_API_KEY = previousEnvironmentKey
  })
  const fake = createContext({ providerSettings: { opencode: 'legacy-provider-key' } })
  const originalFetch = globalThis.fetch
  let request
  globalThis.fetch = async (url, options) => {
    request = { url, options }
    return Response.json({
      usage: Object.fromEntries(
        ['rolling', 'weekly', 'monthly'].map((window) => [window, { status: 'ok', percent: 10 }]),
      ),
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.equal(provider(result, 'opencode-go').state, 'available')
  assert.equal(request.options.headers.authorization, 'Bearer legacy-provider-key')
  assert.deepEqual(fake.activeCalls, [])
  assert.deepEqual(fake.resolveCalls, [])
})

test('OpenCode Go uses configured provider key only after Console failure', async (t) => {
  const previousEnvironmentKey = process.env.OPENCODE_API_KEY
  delete process.env.OPENCODE_API_KEY
  t.after(() => {
    if (previousEnvironmentKey === undefined) delete process.env.OPENCODE_API_KEY
    else process.env.OPENCODE_API_KEY = previousEnvironmentKey
  })
  const consoleConnection = credentialConnection('opencode', 'console-login', 'oauth')
  const fake = createContext({
    active: { opencode: consoleConnection },
    list: [consoleConnection],
    credentials: {
      'console-login': {
        type: 'oauth',
        methodID: 'device',
        access: 'console-oauth-token',
        metadata: { server: 'https://opencode.ai/console' },
      },
    },
    providerSettings: { 'opencode-go': 'configured-go-api-key' },
  })
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    if (url === 'https://opencode.ai/console/api/go/status') {
      return new Response('', { status: 503 })
    }
    return Response.json({
      usage: Object.fromEntries(
        ['rolling', 'weekly', 'monthly'].map((window) => [window, { status: 'ok', percent: 10 }]),
      ),
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.equal(provider(result, 'opencode-go').route_kind, 'api_key')
  const goCalls = calls.filter(({ url }) =>
    ['https://opencode.ai/console/api/go/status', 'https://opencode.ai/zen/go/v1/usage'].includes(
      url,
    ),
  )
  assert.deepEqual(
    goCalls.map(({ url }) => url),
    ['https://opencode.ai/console/api/go/status', 'https://opencode.ai/zen/go/v1/usage'],
  )
  assert.equal(goCalls[0].options.headers.authorization, 'Bearer console-oauth-token')
  assert.equal(goCalls[1].options.headers.authorization, 'Bearer configured-go-api-key')
  assert.ok(fake.resolveCalls.length > 0)
  assert.ok(fake.resolveCalls.every((id) => id === 'console-login'))
})

test('OpenCode Go Console OAuth uses only the fixed Console status route and validated meters', async (t) => {
  const connection = credentialConnection('opencode', 'console-go-login', 'oauth')
  const apiKeyConnection = credentialConnection('opencode-go', 'go-api-key', 'key')
  const fake = createContext({
    active: { opencode: connection, 'opencode-go': apiKeyConnection },
    list: [connection, apiKeyConnection],
    credentials: {
      'console-go-login': {
        type: 'oauth',
        methodID: 'device',
        access: SECRET_SENTINEL,
        metadata: { orgID: 'org_go_123', server: 'https://opencode.ai/console' },
      },
      'go-api-key': { type: 'key', key: 'API_KEY_SENTINEL' },
    },
  })
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return Response.json({
      access: {
        endsAt: '2028-02-29T00:00:00-05:30',
        meters: {
          fiveHour: { limitMicroCents: '100000000', usedMicroCents: '12500000' },
          week: {
            limitMicroCents: 200000000,
            usedMicroCents: 50000000,
            resetsAt: '2028-02-29T00:00:00+05:30',
          },
          month: { limitMicroCents: 100000000, usedMicroCents: 150000000 },
        },
      },
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.equal(fake.resolveCalls.includes('console-go-login'), true)
  assert.equal(fake.resolveCalls.includes('go-api-key'), true)
  assert.equal(provider(result, 'opencode-go').route_kind, 'console_oauth')
  const goCalls = calls.filter(({ url }) => url === 'https://opencode.ai/console/api/go/status')
  assert.equal(goCalls.length, 1)
  assert.equal(
    calls.some(({ url }) => url === 'https://opencode.ai/zen/go/v1/usage'),
    false,
  )
  assert.equal(goCalls[0].options.method, 'GET')
  assert.equal(goCalls[0].options.redirect, 'error')
  assert.equal(goCalls[0].options.headers.authorization, `Bearer ${SECRET_SENTINEL}`)
  assert.equal(goCalls[0].options.headers.accept, 'application/json')
  assert.equal(goCalls[0].options.headers['x-opencode-session'], undefined)
  assert.equal(goCalls[0].options.headers['user-agent'], undefined)
  assert.equal(goCalls[0].options.headers['x-org-id'], 'org_go_123')
  assert.deepEqual(provider(result, 'opencode-go').metrics, [
    {
      kind: 'provider_quota',
      used: 13,
      remaining: 87,
      unit: '%',
      label: '5-hour quota',
      period: 'rolling',
    },
    {
      kind: 'provider_quota',
      used: 25,
      remaining: 75,
      unit: '%',
      label: 'Weekly quota',
      period: 'weekly',
      resetsAt: Date.parse('2028-02-29T00:00:00+05:30'),
    },
    {
      kind: 'provider_quota',
      used: 100,
      remaining: 0,
      unit: '%',
      label: 'Monthly quota',
      period: 'monthly',
      resetsAt: Date.parse('2028-02-29T00:00:00-05:30'),
    },
  ])
  assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
  assert.equal(JSON.stringify(result).includes('API_KEY_SENTINEL'), false)
  assert.equal(JSON.stringify(result).includes('org_go_123'), false)
})

test('OpenCode Go falls back from a failed Console OAuth request to its selected API key', async (t) => {
  const consoleConnection = credentialConnection('opencode', 'console-go-login', 'oauth')
  const apiKeyConnection = credentialConnection('opencode-go', 'go-api-key', 'key')
  const fake = createContext({
    active: { opencode: consoleConnection, 'opencode-go': apiKeyConnection },
    list: [consoleConnection, apiKeyConnection],
    credentials: {
      'console-go-login': {
        type: 'oauth',
        methodID: 'device',
        access: 'CONSOLE_ACCESS_SENTINEL',
        metadata: { orgID: 'org_go_123', server: 'https://opencode.ai/console' },
      },
      'go-api-key': { type: 'key', key: 'GO_API_KEY_SENTINEL' },
    },
  })
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    if (url === 'https://opencode.ai/console/api/go/status') {
      return new Response(null, { status: 403 })
    }
    return Response.json({
      usage: Object.fromEntries(
        ['rolling', 'weekly', 'monthly'].map((window) => [window, { status: 'ok', percent: 25 }]),
      ),
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  const goCalls = calls.filter(({ url }) =>
    ['https://opencode.ai/console/api/go/status', 'https://opencode.ai/zen/go/v1/usage'].includes(
      url,
    ),
  )
  assert.deepEqual(
    goCalls.map(({ url }) => url),
    ['https://opencode.ai/console/api/go/status', 'https://opencode.ai/zen/go/v1/usage'],
  )
  assert.equal(goCalls[0].options.headers.authorization, 'Bearer CONSOLE_ACCESS_SENTINEL')
  assert.equal(goCalls[1].options.headers.authorization, 'Bearer GO_API_KEY_SENTINEL')
  assert.equal(provider(result, 'opencode-go').state, 'available')
  assert.equal(provider(result, 'opencode-go').route_kind, 'api_key')
  assert.equal(JSON.stringify(result).includes('SENTINEL'), false)
})

test('OpenCode Go does not use the API-key fallback when Console reports no Go subscription', async (t) => {
  const consoleConnection = credentialConnection('opencode', 'console-go-login', 'oauth')
  const apiKeyConnection = credentialConnection('opencode-go', 'go-api-key', 'key')
  const fake = createContext({
    active: { opencode: consoleConnection, 'opencode-go': apiKeyConnection },
    list: [consoleConnection, apiKeyConnection],
    credentials: {
      'console-go-login': {
        type: 'oauth',
        methodID: 'device',
        access: 'CONSOLE_ACCESS_SENTINEL',
        metadata: { orgID: 'org_go_123', server: 'https://opencode.ai/console' },
      },
      'go-api-key': { type: 'key', key: 'GO_API_KEY_SENTINEL' },
    },
  })
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return new Response(null, { status: 404 })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  const goCalls = calls.filter(({ url }) =>
    ['https://opencode.ai/console/api/go/status', 'https://opencode.ai/zen/go/v1/usage'].includes(
      url,
    ),
  )
  assert.deepEqual(
    goCalls.map(({ url }) => url),
    ['https://opencode.ai/console/api/go/status'],
  )
  assert.equal(provider(result, 'opencode-go').state, 'unavailable')
  assert.equal(provider(result, 'opencode-go').route_kind, 'console_oauth')
  assert.equal(provider(result, 'opencode-go').reason, 'not_subscribed')
})

test('OpenCode Go does not use the API-key fallback when Console returns no access object', async (t) => {
  const consoleConnection = credentialConnection('opencode', 'console-no-go-access', 'oauth')
  const apiKeyConnection = credentialConnection(
    'opencode-go',
    'go-key-without-console-access',
    'key',
  )
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  for (const [name, payload] of [
    ['null access', { access: null }],
    ['missing access', {}],
  ]) {
    await t.test(name, async (subtest) => {
      const fake = createContext({
        active: { opencode: consoleConnection, 'opencode-go': apiKeyConnection },
        list: [consoleConnection, apiKeyConnection],
        credentials: {
          'console-no-go-access': {
            type: 'oauth',
            methodID: 'device',
            access: 'CONSOLE_ACCESS_SENTINEL',
            metadata: { orgID: 'org_go_123', server: 'https://opencode.ai/console' },
          },
          'go-key-without-console-access': { type: 'key', key: 'GO_API_KEY_SENTINEL' },
        },
      })
      const calls = []
      globalThis.fetch = async (url) => {
        calls.push(url)
        if (url === 'https://opencode.ai/console/api/go/status') return Response.json(payload)
        throw new Error('API-key fallback must not run')
      }
      const cleanup = await setup(fake)
      subtest.after(cleanup)

      const result = await status(fake)
      assert.deepEqual(
        calls.filter((url) =>
          [
            'https://opencode.ai/console/api/go/status',
            'https://opencode.ai/zen/go/v1/usage',
          ].includes(url),
        ),
        ['https://opencode.ai/console/api/go/status'],
      )
      assert.equal(provider(result, 'opencode-go').state, 'unavailable')
      assert.equal(provider(result, 'opencode-go').reason, 'not_subscribed')
      assert.equal(provider(result, 'opencode-go').route_kind, 'console_oauth')
      assert.equal(JSON.stringify(result).includes('SENTINEL'), false)
    })
  }
})

test('OpenCode Go falls back to its API key when Console returns a malformed access value', async (t) => {
  const consoleConnection = credentialConnection('opencode', 'console-malformed-go-access', 'oauth')
  const apiKeyConnection = credentialConnection('opencode-go', 'go-key-malformed-access', 'key')
  const fake = createContext({
    active: { opencode: consoleConnection, 'opencode-go': apiKeyConnection },
    list: [consoleConnection, apiKeyConnection],
    credentials: {
      'console-malformed-go-access': {
        type: 'oauth',
        methodID: 'device',
        access: 'CONSOLE_ACCESS_SENTINEL',
        metadata: { orgID: 'org_go_123', server: 'https://opencode.ai/console' },
      },
      'go-key-malformed-access': { type: 'key', key: 'GO_API_KEY_SENTINEL' },
    },
  })
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    if (url === 'https://opencode.ai/console/api/go/status') {
      return Response.json({ access: 'malformed' })
    }
    return Response.json({
      usage: Object.fromEntries(
        ['rolling', 'weekly', 'monthly'].map((window) => [window, { status: 'ok', percent: 25 }]),
      ),
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  const goCalls = calls.filter(({ url }) =>
    ['https://opencode.ai/console/api/go/status', 'https://opencode.ai/zen/go/v1/usage'].includes(
      url,
    ),
  )
  assert.deepEqual(
    goCalls.map(({ url }) => url),
    ['https://opencode.ai/console/api/go/status', 'https://opencode.ai/zen/go/v1/usage'],
  )
  assert.equal(goCalls[0].options.headers.authorization, 'Bearer CONSOLE_ACCESS_SENTINEL')
  assert.equal(goCalls[1].options.headers.authorization, 'Bearer GO_API_KEY_SENTINEL')
  assert.equal(provider(result, 'opencode-go').state, 'available')
  assert.equal(provider(result, 'opencode-go').route_kind, 'api_key')
  assert.equal(JSON.stringify(result).includes('SENTINEL'), false)
})

test('OpenCode Go preserves Console quota when selected API-key lookup fails', async (t) => {
  const consoleConnection = credentialConnection('opencode', 'console-key-lookup-failure', 'oauth')
  const apiKeyConnection = credentialConnection('opencode-go', 'go-key-lookup-failure', 'key')
  const fake = createContext({
    active: { opencode: consoleConnection, 'opencode-go': apiKeyConnection },
    list: [consoleConnection, apiKeyConnection],
    failActive: 'opencode-go',
    credentials: {
      'console-key-lookup-failure': {
        type: 'oauth',
        methodID: 'device',
        access: 'CONSOLE_ACCESS_SENTINEL',
        metadata: { orgID: 'org_go_123', server: 'https://opencode.ai/console' },
      },
    },
  })
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url) => {
    calls.push(url)
    return Response.json({
      access: {
        meters: {
          fiveHour: { limitMicroCents: 100, usedMicroCents: 20 },
          week: { limitMicroCents: 100, usedMicroCents: 30 },
          month: { limitMicroCents: 100, usedMicroCents: 40 },
        },
      },
    })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.deepEqual(
    calls.filter((url) =>
      ['https://opencode.ai/console/api/go/status', 'https://opencode.ai/zen/go/v1/usage'].includes(
        url,
      ),
    ),
    ['https://opencode.ai/console/api/go/status'],
  )
  assert.equal(provider(result, 'opencode-go').state, 'available')
  assert.equal(provider(result, 'opencode-go').route_kind, 'console_oauth')
  assert.equal(provider(result, 'opencode-go').metrics[0].used, 20)
})

test('OpenCode Go API-key 401 identifies only the selected key route and never falls back', async (t) => {
  const primary = credentialConnection('opencode-go', 'primary-go-key', 'key')
  const fake = createContext({
    active: { 'opencode-go': primary },
    list: [primary],
    credentials: {
      'primary-go-key': { type: 'key', key: SECRET_SENTINEL },
    },
  })
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return new Response(SECRET_SENTINEL, { status: 401 })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  const go = provider(result, 'opencode-go')
  const goCalls = calls.filter(({ url }) =>
    ['https://opencode.ai/zen/go/v1/usage', 'https://opencode.ai/console/api/go/status'].includes(
      url,
    ),
  )
  assert.deepEqual(
    goCalls.map(({ url }) => url),
    ['https://opencode.ai/zen/go/v1/usage'],
  )
  assert.equal(goCalls[0].options.headers.authorization, `Bearer ${SECRET_SENTINEL}`)
  assert.equal(goCalls[0].options.headers['x-opencode-session'], 'pantheon-quota')
  assert.equal(goCalls[0].options.headers['user-agent'], 'Pantheon-Quota/1.0')
  assert.notEqual(goCalls[0].options.headers['x-opencode-session'], primary.id)
  assert.equal(go.route_kind, 'api_key')
  assert.equal(go.reason, 'unauthorized')
  assert.equal(JSON.stringify(result).includes('401'), false)
  assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
  assert.equal(fake.resolveCalls.includes('primary-go-key'), true)
  const validate = new Ajv().compile(fake.definition.methods.status.output)
  const invalidRoute = {
    ...result,
    providers: result.providers.map((item) =>
      item.provider === 'opencode-go' ? { ...item, route_kind: 'https://custom.example' } : item,
    ),
  }
  assert.equal(validate(invalidRoute), false)
})

test('OpenCode Go Console OAuth server metadata is fail-closed and only normalized official defaults are allowed', async (t) => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return new Response(null, { status: 401 })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const allowedServers = [
    ['server absent', undefined],
    ['official default', 'https://opencode.ai/console'],
    ['official default with trailing slash', 'https://opencode.ai/console/'],
    ['retired official alias', 'https://console.opencode.ai'],
  ]
  for (const [name, server] of allowedServers) {
    await t.test(name, async (subtest) => {
      calls.length = 0
      const connection = credentialConnection('opencode', `console-${name}`, 'oauth')
      const metadata = server === undefined ? {} : { server }
      const fake = createContext({
        active: { opencode: connection },
        list: [connection],
        credentials: {
          [connection.id]: {
            type: 'oauth',
            methodID: 'device',
            access: SECRET_SENTINEL,
            metadata,
          },
        },
      })
      const cleanup = await setup(fake)
      subtest.after(cleanup)

      const result = await status(fake)
      assert.deepEqual(
        calls
          .map(({ url }) => url)
          .filter((url) => url === 'https://opencode.ai/console/api/go/status'),
        ['https://opencode.ai/console/api/go/status'],
      )
      assert.equal(provider(result, 'opencode-go').route_kind, 'console_oauth')
      assert.equal(provider(result, 'opencode-go').reason, 'unauthorized')
      assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
    })
  }

  const rejectedServers = [
    'https://custom.example/console',
    'http://opencode.ai/console',
    'https://opencode.ai/other',
    'https://user:pass@opencode.ai/console',
    'not a URL',
    null,
    42,
  ]
  for (const server of rejectedServers) {
    await t.test('rejects configured server without disclosing it', async (subtest) => {
      calls.length = 0
      const connection = credentialConnection('opencode', 'custom-console-login', 'oauth')
      const fake = createContext({
        active: { opencode: connection },
        list: [connection],
        credentials: {
          [connection.id]: {
            type: 'oauth',
            methodID: 'device',
            access: SECRET_SENTINEL,
            metadata: { server, orgID: 'org_private_123' },
          },
        },
      })
      const cleanup = await setup(fake)
      subtest.after(cleanup)

      const result = await status(fake)
      const go = provider(result, 'opencode-go')
      assert.deepEqual(calls, [])
      assert.equal(go.route_kind, 'unsupported')
      assert.equal(go.reason, 'unsupported_credential_method')
      assert.equal(JSON.stringify(result).includes(server), false)
      assert.equal(JSON.stringify(result).includes('org_private_123'), false)
      assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
    })
  }
})

test('OpenCode Zen rejects custom or malformed Console server metadata without requesting billing', async (t) => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options })
    return Response.json({})
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const rejectedServers = [
    'https://custom.example/console',
    'http://opencode.ai/console',
    'https://opencode.ai/other',
    'https://user:pass@opencode.ai/console',
    'not a URL',
    null,
    42,
  ]
  for (const server of rejectedServers) {
    await t.test('rejects configured server without disclosure', async (subtest) => {
      calls.length = 0
      const connection = credentialConnection('opencode', 'custom-console-zen-login', 'oauth')
      const fake = createContext({
        active: { opencode: connection },
        list: [connection],
        credentials: {
          [connection.id]: {
            type: 'oauth',
            methodID: 'device',
            access: SECRET_SENTINEL,
            metadata: { server, orgID: 'org_zen_private_123' },
          },
        },
      })
      const cleanup = await setup(fake)
      subtest.after(cleanup)

      const result = await status(fake)
      const zen = provider(result, 'opencode-zen')
      assert.deepEqual(calls, [])
      assert.equal(zen.authentication, 'connected')
      assert.equal(zen.state, 'unavailable')
      assert.equal(zen.reason, 'unsupported_credential_method')
      assert.deepEqual(zen.metrics, [])
      assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
      assert.equal(JSON.stringify(result).includes('org_zen_private_123'), false)
      if (typeof server === 'string') {
        assert.equal(JSON.stringify(result).includes(server), false)
      }
    })
  }
})

test('OpenCode Go OAuth uses only an active listed Console device login', async (t) => {
  const originalFetch = globalThis.fetch
  let goCalls = []
  globalThis.fetch = async (url) => {
    if (url === 'https://opencode.ai/console/api/go/status') goCalls.push(url)
    throw new Error('must not call provider')
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const cases = [
    {
      name: 'generic OAuth',
      connection: credentialConnection('opencode', 'go-generic-oauth', 'oauth'),
      credential: { type: 'oauth', methodID: 'unknown-method', access: SECRET_SENTINEL },
      resolve: true,
    },
    {
      name: 'token-sharing OAuth',
      connection: credentialConnection('opencode', 'go-token-sharing', 'oauth'),
      credential: { type: 'oauth', methodID: 'chatgpt-token-sharing', access: SECRET_SENTINEL },
      resolve: true,
    },
    {
      name: 'missing OAuth method ID',
      connection: credentialConnection('opencode', 'go-no-method-id', 'oauth'),
      credential: { type: 'oauth', access: SECRET_SENTINEL },
      resolve: true,
    },
    {
      name: 'blank OAuth access token',
      connection: credentialConnection('opencode', 'go-blank-access', 'oauth'),
      credential: { type: 'oauth', methodID: 'device', access: '  \n ' },
      resolve: true,
    },
    {
      name: 'API key resolved for an OAuth connection',
      connection: credentialConnection('opencode', 'go-key-on-oauth', 'oauth'),
      credential: { type: 'key', key: SECRET_SENTINEL },
      resolve: true,
    },
    {
      name: 'malformed organization metadata',
      connection: credentialConnection('opencode', 'go-invalid-org', 'oauth'),
      credential: {
        type: 'oauth',
        methodID: 'device',
        access: SECRET_SENTINEL,
        metadata: { orgID: 'org/with/path' },
      },
      resolve: true,
    },
    {
      name: 'inactive listed Console connection',
      connection: credentialConnection('opencode', 'go-inactive-oauth', 'oauth'),
      credential: { type: 'oauth', methodID: 'device', access: SECRET_SENTINEL },
      active: undefined,
      resolve: false,
    },
    {
      name: 'needs-auth Go API key does not block Console OAuth',
      connection: credentialConnection('opencode', 'go-needs-auth-oauth', 'oauth'),
      primary: {
        ...credentialConnection('opencode-go', 'go-primary-needs-auth', 'key'),
        status: { status: 'needs_auth' },
      },
      credential: { type: 'oauth', methodID: 'device', access: SECRET_SENTINEL },
      resolve: true,
      expectedGoCalls: ['https://opencode.ai/console/api/go/status'],
    },
  ]

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      goCalls = []
      const active =
        scenario.active === undefined && 'active' in scenario
          ? {}
          : { opencode: scenario.connection }
      if (scenario.primary) active['opencode-go'] = scenario.primary
      const list = [scenario.connection, ...(scenario.primary ? [scenario.primary] : [])]
      const fake = createContext({
        active,
        list,
        credentials: { [scenario.connection.id]: scenario.credential },
      })
      const cleanup = await setup(fake)
      subtest.after(cleanup)

      const result = await status(fake)
      assert.deepEqual(goCalls, scenario.expectedGoCalls ?? [])
      assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
      assert.equal(fake.resolveCalls.includes(scenario.connection.id), scenario.resolve)
    })
  }
})

test('OpenCode Go Console OAuth maps auth, rate-limit, and malformed responses to closed failures', async (t) => {
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const cases = [
    {
      name: 'unauthorized',
      response: new Response(SECRET_SENTINEL, { status: 401 }),
      reason: 'unauthorized',
    },
    { name: 'forbidden', response: new Response(null, { status: 403 }), reason: 'forbidden' },
    {
      name: 'rate limited',
      response: new Response(null, { status: 429, headers: { 'retry-after': '45' } }),
      reason: 'rate_limited',
      retryAfter: 45_000,
    },
    {
      name: 'malformed meters',
      response: Response.json({ access: { meters: { fiveHour: {} } } }),
      reason: 'invalid_response',
    },
  ]
  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const connection = credentialConnection('opencode', `console-go-${scenario.name}`, 'oauth')
      const fake = createContext({
        active: { opencode: connection },
        list: [connection],
        credentials: {
          [connection.id]: { type: 'oauth', methodID: 'device', access: SECRET_SENTINEL },
        },
      })
      const calls = []
      globalThis.fetch = async (url) => {
        if (
          url === 'https://opencode.ai/console/api/go/status' ||
          url === 'https://opencode.ai/zen/go/v1/usage'
        ) {
          calls.push(url)
        }
        return scenario.response
      }
      const cleanup = await setup(fake)
      subtest.after(cleanup)

      const result = await status(fake)
      assert.deepEqual(calls, ['https://opencode.ai/console/api/go/status'])
      assert.equal(provider(result, 'opencode-go').route_kind, 'console_oauth')
      assert.equal(provider(result, 'opencode-go').reason, scenario.reason)
      assert.equal(provider(result, 'opencode-go').retry_after_ms, scenario.retryAfter)
      assert.deepEqual(provider(result, 'opencode-go').metrics, [])
      assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
    })
  }
})

test('OpenCode Go prefers window resets and uses validated access end only for monthly fallback', async (t) => {
  const connection = credentialConnection('opencode', 'console-go-reset-metadata', 'oauth')
  const fake = createContext({
    active: { opencode: connection },
    list: [connection],
    credentials: {
      [connection.id]: { type: 'oauth', methodID: 'device', access: SECRET_SENTINEL },
    },
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    Response.json({
      access: {
        endsAt: '2028-02-29T00:00:00-05:30',
        meters: {
          fiveHour: {
            limitMicroCents: 100000000,
            usedMicroCents: 25000000,
            resetsAt: '2026-02-31T00:00:00Z',
          },
          week: { limitMicroCents: 100000000, usedMicroCents: 50000000 },
          month: { limitMicroCents: 100000000, usedMicroCents: 75000000 },
        },
      },
    })
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  const go = provider(result, 'opencode-go')
  assert.equal(go.state, 'available')
  assert.deepEqual(
    go.metrics.map(({ used, resetsAt }) => ({ used, resetsAt })),
    [
      { used: 25, resetsAt: undefined },
      { used: 50, resetsAt: undefined },
      { used: 75, resetsAt: Date.parse('2028-02-29T00:00:00-05:30') },
    ],
  )
})

test('OpenCode Go window reset timestamps take precedence over the monthly access end', async (t) => {
  const connection = credentialConnection('opencode', 'console-go-window-resets', 'oauth')
  const fake = createContext({
    active: { opencode: connection },
    list: [connection],
    credentials: {
      [connection.id]: { type: 'oauth', methodID: 'device', access: SECRET_SENTINEL },
    },
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    Response.json({
      access: {
        endsAt: '2028-02-29T00:00:00-05:30',
        meters: {
          fiveHour: {
            limitMicroCents: 100,
            usedMicroCents: 25,
            resetsAt: '2028-01-01T01:02:03Z',
          },
          week: {
            limitMicroCents: 100,
            usedMicroCents: 50,
            resetsAt: '2028-01-02T02:03:04Z',
          },
          month: {
            limitMicroCents: 100,
            usedMicroCents: 75,
            resetsAt: '2028-01-03T03:04:05Z',
          },
        },
      },
    })
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.deepEqual(
    provider(result, 'opencode-go').metrics.map(({ resetsAt }) => resetsAt),
    [
      Date.parse('2028-01-01T01:02:03Z'),
      Date.parse('2028-01-02T02:03:04Z'),
      Date.parse('2028-01-03T03:04:05Z'),
    ],
  )
})

test('OpenCode Go does not infer a monthly reset from absent or invalid access endsAt', async (t) => {
  const connection = credentialConnection('opencode', 'console-go-invalid-month-end', 'oauth')
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  for (const [name, endsAt] of [
    ['missing endsAt', undefined],
    ['invalid endsAt', '2028-02-30T00:00:00Z'],
  ]) {
    await t.test(name, async (subtest) => {
      const fake = createContext({
        active: { opencode: connection },
        list: [connection],
        credentials: {
          [connection.id]: { type: 'oauth', methodID: 'device', access: SECRET_SENTINEL },
        },
      })
      globalThis.fetch = async () =>
        Response.json({
          access: {
            ...(endsAt === undefined ? {} : { endsAt }),
            meters: {
              fiveHour: { limitMicroCents: 100, usedMicroCents: 10 },
              week: { limitMicroCents: 100, usedMicroCents: 20 },
              month: { limitMicroCents: 100, usedMicroCents: 30 },
            },
          },
        })
      const cleanup = await setup(fake)
      subtest.after(cleanup)

      const result = await status(fake)
      const go = provider(result, 'opencode-go')
      assert.equal(go.state, 'available')
      assert.deepEqual(
        go.metrics.map(({ resetsAt }) => resetsAt),
        [undefined, undefined, undefined],
      )
    })
  }
})

test('OpenCode Go uses the selected legacy API key after unsupported OAuth is ruled out', async (t) => {
  const primary = credentialConnection('opencode-go', 'primary-go-login', 'oauth')
  const legacy = credentialConnection('opencode', 'legacy-go-login', 'key')
  const fake = createContext({
    active: { 'opencode-go': primary, opencode: legacy },
    list: [primary, legacy],
    credentials: {
      'primary-go-login': { type: 'oauth', access: SECRET_SENTINEL },
      'legacy-go-login': { type: 'key', key: SECRET_SENTINEL },
    },
  })
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    return Response.json({})
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.equal(provider(result, 'opencode-go').route_kind, 'api_key')
  assert.deepEqual(fake.resolveCalls, ['legacy-go-login'])
  assert.equal(fetchCalls, 1)
})

test('OpenCode Go uses a selected legacy API key when the primary key needs auth', async (t) => {
  const primary = {
    ...credentialConnection('opencode-go', 'primary-go-login', 'key'),
    status: { status: 'needs_auth' },
  }
  const legacy = credentialConnection('opencode', 'legacy-go-login', 'key')
  const fake = createContext({
    active: { 'opencode-go': primary, opencode: legacy },
    list: [primary, legacy],
    credentials: {
      'primary-go-login': { type: 'key', key: SECRET_SENTINEL },
      'legacy-go-login': { type: 'key', key: SECRET_SENTINEL },
    },
  })
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    return Response.json({})
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.deepEqual(fake.resolveCalls, ['legacy-go-login'])
  assert.equal(fetchCalls, 1)
  assert.equal(provider(result, 'opencode-go').route_kind, 'api_key')
})

test('OpenCode Go does not request usage with a key that trims to empty', async (t) => {
  const connection = credentialConnection('opencode-go', 'blank-go-login', 'key')
  const fake = createContext({
    active: { 'opencode-go': connection },
    list: [connection],
    credentials: { 'blank-go-login': { type: 'key', key: ' \t\n ' } },
  })
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('must not call provider')
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.equal(fetchCalls, 0)
  assert.equal(provider(result, 'opencode-go'), undefined)
})

test('OpenCode Go does not resolve OAuth connections as API keys', async (t) => {
  const connection = credentialConnection('opencode-go', 'legacy-console-login', 'oauth')
  const fake = createContext({
    active: { 'opencode-go': connection },
    list: [connection],
    credentials: {
      'legacy-console-login': {
        type: 'oauth',
        methodID: 'device',
        access: SECRET_SENTINEL,
      },
    },
  })
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('must not call provider')
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.deepEqual(fake.resolveCalls, [])
  assert.equal(fetchCalls, 0)
  assert.equal(provider(result, 'opencode-go').reason, 'unsupported_credential_method')
  assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
})

test('Gemini eligibility and explicitly blocked sources fail closed without network requests', async (t) => {
  const gemini = credentialConnection('google-gemini-cli', 'gemini-business', 'oauth')
  const xiaomi = credentialConnection('xiaomi-mimo', 'xiaomi-login', 'key')
  const fake = createContext({
    active: {
      'google-gemini-cli': gemini,
      'xiaomi-mimo': xiaomi,
    },
    list: [gemini, xiaomi],
    credentials: {
      'gemini-business': { type: 'oauth', access: SECRET_SENTINEL },
      'xiaomi-login': { type: 'key', key: SECRET_SENTINEL },
    },
  })
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    throw new Error('blocked source must not be requested')
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.equal(provider(result, 'gemini-cli').reason, 'eligibility_unverified')
  assert.equal(provider(result, 'xiaomi-mimo').reason, 'unsupported')
  assert.deepEqual(fake.resolveCalls, ['gemini-business', 'xiaomi-login'])
  assert.equal(fetchCalls, 0)
  assert.equal(JSON.stringify(result).includes(SECRET_SENTINEL), false)
})

test('adapter failures are sanitized, oversized bodies rejected, and Retry-After is honored', async (t) => {
  const connection = credentialConnection('deepseek', 'deepseek-login', 'key')
  const fake = createContext({
    active: { deepseek: connection },
    list: [connection],
    credentials: { 'deepseek-login': { type: 'key', key: SECRET_SENTINEL } },
  })
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async (_url, options) => {
    calls += 1
    assert.equal(options.redirect, 'error')
    if (calls === 1) return new Response('too large', { headers: { 'content-length': '65537' } })
    return new Response(null, { status: 429, headers: { 'retry-after': '120' } })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const first = await status(fake)
  assert.equal(provider(first, 'deepseek').reason, 'invalid_response')
  const second = await status(fake)
  assert.equal(provider(second, 'deepseek').reason, 'rate_limited')
  assert.equal(provider(second, 'deepseek').retry_after_ms, 120_000)
  const third = await status(fake)
  assert.equal(provider(third, 'deepseek').reason, 'rate_limited')
  assert.equal(calls, 2)
  assert.equal(JSON.stringify([first, second, third]).includes(SECRET_SENTINEL), false)
})

test('fractional Retry-After is rounded up to an RPC-safe integer', async (t) => {
  const connection = credentialConnection('deepseek', 'deepseek-login', 'key')
  const fake = createContext({
    active: { deepseek: connection },
    list: [connection],
    credentials: { 'deepseek-login': { type: 'key', key: SECRET_SENTINEL } },
  })
  const originalFetch = globalThis.fetch
  let fetchCalls = 0
  globalThis.fetch = async () => {
    fetchCalls += 1
    return new Response(null, { status: 429, headers: { 'retry-after': '0.0001' } })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)
  const originalNow = Date.now
  Date.now = () => 10_000

  try {
    const result = await fake.handlers.status({}, { signal: new AbortController().signal })
    const validate = new Ajv().compile(fake.definition.methods.status.output)
    assert.equal(validate(result), true, JSON.stringify(validate.errors))
    const deepseek = provider(result, 'deepseek')
    assert.equal(deepseek.reason, 'rate_limited')
    assert.equal(deepseek.retry_after_ms, 1)
    assert.equal(Number.isInteger(deepseek.retry_after_ms), true)

    const cooldown = await status(fake)
    assert.equal(provider(cooldown, 'deepseek').retry_after_ms, 1)
    assert.equal(fetchCalls, 1)
  } finally {
    Date.now = originalNow
  }
})

test('adapter timeout and invalid provider payload return safe unavailable states', async (t) => {
  const connection = credentialConnection('deepseek', 'deepseek-login', 'key')
  const fake = createContext({
    active: { deepseek: connection },
    list: [connection],
    credentials: { 'deepseek-login': { type: 'key', key: SECRET_SENTINEL } },
  })
  const originalFetch = globalThis.fetch
  let calls = 0
  const rawErrorDetail = 'private provider transport detail'
  globalThis.fetch = async (_url, options) => {
    calls += 1
    if (calls === 1) {
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener(
          'abort',
          () => reject(new Error(`request failed ${rawErrorDetail}`)),
          { once: true },
        )
      })
    }
    return Response.json({ is_available: 'not-a-boolean', balance_infos: [] })
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await setup(fake)
  t.after(cleanup)

  const result = await status(fake)
  assert.equal(provider(result, 'deepseek').state, 'unavailable')
  assert.equal(provider(result, 'deepseek').reason, 'timeout')
  const malformed = await status(fake)
  assert.equal(provider(malformed, 'deepseek').state, 'unavailable')
  assert.equal(provider(malformed, 'deepseek').reason, 'provider_error')
  assert.equal(calls, 2)
  assert.equal(JSON.stringify([result, malformed]).includes(SECRET_SENTINEL), false)
  assert.equal(JSON.stringify([result, malformed]).includes(rawErrorDetail), false)
})

function createHistoryDatabase(path, modelCount = 1) {
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE message (id TEXT, session_id TEXT, time_created INTEGER, data TEXT)')
  const insert = db.prepare(
    'INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
  )
  for (let index = 0; index < modelCount; index += 1) {
    insert.run(
      `row-${index}`,
      'private-session-id-sentinel',
      Date.now(),
      JSON.stringify({
        role: 'assistant',
        agent: 'private-agent-sentinel',
        model: { providerID: 'openai', id: `model-${index}` },
        tokens: { input: 11, output: 7, cache: { read: 3, write: 2 } },
        content: SECRET_SENTINEL,
      }),
    )
  }
  db.close()
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

test('usage history RPC returns bounded aggregate-only data from the server-owned database path', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pantheon-history-rpc-'))
  const dbPath = join(directory, 'private-database-name.db')
  const previousPath = process.env.PANTHEON_COST_DB
  createHistoryDatabase(dbPath)
  const databaseHash = sha256(dbPath)
  process.env.PANTHEON_COST_DB = dbPath
  const fake = createContext()
  const cleanup = await setup(fake)
  t.after(async () => {
    await cleanup()
    if (previousPath === undefined) delete process.env.PANTHEON_COST_DB
    else process.env.PANTHEON_COST_DB = previousPath
    rmSync(directory, { recursive: true, force: true })
  })

  const inputValidator = new Ajv().compile(fake.definition.methods.usage_history.input)
  const outputValidator = new Ajv().compile(fake.definition.methods.usage_history.output)
  assert.equal(inputValidator({ period: '7d' }), true)
  assert.equal(inputValidator({ period: '1d' }), false)
  assert.equal(inputValidator({ period: '7d', dbPath }), false)

  const result = await fake.handlers.usage_history(
    { period: '7d' },
    { signal: new AbortController().signal },
  )
  assert.equal(outputValidator(result), true, JSON.stringify(outputValidator.errors))
  assert.equal(result.status, 'partial')
  assert.equal(result.period, '7d')
  assert.equal(result.partial, true)
  assert.deepEqual(result.totals, { input: 11, output: 7, cacheRead: 3, cacheWrite: 2, total: 18 })
  assert.equal(result.models.length, 1)
  assert.equal(result.models[0].modelID, 'model-0')
  assert.equal(result.rows, 1)
  assert.equal(result.pricing.billed, false)
  const serialized = JSON.stringify(result)
  for (const secret of [
    dbPath,
    'private-database-name',
    'private-session-id-sentinel',
    'private-agent-sentinel',
    SECRET_SENTINEL,
  ]) {
    assert.equal(serialized.includes(secret), false)
  }
  assert.equal(sha256(dbPath), databaseHash, 'history query must leave the database unchanged')
})

test('usage history RPC sanitizes query failures and rejects invalid periods', async (t) => {
  const previousPath = process.env.PANTHEON_COST_DB
  const privatePath = '/private/path/history-error-secret.db'
  process.env.PANTHEON_COST_DB = privatePath
  const fake = createContext()
  const cleanup = await setup(fake)
  t.after(async () => {
    await cleanup()
    if (previousPath === undefined) delete process.env.PANTHEON_COST_DB
    else process.env.PANTHEON_COST_DB = previousPath
  })

  const outputValidator = new Ajv().compile(fake.definition.methods.usage_history.output)
  const invalid = await fake.handlers.usage_history(
    { period: '1d' },
    { signal: new AbortController().signal },
  )
  assert.deepEqual(invalid, { status: 'unavailable', reason: 'invalid_period' })
  assert.equal(outputValidator(invalid), true, JSON.stringify(outputValidator.errors))
  const failed = await fake.handlers.usage_history(
    { period: '7d' },
    { signal: new AbortController().signal },
  )
  assert.deepEqual(failed, { status: 'unavailable', reason: 'history_unavailable' })
  assert.equal(outputValidator(failed), true, JSON.stringify(outputValidator.errors))
  assert.equal(JSON.stringify(failed).includes(privatePath), false)
})

test('usage history RPC caps model projections and reports truncation', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pantheon-history-size-'))
  const dbPath = join(directory, 'history.db')
  const previousPath = process.env.PANTHEON_COST_DB
  createHistoryDatabase(dbPath, 70)
  process.env.PANTHEON_COST_DB = dbPath
  const fake = createContext()
  const cleanup = await setup(fake)
  t.after(async () => {
    await cleanup()
    if (previousPath === undefined) delete process.env.PANTHEON_COST_DB
    else process.env.PANTHEON_COST_DB = previousPath
    rmSync(directory, { recursive: true, force: true })
  })

  const result = await fake.handlers.usage_history(
    { period: 'total' },
    { signal: new AbortController().signal },
  )
  assert.equal(result.status, 'partial')
  assert.equal(result.truncated, true)
  assert.equal(result.models.length, 64)
  assert.ok(JSON.stringify(result).length < 100_000)
  assert.equal(result.totals.input, 770)
})

test('active-context RPC estimates from safe model and context-token input without cache discount', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'pantheon-context-cost-'))
  const previousHome = process.env.PANTHEON_HOME
  process.env.PANTHEON_HOME = directory
  mkdirSync(join(directory, 'cache'), { recursive: true })
  writeFileSync(
    join(directory, 'cache', 'models-dev.json'),
    JSON.stringify({
      version: 1,
      fetchedAt: Date.now(),
      providers: {
        acme: { alpha: { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.01 } },
      },
    }),
  )
  const fake = createContext()
  const cleanup = await setup(fake)
  t.after(async () => {
    await cleanup()
    if (previousHome === undefined) delete process.env.PANTHEON_HOME
    else process.env.PANTHEON_HOME = previousHome
    rmSync(directory, { recursive: true, force: true })
  })

  const result = await fake.handlers.active_context_cost(
    { providerID: 'acme', modelID: 'alpha', contextTokens: 12_000, cachePercent: 97 },
    { signal: new AbortController().signal },
  )
  const validateOutput = new Ajv().compile(fake.definition.methods.active_context_cost.output)
  const validateInput = new Ajv().compile(fake.definition.methods.active_context_cost.input)
  assert.deepEqual(result, {
    status: 'estimated',
    estimatedUsd: 0.012,
    billed: false,
    basis: 'pre-cache-context-tokens-times-input-price',
    cacheDiscountApplied: false,
  })
  assert.equal(validateOutput(result), true, JSON.stringify(validateOutput.errors))
  assert.equal(
    validateInput({ providerID: 'acme', modelID: 'alpha', contextTokens: 12_000 }),
    true,
    JSON.stringify(validateInput.errors),
  )
  assert.equal(
    validateInput({ providerID: 'acme', modelID: 'alpha', contextTokens: -1 }),
    true,
    JSON.stringify(validateInput.errors),
  )
  assert.equal(
    validateInput({
      providerID: 'acme',
      modelID: 'alpha',
      contextTokens: 12_000,
      cachePercent: 97,
    }),
    false,
  )
  assert.equal(JSON.stringify(result).includes('acme'), false)
  assert.equal(JSON.stringify(result).includes('alpha'), false)

  const invalidTokens = await fake.handlers.active_context_cost(
    { providerID: 'acme', modelID: 'alpha', contextTokens: -1 },
    { signal: new AbortController().signal },
  )
  assert.deepEqual(invalidTokens, {
    status: 'unavailable',
    billed: false,
    basis: 'pre-cache-context-tokens-times-input-price',
    cacheDiscountApplied: false,
    reason: 'invalid-context-token-count',
  })
  assert.equal(validateOutput(invalidTokens), true, JSON.stringify(validateOutput.errors))
})
