import { Accessor } from "solid-js";
import { Context, KeymapLayer, PanelInput } from "@opencode/plugin/tui/context";
//#region src/index-v2.d.ts
/** Sidebar body shown while the host has not published a session yet. */
export declare const SIDEBAR_WAITING_LABEL = "Aguardando sessão…";
/** Marker before the preset label (fixed header, home status, prompt footer).
 *  `▸` U+25B8 is one cell; the previous bolt (U+26A1) carries
 *  Emoji_Presentation and is measured as two cells, which misaligned the line. */
export declare const PRESET_MARKER = "▸";
/** Git ahead / behind arrows (U+2191 / U+2193), one cell each — the glyphs the
 *  reference sidebars use for `↑ahead ↓behind`. */
export declare const GIT_ARROW_UP = "↑";
export declare const GIT_ARROW_DOWN = "↓";
/** One event name the host publishes on `data.on` — the OpenCode V2 union. */
export type SidebarDataEvent = Parameters<Context['data']['on']>[0];
/** V2 events that refresh the sidebar. V1 also listened to `session.updated`,
 *  but that name is absent from the OpenCode V2 event union (verified against
 *  `@opencode/client`'s `OpenCodeEvent`), so the valid events that carry the
 *  same state changes are used instead: `session.renamed` /
 *  `session.metadata.updated` / `session.moved` (the mutations `session.updated`
 *  used to stand for) and `session.idle` (a child finishing). `satisfies` keeps
 *  the literals while making a name outside the union a type error (surfaced by
 *  `tsc -p tsconfig.build.json`), and the sidebar test asserts the same names
 *  against the installed union at runtime. */
export declare const SIDEBAR_REFRESH_EVENTS: readonly ["session.created", "session.renamed", "session.metadata.updated", "session.moved", "session.idle", "session.status", "session.deleted"];
export type PresetInfo = {
  name: string | null;
  source: 'env' | 'file' | null;
};
/** One `overrides.agents[<agent>]` entry from active-preset.json. */
export type AgentModelOverride = {
  model?: string;
  variant?: string;
};
/** The override map the CLI wrote into active-preset.json. */
export type PresetOverrides = {
  agents: Record<string, AgentModelOverride>;
};
/** A preset plus the explicit overrides stored next to it. */
export type ActivePresetDetail = {
  info: PresetInfo;
  overrides: PresetOverrides;
};
/** Keep only well-formed per-agent overrides: unknown keys are ignored and a
 *  non-string model/variant is dropped instead of leaking into the render. */
export declare function parsePresetOverrides(value: unknown): PresetOverrides;
/** Env leg of resolution: PANTHEON_MODEL_PRESET set and !== 'none' wins. */
export declare function presetFromEnv(env: Record<string, string | undefined>): PresetInfo;
/** Resolve the active preset plus its per-agent overrides: env > file > default.
 *  An env-selected preset has no file overrides by construction. */
export declare function resolveActivePresetForTui(env: Record<string, string | undefined>, cwd: string): Promise<ActivePresetDetail>;
/** `SessionInfo.id` is always a `ses…` handle. Guarded so a placeholder or a
 *  foreign id never reaches the status/navigate APIs. */
export declare function isValidSessionID(id: unknown): id is string;
/** Model reference shapes the host publishes: `ModelRef` objects, bare ids, or
 *  `provider/model` strings. Returns the id part, never throws. */
export declare function modelRefID(ref: unknown): string | null;
/** Short display id: the segment after the last `/` (`opencode-go/kimi-k3` →
 *  `kimi-k3`), truncated so a long id never wraps the sidebar. */
export declare function shortModelID(ref: unknown, max?: number): string | null;
/** `providerID` of a model reference, trimmed; null when absent/blank. Derived
 *  only from what the host already published — never a lookup table. */
export declare function providerIDFromRef(ref: unknown): string | null;
/** Provider for a bare-string model reference: match its id (or bare segment)
 *  in the host model list. Null when the list cannot answer. */
export declare function providerIDFromModels(models: unknown, ref: unknown): string | null;
/** Resolve `model.limit.context` for a model reference. Match order: the
 *  provider-qualified id, then the bare id (the host's `id`/`modelID` fields).
 *  Absent/ambiguous models degrade to null so the gauge is simply omitted. */
export declare function resolveContextLimit(models: readonly any[], ref: unknown): number | null;
/** Native token total: input + output + reasoning + cache read + cache write. */
export declare function messageTokensTotal(tokens: any): number;
export type ContextUsage = {
  tokens: number;
  percent: number;
  limit: number;
};
/** The part of a transcript that still counts: everything before the revert
 *  boundary (when a revert is active), then after the last compaction. Both
 *  derived numbers that read "the last assistant with usage" — the context
 *  gauge and the cache hit rate — share this window, so a reverted-away or
 *  compacted-away message can never feed either one. Pure. */
export declare function transcriptWindow(messages: readonly any[], revertMessageID?: string | null): {
  start: number;
  end: number;
};
/** Context usage for a message list. Scope: the live window (see
 *  `transcriptWindow`). The last assistant message carrying `tokens` in that
 *  window wins. Null when there is no limit or no such message — the caller
 *  then omits the block. */
export declare function computeContextUsage(messages: readonly any[], contextLimit: number | null | undefined, revertMessageID?: string | null): ContextUsage | null;
/** Semantic tone for a context percentage, inclusive at the top of each band:
 *  info (blue) up to 25%, success (green) up to 50%, warning (yellow) up to
 *  90%, error (red) above it. Four explicit stages, each backed by a feedback
 *  token, so the gauge follows the active theme. Pure. */
export declare function contextUsageTone(percent: number): ContextProgressTone;
/** The gauge's four stages, one per theme feedback token. */
export type ContextProgressTone = 'info' | 'success' | 'warning' | 'error';
/** Color for one gauge stage. Filled cells and the percent value both come from
 *  this one call, so the bar and its number can never disagree. `theme` is the
 *  host's resolved theme (loosely typed at runtime); a missing token falls back
 *  to the theme's base text instead of an unstyled cell. Pure. */
export declare function contextProgressColor(stage: ContextProgressTone, theme: any): any;
/** The muted extra line under the gauge: `cache 92% · 42.3 tok/s`. Either half
 *  may be missing (no cache read, no measurable turn); no data at all yields
 *  null so no empty line is rendered. The speed keeps the host's own one
 *  decimal and `tok/s` label. Pure. */
export declare function contextPerformanceLine(performance: ContextPerformance | null | undefined): string | null;
/** Cache hit rate of one message: `cache.read / (input + cache.read)` as a
 *  percentage. The denominator must be > 0, otherwise the ratio is meaningless
 *  (a message that only wrote to the cache has no input to hit). Null when the
 *  numbers are absent. Pure. */
export declare function cacheHitPercent(tokens: any): number | null;
/** The message the cache hit rate comes from: the last assistant of the live
 *  window (see `transcriptWindow`) that actually carries `tokens`. Later
 *  messages without usage — a streaming placeholder that the host publishes
 *  before any step completes, a step that reports no usage — are skipped
 *  instead of blanking a ratio the previous message already measured. Null
 *  when nothing in the window has usage. Pure. */
