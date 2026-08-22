/**
 * R4 — Per-agent step caps (max_steps).
 *
 * Pure library. routing.yml `agents.<name>.max_steps` gives each agent a
 * step budget (e.g. explore: 25, reviewer: 25, oracle: 15). When an agent's
 * step count reaches max_steps it is forced to summarize-and-stop: the
 * delegation is either skipped with a capped summary (already at cap) or
 * the prompt is appended with a stop instruction (cap hit mid-dispatch).
 *
 * The tracker is PERMANENT-PER-PROCESS: counters accumulate for the process
 * lifetime and are intentionally NOT reset on successful delegations or
 * session end — a per-session reset would let an agent exceed its process
 * budget over a long session. `reset()` exists as a tested utility for
 * tests and future explicit reset points; no production caller wires it.
 *
 * @module step-cap
 */

// ─── Types ─────────────────────────────────────────────────────────────

/** Default step budget when routing.yml omits max_steps for an agent. */
export const DEFAULT_MAX_STEPS = 25

// ─── Stop instruction ──────────────────────────────────────────────────

/**
 * The forced summarize-and-stop instruction injected into a prompt when an
 * agent's step count reaches max_steps.
 */
export function buildStopInstruction(agent: string, maxSteps: number): string {
  return (
    `\n\n[STEP CAP REACHED — ${agent} at ${maxSteps} steps] ` +
    `You have reached the maximum step budget for this delegation. ` +
    `STOP working immediately and summarize what was accomplished (and ` +
    `what remains, if any) as your final message. Do not start new work.`
  )
}

/**
 * The text returned when a delegation is skipped because the agent is
 * already at its step cap — marks the delegation as capped and asks for a
 * summary of prior results instead of starting new work.
 */
export function cappedSummary(agent: string, maxSteps: number): string {
  return (
    `[STEP CAP REACHED] ${agent} has reached its max_steps budget (${maxSteps}). ` +
    `Delegation skipped — no new work was started. ` +
    `Summarize prior results and stop.`
  )
}

// ─── Tracker ───────────────────────────────────────────────────────────

/**
 * Per-agent step counters with a max_steps budget. Keyed by lowercase agent
 * name (matching is case-insensitive). Agents without a configured budget
 * are never capped.
 */
export class StepCapTracker {
  private readonly steps = new Map<string, number>()
  readonly maxStepsByAgent: Readonly<Record<string, number>>

  constructor(maxStepsByAgent: Readonly<Record<string, number>> = {}) {
    this.maxStepsByAgent = maxStepsByAgent
  }

  /** The configured budget for an agent, or undefined when uncapped. */
  maxStepsFor(agent: string): number | undefined {
    return this.maxStepsByAgent[agent.toLowerCase()]
  }

  /** Current step count for an agent. */
  stepCount(agent: string): number {
    return this.steps.get(agent.toLowerCase()) ?? 0
  }

  /** Whether the agent has reached (or exceeded) its max_steps budget. */
  isCapped(agent: string): boolean {
    const max = this.maxStepsFor(agent)
    if (max === undefined) return false
    return this.stepCount(agent) >= max
  }

  /**
   * Record one step for an agent. Returns the new count and whether this
   * step hit the cap (capped === true exactly when steps >= maxSteps).
   */
  recordStep(agent: string): {
    steps: number
    capped: boolean
    maxSteps: number | undefined
  } {
    const key = agent.toLowerCase()
    const max = this.maxStepsFor(agent)
    const steps = (this.steps.get(key) ?? 0) + 1
    this.steps.set(key, steps)
    return { steps, capped: max !== undefined && steps >= max, maxSteps: max }
  }

  /**
   * Reset an agent's step count.
   *
   * Intentionally NOT wired in production: the tracker is permanent-per-
   * process (see module docstring) so agents cannot exceed their process
   * budget via resets. Exists for tests and future explicit reset points.
   */
  reset(agent: string): void {
    this.steps.delete(agent.toLowerCase())
  }
}
