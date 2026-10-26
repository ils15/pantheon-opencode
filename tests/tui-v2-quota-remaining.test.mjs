import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const root = join(process.cwd(), 'src/plugins/tui/dist')
const { runQuotaAdapter } = await import(pathToFileURL(join(root, 'quota-adapters.js')).href)
const { createQuotaPlugin } = await import(pathToFileURL(join(root, 'server-v2.js')).href)
const TOKEN = 'quota-remaining-test-token'

function response(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers })
}

async function withFetch(t, handler) {
  const original = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    return handler(String(url), options, calls.length)
  }
  t.after(() => {
    globalThis.fetch = original
  })
  return calls
}

test('Anthropic OAuth adapter requests only usage and normalizes reported windows', async (t) => {
  const calls = await withFetch(t, async (url, options) => {
    assert.equal(url, 'https://api.anthropic.com/api/oauth/usage')
    assert.equal(options.method ?? 'GET', 'GET')
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(options.headers['anthropic-beta'], 'oauth-2025-04-20')
    return response({
      five_hour: { utilization: 25 },
      seven_day: { utilization: 60 },
    })
  })

  const result = await runQuotaAdapter('anthropic', TOKEN, new AbortController().signal)
  assert.deepEqual(result, {
    state: 'available',
    metrics: [
      {
        kind: 'provider_quota',
        used: 25,
        remaining: 75,
        unit: '%',
        label: '5-hour quota',
        period: '5h',
      },
      {
        kind: 'provider_quota',
        used: 60,
        remaining: 40,
        unit: '%',
        label: 'Weekly quota',
        period: 'week',
      },
    ],
  })
  assert.equal(calls.length, 1)
})

test('Copilot adapter uses the selected OAuth integration for user quota only', async (t) => {
  const calls = await withFetch(t, async (url, options) => {
    assert.equal(url, 'https://api.github.com/copilot_internal/user')
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(options.headers.cookie, undefined)
    return response({
      copilot_plan: 'individual_pro',
      quota_reset_date_utc: '2026-11-01T00:00:00Z',
      quota_snapshots: { premium_interactions: { entitlement: 300, quota_remaining: 210 } },
    })
  })

  const result = await runQuotaAdapter('github-copilot', TOKEN, new AbortController().signal)
  assert.deepEqual(result, {
    state: 'available',
    metrics: [
      {
        kind: 'provider_quota',
        used: 90,
        remaining: 210,
        unit: 'premium interactions',
        label: 'Copilot user quota',
        period: 'month',
      },
    ],
  })
  assert.equal(calls.length, 1)
})

test('Google AGY requires an integration project ID and posts a bounded quota request', async (t) => {
  let fetchCalls = 0
  const original = globalThis.fetch
  globalThis.fetch = async () => {
    fetchCalls += 1
    return response({ buckets: [{ remainingFraction: 0.5 }] })
  }
  t.after(() => {
    globalThis.fetch = original
  })

  const missingProject = await runQuotaAdapter('google-agy', TOKEN, new AbortController().signal)
  assert.deepEqual(missingProject, { reason: 'eligibility_unverified' })
  assert.equal(fetchCalls, 0)

  globalThis.fetch = async (url, options) => {
    fetchCalls += 1
    assert.equal(
      url,
      'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
    )
    assert.equal(options.method, 'POST')
    assert.deepEqual(JSON.parse(options.body), { project: 'project-123' })
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`)
    return response({
      buckets: [{ displayName: 'Gemini', remainingFraction: 0.5, window: 'weekly' }],
    })
  }
  const result = await runQuotaAdapter(
    'google-agy',
    TOKEN,
    new AbortController().signal,
    undefined,
    { projectId: 'project-123' },
  )
  assert.deepEqual(result, {
    state: 'available',
    metrics: [
      {
        kind: 'provider_quota',
        used: 50,
        remaining: 50,
        unit: '%',
        label: 'AGY quota 1',
        period: 'weekly',
      },
    ],
  })
  assert.equal(fetchCalls, 1)
})

test('OpenCode Go maps provider-reported rolling, weekly and monthly windows', async (t) => {
  const calls = await withFetch(t, async (url, options) => {
    assert.equal(url, 'https://opencode.ai/zen/go/v1/usage')
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`)
    return response({
      usage: {
        rolling: { status: 'ok', percent: 20, resetsAt: '2026-10-24T12:00:00Z' },
        weekly: { status: 'rate-limited', percent: 92, resetsAt: '2026-10-25T00:00:00Z' },
        monthly: { status: 'ok', percent: 5, resetsAt: '2026-11-01T00:00:00Z' },
      },
    })
  })

  const result = await runQuotaAdapter('opencode-go', TOKEN, new AbortController().signal)
  assert.deepEqual(result, {
    state: 'available',
    metrics: [
      {
        kind: 'provider_quota',
        used: 20,
        remaining: 80,
        unit: '%',
        label: '5-hour quota',
        period: 'rolling',
      },
      {
        kind: 'provider_quota',
        used: 100,
        remaining: 0,
        unit: '%',
        label: 'Weekly quota',
        period: 'weekly',
      },
      {
        kind: 'provider_quota',
        used: 5,
        remaining: 95,
        unit: '%',
        label: 'Monthly quota',
        period: 'monthly',
      },
    ],
  })
  assert.equal(calls.length, 1)
})

