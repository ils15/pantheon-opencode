/**
 * goal-loop-config.ts — runtime configuration for the full-auto Goal Loop.
 *
 * The loop's mechanics were shipped in Wave 3 (goal-store, continuation
 * ladder) but hard-disabled by a constant — no user could ever reach them.
 * This module makes it CONFIGURABLE the same way `context_pruner` is: read
 * `options.goal_loop` from the V2 config copy; malformed input yields the
 * defaults (config parsing must never take the hook down).
 *
 * Defaults stay fail-safe: the loop is OFF unless explicitly enabled, and
 * the continuation cap stays bounded (an unbounded auto-continue on a wrong
 * mission would burn budget forever).
 */
export interface GoalLoopConfig {
  enabled: boolean
  cooldownMs: number
  maxContinuations: number
}

export const DEFAULT_GOAL_LOOP_CONFIG: GoalLoopConfig = {
  enabled: false,
  cooldownMs: 5000,
  maxContinuations: 25,
}

const MIN_COOLDOWN_MS = 1000
const MIN_CONTINUATIONS = 1
const MAX_CONTINUATIONS = 200

export function resolveGoalLoopConfig(options: unknown): GoalLoopConfig {
  try {
    const raw = (options as { goal_loop?: unknown } | null | undefined)?.goal_loop
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ...DEFAULT_GOAL_LOOP_CONFIG }
    }
    const obj = raw as Record<string, unknown>
    const num = (value: unknown, fallback: number, min: number, max?: number): number => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
      const floored = Math.max(min, Math.floor(value))
      return max !== undefined ? Math.min(max, floored) : floored
    }
    return {
      enabled: typeof obj.enabled === 'boolean' ? obj.enabled : false,
      cooldownMs: num(obj.cooldownMs, DEFAULT_GOAL_LOOP_CONFIG.cooldownMs, MIN_COOLDOWN_MS),
      maxContinuations: num(
        obj.maxContinuations,
        DEFAULT_GOAL_LOOP_CONFIG.maxContinuations,
        MIN_CONTINUATIONS,
        MAX_CONTINUATIONS,
      ),
    }
  } catch {
    return { ...DEFAULT_GOAL_LOOP_CONFIG }
  }
}
