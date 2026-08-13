/**
 * Compaction Re-Assert (release-134 Phase 4) — re-inject fresh state after
 * compaction.
 *
 * WHY: after a session is compacted, the system state may have changed since
 * the summary was built (new background delegations launched, results
 * delivered, goals updated). The compacted session's context is frozen at
 * summary time — the model would operate on stale state.
 *
 * HOW: the `session.compacted` event hook calls `reassertAfterCompaction`,
 * which builds a COMPACT fresh-state block (running + unread delegations from
 * the board, active goals from the GoalStore — same gating as Phase 2) and
 * enqueues it into the SHARED chat-reminder buffer (chat-reminders.ts). The
 * existing pantheon-hooks `chat.message` hook delivers it as a
 * <system-reminder> into the session's next message — zero new delivery
 * code, and the P0 messageID guard already protects subagent fires.
 *
 * Deliberately NOT `session.promptAsync({noReply:true})`: the sprint 4+7
 * spike refuted noReply as a push mechanism on this opencode build (nothing
 * is delivered to the parent).
 *
 * FAIL-OPEN: every source (board list, goals list, enqueue) is wrapped —
 * a failure logs a warn via the silence-by-default logger and the hook never
 * throws. A session with NO fresh state (nothing running/unread/goals) is a
 * SILENT skip (no warn, no reminder). The block is capped at
 * REASSERT_MAX_LINES item lines (1 header) so it stays compact.
 *
 * Pure TypeScript — zero runtime deps beyond the board/goal types and the
 * shared reminder buffer.
 *
 * @module compaction-assert
 */
import type { BackgroundJobBoard } from './background-job-board.ts'
import { enqueueChatReminder } from './chat-reminders.ts'
import type { CompactionGoalSource } from './delegation-compaction.ts'
import { createPantheonLogger } from './logger.ts'

// Silence-by-default TUI policy (pantheon-hooks L42-58): console echo is
// opt-in via PANTHEON_HOOKS_LOG=1. `deps.logger` injection stays for tests.
const log = createPantheonLogger({ module: 'pantheon-compaction' })

// ─── Constants ─────────────────────────────────────────────────────────

/** Max fresh-state item lines (running + unread + goals) in the block. */
export const REASSERT_MAX_LINES = 10

/** Header line — tells the model the summary may be stale. */
export const REASSERT_HEADER = 'State re-assertion after compaction — the summary may be stale:'

// ─── Types ─────────────────────────────────────────────────────────────

/** Dependencies threaded to reassertAfterCompaction (wired from plugin.ts). */
export interface CompactionAssertDeps {
  /** The compacted session whose next message receives the reminder. */
  sessionID: string
  /** Board query surface — `list` is all the re-assertion needs. */
  board: Pick<BackgroundJobBoard, 'list'>
  /** Goal source for the goals block (optional — same gating as Phase 2). */
  goals?: CompactionGoalSource
  /** Injectable enqueue (testable). Defaults to the shared chat buffer. */
  enqueue?: (text: string) => void
  /** Injectable warn logger (testable). Defaults to silence-by-default. */
  logger?: { warn: (message: string) => void }
}

// ─── Formatting ────────────────────────────────────────────────────────

/** One-line terminal status label, mirroring formatForPrompt. */
function terminalLabel(state: string): string {
  switch (state) {
    case 'completed':
      return 'OK'
    case 'error':
      return 'ERR'
    case 'cancelled':
      return 'CAN'
    default:
      return state.toUpperCase()
  }
}

/** Collapse whitespace and truncate a description/objective. */
function truncate(text: string, max = 80): string {
  const flat = text.trim().replace(/\s+/g, ' ')
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

// ─── Build ─────────────────────────────────────────────────────────────

/**
 * Build the compact fresh-state lines: running delegations first (active work
 * is the freshest signal), then unread terminal delegations, then active
 * goals (only while the line budget allows). Returns undefined when there is
 * nothing to assert (silent skip) or a source failed (warn + skip).
 */
async function buildStateLines(
  deps: CompactionAssertDeps,
  warn: (message: string) => void,
): Promise<string[] | undefined> {
  const lines: string[] = []
  try {
    const jobs = deps.board.list(deps.sessionID)
    const running = jobs
      .filter((j) => j.state === 'running')
      .sort((a, b) => a.launchedAt - b.launchedAt)
    const unread = jobs
      .filter((j) => j.terminalUnreconciled)
      .sort((a, b) => b.updatedAt - a.updatedAt)

    for (const job of running) {
      if (lines.length >= REASSERT_MAX_LINES) break
      lines.push(`  running [${job.alias}] ${job.agent} — ${truncate(job.description)}`)
    }
    for (const job of unread) {
      if (lines.length >= REASSERT_MAX_LINES) break
      lines.push(
        `  unread [${job.alias}] ${job.agent} — ${truncate(job.description)} — ${terminalLabel(job.state)}`,
      )
    }

    const source = deps.goals
    if (lines.length < REASSERT_MAX_LINES && source !== undefined && source.enabled) {
      const goals = await source.list(deps.sessionID)
      for (const goal of goals.filter((g) => g.status !== 'done')) {
        if (lines.length >= REASSERT_MAX_LINES) break
        lines.push(`  goal [${goal.id}] ${truncate(goal.objective)} — ${goal.status}`)
      }
    }
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    warn(`compaction re-assert failed for session ${deps.sessionID}: ${reason}`)
    return undefined
  }
  return lines.length === 0 ? undefined : lines
}

/**
 * Re-assert fresh state for a compacted session: build the compact block and
 * enqueue it as a chat reminder (delivered on the session's next message).
 *
 * Returns true when a reminder was enqueued; false when there was nothing to
 * assert (silent skip) or a source failed (warned). NEVER throws — the event
 * hook must never break the session.
 */
export async function reassertAfterCompaction(deps: CompactionAssertDeps): Promise<boolean> {
  // Silence-by-default logger: file-only warn, console echo opt-in via
  // PANTHEON_HOOKS_LOG=1 (TUI pollution policy, pantheon-hooks L42-58).
  const warn = deps.logger?.warn ?? ((message: string) => log.warn(message))
  try {
    const lines = await buildStateLines(deps, warn)
    if (lines === undefined) return false
    const enqueue = deps.enqueue ?? enqueueChatReminder
    enqueue(`${REASSERT_HEADER}\n${lines.join('\n')}`)
    return true
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    warn(`compaction re-assert failed for session ${deps.sessionID}: ${reason}`)
    return false
  }
}
