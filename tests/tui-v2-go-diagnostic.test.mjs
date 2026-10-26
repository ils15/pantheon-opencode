import assert from 'node:assert/strict'
import test from 'node:test'
import Ajv from 'ajv'
import { createQuotaPlugin } from '../src/plugins/tui/dist/server-v2.js'

const SECRET = 'diagnostic-secret-sentinel'

async function fixture(
  t,
  {
    method = 'key',
    credential = { type: 'key', key: SECRET },
    listed = true,
    fail = false,
    integrationID = 'opencode-go',
  } = {},
) {
  const calls = []
  const resolved = []
  const activeCalls = []
  let handlers
  let definition
  const connection = { type: 'credential', id: 'go-active', method }
  const original = globalThis.fetch
  const logs = []
  for (const method of ['log', 'warn', 'error', 'info', 'debug']) {
    t.mock.method(console, method, (...args) => logs.push(args))
  }
  t.after(() => assert.deepEqual(logs, []))
  globalThis.fetch = async (...args) => {
    calls.push(args)
    return new Response(
      JSON.stringify({ error: { code: SECRET, message: SECRET }, quota: 12345 }),
      {
        status: 401,
        headers: { 'content-type': 'application/json', location: `https://example.test/${SECRET}` },
      },
    )
  }
  t.after(() => {
    globalThis.fetch = original
  })
  const cleanup = await createQuotaPlugin().setup({
    integration: {
      list: async () => ({
        data: listed ? [{ id: integrationID, connections: [connection] }] : [],
      }),
      connection: {
        active: async (id) => {
          activeCalls.push(id)
          return connection
        },
        resolve: async (value) => {
          resolved.push(value)
          if (fail) throw new Error(SECRET)
          return credential
        },
      },
    },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    rpc: {
      register: async (schema, methods) => {
        definition = schema
        handlers = methods
        return { dispose: async () => {}, events: { emit: async () => {} } }
      },
    },
  })
  t.after(cleanup)
  const run = async (signal = new AbortController().signal) => {
    const result = await handlers.go_key_diagnostic({}, { signal })
    const validate = new Ajv().compile(definition.methods.go_key_diagnostic.output)
    assert.equal(validate(result), true, JSON.stringify(validate.errors))
    assert.equal(JSON.stringify(result).includes(SECRET), false)
    return result
  }
  return { calls, resolved, activeCalls, run }
}

test('Go diagnostic is idle at initialization, performs one fixed GET, and returns no response data', async (t) => {
  const fake = await fixture(t)
  assert.equal(fake.calls.length, 0)
  assert.equal(fake.activeCalls.length, 0)
  assert.deepEqual(await fake.run(), {
    category: 'unauthorized',
    status: 401,
    content_type: 'application/json',
    error_structure: 'present',
  })
  assert.equal(fake.calls.length, 1)
  const [url, options] = fake.calls[0]
  assert.equal(url, 'https://opencode.ai/zen/go/v1/usage')
  assert.equal(options.method, 'GET')
  assert.equal(options.redirect, 'manual')
  assert.equal(options.body, undefined)
  assert.deepEqual(options.headers, {
    Authorization: `Bearer ${SECRET}`,
    'x-opencode-session': 'pantheon-quota',
    'user-agent': 'Pantheon-Quota/1.0',
  })
  assert.deepEqual(fake.activeCalls, ['opencode-go'])
  assert.deepEqual(await fake.run(), { category: 'already_used' })
  assert.equal(fake.calls.length, 1)
})

test('missing credential or OAuth cannot enter the diagnostic or fall back to another integration', async (t) => {
  for (const options of [
    { listed: false },
    { method: 'oauth', credential: { type: 'oauth', access: SECRET } },
    { credential: { type: 'key', key: ' ' } },
    { fail: true },
  ]) {
    await t.test(JSON.stringify(options), async (t) => {
      const fake = await fixture(t, options)
      assert.deepEqual(await fake.run(), { category: 'not_run' })
      assert.equal(fake.calls.length, 0)
      assert.equal(fake.activeCalls.includes('opencode'), false)
      if (options.method === 'oauth') assert.equal(fake.resolved.length, 0)
      assert.deepEqual(await fake.run(), { category: 'already_used' })
    })
  }
})

test('redirect is not followed and concurrent invocations cannot spend another attempt', async (t) => {
  const fake = await fixture(t)
  globalThis.fetch = async (...args) => {
    fake.calls.push(args)
    return new Response(SECRET, {
      status: 302,
      headers: { location: `https://example.test/${SECRET}`, 'content-type': SECRET },
    })
  }
  const results = await Promise.all([fake.run(), fake.run()])
  assert.deepEqual(results, [
    { category: 'redirect', status: 302, content_type: 'other' },
    { category: 'already_used' },
  ])
  assert.equal(fake.calls.length, 1)
})

test('network errors are sanitized and never retried', async (t) => {
  const fake = await fixture(t)
  globalThis.fetch = async (...args) => {
    fake.calls.push(args)
    throw new Error(SECRET)
  }
  assert.deepEqual(await fake.run(), { category: 'network_error' })
  assert.deepEqual(await fake.run(), { category: 'already_used' })
  assert.equal(fake.calls.length, 1)
})

