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
/** Env leg of resolution: PANTHEON_MODEL_PRESET set and !== 'none' wins. */
export declare function presetFromEnv(env: Record<string, string | undefined>): PresetInfo;
/** Resolve the active preset for the sidebar: env > file > default. */
export declare function resolvePresetForTui(env: Record<string, string | undefined>, cwd: string): Promise<PresetInfo>;
/** `SessionInfo.id` is always a `ses…` handle. Guarded so a placeholder or a
 *  foreign id never reaches the status/navigate APIs. */
export declare function isValidSessionID(id: unknown): id is string;
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
/** Reactive state the sidebar view renders. Accessors keep the view reactive
 *  while the model itself stays free of JSX, so its effects are exercisable
 *  without a TUI renderer. */
export type SidebarModel = {
  activeSessionID: Accessor<string>;
  session: Accessor<any>;
  branch: Accessor<string | null>;
  delegations: Accessor<DelegationView[]>;
  ceiling: Accessor<{
    visible: DelegationView[];
    hidden: number;
  }>;
  hasRunning: Accessor<boolean>;
  frame: Accessor<number>;
  preset: Accessor<PresetInfo>;
};
/** Reactive wiring behind the sidebar: refresh subscription, warm syncs, the
 *  running-only spinner and the completion-toast effect. `context` stays loosely
 *  typed (the host API only exists at runtime) but the refresh event names are
 *  narrowed to the V2 union at the subscription site. */
export declare function createSidebarModel(context: any, sessionID: () => string | undefined): SidebarModel;
declare const plugin: {
  id: string;
  setup(context: Context): (() => void) | undefined;
};
//#endregion
export { plugin as default };
//# sourceMappingURL=tui-v2.d.ts.map
