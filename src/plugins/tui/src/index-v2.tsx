// biome-ignore-all lint/suspicious/noExplicitAny: OpenCode V2 exposes its TUI API at runtime.
// biome-ignore-all lint/a11y/noStaticElementInteractions: TUI elements, not DOM
/** @jsxImportSource @opentui/solid */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Plugin } from '@opencode/plugin/tui'
import type { Context, KeymapLayer, PanelInput } from '@opencode/plugin/tui/context'
import type { Accessor } from 'solid-js'
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'

const SINGLETON = Symbol.for('pantheon.tui.v2.loaded')

/* ─── Constants ─────────────────────────────────────────── */

/** How often the sidebar re-reads .pantheon/active-preset.json (V1 parity) so
 *  `set-tier` changes made while opencode is open show up within ~30s. */
const PRESET_REFRESH_MS = 30_000
/** Running-row spinner cadence — matches V1's animation tick. */
const SPINNER_INTERVAL_MS = 80
/** Bounded warm-up: sync at most this many sessions at plugin load. */
const WARMUP_SESSION_LIMIT = 24
/** Sidebar body shown while the host has not published a session yet. */
export const SIDEBAR_WAITING_LABEL = 'Aguardando sessão…'
/** Delegate-completion toast title. */
const TOAST_TITLE = 'Pantheon'
/** Marker before the preset label (fixed header, home status, prompt footer).
 *  `▸` U+25B8 is one cell; the previous bolt (U+26A1) carries
 *  Emoji_Presentation and is measured as two cells, which misaligned the line. */
export const PRESET_MARKER = '\u25B8'
/** Git ahead / behind arrows (U+2191 / U+2193), one cell each — the glyphs the
 *  reference sidebars use for `↑ahead ↓behind`. */
export const GIT_ARROW_UP = '\u2191'
export const GIT_ARROW_DOWN = '\u2193'
/** One event name the host publishes on `data.on` — the OpenCode V2 union. */
export type SidebarDataEvent = Parameters<Context['data']['on']>[0]
/** V2 events that refresh the sidebar. V1 also listened to `session.updated`,
 *  but that name is absent from the OpenCode V2 event union (verified against
 *  `@opencode/client`'s `OpenCodeEvent`), so the valid events that carry the
 *  same state changes are used instead: `session.renamed` /
 *  `session.metadata.updated` / `session.moved` (the mutations `session.updated`
 *  used to stand for) and `session.idle` (a child finishing). `satisfies` keeps
 *  the literals while making a name outside the union a type error (surfaced by
 *  `tsc -p tsconfig.build.json`), and the sidebar test asserts the same names
 *  against the installed union at runtime. */
export const SIDEBAR_REFRESH_EVENTS = [
  'session.created',
  'session.renamed',
  'session.metadata.updated',
  'session.moved',
  'session.idle',
  'session.status',
  'session.deleted',
] as const satisfies readonly SidebarDataEvent[]

/* ─── Active Preset Detection ──────────────────────────────
 * Inline replica of the V1 sidebar resolver (src/plugins/tui/src/index.tsx,
 * which itself mirrors src/pantheon/presets.mjs). The copied plugin ships only
 * dist/ + package.json, so it can reach neither module at runtime — the
 * resolution logic is mirrored here rather than imported.
 *
 * Priority: env PANTHEON_MODEL_PRESET > first existing candidate file > none.
 * Custom/unknown preset names are shown as-is. "none" disables → default. */

export type PresetInfo = { name: string | null; source: 'env' | 'file' | null }

/** One `overrides.agents[<agent>]` entry from active-preset.json. */
export type AgentModelOverride = { model?: string; variant?: string }
/** The override map the CLI wrote into active-preset.json. */
export type PresetOverrides = { agents: Record<string, AgentModelOverride> }
/** A preset plus the explicit overrides stored next to it. */
export type ActivePresetDetail = { info: PresetInfo; overrides: PresetOverrides }

function emptyOverrides(): PresetOverrides {
  return { agents: {} }
}

/** Keep only well-formed per-agent overrides: unknown keys are ignored and a
 *  non-string model/variant is dropped instead of leaking into the render. */
export function parsePresetOverrides(value: unknown): PresetOverrides {
  const overrides = emptyOverrides()
  if (!value || typeof value !== 'object') return overrides
  const agents = (value as { agents?: unknown }).agents
  if (!agents || typeof agents !== 'object') return overrides
  for (const [agent, entry] of Object.entries(agents as Record<string, unknown>)) {
    if (agent === '' || !entry || typeof entry !== 'object') continue
    const model = (entry as { model?: unknown }).model
    const variant = (entry as { variant?: unknown }).variant
    const override: AgentModelOverride = {}
    if (typeof model === 'string' && model !== '') override.model = model
    if (typeof variant === 'string' && variant !== '') override.variant = variant
    if (override.model !== undefined || override.variant !== undefined) {
      overrides.agents[agent] = override
    }
  }
  return overrides
}

/** Read .pantheon/active-preset.json — first existing candidate wins; malformed
 *  JSON or a `preset` that is missing, empty or "none" → null (no fall-through
 *  to lower candidates). The explicit per-agent overrides stored in the same
 *  file come along so the sidebar can mark them with `*`. */
async function readActivePresetDetail(cwd: string): Promise<ActivePresetDetail | null> {
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
  const candidates = [
    join(cwd, '.pantheon', 'active-preset.json'),
    join(xdgConfig, 'opencode', '.pantheon', 'active-preset.json'),
    join(homedir(), '.opencode', '.pantheon', 'active-preset.json'),
  ]
  for (const candidate of candidates) {
    let raw: string
    try {
      raw = await readFile(candidate, 'utf8')
    } catch {
      continue // candidate does not exist — try the next one
    }
    try {
      const parsed = JSON.parse(raw) as { preset?: unknown; overrides?: unknown }
      const name = parsed && typeof parsed === 'object' ? parsed.preset : undefined
      if (typeof name !== 'string' || name.length === 0 || name === 'none') return null
      return {
        info: { name, source: 'file' },
        overrides: parsePresetOverrides(parsed.overrides),
      }
    } catch {
      return null // malformed file — treat as default (mirrors presets.mjs)
    }
  }
  return null
}

/** Env leg of resolution: PANTHEON_MODEL_PRESET set and !== 'none' wins. */
export function presetFromEnv(env: Record<string, string | undefined>): PresetInfo {
  const name = env.PANTHEON_MODEL_PRESET
  if (name !== undefined && name !== '' && name !== 'none') {
    return { name, source: 'env' }
  }
  return { name: null, source: null }
}

/** Resolve the active preset plus its per-agent overrides: env > file > default.
 *  An env-selected preset has no file overrides by construction. */
export async function resolveActivePresetForTui(
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<ActivePresetDetail> {
  const envPreset = presetFromEnv(env)
  if (envPreset.source === 'env') return { info: envPreset, overrides: emptyOverrides() }
  return (
    (await readActivePresetDetail(cwd)) ?? {
      info: { name: null, source: null },
      overrides: emptyOverrides(),
    }
  )
}

/* ─── Session helpers ────────────────────────────────────── */

/** `SessionInfo.id` is always a `ses…` handle. Guarded so a placeholder or a
 *  foreign id never reaches the status/navigate APIs. */
export function isValidSessionID(id: unknown): id is string {
  return typeof id === 'string' && id.startsWith('ses')
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/* ─── Sidebar metrics ─────────────────────────────────────
 * The context gauge mirrors the host's own computation: the token total of the
 * last assistant message that carries `tokens`, measured after the most recent
 * compaction and before an active revert boundary, against the model's context
 * limit. Everything is pure so the arithmetic is testable without a renderer. */

/** Model reference shapes the host publishes: `ModelRef` objects, bare ids, or
 *  `provider/model` strings. Returns the id part, never throws. */
export function modelRefID(ref: unknown): string | null {
  if (typeof ref === 'string') return ref === '' ? null : ref
  if (ref && typeof ref === 'object') {
    const id = (ref as { id?: unknown }).id
    if (typeof id === 'string' && id !== '') return id
  }
  return null
}

/** Short display id: the segment after the last `/` (`opencode-go/kimi-k3` →
 *  `kimi-k3`), truncated so a long id never wraps the sidebar. */
export function shortModelID(ref: unknown, max = 24): string | null {
  const id = modelRefID(ref)
  if (id === null) return null
  const segment = id.slice(id.lastIndexOf('/') + 1)
  if (segment === '') return null
  return segment.length > max ? `${segment.slice(0, Math.max(1, max - 1))}…` : segment
}

/** `providerID` of a model reference, trimmed; null when absent/blank. Derived
 *  only from what the host already published — never a lookup table. */
export function providerIDFromRef(ref: unknown): string | null {
  if (ref === null || typeof ref !== 'object') return null
  const providerID = (ref as { providerID?: unknown }).providerID
  return typeof providerID === 'string' && providerID.trim() !== '' ? providerID.trim() : null
}

/** Provider for a bare-string model reference: match its id (or bare segment)
 *  in the host model list. Null when the list cannot answer. */
export function providerIDFromModels(models: unknown, ref: unknown): string | null {
  if (!Array.isArray(models)) return null
  const id = modelRefID(ref)
  if (id === null) return null
  const segment = id.slice(id.lastIndexOf('/') + 1)
  for (const model of models) {
    if (!model || typeof model !== 'object') continue
    const modelID = typeof model.modelID === 'string' ? model.modelID : ''
    const rowID = typeof model.id === 'string' ? model.id : ''
    if (modelID !== id && rowID !== id && modelID !== segment && rowID !== segment) continue
    const providerID = providerIDFromRef(model)
    if (providerID !== null) return providerID
  }
  return null
}

/** Resolve `model.limit.context` for a model reference. Match order: the
 *  provider-qualified id, then the bare id (the host's `id`/`modelID` fields).
 *  Absent/ambiguous models degrade to null so the gauge is simply omitted. */
export function resolveContextLimit(models: readonly any[], ref: unknown): number | null {
  const id = modelRefID(ref)
  if (id === null) return null
  const providerID =
    ref && typeof ref === 'object' ? (ref as { providerID?: unknown }).providerID : undefined
  const segment = id.slice(id.lastIndexOf('/') + 1)
  const matches = models.filter((model) => {
    if (!model || typeof model !== 'object') return false
    const modelID = typeof model.modelID === 'string' ? model.modelID : ''
    const rowID = typeof model.id === 'string' ? model.id : ''
    const idMatches = modelID === id || rowID === id || modelID === segment || rowID === segment
    if (!idMatches) return false
    if (typeof providerID !== 'string' || providerID === '') return true
    return model.providerID === providerID
  })
  const candidates =
    matches.length > 0
      ? matches
      : models.filter((model) => {
          const modelID = typeof model?.modelID === 'string' ? model.modelID : ''
          const rowID = typeof model?.id === 'string' ? model.id : ''
          return modelID === segment || rowID === segment
        })
  for (const model of candidates) {
    const limit = model?.limit?.context
    if (typeof limit === 'number' && Number.isFinite(limit) && limit > 0) return limit
  }
  return null
}

/** Native token total: input + output + reasoning + cache read + cache write. */
export function messageTokensTotal(tokens: any): number {
  const cacheRead = numberOrNull(tokens?.cache?.read) ?? 0
  const cacheWrite = numberOrNull(tokens?.cache?.write) ?? 0
  return (
    (numberOrNull(tokens?.input) ?? 0) +
    (numberOrNull(tokens?.output) ?? 0) +
    (numberOrNull(tokens?.reasoning) ?? 0) +
    cacheRead +
    cacheWrite
  )
}

export type ContextUsage = { tokens: number; percent: number; limit: number }

/** The part of a transcript that still counts: everything before the revert
 *  boundary (when a revert is active), then after the last compaction. Both
 *  derived numbers that read "the last assistant with usage" — the context
 *  gauge and the cache hit rate — share this window, so a reverted-away or
 *  compacted-away message can never feed either one. Pure. */
export function transcriptWindow(
  messages: readonly any[],
  revertMessageID?: string | null,
): { start: number; end: number } {
  let end = messages.length
  if (typeof revertMessageID === 'string' && revertMessageID !== '') {
    const boundary = messages.findIndex((message) => message?.id === revertMessageID)
    if (boundary >= 0) end = boundary
  }

  let start = 0
  for (let index = end - 1; index >= 0; index--) {
    if (messages[index]?.type === 'compaction') {
      start = index + 1
      break
    }
  }

  return { start, end }
}

/** Context usage for a message list. Scope: the live window (see
 *  `transcriptWindow`). The last assistant message carrying `tokens` in that
 *  window wins. Null when there is no limit or no such message — the caller
 *  then omits the block. */
export function computeContextUsage(
  messages: readonly any[],
  contextLimit: number | null | undefined,
  revertMessageID?: string | null,
): ContextUsage | null {
  const limit = numberOrNull(contextLimit)
  if (limit === null || limit <= 0) return null
  if (!Array.isArray(messages) || messages.length === 0) return null

  const { start, end } = transcriptWindow(messages, revertMessageID)

  for (let index = end - 1; index >= start; index--) {
    const message = messages[index]
    if (message?.type !== 'assistant' || !message.tokens) continue
    const tokens = messageTokensTotal(message.tokens)
    if (!Number.isFinite(tokens) || tokens <= 0) continue
    return { tokens, percent: Math.round((tokens / limit) * 100), limit }
  }
  return null
}

/** Semantic tone for a context percentage, inclusive at the top of each band:
 *  info (blue) up to 25%, success (green) up to 50%, warning (yellow) up to
 *  90%, error (red) above it. Four explicit stages, each backed by a feedback
 *  token, so the gauge follows the active theme. Pure. */
export function contextUsageTone(percent: number): ContextProgressTone {
  if (percent > 90) return 'error'
  if (percent > 50) return 'warning'
  if (percent > 25) return 'success'
  return 'info'
}

/** The gauge's four stages, one per theme feedback token. */
export type ContextProgressTone = 'info' | 'success' | 'warning' | 'error'

/** Color for one gauge stage. Filled cells and the percent value both come from
 *  this one call, so the bar and its number can never disagree. `theme` is the
 *  host's resolved theme (loosely typed at runtime); a missing token falls back
 *  to the theme's base text instead of an unstyled cell. Pure. */
export function contextProgressColor(stage: ContextProgressTone, theme: any): any {
  return theme?.text?.feedback?.[stage]?.base ?? theme?.text?.base
}

/** The muted extra line under the gauge: `cache 92% · 42.3 tok/s`. Either half
 *  may be missing (no cache read, no measurable turn); no data at all yields
 *  null so no empty line is rendered. The speed keeps the host's own one
 *  decimal and `tok/s` label. Pure. */
export function contextPerformanceLine(
  performance: ContextPerformance | null | undefined,
): string | null {
  if (!performance) return null
  const parts: string[] = []
  const cacheHit = numberOrNull(performance.cacheHit)
  if (cacheHit !== null) parts.push(`cache ${Math.round(cacheHit)}%`)
  const tokensPerSecond = numberOrNull(performance.tokensPerSecond)
  if (tokensPerSecond !== null) parts.push(`${tokensPerSecond.toFixed(1)} tok/s`)
  return parts.length === 0 ? null : parts.join(SPEND_LINE_SEPARATOR)
}

/** Cache hit rate of one message: `cache.read / (input + cache.read)` as a
 *  percentage. The denominator must be > 0, otherwise the ratio is meaningless
 *  (a message that only wrote to the cache has no input to hit). Null when the
 *  numbers are absent. Pure. */
export function cacheHitPercent(tokens: any): number | null {
  const read = numberOrNull(tokens?.cache?.read)
  const input = numberOrNull(tokens?.input)
  if (read === null || input === null) return null
  const denominator = input + read
  if (!(denominator > 0)) return null
  return (read / denominator) * 100
}

/** The message the cache hit rate comes from: the last assistant of the live
 *  window (see `transcriptWindow`) that actually carries `tokens`. Later
 *  messages without usage — a streaming placeholder that the host publishes
 *  before any step completes, a step that reports no usage — are skipped
 *  instead of blanking a ratio the previous message already measured. Null
 *  when nothing in the window has usage. Pure. */
export function lastAssistantWithTokens(
  messages: readonly any[] | null | undefined,
  revertMessageID?: string | null,
): any | null {
  if (!Array.isArray(messages) || messages.length === 0) return null
  const { start, end } = transcriptWindow(messages, revertMessageID)
  for (let index = end - 1; index >= start; index--) {
    const message = messages[index]
    if (message?.type !== 'assistant' || !message.tokens) continue
    return message
  }
  return null
}

/** Tokens per second of the current turn. Mirrors the host's
 *  `turnTokensPerSecond` (anomalyco/opencode v2.0.30,
 *  `packages/tui/src/routes/session/rows.ts`) so the sidebar and the native
 *  session footer can never disagree: the numerator is `output + reasoning`
 *  summed over every assistant step of the turn and the denominator is the
 *  summed active streaming time `max(0, time.streamed - time.created)`, so the
 *  division happens once, after aggregating — each step weighs by its own
 *  duration instead of each step voting equally. `completed` is never used; a
 *  turn with a step that has no `time.streamed` has no measurable speed. The
 *  turn starts after the last `user` message; with no user message only the
 *  last assistant step counts (degraded: there is no boundary to group by).
 *  Pure and fail-open. */
export function turnTokensPerSecond(
  messages: readonly any[] | null | undefined,
  position?: number | null,
): number | null {
  if (!Array.isArray(messages) || messages.length === 0) return null
  let anchor = -1
  if (
    typeof position === 'number' &&
    Number.isInteger(position) &&
    position >= 0 &&
    position < messages.length
  ) {
    anchor = position
  } else {
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.type === 'assistant') {
        anchor = index
        break
      }
    }
  }
  if (anchor === -1 || messages[anchor]?.type !== 'assistant') return null

  let start = -1
  for (let index = anchor - 1; index >= 0; index--) {
    if (messages[index]?.type === 'user') {
      start = index
      break
    }
  }
  const steps =
    start === -1
      ? [messages[anchor]]
      : messages.slice(start + 1, anchor + 1).filter((item) => item?.type === 'assistant')
  if (steps.length === 0) return null

  let output = 0
  let duration = 0
  for (const step of steps) {
    output +=
      (numberOrNull(step?.tokens?.output) ?? 0) + (numberOrNull(step?.tokens?.reasoning) ?? 0)
    const created = numberOrNull(step?.time?.created)
    const streamed = numberOrNull(step?.time?.streamed)
    if (created === null || streamed === null) return null
    duration += Math.max(0, streamed - created)
  }
  if (output <= 0 || duration <= 0) return null
  const rate = output / (duration / 1_000)
  return Number.isFinite(rate) && rate > 0 ? rate : null
}

/** Last-message telemetry the Context block renders in muted text. Both halves
 *  are optional; the block renders no line when neither is available. */
export type ContextPerformance = { cacheHit: number | null; tokensPerSecond: number | null }

/** Thousands-separated token total: `55320` → `55,320` (en-US, matching the
 *  native block this one replaces). Null for a missing/invalid value. Pure. */
export function formatTokenCount(tokens: number | null | undefined): string | null {
  const value = numberOrNull(tokens)
  if (value === null || value < 0) return null
  return Math.round(value).toLocaleString('en-US')
}

/** Context-window label: `1_000_000` → `1.0M`, `200_000` → `200K`,
 *  `128_000` → `128K`, `32_768` → `32K`. Sub-million limits truncate to whole K
 *  so the printed window never overstates the model's capacity. Pure. */
export function formatContextWindow(limit: number | null | undefined): string | null {
  const value = numberOrNull(limit)
  if (value === null || value <= 0) return null
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
  if (value >= 1_000) return `${Math.floor(value / 1_000)}K`
  return `${Math.floor(value)}`
}

/** Cells in the Context gauge: always rendered in full, so the bar never
 *  changes width between refreshes. With the space, the percent and the
 *  `of <window>` tail (at most 9 columns) the line stays inside 34 columns. */
export const CONTEXT_BAR_CELLS = 12
/** Filled cell (U+25B0) and empty cell (U+25B1), both single-width. */
export const CONTEXT_BAR_FILLED_CELL = '\u25B0'
export const CONTEXT_BAR_EMPTY_CELL = '\u25B1'

/** Filled cells for a percentage: rounded, clamped to `0..cells`, so 0% is an
 *  empty bar and anything at or above 100% is a full one. Pure. */
export function contextBarFilled(percent: number, cells = CONTEXT_BAR_CELLS): number {
  const total = Math.max(1, Math.floor(cells))
  const filled = Math.round((percent / 100) * total)
  if (!Number.isFinite(filled)) return 0
  return Math.min(total, Math.max(0, filled))
}

/** The gauge split into its toned half (filled cells) and its muted half (empty
 *  cells), so the caller colors each side. Null when the percentage is missing:
 *  the Context block then keeps its tokens + cost rows and renders no bar. Pure. */
export function contextBar(
  percent: number | null | undefined,
  cells = CONTEXT_BAR_CELLS,
): { filled: string; empty: string } | null {
  const value = numberOrNull(percent)
  if (value === null) return null
  const total = Math.max(1, Math.floor(cells))
  const filled = contextBarFilled(value, total)
  return {
    filled: CONTEXT_BAR_FILLED_CELL.repeat(filled),
    empty: CONTEXT_BAR_EMPTY_CELL.repeat(total - filled),
  }
}

/** USD spent with two decimals (`$0.18`), the native block's format. Null for
 *  a missing/negative value. Pure. */
export function formatSpent(cost: number | null | undefined): string | null {
  const value = numberOrNull(cost)
  if (value === null || value < 0) return null
  return `$${value.toFixed(2)}`
}

/** One rendered context row. `lead` and `tail` carry the gauge bar when the row
 *  has one (`lead` is toned with the value, `tail` is muted), so the 12 cells
 *  stay contiguous while the empty half still reads as background. */
