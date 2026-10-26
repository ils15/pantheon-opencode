import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const bundlePath = join(process.cwd(), 'src/plugins/tui/dist/tui-v2.js')
const quotaUI = await import(pathToFileURL(bundlePath).href)

function status(provider, authentication, reason, state, metrics = [], routeKind) {
  return {
    provider,
    label: provider,
    scope: 'account',
    authentication,
    reason,
    state,
    metrics,
    ...(routeKind === undefined ? {} : { route_kind: routeKind }),
  }
}

test('quota status includes connected sources and preserves explicit unavailable status', () => {
  const view = quotaUI.quotaSnapshotFromStatus({
    providers: [
      status('anthropic', 'connected', 'unsupported', 'unavailable'),
      status('openai', 'not_connected', 'not_connected', 'needs_setup'),
    ],
  })

  assert.equal(view.status, 'connected_unavailable')
  assert.deepEqual(
    view.providers.map((provider) => provider.id),
    ['anthropic'],
  )
  assert.equal(view.providers[0].quotaState, 'unavailable')
  assert.equal(view.providers[0].metrics.length, 0)
  assert.equal(
    view.details.find((provider) => provider.id === 'openai').authentication,
    'not_connected',
  )
  assert.equal(typeof view.details.find((provider) => provider.id === 'openai').message, 'string')
})

test('credential resolution failure is unavailable while an empty eligible list needs setup', () => {
  const failed = quotaUI.quotaSnapshotFromStatus({
    providers: [],
    credential_resolution_failed: true,
  })
  const empty = quotaUI.quotaSnapshotFromStatus({ providers: [] })

  assert.equal(failed.status, 'unavailable')
  assert.equal(empty.status, 'needs_setup')
})

test('quota detail model contains only providers returned as eligible by the status RPC', () => {
  const view = quotaUI.quotaSnapshotFromStatus({
    providers: [
      status('anthropic', 'connected', 'unsupported', 'unavailable'),
      status('openai', 'connected', 'network_error', 'unavailable'),
    ],
  })

  assert.deepEqual(
    view.providers.map((provider) => provider.id),
    ['anthropic', 'openai'],
  )
  assert.deepEqual(
    view.details.map((provider) => provider.id),
    ['anthropic', 'openai'],
  )
  assert.equal(
    view.details.every((provider) => provider.authentication === 'connected'),
    true,
  )
  assert.equal(
    view.details.every((provider) => provider.state === 'unavailable'),
    true,
  )
})

test('an empty eligible-provider response has no synthesized provider cards', () => {
  const view = quotaUI.quotaSnapshotFromStatus({ providers: [] })

  assert.equal(view.status, 'needs_setup')
  assert.deepEqual(view.providers, [])
  assert.deepEqual(view.details, [])
})

