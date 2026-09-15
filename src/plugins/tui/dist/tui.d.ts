import { TuiPluginModule } from "@opencode-ai/plugin/tui";
//#region src/index.d.ts
type DelegationEntry = {
  /** Job alias, e.g. "apo-1" (from the H1 title, falling back to filename). */
  alias: string;
  /** Parent session the job was launched from (dir name under .pantheon/delegations). */
  sessionID: string;
  /** Child session id (= task id, from the `Task ID` header). The
   *  children channel always sets it from the child session itself; the md
   *  channel parses it so child↔md matching works by taskID. */
  taskID?: string;
  /** Agent name, e.g. "apollo". */
  agent: string;
  state: 'running' | 'retry' | 'completed' | 'error' | 'startup_failed' | 'startup_unknown' | 'cancelled' | 'stale-running';
  /** Epoch ms of the `Started` header. */
  startedAt: number;
  /** Epoch ms of the `Finalized` header — null while still running. */
  updatedAt: number | null;
  timedOut: boolean;
  description: string;
  /** True while the panel is waiting for pantheon_delegation_read. */
  read?: boolean;
  /** Internal provenance used to keep a finalized md report authoritative.
   *  'children-only' = a native task() child session with NO delegate report
   *  (a native child row); 'md' = the child has a matching report;
   *  'child' = the plain children channel; 'live' = the optimistic tool-event
   *  channel. */
  source?: 'child' | 'live' | 'md' | 'children-only';
};
/** Parse one delegation report md header into a structured entry.
 *  Returns null (skip) when the file is not a recognizable report:
 *  missing agent/state/startedAt, an unknown state, or an unparsable
 *  Started timestamp. The alias falls back to the file name when the H1
 *  title is missing. Pure — no I/O.
 *
 *  Linear, single-pass over `raw.split('\n')` with plain string operations
 *  (startsWith/indexOf/slice) — zero regex, so worst case is O(bytes) even
 *  on adversarial whitespace-heavy input (ReDoS regression, CodeQL 12x HIGH). */
declare function parseDelegationMarkdown(raw: string, fileAlias?: string, sessionID?: string): DelegationEntry | null;
/** Read every delegation report under `<dir>/<sessionID>/<alias>.md`.
 *  Fail-open: a missing/unreadable directory yields [], and each unreadable
 *  or malformed file is skipped individually. Entries are sorted running
 *  first, then terminal by `updatedAt` (most recent first) so the panel can
 *  render them in order directly. */
declare function readDelegationEntries(dir: string): Promise<DelegationEntry[]>;
/** Read delegation reports from EVERY session under
 *  `<root>/.pantheon/delegations/<sessionID>/<alias>.md` — the panel's
 *  ENRICHMENT source. The read is deliberately unfiltered (each entry carries
 *  its directory's sessionID, so a taskID match can enrich any channel);
 *  callers MUST scope the merged result with {@link filterDelegationsToSession}
 *  before rendering — only the active session's reports are shown. Entries are
 *  running first, Finalized desc (the sort applied by readDelegationEntries).
 *  Fail-open: a missing/unreadable directory yields []. */
declare function readAllDelegationEntries(root: string): Promise<DelegationEntry[]>;
/** Resolve the PROJECT ROOT used by every pantheon file channel. `directory`
 *  wins over `worktree` (the old `resolveDelegationsDir` already did this);
 *  an absent/empty root or `/` (no git — e.g. the sandbox test project) falls
 *  back to cwd. Standardised here so the delegations md and the panel logger
 *  all read the SAME root (audit finding: the channels
 *  resolved the root independently). Pure — no I/O. */
declare function resolvePantheonRoot(state: {
  directory?: string;
  worktree?: string;
} | undefined, cwd?: string): string;
/** Resolve the directory where delegation md reports are written.
 *  The finalizer writes `.pantheon/delegations` RELATIVE to the server cwd,
 *  which the TUI exposes as `TuiState.path.directory`. */
