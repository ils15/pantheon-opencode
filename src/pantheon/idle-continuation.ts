/**
 * Idle Continuation Dispatcher (Wave 3, PR #46) — routes `session.idle`
 * events to the subsystem that owns the idle.
 *
 * Priority: an ACTIVE GOAL owns the idle — `GoalLoop.onIdle` continues the
 * goal. Without an active goal, the TODO enforcer gets the idle (it
 * self-guards on its own enabled flag + guards). Board-child sessions never
 * reach the dispatcher — the plugin's event hook routes those to the
 * delegation finalize path first (`handleDelegationEvent` returns true) and
 * only calls the dispatcher on the `!delegated` branch.
 *
 * Independently testable — the loop and enforcer are structural interfaces;
 * the real GoalLoop/TodoEnforcer satisfy them.
 *
 * Pure TypeScript — zero runtime dependencies.
 *
 * @module idle-continuation
 */

/** Structural goal-loop surface the dispatcher needs. */
export interface GoalLoopLike {
  hasActiveGoal(sessionID: string): Promise<boolean>
  onIdle(sessionID: string): Promise<void>
}

/** Structural todo-enforcer surface the dispatcher needs. */
export interface TodoEnforcerLike {
  onIdle(sessionID: string): Promise<void>
}

/** The dispatcher's onIdle surface (used by the plugin event hook). */
export interface IdleDispatcher {
  onIdle(sessionID: string): Promise<void>
}

/**
 * Build the idle router. The plugin event hook calls this only on the
 * `!delegated` branch of `handleDelegationEvent`, so board children never
 * arrive here.
 */
export function createIdleDispatcher(deps: {
  goalLoop: GoalLoopLike
  todoEnforcer: TodoEnforcerLike
}): IdleDispatcher {
  return {
    onIdle: async (sessionID: string): Promise<void> => {
      if (await deps.goalLoop.hasActiveGoal(sessionID)) {
        await deps.goalLoop.onIdle(sessionID)
        return
      }
      await deps.todoEnforcer.onIdle(sessionID)
    },
  }
}
