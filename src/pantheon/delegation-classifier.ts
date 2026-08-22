/**
 * Delegation Classifier — stuck-agent detection for delegation results.
 *
 * Classifies delegation results into actionable statuses:
 *   - `content` / `success` — agent returned usable output
 *   - `empty` (empty-mode1 / empty-mode2) — no or near-no output; retryable
 *   - `budget-exhausted` — agent hit max_steps; partial result available
 *   - `timeout` (timeout-with-partial / timeout-empty / timeout-exhausted)
 *   - `error` — provider or infrastructure failure
 *
 * Integrates with the existing `dispatch-guard.ts` classification for
 * empty-response detection and provides a structured `DelegationResult`
 * that replaces raw-text returns.
 *
 * @module delegation-classifier
 */

// ─── Types ─────────────────────────────────────────────────────────────

/** Empty-response mode classification (matches dispatch-guard). */
export type EmptyMode = 'empty-mode1' | 'empty-mode2'

/** Timeout sub-type based on partial output and retry history. */
export type TimeoutSubType = 'timeout-with-partial' | 'timeout-empty' | 'timeout-exhausted'

/** Structured delegation result replacing raw-text returns. */
export interface DelegationResult {
  status: 'success' | 'empty' | 'budget-exhausted' | 'timeout' | 'error'
  content: string
  retryCount: number
  /** When status is 'empty', which empty mode was detected. */
  classification?: EmptyMode | undefined
  /** When status is 'timeout', the timeout sub-type. */
  subType?: TimeoutSubType | undefined
  /** Available when budget-exhausted or timeout-with-partial. */
  partialResult?: string | undefined
  /** Actionable recommendation for the orchestrator. */
  recommendation?: string | undefined
}

/** Result of empty-response classification. */
export interface EmptyClassification {
  mode: EmptyMode | 'content'
  hasContent: boolean
  hasTokens: boolean
}

/** Timeout classification input. */
export interface TimeoutClassifyInput {
  /** Report markdown (undefined if no report was written). */
  report: string | undefined
  /** Whether the child session had any messages at all. */
  hasMessages: boolean
  /** How many retries have already been attempted (0 or 1). */
  retryCount: number
}

/** Result of stuck-agent classification. */
export interface StuckClassification {
  status: 'success' | 'budget-exhausted' | 'empty'
  partialResult?: string | undefined
  recommendation?: string | undefined
}

// ─── Patterns ──────────────────────────────────────────────────────────

/** Matches budget-exhausted messages from the agent or step-cap system. */
const BUDGET_EXHAUSTED_RE =
  /maximum\s+(?:steps?|step\s*budget)\s+(?:for\s+this\s+agent\s+)?(?:has|have)\s+been\s+reached|step\s*budget\s+(?:was\s+)?exhausted/i

/** Output-captured marker in delegation reports. */
const NO_OUTPUT_RE = /_No output captured\._/i

// ─── Empty-Response Classification ────────────────────────────────────

/**
 * Classify whether a response is empty, empty-with-tokens, or has content.
 * Matches the dispatch-guard classification (empty-mode1, empty-mode2).
 *
 * @param text The response text (may be null/undefined).
 * @param tokens Optional token counts for mode2 detection.
 */
export function classifyEmptyResponse(
  text: string | null | undefined,
  tokens?: { tokensInput?: number; tokensOutput?: number },
): EmptyClassification {
  const hasContent = typeof text === 'string' && text.trim() !== ''
  if (hasContent) {
    return { mode: 'content', hasContent: true, hasTokens: hasTokens(tokens) }
  }
  const hasT = hasTokens(tokens)
  return {
    mode: hasT ? 'empty-mode2' : 'empty-mode1',
    hasContent: false,
    hasTokens: hasT,
  }
}

/** Whether token counts indicate the model actually ran. */
function hasTokens(tokens?: { tokensInput?: number; tokensOutput?: number }): boolean {
  if (tokens === undefined) return false
  return (tokens.tokensInput ?? 0) > 0 || (tokens.tokensOutput ?? 0) > 0
}

// ─── Stuck-Agent Detection ────────────────────────────────────────────

/**
 * Classify a report as success, budget-exhausted, or empty.
 * Detects max-steps patterns in the report text.
 *
 * @param report The delegation report markdown.
 */
export function classifyStuckAgent(report: string): StuckClassification {
  const trimmed = report.trim()

  // Empty output
  if (NO_OUTPUT_RE.test(trimmed) || trimmed === '') {
    return { status: 'empty' }
  }

  // Budget-exhausted: extract content before the marker as partialResult
  if (BUDGET_EXHAUSTED_RE.test(trimmed)) {
    const outputSection = extractOutputSection(trimmed)
    const partialResult =
      outputSection !== undefined && !NO_OUTPUT_RE.test(outputSection)
        ? outputSection
        : undefined

    return {
      status: 'budget-exhausted',
      partialResult,
      recommendation:
        'Agent hit step budget; partial result available. ' +
        'Consider resuming with task_id or dispatching with larger budget.',
    }
  }

  return { status: 'success' }
}