declare function resolveDelegationsDir(state: {
  directory?: string;
  worktree?: string;
} | undefined, cwd?: string): string;
/** Project root derived from the delegations dir: `<root>/.pantheon/delegations`
 *  → `<root>`. Used to point the panel logger at the REAL hooks.log — passing
 *  the delegations dir (or its dirname) directly made createTuiLogger append
 *  to `<root>/.pantheon/.pantheon/logs/hooks.log`, a nested empty dir the real
 *  log never saw. Pure — no I/O. */
declare function panelLogDir(delegationsDir: string): string;
/** Where the panel logger appends lines: `<projectRoot>/.pantheon/logs/hooks.log`.
 *  Pure — testable without the runtime. */
declare function tuiLogPath(projectRoot: string): string;
/** Sort delegations: running first, then terminal by recency (updatedAt,
 *  falling back to startedAt, descending). Shared by the md reader and
 *  mergeDelegationSources. */
declare function compareDelegationEntries(a: DelegationEntry, b: DelegationEntry): number;
/** Split the panel list: active jobs (running/retry, stale-marked) first,
 *  then the most recent terminal reports; the remaining tail is collapsed
 *  by the View into a single "… +N more" line. Pure — so the history-only panel (no sessionID) is testable
 *  without the TUI runtime. */
declare function splitDelegationList(all: readonly DelegationEntry[], maxRecent?: number, now?: number, staleThresholdMs?: number): {
  active: DelegationEntry[];
  recent: DelegationEntry[];
};
/** Live-first window used by {@link ceilingDelegationList} (kept for the
 *  ceiling helper and existing tests): active jobs first, then the most
 *  recent terminal reports (capped). Pure. */
declare function visibleDelegationList(all: readonly DelegationEntry[], maxTerminal?: number, now?: number, staleThresholdMs?: number): DelegationEntry[];
/** Default stale-running threshold: 30 minutes. */
declare const STALE_RUNNING_THRESHOLD_MS: number;
/** Idle silence window: if no updatedAt change in this window, the entry is
 *  considered stale. Combined with the stale-running threshold to produce the
 *  display-only `stale-running` state. */
declare const IDLE_SILENCE_MS: number;
/** Visual-only terminal retention windows. Reports remain on disk; these
 *  constants only control which rows enter the TUI window. */
declare const DELEGATION_DONE_RETENTION_MS: number;
declare const DELEGATION_FAILED_RETENTION_MS: number;
/** Alias-less NATIVE task() live entries never receive a report alias (the
 *  task tool output carries none), so the 30s alias-less prune in
 *  mergeChildDelegationSources must not apply to them — 5 minutes covers a
 *  slow child listing while still bounding the live map. */
declare const NATIVE_LIVE_ALIASLESS_TTL_MS: number;
/**
 * Mark a running entry as `stale-running` if it has been running longer than
 * the threshold AND has no recent activity (no `updatedAt` change in the last
 * `IDLE_SILENCE_MS`). This is DISPLAY-ONLY — the persisted state is unchanged.
 *
 * A `stale-running` entry renders with a warning indicator but the underlying
 * delegation is still treated as running by the backend.
 */
declare function markStaleIfRunning(entry: DelegationEntry, now: number, thresholdMs?: number): DelegationEntry;
/** Compact elapsed-time label, single unit only: "12s"/"3m"/"1h"/"2d" — ticks every
 *  second for running jobs. */
declare function fmtElapsed(ms: number): string;
/** Elapsed label for one entry: an ACTIVE entry (running/retry/stale-running)
 *  ticks `now - startedAt`; a terminal one is fixed at
 *  `updatedAt - startedAt` (em dash when no finalized timestamp). */
declare function delegationElapsed(entry: DelegationEntry, now: number): string;
/** The activity labels shown by the animated row. Keeping this pure makes the
 * state machine testable without booting OpenCode's renderer. */
type DelegationActivity = 'delegating' | 'working' | 'reading' | 'completed' | 'error' | 'cancelled';
declare function delegationActivity(entry: DelegationEntry): DelegationActivity;
declare function delegationActivityLabel(entry: DelegationEntry): string;
/** Return a deterministic spinner frame. The View ticks this every 1000ms
 *  (not 140ms — the fast tick flickered without adding information). */
