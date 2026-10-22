// biome-ignore-all lint/suspicious/noExplicitAny: OpenCode V2 exposes its TUI API at runtime.
// biome-ignore-all lint/a11y/noStaticElementInteractions: TUI elements, not DOM
/** @jsxImportSource @opentui/solid */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Plugin } from '@opencode/plugin/tui'
import type { Context } from '@opencode/plugin/tui/context'
import type { Accessor } from 'solid-js'
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js'

const SINGLETON = Symbol.for('pantheon.tui.v2.loaded')

/* ─── Constants ─────────────────────────────────────────── */

/** How often the sidebar re-reads .pantheon/active-preset.json (V1 parity) so
 *  `set-tier` changes made while opencode is open show up within ~30s. */
const PRESET_REFRESH_MS = 30_000
/** Running delegations rendered before the "… +N more" line (V1 parity). */
export const DELEGATIONS_VISIBLE_CEILING = 8
/** Running-row spinner cadence — matches V1's animation tick. */
const SPINNER_INTERVAL_MS = 80
/** Bounded warm-up: sync at most this many sessions at plugin load. */
const WARMUP_SESSION_LIMIT = 24
/** Sidebar body shown while the host has not published a session yet. */
export const SIDEBAR_WAITING_LABEL = 'Aguardando sessão…'
/** Delegate-completion toast title. */
const TOAST_TITLE = 'Pantheon'
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

