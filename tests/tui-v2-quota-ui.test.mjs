import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

const bundlePath = join(process.cwd(), 'src/plugins/tui/dist/tui-v2.js')
const quotaUI = await import(pathToFileURL(bundlePath).href)

test('finance rows retain provider, zero, qualifiers and long values without truncation', () => {
  const snapshot = {
    providers: [
      {
        id: 'openrouter',
        label: 'OpenRouter',
        metrics: [
          {
            kind: 'key_usage',
            label: 'Spend',
            amount: 14.21,
            currency: 'USD',
            period: 'a very long provider reported period',
          },
        ],
      },
      {
        id: 'deepseek',
        label: 'DeepSeek',
        metrics: [
          { kind: 'balance', label: 'Saldo', amount: 0, currency: 'USD', status: 'low balance' },
        ],
      },
    ],
  }
  const entries = quotaUI.sidebarFinanceEntries(snapshot)
  const lines = entries.flatMap((entry) => quotaUI.financeMetricLines(entry.metric, 34))
  const text = lines.join(' ').replace(/\s+/g, ' ')
  assert.match(text, /14\.21 USD/)
  assert.match(text, /a very long provider reported period/)
  assert.match(text, /0 USD.*low balance/)
  assert.ok(lines.every((line) => line.length <= 34 && !line.includes('…')))
  assert.deepEqual(quotaUI.sidebarFinanceEntries({ providers: [] }), [])
})

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

test('quota countdown is deterministic at day, hour, minute, sub-minute, and expiry boundaries', () => {
  const now = 1_800_000_000_000
  const at = (duration) => quotaUI.formatQuotaCountdown(now + duration, now)

  assert.equal(at(25 * 60 * 60 * 1_000), '1d 1h')
  assert.equal(at(60 * 60 * 1_000), '1h')
  assert.equal(at(61 * 60 * 1_000), '1h 1m')
  assert.equal(at(2 * 60 * 1_000), '2m')
  assert.equal(at(59 * 1_000), '<1m')
  assert.equal(at(0), null)
  assert.equal(at(-1), null)
  assert.equal(quotaUI.formatQuotaCountdown(Number.NaN, now), undefined)
  assert.equal(quotaUI.formatQuotaCountdown(undefined, now), undefined)
  assert.equal(quotaUI.formatQuotaCountdown(now + 59_000, now), '<1m')
})

