/**
 * Task Result Guard — detects empty task() results from native opencode
 * subagent calls and converts them to explicit errors.
 *
 * Bug context (reproduced 2026-09-10): task() native creates a child session
 * that inherits the parent transcript. When the payload exceeds the provider's
 * admission limit (e.g. free-tier max_outstanding_uncached_prefill_tokens=1000
 * vs 57k incoming tokens), the stream errors with BackendAdmissionRejected.
 * The error is NOT propagated — the child loop exits normally, the child
 * session goes idle with zero assistant/tool output, and opencode marks the
 * task as `completed` with empty content. The parent LLM receives an empty
 * result and proceeds as if the task succeeded.
 *
 * The guard intercepts this in the `tool.execute.after` hook: when the tool
 * is `task` and the output is empty/whitespace-only, it replaces the output
 * with an explicit error message so the parent sees a failure, not silence.
 *
 * Pure TypeScript — zero runtime dependencies. Meant to be wired into the
 * `combinedAfter` hook chain in plugin.ts alongside the sandbox and read
 * enhancer handlers.
 *
 * @module task-result-guard
 */

import { createPantheonLogger } from './logger.ts'

const log = createPantheonLogger({ module: 'pantheon-task-result-guard' })

// ─── Types ─────────────────────────────────────────────────────────────

/** Input shape of the opencode `tool.execute.after` hook. */
export interface TaskGuardInput {
  tool: string
  sessionID: string
  callID: string
  args: unknown
}

/** Output shape of the opencode `tool.execute.after` hook (mutable). */
export interface TaskGuardOutput {
  title?: string
  output: string
  metadata?: Record<string, unknown>
}

/** The `tool.execute.after` handler shape. */
export type TaskResultGuardHandler = (
  input: TaskGuardInput,
  output: TaskGuardOutput,
) => Promise<void>

export interface TaskResultGuardOptions {
  /** Injectable logger (defaults to the Pantheon file log). */
  logger?: { warn: (message: string) => void }
}

// ─── Constants ─────────────────────────────────────────────────────────

/**
 * The error message injected when a task() result is empty.
 * Matches the existing delegation-finalize.ts contract:
 * "Child session produced no assistant or tool output".
 */
export const EMPTY_TASK_ERROR =
  'ERROR: task() returned empty output — child session produced no assistant or tool output. ' +
  'This typically means the provider rejected the request (admission control / rate limit) ' +
  'or the child session crashed before producing any response. ' +
  'Consider using pantheon_delegate (clean context) instead of task() for large payloads.'

// ─── Implementation ────────────────────────────────────────────────────

/**
 * Whether a result carries any text content (whitespace-only counts as empty).
 */
function isEmptyOutput(output: unknown): boolean {
  if (output == null) return true
  if (typeof output !== 'string') return true
  return output.trim() === ''
}

/**
 * Create a task result guard handler for the `tool.execute.after` hook.
 *
 * When the tool is `task` and the output is empty/whitespace-only, replaces
 * the output with an explicit error message. All other tools pass through
 * untouched.
 *
 * @returns A `ToolExecuteAfterHandler`-compatible async function.
 */
export function createTaskResultGuard(options?: TaskResultGuardOptions): TaskResultGuardHandler {
  const warn = options?.logger?.warn ?? ((message: string) => log.warn(message))

  return async (input: TaskGuardInput, output: TaskGuardOutput): Promise<void> => {
    // Only intercept the `task` tool — all others pass through untouched.
    if (input.tool !== 'task') return

    // Only flag truly empty results — non-empty content is the happy path.
    if (!isEmptyOutput(output.output)) return

    warn(
      `[task-result-guard] Empty task() result detected on session ${input.sessionID} ` +
        `(callID=${input.callID}). Replacing with explicit error.`,
    )

    output.output = EMPTY_TASK_ERROR
  }
}