/** Extract the text after "## Output" in a delegation report, or undefined. */
function extractOutputSection(report: string): string | undefined {
  const marker = '## Output'
  const idx = report.indexOf(marker)
  if (idx === -1) return undefined
  const afterMarker = report.slice(idx + marker.length)
  // Skip the newline after "## Output"
  const content = afterMarker.replace(/^\n+/, '')
  // Stop at the next section (## or **Error**)
  const endIdx = content.search(/\n(?:##|\*\*Error\*\*|\[TIMEOUT)/)
  return endIdx === -1 ? content.trim() : content.slice(0, endIdx).trim()
}

// ─── Timeout Classification ───────────────────────────────────────────

/**
 * Classify a timeout based on available output and retry history.
 *
 * - timeout-empty: no report, no messages, not yet retried → retryable
 * - timeout-with-partial: has report or messages → return partial
 * - timeout-exhausted: already retried → escalate
 *
 * @param input Report availability, message presence, and retry count.
 */
export function classifyTimeout(input: TimeoutClassifyInput): DelegationResult {
  const { report, hasMessages, retryCount } = input
  const hasPartial = (report !== undefined && report.trim() !== '' && !NO_OUTPUT_RE.test(report)) || hasMessages

  // Already retried → exhausted, no more retries
  if (retryCount >= 1) {
    return {
      status: 'timeout',
      content: report ?? '',
      retryCount,
      subType: 'timeout-exhausted',
      partialResult: hasPartial ? (report ?? '') : undefined,
      recommendation:
        'Agent timed out after retry. Options: ' +
        '(a) try different agent, (b) simplify scope, (c) manual intervention.',
    }
  }

  // Has partial output → return it
  if (hasPartial) {
    return {
      status: 'timeout',
      content: report ?? '',
      retryCount,
      subType: 'timeout-with-partial',
      partialResult: report ?? '',
      recommendation:
        'Agent timed out but partial work exists. ' +
        'Partial result is available above.',
    }
  }

  // No output at all → retryable
  return {
    status: 'timeout',
    content: report ?? '',
    retryCount,
    subType: 'timeout-empty',
    recommendation:
      'Agent timed out with no output. Will retry once with rephrased prompt.',
  }
}

// ─── Result Helpers ───────────────────────────────────────────────────

/**
 * Whether a delegation result is retryable (empty + retryCount < 1,
 * or timeout-empty + retryCount < 1).
 */
export function isRetryableResult(result: DelegationResult): boolean {
  if (result.retryCount >= 1) return false
  if (result.status === 'empty') return true
  if (result.status === 'timeout' && result.subType === 'timeout-empty') return true
  return false
}

/**
 * Format a DelegationResult into a human-readable string for the orchestrator.
 * Success results are returned as-is (the raw content). Non-success results
 * get a structured status message.
 */
export function formatDelegationResult(result: DelegationResult): string {
  if (result.status === 'success') {
    return result.content
  }

  const parts: string[] = []

  // Status header
  switch (result.status) {
    case 'empty': {
      const modeLabel =
        result.classification === 'empty-mode2'
          ? 'empty-mode2 (reasoning tokens present but no text output)'
          : 'empty-mode1 (no tokens generated)'
      parts.push(`[EMPTY RESULT — ${modeLabel}]`)
      if (result.retryCount === 0) {
        parts.push(
          'The agent returned an empty response. ' +
            'A retry with a rephrased prompt has been triggered automatically.',
        )
      } else {
        parts.push(
          'The agent returned an empty response even after retry. ' +
            'Options: (a) try different agent, (b) simplify scope, (c) manual intervention.',
        )
      }
      break
    }
    case 'budget-exhausted':
      parts.push('[BUDGET EXHAUSTED]')
      if (result.partialResult) {
        parts.push('Partial result:')
        parts.push(result.partialResult)
      }
      parts.push(result.recommendation ?? '')
      break
    case 'timeout': {
      const subLabel =
        result.subType === 'timeout-with-partial'
          ? 'with partial output'
          : result.subType === 'timeout-exhausted'
            ? 'exhausted after retry'
            : 'no output'
      parts.push(`[TIMEOUT — ${subLabel}]`)
      if (result.partialResult) {
        parts.push('Partial result:')
        parts.push(result.partialResult)
      }
      parts.push(result.recommendation ?? '')
      break
    }
    case 'error':
      parts.push('[ERROR]')
      parts.push(result.content)
      break
  }

  // Structured fields for non-success results
  parts.push(`status: ${result.status}`)
  parts.push(`retryCount: ${result.retryCount}`)

  return parts.filter((p) => p !== '').join('\n')
}
