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

const { createRoot } = await import('solid-js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  const { presetFromEnv, resolvePresetForTui } = await loadV2()

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
      assert.deepEqual(await resolvePresetForTui({}, project), { name: null, source: null })

      // File wins when env is unset.
      writeFileSync(join(dir, 'active-preset.json'), JSON.stringify({ preset: 'pro' }))
      assert.deepEqual(await resolvePresetForTui({}, project), { name: 'pro', source: 'file' })

      // Env still wins over the file.
      assert.deepEqual(await resolvePresetForTui({ PANTHEON_MODEL_PRESET: 'max' }, project), {
        name: 'max',
        source: 'env',
      })

      // "none" in the file disables the preset.
      writeFileSync(join(dir, 'active-preset.json'), JSON.stringify({ preset: 'none' }))
      assert.deepEqual(await resolvePresetForTui({}, project), { name: null, source: null })

      // Malformed JSON degrades to default rather than throwing.
      writeFileSync(join(dir, 'active-preset.json'), '{ not json')
      assert.deepEqual(await resolvePresetForTui({}, project), { name: null, source: null })
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
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

test('delegation formatting: tone, marker/spinner, elapsed, ordering, +N', async () => {
  const {
    delegationStateTone,
    delegationRowMarker,
    spinnerFrame,
    fmtElapsed,
    delegationElapsed,
    orderDelegations,
    ceilingDelegations,
  } = await loadV2()

  assert.equal(delegationStateTone('running'), 'warning')
  assert.equal(delegationStateTone('completed'), 'success')
  assert.equal(delegationStateTone('failed'), 'error')
  assert.equal(delegationStateTone('interrupted'), 'warning', 'an aborted job is not a success')

  assert.equal(delegationRowMarker('running', 0), `${spinnerFrame(0)} `)
  assert.equal(delegationRowMarker('completed'), '\u2713 ')
  assert.equal(delegationRowMarker('failed'), '\u2715 ')
  assert.equal(delegationRowMarker('interrupted'), '\u2298 ')
  assert.equal(spinnerFrame(0), '\u280b', 'first spinner frame')

  assert.equal(fmtElapsed(12_000), '12s')
  assert.equal(fmtElapsed(180_000), '3m')
  assert.equal(fmtElapsed(3_600_000), '1h')
  assert.equal(fmtElapsed(2 * 86_400_000), '2d')

  const running = {
    id: 'r',
    label: 'r',
    state: 'running',
    startedAt: 1_000,
    updatedAt: 1_000,
  }
  assert.equal(delegationElapsed(running, 61_000), '1m')

  const done = {
    id: 'd',
    label: 'd',
    state: 'completed',
    startedAt: 1_000,
    updatedAt: 4_000,
  }
  assert.equal(delegationElapsed(done, 999_999), '3s', 'terminal rows freeze at updated-started')
  assert.equal(
    delegationElapsed({ ...done, updatedAt: null }, 999_999),
    '\u2014',
    'a missing timestamp reads as an em dash',
  )

  const ordered = orderDelegations([
    { id: 'z', label: 'z', state: 'completed', startedAt: 0, updatedAt: 10 },
    { id: 'y', label: 'y', state: 'running', startedAt: 0, updatedAt: 5 },
    { id: 'x', label: 'x', state: 'completed', startedAt: 0, updatedAt: 20 },
  ])
  assert.deepEqual(
    ordered.map((v) => v.id),
    ['y', 'x', 'z'],
    'running first, then most recently active',
  )

  const many = Array.from({ length: 10 }, (_, i) => ({
    id: `s${i}`,
    label: `s${i}`,
    state: 'completed',
    startedAt: 0,
    updatedAt: i,
  }))
  const capped = ceilingDelegations(many)
  assert.equal(capped.visible.length, 8)
  assert.equal(capped.hidden, 2, 'the remainder collapses into "… +N more"')
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

    // Only in-flight delegations render; the finished child is filtered out.
    assert.deepEqual(
      model.delegations().map((view) => [view.label, view.state]),
      [['apo-1', 'running']],
    )

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
    assert.deepEqual(model.delegations(), [], 'a finished delegation leaves the running-only list')

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

  assert.deepEqual(model.delegations(), [])
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

  assert.equal(contextUsageTone(49), 'success')
  assert.equal(contextUsageTone(50), 'warning')
  assert.equal(contextUsageTone(74), 'warning')
  assert.equal(contextUsageTone(75), 'error')

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
  const { formatTokenCount, formatContextWindow, formatSpent, contextBlockRows, contextRowText } =
    await loadV2()

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
  assert.equal(full?.percent?.tone, 'success')

  // Semantic bands live on the percentage row only.
  assert.equal(
    contextBlockRows({ tokens: 1, percent: 49, limit: 1_000_000 }, null)?.percent?.tone,
    'success',
  )
  assert.equal(
    contextBlockRows({ tokens: 1, percent: 50, limit: 1_000_000 }, null)?.percent?.tone,
    'warning',
  )
  assert.equal(
    contextBlockRows({ tokens: 1, percent: 75, limit: 1_000_000 }, null)?.percent?.tone,
    'error',
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
    contextRowText,
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
  assert.equal(rows?.percent?.tone, 'success')

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
  const { createSidebarModel, delegationSidebarLabel, contextBlockRows, contextRowText } =
    await loadV2()
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

        const child = model.delegations()[0]
        assert.equal(child.agent, 'apollo')
        assert.equal(child.model, 'gpt-5.6-luna-fast')
        assert.equal(delegationSidebarLabel(child), 'apo-1 · apollo→gpt-5.6-luna-fast')
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
    assert.deepEqual(model.delegations(), [])
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

test('sidebar block order is Context → Git status → Todo → agent → Dispatch', async () => {
  const source = readFileSync(join(root, 'src/plugins/tui/src/index-v2.tsx'), 'utf8')

  const contextAt = source.indexOf('{/* Context —')
  const gitAt = source.indexOf('{/* Git status —')
  const todoAt = source.indexOf('{/* Todo —')
  const agentAt = source.indexOf('{/* agente —')
  const dispatchAt = source.indexOf('{/* Dispatch —')

  assert.ok(
    contextAt > 0 && gitAt > 0 && todoAt > 0 && agentAt > 0 && dispatchAt > 0,
    'all five blocks exist',
  )
  assert.ok(contextAt < gitAt, 'Context renders before Git status')
  assert.ok(gitAt < todoAt, 'Todo renders after Git status')
  assert.ok(todoAt < agentAt, 'the agent block stays below the reference blocks')
  assert.ok(agentAt < dispatchAt, 'Dispatch closes the sidebar')

  // Spend is no longer a block of its own: its numbers live inside Context.
  assert.equal(source.includes("block('spend')"), false, 'the Spend block is gone')
  assert.equal(/^\s+Spend$/m.test(source), false, 'no bare `Spend` header is rendered')
  assert.equal(/SidebarBlockKey =[^\n]*'spend'/.test(source), false, 'the key was removed too')
  assert.match(
    source,
    /contextSpendLine\(model\.spend\(\)\)/,
    'the totals ride on the Context block',
  )

  assert.equal(/\n\s+git\n/.test(source), false, 'the old lowercase `git` label is gone')
  assert.ok(source.includes('label="Git status"'), 'the git block label is `Git status`')
  assert.ok(source.includes("'⎇ '"), 'the branch row keeps its ⎇ prefix')
})

/* ─── Sixth iteration: block spacing + Dispatch ───────────
 * Blocks are separated by exactly one blank line, and the old running-only
 * delegation list is replaced by `Dispatch`: every child of the active session
 * — running or finished — with its agent, model and duration. */

test('every block header carries one muted single-width glyph; the fixed header has none', async () => {
  const { BLOCK_ICONS } = await loadV2()

  assert.deepEqual(
    BLOCK_ICONS,
    {
      context: '\u25A4',
      git: '\u25C6',
      todo: '\u25BE',
      agent: '\u25C7',
      dispatch: '\u2301',
    },
    '▤ Context · ◆ Git status · ▾ Todo · ◇ agente · ⌁ Dispatch',
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
  for (const label of ['Context', 'Git status', 'Todo', 'agente', 'Dispatch']) {
    assert.ok(
      source.includes(`label="${label}"`),
      `the ${label} block renders its own labeled header`,
    )
  }
  const headers = source.match(/<BlockHeader/g) ?? []
  assert.equal(headers.length, 5, 'exactly five block headers carry a glyph')

  // The fixed header (version / OpenCode V2 / preset / session) takes no icon.
  const fixedHeader = source.slice(
    source.indexOf('<text fg={text()} attributes={1}>'),
    source.indexOf("block('context')"),
  )
  assert.ok(fixedHeader.length > 0, 'the fixed header block was located')
  assert.equal(fixedHeader.includes('BlockHeader'), false, 'the fixed header has no glyph')
})

test('Dispatch rows carry the child cost, and the spend totals ride inside Context', async () => {
  const { createSidebarModel, dispatchRowText, contextSpendLine, resetSpendUnit } = await loadV2()
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
          time: { created: now - 64_000, updated: now - 100 },
        },
      ],
      [
        'ses_c',
        {
          id: 'ses_c',
          parentID: 'ses_root',
          agent: 'talos',
          time: { created: now - 1_000, updated: now - 100 },
        },
      ],
    ],
    family: ['ses_root', 'ses_a', 'ses_b', 'ses_c'],
  })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    await sleep(40)
    const rows = model.dispatch().visible.map((view) => dispatchRowText(view, now))
    const cells = (agent, model, cost, duration) =>
      `\u25CF ${agent.padEnd(12)} ${model.padEnd(7)} ${cost.padStart(5)} ${duration.padStart(5)}`

    assert.equal(rows.length, 3)
    assert.equal(rows[0], cells('apollo', 'gpt-5.6', '$0.04', '12.7s'), 'cost + model + duration')
    assert.equal(
      rows[1],
      cells('demeter', '', '$0.41', '1m04s'),
      'a missing model keeps its column',
    )
    assert.equal(rows[2], cells('talos', '', '\u2014', '1.0s'), 'an absent cost is an em dash')
    for (const row of rows) {
      assert.ok(row.length <= 34, `a Dispatch row stays within 34 columns (got ${row.length})`)
    }

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
      'Context opens the sidebar without a leading gap and no Spend block follows',
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
    (source.match(/<box height=\{1\} \/>/g) ?? []).length,
    6,
    'five block spacers plus the one after the fixed header — no duplicates',
  )
})

