/**
 * tui-prefs.ts — the TUI personalization core (the settings window's TUI tab).
 *
 * TUI-local copy doctrine (same as cost-data.ts): the bundle must stay
 * self-contained. Persistence is the HOST's durable plugin storage
 * (`context.storage.store('tui-prefs', { initial })` — reactive solid store,
 * live-synced across TUI instances); this module owns the SHAPE and the pure
 * operations, never the store handle.
 *
 * v1 surfaces: sidebar fixed headers, sidebar blocks, the Context block's
 * sub-lines and gauge style, and the two Pantheon footer lines. Everything
 * defaults to on — the window exists to turn things OFF.
 */
import type { Context } from '@opencode/plugin/tui/context'
import type { SettingsRow, SettingsTab } from './pantheon-settings-state.ts'

// ── The durable store handle (host storage, one per plugin) ────────────
// Created once at setup and stashed under a globalThis symbol so
// hot-reload generations keep sharing the same live store (the same
// singleton doctrine as the plugin's SINGLETON guard).

const PREFS_SYMBOL = Symbol.for('pantheon.tui.prefs.v1')
type PrefsStore = readonly [
  TuiPrefs,
  (mutation: (draft: TuiPrefs) => void) => Promise<void>,
]

function stash(): PrefsStore | undefined {
  return (globalThis as Record<PropertyKey, unknown>)[PREFS_SYMBOL] as PrefsStore | undefined
}

/** Create (or reuse) the durable prefs store. Fail-open: without host
 *  storage the consumers fall back to DEFAULT_TUI_PREFS (read-only). */
export function initTuiPrefs(context: Context): void {
  if (stash() !== undefined) return
  try {
    const handle = context.storage?.store?.('tui-prefs', { initial: DEFAULT_TUI_PREFS }) as
      | PrefsStore
      | undefined
    if (handle !== undefined) {
      ;(globalThis as unknown as Record<PropertyKey, unknown>)[PREFS_SYMBOL] = handle
    }
  } catch {
    /* no host storage — defaults stay read-only */
  }
}

/** The live reactive prefs (read properties inside memos/JSX — tracked). */
export function tuiPrefs(): TuiPrefs {
  return stash()?.[0] ?? DEFAULT_TUI_PREFS
}

/** Stage a mutation against the durable store; resolves when persisted. */
export function mutateTuiPrefs(mutation: (draft: TuiPrefs) => void): Promise<void> {
  const handle = stash()
  if (handle === undefined) return Promise.resolve()
  return handle[1](mutation)
}

export const GAUGE_STYLES: readonly string[] = Object.freeze(['both', 'bar', 'percent', 'off'])
export const ENABLED_CYCLE: readonly string[] = Object.freeze(['enabled', 'disabled'])

export type GaugeStyle = 'both' | 'bar' | 'percent' | 'off'

export interface TuiPrefs {
  version: 1
  sidebar: {
    header: { version: boolean; preset: boolean; session: boolean }
    blocks: { context: boolean; git: boolean; todo: boolean; dispatch: boolean }
    context: {
      gauge: GaugeStyle
      tokens: boolean
      spent: boolean
      modelUsage: boolean
      performance: boolean
      localSpend: boolean
    }
  }
  footer: { prompt: boolean; home: boolean }
}

