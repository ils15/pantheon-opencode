/**
 * Focused tests for the `pantheon.dispatch` panel of the OpenCode V2 TUI
 * plugin (dist/tui-v2.js).
 *
 * The panel is the full-width counterpart of the sidebar's Dispatch block and
 * both render `collectDispatch` — one collector, so a child can never be listed
 * twice under two different semantics. These tests drive the packaged bundle
 * with a fake `context` (same pattern as tests/tui-v2-sidebar.test.mjs): the
 * open command and its toast, the pure row/header/detail/layout builders, the
 * reactive model (selection by id, fallback to the first row, pagination, the
 * running-only tick) and the command table.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = () => readFileSync(join(root, 'src/plugins/tui/src/index-v2.tsx'), 'utf8')

/* Same shim as the sidebar suite: under `node --test` the bare `solid-js`
 * specifier resolves to the SSR build, where effects are no-ops. */
function resolveSolidClientUrl() {
  const candidates = [
    new URL('../node_modules/solid-js/dist/solid.js', import.meta.url),
    new URL('../src/plugins/tui/node_modules/solid-js/dist/solid.js', import.meta.url),
  ]
  for (const candidate of candidates) if (existsSync(candidate)) return candidate.href
  throw new Error('solid-js client build not found — cannot exercise panel effects')
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'solid-js') return { url: resolveSolidClientUrl(), shortCircuit: true }
    return nextResolve(specifier, context)
  },
})

const { createRoot, createSignal } = await import('solid-js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function loadV2() {
  return import(pathToFileURL(join(root, 'src/plugins/tui/dist/tui-v2.js')).href)
}

/* Isolate the preset file leg: never read the developer's real ~/.config. */
const isolatedXdg = mkdtempSync(join(tmpdir(), 'pantheon-dispatch-xdg-'))
process.env.XDG_CONFIG_HOME = isolatedXdg
process.on('exit', () => rmSync(isolatedXdg, { recursive: true, force: true }))

/** A `context` with only the surface the collector, the sidebar model and the
 *  panel model touch, plus the probes each test asserts on. */
function createPanelHost(options = {}) {
  const children = new Map(options.children ?? [])
  const statuses = new Map(options.statuses ?? [])
  const family = [...(options.family ?? children.keys())]
  const messages = new Map(options.messages ?? [])
  const agents = options.agents ?? []
  const models = options.models ?? []
  const listCalls = []
  const syncCalls = []
  const toasts = []
  const handlers = new Map()
  const layers = []
  const shortcuts = options.shortcuts ?? {}
  const panelCalls = []
  let openResult = options.openResult ?? true

  const context = {
    location: { directory: '/tmp' },
    theme: {
      text: {
        base: 'white',
        muted: 'gray',
        feedback: {
          success: { base: 'green' },
          error: { base: 'red' },
          warning: { base: 'amber' },
        },
      },
    },
    keymap: {
      layer: (factory) => layers.push(factory),
      shortcuts: (id) => shortcuts[id] ?? [],
    },
    ui: {
      toast: { show: (options_) => toasts.push(options_) },
      panel: {
        open: (name, opts) => {
          panelCalls.push({ name, opts })
          return openResult
        },
        close: () => {},
        current: () => undefined,
      },
      router: { navigate: () => {} },
    },
    data: {
      location: {
        vcs: { sync: async () => {}, info: () => ({ branch: { current: 'main' } }) },
        model: { list: () => models },
        agent: { list: () => agents },
      },
      session: {
        get: (id) => children.get(id),
        family: () => family.slice(),
        status: (id) => statuses.get(id),
        cost: () => 0,
        sync: async () => {},
        message: {
          list: (id) => {
            listCalls.push(id)
            return messages.get(id) ?? []
          },
          sync: async (id) => {
            syncCalls.push(id)
          },
        },
      },
      on: (type, handler) => {
        handlers.set(type, handler)
        return () => handlers.delete(type)
      },
    },
  }

  return {
    context,
    children,
    statuses,
    messages,
    listCalls,
    syncCalls,
    toasts,
    layers,
    panelCalls,
    emit: (type) => handlers.get(type)?.(),
    setFamily: (ids) => {
      family.length = 0
      family.push(...ids)
    },
    setOpenResult: (value) => {
      openResult = value
    },
  }
}

/** One `DispatchEntry` built by hand, so formatting tests need no host. */
function entry(id, state, options = {}) {
  const agent = options.agent ?? 'apollo'
  return {
    view: {
      id,
      label: options.label ?? agent,
      state,
      startedAt: options.startedAt ?? 0,
      updatedAt: options.updatedAt ?? 0,
      agent,
      model: options.model ?? null,
      cost: options.cost ?? null,
      kind: options.kind ?? null,
      kindOrigin: options.kindOrigin ?? 'prefix',
      background: options.background ?? false,
    },
    title: options.title ?? null,
    description: options.description ?? null,
    parentID: options.parentID ?? null,
    tokens: options.tokens ?? null,
  }
}

/** Run `fn` inside a Solid root with a reactive panel input (name/width are
 *  signals, exactly as the host's `PanelInput` props are reactive). */