test('shared quota clock ticks locally and clears its timer after the last subscriber leaves', () => {
  let currentTime = 1_000
  let tick
  let scheduled = 0
  let cleared = 0
  const clock = quotaUI.createQuotaClock({
    now: () => currentTime,
    setInterval: (callback, delay) => {
      assert.equal(delay, 60_000)
      scheduled += 1
      tick = callback
      return scheduled
    },
    clearInterval: () => {
      cleared += 1
    },
  })
  const firstTimes = []
  const secondTimes = []
  const unsubscribeFirst = clock.subscribe((time) => firstTimes.push(time))
  const unsubscribeSecond = clock.subscribe((time) => secondTimes.push(time))

  assert.equal(scheduled, 1)
  assert.deepEqual(firstTimes, [1_000])
  assert.deepEqual(secondTimes, [1_000])
  currentTime += 60_000
  tick()
  assert.deepEqual(firstTimes, [1_000, 61_000])
  assert.deepEqual(secondTimes, [1_000, 61_000])

  unsubscribeFirst()
  assert.equal(cleared, 0)
  currentTime += 60_000
  tick()
  assert.deepEqual(firstTimes, [1_000, 61_000])
  assert.deepEqual(secondTimes, [1_000, 61_000, 121_000])
  unsubscribeSecond()
  assert.equal(cleared, 1)
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

test('OpenCode Go no-subscription state is shown explicitly', () => {
  const view = quotaUI.quotaSnapshotFromStatus({
    providers: [status('opencode-go', 'connected', 'not_subscribed', 'unavailable')],
  })

  assert.equal(view.details[0].message, 'sem assinatura OpenCode Go nesta conta')
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

  let clockNow = 1_000
  let tickClock
  const clockTimes = []
  const localClock = quotaUI.createQuotaClock({
    now: () => clockNow,
    setInterval: (tick) => {
      tickClock = tick
      return 1
    },
    clearInterval: () => {},
  })
  const unsubscribeClock = localClock.subscribe((time) => clockTimes.push(time))
  clockNow += 60_000
  tickClock()
  await new Promise((resolve) => setImmediate(resolve))
  unsubscribeClock()
  assert.deepEqual(clockTimes, [1_000, 61_000])
  assert.equal(calls.length, 1, 'a local countdown tick must not request provider status')

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

  const needsSetupUpdatedAt = runtime.snapshot().updatedAt
  await runtime.refresh()
  // A failed refresh keeps the last valid response (empty eligible list) instead of wiping it.
  assert.equal(runtime.snapshot().status, 'stale')
  assert.deepEqual(runtime.snapshot().providers, [])
  assert.equal(runtime.snapshot().updatedAt, needsSetupUpdatedAt)
  assert.match(String(runtime.snapshot().error ?? ''), /RPC unavailable/i)
  assert.doesNotThrow(() => quotaUI.quotaSnapshotStatusLabel(runtime.snapshot().status))
})

test('quota runtime preserves the last valid snapshot and logs the cause when the status request fails', async (t) => {
  const warnings = []
  const originalWarn = console.warn
  console.warn = (message) => warnings.push(String(message))
  t.after(() => {
    console.warn = originalWarn
  })
  const persisted = new Map()
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
  let statusCalls = 0
  const runtime = quotaUI.createQuotaRuntime({
    storage,
    location: undefined,
    data: { location: { default: () => ({ directory: '/workspace' }) } },
    client: {
      rpc() {
        return {
          async status() {
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
            throw new Error('HTTP request failed')
          },
        }
      },
    },
  })
  t.after(() => runtime.dispose())
  await new Promise((resolve) => setImmediate(resolve))

  const healthy = runtime.snapshot()
  assert.equal(healthy.status, 'ready')
  assert.equal(healthy.updatedAt === null, false)

  await runtime.refresh()

  const failed = runtime.snapshot()
  assert.equal(failed.status, 'stale')
  assert.deepEqual(failed.providers, healthy.providers)
  assert.deepEqual(failed.details, healthy.details)
  assert.equal(failed.updatedAt, healthy.updatedAt)
  assert.match(String(failed.error ?? ''), /HTTP request failed/i)
  assert.ok(
    warnings.some((line) => line.includes('[pantheon-tui quota]')),
    'the failure must be logged with the pantheon quota prefix',
  )
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
    ['e', 'm', 'r', 'escape,q', 'tab', 'shift+tab'],
  )
  panel.focused = true
  assert.equal(keymap.enabled(), true)
  await quotaUI.runQuotaPanelCommand('refresh', { focused: true, close() {} }, runtime)
  assert.equal(refreshes, 1)
  let closeCount = 0
  const closeCommand = quotaUI
    .quotaPanelKeymapLayer({ focused: true, close: () => closeCount++ }, runtime)
    .commands.find(({ bind }) => bind === 'escape,q')
  closeCommand.run()
  assert.equal(closeCount, 1)
})

test('quota panel tabs default to Limits and wrap in either keyboard direction', () => {
  assert.deepEqual(quotaUI.QUOTA_TABS, ['usage', 'limits', 'plugin', 'settings'])
  assert.equal(quotaUI.DEFAULT_QUOTA_TAB, 'limits')
  assert.equal(quotaUI.moveQuotaTab('limits', 1), 'plugin')
  assert.equal(quotaUI.moveQuotaTab('limits', -1), 'usage')
  assert.equal(quotaUI.moveQuotaTab('settings', 1), 'usage')
  assert.equal(quotaUI.moveQuotaTab('usage', -1), 'settings')

  const panel = { focused: false, close() {} }
  const runtime = {
    refresh: async () => {},
    toggleEnabled: async () => {},
    toggleDisplay: async () => {},
  }
  let selected = 'limits'
  const keymap = quotaUI.quotaPanelKeymapLayer(panel, runtime, (direction) => {
    selected = quotaUI.moveQuotaTab(selected, direction)
  })
  assert.deepEqual(
    keymap.commands.map(({ bind }) => bind),
    ['e', 'm', 'r', 'escape,q', 'tab', 'shift+tab'],
  )
  keymap.commands.find(({ bind }) => bind === 'tab').run()
  assert.equal(selected, 'limits', 'unfocused panel must not intercept Tab')
  panel.focused = true
  keymap.commands.find(({ bind }) => bind === 'tab').run()
  assert.equal(selected, 'plugin')
  keymap.commands.find(({ bind }) => bind === 'shift+tab').run()
  assert.equal(selected, 'limits')
})

test('quota panel header identifies the active chat model and warns only for partial quota status', () => {
  assert.equal(
    quotaUI.activeQuotaModelLabel({ providerID: 'openai', modelID: 'gpt-5', label: 'GPT-5' }),
    'Modelo ativo · openai/gpt-5',
  )
  assert.equal(quotaUI.quotaPanelStatusMessage({ status: 'ready' }), undefined)
  assert.equal(quotaUI.quotaPanelStatusMessage({ status: 'partial' }), 'Dados parciais')
  assert.notEqual(quotaUI.quotaPanelStatusMessage({ status: 'stale' }), 'Dados parciais')
})

test('quota window layout respects width, display mode and explicit reset only', () => {
  const metric = {
    kind: 'provider_quota',
    period: '5h',
    used: 2,
    remaining: 8,
    unit: 'requests',
    resetsAt: 3_600_000,
  }
  const wide = quotaUI.quotaWindowLines(metric, 'remaining', 48, 0)
  assert.match(wide.join(' '), /8 requests/)
  assert.match(wide.join(' '), /2 requests/)
  assert.match(wide.join(' '), /80% restante/)
  assert.match(wide.join(' '), /\(1h\)/)
  assert.ok(wide.some((line) => line.includes('Resets on 1970-01-01 01:00 UTC')))
  const sidebar = quotaUI.quotaWindowLines(
    { ...metric, unit: '%', used: 20, remaining: 80 },
    'remaining',
    34,
    0,
    true,
  )
  assert.ok(sidebar.some((line) => line.includes('Resets on 1970-01-01 01:00 UTC')))
  assert.ok(sidebar.every((line) => quotaUI.cellWidth(line) <= 34))
  assert.match(quotaUI.quotaWindowLines(metric, 'used', 48, 0).join(' '), /2 requests/)
  assert.ok(quotaUI.quotaWindowLines(metric, 'remaining', 24, 0).length >= 2)
  assert.ok(quotaUI.quotaWindowLines(metric, 'remaining', 10, 0).length >= 3)
  assert.doesNotMatch(
    quotaUI.quotaWindowLines({ ...metric, resetsAt: undefined }, 'remaining', 48, 0).join(' '),
    /\(/,
  )
  assert.doesNotMatch(
    quotaUI.quotaWindowLines({ ...metric, resetsAt: undefined }, 'remaining', 48, 0).join(' '),
    /Resets on/,
  )
  const expired = quotaUI.quotaWindowLines(metric, 'remaining', 48, 3_600_000).join(' ')
  assert.match(expired, /aguardando atualização/)
  assert.doesNotMatch(expired, /Resets on/)
  const emptyGauge = quotaUI.quotaWindowLines(
    { ...metric, used: 0, remaining: 100, resetsAt: undefined },
    'remaining',
    34,
    0,
    true,
  )
  assert.ok(emptyGauge.every((line) => !/[▰▱░▒▓█]/u.test(line)))
  assert.match(emptyGauge.join(' '), /100\s*%/)
})

function historyResult(overrides = {}) {
  return {
    status: 'available',
    period: '7d',
    coverageStart: '2026-10-21',
    partial: false,
    truncated: false,
    rows: 2,
    buckets: [
      {
        date: '2026-10-27',
        input: 400,
        output: 100,
        cacheRead: 0,
        cacheWrite: 0,
        total: 500,
        estimatedUsd: 0.012,
        pricingComplete: true,
      },
    ],
    totals: { input: 400, output: 100, cacheRead: 0, cacheWrite: 0, total: 500 },
    models: [
      {
        providerID: 'provider-a',
        modelID: 'model-one',
        totals: { input: 300, output: 50, cacheRead: 0, cacheWrite: 0, total: 350 },
        estimatedUsd: 0.01,
        pricingComplete: true,
      },
      {
        providerID: 'provider-b',
        modelID: 'model-two',
        totals: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, total: 150 },
        estimatedUsd: 0.002,
        pricingComplete: true,
      },
    ],
    pricing: {
      status: 'complete',
      complete: true,
      billed: false,
      estimatedUsd: 0.012,
      unpricedModels: 0,
    },
    ...overrides,
  }
}

test('usage history selector exposes all ranges and marks the selected period', () => {
  const label = quotaUI.usageHistorySelectorLabel('15d')
  assert.match(label, /7d/)
  assert.match(label, /\[15d\]/)
  assert.match(label, /30d/)
  assert.match(label, /\[?Total\]?/)
  assert.deepEqual(['7', '1', '3', 't'].map(quotaUI.usageHistoryPeriodForKey), [
    '7d',
    '15d',
    '30d',
    'total',
  ])
})

test('usage history reports coverage and warns only for RPC partial or truncation flags', () => {
  const complete = historyResult()
  assert.equal(quotaUI.usageHistoryCoverageLabel(complete), 'Cobertura desde 2026-10-21')
  assert.equal(quotaUI.usageHistoryPartialWarning(complete), null)
  assert.match(quotaUI.usageHistoryPricingLabel(complete), /não cobrada/i)

  const partial = historyResult({ partial: true, status: 'partial' })
  assert.match(quotaUI.usageHistoryPartialWarning(partial), /parcial/i)
  const truncated = historyResult({ truncated: true, status: 'partial' })
  assert.match(quotaUI.usageHistoryPartialWarning(truncated), /truncado/i)
  assert.match(
    quotaUI.usageHistoryCoverageLabel(historyResult({ coverageStart: null })),
    /início da cobertura indisponível/i,
  )
  assert.equal(
    quotaUI.usageHistoryUnavailableMessage({ status: 'unavailable', reason: 'history_timeout' }),
    'Consulta de histórico excedeu o tempo limite.',
  )
})

test('usage history chart includes daily overall totals and every provider/model total', () => {
  const lines = quotaUI.usageHistoryChartLines(historyResult(), 34)
  const chart = lines.join('\n')
  assert.match(chart, /Geral.*500 tokens/i)
  assert.match(chart, /2026-10-27/)
  assert.match(chart, /provider-a\/model-one/)
  assert.match(chart, /provider-b\/model-two/)
  assert.match(chart, /350 tokens/)
  assert.match(chart, /150 tokens/)
  assert.ok(lines.every((line) => quotaUI.cellWidth(line) <= 34))
  assert.match(quotaUI.usageHistoryEmptyMessage(), /sem histórico/i)
})

test('context estimate is explicit, pre-cache and separate from session-reported spend', () => {
  const estimate = quotaUI.activeContextEstimateLines(
    {
      status: 'estimated',
      estimatedUsd: 0.012345,
      billed: false,
      basis: 'pre-cache-context-tokens-times-input-price',
      cacheDiscountApplied: false,
    },
    34,
  )
  const estimateText = estimate.join(' ')
  assert.match(estimateText, /Estimativa de contexto \(pré-cache\)/i)
  assert.match(estimateText, /não é valor cobrado/i)
  assert.match(estimateText, /0\.012345/)
  assert.doesNotMatch(estimateText, /97%|desconto aplicado/i)

  const unavailable = quotaUI.activeContextEstimateLines(
    {
      status: 'unavailable',
      billed: false,
      basis: 'pre-cache-context-tokens-times-input-price',
      cacheDiscountApplied: false,
      reason: 'no-pricing',
    },
    34,
  )
  assert.match(unavailable.join(' '), /preço de entrada indisponível/i)
  assert.match(quotaUI.sessionSpendLabel(0.043), /Gasto da sessão \(relatado\).*\$0\.04/)
  assert.ok(estimate.every((line) => quotaUI.cellWidth(line) <= 34))
})

test('active chat model identity is explicit and history lines fit narrow panels', () => {
  assert.equal(
    quotaUI.activeModelIdentity({ providerID: 'provider-a', modelID: 'chat-model', label: 'Chat' }),
    'provider-a/chat-model',
  )
  const narrowLines = quotaUI.usageHistoryChartLines(historyResult(), 24)
  assert.ok(narrowLines.every((line) => quotaUI.cellWidth(line) <= 24))
  assert.match(narrowLines.join('\n'), /provider-a/)
  assert.match(narrowLines.join('\n'), /provider-b/)
  const selectorLines = quotaUI.usageHistorySelectorLines('total', 24)
  const pricingLines = quotaUI.usageHistoryTextLines(
    quotaUI.usageHistoryPricingLabel(historyResult()),
    24,
  )
  assert.ok(selectorLines.every((line) => quotaUI.cellWidth(line) <= 24))
  assert.ok(pricingLines.every((line) => quotaUI.cellWidth(line) <= 24))
  const empty = historyResult({
    rows: 0,
    buckets: [],
    models: [],
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  })
  assert.match(quotaUI.usageHistoryChartLines(empty, 24).join(' '), /sem histórico/i)
})

test('native usage-history panel renders coverage/models and selects periods from the keyboard', async (t) => {
  const rendererEntry = typeof Bun === 'undefined' ? 'index.js' : 'index.bun.js'
  const { testRender } = await import(
    pathToFileURL(
      join(process.cwd(), `src/plugins/tui/node_modules/@opentui/solid/${rendererEntry}`),
    ).href
  )
  const requests = []
  const layers = []
  const context = {
    client: {
      rpc: () => ({
        usage_history: async ({ period }) => {
          requests.push(period)
          return historyResult({ period })
        },
      }),
    },
    location: 'native-render-test',
    keymap: { layer: (factory) => layers.push(factory) },
  }
  const panel = { focused: true }
  let setup
  try {
    setup = await testRender(() => quotaUI.UsageHistorySection({ context, panel, width: 18 }), {
      width: 24,
      height: 44,
    })
  } catch (error) {
    const message = String(error)
    if (
      message.includes('OpenTUI native FFI is not available for this runtime yet') ||
      message.includes("Cannot find module '@opentui/core-win32-x64'")
    ) {
      t.skip('OpenTUI native rendering is unavailable for this runtime/platform.')
      return
    }
    throw error
  }

  try {
    await setup.waitFor(() => setup.captureCharFrame().includes('provider-a'))
    const initialFrame = setup.captureCharFrame()
    assert.match(initialFrame, /Cobertura desde 2026-10-21/)
    assert.match(initialFrame, /provider-a/)
    assert.match(initialFrame, /provider-b/)
    assert.doesNotMatch(initialFrame, /Dados parciais/)
    assert.ok(initialFrame.split('\n').every((line) => quotaUI.cellWidth(line) <= 24))

    const command = layers[0]().commands.find(({ bind }) => bind === '1')
    assert.ok(command)
    await command.run()
    await setup.waitFor(
      () => requests.includes('15d') && setup.captureCharFrame().includes('[15d]'),
    )
    assert.deepEqual(requests, ['7d', '15d'])
  } finally {
    setup.renderer.destroy()
  }
})

test('native quota tabs default to text-only Limits, expose usage/plugin/settings, and close on click', async (t) => {
  const rendererEntry = typeof Bun === 'undefined' ? 'index.js' : 'index.bun.js'
  const { testRender } = await import(
    pathToFileURL(
      join(process.cwd(), `src/plugins/tui/node_modules/@opentui/solid/${rendererEntry}`),
    ).href
  )
  const { createSignal } = await import('solid-js')
  const layers = []
  const historyRequests = []
  const [snapshot, setSnapshot] = createSignal({
    status: 'ready',
    providers: [],
    details: [
      {
        id: 'openai',
        label: 'OpenAI',
        authentication: 'connected',
        state: 'available',
        metrics: [
          {
            kind: 'provider_quota',
            period: '5h',
            used: 72,
            remaining: 28,
            unit: '%',
            resetsAt: Date.now() + 3_600_000,
          },
          {
            kind: 'provider_quota',
            period: 'weekly',
            used: 40,
            remaining: 60,
            unit: '%',
            resetsAt: Date.now() + 86_400_000,
          },
        ],
      },
    ],
    updatedAt: Date.now(),
  })
  const [preferences, setPreferences] = createSignal({ enabled: true, display: 'remaining' })
  const history = {
    status: 'available',
    period: '7d',
    coverageStart: '2026-10-21',
    partial: false,
    truncated: false,
    rows: 1,
    buckets: [
      {
        date: '2026-10-27',
        input: 50_000,
        output: 2_000,
        cacheRead: 0,
        cacheWrite: 0,
        total: 52_000,
        estimatedUsd: 0.123,
        pricingComplete: true,
      },
    ],
    totals: { input: 50_000, output: 2_000, cacheRead: 0, cacheWrite: 0, total: 52_000 },
    models: [
      {
        providerID: 'openai',
        modelID: 'gpt-5',
        totals: { input: 50_000, output: 2_000, cacheRead: 0, cacheWrite: 0, total: 52_000 },
        estimatedUsd: 0.123,
        pricingComplete: true,
      },
    ],
    pricing: {
      status: 'complete',
      complete: true,
      billed: false,
      estimatedUsd: 0.123,
      unpricedModels: 0,
    },
  }
  const context = {
    theme: {
      themeMode: 'dark',
      text: {
        base: '#ffffff',
        muted: '#999999',
        feedback: {
          info: { base: '#55aaff' },
          warning: { base: '#ffaa00' },
          error: { base: '#ff5555' },
          success: { base: '#55ff55' },
        },
      },
    },
    keymap: { layer: (factory) => layers.push(factory) },
    data: {
      on: () => () => {},
      session: {
        get: () => ({ model: { id: 'gpt-5', providerID: 'openai' } }),
        family: () => [],
        message: {
          list: () => [
            {
              type: 'assistant',
              model: { id: 'gpt-5', providerID: 'openai' },
              tokens: { input: 50_000, output: 2_000 },
              cost: 0.123,
            },
          ],
        },
      },
      location: {
        default: () => ({ directory: '/workspace' }),
        model: {
          list: () => [
            { id: 'gpt-5', modelID: 'gpt-5', providerID: 'openai', limit: { context: 100_000 } },
          ],
        },
      },
    },
    client: {
      rpc: () => ({
        usage_history: async ({ period }) => {
          historyRequests.push(period)
          return { ...history, period }
        },
        active_context_cost: async () => ({
          status: 'estimated',
          estimatedUsd: 0.25,
          billed: false,
          basis: 'pre-cache-context-tokens-times-input-price',
          cacheDiscountApplied: false,
        }),
      }),
    },
  }
  const runtime = {
    snapshot,
    preferences,
    refresh: async () => {},
    toggleEnabled: async () => setPreferences((value) => ({ ...value, enabled: !value.enabled })),
    toggleDisplay: async () =>
      setPreferences((value) => ({
        ...value,
        display: value.display === 'remaining' ? 'used' : 'remaining',
      })),
    dispose: () => {},
  }
  let closeCount = 0
  const panel = {
    name: quotaUI.QUOTA_PANEL_NAME,
    sessionID: 'ses-quota-panel-test',
    width: 48,
    focused: true,
    close: () => closeCount++,
  }
  let setup
  try {
    setup = await testRender(() => quotaUI.QuotaPanel({ context, runtime, panel }), {
      width: 48,
      height: 60,
    })
  } catch (error) {
    const message = String(error)
    if (
      message.includes('OpenTUI native FFI is not available for this runtime yet') ||
      message.includes("Cannot find module '@opentui/core-win32-x64'")
    ) {
      t.skip('OpenTUI native rendering is unavailable for this runtime/platform.')
      return
    }
    throw error
  }

  try {
    await setup.waitFor(() => setup.captureCharFrame().includes('5h'))
    const limitsFrame = setup.captureCharFrame()
    assert.match(limitsFrame, /Limits/)
    assert.match(limitsFrame, /Usage/)
    assert.match(limitsFrame, /Plugin/)
    assert.match(limitsFrame, /Settings/)
    assert.match(limitsFrame, /Modelo ativo · openai\/gpt-5/)
    assert.match(limitsFrame, /72\s*%|28\s*%/)
    assert.doesNotMatch(limitsFrame, /Dados parciais/)
    assert.doesNotMatch(limitsFrame, /[▰▱░▒▓█]/u)
    assert.ok(limitsFrame.split('\n').every((line) => quotaUI.cellWidth(line) <= 48))

    const keymap = layers[0]()
    const runTab = async (bind) => keymap.commands.find((command) => command.bind === bind).run()
    const pluginRow = limitsFrame.split('\n').findIndex((line) => line.includes('Plugin'))
    assert.notEqual(pluginRow, -1)
    const pluginColumn = limitsFrame.split('\n')[pluginRow].indexOf('Plugin') + 2
    await setup.mockMouse.click(pluginColumn, pluginRow)
    await setup.waitFor(() => setup.captureCharFrame().includes('PROVEDORES DETECTADOS'))
    const pluginFrame = setup.captureCharFrame()
    assert.match(pluginFrame, /Pantheon TUI v/)
    assert.match(pluginFrame, /OpenAI/)

    await runTab('tab')
    await runTab('tab')
    await setup.waitFor(() => setup.captureCharFrame().includes('[E] Quota'))
    assert.match(setup.captureCharFrame(), /\[M\] Exibir restante/)

    await runTab('tab')
    await setup.waitFor(() => setup.captureCharFrame().includes('Cobertura desde'))
    await setup.waitFor(() => setup.captureCharFrame().includes('Estimativa de contexto'))
    const usageFrame = setup.captureCharFrame()
    assert.match(usageFrame, /Gasto da sessão \(relatado\)/)
    assert.match(usageFrame, /openai\/gpt-5/)
    assert.match(usageFrame, /provider-a|openai/)
    assert.deepEqual(historyRequests, ['7d'])

    setSnapshot((value) => ({ ...value, status: 'partial' }))
    await setup.waitFor(() => setup.captureCharFrame().includes('Dados parciais'))
    assert.match(setup.captureCharFrame(), /Modelo ativo · openai\/gpt-5/)

    const frame = setup.captureCharFrame().split('\n')
    const closeRow = frame.findIndex((line) => line.includes('× Fechar'))
    assert.notEqual(closeRow, -1)
    const closeColumn = frame[closeRow].indexOf('× Fechar') + 2
    await setup.mockMouse.click(closeColumn, closeRow)
    assert.equal(closeCount, 1)
  } finally {
    setup.renderer.destroy()
  }
})

test('metric rows align values when possible and preserve long labels and states', () => {
  const short = quotaUI.quotaMetricLines(
    { kind: 'balance', label: 'Saldo', amount: 12, currency: 'USD' },
    34,
  )
  assert.equal(short[0], `  Saldo${' '.repeat(21)}12 USD`)
  for (const metric of [
    {
      kind: 'provider_status',
      label: 'Availability with a very long name',
      status: 'Unavailable with a long explanation',
    },
    {
      kind: 'session_usage',
      label: 'Session usage with a long scope',
      amount: 123456,
      unit: 'tokens',
    },
  ]) {
    const lines = quotaUI.quotaMetricLines(metric, 34)
    assert.ok(lines.every((line) => quotaUI.cellWidth(line) <= 34))
    assert.match(
      lines.join(' ').replace(/\s+/g, ' '),
      new RegExp(
        metric.kind === 'provider_status'
          ? 'Unavailable with a long explanation'
          : '123,456 tokens',
      ),
    )
  }
})

test('quota severity follows consumption and sidebar labels group consecutive provider windows', () => {
  assert.deepEqual([59, 60, 85, 86].map(quotaUI.quotaUsageTone), [
    'success',
    'warning',
    'warning',
    'error',
  ])
})

test('sidebar text and quota windows fit terminal cells without losing content', () => {
  const status = 'Credencial local conectada mas dados de quota estão indisponíveis agora'
  const heading = '提供者🚀'.repeat(12)
  for (const width of [10, 34]) {
    for (const text of [status, heading]) {
      const lines = quotaUI.quotaTextLines(text, width, 2)
      assert.ok(lines.every((line) => quotaUI.cellWidth(line) <= width))
      assert.equal(lines.join('').replace(/\s/g, ''), text.replace(/\s/g, ''))
    }
    const metric = {
      kind: 'provider_quota',
      period: 'Longタイトル'.repeat(5),
      used: 25,
      remaining: 75,
      unit: 'requests',
      resetsAt: 1000,
    }
    const lines = quotaUI.quotaWindowLines(metric, 'remaining', width, 1000, true)
    assert.ok(lines.every((line) => quotaUI.cellWidth(line) <= width))
    assert.match(lines.join('').replace(/\s/g, ''), /75%rest\./)
    assert.match(lines.join('').replace(/\s/g, ''), /aguardandoatualização/)
    const rawLines = quotaUI.quotaWindowLines(
      { ...metric, unit: '長い単位'.repeat(8) },
      'used',
      width,
      1000,
    )
    assert.ok(rawLines.every((line) => quotaUI.cellWidth(line) <= width))
    assert.match(rawLines.join('').replace(/\s/g, ''), /25長い単位/)
    const finance = quotaUI.financeMetricLines(
      { kind: 'balance', label: heading, amount: 12345, currency: 'USD' },
      width,
    )
    assert.ok(finance.every((line) => quotaUI.cellWidth(line) <= width))
  }
})

test('footer summary mirrors the fault-aware sidebar status labels', () => {
  const fault = 'rpc de quota indisponível no servidor'
  const unavailable = {
    status: 'unavailable',
    providers: [],
    details: [],
    updatedAt: null,
    error: fault,
  }
  assert.equal(quotaUI.snapshotSummary(unavailable, 'used'), `erro: ${fault}`)
  assert.equal(
    quotaUI.snapshotSummary(
      { status: 'unavailable', providers: [], details: [], updatedAt: null },
      'used',
    ),
    'status indisponível',
  )
  assert.equal(
    quotaUI.snapshotSummary(
      { status: 'stale', providers: [], details: [], updatedAt: null, error: fault },
      'used',
    ),
    'dados desatualizados',
  )
  assert.equal(
    quotaUI.snapshotSummary(
      { status: 'needs_setup', providers: [], details: [], updatedAt: null },
      'remaining',
    ),
    'nenhum provedor elegível',
  )

  const ready = quotaUI.quotaSnapshotFromStatus({
    providers: [
      status('chutes', 'connected', 'none', 'available', [
        { kind: 'provider_quota', used: 2, remaining: 8, unit: 'requests' },
      ]),
    ],
  })
  assert.match(quotaUI.snapshotSummary(ready, 'remaining'), /rest(?:ante|\.) 8 requests/)
})

test('quota tab and provider icons support ASCII fallback without shifting terminal columns', () => {
  const labels = { usage: 'Usage', limits: 'Limits', plugin: 'Plugin', settings: 'Settings' }

  assert.equal(quotaUI.quotaIcon('clock', 'ascii'), '(t)')
  assert.equal(quotaUI.quotaIcon('clock', 'unicode'), '🕒')
  for (const [tab, label] of Object.entries(labels)) {
    for (const mode of ['ascii', 'unicode']) {
      const text = quotaUI.quotaTabLabel(tab, mode)
      assert.ok(text.endsWith(label))
      assert.equal(quotaUI.cellWidth(text) - quotaUI.cellWidth(label), 4)
    }
  }
  for (const mode of ['ascii', 'unicode']) {
    const row = Object.keys(labels)
      .map((tab) => `${tab === 'limits' ? '› ' : '  '}${quotaUI.quotaTabLabel(tab, mode)}`)
      .join(' ')
    assert.ok(quotaUI.cellWidth(row) <= 54)
  }

  const states = [
    ['not_connected', 'unavailable', '*  Precisa configurar'],
    ['unavailable', 'unavailable', 'x  Indisponível'],
    ['connected', 'available', 'v  Credencial local · há dados'],
    ['connected', 'unavailable', '!  Credencial local · sem dados'],
  ]
  for (const [authentication, state, expected] of states) {
    assert.equal(quotaUI.providerState({ authentication, state }, 'ascii').label, expected)
  }
  for (const [authentication, state, text] of [
    ['not_connected', 'unavailable', 'Precisa configurar'],
    ['unavailable', 'unavailable', 'Indisponível'],
    ['connected', 'available', 'Credencial local · há dados'],
    ['connected', 'unavailable', 'Credencial local · sem dados'],
  ]) {
    const label = quotaUI.providerState({ authentication, state }, 'unicode').label
    assert.ok(label.endsWith(text))
    assert.equal(quotaUI.cellWidth(label) - quotaUI.cellWidth(text), 3)
  }
})
