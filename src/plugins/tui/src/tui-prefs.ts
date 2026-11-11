// biome-ignore-all lint/suspicious/noExplicitAny: stored prefs are host JSON of a known shape.
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
type PrefsStore = readonly [TuiPrefs, (mutation: (draft: TuiPrefs) => void) => Promise<void>]

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
      // Self-heal: if store was persisted before layout existed, backfill missing top-level defaults
      if (!handle[0]?.layout) {
        handle[1]((draft: any) => {
          if (!draft.layout) {
            draft.layout = { ...DEFAULT_TUI_PREFS.layout }
          }
        }).catch(() => {})
      }
    }
  } catch {
    /* no host storage — defaults stay read-only */
  }
}

/** The live reactive prefs (read properties inside memos/JSX — tracked). */
export function tuiPrefs(): TuiPrefs {
  const s = stash()?.[0]
  if (!s) return DEFAULT_TUI_PREFS
  if (!s.layout) {
    return {
      ...s,
      layout: DEFAULT_TUI_PREFS.layout,
    }
  }
  return s
}

/** Stage a mutation against the durable store; resolves when persisted. */
export function mutateTuiPrefs(mutation: (draft: TuiPrefs) => void): Promise<void> {
  const handle = stash()
  if (handle === undefined) return Promise.resolve()
  return handle[1](mutation)
}

export const GAUGE_STYLES: readonly string[] = Object.freeze(['both', 'bar', 'percent', 'off'])
export const ENABLED_CYCLE: readonly string[] = Object.freeze(['enabled', 'disabled'])

export const BAR_SHAPES_CYCLE: readonly string[] = Object.freeze([
  'line',
  'block',
  'smooth',
  'ascii',
  'dots',
  'braille',
])
export const BAR_WIDTHS_CYCLE: readonly string[] = Object.freeze([
  'standard',
  'compact',
  'wide',
  'full',
])
export const LAYOUT_PRESETS_CYCLE: readonly string[] = Object.freeze(['comfortable', 'compact'])
export const SEPARATOR_STYLES_CYCLE: readonly string[] = Object.freeze([
  'spaces',
  'pipes',
  'dots',
  'slashes',
])
export const SETTINGS_VIEW_MODES: readonly string[] = Object.freeze([
  'docked',
  'fullscreen',
  'dialog',
])

export type GaugeStyle = 'both' | 'bar' | 'percent' | 'off'
export type BarShapePref = 'line' | 'block' | 'smooth' | 'ascii' | 'dots' | 'braille'
export type BarWidthPref = 'standard' | 'compact' | 'wide' | 'full'
export type LayoutPresetPref = 'comfortable' | 'compact'
export type SeparatorStylePref = 'spaces' | 'pipes' | 'dots' | 'slashes'
export type SettingsViewModePref = 'docked' | 'fullscreen' | 'dialog'