test('model usage pins the active model, then ranks distinct recent models by reported tokens', () => {
  const messages = [
    {
      type: 'assistant',
      model: { id: 'chat', providerID: 'alpha' },
      tokens: { input: 100, output: 20 },
      cost: 0.01,
    },
    {
      type: 'assistant',
      model: { id: 'chat', providerID: 'alpha' },
      tokens: { input: 200, output: 30 },
      cost: 0.02,
    },
    {
      type: 'assistant',
      model: { id: 'expensive', providerID: 'beta' },
      tokens: { input: 300, output: 20 },
      cost: 10,
    },
    {
      type: 'assistant',
      model: { id: 'most-used', providerID: 'gamma' },
      tokens: { input: 5_000, output: 1_000 },
      cost: 0,
    },
    {
      type: 'assistant',
      model: { id: 'middle', providerID: 'delta' },
      tokens: { input: 2_000, output: 200 },
    },
  ]
  const rows = quotaUI.collectRecentModelUsageRows({
    activeModel: messages[0].model,
    activeMessages: messages.slice(0, 2),
    usageMessages: messages,
    models: [
      { id: 'chat', modelID: 'chat', providerID: 'alpha', limit: { context: 400_000 } },
      { id: 'expensive', modelID: 'expensive', providerID: 'beta', limit: { context: 128_000 } },
      { id: 'most-used', modelID: 'most-used', providerID: 'gamma' },
      { id: 'middle', modelID: 'middle', providerID: 'delta', limit: { context: 32_000 } },
    ],
  })

  assert.deepEqual(
    rows.map(({ providerID, modelID, tokens, cost, active }) => ({
      providerID,
      modelID,
      tokens,
      cost,
      active,
    })),
    [
      { providerID: 'alpha', modelID: 'chat', tokens: 350, cost: 0.03, active: true },
      { providerID: 'gamma', modelID: 'most-used', tokens: 6_000, cost: 0, active: false },
      { providerID: 'delta', modelID: 'middle', tokens: 2_200, cost: null, active: false },
    ],
  )
  assert.deepEqual(rows[0].context, { tokens: 230, percent: 0, limit: 400_000 })
  assert.equal(rows[1].context, null)
  assert.deepEqual(rows[2].context, { tokens: 2_200, percent: 7, limit: 32_000 })
})

test('model usage keeps a known active label when message or context data is unavailable', () => {
  const rows = quotaUI.collectRecentModelUsageRows({
    activeModel: { id: 'known-model', providerID: 'provider' },
    activeMessages: [],
    usageMessages: [],
    models: [],
  })

  assert.equal(rows.length, 1)
  assert.equal(rows[0].modelID, 'known-model')
  assert.equal(rows[0].active, true)
  assert.equal(rows[0].tokens, null)
  assert.equal(rows[0].cost, null)
  assert.equal(rows[0].context, null)
})

test('active session model wins over newer transcript models, with bounded transcript fallback', () => {
  const activeModel = { id: 'selected', providerID: 'provider-a' }
  const historical = { type: 'assistant', model: { id: 'historical', providerID: 'provider-b' } }
  const newer = { type: 'assistant', model: { id: 'newer', providerID: 'provider-c' } }

  assert.equal(
    quotaUI.resolveActiveModelRef(activeModel, [historical, newer]),
    activeModel,
    'the selected session model is authoritative over transcript messages',
  )
  assert.deepEqual(
    quotaUI.resolveActiveModelRef(null, [historical, newer]),
    newer.model,
    'the newest transcript model is used only when session.model is absent',
  )
  assert.deepEqual(
    quotaUI.resolveActiveModelRef(null, [], { id: 'agent-default', providerID: 'provider-d' }),
    { id: 'agent-default', providerID: 'provider-d' },
    'a configured fallback model is used when the transcript is empty',
  )
})

test('model usage treats the same model id from different providers as distinct rows', () => {
  const rows = quotaUI.collectRecentModelUsageRows({
    activeModel: { id: 'current', providerID: 'active-provider' },
    activeMessages: [],
    usageMessages: [
      {
        type: 'assistant',
        model: { id: 'shared', providerID: 'provider-a' },
        tokens: { input: 300 },
      },
      {
        type: 'assistant',
        model: { id: 'shared', providerID: 'provider-b' },
        tokens: { input: 200 },
      },
    ],
    models: [],
  })

  assert.deepEqual(
    rows.map(({ providerID, modelID }) => [providerID, modelID]),
    [
      ['active-provider', 'current'],
      ['provider-a', 'shared'],
      ['provider-b', 'shared'],
    ],
  )
})

test('active model context snapshots respect compaction and revert boundaries', () => {
  const model = { id: 'current', providerID: 'provider' }
  const messages = [
    { type: 'assistant', model, tokens: { input: 10_000 } },
    { type: 'compaction' },
    { type: 'assistant', model, tokens: { input: 400 } },
    { id: 'reverted-turn', type: 'assistant', model, tokens: { input: 900 } },
  ]
  const rows = quotaUI.collectRecentModelUsageRows({
    activeModel: model,
    activeMessages: messages,
    usageMessages: messages,
    models: [{ id: 'current', providerID: 'provider', limit: { context: 10_000 } }],
    revertMessageID: 'reverted-turn',
  })

  assert.deepEqual(rows[0].context, { tokens: 400, percent: 4, limit: 10_000 })
})