test('OpenCode Go failures expose only typed HTTP and transport categories', async (t) => {
  const cases = [
    { name: 'unauthorized', status: 401, reason: 'unauthorized' },
    { name: 'forbidden', status: 403, reason: 'forbidden' },
    { name: 'rate limited', status: 429, reason: 'rate_limited' },
    { name: 'server failure', status: 503, reason: 'provider_error' },
  ]

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      await withFetch(
        subtest,
        async () =>
          new Response('private provider payload', {
            status: scenario.status,
            headers: { 'retry-after': '2' },
          }),
      )
      const result = await runQuotaAdapter('opencode-go', TOKEN, new AbortController().signal)
      assert.deepEqual(result, {
        reason: scenario.reason,
        ...(scenario.reason === 'rate_limited' ? { retryAfterMs: 2_000 } : {}),
      })
      assert.equal(JSON.stringify(result).includes('private provider payload'), false)
    })
  }

  await t.test('network failure', async (subtest) => {
    await withFetch(subtest, async () => {
      throw new Error('private URL and token')
    })
    const result = await runQuotaAdapter('opencode-go', TOKEN, new AbortController().signal)
    assert.deepEqual(result, { reason: 'network_error' })
    assert.equal(JSON.stringify(result).includes('private URL and token'), false)
  })

  await t.test('timeout', async (subtest) => {
    await withFetch(subtest, async () => {
      throw new DOMException('private URL and token', 'TimeoutError')
    })
    const result = await runQuotaAdapter('opencode-go', TOKEN, new AbortController().signal)
    assert.deepEqual(result, { reason: 'timeout' })
    assert.equal(JSON.stringify(result).includes('private URL and token'), false)
  })

  await t.test('malformed success response', async (subtest) => {
    await withFetch(subtest, async () => new Response('{ private provider payload'))
    const result = await runQuotaAdapter('opencode-go', TOKEN, new AbortController().signal)
    assert.deepEqual(result, { reason: 'invalid_response' })
    assert.equal(JSON.stringify(result).includes('private provider payload'), false)
  })

  await t.test('invalid usage shape', async (subtest) => {
    await withFetch(subtest, async () => response({ usage: { rolling: {} } }))
    const result = await runQuotaAdapter('opencode-go', TOKEN, new AbortController().signal)
    assert.deepEqual(result, { reason: 'invalid_response' })
  })
})

test('quota RPC allows only sanitized failure categories', async (t) => {
  const connection = {
    integrationID: 'opencode-go',
    type: 'credential',
    id: 'go-login',
    label: 'test connection',
    method: 'key',
  }
  let definition
  let handlers
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(`private response containing ${TOKEN}`, { status: 401 })
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  const cleanup = await createQuotaPlugin().setup({
    integration: {
      list: async () => ({
        location: {},
        data: [{ id: 'opencode-go', connections: [connection] }],
      }),
      connection: {
        active: async () => connection,
        resolve: async () => ({ type: 'key', key: TOKEN }),
      },
    },
    event: {
      subscribe: ({ signal }) => ({
        async *[Symbol.asyncIterator]() {
          await new Promise((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener('abort', resolve, { once: true })
          })
        },
      }),
    },
    rpc: {
      register: async (rpcDefinition, rpcHandlers) => {
        definition = rpcDefinition
        handlers = rpcHandlers
        return { dispose: async () => {} }
      },
    },
  })
  t.after(cleanup)

  const result = await handlers.status({}, { signal: new AbortController().signal })
  const reasonSchema = definition.methods.status.output.properties.providers.items.properties.reason

  assert.deepEqual(reasonSchema.enum, [
    'none',
    'not_connected',
    'unsupported',
    'private_endpoint',
    'eligibility_unverified',
    'runtime_accounting_unavailable',
    'cli_identity_unavailable',
    'unsupported_credential_method',
    'provider_error',
    'rate_limited',
    'unauthorized',
    'forbidden',
    'timeout',
    'network_error',
    'invalid_response',
  ])
  assert.equal(
    result.providers.find((item) => item.provider === 'opencode-go').reason,
    'unauthorized',
  )
  assert.equal(JSON.stringify(result).includes(TOKEN), false)
  assert.equal(reasonSchema.enum.includes(`HTTP 401 ${TOKEN}`), false)
})

