/**
 * Themis Local Reflex Loop — Self-healing inline verification for implementer agents.
 *
 * Catches syntax errors, lint failures, and sliced test failures directly in the
 * implementer's execution cycle, granting up to 2 bounded retry attempts before
 * escalating to the Zeus coordinator.
 *
 * Emits reactive events on `getSharedBus()` for auditability and observability.
 *
 * Pure TypeScript — zero external dependencies.
 *
 * @module themis-reflex
 */

import { getSharedBus } from './bus.ts'

export interface ThemisDiscrepancy {
  readonly file: string
  readonly error: string
  readonly expected?: string
  readonly actual?: string
  readonly suggestedFix?: string
}

export interface ReflexAttemptState {
  taskID: string
  agent: string
  attempt: number
  maxAttempts: number
  discrepancies: ThemisDiscrepancy[]
  timestamp: number
}

export type ThemisReflexDecision =
  | {
      readonly action: 'retry'
      readonly prompt: string
      readonly attempt: number
      readonly maxAttempts: number
    }
  | {
      readonly action: 'escalate'
      readonly verdict: 'BLOCK' | 'FAIL'
      readonly reason: string
      readonly attempts: number
    }
  | {
      readonly action: 'pass'
      readonly verdict: 'PASS'
    }

export class ThemisReflexController {
  private readonly states: Map<string, ReflexAttemptState> = new Map()
  private readonly maxRetries: number

  constructor(options: { maxRetries?: number } = {}) {
    this.maxRetries = options.maxRetries ?? 2
  }

  /**
   * Evaluate a task execution result against Themis verification findings.
   * If discrepancies are found and attempts remain, returns an actionable retry directive.
   */
  evaluate(
    taskID: string,
    agent: string,
    discrepancies: readonly ThemisDiscrepancy[],
  ): ThemisReflexDecision {
    if (discrepancies.length === 0) {
      const existing = this.states.get(taskID)
      if (existing) {
        getSharedBus().emit('themis:reflex:resolved', {
          taskID,
          agent,
          file: existing.discrepancies[0]?.file ?? '',
          error: '',
          attempt: existing.attempt,
          maxAttempts: this.maxRetries,
          timestamp: Date.now(),
          resolved: true,
        })
        this.states.delete(taskID)
      }
      return { action: 'pass', verdict: 'PASS' }
    }

    let state = this.states.get(taskID)
    if (!state) {
      state = {
        taskID,
        agent,
        attempt: 0,
        maxAttempts: this.maxRetries,
        discrepancies: [...discrepancies],
        timestamp: Date.now(),
      }
      this.states.set(taskID, state)
    }

    state.attempt += 1
    state.discrepancies = [...discrepancies]
    state.timestamp = Date.now()

    const firstDisc = discrepancies[0]
    getSharedBus().emit('themis:reflex:discrepancy', {
      taskID,
      agent,
      file: firstDisc.file,
      error: firstDisc.error,
      attempt: state.attempt,
      maxAttempts: this.maxRetries,
      timestamp: state.timestamp,
    })

    if (state.attempt <= this.maxRetries) {
      const prompt = this.formatReflexPrompt(state.attempt, this.maxRetries, discrepancies)
      return {
        action: 'retry',
        prompt,
        attempt: state.attempt,
        maxAttempts: this.maxRetries,
      }
    }

    // Retries exhausted — escalate to coordinator
    this.states.delete(taskID)
    return {
      action: 'escalate',
      verdict: 'FAIL',
      reason: `themis.reflex.exhausted:${state.attempt - 1}_retries_failed`,
      attempts: state.attempt,
    }
  }

  /**
   * Format an inline, high-density reflex prompt directing the implementer to self-heal.
   */
  private formatReflexPrompt(
    attempt: number,
    maxAttempts: number,
    discrepancies: readonly ThemisDiscrepancy[],
  ): string {
    const lines = [
      `[THEMIS INLINE REFLEX — Attempt ${attempt}/${maxAttempts}]`,
      'Themis automated audit detected discrepancies in your edits. Fix them directly before returning:',
    ]

    for (const d of discrepancies) {
      lines.push(`- File: ${d.file}`)
      lines.push(`  Error: ${d.error}`)
      if (d.expected) lines.push(`  Expected: ${d.expected}`)
      if (d.actual) lines.push(`  Actual: ${d.actual}`)
      if (d.suggestedFix) lines.push(`  Fix hint: ${d.suggestedFix}`)
    }

    lines.push('Do NOT escalate to Zeus yet. Apply the targeted fix and re-verify your slice.')
    return lines.join('\n')
  }

  /** Reset state for a taskID */
  reset(taskID: string): void {
    this.states.delete(taskID)
  }
}