test('non-JSON 401 body is cancelled without reading', async (t) => {
  const fake = await fixture(t)
  let cancelled = false
  globalThis.fetch = async (...args) => {
    fake.calls.push(args)
    return {
      status: 401,
      ok: false,
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: {
        cancel: async () => {
          cancelled = true
        },
      },
      json: () => {
        throw new Error(SECRET)
      },
      text: () => {
        throw new Error(SECRET)
      },
    }
  }
  assert.deepEqual(await fake.run(), {
    category: 'unauthorized',
    status: 401,
    content_type: 'text/plain',
    error_structure: 'unavailable',
  })
  assert.equal(cancelled, true)
  assert.equal(fake.calls.length, 1)
})

test('401 JSON exposes only bounded top-level error presence', async (t) => {
  for (const [body, expected] of [
    [JSON.stringify({ error: { message: SECRET, code: SECRET, type: SECRET } }), 'present'],
    ['{"error":null}', 'present'],
    [JSON.stringify({ nested: { error: SECRET } }), 'absent'],
    ['{}', 'absent'],
    ['{"error":', 'unavailable'],
    ['null', 'unavailable'],
    ['[]', 'unavailable'],
    [`{}${' '.repeat(4094)}`, 'absent'],
    [`{}${' '.repeat(4095)}`, 'unavailable'],
  ]) {
    await t.test(expected, async (t) => {
      const fake = await fixture(t)
      globalThis.fetch = async (...args) => {
        fake.calls.push(args)
        return new Response(body, {
          status: 401,
          headers: { 'content-type': ' Application/JSON; charset=utf-8' },
        })
      }
      assert.deepEqual(await fake.run(), {
        category: 'unauthorized',
        status: 401,
        content_type: 'application/json',
        error_structure: expected,
      })
      assert.deepEqual(await fake.run(), { category: 'already_used' })
      assert.equal(fake.calls.length, 1)
    })
  }
})

test('body reader stops and cancels at overflow or unreadable data; never reads non-401 JSON', async (t) => {
  for (const mode of ['overflow', 'unreadable', 'non-401']) {
    await t.test(mode, async (t) => {
      const fake = await fixture(t)
      let reads = 0
      let cancelled = 0
      globalThis.fetch = async (...args) => {
        fake.calls.push(args)
        return {
          status: mode === 'non-401' ? 200 : 401,
          ok: mode === 'non-401',
          headers: new Headers({ 'content-type': 'application/json' }),
          body: {
            cancel: async () => {
              cancelled++
            },
            getReader() {
              assert.notEqual(mode, 'non-401')
              return {
                async read() {
                  reads++
                  if (mode === 'unreadable') throw new Error(SECRET)
                  assert.ok(reads <= 2)
                  return { done: false, value: new Uint8Array(reads === 1 ? 4096 : 1) }
                },
                cancel: async () => {
                  cancelled++
                },
                releaseLock() {},
              }
            },
          },
        }
      }
      const result = await fake.run()
      assert.equal(result.error_structure, mode === 'non-401' ? undefined : 'unavailable')
      assert.equal(reads, mode === 'non-401' ? 0 : mode === 'overflow' ? 2 : 1)
      assert.equal(cancelled, 1)
      assert.equal(fake.calls.length, 1)
    })
  }
})

test('request timeout aborts the only fetch and consumes the attempt', async (t) => {
  const fake = await fixture(t)
  globalThis.fetch = async (...args) => {
    fake.calls.push(args)
    const { signal } = args[1]
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error(SECRET)), { once: true })
    })
  }
  // Keep the test alive while the native AbortSignal's unref'ed deadline runs.
  const keepAlive = setInterval(() => {}, 1_000)
  t.after(() => clearInterval(keepAlive))
  assert.deepEqual(await fake.run(), { category: 'timeout' })
  assert.deepEqual(await fake.run(), { category: 'already_used' })
  assert.equal(fake.calls.length, 1)
})

test('abort interrupts a pending body read without surfacing stream errors or retrying', async (t) => {
  const fake = await fixture(t)
  const controller = new AbortController()
  let cancelled = 0
  globalThis.fetch = async (...args) => {
    fake.calls.push(args)
    return {
      status: 401,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: {
        getReader: () => ({
          read: () => {
            queueMicrotask(() => controller.abort(new Error(SECRET)))
            return new Promise(() => {})
          },
          cancel: async () => {
            cancelled++
          },
          releaseLock() {},
        }),
      },
    }
  }
  assert.deepEqual(await fake.run(controller.signal), {
    category: 'unauthorized',
    status: 401,
    content_type: 'application/json',
    error_structure: 'unavailable',
  })
  assert.equal(cancelled, 1)
  assert.deepEqual(await fake.run(), { category: 'already_used' })
  assert.equal(fake.calls.length, 1)
})

test('diagnostic preserves the existing active Go key legacy alias, but never resolves alias OAuth', async (t) => {
  for (const method of ['key', 'oauth']) {
    await t.test(method, async (t) => {
      const fake = await fixture(t, { integrationID: 'opencode', method })
      const result = await fake.run()
      assert.equal(result.category, method === 'key' ? 'unauthorized' : 'not_run')
      assert.equal(fake.calls.length, method === 'key' ? 1 : 0)
      assert.equal(fake.resolved.length, method === 'key' ? 1 : 0)
    })
  }
})