export declare function lastAssistantWithTokens(messages: readonly any[] | null | undefined, revertMessageID?: string | null): any | null;
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
export declare function turnTokensPerSecond(messages: readonly any[] | null | undefined, position?: number | null): number | null;
/** Last-message telemetry the Context block renders in muted text. Both halves
 *  are optional; the block renders no line when neither is available. */
export type ContextPerformance = {
  cacheHit: number | null;
  tokensPerSecond: number | null;
};
/** Thousands-separated token total: `55320` → `55,320` (en-US, matching the
 *  native block this one replaces). Null for a missing/invalid value. Pure. */
export declare function formatTokenCount(tokens: number | null | undefined): string | null;
/** Context-window label: `1_000_000` → `1.0M`, `200_000` → `200K`,
 *  `128_000` → `128K`, `32_768` → `32K`. Sub-million limits truncate to whole K
 *  so the printed window never overstates the model's capacity. Pure. */
export declare function formatContextWindow(limit: number | null | undefined): string | null;
/** Cells in the Context gauge: always rendered in full, so the bar never
 *  changes width between refreshes. With the space, the percent and the
 *  `of <window>` tail (at most 9 columns) the line stays inside 34 columns. */
export declare const CONTEXT_BAR_CELLS = 12;
/** Filled cell (U+25B0) and empty cell (U+25B1), both single-width. */
export declare const CONTEXT_BAR_FILLED_CELL = "▰";
export declare const CONTEXT_BAR_EMPTY_CELL = "▱";
/** Filled cells for a percentage: rounded, clamped to `0..cells`, so 0% is an
 *  empty bar and anything at or above 100% is a full one. Pure. */
export declare function contextBarFilled(percent: number, cells?: number): number;
/** The gauge split into its toned half (filled cells) and its muted half (empty
 *  cells), so the caller colors each side. Null when the percentage is missing:
 *  the Context block then keeps its tokens + cost rows and renders no bar. Pure. */
export declare function contextBar(percent: number | null | undefined, cells?: number): {
  filled: string;
  empty: string;
} | null;
/** USD spent with two decimals (`$0.18`), the native block's format. Null for
 *  a missing/negative value. Pure. */
export declare function formatSpent(cost: number | null | undefined): string | null;
/** One rendered context row. `lead` and `tail` carry the gauge bar when the row
 *  has one (`lead` is toned with the value, `tail` is muted), so the 12 cells
 *  stay contiguous while the empty half still reads as background. */
export type ContextRow = {
  lead: string | null;
  value: string;
  tail: string | null;
  suffix: string | null;
  tone: ContextProgressTone | null;
};
/** The `Context` block's data rows; null rows are not rendered. */
export type ContextBlockRows = {
  tokens: ContextRow | null;
  percent: ContextRow | null;
  spent: ContextRow | null;
};
/** Rows for the `Context` block:
 *  `<tokens> tokens` / `▰▰▰▰▰▱▱▱▱▱▱▱ <percent>% of <window>` /
 *  `$<spent> spent`. The percentage row carries the only semantic tone, the
 *  gauge bar (12 cells) and is omitted entirely when the percentage is
 *  unavailable (never `undefined%`). A block with neither tokens nor cost
 *  yields null. Pure. */
export declare function contextBlockRows(usage: ContextUsage | null, cost: number | null | undefined): ContextBlockRows | null;
/** Models rendered in the Context block before the aggregate `… +N` line. */
export declare const MODEL_USAGE_VISIBLE_CEILING = 3;
/** Newest messages read per session — bounds the O(n) walk on long sessions. */
export declare const MODEL_USAGE_MESSAGE_LIMIT = 400;
/** Sessions read per family (root + delegations) for the aggregate. */
export declare const MODEL_USAGE_SESSION_LIMIT = 8;
/** Column widths for one model row (labels are muted, numbers right-aligned). */
export declare const MODEL_USAGE_MODEL_WIDTH = 12;
export declare const MODEL_USAGE_TOKEN_WIDTH = 6;
export declare const MODEL_USAGE_COST_WIDTH = 8;
/** Session events arrive in bursts; model rows are recomputed at most once
 *  per window (same cadence as the git-count revalidation). */
export declare const MODEL_USAGE_DEBOUNCE_MS = 400;
/** Real usage for one model, summed across the assistant messages that used it. */
export type ModelUsage = {
  model: string;
  tokens: number;
  cost: number;
};
/** Totals per model from assistant messages: sums `cost` and `tokens`, drops
 *  models whose real cost is 0/absent, and orders by cost (then tokens, then
 *  name). `providerID` participates in the key so two providers exposing the
 *  same bare id are not merged. Pure. */
export declare function collectModelUsage(messages: readonly any[]): ModelUsage[];
/** Visible rows plus the aggregate of the models that did not fit. Pure. */
export type ModelUsageCeiling = {
  visible: ModelUsage[];
  hidden: number;
  hiddenCost: number;
  hiddenTokens: number;
};
/** Cap the model list at `maxVisible`; the rest is aggregated (still real
 *  totals) for the `… +N` line. Pure. */
export declare function ceilingModelUsage(rows: readonly ModelUsage[], maxVisible?: number): ModelUsageCeiling;
/** Compact tokens for a model row (`80,000` → `80K`); `0` stays explicit. Pure. */
export declare function formatUsageTokens(tokens: number | null | undefined): string;
/** Real per-model cost with adaptive precision: cents for `>= $0.01`, up to
 *  four decimals below that (a real `$0.0031` must not render as `$0.00`), and
 *  an explicit `< $0.0001` for the remainder. Pure. */
export declare function formatUsageCost(cost: number | null | undefined): string | null;
/** One formatted model row: truncated label + compact tokens + real cost. */
export type ModelUsageRow = {
  model: string;
  tokens: string;
  cost: string;
};
/** Format the visible model rows for rendering. Labels are already short ids
 *  (12 chars); the second truncation only guards host drift. Pure. */
export declare function modelUsageRows(rows: readonly ModelUsage[]): ModelUsageRow[];
/** Exact single-line text of a model row, with numbers right-aligned. Pure. */
export declare function modelUsageRowText(row: ModelUsageRow): string;
/** Muted aggregate line for the models beyond the cap (`… +2  $0.03`). Null
 *  when every model fits. Pure. */
export declare function hiddenModelUsageText(hidden: number, hiddenCost: number): string | null;
/** Bucket for a session the host published without an agent id. */
export declare const UNKNOWN_AGENT = "?";
/** Agent key of a session or message: the trimmed id when it is a non-empty
 *  string, else the `?` bucket — never `undefined`. Pure. */
export declare function agentKey(value: unknown): string;
export type TodoStatus = 'in_progress' | 'pending' | 'completed' | 'cancelled';
/** One rendered todo row. `priority` is carried by the tool but not rendered:
 *  the reference block uses a single marker column. */
export type TodoItem = {
  content: string;
  status: TodoStatus;
};
/** Rows rendered before the `… +N` line. */
export declare const TODO_VISIBLE_CEILING = 6;
/** Content width before the ellipsis — the block has ~30-34 usable columns. */
export declare const TODO_TEXT_WIDTH = 28;
/** Narrow a loose `status` value to the tool's four states. */
export declare function isTodoStatus(value: unknown): value is TodoStatus;
/** Items from a `todowrite` `input` payload. A missing/malformed `input`,
 *  absent `todos`, an unknown `status` or an empty/missing `content` drops the
 *  entry instead of throwing; a list with nothing readable yields `[]`. Pure. */
