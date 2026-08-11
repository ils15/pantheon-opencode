import { TuiPluginModule } from "@opencode-ai/plugin/tui";
//#region src/index.d.ts
type DelegationEntry = {
  /** Job alias, e.g. "apo-1" (from the H1 title, falling back to filename). */
  alias: string;
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
declare function parseDelegationMarkdown(raw: string, fileAlias?: string): DelegationEntry | null;
/** Read every delegation report under `<dir>/<sessionID>/<alias>.md`.
 *  Fail-open: a missing/unreadable directory yields [], and each unreadable
 *  or malformed file is skipped individually. Entries are sorted running
 *  first, then terminal by `updatedAt` (most recent first) so the panel can
 *  render them in order directly. */
declare function readDelegationEntries(dir: string): Promise<DelegationEntry[]>;
declare const plugin: TuiPluginModule & {
  id: string;
};
//#endregion
export { DelegationEntry, plugin as default, parseDelegationMarkdown, readDelegationEntries };
//# sourceMappingURL=tui.d.ts.map
