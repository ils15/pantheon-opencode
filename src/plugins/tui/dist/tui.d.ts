import { TuiPluginModule } from "@opencode-ai/plugin/tui";
//#region src/index.d.ts
type DelegationEntry = {
  /** Job alias, e.g. "apo-1" (from the H1 title, falling back to filename). */
  alias: string;
  /** Parent session the job was launched from (dir name under .pantheon/delegations). */
  sessionID: string;
  /** Child session id (= board task id, from the `Task ID` header). The
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
   *  'children-only' = a native task() child session with NO board report
   *  (rendered with the distinct `nat:` prefix); 'md' = board report wins;
   *  'board' = read from .pantheon/board/state.json (cross-session FSM). */
  source?: 'child' | 'live' | 'md' | 'children-only' | 'board';
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
 *  HISTORY channel. Unlike the children/live channels it does NOT depend on a
 *  resolved sessionID: with no focused session (null/placeholder), the panel
 *  still shows the reports from all past sessions (running first, Finalized
 *  desc — the sort applied by readDelegationEntries). Fail-open: a
 *  missing/unreadable directory yields []. */
declare function readAllDelegationEntries(root: string): Promise<DelegationEntry[]>;
/** The persisted subset of BackgroundJobRecord the panel consumes. Duck-typed
 *  so a corrupt/older record never breaks parsing. */
type BoardJobRecord = {
  taskID: string;
  parentSessionID: string;
  agent: string;
  description?: string;
  state: string;
  alias: string;
  launchedAt?: number;
  completedAt?: number;
  updatedAt?: number;
  timedOut?: boolean;
};
/** The FilePersistence state path: `<root>/.pantheon/board/state.json`. */
declare function boardStatePath(root: string): string;
/** Read `.pantheon/board/state.json` (the cross-session job board snapshot).
 *  Fail-open: missing file, corrupt JSON, non-array payload or an unreadable
 *  path all yield [] — the panel keeps rendering from the other channels. */
declare function readBoardState(root: string): Promise<BoardJobRecord[]>;
/** Resolve the PROJECT ROOT used by every pantheon file channel. `directory`
 *  wins over `worktree` (the old `resolveDelegationsDir` already did this);
 *  an absent/empty root or `/` (no git — e.g. the sandbox test project) falls
 *  back to cwd. Standardised here so the delegations md, the board state file
 *  and the panel logger all read the SAME root (audit finding: the channels
 *  resolved the root independently). Pure — no I/O. */
declare function resolvePantheonRoot(state: {
  directory?: string;
  worktree?: string;
} | undefined, cwd?: string): string;
/** Resolve the directory where the job board writes delegation md reports.
 *  The board writes `.pantheon/delegations` RELATIVE to the server cwd,
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
 *  then the most recent terminal reports, then the archived tail (paginated
 *  in the View). Pure — so the history-only panel (no sessionID) is testable
 *  without the TUI runtime. */
declare function splitDelegationList(all: readonly DelegationEntry[], maxRecent?: number, now?: number, staleThresholdMs?: number): {
  active: DelegationEntry[];
  recent: DelegationEntry[];
  archived: DelegationEntry[];
};
/** The list the panel actually renders (kept for the header count and
 *  existing tests): active jobs first, then the most recent terminal
 *  reports (capped) — the archived tail is rendered separately. Pure. */
declare function visibleDelegationList(all: readonly DelegationEntry[], maxTerminal?: number, now?: number, staleThresholdMs?: number): DelegationEntry[];
/** Default stale-running threshold: 30 minutes. */
declare const STALE_RUNNING_THRESHOLD_MS: number;
/** Idle silence window: if no updatedAt change in this window, the entry is
 *  considered stale. Combined with the stale-running threshold to produce the
 *  display-only `stale-running` state. */
declare const IDLE_SILENCE_MS: number;
/**
 * Mark a running entry as `stale-running` if it has been running longer than
 * the threshold AND has no recent activity (no `updatedAt` change in the last
 * `IDLE_SILENCE_MS`). This is DISPLAY-ONLY — the board state is unchanged.
 *
 * A `stale-running` entry renders with a warning indicator but the underlying
 * delegation is still treated as running by the backend.
 */
declare function markStaleIfRunning(entry: DelegationEntry, now: number, thresholdMs?: number): DelegationEntry;
/** Compact elapsed-time label: "5m 12s", "1h 30m", "2d 4h" — ticks every
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
/** Every state the row knows how to draw: the real BackgroundJobBoard FSM
 *  (src/pantheon/background-job-board.ts) plus the TUI display-only states
 *  (`retry`, `stale-running`). Fase 1 deliberately omits speculative
 *  blocked/paused/scheduled/skipped. There is no `pending` display state: a
 *  pre-dispatch tool part maps to `running` in {@link reduceDelegationToolPart}. */
type DelegationDisplayState = DelegationEntry['state'];
/** Static glyph per display state. `running` shows its base spinner frame;
 *  callers that animate must prefer {@link delegationStateMarker}. Unicode
 *  geometric shapes only (no Nerd Font) — shape is an independent channel
 *  from color, so rows stay legible without color. */
declare const DELEGATION_STATE_GLYPHS: Readonly<Record<DelegationDisplayState, string>>;
declare function delegationStateGlyph(state: DelegationDisplayState): string;
/** Row marker (`<glyph> `) — the state channel. `running` animates through
 *  {@link delegationSpinnerFrame} for the given tick; every other state is
 *  static. Pure. */
declare function delegationStateMarker(state: DelegationDisplayState, now?: number): string;
/** Semantic tone mapped to the TUI theme at the row ({@link DelegationRow}).
 *  Kept separate + pure so the color channel is testable without booting the
 *  renderer. */
type DelegationStateTone = 'warning' | 'error' | 'success' | 'muted';
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
 *  (rows render `nat:` via the children channel). Pure w.r.t. I/O — used
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
/** Map one persisted board record into the display shape. Returns null for
 *  states the panel does not render (reconciled / unknown). Pure. */
declare function boardRecordToDelegationEntry(record: BoardJobRecord): DelegationEntry | null;
/** Map a whole board snapshot, dropping unrenderable states. Sorted like every
 *  other channel (running first, then most recent). Pure. */
declare function boardRecordsToDelegationEntries(records: readonly BoardJobRecord[]): DelegationEntry[];
/** Merge the board over any other channel. The board is AUTHORITATIVE for
 *  state/alias/agent (it is the persisted FSM) and it is the only channel
 *  that carries jobs from OTHER sessions. Dedup by taskID first, then by
 *  (sessionID, alias) — aliases are per parent session. Pure. */
declare function mergeBoardDelegationSources(base: readonly DelegationEntry[], board: readonly DelegationEntry[]): DelegationEntry[];
/** 'session' = focused session only (default); 'all' = every session the
 *  board knows about. */
type DelegationScope = 'session' | 'all';
/** api.kv key holding the persisted scope (defaults to 'session'). */
declare const DELEGATION_SCOPE_KV_KEY = "delegations.scope";
/** Structural subset of TuiKV — kept local so the pure helpers are testable
 *  without the TUI runtime. */
type DelegationScopeKv = {
  get: (key: string, fallback?: unknown) => unknown;
  set: (key: string, value: unknown) => void;
};
/** Read the persisted scope; anything malformed/absent → 'session'. */
declare function readDelegationScope(kv: DelegationScopeKv | undefined): DelegationScope;
/** Persist the scope. Failure is non-fatal — the signal keeps it in memory. */
declare function writeDelegationScope(kv: DelegationScopeKv | undefined, scope: DelegationScope): void;
/** Keyboard/click toggle target. Pure. */
declare function nextDelegationScope(scope: DelegationScope): DelegationScope;
/** Keep only the focused session's jobs ('session') or all of them ('all').
 *  An empty sessionID marks a current-session child (the children channel is
 *  session-scoped and only fills sessionID from a matching md report), so it
 *  counts as the current session. With no resolved session there is nothing
 *  to scope against — fail-open to the full list. Pure. */
declare function filterDelegationsByScope(entries: readonly DelegationEntry[], scope: DelegationScope, sessionID: string | null): DelegationEntry[];
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
  /** Child session id (= board task id). */
  id: string;
  /** Session title — the delegate's description or prompt prefix. */
  title?: string;
  /** Agent name when the child session carries one (duck-typed; native
   *  task() children may expose it, board reports always do). */
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
/** Short row prefix for a delegation entry (one of the two visual channels
 *  that split native task() work from pantheon_delegate jobs — the other is
 *  {@link delegationIcon}):
 *
 *  - `nat:<agent>` — a native task() child (source 'children-only', no board
 *    report). The child session carries no board alias, so the agent IS the
 *    identity.
 *  - `pan:<alias>` — a pantheon_delegate board row (`pan:apo-1`), the same
 *    alias the manager prints in pantheon_delegation_list.
 *
 *  Short prefixes keep the narrow sidebar readable (the old
 *  `pan:apo-1`/`nat:` tags ate the row width). */
declare function delegationTag(entry: DelegationEntry): string;
/** Row glyph: hollow diamond `◇` for native task() children (info color,
 *  outline) vs filled diamond `◆` for pantheon_delegate rows (state color).
 *  Shape + color are independent channels, so the split stays legible even
 *  without color. */
declare function delegationIcon(entry: DelegationEntry): string;
/** Row identity after the status marker + glyph. Pantheon rows append the
 *  agent (`pan:apo-1 apollo`); native rows already carry it inside the tag
 *  (`nat:apollo`) and must not duplicate it. */
declare function formatDelegationIdentity(entry: DelegationEntry): string;
/** Max description width on the row detail line — the old 180-char slice
 *  wrapped the sidebar; 44 keeps one readable line. */
declare const DELEGATION_DESCRIPTION_MAX = 44;
/** Truncate a description to `max` graphemes appending `…` when cut. Exact
 *  `max`-length text is left untouched. Grapheme-granular, so an emoji made of
 *  several code points is never split into mojibake at the boundary. Pure. */
declare function truncateDelegationDescription(text: string, max?: number): string;
/** Fixed elapsed-time box: right-aligned to `width` (default 8) so elapsed
 *  values line up across rows, e.g. `     12s`. A label that already fills
 *  the box is returned untouched. Pure. */
declare const DELEGATION_ELAPSED_WIDTH = 8;
declare function formatDelegationElapsed(entry: DelegationEntry, now: number, width?: number): string;
/** First row line: `<marker><glyph> <identity>`. The marker already carries
 *  its trailing space. Pure — the row renders the returned string verbatim. */
declare function formatDelegationRow(entry: DelegationEntry, marker: string): string;
/** Header summary: `(N active · M done · nat:K pan:M)`. Active counts
 *  running/retry AND display-only stale-running (a stale row is still a live
 *  job — it must never read as done). Pure. */
declare function formatDelegationHeader(entries: readonly DelegationEntry[]): string;
/** Split a display list into native task() rows vs pantheon_delegate rows.
 *  Native = source 'children-only' (no board report); everything else counts
 *  as pantheon. Pure — powers the header breakdown + the hooks.log line. */
declare function countDelegationSources(entries: readonly DelegationEntry[]): {
  native: number;
  pantheon: number;
  total: number;
};
/** Diagnostic hooks.log line for a panel re-fetch, with the children
 *  breakdown (pantheon = children WITH a board report, native = children
 *  WITHOUT one). Pure — the View logs the returned string verbatim. */
declare function formatPanelLogLine(children: number, pantheon: number, native: number, md: number, events: number): string;
/** Turn child sessions (PRIMARY) enriched with md reports into the display
 *  list. One entry per child id (duplicates across re-fetches collapse).
 *  The md report is matched by `Task ID` (== child.id) and supplies alias,
 *  agent, description, terminal state and duration. A child without a
 *  report still renders: description from its title, agent from the child
 *  itself (fallback 'agent'), state derived from its status, startedAt from
 *  time.created. A report-less child is a NATIVE task() child (every
 *  child of the current session — pantheon_delegate OR the native `task()`
 *  tool — carries parentID = caller), so it gets source 'children-only',
 *  the internal alias 'native-task' and the `nat:` tag instead of a
 *  board alias. The 'task nativa' description fallback keeps the row
 *  non-empty when the child carries no title.
 *  Terminal md state wins over the derived state; a running md defers to
 *  the child's live status. A running child is NEVER archived — it always
 *  lands in the active split (splitDelegationList active = running/retry).
 *  Sorted running-first (compareDelegationEntries).
 *  Pure — no I/O. */
declare function childrenToDelegationEntries(children: readonly ChildDelegationLike[] | undefined, md: readonly DelegationEntry[], now?: number): DelegationEntry[];
/** Navigate the TUI to a child session (click/Enter on a delegation row).
 *  Returns false when the route API is unavailable or the target id is
 *  missing/placeholder — the row stays inert instead of crashing. Only a
 *  server-valid session id ("ses...") ever reaches the router, so an
 *  unsubstituted "{sessionID}" placeholder can never be routed. */
declare function navigateToDelegationSession(route: {
  navigate?: (name: string, params?: Record<string, unknown>) => void;
} | undefined, taskID: string | undefined): boolean;
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
export { BoardJobRecord, ChildDelegationLike, DELEGATION_DESCRIPTION_MAX, DELEGATION_ELAPSED_WIDTH, DELEGATION_SCOPE_KV_KEY, DELEGATION_STATE_GLYPHS, DelegationActivity, DelegationDisplayState, DelegationEntry, DelegationScope, DelegationScopeKv, DelegationStateTone, DelegationToolPart, IDLE_SILENCE_MS, LiveDelegationEntry, LiveDelegationStore, ParsedDelegationToolPart, STALE_RUNNING_THRESHOLD_MS, ToolActivity, TuiSessionSources, boardRecordToDelegationEntry, boardRecordsToDelegationEntries, boardStatePath, buildChildrenPath, childStatusToState, childrenToDelegationEntries, collectDelegationToolParts, compareDelegationEntries, countDelegationSources, plugin as default, delegationActivity, delegationActivityLabel, delegationElapsed, delegationIcon, delegationSpinnerFrame, delegationStateGlyph, delegationStateMarker, delegationStateTone, delegationTag, extractToolActivity, filterDelegationsByScope, fmtElapsed, formatDelegationElapsed, formatDelegationHeader, formatDelegationIdentity, formatDelegationRow, formatPanelLogLine, isValidSessionId, latestToolActivityFor, markStaleIfRunning, mergeBoardDelegationSources, mergeChildDelegationSources, mergeDelegationSources, navigateToDelegationSession, nextDelegationScope, panelLogDir, parseDelegationMarkdown, parseDelegationToolPart, readAllDelegationEntries, readBoardState, readDelegationEntries, readDelegationScope, reduceDelegationToolPart, removeDelegationEntry, resolveCurrentSessionID, resolveDelegationsDir, resolvePantheonRoot, safeSessionPath, seedLiveDelegationMap, splitDelegationList, toDelegationEntry, trackToolActivity, truncateDelegationDescription, tuiLogPath, visibleDelegationList, writeDelegationScope };
//# sourceMappingURL=tui.d.ts.map