export declare function parseTodoItems(input: unknown): TodoItem[];
/** Newest completed `todowrite` in a transcript. The tool replaces the list
 *  wholesale, so the last write wins; a write with `todos: []` returns null
 *  (the block disappears rather than showing the previous list) and a
 *  not-yet-completed write is ignored. Null when the transcript carries no
 *  such part, so the block never renders a guess. Pure. */
export declare function latestTodoItems(messages: readonly any[] | null | undefined): TodoItem[] | null;
/** Stable group order (in_progress → pending → completed → cancelled); within a
 *  group the transcript order is preserved. Pure. */
export declare function orderTodoItems(items: readonly TodoItem[]): TodoItem[];
/** Row color channel: `accent` for live work, `muted` for closed items, base
 *  for pending. Kept separate from the theme so it is testable. Pure. */
export type TodoTone = 'accent' | 'muted' | 'base';
/** Tone for one status — no rainbow, a single accent. Pure. */
export declare function todoTone(status: TodoStatus): TodoTone;
/** Exact rendered text of one row: `[•] <content truncated to 28>`. Pure. */
export declare function todoRowText(item: TodoItem): string;
/** Ordered rows capped for the sidebar, plus how many did not fit. Pure. */
export type TodoCeiling = {
  visible: TodoItem[];
  hidden: number;
};
/** Order then cap the list at `maxVisible`. Pure. */
export declare function ceilingTodoItems(items: readonly TodoItem[], maxVisible?: number): TodoCeiling;
/** Overflow line (`… +3`); null when every item fits. Pure. */
export declare function hiddenTodoText(hidden: number): string | null;
export type GitChangeCounts = {
  added: number;
  modified: number;
  deleted: number;
};
/** Files per status from a `VcsFileStatus[]` payload. Unknown statuses and
 *  malformed entries are ignored. Pure. */
export declare function countGitChanges(files: readonly any[] | null | undefined): GitChangeCounts;
/** `+1 ±2 −3` for the file counts; each zero term is omitted, and an empty
 *  change set returns null so the row is not rendered at all. Pure. */
export declare function formatGitChanges(files: readonly any[] | null | undefined): string | null;
/** Wall-clock ceiling for one git call. A stuck git (index lock, network
 *  filesystem) is killed instead of holding the row forever. */
export declare const GIT_CLI_TIMEOUT_MS = 2000;
/** Session events arrive in bursts; a git probe is scheduled at most once per
 *  window instead of once per event. */
export declare const GIT_CLI_DEBOUNCE_MS = 1000;
/** Minimum spacing between two probe starts. Five seconds keeps a chatty event
 *  stream from spawning a git process per step while staying fresh enough to
 *  show a file appearing mid-turn. */
export declare const GIT_CLI_MIN_INTERVAL_MS = 5000;
/** Stdout ceiling for one git call. `status --porcelain=v1 -uall` lists every
 *  untracked file, so a large worktree easily passes the 1 MB `execFile`
 *  default — which would reject and silently hand the row back to the
 *  `vcs.status` fallback. 4 MB is far above a realistic porcelain listing. */
export declare const GIT_CLI_MAX_BUFFER: number;
/** One `execFile` call: `(file, args, options) → { stdout }`. Injectable so the
 *  parsing/gating logic is testable without spawning processes. */
export type GitExec = (file: string, args: readonly string[], options: {
  cwd: string;
  timeout: number;
  windowsHide: boolean;
  maxBuffer: number;
}) => Promise<{
  stdout: string;
}>;
/** Default runner: the promisified `node:child_process.execFile`. A non-zero
 *  exit (no repository, no upstream) rejects and the caller decides. */
export declare const defaultGitExec: GitExec;
/** Files per status from `git status --porcelain=v1 -uall`, including the two
 *  columns the protocol cannot report. Each line starts with `XY` (index and
 *  worktree state); a rename prints `R  old -> new`, and `??` / `!!` are
 *  untracked / ignored. Precedence per file: deleted > added > modified, so
 *  `AM` counts once as added and `AD` once as deleted. Renames, copies and
 *  unmerged entries count as modified. Pure. */
export type GitPorcelainCounts = {
  added: number;
  modified: number;
  deleted: number;
  untracked: number;
};
/** Parse porcelain v1 output into file counts. Empty/malformed output yields
 *  zero counts (a clean tree), never a throw. Pure. */
export declare function parseGitStatusPorcelain(output: string | null | undefined): GitPorcelainCounts;
/** `git rev-list --count --left-right @{upstream}...HEAD` prints two numbers:
 *  commits only on the upstream (behind) then commits only on HEAD (ahead).
 *  Null when the output is not that pair — e.g. the command failed because the
 *  branch has no upstream, in which case the arrows are simply omitted. Pure. */
export declare function parseGitAheadBehind(output: string | null | undefined): {
  ahead: number;
  behind: number;
} | null;
/** One git observation: file counts plus the upstream distance (either arrow
 *  may be unknown when the branch has no upstream). */
export type GitCliSnapshot = {
  changes: GitPorcelainCounts;
  ahead: number | null;
  behind: number | null;
};
/** One probe: `git status --porcelain=v1 -uall` for the counts, then
 *  `git rev-list --count --left-right @{upstream}...HEAD` for the arrows (a
 *  failure there only drops the arrows). A status failure rejects — the caller
 *  then falls back to `client.vcs.status`. */
export declare function readGitSnapshot(directory: string, exec?: GitExec): Promise<GitCliSnapshot>;
/** Rendered git row: `+1 ±2 −1 ?2 ↑3 ↓1`, zero terms omitted. Null when the
 *  tree is clean and in sync, so the block keeps only its branch line. Pure. */
export declare function formatGitSnapshot(snapshot: GitCliSnapshot | null | undefined): string | null;
/** Whether a new probe may start. An in-flight probe always wins (no queue), and
 *  the previous start must be older than the cooldown. Pure. */
export declare function gitProbeAllowed(state: {
  now: number;
  lastRunAt: number | null;
  inFlight: boolean;
}, cooldownMs?: number): boolean;
/** Spend window labels, in render order. */
export declare const SPEND_TODAY_LABEL = "hoje";
export declare const SPEND_30D_LABEL = "30d";
/** Separator between the two windows on the Context footer line. */
export declare const SPEND_LINE_SEPARATOR = " · ";
/** `30d` window: 30 × 24 h, measured back from "now". */
export declare const SPEND_30D_MS: number;
/** Probe window: one hour, narrow enough that a unit mix-up cannot line up. */
export declare const SPEND_PROBE_WINDOW_MS: number;
/** The echoed `range` may be rounded server-side; 120 s absorbs that. */
export declare const SPEND_PROBE_TOLERANCE_MS = 120000;
/** Session events arrive in bursts — same 400 ms window as the other blocks. */
export declare const SPEND_REFRESH_DEBOUNCE_MS = 400;
/** Spend per window in USD. Either side may be unknown (kept `null`). */
export type SpendTotals = {
  today: number | null;
  thirtyDays: number | null;
};
/** `from`/`to` unit accepted by the route. `SessionStatsInput` declares both as
 *  bare `number` and does not say which unit, so it is measured once per
 *  process (`ms` unless the server echoes seconds) instead of guessed. */
