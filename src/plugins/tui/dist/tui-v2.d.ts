import { Accessor } from "solid-js";
import { Context } from "@opencode/plugin/tui/context";
//#region src/index-v2.d.ts
/** Running delegations rendered before the "… +N more" line (V1 parity). */
export declare const DELEGATIONS_VISIBLE_CEILING = 8;
/** Sidebar body shown while the host has not published a session yet. */
export declare const SIDEBAR_WAITING_LABEL = "Aguardando sessão…";
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
/** Resolve the active preset for the sidebar: env > file > default. */
export declare function resolvePresetForTui(env: Record<string, string | undefined>, cwd: string): Promise<PresetInfo>;
/** `SessionInfo.id` is always a `ses…` handle. Guarded so a placeholder or a
 *  foreign id never reaches the status/navigate APIs. */
export declare function isValidSessionID(id: unknown): id is string;
/** Model reference shapes the host publishes: `ModelRef` objects, bare ids, or
 *  `provider/model` strings. Returns the id part, never throws. */
export declare function modelRefID(ref: unknown): string | null;
/** Short display id: the segment after the last `/` (`opencode-go/kimi-k3` →
 *  `kimi-k3`), truncated so a long id never wraps the sidebar. */
export declare function shortModelID(ref: unknown, max?: number): string | null;
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
/** Context usage for a message list. Scope: everything before the revert
 *  boundary (when a revert is active), then after the last compaction. The last
 *  assistant message carrying `tokens` in that window wins. Null when there is
 *  no limit or no such message — the caller then omits the block. */
export declare function computeContextUsage(messages: readonly any[], contextLimit: number | null | undefined, revertMessageID?: string | null): ContextUsage | null;
/** Semantic tone for a context percentage: green < 50%, yellow < 75%, red at
 *  or above 75%. Reuses the delegation tone union so both rows draw from the
 *  same theme tokens. Pure. */
export declare function contextUsageTone(percent: number): DelegationTone;
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
  tone: DelegationTone | null;
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
/** Full single-line text of a context row (`55,320 tokens`,
 *  `▰▰▰▰▰▱▱▱▱▱▱▱ 39% of 200K`). Pure. */
export declare function contextRowText(row: ContextRow | null): string | null;
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
/** Clamp a free-form label to the sidebar width without wrapping. */
export declare function truncateLabel(value: string, max?: number): string;
/** `agente→modelo` identity for a delegation row; either half may be absent. */
export declare function delegationIdentity(view: Pick<DelegationView, 'agent' | 'model'>): string;
/** Sidebar row body: truncated label plus the agent→model identity. */
export declare function delegationSidebarLabel(view: DelegationView, max?: number): string;
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
/** Build a delegation row from a child session + its live status. A terminal
 *  `outcome` wins when present (the only V2 primitive that surfaces a
 *  delegation failure/interruption once the status is back to idle); otherwise
 *  the live status decides, with the absent/idle grace window applied. Pure. */
export declare function toDelegationView(child: any, status: string | undefined, now?: number): DelegationView;
/** Whole-row tone: red = failed, green = terminal, yellow = in flight. The
 *  glyph stays a redundant channel so the state reads in monochrome. Pure. */
export declare function delegationStateTone(state: DelegationState): DelegationTone;
/** Spinner glyph for a frame counter (incremented every ~80ms while any job is
 *  running). Pure. */
export declare function spinnerFrame(frame: number): string;
/** Row marker (`<glyph> `): the animated spinner while running, ✓ when done,
 *  ⊘ when interrupted, ✕ on failure. Pure. */
export declare function delegationRowMarker(state: DelegationState, frame?: number): string;
/** Compact single-unit elapsed label: "12s"/"3m"/"1h"/"2d". Pure. */
export declare function fmtElapsed(ms: number): string;
/** Elapsed label for one row: a running job ticks `now - startedAt`; a terminal
 *  one is fixed at `updatedAt - startedAt` (em dash when a timestamp is
 *  missing). Pure. */
export declare function delegationElapsed(view: DelegationView, now: number): string;
/** Live rows first (a running job never falls behind the cap), then by most
 *  recent activity. Pure. */
export declare function orderDelegations(views: readonly DelegationView[]): DelegationView[];
/** Cap the panel: at most `maxVisible` rows, the remainder collapsing into the
 *  "… +N more" line. Pure. */