declare function delegationSpinnerFrame(now: number): string;
/** Every state the row knows how to draw: the delegation lifecycle states
 *  derived from the children status + md reports (`completed`, `error`,
 *  `cancelled`, `startup_failed`, `startup_unknown`) plus the TUI-only
 *  states (`retry`, `stale-running`). Fase 1 deliberately omits speculative
 *  blocked/paused/scheduled/skipped. There is no `pending` display state: a
 *  pre-dispatch tool part maps to `running` in {@link reduceDelegationToolPart}. */
type DelegationDisplayState = DelegationEntry['state'];
/** Semantic tone mapped to the TUI theme at the row ({@link DelegationRow}).
 *  Kept separate + pure so the color channel is testable without booting the
 *  renderer. Every display state resolves to one of the three status colors;
 *  the row paints its whole content with it (see {@link DelegationRow}). */
type DelegationStateTone = 'warning' | 'error' | 'success';
/** Status → color mapping for the whole-row tone. Red = failure, green =
 *  terminal, yellow = in flight. The glyph remains a redundant channel so the
 *  state stays legible in monochrome. Display-only; no behavior change. */
declare function delegationStateTone(state: DelegationDisplayState): DelegationStateTone;
type ToolActivity = {
  tool: string;
  summary: string;
  at: number;
};
/** Reduce one message.part.updated tool part to displayable activity.
 *  Returns null for non-tool parts, completed/error parts (no live activity)
 *  or parts without a session id. Pure. */
declare function extractToolActivity(part: {
  type?: string;
  tool?: string;
  sessionID?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
  };
}, now?: number): {
  sessionID: string;
  activity: ToolActivity;
} | null;
/** Record an activity sample (bounded map, oldest dropped). */
declare function trackToolActivity(map: Map<string, ToolActivity>, sessionID: string, activity: ToolActivity): void;
/** Latest live activity for a child session, or null when absent/stale. */
declare function latestToolActivityFor(map: Map<string, ToolActivity>, sessionID: string | undefined, now?: number, ttlMs?: number): ToolActivity | null;
/** Merge the immediate tool-event channel into the child-session channel.
 *
 * Children remain the durable source, while live entries make a delegation
 * visible before the child API/report catches up. A finalized md entry wins
 * over a stale live entry; a child-only row is upgraded with live agent,
 * alias, phase and timestamps. */
declare function mergeChildDelegationSources(children: readonly DelegationEntry[], live: readonly LiveDelegationEntry[]): DelegationEntry[];
/** Duck-typed subset of a tool part (SDK v2 `ToolPart` / `ToolState`). */
type DelegationToolPart = {
  id?: string;
  callID?: string;
  sessionID?: string;
  type?: string;
  tool?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    time?: {
      start?: number;
      end?: number;
    };
  };
};
/** One live delegation tracked in-memory, keyed by the delegate callID. */
type LiveDelegationEntry = {
  /** Tool call id of the pantheon_delegate part (stable across events). */
  callID: string;
  /** Part id (for message.part.removed cleanup). */
  partID: string;
  /** Parent session the delegation was launched from. */
  sessionID: string;
  tool: 'pantheon_delegate' | 'pantheon_delegation_read' | 'task';
  /** Agent name (from the delegate input args). */
  agent: string;
  description: string;
  /** Known after the delegate tool completes (parsed from its output). */
  alias: string | null;
  /** Child session id (parsed from the delegate output). */
  taskID: string | null;
  state: 'running' | 'completed' | 'error' | 'cancelled';
  startedAt: number;
  updatedAt: number | null;
  /** True once a pantheon_delegation_read for this job has been observed. */
  read: boolean;
};
/** Result of parsing one tool part into lifecycle-relevant fields. */
type ParsedDelegationToolPart = {
  callID: string;
  partID: string;
  sessionID: string;
  tool: 'pantheon_delegate' | 'pantheon_delegation_read' | 'task';
  /** null for read parts (no agent arg — the id targets an existing job). */
  agent: string | null;
  description: string;
  status: 'pending' | 'running' | 'completed' | 'error';
  alias: string | null;
  taskID: string | null;
  startedAt: number;
  endAt: number | null;
};
/** Extract the tool name + args from a `message.part.updated` part and
 *  reduce it to what the panel needs. Returns null for anything that is
 *  not a pantheon delegation tool part, the native `task` subagent tool
 *  (same parentID === caller mechanism — its children render `nat:`),
 *  or is missing its callID. */
