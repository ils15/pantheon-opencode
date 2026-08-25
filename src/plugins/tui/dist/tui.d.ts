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
  state: 'running' | 'completed' | 'error' | 'startup_failed' | 'startup_unknown' | 'cancelled' | 'stale-running';
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
   *  (rendered with the distinct `[task]` tag); 'md' = board report wins. */
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
 *  HISTORY channel. Unlike the children/live channels it does NOT depend on a
 *  resolved sessionID: with no focused session (null/placeholder), the panel
 *  still shows the reports from all past sessions (running first, Finalized
 *  desc — the sort applied by readDelegationEntries). Fail-open: a
 *  missing/unreadable directory yields []. */
declare function readAllDelegationEntries(root: string): Promise<DelegationEntry[]>;
/** Resolve the directory where the job board writes delegation md reports.
 *  The board writes `.pantheon/delegations` RELATIVE to the server cwd,
 *  which the TUI exposes as `TuiState.path.directory`. `project` does NOT
 *  exist on `TuiState.path` (the old `state?.project ?? state?.worktree`
 *  resolution was always undefined for the first term) and `worktree` is
 *  `/` when there is no git (e.g. the sandbox test project) — a root of
 *  `''` or `'/'` must fall back to `process.cwd()`. */
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
/** The list the panel actually renders: running jobs first, then the most
 *  recent terminal reports (capped). Pure — so the history-only panel (no
 *  sessionID) is testable without the TUI runtime. The header count uses the
 *  same "running + recentes" list. */
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
/** Elapsed label for one entry: running → ticks `now - startedAt`, terminal
 *  → fixed `updatedAt - startedAt` (em dash when no finalized timestamp). */
declare function delegationElapsed(entry: DelegationEntry, now: number): string;
/** The activity labels shown by the animated row. Keeping this pure makes the
 * state machine testable without booting OpenCode's renderer. */
type DelegationActivity = 'delegating' | 'working' | 'reading' | 'completed' | 'error' | 'cancelled';
declare function delegationActivity(entry: DelegationEntry): DelegationActivity;
declare function delegationActivityLabel(entry: DelegationEntry): string;
/** Return a deterministic spinner frame. The View ticks this every 140ms. */
declare function delegationSpinnerFrame(now: number): string;
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
  tool: 'pantheon_delegate' | 'pantheon_delegation_read';
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
  tool: 'pantheon_delegate' | 'pantheon_delegation_read';
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
 *  not a pantheon delegation tool part (or is missing its callID). */
declare function parseDelegationToolPart(part: DelegationToolPart, now?: number): ParsedDelegationToolPart | null;
/** Apply one tool part to the live map. Returns true when the map changed.
 *  Pure w.r.t. I/O — only mutates `map`. */
declare function reduceDelegationToolPart(map: Map<string, LiveDelegationEntry>, part: DelegationToolPart, now?: number): boolean;
/** Remove a live entry by part id (message.part.removed) or call id.
 *  Returns true when something was removed. */
declare function removeDelegationEntry(map: Map<string, LiveDelegationEntry>, partIDOrCallID: string): boolean;
/** Collect pantheon delegation tool parts from a session's messages.
 *  Messages may carry their parts inline (duck-typed `msg.parts`); when
 *  they don't, the optional `getParts(messageID)` callback is used (the TUI
 *  SDK exposes `api.state.part(messageID)`). Pure w.r.t. I/O — used by the
 *  mount re-scan to re-seed the live map after compaction/attach. */
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
declare function childStatusToState(status: string | undefined): 'running' | 'completed';
/** Row tag for a delegation entry: `[task]` for native task() children
 *  (source 'children-only' — no board report), `[<alias>]` for board rows
 *  ([apo-1]). The panel renders the tag with a distinct style so native
 *  task() children are visually separable from pantheon_delegate jobs. */
declare function delegationTag(entry: DelegationEntry): string;
/** Turn child sessions (PRIMARY) enriched with md reports into the display
 *  list. One entry per child id (duplicates across re-fetches collapse).
 *  The md report is matched by `Task ID` (== child.id) and supplies alias,
 *  agent, description, terminal state and duration. A child without a
 *  report still renders: description from its title, agent from the child
 *  itself (fallback 'agent'), state derived from its status, startedAt from
 *  time.created. A report-less child is a NATIVE task() child (every
 *  child of the current session — pantheon_delegate OR the native `task()`
 *  tool — carries parentID = caller), so it gets source 'children-only'
 *  and the `[task]` tag instead of a board alias.
 *  Terminal md state wins over the derived state; a running md defers to
 *  the child's live status. Sorted running-first (compareDelegationEntries).
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
};
//#endregion
export { ChildDelegationLike, DelegationActivity, DelegationEntry, DelegationToolPart, IDLE_SILENCE_MS, LiveDelegationEntry, LiveDelegationStore, ParsedDelegationToolPart, STALE_RUNNING_THRESHOLD_MS, TuiSessionSources, buildChildrenPath, childStatusToState, childrenToDelegationEntries, collectDelegationToolParts, compareDelegationEntries, plugin as default, delegationActivity, delegationActivityLabel, delegationElapsed, delegationSpinnerFrame, delegationTag, fmtElapsed, isValidSessionId, markStaleIfRunning, mergeChildDelegationSources, mergeDelegationSources, navigateToDelegationSession, panelLogDir, parseDelegationMarkdown, parseDelegationToolPart, readAllDelegationEntries, readDelegationEntries, reduceDelegationToolPart, removeDelegationEntry, resolveCurrentSessionID, resolveDelegationsDir, safeSessionPath, seedLiveDelegationMap, toDelegationEntry, tuiLogPath, visibleDelegationList };
//# sourceMappingURL=tui.d.ts.map