export declare function ceilingDelegations(views: readonly DelegationView[], maxVisible?: number): {
  visible: DelegationView[];
  hidden: number;
};
/** Sidebar blocks in render order. Spacing is derived from this list instead of
 *  from the view, so a hidden block can never leave an empty gap behind. */
export type SidebarBlockKey = 'context' | 'git' | 'todo' | 'agent' | 'dispatch';
/** One rendered block: its key, and whether a blank line precedes it. */
export type SidebarBlock = {
  key: SidebarBlockKey;
  spacer: boolean;
};
/** Header glyph per block — one codepoint each, rendered muted before the bold
 *  label. The fixed header (version/preset/session) takes none.
 *  Measured as one terminal cell by the host (`@opentui/core` counts
 *  `emoji-regex` matches as two): ▤ U+25A4 (EAW=A), ◆ U+25C6 (A), ▾ U+25BE (N),
 *  ◇ U+25C7 (A), ⌁ U+2301 (N). `☑` U+2611 was rejected for the Todo header
 *  because it matches `emoji-regex` and would occupy two cells. */
export declare const BLOCK_ICONS: Record<SidebarBlockKey, string>;
/** Tag every block that has content with its spacer: never before the first
 *  (the view puts a single blank line after the fixed header instead), one
 *  blank line before every later block. A repeated key collapses instead of
 *  stacking spacers, so an absent optional block can never leave a double gap.
 *  Pure. */
export declare function withBlockSpacers(keys: readonly SidebarBlockKey[]): SidebarBlock[];
/** Children listed before the "… +N" line. Five keeps the sidebar inside a
 *  short pane while still showing the finished job next to the live one. */
export declare const DISPATCH_VISIBLE_CEILING = 5;
/** Column width of the agent (or of its title/id fallback). */
export declare const DISPATCH_AGENT_WIDTH = 12;
/** Column width of the short model id — the model is dropped before the agent
 *  or the cost so a row always fits. */
export declare const DISPATCH_MODEL_WIDTH = 7;
/** Column width of the per-dispatch cost (`$0.04`; a sub-cent cost widens it). */
export declare const DISPATCH_COST_WIDTH = 5;
/** Column width of the duration (`12.7s` / `1m04s` / `820ms`). */
export declare const DISPATCH_DURATION_WIDTH = 5;
/** Hard column budget for one row — a Dispatch line never wraps:
 *  marker(2) + agent(12) + model(7) + cost(5) + duration(5) + 3 spaces = 34. */
export declare const DISPATCH_MAX_WIDTH = 34;
export type DispatchTone = 'success' | 'error' | 'muted';
/** Row marker: ● live, ✓ succeeded, ✗ failed, − interrupted. The glyph is the
 *  redundant channel, so the state still reads in monochrome. Pure. */
export declare function dispatchMarker(state: DelegationState): string;
/** Row tone: live work is the block's only accent, a failed child is red, and
 *  every terminal state recedes to muted. Pure. */
export declare function dispatchTone(state: DelegationState): DispatchTone;
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
/** One Dispatch row, columns aligned:
 *  `<marker> <agent> <model> <cost> <duration>`. The agent and model columns are
 *  padded, the cost and duration right-aligned, and the model column stays
 *  reserved when a child published no model so the numbers line up. When the
 *  row would exceed `max` columns the model is dropped first, then the cost —
 *  the agent is never cut below `DISPATCH_AGENT_WIDTH`. Pure. */
export declare function dispatchRowText(view: DelegationView, now?: number, max?: number): string;
/** The "… +N" line for children beyond the cap, null when nothing was cut. Pure. */
export declare function hiddenDispatchText(hidden: number): string | null;
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
  /** `+N ±N −N` file counts from `vcs.status`, null when clean/unavailable. */
  gitChanges: Accessor<string | null>;
  /** Running children only — what the spinner and the accent read. */
  delegations: Accessor<DelegationView[]>;
  /** Every child of the active session (running + finished), ordered and
   *  capped for the `Dispatch` block. */
  dispatch: Accessor<{
    visible: DelegationView[];
    hidden: number;
  }>;
  /** Blocks that have content, in render order, each tagged with its spacer. */
  blocks: Accessor<SidebarBlock[]>;
  hasRunning: Accessor<boolean>;
  frame: Accessor<number>;
  /** Fresh clock that advances on the spinner's own tick — the live rows
   *  measure their duration from it instead of from a second interval. */
  liveNow: Accessor<number>;
  preset: Accessor<PresetInfo>;
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
export declare function createSidebarModel(context: any, sessionID: () => string | undefined): SidebarModel;
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