async function withPanelModel(context, panelOptions, fn) {
  const [name, setName] = createSignal(panelOptions.name ?? 'pantheon.dispatch')
  const [width, setWidth] = createSignal(panelOptions.width ?? 100)
  const [sessionID, setSessionID] = createSignal(panelOptions.sessionID ?? 'ses_root')
  const capture = {}
  const { createDispatchPanelModel } = await loadV2()
  const dispose = createRoot((disposeRoot) => {
    capture.model = createDispatchPanelModel(context, () => ({
      get name() {
        return name()
      },
      get width() {
        return width()
      },
      get sessionID() {
        return sessionID()
      },
    }))
    return disposeRoot
  })
  try {
    return await fn(capture.model, { setName, setWidth, setSessionID })
  } finally {
    dispose()
  }
}

/* ─── Open command ──────────────────────────────────────── */

test('open: true is silent, false shows the session warning and does nothing else', async () => {
  const { openDispatchPanel, DISPATCH_PANEL_NAME, DISPATCH_PANEL_TOAST } = await loadV2()
  const host = createPanelHost()

  assert.equal(openDispatchPanel(host.context), true)
  assert.deepEqual(host.panelCalls, [{ name: DISPATCH_PANEL_NAME, opts: undefined }])
  assert.deepEqual(host.toasts, [], 'a successful open never toasts')

  host.setOpenResult(false)
  assert.equal(openDispatchPanel(host.context), false)
  assert.deepEqual(host.toasts, [{ message: DISPATCH_PANEL_TOAST, variant: 'warning' }])
  assert.equal(host.panelCalls.length, 2, 'the failed open is attempted once, never retried')
  assert.equal(DISPATCH_PANEL_TOAST, 'Abra uma sessão para ver o Dispatch')

  // A host without the panel API (or one that throws) degrades to the same toast.
  assert.equal(openDispatchPanel({ ui: { toast: { show: () => {} } } }), false)
  assert.equal(openDispatchPanel(undefined), false, 'a missing context never throws')
})

