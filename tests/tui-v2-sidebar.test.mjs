/**
 * Focused tests for the OpenCode V2 TUI sidebar bundle (dist/tui-v2.js).
 *
 * The packaged V2 plugin is imported with a fake `context` — the same pattern
 * as tests/tui-packaged-smoke.test.mjs — so no OpenCode TUI runtime is needed.
 * Assertions cover the logic ported from the V1 sidebar: preset resolution,
 * the active-session line, running-only delegation filtering and formatting
 * (tone / elapsed / marker / "+N"), the empty-initial-state guard behind the
 * Known Issue, the completion tracker that feeds the toasts, click-through
 * routing, and the eager warm-up the plugin performs at setup.
 *
 * They also drive the reactive model (`createSidebarModel`) inside a Solid root
 * with a fake host: the refresh subscription only uses names from the OpenCode
 * V2 event union, one toast fires per running→terminal transition and none at
 * mount, the spinner is armed only while a child runs, terminal delegations
 * are filtered out of the rendered set, and teardown calls every unsubscribe
 * the host handed out.
 *
 * The Todo block has no host API of its own: its rows are derived from the
 * newest completed `todowrite` part in the active session's transcript, inside
 * the same `message.list` walk that feeds the per-model cost rows.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

/* Under `node --test` the bare `solid-js` specifier resolves to the SSR build,
 * where `createEffect`/`onMount` are no-ops and no subscription would ever be
 * registered. Map it to the client build so the model's effects really run. */
function resolveSolidClientUrl() {
  const candidates = [
    new URL('../node_modules/solid-js/dist/solid.js', import.meta.url),
    new URL('../src/plugins/tui/node_modules/solid-js/dist/solid.js', import.meta.url),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate.href
  throw new Error('solid-js client build not found — cannot exercise sidebar effects')
}

const solidClientUrl = resolveSolidClientUrl()
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'solid-js') return { url: solidClientUrl, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const { createRoot, createSignal } = await import('solid-js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** One live Dispatch row, columns exactly as the view builds them. */
const toCell = (agent, model, cost, duration) =>
  `\u280B ${agent.padEnd(12)} ${model.padEnd(7)} ${cost.padStart(5)} ${duration.padStart(5)}`

/** A rendered line that must carry either a money amount or the explicit em
 *  dash the view uses when the host published no numeric cost. */
const hasMoney = (line) => /\$|\u2014/.test(line)

/** One context row flattened the way the sidebar renders it. Test-local: the
 *  plugin derives the string from the row's own cells, so nothing in production
 *  needs (or exports) this composition. */
const contextRowText = (row) =>
  row === null || row === undefined
    ? null
    : `${row.lead ?? ''}${row.tail ?? ''}${row.value}${row.suffix ?? ''}`

async function loadV2() {
  return import(pathToFileURL(join(root, 'src/plugins/tui/dist/tui-v2.js')).href)
}

/* ─── OpenCode V2 event union ─────────────────────────────
 * The refresh subscription must only use names the host actually publishes.
 * `session.updated` (the V1 name) is NOT one of them — reading the generated
 * union keeps that honest instead of trusting a snapshot. */

/** Documented snapshot of the V2 `session.*` event names, used when the
 *  installed `@opencode/client` generated types cannot be located. */
const V2_SESSION_EVENTS = new Set([
  'session.agent.selected',
  'session.compaction.delta',
  'session.compaction.ended',
  'session.compaction.failed',
  'session.compaction.started',
  'session.created',
  'session.deleted',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.execution.started',
  'session.execution.succeeded',
  'session.forked',
  'session.idle',
  'session.inbox.cancelled',
  'session.inbox.delivered',
  'session.inbox.delivery.changed',
  'session.inbox.enqueued',
  'session.instructions.updated',
  'session.message.content.updated',
  'session.metadata.updated',
  'session.model.selected',
  'session.moved',
  'session.permissions',
  'session.reasoning.delta',
  'session.reasoning.ended',
  'session.reasoning.started',
  'session.renamed',
  'session.retry.scheduled',
  'session.revert.cleared',
  'session.revert.committed',
  'session.revert.staged',
  'session.shell.ended',
  'session.shell.started',
  'session.skill.activated',
  'session.status',
  'session.step.ended',
  'session.step.failed',
  'session.step.started',
  'session.step.streamed',
  'session.synthetic',
  'session.text.delta',
  'session.text.ended',
  'session.text.started',
  'session.tool.called',
  'session.tool.failed',
  'session.tool.input.delta',
  'session.tool.input.ended',
  'session.tool.input.started',
  'session.tool.progress',
  'session.tool.success',
  'session.usage.recorded',
  'session.usage.updated',
  'session.viewed',
])

/** Event names read out of the installed `@opencode/client` generated types,
 *  or null when that file is not where a hoisted/nested layout puts it. */
function readInstalledEventUnion() {
  const clients = [
    join(root, 'src/plugins/tui/node_modules/@opencode/plugin/node_modules/@opencode/client'),
    join(root, 'src/plugins/tui/node_modules/@opencode/client'),
    join(root, 'node_modules/@opencode/plugin/node_modules/@opencode/client'),
    join(root, 'node_modules/@opencode/client'),
  ].find((dir) => existsSync(join(dir, 'package.json')))
  if (clients === undefined) return null

  const pkg = JSON.parse(readFileSync(join(clients, 'package.json'), 'utf8'))
  const typesEntry = pkg.exports?.['.']?.types
  if (typeof typesEntry !== 'string') return null

  const generated = join(clients, dirname(typesEntry), 'generated', 'types.d.ts')
  if (!existsSync(generated)) return null

  const names = new Set()
  for (const match of readFileSync(generated, 'utf8').matchAll(
    /\btype:\s*"([a-z][a-zA-Z0-9.]*)"/g,
  )) {
    names.add(match[1])
  }
  return names.size > 0 ? names : null
}

/* ─── Fake sidebar host ───────────────────────────────────
 * A minimal `context`: only the surface `createSidebarModel` touches. */

function createSidebarHost(options = {}) {
  const registered = new Map()
  const unsubscribed = []
  const toasts = []
  const children = new Map(options.children ?? [])
  const statuses = new Map(options.statuses ?? [])
  const family = [...(options.family ?? [])]
  const messages = new Map(options.messages ?? [])
  const models = options.models ?? []
  const agents = options.agents ?? []
  const costs = new Map(options.costs ?? [])
  /* A host that publishes an event outside the V2 union is a bug, not a
   * tolerated drift — fail loudly so a typo cannot hide as a no-op. */
  const known = options.knownEvents ?? V2_SESSION_EVENTS
  const returnsUnsubscribe = options.returnsUnsubscribe ?? true

  const context = {
    location: { directory: options.directory ?? tmpdir() },
    ...(options.client === undefined ? {} : { client: options.client }),
    data: {
      location: {
        vcs: {
          sync: async () => {},
          info:
            options.vcs === undefined ? () => ({ branch: { current: 'main' } }) : () => options.vcs,
        },
        model: { list: () => models },
        agent: { list: () => agents },
      },
      session: {
        get: (id) => children.get(id),
        family: () => family.slice(),
        status: (id) => statuses.get(id),
        cost: (id) => costs.get(id) ?? 0,
        sync: async () => {},
        message: { list: (id) => messages.get(id) ?? [], sync: async () => {} },
      },
      on: (type, handler) => {
        if (!known.has(type)) throw new Error(`unknown V2 event subscribed: ${type}`)
        registered.set(type, handler)
        return returnsUnsubscribe ? () => unsubscribed.push(type) : undefined
      },
    },
    ui: { toast: { show: (options) => toasts.push(options) }, router: { navigate: () => {} } },
  }

  return {
    context,
    registered,
    unsubscribed,
    toasts,
    emit: (type) => registered.get(type)?.(),
    setChild: (id, child) => children.set(id, child),
    setStatus: (id, status) => statuses.set(id, status),
    setMessages: (id, list) => messages.set(id, list),
    setFamily: (ids) => {
      family.length = 0
      family.push(...ids)
    },
  }
}

/** Run `fn` with an isolated XDG_CONFIG_HOME so the active-preset file leg can
 *  never read the developer's real ~/.config candidate. */
async function withIsolatedXdg(fn) {
  const previous = process.env.XDG_CONFIG_HOME
  const isolated = mkdtempSync(join(tmpdir(), 'pantheon-xdg-'))
  process.env.XDG_CONFIG_HOME = isolated
  try {
    return await fn(isolated)
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous
    rmSync(isolated, { recursive: true, force: true })
  }
}

test('preset resolution: env beats file, malformed/none fall back to default', async () => {
  const { presetFromEnv, resolveActivePresetForTui } = await loadV2()

  assert.deepEqual(presetFromEnv({ PANTHEON_MODEL_PRESET: 'max' }), {
    name: 'max',
    source: 'env',
  })
  assert.deepEqual(presetFromEnv({}), { name: null, source: null })
  assert.deepEqual(presetFromEnv({ PANTHEON_MODEL_PRESET: 'none' }), { name: null, source: null })
  assert.deepEqual(presetFromEnv({ PANTHEON_MODEL_PRESET: '' }), { name: null, source: null })

  await withIsolatedXdg(async () => {
    const project = mkdtempSync(join(tmpdir(), 'pantheon-preset-'))
    try {
      const dir = join(project, '.pantheon')
      mkdirSync(dir, { recursive: true })

      // No file → default.
      assert.deepEqual((await resolveActivePresetForTui({}, project)).info, {
        name: null,
        source: null,
      })

      // File wins when env is unset.
      writeFileSync(join(dir, 'active-preset.json'), JSON.stringify({ preset: 'pro' }))
      assert.deepEqual((await resolveActivePresetForTui({}, project)).info, {
        name: 'pro',
        source: 'file',
      })

      // Env still wins over the file.
      assert.deepEqual(
        (await resolveActivePresetForTui({ PANTHEON_MODEL_PRESET: 'max' }, project)).info,
        {
          name: 'max',
          source: 'env',
        },
      )

      // "none" in the file disables the preset.
      writeFileSync(join(dir, 'active-preset.json'), JSON.stringify({ preset: 'none' }))
      assert.deepEqual((await resolveActivePresetForTui({}, project)).info, {
        name: null,
        source: null,
      })

      // Malformed JSON degrades to default rather than throwing.
      writeFileSync(join(dir, 'active-preset.json'), '{ not json')
      assert.deepEqual((await resolveActivePresetForTui({}, project)).info, {
        name: null,
        source: null,
      })
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})

test('header: the self-promo line is gone; the preset row carries the provider', async () => {
  const { presetHeaderLine } = await loadV2()
  const source = readFileSync(join(root, 'src/plugins/tui/src/index-v2.tsx'), 'utf8')

  assert.equal(
    source.includes('OpenCode V2 · plugin TUI ativo'),
    false,
    'the static self-promotion line is removed, not reworded',
  )
  assert.equal(source.includes('plugin TUI ativo'), false, 'no variant of that line survives')

  assert.equal(presetHeaderLine('go-free', 'opencode'), '▸ go-free · opencode')
  assert.equal(
    presetHeaderLine('go-free', null),
    '▸ go-free',
    'no provider resolves → the preset alone, never `unknown`',
  )
  assert.equal(presetHeaderLine('go-free', ''), '▸ go-free', 'an empty id is treated as absent')

  const longProvider = presetHeaderLine('go-free', 'a-very-long-provider-identifier')
  assert.ok(longProvider.length <= 34, 'the preset row stays inside 34 columns')
  assert.ok(
    longProvider.startsWith('▸ go-free · '),
    'the provider is cut first, the preset survives',
  )

  const longPreset = presetHeaderLine('a'.repeat(60), 'opencode')
  assert.ok(longPreset.length <= 34, 'an oversized preset never wraps the sidebar')
  assert.equal(longPreset.includes('opencode'), false, 'the provider goes before the preset does')
})

test('sidebar provider: session model → last assistant → location agent/model → omitted', async () => {
  const { createSidebarModel } = await loadV2()
  const now = Date.now()
  const providerFor = (options = {}) => {
    const host = createSidebarHost({
      family: ['ses_root'],
      children: [
        [
          'ses_root',
          {
            id: 'ses_root',
            title: 'root',
            time: { created: now, updated: now },
            ...options.session,
          },
        ],
      ],
      messages: [['ses_root', options.messages ?? []]],
      agents: options.agents ?? [],
      models: options.models ?? [],
    })
    let model
    const dispose = createRoot((disposeRoot) => {
      model = createSidebarModel(host.context, () => 'ses_root')
      return disposeRoot
    })
    try {
      return model.provider()
    } finally {
      dispose()
    }
  }

  assert.equal(
    providerFor({
      session: { model: { providerID: 'opencode', modelID: 'kimi-k3' } },
      messages: [
        { id: 'm1', type: 'assistant', model: { providerID: 'anthropic', modelID: 'opus' } },
      ],
    }),
    'opencode',
    'the session model wins over the transcript',
  )

  assert.equal(
    providerFor({
      messages: [
        { id: 'm1', type: 'assistant', model: { providerID: 'anthropic', modelID: 'opus' } },
        { id: 'm2', type: 'assistant', model: { providerID: 'opencode-go', modelID: 'kimi-k3' } },
      ],
    }),
    'opencode-go',
    'the newest assistant message wins when the session has no model',
  )

  assert.equal(
    providerFor({
      session: { agent: 'zeus' },
      agents: [{ id: 'zeus', model: { providerID: 'deepseek', modelID: 'deepseek-v4.1-flash' } }],
    }),
    'deepseek',
    'the agent model from location.agent.list() is the last resort',
  )

  assert.equal(
    providerFor({
      session: { agent: 'zeus' },
      agents: [{ id: 'zeus', model: 'deepseek/deepseek-v4.1-flash' }],
      models: [
        {
          id: 'deepseek-v4.1-flash',
          modelID: 'deepseek-v4.1-flash',
          providerID: 'deepseek',
        },
      ],
    }),
    'deepseek',
    'a bare string agent model resolves its provider through location.model.list()',
  )

  assert.equal(providerFor(), null, 'nothing resolves → omitted, never `unknown`')
  assert.equal(
    providerFor({ session: { agent: 'zeus' }, agents: [{ id: 'zeus', model: 'mystery/model' }] }),
    null,
    'an unlisted model invents no provider',
  )
})

test('delegation view: state from status + outcome, grace window, label fallbacks', async () => {
  const { toDelegationView, delegationStateFromOutcome } = await loadV2()

  const running = toDelegationView(
    { id: 'ses_child', title: 'apo-1', time: { created: 1_000, updated: 4_000 } },
    'running',
  )
  assert.deepEqual(running, {
    id: 'ses_child',
    label: 'apo-1',
    state: 'running',
    startedAt: 1_000,
    updatedAt: 4_000,
    agent: null,
    model: null,
    cost: null,
    kind: null,
    kindOrigin: 'unavailable',
    background: false,
  })

  // The spawning `subagent` call adds the purpose and the background flag; the
  // rest of the row is unchanged, so a call can only ever *add* evidence.
  const classified = toDelegationView(
    { id: 'ses_call', title: 'scout', agent: 'apollo', time: { created: 1_000, updated: 4_000 } },
    'running',
    undefined,
    { sessionID: 'ses_call', agent: 'apollo', description: '[review] audit', background: true },
  )
  assert.deepEqual(classified, {
    id: 'ses_call',
    label: 'scout',
    state: 'running',
    startedAt: 1_000,
    updatedAt: 4_000,
    agent: 'apollo',
    model: null,
    cost: null,
    kind: 'revw',
    kindOrigin: 'prefix',
    background: true,
  })

  const failed = toDelegationView(
    { id: 'ses_fail', agent: 'apollo', outcome: 'failed', time: { created: 1, updated: 2 } },
    'idle',
  )
  assert.equal(failed.state, 'failed', 'a failed outcome wins over an idle status')
  assert.equal(failed.label, 'apollo', 'falls back to the agent when there is no title')

  // V2 reports `idle` for both "created but not started" and "finished": a
  // fresh child must not flash the ✓ of a completed one.
  const now = 1_000_000
  const justSpawned = toDelegationView(
    { id: 'ses_new', title: 'just spawned', time: { created: now - 1_000, updated: now - 1_000 } },
    'idle',
    now,
  )
  assert.equal(justSpawned.state, 'running', 'an idle child inside the grace window is not done')

  const stale = toDelegationView(
    { id: 'ses_old', title: 'long done', time: { created: now - 600_000, updated: now - 600_000 } },
    'idle',
    now,
  )
  assert.equal(stale.state, 'completed', 'past the grace window idle is terminal')

  // An interrupted outcome is neither success nor failure.
  const interrupted = toDelegationView(
    {
      id: 'ses_abort',
      title: 'aborted',
      outcome: 'interrupted',
      time: { created: 1, updated: 2 },
    },
    'idle',
  )
  assert.equal(interrupted.state, 'interrupted')
  assert.equal(delegationStateFromOutcome('succeeded'), 'completed')
  assert.equal(delegationStateFromOutcome(undefined), null, 'absent outcome defers to status')

  const untitled = toDelegationView({ id: 'ses_abcdef123' }, 'idle')
  assert.equal(untitled.state, 'completed')
  assert.equal(untitled.label, 'ses_abcd', 'falls back to the short id')
  assert.equal(untitled.startedAt, null)
})

test('delegation formatting: the shared spinner glyph', async () => {
  const { spinnerFrame } = await loadV2()

  assert.equal(spinnerFrame(0), '\u280b', 'first spinner frame')
  assert.equal(spinnerFrame(-1), spinnerFrame(1), 'a negative frame reads as a positive one')
  assert.equal(spinnerFrame(10), spinnerFrame(0), 'the frame counter wraps over the glyph list')
})

test('empty initial state guard (Known Issue) + session id validation', async () => {
  const { sidebarPlaceholder, isValidSessionID, SIDEBAR_WAITING_LABEL } = await loadV2()

  assert.equal(isValidSessionID('ses_abc'), true)
  assert.equal(isValidSessionID(''), false)
  assert.equal(isValidSessionID(undefined), false)
  assert.equal(isValidSessionID('foo'), false)

  assert.equal(sidebarPlaceholder(undefined), SIDEBAR_WAITING_LABEL)
  assert.equal(sidebarPlaceholder(''), SIDEBAR_WAITING_LABEL)
  assert.equal(sidebarPlaceholder('foo'), SIDEBAR_WAITING_LABEL)
  assert.equal(sidebarPlaceholder('ses_abc'), null, 'a real session suppresses the placeholder')
})

test('detectDelegationCompletions: one report per running→terminal transition', async () => {
  const { detectDelegationCompletions } = await loadV2()

  const running = (id) => ({ id, label: id, state: 'running' })
  const completed = (id) => ({ id, label: id, state: 'completed' })
  const failed = (id) => ({ id, label: id, state: 'failed' })

  // First observation never toasts.
  assert.deepEqual(detectDelegationCompletions(new Map(), [running('a')]).completed, [])

  const prev = new Map([['a', 'running']])
  assert.deepEqual(
    detectDelegationCompletions(prev, [completed('a')]).completed.map((c) => c.id),
    ['a'],
  )
  assert.deepEqual(
    detectDelegationCompletions(prev, [failed('a')]).completed.map((c) => c.state),
    ['failed'],
  )
  // Still running → no completion.
  assert.deepEqual(detectDelegationCompletions(prev, [running('a')]).completed, [])
  // Already terminal before → no double report.
  assert.deepEqual(
    detectDelegationCompletions(new Map([['a', 'completed']]), [failed('a')]).completed,
    [],
  )
})

test('navigateToSession: fail-open click-through', async () => {
  const { navigateToSession } = await loadV2()

  const calls = []
  assert.equal(
    navigateToSession({ navigate: (destination) => calls.push(destination) }, 'ses_1'),
    true,
  )
  assert.deepEqual(calls, [{ type: 'session', sessionID: 'ses_1' }])

  assert.equal(navigateToSession(undefined, 'ses_1'), false)
  assert.equal(navigateToSession({ navigate: () => {} }, 'nope'), false)
  assert.equal(navigateToSession({ navigate: () => {} }, undefined), false)
  assert.equal(
    navigateToSession(
      {
        navigate: () => {
          throw new Error('removed session')
        },
      },
      'ses_1',
    ),
    false,
    'a throwing router is absorbed',
  )
})

test('collectWarmupTargets: deduped, validated, bounded', async () => {
  const { collectWarmupTargets } = await loadV2()

  assert.deepEqual(
    collectWarmupTargets([
      { id: 'ses_a' },
      { id: 'ses_a' },
      { id: 'bad' },
      { id: '' },
      {},
      { id: 'ses_b' },
    ]),
    ['ses_a', 'ses_b'],
  )
  assert.equal(
    collectWarmupTargets([{ id: 'ses_a' }, { id: 'ses_b' }, { id: 'ses_c' }], 2).length,
    2,
  )
})

test('packaged plugin registers both slots, warms up eagerly, and disposes', async () => {
  const { default: plugin } = await loadV2()

  assert.equal(plugin.id, 'pantheon.tui')
  assert.equal(typeof plugin.setup, 'function')

  const project = mkdtempSync(join(tmpdir(), 'pantheon-v2-sidebar-'))
  const registrations = []
  const disposers = []
  const calls = { vcsSync: [], sessionSync: [] }

  const context = {
    location: { directory: project },
    data: {
      location: {
        default: () => ({ directory: project }),
        vcs: { sync: async (location) => calls.vcsSync.push(location) },
      },
      session: {
        list: () => [
          { id: 'ses_1', time: { updated: 2 } },
          { id: 'ses_2', time: { updated: 1 } },
        ],
        sync: async (id) => calls.sessionSync.push(id),
      },
      on: () => () => {},
    },
    ui: {
      slot: (claim) => {
        registrations.push(claim)
        const dispose = () => {}
        disposers.push(dispose)
        return dispose
      },
    },
  }

  try {
    const cleanup = plugin.setup(context)
    assert.equal(typeof cleanup, 'function', 'setup returns a cleanup function')

    const paths = registrations.map((claim) => claim.append)
    assert.ok(paths.includes('sidebar.content'), 'sidebar slot is registered')
    assert.ok(
      paths.includes('home.footer.status'),
      'home footer status guards the pre-prompt state',
    )
    assert.ok(
      paths.includes('prompt.footer'),
      'prompt footer is claimed additively (native line stays intact)',
    )
    for (const claim of registrations) assert.equal(typeof claim.render, 'function')

    // Eager warm-up: vcs + every listed session synced at load (Known Issue fix).
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(calls.vcsSync.length, 1)
    assert.deepEqual([...calls.sessionSync].sort(), ['ses_1', 'ses_2'])

    // Singleton guard: a second setup is a no-op.
    const count = registrations.length
    assert.equal(plugin.setup(context), undefined)
    assert.equal(registrations.length, count)

    cleanup()
    // After cleanup the guard is released, so a reload can register again.
    const again = plugin.setup(context)
    assert.equal(typeof again, 'function')
    assert.ok(registrations.length > count)
    again()
  } finally {
    rmSync(project, { recursive: true, force: true })
  }
})

test('refresh subscription uses only names from the OpenCode V2 event union', async () => {
  const { SIDEBAR_REFRESH_EVENTS } = await loadV2()

  assert.ok(SIDEBAR_REFRESH_EVENTS.length > 0)
  const installed = readInstalledEventUnion()
  const known = installed ?? V2_SESSION_EVENTS
  for (const name of SIDEBAR_REFRESH_EVENTS) {
    assert.ok(
      known.has(name),
      `${name} is not in the ${installed ? 'installed' : 'snapshot'} V2 event union`,
    )
  }

  assert.ok(
    !SIDEBAR_REFRESH_EVENTS.includes('session.updated'),
    'session.updated is absent from the V2 union — subscribing to it was a silent no-op',
  )
  for (const replacement of [
    'session.renamed',
    'session.metadata.updated',
    'session.moved',
    'session.idle',
  ]) {
    assert.ok(
      SIDEBAR_REFRESH_EVENTS.includes(replacement),
      `${replacement} carries the refresh V1 got from session.updated`,
    )
  }
})

test('createSidebarModel: subscription, toast, spinner and teardown (fake host)', async () => {
  const { createSidebarModel } = await loadV2()
  const now = Date.now()
  const host = createSidebarHost({
    children: [
      ['ses_root', { id: 'ses_root', title: 'Root', agent: 'zeus' }],
      [
        'ses_child',
        {
          id: 'ses_child',
          parentID: 'ses_root',
          title: 'apo-1',
          time: { created: now, updated: now },
        },
      ],
      // A terminal child at mount must never render — its toast covers it.
      [
        'ses_done',
        {
          id: 'ses_done',
          parentID: 'ses_root',
          title: 'done-1',
          outcome: 'succeeded',
          time: { created: now - 5_000, updated: now - 4_000 },
        },
      ],
    ],
    statuses: [['ses_child', 'running']],
    family: ['ses_root', 'ses_child', 'ses_done'],
  })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })

  try {
    // The fake host throws on any name outside the union, so a passing mount
    // proves every subscription is a real V2 event.
    assert.deepEqual(
      [...host.registered.keys()],
      [
        'session.created',
        'session.renamed',
        'session.metadata.updated',
        'session.moved',
        'session.idle',
        'session.status',
        'session.deleted',
      ],
    )
    assert.deepEqual(host.toasts, [], 'mounting must not toast')

    // The sidebar no longer lists other sessions — only the active one.
    assert.equal(model.sessions, undefined, 'the session list is gone from the model')
    assert.equal(model.session()?.id, 'ses_root', 'the active session is exposed')
    assert.equal(model.session()?.title, 'Root')
    assert.equal(model.activeSessionID(), 'ses_root')

    // Only in-flight children render as individual rows; the finished child is
    // already aggregated by the same block.
    assert.deepEqual(
      model.dispatch().running.map((row) => row.id),
      ['ses_child'],
    )
    assert.equal(model.dispatch().runningCount, 1)

    // Spinner armed only while a child runs.
    await sleep(3 * 80 + 40)
    assert.ok(model.frame() > 0, 'the spinner ticks while a delegation runs')

    host.setStatus('ses_child', 'idle')
    host.setChild('ses_child', {
      id: 'ses_child',
      parentID: 'ses_root',
      title: 'apo-1',
      outcome: 'succeeded',
      time: { created: now - 9_000, updated: now },
    })
    host.emit('session.idle')

    assert.deepEqual(
      host.toasts.map((toast) => [toast.message, toast.variant, toast.sessionID]),
      [['apo-1 concluída', 'success', 'ses_child']],
      'one toast on the running→terminal transition',
    )
    assert.equal(model.dispatch().runningCount, 0, 'a finished child leaves the live section')
    assert.equal(model.dispatch().completedCount, 2, 'both finished children are aggregated')

    const frozen = model.frame()
    await sleep(3 * 80 + 40)
    assert.equal(model.frame(), frozen, 'the interval is cleared once nothing runs')

    host.emit('session.status')
    assert.equal(host.toasts.length, 1, 'a terminal→terminal refresh is not a completion')
  } finally {
    dispose()
  }

  assert.deepEqual(
    [...host.unsubscribed].sort(),
    [...host.registered.keys()].sort(),
    'teardown releases every subscription the host handed out',
  )
})

test('createSidebarModel: a host returning no unsubscribe still tears down', async () => {
  const { createSidebarModel } = await loadV2()
  const host = createSidebarHost({ returnsUnsubscribe: false })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => undefined)
    return disposeRoot
  })

  assert.equal(model.dispatch(), null, 'no session id → no Dispatch block')
  assert.doesNotThrow(() => dispose())
  assert.deepEqual(host.unsubscribed, [])
})