export const DEFAULT_TUI_PREFS: TuiPrefs = {
  version: 1,
  sidebar: {
    header: { version: true, preset: true, session: true },
    blocks: { context: true, git: true, todo: true, dispatch: true },
    context: {
      gauge: 'both',
      tokens: true,
      spent: true,
      modelUsage: true,
      performance: true,
      localSpend: true,
    },
  },
  footer: { prompt: true, home: true },
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** Deep-merge stored JSON over the defaults; unknown keys and junk are ignored. */
export function normalizeTuiPrefs(raw: unknown): TuiPrefs {
  const stored = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, any>
  const sidebar = (typeof stored.sidebar === 'object' && stored.sidebar !== null
    ? stored.sidebar
    : {}) as Record<string, any>
  const header = (typeof sidebar.header === 'object' && sidebar.header !== null
    ? sidebar.header
    : {}) as Record<string, any>
  const blocks = (typeof sidebar.blocks === 'object' && sidebar.blocks !== null
    ? sidebar.blocks
    : {}) as Record<string, any>
  const context = (typeof sidebar.context === 'object' && sidebar.context !== null
    ? sidebar.context
    : {}) as Record<string, any>
  const footer = (typeof stored.footer === 'object' && stored.footer !== null
    ? stored.footer
    : {}) as Record<string, any>
  const gauge = GAUGE_STYLES.includes(context.gauge as string)
    ? (context.gauge as GaugeStyle)
    : DEFAULT_TUI_PREFS.sidebar.context.gauge
  return {
    version: 1,
    sidebar: {
      header: {
        version: asBool(header.version, true),
        preset: asBool(header.preset, true),
        session: asBool(header.session, true),
      },
      blocks: {
        context: asBool(blocks.context, true),
        git: asBool(blocks.git, true),
        todo: asBool(blocks.todo, true),
        dispatch: asBool(blocks.dispatch, true),
      },
      context: {
        gauge,
        tokens: asBool(context.tokens, true),
        spent: asBool(context.spent, true),
        modelUsage: asBool(context.modelUsage, true),
        performance: asBool(context.performance, true),
        localSpend: asBool(context.localSpend, true),
      },
    },
    footer: {
      prompt: asBool(footer.prompt, true),
      home: asBool(footer.home, true),
    },
  }
}

// ── The TUI tab (cycler rows over the dotted pref paths) ───────────────

const onOff = ENABLED_CYCLE
const row = (
  id: string,
  name: string,
  value: boolean,
  note: string,
): SettingsRow => ({
  id,
  name,
  value: value ? 'enabled' : 'disabled',
  cycle: onOff,
  note,
})

export function buildTuiTab(prefs: TuiPrefs): SettingsTab {
  return {
    id: 'tui',
    title: 'TUI',
    groups: [
      {
        title: 'Sidebar header',
        rows: [
          row('tui.sidebar.header.version', 'Version line', prefs.sidebar.header.version, 'the `Pantheon v…` line'),
          row('tui.sidebar.header.preset', 'Preset line', prefs.sidebar.header.preset, 'the `▸ preset · provider` line'),
          row('tui.sidebar.header.session', 'Session line', prefs.sidebar.header.session, 'the active session title'),
        ],
      },
      {
        title: 'Sidebar blocks',
        rows: [
          row('tui.sidebar.block.context', 'Context block', prefs.sidebar.blocks.context, 'tokens, gauge, spend, model usage'),
          row('tui.sidebar.block.git', 'Git block', prefs.sidebar.blocks.git, 'branch + working-tree counts'),
          row('tui.sidebar.block.todo', 'Todo block', prefs.sidebar.blocks.todo, 'the newest todowrite'),
          row('tui.sidebar.block.dispatch', 'Dispatch block', prefs.sidebar.blocks.dispatch, 'live delegations + rollup'),
        ],
      },
      {
        title: 'Context block detail',
        rows: [
          {
            id: 'tui.sidebar.context.gauge',
            name: 'Gauge style',
            value: prefs.sidebar.context.gauge,
            cycle: GAUGE_STYLES,
            note: 'both | bar | percent | off — `▰▱ 42% of 200k`',
          },
          row('tui.sidebar.context.tokens', 'Tokens row', prefs.sidebar.context.tokens, 'the raw token count line'),
          row('tui.sidebar.context.spent', 'Spent row', prefs.sidebar.context.spent, 'the `$… gasto na sessão` line'),
          row('tui.sidebar.context.modelUsage', 'Model usage table', prefs.sidebar.context.modelUsage, 'per-model tokens/USD'),
          row('tui.sidebar.context.performance', 'Performance line', prefs.sidebar.context.performance, 'cache % + tok/s'),
          row('tui.sidebar.context.localSpend', 'Local spend', prefs.sidebar.context.localSpend, 'hoje / 30d totals'),
        ],
      },
      {
        title: 'Footers',
        rows: [
          row('tui.footer.prompt', 'Prompt footer', prefs.footer.prompt, 'the `▸preset · ✦n ativos` line while delegations run'),
          row('tui.footer.home', 'Home status', prefs.footer.home, 'the `Pantheon v…` line under the home prompt'),
        ],
      },
    ],
  }
}

/**
 * Apply one staged row INTO a prefs draft (in place — the storage mutate
 * callback hands an immer-style draft). Unknown ids or junk values are no-ops.
 */
export function applyTuiRow(draft: TuiPrefs, id: string, value: string): void {
  const enabled = value === 'enabled'
  switch (id) {
    case 'tui.sidebar.header.version':
      draft.sidebar.header.version = enabled
      return
    case 'tui.sidebar.header.preset':
      draft.sidebar.header.preset = enabled
      return
    case 'tui.sidebar.header.session':
      draft.sidebar.header.session = enabled
      return
    case 'tui.sidebar.block.context':
      draft.sidebar.blocks.context = enabled
      return
    case 'tui.sidebar.block.git':
      draft.sidebar.blocks.git = enabled
      return
    case 'tui.sidebar.block.todo':
      draft.sidebar.blocks.todo = enabled
      return
    case 'tui.sidebar.block.dispatch':
      draft.sidebar.blocks.dispatch = enabled
      return
    case 'tui.sidebar.context.gauge':
      if (GAUGE_STYLES.includes(value)) draft.sidebar.context.gauge = value as GaugeStyle
      return
    case 'tui.sidebar.context.tokens':
      draft.sidebar.context.tokens = enabled
      return
    case 'tui.sidebar.context.spent':
      draft.sidebar.context.spent = enabled
      return
    case 'tui.sidebar.context.modelUsage':
      draft.sidebar.context.modelUsage = enabled
      return
    case 'tui.sidebar.context.performance':
      draft.sidebar.context.performance = enabled
      return
    case 'tui.sidebar.context.localSpend':
      draft.sidebar.context.localSpend = enabled
      return
    case 'tui.footer.prompt':
      draft.footer.prompt = enabled
      return
    case 'tui.footer.home':
      draft.footer.home = enabled
      return
    default:
      return
  }
}

/** Read the current pref value for a row id ('enabled'/'disabled'/gauge). */
export function tuiRowValue(prefs: TuiPrefs, id: string): string | undefined {
  if (id === 'tui.sidebar.context.gauge') return prefs.sidebar.context.gauge
  const enabled = (() => {
    switch (id) {
      case 'tui.sidebar.header.version':
        return prefs.sidebar.header.version
      case 'tui.sidebar.header.preset':
        return prefs.sidebar.header.preset
      case 'tui.sidebar.header.session':
        return prefs.sidebar.header.session
      case 'tui.sidebar.block.context':
        return prefs.sidebar.blocks.context
      case 'tui.sidebar.block.git':
        return prefs.sidebar.blocks.git
      case 'tui.sidebar.block.todo':
        return prefs.sidebar.blocks.todo
      case 'tui.sidebar.block.dispatch':
        return prefs.sidebar.blocks.dispatch
      case 'tui.sidebar.context.tokens':
        return prefs.sidebar.context.tokens
      case 'tui.sidebar.context.spent':
        return prefs.sidebar.context.spent
      case 'tui.sidebar.context.modelUsage':
        return prefs.sidebar.context.modelUsage
      case 'tui.sidebar.context.performance':
        return prefs.sidebar.context.performance
      case 'tui.sidebar.context.localSpend':
        return prefs.sidebar.context.localSpend
      case 'tui.footer.prompt':
        return prefs.footer.prompt
      case 'tui.footer.home':
        return prefs.footer.home
      default:
        return undefined
    }
  })()
  return enabled === undefined ? undefined : enabled ? 'enabled' : 'disabled'
}