type SpendUnit = 'ms' | 's' | 'unavailable';
/** Test-only: forget the process-wide unit resolution. Never called at runtime. */
export declare function resetSpendUnit(): void;
/** Resolved unit (`ms` / `s` / `unavailable`) or null while still unknown. */
export declare function resolvedSpendUnit(): SpendUnit | null;
/** Local midnight for `now`: `new Date()` with the clock fields zeroed in the
 *  current timezone (DST-safe, unlike subtracting hours). Pure. */
export declare function startOfLocalDay(now: number): number;
/** The two windows the block shows: `hoje` (local midnight → now) and `30d`
 *  (now − 30 days → now). Pure. */
export declare function spendWindows(now: number): {
  today: {
    from: number;
    to: number;
  };
  thirtyDays: {
    from: number;
    to: number;
  };
};
/** USD with two decimals (`$0.42`), four for a positive sub-cent amount
 *  (`$0.0031`), and `<$0.0001` when even four decimals would read `$0.0000`.
 *  `0` prints `$0.00`. Null for a missing/negative/non-finite value. Pure. */
export declare function formatSpendUSD(cost: number | null | undefined): string | null;
/** `cost` off a `SessionStatsInfo` (`MoneyUSD` = number) or null when the
 *  payload is malformed/negative, so a bad value never reaches a row. Pure. */
export declare function statsCost(result: unknown): number | null;
/** True when the server echoed the window we sent, within 120 s. `scale` is how
 *  many milliseconds one unit of the sent window is worth (`1` for `ms`, `1000`
 *  for `s`). The echo is accepted either as the same numbers we sent (the route
 *  keeps the caller's unit) or converted to millisecond epoch (`DateTime.Utc`),
 *  so the probe pins the unit without assuming which of the two it gets. Pure. */
export declare function statsRangeMatches(range: unknown, sent: {
  from: number;
  to: number;
}, scale: number): boolean;
/** The `Context` block's last line: both spend windows on one muted row
 *  (`hoje $0.42 · 30d $9.80`). A window without a usable amount is omitted, and
 *  no usable window at all yields null so the line (and not the block) is
 *  dropped. Pure. */
export declare function contextSpendLine(totals: SpendTotals | null): string | null;
/** Terminal cells `value` occupies — the unit every column in this plugin is
 *  measured in. Mirrors the host (that is how `@opentui/core` sizes a text
 *  run): emoji count as two cells, East Asian Wide/Fullwidth as two, East
 *  Asian Ambiguous as one, combining marks and variation selectors as none.
 *  Pure. */
export declare function cellWidth(value: string): number;
/** Clamp a free-form label to `max` terminal cells without wrapping. The width
 *  is measured in display cells, never in UTF-16 code units: a CJK or emoji
 *  label used to overflow the column it was cut for (`計画の移行` is 5 code
 *  units but 10 cells, `🚀` is 2 units and 2 cells). Pure. */
export declare function truncateLabel(value: string, max?: number): string;
/** Right-pad `value` with spaces to exactly `cells` display columns (a wider
 *  value is truncated first). `padEnd` counts code units, so it under-pads a
 *  CJK/emoji cell and the next column drifts. Pure. */
export declare function padCell(value: string, cells: number): string;
/** Columns the fixed header may use before it would wrap the sidebar. */
export declare const HEADER_MAX_WIDTH = 34;
/** Preset row of the fixed header: `▸ <preset> · <provider>`. The provider is
 *  cut first when the row overflows, so the preset name is never the casualty;
 *  a missing provider leaves the preset alone (no `unknown` placeholder). */
export declare function presetHeaderLine(presetName: string, providerID: string | null): string;
export type DispatchKind = 'coun' | 'plan' | 'revw' | 'hot' | 'disc' | 'oth';
export type DispatchKindOrigin = 'prefix' | 'agent' | 'unavailable';
/** One classification plus the evidence that produced it. */
export type DispatchKindLabel = {
  kind: DispatchKind | null;
  origin: DispatchKindOrigin;
};
/** Kind declared by a leading `[prefix]` on the description: case-insensitive
 *  and tolerant of spaces inside the brackets. Null when none is declared. */
export declare function dispatchKindFromPrefix(description: unknown): DispatchKind | null;
/** Kind implied by the child's agent, null for an agent that implies none. */
export declare function dispatchKindFromAgent(agent: unknown): DispatchKind | null;
/** Classify one dispatch. The description prefix always wins over the agent;
 *  otherwise the agent decides, and anything else is `oth` (a real dispatch we
 *  simply cannot name). A missing call is the only `unavailable` outcome. Pure. */
export declare function classifyDispatchKind(call: {
  description?: unknown;
  agent?: unknown;
} | null | undefined): DispatchKindLabel;
/** A `subagent` tool call the parent made, as its own transcript records it. */
export type SubagentCall = {
  /** Child session id the call created — the correlation key. */
  sessionID: string;
  agent: string;
  description: string;
  background: boolean;
};
/** Correlate the parent transcript's `subagent` calls with the children they
 *  spawned: child session id → `{ agent, description, background }`. One pass
 *  over the list the sidebar already holds — no request, no `message.sync` on
 *  the child. `streaming`/`pending` states carry their input as *partial JSON
 *  text*, so they are skipped rather than parsed. Fail-open: a malformed part
 *  contributes nothing. Pure. */
export declare function collectSubagentCalls(messages: readonly any[] | null | undefined): Map<string, SubagentCall>;
export type DelegationState = 'running' | 'completed' | 'failed' | 'interrupted';
export type DelegationTone = 'warning' | 'error' | 'success';
/** Grace window for a child that has not started yet. V2's `session.status()`
 *  returns `idle` both for "created but not started" and for "finished", so an
 *  idle/unknown/absent child whose own last activity (`time.updated`, falling
 *  back to `time.created`) is this recent still reads as running — otherwise a
 *  just-spawned child renders a premature ✓. Trade-off (V1 parity: it had the
 *  same window for its absent statuses): a child that finished within the window
 *  and reports no `outcome` reads as running until the window closes, at which
 *  point it turns terminal and its completion toast fires. A child that reports
 *  a terminal `outcome` is never held back by the window. */
export declare const DELEGATION_CHILD_STATUS_GRACE_MS: number;
/** One delegated child job as the sidebar renders it. */
export type DelegationView = {
  /** Child session id — also the click-through target. */
  id: string;
  /** Alias shown on the row: the child title, else agent, else short id. */
  label: string;
  state: DelegationState;
  /** Epoch ms of the child's `time.created`. */
  startedAt: number | null;
  /** Epoch ms of the child's `time.updated`. */
  updatedAt: number | null;
  /** Child agent id, when the host published one. */
  agent: string | null;
  /** Resolved child model, shortened to its bare id. */
  model: string | null;
  /** Real `SessionInfo.cost` for the child, null when the host published none. */
  cost: number | null;
  /** Why the child exists — see `classifyDispatchKind`. Null when no `subagent`
   *  call in the parent transcript could be correlated with this child. */
  kind: DispatchKind | null;
  /** Which evidence produced `kind`. */
  kindOrigin: DispatchKindOrigin;
  /** The parent asked for this child to run in the background. */
  background: boolean;
};
/** Map the host's live session status to a display state. V2 exposes only
 *  `"idle" | "running"` through the TUI context (the client union adds `retry`
 *  and `busy`); `error`/`failed` are handled defensively for host drift.
 *  `idle`, `retry` and unknown/absent statuses are terminal only once the
 *  child's own activity is older than the grace window — within it the child
 *  reads as running (see `DELEGATION_CHILD_STATUS_GRACE_MS`). An interruption is
 *  not part of this union: it arrives as a terminal `outcome`. Pure. */