export type ContextRow = {
  lead: string | null
  value: string
  tail: string | null
  suffix: string | null
  tone: ContextProgressTone | null
}

/** The `Context` block's data rows; null rows are not rendered. */
export type ContextBlockRows = {
  tokens: ContextRow | null
  percent: ContextRow | null
  spent: ContextRow | null
}

/** Rows for the `Context` block:
 *  `<tokens> tokens` / `▰▰▰▰▰▱▱▱▱▱▱▱ <percent>% of <window>` /
 *  `$<spent> spent`. The percentage row carries the only semantic tone, the
 *  gauge bar (12 cells) and is omitted entirely when the percentage is
 *  unavailable (never `undefined%`). A block with neither tokens nor cost
 *  yields null. Pure. */
export function contextBlockRows(
  usage: ContextUsage | null,
  cost: number | null | undefined,
): ContextBlockRows | null {
  const spentValue = formatSpent(cost)
  const spent: ContextRow | null =
    spentValue === null
      ? null
      : { lead: null, value: spentValue, tail: null, suffix: ' spent', tone: null }
  if (usage === null) return spent === null ? null : { tokens: null, percent: null, spent }

  const tokensValue = formatTokenCount(usage.tokens)
  const tokens: ContextRow | null =
    tokensValue === null
      ? null
      : { lead: null, value: tokensValue, tail: null, suffix: ' tokens', tone: null }

  const percentValue = numberOrNull(usage.percent)
  const window = formatContextWindow(usage.limit)
  const bar = contextBar(percentValue)
  const percent: ContextRow | null =
    bar === null || percentValue === null
      ? null
      : {
          lead: bar.filled,
          value: ` ${Math.round(percentValue)}%`,
          tail: bar.empty,
          suffix: window === null ? null : ` of ${window}`,
          tone: contextUsageTone(percentValue),
        }

  if (tokens === null && percent === null && spent === null) return null
  return { tokens, percent, spent }
}

/* ─── Per-model real usage ────────────────────────────────
 * `SessionMessageAssistant` carries the real `model` (`ModelRef`), an optional
 * `cost` (`MoneyUSD` = number) and optional `tokens`, so the sidebar can show
 * what each model actually cost instead of estimating from pricing tables.
 * Everything below is pure so the aggregation is testable without a renderer;
 * a message without `cost` contributes 0 and is omitted (never a guessed
 * price). */

/** Models rendered in the Context block before the aggregate `… +N` line. */
export const MODEL_USAGE_VISIBLE_CEILING = 3
/** Newest messages read per session — bounds the O(n) walk on long sessions. */
export const MODEL_USAGE_MESSAGE_LIMIT = 400
/** Sessions read per family (root + delegations) for the aggregate. */
export const MODEL_USAGE_SESSION_LIMIT = 8
/** Column widths for one model row (labels are muted, numbers right-aligned). */
export const MODEL_USAGE_MODEL_WIDTH = 12
export const MODEL_USAGE_TOKEN_WIDTH = 6
export const MODEL_USAGE_COST_WIDTH = 8
/** Session events arrive in bursts; model rows are recomputed at most once
 *  per window (same cadence as the git-count revalidation). */
export const MODEL_USAGE_DEBOUNCE_MS = 400

/** Real usage for one model, summed across the assistant messages that used it. */
export type ModelUsage = { model: string; tokens: number; cost: number }

/** Totals per model from assistant messages: sums `cost` and `tokens`, drops
 *  models whose real cost is 0/absent, and orders by cost (then tokens, then
 *  name). `providerID` participates in the key so two providers exposing the
 *  same bare id are not merged. Pure. */
export function collectModelUsage(messages: readonly any[]): ModelUsage[] {
  if (!Array.isArray(messages)) return []
  const totals = new Map<string, ModelUsage>()
  for (const message of messages) {
    if (message?.type !== 'assistant') continue
    const id = modelRefID(message.model)
    const model = shortModelID(message.model, MODEL_USAGE_MODEL_WIDTH)
    if (id === null || model === null) continue
    const providerID = typeof message.model?.providerID === 'string' ? message.model.providerID : ''
    const key = `${providerID}\u0000${id}`
    const tokenCount = message.tokens ? messageTokensTotal(message.tokens) : 0
    const cost = numberOrNull(message.cost) ?? 0
    const current = totals.get(key)
    if (current) {
      current.tokens += Math.max(0, tokenCount)
      current.cost += Math.max(0, cost)
    } else {
      totals.set(key, { model, tokens: Math.max(0, tokenCount), cost: Math.max(0, cost) })
    }
  }
  return [...totals.values()]
    .filter((row) => row.cost > 0)
    .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.model.localeCompare(b.model))
}

/** Visible rows plus the aggregate of the models that did not fit. Pure. */
export type ModelUsageCeiling = {
  visible: ModelUsage[]
  hidden: number
  hiddenCost: number
  hiddenTokens: number
}

/** Cap the model list at `maxVisible`; the rest is aggregated (still real
 *  totals) for the `… +N` line. Pure. */
export function ceilingModelUsage(
  rows: readonly ModelUsage[],
  maxVisible = MODEL_USAGE_VISIBLE_CEILING,
): ModelUsageCeiling {
  const limit = Math.max(0, maxVisible)
  const visible = rows.slice(0, limit)
  const rest = rows.slice(visible.length)
  return {
    visible,
    hidden: rest.length,
    hiddenCost: rest.reduce((sum, row) => sum + row.cost, 0),
    hiddenTokens: rest.reduce((sum, row) => sum + row.tokens, 0),
  }
}

/** Compact tokens for a model row (`80,000` → `80K`); `0` stays explicit. Pure. */
export function formatUsageTokens(tokens: number | null | undefined): string {
  const value = numberOrNull(tokens)
  if (value === null || value <= 0) return '0'
  return formatContextWindow(value) ?? String(Math.round(value))
}

/** Real per-model cost with adaptive precision: cents for `>= $0.01`, up to
 *  four decimals below that (a real `$0.0031` must not render as `$0.00`), and
 *  an explicit `< $0.0001` for the remainder. Pure. */
export function formatUsageCost(cost: number | null | undefined): string | null {
  const value = numberOrNull(cost)
  if (value === null || value < 0) return null
  if (value === 0) return '$0.00'
  if (value >= 0.01) return `$${value.toFixed(2)}`
  if (value >= 0.0001) {
    const fixed = value.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')
    return `$${fixed}`
  }
  return '<$0.0001'
}

/** One formatted model row: truncated label + compact tokens + real cost. */
export type ModelUsageRow = { model: string; tokens: string; cost: string }

/** Format the visible model rows for rendering. Labels are already short ids
 *  (12 chars); the second truncation only guards host drift. Pure. */
export function modelUsageRows(rows: readonly ModelUsage[]): ModelUsageRow[] {
  return rows.map((row) => ({
    model: truncateLabel(row.model, MODEL_USAGE_MODEL_WIDTH),
    tokens: formatUsageTokens(row.tokens),
    cost: formatUsageCost(row.cost) ?? '$0.00',
  }))
}

/** Exact single-line text of a model row, with numbers right-aligned. Pure. */
export function modelUsageRowText(row: ModelUsageRow): string {
  return `${row.model.padEnd(MODEL_USAGE_MODEL_WIDTH)}  ${row.tokens.padStart(MODEL_USAGE_TOKEN_WIDTH)}  ${row.cost.padStart(MODEL_USAGE_COST_WIDTH)}`
}

/** Muted aggregate line for the models beyond the cap (`… +2  $0.03`). Null
 *  when every model fits. Pure. */
export function hiddenModelUsageText(hidden: number, hiddenCost: number): string | null {
  if (!Number.isFinite(hidden) || hidden <= 0) return null
  const cost = formatUsageCost(hiddenCost)
  return cost === null ? `… +${hidden}` : `… +${hidden}  ${cost}`
}

/* ─── Child agent bucket ──────────────────────────────────
 * `SessionInfo.agent` is the host's per-session agent id, so the `Dispatch`
 * block groups the delegation tree by that field alone — no extra request, no
 * price table, and no per-message refinement: the aggregate is a count plus the
 * summed child cost, which is the only thing the short sidebar can afford. */

/** Bucket for a session the host published without an agent id. */
export const UNKNOWN_AGENT = '?'

/** Agent key of a session or message: the trimmed id when it is a non-empty
 *  string, else the `?` bucket — never `undefined`. Pure. */
export function agentKey(value: unknown): string {
  if (typeof value !== 'string') return UNKNOWN_AGENT
  const text = value.trim()
  return text === '' ? UNKNOWN_AGENT : text
}

/* ─── Todo block ──────────────────────────────────────────
 * The host exposes no todo API: the installed client has no
 * `session.todo`/`client.session.todo` and the V2 event union carries no
 * `todo.updated`. The authoritative source is the transcript — the
 * `todowrite` tool part (`SessionMessageAssistantTool`) stores the whole list
 * in `state.input.todos`, and the tool is a full replace (delete + insert), so
 * the newest *completed* write is the current list. Deriving it from the
 * transcript (never from a local write history) also makes a session revert
 * correct for free: the reverted-away write is simply not in `message.list`
 * anymore. Everything below is pure and fail-open. */

export type TodoStatus = 'in_progress' | 'pending' | 'completed' | 'cancelled'

/** One rendered todo row. `priority` is carried by the tool but not rendered:
 *  the reference block uses a single marker column. */
export type TodoItem = { content: string; status: TodoStatus }

/** Rows rendered before the `… +N` line. */
export const TODO_VISIBLE_CEILING = 6
/** Content width before the ellipsis — the block has ~30-34 usable columns. */
export const TODO_TEXT_WIDTH = 28

/** Row markers (`•` in progress, `−` cancelled with U+2212, as in the git row). */
const TODO_MARKERS: Record<TodoStatus, string> = {
  in_progress: '[\u2022]',
  pending: '[ ]',
  completed: '[x]',
  cancelled: '[\u2212]',
}

/** Group order: live work first, then open, then closed. */
const TODO_STATUS_ORDER: readonly TodoStatus[] = [
  'in_progress',
  'pending',
  'completed',
  'cancelled',
]

/** Narrow a loose `status` value to the tool's four states. */
export function isTodoStatus(value: unknown): value is TodoStatus {
  return (
    value === 'in_progress' || value === 'pending' || value === 'completed' || value === 'cancelled'
  )
}

/** Items from a `todowrite` `input` payload. A missing/malformed `input`,
 *  absent `todos`, an unknown `status` or an empty/missing `content` drops the
 *  entry instead of throwing; a list with nothing readable yields `[]`. Pure. */
export function parseTodoItems(input: unknown): TodoItem[] {
  const raw = (input as { todos?: unknown } | null | undefined)?.todos
  if (!Array.isArray(raw)) return []
  const items: TodoItem[] = []
  for (const entry of raw) {
    const content = (entry as { content?: unknown } | null | undefined)?.content
    const status = (entry as { status?: unknown } | null | undefined)?.status
    if (typeof content !== 'string' || content.trim() === '') continue
    if (!isTodoStatus(status)) continue
    items.push({ content: content.trim(), status })
  }
  return items
}

/** Newest completed `todowrite` in a transcript. The tool replaces the list
 *  wholesale, so the last write wins; a write with `todos: []` returns null
 *  (the block disappears rather than showing the previous list) and a
 *  not-yet-completed write is ignored. Null when the transcript carries no
 *  such part, so the block never renders a guess. Pure. */
export function latestTodoItems(messages: readonly any[] | null | undefined): TodoItem[] | null {
  if (!Array.isArray(messages)) return null
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.type !== 'assistant' || !Array.isArray(message.content)) continue
    const parts = message.content
    for (let position = parts.length - 1; position >= 0; position--) {
      const part = parts[position]
      if (part?.type !== 'tool' || part?.name !== 'todowrite') continue
      if (part?.state?.status !== 'completed') continue
      const items = parseTodoItems(part.state.input)
      return items.length === 0 ? null : items
    }
  }
  return null
}

/** Stable group order (in_progress → pending → completed → cancelled); within a
 *  group the transcript order is preserved. Pure. */
export function orderTodoItems(items: readonly TodoItem[]): TodoItem[] {
  return [...items].sort(
    (a, b) => TODO_STATUS_ORDER.indexOf(a.status) - TODO_STATUS_ORDER.indexOf(b.status),
  )
}

/** Row color channel: `accent` for live work, `muted` for closed items, base
 *  for pending. Kept separate from the theme so it is testable. Pure. */
export type TodoTone = 'accent' | 'muted' | 'base'

/** Tone for one status — no rainbow, a single accent. Pure. */
export function todoTone(status: TodoStatus): TodoTone {
  if (status === 'in_progress') return 'accent'
  if (status === 'completed' || status === 'cancelled') return 'muted'
  return 'base'
}

/** Exact rendered text of one row: `[•] <content truncated to 28>`. Pure. */
export function todoRowText(item: TodoItem): string {
  return `${TODO_MARKERS[item.status]} ${truncateLabel(item.content, TODO_TEXT_WIDTH)}`
}

/** Ordered rows capped for the sidebar, plus how many did not fit. Pure. */
export type TodoCeiling = { visible: TodoItem[]; hidden: number }

/** Order then cap the list at `maxVisible`. Pure. */
export function ceilingTodoItems(
  items: readonly TodoItem[],
  maxVisible = TODO_VISIBLE_CEILING,
): TodoCeiling {
  const ordered = orderTodoItems(items)
  const visible = ordered.slice(0, Math.max(0, maxVisible))
  return { visible, hidden: Math.max(0, ordered.length - visible.length) }
}

/** Overflow line (`… +3`); null when every item fits. Pure. */
export function hiddenTodoText(hidden: number): string | null {
  if (!Number.isFinite(hidden) || hidden <= 0) return null
  return `… +${Math.round(hidden)}`
}

/* ─── Git change counts ───────────────────────────────────
 * Two sources, in order of authority:
 *   1. the git CLI (`git status --porcelain=v1 -uall` + `git rev-list
 *      --count --left-right @{upstream}...HEAD`), which is the only way to see
 *      untracked files and ahead/behind — the HTTP protocol exposes neither;
 *   2. `client.vcs.status()` (`GET /api/vcs/status`), one `VcsFileStatus` per
 *      changed file: `{ file, additions, deletions, status }` with `status` in
 *      `"added" | "modified" | "deleted"`. Used only when the CLI fails, and it
 *      counts files per status — never lines.
 * Both are fail-open: no git or no API degrades to the branch-only row. */

export type GitChangeCounts = { added: number; modified: number; deleted: number }

/** Narrow a `VcsFileStatus["status"]` value read off a loose payload. */
function isGitChangeStatus(value: unknown): value is keyof GitChangeCounts {
  return value === 'added' || value === 'modified' || value === 'deleted'
}

/** Files per status from a `VcsFileStatus[]` payload. Unknown statuses and
 *  malformed entries are ignored. Pure. */
export function countGitChanges(files: readonly any[] | null | undefined): GitChangeCounts {
  const counts: GitChangeCounts = { added: 0, modified: 0, deleted: 0 }
  if (!Array.isArray(files)) return counts
  for (const entry of files) {
    const status: unknown = entry?.status
    if (isGitChangeStatus(status)) counts[status] += 1
  }
  return counts
}

/** `+1 ±2 −3` for the file counts; each zero term is omitted, and an empty
 *  change set returns null so the row is not rendered at all. Pure. */
export function formatGitChanges(files: readonly any[] | null | undefined): string | null {
  const { added, modified, deleted } = countGitChanges(files)
  const parts: string[] = []
  if (added > 0) parts.push(`+${added}`)
  if (modified > 0) parts.push(`±${modified}`)
  if (deleted > 0) parts.push(`\u2212${deleted}`)
  return parts.length === 0 ? null : parts.join(' ')
}

/* ─── Git CLI (untracked / ahead / behind) ────────────────
 * Run with an async `execFile` — never `execSync`, which would block the TUI's
 * render loop — bounded by a timeout and with `windowsHide` so a Windows host
 * does not flash a console window. One probe is two short git calls; the
 * sidebar revalidates on mount and on the session events it already
 * subscribes to, behind a debounce and a cooldown (see the constants), and
 * skips a revalidation entirely while one is still running — there is no queue
 * and no polling timer. */

/** Wall-clock ceiling for one git call. A stuck git (index lock, network
 *  filesystem) is killed instead of holding the row forever. */
export const GIT_CLI_TIMEOUT_MS = 2_000
/** Session events arrive in bursts; a git probe is scheduled at most once per
 *  window instead of once per event. */
export const GIT_CLI_DEBOUNCE_MS = 1_000
/** Minimum spacing between two probe starts. Five seconds keeps a chatty event
 *  stream from spawning a git process per step while staying fresh enough to
 *  show a file appearing mid-turn. */
export const GIT_CLI_MIN_INTERVAL_MS = 5_000
/** Stdout ceiling for one git call. `status --porcelain=v1 -uall` lists every
 *  untracked file, so a large worktree easily passes the 1 MB `execFile`
 *  default — which would reject and silently hand the row back to the
 *  `vcs.status` fallback. 4 MB is far above a realistic porcelain listing. */
export const GIT_CLI_MAX_BUFFER = 4 * 1024 * 1024

/** One `execFile` call: `(file, args, options) → { stdout }`. Injectable so the
 *  parsing/gating logic is testable without spawning processes. */
export type GitExec = (
  file: string,
  args: readonly string[],
  options: { cwd: string; timeout: number; windowsHide: boolean; maxBuffer: number },
) => Promise<{ stdout: string }>

/** Default runner: the promisified `node:child_process.execFile`. A non-zero
 *  exit (no repository, no upstream) rejects and the caller decides. */
export const defaultGitExec: GitExec = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        cwd: options.cwd,
        timeout: options.timeout,
        windowsHide: options.windowsHide,
        maxBuffer: options.maxBuffer,
      },
      (error, stdout) => {
        if (error) reject(error)
        else resolve({ stdout: typeof stdout === 'string' ? stdout : String(stdout ?? '') })
      },
    )
  })

/** Files per status from `git status --porcelain=v1 -uall`, including the two
 *  columns the protocol cannot report. Each line starts with `XY` (index and
 *  worktree state); a rename prints `R  old -> new`, and `??` / `!!` are
 *  untracked / ignored. Precedence per file: deleted > added > modified, so
 *  `AM` counts once as added and `AD` once as deleted. Renames, copies and
 *  unmerged entries count as modified. Pure. */
export type GitPorcelainCounts = {
  added: number
  modified: number
  deleted: number
  untracked: number
}

/** Parse porcelain v1 output into file counts. Empty/malformed output yields
 *  zero counts (a clean tree), never a throw. Pure. */
export function parseGitStatusPorcelain(output: string | null | undefined): GitPorcelainCounts {
  const counts: GitPorcelainCounts = { added: 0, modified: 0, deleted: 0, untracked: 0 }
  if (typeof output !== 'string' || output === '') return counts
  for (const line of output.split('\n')) {
    if (line.length < 2) continue
    const index = line[0]
    const worktree = line[1]
    if (index === '!' && worktree === '!') continue // ignored file
    if (index === '?' && worktree === '?') {
      counts.untracked += 1
      continue
    }
    if (index === ' ' && worktree === ' ') continue
    if (index === 'D' || worktree === 'D') counts.deleted += 1
    else if (index === 'A' || worktree === 'A') counts.added += 1
    else counts.modified += 1
  }
  return counts
}

/** `git rev-list --count --left-right @{upstream}...HEAD` prints two numbers:
 *  commits only on the upstream (behind) then commits only on HEAD (ahead).
 *  Null when the output is not that pair — e.g. the command failed because the
 *  branch has no upstream, in which case the arrows are simply omitted. Pure. */
export function parseGitAheadBehind(
  output: string | null | undefined,
): { ahead: number; behind: number } | null {
  if (typeof output !== 'string') return null
  const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(output)
  if (match === null) return null
  const behind = Number(match[1])
  const ahead = Number(match[2])
  if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return null
  return { ahead, behind }
}

/** One git observation: file counts plus the upstream distance (either arrow
 *  may be unknown when the branch has no upstream). */
export type GitCliSnapshot = {
  changes: GitPorcelainCounts
  ahead: number | null
  behind: number | null
}

/** One probe: `git status --porcelain=v1 -uall` for the counts, then
 *  `git rev-list --count --left-right @{upstream}...HEAD` for the arrows (a
 *  failure there only drops the arrows). A status failure rejects — the caller
 *  then falls back to `client.vcs.status`. */
export async function readGitSnapshot(
  directory: string,
  exec: GitExec = defaultGitExec,
): Promise<GitCliSnapshot> {
  const options = {
    cwd: directory,
    timeout: GIT_CLI_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: GIT_CLI_MAX_BUFFER,
  }
  const status = await exec('git', ['status', '--porcelain=v1', '-uall'], options)
  const changes = parseGitStatusPorcelain(status?.stdout)
  let ahead: number | null = null
  let behind: number | null = null
  try {
    const counts = await exec(
      'git',
      ['rev-list', '--count', '--left-right', '@{upstream}...HEAD'],
      options,
    )
    const parsed = parseGitAheadBehind(counts?.stdout)
    if (parsed !== null) {
      ahead = parsed.ahead
      behind = parsed.behind
    }
  } catch {
    /* no upstream configured — the arrows are omitted, the counts still show */
  }
  return { changes, ahead, behind }
}

/** Rendered git row: `+1 ±2 −1 ?2 ↑3 ↓1`, zero terms omitted. Null when the
 *  tree is clean and in sync, so the block keeps only its branch line. Pure. */
export function formatGitSnapshot(snapshot: GitCliSnapshot | null | undefined): string | null {
  if (!snapshot?.changes) return null
  const { added, modified, deleted, untracked } = snapshot.changes
  const parts: string[] = []
  if (added > 0) parts.push(`+${added}`)
  if (modified > 0) parts.push(`±${modified}`)
  if (deleted > 0) parts.push(`\u2212${deleted}`)
  if (untracked > 0) parts.push(`?${untracked}`)
  if ((snapshot.ahead ?? 0) > 0) parts.push(`${GIT_ARROW_UP}${snapshot.ahead}`)
  if ((snapshot.behind ?? 0) > 0) parts.push(`${GIT_ARROW_DOWN}${snapshot.behind}`)
  return parts.length === 0 ? null : parts.join(' ')
}