test('context gauge follows the native token formula, compaction and revert bounds', async () => {
  const {
    messageTokensTotal,
    computeContextUsage,
    contextUsageTone,
    formatSpent,
    resolveContextLimit,
  } = await loadV2()

  const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 1_000, write: 200 } }
  assert.equal(
    messageTokensTotal(tokens),
    1_325,
    'input + output + reasoning + cache read + cache write',
  )

  const assistant = (id, value) => ({ id, type: 'assistant', tokens: value })
  const compaction = (id) => ({ id, type: 'compaction', status: 'completed' })

  assert.deepEqual(computeContextUsage([assistant('m1', tokens)], 10_000), {
    tokens: 1_325,
    percent: 13,
    limit: 10_000,
  })

  const afterCompaction = computeContextUsage(
    [
      assistant('m1', { input: 90_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
      compaction('c1'),
      assistant('m2', { input: 1_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
    ],
    10_000,
  )
  assert.equal(afterCompaction?.tokens, 1_000, 'only messages after the last compaction count')

  const reverted = computeContextUsage(
    [
      assistant('m1', { input: 2_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
      assistant('m2', { input: 9_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }),
    ],
    10_000,
    'm2',
  )
  assert.equal(reverted?.tokens, 2_000, 'the revert boundary and everything after it are excluded')

  assert.equal(
    computeContextUsage([assistant('m1', tokens)], 10_000, 'not-a-message')?.tokens,
    1_325,
    'an unmatched revert id degrades to the full window',
  )
  assert.equal(computeContextUsage([assistant('m1', tokens)], 0), null)
  assert.equal(computeContextUsage([], 10_000), null)
  assert.equal(computeContextUsage([{ id: 'u1', type: 'user' }], 10_000), null)

  // Four explicit stages: blue → green → yellow → red.
  assert.equal(contextUsageTone(25), 'info')
  assert.equal(contextUsageTone(26), 'success')
  assert.equal(contextUsageTone(50), 'success')
  assert.equal(contextUsageTone(51), 'warning')
  assert.equal(contextUsageTone(90), 'warning')
  assert.equal(contextUsageTone(91), 'error')

  assert.equal(formatSpent(0.18), '$0.18')
  assert.equal(formatSpent(0.0423), '$0.04')
  assert.equal(formatSpent(0), '$0.00')
  assert.equal(formatSpent(-1), null)
  assert.equal(formatSpent(null), null)

  const models = [
    { id: 'row-a', modelID: 'kimi-k3', providerID: 'opencode-go', limit: { context: 200_000 } },
    {
      id: 'row-b',
      modelID: 'deepseek-v4-flash',
      providerID: 'deepseek',
      limit: { context: 131_072 },
    },
  ]
  assert.equal(resolveContextLimit(models, { id: 'kimi-k3', providerID: 'opencode-go' }), 200_000)
  assert.equal(resolveContextLimit(models, 'opencode-go/kimi-k3'), 200_000)
  assert.equal(resolveContextLimit(models, 'deepseek-v4-flash'), 131_072)
  assert.equal(resolveContextLimit(models, { id: 'missing', providerID: 'nope' }), null)
})

test('Context block formats tokens, window, percent and spend like the native block', async () => {
  const { formatTokenCount, formatContextWindow, formatSpent, contextBlockRows } = await loadV2()

  assert.equal(formatTokenCount(55_320), '55,320')
  assert.equal(formatTokenCount(1_000_000), '1,000,000')
  assert.equal(formatTokenCount(0), '0')
  assert.equal(formatTokenCount(null), null)
  assert.equal(formatTokenCount(Number.NaN), null)

  assert.equal(formatContextWindow(1_000_000), '1.0M')
  assert.equal(formatContextWindow(2_000_000), '2.0M')
  assert.equal(formatContextWindow(200_000), '200K')
  assert.equal(formatContextWindow(128_000), '128K')
  assert.equal(formatContextWindow(32_768), '32K')
  assert.equal(formatContextWindow(131_072), '131K')
  assert.equal(formatContextWindow(0), null)
  assert.equal(formatContextWindow(null), null)

  assert.equal(formatSpent(0.18), '$0.18')
  assert.equal(formatSpent(0.1849), '$0.18')

  const full = contextBlockRows({ tokens: 55_320, percent: 6, limit: 1_000_000 }, 0.18)
  assert.deepEqual(
    [
      contextRowText(full?.tokens ?? null),
      contextRowText(full?.percent ?? null),
      contextRowText(full?.spent ?? null),
    ],
    ['55,320 tokens', `${'\u25B0'.repeat(1)}${'\u25B1'.repeat(11)} 6% of 1.0M`, '$0.18 spent'],
  )
  assert.equal(full?.tokens?.tone, null, 'only the percentage row is toned')
  assert.equal(full?.percent?.tone, 'info', 'a low gauge starts blue')

  // Semantic bands live on the percentage row only.
  assert.equal(
    contextBlockRows({ tokens: 1, percent: 49, limit: 1_000_000 }, null)?.percent?.tone,
    'success',
  )
  assert.equal(
    contextBlockRows({ tokens: 1, percent: 50, limit: 1_000_000 }, null)?.percent?.tone,
    'success',
  )
  assert.equal(
    contextBlockRows({ tokens: 1, percent: 74, limit: 1_000_000 }, null)?.percent?.tone,
    'warning',
  )
  assert.equal(
    contextBlockRows({ tokens: 1, percent: 75, limit: 1_000_000 }, null)?.percent?.tone,
    'warning',
  )

  // Unknown percentage → the percent/window row is omitted, never `undefined%`.
  const noPercent = contextBlockRows({ tokens: 12_345, percent: Number.NaN, limit: 200_000 }, 1.5)
  assert.equal(noPercent?.percent, null)
  assert.deepEqual(
    [contextRowText(noPercent?.tokens ?? null), contextRowText(noPercent?.spent ?? null)],
    ['12,345 tokens', '$1.50 spent'],
  )

  // Empty session: cost only, and nothing at all without a cost.
  assert.deepEqual(contextBlockRows(null, 0.18), {
    tokens: null,
    percent: null,
    spent: { lead: null, value: '$0.18', tail: null, suffix: ' spent', tone: null },
  })
  assert.equal(contextBlockRows(null, null), null)
  assert.equal(contextBlockRows(null, Number.NaN), null)
})

test('Context gauge: 12 cells, rounded fill, clamped, and no bar without a percent', async () => {
  const {
    contextBar,
    contextBarFilled,
    contextBlockRows,
    CONTEXT_BAR_CELLS,
    CONTEXT_BAR_FILLED_CELL,
    CONTEXT_BAR_EMPTY_CELL,
  } = await loadV2()

  assert.equal(CONTEXT_BAR_CELLS, 12, 'the gauge is 12 cells wide')
  assert.equal(CONTEXT_BAR_FILLED_CELL, '\u25B0', '▰ fills a cell')
  assert.equal(CONTEXT_BAR_EMPTY_CELL, '\u25B1', '▱ is an empty cell')

  const bar = (percent) => {
    const cells = contextBar(percent)
    return `${cells.filled}${cells.empty}`
  }
  assert.equal(bar(0), '\u25B1'.repeat(12), '0% is an empty bar')
  assert.equal(bar(39), `${'\u25B0'.repeat(5)}${'\u25B1'.repeat(7)}`, '39% rounds to 5 of 12')
  assert.equal(bar(100), '\u25B0'.repeat(12), '100% is a full bar')
  assert.equal(bar(140), '\u25B0'.repeat(12), 'above 100% clamps instead of overflowing')
  assert.equal(bar(-5), '\u25B1'.repeat(12), 'a negative percentage clamps to empty')

  assert.equal(contextBarFilled(39), 5)
  assert.equal(contextBarFilled(50), 6)
  assert.equal(contextBarFilled(4), 0, 'under half a cell rounds down')
  assert.equal(contextBarFilled(5), 1, 'over half a cell rounds up')
  for (const percent of [0, 1, 12, 39, 50, 75, 99, 100, 250]) {
    const cells = contextBar(percent)
    assert.equal(
      cells.filled.length + cells.empty.length,
      CONTEXT_BAR_CELLS,
      `the bar is always 12 cells at ${percent}%`,
    )
  }

  // No percentage → no bar at all, exactly as before.
  assert.equal(contextBar(null), null)
  assert.equal(contextBar(undefined), null)
  assert.equal(contextBar(Number.NaN), null)
  assert.equal(
    contextBlockRows({ tokens: 12_345, percent: Number.NaN, limit: 200_000 }, 1.5)?.percent,
    null,
  )

  const rows = contextBlockRows({ tokens: 78_000, percent: 39, limit: 200_000 }, 0.04)
  assert.equal(
    contextRowText(rows?.percent ?? null),
    '\u25B0\u25B0\u25B0\u25B0\u25B0\u25B1\u25B1\u25B1\u25B1\u25B1\u25B1\u25B1 39% of 200K',
    'bar, percent and window share one line',
  )
  assert.equal(rows?.percent?.lead, '\u25B0'.repeat(5), 'the filled cells are toned')
  assert.equal(rows?.percent?.tail, '\u25B1'.repeat(7), 'the empty cells are muted')
  assert.equal(rows?.percent?.tone, 'success', '39% is the green stage')

  const full = contextBlockRows({ tokens: 1, percent: 100, limit: 1_000_000 }, null)
  assert.equal(contextRowText(full?.percent ?? null), `${'\u25B0'.repeat(12)} 100% of 1.0M`)
  for (const percent of [0, 39, 100]) {
    const line = contextRowText(
      contextBlockRows({ tokens: 1, percent, limit: 2_000_000 }, null)?.percent ?? null,
    )
    assert.ok(line.length <= 34, `the percent line stays within 34 columns (got ${line.length})`)
  }
})

test('model usage sums real message cost/tokens, omits zero cost, caps at 3 + aggregate', async () => {
  const {
    collectModelUsage,
    ceilingModelUsage,
    formatSpent,
    formatUsageCost,
    formatUsageTokens,
    modelUsageRows,
    modelUsageRowText,
    hiddenModelUsageText,
    MODEL_USAGE_MODEL_WIDTH,
    MODEL_USAGE_VISIBLE_CEILING,
  } = await loadV2()

  const assistant = (id, model, cost, tokens) => ({
    id,
    type: 'assistant',
    model,
    cost,
    tokens,
  })
  const messages = [
    assistant('m1', { id: 'kimi-k3', providerID: 'opencode-go' }, 0.04, {
      input: 70_000,
      output: 6_000,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }),
    assistant('m2', { id: 'kimi-k3', providerID: 'opencode-go' }, 0.02, {
      input: 2_000,
      output: 2_000,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }),
    assistant('m3', { id: 'gpt-5.6-luna-fast', providerID: 'opencode-go' }, 0.01, {
      input: 1_500,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }),
    // No cost → contributes 0 and is never rendered (no invented price).
    assistant('m4', { id: 'free-model', providerID: 'local' }, undefined, {
      input: 5_000,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }),
    // Assistant without a model cannot be attributed.
    assistant('m5', undefined, 1, {
      input: 1,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }),
    // Non-assistant messages never contribute.
    { id: 'u1', type: 'user', cost: 99 },
  ]

  const rows = collectModelUsage(messages)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].model, 'kimi-k3')
  assert.equal(rows[0].tokens, 80_000, 'tokens are summed per model')
  assert.equal(formatSpent(rows[0].cost), '$0.06', 'cost is the real sum, rounded only for display')
  assert.equal(rows[1].model, 'gpt-5.6-lun…')
  assert.equal(rows[1].tokens, 1_500)

  assert.equal(formatUsageTokens(80_000), '80K')
  assert.equal(formatUsageTokens(0), '0')
  assert.equal(formatUsageTokens(null), '0')

  // Real sub-cent costs are not rounded down to $0.00.
  assert.equal(formatUsageCost(0.06), '$0.06')
  assert.equal(formatUsageCost(0.0031), '$0.0031')
  assert.equal(formatUsageCost(0.001), '$0.001')
  assert.equal(formatUsageCost(0.00001), '<$0.0001')
  assert.equal(formatUsageCost(0), '$0.00')
  assert.equal(formatUsageCost(-1), null)

  const formatted = modelUsageRows(rows)
  assert.equal(formatted[0].model.length <= MODEL_USAGE_MODEL_WIDTH, true)
  assert.equal(formatted[0].tokens, '80K')
  assert.equal(formatted[0].cost, '$0.06')
  assert.ok(
    modelUsageRowText(formatted[0]).trim().includes('kimi-k3'),
    'label is present in the row text',
  )
  assert.ok(
    modelUsageRowText(formatted[0]).length <= 34,
    'a model row always fits the ~34-column sidebar budget',
  )
  assert.equal(
    modelUsageRows(
      collectModelUsage([
        assistant('long', { id: 'a-very-long-model-identifier', providerID: 'x' }, 1, {
          input: 1,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        }),
      ]),
    )[0].model.length,
    MODEL_USAGE_MODEL_WIDTH,
    'model ids are truncated to the column width',
  )

  assert.deepEqual(collectModelUsage([]), [])
  assert.deepEqual(collectModelUsage([{ id: 'u1', type: 'user', cost: 1 }]), [])

  const many = [
    assistant('a', { id: 'm-a', providerID: 'x' }, 0.05, {
      input: 1,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }),
    assistant('b', { id: 'm-b', providerID: 'x' }, 0.04, {
      input: 1,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }),
    assistant('c', { id: 'm-c', providerID: 'x' }, 0.03, {
      input: 1,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }),
    assistant('d', { id: 'm-d', providerID: 'x' }, 0.02, {
      input: 1,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }),
    assistant('e', { id: 'm-e', providerID: 'x' }, 0.01, {
      input: 1,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    }),
  ]
  const capped = ceilingModelUsage(collectModelUsage(many), MODEL_USAGE_VISIBLE_CEILING)
  assert.equal(capped.visible.length, 3)
  assert.equal(capped.hidden, 2)
  assert.equal(formatSpent(capped.hiddenCost), '$0.03', 'the overflow line aggregates real cost')
  assert.equal(capped.hiddenTokens, 2)
  assert.equal(hiddenModelUsageText(capped.hidden, capped.hiddenCost), '… +2  $0.03')
  assert.equal(hiddenModelUsageText(0, 0), null)
  assert.equal(hiddenModelUsageText(Number.NaN, 0), null)
})

test('sidebar model aggregates per-model cost across root and family messages', async () => {
  const { createSidebarModel, formatSpent, modelUsageRows, modelUsageRowText } = await loadV2()
  const assistant = (id, model, cost, input) => ({
    id,
    type: 'assistant',
    model,
    cost,
    tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  const host = createSidebarHost({
    children: [
      ['ses_root', { id: 'ses_root', title: 'Root', agent: 'zeus' }],
      ['ses_child', { id: 'ses_child', parentID: 'ses_root', title: 'apo-1', agent: 'apollo' }],
    ],
    family: ['ses_root', 'ses_child'],
    messages: [
      [
        'ses_root',
        [
          assistant('m1', { id: 'kimi-k3', providerID: 'opencode-go' }, 0.02, 1_000),
          assistant('m2', { id: 'kimi-k3', providerID: 'opencode-go' }, 0.01, 1_400),
        ],
      ],
      [
        'ses_child',
        [assistant('m3', { id: 'gpt-5.6-luna-fast', providerID: 'opencode-go' }, 0.03, 300)],
      ],
    ],
    costs: [
      ['ses_root', 0.03],
      ['ses_child', 0.03],
    ],
  })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    const usage = model.modelUsage()
    assert.equal(usage.visible.length, 2, 'both the root and the delegated model appear')
    assert.equal(usage.visible[0].model, 'kimi-k3')
    assert.equal(usage.visible[0].tokens, 2_400)
    assert.equal(formatSpent(usage.visible[0].cost), '$0.03')
    assert.equal(usage.visible[1].model, 'gpt-5.6-lun…')
    assert.equal(formatSpent(usage.visible[1].cost), '$0.03')
    assert.equal(formatSpent(model.cost()), '$0.06', 'root + child session costs are summed')
    assert.ok(usage.visible.every((row) => row.cost > 0))
    const rows = modelUsageRows(usage.visible)
    for (const row of rows) {
      assert.ok(modelUsageRowText(row).length <= 34, 'every row fits the sidebar budget')
    }
  } finally {
    dispose()
  }

  // A host whose cost API still reports 0 must not hide positive model rows:
  // the real message costs fill the total.
  const zeroCostHost = createSidebarHost({
    children: [
      ['ses_root', { id: 'ses_root', title: 'Root' }],
      ['ses_child', { id: 'ses_child', parentID: 'ses_root', title: 'apo-1' }],
    ],
    family: ['ses_root', 'ses_child'],
    messages: [
      ['ses_root', [assistant('m1', { id: 'kimi-k3', providerID: 'opencode-go' }, 0.02, 1_000)]],
      ['ses_child', [assistant('m2', { id: 'kimi-k3', providerID: 'opencode-go' }, 0.03, 500)]],
    ],
    costs: [
      ['ses_root', 0],
      ['ses_child', 0],
    ],
  })
  let zeroModel
  const disposeZero = createRoot((disposeRoot) => {
    zeroModel = createSidebarModel(zeroCostHost.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    assert.equal(
      formatSpent(zeroModel.cost()),
      '$0.05',
      'real message costs replace a stale $0.00 from the session cost API',
    )
  } finally {
    disposeZero()
  }
})

test('git change counts are files per status, with zero terms omitted', async () => {
  const { countGitChanges, formatGitChanges } = await loadV2()

  const files = [
    { file: 'a.ts', additions: 10, deletions: 0, status: 'added' },
    { file: 'b.ts', additions: 4, deletions: 1, status: 'modified' },
    { file: 'c.ts', additions: 2, deletions: 0, status: 'modified' },
    { file: 'd.ts', additions: 0, deletions: 9, status: 'deleted' },
    { file: 'e.ts', additions: 1, deletions: 1, status: 'unknown' },
  ]

  assert.deepEqual(countGitChanges(files), { added: 1, modified: 2, deleted: 1 })
  assert.equal(
    formatGitChanges(files),
    '+1 ±2 \u22121',
    'counts files per status (never lines) and uses the typographic minus',
  )

  assert.equal(
    formatGitChanges([{ file: 'b.ts', additions: 99, deletions: 99, status: 'modified' }]),
    '±1',
    'zero terms are omitted — additions/deletions lines never leak into the row',
  )
  assert.equal(formatGitChanges([{ file: 'a.ts', status: 'added' }]), '+1')
  assert.equal(formatGitChanges([{ file: 'd.ts', status: 'deleted' }]), '\u22121')
  assert.equal(formatGitChanges([]), null, 'a clean tree renders no row')
  assert.equal(formatGitChanges(null), null)
  assert.equal(
    formatGitChanges([{ file: 'x.ts', status: 'untracked' }]),
    null,
    'no untracked counter exists in the VcsFileStatus protocol',
  )
})

test('sidebar model exposes context, cost, agent→model and full delegation rows', async () => {
  const { toDelegationView, createSidebarModel, contextBlockRows } = await loadV2()
  const now = Date.now()

  await withIsolatedXdg(async () => {
    const project = mkdtempSync(join(tmpdir(), 'pantheon-v2-metrics-'))
    try {
      mkdirSync(join(project, '.pantheon'), { recursive: true })
      writeFileSync(
        join(project, '.pantheon', 'active-preset.json'),
        JSON.stringify({
          preset: 'go-fast',
          overrides: { agents: { apollo: { model: 'opencode-go/qwen3.8-max' } } },
        }),
      )

      const host = createSidebarHost({
        directory: project,
        children: [
          [
            'ses_root',
            {
              id: 'ses_root',
              title: 'Root session with a very long title that must be truncated',
              agent: 'aphrodite',
              model: { id: 'kimi-k3', providerID: 'opencode-go' },
            },
          ],
          [
            'ses_child',
            {
              id: 'ses_child',
              parentID: 'ses_root',
              title: 'apo-1',
              agent: 'apollo',
              model: { id: 'gpt-5.6-luna-fast', providerID: 'opencode-go' },
              time: { created: now, updated: now },
            },
          ],
        ],
        statuses: [['ses_child', 'running']],
        family: ['ses_root', 'ses_child'],
        messages: [
          [
            'ses_root',
            [
              {
                id: 'm1',
                type: 'assistant',
                model: { id: 'kimi-k3', providerID: 'opencode-go' },
                tokens: {
                  input: 60_000,
                  output: 14_000,
                  reasoning: 1_000,
                  cache: { read: 2_000, write: 1_000 },
                },
              },
            ],
          ],
        ],
        models: [
          {
            id: 'row-kimi',
            modelID: 'kimi-k3',
            providerID: 'opencode-go',
            limit: { context: 200_000 },
          },
        ],
        agents: [
          { id: 'aphrodite', model: { id: 'kimi-k3', providerID: 'opencode-go' } },
          { id: 'apollo', model: { id: 'gpt-5.6-luna-fast', providerID: 'opencode-go' } },
        ],
        costs: [['ses_root', 0.0423]],
      })

      let model
      const dispose = createRoot((disposeRoot) => {
        model = createSidebarModel(host.context, () => 'ses_root')
        return disposeRoot
      })

      try {
        await sleep(20)
        const usage = model.contextUsage()
        assert.deepEqual(usage, { tokens: 78_000, percent: 39, limit: 200_000 })
        assert.equal(model.cost(), 0.0423)
        const rows = contextBlockRows(usage, model.cost())
        assert.deepEqual(
          [
            contextRowText(rows?.tokens ?? null),
            contextRowText(rows?.percent ?? null),
            contextRowText(rows?.spent ?? null),
          ],
          [
            '78,000 tokens',
            `${'\u25B0'.repeat(5)}${'\u25B1'.repeat(7)} 39% of 200K`,
            '$0.04 spent',
          ],
        )

        assert.deepEqual(model.agentModel(), {
          agent: 'aphrodite',
          model: 'kimi-k3',
          overridden: false,
        })
        assert.equal(model.preset().name, 'go-fast')
        assert.equal(model.presetOverrides().agents.apollo?.model, 'opencode-go/qwen3.8-max')

        const child = toDelegationView(host.context.data.session.get('ses_child'), 'running', now)
        assert.equal(child.agent, 'apollo')
        assert.equal(child.model, 'gpt-5.6-luna-fast')
      } finally {
        dispose()
      }

      // The explicit override wins for the current agent and is starred.
      let childModel
      const disposeChild = createRoot((disposeRoot) => {
        childModel = createSidebarModel(host.context, () => 'ses_child')
        return disposeRoot
      })
      try {
        await sleep(20)
        assert.deepEqual(childModel.agentModel(), {
          agent: 'apollo',
          model: 'qwen3.8-max',
          overridden: true,
        })
      } finally {
        disposeChild()
      }
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})

test('git counts come from client.vcs.status at mount and debounced session events', async () => {
  const { createSidebarModel, GIT_CHANGES_DEBOUNCE_MS } = await loadV2()

  const calls = []
  let payload = [
    { file: 'a.ts', additions: 1, deletions: 0, status: 'added' },
    { file: 'b.ts', additions: 0, deletions: 2, status: 'deleted' },
  ]
  let fail = false
  const client = {
    vcs: {
      status: async (input) => {
        calls.push(input)
        if (fail) throw new Error('vcs unreachable')
        return { location: { directory: input?.location?.directory }, data: payload }
      },
    },
  }

  const host = createSidebarHost({
    directory: '/repo',
    client,
    children: [['ses_root', { id: 'ses_root' }]],
    family: ['ses_root'],
  })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })

  try {
    await sleep(20)
    assert.equal(calls.length, 1, 'exactly one fetch at mount — no interval polling')
    assert.deepEqual(
      calls[0],
      { location: { directory: '/repo' } },
      'client.vcs.status takes { location } exactly',
    )
    assert.equal(model.gitChanges(), '+1 \u22121')

    // A session event revalidates once, after the debounce window.
    payload = [{ file: 'b.ts', additions: 3, deletions: 0, status: 'modified' }]
    host.emit('session.idle')
    assert.equal(calls.length, 1, 'no request before the debounce elapses')
    await sleep(GIT_CHANGES_DEBOUNCE_MS + 40)
    assert.equal(calls.length, 2)
    assert.equal(model.gitChanges(), '±1')

    // Bursts coalesce: two events inside one window cost one request.
    host.emit('session.idle')
    host.emit('session.status')
    await sleep(GIT_CHANGES_DEBOUNCE_MS + 40)
    assert.equal(calls.length, 3, 'bursty events collapse into a single revalidation')

    // A failing call keeps the previous value instead of throwing.
    fail = true
    host.emit('session.idle')
    await sleep(GIT_CHANGES_DEBOUNCE_MS + 40)
    assert.equal(calls.length, 4)
    assert.equal(model.gitChanges(), '±1')
  } finally {
    dispose()
  }
})

test('git row degrades to branch-only when client.vcs.status is absent', async () => {
  const { createSidebarModel } = await loadV2()

  const withoutStatus = createSidebarHost({
    client: { vcs: { status: undefined } },
    children: [['ses_root', { id: 'ses_root' }]],
    family: ['ses_root'],
  })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(withoutStatus.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    await sleep(20)
    assert.doesNotThrow(() => withoutStatus.emit('session.idle'))
    await sleep(20)
    assert.equal(model.gitChanges(), null, 'branch-only when vcs.status is not callable')
    assert.equal(model.branch(), 'main')
  } finally {
    dispose()
  }

  // No client at all (older host drift) is equally silent.
  const bare = createSidebarHost({ children: [['ses_root', { id: 'ses_root' }]] })
  let bareModel
  const disposeBare = createRoot((disposeRoot) => {
    bareModel = createSidebarModel(bare.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    await sleep(20)
    assert.equal(bareModel.gitChanges(), null)
    assert.equal(bareModel.branch(), 'main')
  } finally {
    disposeBare()
  }
})

test('sidebar model degrades without vcs, messages, models, agent info or cost API', async () => {
  const { createSidebarModel, createFooterModel } = await loadV2()

  // Empty collections: vcs.info() null, no messages, no models/agents.
  const emptyHost = createSidebarHost({
    vcs: null,
    children: [['ses_root', { id: 'ses_root', title: 'Root' }]],
    family: ['ses_root'],
  })
  let model
  let footer
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(emptyHost.context, () => 'ses_root')
    footer = createFooterModel(emptyHost.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    await sleep(5)
    assert.equal(model.branch(), null)
    assert.equal(model.contextUsage(), null, 'no message limit/messages → no gauge')
    assert.equal(model.agentModel(), null)
    assert.equal(model.cost(), 0)
    assert.equal(model.dispatch(), null, 'a host without family data renders no block')
    assert.equal(footer.running(), 0)
  } finally {
    dispose()
  }

  // APIs absent entirely (older host drift) must not throw on mount or read.
  const bareHost = createSidebarHost({ family: ['ses_root'] })
  delete bareHost.context.data.location.vcs
  delete bareHost.context.data.location.model
  delete bareHost.context.data.location.agent
  delete bareHost.context.data.session.message
  delete bareHost.context.data.session.cost
  let bareModel
  const disposeBare = createRoot((disposeRoot) => {
    bareModel = createSidebarModel(bareHost.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    await sleep(5)
    assert.equal(bareModel.branch(), null)
    assert.equal(bareModel.contextUsage(), null)
    assert.equal(bareModel.agentModel(), null)
    assert.equal(bareModel.cost(), null)
    assert.deepEqual(
      bareModel.modelUsage(),
      { visible: [], hidden: 0, hiddenCost: 0, hiddenTokens: 0 },
      'no message cost data → the model rows are empty and the block keeps its old format',
    )
  } finally {
    assert.doesNotThrow(() => disposeBare())
  }
})

test('prompt footer is additive only and counts running delegations without toasting', async () => {
  const source = readFileSync(join(root, 'src/plugins/tui/src/index-v2.tsx'), 'utf8')
  assert.equal(
    /\breplace\s*:/.test(source),
    false,
    'no replace claim anywhere in the V2 TUI source',
  )

  const { default: plugin, createFooterModel } = await loadV2()
  const registrations = []
  const context = {
    location: { directory: tmpdir() },
    data: {
      location: { default: () => ({ directory: tmpdir() }), vcs: { sync: async () => {} } },
      session: { list: () => [], sync: async () => {} },
      on: () => () => {},
    },
    ui: {
      slot: (claim) => {
        registrations.push(claim)
        return () => {}
      },
    },
  }

  const cleanup = plugin.setup(context)
  try {
    const footer = registrations.find((claim) => claim.append === 'prompt.footer')
    assert.ok(footer, 'prompt.footer is claimed with append')
    assert.equal(footer.replace, undefined)
    for (const claim of registrations) {
      const placements = ['prepend', 'append', 'before', 'after', 'replace'].filter(
        (key) => key in claim,
      )
      assert.deepEqual(placements, ['append'], 'every claim is additive; replace is forbidden')
    }
  } finally {
    cleanup()
  }

  const now = Date.now()
  const host = createSidebarHost({
    children: [
      ['ses_root', { id: 'ses_root' }],
      [
        'ses_child',
        {
          id: 'ses_child',
          parentID: 'ses_root',
          title: 'apo-1',
          time: { created: now, updated: now },
        },
      ],
    ],
    statuses: [['ses_child', 'running']],
    family: ['ses_root', 'ses_child'],
  })

  let footerModel
  const dispose = createRoot((disposeRoot) => {
    footerModel = createFooterModel(host.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    assert.equal(footerModel.running(), 1)
    assert.deepEqual(host.toasts, [], 'the footer model never fires completion toasts')
  } finally {
    dispose()
  }

  let noSession
  const disposeNoSession = createRoot((disposeRoot) => {
    noSession = createFooterModel(host.context, () => undefined)
    return disposeRoot
  })
  try {
    assert.equal(noSession.running(), 0, 'a slot input without a session is a no-op')
  } finally {
    disposeNoSession()
  }
})

/* ─── Todo block ──────────────────────────────────────────
 * There is no todo API in the installed client (`client.session.todo` does not
 * exist and no `todo.updated` event is published), so the block is derived from
 * the newest completed `todowrite` part of the active session's transcript.
 * That tool is a full replace, so the last write wins. */

/** One assistant message carrying a single tool part. */
function toolMessage(id, name, input, status = 'completed') {
  return {
    id,
    type: 'assistant',
    model: { id: 'm', providerID: 'p' },
    content: [
      {
        type: 'tool',
        id: `part-${id}`,
        name,
        time: { created: 1 },
        state: { status, input },
      },
    ],
  }
}

function todoMessage(id, todos, status) {
  return toolMessage(id, 'todowrite', { todos }, status)
}

test('latestTodoItems: the last completed todowrite wins and bad input is ignored', async () => {
  const { latestTodoItems } = await loadV2()

  const first = [
    { content: 'old one', status: 'pending' },
    { content: 'old two', status: 'completed' },
  ]
  const second = [{ content: 'new one', status: 'in_progress' }]

  assert.deepEqual(
    latestTodoItems([todoMessage('m1', first), todoMessage('m2', second)]),
    [{ content: 'new one', status: 'in_progress' }],
    'todowrite is a full replace — the newest write is the authoritative list',
  )

  assert.equal(
    latestTodoItems([todoMessage('m1', first), todoMessage('m2', [])]),
    null,
    'todos: [] hides the block instead of resurrecting the previous list',
  )

  assert.deepEqual(
    latestTodoItems([
      toolMessage('m1', 'bash', { command: 'ls' }),
      todoMessage('m2', second),
      toolMessage('m3', 'read', { file: 'a.ts' }),
    ]),
    [{ content: 'new one', status: 'in_progress' }],
    'parts that are not todowrite are ignored in the same walk',
  )

  assert.equal(
    latestTodoItems([todoMessage('m1', second, 'running')]),
    null,
    'a not-yet-completed write is not authoritative',
  )
  assert.deepEqual(
    latestTodoItems([todoMessage('m1', first), todoMessage('m2', second, 'running')]),
    first,
    'a pending write leaves the last completed one in place',
  )

  assert.equal(latestTodoItems([todoMessage('m1', { not: 'a list' })]), null)
  assert.equal(latestTodoItems([toolMessage('m1', 'todowrite', null)]), null)
  assert.equal(latestTodoItems([{ id: 'm1', type: 'assistant', content: 'nope' }]), null)
  assert.equal(latestTodoItems([{ id: 'u1', type: 'user' }]), null)
  assert.equal(latestTodoItems([]), null)
  assert.equal(latestTodoItems(null), null)
  assert.doesNotThrow(() => latestTodoItems([{ type: 'assistant', content: [null] }]))

  const { parseTodoItems } = await loadV2()
  assert.deepEqual(parseTodoItems({ todos: 'x' }), [])
  assert.deepEqual(parseTodoItems(null), [])
  assert.deepEqual(
    parseTodoItems({
      todos: [
        { content: '  spaced  ', status: 'pending', priority: 'high' },
        { status: 'pending' },
        { content: '   ', status: 'pending' },
        { content: 'bad status', status: 'blocked' },
        null,
      ],
    }),
    [{ content: 'spaced', status: 'pending' }],
    'items without content/known status are dropped, never rendered',
  )
})

test('Todo rows: markers per status, group order, cap of 6 and 28-char truncation', async () => {
  const {
    todoRowText,
    orderTodoItems,
    ceilingTodoItems,
    hiddenTodoText,
    todoTone,
    TODO_TEXT_WIDTH,
  } = await loadV2()

  const items = [
    { content: 'done work', status: 'completed' },
    { content: 'open work', status: 'pending' },
    { content: 'dropped work', status: 'cancelled' },
    { content: 'live work', status: 'in_progress' },
    { content: 'done later', status: 'completed' },
    { content: 'open later', status: 'pending' },
  ]

  assert.deepEqual(
    orderTodoItems(items).map((item) => item.content),
    ['live work', 'open work', 'open later', 'done work', 'done later', 'dropped work'],
    'in_progress → pending → completed → cancelled, original order inside a group',
  )

  assert.equal(todoRowText({ content: 'live work', status: 'in_progress' }), '[\u2022] live work')
  assert.equal(todoRowText({ content: 'open work', status: 'pending' }), '[ ] open work')
  assert.equal(todoRowText({ content: 'done work', status: 'completed' }), '[x] done work')
  assert.equal(
    todoRowText({ content: 'dropped work', status: 'cancelled' }),
    '[\u2212] dropped work',
    'cancelled uses U+2212, consistent with the git row',
  )

  assert.equal(todoTone('in_progress'), 'accent')
  assert.equal(todoTone('pending'), 'base')
  assert.equal(todoTone('completed'), 'muted')
  assert.equal(todoTone('cancelled'), 'muted')

  const long = 'x'.repeat(60)
  const truncated = todoRowText({ content: long, status: 'pending' })
  assert.equal(truncated, `[ ] ${'x'.repeat(TODO_TEXT_WIDTH - 1)}…`)
  assert.equal(TODO_TEXT_WIDTH, 28)
  assert.equal(truncated.length, 4 + TODO_TEXT_WIDTH, 'every row stays inside the sidebar budget')
  assert.equal(
    todoRowText({ content: '1234567890123456789012345678', status: 'pending' }),
    '[ ] 1234567890123456789012345678',
    'exactly 28 characters is not truncated',
  )

  assert.equal(
    todoRowText({ content: '12345678901234567890123456789', status: 'pending' }),
    '[ ] 123456789012345678901234567…',
    '29 characters truncates to 27 + ellipsis',
  )

  const eight = Array.from({ length: 8 }, (_, index) => ({
    content: `item-${index}`,
    status: 'pending',
  }))
  const capped = ceilingTodoItems(eight)
  assert.equal(capped.visible.length, 6, 'the block shows at most six rows')
  assert.equal(capped.hidden, 2)
  assert.equal(hiddenTodoText(capped.hidden), '… +2')
  assert.equal(hiddenTodoText(0), null)
  assert.equal(hiddenTodoText(Number.NaN), null)

  const orderedCap = ceilingTodoItems([...eight, { content: 'live', status: 'in_progress' }])
  assert.equal(orderedCap.visible[0].content, 'live', 'live work is never pushed past the cap')
  assert.equal(orderedCap.hidden, 3)
})

test('sidebar model derives Todo from the active transcript only, in one message pass', async () => {
  const { createSidebarModel, MODEL_USAGE_DEBOUNCE_MS } = await loadV2()

  const rootMessages = [
    toolMessage('m1', 'read', { file: 'a.ts' }),
    todoMessage('m2', [
      { content: 'first list', status: 'pending' },
      { content: 'stale', status: 'cancelled' },
    ]),
    toolMessage('m3', 'todowrite', { todos: [{ content: 'second list', status: 'in_progress' }] }),
  ]
  const host = createSidebarHost({
    children: [
      ['ses_root', { id: 'ses_root', title: 'Root' }],
      ['ses_child', { id: 'ses_child', parentID: 'ses_root', title: 'apo-1' }],
    ],
    family: ['ses_root', 'ses_child'],
    messages: [
      ['ses_root', rootMessages],
      ['ses_child', [todoMessage('c1', [{ content: 'child list', status: 'in_progress' }])]],
    ],
  })

  const calls = []
  const list = host.context.data.session.message.list
  host.context.data.session.message.list = (id) => {
    calls.push(id)
    return list(id)
  }

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })

  try {
    await sleep(10)
    assert.deepEqual([...new Set(calls)], ['ses_root', 'ses_child'], 'only the family is read')

    // Reading both derived blocks costs no extra list call — they share one memo.
    const beforeReads = calls.length
    const usage = model.modelUsage()
    const todo = model.todo()
    assert.equal(
      calls.length,
      beforeReads,
      'model usage and the Todo block share a single message.list pass over the root session',
    )
    assert.deepEqual(usage.visible, [], 'no assistant message carries cost here')
    assert.deepEqual(todo.visible, [{ content: 'second list', status: 'in_progress' }])
    assert.equal(todo.hidden, 0, "a child's todowrite never leaks into the active session's block")

    // A refresh costs the same whether or not the transcript carries a
    // todowrite: the control host below proves the Todo block adds no pass.
    const rootBefore = calls.filter((id) => id === 'ses_root').length
    const childBefore = calls.filter((id) => id === 'ses_child').length
    host.emit('session.idle')
    await sleep(MODEL_USAGE_DEBOUNCE_MS + 50)
    const rootDelta = calls.filter((id) => id === 'ses_root').length - rootBefore
    const childDelta = calls.filter((id) => id === 'ses_child').length - childBefore
    assert.ok(childDelta >= 1, 'the family is walked after a session event')
    assert.equal(
      rootDelta - childDelta,
      1,
      'every family sweep reads the root once; the single extra root read is the context gauge — the Todo block adds no pass',
    )
    const withTodoDelta = rootDelta + childDelta
    const controlHost = createSidebarHost({
      children: [
        ['ses_root', { id: 'ses_root', title: 'Root' }],
        ['ses_child', { id: 'ses_child', parentID: 'ses_root', title: 'apo-1' }],
      ],
      family: ['ses_root', 'ses_child'],
      messages: [
        ['ses_root', [toolMessage('m1', 'read', { file: 'a.ts' })]],
        ['ses_child', [toolMessage('c1', 'bash', { command: 'ls' })]],
      ],
    })
    const controlCalls = []
    const controlList = controlHost.context.data.session.message.list
    controlHost.context.data.session.message.list = (id) => {
      controlCalls.push(id)
      return controlList(id)
    }
    let controlModel
    const disposeControl = createRoot((disposeRoot) => {
      controlModel = createSidebarModel(controlHost.context, () => 'ses_root')
      return disposeRoot
    })
    try {
      await sleep(10)
      const baseline = controlCalls.length
      controlHost.emit('session.idle')
      await sleep(MODEL_USAGE_DEBOUNCE_MS + 50)
      assert.equal(
        controlCalls.length - baseline,
        withTodoDelta,
        'the Todo block adds no message.list pass (identical refresh cost without todowrite)',
      )
      assert.deepEqual(controlModel.todo(), { visible: [], hidden: 0 })
    } finally {
      disposeControl()
    }

    // The active session's list changed (a new full-replace write): the debounce
    // recomputes once, and only from the same single pass.
    host.setMessages('ses_root', [
      todoMessage('m9', [
        { content: 'a', status: 'pending' },
        { content: 'b', status: 'in_progress' },
      ]),
    ])
    const callsBeforeIdle = calls.length
    host.emit('session.idle')
    assert.ok(calls.length > callsBeforeIdle, 'the session event triggers a re-read')
    await sleep(MODEL_USAGE_DEBOUNCE_MS + 50)
    assert.deepEqual(
      model.todo().visible.map((item) => item.content),
      ['b', 'a'],
      'the newest full-replace write is rendered, ordered by group',
    )

    // todos: [] hides the block (the model reports an empty, renderable set).
    host.setMessages('ses_root', [todoMessage('m10', [])])
    host.emit('session.idle')
    await sleep(MODEL_USAGE_DEBOUNCE_MS + 50)
    assert.deepEqual(model.todo(), { visible: [], hidden: 0 })

    // A transcript with no todowrite at all is equally silent.
    host.setMessages('ses_root', [toolMessage('m11', 'bash', { command: 'ls' })])
    host.emit('session.idle')
    await sleep(MODEL_USAGE_DEBOUNCE_MS + 50)
    assert.deepEqual(model.todo(), { visible: [], hidden: 0 })
  } finally {
    dispose()
  }
})

test('spend windows: hoje starts at local midnight, 30d is now minus 30 days', async () => {
  const { SPEND_30D_MS, spendWindows, startOfLocalDay } = await loadV2()

  const now = new Date(2026, 9, 22, 15, 41, 9, 512).getTime()
  const windows = spendWindows(now)

  assert.equal(windows.today.to, now, 'hoje ends at now')
  assert.equal(windows.thirtyDays.to, now, '30d ends at now')
  assert.equal(windows.thirtyDays.from, now - SPEND_30D_MS, '30d = now − 30 days')

  // Local midnight, not UTC midnight: the date fields match "today" and the
  // clock is zeroed, whatever the host timezone is.
  const midnight = new Date(windows.today.from)
  const today = new Date(now)
  assert.equal(midnight.getFullYear(), today.getFullYear())
  assert.equal(midnight.getMonth(), today.getMonth())
  assert.equal(midnight.getDate(), today.getDate())
  assert.deepEqual(
    [midnight.getHours(), midnight.getMinutes(), midnight.getSeconds(), midnight.getMilliseconds()],
    [0, 0, 0, 0],
    'hoje starts exactly at 00:00:00.000 local',
  )
  assert.ok(windows.today.from <= now && windows.today.from > now - 24 * 60 * 60 * 1000)
  assert.equal(startOfLocalDay(now), windows.today.from)

  // A different instant the same day yields the same midnight.
  assert.equal(startOfLocalDay(now + 60_000), windows.today.from)
})

test('spend formatting: $0.00 / $0.42 / $0.0031, never $0.0000 or a negative', async () => {
  const { formatSpendUSD, statsCost, contextSpendLine } = await loadV2()

  assert.equal(formatSpendUSD(0), '$0.00')
  assert.equal(formatSpendUSD(0.42), '$0.42')
  assert.equal(formatSpendUSD(9.8), '$9.80')
  assert.equal(formatSpendUSD(0.0031), '$0.0031')
  assert.equal(formatSpendUSD(0.00002), '<$0.0001', 'a positive amount never prints $0.0000')
  assert.equal(formatSpendUSD(-1), null, 'a negative amount is not renderable')
  assert.equal(formatSpendUSD(Number.NaN), null)
  assert.equal(formatSpendUSD(Number.POSITIVE_INFINITY), null)
  assert.equal(formatSpendUSD(undefined), null)
  assert.equal(formatSpendUSD(null), null)

  assert.equal(statsCost({ cost: 0.42 }), 0.42)
  assert.equal(statsCost({ cost: 0 }), 0)
  assert.equal(statsCost({ cost: -3 }), null)
  assert.equal(statsCost({ cost: 'nope' }), null)
  assert.equal(statsCost(undefined), null)

  assert.equal(
    contextSpendLine({ today: 0.42, thirtyDays: 9.8 }),
    'hoje $0.42 \u00B7 30d $9.80',
    'both windows share one muted line',
  )
  assert.equal(contextSpendLine(null), null, 'no data, no line')
  assert.equal(contextSpendLine({ today: null, thirtyDays: null }), null)
  assert.equal(
    contextSpendLine({ today: null, thirtyDays: 1.5 }),
    '30d $1.50',
    'one usable window renders that window only',
  )
  assert.equal(
    contextSpendLine({ today: 0.42, thirtyDays: null }),
    'hoje $0.42',
    'a partial line never prints a placeholder for the missing window',
  )
})

/** Client stub whose `session.stats` records every call and answers from
 *  `handler`. `calls` keeps the inputs so the test can assert the sent unit. */
function createStatsClient(handler) {
  const calls = []
  return {
    calls,
    client: {
      session: {
        stats: async (input) => {
          calls.push(input)
          return handler(input, calls.length)
        },
      },
    },
  }
}

const SPEND_HOST_EXTRAS = { children: [['ses_root', { id: 'ses_root' }]], family: ['ses_root'] }

test('spend line: the ms probe is accepted and each refresh sends two windows', async () => {
  const {
    createSidebarModel,
    resetSpendUnit,
    resolvedSpendUnit,
    startOfLocalDay,
    SPEND_30D_MS,
    SPEND_REFRESH_DEBOUNCE_MS,
    SPEND_PROBE_WINDOW_MS,
  } = await loadV2()
  resetSpendUnit()

  const { calls, client } = createStatsClient((input) => ({
    range: { from: input.from, to: input.to },
    cost: input.to - input.from > 7 * 24 * 60 * 60 * 1000 ? 9.8 : 0.42,
  }))
  const host = createSidebarHost({ client, ...SPEND_HOST_EXTRAS })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })

  try {
    await sleep(30)
    assert.equal(resolvedSpendUnit(), 'ms', 'the echoed ms range pins the unit to ms')
    assert.equal(calls.length, 3, 'one probe call (ms accepted) + one call per window')
    assert.equal(
      calls[0].to - calls[0].from,
      SPEND_PROBE_WINDOW_MS,
      'the probe asks for a one-hour window',
    )

    const [, todayCall, thirtyCall] = calls
    assert.ok(Math.abs(todayCall.to - Date.now()) < 5_000, '`to` is a millisecond epoch')
    assert.equal(todayCall.from, startOfLocalDay(todayCall.to), 'hoje starts at local midnight')
    assert.equal(thirtyCall.from, thirtyCall.to - SPEND_30D_MS, '30d = now − 30 days')
    assert.equal(thirtyCall.to, todayCall.to, 'both windows share one instant')
    assert.equal(todayCall.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone)
    assert.equal(todayCall.tools, 'none')
    assert.equal('project' in todayCall, false, 'no project id is invented or fetched')
    assert.deepEqual(model.spend(), { today: 0.42, thirtyDays: 9.8 })

    // A burst of events costs exactly two calls (one per window), after the
    // debounce — never one call per event.
    const before = calls.length
    host.emit('session.idle')
    host.emit('session.status')
    assert.equal(calls.length, before, 'no request before the debounce elapses')
    await sleep(SPEND_REFRESH_DEBOUNCE_MS + 60)
    assert.equal(calls.length - before, 2, '≤2 calls per refresh: one per window')

    // Non-session work never triggers a fetch: no interval, no polling.
    await sleep(120)
    assert.equal(calls.length - before, 2)
  } finally {
    dispose()
    resetSpendUnit()
  }
})

test('spend line: a rejected ms probe falls back to seconds exactly once', async () => {
  const {
    createSidebarModel,
    resetSpendUnit,
    resolvedSpendUnit,
    startOfLocalDay,
    SPEND_REFRESH_DEBOUNCE_MS,
  } = await loadV2()
  resetSpendUnit()

  // Server that interprets `from`/`to` as seconds and echoes the range in ms.
  const { calls, client } = createStatsClient((input) => ({
    range: { from: input.from * 1000, to: input.to * 1000 },
    cost: 0.5,
  }))
  const host = createSidebarHost({ client, ...SPEND_HOST_EXTRAS })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })

  try {
    await sleep(40)
    assert.equal(resolvedSpendUnit(), 's', 'seconds won the single fallback attempt')
    assert.equal(calls.length, 4, 'ms attempt + seconds attempt + one call per window')
    assert.ok(calls[0].from > 1_000_000_000_000, 'the first attempt sent epoch ms')
    assert.ok(calls[1].from < 1_000_000_000_000, 'the fallback sent epoch seconds')

    const [, , todayCall, thirtyCall] = calls
    const now = todayCall.to * 1000
    assert.ok(Math.abs(now - Date.now()) < 5_000, '`to` is now in seconds')
    assert.ok(
      Math.abs(todayCall.from * 1000 - startOfLocalDay(now)) <= 1_000,
      'hoje starts at local midnight (sub-second truncation only)',
    )
    assert.equal(
      thirtyCall.from,
      thirtyCall.to - 30 * 24 * 60 * 60,
      '30d = now − 30 days (whole seconds)',
    )
    assert.equal(todayCall.timezone, Intl.DateTimeFormat().resolvedOptions().timeZone)
    assert.deepEqual(model.spend(), { today: 0.5, thirtyDays: 0.5 })

    // The resolved unit is reused: no further probing.
    host.emit('session.idle')
    await sleep(SPEND_REFRESH_DEBOUNCE_MS + 60)
    assert.equal(calls.length, 6, 'one refresh = two window calls, never another probe')
    assert.ok(calls[5].from < 1_000_000_000_000, 'refreshes keep the seconds unit')
  } finally {
    dispose()
    resetSpendUnit()
  }
})

test('spend line: both units rejected hides the line and stops calling', async () => {
  const {
    createSidebarModel,
    resetSpendUnit,
    resolvedSpendUnit,
    contextSpendLine,
    SPEND_REFRESH_DEBOUNCE_MS,
  } = await loadV2()
  resetSpendUnit()

  const { calls, client } = createStatsClient(() => ({ range: { from: 0, to: 0 }, cost: 4.2 }))
  const host = createSidebarHost({ client, ...SPEND_HOST_EXTRAS })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })

  try {
    await sleep(40)
    assert.equal(resolvedSpendUnit(), 'unavailable')
    assert.equal(calls.length, 2, 'at most two probe calls for the whole process')
    assert.equal(model.spend(), null, 'no value is rendered from an unverified unit')
    assert.equal(contextSpendLine(model.spend()), null, 'the Context line does not render')

    host.emit('session.idle')
    await sleep(SPEND_REFRESH_DEBOUNCE_MS + 80)
    host.emit('session.status')
    await sleep(SPEND_REFRESH_DEBOUNCE_MS + 80)
    assert.equal(calls.length, 2, 'an unavailable probe is never retried')
    assert.equal(model.spend(), null)
  } finally {
    dispose()
    resetSpendUnit()
  }
})

test('spend line: a partial failure keeps the last good value of that window', async () => {
  const { createSidebarModel, resetSpendUnit, contextSpendLine, SPEND_REFRESH_DEBOUNCE_MS } =
    await loadV2()
  resetSpendUnit()

  let failToday = false
  const { client } = createStatsClient((input) => {
    const span = input.to - input.from
    const isToday = span < 7 * 24 * 60 * 60 * 1000
    if (isToday && failToday) throw new Error('stats window failed')
    return { range: { from: input.from, to: input.to }, cost: isToday ? 0.42 : 9.8 }
  })
  const host = createSidebarHost({ client, ...SPEND_HOST_EXTRAS })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })

  try {
    await sleep(30)
    assert.deepEqual(model.spend(), { today: 0.42, thirtyDays: 9.8 })

    failToday = true
    host.emit('session.idle')
    await sleep(SPEND_REFRESH_DEBOUNCE_MS + 60)
    assert.deepEqual(
      model.spend(),
      { today: 0.42, thirtyDays: 9.8 },
      'the failed window keeps its previous value; the other window still renders',
    )
    assert.equal(contextSpendLine(model.spend()), 'hoje $0.42 \u00B7 30d $9.80')
  } finally {
    dispose()
    resetSpendUnit()
  }
})

test('spend line: absent client.session.stats hides it without calling or throwing', async () => {
  const { createSidebarModel, resetSpendUnit, contextSpendLine, SPEND_REFRESH_DEBOUNCE_MS } =
    await loadV2()
  resetSpendUnit()

  const withoutStats = createSidebarHost({
    client: { session: { stats: undefined } },
    ...SPEND_HOST_EXTRAS,
  })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(withoutStats.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    await sleep(30)
    assert.equal(model.spend(), null)
    assert.equal(contextSpendLine(model.spend()), null)
    assert.doesNotThrow(() => withoutStats.emit('session.idle'))
    await sleep(SPEND_REFRESH_DEBOUNCE_MS + 60)
    assert.equal(model.spend(), null, 'nothing renders without the stats API')
  } finally {
    dispose()
    resetSpendUnit()
  }

  // No client at all (older host drift) is equally silent.
  const bare = createSidebarHost(SPEND_HOST_EXTRAS)
  let bareModel
  const disposeBare = createRoot((disposeRoot) => {
    bareModel = createSidebarModel(bare.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    await sleep(30)
    assert.equal(bareModel.spend(), null)
    assert.doesNotThrow(() => bare.emit('session.status'))
  } finally {
    disposeBare()
    resetSpendUnit()
  }
})

test('sidebar renders Context → Git status → Todo → Dispatch, and no other block', async () => {
  const { BLOCK_ICONS } = await loadV2()
  const source = readFileSync(join(root, 'src/plugins/tui/src/index-v2.tsx'), 'utf8')

  const contextAt = source.indexOf('{/* Context —')
  const gitAt = source.indexOf('{/* Git status —')
  const todoAt = source.indexOf('{/* Todo —')
  const dispatchAt = source.indexOf('{/* Dispatch —')

  assert.ok(contextAt > 0 && gitAt > 0 && todoAt > 0 && dispatchAt > 0, 'four blocks exist')
  assert.ok(contextAt < gitAt, 'Context renders before Git status')
  assert.ok(gitAt < todoAt, 'Todo renders after Git status')
  assert.ok(todoAt < dispatchAt, 'Dispatch closes the sidebar')

  // The standalone `agentes` and `Skills` blocks were removed, not hidden: no
  // header, no label, no block key, no skill source and no skill estimate.
  assert.equal(source.includes('label="agentes"'), false, 'the `agentes` header is gone')
  assert.equal(source.includes('label="Skills"'), false, 'the `Skills` header is gone')
  assert.equal(/block\('agents'\)/.test(source), false, 'no `agents` block key is read')
  assert.equal(/block\('skills'\)/.test(source), false, 'no `skills` block key is read')
  assert.equal(
    /SidebarBlockKey =[^\n]*'agents'/.test(source),
    false,
    "SidebarBlockKey no longer carries 'agents'",
  )
  assert.equal(
    /SidebarBlockKey =[^\n]*'skills'/.test(source),
    false,
    "SidebarBlockKey no longer carries 'skills'",
  )
  assert.equal(source.includes('location.skill'), false, 'the skill collection is no longer read')
  assert.equal(source.includes('SkillIndexSummary'), false, 'the skill estimate is gone')
  assert.equal(source.includes('AgentUsageBlock'), false, 'the old agentes rows are gone')

  assert.deepEqual(
    Object.keys(BLOCK_ICONS),
    ['context', 'git', 'todo', 'dispatch'],
    'only the four surviving blocks carry a header glyph',
  )

  // Spend is not a block (its numbers live inside Context) and the TUI still
  // never claims the native block: it only ever appends.
  assert.equal(source.includes("block('spend')"), false, 'the Spend block stays gone')
  assert.match(
    source,
    /contextSpendLine\(model\.spend\(\)\)/,
    'the totals ride on the Context block',
  )
  assert.equal(/\n\s+git\n/.test(source), false, 'the old lowercase `git` label is gone')
  assert.ok(source.includes('label="Git status"'), 'the git block label is `Git status`')
  assert.ok(source.includes("'⎇ '"), 'the branch row keeps its ⎇ prefix')
})

test('Dispatch is a single block: one header, the live rows and one rollup', async () => {
  const source = readFileSync(join(root, 'src/plugins/tui/src/index-v2.tsx'), 'utf8')

  assert.equal(
    (source.match(/label="Dispatch"/g) ?? []).length,
    1,
    'exactly one Dispatch header is rendered',
  )
  assert.equal(
    (source.match(/label="agentes"/g) ?? []).length,
    0,
    'the duplicated agent list is gone, so the block cannot print the same data twice',
  )
  assert.match(source, /label="Dispatch"[\s\S]{0,400}summary=\{dispatchSummary\(\)\}/)
  assert.match(source, /✓ <total> · \$<soma> · <M> agentes/, 'the summary documents its own shape')
  assert.equal(source.includes('… +N member'), false, 'no per-session `… +N` list survives')
})

test('every block header carries one muted single-width glyph; the fixed header has none', async () => {
  const { BLOCK_ICONS } = await loadV2()

  assert.deepEqual(
    BLOCK_ICONS,
    {
      context: '\u25A4',
      git: '\u25C6',
      todo: '\u25BE',
      dispatch: '\u25C8',
    },
    '▤ Context · ◆ Git status · ▾ Todo · ◈ Dispatch',
  )
  for (const [key, icon] of Object.entries(BLOCK_ICONS)) {
    assert.equal([...icon].length, 1, `${key} uses exactly one codepoint, never a sequence`)
    assert.ok(icon.codePointAt(0) < 0x2e80, `${key} stays out of the wide CJK blocks`)
    assert.equal(
      /\uFE0F/.test(icon),
      false,
      `${key} carries no variation selector that could widen it`,
    )
  }
  // The host measures a `emoji-regex` match as two cells, so no header glyph may
  // match it (☑ U+2611 was the one candidate that did).
  const emoji = (await import('emoji-regex')).default()
  for (const [key, icon] of Object.entries(BLOCK_ICONS)) {
    emoji.lastIndex = 0
    assert.equal(emoji.test(icon), false, `${key} glyph is never measured as wide`)
  }

  const source = readFileSync(join(root, 'src/plugins/tui/src/index-v2.tsx'), 'utf8')
  for (const label of ['Context', 'Git status', 'Todo', 'Dispatch']) {
    assert.ok(
      source.includes(`label="${label}"`),
      `the ${label} block renders its own labeled header`,
    )
  }
  assert.equal((source.match(/<BlockHeader/g) ?? []).length, 4, 'exactly four block headers')

  // The fixed header (version / preset / session) takes no icon.
  const fixedHeader = source.slice(
    source.indexOf('<text fg={text()} attributes={1}>'),
    source.indexOf("block('context')"),
  )
  assert.ok(fixedHeader.length > 0, 'the fixed header block was located')
  assert.equal(fixedHeader.includes('BlockHeader'), false, 'the fixed header has no glyph')
})

test('Dispatch rows carry the child cost, and the spend totals ride inside Context', async () => {
  const {
    createSidebarModel,
    childAgentRowText,
    dispatchHeaderSummary,
    contextSpendLine,
    resetSpendUnit,
  } = await loadV2()
  const now = Date.now()
  const { client } = createStatsClient((input) => ({
    range: { from: input.from, to: input.to },
    cost: input.to - input.from < 7 * 24 * 60 * 60 * 1000 ? 0.42 : 9.8,
  }))
  const host = createSidebarHost({
    client,
    // The root reports no usable cost, so Context must survive on spend alone.
    costs: [['ses_root', Number.NaN]],
    children: [
      ['ses_root', { id: 'ses_root', agent: 'zeus', time: { created: now, updated: now } }],
      [
        'ses_a',
        {
          id: 'ses_a',
          parentID: 'ses_root',
          agent: 'apollo',
          model: { id: 'gpt-5.6', providerID: 'opencode-go' },
          cost: 0.04,
          time: { created: now - 12_700, updated: now - 100 },
        },
      ],
      [
        'ses_b',
        {
          id: 'ses_b',
          parentID: 'ses_root',
          agent: 'demeter',
          cost: 0.41,
          outcome: 'succeeded',
          time: { created: now - 64_000, updated: now - 100 },
        },
      ],
      [
        'ses_c',
        {
          id: 'ses_c',
          parentID: 'ses_root',
          agent: 'talos',
          outcome: 'succeeded',
          time: { created: now - 1_000, updated: now - 100 },
        },
      ],
    ],
    statuses: [['ses_a', 'running']],
    family: ['ses_root', 'ses_a', 'ses_b', 'ses_c'],
  })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    await sleep(40)
    const view = model.dispatch()
    assert.equal(view.runningCount, 1)
    assert.equal(view.completedCount, 2)
    assert.equal(view.agentCount, 2, 'two agents own the two finished children')
    assert.equal(
      dispatchHeaderSummary(view.runningCount, view.totalCost),
      '1 rodando · $0.45',
      'the header adds the live and the finished spend',
    )

    const running = view.running[0]
    assert.equal(running.id, 'ses_a')
    const live = toCell('apollo', 'gpt-5.6', '$0.04', '12.7s')
    assert.equal(running.text, live, 'spinner + agent + model + cost + duration')
    assert.ok(running.text.length <= 34, 'a live row stays inside 34 columns')

    assert.equal(view.summary, '✓ 2 · $0.41 · 2 agentes')
    assert.deepEqual(
      view.agents.map((row) => [row.agent, row.count, hasMoney(childAgentRowText(row))]),
      [
        ['demeter', 1, true],
        ['talos', 1, true],
      ],
      'cost descending, and every agent row carries a monetary value',
    )
    assert.equal(
      childAgentRowText(view.agents[0]),
      `${'demeter'.padEnd(12)} \u00D7${'1'.padStart(3)} ${'$0.41'.padStart(7)}`,
      'agent 12 · ×count 3 · cost 7',
    )
    assert.equal(
      childAgentRowText(view.agents[1]),
      `${'talos'.padEnd(12)} \u00D7${'1'.padStart(3)} ${'$0.00'.padStart(7)}`,
      'a child with no recorded cost still prints $0.00, never a blank column',
    )

    // Spend is a Context line, never a block of its own.
    assert.equal(contextSpendLine(model.spend()), 'hoje $0.42 \u00B7 30d $9.80')
    assert.equal(
      model.blocks().some((entry) => entry.key === 'spend'),
      false,
      'no Spend block exists any more',
    )
    assert.deepEqual(
      model.blocks().map((entry) => [entry.key, entry.spacer]),
      [
        ['context', false],
        ['git', true],
        ['dispatch', true],
      ],
      'Context opens the sidebar, Dispatch closes it and no removed block leaves a gap',
    )
  } finally {
    dispose()
    resetSpendUnit()
  }
})

test('block spacing: one blank line between rendered blocks, never before the first', async () => {
  const { withBlockSpacers } = await loadV2()

  assert.deepEqual(withBlockSpacers([]), [], 'no blocks means no spacing')
  assert.deepEqual(
    withBlockSpacers(['context', 'git', 'dispatch']),
    [
      { key: 'context', spacer: false },
      { key: 'git', spacer: true },
      { key: 'dispatch', spacer: true },
    ],
    'the first block carries no spacer; every later one does',
  )
  assert.deepEqual(
    withBlockSpacers(['todo', 'todo', 'dispatch']),
    [
      { key: 'todo', spacer: false },
      { key: 'dispatch', spacer: true },
    ],
    'a repeated key collapses instead of stacking spacers',
  )

  // The fixed header is separated from the first block by exactly one blank
  // line, and the block list itself never opens or closes with one.
  const source = readFileSync(join(root, 'src/plugins/tui/src/index-v2.tsx'), 'utf8')
  assert.match(
    source,
    /<Show when=\{model\.blocks\(\)\.length > 0\}>\s*<box height=\{1\} \/>/,
    'one blank line sits between the fixed header and the first block',
  )
  assert.equal(
    (
      source
        .slice(source.indexOf('function Sidebar('), source.indexOf('/** Keymap layer of the panel'))
        .match(/<box height=\{1\} \/>/g) ?? []
    ).length,
    5,
    'one slot per block plus the one after the fixed header — no duplicates',
  )
})

test('Dispatch formatting: columns, truncation, caps and the money guarantee', async () => {
  const {
    spinnerFrame,
    formatDispatchDuration,
    dispatchElapsed,
    dispatchAgentText,
    dispatchModelText,
    formatDispatchCost,
    runningChildRowText,
    childAgentRowText,
    hiddenChildAgentsText,
    completedSummaryText,
    failedSuffixText,
    dispatchHeaderSummary,
    dispatchTotalCost,
    DISPATCH_AGENT_WIDTH,
    DISPATCH_MIN_AGENT_WIDTH,
    DISPATCH_MODEL_WIDTH,
    DISPATCH_COST_WIDTH,
    DISPATCH_DURATION_WIDTH,
    DISPATCH_MAX_WIDTH,
  } = await loadV2()

  // The spinner is the host's Braille set: ten frames, one cell each.
  const frames = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((frame) => spinnerFrame(frame))
  assert.deepEqual(frames.slice(0, 10), ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'])
  assert.equal(frames[10], '⠋', 'the spinner wraps')

  assert.equal(formatDispatchDuration(820), '820ms', 'sub-second keeps its millisecond unit')
  assert.equal(formatDispatchDuration(12_400), '12.4s')
  assert.equal(formatDispatchDuration(64_000), '1m04s', 'no space inside the duration')
  assert.equal(formatDispatchDuration(3_780_000), '1h03m')
  assert.equal(formatDispatchDuration(172_800_000), '2d')
  assert.equal(formatDispatchDuration(0), '0ms')
  assert.equal(formatDispatchDuration(null), '\u2014', 'no timestamp renders an em dash')
  assert.equal(formatDispatchDuration(Number.NaN), '\u2014')
  assert.equal(formatDispatchDuration(-1), '\u2014')
  for (const ms of [820, 12_400, 64_000, 3_780_000]) {
    assert.equal(
      / /.test(formatDispatchDuration(ms)),
      false,
      `a duration never contains a space (${formatDispatchDuration(ms)})`,
    )
  }

  const running = {
    id: 'ses_a',
    label: 'apo-1',
    state: 'running',
    agent: 'apollo',
    model: 'gpt-5.6',
    cost: 0.04,
    startedAt: 1_000,
    updatedAt: 1_000,
  }
  assert.equal(dispatchElapsed(running, 13_400), '12.4s', 'a live row measures now - created')
  const done = { ...running, state: 'completed', startedAt: 1_000, updatedAt: 65_000 }
  assert.equal(dispatchElapsed(done, 999_999), '1m04s', 'a finished row freezes created→updated')
  assert.equal(dispatchElapsed({ ...done, updatedAt: null }, 999_999), '\u2014')
  assert.equal(dispatchElapsed({ ...running, startedAt: null }, 999_999), '\u2014')

  assert.equal(dispatchAgentText(running), 'apollo', 'the agent names the row')
  assert.equal(
    dispatchAgentText({ ...running, agent: null, label: 'apo-1' }),
    'apo-1',
    'an agent-less child falls back to its title',
  )
  assert.equal(
    dispatchAgentText({ ...running, agent: null, label: 'ses_abc1' }),
    'ses_abc1',
    'a child with no agent and no title falls back to its short id',
  )
  assert.equal(
    dispatchAgentText({ ...running, agent: 'a'.repeat(20) }),
    `${'a'.repeat(DISPATCH_AGENT_WIDTH - 1)}\u2026`,
    'a long agent truncates to the column width',
  )
  assert.equal(
    dispatchAgentText({ id: '', label: '', agent: null }),
    '\u2014',
    'nothing to name renders an em dash, never undefined',
  )

  assert.equal(dispatchModelText(running), 'gpt-5.6')
  assert.equal(dispatchModelText({ ...running, model: null }), '', 'no model, no column')
  assert.equal(
    dispatchModelText({ ...running, model: 'gpt-5.6-luna-fast' }),
    `${'gpt-5.6-luna-fast'.slice(0, DISPATCH_MODEL_WIDTH - 1)}\u2026`,
    `a long model truncates to ${DISPATCH_MODEL_WIDTH}`,
  )

  assert.equal(formatDispatchCost(0.04), '$0.04', 'two decimals')
  assert.equal(formatDispatchCost(0), '$0.00', 'a zero cost is explicit, never blank')
  assert.equal(formatDispatchCost(0.0031), '$0.0031', 'sub-cent keeps its real value')
  assert.equal(formatDispatchCost(null), '\u2014', 'no numeric cost renders an em dash')
  assert.equal(formatDispatchCost(undefined), '\u2014')
  assert.equal(formatDispatchCost(Number.NaN), '\u2014')

  // One live row: spinner + agent 12 + model 7 + cost 5 + duration 5 = 34.
  const cost = (value) => value.padStart(DISPATCH_COST_WIDTH)
  const duration = (value) => value.padStart(DISPATCH_DURATION_WIDTH)
  const fullRow = runningChildRowText(running, 13_400)
  assert.equal(
    fullRow,
    `\u280B ${'apollo'.padEnd(DISPATCH_AGENT_WIDTH)} ${'gpt-5.6'.padEnd(DISPATCH_MODEL_WIDTH)} ${cost('$0.04')} ${duration('12.4s')}`,
    'the full row is agent + model + cost + duration, columns aligned',
  )
  assert.equal(fullRow.length, DISPATCH_MAX_WIDTH)

  // A long duration overflows the budget: the model goes first, the cost stays.
  const sixSeconds = runningChildRowText({ ...running, startedAt: 0 }, 14 * 60_000 + 34_000)
  assert.equal(
    sixSeconds,
    `\u280B ${'apollo'.padEnd(DISPATCH_AGENT_WIDTH)} ${cost('$0.04')} ${duration('14m34s')}`,
    'the model is dropped before the cost',
  )
  assert.equal(hasMoney(sixSeconds), true)

  // A missing cost keeps the em dash, never an empty column.
  const noCost = runningChildRowText({ ...running, cost: undefined }, 13_400)
  assert.equal(
    noCost,
    `\u280B ${'apollo'.padEnd(DISPATCH_AGENT_WIDTH)} ${'gpt-5.6'.padEnd(DISPATCH_MODEL_WIDTH)} ${cost('\u2014')} ${duration('12.4s')}`,
  )

  // Narrow budgets shrink the agent column, never the cost.
  const narrow = runningChildRowText(running, 13_400, 0, 24)
  assert.ok(narrow.length <= 24, `a narrowed row fits 24 columns (got ${narrow.length})`)
  assert.ok(narrow.includes('$0.04'), 'the cost survives every narrowing')
  assert.ok(narrow.includes('12.4s'), 'the duration survives too')
  assert.equal(
    narrow.slice(2, 2 + DISPATCH_MIN_AGENT_WIDTH),
    'apollo  ',
    'the agent column stops at its minimum width',
  )

  // Rollup rows: agent 12 · ×count 3 · cost 7, cost descending at the block.
  const groupCell = (agent, count, cash) =>
    `${agent.padEnd(DISPATCH_AGENT_WIDTH)} \u00D7${String(count).padStart(3)} ${cash.padStart(7)}`
  assert.equal(
    childAgentRowText({ agent: 'prometheus', count: 3, cost: 0.21 }),
    groupCell('prometheus', 3, '$0.21'),
  )
  assert.equal(
    childAgentRowText({ agent: 'iris', count: 1, cost: 0.0051 }),
    groupCell('iris', 1, '$0.0051'),
    'the wider sub-cent cost keeps its own column',
  )
  assert.equal(
    childAgentRowText({ agent: 'talos', count: 100, cost: 0 }),
    groupCell('talos', 100, '$0.00'),
    'a three-digit count and a zero cost still align',
  )
  assert.ok(
    childAgentRowText({ agent: 'a'.repeat(20), count: 2, cost: 0.01 }).length <= DISPATCH_MAX_WIDTH,
  )
  assert.equal(hasMoney(childAgentRowText({ agent: '?', count: 1, cost: 0 })), true)
  assert.equal(
    childAgentRowText({ agent: 'a'.repeat(20), count: 2, cost: 0.01 }, 22).includes('$0.01'),
    true,
    'the agent shrinks before the cost on a narrow budget',
  )

  assert.equal(hiddenChildAgentsText(0, 0), null, 'nothing hidden, no line')
  assert.equal(hiddenChildAgentsText(6, 1.02), '\u2026 +6  $1.02')
  assert.equal(hiddenChildAgentsText(6, 0), '\u2026 +6  $0.00', 'a zero sum still prints')
  assert.equal(hiddenChildAgentsText(1, 0.0031), '\u2026 +1  $0.0031')

  assert.equal(completedSummaryText(0, 0, 0), null, 'nothing finished, no summary')
  assert.equal(completedSummaryText(70, 3.4, 9), '\u2713 70 \u00B7 $3.40 \u00B7 9 agentes')
  assert.equal(
    completedSummaryText(3, 0, 1),
    '\u2713 3',
    'a zero spend drops the `$` part and a single agent drops `· 1 agente`',
  )
  assert.equal(
    completedSummaryText(2, 0.0031, 2),
    '\u2713 2 \u00B7 $0.0031 \u00B7 2 agentes',
    'a sub-cent total keeps four decimals instead of collapsing to $0.00',
  )

  assert.equal(failedSuffixText(0), null, 'no failure, no suffix')
  assert.equal(failedSuffixText(1), '1 falha', 'one failure is singular')
  assert.equal(failedSuffixText(3), '3 falhas')

  assert.equal(dispatchHeaderSummary(2, 0.47), '2 rodando \u00B7 $0.47')
  assert.equal(dispatchHeaderSummary(0, 0.47), '$0.47', 'no live job, cost only')
  assert.equal(dispatchHeaderSummary(0, 0), '$0.00', 'a subtree that spent nothing says so')
  assert.equal(dispatchHeaderSummary(1, null), '1 rodando \u00B7 $0.00')
  assert.equal(dispatchHeaderSummary(Number.NaN, Number.NaN), '$0.00')

  assert.equal(dispatchTotalCost([running, done]), 0.08, 'live + finished')
  assert.equal(dispatchTotalCost([{ ...running, cost: undefined }]), 0, 'absent costs count zero')
  assert.equal(dispatchTotalCost([]), 0)
})

test('Dispatch block: running first (newest first), finished grouped by agent, root excluded', async () => {
  const { createSidebarModel, childAgentRowText, failedSuffixText } = await loadV2()
  const now = Date.now()
  const host = createSidebarHost({
    children: [
      ['ses_root', { id: 'ses_root', agent: 'zeus', time: { created: now, updated: now } }],
      [
        'ses_old',
        {
          id: 'ses_old',
          parentID: 'ses_root',
          agent: 'apollo',
          cost: 0.1,
          time: { created: now - 20_000, updated: now - 10_000 },
        },
      ],
      [
        'ses_new',
        {
          id: 'ses_new',
          parentID: 'ses_root',
          agent: 'iris',
          cost: 0.2,
          time: { created: now - 5_000, updated: now - 1_000 },
        },
      ],
      [
        'ses_done_a',
        {
          id: 'ses_done_a',
          parentID: 'ses_root',
          agent: 'demeter',
          cost: 0.3,
          outcome: 'succeeded',
          time: { created: now - 9_000, updated: now - 8_000 },
        },
      ],
      [
        'ses_done_b',
        {
          id: 'ses_done_b',
          parentID: 'ses_root',
          agent: 'demeter',
          cost: 0.2,
          outcome: 'succeeded',
          time: { created: now - 7_000, updated: now - 6_000 },
        },
      ],
      [
        'ses_dead',
        {
          id: 'ses_dead',
          parentID: 'ses_root',
          agent: 'talos',
          cost: 0.15,
          outcome: 'failed',
          time: { created: now - 4_000, updated: now - 3_000 },
        },
      ],
    ],
    statuses: [
      ['ses_old', 'running'],
      ['ses_new', 'running'],
    ],
    family: ['ses_root', 'ses_old', 'ses_new', 'ses_done_a', 'ses_done_b', 'ses_dead'],
  })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    await sleep(20)
    const view = model.dispatch()
    assert.deepEqual(
      view.running.map((row) => row.id),
      ['ses_new', 'ses_old'],
      'the most recently active live child leads; the root is never a child',
    )
    assert.equal(view.runningCount, 2)
    assert.equal(view.completedCount, 3, 'the failed child counts as finished, not as a row')
    assert.equal(view.failures, 1)
    assert.equal(view.agentCount, 2, 'two agents own the three finished children')
    assert.equal(view.summary, '\u2713 3 \u00B7 $0.65 \u00B7 2 agentes')
    assert.equal(failedSuffixText(view.failures), '1 falha')
    assert.deepEqual(
      view.agents.map((row) => [row.agent, row.count, Number(row.cost.toFixed(2))]),
      [
        ['demeter', 2, 0.5],
        ['talos', 1, 0.15],
      ],
      'finished children are aggregated per agent, never one row per session',
    )
    for (const row of view.agents) assert.equal(hasMoney(childAgentRowText(row)), true)
    assert.equal(
      model.dispatch().totalCost.toFixed(2),
      '0.95',
      'the header total sums the live and the finished children',
    )
  } finally {
    dispose()
  }
})

test('Dispatch caps: 3 live rows plus "… +N rodando", 3 agents plus "… +K  $sum"', async () => {
  const { createSidebarModel, DISPATCH_RUNNING_CEILING, DISPATCH_AGENT_CEILING } = await loadV2()
  const now = Date.now()
  const children = [['ses_root', { id: 'ses_root', time: { created: now, updated: now } }]]
  const statuses = []
  // Five running children (each with its own agent) and five finished agents.
  for (let index = 0; index < 5; index += 1) {
    children.push([
      `ses_live_${index}`,
      {
        id: `ses_live_${index}`,
        parentID: 'ses_root',
        agent: `live-${index}`,
        cost: 0.01 * (index + 1),
        time: { created: now - 2_000, updated: now - index * 100 },
      },
    ])
    statuses.push([`ses_live_${index}`, 'running'])
    children.push([
      `ses_done_${index}`,
      {
        id: `ses_done_${index}`,
        parentID: 'ses_root',
        agent: `done-${index}`,
        cost: 0.1 * (index + 1),
        outcome: 'succeeded',
        time: { created: now - 9_000, updated: now - 5_000 },
      },
    ])
  }
  const host = createSidebarHost({
    children,
    statuses,
    family: ['ses_root', ...children.slice(1).map(([id]) => id)],
  })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    await sleep(20)
    const view = model.dispatch()
    assert.equal(DISPATCH_RUNNING_CEILING, 3)
    assert.equal(DISPATCH_AGENT_CEILING, 3)
    assert.equal(view.running.length, 3, 'three live rows render')
    assert.equal(view.runningHidden, 2, 'the rest collapse into `… +N rodando`')
    assert.deepEqual(
      view.running.map((row) => row.id),
      ['ses_live_0', 'ses_live_1', 'ses_live_2'],
      'the cap keeps the most recently active rows',
    )
    // Five live rows already cost four lines (three + overflow), so the rollup
    // yields to keep the block inside eight: one agent row plus its overflow,
    // which still reports the spend of the agents it hides.
    assert.equal(view.agents.length, 1, 'the rollup gives up rows before the live section')
    assert.equal(view.agentsHidden, 4)
    assert.equal(
      view.agentsHiddenCost.toFixed(2),
      '1.00',
      '0.4 + 0.3 + 0.2 + 0.1 stay summed, not lost',
    )
    assert.deepEqual(
      view.agents.map((row) => row.agent),
      ['done-4'],
      'cost descending',
    )
    assert.equal(view.summary, '\u2713 5 \u00B7 $1.50 \u00B7 5 agentes')
    const rendered =
      1 +
      view.running.length +
      (view.runningHidden > 0 ? 1 : 0) +
      (view.summary === null ? 0 : 1) +
      view.agents.length +
      (view.agentsHidden > 0 ? 1 : 0)
    assert.ok(rendered <= 8, `the block never exceeds eight lines (got ${rendered})`)
  } finally {
    dispose()
  }
})

/* ─── Dispatch kind ───────────────────────────────────────
 * The host's own row answers who runs and how much it spent, never why the
 * child exists. The purpose comes from the parent's own `subagent` call — its
 * bracketed description prefix first, the spawning agent as the fallback — and a
 * child that cannot be correlated to a call stays unclassified instead of being
 * guessed. */

/** One assistant message carrying a single `subagent` call. */
function subagentMessage(
  id,
  { sessionID, agent, description, background, status = 'completed', content } = {},
) {
  const input = { agent, description, prompt: 'p' }
  if (background !== undefined) input.background = background
  const state = { status, input }
  if (sessionID !== undefined) state.metadata = { sessionID }
  if (content !== undefined) state.content = content
  return {
    id,
    type: 'assistant',
    model: { id: 'm', providerID: 'p' },
    content: [{ type: 'tool', id: `part-${id}`, name: 'subagent', time: { created: 1 }, state }],
  }
}

test('Dispatch kind: the description prefix wins, the agent is only the fallback', async () => {
  const {
    classifyDispatchKind,
    dispatchKindFromPrefix,
    dispatchKindFromAgent,
    dispatchKindSuffix,
  } = await loadV2()

  // Every declared prefix, mapped to its short label.
  assert.deepEqual(
    ['[council]', '[plan]', '[review]', '[hotfix]', '[discovery]'].map((prefix) =>
      classifyDispatchKind({ description: `${prefix} task`, agent: 'aphrodite' }),
    ),
    [
      { kind: 'coun', origin: 'prefix' },
      { kind: 'plan', origin: 'prefix' },
      { kind: 'revw', origin: 'prefix' },
      { kind: 'hot', origin: 'prefix' },
      { kind: 'disc', origin: 'prefix' },
    ],
    'council/plan/review/hotfix/discovery → coun/plan/revw/hot/disc',
  )

  // Case-insensitive and space-tolerant inside the brackets.
  assert.equal(dispatchKindFromPrefix('  [REVIEW] audit auth'), 'revw')
  assert.equal(dispatchKindFromPrefix('[  Council  ] round'), 'coun')
  assert.equal(dispatchKindFromPrefix('[HotFix] css'), 'hot')

  // The prefix is the declared intent, so it beats the agent it was sent to.
  assert.deepEqual(
    classifyDispatchKind({ description: '[discovery] scout the docs', agent: 'themis' }),
    { kind: 'disc', origin: 'prefix' },
    'a [discovery] sent to themis is still a discovery',
  )
  assert.deepEqual(
    classifyDispatchKind({ description: '  [council] five specialists', agent: 'zeus' }),
    { kind: 'coun', origin: 'prefix' },
  )

  // No prefix → the agent decides.
  assert.deepEqual(
    ['athena', 'themis', 'talos', 'apollo'].map((agent) =>
      classifyDispatchKind({ description: 'no prefix here', agent }),
    ),
    [
      { kind: 'plan', origin: 'agent' },
      { kind: 'revw', origin: 'agent' },
      { kind: 'hot', origin: 'agent' },
      { kind: 'disc', origin: 'agent' },
    ],
  )

  // An agent that implies nothing is still a real dispatch: `oth`, never null.
  assert.deepEqual(classifyDispatchKind({ description: 'build it', agent: 'zeus' }), {
    kind: 'oth',
    origin: 'agent',
  })
  assert.deepEqual(classifyDispatchKind({ description: '', agent: '' }), {
    kind: 'oth',
    origin: 'agent',
  })
  assert.deepEqual(classifyDispatchKind({ description: undefined, agent: undefined }), {
    kind: 'oth',
    origin: 'agent',
  })

  // council is a declared convention, never an agent identity.
  for (const agent of [
    'athena',
    'themis',
    'talos',
    'apollo',
    'zeus',
    'iris',
    'hermes',
    'council',
  ]) {
    assert.notEqual(
      classifyDispatchKind({ description: 'plain description', agent }).kind,
      'coun',
      `${agent} never implies council on its own`,
    )
    assert.equal(
      dispatchKindFromAgent(agent),
      agent === 'council' ? null : dispatchKindFromAgent(agent),
    )
  }

  // A word that only *looks* like a prefix is not one: the agent still decides.
  assert.deepEqual(classifyDispatchKind({ description: '[plans] later', agent: 'athena' }), {
    kind: 'plan',
    origin: 'agent',
  })
  assert.deepEqual(classifyDispatchKind({ description: 'plans [review]', agent: 'athena' }), {
    kind: 'plan',
    origin: 'agent',
  })

  // No call at all is the only `unavailable` outcome — never a guess.
  assert.deepEqual(classifyDispatchKind(null), { kind: null, origin: 'unavailable' })
  assert.deepEqual(classifyDispatchKind(undefined), { kind: null, origin: 'unavailable' })

  // Malformed evidence never throws.
  assert.doesNotThrow(() => classifyDispatchKind({ description: 42, agent: null }))
  assert.equal(dispatchKindFromPrefix(null), null)
  assert.equal(dispatchKindFromPrefix({}), null)
  assert.equal(dispatchKindFromAgent(undefined), null)

  // The suffix glues to a label: `·disc`, `·disc~` in background, '' otherwise.
  assert.equal(dispatchKindSuffix('disc'), '\u00B7disc')
  assert.equal(dispatchKindSuffix('disc', true), '\u00B7disc~')
  assert.equal(dispatchKindSuffix('disc', false), '\u00B7disc')
  assert.equal(dispatchKindSuffix(null, true), '', 'no kind, no suffix — not even the marker')
  assert.equal(dispatchKindSuffix(undefined), '')
})

test('subagent correlation: metadata.sessionID first, content fallback, streaming ignored', async () => {
  const { collectSubagentCalls } = await loadV2()

  const calls = collectSubagentCalls([
    subagentMessage('m1', {
      sessionID: 'ses_disc',
      agent: 'apollo',
      description: '[discovery] scout the docs',
      background: true,
    }),
    subagentMessage('m2', { sessionID: 'ses_fg', agent: 'themis', description: '[review] audit' }),
    subagentMessage('m3', {
      sessionID: 'ses_explicit_fg',
      agent: 'talos',
      description: '[hotfix] css',
      background: false,
    }),
  ])
  assert.equal(calls.get('ses_disc')?.background, true, 'background: true is carried')
  assert.equal(calls.get('ses_fg')?.background, false, 'an absent background is not background')
  assert.equal(calls.get('ses_explicit_fg')?.background, false, 'background: false is carried')
  assert.deepEqual(
    [...calls.values()],
    [
      {
        sessionID: 'ses_disc',
        agent: 'apollo',
        description: '[discovery] scout the docs',
        background: true,
      },
      { sessionID: 'ses_fg', agent: 'themis', description: '[review] audit', background: false },
      {
        sessionID: 'ses_explicit_fg',
        agent: 'talos',
        description: '[hotfix] css',
        background: false,
      },
    ],
    'one entry per correlated child, keyed by its session id',
  )

  // metadata.sessionID is the exact evidence and wins over the result text.
  assert.deepEqual(
    [
      ...collectSubagentCalls([
        subagentMessage('m4', {
          sessionID: 'ses_meta',
          agent: 'athena',
          description: '[plan] phases',
          content: [{ type: 'text', text: '<subagent sessionID="ses_other" state="completed">' }],
        }),
      ]).keys(),
    ],
    ['ses_meta'],
  )

  // No metadata: the result tag `<subagent sessionID="…">` is the fallback.
  assert.deepEqual(
    [
      ...collectSubagentCalls([
        subagentMessage('m5', {
          agent: 'athena',
          description: '[plan] phases',
          content: [
            { type: 'text', text: 'working' },
            { type: 'text', text: '<subagent sessionID="ses_content" state="completed">ok' },
          ],
        }),
      ]).keys(),
    ],
    ['ses_content'],
  )

  // A running call whose metadata already names the child still correlates —
  // that is what classifies a live row. A call with no child yet contributes
  // nothing.
  assert.deepEqual(
    [
      ...collectSubagentCalls([
        subagentMessage('m6', { sessionID: 'ses_live', agent: 'apollo', status: 'running' }),
        subagentMessage('m7', { agent: 'apollo', status: 'running' }),
      ]).keys(),
    ],
    ['ses_live'],
  )

  // streaming/pending carry their input as partial JSON text: skipped, not parsed.
  assert.equal(
    collectSubagentCalls([
      {
        id: 'm8',
        type: 'assistant',
        content: [
          {
            type: 'tool',
            id: 'part-m8',
            name: 'subagent',
            state: {
              status: 'streaming',
              input: '{"agent":"apollo","description":"[discovery] sc',
            },
          },
        ],
      },
      {
        id: 'm9',
        type: 'assistant',
        content: [
          {
            type: 'tool',
            id: 'part-m9',
            name: 'subagent',
            state: { status: 'pending', input: '{"agent":"apollo"' },
          },
        ],
      },
    ]).size,
    0,
    'a partially streamed call has no child to correlate',
  )

  // Only the host's `subagent` tool counts (it is not `task`).
  assert.equal(
    collectSubagentCalls([
      {
        id: 'm10',
        type: 'assistant',
        content: [
          {
            type: 'tool',
            id: 'part-m10',
            name: 'task',
            state: {
              status: 'completed',
              input: { agent: 'apollo' },
              metadata: { sessionID: 'ses_task' },
            },
          },
        ],
      },
    ]).size,
    0,
    'the V1 `task` tool name is not the V2 dispatch call',
  )

  // Fail-open on a hostile transcript.
  assert.equal(collectSubagentCalls(null).size, 0)
  assert.equal(collectSubagentCalls(undefined).size, 0)
  assert.equal(collectSubagentCalls([]).size, 0)
  assert.doesNotThrow(() =>
    collectSubagentCalls([
      { id: 'm11', type: 'assistant', content: 'nope' },
      { id: 'm12', type: 'user' },
      { id: 'm13', type: 'assistant', content: [null] },
      { id: 'm14', type: 'assistant', content: [{ type: 'tool', name: 'subagent', state: null }] },
      {
        id: 'm15',
        type: 'assistant',
        content: [{ type: 'tool', name: 'subagent', state: { status: 'completed' } }],
      },
    ]),
  )
})

test('Dispatch rows carry the kind glued to the label, and a group only when it is uniform', async () => {
  const {
    runningChildRowText,
    childAgentRowText,
    collectChildAgentUsage,
    dispatchKindSuffix,
    DISPATCH_AGENT_WIDTH,
    DISPATCH_MAX_WIDTH,
    DISPATCH_MIN_AGENT_WIDTH,
  } = await loadV2()

  const running = {
    id: 'ses_a',
    label: 'apo-1',
    state: 'running',
    agent: 'apollo',
    model: 'gpt-5.6',
    cost: 0.04,
    startedAt: 1_000,
    updatedAt: 1_000,
    kind: 'disc',
    kindOrigin: 'prefix',
    background: false,
  }
  const cost = (value) => value.padStart(5)
  const duration = (value) => value.padStart(5)

  // The kind is the stronger evidence at this width: it takes the model's
  // columns, so a classified row is agent·kind + cost + duration.
  assert.equal(
    runningChildRowText(running, 13_400),
    `\u280B apollo\u00B7disc ${cost('$0.04')} ${duration('12.4s')}`,
    'spinner + agent·kind + cost + duration',
  )
  assert.equal(
    runningChildRowText({ ...running, background: true }, 13_400),
    `\u280B apollo\u00B7disc~ ${cost('$0.04')} ${duration('12.4s')}`,
    'the background marker rides the same glued suffix',
  )
  assert.equal(
    runningChildRowText({ ...running, agent: 'prometheus' }, 13_400),
    `\u280B prometheus\u00B7disc ${cost('$0.04')} ${duration('12.4s')}`,
    'a wider label keeps the kind in front of the cost',
  )
  assert.equal(
    runningChildRowText({ ...running, kind: null, kindOrigin: 'unavailable' }, 13_400),
    `\u280B ${'apollo'.padEnd(DISPATCH_AGENT_WIDTH)} ${'gpt-5.6'.padEnd(7)} ${cost('$0.04')} ${duration('12.4s')}`,
    'an unclassified row is byte-identical to the pre-kind row',
  )

  // The width budget holds for every combination, model present or not.
  const kinds = [null, 'coun', 'plan', 'revw', 'hot', 'disc', 'oth']
  const widths = []
  for (const kind of kinds) {
    for (const background of [true, false]) {
      for (const model of [null, 'gpt-5.6', 'gpt-5.6-luna-fast']) {
        for (const agent of ['apollo', 'prometheus-with-a-long-name', 'x']) {
          for (const cash of [0.04, 0.0031, 1234.5, undefined]) {
            const row = runningChildRowText(
              { ...running, kind, background, model, agent, cost: cash },
              13_400,
            )
            widths.push(row.length)
            assert.ok(
              row.length <= DISPATCH_MAX_WIDTH,
              `live row fits 34 columns (${row.length}): ${JSON.stringify(row)}`,
            )
            assert.ok(row.includes('$') || row.includes('\u2014'), 'the cost never disappears')
            assert.equal(
              row.split('\u00B7').length - 1,
              kind === null ? 0 : kind === 'coun' ? 1 : 1,
              'the suffix is the only middle dot on the row',
            )
          }
        }
      }
    }
  }
  assert.ok(Math.max(...widths) <= DISPATCH_MAX_WIDTH)

  // Rollup: same evidence rule per group — all or nothing.
  const finished = (agent, kind, background) => ({
    ...running,
    id: `ses_${agent}_${kind}_${background}`,
    state: 'completed',
    updatedAt: 5_000,
    agent,
    kind,
    background,
  })
  const uniform = collectChildAgentUsage([
    finished('aphrodite', 'plan', false),
    finished('aphrodite', 'plan', false),
  ])
  assert.deepEqual(
    uniform.map(({ agent, count, kind, background }) => ({ agent, count, kind, background })),
    [{ agent: 'aphrodite', count: 2, kind: 'plan', background: false }],
    'a group where every session agrees keeps the kind',
  )
  assert.equal(
    childAgentRowText(uniform[0]),
    `${'aphrodite'.padEnd(DISPATCH_AGENT_WIDTH)} \u00D7${'2'.padStart(3)}\u00B7plan ${'$0.08'.padStart(7)}`,
    'agent 12 · ×count 3·kind · cost 7',
  )

  const mixed = collectChildAgentUsage([
    finished('iris', 'revw', false),
    finished('iris', 'hot', false),
  ])
  assert.equal(mixed[0].kind, null, 'a mixed group has no single purpose')
  assert.equal(
    childAgentRowText(mixed[0]).includes('\u00B7'),
    false,
    'the mixed group row omits the kind entirely',
  )
  assert.equal(
    childAgentRowText(mixed[0]),
    `${'iris'.padEnd(DISPATCH_AGENT_WIDTH)} \u00D7${'2'.padStart(3)} ${'$0.08'.padStart(7)}`,
    'the pre-kind rollup row is unchanged',
  )

  const uncorrelated = collectChildAgentUsage([finished('hermes', null, false)])
  assert.equal(uncorrelated[0].kind, null, 'no classification, nothing to show')

  const backgroundGroup = collectChildAgentUsage([
    finished('apollo', 'disc', true),
    finished('apollo', 'disc', true),
  ])
  assert.deepEqual(
    [backgroundGroup[0].kind, backgroundGroup[0].background],
    ['disc', true],
    'a group that is entirely background keeps the marker',
  )
  assert.equal(
    childAgentRowText(backgroundGroup[0]).includes('\u00B7disc~'),
    true,
    'the group marker is `·disc~`',
  )
  assert.equal(
    collectChildAgentUsage([finished('apollo', 'disc', true), finished('apollo', 'disc', false)])[0]
      .background,
    false,
    'a half-background group claims no marker',
  )

  // The rollup row stays inside the budget for every kind/flag combination.
  for (const kind of kinds) {
    for (const background of [true, false]) {
      for (const count of [1, 8, 100]) {
        for (const cash of [0, 0.0031, 12.5]) {
          for (const agent of ['iris', 'a'.repeat(24)]) {
            const row = childAgentRowText({ agent, count, cost: cash, kind, background })
            assert.ok(
              row.length <= DISPATCH_MAX_WIDTH,
              `rollup row fits 34 columns (${row.length}): ${JSON.stringify(row)}`,
            )
            assert.ok(row.includes('$') || row.includes('\u2014'))
          }
        }
      }
    }
  }
  // A narrow budget still shrinks the agent before the kind or the cost; only a
  // budget too tight even for the minimum column makes the kind yield.
  const narrow = childAgentRowText(
    { agent: 'prometheus', count: 8, cost: 0.4, kind: 'plan', background: false },
    24,
  )
  assert.ok(narrow.length <= 24, `a narrowed rollup fits 24 columns (got ${narrow.length})`)
  assert.ok(narrow.includes('$0.40'), 'the cost survives every narrowing')
  assert.equal(
    narrow.includes('\u00B7plan'),
    false,
    'the kind yields instead of overflowing the budget',
  )
  assert.equal(
    childAgentRowText(
      { agent: 'prometheus', count: 8, cost: 0.4, kind: 'plan', background: false },
      26,
    ).includes('\u00B7plan'),
    true,
    'a budget one character wider keeps the kind',
  )
  assert.equal(
    narrow.slice(0, DISPATCH_MIN_AGENT_WIDTH).includes('\u00B7'),
    false,
    'the kind never eats the agent column',
  )
  assert.equal(dispatchKindSuffix('plan'), '\u00B7plan')
})

test('Dispatch kind: the model correlates the parent transcript with its children', async () => {
  const { createSidebarModel, childAgentRowText, DISPATCH_MAX_WIDTH } = await loadV2()
  const now = Date.now()
  const host = createSidebarHost({
    children: [
      ['ses_root', { id: 'ses_root', agent: 'zeus', time: { created: now, updated: now } }],
      [
        'ses_live',
        {
          id: 'ses_live',
          parentID: 'ses_root',
          agent: 'apollo',
          model: { id: 'gpt-5.6', providerID: 'opencode-go' },
          cost: 0.04,
          time: { created: now - 12_700, updated: now - 100 },
        },
      ],
      [
        'ses_plan_a',
        {
          id: 'ses_plan_a',
          parentID: 'ses_root',
          agent: 'demeter',
          cost: 0.2,
          outcome: 'succeeded',
          time: { created: now - 9_000, updated: now - 8_000 },
        },
      ],
      [
        'ses_plan_b',
        {
          id: 'ses_plan_b',
          parentID: 'ses_root',
          agent: 'demeter',
          cost: 0.1,
          outcome: 'succeeded',
          time: { created: now - 7_000, updated: now - 6_000 },
        },
      ],
      [
        'ses_mixed_a',
        {
          id: 'ses_mixed_a',
          parentID: 'ses_root',
          agent: 'iris',
          cost: 0.05,
          outcome: 'succeeded',
          time: { created: now - 5_000, updated: now - 4_000 },
        },
      ],
      [
        'ses_mixed_b',
        {
          id: 'ses_mixed_b',
          parentID: 'ses_root',
          agent: 'iris',
          cost: 0.01,
          outcome: 'succeeded',
          time: { created: now - 3_000, updated: now - 2_000 },
        },
      ],
      [
        'ses_unknown',
        {
          id: 'ses_unknown',
          parentID: 'ses_root',
          agent: 'hermes',
          cost: 0.01,
          outcome: 'succeeded',
          time: { created: now - 1_000, updated: now - 500 },
        },
      ],
    ],
    statuses: [['ses_live', 'running']],
    family: [
      'ses_root',
      'ses_live',
      'ses_plan_a',
      'ses_plan_b',
      'ses_mixed_a',
      'ses_mixed_b',
      'ses_unknown',
    ],
    messages: [
      [
        'ses_root',
        [
          subagentMessage('m1', {
            sessionID: 'ses_live',
            agent: 'apollo',
            description: '[discovery] scout the docs',
            background: true,
            status: 'running',
          }),
          subagentMessage('m2', {
            sessionID: 'ses_plan_a',
            agent: 'demeter',
            description: '[plan] schema',
          }),
          subagentMessage('m3', {
            sessionID: 'ses_plan_b',
            agent: 'demeter',
            description: '[plan] indexes',
          }),
          subagentMessage('m4', {
            sessionID: 'ses_mixed_a',
            agent: 'iris',
            description: '[review] pr',
          }),
          subagentMessage('m5', {
            sessionID: 'ses_mixed_b',
            agent: 'iris',
            description: '[hotfix] typo',
          }),
          // ses_unknown has no call at all: the row stays unclassified.
        ],
      ],
    ],
  })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    await sleep(40)
    const view = model.dispatch()
    const live = view.running[0]
    assert.equal(live.id, 'ses_live')
    assert.match(
      live.text,
      /apollo\u00B7disc~ \$0\.04 12\.\ds$/,
      'a live row names its purpose and mode',
    )
    assert.ok(live.text.length <= DISPATCH_MAX_WIDTH)

    const rows = view.agents.map((row) => ({ ...row, text: childAgentRowText(row) }))
    const byAgent = Object.fromEntries(rows.map((row) => [row.agent, row]))
    assert.equal(
      byAgent.demeter.kind,
      'plan',
      'two [plan] children of one agent aggregate under a single kind',
    )
    assert.match(byAgent.demeter.text, /\u00D7\s*2\u00B7plan\s+\$0\.30$/)
    assert.equal(byAgent.iris.kind, null, 'review + hotfix never collapse into one label')
    assert.equal(byAgent.iris.text.includes('\u00B7'), false)
    assert.equal(byAgent.hermes.kind, null, 'a child without a correlatable call is unclassified')
    assert.equal(byAgent.hermes.text.includes('\u00B7'), false)
    for (const row of rows) assert.ok(row.text.length <= DISPATCH_MAX_WIDTH)
  } finally {
    dispose()
  }
})

test('sidebar block list drives the spacers, and absent blocks leave no gap', async () => {
  const { createSidebarModel, contextBlockRows, resetSpendUnit } = await loadV2()
  const now = Date.now()
  const root = {
    id: 'ses_root',
    agent: 'zeus',
    model: { id: 'kimi-k3', providerID: 'opencode-go' },
    time: { created: now, updated: now },
  }
  const messages = [
    [
      'ses_root',
      [
        {
          id: 'm1',
          type: 'assistant',
          model: { id: 'kimi-k3', providerID: 'opencode-go' },
          tokens: { input: 1_000 },
        },
      ],
    ],
  ]
  const models = [
    { id: 'row-kimi', modelID: 'kimi-k3', providerID: 'opencode-go', limit: { context: 200_000 } },
  ]

  const full = createSidebarHost({
    children: [['ses_root', root]],
    family: ['ses_root'],
    messages,
    models,
    costs: [['ses_root', 0.1]],
  })
  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(full.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    assert.deepEqual(
      model.blocks().map((entry) => [entry.key, entry.spacer]),
      [
        ['context', false],
        ['git', true],
      ],
      'no Spend/Todo/Dispatch without data, and no spacer before the first block',
    )
  } finally {
    dispose()
  }

  // Spend stats alone (no usage, no cost) keep Context up as the only block —
  // no Spend block of its own, and no spacer where it used to be.
  const { client } = createStatsClient((input) => ({
    range: { from: input.from, to: input.to },
    cost: 0.42,
  }))
  const spendOnly = createSidebarHost({
    client,
    costs: [['ses_root', Number.NaN]],
    children: [['ses_root', { id: 'ses_root' }]],
    family: ['ses_root'],
    vcs: null,
  })
  let statsModel
  const disposeStats = createRoot((disposeRoot) => {
    statsModel = createSidebarModel(spendOnly.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    await sleep(40)
    assert.equal(contextBlockRows(statsModel.contextUsage(), statsModel.cost()), null)
    assert.notEqual(statsModel.spend(), null, 'the local stats answered')
    assert.deepEqual(
      statsModel.blocks().map((entry) => [entry.key, entry.spacer]),
      [['context', false]],
      'the spend line keeps Context, alone and without a leading gap',
    )
  } finally {
    disposeStats()
    resetSpendUnit()
  }

  // Without a branch the Git block is absent, and nothing takes its spacer.
  const noVcs = createSidebarHost({
    children: [['ses_root', root]],
    family: ['ses_root'],
    messages,
    models,
    costs: [['ses_root', 0.1]],
    vcs: null,
  })
  let bare
  const disposeBare = createRoot((disposeRoot) => {
    bare = createSidebarModel(noVcs.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    assert.deepEqual(
      bare.blocks().map((entry) => [entry.key, entry.spacer]),
      [['context', false]],
      'an absent block is removed from the list instead of leaving an empty gap',
    )
  } finally {
    disposeBare()
  }

  // A child adds Dispatch as the last block, behind a spacer.
  const withChild = createSidebarHost({
    children: [
      ['ses_root', root],
      [
        'ses_child',
        {
          id: 'ses_child',
          parentID: 'ses_root',
          agent: 'apollo',
          outcome: 'succeeded',
          time: { created: now, updated: now },
        },
      ],
    ],
    family: ['ses_root', 'ses_child'],
    messages,
    models,
    costs: [
      ['ses_root', 0.1],
      ['ses_child', 0.05],
    ],
  })
  let withDispatch
  const disposeChild = createRoot((disposeRoot) => {
    withDispatch = createSidebarModel(withChild.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    assert.deepEqual(
      withDispatch.blocks().map((entry) => entry.key),
      ['context', 'git', 'dispatch'],
      'Dispatch closes the sidebar, right after the reference blocks',
    )
    assert.equal(withDispatch.blocks().at(-1).spacer, true)
  } finally {
    disposeChild()
  }
})

/* ─── Eleventh iteration: one aggregated `◈ Dispatch` block ─────────────
 * The duplicated `◇ agentes` block and the `⌗ Skills` block are gone. Dispatch
 * now carries two sections of its own: one row per live child (newest first,
 * three plus `… +N rodando`) and one row per *agent* for the finished ones
 * (`✓ <total> · $<soma> · <M> agentes`, then up to three `×<n>  $<soma>` rows
 * plus `… +K  $soma`, and `· <F> falhas` when anything failed). Every row is a
 * single preformatted line, so no column can be squeezed out by the layout —
 * the regression that made the old `agentes` rows print a bare name. */

test('sidebar model: Dispatch with 71 children never renders a row without money', async () => {
  const {
    createSidebarModel,
    childAgentRowText,
    runningChildRowText,
    hiddenChildAgentsText,
    completedSummaryText,
    DISPATCH_MAX_WIDTH,
    DISPATCH_MAX_LINES,
  } = await loadV2()
  const now = Date.now()
  const roster = [
    'prometheus',
    'iris',
    'talos',
    'apollo',
    'hermes',
    'mnemosyne',
    'aphrodite',
    'demeter',
    'themis',
  ]
  const children = [
    ['ses_root', { id: 'ses_root', agent: 'zeus', time: { created: now, updated: now } }],
  ]
  const statuses = []
  for (let index = 0; index < 71; index += 1) {
    const id = `ses_${String(index).padStart(3, '0')}`
    const live = index === 0
    children.push([
      id,
      {
        id,
        parentID: 'ses_root',
        agent: roster[index % roster.length],
        // One live child at $0.09, the rest at $0.05 each: 70 × 0.05 = $3.50.
        cost: live ? 0.09 : 0.05,
        time: {
          created: now - (index + 1) * 60_000,
          updated: live ? now : now - index * 1_000,
        },
        ...(live ? {} : { outcome: 'succeeded' }),
      },
    ])
    if (live) statuses.push([id, 'running'])
  }
  const host = createSidebarHost({
    children,
    statuses,
    family: ['ses_root', ...children.slice(1).map(([id]) => id)],
  })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    await sleep(20)
    const view = model.dispatch()
    assert.equal(view.runningCount, 1, 'one live child')
    assert.equal(view.completedCount, 70, 'seventy finished children')
    assert.equal(view.agentCount, 9, 'spread over nine agents')
    assert.equal(view.failures, 0)
    assert.equal(view.running.length, 1)
    assert.equal(view.agents.length, 3, 'three rollup rows, not 70 session rows')
    assert.equal(view.agentsHidden, 6)
    assert.equal(view.agentsHiddenCost.toFixed(2), '2.30')

    // Aggregation is per agent: ×count and the summed cost, ordered by cost.
    assert.deepEqual(
      view.agents.map((row) => [row.agent, row.count, Number(row.cost.toFixed(2))]),
      [
        ['aphrodite', 8, 0.4],
        ['apollo', 8, 0.4],
        ['demeter', 8, 0.4],
      ],
    )
    assert.equal(view.summary, '\u2713 70 \u00B7 $3.50 \u00B7 9 agentes')
    assert.equal(view.totalCost.toFixed(2), '3.59', 'live + finished, root excluded')

    // THE regression this iteration guards: no rendered line of the block may
    // lose its monetary value (the old per-session/multi-column row could).
    const lines = [
      ...view.running.map((row) => row.text),
      view.summary,
      ...view.agents.map((row) => childAgentRowText(row)),
      hiddenChildAgentsText(view.agentsHidden, view.agentsHiddenCost),
    ].filter((line) => typeof line === 'string' && line !== '')
    assert.equal(lines.length, 6)
    for (const line of lines) {
      assert.match(line, /\$|\u2014/, `every rendered line carries money: ${JSON.stringify(line)}`)
    }
    for (const row of view.agents) {
      assert.match(childAgentRowText(row), /\$\d/, 'an agent row always prints a cost')
      assert.match(childAgentRowText(row), /\u00D7\s*\d/, 'and its session count')
    }
    for (const line of lines) {
      assert.ok(line.length <= DISPATCH_MAX_WIDTH, `line inside ${DISPATCH_MAX_WIDTH}: ${line}`)
    }

    // Block budget: header + live rows + summary + rollup rows.
    const rendered =
      1 +
      view.running.length +
      (view.runningHidden > 0 ? 1 : 0) +
      (view.summary === null ? 0 : 1) +
      view.agents.length +
      (view.agentsHidden > 0 ? 1 : 0)
    assert.ok(rendered <= DISPATCH_MAX_LINES, `the block stays at ${rendered} ≤ 8 lines`)

    // The block is the sidebar's last one, and it is the only place the child
    // data shows up — no duplicated `agentes` block.
    assert.deepEqual(
      model.blocks().map((entry) => entry.key),
      ['context', 'git', 'dispatch'],
    )
    assert.equal(
      model.blocks().some((entry) => entry.key === 'agents'),
      false,
      'the duplicated agent block is gone',
    )

    // A live row is still a single preformatted line (the layout cannot squeeze
    // a column out of it): spinner + agent + cost + duration.
    const liveText = runningChildRowText(
      {
        id: 'ses_000',
        label: 'ses_000',
        state: 'running',
        agent: 'prometheus',
        model: null,
        cost: 0.09,
        startedAt: now - 874_000,
        updatedAt: now,
      },
      now,
    )
    assert.equal(liveText, '\u280B prometheus   $0.09 14m34s')
    assert.equal(hasMoney(liveText), true)

    // The summary drops the `$` part when nothing was spent, and `· 1 agente`
    // when a single agent owns everything.
    assert.equal(completedSummaryText(70, 0, 1), '\u2713 70')
  } finally {
    dispose()
  }
})

test('Dispatch: a failing family hides the block instead of inventing a child', async () => {
  const { createSidebarModel } = await loadV2()
  const host = createSidebarHost({
    children: [['ses_root', { id: 'ses_root', agent: 'zeus' }]],
    family: ['ses_root'],
    costs: [['ses_root', 0.2]],
  })
  host.context.data.session.family = () => {
    throw new Error('family unavailable')
  }
  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    await sleep(10)
    assert.equal(model.dispatch(), null, 'no family, no child, no block')
    assert.equal(
      model.blocks().some((entry) => entry.key === 'dispatch'),
      false,
      'the block (and its spacer) stay out of the sidebar',
    )
  } finally {
    dispose()
  }
})

test('Dispatch: a child with no agent lands in the ? bucket', async () => {
  const { createSidebarModel, childAgentRowText } = await loadV2()
  const now = Date.now()
  const host = createSidebarHost({
    children: [
      ['ses_root', { id: 'ses_root' }],
      [
        'ses_child',
        {
          id: 'ses_child',
          parentID: 'ses_root',
          cost: 0.1,
          outcome: 'succeeded',
          time: { created: now, updated: now },
        },
      ],
    ],
    family: ['ses_root', 'ses_child'],
  })
  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    await sleep(10)
    const view = model.dispatch()
    assert.deepEqual(
      view.agents.map((row) => row.agent),
      ['?'],
      'an agent-less child is bucketed as ?, never as undefined',
    )
    assert.equal(childAgentRowText(view.agents[0]).includes('$0.10'), true)
  } finally {
    dispose()
  }
})

test('Dispatch keeps click-through on live rows and adds no replace claim', async () => {
  const source = readFileSync(join(root, 'src/plugins/tui/src/index-v2.tsx'), 'utf8')

  assert.match(
    source,
    /onMouseDown=\{open\(row\.id\)\}/,
    'a live Dispatch row still navigates to the child session',
  )
  assert.equal(
    /onMouseDown=\{open\([^)]*\)\}[\s\S]{0,200}childAgentRowText/.test(source),
    false,
    'the aggregated rollup rows are not click targets (one row, many sessions)',
  )
  assert.ok(source.includes('label="Dispatch"'), 'the block header is `Dispatch`')
  assert.equal(
    /\breplace\s*:/.test(source),
    false,
    'no replace claim was introduced with the Dispatch block',
  )
  assert.equal(
    /from\s+['"][^'"]*src\/pantheon/.test(source),
    false,
    'the TUI entry still imports nothing from src/pantheon',
  )
  assert.match(
    source,
    /import \{ readFile \} from 'node:fs\/promises'/,
    'the TUI entry only ever reads from disk',
  )
  assert.equal(
    /\b(writeFile|appendFile|createWriteStream|unlink|mkdir)\b/.test(source),
    false,
    'the TUI entry never writes a file — cli.json included',
  )
})

test('gauge colors: blue → green → yellow → red, with the bar and the percent sharing one color', async () => {
  const { contextUsageTone, contextProgressColor, contextBlockRows } = await loadV2()

  const theme = {
    text: {
      base: '#111111',
      feedback: {
        info: { base: '#61afef' },
        success: { base: '#98c379' },
        warning: { base: '#e5c07b' },
        error: { base: '#e06c75' },
      },
    },
  }

  // Inclusive at the top of each band: 25/26, 50/51 and 90/91 split bands.
  const bands = [
    { percent: 0, tone: 'info', color: '#61afef' },
    { percent: 25, tone: 'info', color: '#61afef' },
    { percent: 26, tone: 'success', color: '#98c379' },
    { percent: 50, tone: 'success', color: '#98c379' },
    { percent: 51, tone: 'warning', color: '#e5c07b' },
    { percent: 90, tone: 'warning', color: '#e5c07b' },
    { percent: 91, tone: 'error', color: '#e06c75' },
    { percent: 100, tone: 'error', color: '#e06c75' },
  ]

  assert.deepEqual(
    bands.map(({ percent }) => contextUsageTone(percent)),
    bands.map(({ tone }) => tone),
    'each percentage lands in its own band',
  )
  assert.deepEqual(
    bands.map(({ percent }) => contextProgressColor(contextUsageTone(percent), theme)),
    bands.map(({ color }) => color),
    'each band resolves to its own feedback token, no literal color',
  )
  assert.equal(
    contextProgressColor('info', { text: { base: '#222222' } }),
    '#222222',
    'a theme without feedback tokens falls back to its base text',
  )
  assert.equal(
    contextProgressColor('error', undefined),
    undefined,
    'a missing theme yields no color instead of throwing',
  )

  // The percent row carries exactly one tone, and the view paints the filled
  // cells and the number with the same resolved color.
  for (const { percent, tone } of bands) {
    const row = contextBlockRows({ tokens: 10, percent, limit: 1_000 }, null)?.percent
    assert.equal(row?.tone, tone, `${percent}% keeps its band on the row`)
    assert.equal(
      contextProgressColor(row?.tone ?? 'info', theme),
      contextProgressColor(contextUsageTone(percent), theme),
      `${percent}% shares one color between bar and percent`,
    )
    assert.ok(row?.lead !== null && row?.value !== undefined)
  }

  const source = readFileSync(join(root, 'src/plugins/tui/src/index-v2.tsx'), 'utf8')
  const rowView = source.slice(
    source.indexOf('function ContextRowView'),
    source.indexOf('function BlockHeader'),
  )
  assert.ok(rowView.length > 0, 'the context row view was located')
  assert.equal(
    (rowView.match(/fg=\{props\.fg\}/g) ?? []).length,
    2,
    'filled cells and the percent value both read the one `fg` prop',
  )
  assert.match(rowView, /fg=\{props\.muted\}>\{tail\(\)\}/, 'the ▱ track stays muted')
  assert.match(
    source,
    /fg=\{gaugeFg\(row\(\)\)\}/,
    'the percent row resolves its color through the shared stage helper',
  )
  const helper = source.slice(
    source.indexOf('export function contextProgressColor'),
    source.indexOf('/** The muted extra line under the gauge'),
  )
  assert.equal(/#[0-9a-fA-F]{3,8}\b/.test(helper), false, 'the stage helper holds no literal color')
})

test('Context telemetry: cache hit and turn speed, hidden when unmeasurable', async () => {
  const {
    cacheHitPercent,
    turnTokensPerSecond,
    contextPerformanceLine,
    createSidebarModel,
    resetSpendUnit,
  } = await loadV2()

  assert.equal(Math.round(cacheHitPercent({ input: 800, cache: { read: 9_200 } })), 92)
  assert.equal(cacheHitPercent({ input: 0, cache: { read: 0 } }), null, '0/0 has no ratio')
  assert.equal(cacheHitPercent({ input: 100 }), null, 'no cache read means no ratio')
  assert.equal(cacheHitPercent({ cache: { read: 100 } }), null, 'no input means no denominator')
  assert.equal(cacheHitPercent(null), null)
  assert.equal(cacheHitPercent({ input: Number.NaN, cache: { read: 1 } }), null)

  /* Turn speed mirrors the host's `turnTokensPerSecond`: reasoning joins the
   * numerator, `completed` never enters, and the division happens once after
   * the per-step durations are summed. `streamed` is the only clock. */
  const user = (id) => ({ id, type: 'user' })
  const turn = (id, tokens, created, streamed, completed = streamed) => ({
    id,
    type: 'assistant',
    tokens,
    time: { created, streamed, completed },
  })

  assert.equal(
    turnTokensPerSecond([user('u1'), turn('a1', { output: 1_000, reasoning: 1_000 }, 0, 2_000)]),
    1_000,
    'output + reasoning is the numerator',
  )
  assert.equal(
    turnTokensPerSecond([user('u1'), turn('a1', { output: 400 }, 1_000, 3_000)]),
    200,
    'active streaming time is the denominator',
  )

  const completedIgnored = (completed) =>
    turnTokensPerSecond([user('u1'), turn('a1', { output: 400 }, 1_000, 3_000, completed)])
  assert.equal(completedIgnored(3_000), 200, 'completed === streamed')
  assert.equal(
    completedIgnored(3_000_000),
    completedIgnored(3_000),
    'a huge completed must not move the rate — it is not part of the formula',
  )

  assert.equal(
    turnTokensPerSecond([user('u1'), turn('a1', { output: 400 }, 1_000, null, 11_000)]),
    null,
    'a step without time.streamed hides the speed instead of falling back to completed',
  )
  assert.equal(
    turnTokensPerSecond([
      user('u1'),
      turn('a1', { output: 1_000 }, 0, 1_000),
      turn('a2', { output: 100 }, 0, 9_000),
    ]),
    110,
    '1,100 tokens over 10 s of active streaming — not the 505.5 mean of the two steps',
  )
  assert.equal(
    turnTokensPerSecond([
      turn('a0', { output: 9_000 }, 0, 1_000),
      user('u1'),
      turn('a1', { output: 400 }, 1_000, 3_000),
    ]),
    200,
    'only the steps of the current turn are aggregated',
  )
  assert.equal(
    turnTokensPerSecond([
      turn('a0', { output: 9_000 }, 0, 1_000),
      turn('a1', { output: 400 }, 1_000, 3_000),
    ]),
    200,
    'without a user message only the last step is measurable (degraded, documented)',
  )
  assert.equal(
    turnTokensPerSecond([user('u1'), turn('a1', { output: 0, reasoning: 0 }, 0, 1_000)]),
    null,
    'zero output and reasoning has no speed',
  )
  assert.equal(
    turnTokensPerSecond([user('u1'), turn('a1', { output: 420 }, 1_000, 1_000)]),
    null,
    'streamed === created is not a measurable speed',
  )
  assert.equal(
    turnTokensPerSecond([user('u1')]),
    null,
    'a turn with no assistant step has no speed',
  )
  assert.equal(turnTokensPerSecond([]), null)
  assert.equal(turnTokensPerSecond(null), null)

  assert.equal(
    contextPerformanceLine({ cacheHit: 92, tokensPerSecond: 42.34 }),
    'cache 92% · 42.3 tok/s',
  )
  assert.equal(contextPerformanceLine({ cacheHit: 92, tokensPerSecond: null }), 'cache 92%')
  assert.equal(contextPerformanceLine({ cacheHit: null, tokensPerSecond: 42 }), '42.0 tok/s')
  assert.equal(contextPerformanceLine({ cacheHit: null, tokensPerSecond: 0.04 }), '0.0 tok/s')
  assert.equal(contextPerformanceLine({ cacheHit: null, tokensPerSecond: null }), null)
  assert.equal(contextPerformanceLine(null), null)

  const now = Date.now()
  const message = (id, tokens, time) => ({ id, type: 'assistant', tokens, time })
  const host = createSidebarHost({
    children: [['ses_root', { id: 'ses_root' }]],
    family: ['ses_root'],
    messages: [
      [
        'ses_root',
        [
          message(
            'm1',
            { input: 800, output: 420, cache: { read: 9_200 } },
            { created: now - 10_000, streamed: now, completed: now + 5_000 },
          ),
        ],
      ],
    ],
  })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    await sleep(20)
    assert.deepEqual(model.performance(), { cacheHit: 92, tokensPerSecond: 42 })
    assert.equal(contextPerformanceLine(model.performance()), 'cache 92% · 42.0 tok/s')
  } finally {
    dispose()
  }

  // A zero cache denominator and a step with no `streamed` clock render no line.
  const hidden = createSidebarHost({
    children: [['ses_root', { id: 'ses_root' }]],
    family: ['ses_root'],
    messages: [
      [
        'ses_root',
        [
          message(
            'm1',
            { input: 0, output: 0, cache: { read: 0 } },
            { created: now, completed: now },
          ),
        ],
      ],
    ],
  })
  let bare
  const disposeBare = createRoot((disposeRoot) => {
    bare = createSidebarModel(hidden.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    await sleep(20)
    assert.equal(bare.performance(), null, 'nothing measurable, nothing rendered')
    assert.equal(contextPerformanceLine(bare.performance()), null)
  } finally {
    disposeBare()
    resetSpendUnit()
  }
})

test('Context telemetry: cache hit is independent of the turn being closed', async () => {
  const { createSidebarModel, contextPerformanceLine, resetSpendUnit } = await loadV2()
  const now = Date.now()
  /* 92% cache hit: readable from any assistant that carries `tokens`, whether or
   * not its turn has a `streamed` clock yet. */
  const cached = { input: 800, output: 0, cache: { read: 9_200 } }

  const performanceOf = async (messages, session = { id: 'ses_root' }) => {
    const host = createSidebarHost({
      children: [['ses_root', session]],
      family: ['ses_root'],
      messages: [['ses_root', messages]],
    })
    let model
    const dispose = createRoot((disposeRoot) => {
      model = createSidebarModel(host.context, () => 'ses_root')
      return disposeRoot
    })
    try {
      await sleep(20)
      return { model, host, dispose }
    } catch (error) {
      dispose()
      resetSpendUnit()
      throw error
    }
  }

  const cases = [
    {
      name: 'the current turn has no step with tokens yet (streaming placeholder last)',
      messages: [
        { id: 'u1', type: 'user' },
        {
          id: 'a1',
          type: 'assistant',
          tokens: cached,
          time: { created: now - 1_000, streamed: now },
        },
        { id: 'a2', type: 'assistant' },
      ],
      expected: { cacheHit: 92, tokensPerSecond: null },
    },
    {
      name: 'the newest step carries tokens but has no streamed clock (mid-stream)',
      messages: [
        { id: 'u1', type: 'user' },
        { id: 'a1', type: 'assistant', tokens: cached, time: { created: now } },
      ],
      expected: { cacheHit: 92, tokensPerSecond: null },
    },
    {
      name: 'no clock at all still reports the cache hit',
      messages: [{ id: 'a1', type: 'assistant', tokens: cached }],
      expected: { cacheHit: 92, tokensPerSecond: null },
    },
  ]

  for (const item of cases) {
    const { model, dispose } = await performanceOf(item.messages)
    try {
      assert.deepEqual(model.performance(), item.expected, item.name)
      assert.equal(contextPerformanceLine(model.performance()), 'cache 92%', item.name)
    } finally {
      dispose()
    }
  }

  /* The halves stay independent in the other direction too: a measurable turn
   * with a zero cache denominator shows only the speed. */
  const speedOnly = await performanceOf([
    { id: 'u1', type: 'user' },
    {
      id: 'a1',
      type: 'assistant',
      tokens: { input: 0, output: 420, cache: { read: 0 } },
      time: { created: now - 10_000, streamed: now },
    },
  ])
  try {
    assert.deepEqual(speedOnly.model.performance(), { cacheHit: null, tokensPerSecond: 42 })
    assert.equal(contextPerformanceLine(speedOnly.model.performance()), '42.0 tok/s')
  } finally {
    speedOnly.dispose()
  }

  /* A reverted-away message must not supply the rate: the window ends at the
   * revert boundary, exactly like the context gauge. */
  const reverted = await performanceOf(
    [
      { id: 'u1', type: 'user' },
      { id: 'a1', type: 'assistant', tokens: { input: 100, cache: { read: 900 } } },
      { id: 'u2', type: 'user' },
      { id: 'a2', type: 'assistant', tokens: cached },
    ],
    { id: 'ses_root', revert: { messageID: 'u2' } },
  )
  try {
    assert.equal(
      Math.round(reverted.model.performance().cacheHit),
      90,
      'the reverted-away assistant no longer feeds the cache hit',
    )
  } finally {
    reverted.dispose()
  }

  /* A compaction closes the window: nothing before it can feed the rate. */
  const compacted = await performanceOf([
    { id: 'a1', type: 'assistant', tokens: cached },
    { id: 'c1', type: 'compaction' },
  ])
  try {
    assert.equal(compacted.model.performance(), null, 'no usage after the compaction, no line')
    assert.equal(contextPerformanceLine(compacted.model.performance()), null)
  } finally {
    compacted.dispose()
    resetSpendUnit()
  }

  /* Reading the line costs no extra `message.list`: both halves ride the one
   * pass that feeds the gauge. */
  const counted = createSidebarHost({
    children: [['ses_root', { id: 'ses_root' }]],
    family: ['ses_root'],
    messages: [
      [
        'ses_root',
        [
          { id: 'u1', type: 'user' },
          {
            id: 'a1',
            type: 'assistant',
            tokens: cached,
            time: { created: now - 1_000, streamed: now },
          },
        ],
      ],
    ],
  })
  const calls = []
  const list = counted.context.data.session.message.list
  counted.context.data.session.message.list = (id) => {
    calls.push(id)
    return list(id)
  }
  let countedModel
  const disposeCounted = createRoot((disposeRoot) => {
    countedModel = createSidebarModel(counted.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    await sleep(20)
    /* The gauge already warms the shared `messages` memo; both telemetry halves
     * must then read it without touching `message.list` again. */
    countedModel.contextUsage()
    const before = calls.length
    countedModel.performance()
    countedModel.performance()
    assert.equal(
      calls.length,
      before,
      "the cache half and the turn half ride the gauge's single message.list pass",
    )
  } finally {
    disposeCounted()
    resetSpendUnit()
  }
})

/** Fake git runner: records every call and answers from `handler`. */
function fakeGitExec(handler) {
  const calls = []
  const exec = async (file, args, options) => {
    calls.push({ file, args: [...args], options })
    return handler(args)
  }
  return { exec, calls }
}

test('git CLI parsing: porcelain columns (untracked, rename, conflicts) and ahead/behind', async () => {
  const {
    parseGitStatusPorcelain,
    parseGitAheadBehind,
    formatGitSnapshot,
    readGitSnapshot,
    GIT_CLI_TIMEOUT_MS,
    GIT_CLI_MAX_BUFFER,
  } = await loadV2()

  const porcelain = [
    '?? new.ts',
    '!! ignored.log',
    ' M changed.ts',
    'A  staged-add.ts',
    'D  staged-del.ts',
    'R  old.ts -> renamed.ts',
    'AM both.ts',
    ' M other.ts',
  ].join('\n')
  assert.deepEqual(
    parseGitStatusPorcelain(porcelain),
    { added: 2, modified: 3, deleted: 1, untracked: 1 },
    'XY is read as two columns: ?? untracked, A added, D deleted, M/R modified',
  )
  assert.deepEqual(parseGitStatusPorcelain(''), { added: 0, modified: 0, deleted: 0, untracked: 0 })
  assert.deepEqual(parseGitStatusPorcelain(null), {
    added: 0,
    modified: 0,
    deleted: 0,
    untracked: 0,
  })

  assert.deepEqual(
    parseGitAheadBehind('3\t1\n'),
    { ahead: 1, behind: 3 },
    'left is the upstream-only count (behind), right is the HEAD-only count (ahead)',
  )
  assert.equal(parseGitAheadBehind(''), null, 'no upstream prints nothing')
  assert.equal(parseGitAheadBehind('fatal: no upstream configured'), null)
  assert.equal(parseGitAheadBehind(null), null)

  assert.equal(
    formatGitSnapshot({
      changes: { added: 1, modified: 2, deleted: 1, untracked: 2 },
      ahead: 3,
      behind: 1,
    }),
    '+1 ±2 \u22121 ?2 \u21913 \u21931',
    'counts then arrows, zero terms omitted',
  )
  assert.equal(
    formatGitSnapshot({
      changes: { added: 0, modified: 1, deleted: 0, untracked: 0 },
      ahead: null,
      behind: null,
    }),
    '±1',
    'no upstream means no arrows at all',
  )
  assert.equal(
    formatGitSnapshot({
      changes: { added: 0, modified: 0, deleted: 0, untracked: 0 },
      ahead: 0,
      behind: 0,
    }),
    null,
    'a clean, in-sync tree renders no row',
  )

  const { exec, calls } = fakeGitExec((args) =>
    args[0] === 'status' ? { stdout: '?? a.ts\n' } : { stdout: '0\t2\n' },
  )
  const snapshot = await readGitSnapshot('/repo', exec)
  assert.deepEqual(snapshot, {
    changes: { added: 0, modified: 0, deleted: 0, untracked: 1 },
    ahead: 2,
    behind: 0,
  })
  assert.deepEqual(calls[0].args, ['status', '--porcelain=v1', '-uall'])
  assert.deepEqual(calls[1].args, ['rev-list', '--count', '--left-right', '@{upstream}...HEAD'])
  assert.deepEqual(calls[0].options, {
    cwd: '/repo',
    timeout: GIT_CLI_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: GIT_CLI_MAX_BUFFER,
  })
  assert.equal(calls[0].file, 'git')

  // A failing rev-list (no upstream) keeps the counts and drops only the arrows.
  const withoutUpstream = fakeGitExec((args) => {
    if (args[0] === 'status') return { stdout: ' M a.ts\n' }
    throw new Error('fatal: no upstream configured')
  })
  assert.deepEqual(await readGitSnapshot('/repo', withoutUpstream.exec), {
    changes: { added: 0, modified: 1, deleted: 0, untracked: 0 },
    ahead: null,
    behind: null,
  })
})

test('git CLI is authoritative, falls back to vcs.status, and respects the cooldown', async () => {
  const { createSidebarModel, gitProbeAllowed, GIT_CLI_DEBOUNCE_MS, GIT_CLI_MIN_INTERVAL_MS } =
    await loadV2()

  assert.ok(GIT_CLI_DEBOUNCE_MS >= 1_000, 'the CLI revalidation debounce is at least one second')
  assert.equal(GIT_CLI_MIN_INTERVAL_MS, 5_000, 'cooldown between two probe starts')

  // Pure gate first: in-flight wins, and the cooldown is exclusive.
  assert.equal(gitProbeAllowed({ now: 0, lastRunAt: null, inFlight: false }), true)
  assert.equal(gitProbeAllowed({ now: 9_000, lastRunAt: 1_000, inFlight: true }), false)
  assert.equal(gitProbeAllowed({ now: 5_999, lastRunAt: 1_000, inFlight: false }), false)
  assert.equal(gitProbeAllowed({ now: 6_000, lastRunAt: 1_000, inFlight: false }), true)

  const vcsPayload = [
    { file: 'a.ts', status: 'added' },
    { file: 'b.ts', status: 'deleted' },
  ]
  const vcsClient = {
    vcs: { status: async () => ({ data: vcsPayload }) },
  }
  const rootChild = ['ses_root', { id: 'ses_root' }]

  // 1. The CLI answers: its counts (with `?` and the arrows) win over vcs.status.
  const cli = fakeGitExec((args) =>
    args[0] === 'status' ? { stdout: '?? new.ts\n M edited.ts\n' } : { stdout: '1\t3\n' },
  )
  const cliHost = createSidebarHost({
    directory: '/repo',
    client: vcsClient,
    children: [rootChild],
    family: ['ses_root'],
  })
  let cliModel
  const disposeCli = createRoot((disposeRoot) => {
    cliModel = createSidebarModel(cliHost.context, () => 'ses_root', cli.exec)
    return disposeRoot
  })
  try {
    await sleep(30)
    assert.equal(cliModel.gitLine(), '±1 ?1 \u21913 \u21931')
    assert.deepEqual(cliModel.gitCli()?.changes, {
      added: 0,
      modified: 1,
      deleted: 0,
      untracked: 1,
    })
    assert.equal(
      cli.calls.filter((call) => call.args[0] === 'status').length,
      1,
      'exactly one probe at mount — no interval polling',
    )

    // A burst of session events cannot start a second probe inside the cooldown.
    cliHost.emit('session.idle')
    cliHost.emit('session.status')
    await sleep(GIT_CLI_DEBOUNCE_MS + 80)
    assert.equal(
      cli.calls.filter((call) => call.args[0] === 'status').length,
      1,
      'the 5 s cooldown suppresses the burst instead of queueing it',
    )
    await sleep(400)
    assert.equal(
      cli.calls.filter((call) => call.args[0] === 'status').length,
      1,
      'nothing re-probes on its own — there is no polling timer',
    )
  } finally {
    disposeCli()
  }

  // 2. git fails: the vcs.status counts take over (branch-only if it also fails).
  const broken = fakeGitExec(() => {
    throw new Error('git: command not found')
  })
  const fallbackHost = createSidebarHost({
    directory: '/repo',
    client: vcsClient,
    children: [rootChild],
    family: ['ses_root'],
  })
  let fallbackModel
  const disposeFallback = createRoot((disposeRoot) => {
    fallbackModel = createSidebarModel(fallbackHost.context, () => 'ses_root', broken.exec)
    return disposeRoot
  })
  try {
    await sleep(40)
    assert.equal(fallbackModel.gitCli(), null, 'git never answered')
    assert.equal(fallbackModel.gitLine(), '+1 \u22121', 'the protocol fallback renders instead')
  } finally {
    disposeFallback()
  }

  // 3. A clean CLI tree is authoritative: vcs.status must not resurrect a row.
  const clean = fakeGitExec(() => ({ stdout: '' }))
  const cleanHost = createSidebarHost({
    directory: '/repo',
    client: vcsClient,
    children: [rootChild],
    family: ['ses_root'],
  })
  let cleanModel
  const disposeClean = createRoot((disposeRoot) => {
    cleanModel = createSidebarModel(cleanHost.context, () => 'ses_root', clean.exec)
    return disposeRoot
  })
  try {
    await sleep(40)
    assert.notEqual(cleanModel.gitCli(), null, 'the CLI did answer')
    assert.equal(cleanModel.gitLine(), null, 'a clean tree renders no counts, even with a vcs row')
  } finally {
    disposeClean()
  }

  // 4. Neither source: the block keeps its branch line only.
  const nothingHost = createSidebarHost({
    directory: '/repo',
    client: { vcs: { status: async () => ({ data: vcsPayload }) } },
    children: [rootChild],
    family: ['ses_root'],
    vcs: { branch: { current: 'main' } },
  })
  let nothingModel
  const disposeNothing = createRoot((disposeRoot) => {
    nothingModel = createSidebarModel(nothingHost.context, () => 'ses_root', broken.exec)
    return disposeRoot
  })
  try {
    await sleep(40)
    assert.equal(nothingModel.gitLine(), '+1 \u22121')
    assert.equal(nothingModel.branch(), 'main')
  } finally {
    disposeNothing()
  }
})

test('session switch drops the git counts and probes the new tree without the old cooldown', async () => {
  const { createSidebarModel } = await loadV2()

  let gate = null
  let release = () => {}
  const statusCalls = []
  const exec = async (_file, args) => {
    if (args[0] === 'status') statusCalls.push(args)
    if (gate !== null) await gate
    return args[0] === 'status' ? { stdout: ' M a.ts\n' } : { stdout: '0\t0\n' }
  }

  const host = createSidebarHost({
    directory: '/repo',
    children: [
      ['ses_a', { id: 'ses_a' }],
      ['ses_b', { id: 'ses_b' }],
    ],
    family: ['ses_a'],
  })
  const [sessionID, setSessionID] = createSignal('ses_a')
  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => sessionID(), exec)
    return disposeRoot
  })

  try {
    await sleep(30)
    assert.deepEqual(model.gitCli()?.changes, {
      added: 0,
      modified: 1,
      deleted: 0,
      untracked: 0,
    })
    assert.equal(statusCalls.length, 1, 'one probe at mount')
    assert.equal(model.gitLine(), '±1')

    // The next probe hangs on the gate, so the reset is observable before its
    // result lands.
    gate = new Promise((resolve) => {
      release = resolve
    })
    setSessionID('ses_b')
    await sleep(10)
    assert.equal(model.gitCli(), null, 'the previous session’s CLI counts are dropped')
    assert.equal(
      statusCalls.length,
      2,
      'the new session probes immediately: the old 5 s cooldown does not apply',
    )

    release()
    await sleep(20)
    assert.deepEqual(
      model.gitCli()?.changes,
      { added: 0, modified: 1, deleted: 0, untracked: 0 },
      'the new session gets its own observation',
    )
  } finally {
    dispose()
  }
})

test('session switch drops the observed states, so the new session never toasts a first-sight completion', async () => {
  const { createSidebarModel } = await loadV2()

  const host = createSidebarHost({
    children: [
      ['ses_a', { id: 'ses_a' }],
      ['ses_b', { id: 'ses_b' }],
      ['ses_child', { id: 'ses_child', parentID: 'ses_a', label: 'apo-1', agent: 'apollo' }],
    ],
    statuses: [['ses_child', 'running']],
    family: ['ses_a', 'ses_child'],
  })
  const [sessionID, setSessionID] = createSignal('ses_a')
  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => sessionID())
    return disposeRoot
  })

  try {
    await sleep(20)
    assert.equal(model.dispatch()?.runningCount, 1, 'the first session sees the child running')
    assert.equal(host.toasts.length, 0, 'a first sight of a running child never toasts')

    // The child belongs to the second session now and is already finished. A
    // stale `running` from ses_a would read as a completion and toast.
    host.setChild('ses_child', {
      id: 'ses_child',
      parentID: 'ses_b',
      label: 'apo-1',
      agent: 'apollo',
      outcome: 'succeeded',
    })
    host.setStatus('ses_child', 'idle')
    host.setFamily(['ses_b', 'ses_child'])
    setSessionID('ses_b')
    await sleep(20)

    assert.equal(model.dispatch()?.completedCount, 1, 'the child is listed as finished')
    assert.deepEqual(host.toasts, [], 'nothing completed in this session, so nothing toasts')
  } finally {
    dispose()
  }
})

test('Dispatch: native spinner per live row, header summary, frame freeze', async () => {
  const { createSidebarModel, spinnerFrame, dispatchHeaderSummary, DISPATCH_MAX_WIDTH } =
    await loadV2()

  // The spinner is the host's Braille set: ten frames, one cell each.
  const frames = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((frame) => spinnerFrame(frame))
  assert.deepEqual(frames.slice(0, 10), ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'])
  assert.equal(frames[10], '⠋', 'the spinner wraps')

  // The header omits the live count when nothing runs and always prints spend.
  assert.equal(dispatchHeaderSummary(2, 0.47), '2 rodando · $0.47')
  assert.equal(dispatchHeaderSummary(0, 0.47), '$0.47')
  assert.equal(dispatchHeaderSummary(0, 0), '$0.00')

  // Model side: the frame advances while a child runs, freezes when it ends.
  const now = Date.now()
  const host = createSidebarHost({
    children: [
      ['ses_root', { id: 'ses_root' }],
      [
        'ses_live',
        {
          id: 'ses_live',
          parentID: 'ses_root',
          agent: 'apollo',
          cost: 0.4,
          time: { created: now, updated: now },
        },
      ],
      [
        'ses_stop',
        {
          id: 'ses_stop',
          parentID: 'ses_root',
          agent: 'talos',
          cost: 0.07,
          outcome: 'interrupted',
          time: { created: now - 5_000, updated: now - 1_000 },
        },
      ],
    ],
    statuses: [['ses_live', 'running']],
    family: ['ses_root', 'ses_live', 'ses_stop'],
  })
  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    await sleep(3 * 80 + 40)
    assert.ok(model.frame() > 0, 'the spinner ticks while a dispatch runs')
    const view = model.dispatch()
    assert.equal(dispatchHeaderSummary(view.runningCount, view.totalCost), '1 rodando · $0.47')
    assert.equal(view.running.length, 1, 'only the live child gets a row')
    assert.equal(view.running[0].text.slice(0, 2), `${spinnerFrame(model.frame())} `)
    assert.equal(view.running[0].text.length <= DISPATCH_MAX_WIDTH, true)
    // The interrupted child is finished: counted in the rollup, never its own row.
    assert.equal(view.completedCount, 1)
    assert.equal(view.failures, 0, 'an interruption is not a failure')
    assert.equal(view.summary, '✓ 1 · $0.07')

    host.setStatus('ses_live', 'idle')
    host.setChild('ses_live', {
      id: 'ses_live',
      parentID: 'ses_root',
      agent: 'apollo',
      cost: 0.4,
      outcome: 'succeeded',
      time: { created: now, updated: now + 10_000 },
    })
    host.emit('session.idle')
    const frozen = model.frame()
    await sleep(3 * 80 + 40)
    assert.equal(model.frame(), frozen, 'the tick stops as soon as nothing runs')
    assert.equal(model.dispatch().runningCount, 0)
    assert.equal(model.dispatch().summary, '✓ 2 · $0.47 · 2 agentes')
  } finally {
    dispose()
  }
})

test('new glyphs are one terminal cell and never match emoji-regex', async () => {
  const {
    PRESET_MARKER,
    GIT_ARROW_UP,
    GIT_ARROW_DOWN,
    BLOCK_ICONS,
    spinnerFrame,
    DISPATCH_DONE_MARKER,
  } = await loadV2()
  const emoji = (await import('emoji-regex')).default()
  const spinner = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((frame) => spinnerFrame(frame))

  const glyphs = {
    preset: PRESET_MARKER,
    ahead: GIT_ARROW_UP,
    behind: GIT_ARROW_DOWN,
    contextHeader: BLOCK_ICONS.context,
    gitHeader: BLOCK_ICONS.git,
    todoHeader: BLOCK_ICONS.todo,
    dispatchHeader: BLOCK_ICONS.dispatch,
    done: DISPATCH_DONE_MARKER,
    ...Object.fromEntries(spinner.map((glyph, index) => [`spinner${index}`, glyph])),
  }

  for (const [name, glyph] of Object.entries(glyphs)) {
    assert.equal([...glyph].length, 1, `${name} is exactly one codepoint`)
    assert.ok(glyph.codePointAt(0) < 0x2e80, `${name} stays out of the wide CJK blocks`)
    assert.equal(/\uFE0F/.test(glyph), false, `${name} carries no variation selector`)
    emoji.lastIndex = 0
    assert.equal(emoji.test(glyph), false, `${name} is never measured as two cells`)
  }

  const source = readFileSync(join(root, 'src/plugins/tui/src/index-v2.tsx'), 'utf8')
  assert.equal(source.includes('\u26A1'), false, 'the two-cell preset bolt is gone from the source')
  assert.match(source, /'⎇ '/, 'the branch row keeps the git glyph')
  // The aggregated design dropped the tree vocabulary entirely.
  assert.equal(source.includes('\u251C\u2500'), false, 'no `├─` branch survives')
  assert.equal(source.includes('\u2514\u2500'), false, 'no `└─` branch survives')
  assert.equal(source.includes('dispatchRowPrefix'), false, 'the branch helper is gone')
})