export declare function delegationStateFromStatus(status: string | undefined, time?: {
  created?: number;
  updated?: number;
}, now?: number, graceMs?: number): DelegationState;
/** Map a V2 child `outcome` to a display state. `interrupted` (user abort,
 *  shutdown, superseded, inactivity) is distinct from both success and failure,
 *  so an aborted child never renders the ✓ of a completed one. Returns null for
 *  an absent/unrecognised outcome so the live status decides. Pure. */
export declare function delegationStateFromOutcome(outcome: unknown): DelegationState | null;
/** Build a delegation row from a child session + its live status, plus the
 *  `subagent` call that spawned it (when the parent transcript had one). A
 *  terminal `outcome` wins when present (the only V2 primitive that surfaces a
 *  delegation failure/interruption once the status is back to idle); otherwise
 *  the live status decides, with the absent/idle grace window applied. The
 *  `call` only ever *adds* the purpose and the background flag — an absent one
 *  leaves the row fully renderable. Pure. */
export declare function toDelegationView(child: any, status: string | undefined, now?: number, call?: SubagentCall | null): DelegationView;
/** Spinner glyph for a frame counter (incremented every ~80ms while any job is
 *  running). Pure. */
export declare function spinnerFrame(frame: number): string;
/** Token totals published on `SessionInfo.tokens`, one entry per counter. */
export type DispatchTokens = {
  input: number | null;
  output: number | null;
  reasoning: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
};
/** One child of the dispatch tree: the delegation row plus the fields only the
 *  panel's detail view needs (`SessionInfo.title`/`parentID`/`tokens` and the
 *  spawning call's description). */
export type DispatchEntry = {
  view: DelegationView;
  title: string | null;
  description: string | null;
  parentID: string | null;
  tokens: DispatchTokens | null;
};
/** Optional inputs of `collectDispatch`: a fixed clock (tests/render ticks) and
 *  an already-computed `agent` map, so a caller that walked the parent
 *  transcript anyway never pays for a second walk. */
export type CollectDispatchOptions = {
  now?: number;
  calls?: Map<string, SubagentCall>;
};
/** Token counters of a child, null when the host published none of them. Pure. */
export declare function dispatchTokens(tokens: unknown): DispatchTokens | null;
/** One child `SessionInfo` + its live status → `DispatchEntry`. The call only
 *  ever adds the kind and the description; an absent one leaves the entry fully
 *  renderable. Pure. */
export declare function toDispatchEntry(child: any, status: string | undefined, now?: number, call?: SubagentCall | null): DispatchEntry;
/** The delegation tree of `sessionID` — every child `session.family` returns,
 *  root excluded, each enriched from `session.get`/`session.status` and the
 *  parent's `subagent` calls. Empty when the family API is unavailable or the
 *  session id is not a real handle (never falls back to the root). Ordered by
 *  the shared `compareDelegations`, so callers render the same list in the same
 *  order. A family that repeats an id yields one row per child: the id is
 *  deduplicated before the walk, so a duplicate can never double a row or its
 *  cost. */
export declare function collectDispatch(context: any, sessionID: string | undefined, options?: CollectDispatchOptions): DispatchEntry[];
/** Sidebar blocks in render order. Spacing is derived from this list instead of
 *  from the view, so a hidden block can never leave an empty gap behind. */
export type SidebarBlockKey = 'context' | 'git' | 'todo' | 'dispatch';
/** One rendered block: its key, and whether a blank line precedes it. */
export type SidebarBlock = {
  key: SidebarBlockKey;
  spacer: boolean;
};
/** Header glyph per block — one codepoint each, rendered muted before the bold
 *  label. The fixed header (version/preset/session) takes none.
 *  Measured as one terminal cell by the host (`@opentui/core` counts
 *  `emoji-regex` matches as two): ▤ U+25A4 (EAW=A), ◆ U+25C6 (A), ▾ U+25BE (N),
 *  ◈ U+25C8 (A). `☑` U+2611 was rejected for the Todo header because it matches
 *  `emoji-regex` and would occupy two cells; `⌁` U+2301 (the old Dispatch glyph)
 *  was replaced by the host's own Notice glyph. */
export declare const BLOCK_ICONS: Record<SidebarBlockKey, string>;
/** Tag every block that has content with its spacer: never before the first
 *  (the view puts a single blank line after the fixed header instead), one
 *  blank line before every later block. A repeated key collapses instead of
 *  stacking spacers, so an absent optional block can never leave a double gap.
 *  Pure. */
export declare function withBlockSpacers(keys: readonly SidebarBlockKey[]): SidebarBlock[];
/** Live children rendered one row each; the rest collapse into `… +N rodando`. */
export declare const DISPATCH_RUNNING_CEILING = 3;
/** Agent rollup rows rendered before the `… +K  $<soma>` line. */
export declare const DISPATCH_AGENT_CEILING = 3;
/** Hard cap on the block's rendered rows, header included. The sidebar is
 *  short; live work is served first, then the finished rollup. */
export declare const DISPATCH_MAX_LINES = 8;
/** Marker of the aggregated "finished" section. */
export declare const DISPATCH_DONE_MARKER = "✓";
/** Column width of the agent (or of its title/id fallback). */
export declare const DISPATCH_AGENT_WIDTH = 12;
/** Narrowest agent column a row may fall back to before the cost is kept whole
 *  and the label truncates further. */
export declare const DISPATCH_MIN_AGENT_WIDTH = 8;
/** Column width of the short model id — the model is dropped before the agent
 *  or the cost so a row always fits. */
export declare const DISPATCH_MODEL_WIDTH = 7;
/** Column width of the per-dispatch cost (`$0.04`; a sub-cent cost widens it). */
export declare const DISPATCH_COST_WIDTH = 5;
/** Column width of the duration (`12.7s` / `1m04s` / `820ms`). */
export declare const DISPATCH_DURATION_WIDTH = 5;
/** Column width of the `×<count>` cell of an agent rollup row. */
export declare const DISPATCH_COUNT_WIDTH = 3;
/** Column width of an agent rollup cost (`$0.0051` still fits). */
export declare const DISPATCH_GROUP_COST_WIDTH = 7;
/** Hard column budget for one row — a Dispatch line never wraps:
 *  marker(2) + agent(12) + model(7) + cost(5) + duration(5) + 3 spaces = 34.
 *  The kind suffix (`·disc`, `·disc~`) is wider evidence than the model, so a
 *  classified row spends the model's columns first: marker(2) + agent(≤12) +
 *  suffix(≤6) + cost(5) + duration(5) + 2 spaces ≤ 32, still inside 34. */
export declare const DISPATCH_MAX_WIDTH = 34;
/** Kind suffix glued to a row's label: `·disc`, `·disc~` for a background run,
 *  and empty when the child could not be classified (the row then reads exactly
 *  as before). Pure. */
export declare function dispatchKindSuffix(kind: DispatchKind | null | undefined, background?: boolean): string;
/** Header summary: `2 rodando · $3.49`. The live count is omitted when nothing
 *  runs, and the total spend is always printed (the header only renders while
 *  the tree has children, so `$0.00` is a real answer). Pure. */
