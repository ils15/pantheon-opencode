/**
 * autonomy-state.ts — the Autonomy tab of the settings window.
 *
 * TUI-local copy doctrine. Two surfaces live here:
 *
 * 1. GOAL LOOP — the persisted-mission loop (Wave 3 mechanics) read/written
 *    to `options.goal_loop` in the user's opencode.json (the same V2 config
 *    copy the context pruner uses). Startup-applied: the runtime resolves it
 *    once at plugin setup, so saving requires an OpenCode restart — the tab
 *    says so.
 *
 * 2. DECISION BUDGETS — monthly/per-decision USD caps stored in
 *    decision-router.json's companion `decision-budget` semantics. The caps
 *    the CLI writes via setup-model flags; here they are read from the
 *    decision-router.json envelope extension `budget` (v2 superset — the
 *    exact-key validator tolerates it via the documented envelope) and
 *    applied live per gated call.
 *
 * The decision-gradiente (decide-solo → Jev → human) is DOCUMENTED here, not
 * enforced: J1 owns the risk axis, budgets own the money axis — this tab
 * shows where the thresholds sit today.
 */
import type { SettingsTab } from './pantheon-settings-state.ts'

export interface GoalLoopPrefs {
  enabled: boolean
  cooldownMs: number
  maxContinuations: number
}

export const DEFAULT_GOAL_LOOP_PREFS: GoalLoopPrefs = {
  enabled: false,
  cooldownMs: 5000,
  maxContinuations: 25,
}

export const GOAL_LOOP_ENABLED_CYCLE: readonly string[] = Object.freeze(['enabled', 'disabled'])

export const MAX_CONTINUATIONS_CYCLE: readonly string[] = Object.freeze([
  '10',
  '25',
  '50',
  '100',
  '200',
])

export const COOLDOWN_MS_CYCLE: readonly string[] = Object.freeze(['1000', '2000', '5000', '10000'])

export interface DecisionBudgets {
  monthlyUsd: number
  perDecisionUsd: number
}

export const DEFAULT_DECISION_BUDGETS: DecisionBudgets = {
  monthlyUsd: 5,
  perDecisionUsd: 0.1,
}

/** Format USD compactly for a cycler cell ("$5", "$0.10"). */
export function formatUsd(value: number): string {
  return `$${value < 1 ? value.toFixed(2) : String(Math.round(value))}`
}

/** Build the USD step ladder used by the budget cyclers. */
export const MONTHLY_USD_CYCLE: readonly string[] = Object.freeze(
  [1, 2, 5, 10, 20, 50, 100].map((value) => formatUsd(value)),
)
export const PER_DECISION_USD_CYCLE: readonly string[] = Object.freeze(
  [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1].map((value) => formatUsd(value)),
)

/** Parse a staged USD cell back to a number; junk keeps the input. */
export function parseUsd(cell: string): number | null {
  const value = Number(cell.replace('$', ''))
  return Number.isFinite(value) && value > 0 ? value : null
}

export function buildAutonomyTab(input: {
  goalLoop: GoalLoopPrefs
  budgets: DecisionBudgets
  goalLoopRestartPending?: boolean
}): SettingsTab {
  return {
    id: 'autonomy',
    title: 'Autonomy',
    groups: [
      {
        title: 'Goal loop (multi-turn session auto-continuation)',
        rows: [
          {
            id: 'autonomy.goal_loop.enabled',
            name: 'Goal loop',
            value: input.goalLoop.enabled ? 'enabled' : 'disabled',
            cycle: GOAL_LOOP_ENABLED_CYCLE,
            note:
              'auto-continues multi-turn tasks when session goes idle' +
              (input.goalLoopRestartPending
                ? ' · [!] restart required to apply'
                : ' · applies after OpenCode restart'),
          },
          {
            id: 'autonomy.goal_loop.maxContinuations',
            name: 'Max continuations',
            value: String(input.goalLoop.maxContinuations),
            cycle: MAX_CONTINUATIONS_CYCLE,
            note: '1..200 — safety ceiling to prevent runaway tasks',
          },
          {
            id: 'autonomy.goal_loop.cooldownMs',
            name: 'Cooldown (ms)',
            value: String(input.goalLoop.cooldownMs),
            cycle: COOLDOWN_MS_CYCLE,
            note: 'delay between autonomous turns (min 1000ms)',
          },
        ],
      },
      {
        title: 'Decision budgets (applies live per gated call)',
        rows: [
          {
            id: 'autonomy.budget.monthly',
            name: 'Monthly cap',
            value: formatUsd(input.budgets.monthlyUsd),
            cycle: MONTHLY_USD_CYCLE,
            note: 'monthly USD ceiling for gated arbitrator decisions',
          },
          {
            id: 'autonomy.budget.perDecision',
            name: 'Per-decision cap',
            value: formatUsd(input.budgets.perDecisionUsd),
            cycle: PER_DECISION_USD_CYCLE,
            note: 'price cap — gated decisions above this are refused',
          },
        ],
      },
      {
        title: 'Decision gradient (reference policy · J1 owns the risk axis)',
        rows: [
          {
            id: 'autonomy.gradient.solo',
            name: 'Decide solo',
            value: 'autonomous',
            note: 'reversible & low-risk edits, routine fixes (no gate)',
          },
          {
            id: 'autonomy.gradient.jev',
            name: 'Jev decides',
            value: 'arbitrated',
            note: 'typed ambiguity & candidate ranking (budget-capped)',
          },
          {
            id: 'autonomy.gradient.human',
            name: 'Human decides',
            value: 'human review',
            note: 'high-risk & destructive operations (J1 gate)',
          },
        ],
      },
    ],
  }
}