test('context snapshots are matched to the exact provider and model before showing a gauge', () => {
  const selected = { id: 'shared-model', providerID: 'provider-a' }
  const otherProvider = { id: 'shared-model', providerID: 'provider-b' }
  const rows = quotaUI.collectRecentModelUsageRows({
    activeModel: selected,
    activeMessages: [{ type: 'assistant', model: otherProvider, tokens: { input: 900 } }],
    usageMessages: [],
    models: [
      { id: 'shared-model', providerID: 'provider-a', limit: { context: 10_000 } },
      { id: 'shared-model', providerID: 'provider-b', limit: { context: 1_000 } },
    ],
  })

  assert.equal(
    rows[0].context,
    null,
    'same model id under another provider is not a context snapshot',
  )

  const unknownLimit = quotaUI.collectRecentModelUsageRows({
    activeModel: selected,
    activeMessages: [{ type: 'assistant', model: selected, tokens: { input: 900 } }],
    usageMessages: [],
    models: [{ id: 'shared-model', providerID: 'provider-b', limit: { context: 1_000 } }],
  })
  assert.equal(unknownLimit[0].context, null, 'a different provider limit cannot label this row')
})

test('active context uses only matching snapshots inside compaction and revert boundaries', () => {
  const selected = { id: 'selected', providerID: 'provider-a' }
  const other = { id: 'other', providerID: 'provider-b' }
  const messages = [
    { id: 'before', type: 'assistant', model: selected, tokens: { input: 10_000 } },
    { id: 'foreign-before', type: 'assistant', model: other, tokens: { input: 8_000 } },
    { id: 'compact', type: 'compaction' },
    { id: 'current', type: 'assistant', model: selected, tokens: { input: 400 } },
    { id: 'foreign-after', type: 'assistant', model: other, tokens: { input: 500 } },
    { id: 'reverted', type: 'assistant', model: selected, tokens: { input: 900 } },
  ]
  const rows = quotaUI.collectRecentModelUsageRows({
    activeModel: selected,
    activeMessages: messages,
    usageMessages: messages,
    models: [
      { id: 'selected', providerID: 'provider-a', limit: { context: 10_000 } },
      { id: 'other', providerID: 'provider-b', limit: { context: 1_000 } },
    ],
    revertMessageID: 'reverted',
  })

  assert.deepEqual(rows[0].context, { tokens: 400, percent: 4, limit: 10_000 })
})

test('model selection and usage ignore active-session messages older than the 400-message bound', () => {
  const outside = {
    type: 'assistant',
    model: { id: 'outside-window', providerID: 'provider' },
    tokens: { input: 50_000 },
  }
  const inside = Array.from({ length: 400 }, (_, index) => ({
    type: 'assistant',
    model: { id: 'inside-window', providerID: 'provider' },
    tokens: { input: 1 },
    time: { created: index + 1 },
  }))
  const messages = [outside, ...inside]
  const activeModel = quotaUI.resolveActiveModelRef(null, messages)
  const rows = quotaUI.collectRecentModelUsageRows({
    activeModel,
    activeMessages: messages,
    usageMessages: messages,
    usageSessions: [{ messages, revertMessageID: null }],
    models: [],
  })

  assert.equal(
    rows[0].modelID,
    'inside-window',
    'older transcript entries cannot select the pinned model',
  )
  assert.deepEqual(
    rows.map(({ modelID, tokens }) => [modelID, tokens]),
    [['inside-window', 400]],
    'older transcript entries cannot affect summed model usage or ranking',
  )
})

