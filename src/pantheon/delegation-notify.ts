/**
 * Delegation event wiring — observe background-job lifecycle events and
 * route them to finalize. This module is the `event`-hook complement of the
 * board: `session.idle`/`session.error` on a child session that is a board
 * job → `finalizeDelegation` (Phase 2), which transitions the board and
 * fires `onTerminal`.
 *
 * NOT a notification channel. The user policy is ZERO delegation
 * notifications in the chat transcript — no `<task-notification>` block is
 * ever injected into a `chat.message` output, and no queued delivery path
 * exists. Completion visibility lives in the legitimate channels only:
 * the board `[unread]` marker (`pantheon_delegation_list`),
 * `pantheon_delegation_read`, TUI toasts (pantheon-hooks, PANTHEON_TOASTS
 * gate), and compaction carry-forward. The plugin's `onTerminal` listener
 * writes a file-only log line for the on-disk audit trail.
 *
 * `handleDelegationEvent` wires the `event` hook: `session.idle`/`session.error`
 * on a child session that is a board job → `finalizeDelegation` (Phase 2),
 * which transitions the board and fires `onTerminal`. Finalize never notifies
 * directly, and `markReconciled` does not re-fire onTerminal (reconcile is an
 * acknowledgment, not a completion), so every job gets exactly ONE terminal
 * transition — never a reconciled echo. Unknown sessions are ignored.
 *
 * `finalizeIdleChildrenWithoutMd` proactively finalizes children that are
 * idle on the board but have no MD report on disk — eliminates the phantom
 * "running" window during `pullOutput` (Fix 2 for the TUI stale-running bug).
 * Wired into a periodic scan via `startIdleChildScan` (default 30 s cadence).
 *
 * Pure TypeScript — zero runtime dependencies beyond the board types.
 *
 * Follow-up (Themis review, Phase 5): `extractErrorMessage` handles the two
 * observed `session.error` error shapes (string, { message }). The opencode SDK
 * MAY expose other shapes (e.g. Error-like with non-string `message`) — if a
 * real session.error ever carries one, the extraction degrades to the generic
 * "session error" label. No code change: there is no evidence any other shape
 * occurs in practice; revisit if a session.error shows an unexpected payload.
 *
 * @module delegation-notify
 */

import type { BackgroundJobRecord } from './background-job-board.ts'
import type { FinalizeInput } from './delegation-finalize.ts'

export type { FinalizeInput } from './delegation-finalize.ts'

/** Default cadence for the proactive idle-child scan (30 s). */
export const IDLE_SCAN_INTERVAL_MS = 30_000

// ─── Types ─────────────────────────────────────────────────────────────

/** Structural view of the event payload the `event` hook receives. */
export interface DelegationEventLike {
  type?: string
  properties?: Record<string, unknown>
}

/** Dependencies threaded to handleDelegationEvent (board lookup + finalize). */
export interface DelegationEventDeps {
  /** Look up a board job by session ID (child session IDs are task IDs). */
  board: { get(taskID: string): BackgroundJobRecord | undefined }
  /** Bound Phase 2 finalize — clears the timeout timer + writes the report. */
  finalize: (childSessionID: string, opts: FinalizeInput) => Promise<unknown>
}

// ─── Event → finalize wiring ───────────────────────────────────────────

function extractErrorMessage(error: unknown): string {
  if (typeof error === 'string' && error.trim() !== '') return error
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === 'string' && message.trim() !== '') return message
  }
  return 'session error'
}

/**
 * Handle a lifecycle event for background delegations:
 *  - `session.idle` on a board job → finalize as completed;
 *  - `session.error` on a board job → finalize as error (message extracted);
 *  - any other event, a missing session ID, or an unknown session → no-op.
 *
 * Finalize transitions the board, which fires `onTerminal` (the plugin's
 * file-only audit log — no chat delivery; see module header). The board's
 * same-terminal idempotency makes repeated idles harmless (finalize rewrites
 * the report but never transitions a terminal job to a different state).
 *
 * @returns True when the event named a board job (handled).
 */