test('OpenCode Zen queries only authorized billing and usage routes', async (t) => {
  const paths = []
  const calls = await withFetch(t, async (url, _options) => {
    paths.push(url)
    if (url.endsWith('/billing/status')) return response({ balanceMicroCents: '125000000' })
    if (url.endsWith('/billing/account')) return response({ creditLimitMicroCents: '500000000' })
    if (url.endsWith('/usage/cost-by-day')) {
      return response([
        { date: new Date().toISOString().slice(0, 10), totalCostMicroCents: '12500000' },
      ])
    }
    return response({})
  })

  const result = await runQuotaAdapter(
    'opencode-zen',
    TOKEN,
    new AbortController().signal,
    undefined,
    { accountId: 'account-1', orgId: 'org-1' },
  )
  assert.deepEqual(
    paths.sort(),
    [
      'https://opencode.ai/console/api/billing/account',
      'https://opencode.ai/console/api/billing/status',
      'https://opencode.ai/console/api/usage/cost-by-day',
    ].sort(),
  )
  assert.deepEqual(result, {
    state: 'available',
    metrics: [
      { kind: 'balance', amount: 1.25, currency: 'USD', label: 'Console balance' },
      {
        kind: 'provider_quota',
        used: 0.125,
        remaining: 4.875,
        unit: 'USD',
        label: 'Monthly credit limit',
        period: 'month',
      },
    ],
  })
  assert.deepEqual(
    paths.sort(),
    [
      'https://opencode.ai/console/api/billing/account',
      'https://opencode.ai/console/api/billing/status',
      'https://opencode.ai/console/api/usage/cost-by-day',
    ].sort(),
  )
  assert.equal(calls.length, 3)
  for (const call of calls) {
    assert.equal(call.options.headers.authorization, `Bearer ${TOKEN}`)
    assert.equal(call.options.headers['x-org-id'], 'org-1')
  }
})