test('quota aggregate status reflects normalized connected metrics and partial availability', () => {
  const unavailable = quotaUI.quotaSnapshotFromStatus({
    providers: [status('anthropic', 'connected', 'unsupported', 'unavailable')],
  })
  const missingMetric = quotaUI.quotaSnapshotFromStatus({
    providers: [status('chutes', 'connected', 'none', 'available')],
  })
  const ready = quotaUI.quotaSnapshotFromStatus({
    providers: [
      status('chutes', 'connected', 'none', 'available', [
        { kind: 'provider_quota', used: 2, remaining: 8, unit: 'requests' },
      ]),
    ],
  })
  const partial = quotaUI.quotaSnapshotFromStatus({
    providers: [
      status('chutes', 'connected', 'none', 'available', [
        { kind: 'provider_quota', used: 2, remaining: 8, unit: 'requests' },
      ]),
      status('anthropic', 'connected', 'unsupported', 'unavailable'),
    ],
  })

  assert.equal(unavailable.status, 'connected_unavailable')
  assert.equal(missingMetric.status, 'connected_unavailable')
  assert.equal(missingMetric.providers[0].quotaState, 'unavailable')
  assert.equal(ready.status, 'ready')
  assert.equal(partial.status, 'partial')
  const unavailableLabel = quotaUI.quotaSnapshotStatusLabel(unavailable.status)
  const partialLabel = quotaUI.quotaSnapshotStatusLabel(partial.status)
  const readyLabel = quotaUI.quotaSnapshotStatusLabel(ready.status)
  assert.equal(typeof unavailableLabel, 'string')
  assert.notEqual(unavailableLabel, partialLabel)
  assert.notEqual(partialLabel, readyLabel)
})

test('quota status distinguishes setup-needed from a failed status source', () => {
  const setupNeeded = quotaUI.quotaSnapshotFromStatus({
    providers: [status('anthropic', 'not_connected', 'not_connected', 'needs_setup')],
  })
  const unavailable = quotaUI.quotaSnapshotFromStatus({
    providers: [status('anthropic', 'unavailable', 'provider_error', 'unavailable')],
  })

  assert.equal(setupNeeded.status, 'needs_setup')
  assert.equal(unavailable.status, 'unavailable')
  assert.deepEqual(setupNeeded.providers, [])
  assert.deepEqual(unavailable.providers, [])
  assert.equal(
    setupNeeded.details.find((provider) => provider.id === 'anthropic').authentication,
    'not_connected',
  )
})

test('quota detail gives distinct safe messages for diagnosed provider failures', () => {
  const reasons = [
    'unauthorized',
    'forbidden',
    'rate_limited',
    'timeout',
    'network_error',
    'provider_error',
    'invalid_response',
  ]
  const providers = [
    'anthropic',
    'chutes',
    'cursor',
    'github-copilot',
    'google-agy',
    'kilo-gateway',
    'nanogpt',
  ]
  const view = quotaUI.quotaSnapshotFromStatus({
    providers: reasons.map((reason, index) =>
      status(providers[index], 'connected', reason, 'unavailable'),
    ),
  })
  const messages = providers.map((id) => view.details.find((item) => item.id === id).message)

  assert.equal(
    messages.every((message) => typeof message === 'string'),
    true,
  )
  assert.equal(new Set(messages).size, reasons.length)
  assert.equal(JSON.stringify(messages).includes('private provider payload'), false)

  const unknown = quotaUI.quotaSnapshotFromStatus({
    providers: [status('opencode-go', 'connected', 'private provider payload', 'unavailable')],
  })
  assert.equal(
    unknown.details.find((item) => item.id === 'opencode-go').message.includes('private'),
    false,
  )
})

