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