declare function parseDelegationToolPart(part: DelegationToolPart, now?: number): ParsedDelegationToolPart | null;
/** Apply one tool part to the live map. Returns true when the map changed.
 *  Pure w.r.t. I/O — only mutates `map`. */
declare function reduceDelegationToolPart(map: Map<string, LiveDelegationEntry>, part: DelegationToolPart, now?: number): boolean;
/** Remove a live entry by part id (message.part.removed) or call id.
 *  Returns true when something was removed. */
declare function removeDelegationEntry(map: Map<string, LiveDelegationEntry>, partIDOrCallID: string): boolean;
/** Collect pantheon delegation + native task tool parts from a session's messages.
 *  Messages may carry their parts inline (duck-typed `msg.parts`); when
 *  they don't, the optional `getParts(messageID)` callback is used (the TUI
 *  SDK exposes `api.state.part(messageID)`). The native `task` tool spawns a
 *  child session with parentID = caller — the same mechanism as
 *  pantheon_delegate — so its parts feed the live-map as the native signal
 *  (rows come from the children channel). Pure w.r.t. I/O — used
 *  by the mount re-scan to re-seed the live map after compaction/attach. */
declare function collectDelegationToolParts(messages: readonly {
  id?: string;
  parts?: unknown[];
}[] | undefined, getParts?: (messageID: string) => readonly unknown[] | undefined): DelegationToolPart[];
/** Apply a batch of tool parts (in message order) to the live map. Used on
 *  mount to re-seed entries that `message.part.removed` (compaction) wiped,
 *  from the session's existing tool parts. Returns how many parts changed
 *  the map (0 on the second identical seed — idempotent, no extra bumps). */
declare function seedLiveDelegationMap(map: Map<string, LiveDelegationEntry>, parts: readonly DelegationToolPart[], now?: number): number;
/** Convert a live entry into the shared display shape. Alias falls back to
 *  a `live-<callID>` prefix while the delegate tool has not completed yet. */
declare function toDelegationEntry(live: LiveDelegationEntry): DelegationEntry;
/** Combine the live channel with the md (historical) channel into one
 *  display list. Dedupes by (sessionID, alias) — aliases are per-parent-
 *  session, so the same alias in different sessions stays separate. A
 *  terminal md entry is authoritative over a live running entry for the
 *  same job (it carries Finalized/timedOut/cancelled from finalize). */
declare function mergeDelegationSources(live: readonly LiveDelegationEntry[], md: readonly DelegationEntry[]): DelegationEntry[];
/** Scope a fully-merged display list to the ACTIVE session only.
 *
 *  The panel is session-scoped: rows from other sessions (md history under
 *  `.pantheon/delegations/<other-session>/`) and rows with no
 *  attributable session (empty sessionID) are DROPPED. The previous
 *  cross-session behavior rendered those rows and clicking them led to
 *  "Session not found" — there is no cross-session channel anymore.
 *
 *  The md channel still feeds the merge UNFILTERED so it can ENRICH an
 *  active-session row with state/alias/agent (dedup by taskID), but it can
 *  never introduce a row for another session: this filter is applied
 *  ONCE, after every merge (children + live + md).
 *
 *  Returns [] when no active session resolves (null/placeholder) — there is no
 *  scope to show. Native children always carry the active session id (stamped
 *  by `childrenToDelegationEntries`), so they survive the filter. Pure. */