test('Dispatch formatting: markers, tones, three durations, truncation, row width', async () => {
  const {
    dispatchMarker,
    dispatchTone,
    formatDispatchDuration,
    dispatchElapsed,
    dispatchAgentText,
    dispatchModelText,
    formatDispatchCost,
    dispatchRowText,
    hiddenDispatchText,
    DISPATCH_AGENT_WIDTH,
    DISPATCH_MODEL_WIDTH,
    DISPATCH_COST_WIDTH,
    DISPATCH_DURATION_WIDTH,
    DISPATCH_MAX_WIDTH,
  } = await loadV2()

  assert.equal(dispatchMarker('running'), '\u25CF', '● for a live child')
  assert.equal(dispatchMarker('completed'), '\u2713', '✓ for a succeeded child')
  assert.equal(dispatchMarker('failed'), '\u2717', '✗ for a failed child')
  assert.equal(dispatchMarker('interrupted'), '\u2212', '− for an interrupted child')

  assert.equal(dispatchTone('running'), 'success', 'live work is the only green row')
  assert.equal(dispatchTone('failed'), 'error')
  assert.equal(dispatchTone('completed'), 'muted', 'a finished child recedes')
  assert.equal(dispatchTone('interrupted'), 'muted', 'an aborted child is not a success')

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

  // Layout: marker + padded agent + padded model + right-aligned cost + duration.
  const cost = (value) => value.padStart(DISPATCH_COST_WIDTH)
  const duration = (value) => value.padStart(DISPATCH_DURATION_WIDTH)
  assert.equal(cost('$0.04').length, 5)
  assert.equal(
    dispatchRowText({ ...running, cost: 0.04 }, 13_400),
    `\u25CF ${'apollo'.padEnd(DISPATCH_AGENT_WIDTH)} ${'gpt-5.6'.padEnd(DISPATCH_MODEL_WIDTH)} ${cost('$0.04')} ${duration('12.4s')}`,
    'the full row is agent + model + cost + duration, columns aligned',
  )
  assert.equal(
    dispatchRowText({ ...running, cost: 0.04 }, 13_400).length,
    DISPATCH_MAX_WIDTH,
    'a full row is exactly the 34-column budget',
  )
  assert.equal(
    dispatchRowText({ ...running, model: null, cost: 0.41 }, 13_400),
    `\u25CF ${'apollo'.padEnd(DISPATCH_AGENT_WIDTH)} ${' '.repeat(DISPATCH_MODEL_WIDTH)} ${cost('$0.41')} ${duration('12.4s')}`,
    'a missing model keeps its column so the numbers stay aligned',
  )
  assert.equal(
    dispatchRowText({ ...running, cost: undefined }, 13_400),
    `\u25CF ${'apollo'.padEnd(DISPATCH_AGENT_WIDTH)} ${'gpt-5.6'.padEnd(DISPATCH_MODEL_WIDTH)} ${cost('\u2014')} ${duration('12.4s')}`,
    'an absent cost renders an em dash in its column',
  )
  const noModel = dispatchRowText({ ...running, cost: 0.04 }, 13_400, 30)
  assert.equal(
    noModel,
    `\u25CF ${'apollo'.padEnd(DISPATCH_AGENT_WIDTH)} ${cost('$0.04')} ${duration('12.4s')}`,
    'the model is dropped first when the row would not fit',
  )
  const noCost = dispatchRowText({ ...running, cost: 0.04 }, 13_400, 20)
  assert.equal(
    noCost,
    `\u25CF ${'apollo'.padEnd(DISPATCH_AGENT_WIDTH)} ${duration('12.4s')}`,
    'the cost is dropped only after the model',
  )
  assert.ok(
    dispatchRowText({ ...running, cost: 0.04 }, 13_400, 20).includes('apollo'),
    'the agent is never cut away to fit the row',
  )
  const worst = dispatchRowText(
    {
      ...running,
      agent: 'a'.repeat(20),
      model: 'm'.repeat(20),
      cost: 0.0031,
      state: 'completed',
      updatedAt: 63_601_000,
    },
    0,
  )
  assert.ok(
    worst.length <= DISPATCH_MAX_WIDTH,
    `the widest row stays within ${DISPATCH_MAX_WIDTH} columns (got ${worst.length})`,
  )

  assert.equal(hiddenDispatchText(0), null)
  assert.equal(hiddenDispatchText(2), '\u2026 +2')
  assert.equal(hiddenDispatchText(Number.NaN), null)
})