test('xAI SuperGrok verifies an active eligible subscription before requesting usage', async (t) => {
  const calls = await withFetch(t, async (url, options) => {
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`)
    if (url === 'https://grok.com/rest/subscriptions') {
      return response({
        subscriptions: [
          { status: 'SUBSCRIPTION_STATUS_ACTIVE', tier: 'SUBSCRIPTION_TIER_SUPER_GROK' },
        ],
      })
    }
    assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/billing?format=credits')
    return response({
      config: { creditUsagePercent: 35, currentPeriod: { type: 'BILLING_PERIOD_MONTHLY' } },
    })
  })

  const result = await runQuotaAdapter('xai-supergrok', TOKEN, new AbortController().signal)
  assert.deepEqual(result, {
    state: 'available',
    metrics: [
      {
        kind: 'provider_quota',
        used: 35,
        remaining: 65,
        unit: '%',
        label: 'SuperGrok billing period',
        period: 'billing period',
      },
    ],
  })
  assert.deepEqual(
    calls.map((call) => call.url),
    [
      'https://grok.com/rest/subscriptions',
      'https://cli-chat-proxy.grok.com/v1/billing?format=credits',
    ],
  )
})

test('xAI does not request billing usage without an active SuperGrok subscription', async (t) => {
  const calls = await withFetch(t, async () => response({ subscriptions: [] }))
  const result = await runQuotaAdapter('xai-supergrok', TOKEN, new AbortController().signal)
  assert.deepEqual(result, { reason: 'eligibility_unverified' })
  assert.deepEqual(
    calls.map((call) => call.url),
    ['https://grok.com/rest/subscriptions'],
  )
})

test('xAI missing credit usage is unavailable even when a billing period exists', async (t) => {
  const calls = await withFetch(t, async (url) => {
    if (url === 'https://grok.com/rest/subscriptions') {
      return response({
        subscriptions: [
          { status: 'SUBSCRIPTION_STATUS_ACTIVE', tier: 'SUBSCRIPTION_TIER_SUPER_GROK' },
        ],
      })
    }
    return response({ config: { currentPeriod: { type: 'BILLING_PERIOD_MONTHLY' } } })
  })

  const result = await runQuotaAdapter('xai-supergrok', TOKEN, new AbortController().signal)
  assert.deepEqual(result, { reason: 'provider_error' })
  assert.equal(calls.length, 2)
})

test('new adapter failures discard provider bodies and never echo the credential', async (t) => {
  const original = globalThis.fetch
  globalThis.fetch = async () => new Response(`${TOKEN} private provider detail`, { status: 500 })
  t.after(() => {
    globalThis.fetch = original
  })
  const result = await runQuotaAdapter('anthropic', TOKEN, new AbortController().signal)
  assert.deepEqual(result, { reason: 'provider_error' })
  assert.equal(JSON.stringify(result).includes(TOKEN), false)
})

test('new adapters use only matching listed credentials and projected OAuth metadata', async (t) => {
  const anthropicConnection = { type: 'credential', id: 'anthropic-login', method: 'oauth' }
  const agyConnection = { type: 'credential', id: 'agy-login', method: 'oauth' }
  const resolvedIds = []
  const events = {
    subscribe({ signal }) {
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
        },
      }
    },
  }
  let handler
  const context = {
    integration: {
      list: async () => ({
        data: [
          { id: 'anthropic', connections: [anthropicConnection] },
          { id: 'google-agy', connections: [agyConnection] },
          { id: 'unrelated', connections: [{ ...anthropicConnection, id: 'other-login' }] },
        ],
      }),
      connection: {
        active: async (integrationID) => {
          if (integrationID === 'anthropic') return anthropicConnection
          if (integrationID === 'google-agy') return agyConnection
          return undefined
        },
        resolve: async (selected) => {
          resolvedIds.push(selected.id)
          if (selected.id === 'anthropic-login') {
            return { type: 'oauth', methodID: 'oauth', access: TOKEN, metadata: {} }
          }
          assert.equal(selected.id, 'agy-login')
          return {
            type: 'oauth',
            methodID: 'oauth',
            access: TOKEN,
            metadata: { projectId: 'project-123', opaque: 'discard-this' },
          }
        },
      },
    },
    event: events,
    rpc: {
      register: async (_definition, handlers) => {
        handler = handlers.status
        return { dispose: async () => {} }
      },
    },
  }
  const requests = await withFetch(t, async (url, options) => {
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`)
    if (url === 'https://api.anthropic.com/api/oauth/usage') {
      return response({ five_hour: { utilization: 10 }, seven_day: { utilization: 20 } })
    }
    assert.equal(
      url,
      'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary',
    )
    assert.deepEqual(JSON.parse(options.body), { project: 'project-123' })
    return response({ buckets: [{ displayName: 'AGY', remainingFraction: 0.75 }] })
  })
  const cleanup = await createQuotaPlugin(async () => ({
    reason: 'cli_identity_unavailable',
  })).setup(context)
  t.after(cleanup)
  const result = await handler({}, { signal: new AbortController().signal })
  assert.deepEqual(resolvedIds, ['anthropic-login', 'agy-login'])
  assert.equal(result.providers.find((item) => item.provider === 'anthropic').state, 'available')
  assert.equal(result.providers.find((item) => item.provider === 'google-agy').state, 'available')
  assert.equal(requests.length, 2)
})

test('OAuth-only adapters omit API-key connections before resolving or requesting', async (t) => {
  const connection = { type: 'credential', id: 'anthropic-key', method: 'key' }
  let resolveCalls = 0
  const events = {
    subscribe({ signal }) {
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }))
        },
      }
    },
  }
  let handler
  const context = {
    integration: {
      list: async () => ({ data: [{ id: 'anthropic', connections: [connection] }] }),
      connection: {
        active: async (integrationID) => (integrationID === 'anthropic' ? connection : undefined),
        resolve: async () => {
          resolveCalls += 1
          return { type: 'key', key: TOKEN }
        },
      },
    },
    event: events,
    rpc: {
      register: async (_definition, handlers) => {
        handler = handlers.status
        return { dispose: async () => {} }
      },
    },
  }
  const calls = await withFetch(t, async () => response({}))
  const cleanup = await createQuotaPlugin(async () => ({
    reason: 'cli_identity_unavailable',
  })).setup(context)
  t.after(cleanup)
  const result = await handler({}, { signal: new AbortController().signal })
  assert.equal(
    result.providers.find((item) => item.provider === 'anthropic'),
    undefined,
  )
  assert.equal(resolveCalls, 0)
  assert.equal(calls.length, 0)
})