declare function filterDelegationsToSession(entries: readonly DelegationEntry[], activeSessionID: string | null | undefined): DelegationEntry[];
/** Server-aligned session id validity: opencode rejects anything not starting
 *  with "ses" (SchemaError). This deliberately mirrors that exact contract —
 *  nothing stricter, nothing looser — so a template placeholder ("{sessionID}"),
 *  its URL-encoded form ("%7BsessionID%7D", what the server reported in the
 *  schema error), an empty/undefined value, or a foreign id (e.g. "wrk_") can
 *  never reach a path and error-spam the log. Confirmed: "{sessionID}" starts
 *  with "{" and "%7BsessionID%7D" with "%" — both fail startsWith("ses"), so
 *  the placeholder is rejected WITHOUT an explicit denylist (covered by tests). */
declare function isValidSessionId(id: unknown): id is string;
/** Sources the sidebar can resolve the CURRENT session id from. Duck-typed
 *  subsets of TuiPluginApi / TuiState / TuiRouteCurrent so the helper stays
 *  pure and testable without the TUI runtime. */
type TuiSessionSources = {
  /** sidebar_content slot prop (`session_id`). */
  sessionID?: string | null;
  api?: {
    /** Runtime state superset — may expose the current session id. */
    state?: {
      sessionID?: unknown;
    };
    /** Typed route: { name: 'session', params: { sessionID } } when in one. */
    route?: {
      current?: {
        name?: string;
        params?: Record<string, unknown>;
      };
    };
  } | null;
};
/** Resolve the current session id for the sidebar. Order: slot prop →
 *  api.state.sessionID (runtime superset) → api.route.current.params.sessionID
 *  (typed route). Every source is validated; invalid/absent → next source.
 *  NEVER returns a placeholder or non-ses id. Null → callers MUST skip the
 *  fetch (empty panel, zero errors). Pure — no I/O, no runtime required. */
declare function resolveCurrentSessionID(sources: TuiSessionSources): string | null;
/** THE single choke point for every `session.children` / session-API path.
 *  Returns `{ path: { id } }` ONLY for a server-valid session id; returns
 *  null for anything else (placeholder, empty, foreign id) so the caller
 *  skips the call entirely instead of sending an unsubstituted placeholder
 *  (the "%7BsessionID%7D" regression). Every session-API call site MUST go
 *  through this function (enforced by the source-scan test in
 *  tests/pantheon/tui-delegations.test.ts). */
declare function safeSessionPath(id: unknown): {
  path: {
    id: string;
  };
} | null;
/** Build the `session.children` path ONLY from a validated session id.
 *  Delegates to {@link safeSessionPath} — the single choke point. Returns
 *  null for null/invalid ids so the caller skips the fetch instead of
 *  sending an unsubstituted placeholder (the "%7BsessionID%7D" regression). */
declare function buildChildrenPath(id: string | null | undefined): {
  path: {
    id: string;
  };
} | null;
/** Duck-typed subset of a child Session (+ its live status type). */
type ChildDelegationLike = {
  /** Child session id (= task id). */
  id: string;
  /** Session title — the delegate's description or prompt prefix. */
  title?: string;
  /** Agent name when the child session carries one (duck-typed; native
   *  task() children may expose it, md reports always do). */
  agent?: string;
  /** Status type from api.state.session.status: 'busy' | 'retry' | 'idle',
   *  or undefined when the status API is unavailable. */
  status?: string;
  time?: {
    created?: number;
    updated?: number;
  };
};
/** Map a child status type to a display state. busy/retry → running
 *  (the child is actively working), idle → completed, unknown → running
 *  (fail-open: a freshly-seen child is assumed active; the 1s poll + md
 *  correct it as soon as terminal data exists). */
declare function childStatusToState(status: string | undefined): 'running' | 'completed' | 'retry';
/** Status-only row model: ONE glyph + ONE identity per row.
 *
 *  A row is
 *  `{glyph} {alias:7} {elapsed:>5}` plus a muted description line. The short
 *  alias (`apo-1`) is the single identity; rows without a report alias show
 *  the agent instead (never both). */