test('OpenCode Go request rejection does not claim the selected key is invalid', () => {
  const apiKeyView = quotaUI.quotaSnapshotFromStatus({
    providers: [status('opencode-go', 'connected', 'unauthorized', 'unavailable', [], 'api_key')],
  })
  const oauthView = quotaUI.quotaSnapshotFromStatus({
    providers: [
      status('opencode-go', 'connected', 'unauthorized', 'unavailable', [], 'console_oauth'),
    ],
  })

  assert.equal(apiKeyView.details[0].message, oauthView.details[0].message)
  assert.equal(apiKeyView.providers[0].message, apiKeyView.details[0].message)

  const unsupported = quotaUI.quotaSnapshotFromStatus({
    providers: [
      status('opencode-go', 'connected', 'unauthorized', 'unavailable', [], 'unsupported'),
    ],
  })
  assert.equal(
    unsupported.details[0].message,
    quotaUI.quotaSnapshotFromStatus({
      providers: [status('opencode-go', 'connected', 'unauthorized', 'unavailable')],
    }).details[0].message,
  )
})

test('quota metrics remain distinct and used/remaining selection changes the primary quota value', () => {
  const metric = {
    kind: 'provider_quota',
    used: 25,
    remaining: 75,
    unit: 'requests',
  }

  assert.equal(
    quotaUI.formatQuotaMetric(metric, 'remaining'),
    'Quota do provedor · restante 75 requests · usado 25 requests',
  )
  assert.equal(
    quotaUI.formatQuotaMetric(metric, 'used'),
    'Quota do provedor · usado 25 requests · restante 75 requests',
  )
  assert.equal(
    quotaUI.formatQuotaMetric(
      { kind: 'balance', amount: 12.5, currency: 'USD', status: 'ativo' },
      'remaining',
    ),
    'Saldo · 12.5 USD · ativo',
  )
  assert.equal(
    quotaUI.formatQuotaMetric({ kind: 'estimate', amount: 4, unit: 'hours' }, 'remaining'),
    'Estimativa · 4 hours',
  )
  assert.equal(
    quotaUI.formatQuotaMetric({ kind: 'session_usage', amount: 2400, unit: 'tokens' }, 'used'),
    'Uso da sessão · 2,400 tokens',
  )
  assert.equal(
    quotaUI.formatQuotaMetric(
      { kind: 'provider_status', status: 'available', label: 'Service status' },
      'remaining',
    ),
    'Service status · available',
  )
})

test('quota progress is derived only from valid non-negative provider quota values', () => {
  assert.deepEqual(
    quotaUI.quotaProgress({ kind: 'provider_quota', used: 25, remaining: 75, unit: 'requests' }),
    { usedPercent: 25, remainingPercent: 75 },
  )
  assert.equal(
    quotaUI.quotaProgress({ kind: 'provider_quota', used: 0, remaining: 0, unit: 'requests' }),
    undefined,
  )
  assert.equal(
    quotaUI.quotaProgress({ kind: 'provider_quota', used: -1, remaining: 2, unit: 'requests' }),
    undefined,
  )
})

test('sidebar quota entries include only connected providers and preserve each reported quota window', () => {
  const view = quotaUI.quotaSnapshotFromStatus({
    providers: [
      status('openai', 'connected', 'none', 'available', [
        {
          kind: 'provider_quota',
          used: 26,
          remaining: 74,
          unit: '%',
          label: 'ChatGPT quota',
          period: '5h',
        },
        {
          kind: 'provider_quota',
          used: 12,
          remaining: 88,
          unit: '%',
          label: 'Weekly quota',
          period: '7d',
        },
      ]),
      status('anthropic', 'not_connected', 'not_connected', 'needs_setup'),
      status('opencode-go', 'unavailable', 'provider_error', 'unavailable'),
    ],
  })

  assert.deepEqual(
    quotaUI
      .quotaSidebarEntries(view)
      .map((entry) => [entry.kind, entry.providerID, entry.metric.period]),
    [
      ['quota', 'openai', '5h'],
      ['quota', 'openai', '7d'],
    ],
  )
})