test('sidebar Dispatch lists running first, then finished children, root excluded', async () => {
  const { createSidebarModel, dispatchAgentText } = await loadV2()
  const now = Date.now()
  const host = createSidebarHost({
    children: [
      ['ses_root', { id: 'ses_root', agent: 'zeus', time: { created: now, updated: now } }],
      [
        'ses_a',
        {
          id: 'ses_a',
          parentID: 'ses_root',
          agent: 'apollo',
          model: { id: 'gpt-5.6', providerID: 'opencode-go' },
          time: { created: now - 2_000, updated: now - 1_000 },
        },
      ],
      [
        'ses_b',
        {
          id: 'ses_b',
          parentID: 'ses_root',
          agent: 'demeter',
          outcome: 'succeeded',
          time: { created: now - 9_000, updated: now - 5_000 },
        },
      ],
      [
        'ses_c',
        {
          id: 'ses_c',
          parentID: 'ses_root',
          title: 'hotfix',
          outcome: 'failed',
          time: { created: now - 9_000, updated: now - 7_000 },
        },
      ],
      // A grandchild is not a dispatch of this session.
      [
        'ses_grand',
        {
          id: 'ses_grand',
          parentID: 'ses_a',
          agent: 'iris',
          outcome: 'succeeded',
          time: { created: now, updated: now },
        },
      ],
    ],
    statuses: [['ses_a', 'running']],
    family: ['ses_root', 'ses_a', 'ses_b', 'ses_c', 'ses_grand'],
  })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })

  try {
    assert.deepEqual(
      model.dispatch().visible.map((view) => [view.id, view.state]),
      [
        ['ses_a', 'running'],
        ['ses_b', 'completed'],
        ['ses_c', 'failed'],
      ],
      'running first, then by most recent activity; root and grandchild excluded',
    )
    assert.equal(model.dispatch().hidden, 0)
    assert.equal(
      dispatchAgentText(model.dispatch().visible[2]),
      'hotfix',
      'title stands in for agent',
    )
    assert.deepEqual(
      model.delegations().map((view) => view.id),
      ['ses_a'],
      'the running-only list',
    )
    assert.ok(model.liveNow() > 0, 'the live clock is readable for the row durations')
  } finally {
    dispose()
  }
})