export interface TuiPrefs {
  version: 1
  layout: {
    preset: LayoutPresetPref
    separator: SeparatorStylePref
    settingsView?: SettingsViewModePref
  }
  sidebar: {
    header: { version: boolean; preset: boolean; session: boolean }
    blocks: { context: boolean; git: boolean; todo: boolean; dispatch: boolean }
    context: {
      gauge: GaugeStyle
      barShape: BarShapePref
      barWidth: BarWidthPref
      evenMark: boolean
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
  layout: {
    preset: 'comfortable',
    separator: 'spaces',
    settingsView: 'dialog',
  },
  sidebar: {
    header: { version: true, preset: true, session: true },
    blocks: { context: true, git: true, todo: true, dispatch: true },
    context: {
      gauge: 'both',
      barShape: 'line',
      barWidth: 'standard',
      evenMark: false,
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
  const layout = (
    typeof stored.layout === 'object' && stored.layout !== null ? stored.layout : {}
  ) as Record<string, any>
  const sidebar = (
    typeof stored.sidebar === 'object' && stored.sidebar !== null ? stored.sidebar : {}
  ) as Record<string, any>
  const header = (
    typeof sidebar.header === 'object' && sidebar.header !== null ? sidebar.header : {}
  ) as Record<string, any>
  const blocks = (
    typeof sidebar.blocks === 'object' && sidebar.blocks !== null ? sidebar.blocks : {}
  ) as Record<string, any>
  const context = (
    typeof sidebar.context === 'object' && sidebar.context !== null ? sidebar.context : {}
  ) as Record<string, any>
  const footer = (
    typeof stored.footer === 'object' && stored.footer !== null ? stored.footer : {}
  ) as Record<string, any>
  const preset = LAYOUT_PRESETS_CYCLE.includes(layout.preset as string)
    ? (layout.preset as LayoutPresetPref)
    : DEFAULT_TUI_PREFS.layout.preset
  const separator = SEPARATOR_STYLES_CYCLE.includes(layout.separator as string)
    ? (layout.separator as SeparatorStylePref)
    : DEFAULT_TUI_PREFS.layout.separator
  const settingsView = (
    SETTINGS_VIEW_MODES.includes(layout.settingsView as string)
      ? layout.settingsView
      : DEFAULT_TUI_PREFS.layout.settingsView
  ) as SettingsViewModePref
  const gauge = GAUGE_STYLES.includes(context.gauge as string)
    ? (context.gauge as GaugeStyle)
    : DEFAULT_TUI_PREFS.sidebar.context.gauge
  const barShape = BAR_SHAPES_CYCLE.includes(context.barShape as string)
    ? (context.barShape as BarShapePref)
    : DEFAULT_TUI_PREFS.sidebar.context.barShape
  const barWidth = BAR_WIDTHS_CYCLE.includes(context.barWidth as string)
    ? (context.barWidth as BarWidthPref)
    : DEFAULT_TUI_PREFS.sidebar.context.barWidth
  const evenMark = asBool(context.evenMark, DEFAULT_TUI_PREFS.sidebar.context.evenMark)

  return {
    version: 1,
    layout: {
      preset,
      separator,
      settingsView,
    },
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
        barShape,
        barWidth,
        evenMark,
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
const row = (id: string, name: string, value: boolean, note: string): SettingsRow => ({
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
        title: 'Preset & Layout',
        rows: [
          {
            id: 'tui.layout.preset',
            name: 'Layout preset',
            value: prefs.layout?.preset ?? DEFAULT_TUI_PREFS.layout.preset,
            cycle: LAYOUT_PRESETS_CYCLE,
            note: 'comfortable | compact — sets spacing & borders',
          },
          {
            id: 'tui.layout.separator',
            name: 'Separator',
            value: prefs.layout?.separator ?? DEFAULT_TUI_PREFS.layout.separator,
            cycle: SEPARATOR_STYLES_CYCLE,
            note: 'spaces | pipes | dots | slashes — status line glyphs',
          },
          {
            id: 'tui.layout.settingsView',
            name: 'Settings surface',
            value: tuiRowValue(prefs, 'tui.layout.settingsView') ?? 'docked',
            cycle: SETTINGS_VIEW_MODES,
            note: 'docked (above prompt) | fullscreen router page | dialog overlay',
          },
        ],
      },
      {
        title: 'Bars & Gauges',
        rows: [
          {
            id: 'tui.sidebar.context.barShape',
            name: 'Bar shape',
            value: prefs.sidebar.context.barShape,
            cycle: BAR_SHAPES_CYCLE,
            note: 'line (━─) | block (▰▱) | smooth (█░) | ascii (=) | dots (●○) | braille',
          },
          {
            id: 'tui.sidebar.context.barWidth',
            name: 'Bar width',
            value: prefs.sidebar.context.barWidth,
            cycle: BAR_WIDTHS_CYCLE,
            note: 'standard (12) | compact (8) | wide (16) | full (20 cells)',
          },
          row(
            'tui.sidebar.context.evenMark',
            'Even-use mark',
            prefs.sidebar.context.evenMark,
            '| indicator at 50% midpoint in gauge bars',
          ),
          {
            id: 'tui.sidebar.context.gauge',
            name: 'Gauge style',
            value: prefs.sidebar.context.gauge,
            cycle: GAUGE_STYLES,
            note: 'both | bar | percent | off — `▰▱ 42% of 200k`',
          },
        ],
      },
      {
        title: 'Sidebar header',
        rows: [
          row(
            'tui.sidebar.header.version',
            'Version line',
            prefs.sidebar.header.version,
            'the `Pantheon v…` line',
          ),
          row(
            'tui.sidebar.header.preset',
            'Preset line',
            prefs.sidebar.header.preset,
            'the `▸ preset · provider` line',
          ),
          row(
            'tui.sidebar.header.session',
            'Session line',
            prefs.sidebar.header.session,
            'the active session title',
          ),
        ],
      },
      {
        title: 'Sidebar blocks',
        rows: [
          row(
            'tui.sidebar.block.context',
            'Context block',
            prefs.sidebar.blocks.context,
            'tokens, gauge, spend, model usage',
          ),
          row(
            'tui.sidebar.block.git',
            'Git block',
            prefs.sidebar.blocks.git,
            'branch + working-tree counts',
          ),
          row(
            'tui.sidebar.block.todo',
            'Todo block',
            prefs.sidebar.blocks.todo,
            'the newest todowrite',
          ),
          row(
            'tui.sidebar.block.dispatch',
            'Dispatch block',
            prefs.sidebar.blocks.dispatch,
            'live delegations + rollup',
          ),
        ],
      },
      {
        title: 'Context block detail',
        rows: [
          row(
            'tui.sidebar.context.tokens',
            'Tokens row',
            prefs.sidebar.context.tokens,
            'the raw token count line',
          ),
          row(
            'tui.sidebar.context.spent',
            'Spent row',
            prefs.sidebar.context.spent,
            'the `$… gasto na sessão` line',
          ),
          row(
            'tui.sidebar.context.modelUsage',
            'Model usage table',
            prefs.sidebar.context.modelUsage,
            'per-model tokens/USD',
          ),
          row(
            'tui.sidebar.context.performance',
            'Performance line',
            prefs.sidebar.context.performance,
            'cache % + tok/s',
          ),
          row(
            'tui.sidebar.context.localSpend',
            'Local spend',
            prefs.sidebar.context.localSpend,
            'hoje / 30d totals',
          ),
        ],
      },
      {
        title: 'Footers',
        rows: [
          row(
            'tui.footer.prompt',
            'Prompt footer',
            prefs.footer.prompt,
            'the `▸preset · ✦n ativos` line while delegations run',
          ),
          row(
            'tui.footer.home',
            'Home status',
            prefs.footer.home,
            'the `Pantheon v…` line under the home prompt',
          ),
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
    case 'tui.layout.preset':
      if (LAYOUT_PRESETS_CYCLE.includes(value)) {
        if (!draft.layout) draft.layout = { ...DEFAULT_TUI_PREFS.layout }
        draft.layout.preset = value as LayoutPresetPref
      }
      return
    case 'tui.layout.separator':
      if (SEPARATOR_STYLES_CYCLE.includes(value)) {
        if (!draft.layout) draft.layout = { ...DEFAULT_TUI_PREFS.layout }
        draft.layout.separator = value as SeparatorStylePref
      }
      return
    case 'tui.layout.settingsView':
      if (SETTINGS_VIEW_MODES.includes(value)) {
        if (!draft.layout) draft.layout = { ...DEFAULT_TUI_PREFS.layout }
        draft.layout.settingsView = value as SettingsViewModePref
      }
      return
    case 'tui.sidebar.context.barShape':
      if (BAR_SHAPES_CYCLE.includes(value)) draft.sidebar.context.barShape = value as BarShapePref
      return
    case 'tui.sidebar.context.barWidth':
      if (BAR_WIDTHS_CYCLE.includes(value)) draft.sidebar.context.barWidth = value as BarWidthPref
      return
    case 'tui.sidebar.context.evenMark':
      draft.sidebar.context.evenMark = enabled
      return
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

/** Read the current pref value for a row id ('enabled'/'disabled'/gauge/custom). */
export function tuiRowValue(prefs: TuiPrefs, id: string): string | undefined {
  if (id === 'tui.layout.preset') return prefs.layout?.preset ?? DEFAULT_TUI_PREFS.layout.preset
  if (id === 'tui.layout.separator')
    return prefs.layout?.separator ?? DEFAULT_TUI_PREFS.layout.separator
  if (id === 'tui.layout.settingsView')
    return prefs.layout?.settingsView ?? DEFAULT_TUI_PREFS.layout.settingsView ?? 'docked'
  if (id === 'tui.sidebar.context.barShape') return prefs.sidebar.context.barShape
  if (id === 'tui.sidebar.context.barWidth') return prefs.sidebar.context.barWidth
  if (id === 'tui.sidebar.context.gauge') return prefs.sidebar.context.gauge
  if (id === 'tui.sidebar.context.evenMark')
    return prefs.sidebar.context.evenMark ? 'enabled' : 'disabled'
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
