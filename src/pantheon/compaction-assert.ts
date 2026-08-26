/**
 * Compaction Re-Assert (release-134 Phase 4) — detect fresh state after
 * compaction without writing to the chat transcript.
 *
 * WHY: after a session is compacted, the system state may have changed since
 * the summary was built (new background delegations launched, results
 * delivered, goals updated). The compacted session's context is frozen at
 * summary time — the model would operate on stale state.
 *
 * HOW: the compaction lifecycle keeps the board and goal stores authoritative;
 * the `experimental.session.compacting` hook builds the context that is
 * consumed by the compaction itself. Chat is never used as a delivery channel.
 *
 * Deliberately NOT `session.promptAsync({noReply:true})`: the sprint 4+7
 * spike refuted noReply as a push mechanism on this opencode build (nothing
 * is delivered to the parent).
 *
 * FAIL-OPEN: every source (board list and goals list) is wrapped —
 * a failure logs a warn via the silence-by-default logger and the hook never
 * throws. A session with NO fresh state (nothing running/unread/goals) is a
 * SILENT skip (no warn). The block is capped at
 * REASSERT_MAX_LINES item lines (1 header) so it stays compact.
 *
 * Pure TypeScript — zero runtime deps beyond the board/goal types.
 *
 * @module compaction-assert
 */
import type { BackgroundJobBoard } from './background-job-board.ts'
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
  /** The session whose compaction context is being prepared. */
  sessionID: string
  /** Board query surface — `list` is all the re-assertion needs. */
  board: Pick<BackgroundJobBoard, 'list'>
  /** Goal source for the goals block (optional — same gating as Phase 2). */
  goals?: CompactionGoalSource
  /** Injectable warn logger (testable). Defaults to silence-by-default. */
  logger?: { warn: (message: string) => void }
  /** Non-chat delivery sink (for example a pending `output.context` block). */
  deliverContext?: (context: string[]) => void | Promise<void>
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
 * Re-assert fresh state for a compacted session and return the context block
 * to the non-chat caller. The caller can hand this array to OpenCode's
 * `output.context` or persist it through the board; constructing it here and
 * throwing it away would make the hook a no-op.
 *
 * Returns the fresh-state context when found, or undefined when there was
 * nothing to assert (silent skip) or a source failed (warned). NEVER throws —
 * the event hook must never break the session.
 */
export async function reassertAfterCompaction(
  deps: CompactionAssertDeps,
): Promise<string[] | undefined> {
  // Silence-by-default logger: file-only warn, console echo opt-in via
  // PANTHEON_HOOKS_LOG=1 (TUI pollution policy, pantheon-hooks L42-58).
  const warn = deps.logger?.warn ?? ((message: string) => log.warn(message))
  try {
    const lines = await buildStateLines(deps, warn)
    if (lines === undefined) return undefined
    // This is a context return value, not a chat message. The caller owns the
    // supported delivery path (output.context or persisted board state).
    const context = [REASSERT_HEADER, ...lines]
    await deps.deliverContext?.(context)
    return context
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    warn(`compaction re-assert failed for session ${deps.sessionID}: ${reason}`)
    return undefined
  }
}