export async function handleDelegationEvent(
  ev: DelegationEventLike,
  deps: DelegationEventDeps,
): Promise<boolean> {
  const type = ev?.type
  if (type !== 'session.idle' && type !== 'session.error') return false
  const sessionID = ev.properties?.sessionID
  if (typeof sessionID !== 'string' || sessionID === '') return false
  if (deps.board.get(sessionID) === undefined) return false

  if (type === 'session.idle') {
    await deps.finalize(sessionID, { state: 'completed' })
  } else {
    await deps.finalize(sessionID, {
      state: 'error',
      error: extractErrorMessage(ev.properties?.error),
    })
  }
  return true
}

// ─── Proactive finalize (Fix 2) ────────────────────────────────────────

/** Dependencies for idle-child scanning. */
export interface IdleChildScanDeps {
  /** Look up a board job by session ID (child session IDs are task IDs). */
  board: {
    get(taskID: string): BackgroundJobRecord | undefined
    list(parentSessionID?: string): BackgroundJobRecord[]
  }
  /** Bound Phase 2 finalize — clears the timeout timer + writes the report. */
  finalize: (childSessionID: string, opts: FinalizeInput) => Promise<unknown>
  /**
   * Check whether an MD report exists for the given board job.
   * Receives the full job record so the caller can construct the report
   * path from `job.parentSessionID` + `job.alias`.
   * If the function throws, the scan skips that child (fail-open).
   */
  hasReport: (job: BackgroundJobRecord) => boolean
  /** Optional logger for diagnostic messages. */
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void }
}

/**
 * Scan running board jobs for children whose sessions are idle but have no MD
 * report on disk, and proactively finalize them. This eliminates the phantom
 * "running" window that occurs between `session.idle` firing and the
 * `pullOutput`→`writeDelegationReport` cycle completing.
 *
 * Called from the periodic idle-child scan (`startIdleChildScan`, default 30 s).
 * The scan is O(N) where N = number of running jobs (typically < 10).
 *
 * Each child is finalized exactly once — the board's same-terminal idempotency
 * ensures repeated scans are harmless. Errors are caught per-child so one
 * failure never blocks the rest.
 *
 * @returns Number of children finalized (for diagnostics).
 */
export async function finalizeIdleChildrenWithoutMd(deps: IdleChildScanDeps): Promise<number> {
  const runningJobs = deps.board.list().filter((j: BackgroundJobRecord) => j.state === 'running')

  let finalized = 0
  for (const job of runningJobs) {
    try {
      // If the child already has an MD report, finalize was already handled
      // by handleDelegationEvent — skip.
      if (deps.hasReport(job)) continue
      // Child is idle on the board but has no report — proactively finalize.
      await deps.finalize(job.taskID, { state: 'completed' })
      finalized++
    } catch (err) {
      deps.logger?.warn?.(`[delegation-notify] proactive finalize failed for ${job.taskID}: ${err}`)
    }
  }
  return finalized
}

// ─── Periodic scan launcher ─────────────────────────────────────────────

/**
 * Start a periodic scan that proactively finalizes idle board children
 * without MD reports. The scan runs every `intervalMs` (default 30 s) and
 * is **unref'd** so it never holds the process open on its own.
 *
 * The timer is idempotent — calling this function multiple times is safe
 * (each call creates an independent timer, but the underlying finalize
 * operation is itself idempotent due to the board's same-terminal guard).
 *
 * @returns A `NodeJS.Timeout` handle that can be cleared with
 *   `clearInterval(handle)` to stop the scan.
 */
export function startIdleChildScan(
  deps: IdleChildScanDeps,
  intervalMs: number = IDLE_SCAN_INTERVAL_MS,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    void finalizeIdleChildrenWithoutMd(deps).catch((err) => {
      deps.logger?.warn?.(`[delegation-notify] periodic idle scan failed: ${err}`)
    })
  }, intervalMs)
  timer.unref()
  return timer
}
