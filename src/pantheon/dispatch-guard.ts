/**
 * Dispatch Guard (Wave 4, PR #46) — auto-retry-on-empty for background
 * delegations. Classifies a dispatch result and redispatch once when it
 * came back empty.
 *
 * Failure signature classification:
 *   - 'content'     — text content present, nothing to do.
 *   - 'empty-mode1' — NO content AND NO tokens: the dispatch returned
 *                     nothing at all (no reply / early abort).
 *   - 'empty-mode2' — no text part but tokens present: reasoning happened
 *                     but the text part was lost — the themis Wave-2
 *                     failure signature that triggered this guard.
 *
 * Retry cap is HARD at 1 (never 2x). The guard is stateful per instance:
 * one retry budget total. It is a PURE library — it does NOT intercept
 * task() (opencode 1.18.x cannot intercept task completion via hooks, so
 * integration is manual-orchestration; see zeus.md "Empty-Result Retry").
 *
 * @module dispatch-guard
 */

import { createPantheonLogger } from './logger.ts'

// Silence-by-default TUI policy (pantheon-hooks L42-58): the default warn
// fallback logs to .pantheon/logs/hooks.log; console echo is opt-in via
// PANTHEON_HOOKS_LOG=1. `logger` injection stays for tests.
const log = createPantheonLogger({ module: 'pantheon-dispatch-guard' })

/** A dispatch result — the minimal shape needed to classify emptiness. */
export interface DispatchResultLike {
  /** Text content of the result (task_result / report markdown). */
  content?: string | null
  /** Input tokens (present when the model actually reasoned). */
  tokensInput?: number
  /** Output tokens (present when the model actually reasoned). */
  tokensOutput?: number
}

/** Classification of a dispatch result. */
export type DispatchClassification = 'content' | 'empty-mode1' | 'empty-mode2'

export interface DispatchGuardOptions {
  /** Enable auto-retry on empty results. Default: true. */
  retryOnEmpty?: boolean
  /** Injectable logger (defaults to the Pantheon file log, env-gated echo). */
  logger?: { warn: (message: string) => void }
}

export interface DispatchGuard {
  /** Classify a result: content, empty-mode1 (nothing), empty-mode2 (reasoning, no text). */
  classifyResult(result: DispatchResultLike): DispatchClassification
  /**
   * Redispatch ONCE when the result is empty and retryOnEmpty is enabled.
   * A retried result that is STILL empty is returned as-is — the cap of 1
   * is never exceeded. Never throws.
   */
  maybeRetry(
    result: DispatchResultLike,
    redispatch: () => Promise<DispatchResultLike>,
  ): Promise<{
    classification: DispatchClassification
    retried: boolean
    result: DispatchResultLike
  }>
}

/** 1-based retry budget — the hard cap. Never 2x. */
const MAX_RETRIES = 1

/** Whether a result carries any text content (whitespace-only counts as empty). */
function hasContent(result: DispatchResultLike): boolean {
  return typeof result.content === 'string' && result.content.trim() !== ''
}

/** Whether the result carries any token counts (i.e. the model actually ran). */
function hasTokens(result: DispatchResultLike): boolean {
  return (result.tokensInput ?? 0) > 0 || (result.tokensOutput ?? 0) > 0
}

export function createDispatchGuard(options?: DispatchGuardOptions): DispatchGuard {
  const retryOnEmpty = options?.retryOnEmpty ?? true
  const warn = options?.logger?.warn ?? ((message: string) => log.warn(message))
  // Per-instance retry budget — the "cap 1" enforcement point.
  let retriesUsed = 0

  return {
    classifyResult(result: DispatchResultLike): DispatchClassification {
      if (hasContent(result)) return 'content'
      return hasTokens(result) ? 'empty-mode2' : 'empty-mode1'
    },

    async maybeRetry(result, redispatch) {
      const classification = this.classifyResult(result)
      if (!retryOnEmpty || classification === 'content' || retriesUsed >= MAX_RETRIES) {
        return { classification, retried: false, result }
      }
      retriesUsed += 1
      warn(`dispatch returned ${classification}; retrying once (cap ${MAX_RETRIES})`)
      const retriedResult = await redispatch()
      return {
        classification: this.classifyResult(retriedResult),
        retried: true,
        result: retriedResult,
      }
    },
  }
}