/** Whether a new probe may start. An in-flight probe always wins (no queue), and
 *  the previous start must be older than the cooldown. Pure. */
export function gitProbeAllowed(
  state: { now: number; lastRunAt: number | null; inFlight: boolean },
  cooldownMs = GIT_CLI_MIN_INTERVAL_MS,
): boolean {
  if (state.inFlight) return false
  if (state.lastRunAt === null) return true
  const elapsed = state.now - state.lastRunAt
  return !Number.isFinite(elapsed) || elapsed >= cooldownMs
}

/* ─── Spend (local server stats) ─────────────────────────
 * `client.session.stats()` → `GET /api/experimental/session/stats` is the only
 * source: it is served by the local OpenCode process that is already running,
 * so the numbers are pure spend — no provider call, no credential read, no
 * polling, and no plan limit (the protocol exposes no quota/balance field).
 * The route is experimental: any failure leaves the values unknown and
 * preserves whatever was last known. */

/** Spend window labels, in render order. */
export const SPEND_TODAY_LABEL = 'hoje'
export const SPEND_30D_LABEL = '30d'
/** Separator between the two windows on the Context footer line. */
export const SPEND_LINE_SEPARATOR = ' \u00B7 '
/** `30d` window: 30 × 24 h, measured back from "now". */
export const SPEND_30D_MS = 30 * 24 * 60 * 60 * 1000
/** Probe window: one hour, narrow enough that a unit mix-up cannot line up. */
export const SPEND_PROBE_WINDOW_MS = 60 * 60 * 1000
/** The echoed `range` may be rounded server-side; 120 s absorbs that. */
export const SPEND_PROBE_TOLERANCE_MS = 120_000
/** Session events arrive in bursts — same 400 ms window as the other blocks. */
export const SPEND_REFRESH_DEBOUNCE_MS = 400

/** Spend per window in USD. Either side may be unknown (kept `null`). */
export type SpendTotals = { today: number | null; thirtyDays: number | null }

/** `from`/`to` unit accepted by the route. `SessionStatsInput` declares both as
 *  bare `number` and does not say which unit, so it is measured once per
 *  process (`ms` unless the server echoes seconds) instead of guessed. */
type SpendUnit = 'ms' | 's' | 'unavailable'

/** Resolved unit for this process; `null` until the mount probe answers. */
let spendUnit: SpendUnit | null = null
/** In-flight probe, so two refreshes cannot each burn the 2-call budget. */
let spendProbe: Promise<SpendUnit> | null = null

/** Test-only: forget the process-wide unit resolution. Never called at runtime. */
export function resetSpendUnit(): void {
  spendUnit = null
  spendProbe = null
}

/** Resolved unit (`ms` / `s` / `unavailable`) or null while still unknown. */
export function resolvedSpendUnit(): SpendUnit | null {
  return spendUnit
}

/** Local midnight for `now`: `new Date()` with the clock fields zeroed in the
 *  current timezone (DST-safe, unlike subtracting hours). Pure. */
export function startOfLocalDay(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** The two windows the block shows: `hoje` (local midnight → now) and `30d`
 *  (now − 30 days → now). Pure. */
export function spendWindows(now: number): {
  today: { from: number; to: number }
  thirtyDays: { from: number; to: number }
} {
  return {
    today: { from: startOfLocalDay(now), to: now },
    thirtyDays: { from: now - SPEND_30D_MS, to: now },
  }
}

/** USD with two decimals (`$0.42`), four for a positive sub-cent amount
 *  (`$0.0031`), and `<$0.0001` when even four decimals would read `$0.0000`.
 *  `0` prints `$0.00`. Null for a missing/negative/non-finite value. Pure. */
export function formatSpendUSD(cost: number | null | undefined): string | null {
  const value = numberOrNull(cost)
  if (value === null || value < 0) return null
  if (value === 0) return '$0.00'
  if (value >= 0.01) return `$${value.toFixed(2)}`
  const cents = value.toFixed(2)
  if (cents !== '0.00') return `$${cents}`
  const cents4 = value.toFixed(4)
  return cents4 === '0.0000' ? '<$0.0001' : `$${cents4}`
}

/** `cost` off a `SessionStatsInfo` (`MoneyUSD` = number) or null when the
 *  payload is malformed/negative, so a bad value never reaches a row. Pure. */
export function statsCost(result: unknown): number | null {
  const cost = numberOrNull((result as { cost?: unknown } | null | undefined)?.cost)
  return cost !== null && cost >= 0 ? cost : null
}

/** True when the server echoed the window we sent, within 120 s. `scale` is how
 *  many milliseconds one unit of the sent window is worth (`1` for `ms`, `1000`
 *  for `s`). The echo is accepted either as the same numbers we sent (the route
 *  keeps the caller's unit) or converted to millisecond epoch (`DateTime.Utc`),
 *  so the probe pins the unit without assuming which of the two it gets. Pure. */
export function statsRangeMatches(
  range: unknown,
  sent: { from: number; to: number },
  scale: number,
): boolean {
  const from = numberOrNull((range as { from?: unknown } | null | undefined)?.from)
  const to = numberOrNull((range as { to?: unknown } | null | undefined)?.to)
  if (from === null || to === null) return false
  const tolerance = SPEND_PROBE_TOLERANCE_MS / scale
  const sameUnit = Math.abs(from - sent.from) <= tolerance && Math.abs(to - sent.to) <= tolerance
  const asMilliseconds =
    Math.abs(from - sent.from * scale) <= SPEND_PROBE_TOLERANCE_MS &&
    Math.abs(to - sent.to * scale) <= SPEND_PROBE_TOLERANCE_MS
  return sameUnit || asMilliseconds
}

/** The `Context` block's last line: both spend windows on one muted row
 *  (`hoje $0.42 · 30d $9.80`). A window without a usable amount is omitted, and
 *  no usable window at all yields null so the line (and not the block) is
 *  dropped. Pure. */
export function contextSpendLine(totals: SpendTotals | null): string | null {
  if (totals === null) return null
  const parts: string[] = []
  const today = formatSpendUSD(totals.today)
  if (today !== null) parts.push(`${SPEND_TODAY_LABEL} ${today}`)
  const thirtyDays = formatSpendUSD(totals.thirtyDays)
  if (thirtyDays !== null) parts.push(`${SPEND_30D_LABEL} ${thirtyDays}`)
  return parts.length === 0 ? null : parts.join(SPEND_LINE_SEPARATOR)
}

/** Grapheme iterator: a cut never splits a surrogate pair, a combining mark
 *  from its base or a ZWJ emoji sequence, so truncation stays cell-exact. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** A grapheme the host draws two cells wide: emoji presentation, an extended
 *  pictograph (a bare `❤` counts too, exactly as the host's `emoji-regex`
 *  does) and a regional-indicator pair (a flag). */
const EMOJI_GLYPH = /\p{Emoji_Presentation}|\p{Extended_Pictographic}|\p{Regional_Indicator}/u
/** VS16 asks for emoji presentation; without it `1` is one cell, with it the
 *  keycap sequence is drawn as one two-cell glyph. */
const EMOJI_PRESENTATION_SELECTOR = '\uFE0F'
/** Unicode default-ignorable code points carry no width of their own. */
const IGNORABLE_GLYPH = /^\p{Default_Ignorable_Code_Point}$/u
/** East Asian Wide/Fullwidth ranges — two cells, never the ambiguous width
 *  (the host measures ambiguous as narrow, so `▸`/`✓`/`—` stay one cell).
 *  Generated from the host's own measurement (`string-width` over every code
 *  point, emoji excluded), so this table can be regenerated verbatim when the
 *  host upgrades its Unicode data instead of being hand-edited. */
const CELL_WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115e],
  [0x2329, 0x232a],
  [0x2630, 0x2637],
  [0x268a, 0x268f],
  [0x2e80, 0x2e99],
  [0x2e9b, 0x2ef3],
  [0x2f00, 0x2fd5],
  [0x2ff0, 0x302f],
  [0x3031, 0x303c],
  [0x303e, 0x303e],
  [0x3041, 0x3096],
  [0x3099, 0x30ff],
  [0x3105, 0x312f],
  [0x3131, 0x3163],
  [0x3165, 0x318e],
  [0x3190, 0x31e5],
  [0x31ef, 0x321e],
  [0x3220, 0x3247],
  [0x3250, 0x3296],
  [0x3298, 0x3298],
  [0x329a, 0xa48c],
  [0xa490, 0xa4c6],
  [0xa960, 0xa97c],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe52],
  [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x16ff0, 0x16ff6],
  [0x17000, 0x18cda],
  [0x18cff, 0x18d20],
  [0x18d80, 0x18df2],
  [0x18e00, 0x19191],
  [0x191a0, 0x191d2],
  [0x1aff0, 0x1aff3],
  [0x1aff5, 0x1affb],
  [0x1affd, 0x1affe],
  [0x1b000, 0x1b128],
  [0x1b132, 0x1b132],
  [0x1b150, 0x1b152],
  [0x1b155, 0x1b155],
  [0x1b164, 0x1b168],
  [0x1b170, 0x1b2fb],
  [0x1d300, 0x1d356],
  [0x1d360, 0x1d376],
  [0x1f200, 0x1f200],
  [0x1f210, 0x1f219],
  [0x1f21b, 0x1f22e],
  [0x1f230, 0x1f231],
  [0x1f23b, 0x1f23b],
  [0x1f240, 0x1f248],
  [0x1f260, 0x1f265],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
]

/** One code point the terminal draws no cell for: control characters, the
 *  zero-width joiners/marks, combining marks and variation selectors. */
function isZeroWidthCodePoint(code: number, glyph: string): boolean {
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  if (code >= 0x200b && code <= 0x200f) return true
  if (code === 0xfeff) return true
  if (code >= 0x300 && code <= 0x36f) return true
  if (code >= 0x1ab0 && code <= 0x1aff) return true
  if (code >= 0x1dc0 && code <= 0x1dff) return true
  if (code >= 0x20d0 && code <= 0x20ff) return true
  if (code >= 0xfe00 && code <= 0xfe0f) return true
  if (code >= 0xfe20 && code <= 0xfe2f) return true
  if (code >= 0xe0100 && code <= 0xe01ef) return true
  if (code >= 0xd800 && code <= 0xdfff) return true // a lone surrogate
  return IGNORABLE_GLYPH.test(glyph)
}

function isWideCodePoint(code: number): boolean {
  for (const [low, high] of CELL_WIDE_RANGES) {
    if (code < low) return false
    if (code <= high) return true
  }
  return false
}

/** Cells one grapheme occupies. */
function graphemeWidth(segment: string): number {
  if (EMOJI_GLYPH.test(segment)) return 2
  // A lone VS16 carries no width; after a base it asks for emoji presentation.
  if (segment.length > 1 && segment.includes(EMOJI_PRESENTATION_SELECTOR)) return 2
  let width = 0
  for (const glyph of segment) {
    const code = glyph.codePointAt(0) ?? 0
    if (isZeroWidthCodePoint(code, glyph)) continue
    width += isWideCodePoint(code) ? 2 : 1
  }
  return width
}

/** Terminal cells `value` occupies — the unit every column in this plugin is
 *  measured in. Mirrors the host (that is how `@opentui/core` sizes a text
 *  run): emoji count as two cells, East Asian Wide/Fullwidth as two, East
 *  Asian Ambiguous as one, combining marks and variation selectors as none.
 *  Pure. */
export function cellWidth(value: string): number {
  let width = 0
  for (const { segment } of GRAPHEMES.segment(value)) width += graphemeWidth(segment)
  return width
}

/** Clamp a free-form label to `max` terminal cells without wrapping. The width
 *  is measured in display cells, never in UTF-16 code units: a CJK or emoji
 *  label used to overflow the column it was cut for (`計画の移行` is 5 code
 *  units but 10 cells, `🚀` is 2 units and 2 cells). Pure. */
export function truncateLabel(value: string, max = 28): string {
  const text = value.trim()
  const budget = Math.max(1, Math.floor(numberOrNull(max) ?? 1))
  if (cellWidth(text) <= budget) return text
  const ellipsis = '\u2026'
  const room = budget - cellWidth(ellipsis)
  let cut = ''
  let used = 0
  for (const { segment } of GRAPHEMES.segment(text)) {
    const width = cellWidth(segment)
    if (used + width > room) break
    cut += segment
    used += width
  }
  return `${cut.replace(/\s+$/, '')}${ellipsis}`
}

/** Right-pad `value` with spaces to exactly `cells` display columns (a wider
 *  value is truncated first). `padEnd` counts code units, so it under-pads a
 *  CJK/emoji cell and the next column drifts. Pure. */
export function padCell(value: string, cells: number): string {
  const width = Math.max(0, Math.floor(numberOrNull(cells) ?? 0))
  if (width === 0) return ''
  const text = truncateLabel(value, width)
  return `${text}${' '.repeat(Math.max(0, width - cellWidth(text)))}`
}

/** Columns the fixed header may use before it would wrap the sidebar. */
export const HEADER_MAX_WIDTH = 34

/** Preset row of the fixed header: `▸ <preset> · <provider>`. The provider is
 *  cut first when the row overflows, so the preset name is never the casualty;
 *  a missing provider leaves the preset alone (no `unknown` placeholder). */
export function presetHeaderLine(presetName: string, providerID: string | null): string {
  const name = presetName.trim() === '' ? 'default' : presetName.trim()
  const base = `${PRESET_MARKER} ${name}`
  const provider = providerID === null ? '' : providerID.trim()
  if (provider === '') return truncateLabel(base, HEADER_MAX_WIDTH)
  const room = HEADER_MAX_WIDTH - `${base} · `.length
  if (room < 2) return truncateLabel(base, HEADER_MAX_WIDTH)
  return `${base} · ${truncateLabel(provider, room)}`
}

/* ─── Dispatch kind (why the child exists) ────────────────
 * The host's own row answers *who* runs and *how much* it cost, never *why* the
 * child exists. Only two evidence sources are allowed here, and neither is
 * invented: the `description` the parent typed for the `subagent` call (a
 * bracketed prefix such as `[review]`), and — when the prefix is absent — the
 * agent that owns the child (athena plans, themis reviews, talos hotfixes,
 * apollo scouts). `council` is the single exception: a round of specialists is
 * a declared intent, not an agent identity, so it is *never* inferred from the
 * agent. Every classification carries the `origin` of its evidence, and a child
 * that cannot be correlated to a call degrades to `{ null, 'unavailable' }`
 * instead of a guess. Pure. */

export type DispatchKind = 'coun' | 'plan' | 'revw' | 'hot' | 'disc' | 'oth'
export type DispatchKindOrigin = 'prefix' | 'agent' | 'unavailable'

/** One classification plus the evidence that produced it. */
export type DispatchKindLabel = { kind: DispatchKind | null; origin: DispatchKindOrigin }

/** Bracketed description prefix → short label (`[council]` → `coun`). */
const DISPATCH_PREFIX_KINDS: ReadonlyArray<readonly [string, DispatchKind]> = [
  ['council', 'coun'],
  ['discovery', 'disc'],
  ['hotfix', 'hot'],
  ['plan', 'plan'],
  ['review', 'revw'],
]

/** Agent → kind, consulted only when the description declares no prefix.
 *  `council` is deliberately absent — see the section comment. */
const DISPATCH_AGENT_KINDS: Readonly<Record<string, DispatchKind>> = {
  apollo: 'disc',
  athena: 'plan',
  talos: 'hot',
  themis: 'revw',
}

/** Kind declared by a leading `[prefix]` on the description: case-insensitive
 *  and tolerant of spaces inside the brackets. Null when none is declared. */
export function dispatchKindFromPrefix(description: unknown): DispatchKind | null {
  if (typeof description !== 'string') return null
  const match = /^\s*\[\s*([a-z]+)\s*\]/i.exec(description)
  if (match === null) return null
  const token = (match[1] ?? '').toLowerCase()
  for (const [word, kind] of DISPATCH_PREFIX_KINDS) {
    if (word === token) return kind
  }
  return null
}

/** Kind implied by the child's agent, null for an agent that implies none. */
export function dispatchKindFromAgent(agent: unknown): DispatchKind | null {
  if (typeof agent !== 'string') return null
  return DISPATCH_AGENT_KINDS[agent.trim().toLowerCase()] ?? null
}

/** Classify one dispatch. The description prefix always wins over the agent;
 *  otherwise the agent decides, and anything else is `oth` (a real dispatch we
 *  simply cannot name). A missing call is the only `unavailable` outcome. Pure. */
export function classifyDispatchKind(
  call: { description?: unknown; agent?: unknown } | null | undefined,
): DispatchKindLabel {
  if (call === null || call === undefined) return { kind: null, origin: 'unavailable' }
  const fromPrefix = dispatchKindFromPrefix(call.description)
  if (fromPrefix !== null) return { kind: fromPrefix, origin: 'prefix' }
  return { kind: dispatchKindFromAgent(call.agent) ?? 'oth', origin: 'agent' }
}

/** A `subagent` tool call the parent made, as its own transcript records it. */
export type SubagentCall = {
  /** Child session id the call created — the correlation key. */
  sessionID: string
  agent: string
  description: string
  background: boolean
}

/** Host tool that spawns a child (V2 name; it is not `task`). */
const SUBAGENT_TOOL = 'subagent'
/** The tool result also names its child: `<subagent sessionID="ses_…" …>`. */
const SUBAGENT_SESSION_PATTERN = /sessionID="([^"]+)"/

/** Text of a tool `content` payload, joined; tolerant of the string form. */
function toolContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const chunks: string[] = []
  for (const part of content) {
    const text = (part as { text?: unknown } | null | undefined)?.text
    if (typeof text === 'string') chunks.push(text)
  }
  return chunks.join('\n')
}

/** Child session id of one `subagent` call: the exact `metadata.sessionID`
 *  first, then an `output`/`result` id, then the `<subagent sessionID="…">` tag
 *  in the result text. Null when the call has not produced a child yet. */
function subagentSessionID(state: any): string | null {
  const direct = [state?.metadata?.sessionID, state?.output?.sessionID, state?.result?.sessionID]
  for (const candidate of direct) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  const match = SUBAGENT_SESSION_PATTERN.exec(toolContentText(state?.content))
  return match?.[1] ?? null
}

/** Correlate the parent transcript's `subagent` calls with the children they
 *  spawned: child session id → `{ agent, description, background }`. One pass
 *  over the list the sidebar already holds — no request, no `message.sync` on
 *  the child. `streaming`/`pending` states carry their input as *partial JSON
 *  text*, so they are skipped rather than parsed. Fail-open: a malformed part
 *  contributes nothing. Pure. */
export function collectSubagentCalls(
  messages: readonly any[] | null | undefined,
): Map<string, SubagentCall> {
  const calls = new Map<string, SubagentCall>()
  if (!Array.isArray(messages)) return calls
  for (const message of messages) {
    if (message?.type !== 'assistant' || !Array.isArray(message.content)) continue
    for (const part of message.content) {
      if (part?.type !== 'tool' || part?.name !== SUBAGENT_TOOL) continue
      const state = part.state
      if (state === null || typeof state !== 'object') continue
      if (state.status === 'streaming' || state.status === 'pending') continue
      const sessionID = subagentSessionID(state)
      if (!isValidSessionID(sessionID)) continue
      const input =
        state.input !== null && typeof state.input === 'object' ? (state.input as any) : {}
      const agent = typeof input.agent === 'string' ? input.agent : ''
      const description = typeof input.description === 'string' ? input.description : ''
      calls.set(sessionID, {
        sessionID,
        agent,
        description,
        background: input.background === true,
      })
    }
  }
  return calls
}

/* ─── Delegation helpers ─────────────────────────────────── */

export type DelegationState = 'running' | 'completed' | 'failed' | 'interrupted'
export type DelegationTone = 'warning' | 'error' | 'success'

/** Grace window for a child that has not started yet. V2's `session.status()`
 *  returns `idle` both for "created but not started" and for "finished", so an
 *  idle/unknown/absent child whose own last activity (`time.updated`, falling
 *  back to `time.created`) is this recent still reads as running — otherwise a
 *  just-spawned child renders a premature ✓. Trade-off (V1 parity: it had the
 *  same window for its absent statuses): a child that finished within the window
 *  and reports no `outcome` reads as running until the window closes, at which
 *  point it turns terminal and its completion toast fires. A child that reports
 *  a terminal `outcome` is never held back by the window. */
export const DELEGATION_CHILD_STATUS_GRACE_MS = 60 * 1000

/** One delegated child job as the sidebar renders it. */
export type DelegationView = {
  /** Child session id — also the click-through target. */
  id: string
  /** Alias shown on the row: the child title, else agent, else short id. */
  label: string
  state: DelegationState
  /** Epoch ms of the child's `time.created`. */
  startedAt: number | null
  /** Epoch ms of the child's `time.updated`. */
  updatedAt: number | null
  /** Child agent id, when the host published one. */
  agent: string | null
  /** Resolved child model, shortened to its bare id. */
  model: string | null
  /** Real `SessionInfo.cost` for the child, null when the host published none. */
  cost: number | null
  /** Why the child exists — see `classifyDispatchKind`. Null when no `subagent`
   *  call in the parent transcript could be correlated with this child. */
  kind: DispatchKind | null
  /** Which evidence produced `kind`. */
  kindOrigin: DispatchKindOrigin
  /** The parent asked for this child to run in the background. */
  background: boolean
}