type DelegationRowStatus = 'active' | 'done' | 'failed' | 'retry';
/** Map every FSM/display state to one of the 4 row kinds. reconciled never
 *  reaches the panel (the md parser drops it) but reads as done;
 *  cancelled reads as done; startup_failed reads as failed while
 *  startup_unknown (no error known) reads as retry. Pure. */
declare function delegationRowStatus(state: DelegationDisplayState): DelegationRowStatus;
/** The only 4 glyphs a row may show: animated active, done, failed, retry.
 *  Shape is redundant with color (never the only signal). Pure. */
declare const DELEGATION_ROW_GLYPHS: Readonly<Record<DelegationRowStatus, string>>;
declare function delegationRowGlyph(status: DelegationRowStatus): string;
/** Row marker (`<glyph> `) — the single state channel. `active` animates
 *  through the 1s spinner for the given tick; every other kind is static.
 *  Pure. */
declare function delegationRowMarker(state: DelegationDisplayState, now?: number): string;
/** ONE identity per row: the short report alias (`apo-1`); a row without a
 *  report alias (native task() child `native-task` / `native-<id>`, or an
 *  alias-less native live row `live-<callID>` kept as children-only) shows
 *  the agent instead — never alias + agent stacked. Pure. */
declare function delegationRowIdentity(entry: DelegationEntry): string;
/** Fixed alias cell, pad-right + hard-truncate to `width` (default 7) so
 *  identities line up across rows. Pure. */
declare const DELEGATION_ALIAS_WIDTH = 7;
declare function formatDelegationAlias(identity: string, width?: number): string;
/** Max description width on the row detail line — the old 180-char slice
 *  wrapped the sidebar; 44 keeps one readable line. */
declare const DELEGATION_DESCRIPTION_MAX = 44;
/** Truncate a description to `max` graphemes appending `…` when cut. Exact
 *  `max`-length text is left untouched. Grapheme-granular, so an emoji made of
 *  several code points is never split into mojibake at the boundary. Pure. */
declare function truncateDelegationDescription(text: string, max?: number): string;
/** Fixed elapsed-time box: right-aligned to `width` (default 5) so elapsed
 *  values line up across rows, e.g. `  12s`. A label that already fills
 *  the box is returned untouched. Pure. */
declare const DELEGATION_ELAPSED_WIDTH = 5;
declare function formatDelegationElapsed(entry: DelegationEntry, now: number, width?: number): string;
/** Colored left half of a row line: `<marker><alias:7> ` — the state glyph
 *  plus the single identity, padded so the muted elapsed column aligns. The
 *  row renders this colored lead separately from the muted elapsed tail. Pure. */
declare function formatDelegationRowLead(entry: DelegationEntry, marker: string): string;
/** Visible-row ceiling for the panel: the remainder collapses into a single
 *  "… +N more" line. Live rows render first, so a running job is never hidden
 *  by the cap. */
declare const DELEGATION_VISIBLE_CEILING = 8;
/** Header summary: `(N active · M done)` plus `· K failed` only when K > 0.
 *  Active counts running/retry AND display-only stale-running (a stale row is
 *  still a live job — it must never read as done); failed counts
 *  error/startup_failed; cancelled reads as done. Pure. */
declare function formatDelegationHeader(entries: readonly DelegationEntry[]): string;
/** Cap the panel: live rows first, then most-recent retained terminal rows, at
 *  most `maxVisible` total. Hidden counts describe the retained render list,
 *  not expired history. */
declare function ceilingDelegationList(all: readonly DelegationEntry[], maxVisible?: number, now?: number): {
  visible: DelegationEntry[];
  hidden: number;
  hiddenActive: number;
  hiddenTerminal: number;
};
/** Split a display list into native task() rows vs pantheon_delegate rows.
 *  Native = source 'children-only' (no delegate report); everything else counts
 *  as pantheon. Pure — powers the hooks.log line. */