export declare function dispatchHeaderSummary(running: number | null | undefined, cost: number | null | undefined): string | null;
/** Compact duration without an internal space: `820` → `820ms`, `12_400` →
 *  `12.4s`, `64_000` → `1m04s`, `3_780_000` → `1h03m`, `172_800_000` → `2d`.
 *  An absent or negative value renders an em dash, never `NaN`s. Pure. */
export declare function formatDispatchDuration(ms: number | null | undefined): string;
/** Elapsed label for one row: a live child measures `now - created`, a finished
 *  one freezes at `updated - created` (em dash when a timestamp is missing).
 *  Pure. */
export declare function dispatchElapsed(view: DelegationView, now?: number): string;
/** Name column: the agent when the host published one, else the child title,
 *  else the short id — never `undefined`. Truncated to the column width. Pure. */
export declare function dispatchAgentText(view: Pick<DelegationView, 'agent' | 'label' | 'id'>, max?: number): string;
/** Model column, empty when the host published none. Pure. */
export declare function dispatchModelText(view: Pick<DelegationView, 'model'>): string;
/** Cost column: the child's real `SessionInfo.cost` with two decimals (up to
 *  four below a cent, so `$0.0031` never collapses to `$0.00`), `$0.00` for a
 *  zero cost, and an em dash when the host published no numeric cost. Pure. */
export declare function formatDispatchCost(cost: number | null | undefined): string;
/** Total spend of every child (live + finished), `0` when none published a
 *  numeric cost. Pure. */
export declare function dispatchTotalCost(views: readonly DelegationView[]): number;
/** One live child: `⠸ <agent 12>·<kind> <custo> <duração>`, with the model as a
 *  fourth column only when the row still fits and the child is unclassified —
 *  the kind is the stronger evidence at this width, so it takes the model's
 *  columns. The kind rides glued to the label (never a column of its own) and
 *  disappears with the label's truncation; then the agent column shrinks (never
 *  below `DISPATCH_MIN_AGENT_WIDTH`); the cost is always present — `$0.00` for a
 *  zero cost, an em dash for a missing one. Pure. */
export declare function runningChildRowText(view: DelegationView, now?: number, frame?: number, max?: number): string;
/** Sessions and spend attributed to one agent in the finished section. `kind`
 *  is only set when every finished session of the group agrees on it — a mixed
 *  group carries no single purpose, so the row omits it rather than picking one.
 *  `background` follows the same rule (all of them background). */
export type ChildAgentUsage = {
  agent: string;
  count: number;
  cost: number;
  kind: DispatchKind | null;
  background: boolean;
};
/** Rollup of the finished children by agent: `×count` sessions and the summed
 *  `SessionInfo.cost`. Failed and interrupted children are included (they are
 *  finished); running ones are not. The group's kind survives only when the
 *  whole group agrees, so an aggregate row never claims a purpose it cannot
 *  prove. Ordered by cost, then count, then name. Pure. */
export declare function collectChildAgentUsage(views: readonly DelegationView[]): ChildAgentUsage[];
/** One agent rollup row: `<agent 12> ×<count 3>·<kind> <custo 7>`. The kind is
 *  glued to the count (the row's only label) and omitted for a mixed group; the
 *  agent column shrinks (never below the minimum) before the cost, which is
 *  what the row is for. Pure. */
export declare function childAgentRowText(row: ChildAgentUsage, max?: number): string;
/** The `… +K  $<soma>` line for agents beyond the rollup cap. Null when every
 *  agent fits. Pure. */
export declare function hiddenChildAgentsText(hidden: number, hiddenCost: number): string | null;
/** Summary of the finished section: `✓ 70 · $3.40 · 9 agentes`. `· $<soma>` is
 *  omitted when nothing was spent and `· 1 agente` when a single agent owns
 *  every finished child; `✓ <total>` always prints. Null when nothing finished.
 *  Pure. */
export declare function completedSummaryText(completed: number | null | undefined, cost: number | null | undefined, agents: number | null | undefined): string | null;
/** The `· <F> falhas` suffix of the finished summary, null when nothing failed.
 *  Pure. */
export declare function failedSuffixText(failures: number | null | undefined): string | null;
/** One rendered live row: its text plus the session it navigates to. */
export type DispatchRunningLine = {
  id: string;
  text: string;
};
/** Everything the `Dispatch` block renders, already joined and capped. */
export type DispatchBlockView = {
  runningCount: number;
  completedCount: number;
  agentCount: number;
  failures: number;
  totalCost: number;
  running: DispatchRunningLine[];
  runningHidden: number;
  summary: string | null;
  agents: ChildAgentUsage[];
  agentsHidden: number;
  agentsHiddenCost: number;
};
/** Build the whole block from the child set. Null when there is no child, so
 *  the block (and its spacer) never renders empty. Live work is capped at
 *  `DISPATCH_RUNNING_CEILING` and the finished rollup at
 *  `DISPATCH_AGENT_CEILING`, with the rollup giving up rows first to keep the
 *  block inside `DISPATCH_MAX_LINES`. Pure. */
export declare function buildDispatchBlock(views: readonly DelegationView[], now?: number, frame?: number, max?: number): DispatchBlockView | null;
/** Panel content name, registered by the `session.panel` claim and passed to
 *  `ui.panel.open`. */
export declare const DISPATCH_PANEL_NAME = "pantheon.dispatch";
/** Toast shown when `ui.panel.open` refuses (no session route is active). The
 *  panel only exists inside a session, so there is no alternative route. */
export declare const DISPATCH_PANEL_TOAST = "Abra uma sessão para ver o Dispatch";
/** Panel title marker — the same glyph the sidebar block header uses. */
export declare const DISPATCH_PANEL_HEADER_MARKER = "◈";
/** Selected-row gutter marker (`▸`, one cell). */
export declare const DISPATCH_PANEL_SELECTION_MARKER = "▸";
/** Cells the selection gutter occupies before a row's own text. */
export declare const DISPATCH_PANEL_SELECTION_GUTTER = 2;
/** Column of the horizontal rule under the header. */
export declare const DISPATCH_PANEL_RULE_CHAR = "─";
/** Em dash for any datum the host did not publish. */
export declare const DISPATCH_PANEL_DASH = "—";
/** Body of an empty panel (the claim still renders, the list is just empty). */
export declare const DISPATCH_PANEL_EMPTY_TEXT = "Nenhuma sessão delegada";
/** Width at or above which the list and the detail sit side by side. */
export declare const DISPATCH_PANEL_WIDE_MIN_WIDTH = 72;
/** Rows the viewport holds; pageup/pagedown move by exactly this many rows. */
export declare const DISPATCH_PANEL_PAGE_SIZE = 10;
/** Panel row columns: marker(2) + agent(12) + kind(4) + cost(≥7) + duration(8).
 *  The cost column is at least this wide; a sub-cent cost widens it per row. */