/** Map the host's live session status to a display state. V2 exposes only
 *  `"idle" | "running"` through the TUI context (the client union adds `retry`
 *  and `busy`); `error`/`failed` are handled defensively for host drift.
 *  `idle`, `retry` and unknown/absent statuses are terminal only once the
 *  child's own activity is older than the grace window — within it the child
 *  reads as running (see `DELEGATION_CHILD_STATUS_GRACE_MS`). An interruption is
 *  not part of this union: it arrives as a terminal `outcome`. Pure. */
export function delegationStateFromStatus(
  status: string | undefined,
  time?: { created?: number; updated?: number },
  now = Date.now(),
  graceMs = DELEGATION_CHILD_STATUS_GRACE_MS,
): DelegationState {
  switch (status) {
    case 'running':
    case 'busy':
      return 'running'
    case 'error':
    case 'failed':
      return 'failed'
    default: {
      const lastActivity = Math.max(time?.updated ?? 0, time?.created ?? 0)
      if (lastActivity > 0 && now - lastActivity < graceMs) return 'running'
      return 'completed'
    }
  }
}

/** Map a V2 child `outcome` to a display state. `interrupted` (user abort,
 *  shutdown, superseded, inactivity) is distinct from both success and failure,
 *  so an aborted child never renders the ✓ of a completed one. Returns null for
 *  an absent/unrecognised outcome so the live status decides. Pure. */
export function delegationStateFromOutcome(outcome: unknown): DelegationState | null {
  switch (outcome) {
    case 'succeeded':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'interrupted':
      return 'interrupted'
    default:
      return null
  }
}

/** Build a delegation row from a child session + its live status, plus the
 *  `subagent` call that spawned it (when the parent transcript had one). A
 *  terminal `outcome` wins when present (the only V2 primitive that surfaces a
 *  delegation failure/interruption once the status is back to idle); otherwise
 *  the live status decides, with the absent/idle grace window applied. The
 *  `call` only ever *adds* the purpose and the background flag — an absent one
 *  leaves the row fully renderable. Pure. */
export function toDelegationView(
  child: any,
  status: string | undefined,
  now = Date.now(),
  call?: SubagentCall | null,
): DelegationView {
  const id = typeof child?.id === 'string' ? child.id : ''
  const title = typeof child?.title === 'string' && child.title !== '' ? child.title : ''
  const agent = typeof child?.agent === 'string' && child.agent !== '' ? child.agent : ''
  const label = title !== '' ? title : agent !== '' ? agent : id.slice(0, 8)
  const state: DelegationState =
    delegationStateFromOutcome(child?.outcome) ??
    delegationStateFromStatus(status, child?.time, now)
  const classification = classifyDispatchKind(call)
  return {
    id,
    label,
    state,
    startedAt: numberOrNull(child?.time?.created),
    updatedAt: numberOrNull(child?.time?.updated),
    agent: agent !== '' ? agent : null,
    model: shortModelID(child?.model),
    cost: numberOrNull(child?.cost),
    kind: classification.kind,
    kindOrigin: classification.origin,
    background: call?.background === true,
  }
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** Spinner glyph for a frame counter (incremented every ~80ms while any job is
 *  running). Pure. */
export function spinnerFrame(frame: number): string {
  const index = Math.abs(Math.floor(frame)) % SPINNER_FRAMES.length
  return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0]
}

/** Shared order: live work first, then most recent activity. One comparator for
 *  every consumer of the dispatch tree (sidebar block and panel list), so the
 *  two views can never disagree about which child comes first. Pure. */
function compareDelegations(a: DelegationView, b: DelegationView): number {
  const activeA = a.state === 'running' ? 1 : 0
  const activeB = b.state === 'running' ? 1 : 0
  if (activeA !== activeB) return activeB - activeA
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
}

/* ─── Dispatch collector (shared) ─────────────────────────
 * The single source of the delegation tree: the sidebar block and the
 * `pantheon.dispatch` panel both render `collectDispatch` output, so a child
 * can never appear twice under two different semantics — the duplication bug
 * the two-collector design had. It reads only state the host already cached:
 * `session.family` for the id set, `session.get` per child, `session.status`
 * for liveness, and the parent's own `message.list` for the `subagent` calls
 * that explain each child. Never a child `message.list`, never `message.sync`,
 * never an HTTP call. */