test('sidebar quota widget keeps every provider-reported window visible, including monthly and paired windows', () => {
  const view = quotaUI.quotaSnapshotFromStatus({
    providers: [
      status('openai', 'connected', 'none', 'available', [
        { kind: 'provider_quota', used: 10, remaining: 90, unit: '%', period: '5h' },
        { kind: 'provider_quota', used: 20, remaining: 80, unit: '%', period: '7d' },
        { kind: 'provider_quota', used: 30, remaining: 70, unit: '%', period: 'monthly' },
      ]),
      status('kimi-code-global', 'connected', 'none', 'available', [
        { kind: 'provider_quota', used: 40, remaining: 60, unit: '%', period: '5h' },
        { kind: 'provider_quota', used: 50, remaining: 50, unit: '%', period: '7d' },
        { kind: 'provider_quota', used: 6, remaining: 94, unit: '%', period: 'monthly' },
        { kind: 'key_usage', amount: 3.25, currency: 'USD', label: 'Spend' },
      ]),
      status('anthropic', 'not_connected', 'not_connected', 'needs_setup', [
        { kind: 'provider_quota', used: 1, remaining: 99, unit: '%', period: 'monthly' },
      ]),
    ],
  })

  const entries = quotaUI.quotaSidebarEntries(view)
  assert.deepEqual(
    entries.map((entry) => [entry.providerID, entry.metric.period]),
    [
      ['openai', '5h'],
      ['openai', '7d'],
      ['openai', 'monthly'],
      ['kimi-code-global', '5h'],
      ['kimi-code-global', '7d'],
      ['kimi-code-global', 'monthly'],
    ],
  )
  assert.equal(
    entries.some((entry) => entry.providerID === 'anthropic'),
    false,
  )
  assert.equal(
    entries.some((entry) => entry.kind === 'status' && entry.message.includes('Spend')),
    false,
  )
})

test('sidebar quota entries show safe status without inventing gauges and keep spend out of quota rows', () => {
  const view = quotaUI.quotaSnapshotFromStatus({
    providers: [
      status('opencode-go', 'connected', 'unauthorized', 'unavailable'),
      status('synthetic', 'connected', 'none', 'available', [
        { kind: 'provider_quota', used: -1, remaining: 2, unit: '%' },
      ]),
      status('openrouter', 'connected', 'none', 'available', [
        { kind: 'key_usage', amount: 3.25, currency: 'USD', label: 'Selected key spend' },
      ]),
    ],
  })
  const entries = quotaUI.quotaSidebarEntries(view)

  assert.deepEqual(
    entries.map(({ message, ...entry }) => entry),
    [
      {
        kind: 'status',
        key: 'opencode-go:status',
        providerID: 'opencode-go',
        providerLabel: 'opencode-go',
      },
      {
        kind: 'status',
        key: 'synthetic:status',
        providerID: 'synthetic',
        providerLabel: 'synthetic',
      },
    ],
  )
  assert.equal(typeof entries[0].message, 'string')
  assert.equal(typeof entries[1].message, 'string')
  assert.equal(
    quotaUI.compactQuotaMetric(
      view.providers.find((provider) => provider.id === 'openrouter').metrics[0],
      'remaining',
    ),
    'Selected key spend 3.25 USD',
  )
})

test('quota status retains normalized balance and selected-key usage metrics', () => {
  const view = quotaUI.quotaSnapshotFromStatus({
    providers: [
      status('openrouter', 'connected', 'none', 'available', [
        { kind: 'key_usage', amount: 3.25, currency: 'USD', label: 'Selected key spend' },
      ]),
    ],
  })
  assert.deepEqual(view.providers[0].metrics, [
    { kind: 'key_usage', amount: 3.25, currency: 'USD', label: 'Selected key spend' },
  ])
  assert.equal(view.providers[0].quotaState, 'available')
})