export declare const DISPATCH_PANEL_AGENT_WIDTH = 12;
export declare const DISPATCH_PANEL_MIN_AGENT_WIDTH = 6;
export declare const DISPATCH_PANEL_KIND_WIDTH = 4;
export declare const DISPATCH_PANEL_COST_WIDTH = 7;
export declare const DISPATCH_PANEL_DURATION_WIDTH = 8;
/** Title column budget (`◈ Dispatch — <sessão>`). */
export declare const DISPATCH_PANEL_TITLE_WIDTH = 44;
/** Badge appended to the title while the host presents the panel full screen. */
export declare const DISPATCH_PANEL_FULLSCREEN_BADGE = "[fullscreen]";
/** Human labels of a kind's evidence, as the detail line prints them. */
export declare const DISPATCH_KIND_ORIGIN_LABELS: Readonly<Record<DispatchKindOrigin, string>>;
/** Entries in row order: live work first, then most recent activity — the same
 *  comparator the sidebar block uses. Pure. */
export declare function orderDispatchEntries(entries: readonly DispatchEntry[]): DispatchEntry[];
/** `◈ Dispatch — <sessão>`, with the session title truncated (never wrapped),
 *  plus the `[fullscreen]` badge while the host presents the panel full screen.
 *  An absent title leaves the marker and the name alone. Pure. */
export declare function dispatchPanelTitle(sessionTitle: string | null | undefined, max?: number, presentation?: string): string;
/** Header counters: `2 rodando · 70 concluídos · 1 falha · $3.59`. A zero
 *  counter is omitted (never `0 rodando`); the total spend is printed whenever
 *  the tree has a child, because `$0.00` is then a real answer. Null for an
 *  empty tree, so the header renders no counter line at all. Pure. */
export declare function dispatchPanelHeader(entries: readonly DispatchEntry[] | null | undefined): string | null;
/** Horizontal rule under the header, clamped to the panel's own width. Pure. */
export declare function dispatchPanelRule(width: number, max?: number): string;
/** Row marker: animated spinner while running, `✓` done, `✗` failed, `○`
 *  cancelled/interrupted, `?` for a state the host never publishes. Every glyph
 *  is one cell wide and `?` is the only fallback, so an unknown state is visible
 *  instead of silently rendering as success. Pure. */
export declare function dispatchPanelMarker(state: DelegationState | string, frame?: number): string;
/** One padded, truncated cell: an absent/blank value becomes the em dash, and
 *  the value is cut to the cell's own width (never to the line's length, so one
 *  long cell cannot squeeze its neighbours out of alignment). Pure. */
export declare function dispatchPanelCell(value: unknown, width: number): string;
/** One list row: `⠋ prometheus   plan   $0.09  14m34s`. The agent cell absorbs
 *  the width difference (down to `DISPATCH_PANEL_MIN_AGENT_WIDTH`), so a narrow
 *  panel truncates the label rather than the numbers; the cost column grows by
 *  itself for a sub-cent value so the row never spends more than its budget.
 *  Pure. */
export declare function dispatchPanelRowText(entry: DispatchEntry, options?: {
  now?: number;
  frame?: number;
  max?: number;
}): string;
/** `ses_ab12cd`, short enough for a detail line. Full id when it already fits. */
export declare function shortSessionID(id: string | null | undefined, max?: number): string;
/** Token counters of one child on a single line (`in 1.2K · out 430 · r 120 ·
 *  cache 8K/1K`), or `tokens —` when the host published none. Pure. */
export declare function dispatchTokenLine(tokens: DispatchTokens | null | undefined): string;
/** Detail lines of the selected child: heading (title, else the spawning
 *  description, else the row label), short id + model, token counters, and the
 *  kind plus its evidence and the parent id. Two to four lines; `expanded:
 *  false` keeps only the heading. Every missing datum prints `—`. Pure. */
export declare function dispatchPanelDetail(entry: DispatchEntry | null | undefined, options?: {
  expanded?: boolean;
  max?: number;
}): string[];
/** Panel geometry for its input width: wide (≥72) puts the detail in a second
 *  column, narrow stacks it under the list. `rowWidth` is what a list row may
 *  spend after the selection gutter. Pure. */
export type DispatchPanelLayout = {
  mode: 'wide' | 'narrow';
  listWidth: number;
  detailWidth: number;
  rowWidth: number;
};
export declare function dispatchPanelLayout(width: number): DispatchPanelLayout;
/** Viewport of the list: the page holding the selection, scrolled so the
 *  selected row stays visible with its predecessors. Bounded, so a 71-child
 *  tree renders ten rows, never all of them. Pure. */
export declare function dispatchPanelWindow(total: number, selectedIndex: number, pageSize?: number): {
  start: number;
  end: number;
  size: number;
};
/** `1-10 de 71` while the list is longer than one page; null when everything
 *  fits (and for an empty list), so the footer never pads itself. Pure. */
export declare function dispatchPanelRangeText(start: number, end: number, total: number): string | null;
/** One rendered list row, selection resolved by the view against the model's
 *  selected id. */
export type DispatchPanelRow = {
  id: string;
  state: DelegationState;
  text: string;
};
/** Every entry as a row, ordered by the shared comparator. Pure. */
export declare function dispatchPanelRows(entries: readonly DispatchEntry[] | null | undefined, options?: {
  now?: number;
  frame?: number;
  max?: number;
}): DispatchPanelRow[];
/** Panel action, one per command. */
export type DispatchPanelAction = 'up' | 'down' | 'home' | 'end' | 'pageup' | 'pagedown' | 'toggle' | 'fullscreen' | 'close';
/** One namespaced command: stable id, explicit binding, and the action it runs. */
export type DispatchPanelCommandSpec = {
  action: DispatchPanelAction;
  id: string;
  title: string;
  bind: string;
};
/** The panel's whole keymap, in table order. `bind` is explicit for every
 *  command (no auto-binding), and every id is namespaced, so a `k`/`q`/`f`
 *  binding can never collide with the host's own keys. */
export declare const DISPATCH_PANEL_COMMANDS: readonly DispatchPanelCommandSpec[];
/** Run one action against the model and the host-owned panel input. Kept apart
 *  from the keymap so the whole command surface is testable without a renderer.
 */
export declare function performDispatchPanelAction(action: DispatchPanelAction, model: Pick<DispatchPanelModel, 'move' | 'first' | 'last' | 'pageUp' | 'pageDown' | 'toggle'>, panel: Pick<PanelInput, 'close' | 'toggleFullscreen'>): void;
/** Footer: the keys the host reports for each command (`keymap.shortcuts`) with
 *  an em dash whenever a command has no binding, so the hint can never advertise
 *  a key that does nothing. Pure. */
export declare function dispatchPanelFooter(shortcutsOf: (id: string) => readonly string[]): string;
/** The subset of `PanelInput` the model reads, so tests can drive it with a
 *  plain object. */
export type DispatchPanelInput = {
  readonly name: string;
  readonly sessionID: string;
  readonly width: number;
  readonly presentation?: string;
};
/** Open the panel from the command palette / slash command. `ui.panel.open`
 *  only accepts a `session` route, so a refusal (no session open) is answered
 *  with a toast — never a fallback route, never a silent no-op. Returns whether
 *  the panel opened. */
export declare function openDispatchPanel(context: any): boolean;
/** Reactive state the panel view renders. Selection is held by session id, so
 *  it survives list updates; the index is derived (and falls back to the first
 *  row when the selected child disappears). */
