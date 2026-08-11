/**
 * Delegation Notify (Phase 3) — completion notifications for background jobs.
 *
 * The spike refuted `promptAsync({noReply:true})` as a push mechanism — nothing
 * is delivered to the parent session. The working channel is a QUEUE + flush:
 *
 *   1. When a board job reaches a terminal state (`board.onTerminal`), the
 *      plugin calls `notifyParent(job)` → a `<task-notification>` block is
 *      queued in-memory for `job.parentSessionID` (FIFO, bounded per parent).
 *   2. The next `chat.message` hook fire for that parent session calls
 *      `flushQueue(parentSessionID, output)`, which prepends the pending
 *      notifications onto the first text part of the parent's user message —
 *      the same graceful-degradation channel pantheon-hooks uses for its
 *      <system-reminder> fallback buffer (TUI toasts are broken on 1.18.13).
 *
 * If the parent never sends another message the notification stays queued —
 * the graceful-degradation path. There is deliberately NO client push.
 *
 * `handleDelegationEvent` wires the `event` hook: `session.idle`/`session.error`
 * on a child session that is a board job → `finalizeDelegation` (Phase 2),
 * which transitions the board and fires `onTerminal` → notify. That makes the
 * onTerminal listener the SINGLE notification point — finalize never notifies
 * directly, so there is no double-notify. Unknown sessions are ignored.
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
import { createPantheonLogger } from './logger.ts'

// Silence-by-default TUI policy (pantheon-hooks L42-58): the default warn
// fallback logs to .pantheon/logs/hooks.log; console echo is opt-in via
// PANTHEON_HOOKS_LOG=1. `logger` injection stays for tests.
const log = createPantheonLogger({ module: 'pantheon-delegation' })

export type { FinalizeInput } from './delegation-finalize.ts'

// ─── Types ─────────────────────────────────────────────────────────────

/** One queued notification: text + enqueue timestamp. */
export interface QueuedNotification {
  text: string
  at: number
}

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

// ─── Notification text ─────────────────────────────────────────────────

/** Cap for description/summary text embedded in a notification. */
const NOTIFICATION_TEXT_MAX = 120

function truncate(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

/**
 * Build the self-contained `<task-notification>` block for a terminal job.
 * Carries the task ID, alias, agent, state, timeout flag, description and
 * result summary so the parent model can act on the completion without extra
 * tool calls.
 */
export function buildTaskNotification(job: BackgroundJobRecord): string {
  const stateLabel =
    job.state === 'completed' ? 'completed' : job.state === 'error' ? 'failed' : job.state
  const timeout = job.timedOut ? ' (timed out)' : ''
  // The `Result:` marker makes the child output origin explicit in the parent
  // context — the summary text came from the CHILD's output, not the parent's
  // own context (Themis mitigation, Phase 5).
  const summary = job.resultSummary
    ? ` — Result: ${truncate(job.resultSummary, NOTIFICATION_TEXT_MAX)}`
    : ''
  return [
    '<task-notification>',
    `<task id="${job.taskID}" alias="${job.alias}" agent="${job.agent}" state="${job.state}">`,
    `<summary>Delegation [${job.alias}] (${job.agent}) ${stateLabel}${timeout}: ${truncate(job.description, NOTIFICATION_TEXT_MAX)}${summary}</summary>`,
    `<read>Read the full report with pantheon_delegation_read({ id: "${job.alias}" }).</read>`,
    '</task>',
    '</task-notification>',
  ].join('\n')
}

// ─── Notifier (queue + flush) ──────────────────────────────────────────

/** Per-parent queue bound — a full queue drops new entries, never grows unbounded. */
const MAX_PER_PARENT = 10

function isTextPartLike(value: unknown): value is { type: 'text'; text: string } {
  if (!value || typeof value !== 'object') return false
  const part = value as { type?: unknown; text?: unknown }
  return part.type === 'text' && typeof part.text === 'string'
}

/**
 * In-memory completion notification queue, keyed by parent session ID.
 * FIFO per parent, bounded (MAX_PER_PARENT — anti-spam philosophy, matching
 * pantheon-hooks' CHAT_REMINDER_MAX). Delivered by `flushQueue` into the
 * parent's next chat.message; delivered notifications are marked sent.
 */
export class DelegationNotifier {
  private readonly queue = new Map<string, QueuedNotification[]>()
  private readonly sent = new Map<string, number>()
  private readonly warn: (message: string) => void

  /**
   * @param logger Optional injected logger (testable). Defaults to the
   *   Pantheon silence-by-default logger: writes `[pantheon-delegation]`
   *   lines to .pantheon/logs/hooks.log, console echo opt-in via
   *   PANTHEON_HOOKS_LOG=1 (TUI pollution policy, pantheon-hooks L42-58).
   */
  constructor(logger?: { warn: (message: string) => void }) {
    this.warn = logger?.warn ?? ((message: string) => log.warn(message))
  }

  /** Notifications awaiting delivery for a parent session. */
  pendingCount(parentSessionID: string): number {
    return this.queue.get(parentSessionID)?.length ?? 0
  }

  /** Whether any notifications await delivery for a parent session. */
  hasPending(parentSessionID: string): boolean {
    return this.pendingCount(parentSessionID) > 0
  }

  /** Notifications already injected into a parent's chat.message output. */
  sentCount(parentSessionID: string): number {
    return this.sent.get(parentSessionID) ?? 0
  }

  /**
   * Queue a completion notification for a parent session. The channel: there
   * is NO client push — the notification is delivered by the next
   * `flushQueue` for that parent. Returns false when the queue is full.
   */
  queueNotification(parentSessionID: string, text: string): boolean {
    const entries = this.queue.get(parentSessionID) ?? []
    if (entries.length >= MAX_PER_PARENT) {
      this.warn(
        `notification dropped for parent session ${parentSessionID}: ` +
          `queue full (${MAX_PER_PARENT} pending)`,
      )
      return false
    }
    entries.push({ text, at: Date.now() })
    this.queue.set(parentSessionID, entries)
    return true
  }

  /** Build + queue the notification for a terminal job. False when full. */
  notifyParent(job: BackgroundJobRecord): boolean {
    return this.queueNotification(job.parentSessionID, buildTaskNotification(job))
  }

  /**
   * Inject all pending notifications for a parent into a `chat.message` output
   * (prepend onto the first text part — matching the pantheon-hooks reminder
   * injection pattern; with no text part the block is unshifted as a new one).
   * Delivered entries are marked sent. Returns how many were delivered (0 when
   * nothing was pending).
   */
  flushQueue(parentSessionID: string, output: { parts: unknown[] }): number {
    const entries = this.queue.get(parentSessionID)
    if (entries === undefined || entries.length === 0) return 0
    this.queue.delete(parentSessionID)

    const block = entries.map((entry) => entry.text).join('\n')
    const firstText = output.parts.find(isTextPartLike)
    if (firstText !== undefined) {
      firstText.text = `${block}\n\n${firstText.text}`
    } else {
      output.parts.unshift({ type: 'text', text: block })
    }
    this.sent.set(parentSessionID, (this.sent.get(parentSessionID) ?? 0) + entries.length)
    return entries.length
  }
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
 * Finalize transitions the board, which fires `onTerminal` — the single point
 * that queues the completion notification (no double-notify). The board's
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