test('quota preferences default to enabled and remaining, and invalid persisted values are safe', () => {
  assert.deepEqual(quotaUI.DEFAULT_QUOTA_PREFERENCES, { enabled: true, display: 'remaining' })
  assert.deepEqual(quotaUI.normalizeQuotaPreferences({ enabled: false, display: 'used' }), {
    enabled: false,
    display: 'used',
  })
  assert.deepEqual(quotaUI.normalizeQuotaPreferences({ enabled: 'false', display: 'balance' }), {
    enabled: true,
    display: 'remaining',
  })
})

test('quota runtime shares persisted preferences and stops status calls while disabled', async (t) => {
  const persisted = new Map()
  const calls = []
  const location = { directory: '/workspace/quota-project', workspaceID: 'workspace-1' }
  let requestOptions
  let definition
  const storage = {
    store(key, { initial }) {
      if (!persisted.has(key)) persisted.set(key, { ...initial })
      const value = persisted.get(key)
      return [value, async (mutate) => mutate(value)]
    },
    memory(key, { initial }) {
      if (!persisted.has(key)) persisted.set(key, { ...initial })
      const value = persisted.get(key)
      return [value, (mutate) => mutate(value)]
    },
  }
  const context = {
    storage,
    location,
    data: { location: { default: () => ({ directory: '/workspace/default-project' }) } },
    client: {
      rpc(rpcDefinition) {
        definition = rpcDefinition
        return {
          async status(_input, options) {
            calls.push('status')
            requestOptions = options
            return {
              providers: [
                status('anthropic', 'connected', 'unsupported', 'unavailable'),
                status('openai', 'not_connected', 'not_connected', 'needs_setup'),
              ],
            }
          },
        }
      },
    },
  }
  const runtime = quotaUI.createQuotaRuntime(context)
  t.after(() => runtime.dispose())
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(definition.id, 'pantheon.quota')
  assert.deepEqual(requestOptions.location, location)
  assert.ok(requestOptions.signal instanceof AbortSignal)
  assert.equal(runtime.preferences().enabled, true)
  assert.equal(runtime.preferences().display, 'remaining')
  assert.equal(runtime.snapshot().status, 'connected_unavailable')
  assert.deepEqual(
    runtime.snapshot().providers.map((provider) => provider.id),
    ['anthropic'],
  )

  await runtime.toggleDisplay()
  assert.equal(runtime.preferences().display, 'used')
  await runtime.toggleEnabled()
  assert.equal(runtime.preferences().enabled, false)
  assert.equal(runtime.snapshot().status, 'disabled')
  assert.equal(calls.length, 1)

  await runtime.toggleEnabled()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runtime.preferences().enabled, true)
  assert.equal(runtime.preferences().display, 'used')
  assert.equal(calls.length, 2)
})

