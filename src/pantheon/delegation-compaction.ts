/**
 * Delegation Compaction Context (Phase 4) — build the context blocks injected
 * by the `experimental.session.compacting` hook so a compacted session does
 * not lose track of its in-flight background delegations.
 *
 * Returns a string[] (empty when there is nothing to preserve):
 *   - "Background Delegations (running):" — every running job launched by the
 *     session (active work is never capped): alias, agent, started ISO,
 *     truncated prompt.
 *   - "Background Delegations (finished, unread):" — terminal-unreconciled
 *     jobs, newest first, capped at `maxItems` (default 10, matching
 *     routing.yml background_delegation.max_compaction_items).
 *
 * Reconciled jobs are excluded — they have been read already.
 *
 * The block style mirrors board.formatForPrompt ("  [alias] description —
 * STATUS") so compaction context reads consistently with the system prompt,
 * but with the extra id/agent/started detail the compaction hook needs.
 *
 * @module delegation-compaction
 */

import type { BackgroundJobBoard, BackgroundJobRecord } from './background-job-board.ts'

// ─── Types ─────────────────────────────────────────────────────────────

export interface CompactionContextOptions {
  /** Scope to jobs launched by this session; omit for all jobs. */
  sessionID?: string
  /** Cap on unread terminal jobs kept (default 10). */
  maxItems?: number
}

/** Prompt truncation length for a context line. */
const PROMPT_MAX_LEN = 100

// ─── Formatting ────────────────────────────────────────────────────────

/** Collapse whitespace and truncate a prompt to PROMPT_MAX_LEN chars. */
function truncatePrompt(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ')
  if (flat.length <= PROMPT_MAX_LEN) return flat
  return `${flat.slice(0, PROMPT_MAX_LEN)}…`
}

/** One-line terminal status label, mirroring formatForPrompt. */
function terminalLabel(state: BackgroundJobRecord['state']): string {
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

function runningLine(job: BackgroundJobRecord): string {
  return (
    `  [${job.alias}] ${job.agent} — ${truncatePrompt(job.description)} — ` +
    `RUNNING since ${new Date(job.launchedAt).toISOString()}`
  )
}

function unreadTerminalLine(job: BackgroundJobRecord): string {
  return (
    `  [${job.alias}] ${job.agent} — ${truncatePrompt(job.description)} — ` +
    `${terminalLabel(job.state)} ${new Date(job.updatedAt).toISOString()} [unread]`
  )
}

// ─── Build ─────────────────────────────────────────────────────────────

/**
 * Build the compaction context blocks for a session's background delegations.
 * Returns an empty array when there is nothing to preserve (caller skips the
 * hook injection entirely).
 */
export function buildCompactionContext(
  board: BackgroundJobBoard,
  opts: CompactionContextOptions = {},
): string[] {
  const maxItems = opts.maxItems ?? 10
  const jobs = opts.sessionID !== undefined ? board.list(opts.sessionID) : board.list()

  const running = jobs
    .filter((j) => j.state === 'running')
    .sort((a, b) => a.launchedAt - b.launchedAt)
  const unreadTerminal = jobs
    .filter((j) => j.terminalUnreconciled)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, maxItems)

  if (running.length === 0 && unreadTerminal.length === 0) return []

  const blocks: string[] = []
  if (running.length > 0) {
    blocks.push(`Background Delegations (running):\n${running.map(runningLine).join('\n')}`)
  }
  if (unreadTerminal.length > 0) {
    blocks.push(
      `Background Delegations (finished, unread):\n${unreadTerminal
        .map(unreadTerminalLine)
        .join('\n')}`,
    )
  }
  return blocks
}
