import { TuiPluginModule } from "@opencode-ai/plugin/tui";
//#region src/index.d.ts
type DelegationEntry = {
  /** Job alias, e.g. "apo-1" (from the H1 title, falling back to filename). */
  alias: string;
  /** Parent session the job was launched from (dir name under .pantheon/delegations). */
  sessionID: string;
  /** Agent name, e.g. "apollo". */
  agent: string;
  state: 'running' | 'completed' | 'error' | 'cancelled';
  /** Epoch ms of the `Started` header. */
  startedAt: number;
  /** Epoch ms of the `Finalized` header — null while still running. */
  updatedAt: number | null;
  timedOut: boolean;
  description: string;
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
/** Plugin-level live delegation store shared with the event subscriptions
 *  in `tui()`: the map of live entries + a version signal bumped on every
 *  mutation so the View re-renders reactively. */
type LiveDelegationStore = {
  map: Map<string, LiveDelegationEntry>;
  /** Reactive version getter — View reads it inside a memo to re-render. */
  version: () => number;
  /** Bump the version after a live mutation. */
  bump: () => void;
};
declare const plugin: TuiPluginModule & {
  id: string;
};
//#endregion
export { DelegationEntry, DelegationToolPart, LiveDelegationEntry, LiveDelegationStore, ParsedDelegationToolPart, collectDelegationToolParts, compareDelegationEntries, plugin as default, delegationElapsed, fmtElapsed, mergeDelegationSources, parseDelegationMarkdown, parseDelegationToolPart, readDelegationEntries, reduceDelegationToolPart, removeDelegationEntry, resolveDelegationsDir, seedLiveDelegationMap, toDelegationEntry };
//# sourceMappingURL=tui.d.ts.map