declare function countDelegationSources(entries: readonly DelegationEntry[]): {
  native: number;
  pantheon: number;
  total: number;
};
/** Diagnostic hooks.log line for a panel re-fetch, with the children
 *  breakdown (pantheon = children WITH a delegate report, native = children
 *  WITHOUT one). Pure — the View logs the returned string verbatim. */
declare function formatPanelLogLine(children: number, pantheon: number, native: number, md: number, events: number): string;
declare function childrenToDelegationEntries(children: readonly ChildDelegationLike[] | undefined, md: readonly DelegationEntry[], now?: number, parentSessionID?: string): DelegationEntry[];
/** Navigate the TUI to a child session (click/Enter on a delegation row).
 *  Returns false when the route API is unavailable or the target id is
 *  missing/placeholder — the row stays inert instead of crashing. Only a
 *  server-valid session id ("ses...") ever reaches the router, so an
 *  unsubstituted "{sessionID}" placeholder can never be routed. */
declare function navigateToDelegationSession(route: {
  navigate?: (name: string, params?: Record<string, unknown>) => void | PromiseLike<void>;
} | undefined, taskID: string | undefined): boolean;
/** Build the mouse handler used by each delegation row. */
declare function createDelegationRowOpenHandler(route: {
  navigate?: (name: string, params?: Record<string, unknown>) => void | PromiseLike<void>;
} | undefined, taskID: string | undefined): () => void;
/** Plugin-level live delegation store shared with the event subscriptions
 *  in `tui()`: the map of live entries + a version signal bumped on every
 *  mutation. The View subscribes to the version (in an effect) to refresh the
 *  durable child list and also reads the map as an optimistic live source. */
type LiveDelegationStore = {
  map: Map<string, LiveDelegationEntry>;
  /** Reactive version getter — View reads it inside an effect to re-fetch. */
  version: () => number;
  /** Bump the version after a live mutation. */
  bump: () => void;
};
declare const plugin: TuiPluginModule & {
  id: string;
  setup: () => Promise<void>;
};
//#endregion
export { ChildDelegationLike, DELEGATION_ALIAS_WIDTH, DELEGATION_DESCRIPTION_MAX, DELEGATION_DONE_RETENTION_MS, DELEGATION_ELAPSED_WIDTH, DELEGATION_FAILED_RETENTION_MS, DELEGATION_ROW_GLYPHS, DELEGATION_VISIBLE_CEILING, DelegationActivity, DelegationDisplayState, DelegationEntry, DelegationRowStatus, DelegationStateTone, DelegationToolPart, IDLE_SILENCE_MS, LiveDelegationEntry, LiveDelegationStore, NATIVE_LIVE_ALIASLESS_TTL_MS, ParsedDelegationToolPart, STALE_RUNNING_THRESHOLD_MS, ToolActivity, TuiSessionSources, buildChildrenPath, ceilingDelegationList, childStatusToState, childrenToDelegationEntries, collectDelegationToolParts, compareDelegationEntries, countDelegationSources, createDelegationRowOpenHandler, plugin as default, delegationActivity, delegationActivityLabel, delegationElapsed, delegationRowGlyph, delegationRowIdentity, delegationRowMarker, delegationRowStatus, delegationSpinnerFrame, delegationStateTone, extractToolActivity, filterDelegationsToSession, fmtElapsed, formatDelegationAlias, formatDelegationElapsed, formatDelegationHeader, formatDelegationRowLead, formatPanelLogLine, isValidSessionId, latestToolActivityFor, markStaleIfRunning, mergeChildDelegationSources, mergeDelegationSources, navigateToDelegationSession, panelLogDir, parseDelegationMarkdown, parseDelegationToolPart, readAllDelegationEntries, readDelegationEntries, reduceDelegationToolPart, removeDelegationEntry, resolveCurrentSessionID, resolveDelegationsDir, resolvePantheonRoot, safeSessionPath, seedLiveDelegationMap, splitDelegationList, toDelegationEntry, trackToolActivity, truncateDelegationDescription, tuiLogPath, visibleDelegationList };
//# sourceMappingURL=tui.d.ts.map
