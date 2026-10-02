/**
 * Compaction Context (Phase 4 + release-134 Phase 2, slimmed in Fase 2 of the
 * delegate removal) — build the context blocks injected by the
 * `experimental.session.compacting` hook so a compacted session does not lose
 * its working state: active goals and pending todos.
 *
 * Returns a Promise<string[]> (empty when there is nothing to preserve).
 * Section order is stable:
 *   - "<pantheon-context directive>" — preservation directive (prefix,
 *     PANTHEON_COMPACTION_DIRECTIVE). Emitted whenever at least one other
 *     section follows; a totally-empty state returns [] (an orphan
 *     directive is noise).
 *   - "<mission_context>" — active (non-done) goals from `opts.goals`:
 *     "  [id] objective — status". Omitted when the goal source is absent,
 *     disabled, unscoped (no sessionID), fails, or has no active goals.
 *   - "<todo_context>" — pending (not completed/cancelled) todos from
 *     `opts.todos`: "  [id] description — status". Omitted when the todo
 *     source is absent, disabled, unscoped (no sessionID), fails, or has
 *     no pending todos.
 *
 * @module compaction-context
 */

import type { Goal } from './goal-store.ts'
import { createPantheonLogger } from './logger.ts'
import type { TodoLike } from './todo-enforcer.ts'

// Silence-by-default TUI policy (pantheon-hooks L42-58): the default warn
// fallback logs to .pantheon/logs/hooks.log; console echo is opt-in via
// PANTHEON_HOOKS_LOG=1. `deps.logger` injection stays for tests.
const log = createPantheonLogger({ module: 'pantheon-compaction' })

// ─── Constants ─────────────────────────────────────────────────────────

/**
 * Preservation directive (release-134 Phase 2): the native compaction
 * prompt keeps every pushed section, so this prefix asks the model to keep
 * the pantheon sections verbatim — not paraphrased, merged, or dropped.
 */
export const PANTHEON_COMPACTION_DIRECTIVE =
  'preserve these sections verbatim in the summarized context'

// ─── Types ─────────────────────────────────────────────────────────────

/** Source for the <mission_context> section (active goals). */
export interface CompactionGoalSource {
  /** True when the goal loop is enabled; false/undefined → section omitted. */
  enabled: boolean
  /** List the session's goals (any status; the builder keeps non-done). */
  list(sessionID: string): Promise<Goal[]>
}

/** Source for the <todo_context> section (pending todos). */
export interface CompactionTodoSource {
  /** True when the todo enforcer is enabled; false/undefined → section omitted. */
  enabled: boolean
  /** List the session's todos (any status; the builder keeps pending). */
  list(sessionID: string): Promise<TodoLike[]>
}

export interface CompactionContextOptions {
  /** Scope to this session; omit to skip the per-session sections. */
  sessionID?: string
  /** Goal source for <mission_context> (optional — omitted when absent). */
  goals?: CompactionGoalSource
  /** Todo source for <todo_context> (optional — omitted when absent). */
  todos?: CompactionTodoSource
}

// ─── Sections ──────────────────────────────────────────────────────────

/**
 * `<mission_context>` — active (non-done) goals for the session.
 * Returns undefined when the section must be omitted: no goal source, the
 * goal loop is disabled, no sessionID (per-session data cannot be scoped),
 * the source throws (logged, fail-open), or no active goals remain.
 */
async function missionContextBlock(opts: CompactionContextOptions): Promise<string | undefined> {
  const source = opts.goals
  if (opts.sessionID === undefined || source === undefined || !source.enabled) return undefined

  let goals: Goal[]
  try {
    goals = await source.list(opts.sessionID)
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    log.warn(`compaction goal context failed for session ${opts.sessionID}: ${reason}`)
    return undefined
  }

  const active = goals.filter((goal) => goal.status !== 'done')
  if (active.length === 0) return undefined

  const lines = active.map((goal) => `  [${goal.id}] ${goal.objective} — ${goal.status}`)
  return `<mission_context>\n${lines.join('\n')}`
}

/**
 * `<todo_context>` — pending (not completed/cancelled) todos for the
 * session. Returns undefined when the section must be omitted: no todo
 * source, the enforcer is disabled, no sessionID, the source throws
 * (logged, fail-open), or no pending todos remain.
 */
async function todoContextBlock(opts: CompactionContextOptions): Promise<string | undefined> {
  const source = opts.todos
  if (opts.sessionID === undefined || source === undefined || !source.enabled) return undefined

  let todos: TodoLike[]
  try {
    todos = await source.list(opts.sessionID)
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    log.warn(`compaction todo context failed for session ${opts.sessionID}: ${reason}`)
    return undefined
  }

  const pending = todos.filter((todo) => todo.status !== 'completed' && todo.status !== 'cancelled')
  if (pending.length === 0) return undefined

  const lines = pending.map((todo) => {
    const label = todo.content?.trim() || todo.id || '(no description)'
    const id = todo.id !== undefined && todo.id !== '' ? `[${todo.id}] ` : ''
    return `  ${id}${label} — ${todo.status}`
  })
  return `<todo_context>\n${lines.join('\n')}`
}

// ─── Build ─────────────────────────────────────────────────────────────

/**
 * Build the compaction context blocks for a session: preservation
 * directive, active goals, and pending todos. Returns an empty array when
 * there is nothing to preserve (caller skips the hook injection entirely).
 */
export async function buildCompactionContext(
  opts: CompactionContextOptions = {},
): Promise<string[]> {
  const [mission, todo] = await Promise.all([missionContextBlock(opts), todoContextBlock(opts)])

  // Totally-empty state → nothing to preserve; a lone directive is noise.
  if (mission === undefined && todo === undefined) return []

  const blocks: string[] = [`<pantheon-context directive>\n${PANTHEON_COMPACTION_DIRECTIVE}`]
  if (mission !== undefined) blocks.push(mission)
  if (todo !== undefined) blocks.push(todo)
  return blocks
}