/** Token totals published on `SessionInfo.tokens`, one entry per counter. */
export type DispatchTokens = {
  input: number | null
  output: number | null
  reasoning: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

/** One child of the dispatch tree: the delegation row plus the fields only the
 *  panel's detail view needs (`SessionInfo.title`/`parentID`/`tokens` and the
 *  spawning call's description). */
export type DispatchEntry = {
  view: DelegationView
  title: string | null
  description: string | null
  parentID: string | null
  tokens: DispatchTokens | null
}

/** Optional inputs of `collectDispatch`: a fixed clock (tests/render ticks) and
 *  an already-computed `agent` map, so a caller that walked the parent
 *  transcript anyway never pays for a second walk. */
export type CollectDispatchOptions = {
  now?: number
  calls?: Map<string, SubagentCall>
}

/** `message.list` of one session, degrades to an empty list. The host's list is
 *  a cached directory read, not a request. */
function readSessionMessages(context: any, sessionID: string): any[] {
  try {
    const result = context?.data?.session?.message?.list?.(sessionID)
    return Array.isArray(result) ? result : []
  } catch {
    return []
  }
}

/** Token counters of a child, null when the host published none of them. Pure. */
export function dispatchTokens(tokens: unknown): DispatchTokens | null {
  if (tokens === null || typeof tokens !== 'object') return null
  const source = tokens as Record<string, unknown>
  const cache =
    source.cache !== null && typeof source.cache === 'object'
      ? (source.cache as Record<string, unknown>)
      : {}
  const totals: DispatchTokens = {
    input: numberOrNull(source.input),
    output: numberOrNull(source.output),
    reasoning: numberOrNull(source.reasoning),
    cacheRead: numberOrNull(cache.read),
    cacheWrite: numberOrNull(cache.write),
  }
  const values = [
    totals.input,
    totals.output,
    totals.reasoning,
    totals.cacheRead,
    totals.cacheWrite,
  ]
  return values.every((value) => value === null) ? null : totals
}

/** One child `SessionInfo` + its live status → `DispatchEntry`. The call only
 *  ever adds the kind and the description; an absent one leaves the entry fully
 *  renderable. Pure. */
export function toDispatchEntry(
  child: any,
  status: string | undefined,
  now = Date.now(),
  call?: SubagentCall | null,
): DispatchEntry {
  const title = typeof child?.title === 'string' && child.title !== '' ? child.title : null
  const parentID =
    typeof child?.parentID === 'string' && child.parentID !== '' ? child.parentID : null
  const description =
    typeof call?.description === 'string' && call.description !== '' ? call.description : null
  return {
    view: toDelegationView(child, status, now, call),
    title,
    description,
    parentID,
    tokens: dispatchTokens(child?.tokens),
  }
}

/** The delegation tree of `sessionID` — every child `session.family` returns,
 *  root excluded, each enriched from `session.get`/`session.status` and the
 *  parent's `subagent` calls. Empty when the family API is unavailable or the
 *  session id is not a real handle (never falls back to the root). Ordered by
 *  the shared `compareDelegations`, so callers render the same list in the same
 *  order. A family that repeats an id yields one row per child: the id is
 *  deduplicated before the walk, so a duplicate can never double a row or its
 *  cost. */
export function collectDispatch(
  context: any,
  sessionID: string | undefined,
  options: CollectDispatchOptions = {},
): DispatchEntry[] {
  if (!isValidSessionID(sessionID)) return []
  let family: string[] = []
  try {
    const result = context?.data?.session?.family?.(sessionID)
    if (Array.isArray(result)) family = result
  } catch {
    return []
  }
  const now = numberOrNull(options.now) ?? Date.now()
  const calls = options.calls ?? collectSubagentCalls(readSessionMessages(context, sessionID))
  const entries: DispatchEntry[] = []
  // A host may publish the same child more than once (`family()` is not
  // guaranteed unique). Deduplicate by id, preserving the host's order, so a
  // repeated id never renders two rows nor counts its cost twice.
  const seen = new Set<string>()
  for (const childID of family) {
    if (childID === sessionID || !isValidSessionID(childID)) continue
    if (seen.has(childID)) continue
    seen.add(childID)
    let child: any
    try {
      child = context.data.session.get(childID)
    } catch {
      continue
    }
    if (!child) continue
    entries.push(
      toDispatchEntry(child, sessionStatusOf(context, childID), now, calls.get(childID) ?? null),
    )
  }
  return entries.sort((a, b) => compareDelegations(a.view, b.view))
}

/* ─── Block layout ───────────────────────────────────────── */

/** Sidebar blocks in render order. Spacing is derived from this list instead of
 *  from the view, so a hidden block can never leave an empty gap behind. */
export type SidebarBlockKey = 'context' | 'git' | 'todo' | 'dispatch'

/** One rendered block: its key, and whether a blank line precedes it. */
export type SidebarBlock = { key: SidebarBlockKey; spacer: boolean }

/** Header glyph per block — one codepoint each, rendered muted before the bold
 *  label. The fixed header (version/preset/session) takes none.
 *  Measured as one terminal cell by the host (`@opentui/core` counts
 *  `emoji-regex` matches as two): ▤ U+25A4 (EAW=A), ◆ U+25C6 (A), ▾ U+25BE (N),
 *  ◈ U+25C8 (A). `☑` U+2611 was rejected for the Todo header because it matches
 *  `emoji-regex` and would occupy two cells; `⌁` U+2301 (the old Dispatch glyph)
 *  was replaced by the host's own Notice glyph. */
export const BLOCK_ICONS: Record<SidebarBlockKey, string> = {
  context: '\u25A4',
  git: '\u25C6',
  todo: '\u25BE',
  dispatch: '\u25C8',
}

/** Tag every block that has content with its spacer: never before the first
 *  (the view puts a single blank line after the fixed header instead), one
 *  blank line before every later block. A repeated key collapses instead of
 *  stacking spacers, so an absent optional block can never leave a double gap.
 *  Pure. */
export function withBlockSpacers(keys: readonly SidebarBlockKey[]): SidebarBlock[] {
  const seen = new Set<SidebarBlockKey>()
  const blocks: SidebarBlock[] = []
  for (const key of keys) {
    if (seen.has(key)) continue
    seen.add(key)
    blocks.push({ key, spacer: blocks.length > 0 })
  }
  return blocks
}

/* ─── Dispatch block ──────────────────────────────────────
 * One block for the whole child set, in two sections: the live jobs one row
 * each, then the finished ones aggregated per agent. A per-session list cannot
 * survive a wide fan-out (71 children would either scroll the sidebar or hide
 * most of them behind `… +66`), while a per-agent rollup keeps the count, the
 * spend and the failures readable in a handful of rows. */

/** Live children rendered one row each; the rest collapse into `… +N rodando`. */
export const DISPATCH_RUNNING_CEILING = 3
/** Agent rollup rows rendered before the `… +K  $<soma>` line. */
export const DISPATCH_AGENT_CEILING = 3
/** Hard cap on the block's rendered rows, header included. The sidebar is
 *  short; live work is served first, then the finished rollup. */
export const DISPATCH_MAX_LINES = 8
/** Marker of the aggregated "finished" section. */
export const DISPATCH_DONE_MARKER = '\u2713'
/** Column width of the agent (or of its title/id fallback). */
export const DISPATCH_AGENT_WIDTH = 12
/** Narrowest agent column a row may fall back to before the cost is kept whole
 *  and the label truncates further. */
export const DISPATCH_MIN_AGENT_WIDTH = 8
/** Column width of the short model id — the model is dropped before the agent
 *  or the cost so a row always fits. */
export const DISPATCH_MODEL_WIDTH = 7
/** Column width of the per-dispatch cost (`$0.04`; a sub-cent cost widens it). */
export const DISPATCH_COST_WIDTH = 5
/** Column width of the duration (`12.7s` / `1m04s` / `820ms`). */
export const DISPATCH_DURATION_WIDTH = 5
/** Column width of the `×<count>` cell of an agent rollup row. */
export const DISPATCH_COUNT_WIDTH = 3
/** Column width of an agent rollup cost (`$0.0051` still fits). */
export const DISPATCH_GROUP_COST_WIDTH = 7
/** Hard column budget for one row — a Dispatch line never wraps:
 *  marker(2) + agent(12) + model(7) + cost(5) + duration(5) + 3 spaces = 34.
 *  The kind suffix (`·disc`, `·disc~`) is wider evidence than the model, so a
 *  classified row spends the model's columns first: marker(2) + agent(≤12) +
 *  suffix(≤6) + cost(5) + duration(5) + 2 spaces ≤ 32, still inside 34. */
export const DISPATCH_MAX_WIDTH = 34

/** Middle dot used between a label and its kind (`apollo·disc`). */
const DISPATCH_KIND_SEPARATOR = '\u00B7'
/** Background marker: the parent asked the child to run in the background. */
const DISPATCH_BACKGROUND_MARKER = '~'

/** Kind suffix glued to a row's label: `·disc`, `·disc~` for a background run,
 *  and empty when the child could not be classified (the row then reads exactly
 *  as before). Pure. */
export function dispatchKindSuffix(
  kind: DispatchKind | null | undefined,
  background?: boolean,
): string {
  if (kind === null || kind === undefined) return ''
  const text = `${DISPATCH_KIND_SEPARATOR}${kind}`
  return background === true ? `${text}${DISPATCH_BACKGROUND_MARKER}` : text
}

/** Header summary: `2 rodando · $3.49`. The live count is omitted when nothing
 *  runs, and the total spend is always printed (the header only renders while
 *  the tree has children, so `$0.00` is a real answer). Pure. */
export function dispatchHeaderSummary(
  running: number | null | undefined,
  cost: number | null | undefined,
): string | null {
  const parts: string[] = []
  const live = numberOrNull(running) ?? 0
  if (live > 0) parts.push(`${Math.round(live)} rodando`)
  const formatted = formatSpendUSD(numberOrNull(cost) ?? 0)
  if (formatted !== null) parts.push(formatted)
  return parts.length === 0 ? null : parts.join(SPEND_LINE_SEPARATOR)
}

/** Compact duration without an internal space: `820` → `820ms`, `12_400` →
 *  `12.4s`, `64_000` → `1m04s`, `3_780_000` → `1h03m`, `172_800_000` → `2d`.
 *  An absent or negative value renders an em dash, never `NaN`s. Pure. */
export function formatDispatchDuration(ms: number | null | undefined): string {
  const value = numberOrNull(ms)
  if (value === null || value < 0) return '\u2014'
  if (value < 1_000) return `${Math.round(value)}ms`
  const seconds = value / 1000
  if (seconds < 59.95) return `${seconds.toFixed(1)}s`
  const total = Math.round(seconds)
  const hours = Math.floor(total / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d`
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, '0')}m`
  return `${minutes}m${String(total % 60).padStart(2, '0')}s`
}

/** Elapsed label for one row: a live child measures `now - created`, a finished
 *  one freezes at `updated - created` (em dash when a timestamp is missing).
 *  Pure. */
export function dispatchElapsed(view: DelegationView, now = Date.now()): string {
  if (view.startedAt === null) return '\u2014'
  if (view.state === 'running') return formatDispatchDuration(now - view.startedAt)
  if (view.updatedAt === null) return '\u2014'
  return formatDispatchDuration(view.updatedAt - view.startedAt)
}

/** Name column: the agent when the host published one, else the child title,
 *  else the short id — never `undefined`. Truncated to the column width. Pure. */
export function dispatchAgentText(
  view: Pick<DelegationView, 'agent' | 'label' | 'id'>,
  max = DISPATCH_AGENT_WIDTH,
): string {
  const agent = typeof view.agent === 'string' ? view.agent.trim() : ''
  const label = typeof view.label === 'string' ? view.label.trim() : ''
  const id = typeof view.id === 'string' ? view.id.trim() : ''
  const name = agent !== '' ? agent : label !== '' ? label : id
  return name === '' ? '\u2014' : truncateLabel(name, max)
}

/** Model column, empty when the host published none. Pure. */
export function dispatchModelText(view: Pick<DelegationView, 'model'>): string {
  const model = typeof view.model === 'string' ? view.model.trim() : ''
  return model === '' ? '' : truncateLabel(model, DISPATCH_MODEL_WIDTH)
}

/** Cost column: the child's real `SessionInfo.cost` with two decimals (up to
 *  four below a cent, so `$0.0031` never collapses to `$0.00`), `$0.00` for a
 *  zero cost, and an em dash when the host published no numeric cost. Pure. */
export function formatDispatchCost(cost: number | null | undefined): string {
  return formatUsageCost(cost) ?? '\u2014'
}

/** Total spend of every child (live + finished), `0` when none published a
 *  numeric cost. Pure. */
export function dispatchTotalCost(views: readonly DelegationView[]): number {
  let total = 0
  for (const view of views ?? []) {
    const cost = numberOrNull(view?.cost)
    if (cost !== null && cost >= 0) total += cost
  }
  return total
}

/** One live child: `⠸ <agent 12>·<kind> <custo> <duração>`, with the model as a
 *  fourth column only when the row still fits and the child is unclassified —
 *  the kind is the stronger evidence at this width, so it takes the model's
 *  columns. The kind rides glued to the label (never a column of its own) and
 *  disappears with the label's truncation; then the agent column shrinks (never
 *  below `DISPATCH_MIN_AGENT_WIDTH`); the cost is always present — `$0.00` for a
 *  zero cost, an em dash for a missing one. Pure. */
export function runningChildRowText(
  view: DelegationView,
  now = Date.now(),
  frame = 0,
  max = DISPATCH_MAX_WIDTH,
): string {
  const marker = `${spinnerFrame(frame)} `
  const duration = dispatchElapsed(view, now).padStart(DISPATCH_DURATION_WIDTH)
  const cost = formatDispatchCost(view.cost).padStart(DISPATCH_COST_WIDTH)
  const model = dispatchModelText(view)
  const suffix = dispatchKindSuffix(view.kind, view.background)
  const limit = Math.max(1, max)
  const row = (agentWidth: number, withModel: boolean, withSuffix = true): string => {
    const kind = withSuffix ? suffix : ''
    const name = dispatchAgentText(view, agentWidth)
    // The kind rides glued to the label and never becomes a column of its own:
    // an unclassified row keeps the fixed 12-column label cell byte-for-byte.
    const cell = kind === '' ? name.padEnd(agentWidth) : `${name}${kind}`
    const tail = withModel
      ? `${model.padEnd(DISPATCH_MODEL_WIDTH)} ${cost} ${duration}`
      : `${cost} ${duration}`
    return `${marker}${cell} ${tail}`
  }
  if (model !== '' && suffix === '') {
    const withModel = row(DISPATCH_AGENT_WIDTH, true)
    if (withModel.length <= limit) return withModel
  }
  const full = row(DISPATCH_AGENT_WIDTH, false)
  if (full.length <= limit) return full
  for (let width = DISPATCH_AGENT_WIDTH - 1; width >= DISPATCH_MIN_AGENT_WIDTH; width -= 1) {
    const narrowed = row(width, false)
    if (narrowed.length <= limit) return narrowed
  }
  // The kind is evidence, the cost is the point: on a budget too narrow even for
  // the minimum agent column, the suffix yields before the row overflows.
  if (suffix !== '') return row(DISPATCH_MIN_AGENT_WIDTH, false, false)
  return row(DISPATCH_MIN_AGENT_WIDTH, false)
}

/** Sessions and spend attributed to one agent in the finished section. `kind`
 *  is only set when every finished session of the group agrees on it — a mixed
 *  group carries no single purpose, so the row omits it rather than picking one.
 *  `background` follows the same rule (all of them background). */
export type ChildAgentUsage = {
  agent: string
  count: number
  cost: number
  kind: DispatchKind | null
  background: boolean
}

/** Rollup of the finished children by agent: `×count` sessions and the summed
 *  `SessionInfo.cost`. Failed and interrupted children are included (they are
 *  finished); running ones are not. The group's kind survives only when the
 *  whole group agrees, so an aggregate row never claims a purpose it cannot
 *  prove. Ordered by cost, then count, then name. Pure. */
export function collectChildAgentUsage(views: readonly DelegationView[]): ChildAgentUsage[] {
  type Accumulated = {
    agent: string
    count: number
    cost: number
    kinds: Set<DispatchKind | null>
    background: boolean
  }
  const totals = new Map<string, Accumulated>()
  for (const view of views ?? []) {
    if (!view || view.state === 'running') continue
    const agent = agentKey(view.agent)
    const current = totals.get(agent) ?? {
      agent,
      count: 0,
      cost: 0,
      kinds: new Set<DispatchKind | null>(),
      background: true,
    }
    current.count += 1
    current.kinds.add(view.kind ?? null)
    if (view.background !== true) current.background = false
    const cost = numberOrNull(view.cost)
    if (cost !== null && cost >= 0) current.cost += cost
    totals.set(agent, current)
  }
  return [...totals.values()]
    .map((entry) => {
      const shared = entry.kinds.size === 1 ? ([...entry.kinds][0] ?? null) : null
      return {
        agent: entry.agent,
        count: entry.count,
        cost: entry.cost,
        kind: shared,
        background: entry.background,
      }
    })
    .sort((a, b) => b.cost - a.cost || b.count - a.count || a.agent.localeCompare(b.agent))
}

/** One agent rollup row: `<agent 12> ×<count 3>·<kind> <custo 7>`. The kind is
 *  glued to the count (the row's only label) and omitted for a mixed group; the
 *  agent column shrinks (never below the minimum) before the cost, which is
 *  what the row is for. Pure. */
export function childAgentRowText(row: ChildAgentUsage, max = DISPATCH_MAX_WIDTH): string {
  const suffix = dispatchKindSuffix(row?.kind, row?.background)
  const count = `\u00D7${String(Math.max(0, Math.round(numberOrNull(row?.count) ?? 0))).padStart(
    DISPATCH_COUNT_WIDTH,
  )}`
  const cost = formatDispatchCost(row?.cost).padStart(DISPATCH_GROUP_COST_WIDTH)
  const limit = Math.max(1, max)
  const text = (agentWidth: number, withSuffix = true): string => {
    const kind = withSuffix ? suffix : ''
    return `${truncateLabel(agentKey(row?.agent), agentWidth).padEnd(agentWidth)} ${count}${kind} ${cost}`
  }
  const full = text(DISPATCH_AGENT_WIDTH)
  if (full.length <= limit) return full
  for (let width = DISPATCH_AGENT_WIDTH - 1; width >= DISPATCH_MIN_AGENT_WIDTH; width -= 1) {
    const narrowed = text(width)
    if (narrowed.length <= limit) return narrowed
  }
  // Same rule as a live row: the kind yields before the row overflows.
  if (suffix !== '') return text(DISPATCH_MIN_AGENT_WIDTH, false)
  return text(DISPATCH_MIN_AGENT_WIDTH)
}

/** The `… +K  $<soma>` line for agents beyond the rollup cap. Null when every
 *  agent fits. Pure. */
export function hiddenChildAgentsText(hidden: number, hiddenCost: number): string | null {
  const count = numberOrNull(hidden) ?? 0
  if (count <= 0) return null
  const cost = formatSpendUSD(numberOrNull(hiddenCost) ?? 0)
  return cost === null ? `\u2026 +${Math.round(count)}` : `\u2026 +${Math.round(count)}  ${cost}`
}

/** Summary of the finished section: `✓ 70 · $3.40 · 9 agentes`. `· $<soma>` is
 *  omitted when nothing was spent and `· 1 agente` when a single agent owns
 *  every finished child; `✓ <total>` always prints. Null when nothing finished.
 *  Pure. */
export function completedSummaryText(
  completed: number | null | undefined,
  cost: number | null | undefined,
  agents: number | null | undefined,
): string | null {
  const total = numberOrNull(completed) ?? 0
  if (total <= 0) return null
  const parts = [`${DISPATCH_DONE_MARKER} ${Math.round(total)}`]
  const spend = numberOrNull(cost) ?? 0
  if (spend > 0) {
    const formatted = formatSpendUSD(spend)
    if (formatted !== null) parts.push(formatted)
  }
  const groups = Math.round(numberOrNull(agents) ?? 0)
  if (groups > 1) parts.push(`${groups} agentes`)
  return parts.join(SPEND_LINE_SEPARATOR)
}

/** The `· <F> falhas` suffix of the finished summary, null when nothing failed.
 *  Pure. */
export function failedSuffixText(failures: number | null | undefined): string | null {
  const count = numberOrNull(failures) ?? 0
  if (count <= 0) return null
  const rounded = Math.round(count)
  return `${rounded} ${rounded === 1 ? 'falha' : 'falhas'}`
}

/** One rendered live row: its text plus the session it navigates to. */
export type DispatchRunningLine = { id: string; text: string }

/** Everything the `Dispatch` block renders, already joined and capped. */
export type DispatchBlockView = {
  runningCount: number
  completedCount: number
  agentCount: number
  failures: number
  totalCost: number
  running: DispatchRunningLine[]
  runningHidden: number
  summary: string | null
  agents: ChildAgentUsage[]
  agentsHidden: number
  agentsHiddenCost: number
}

/** Newest activity first, so the live rows that just moved lead the section.
 *  Pure. */
function lastActivity(view: DelegationView): number {
  return Math.max(numberOrNull(view?.updatedAt) ?? 0, numberOrNull(view?.startedAt) ?? 0)
}

/** Build the whole block from the child set. Null when there is no child, so
 *  the block (and its spacer) never renders empty. Live work is capped at
 *  `DISPATCH_RUNNING_CEILING` and the finished rollup at
 *  `DISPATCH_AGENT_CEILING`, with the rollup giving up rows first to keep the
 *  block inside `DISPATCH_MAX_LINES`. Pure. */
export function buildDispatchBlock(
  views: readonly DelegationView[],
  now = Date.now(),
  frame = 0,
  max = DISPATCH_MAX_WIDTH,
): DispatchBlockView | null {
  const list = Array.isArray(views)
    ? views.filter((view) => view && typeof view.id === 'string')
    : []
  if (list.length === 0) return null

  const running = list
    .filter((view) => view.state === 'running')
    .sort((a, b) => lastActivity(b) - lastActivity(a))
  const finished = list.filter((view) => view.state !== 'running')
  const groups = collectChildAgentUsage(finished)
  const finishedCost = groups.reduce((sum, group) => sum + group.cost, 0)
  const failures = finished.filter((view) => view.state === 'failed').length
  const totalCost = dispatchTotalCost(list)

  const runningSlots = Math.min(DISPATCH_RUNNING_CEILING, running.length)
  const runningHidden = running.length - runningSlots
  const runningLines = running.map((view) => ({
    id: view.id,
    text: runningChildRowText(view, now, frame, max),
  }))
  const summary = completedSummaryText(finished.length, finishedCost, groups.length)

  // Budget: header + live section + summary + rollup. The rollup yields first,
  // and its own `… +K` line is reserved before any agent row is granted, so the
  // block can never exceed `DISPATCH_MAX_LINES`.
  const runningRows = runningSlots + (runningHidden > 0 ? 1 : 0)
  const room = Math.max(0, DISPATCH_MAX_LINES - 1 - runningRows - (summary === null ? 0 : 1))
  const wanted = Math.min(DISPATCH_AGENT_CEILING, groups.length)
  const agentSlots =
    groups.length > wanted ? Math.min(wanted, Math.max(0, room - 1)) : Math.min(wanted, room)
  const visibleAgents = groups.slice(0, agentSlots)
  const hiddenAgents = groups.slice(agentSlots)

  return {
    runningCount: running.length,
    completedCount: finished.length,
    agentCount: groups.length,
    failures,
    totalCost,
    running: runningLines.slice(0, runningSlots),
    runningHidden,
    summary,
    agents: visibleAgents,
    agentsHidden: hiddenAgents.length,
    agentsHiddenCost: hiddenAgents.reduce((sum, group) => sum + group.cost, 0),
  }
}

/* ─── Dispatch panel ──────────────────────────────────────
 * The `pantheon.dispatch` panel is the full-width counterpart of the sidebar
 * block: one row per child session (not per agent), the header counters of the
 * whole tree and a detail column for the selected child. It renders
 * `collectDispatch` output — the same collector the sidebar block consumes — so
 * a child can never be listed twice or described two different ways.
 *
 * Everything below is pure until `createDispatchPanelModel`: row/header/detail
 * text is computed without a renderer, and the model owns only the signals the
 * view needs (selection by id, viewport, expansion, spinner frame). */

/** Panel content name, registered by the `session.panel` claim and passed to
 *  `ui.panel.open`. */
export const DISPATCH_PANEL_NAME = 'pantheon.dispatch'
/** Toast shown when `ui.panel.open` refuses (no session route is active). The
 *  panel only exists inside a session, so there is no alternative route. */
export const DISPATCH_PANEL_TOAST = 'Abra uma sessão para ver o Dispatch'
/** Panel title marker — the same glyph the sidebar block header uses. */
export const DISPATCH_PANEL_HEADER_MARKER = '\u25C8'
/** Selected-row gutter marker (`▸`, one cell). */
export const DISPATCH_PANEL_SELECTION_MARKER = '\u25B8'
/** Cells the selection gutter occupies before a row's own text. */
export const DISPATCH_PANEL_SELECTION_GUTTER = 2
/** Column of the horizontal rule under the header. */
export const DISPATCH_PANEL_RULE_CHAR = '\u2500'
/** Em dash for any datum the host did not publish. */
export const DISPATCH_PANEL_DASH = '\u2014'
/** Body of an empty panel (the claim still renders, the list is just empty). */
export const DISPATCH_PANEL_EMPTY_TEXT = 'Nenhuma sessão delegada'
/** Width at or above which the list and the detail sit side by side. */
export const DISPATCH_PANEL_WIDE_MIN_WIDTH = 72
/** Rows the viewport holds; pageup/pagedown move by exactly this many rows. */
export const DISPATCH_PANEL_PAGE_SIZE = 10
/** Panel row columns: marker(2) + agent(12) + kind(4) + cost(≥7) + duration(8).
 *  The cost column is at least this wide; a sub-cent cost widens it per row. */
export const DISPATCH_PANEL_AGENT_WIDTH = 12
export const DISPATCH_PANEL_MIN_AGENT_WIDTH = 6
export const DISPATCH_PANEL_KIND_WIDTH = 4
export const DISPATCH_PANEL_COST_WIDTH = 7
export const DISPATCH_PANEL_DURATION_WIDTH = 8
/** Title column budget (`◈ Dispatch — <sessão>`). */
export const DISPATCH_PANEL_TITLE_WIDTH = 44
/** Badge appended to the title while the host presents the panel full screen. */
export const DISPATCH_PANEL_FULLSCREEN_BADGE = '[fullscreen]'
/** Columns a row spends before the agent cell, cost column excluded
 *  (2 marker + 1 + 4 kind + 1 + 8 duration). The cost is measured per row
 *  because `<$0.0001` is one cell wider than `DISPATCH_PANEL_COST_WIDTH`. */
const DISPATCH_PANEL_ROW_FIXED_WIDTH = 16

/** Human labels of a kind's evidence, as the detail line prints them. */
export const DISPATCH_KIND_ORIGIN_LABELS: Readonly<Record<DispatchKindOrigin, string>> = {
  prefix: 'prefixo',
  agent: 'agente',
  unavailable: 'indisponível',
}

/** Entries in row order: live work first, then most recent activity — the same
 *  comparator the sidebar block uses. Pure. */
export function orderDispatchEntries(entries: readonly DispatchEntry[]): DispatchEntry[] {
  return [...entries].sort((a, b) => compareDelegations(a.view, b.view))
}

/** `◈ Dispatch — <sessão>`, with the session title truncated (never wrapped),
 *  plus the `[fullscreen]` badge while the host presents the panel full screen.
 *  An absent title leaves the marker and the name alone. Pure. */
export function dispatchPanelTitle(
  sessionTitle: string | null | undefined,
  max = DISPATCH_PANEL_TITLE_WIDTH,
  presentation?: string,
): string {
  const base = `${DISPATCH_PANEL_HEADER_MARKER} Dispatch`
  const badge = presentation === 'fullscreen' ? ` ${DISPATCH_PANEL_FULLSCREEN_BADGE}` : ''
  const title = typeof sessionTitle === 'string' ? sessionTitle.trim() : ''
  if (title === '') return `${base}${badge}`
  return `${base} ${DISPATCH_PANEL_DASH} ${truncateLabel(title, Math.max(4, max))}${badge}`
}

/** Header counters: `2 rodando · 70 concluídos · 1 falha · $3.59`. A zero
 *  counter is omitted (never `0 rodando`); the total spend is printed whenever
 *  the tree has a child, because `$0.00` is then a real answer. Null for an
 *  empty tree, so the header renders no counter line at all. Pure. */
export function dispatchPanelHeader(
  entries: readonly DispatchEntry[] | null | undefined,
): string | null {
  const list = Array.isArray(entries) ? entries.filter((entry) => entry?.view) : []
  if (list.length === 0) return null
  let running = 0
  let completed = 0
  let failed = 0
  for (const entry of list) {
    switch (entry.view.state) {
      case 'running':
        running += 1
        break
      case 'completed':
        completed += 1
        break
      case 'failed':
        failed += 1
        break
      default:
        break
    }
  }
  const parts: string[] = []
  if (running > 0) parts.push(`${running} rodando`)
  if (completed > 0) parts.push(`${completed} ${completed === 1 ? 'concluído' : 'concluídos'}`)
  if (failed > 0) parts.push(`${failed} ${failed === 1 ? 'falha' : 'falhas'}`)
  const cost = formatSpendUSD(dispatchTotalCost(list.map((entry) => entry.view)))
  if (cost !== null) parts.push(cost)
  return parts.length === 0 ? null : parts.join(SPEND_LINE_SEPARATOR)
}

/** Horizontal rule under the header, clamped to the panel's own width. Pure. */
export function dispatchPanelRule(width: number, max = 200): string {
  const columns = Math.max(0, Math.min(max, Math.floor(numberOrNull(width) ?? 0)))
  return DISPATCH_PANEL_RULE_CHAR.repeat(columns)
}

/** Row marker: animated spinner while running, `✓` done, `✗` failed, `○`
 *  cancelled/interrupted, `?` for a state the host never publishes. Every glyph
 *  is one cell wide and `?` is the only fallback, so an unknown state is visible
 *  instead of silently rendering as success. Pure. */
export function dispatchPanelMarker(state: DelegationState | string, frame = 0): string {
  switch (state) {
    case 'running':
      return `${spinnerFrame(frame)} `
    case 'completed':
      return '\u2713 '
    case 'failed':
      return '\u2717 '
    case 'interrupted':
      return '\u25CB '
    default:
      return '? '
  }
}

/** One padded, truncated cell: an absent/blank value becomes the em dash, and
 *  the value is cut to the cell's own width (never to the line's length, so one
 *  long cell cannot squeeze its neighbours out of alignment). Pure. */
export function dispatchPanelCell(value: unknown, width: number): string {
  const cells = Math.max(1, Math.floor(numberOrNull(width) ?? 1))
  const text = typeof value === 'string' ? value.trim() : ''
  return padCell(text === '' ? DISPATCH_PANEL_DASH : text, cells)
}

/** One list row: `⠋ prometheus   plan   $0.09  14m34s`. The agent cell absorbs
 *  the width difference (down to `DISPATCH_PANEL_MIN_AGENT_WIDTH`), so a narrow
 *  panel truncates the label rather than the numbers; the cost column grows by
 *  itself for a sub-cent value so the row never spends more than its budget.
 *  Pure. */
export function dispatchPanelRowText(
  entry: DispatchEntry,
  options: { now?: number; frame?: number; max?: number } = {},
): string {
  const view = entry?.view
  if (!view) return ''
  const now = numberOrNull(options.now) ?? Date.now()
  const frame = numberOrNull(options.frame) ?? 0
  const width = Math.floor(numberOrNull(options.max) ?? 35)
  const costText = formatDispatchCost(view.cost)
  const costWidth = Math.max(DISPATCH_PANEL_COST_WIDTH, cellWidth(costText))
  const agentWidth = Math.max(
    DISPATCH_PANEL_MIN_AGENT_WIDTH,
    Math.min(DISPATCH_PANEL_AGENT_WIDTH, width - (DISPATCH_PANEL_ROW_FIXED_WIDTH + costWidth)),
  )
  const marker = dispatchPanelMarker(view.state, frame)
  const agent = dispatchPanelCell(dispatchAgentText(view, DISPATCH_PANEL_AGENT_WIDTH), agentWidth)
  const kind = dispatchPanelCell(view.kind, DISPATCH_PANEL_KIND_WIDTH)
  const cost = costText.padStart(costWidth)
  const duration = truncateLabel(
    dispatchElapsed(view, now),
    DISPATCH_PANEL_DURATION_WIDTH,
  ).padStart(DISPATCH_PANEL_DURATION_WIDTH)
  return `${marker}${agent} ${kind} ${cost}${duration}`
}

/** `ses_ab12cd`, short enough for a detail line. Full id when it already fits. */
export function shortSessionID(id: string | null | undefined, max = 10): string {
  const text = typeof id === 'string' ? id.trim() : ''
  if (text === '') return DISPATCH_PANEL_DASH
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}\u2026`
}

/** Token counters of one child on a single line (`in 1.2K · out 430 · r 120 ·
 *  cache 8K/1K`), or `tokens —` when the host published none. Pure. */
export function dispatchTokenLine(tokens: DispatchTokens | null | undefined): string {
  if (!tokens) return `tokens ${DISPATCH_PANEL_DASH}`
  const value = (token: number | null) =>
    token === null ? DISPATCH_PANEL_DASH : (formatContextWindow(token) ?? String(token))
  return [
    `in ${value(tokens.input)}`,
    `out ${value(tokens.output)}`,
    `r ${value(tokens.reasoning)}`,
    `cache ${value(tokens.cacheRead)}/${value(tokens.cacheWrite)}`,
  ].join(SPEND_LINE_SEPARATOR)
}

/** Detail lines of the selected child: heading (title, else the spawning
 *  description, else the row label), short id + model, token counters, and the
 *  kind plus its evidence and the parent id. Two to four lines; `expanded:
 *  false` keeps only the heading. Every missing datum prints `—`. Pure. */
export function dispatchPanelDetail(
  entry: DispatchEntry | null | undefined,
  options: { expanded?: boolean; max?: number } = {},
): string[] {
  if (!entry?.view) return [DISPATCH_PANEL_DASH]
  const max = Math.max(8, Math.floor(numberOrNull(options.max) ?? 60))
  const view = entry.view
  const heading =
    entry.title ??
    entry.description ??
    (typeof view.label === 'string' && view.label !== '' ? view.label : null) ??
    view.id
  const lines = [truncateLabel(heading, max)]
  if (options.expanded === false) return lines
  lines.push(
    truncateLabel(
      `${shortSessionID(view.id)}${SPEND_LINE_SEPARATOR}${view.model ?? DISPATCH_PANEL_DASH}`,
      max,
    ),
  )
  lines.push(truncateLabel(dispatchTokenLine(entry.tokens), max))
  const origin =
    DISPATCH_KIND_ORIGIN_LABELS[view.kindOrigin] ?? DISPATCH_KIND_ORIGIN_LABELS.unavailable
  lines.push(
    truncateLabel(
      `kind ${view.kind ?? DISPATCH_PANEL_DASH} (${origin})${SPEND_LINE_SEPARATOR}parent ${entry.parentID ?? DISPATCH_PANEL_DASH}`,
      max,
    ),
  )
  return lines
}

/** Panel geometry for its input width: wide (≥72) puts the detail in a second
 *  column, narrow stacks it under the list. `rowWidth` is what a list row may
 *  spend after the selection gutter. Pure. */
export type DispatchPanelLayout = {
  mode: 'wide' | 'narrow'
  listWidth: number
  detailWidth: number
  rowWidth: number
}

export function dispatchPanelLayout(width: number): DispatchPanelLayout {
  const columns = Math.max(20, Math.floor(numberOrNull(width) ?? 0))
  if (columns >= DISPATCH_PANEL_WIDE_MIN_WIDTH) {
    const listWidth = Math.max(40, Math.min(64, columns - 26))
    return {
      mode: 'wide',
      listWidth,
      detailWidth: Math.max(24, columns - listWidth - 2),
      rowWidth: listWidth - DISPATCH_PANEL_SELECTION_GUTTER,
    }
  }
  return {
    mode: 'narrow',
    listWidth: columns,
    detailWidth: columns,
    rowWidth: columns - DISPATCH_PANEL_SELECTION_GUTTER,
  }
}

/** Viewport of the list: the page holding the selection, scrolled so the
 *  selected row stays visible with its predecessors. Bounded, so a 71-child
 *  tree renders ten rows, never all of them. Pure. */
export function dispatchPanelWindow(
  total: number,
  selectedIndex: number,
  pageSize = DISPATCH_PANEL_PAGE_SIZE,
): { start: number; end: number; size: number } {
  const count = Math.max(0, Math.floor(numberOrNull(total) ?? 0))
  const size = Math.max(1, Math.floor(numberOrNull(pageSize) ?? DISPATCH_PANEL_PAGE_SIZE))
  if (count === 0) return { start: 0, end: 0, size }
  const index = Math.min(count - 1, Math.max(0, Math.floor(numberOrNull(selectedIndex) ?? 0)))
  const start = Math.min(Math.max(0, index - size + 1), Math.max(0, count - size))
  return { start, end: Math.min(count, start + size), size }
}

/** `1-10 de 71` while the list is longer than one page; null when everything
 *  fits (and for an empty list), so the footer never pads itself. Pure. */
export function dispatchPanelRangeText(start: number, end: number, total: number): string | null {
  const count = Math.max(0, Math.floor(numberOrNull(total) ?? 0))
  const first = Math.max(0, Math.floor(numberOrNull(start) ?? 0))
  const last = Math.min(count, Math.floor(numberOrNull(end) ?? 0))
  if (count === 0 || (first === 0 && last >= count)) return null
  return `${first + 1}-${last} de ${count}`
}

/** One rendered list row, selection resolved by the view against the model's
 *  selected id. */
export type DispatchPanelRow = { id: string; state: DelegationState; text: string }

/** Every entry as a row, ordered by the shared comparator. Pure. */
export function dispatchPanelRows(
  entries: readonly DispatchEntry[] | null | undefined,
  options: { now?: number; frame?: number; max?: number } = {},
): DispatchPanelRow[] {
  const list = Array.isArray(entries)
    ? entries.filter((entry) => entry?.view && typeof entry.view.id === 'string')
    : []
  return orderDispatchEntries(list).map((entry) => ({
    id: entry.view.id,
    state: entry.view.state,
    text: dispatchPanelRowText(entry, options),
  }))
}

/** Panel action, one per command. */
export type DispatchPanelAction =
  | 'up'
  | 'down'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'
  | 'toggle'
  | 'fullscreen'
  | 'close'

/** One namespaced command: stable id, explicit binding, and the action it runs. */
export type DispatchPanelCommandSpec = {
  action: DispatchPanelAction
  id: string
  title: string
  bind: string
}

/** The panel's whole keymap, in table order. `bind` is explicit for every
 *  command (no auto-binding), and every id is namespaced, so a `k`/`q`/`f`
 *  binding can never collide with the host's own keys. */
export const DISPATCH_PANEL_COMMANDS: readonly DispatchPanelCommandSpec[] = [
  {
    action: 'up',
    id: 'pantheon.dispatch.up',
    title: 'Dispatch: selecionar anterior',
    bind: 'k,up',
  },
  {
    action: 'down',
    id: 'pantheon.dispatch.down',
    title: 'Dispatch: selecionar próxima',
    bind: 'j,down',
  },
  { action: 'home', id: 'pantheon.dispatch.home', title: 'Dispatch: primeira', bind: 'home' },
  { action: 'end', id: 'pantheon.dispatch.end', title: 'Dispatch: última', bind: 'end' },
  {
    action: 'pageup',
    id: 'pantheon.dispatch.pageup',
    title: 'Dispatch: página acima',
    bind: 'pageup',
  },
  {
    action: 'pagedown',
    id: 'pantheon.dispatch.pagedown',
    title: 'Dispatch: página abaixo',
    bind: 'pagedown',
  },
  {
    action: 'toggle',
    id: 'pantheon.dispatch.toggle',
    title: 'Dispatch: expandir detalhe',
    bind: 'enter',
  },
  {
    action: 'fullscreen',
    id: 'pantheon.dispatch.fullscreen',
    title: 'Dispatch: tela cheia',
    bind: 'f',
  },
  { action: 'close', id: 'pantheon.dispatch.close', title: 'Dispatch: fechar', bind: 'escape,q' },
]

/** Run one action against the model and the host-owned panel input. Kept apart
 *  from the keymap so the whole command surface is testable without a renderer.
 */
export function performDispatchPanelAction(
  action: DispatchPanelAction,
  model: Pick<DispatchPanelModel, 'move' | 'first' | 'last' | 'pageUp' | 'pageDown' | 'toggle'>,
  panel: Pick<PanelInput, 'close' | 'toggleFullscreen'>,
): void {
  switch (action) {
    case 'up':
      model.move(-1)
      return
    case 'down':
      model.move(1)
      return
    case 'home':
      model.first()
      return
    case 'end':
      model.last()
      return
    case 'pageup':
      model.pageUp()
      return
    case 'pagedown':
      model.pageDown()
      return
    case 'toggle':
      model.toggle()
      return
    case 'fullscreen':
      panel.toggleFullscreen()
      return
    case 'close':
      panel.close()
      return
    default:
      return
  }
}

/** Footer: the keys the host reports for each command (`keymap.shortcuts`) with
 *  an em dash whenever a command has no binding, so the hint can never advertise
 *  a key that does nothing. Pure. */
export function dispatchPanelFooter(shortcutsOf: (id: string) => readonly string[]): string {
  const keys = (id: string): string => {
    let list: readonly string[] = []
    try {
      const result = shortcutsOf(id)
      list = Array.isArray(result) ? result : []
    } catch {
      list = []
    }
    const text = list
      .map((key) => String(key ?? '').trim())
      .filter((key) => key !== '')
      .join('/')
    return text === '' ? DISPATCH_PANEL_DASH : text
  }
  return [
    `${keys('pantheon.dispatch.up')} ${keys('pantheon.dispatch.down')} mover`,
    `${keys('pantheon.dispatch.toggle')} detalhe`,
    `${keys('pantheon.dispatch.fullscreen')} fullscreen`,
    `${keys('pantheon.dispatch.close')} fechar`,
  ].join(SPEND_LINE_SEPARATOR)
}

/** The subset of `PanelInput` the model reads, so tests can drive it with a
 *  plain object. */
export type DispatchPanelInput = {
  readonly name: string
  readonly sessionID: string
  readonly width: number
  readonly presentation?: string
}

/** `keymap.shortcuts` of one command; empty when the keymap is unavailable. */
function keymapShortcuts(context: any, id: string): readonly string[] {
  try {
    const list = context?.keymap?.shortcuts?.(id)
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** Open the panel from the command palette / slash command. `ui.panel.open`
 *  only accepts a `session` route, so a refusal (no session open) is answered
 *  with a toast — never a fallback route, never a silent no-op. Returns whether
 *  the panel opened. */
export function openDispatchPanel(context: any): boolean {
  let opened = false
  try {
    opened = context?.ui?.panel?.open?.(DISPATCH_PANEL_NAME) === true
  } catch {
    opened = false
  }
  if (opened) return true
  try {
    context?.ui?.toast?.show?.({ message: DISPATCH_PANEL_TOAST, variant: 'warning' })
  } catch {
    /* toast unavailable — the command still degrades to a no-op */
  }
  return false
}

/** Reactive state the panel view renders. Selection is held by session id, so
 *  it survives list updates; the index is derived (and falls back to the first
 *  row when the selected child disappears). */
export type DispatchPanelModel = {
  entries: Accessor<DispatchEntry[]>
  rows: Accessor<DispatchPanelRow[]>
  title: Accessor<string>
  header: Accessor<string | null>
  detail: Accessor<string[]>
  layout: Accessor<DispatchPanelLayout>
  visible: Accessor<{ start: number; rows: DispatchPanelRow[] }>
  selectedID: Accessor<string | null>
  selectedIndex: Accessor<number>
  expanded: Accessor<boolean>
  hasRunning: Accessor<boolean>
  frame: Accessor<number>
  footer: Accessor<string>
  move: (delta: number) => void
  first: () => void
  last: () => void
  pageUp: () => void
  pageDown: () => void
  toggle: () => void
}

/** Model behind the panel. Mounted only while the panel claim renders (the
 *  `Show` in `session.panel`), so the 80 ms tick it arms exists exactly while
 *  the panel is open; it also stops on `isOpen()` going false and on dispose.
 *  It performs no `message.sync`, writes no `session.metadata` and makes no
 *  request: `collectDispatch` reads only host-cached state. */
export function createDispatchPanelModel(
  context: any,
  panel: () => DispatchPanelInput,
): DispatchPanelModel {
  const [revision, setRevision] = createSignal(0)
  const [frame, setFrame] = createSignal(0)
  const [expanded, setExpanded] = createSignal(true)
  const [selectedID, setSelectedID] = createSignal<string | null>(null)

  const isOpen = () => panel().name === DISPATCH_PANEL_NAME
  const activeSessionID = () => {
    const id = panel().sessionID
    return isValidSessionID(id) ? id : ''
  }

  const entries = createMemo(() => {
    revision()
    if (!isOpen()) return []
    return collectDispatch(context, activeSessionID())
  })

  const layout = createMemo(() => dispatchPanelLayout(panel().width))

  const rows = createMemo(() => {
    const mode = layout()
    return dispatchPanelRows(entries(), {
      now: Date.now(),
      frame: frame(),
      max: mode.rowWidth,
    })
  })

  const selectedIndex = createMemo(() => {
    const list = rows()
    if (list.length === 0) return 0
    const id = selectedID()
    if (id === null) return 0
    const index = list.findIndex((row) => row.id === id)
    return index === -1 ? 0 : index
  })

  const selectedIDAccessor = createMemo(() => rows()[selectedIndex()]?.id ?? null)
  const selectedEntry = createMemo(() => entries()[selectedIndex()] ?? null)

  const session = createMemo(() => {
    revision()
    const id = activeSessionID()
    if (id === '') return undefined
    try {
      return context.data.session.get(id)
    } catch {
      return undefined
    }
  })

  const title = createMemo(() =>
    dispatchPanelTitle(session()?.title, DISPATCH_PANEL_TITLE_WIDTH, panel().presentation),
  )
  const header = createMemo(() => dispatchPanelHeader(entries()))
  const detail = createMemo(() =>
    dispatchPanelDetail(selectedEntry(), {
      expanded: expanded(),
      max: layout().detailWidth,
    }),
  )

  const visible = createMemo(() => {
    const list = rows()
    const window = dispatchPanelWindow(list.length, selectedIndex())
    return { start: window.start, rows: list.slice(window.start, window.end) }
  })

  const hasRunning = createMemo(() => rows().some((row) => row.state === 'running'))

  const footer = createMemo(() => {
    const list = rows()
    const window = dispatchPanelWindow(list.length, selectedIndex())
    const range = dispatchPanelRangeText(window.start, window.end, list.length)
    const hints = dispatchPanelFooter((id) => keymapShortcuts(context, id))
    return range === null ? hints : `${range}${SPEND_LINE_SEPARATOR}${hints}`
  })

  const select = (index: number) => {
    const list = rows()
    if (list.length === 0) return
    const clamped = Math.min(list.length - 1, Math.max(0, Math.round(index)))
    setSelectedID(list[clamped]?.id ?? null)
  }

  onMount(() => {
    onCleanup(subscribeSidebarRefresh(context, () => setRevision((value) => value + 1)))
  })

  // Spinner ticks only while the panel is open *and* a child runs; closing the
  // panel, the last child finishing or the component unmounting all clear it.
  createEffect(() => {
    if (!isOpen() || !hasRunning()) return
    const spinner = setInterval(() => setFrame((value) => value + 1), SPINNER_INTERVAL_MS)
    onCleanup(() => clearInterval(spinner))
  })

  return {
    entries,
    rows,
    title,
    header,
    detail,
    layout,
    visible,
    selectedID: selectedIDAccessor,
    selectedIndex,
    expanded,
    hasRunning,
    frame,
    footer,
    move: (delta: number) => select(selectedIndex() + (numberOrNull(delta) ?? 0)),
    first: () => select(0),
    last: () => select(rows().length - 1),
    pageUp: () => select(selectedIndex() - DISPATCH_PANEL_PAGE_SIZE),
    pageDown: () => select(selectedIndex() + DISPATCH_PANEL_PAGE_SIZE),
    toggle: () => setExpanded((value) => !value),
  }
}

/** Session ids to eagerly sync at load (deduped, bounded). Pure. */
export function collectWarmupTargets(
  sessions: readonly any[],
  limit = WARMUP_SESSION_LIMIT,
): string[] {
  const ids: string[] = []
  for (const session of sessions) {
    if (!isValidSessionID(session?.id) || ids.includes(session.id)) continue
    ids.push(session.id)
    if (ids.length >= limit) break
  }
  return ids
}

/* ─── Known Issue guard ──────────────────────────────────── */

/** Body a sidebar instance renders when the host has not published a real
 *  session id yet. OpenCode V2 scopes the `sidebar.content` slot to a session
 *  (`SlotMap["sidebar.content"] = { sessionID: string }`), so before the first
 *  prompt the slot may not mount at all — see the `home.footer.status`
 *  contribution for the pre-prompt degradation. Pure. */
export function sidebarPlaceholder(sessionID: string | undefined): string | null {
  return isValidSessionID(sessionID) ? null : SIDEBAR_WAITING_LABEL
}

/* ─── Click-through ──────────────────────────────────────── */

/** Navigate to a session through the V2 router. Fail-open: an absent router or
 *  a removed session must never break the sidebar. Returns whether a valid
 *  navigation was dispatched. Pure. */
export function navigateToSession(
  router: { navigate?: (destination: any) => void } | undefined,
  sessionID: string | undefined,
): boolean {
  if (typeof router?.navigate !== 'function' || !isValidSessionID(sessionID)) return false
  try {
    router.navigate({ type: 'session', sessionID })
    return true
  } catch {
    return false
  }
}

/* ─── Delegate-completion detection (toasts) ─────────────── */

export type DelegationCompletion = { id: string; label: string; state: DelegationState }

/** Diff two delegation observations: entries that were `running` and are no
 *  longer running count as completions, fired once per transition. Returns the
 *  next snapshot so callers can keep a single tracker. First observation never
 *  reports a completion (no toast spam on mount). Pure. */
export function detectDelegationCompletions(
  previous: ReadonlyMap<string, DelegationState>,
  current: ReadonlyArray<DelegationCompletion>,
): { completed: DelegationCompletion[]; snapshot: Map<string, DelegationState> } {
  const snapshot = new Map<string, DelegationState>()
  const completed: DelegationCompletion[] = []
  for (const entry of current) {
    snapshot.set(entry.id, entry.state)
    if (previous.get(entry.id) === 'running' && entry.state !== 'running') completed.push(entry)
  }
  return { completed, snapshot }
}

/* ─── Runtime helpers ────────────────────────────────────── */

function resolveLocation(context: any): any {
  try {
    return context?.location ?? context?.data?.location?.default()
  } catch {
    return undefined
  }
}

function resolveSidebarCwd(context: any): string {
  const location = resolveLocation(context)
  if (location && typeof location.directory === 'string' && location.directory !== '') {
    return location.directory
  }
  return process.cwd()
}

function sessionStatusOf(context: any, sessionID: string): string | undefined {
  try {
    const status = context?.data?.session?.status?.(sessionID)
    return typeof status === 'string' ? status : undefined
  } catch {
    return undefined
  }
}

/** Subscribe `refresh` to every V2 event that can change sidebar state. Returns
 *  a disposer that releases exactly the subscriptions the host handed out. The
 *  event names come from the V2 union; the cast turns an unknown name into a
 *  compile error instead of a silent no-op subscription. */
function subscribeSidebarRefresh(context: any, refresh: () => void): () => void {
  const stop: Array<() => void> = []
  const data = context?.data as Context['data'] | undefined
  if (typeof data?.on === 'function') {
    for (const type of SIDEBAR_REFRESH_EVENTS) {
      try {
        const unsubscribe = data.on(type, refresh)
        if (typeof unsubscribe === 'function') stop.push(unsubscribe)
      } catch {
        // Sidebar stays useful with the initial cached state if an event is unavailable.
      }
    }
  }
  return () => {
    for (const unsubscribe of stop) {
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }
}

/** Populate the cached data at load so the sidebar has content before the first
 *  prompt (Known Issue guard). Fire-and-forget: a missing API or a failed sync
 *  degrades silently and the sidebar still renders its static header. */
function warmUpSidebarData(context: any, location: any): void {
  try {
    void Promise.resolve(context?.data?.location?.vcs?.sync?.(location)).catch(() => {})
  } catch {
    /* vcs API unavailable */
  }
  let listed: any[] = []
  try {
    const result = context?.data?.session?.list?.()
    if (Array.isArray(result)) listed = result
  } catch {
    /* session API unavailable */
  }
  for (const id of collectWarmupTargets(listed)) {
    try {
      void Promise.resolve(context?.data?.session?.sync?.(id)).catch(() => {})
    } catch {
      /* per-session sync unavailable */
    }
  }
}

function showDelegationToast(context: any, done: DelegationCompletion): void {
  const variant =
    done.state === 'failed' ? 'error' : done.state === 'interrupted' ? 'warning' : 'success'
  const verb =
    done.state === 'failed' ? 'falhou' : done.state === 'interrupted' ? 'interrompida' : 'concluída'
  try {
    context?.ui?.toast?.show?.({
      title: TOAST_TITLE,
      message: `${done.label} ${verb}`,
      variant,
      sessionID: done.id,
    })
  } catch {
    /* toast API unavailable — the row already carries the state tone */
  }
}

/** Active preset signal with mount + 30s refresh. Shared by the sidebar and the
 *  home-screen status contribution. */
function useActivePreset(context: any): {
  preset: Accessor<PresetInfo>
  overrides: Accessor<PresetOverrides>
} {
  const [preset, setPreset] = createSignal<PresetInfo>(presetFromEnv(process.env))
  const [overrides, setOverrides] = createSignal<PresetOverrides>(emptyOverrides())
  onMount(() => {
    const cwd = resolveSidebarCwd(context)
    let cancelled = false
    const refresh = async () => {
      try {
        const detail = await resolveActivePresetForTui(process.env, cwd)
        if (!cancelled) {
          setPreset(detail.info)
          setOverrides(detail.overrides)
        }
      } catch {
        /* transient read error — keep the last known value */
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), PRESET_REFRESH_MS)
    onCleanup(() => {
      cancelled = true
      clearInterval(timer)
    })
  })
  return { preset, overrides }
}

/** Debounce for the git file-count revalidation. `vcs.status` is an HTTP call;
 *  session events arrive in bursts, so the row is refreshed at most once per
 *  window instead of on every event. */
export const GIT_CHANGES_DEBOUNCE_MS = 400

/** `context.client.vcs.status(input?, requestOptions?)` →
 *  `Promise<{ data: VcsFileStatus[] }>` (`GET /api/vcs/status`). Returns the
 *  callable or null when the host does not expose it, so callers degrade to
 *  the branch-only row instead of throwing. */
function vcsStatusCall(context: any): ((input?: any) => Promise<any>) | null {
  const status = context?.client?.vcs?.status
  return typeof status === 'function' ? status.bind(context.client.vcs) : null
}

/** `context.client.session.stats(input?, requestOptions?)` →
 *  `Promise<SessionStatsInfo>` (`GET /api/experimental/session/stats`), served
 *  by the local process. Returns the callable or null when the host does not
 *  expose it, so the Context spend line simply does not render. */
function statsCall(context: any): ((input?: any) => Promise<any>) | null {
  const stats = context?.client?.session?.stats
  return typeof stats === 'function' ? stats.bind(context.client.session) : null
}

/** Local IANA zone for the stats call (`America/Sao_Paulo`); omitted when the
 *  runtime cannot resolve one. */
function localTimezone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof zone === 'string' && zone !== '' ? zone : undefined
  } catch {
    return undefined
  }
}

/** Fields every stats call sends. `tools: 'none'` skips the tool aggregation
 *  the block never renders; `project` is omitted (no cheap id in hand) rather
 *  than guessed. */
function statsInput(): Record<string, unknown> {
  const timezone = localTimezone()
  return timezone === undefined ? { tools: 'none' } : { tools: 'none', timezone }
}

/** Convert a millisecond instant to the unit the route accepted. */
function spendInstant(ms: number, unit: SpendUnit): number {
  return unit === 's' ? Math.floor(ms / 1000) : ms
}

/** Measure the `from`/`to` unit once: millisecond epoch first, then a single
 *  seconds attempt. Bounded to two calls and never throws; anything the route
 *  rejects (mismatch, throw, malformed echo) ends as `unavailable`, which hides
 *  the block for the rest of the process instead of retrying forever. */
async function probeSpendUnit(call: (input?: any) => Promise<any>): Promise<SpendUnit> {
  const now = Date.now()
  const fromMs = now - SPEND_PROBE_WINDOW_MS
  const attempts: Array<{ sent: { from: number; to: number }; scale: number; unit: SpendUnit }> = [
    { sent: { from: fromMs, to: now }, scale: 1, unit: 'ms' },
    {
      sent: { from: Math.floor(fromMs / 1000), to: Math.floor(now / 1000) },
      scale: 1000,
      unit: 's',
    },
  ]
  for (const attempt of attempts) {
    try {
      const result = await call({ ...statsInput(), ...attempt.sent })
      if (statsRangeMatches(result?.range, attempt.sent, attempt.scale)) return attempt.unit
    } catch {
      /* route rejected the call in this unit — try the next one, then give up */
    }
  }
  return 'unavailable'
}

/** Resolve (and cache) the unit for this process. Concurrent callers share one
 *  probe, so a burst of refreshes cannot spend more than two calls on it. */
function ensureSpendUnit(call: (input?: any) => Promise<any>): Promise<SpendUnit> {
  if (spendUnit !== null) return Promise.resolve(spendUnit)
  if (spendProbe === null) {
    spendProbe = probeSpendUnit(call).then(
      (unit) => {
        spendUnit = unit
        spendProbe = null
        return unit
      },
      (): SpendUnit => {
        spendUnit = 'unavailable'
        spendProbe = null
        return 'unavailable'
      },
    )
  }
  return spendProbe
}

/* ─── Reactive model ─────────────────────────────────────── */

/** Reactive state the sidebar view renders. Accessors keep the view reactive
 *  while the model itself stays free of JSX, so its effects are exercisable
 *  without a TUI renderer. */
export type SidebarModel = {
  activeSessionID: Accessor<string>
  session: Accessor<any>
  branch: Accessor<string | null>
  /** `+N ±N −N` file counts from `vcs.status` (fallback only), null when
   *  clean/unavailable. */
  gitChanges: Accessor<string | null>
  /** The rendered git row: CLI counts with `?untracked ↑ahead ↓behind` when git
   *  answered, else the `vcs.status` counts, else null. */
  gitLine: Accessor<string | null>
  /** Last successful git CLI observation (counts + upstream distance), null
   *  while git has never answered. */
  gitCli: Accessor<GitCliSnapshot | null>
  /** Cache hit rate + output speed of the active session's newest messages. */
  performance: Accessor<ContextPerformance | null>
  /** The rendered `Dispatch` block: live rows, the finished rollup and the
   *  spend totals. Null when the session has no child (block hidden). */
  dispatch: Accessor<DispatchBlockView | null>
  /** Blocks that have content, in render order, each tagged with its spacer. */
  blocks: Accessor<SidebarBlock[]>
  hasRunning: Accessor<boolean>
  frame: Accessor<number>
  preset: Accessor<PresetInfo>
  /** Provider of the model in use, derived from the session, its transcript or
   *  the host location; null when nothing resolves (the header omits it). */
  provider: Accessor<string | null>
  /** Resolved preset override map (explicit per-agent models). */
  presetOverrides: Accessor<PresetOverrides>
  /** Family cost in USD (root + delegations), null when the host cannot answer. */
  cost: Accessor<number | null>
  /** Real per-model totals from assistant messages, capped for the sidebar. */
  modelUsage: Accessor<ModelUsageCeiling>
  /** Todo rows derived from the newest completed `todowrite`, ordered + capped. */
  todo: Accessor<TodoCeiling>
  /** Local spend for `hoje` / `30d`, null when stats is unavailable/unknown.
   *  Rendered as the Context block's last line, not as its own block. */
  spend: Accessor<SpendTotals | null>
  /** Context gauge; null when there is no limit or no token-carrying message. */
  contextUsage: Accessor<ContextUsage | null>
  /** Current agent and its resolved short model id (`*` = explicit override). */
  agentModel: Accessor<{ agent: string; model: string; overridden: boolean } | null>
}

/** Reactive wiring behind the sidebar: refresh subscription, warm syncs, the
 *  running-only spinner and the completion-toast effect. `context` stays loosely
 *  typed (the host API only exists at runtime) but the refresh event names are
 *  narrowed to the V2 union at the subscription site. */
export function createSidebarModel(
  context: any,
  sessionID: () => string | undefined,
  gitExec: GitExec = defaultGitExec,
): SidebarModel {
  const [revision, setRevision] = createSignal(0)
  const [metricsRevision, setMetricsRevision] = createSignal(0)
  const [frame, setFrame] = createSignal(0)
  const location = resolveLocation(context)
  const activePreset = useActivePreset(context)
  const preset = activePreset.preset
  const presetOverrides = activePreset.overrides
  let observedStates = new Map<string, DelegationState>()
  let metricsDebounce: ReturnType<typeof setTimeout> | undefined

  // Model rows walk the family's message lists, so they are coalesced instead
  // of recomputed on every event in a burst (the host publishes many per step).
  const scheduleMetrics = () => {
    if (metricsDebounce !== undefined) clearTimeout(metricsDebounce)
    metricsDebounce = setTimeout(() => {
      metricsDebounce = undefined
      setMetricsRevision((value) => value + 1)
    }, MODEL_USAGE_DEBOUNCE_MS)
  }
  const refresh = () => {
    setRevision((value) => value + 1)
    scheduleMetrics()
  }
  const activeSessionID = () => {
    const id = sessionID()
    return isValidSessionID(id) ? id : ''
  }

  const session = createMemo(() => {
    revision()
    const id = activeSessionID()
    if (id === '') return undefined
    try {
      return context.data.session.get(id)
    } catch {
      /* session API unavailable */
      return undefined
    }
  })

  const branch = createMemo(() => {
    revision()
    try {
      return context.data.location.vcs.info(location)?.branch?.current ?? null
    } catch {
      /* vcs API unavailable */
      return null
    }
  })

  // Git file counts: the git CLI first (it is the only source for untracked and
  // ahead/behind), with `client.vcs.status` as the fallback when git is missing
  // or fails. The CLI probe runs at mount and on session events, behind a
  // debounce, a 5 s cooldown and a single-flight guard — no polling timer, no
  // queue. `vcs.status` is only queried while the CLI has never answered.
  // Both git signals are keyed by the session they were read for: the host
  // reuses one sidebar instance across routes, so a value observed for one
  // session must never be read as if it belonged to the next one.
  type GitChangesRead = { session: string; text: string | null }
  type GitCliRead = { session: string; snapshot: GitCliSnapshot | null }
  const [gitChangesRead, setGitChangesRead] = createSignal<GitChangesRead>({
    session: activeSessionID(),
    text: null,
  })
  const [gitCliRead, setGitCliRead] = createSignal<GitCliRead>({
    session: activeSessionID(),
    snapshot: null,
  })
  const gitChanges = createMemo(() => {
    const read = gitChangesRead()
    return read.session === activeSessionID() ? read.text : null
  })
  const gitCli = createMemo(() => {
    const read = gitCliRead()
    return read.session === activeSessionID() ? read.snapshot : null
  })
  let gitRequest = 0
  let gitDebounce: ReturnType<typeof setTimeout> | undefined
  let gitProbeDebounce: ReturnType<typeof setTimeout> | undefined
  let gitProbeSessionID = activeSessionID()
  let gitProbeStartedAt: number | null = null
  let gitProbeInFlight = false
  let disposed = false
  const loadGitChanges = async () => {
    const status = vcsStatusCall(context)
    if (status === null) return
    const session = activeSessionID()
    const request = ++gitRequest
    try {
      const result = await status({ location: { directory: resolveSidebarCwd(context) } })
      // Superseded by a newer request, or by a session switch.
      if (request !== gitRequest || session !== activeSessionID()) return
      const files = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : []
      setGitChangesRead({ session, text: formatGitChanges(files) })
    } catch {
      /* vcs.status unavailable or failed — keep the previous counts */
    }
  }
  const runGitProbe = async () => {
    const session = activeSessionID()
    // A different session invalidates the previous 5 s cooldown and any flight
    // started for the old one: the new directory is probed right away instead
    // of waiting out a window observed elsewhere.
    if (session !== gitProbeSessionID) {
      gitProbeSessionID = session
      gitProbeStartedAt = null
      gitProbeInFlight = false
    }
    if (
      !gitProbeAllowed({
        now: Date.now(),
        lastRunAt: gitProbeStartedAt,
        inFlight: gitProbeInFlight,
      })
    ) {
      return // cooldown or a probe still running — no queue, skip this one
    }
    gitProbeInFlight = true
    gitProbeStartedAt = Date.now()
    try {
      const snapshot = await readGitSnapshot(resolveSidebarCwd(context), gitExec)
      // A result read for another session must not land on this one.
      if (!disposed && session === activeSessionID()) setGitCliRead({ session, snapshot })
    } catch {
      /* git CLI unavailable — the vcs.status fallback stays in charge */
    } finally {
      if (session === gitProbeSessionID) gitProbeInFlight = false
    }
  }
  const scheduleGitChanges = () => {
    if (vcsStatusCall(context) === null) return
    if (gitCli() !== null) return // the CLI is authoritative once it answered
    if (gitDebounce !== undefined) clearTimeout(gitDebounce)
    gitDebounce = setTimeout(() => {
      gitDebounce = undefined
      void loadGitChanges()
    }, GIT_CHANGES_DEBOUNCE_MS)
  }
  const scheduleGitProbe = () => {
    if (gitProbeDebounce !== undefined) clearTimeout(gitProbeDebounce)
    gitProbeDebounce = setTimeout(() => {
      gitProbeDebounce = undefined
      void runGitProbe()
    }, GIT_CLI_DEBOUNCE_MS)
  }
  // One rendered git line. A CLI snapshot wins even when it is clean (the
  // protocol fallback is not consulted then); `vcs.status` is used only while
  // the CLI has never answered.
  const gitLine = createMemo(() => {
    const snapshot = gitCli()
    if (snapshot !== null) return formatGitSnapshot(snapshot)
    return gitChanges()
  })

  // A session switch discards the previous observations (both git accessors are
  // session-keyed, so a late answer is unreadable rather than merely ignored) and
  // asks both sources again immediately: the new directory never waits out the
  // cooldown observed for the old one. Observations kept by the completion toast
  // are dropped by that effect's own session guard.
  createEffect(
    on(
      activeSessionID,
      (id) => {
        if (disposed || id === '') return
        void runGitProbe()
        void loadGitChanges()
      },
      { defer: true },
    ),
  )

  // Spend reads the local server's own aggregate (`session.stats`): two calls
  // per refresh, one per window, in parallel. Never a provider request, never a
  // credential read, never an interval. The `from`/`to` unit is measured by a
  // single probe at mount (see `probeSpendUnit`); while it is unresolved or
  // unavailable the Context footer line stays hidden. A failed window keeps its
  // last good value, so a partial failure still renders the other window.
  const [spend, setSpend] = createSignal<SpendTotals | null>(null)
  let spendTotals: SpendTotals = { today: null, thirtyDays: null }
  let spendRequest = 0
  let spendDebounce: ReturnType<typeof setTimeout> | undefined
  const loadSpend = async () => {
    const stats = statsCall(context)
    if (stats === null) return
    try {
      const unit = await ensureSpendUnit(stats)
      if (unit === 'unavailable') return
      const request = ++spendRequest
      const windows = spendWindows(Date.now())
      const settled = await Promise.allSettled([
        stats({
          ...statsInput(),
          from: spendInstant(windows.today.from, unit),
          to: spendInstant(windows.today.to, unit),
        }),
        stats({
          ...statsInput(),
          from: spendInstant(windows.thirtyDays.from, unit),
          to: spendInstant(windows.thirtyDays.to, unit),
        }),
      ])
      if (request !== spendRequest) return // superseded by a newer refresh
      const next: SpendTotals = { ...spendTotals }
      for (const [index, key] of (['today', 'thirtyDays'] as const).entries()) {
        const result = settled[index]
        if (result === undefined || result.status !== 'fulfilled') continue
        const cost = statsCost(result.value)
        if (cost === null) continue // malformed/negative — keep the last good value
        next[key] = cost
      }
      spendTotals = next
      setSpend(next)
    } catch {
      /* experimental route gone — keep the last good values (block hidden if none) */
    }
  }
  const scheduleSpend = () => {
    if (statsCall(context) === null) return
    if (spendDebounce !== undefined) clearTimeout(spendDebounce)
    spendDebounce = setTimeout(() => {
      spendDebounce = undefined
      void loadSpend()
    }, SPEND_REFRESH_DEBOUNCE_MS)
  }

  // Messages feed the context gauge. `message.list` is synchronous and returns
  // the host's cached list; a missing API degrades to an empty window.
  const messages = createMemo(() => {
    revision()
    const id = activeSessionID()
    if (id === '') return []
    try {
      const result = context.data.session.message?.list?.(id)
      return Array.isArray(result) ? result : []
    } catch {
      return []
    }
  })

  // Root + delegation sessions, deduped and bounded. `family()` returns ids
  // (not SessionInfo), so each child is resolved through `session.get`.
  const familySessionIDs = createMemo(() => {
    revision()
    const id = activeSessionID()
    if (id === '') return []
    const ids = [id]
    try {
      const result = context.data.session.family?.(id)
      if (Array.isArray(result)) {
        for (const childID of result) {
          if (!isValidSessionID(childID) || ids.includes(childID)) continue
          ids.push(childID)
          if (ids.length >= MODEL_USAGE_SESSION_LIMIT) break
        }
      }
    } catch {
      /* family API unavailable — the root session still contributes */
    }
    return ids
  })

  // One `message.list` call per family session feeds the real per-model
  // aggregate and the Todo block: the newest completed `todowrite` of the
  // *active* session is captured inside the same walk (a child's list is not
  // this sidebar's todo). `message.list` is the host's cached list, so this is a
  // single fetch/scan per refresh, never one per block. Each session contributes
  // at most MODEL_USAGE_MESSAGE_LIMIT entries, which keeps the walk O(limit) per
  // update.
  const transcript = createMemo(() => {
    metricsRevision()
    const rootID = activeSessionID()
    const collected: any[] = []
    let todo: TodoItem[] = []
    for (const id of familySessionIDs()) {
      let list: any[] = []
      try {
        const result = context.data.session.message?.list?.(id)
        if (Array.isArray(result)) list = result
      } catch {
        /* one unreadable session must not hide the others */
      }
      collected.push(...list.slice(-MODEL_USAGE_MESSAGE_LIMIT))
      if (id === rootID) todo = latestTodoItems(list) ?? []
    }
    return { messages: collected, todo }
  })
  const usageMessages = createMemo(() => transcript().messages)
  // Ordered + capped todo rows; empty when the transcript has no `todowrite`,
  // so the block stays hidden.
  const todo = createMemo(() => ceilingTodoItems(transcript().todo, TODO_VISIBLE_CEILING))

  // Session cost is the host's authoritative number for the session; while a
  // session is live it already includes every assistant message. Summing the
  // family gives the true spend of the delegation tree. When no cost API is
  // reachable, the real message costs (never a price-table estimate) are the
  // fallback.
  const messageCostTotal = createMemo(() => {
    let total = 0
    for (const message of usageMessages()) {
      if (message?.type !== 'assistant') continue
      const cost = numberOrNull(message.cost)
      if (cost !== null && cost > 0) total += cost
    }
    return total
  })

  const cost = createMemo(() => {
    revision()
    const ids = familySessionIDs()
    if (ids.length === 0) return null
    let total = 0
    let found = false
    for (const id of ids) {
      let value: unknown
      try {
        value = context.data.session.cost?.(id)
      } catch {
        value = undefined
      }
      let resolved = numberOrNull(value)
      if (resolved === null) {
        try {
          resolved = numberOrNull(context.data.session.get(id)?.cost)
        } catch {
          resolved = null
        }
      }
      if (resolved !== null && resolved >= 0) {
        total += resolved
        found = true
      }
    }
    if (found) {
      // The session cost is authoritative, but a host that has not recorded it
      // yet can still expose real message costs. Never show $0.00 next to
      // positive model rows; take the larger real number, never a price table.
      return Math.max(total, messageCostTotal())
    }
    const fallback = messageCostTotal()
    return fallback > 0 ? fallback : null
  })

  const modelUsage = createMemo(() => {
    metricsRevision()
    return ceilingModelUsage(collectModelUsage(usageMessages()), MODEL_USAGE_VISIBLE_CEILING)
  })

  // Resolved model reference: the session's own model first, then the agent's
  // configured model from the host, with the preset override as the last word.
  const modelRefs = createMemo(() => {
    revision()
    const current = session()
    const agent = typeof current?.agent === 'string' && current.agent !== '' ? current.agent : ''
    let agentRef: unknown
    if (agent !== '') {
      try {
        const agents = context.data.location?.agent?.list?.(location)
        if (Array.isArray(agents)) agentRef = agents.find((entry) => entry?.id === agent)?.model
      } catch {
        /* agent list unavailable */
      }
    }
    const override = agent === '' ? undefined : presetOverrides().agents[agent]?.model
    return {
      agent,
      sessionRef: current?.model,
      agentRef,
      override: typeof override === 'string' && override !== '' ? override : null,
    }
  })

  const agentModel = createMemo(() => {
    const { agent, sessionRef, agentRef, override } = modelRefs()
    // An explicit preset override is the user's last word, so it is displayed
    // (and starred) ahead of the session/agent reference.
    const model = shortModelID(override) ?? shortModelID(sessionRef) ?? shortModelID(agentRef)
    if (model === null) return null
    return { agent, model, overridden: override !== null }
  })

  // Provider of the model actually in use — derived, never typed: the session's
  // own model, then the newest assistant message from the transcript walk, then
  // the current agent's model in the host location (agent list first, its model
  // list for a bare id). Null when none of them answers, so the header can omit
  // it instead of inventing a name.
  const provider = createMemo(() => {
    revision()
    const fromSession = providerIDFromRef(session()?.model)
    if (fromSession !== null) return fromSession
    const list = messages()
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const message = list[index]
      if (message?.type !== 'assistant') continue
      const fromMessage = providerIDFromRef(message.model)
      if (fromMessage !== null) return fromMessage
    }
    const { agentRef } = modelRefs()
    const fromAgent = providerIDFromRef(agentRef)
    if (fromAgent !== null) return fromAgent
    try {
      return providerIDFromModels(context.data.location?.model?.list?.(location), agentRef)
    } catch {
      /* model list unavailable */
      return null
    }
  })

  const contextUsage = createMemo(() => {
    const list = messages()
    if (list.length === 0) return null
    const refs = modelRefs()
    const lastAssistant = [...list]
      .reverse()
      .find((message) => message?.type === 'assistant' && message?.model)
    const ref = lastAssistant?.model ?? refs.sessionRef ?? refs.agentRef ?? refs.override
    let limit: number | null = null
    try {
      const models = context.data.location?.model?.list?.(location)
      limit = resolveContextLimit(Array.isArray(models) ? models : [], ref)
    } catch {
      limit = null
    }
    return computeContextUsage(list, limit, session()?.revert?.messageID)
  })

  // Telemetry that rides on the messages already in hand — no extra request.
  // The halves are deliberately separate memos: the cache hit rate comes from
  // the last assistant that carries `tokens` and never looks at the clock,
  // while the speed needs the turn (and `time.streamed`) to be measurable. One
  // half being unavailable must never blank the other.
  const cachePerformance = createMemo<number | null>(() => {
    const message = lastAssistantWithTokens(messages(), session()?.revert?.messageID)
    return message === null ? null : cacheHitPercent(message.tokens)
  })

  // The turn the newest assistant step closes gets the host's aggregated
  // `turnTokensPerSecond` (see the helper).
  const turnPerformance = createMemo<number | null>(() => {
    const list = messages()
    let anchor = -1
    for (let index = list.length - 1; index >= 0; index--) {
      if (list[index]?.type === 'assistant') {
        anchor = index
        break
      }
    }
    return anchor === -1 ? null : turnTokensPerSecond(list, anchor)
  })

  const performance = createMemo<ContextPerformance | null>(() => {
    const cacheHit = cachePerformance()
    const tokensPerSecond = turnPerformance()
    if (cacheHit === null && tokensPerSecond === null) return null
    return { cacheHit, tokensPerSecond }
  })

  // Child session id → the `subagent` call that spawned it (description, agent,
  // background). This rides the transcript the sidebar already holds: one pass,
  // no request, and no `message.sync` on the children. The call is evidence for
  // *why* a child exists; when it is missing the row simply stays unclassified.
  const subagentCalls = createMemo(() => collectSubagentCalls(messages()))

  // Delegations = every child of the active session (native task() children and
  // a dispatch's own children alike), enriched with each child's live status and
  // terminal outcome. `collectDispatch` is the same collector the
  // `pantheon.dispatch` panel renders, so the sidebar and the panel can never
  // list a child twice or disagree about its evidence; the calls map already
  // computed above is handed over so this costs no second transcript walk.
  const dispatchEntries = createMemo(() => {
    revision()
    const id = activeSessionID()
    if (id === '') return []
    return collectDispatch(context, id, { now: Date.now(), calls: subagentCalls() })
  })

  /** What the sidebar block renders: the collector's rows, nothing else. */
  const allDelegations = createMemo(() => dispatchEntries().map((entry) => entry.view))

  const hasRunning = createMemo(() => allDelegations().some((view) => view.state === 'running'))

  // The whole `Dispatch` block in one memo: the live rows (newest first, capped),
  // the finished rollup per agent and the spend totals. Reading `frame()` is what
  // re-evaluates it while something runs — the spinner already ticks every 80 ms,
  // so a live row's duration advances without a second timer and an idle sidebar
  // stays static. Null when the session has no child, so the block (and its
  // spacer) never renders empty.
  const dispatch = createMemo(() => {
    frame()
    return buildDispatchBlock(allDelegations(), Date.now(), frame())
  })

  // Which blocks render, and where a blank line goes. The conditions mirror the
  // ones in the view's own `<Show>`s — both read these same memos, so a spacer
  // can never outlive the block it separates.
  const blocks = createMemo(() => {
    const present: SidebarBlockKey[] = []
    // Context also owns the spend line, so the stats totals alone keep it up.
    if (contextBlockRows(contextUsage(), cost()) !== null || contextSpendLine(spend()) !== null) {
      present.push('context')
    }
    if (branch() !== null || gitLine() !== null) present.push('git')
    if (todo().visible.length > 0) present.push('todo')
    if (dispatch() !== null) present.push('dispatch')
    return withBlockSpacers(present)
  })

  onMount(() => {
    const unsubscribeAll = subscribeSidebarRefresh(context, () => {
      refresh()
      scheduleGitChanges()
      scheduleGitProbe()
      scheduleSpend()
    })
    const id = activeSessionID()
    if (id !== '') {
      try {
        void Promise.resolve(context.data.session.sync(id)).then(refresh)
      } catch {
        /* sync unavailable */
      }
      try {
        void Promise.resolve(context.data.session.message?.sync?.(id)).then(refresh)
      } catch {
        /* message sync unavailable — the gauge degrades to cost-only */
      }
    }
    try {
      void Promise.resolve(context.data.location.vcs.sync(location)).then(refresh)
    } catch {
      /* vcs sync unavailable */
    }

    void loadGitChanges()
    void runGitProbe()
    void loadSpend()

    // Spinner ticks only while a job is running; terminal rows stay static. The
    // interval is armed on the running edge and cleared on the terminal one, so
    // an idle sidebar schedules no work at all.
    createEffect(() => {
      if (!hasRunning()) return
      const spinner = setInterval(() => setFrame((value) => value + 1), SPINNER_INTERVAL_MS)
      onCleanup(() => clearInterval(spinner))
    })

    onCleanup(() => {
      disposed = true
      if (gitDebounce !== undefined) clearTimeout(gitDebounce)
      if (gitProbeDebounce !== undefined) clearTimeout(gitProbeDebounce)
      if (spendDebounce !== undefined) clearTimeout(spendDebounce)
      if (metricsDebounce !== undefined) clearTimeout(metricsDebounce)
    })
    onCleanup(unsubscribeAll)
  })

  // Discrete completion toast: exactly one per running→terminal transition, and
  // never across a session switch — a state observed in one session says nothing
  // about the next one, so the snapshot is dropped with the session id.
  let observedSessionID = activeSessionID()
  createEffect(() => {
    const id = activeSessionID()
    const views = allDelegations()
    if (id !== observedSessionID) {
      observedSessionID = id
      observedStates = new Map()
    }
    if (id === '') {
      observedStates = new Map()
      return
    }
    const { completed, snapshot } = detectDelegationCompletions(
      observedStates,
      views.map((view) => ({ id: view.id, label: view.label, state: view.state })),
    )
    observedStates = snapshot
    for (const done of completed) showDelegationToast(context, done)
  })

  return {
    activeSessionID,
    session,
    branch,
    gitChanges,
    gitLine,
    gitCli,
    performance,
    dispatch,
    blocks,
    hasRunning,
    frame,
    preset,
    provider,
    presetOverrides,
    cost,
    modelUsage,
    todo,
    spend,
    contextUsage,
    agentModel,
  }
}

/* ─── Components ─────────────────────────────────────────── */

/** One `Context` row: an optional toned lead segment (the gauge's filled
 *  cells), the value, the muted gauge tail (empty cells) and the muted unit
 *  suffix (`tokens` / `of 200K` / `spent`). */
function ContextRowView(props: { row: ContextRow; fg: string; muted: string }) {
  return (
    <box flexDirection="row">
      <Show when={props.row.lead}>{(lead) => <text fg={props.fg}>{lead()}</text>}</Show>
      <Show when={props.row.tail}>{(tail) => <text fg={props.muted}>{tail()}</text>}</Show>
      <text fg={props.fg}>{props.row.value}</text>
      <Show when={props.row.suffix}>{(suffix) => <text fg={props.muted}>{suffix()}</text>}</Show>
    </box>
  )
}

/** Block title: a muted single-width glyph, then the bold label. The fixed
 *  header at the top of the sidebar deliberately renders no icon. `summary` is
 *  the muted tail some blocks carry (`· 2 rodando · $0.47`), so the header
 *  stays one line. */
function BlockHeader(props: {
  icon: string
  label: string
  fg: string
  muted: string
  summary?: string | null
}) {
  return (
    <box flexDirection="row">
      <text fg={props.muted}>{`${props.icon} `}</text>
      <text fg={props.fg} attributes={1}>
        {props.label}
      </text>
      <Show when={props.summary}>
        {(summary) => <text fg={props.muted}>{`${SPEND_LINE_SEPARATOR}${summary()}`}</text>}
      </Show>
    </box>
  )
}

function Sidebar(props: { context: any; sessionID?: string }) {
  const { context } = props
  const model = createSidebarModel(context, () => props.sessionID)
  const text = () => context.theme.text?.base
  const muted = () => context.theme.text?.muted ?? text()
  const tone = (value: DelegationTone) => context.theme?.text?.feedback?.[value]?.base ?? text()
  /* Single accent: in-progress uses `theme.text.feedback.warning.base` when the
   * theme ships it, so live work is the only colored row. */
  const todoFg = (status: TodoStatus) => {
    const rowTone = todoTone(status)
    if (rowTone === 'accent') return tone('warning')
    return rowTone === 'muted' ? muted() : text()
  }
  const open = (sessionID: string) => () => navigateToSession(context.ui?.router, sessionID)
  /* Spacing comes from the block list, never from the view: a block with no
   * content is simply absent there, so it leaves no orphan gap behind. */
  const block = (key: SidebarBlockKey) => model.blocks().find((entry) => entry.key === key)
  /* Read the flag live (not through a captured entry) so a block that becomes
   * the first one loses its spacer instead of keeping a stale blank line. */
  const spacer = (key: SidebarBlockKey) => block(key)?.spacer === true
  const usageRows = () => modelUsageRows(model.modelUsage().visible)
  const usageHidden = () =>
    hiddenModelUsageText(model.modelUsage().hidden, model.modelUsage().hiddenCost)
  const contextRows = () => contextBlockRows(model.contextUsage(), model.cost())
  const spendLine = () => contextSpendLine(model.spend())
  const performanceLine = () => contextPerformanceLine(model.performance())
  /* Filled cells and the percent value resolve through the same stage, so the
   * bar and its number can never disagree. */
  const gaugeFg = (row: ContextRow) => contextProgressColor(row.tone ?? 'warning', context.theme)
  const dispatchView = () => model.dispatch()
  const dispatchSummary = () => {
    const view = dispatchView()
    return view === null ? null : dispatchHeaderSummary(view.runningCount, view.totalCost)
  }
  const failedSuffix = () => failedSuffixText(dispatchView()?.failures)

  return (
    <box flexDirection="column" width="100%" padding={1}>
      <text fg={text()} attributes={1}>{`Pantheon v${__PANTHEON_VERSION__}`}</text>
      {/* Preset plus the provider of the model in use — both derived from host
          state. The provider is dropped when nothing resolves, so the row is
          never a placeholder. */}
      <text fg={muted()}>{presetHeaderLine(model.preset().name ?? '', model.provider())}</text>
      <Show
        when={model.activeSessionID() !== '' && model.session()}
        fallback={<text fg={muted()}>{sidebarPlaceholder(props.sessionID)}</text>}
      >
        {(current: any) => (
          <text fg={text()}>{`Sessão: ${truncateLabel(current().title || current().id)}`}</text>
        )}
      </Show>

      {/* Exactly one blank line between the fixed header and the first block, so
          the session line never touches the first gauge. Blocks carry their own
          spacer (see `withBlockSpacers`), so this never doubles. */}
      <Show when={model.blocks().length > 0}>
        <box height={1} />
      </Show>

      {/* Context — a 12-cell gauge of the model's window, one row per model
          with real message cost > 0 (`<model> <tokens> $<cost>`), and one muted
          footer line with the local `hoje` / `30d` totals. The native block is
          disabled in cli.json, so this is the only source of the data. Only the
          gauge carries a semantic tone; labels and units stay muted. */}
      <Show when={block('context')}>
        <box flexDirection="column">
          <Show when={spacer('context')}>
            <box height={1} />
          </Show>
          <BlockHeader icon={BLOCK_ICONS.context} label="Context" fg={text()} muted={muted()} />
          <Show when={contextRows()}>
            {(rows) => (
              <box flexDirection="column">
                <Show when={rows().tokens}>
                  {(row) => <ContextRowView row={row()} fg={text()} muted={muted()} />}
                </Show>
                <Show when={rows().percent}>
                  {(row) => <ContextRowView row={row()} fg={gaugeFg(row())} muted={muted()} />}
                </Show>
                <Show when={rows().spent}>
                  {(row) => <ContextRowView row={row()} fg={text()} muted={muted()} />}
                </Show>
                {/* Real per-model spend, only for models with cost > 0. Label muted,
                    numbers right-aligned; the gauge above remains the block's
                    single accent. When no message carries cost this loop is empty
                    and the block keeps its original token/spend rows. */}
                <For each={usageRows()}>
                  {(row: ModelUsageRow) => (
                    <box flexDirection="row">
                      <text fg={muted()}>{row.model.padEnd(MODEL_USAGE_MODEL_WIDTH)}</text>
                      <text fg={text()}>{`  ${row.tokens.padStart(MODEL_USAGE_TOKEN_WIDTH)}`}</text>
                      <text fg={text()}>{`  ${row.cost.padStart(MODEL_USAGE_COST_WIDTH)}`}</text>
                    </box>
                  )}
                </For>
                <Show when={usageHidden()}>{(line) => <text fg={muted()}>{line()}</text>}</Show>
              </box>
            )}
          </Show>
          {/* Cache hit + output speed of the newest messages: already in the
              transcript walk, so these cost no request. Muted, one line, and
              absent entirely when neither number exists. */}
          <Show when={performanceLine()}>{(line) => <text fg={muted()}>{line()}</text>}</Show>
          {/* Spend, not budget: two local windows on one muted line. Absent
              whenever stats is missing or the from/to unit probe failed. */}
          <Show when={spendLine()}>{(line) => <text fg={muted()}>{line()}</text>}</Show>
        </box>
      </Show>

      {/* Git status — branch from the location cache; file counts from the git
          CLI (`+1 ±2 −1 ?2 ↑3 ↓1`, async, debounced, 5 s cooldown) and only
          `client.vcs.status` when git is unavailable. Untracked and
          ahead/behind exist only on the CLI path: the HTTP protocol has no
          field for either. The header renders even without a branch when the
          CLI answered, so a repo with a detached HEAD still shows its counts. */}
      <Show when={block('git')}>
        <box flexDirection="column">
          <Show when={spacer('git')}>
            <box height={1} />
          </Show>
          <BlockHeader icon={BLOCK_ICONS.git} label="Git status" fg={text()} muted={muted()} />
          <Show when={model.branch()}>
            {(value) => (
              <box flexDirection="row">
                <text fg={muted()}>{'⎇ '}</text>
                <text fg={text()}>{truncateLabel(value(), 32)}</text>
              </box>
            )}
          </Show>
          <Show when={model.gitLine()}>{(line) => <text fg={text()}>{line()}</text>}</Show>
        </box>
      </Show>

      {/* Todo — derived from the newest completed `todowrite` in the active
          session's transcript (no todo API exists in the installed client).
          Rows are grouped in_progress → pending → completed → cancelled, capped
          at six, and every row keeps a single accent: live work only. The
          header takes `warning` so the block reads apart from the neutral
          reference blocks above it. */}
      <Show when={block('todo')}>
        <box flexDirection="column">
          <Show when={spacer('todo')}>
            <box height={1} />
          </Show>
          <Show when={model.todo().visible.length > 0}>
            <box flexDirection="column">
              <BlockHeader
                icon={BLOCK_ICONS.todo}
                label="Todo"
                fg={tone('warning')}
                muted={muted()}
              />
              <For each={model.todo().visible}>
                {(item: TodoItem) => <text fg={todoFg(item.status)}>{todoRowText(item)}</text>}
              </For>
              <Show when={hiddenTodoText(model.todo().hidden)}>
                {(line) => <text fg={muted()}>{line()}</text>}
              </Show>
            </box>
          </Show>
        </box>
      </Show>

      {/* Dispatch — one block for the whole child set. The header carries the
          live count and the subtree's real spend; then one row per live child
          (newest first, capped at three, `… +N rodando` beyond), the aggregated
          `✓ <total> · $<soma> · <M> agentes` line of the finished ones, up to
          three per-agent rollup rows (`<agente> ×<n>  $<soma>`), `… +K  $<soma>`
          beyond, and `· <F> falhas` on the summary when any child failed. Every
          row is one preformatted line, so no column can be squeezed away by the
          layout; live rows navigate to the child session on click. */}
      <Show when={block('dispatch')}>
        <box flexDirection="column">
          <Show when={spacer('dispatch')}>
            <box height={1} />
          </Show>
          <Show when={dispatchView()}>
            {(view) => (
              <box flexDirection="column">
                <BlockHeader
                  icon={BLOCK_ICONS.dispatch}
                  label="Dispatch"
                  fg={view().runningCount > 0 ? tone('success') : muted()}
                  muted={muted()}
                  summary={dispatchSummary()}
                />
                <For each={view().running}>
                  {(row: DispatchRunningLine) => (
                    <box onMouseDown={open(row.id)} flexShrink={0}>
                      <text fg={tone('success')}>{row.text}</text>
                    </box>
                  )}
                </For>
                <Show when={view().runningHidden > 0}>
                  <text fg={muted()}>{`\u2026 +${view().runningHidden} rodando`}</text>
                </Show>
                <Show when={view().summary}>
                  {(line) => (
                    <box flexDirection="row" flexShrink={0}>
                      <text fg={muted()}>{line()}</text>
                      <Show when={failedSuffix()}>
                        {(suffix) => (
                          <text fg={tone('error')}>{`${SPEND_LINE_SEPARATOR}${suffix()}`}</text>
                        )}
                      </Show>
                    </box>
                  )}
                </Show>
                <For each={view().agents}>
                  {(row: ChildAgentUsage) => <text fg={muted()}>{childAgentRowText(row)}</text>}
                </For>
                <Show when={hiddenChildAgentsText(view().agentsHidden, view().agentsHiddenCost)}>
                  {(line) => <text fg={muted()}>{line()}</text>}
                </Show>
              </box>
            )}
          </Show>
        </box>
      </Show>
    </box>
  )
}

/** Panel actions that only make sense with a row selected. A panel over an
 *  empty tree still owns `f`/`escape`, but the navigation keys fall through
 *  instead of being swallowed by a no-op. */
const DISPATCH_PANEL_ROW_ACTIONS: ReadonlySet<DispatchPanelAction> = new Set<DispatchPanelAction>([
  'up',
  'down',
  'home',
  'end',
  'pageup',
  'pagedown',
  'toggle',
])

/** One command: runs only while the panel owns the keyboard, and reports
 *  `false` (the host keeps the key) when it cannot act. `undefined` means the
 *  key was consumed. */
export function runDispatchPanelCommand(
  action: DispatchPanelAction,
  panel: Pick<PanelInput, 'focused' | 'close' | 'toggleFullscreen'>,
  model: Pick<
    DispatchPanelModel,
    'rows' | 'move' | 'first' | 'last' | 'pageUp' | 'pageDown' | 'toggle'
  >,
): false | undefined {
  if (panel.focused !== true) return false
  if (DISPATCH_PANEL_ROW_ACTIONS.has(action) && model.rows().length === 0) return false
  performDispatchPanelAction(action, model, panel)
  return undefined
}

/** Keymap layer of the panel, as data. It is registered inside the
 *  `session.panel` claim, but the host mounts the effects of *every* panel
 *  contribution, so the layer itself is not proof of focus: without `enabled`
 *  the `j/k/f/q/enter/escape` bindings were consumed while the panel was not
 *  focused and the composer lost its keys. `enabled` (the documented gate) makes
 *  the whole layer inert until `panel.focused` is true. Pure. */
export function dispatchPanelKeymapLayer(
  panel: Pick<PanelInput, 'focused' | 'close' | 'toggleFullscreen'>,
  model: DispatchPanelModel,
): KeymapLayer {
  const focused = () => panel.focused === true
  return {
    mode: 'global',
    enabled: focused,
    commands: DISPATCH_PANEL_COMMANDS.map((spec) => ({
      id: spec.id,
      title: spec.title,
      bind: spec.bind,
      run: () => (focused() ? runDispatchPanelCommand(spec.action, panel, model) : false),
    })),
  }
}

/** Keymap layer of the panel. Created inside the `session.panel` claim, so the
 *  host removes it with the panel; it renders nothing. */
function DispatchPanelKeymap(props: {
  context: any
  panel: PanelInput
  model: DispatchPanelModel
}) {
  props.context.keymap.layer(() => dispatchPanelKeymapLayer(props.panel, props.model))
  return null
}

// TODO(dispatch panel): jumping to the selected child session. `ui.router` only
// has the destination shape verified for the sidebar's click-through
// (`navigateToSession`), and no verified destination exists for a *child* id
// from inside a session route — so panel rows stay non-interactive and the
// detail prints the short id instead. Revisit once the router API for `session`
// destinations is verified against the installed host.
/** The full-width dispatch panel: header counters, one row per child session,
 *  the detail of the selected child and the key hints. Wide panels put the
 *  detail beside the list; narrow ones stack it under the list and every cell is
 *  truncated to its own column instead of wrapping. */
function DispatchPanel(props: { context: any; panel: PanelInput }) {
  const model = createDispatchPanelModel(props.context, () => props.panel)
  const text = () => props.context.theme.text?.base
  const muted = () => props.context.theme.text?.muted ?? text()
  const tone = (value: DelegationTone) =>
    props.context.theme?.text?.feedback?.[value]?.base ?? text()
  const rowFg = (state: DelegationState) => {
    if (state === 'failed') return tone('error')
    if (state === 'running') return tone('success')
    if (state === 'interrupted') return tone('warning')
    return text()
  }
  const selected = (id: string) => id === model.selectedID()
  const rows = () => (
    <For each={model.visible().rows}>
      {(row: DispatchPanelRow) => (
        <box flexDirection="row" flexShrink={0}>
          <text fg={selected(row.id) ? text() : muted()}>
            {selected(row.id) ? `${DISPATCH_PANEL_SELECTION_MARKER} ` : '  '}
          </text>
          <text fg={rowFg(row.state)} attributes={selected(row.id) ? 1 : 0}>
            {row.text}
          </text>
        </box>
      )}
    </For>
  )
  const detail = () => (
    <For each={model.detail()}>
      {(line: string, index: () => number) => (
        <text fg={index() === 0 ? text() : muted()}>{line}</text>
      )}
    </For>
  )
  const empty = () => <text fg={muted()}>{DISPATCH_PANEL_EMPTY_TEXT}</text>

  return (
    <box flexDirection="column" width="100%" padding={1}>
      <DispatchPanelKeymap context={props.context} panel={props.panel} model={model} />
      {/* `◈ Dispatch — <sessão>` then the counters of the whole tree; a counter
          that is zero is absent, and an empty tree renders no counter line. */}
      <text fg={text()} attributes={1}>
        {model.title()}
      </text>
      <Show when={model.header()}>{(line) => <text fg={muted()}>{line()}</text>}</Show>
      <text fg={muted()}>{dispatchPanelRule(props.panel.width - 2)}</text>
      <Show
        when={model.layout().mode === 'wide'}
        fallback={
          <box flexDirection="column">
            <Show when={model.rows().length > 0} fallback={empty()}>
              <box flexDirection="column">{rows()}</box>
            </Show>
            <Show when={model.selectedID()}>
              <box flexDirection="column">
                <box height={1} />
                {detail()}
              </box>
            </Show>
          </box>
        }
      >
        <box flexDirection="row">
          <box flexDirection="column" width={model.layout().listWidth}>
            <Show when={model.rows().length > 0} fallback={empty()}>
              {rows()}
            </Show>
          </box>
          {/* No selected child (an empty tree) → no detail column at all, so an
              empty panel never renders a dangling em dash beside the list. */}
          <Show when={model.selectedID()}>
            <box flexDirection="column" width={model.layout().detailWidth}>
              {detail()}
            </box>
          </Show>
        </box>
      </Show>
      <box height={1} />
      <text fg={muted()}>{model.footer()}</text>
    </box>
  )
}

/** App-level command claim: the only way into the panel. It registers the
 *  `pantheon.dispatch.open` command (palette + `/dispatch`) and renders nothing;
 *  the panel itself lives behind its own `session.panel` claim. */
function DispatchCommandLayer(props: { context: any }) {
  props.context.keymap.layer(() => ({
    mode: 'global',
    commands: [
      {
        id: 'pantheon.dispatch.open',
        title: 'Pantheon: Dispatch',
        group: 'Pantheon',
        palette: true,
        slash: { name: 'dispatch', aliases: ['pantheon-dispatch'] },
        run: () => {
          openDispatchPanel(props.context)
        },
      },
    ],
  }))
  return null
}

/** Home-screen status contribution. The sidebar slot is session-scoped, so
 *  before the first prompt the sidebar may not mount at all (Known Issue) —
 *  this keeps a compact Pantheon line visible on the home footer meanwhile. */
function HomeStatus(props: { context: any }) {
  const preset = useActivePreset(props.context).preset
  const muted = () => props.context.theme?.text?.muted ?? props.context.theme?.text?.base
  return (
    <text
      fg={muted()}
    >{`Pantheon v${__PANTHEON_VERSION__}${preset().name ? ` ${PRESET_MARKER} ${preset().name}` : ''}`}</text>
  )
}

/** Lean footer model: only the preset label and the live delegation count. It
 *  deliberately does not reuse `createSidebarModel` — that model owns the
 *  completion toasts and the spinner, and a second instance would double-toast.
 *  No session id in the slot input is a graceful no-op (count 0). */
export type FooterModel = {
  preset: Accessor<PresetInfo>
  running: Accessor<number>
}

export function createFooterModel(context: any, sessionID: () => string | undefined): FooterModel {
  const [revision, setRevision] = createSignal(0)
  const preset = useActivePreset(context).preset
  const activeSessionID = () => {
    const id = sessionID()
    return isValidSessionID(id) ? id : ''
  }

  const running = createMemo(() => {
    revision()
    const id = activeSessionID()
    if (id === '') return 0
    let family: string[] = []
    try {
      const result = context.data.session.family?.(id)
      if (Array.isArray(result)) family = result
    } catch {
      return 0
    }
    const now = Date.now()
    let count = 0
    for (const childID of family) {
      if (childID === id || !isValidSessionID(childID)) continue
      try {
        const child = context.data.session.get(childID)
        if (child?.parentID !== id) continue
        const view = toDelegationView(child, sessionStatusOf(context, childID), now)
        if (view.state === 'running') count += 1
      } catch {
        /* one unreadable child must not hide the rest */
      }
    }
    return count
  })

  onMount(() => {
    onCleanup(subscribeSidebarRefresh(context, () => setRevision((value) => value + 1)))
  })

  return { preset, running }
}

/** Prompt-footer contribution: `▸<preset> · ✦<n> ativos`, appended next to the
 *  native line (never replacing it) and only while a delegation is running. */
function PromptFooter(props: { context: any; sessionID?: string | undefined }) {
  const model = createFooterModel(props.context, () => props.sessionID)
  const muted = () => props.context.theme?.text?.muted ?? props.context.theme?.text?.base
  return (
    <Show when={model.running() > 0}>
      <text fg={muted()}>
        {`${PRESET_MARKER}${model.preset().name ?? 'default'} · ✦${model.running()} ativos`}
      </text>
    </Show>
  )
}

/* ─── Plugin registration ────────────────────────────────── */

const plugin = Plugin.define({
  id: 'pantheon.tui',
  setup(context: Context) {
    const globalState = globalThis as unknown as Record<PropertyKey, unknown>
    if (globalState[SINGLETON]) return
    globalState[SINGLETON] = true

    const location = resolveLocation(context)
    // Eager load/sync at setup so the cache is warm before the slot's first
    // render (Known Issue: empty sidebar before the first prompt).
    warmUpSidebarData(context, location)

    const unregisterSidebar = context.ui.slot({
      append: 'sidebar.content',
      render: ({ sessionID }: { sessionID: string }) => (
        <Sidebar context={context} sessionID={sessionID} />
      ),
    })
    const unregisterHome = context.ui.slot({
      append: 'home.footer.status',
      render: () => <HomeStatus context={context} />,
    })
    // Additive claim: the native prompt footer keeps its own tokens/cost line.
    const unregisterPromptFooter = context.ui.slot({
      append: 'prompt.footer',
      render: ({ sessionID }: { sessionID?: string }) => (
        <PromptFooter context={context} sessionID={sessionID} />
      ),
    })
    // The dispatch panel is a session-scoped slot: the claim renders only when
    // the host's selected panel is ours, and the host keeps `focused`, `close`
    // and `toggleFullscreen` (the panel never steals focus or routing).
    const unregisterPanel = context.ui.slot({
      append: 'session.panel',
      render: (panel) => (
        <Show when={panel.name === DISPATCH_PANEL_NAME}>
          <DispatchPanel context={context} panel={panel} />
        </Show>
      ),
    })
    // Command layer: an additive claim at `app` that renders nothing and only
    // registers the keymap layer, so `/dispatch` and the palette entry exist
    // even while no panel is open.
    const unregisterCommands = context.ui.slot({
      append: 'app',
      render: () => <DispatchCommandLayer context={context} />,
    })
    return () => {
      if (typeof unregisterSidebar === 'function') unregisterSidebar()
      if (typeof unregisterHome === 'function') unregisterHome()
      if (typeof unregisterPromptFooter === 'function') unregisterPromptFooter()
      if (typeof unregisterPanel === 'function') unregisterPanel()
      if (typeof unregisterCommands === 'function') unregisterCommands()
      delete globalState[SINGLETON]
    }
  },
})

export default plugin
