/**
 * V2 Event Handlers — Pantheon event subscriptions for the V2 plugin API.
 *
 * Subscribes to session lifecycle events (created, idle, error, compacted)
 * and routes them to the appropriate subsystem:
 * - session.created → seed session hierarchy + root sessions
 * - session.idle → delegation finalize / goal loop / todo enforcer
 * - session.error → delegation finalize as error
 * - session.compacted → todo preserve / compaction context
 *
 * These handlers are PURE — they depend only on structural interfaces,
 * not on the V1 PluginInput or V2 PluginContext.
 *
 * @module pantheon/v2-events
 */

import type { BackgroundJobBoard } from './background-job-board.ts'
import type { FinalizeInput } from './delegation-finalize.ts'
import type { DelegationEventDeps, DelegationEventLike } from './delegation-notify.ts'
import { handleDelegationEvent } from './delegation-notify.ts'
import type { GoalLoopLike, TodoEnforcerLike } from './idle-continuation.ts'
import { createIdleDispatcher, type IdleDispatcher } from './idle-continuation.ts'
import { createPantheonLogger } from './logger.ts'

const log = createPantheonLogger({ module: 'pantheon-v2-events' })

// ─── Types ───────────────────────────────────────────────────────────────

/**
 * Structural session info from session.created events.
 */
export interface SessionInfo {
  id: string
  parentID?: string
}

/**
 * Structural event from the V2 event stream.
 */
export interface V2SessionEvent {
  type: string
  properties?: Record<string, unknown>
}

/**
 * Dependencies for the V2 event dispatcher.
 */
export interface V2EventDeps {
  board: BackgroundJobBoard
  finalize: (childSessionID: string, opts: FinalizeInput) => Promise<unknown>
  goalLoop: GoalLoopLike
  todoEnforcer: TodoEnforcerLike
  /** Callback to register a session in the hierarchy. */
  registerSession?: (info: SessionInfo) => void
  /** Callback to add a session as root. */
  addRootSession?: (sessionID: string) => void
}

/**
 * V2 Event Dispatcher — routes session events to subsystems.
 */
export interface V2EventDispatcher {
  /** Process a session event. Returns true if handled. */
  handleEvent(event: V2SessionEvent): Promise<boolean>
  /** Cleanup subscriptions. */
  dispose(): void
}

// ─── Implementation ──────────────────────────────────────────────────────

/**
 * Create the V2 event dispatcher. Routes session lifecycle events to
 * delegation finalize, goal loop, and todo enforcer.
 *
 * Usage:
 * ```ts
 * const dispatcher = createV2EventDispatcher(deps)
 * // In event subscription loop:
 * for await (const event of ctx.event.subscribe(...)) {
 *   await dispatcher.handleEvent(event)
 * }
 * ```
 */
export function createV2EventDispatcher(deps: V2EventDeps): V2EventDispatcher {
  const delegationDeps: DelegationEventDeps = {
    board: deps.board,
    finalize: deps.finalize,
  }
  const idleDispatcher: IdleDispatcher = createIdleDispatcher({
    goalLoop: deps.goalLoop,
    todoEnforcer: deps.todoEnforcer,
  })

  return {
    handleEvent: async (event: V2SessionEvent): Promise<boolean> => {
      try {
        // session.created → seed hierarchy
        if (event.type === 'session.created') {
          const info = event.properties?.info as SessionInfo | undefined
          if (info) {
            deps.registerSession?.(info)
            if (info.parentID === undefined) {
              deps.addRootSession?.(info.id)
            }
          }
        }

        // Delegate to handleDelegationEvent (covers idle + error for board children)
        const delegated = await handleDelegationEvent(event as DelegationEventLike, delegationDeps)

        // Non-board idle → idle dispatcher (goal loop / todo enforcer)
        if (!delegated && event.type === 'session.idle') {
          const sessionID = event.properties?.sessionID as string | undefined
          if (sessionID) {
            await idleDispatcher.onIdle(sessionID)
          }
        }

        return delegated
      } catch (err) {
        log.error('[Pantheon V2] Event handling failed:', err)
        return false
      }
    },

    dispose: () => {
      // No persistent subscriptions to clean up — the event stream
      // lifecycle is managed by the caller.
    },
  }
}
