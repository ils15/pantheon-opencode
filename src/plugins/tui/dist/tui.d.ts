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
  state: 'running' | 'completed' | 'error' | 'cancelled';
  /** Epoch ms of the `Started` header. */
  startedAt: number;
  /** Epoch ms of the `Finalized` header — null while still running. */
  updatedAt: number | null;
  timedOut: boolean;
  description: string;
  /** True while the panel is waiting for pantheon_delegation_read. */
  read?: boolean;
  /** Internal provenance used to keep a finalized md report authoritative. */
  source?: 'child' | 'live' | 'md';
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
/** Sort delegations: running first, then terminal by recency (updatedAt,
 *  falling back to startedAt, descending). Shared by the md reader and
 *  mergeDelegationSources. */
declare function compareDelegationEntries(a: DelegationEntry, b: DelegationEntry): number;
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
 *  an empty/undefined value, or a foreign id (e.g. "wrk_") can never reach a
 *  path and error-spam the log. */
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
/** Build the `session.children` path ONLY from a validated session id.
 *  Returns null for null/invalid ids so the caller skips the fetch instead of
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
/** Turn child sessions (PRIMARY) enriched with md reports into the display
 *  list. One entry per child id (duplicates across re-fetches collapse).
 *  The md report is matched by `Task ID` (== child.id) and supplies alias,
 *  agent, description, terminal state and duration. A child without a
 *  report still renders: description from its title, agent falls back to
 *  'agent', state derived from its status, startedAt from time.created.
 *  Terminal md state wins over the derived state; a running md defers to
 *  the child's live status. Sorted running-first (compareDelegationEntries).
 *  Pure — no I/O. */
declare function childrenToDelegationEntries(children: readonly ChildDelegationLike[] | undefined, md: readonly DelegationEntry[], now?: number): DelegationEntry[];
/** Navigate the TUI to a child session (click/Enter on a delegation row).
 *  Returns false when the route API is unavailable or the target id is
 *  missing — the row stays inert instead of crashing. */
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
export { ChildDelegationLike, DelegationActivity, DelegationEntry, DelegationToolPart, LiveDelegationEntry, LiveDelegationStore, ParsedDelegationToolPart, TuiSessionSources, buildChildrenPath, childStatusToState, childrenToDelegationEntries, collectDelegationToolParts, compareDelegationEntries, plugin as default, delegationActivity, delegationActivityLabel, delegationElapsed, delegationSpinnerFrame, fmtElapsed, isValidSessionId, mergeChildDelegationSources, mergeDelegationSources, navigateToDelegationSession, parseDelegationMarkdown, parseDelegationToolPart, readDelegationEntries, reduceDelegationToolPart, removeDelegationEntry, resolveCurrentSessionID, resolveDelegationsDir, seedLiveDelegationMap, toDelegationEntry };
//# sourceMappingURL=tui.d.ts.map