test('quota runtime clears old provider rows after removal and resolver request failures', async (t) => {
  const persisted = new Map()
  const defaultLocation = { directory: '/workspace/default-project' }
  let requestLocation
  let statusCalls = 0
  let credentialChanged
  const storage = {
    store(key, { initial }) {
      if (!persisted.has(key)) persisted.set(key, { ...initial })
      const value = persisted.get(key)
      return [value, async (mutate) => mutate(value)]
    },
    memory(key, { initial }) {
      if (!persisted.has(key)) persisted.set(key, { ...initial })
      const value = persisted.get(key)
      return [value, (mutate) => mutate(value)]
    },
  }
  const runtime = quotaUI.createQuotaRuntime({
    storage,
    location: undefined,
    data: { location: { default: () => defaultLocation } },
    client: {
      rpc() {
        return {
          events: {
            on(name, handler) {
              assert.equal(name, 'credentials_changed')
              credentialChanged = handler
              return () => {}
            },
          },
          async status(_input, options) {
            requestLocation = options.location
            statusCalls += 1
            if (statusCalls === 1) {
              return {
                providers: [
                  status('deepseek', 'connected', 'none', 'available', [
                    { kind: 'balance', amount: 1, currency: 'USD', label: 'Balance' },
                  ]),
                ],
              }
            }
            if (statusCalls === 2) return { providers: [] }
            throw new Error('RPC unavailable')
          },
        }
      },
    },
  })
  t.after(() => runtime.dispose())
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(requestLocation, defaultLocation)
  assert.equal(runtime.snapshot().status, 'ready')

  credentialChanged()
  assert.equal(runtime.snapshot().status, 'loading')
  assert.deepEqual(runtime.snapshot().providers, [])
  assert.deepEqual(runtime.snapshot().details, [])
  for (let attempt = 0; attempt < 20 && statusCalls < 2; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(runtime.snapshot().status, 'needs_setup')
  assert.deepEqual(runtime.snapshot().providers, [])

  await runtime.refresh()
  assert.equal(runtime.snapshot().status, 'unavailable')
  assert.deepEqual(runtime.snapshot().providers, [])
  assert.doesNotThrow(() => quotaUI.quotaSnapshotStatusLabel(runtime.snapshot().status))
})

test('quota runtime discards legacy cached provider cards until the eligible RPC result arrives', (t) => {
  const legacySnapshot = {
    status: 'ready',
    providers: [{ id: 'hidden-provider' }],
    details: [{ id: 'hidden-provider' }],
    updatedAt: Date.now(),
  }
  const storage = {
    store(_key, { initial }) {
      return [{ ...initial }, async () => {}]
    },
    memory(storageName, { initial }) {
      const value = storageName === 'pantheon.quota.live.v1' ? legacySnapshot : initial
      return [value, (mutate) => mutate(value)]
    },
  }
  const runtime = quotaUI.createQuotaRuntime({
    storage,
    location: undefined,
    data: { location: { default: () => ({ directory: '/workspace' }) } },
    client: {
      rpc() {
        return { status: () => new Promise(() => {}) }
      },
    },
  })
  t.after(() => runtime.dispose())

  assert.equal(runtime.snapshot().status, 'loading')
  assert.deepEqual(runtime.snapshot().providers, [])
  assert.deepEqual(runtime.snapshot().details, [])
})

test('quota slash/palette command opens its details panel and focused actions do not steal composer keys', async () => {
  let opened
  const command = quotaUI.quotaOpenCommand({
    ui: {
      panel: {
        open(name) {
          opened = name
          return true
        },
      },
    },
  })
  assert.equal(command.id, 'pantheon.quota.open')
  assert.equal(command.palette, true)
  assert.deepEqual(command.slash, { name: 'quota', aliases: ['pantheon-quota'] })
  command.run()
  assert.equal(opened, quotaUI.QUOTA_PANEL_NAME)
  let toast
  assert.equal(
    quotaUI.openQuotaPanel({
      ui: {
        panel: { open: () => false },
        toast: {
          show: (notice) => {
            toast = notice
          },
        },
      },
    }),
    false,
  )
  assert.equal(toast.variant, 'warning')

  let refreshes = 0
  const runtime = {
    refresh: async () => {
      refreshes += 1
    },
    toggleEnabled: async () => {},
    toggleDisplay: async () => {},
  }
  const unfocused = quotaUI.runQuotaPanelCommand('refresh', { focused: false, close() {} }, runtime)
  assert.equal(unfocused, false)
  assert.equal(refreshes, 0)
  const panel = { focused: false, close() {} }
  const keymap = quotaUI.quotaPanelKeymapLayer(panel, runtime)
  assert.equal(keymap.enabled(), false)
  assert.deepEqual(
    keymap.commands.map((item) => item.bind),
    ['e', 'm', 'r', 'escape,q'],
  )
  panel.focused = true
  assert.equal(keymap.enabled(), true)
  await quotaUI.runQuotaPanelCommand('refresh', { focused: true, close() {} }, runtime)
  assert.equal(refreshes, 1)
})
