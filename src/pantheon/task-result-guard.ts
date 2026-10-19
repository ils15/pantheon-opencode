/**
 * Task Result Guard — detects empty `task`/`subagent` tool results and converts
 * them to explicit errors. Accepted labels do not prove live-host event mapping.
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
 * The guard intercepts empty results for either `task` or `subagent` tool
 * labels in `tool.execute.after` and replaces them with an explicit error.
 * This adapter compatibility does not establish which label a live host emits.
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
 * The error message injected when a child-dispatch result is empty.
 * Keeps the historical "no assistant or tool output" contract text.
 */
export const EMPTY_TASK_ERROR =
  'ERROR: task() returned empty output — child session produced no assistant or tool output. ' +
  'This typically means the provider rejected the request (admission control / rate limit) ' +
  'or the child session crashed before producing any response. ' +
  'Consider splitting the work into a smaller task. No retry is automatic; investigate before retrying manually.'

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
 * When the tool label is `task` or `subagent` and its output is
 * empty/whitespace-only, replaces the output with an explicit error message.
 * All other tools pass through untouched; no child is retried automatically.
 *
 * @returns A `ToolExecuteAfterHandler`-compatible async function.
 */
export function createTaskResultGuard(options?: TaskResultGuardOptions): TaskResultGuardHandler {
  const warn = options?.logger?.warn ?? ((message: string) => log.warn(message))

  return async (input: TaskGuardInput, output: TaskGuardOutput): Promise<void> => {
    // Accept both labels without claiming which one a live host emits.
    if (input.tool !== 'task' && input.tool !== 'subagent') return

    // Only flag truly empty results — non-empty content is the happy path.
    if (!isEmptyOutput(output.output)) return

    warn(
      `[task-result-guard] Empty ${input.tool} result detected on session ${input.sessionID} ` +
        `(callID=${input.callID}). Replacing with explicit error.`,
    )

    output.output = EMPTY_TASK_ERROR
  }
}