/** Resolve the active preset for the sidebar: env > file > default. */
export async function resolvePresetForTui(
  env: Record<string, string | undefined>,
  cwd: string,
): Promise<PresetInfo> {
  return (await resolveActivePresetForTui(env, cwd)).info
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

/** Context usage for a message list. Scope: everything before the revert
 *  boundary (when a revert is active), then after the last compaction. The last
 *  assistant message carrying `tokens` in that window wins. Null when there is
 *  no limit or no such message — the caller then omits the block. */
export function computeContextUsage(
  messages: readonly any[],
  contextLimit: number | null | undefined,
  revertMessageID?: string | null,
): ContextUsage | null {
  const limit = numberOrNull(contextLimit)
  if (limit === null || limit <= 0) return null
  if (!Array.isArray(messages) || messages.length === 0) return null

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

  for (let index = end - 1; index >= start; index--) {
    const message = messages[index]
    if (message?.type !== 'assistant' || !message.tokens) continue
    const tokens = messageTokensTotal(message.tokens)
    if (!Number.isFinite(tokens) || tokens <= 0) continue
    return { tokens, percent: Math.round((tokens / limit) * 100), limit }
  }
  return null
}

/** Semantic tone for a context percentage: green < 50%, yellow < 75%, red at
 *  or above 75%. Reuses the delegation tone union so both rows draw from the
 *  same theme tokens. Pure. */
export function contextUsageTone(percent: number): DelegationTone {
  if (percent >= 75) return 'error'
  if (percent >= 50) return 'warning'
  return 'success'
}

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
  tone: DelegationTone | null
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

/** Full single-line text of a context row (`55,320 tokens`,
 *  `▰▰▰▰▰▱▱▱▱▱▱▱ 39% of 200K`). Pure. */
export function contextRowText(row: ContextRow | null): string | null {
  if (row === null) return null
  return `${row.lead ?? ''}${row.tail ?? ''}${row.value}${row.suffix ?? ''}`
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
 * `client.vcs.status()` (`GET /api/vcs/status`) returns one
 * `VcsFileStatus` per changed file: `{ file, additions, deletions, status }`
 * with `status` in `"added" | "modified" | "deleted"`. The sidebar counts
 * files per status — never lines, and never untracked/ahead-behind, which the
 * protocol does not expose. */

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

/** Clamp a free-form label to the sidebar width without wrapping. */
export function truncateLabel(value: string, max = 28): string {
  const text = value.trim()
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(1, max - 1))}…`
}

/** `agente→modelo` identity for a delegation row; either half may be absent. */
export function delegationIdentity(view: Pick<DelegationView, 'agent' | 'model'>): string {
  const agent = view.agent ?? ''
  const model = view.model ?? ''
  if (agent !== '' && model !== '') return `${agent}→${model}`
  return agent !== '' ? agent : model
}

/** Sidebar row body: truncated label plus the agent→model identity. */
export function delegationSidebarLabel(view: DelegationView, max = 18): string {
  const label = truncateLabel(view.label, max)
  const identity = delegationIdentity(view)
  return identity === '' ? label : `${label} · ${identity}`
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

/** Build a delegation row from a child session + its live status. A terminal
 *  `outcome` wins when present (the only V2 primitive that surfaces a
 *  delegation failure/interruption once the status is back to idle); otherwise
 *  the live status decides, with the absent/idle grace window applied. Pure. */
export function toDelegationView(
  child: any,
  status: string | undefined,
  now = Date.now(),
): DelegationView {
  const id = typeof child?.id === 'string' ? child.id : ''
  const title = typeof child?.title === 'string' && child.title !== '' ? child.title : ''
  const agent = typeof child?.agent === 'string' && child.agent !== '' ? child.agent : ''
  const label = title !== '' ? title : agent !== '' ? agent : id.slice(0, 8)
  const state: DelegationState =
    delegationStateFromOutcome(child?.outcome) ??
    delegationStateFromStatus(status, child?.time, now)
  return {
    id,
    label,
    state,
    startedAt: numberOrNull(child?.time?.created),
    updatedAt: numberOrNull(child?.time?.updated),
    agent: agent !== '' ? agent : null,
    model: shortModelID(child?.model),
    cost: numberOrNull(child?.cost),
  }
}

const DELEGATION_TONES: Record<DelegationState, DelegationTone> = {
  running: 'warning',
  completed: 'success',
  failed: 'error',
  interrupted: 'warning',
}

/** Whole-row tone: red = failed, green = terminal, yellow = in flight. The
 *  glyph stays a redundant channel so the state reads in monochrome. Pure. */
export function delegationStateTone(state: DelegationState): DelegationTone {
  return DELEGATION_TONES[state]
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** Spinner glyph for a frame counter (incremented every ~80ms while any job is
 *  running). Pure. */
export function spinnerFrame(frame: number): string {
  const index = Math.abs(Math.floor(frame)) % SPINNER_FRAMES.length
  return SPINNER_FRAMES[index] ?? SPINNER_FRAMES[0]
}

/** Row marker (`<glyph> `): the animated spinner while running, ✓ when done,
 *  ⊘ when interrupted, ✕ on failure. Pure. */
export function delegationRowMarker(state: DelegationState, frame = 0): string {
  if (state === 'running') return `${spinnerFrame(frame)} `
  if (state === 'failed') return '\u2715 '
  if (state === 'interrupted') return '\u2298 '
  return '\u2713 '
}

/** Compact single-unit elapsed label: "12s"/"3m"/"1h"/"2d". Pure. */
export function fmtElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(total / 86_400)
  const hours = Math.floor((total % 86_400) / 3_600)
  const minutes = Math.floor((total % 3_600) / 60)
  const seconds = total % 60
  if (days > 0) return `${days}d`
  if (hours > 0) return `${hours}h`
  if (minutes > 0) return `${minutes}m`
  return `${seconds}s`
}

/** Elapsed label for one row: a running job ticks `now - startedAt`; a terminal
 *  one is fixed at `updatedAt - startedAt` (em dash when a timestamp is
 *  missing). Pure. */
export function delegationElapsed(view: DelegationView, now: number): string {
  if (view.state === 'running') {
    return view.startedAt === null ? '\u2014' : fmtElapsed(now - view.startedAt)
  }
  if (view.startedAt !== null && view.updatedAt !== null)
    return fmtElapsed(view.updatedAt - view.startedAt)
  return '\u2014'
}

/** Live rows first (a running job never falls behind the cap), then by most
 *  recent activity. Pure. */
export function orderDelegations(views: readonly DelegationView[]): DelegationView[] {
  return [...views].sort((a, b) => {
    const activeA = a.state === 'running' ? 1 : 0
    const activeB = b.state === 'running' ? 1 : 0
    if (activeA !== activeB) return activeB - activeA
    return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
  })
}

/** Cap the panel: at most `maxVisible` rows, the remainder collapsing into the
 *  "… +N more" line. Pure. */
export function ceilingDelegations(
  views: readonly DelegationView[],
  maxVisible = DELEGATIONS_VISIBLE_CEILING,
): { visible: DelegationView[]; hidden: number } {
  const limit = Math.max(0, maxVisible)
  const visible = views.slice(0, limit)
  return { visible, hidden: Math.max(0, views.length - visible.length) }
}

/* ─── Block layout ───────────────────────────────────────── */

/** Sidebar blocks in render order. Spacing is derived from this list instead of
 *  from the view, so a hidden block can never leave an empty gap behind. */
export type SidebarBlockKey = 'context' | 'git' | 'todo' | 'agent' | 'dispatch'

/** One rendered block: its key, and whether a blank line precedes it. */
export type SidebarBlock = { key: SidebarBlockKey; spacer: boolean }

/** Header glyph per block — one codepoint each, rendered muted before the bold
 *  label. The fixed header (version/preset/session) takes none.
 *  Measured as one terminal cell by the host (`@opentui/core` counts
 *  `emoji-regex` matches as two): ▤ U+25A4 (EAW=A), ◆ U+25C6 (A), ▾ U+25BE (N),
 *  ◇ U+25C7 (A), ⌁ U+2301 (N). `☑` U+2611 was rejected for the Todo header
 *  because it matches `emoji-regex` and would occupy two cells. */
export const BLOCK_ICONS: Record<SidebarBlockKey, string> = {
  context: '\u25A4',
  git: '\u25C6',
  todo: '\u25BE',
  agent: '\u25C7',
  dispatch: '\u2301',
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

/* ─── Dispatch block ─────────────────────────────────────── */

/** Children listed before the "… +N" line. Five keeps the sidebar inside a
 *  short pane while still showing the finished job next to the live one. */
export const DISPATCH_VISIBLE_CEILING = 5
/** Column width of the agent (or of its title/id fallback). */
export const DISPATCH_AGENT_WIDTH = 12
/** Column width of the short model id — the model is dropped before the agent
 *  or the cost so a row always fits. */
export const DISPATCH_MODEL_WIDTH = 7
/** Column width of the per-dispatch cost (`$0.04`; a sub-cent cost widens it). */
export const DISPATCH_COST_WIDTH = 5
/** Column width of the duration (`12.7s` / `1m04s` / `820ms`). */
export const DISPATCH_DURATION_WIDTH = 5
/** Hard column budget for one row — a Dispatch line never wraps:
 *  marker(2) + agent(12) + model(7) + cost(5) + duration(5) + 3 spaces = 34. */
export const DISPATCH_MAX_WIDTH = 34

export type DispatchTone = 'success' | 'error' | 'muted'

/** Row marker: ● live, ✓ succeeded, ✗ failed, − interrupted. The glyph is the
 *  redundant channel, so the state still reads in monochrome. Pure. */
export function dispatchMarker(state: DelegationState): string {
  if (state === 'running') return '\u25CF'
  if (state === 'failed') return '\u2717'
  if (state === 'interrupted') return '\u2212'
  return '\u2713'
}

/** Row tone: live work is the block's only accent, a failed child is red, and
 *  every terminal state recedes to muted. Pure. */
export function dispatchTone(state: DelegationState): DispatchTone {
  if (state === 'running') return 'success'
  if (state === 'failed') return 'error'
  return 'muted'
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

/** One Dispatch row, columns aligned:
 *  `<marker> <agent> <model> <cost> <duration>`. The agent and model columns are
 *  padded, the cost and duration right-aligned, and the model column stays
 *  reserved when a child published no model so the numbers line up. When the
 *  row would exceed `max` columns the model is dropped first, then the cost —
 *  the agent is never cut below `DISPATCH_AGENT_WIDTH`. Pure. */
export function dispatchRowText(
  view: DelegationView,
  now = Date.now(),
  max = DISPATCH_MAX_WIDTH,
): string {
  const marker = `${dispatchMarker(view.state)} `
  const agent = dispatchAgentText(view)
  const duration = dispatchElapsed(view, now)
  const cost = formatDispatchCost(view.cost)

  const agentColumn = agent.padEnd(DISPATCH_AGENT_WIDTH)
  const modelColumn = dispatchModelText(view).padEnd(DISPATCH_MODEL_WIDTH)
  const costColumn = cost.padStart(DISPATCH_COST_WIDTH)
  const durationColumn = duration.padStart(DISPATCH_DURATION_WIDTH)
  const limit = Math.max(1, max)

  const full = `${marker}${agentColumn} ${modelColumn} ${costColumn} ${durationColumn}`
  if (full.length <= limit) return full
  const withoutModel = `${marker}${agentColumn} ${costColumn} ${durationColumn}`
  if (withoutModel.length <= limit) return withoutModel
  return `${marker}${agentColumn} ${durationColumn}`
}

/** The "… +N" line for children beyond the cap, null when nothing was cut. Pure. */
export function hiddenDispatchText(hidden: number): string | null {
  if (!Number.isFinite(hidden) || hidden <= 0) return null
  return `\u2026 +${Math.round(hidden)}`
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
  /** `+N ±N −N` file counts from `vcs.status`, null when clean/unavailable. */
  gitChanges: Accessor<string | null>
  /** Running children only — what the spinner and the accent read. */
  delegations: Accessor<DelegationView[]>
  /** Every child of the active session (running + finished), ordered and
   *  capped for the `Dispatch` block. */
  dispatch: Accessor<{ visible: DelegationView[]; hidden: number }>
  /** Blocks that have content, in render order, each tagged with its spacer. */
  blocks: Accessor<SidebarBlock[]>
  hasRunning: Accessor<boolean>
  frame: Accessor<number>
  /** Fresh clock that advances on the spinner's own tick — the live rows
   *  measure their duration from it instead of from a second interval. */
  liveNow: Accessor<number>
  preset: Accessor<PresetInfo>
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

  // Git file counts come from the client API, not the location cache (VcsInfo
  // carries only the branch). Fetched once at mount and revalidated on session
  // events with a debounce; a failed/slow call keeps the previous value.
  const [gitChanges, setGitChanges] = createSignal<string | null>(null)
  let gitRequest = 0
  let gitDebounce: ReturnType<typeof setTimeout> | undefined
  const loadGitChanges = async () => {
    const status = vcsStatusCall(context)
    if (status === null) return
    const request = ++gitRequest
    try {
      const result = await status({ location: { directory: resolveSidebarCwd(context) } })
      if (request !== gitRequest) return // superseded by a newer request
      const files = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : []
      setGitChanges(formatGitChanges(files))
    } catch {
      /* vcs.status unavailable or failed — keep the previous counts */
    }
  }
  const scheduleGitChanges = () => {
    if (vcsStatusCall(context) === null) return
    if (gitDebounce !== undefined) clearTimeout(gitDebounce)
    gitDebounce = setTimeout(() => {
      gitDebounce = undefined
      void loadGitChanges()
    }, GIT_CHANGES_DEBOUNCE_MS)
  }

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

  // One `message.list` call per family session feeds both the real per-model
  // aggregate and the Todo block: the newest completed `todowrite` of the
  // *active* session is captured inside the same walk (a child's list is not
  // this sidebar's todo). `message.list` is the host's cached list, so this is
  // a single fetch/scan per refresh, never one per block. Each session
  // contributes at most MODEL_USAGE_MESSAGE_LIMIT entries to the aggregate,
  // which keeps the walk O(limit) per update.
  const transcript = createMemo(() => {
    metricsRevision()
    const rootID = activeSessionID()
    const collected: any[] = []
    let todo: TodoItem[] = []
    for (const id of familySessionIDs()) {
      try {
        const result = context.data.session.message?.list?.(id)
        if (!Array.isArray(result)) continue
        collected.push(...result.slice(-MODEL_USAGE_MESSAGE_LIMIT))
        if (id === rootID) todo = latestTodoItems(result) ?? []
      } catch {
        /* one unreadable session must not hide the others */
      }
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

  // Delegations = the children of the active session (native task() children),
  // enriched with each child's live status + outcome. The V2 family API returns
  // the id set; `parentID` narrows it to direct children exactly like V1.
  const allDelegations = createMemo(() => {
    revision()
    const id = activeSessionID()
    if (id === '') return []
    let family: string[] = []
    try {
      const result = context.data.session.family?.(id)
      if (Array.isArray(result)) family = result
    } catch {
      return []
    }
    const now = Date.now()
    const views: DelegationView[] = []
    for (const childID of family) {
      if (childID === id || !isValidSessionID(childID)) continue
      const child = context.data.session.get(childID)
      if (child?.parentID !== id) continue
      views.push(toDelegationView(child, sessionStatusOf(context, childID), now))
    }
    return orderDelegations(views)
  })

  // Running-only view of the child set: what the spinner cadence and the
  // Dispatch header accent read. Terminal jobs stay in `dispatch` below; the
  // unfiltered set is kept for the running→terminal detection behind the toasts.
  const delegations = createMemo(() => allDelegations().filter((view) => view.state === 'running'))

  const hasRunning = createMemo(() => delegations().length > 0)

  // Dispatch = the same child set, unfiltered: a finished child stays on screen
  // as ✓/✗/− instead of vanishing into the toast alone. Ordered by
  // `orderDelegations` (live first, then most recent) and capped, so a busy root
  // cannot push the sidebar past five rows.
  const dispatch = createMemo(() => ceilingDelegations(allDelegations(), DISPATCH_VISIBLE_CEILING))

  // Live clock for the running durations. Reading `frame()` inside the memo is
  // what re-evaluates it: the spinner already ticks every 80ms while a child
  // runs, so no second timer is armed here (and an idle sidebar stays static).
  const liveNow = createMemo(() => {
    frame()
    return Date.now()
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
    if (branch() !== null) present.push('git')
    if (todo().visible.length > 0) present.push('todo')
    if (agentModel() !== null) present.push('agent')
    if (dispatch().visible.length > 0) present.push('dispatch')
    return withBlockSpacers(present)
  })

  onMount(() => {
    const unsubscribeAll = subscribeSidebarRefresh(context, () => {
      refresh()
      scheduleGitChanges()
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
      if (gitDebounce !== undefined) clearTimeout(gitDebounce)
      if (spendDebounce !== undefined) clearTimeout(spendDebounce)
      if (metricsDebounce !== undefined) clearTimeout(metricsDebounce)
    })
    onCleanup(unsubscribeAll)
  })

  // Discrete completion toast: exactly one per running→terminal transition.
  createEffect(() => {
    const views = allDelegations()
    if (activeSessionID() === '') {
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
    delegations,
    dispatch,
    blocks,
    hasRunning,
    frame,
    liveNow,
    preset,
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
 *  header at the top of the sidebar deliberately renders no icon. */
function BlockHeader(props: { icon: string; label: string; fg: string; muted: string }) {
  return (
    <box flexDirection="row">
      <text fg={props.muted}>{`${props.icon} `}</text>
      <text fg={props.fg} attributes={1}>
        {props.label}
      </text>
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
  /* One accent per Dispatch row: green only while it runs, red when it failed,
   * muted once it is over. */
  const dispatchFg = (state: DelegationState) => {
    const rowTone = dispatchTone(state)
    return rowTone === 'muted' ? muted() : tone(rowTone)
  }
  const usageRows = () => modelUsageRows(model.modelUsage().visible)
  const usageHidden = () =>
    hiddenModelUsageText(model.modelUsage().hidden, model.modelUsage().hiddenCost)
  const contextRows = () => contextBlockRows(model.contextUsage(), model.cost())
  const spendLine = () => contextSpendLine(model.spend())

  return (
    <box flexDirection="column" width="100%" padding={1}>
      <text fg={text()} attributes={1}>{`Pantheon v${__PANTHEON_VERSION__}`}</text>
      <text fg={muted()}>OpenCode V2 · plugin TUI ativo</text>
      <Show when={model.preset().name} fallback={<text fg={muted()}>{'⚡ Preset: default'}</text>}>
        {(name) => (
          <box flexDirection="row">
            <text fg={muted()}>{'⚡ Preset: '}</text>
            <text fg={text()}>{name()}</text>
            <text fg={muted()}>{` (${model.preset().source ?? ''})`}</text>
          </box>
        )}
      </Show>

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
                  {(row) => (
                    <ContextRowView
                      row={row()}
                      fg={tone(row().tone ?? 'success')}
                      muted={muted()}
                    />
                  )}
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
          {/* Spend, not budget: two local windows on one muted line. Absent
              whenever stats is missing or the from/to unit probe failed. */}
          <Show when={spendLine()}>{(line) => <text fg={muted()}>{line()}</text>}</Show>
        </box>
      </Show>

      {/* Git status — branch from the location cache; file counts from
          `client.vcs.status` (async, debounced). The protocol exposes no
          untracked/ahead-behind counters, so none are invented here. */}
      <Show when={block('git')}>
        <box flexDirection="column">
          <Show when={spacer('git')}>
            <box height={1} />
          </Show>
          <Show when={model.branch()}>
            {(value) => (
              <box flexDirection="column">
                <BlockHeader
                  icon={BLOCK_ICONS.git}
                  label="Git status"
                  fg={text()}
                  muted={muted()}
                />
                <box flexDirection="row">
                  <text fg={muted()}>{'⎇ '}</text>
                  <text fg={text()}>{truncateLabel(value(), 32)}</text>
                </box>
                <Show when={model.gitChanges()}>
                  {(changes) => <text fg={text()}>{changes()}</text>}
                </Show>
              </box>
            )}
          </Show>
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

      {/* agente — current agent + resolved short model (`*` = explicit override). */}
      <Show when={block('agent')}>
        <box flexDirection="column">
          <Show when={spacer('agent')}>
            <box height={1} />
          </Show>
          <Show when={model.agentModel()}>
            {(identity) => (
              <box flexDirection="column">
                <BlockHeader icon={BLOCK_ICONS.agent} label="agente" fg={text()} muted={muted()} />
                <box flexDirection="row">
                  <Show when={identity().agent !== ''}>
                    <text fg={muted()}>{`${identity().agent} → `}</text>
                  </Show>
                  <text fg={text()}>
                    {`${identity().model}${identity().overridden ? '*' : ''}`}
                  </text>
                </box>
              </box>
            )}
          </Show>
        </box>
      </Show>

      {/* Dispatch — every child of the active session: the running ones first,
          then the finished ones by most recent activity (the same set the
          completion toasts are derived from). A job that ends stays visible as
          ✓/✗/− instead of disappearing. Row columns: marker, agent, model, real
          child cost, duration — the model is dropped first (then the cost) when
          a row would overflow. One accent only: the header is green while
          something runs, muted otherwise, and a row is green/red/muted by its
          state. Rows navigate to the child session on click; five rows then
          `… +N`. */}
      <Show when={block('dispatch')}>
        <box flexDirection="column">
          <Show when={spacer('dispatch')}>
            <box height={1} />
          </Show>
          <Show when={model.dispatch().visible.length > 0}>
            <box flexDirection="column">
              <BlockHeader
                icon={BLOCK_ICONS.dispatch}
                label="Dispatch"
                fg={model.hasRunning() ? tone('success') : muted()}
                muted={muted()}
              />
              <For each={model.dispatch().visible}>
                {(view: DelegationView) => (
                  <box onMouseDown={open(view.id)}>
                    <text fg={dispatchFg(view.state)}>
                      {dispatchRowText(view, model.liveNow())}
                    </text>
                  </box>
                )}
              </For>
              <Show when={hiddenDispatchText(model.dispatch().hidden)}>
                {(line) => <text fg={muted()}>{line()}</text>}
              </Show>
            </box>
          </Show>
        </box>
      </Show>
    </box>
  )
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
    >{`Pantheon v${__PANTHEON_VERSION__}${preset().name ? ` ⚡ ${preset().name}` : ''}`}</text>
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

/** Prompt-footer contribution: `⚡<preset> · ✦<n> ativos`, appended next to the
 *  native line (never replacing it) and only while a delegation is running. */
function PromptFooter(props: { context: any; sessionID?: string | undefined }) {
  const model = createFooterModel(props.context, () => props.sessionID)
  const muted = () => props.context.theme?.text?.muted ?? props.context.theme?.text?.base
  return (
    <Show when={model.running() > 0}>
      <text fg={muted()}>
        {`⚡${model.preset().name ?? 'default'} · ✦${model.running()} ativos`}
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
    return () => {
      if (typeof unregisterSidebar === 'function') unregisterSidebar()
      if (typeof unregisterHome === 'function') unregisterHome()
      if (typeof unregisterPromptFooter === 'function') unregisterPromptFooter()
      delete globalState[SINGLETON]
    }
  },
})

export default plugin
