/**
 * Native Task Status — classifies BackgroundJobRecord results from native
 * task() delegation into actionable status codes.
 *
 * Pure module — zero external dependencies. Consumed by native-probe.ts
 * and the delegation manager to decide retry/skip/escalate strategy.
 *
 * @module native-task-status
 */

import type { BackgroundJobRecord } from './background-job-board.ts'

// ─── Types ─────────────────────────────────────────────────────────────

/** Actionable status for a native task() delegation result. */
export type NativeTaskStatus =
  | 'OK'
  | 'UNSUPPORTED'
  | 'UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'INVALID_STATE'
  | 'CONFLICT'
  | 'CORRUPT_DATA'
  | 'TIMEOUT'
  | 'ESCALATE'

// ─── Helpers ───────────────────────────────────────────────────────────

/** Check if a string contains any of the given substrings (case-insensitive). */
function containsAny(text: string | undefined, patterns: readonly string[]): boolean {
  if (text == null) return false
  const lower = text.toLowerCase()
  return patterns.some((p) => lower.includes(p.toLowerCase()))
}

/** Check if a job's output is empty or whitespace-only. */
function isOutputEmpty(job: BackgroundJobRecord): boolean {
  const summary = job.resultSummary
  if (summary == null) return true
  if (typeof summary !== 'string') return true
  return summary.trim() === ''
}

// ─── Implementation ────────────────────────────────────────────────────

/**
 * Classify a BackgroundJobRecord result into a NativeTaskStatus.
 *
 * Priority order (first match wins):
 * 1. verifyError and lastStatusError patterns → UNSUPPORTED, CONFLICT,
 *    INVALID_INPUT, INVALID_STATE, CORRUPT_DATA, ESCALATE
 * 2. state === startup_failed or timedOut → TIMEOUT
 * 3. state === completed + non-empty output → OK
 * 4. state === completed + empty output → UNAVAILABLE (silent failure / admission rejection)
 * 5. state === error → UNAVAILABLE (safe default for provider/infra errors)
 * 6. Fallback → UNAVAILABLE
 */
export function classifyNativeResult(
  job: BackgroundJobRecord,
  verifyError?: string,
): NativeTaskStatus {
  const statusError = [verifyError, job.lastStatusError]
    .filter((value): value is string => value != null && value.length > 0)
    .join(' ')

  // A missing native task API is terminal and must not be retried or sent
  // through a fallback model. Provider/transport failures remain unavailable.
  if (
    containsAny(statusError, [
      'api unavailable',
      'api not available',
      'api missing',
      'method not found',
      'unknown method',
      'not supported',
      'unsupported',
      'does not support',
      'task() is not available',
    ])
  ) {
    return 'UNSUPPORTED'
  }

  // ── Phase 1: verifyError explicit signals (highest priority) ───────

  if (verifyError != null && verifyError.length > 0) {
    // CONFLICT: canDispatch=false or concurrency exceeded
    if (containsAny(verifyError, ['canDispatch', 'concurrency', 'conflict'])) {
      return 'CONFLICT'
    }

    // INVALID_INPUT: agent not recognized / invalid
    if (containsAny(verifyError, ['invalid agent', 'agent not found', 'unknown agent'])) {
      return 'INVALID_INPUT'
    }

    // INVALID_STATE: child already in terminal state
    if (containsAny(verifyError, ['already terminal', 'already in terminal', 'invalid state'])) {
      return 'INVALID_STATE'
    }

    // CORRUPT_DATA: output can't be parsed / corrupted
    if (containsAny(verifyError, ['corrupt', 'parse failed', 'malformed', 'invalid format'])) {
      return 'CORRUPT_DATA'
    }

    // ESCALATE: unrecoverable failure
    if (containsAny(verifyError, ['unrecoverable', 'fatal', 'max retries exceeded'])) {
      return 'ESCALATE'
    }
  }

  // ── Phase 2: state-based classification ────────────────────────────

  // TIMEOUT: startup failure or timed out
  if (job.state === 'startup_failed' || job.state === 'startup_unknown' || job.timedOut) {
    return 'TIMEOUT'
  }

  // ── Phase 3: output-based classification ───────────────────────────

  if (job.state === 'completed') {
    if (!isOutputEmpty(job)) {
      return 'OK'
    }
    // completed but empty → silent failure (BackendAdmissionRejected pattern)
    return 'UNAVAILABLE'
  }

  // ── Phase 4: error state fallback ──────────────────────────────────

  if (job.state === 'error') {
    return 'UNAVAILABLE'
  }

  // ── Fallback ───────────────────────────────────────────────────────

  return 'UNAVAILABLE'
}