test('sidebar Dispatch caps at 5 rows and reports the remainder as "… +N"', async () => {
  const { createSidebarModel, hiddenDispatchText, DISPATCH_VISIBLE_CEILING } = await loadV2()
  const now = Date.now()
  const children = [['ses_root', { id: 'ses_root', time: { created: now, updated: now } }]]
  for (let index = 0; index < 7; index += 1) {
    children.push([
      `ses_${index}`,
      {
        id: `ses_${index}`,
        parentID: 'ses_root',
        agent: `agent-${index}`,
        outcome: 'succeeded',
        time: { created: now - 10_000, updated: now - index * 1_000 },
      },
    ])
  }
  const host = createSidebarHost({
    children,
    family: ['ses_root', ...children.slice(1).map(([id]) => id)],
  })

  let model
  const dispose = createRoot((disposeRoot) => {
    model = createSidebarModel(host.context, () => 'ses_root')
    return disposeRoot
  })

  try {
    assert.equal(DISPATCH_VISIBLE_CEILING, 5)
    assert.equal(model.dispatch().visible.length, 5)
    assert.equal(model.dispatch().hidden, 2)
    assert.equal(hiddenDispatchText(model.dispatch().hidden), '\u2026 +2')
    assert.deepEqual(
      model.dispatch().visible.map((view) => view.id),
      ['ses_0', 'ses_1', 'ses_2', 'ses_3', 'ses_4'],
      'the cap keeps the most recently active rows',
    )
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
        ['agent', true],
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
      [
        ['context', false],
        ['agent', true],
      ],
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
  })
  let withDispatch
  const disposeChild = createRoot((disposeRoot) => {
    withDispatch = createSidebarModel(withChild.context, () => 'ses_root')
    return disposeRoot
  })
  try {
    assert.deepEqual(
      withDispatch.blocks().map((entry) => entry.key),
      ['context', 'git', 'agent', 'dispatch'],
      'Dispatch closes the sidebar, after the agent row',
    )
    assert.equal(withDispatch.blocks().at(-1).spacer, true)
  } finally {
    disposeChild()
  }
})

test('Dispatch block keeps click-through and adds no replace claim', async () => {
  const source = readFileSync(join(root, 'src/plugins/tui/src/index-v2.tsx'), 'utf8')

  assert.match(
    source,
    /onMouseDown=\{open\(view\.id\)\}/,
    'a Dispatch row still navigates to the child session',
  )
  assert.ok(source.includes('Dispatch'), 'the block header is `Dispatch`')
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