test('registration: session.panel is an append claim; /dispatch is palette-visible', async () => {
  const text = source()

  assert.match(text, /append: 'session\.panel'/, 'the panel claim appends to session.panel')
  assert.match(text, /append: 'app'/, 'the command layer appends at app')
  assert.equal(/\.slot\(\{[^}]*replace:/.test(text), false, 'no slot claim replaces host content')
  assert.match(text, /panel\.name === DISPATCH_PANEL_NAME/, 'the claim renders only for our panel')
  assert.match(text, /palette: true/)
  assert.match(text, /slash: \{ name: 'dispatch', aliases: \['pantheon-dispatch'\] \}/)
  assert.match(text, /ui\?\.panel\?\.open\?\.\(DISPATCH_PANEL_NAME\)/)
  assert.equal(
    text.includes('router.navigate') && /openDispatchPanel[\s\S]{0,400}router\.navigate/.test(text),
    false,
    'a refused open never navigates: there is no alternative route',
  )
})

/* ─── Header / rows / detail ────────────────────────────── */

test('header: zero counters are omitted and a failure is counted', async () => {
  const { dispatchPanelHeader } = await loadV2()

  assert.equal(dispatchPanelHeader([]), null, 'an empty tree renders no counter line')

  const mixed = dispatchPanelHeader([
    entry('ses_a', 'running', { cost: 0.09 }),
    entry('ses_b', 'running', { cost: 0.5 }),
    entry('ses_c', 'completed', { cost: 2 }),
    entry('ses_d', 'failed', { cost: 1 }),
  ])
  assert.equal(mixed, '2 rodando · 1 concluído · 1 falha · $3.59')

  const onlyDone = dispatchPanelHeader([entry('ses_a', 'completed', { cost: 0.02 })])
  assert.equal(onlyDone, '1 concluído · $0.02', 'no `0 rodando` and no `0 falhas`')

  const onlyFailed = dispatchPanelHeader([
    entry('ses_a', 'failed', { cost: 0.01 }),
    entry('ses_b', 'failed', { cost: 0.01 }),
  ])
  assert.equal(onlyFailed, '2 falhas · $0.02', 'plural on the failure counter')
  assert.equal(onlyFailed.includes('rodando'), false)

  const interrupted = dispatchPanelHeader([entry('ses_a', 'interrupted', { cost: 0.01 })])
  assert.equal(interrupted, '$0.01', 'only the real counters and the spend; zero terms are absent')

  const free = dispatchPanelHeader([entry('ses_a', 'completed', { cost: 0 })])
  assert.equal(free, '1 concluído · $0.00', 'a real zero cost is still an answer')
})

test('rows: running first, then most recent; one marker per state', async () => {
  const { dispatchPanelRows, dispatchPanelRowText } = await loadV2()

  const rows = dispatchPanelRows([
    entry('ses_old', 'completed', { agent: 'demeter', updatedAt: 1_000, cost: 0.02 }),
    entry('ses_new', 'completed', { agent: 'apollo', updatedAt: 9_000, cost: 0.04 }),
    entry('ses_live', 'running', { agent: 'prometheus', updatedAt: 5_000, cost: 0.09 }),
    entry('ses_fail', 'failed', { agent: 'demeter', updatedAt: 3_000, cost: 0.02 }),
  ])
  assert.deepEqual(
    rows.map((row) => row.id),
    ['ses_live', 'ses_new', 'ses_fail', 'ses_old'],
  )

  const live = entry('ses_live', 'running', {
    agent: 'prometheus',
    kind: 'plan',
    cost: 0.09,
    startedAt: 0,
  })
  assert.equal(
    dispatchPanelRowText(live, { now: 874_000, frame: 0, max: 35 }),
    `\u280B prometheus   plan   $0.09  14m34s`,
    'running row: spinner, agent, kind (4), cost, duration',
  )

  const done = entry('ses_done', 'completed', {
    agent: 'apollo',
    kind: 'disc',
    cost: 0.04,
    startedAt: 0,
    updatedAt: 12_800,
  })
  assert.equal(dispatchPanelRowText(done, { now: 999_999 }), '✓ apollo       disc   $0.04   12.8s')
  assert.match(dispatchPanelRowText(entry('ses_f', 'failed', { cost: 0.02 })), /^✗ /u)
  assert.match(dispatchPanelRowText(entry('ses_i', 'interrupted', { cost: 0.02 })), /^○ /u)
  assert.match(dispatchPanelRowText(entry('ses_u', 'weird', { cost: 0.02 })), /^\? /u)

  const missing = dispatchPanelRowText(entry('ses_m', 'completed'), { now: 0 })
  assert.equal(missing.includes('—'), true, 'missing kind/cost/duration print the em dash')
  assert.equal(missing.length, 35, 'an absent datum never shrinks the columns')
})

test('rows: a sub-cent cost widens its own column instead of overflowing the budget', async () => {
  const { dispatchPanelRowText, cellWidth } = await loadV2()

  const row = (cost) =>
    dispatchPanelRowText(
      entry('ses_cost', 'completed', {
        agent: 'apollo',
        kind: 'disc',
        cost,
        startedAt: 0,
        updatedAt: 12_800,
      }),
      { now: 999_999, max: 35 },
    )

  // `<$0.0001` is eight cells, one more than the fixed cost column: the row
  // must borrow that cell from the agent label, never from the budget.
  assert.equal(row(0.00004).includes('<$0.0001'), true)
  assert.equal(cellWidth(row(0.00004)), 35, 'the widest cost still fits 35 cells')
  assert.equal(row(0.0031).includes('$0.0031'), true)
  assert.equal(cellWidth(row(0.0031)), 35)
  assert.equal(row(1.2).includes('$1.20'), true)
  assert.equal(cellWidth(row(1.2)), 35)
  assert.equal(row(null).includes('\u2014'), true, 'a missing cost prints the em dash')
  assert.equal(cellWidth(row(null)), 35)

  for (const cost of [0.00004, 0.0031, 1.2, null]) {
    assert.equal(cellWidth(row(cost)), 35, `cost ${cost} keeps every row inside its budget`)
  }

  // The duration column is still the last thing on the line, unmoved.
  assert.equal(/\d+s$|\d+\.\ds$/u.test(row(0.00004)), true, 'the duration closes the row')
})

test('detail: every absent datum is an em dash; kind origin is spelled out', async () => {
  const { dispatchPanelDetail } = await loadV2()

  const bare = dispatchPanelDetail(
    entry('ses_bare', 'completed', { agent: 'apollo', kindOrigin: 'unavailable' }),
  )
  assert.equal(bare.length, 4, 'heading, id/model, tokens, kind/parent')
  assert.equal(bare[1].includes('—'), true, 'no model → em dash')
  assert.equal(bare[2], 'tokens —')
  assert.equal(bare[3].includes('indisponível'), true, 'unavailable origin is labelled, not blank')
  assert.equal(bare[3].includes('parent —'), true, 'no parentID → em dash')
  assert.equal(bare[0], 'apollo')

  const full = dispatchPanelDetail(
    entry('ses_full', 'running', {
      agent: 'prometheus',
      title: 'plan the migration',
      model: 'kimi-k3',
      kind: 'plan',
      kindOrigin: 'prefix',
      parentID: 'ses_root',
      tokens: { input: 12_000, output: 430, reasoning: 120, cacheRead: 8_000, cacheWrite: 1_000 },
    }),
  )
  assert.equal(full[0], 'plan the migration', 'the title wins over the row label')
  assert.equal(full[1], 'ses_full · kimi-k3')
  assert.equal(full[2], 'in 12K · out 430 · r 120 · cache 8K/1K')
  assert.equal(full[3], 'kind plan (prefixo) · parent ses_root')

  // The spawning description stands in when the child has no title.
  const described = dispatchPanelDetail(
    entry('ses_desc', 'completed', { description: '[review] audit the PR' }),
  )
  assert.equal(described[0], '[review] audit the PR')

  const collapsed = dispatchPanelDetail(entry('ses_c', 'completed', { title: 'only me' }), {
    expanded: false,
  })
  assert.deepEqual(collapsed, ['only me'], 'collapsed keeps the heading only')

  assert.deepEqual(dispatchPanelDetail(null), ['—'], 'no selected child → em dash')
})

test('layout: wide puts the detail beside the list; narrow stacks and truncates per cell', async () => {
  const { dispatchPanelLayout, dispatchPanelRowText } = await loadV2()

  const wide = dispatchPanelLayout(100)
  assert.equal(wide.mode, 'wide')
  assert.ok(wide.listWidth > 0 && wide.detailWidth > 0)
  assert.ok(wide.listWidth + wide.detailWidth <= 100, 'the two columns fit the panel')
  assert.equal(wide.rowWidth, wide.listWidth - 2)

  const narrow = dispatchPanelLayout(50)
  assert.equal(narrow.mode, 'narrow')
  assert.equal(narrow.rowWidth, 48, 'the stacked layout keeps the full width for the list')
  assert.equal(dispatchPanelLayout(71).mode, 'narrow', '71 columns still stacks')
  assert.equal(dispatchPanelLayout(72).mode, 'wide', '72 is the documented breakpoint')

  // A long agent name is cut inside its own cell; the numbers keep their columns.
  const long = dispatchPanelRowText(
    entry('ses_long', 'completed', {
      agent: 'an-extremely-long-agent-name',
      kind: 'revw',
      cost: 0.04,
      startedAt: 0,
      updatedAt: 12_000,
    }),
    { now: 12_000, max: 35 },
  )
  assert.equal(long.length, 35, 'the row honours its column budget')
  assert.match(long, /an-extremel…/u)
  assert.match(long, /revw +\$0\.04 +12\.0s$/u, 'cost and duration are intact')

  const text = source()
  assert.match(text, /model\.layout\(\)\.mode === 'wide'/, 'the view branches on the layout mode')
})

test('cellWidth agrees with the host’s own width measurement', async () => {
  const { cellWidth } = await loadV2()
  // The host sizes a text run with `string-width` (via `@opentui/core`); the
  // plugin keeps a local measurement so the deployed bundle needs no extra
  // module. This pins the two together for the text the panel renders.
  const { default: hostWidth } = await import('string-width')
  const corpus = [
    'plan the migration',
    'refactor the dispatcher',
    'ses_ab12cd',
    'provider/kimi-k3',
    'apollo',
    'council',
    '±1 ↑3 ↓1 ?2',
    '▸ ✓ ✗ ○ ? … — ·',
    '日本語のタイトル',
    '한국어 제목',
    'Ａ fullwidth',
    'combining e\u0301',
    '🚀 deploy',
    '👨‍👩‍👧‍👦 family',
    '🇧🇷 bandeira',
    '1️⃣ keycap',
    '❤️ coração',
    '×003 $0.04 12.8s',
    '',
  ]
  for (const text of corpus) {
    assert.equal(
      cellWidth(text),
      hostWidth(text),
      `${JSON.stringify(text)} is measured like the host`,
    )
  }
})

test('cells, title and detail are cut by display cells, not by UTF-16 units', async () => {
  const { dispatchPanelCell, dispatchPanelTitle, dispatchPanelDetail, cellWidth, truncateLabel } =
    await loadV2()

  // A CJK label is half as many code units as it is cells.
  assert.equal(cellWidth('計画の移行テスト'), 16, 'CJK: 8 code units, 16 cells')
  assert.equal(cellWidth('🚀'), 2, 'an emoji is one code point and two cells')

  // Cell: the column width is a cell budget, so the padded cell is exactly it
  // (the old code-unit arithmetic padded 8 units to 20 and rendered 28 cells).
  const cjkCell = dispatchPanelCell('計画の移行テスト'.repeat(2), 20)
  assert.equal(cellWidth(cjkCell), 20, 'a CJK cell occupies exactly its column')
  assert.equal(cjkCell.includes('\u2026'), true, 'the cut is marked')

  const emojiCell = dispatchPanelCell('🚀 deploy 🚀 deploy', 10)
  assert.equal(cellWidth(emojiCell), 10)
  assert.equal(
    [...emojiCell].some((glyph) => {
      const point = glyph.codePointAt(0) ?? 0
      return point >= 0xd800 && point <= 0xdfff
    }),
    false,
    'the cut never leaves half a surrogate pair',
  )

  // Padding is measured in cells, so an emoji cell is followed by the same
  // column boundary as an ASCII one.
  assert.equal(
    cellWidth(dispatchPanelCell('🚀', 4)),
    cellWidth(dispatchPanelCell('ab', 4)),
    'padding is measured in cells, so columns stay aligned',
  )

  // Title: 44 cells of budget, whatever the title is made of.
  const titleBudget = (value) => cellWidth(value) - cellWidth('\u25C8 Dispatch \u2014 ')
  const wide = '🚀 deploy '.repeat(6)
  const title = dispatchPanelTitle(wide, 44)
  assert.equal(titleBudget(title) <= 44, true, 'an emoji title never passes 44 cells')
  assert.equal(titleBudget(title) >= 40, true, 'and it spends the column instead of wasting it')
  assert.equal(title.includes('🚀'), true, 'the whole emoji survives the cut')
  const cjkTitle = dispatchPanelTitle('計'.repeat(40), 44)
  assert.equal(titleBudget(cjkTitle) <= 44, true, 'a CJK title never passes 44 cells')
  assert.equal(titleBudget(cjkTitle) >= 40, true)

  // Detail: every line of a CJK/emoji heading is cut to the detail column.
  const detail = dispatchPanelDetail(
    entry('ses_i18n', 'completed', {
      agent: 'apollo',
      title: '計画の移行テスト 🚀 計画の移行テスト 🚀 計画の移行テスト',
      model: '計',
      parentID: 'ses_root',
      tokens: { input: 12_000, output: 430, reasoning: 120, cacheRead: 8_000, cacheWrite: 1_000 },
    }),
    { max: 20 },
  )
  for (const line of detail) {
    assert.equal(
      cellWidth(line) <= 20,
      true,
      `detail line ${JSON.stringify(line)} fits its 20 cells`,
    )
  }
  assert.equal(cellWidth(detail[0]), 20, 'the heading uses the whole column')

  // truncateLabel itself: an emoji never ends the string on half a pair.
  const cut = truncateLabel('🚀'.repeat(6), 5)
  assert.equal(cellWidth(cut), 5)
  assert.equal(cut.endsWith('\u2026'), true)
  assert.equal(truncateLabel('日本', 4), '日本', 'a label that fits is returned untouched')
})

/* ─── Model: selection, viewport, tick ──────────────────── */

function dispatchHost() {
  const now = Date.now()
  return createPanelHost({
    children: [
      ['ses_root', { id: 'ses_root', title: 'root session', time: { created: now, updated: now } }],
      [
        'ses_live',
        {
          id: 'ses_live',
          parentID: 'ses_root',
          title: 'plan the migration',
          agent: 'prometheus',
          model: { id: 'provider/kimi-k3' },
          cost: 0.09,
          tokens: { input: 1_200, output: 40, reasoning: 10, cache: { read: 800, write: 10 } },
          time: { created: now - 60_000, updated: now - 1_000 },
        },
      ],
      [
        'ses_done',
        {
          id: 'ses_done',
          parentID: 'ses_root',
          title: 'audit the PR',
          agent: 'apollo',
          cost: 0.04,
          outcome: 'succeeded',
          time: { created: now - 120_000, updated: now - 90_000 },
        },
      ],
      [
        'ses_fail',
        {
          id: 'ses_fail',
          parentID: 'ses_root',
          title: 'schema review',
          agent: 'demeter',
          cost: 0.02,
          outcome: 'failed',
          time: { created: now - 200_000, updated: now - 150_000 },
        },
      ],
    ],
    statuses: [['ses_live', 'running']],
    family: ['ses_root', 'ses_live', 'ses_done', 'ses_fail'],
    messages: [
      [
        'ses_root',
        [
          {
            type: 'assistant',
            content: [
              {
                type: 'tool',
                name: 'subagent',
                state: {
                  status: 'completed',
                  input: { agent: 'prometheus', description: '[plan] migration' },
                  metadata: { sessionID: 'ses_live' },
                },
              },
            ],
          },
        ],
      ],
    ],
  })
}

test('selection: moves by row, survives updates by id, falls back to the first row', async () => {
  const host = dispatchHost()
  await withPanelModel(host.context, { width: 100 }, async (model) => {
    assert.deepEqual(
      model.rows().map((row) => row.id),
      ['ses_live', 'ses_done', 'ses_fail'],
      'the panel lists one row per child, running first',
    )
    assert.equal(model.selectedID(), 'ses_live', 'the first row starts selected')

    model.move(1)
    assert.equal(model.selectedID(), 'ses_done')
    model.move(-1)
    assert.equal(model.selectedID(), 'ses_live')

    model.last()
    assert.equal(model.selectedID(), 'ses_fail')
    model.first()
    assert.equal(model.selectedID(), 'ses_live')

    // An update that reshuffles the list must not steal the selection.
    host.statuses.set('ses_live', 'idle')
    host.children.get('ses_live').time.updated = Date.now()
    host.children.get('ses_done').time.updated = Date.now()
    host.emit('session.idle')
    await sleep(0)
    assert.equal(model.rows()[0].id, 'ses_live', 'the freshly updated child leads')
    assert.equal(model.selectedID(), 'ses_live', 'selection is held by id, not by index')

    // The selected child disappearing falls back to the first remaining row.
    host.children.delete('ses_live')
    host.setFamily(['ses_root', 'ses_done', 'ses_fail'])
    host.emit('session.deleted')
    await sleep(0)
    assert.equal(model.selectedID(), 'ses_done', 'a vanished selection selects the first row')
    assert.equal(model.selectedIndex(), 0)
  })
})

test('viewport: 71 children paginate ten at a time with pageup/pagedown', async () => {
  const { dispatchPanelWindow, dispatchPanelRangeText, DISPATCH_PANEL_PAGE_SIZE } = await loadV2()
  const now = Date.now()
  const children = [
    ['ses_root', { id: 'ses_root', title: 'root', time: { created: now, updated: now } }],
  ]
  const family = ['ses_root']
  for (let index = 0; index < 71; index += 1) {
    const id = `ses_child_${String(index).padStart(2, '0')}`
    children.push([
      id,
      {
        id,
        parentID: 'ses_root',
        agent: 'apollo',
        outcome: 'succeeded',
        cost: 0.01,
        time: { created: now - 1_000, updated: now - index },
      },
    ])
    family.push(id)
  }
  const host = createPanelHost({ children, family })

  await withPanelModel(host.context, { width: 100 }, async (model) => {
    assert.equal(model.rows().length, 71)
    assert.equal(model.visible().rows.length, DISPATCH_PANEL_PAGE_SIZE, 'the list is bounded')
    assert.equal(model.visible().start, 0)
    assert.equal(model.selectedIndex(), 0)

    model.pageDown()
    assert.equal(model.selectedIndex(), 10)
    assert.equal(model.visible().start, 1, 'the window scrolls so the selection stays visible')
    assert.equal(model.visible().rows.length, 10)
    assert.equal(model.visible().rows.at(-1).id, model.selectedID())

    model.pageDown()
    assert.equal(model.selectedIndex(), 20)
    model.pageUp()
    assert.equal(model.selectedIndex(), 10)

    model.last()
    assert.equal(model.selectedIndex(), 70)
    const tail = model.visible()
    assert.equal(tail.start, 61, 'the last page holds the tail of the list')
    assert.equal(tail.rows.at(-1).id, model.selectedID())

    model.first()
    assert.equal(model.selectedIndex(), 0)
    assert.equal(model.rows()[0].id, model.selectedID())

    assert.equal(dispatchPanelRangeText(model.visible().start, 10, 71), '1-10 de 71')
    assert.equal(model.footer().includes('1-10 de 71'), true)
    assert.equal(dispatchPanelWindow(3, 0).end, 3)
    assert.equal(dispatchPanelRangeText(0, 3, 3), null, 'a list that fits needs no range')
  })
})

test('tick: 80 ms only while the panel is open with something running', async () => {
  const host = dispatchHost()
  await withPanelModel(host.context, { width: 100 }, async (model, panel) => {
    await sleep(180)
    assert.ok(model.frame() > 0, 'a running child animates the spinner')

    panel.setName('someone.else')
    await sleep(0)
    const frozen = model.frame()
    await sleep(200)
    assert.equal(model.frame(), frozen, 'closing the panel stops the tick')

    panel.setName('pantheon.dispatch')
    await sleep(0)
    host.statuses.set('ses_live', 'idle')
    host.children.get('ses_live').time.updated = 0
    host.emit('session.idle')
    await sleep(20)
    const idle = model.frame()
    await sleep(200)
    assert.equal(model.frame(), idle, 'nothing running → no timer at all')
  })

  // Unmounting clears the interval: a new root sees frame 0 only.
  await withPanelModel(host.context, { width: 100 }, async (model) => {
    await sleep(0)
    assert.equal(model.hasRunning(), false)
  })
})

/* ─── Commands ──────────────────────────────────────────── */

test('keymap: the layer is disabled and every key falls through while the panel is not focused', async () => {
  const { dispatchPanelKeymapLayer, DISPATCH_PANEL_COMMANDS } = await loadV2()

  const calls = []
  const model = {
    rows: () => [{ id: 'ses_a', state: 'completed', text: 'row' }],
    move: (delta) => calls.push(['move', delta]),
    first: () => calls.push(['first']),
    last: () => calls.push(['last']),
    pageUp: () => calls.push(['pageUp']),
    pageDown: () => calls.push(['pageDown']),
    toggle: () => calls.push(['toggle']),
  }
  const unfocused = {
    focused: false,
    close: () => calls.push(['close']),
    toggleFullscreen: () => calls.push(['fullscreen']),
  }

  const inert = dispatchPanelKeymapLayer(unfocused, model)
  assert.equal(inert.mode, 'global', 'the binding names stay namespaced')
  assert.equal(typeof inert.enabled, 'function', 'focus is a reactive gate, not a one-time read')
  assert.equal(inert.enabled(), false, 'the whole layer is off while the panel is not focused')
  assert.equal(inert.commands.length, DISPATCH_PANEL_COMMANDS.length)
  for (const command of inert.commands) {
    assert.equal(
      command.run(),
      false,
      `${command.id} returns false so j/k/f/q/enter/escape reach the composer`,
    )
  }
  assert.deepEqual(calls, [], 'no action ran and no key was consumed')

  // Focused: the same layer becomes active and consumes the keys it handles.
  const focused = { ...unfocused, focused: true }
  const active = dispatchPanelKeymapLayer(focused, model)
  assert.equal(active.enabled(), true)
  const byId = new Map(active.commands.map((command) => [command.id, command]))
  assert.equal(byId.get('pantheon.dispatch.down').run(), undefined, 'down is consumed')
  assert.equal(byId.get('pantheon.dispatch.toggle').run(), undefined, 'enter is consumed')
  assert.equal(byId.get('pantheon.dispatch.close').run(), undefined, 'q/escape close the panel')
  assert.deepEqual(calls.slice(0, 3), [['move', 1], ['toggle'], ['close']])

  // Focused but nothing to navigate: the navigation keys fall through, the
  // panel's own keys still work.
  const empty = dispatchPanelKeymapLayer(focused, { ...model, rows: () => [] })
  const emptyById = new Map(empty.commands.map((command) => [command.id, command]))
  assert.equal(emptyById.get('pantheon.dispatch.up').run(), false, 'no row to select')
  assert.equal(emptyById.get('pantheon.dispatch.toggle').run(), false, 'no detail to expand')
  assert.equal(emptyById.get('pantheon.dispatch.close').run(), undefined)
})

test('commands: every panel command is namespaced and explicitly bound', async () => {
  const { DISPATCH_PANEL_COMMANDS, performDispatchPanelAction } = await loadV2()
  const expected = [
    ['pantheon.dispatch.up', 'k,up'],
    ['pantheon.dispatch.down', 'j,down'],
    ['pantheon.dispatch.home', 'home'],
    ['pantheon.dispatch.end', 'end'],
    ['pantheon.dispatch.pageup', 'pageup'],
    ['pantheon.dispatch.pagedown', 'pagedown'],
    ['pantheon.dispatch.toggle', 'enter'],
    ['pantheon.dispatch.fullscreen', 'f'],
    ['pantheon.dispatch.close', 'escape,q'],
  ]
  assert.deepEqual(
    DISPATCH_PANEL_COMMANDS.map((command) => [command.id, command.bind]),
    expected,
  )
  for (const command of DISPATCH_PANEL_COMMANDS) {
    assert.equal(typeof command.bind, 'string', `${command.id} keeps an explicit binding`)
    assert.ok(command.bind.length > 0)
    assert.ok(command.title.length > 0)
  }

  const calls = []
  const model = {
    move: (delta) => calls.push(['move', delta]),
    first: () => calls.push(['first']),
    last: () => calls.push(['last']),
    pageUp: () => calls.push(['pageUp']),
    pageDown: () => calls.push(['pageDown']),
    toggle: () => calls.push(['toggle']),
  }
  const panel = {
    close: () => calls.push(['close']),
    toggleFullscreen: () => calls.push(['fullscreen']),
  }
  for (const command of DISPATCH_PANEL_COMMANDS) {
    performDispatchPanelAction(command.action, model, panel)
  }
  assert.deepEqual(calls, [
    ['move', -1],
    ['move', 1],
    ['first'],
    ['last'],
    ['pageUp'],
    ['pageDown'],
    ['toggle'],
    ['fullscreen'],
    ['close'],
  ])

  // The layer itself is wired from that table, inside the panel claim.
  const text = source()
  assert.match(text, /function DispatchPanelKeymap/)
  assert.match(text, /DISPATCH_PANEL_COMMANDS\.map/)
  assert.match(text, /mode: 'global'/)
})

test('footer: host shortcuts, em dash when a command has no binding', async () => {
  const { dispatchPanelFooter } = await loadV2()

  const bound = dispatchPanelFooter((id) =>
    id === 'pantheon.dispatch.up'
      ? ['k', 'up']
      : id === 'pantheon.dispatch.close'
        ? ['escape', 'q']
        : [],
  )
  assert.equal(
    bound,
    'k/up — mover · — detalhe · — fullscreen · escape/q fechar',
    'a command without a reported shortcut prints the em dash',
  )
  const bare = dispatchPanelFooter(() => [])
  assert.equal(bare.startsWith('— — mover'), true)
  assert.equal(dispatchPanelFooter(() => null).includes('—'), true, 'a broken keymap never throws')
})

/* ─── Shared collector + budget ─────────────────────────── */

test('collector: the sidebar and the panel render one collector, with no duplicates', async () => {
  const { collectDispatch, createSidebarModel } = await loadV2()
  const host = dispatchHost()

  const entries = collectDispatch(host.context, 'ses_root')
  assert.deepEqual(
    entries.map((item) => item.view.id),
    ['ses_live', 'ses_done', 'ses_fail'],
    'the root is excluded and every child appears exactly once',
  )
  assert.deepEqual(entries[0].tokens, {
    input: 1_200,
    output: 40,
    reasoning: 10,
    cacheRead: 800,
    cacheWrite: 10,
  })
  assert.equal(entries[0].parentID, 'ses_root')
  assert.equal(entries[0].description, '[plan] migration', 'the subagent call explains the child')
  assert.equal(entries[0].view.kind, 'plan')
  assert.equal(entries[1].view.state, 'completed')
  assert.equal(entries[2].view.state, 'failed')

  // No child transcript is read: only the parent's own `message.list` (the
  // host's cached list) feeds the call evidence.
  assert.deepEqual(host.listCalls, ['ses_root'])
  assert.deepEqual(host.syncCalls, [], 'the collector syncs nothing')

  // The sidebar block and the panel agree, because both read that one function.
  // The model owns a spinner timer, so it lives inside a root that is disposed.
  const sidebarBlock = () =>
    createRoot((dispose) => {
      try {
        return createSidebarModel(host.context, () => 'ses_root').dispatch()
      } finally {
        dispose()
      }
    })
  const block = sidebarBlock()
  assert.equal(block.runningCount, 1)
  assert.equal(block.completedCount, 2)
  assert.equal(block.failures, 1)
  assert.deepEqual(
    block.running.map((row) => row.id),
    entries.filter((item) => item.view.state === 'running').map((item) => item.view.id),
  )

  await withPanelModel(host.context, { width: 100 }, async (model) => {
    assert.deepEqual(
      model.entries().map((item) => item.view.id),
      entries.map((item) => item.view.id),
      'panel entries are the collector output, in the same order',
    )
    const ids = model.rows().map((row) => row.id)
    assert.equal(new Set(ids).size, ids.length, 'no duplicated row')
    assert.equal(model.header().includes('1 rodando'), true)
    assert.equal(model.header().includes('1 falha'), true)
  })

  // Source-level: one function, called by both models — never two collectors.
  const text = source()
  assert.match(text, /export function collectDispatch\(/)
  assert.equal(
    (text.match(/function collectDispatch\(/g) ?? []).length,
    1,
    'exactly one collectDispatch definition',
  )
  assert.match(
    text,
    /const dispatchEntries = createMemo\(\(\) => \{[\s\S]{0,400}collectDispatch\(context, id, \{/,
    'the sidebar model collects through collectDispatch',
  )
  assert.match(
    text,
    /const entries = createMemo\(\(\) => \{[\s\S]{0,200}collectDispatch\(context, activeSessionID\(\)\)/,
    'the panel model collects through the same function',
  )
  assert.match(
    text,
    /function toDispatchEntry\([\s\S]{0,600}toDelegationView\(child, status, now, call\)/,
    'the collector is the one place that builds a delegation row for the tree',
  )
})

test('collector: a family that repeats an id yields one row and counts its cost once', async () => {
  const { collectDispatch, dispatchTotalCost, dispatchPanelHeader } = await loadV2()
  const host = createPanelHost({
    children: [
      ['ses_root', { id: 'ses_root' }],
      [
        'ses_a',
        {
          id: 'ses_a',
          parentID: 'ses_root',
          agent: 'apollo',
          cost: 0.5,
          outcome: 'succeeded',
          time: { created: 0, updated: 2 },
        },
      ],
      [
        'ses_b',
        {
          id: 'ses_b',
          parentID: 'ses_root',
          agent: 'demeter',
          cost: 0.25,
          outcome: 'failed',
          time: { created: 0, updated: 1 },
        },
      ],
    ],
    family: ['ses_root', 'ses_a', 'ses_a', 'ses_b'],
  })

  const entries = collectDispatch(host.context, 'ses_root')
  assert.deepEqual(
    entries.map((item) => item.view.id),
    ['ses_a', 'ses_b'],
    'a repeated id is listed once, in the order the host published it',
  )
  assert.equal(
    dispatchTotalCost(entries.map((item) => item.view)),
    0.75,
    'a repeated child cannot double the spend',
  )
  assert.equal(dispatchPanelHeader(entries), '1 concluído · 1 falha · $0.75')
})

test('budget: the panel writes no metadata and syncs no session', async () => {
  const text = source()
  const panelSection = text.slice(
    text.indexOf('/* ─── Dispatch panel'),
    text.indexOf('/** Session ids to eagerly sync at load'),
  )
  assert.ok(panelSection.length > 1_000, 'the panel section was located')
  assert.equal(
    /metadata\s*\.?\s*(update|set)\s*\(|session\.update\s*\(/.test(panelSection),
    false,
    'never writes session.metadata',
  )
  assert.equal(panelSection.includes('.sync('), false, 'never syncs a session or a message list')
  assert.equal(
    panelSection.includes('message.list'),
    false,
    'the panel adds no message.list of its own',
  )
  assert.match(panelSection, /SPINNER_INTERVAL_MS/, 'the only timer is the shared 80 ms tick')
})

/* ─── Rendered shape (documentation of the panel) ───────── */

test('render: empty, mixed and narrow panels keep their documented shape', async () => {
  const {
    dispatchPanelTitle,
    dispatchPanelHeader,
    dispatchPanelRule,
    dispatchPanelRowText,
    dispatchPanelDetail,
    dispatchPanelLayout,
    DISPATCH_PANEL_EMPTY_TEXT,
  } = await loadV2()

  const title = dispatchPanelTitle('refactor the dispatcher')
  assert.equal(title, '◈ Dispatch — refactor the dispatcher')
  assert.equal(dispatchPanelTitle(null), '◈ Dispatch', 'no session title → no dangling dash')
  assert.equal(
    dispatchPanelTitle('refactor the dispatcher', 44, 'fullscreen'),
    '◈ Dispatch — refactor the dispatcher [fullscreen]',
    'the full-screen presentation is badged, exactly as the mock shows',
  )
  assert.equal(dispatchPanelTitle(null, 44, 'fullscreen'), '◈ Dispatch [fullscreen]')
  assert.equal(
    dispatchPanelTitle('refactor', 44, 'panel').includes('['),
    false,
    'the inline panel carries no badge',
  )
  assert.equal(dispatchPanelRule(12).length, 12)

  const empty = [title, dispatchPanelRule(60), DISPATCH_PANEL_EMPTY_TEXT]
  assert.deepEqual(empty, [
    '◈ Dispatch — refactor the dispatcher',
    '─'.repeat(60),
    'Nenhuma sessão delegada',
  ])

  const running = entry('ses_a', 'running', {
    agent: 'prometheus',
    kind: 'plan',
    cost: 0.09,
    startedAt: 0,
  })
  const done = entry('ses_b', 'completed', {
    agent: 'apollo',
    kind: 'disc',
    cost: 0.04,
    startedAt: 0,
    updatedAt: 12_800,
  })
  const failed = entry('ses_c', 'failed', {
    agent: 'demeter',
    kind: 'oth',
    cost: 0.02,
    startedAt: 0,
    updatedAt: 6_000,
  })
  const mixed = [running, done, failed]
  assert.equal(dispatchPanelHeader(mixed), '1 rodando · 1 concluído · 1 falha · $0.15')
  assert.deepEqual(dispatchPanelDetail(running)[3], 'kind plan (prefixo) · parent —')

  const narrow = dispatchPanelLayout(60)
  assert.equal(narrow.mode, 'narrow')
  assert.equal(
    dispatchPanelRowText(done, { now: 0, max: narrow.rowWidth }).length,
    35,
    'a narrow row keeps its columns instead of wrapping',
  )
})
