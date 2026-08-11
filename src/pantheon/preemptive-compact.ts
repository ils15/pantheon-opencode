/**
 * Preemptive Compaction Check (release-134 Phase 5) — dormant, ready-to-wire.
 *
 * WHY: the SDK 1.18.x exposes NO runtime source of context-usage percentage,
 * so there is nothing to observe at runtime yet. This module is the pure
 * decision core that warns the model BEFORE the context fills up — ready to
 * be wired to a future usage source, but deliberately NOT wired today.
 *
 * HOW: `preemptiveCompactCheck` is a pure function: given the current usage
 * fraction and the last fraction at which a warning was emitted, it decides
 * whether to warn again (threshold + re-warn step) and returns the effective
 * `lastWarnedPct`. The `enqueue` callback is INJECTED by the caller — this
 * module stays standalone and does NOT import the shared chat-reminders
 * buffer.
 *
 * YAGNI: no background timers, no polling, no plugin wiring. When (if) the
 * SDK exposes a usage source, the caller wires it into this check.
 *
 * FAIL-OPEN: the whole check is wrapped — an enqueue failure returns the
 * previous state and never throws.
 *
 * @module preemptive-compact
 */

// ─── Constants ─────────────────────────────────────────────────────────

/** Warn when context usage reaches this fraction (78%). */
export const PREEMPTIVE_COMPACTION_THRESHOLD = 0.78

/** Re-warn only when usage rose at least this much since the last warning (5pp). */
export const PREEMPTIVE_REWARN_STEP = 0.05

// ─── Types ─────────────────────────────────────────────────────────────

/** Dependencies threaded to preemptiveCompactCheck (wired from plugin.ts). */
export interface PreemptiveCompactDeps {
  /** The session whose context usage is being checked. */
  sessionID: string
  /** Current context usage as a fraction (0..1). */
  usagePct: number
  /** Last fraction at which a warning was emitted (undefined = never). */
  lastWarnedPct: number | undefined
  /** Injectable enqueue (testable). The module stays standalone. */
  enqueue: (text: string) => void
}

// ─── Decision ──────────────────────────────────────────────────────────

/**
 * Pure decision: should a warning be emitted at the given usage?
 * True when usage is at/above the threshold AND either no warning was
 * emitted yet or usage rose by at least the re-warn step since the last one.
 */
export function shouldWarn(usagePct: number, lastWarnedPct: number | undefined): boolean {
  if (usagePct < PREEMPTIVE_COMPACTION_THRESHOLD) return false
  if (lastWarnedPct === undefined) return true
  return usagePct >= lastWarnedPct + PREEMPTIVE_REWARN_STEP
}

/**
 * Preemptive compaction check: when a warning should fire, enqueue the
 * reminder and return the usage fraction as the new `lastWarnedPct`.
 * Otherwise (or on any failure) return the previous `lastWarnedPct`.
 * NEVER throws — the hook must never break the session.
 */
export function preemptiveCompactCheck(deps: PreemptiveCompactDeps): number | undefined {
  try {
    if (!shouldWarn(deps.usagePct, deps.lastWarnedPct)) return deps.lastWarnedPct
    deps.enqueue(
      `context usage at ${Math.round(deps.usagePct * 100)}% — consider compacting before continuing`,
    )
    return deps.usagePct
  } catch {
    return deps.lastWarnedPct
  }
}