export type DispatchPanelModel = {
  entries: Accessor<DispatchEntry[]>;
  rows: Accessor<DispatchPanelRow[]>;
  title: Accessor<string>;
  header: Accessor<string | null>;
  detail: Accessor<string[]>;
  layout: Accessor<DispatchPanelLayout>;
  visible: Accessor<{
    start: number;
    rows: DispatchPanelRow[];
  }>;
  selectedID: Accessor<string | null>;
  selectedIndex: Accessor<number>;
  expanded: Accessor<boolean>;
  hasRunning: Accessor<boolean>;
  frame: Accessor<number>;
  footer: Accessor<string>;
  move: (delta: number) => void;
  first: () => void;
  last: () => void;
  pageUp: () => void;
  pageDown: () => void;
  toggle: () => void;
};
/** Model behind the panel. Mounted only while the panel claim renders (the
 *  `Show` in `session.panel`), so the 80 ms tick it arms exists exactly while
 *  the panel is open; it also stops on `isOpen()` going false and on dispose.
 *  It performs no `message.sync`, writes no `session.metadata` and makes no
 *  request: `collectDispatch` reads only host-cached state. */
export declare function createDispatchPanelModel(context: any, panel: () => DispatchPanelInput): DispatchPanelModel;
/** Session ids to eagerly sync at load (deduped, bounded). Pure. */
export declare function collectWarmupTargets(sessions: readonly any[], limit?: number): string[];
/** Body a sidebar instance renders when the host has not published a real
 *  session id yet. OpenCode V2 scopes the `sidebar.content` slot to a session
 *  (`SlotMap["sidebar.content"] = { sessionID: string }`), so before the first
 *  prompt the slot may not mount at all — see the `home.footer.status`
 *  contribution for the pre-prompt degradation. Pure. */
export declare function sidebarPlaceholder(sessionID: string | undefined): string | null;
/** Navigate to a session through the V2 router. Fail-open: an absent router or
 *  a removed session must never break the sidebar. Returns whether a valid
 *  navigation was dispatched. Pure. */
export declare function navigateToSession(router: {
  navigate?: (destination: any) => void;
} | undefined, sessionID: string | undefined): boolean;
export type DelegationCompletion = {
  id: string;
  label: string;
  state: DelegationState;
};
/** Diff two delegation observations: entries that were `running` and are no
 *  longer running count as completions, fired once per transition. Returns the
 *  next snapshot so callers can keep a single tracker. First observation never
 *  reports a completion (no toast spam on mount). Pure. */
export declare function detectDelegationCompletions(previous: ReadonlyMap<string, DelegationState>, current: ReadonlyArray<DelegationCompletion>): {
  completed: DelegationCompletion[];
  snapshot: Map<string, DelegationState>;
};
/** Debounce for the git file-count revalidation. `vcs.status` is an HTTP call;
 *  session events arrive in bursts, so the row is refreshed at most once per
 *  window instead of on every event. */
export declare const GIT_CHANGES_DEBOUNCE_MS = 400;
/** Reactive state the sidebar view renders. Accessors keep the view reactive
 *  while the model itself stays free of JSX, so its effects are exercisable
 *  without a TUI renderer. */
export type SidebarModel = {
  activeSessionID: Accessor<string>;
  session: Accessor<any>;
  branch: Accessor<string | null>;
  /** `+N ±N −N` file counts from `vcs.status` (fallback only), null when
   *  clean/unavailable. */
  gitChanges: Accessor<string | null>;
  /** The rendered git row: CLI counts with `?untracked ↑ahead ↓behind` when git
   *  answered, else the `vcs.status` counts, else null. */
  gitLine: Accessor<string | null>;
  /** Last successful git CLI observation (counts + upstream distance), null
   *  while git has never answered. */
  gitCli: Accessor<GitCliSnapshot | null>;
  /** Cache hit rate + output speed of the active session's newest messages. */
  performance: Accessor<ContextPerformance | null>;
  /** The rendered `Dispatch` block: live rows, the finished rollup and the
   *  spend totals. Null when the session has no child (block hidden). */
  dispatch: Accessor<DispatchBlockView | null>;
  /** Blocks that have content, in render order, each tagged with its spacer. */
  blocks: Accessor<SidebarBlock[]>;
  hasRunning: Accessor<boolean>;
  frame: Accessor<number>;
  preset: Accessor<PresetInfo>;
  /** Provider of the model in use, derived from the session, its transcript or
   *  the host location; null when nothing resolves (the header omits it). */
  provider: Accessor<string | null>;
  /** Resolved preset override map (explicit per-agent models). */
  presetOverrides: Accessor<PresetOverrides>;
  /** Family cost in USD (root + delegations), null when the host cannot answer. */
  cost: Accessor<number | null>;
  /** Real per-model totals from assistant messages, capped for the sidebar. */
  modelUsage: Accessor<ModelUsageCeiling>;
  /** Todo rows derived from the newest completed `todowrite`, ordered + capped. */
  todo: Accessor<TodoCeiling>;
  /** Local spend for `hoje` / `30d`, null when stats is unavailable/unknown.
   *  Rendered as the Context block's last line, not as its own block. */
  spend: Accessor<SpendTotals | null>;
  /** Context gauge; null when there is no limit or no token-carrying message. */
  contextUsage: Accessor<ContextUsage | null>;
  /** Current agent and its resolved short model id (`*` = explicit override). */
  agentModel: Accessor<{
    agent: string;
    model: string;
    overridden: boolean;
  } | null>;
};
/** Reactive wiring behind the sidebar: refresh subscription, warm syncs, the
 *  running-only spinner and the completion-toast effect. `context` stays loosely
 *  typed (the host API only exists at runtime) but the refresh event names are
 *  narrowed to the V2 union at the subscription site. */
export declare function createSidebarModel(context: any, sessionID: () => string | undefined, gitExec?: GitExec): SidebarModel;
/** One command: runs only while the panel owns the keyboard, and reports
 *  `false` (the host keeps the key) when it cannot act. `undefined` means the
 *  key was consumed. */
export declare function runDispatchPanelCommand(action: DispatchPanelAction, panel: Pick<PanelInput, 'focused' | 'close' | 'toggleFullscreen'>, model: Pick<DispatchPanelModel, 'rows' | 'move' | 'first' | 'last' | 'pageUp' | 'pageDown' | 'toggle'>): false | undefined;
/** Keymap layer of the panel, as data. It is registered inside the
 *  `session.panel` claim, but the host mounts the effects of *every* panel
 *  contribution, so the layer itself is not proof of focus: without `enabled`
 *  the `j/k/f/q/enter/escape` bindings were consumed while the panel was not
 *  focused and the composer lost its keys. `enabled` (the documented gate) makes
 *  the whole layer inert until `panel.focused` is true. Pure. */
export declare function dispatchPanelKeymapLayer(panel: Pick<PanelInput, 'focused' | 'close' | 'toggleFullscreen'>, model: DispatchPanelModel): KeymapLayer;
/** Lean footer model: only the preset label and the live delegation count. It
 *  deliberately does not reuse `createSidebarModel` — that model owns the
 *  completion toasts and the spinner, and a second instance would double-toast.
 *  No session id in the slot input is a graceful no-op (count 0). */
export type FooterModel = {
  preset: Accessor<PresetInfo>;
  running: Accessor<number>;
};
export declare function createFooterModel(context: any, sessionID: () => string | undefined): FooterModel;
declare const plugin: {
  id: string;
  setup(context: Context): (() => void) | undefined;
};
//#endregion
export { plugin as default };
//# sourceMappingURL=tui-v2.d.ts.map
