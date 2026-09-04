/**
 * V2 Session Hooks — Pantheon session hooks for the V2 plugin API.
 *
 * Provides two hook types:
 * - `"prompt"` hook: Vision message interception (paste-and-ask). Intercepts
 *   user messages with pasted images and replaces them with text instructions
 *   or native vision descriptions.
 * - `"context"` hook: Inject routing policy, active goals, and pending todos
 *   into the system context before each LLM call.
 *
 * These handlers are PURE — they depend only on structural interfaces.
 *
 * @module pantheon/v2-hooks
 */

import type { BackgroundJobBoard } from './background-job-board.ts'
import { buildCompactionContext } from './delegation-compaction.ts'
import type { GoalStore } from './goal-loop.ts'
import { createPantheonLogger } from './logger.ts'
import type { TodoEnforcer } from './todo-enforcer.ts'

const log = createPantheonLogger({ module: 'pantheon-v2-hooks' })

// ─── Types ───────────────────────────────────────────────────────────────

/**
 * Structural context event passed to the "context" hook.
 * V2 API: `ctx.session.hook("context", (event) => { ... })`
 */
export interface V2ContextHookEvent {
  sessionID: string
  system: string[]
  generation: {
    temperature?: number
  }
}

/**
 * Structural prompt event passed to the "prompt" hook.
 * V2 API: `ctx.session.hook("prompt", (event) => { ... })`
 */
export interface V2PromptHookEvent {
  sessionID: string
  message: unknown
}

/**
 * Dependencies for session hooks.
 */
export interface V2HookDeps {
  board: BackgroundJobBoard
  goalStore: GoalStore
  todoEnforcer: TodoEnforcer
}

// ─── Context Hook ────────────────────────────────────────────────────────

const POLICY_MARKER = '<!-- pantheon-v2-policy -->'
const ROUTING_POLICY =
  `${POLICY_MARKER}\nFollow Pantheon routing policy: delegate implementation work ` +
  `to the named specialist and do not claim work was performed without verification.`

/** Default max compaction items (matching routing.yml background_delegation.max_compaction_items). */
const DEFAULT_MAX_COMPACTION_ITEMS = 10

/**
 * Context hook handler — injects Pantheon policy, routing, and compaction
 * state into the system context before each LLM call.
 *
 * Registered via: `ctx.session.hook("context", handler)`
 */
export function createV2ContextHookHandler(deps: V2HookDeps) {
  return async (event: V2ContextHookEvent): Promise<void> => {
    try {
      // 1. Inject routing policy if not already present
      const hasPolicy = event.system.some((s) => s.includes(POLICY_MARKER))
      if (!hasPolicy) {
        event.system.push(ROUTING_POLICY)
      }

      // 2. Inject compaction context (active goals, pending todos, delegations)
      const blocks = await buildCompactionContext(deps.board, {
        sessionID: event.sessionID,
        maxItems: DEFAULT_MAX_COMPACTION_ITEMS,
        goals: {
          enabled: true,
          list: (sessionID: string) => deps.goalStore.list(sessionID),
        },
        todos: {
          enabled: true,
          list: (sessionID: string) => deps.todoEnforcer.listPendingTodos(sessionID),
        },
      })
      if (blocks.length > 0) {
        event.system.push(...blocks)
      }

      // 3. Apply conservative temperature for routing decisions
      if (event.generation.temperature === undefined) {
        event.generation.temperature = 0.2
      }
    } catch (err) {
      log.warn('[Pantheon V2] Context hook failed:', err)
      // Fail-open: never break the session
    }
  }
}

// ─── Prompt Hook ─────────────────────────────────────────────────────────

/**
 * Prompt hook handler — intercepts user messages for vision processing.
 *
 * Registered via: `ctx.session.hook("prompt", handler)`
 *
 * Note: The full vision handler is complex (file I/O, provider API calls).
 * This is a minimal adapter that delegates to the V1 vision handler
 * if available. Without vision infrastructure, it's a no-op.
 */
export function createV2PromptHookHandler(_deps: V2HookDeps) {
  return async (event: V2PromptHookEvent): Promise<void> => {
    // Vision interception is a complex subsystem (see src/pantheon/vision.ts).
    // The V2 prompt hook delegates to the V1 vision handler via the plugin's
    // integration point. Without V1 client access, this is a graceful no-op.
    //
    // TODO: Wire full vision handler when V2 provides SDK client access.
    void event
  }
}

// ─── Tool Hooks ──────────────────────────────────────────────────────────

/**
 * Tool execute.before hook — enforces read-only restrictions, command
 * normalization, and todo preservation.
 *
 * Registered via: `ctx.tool.hook("execute.before", handler)`
 */
export interface V2ToolBeforeEvent {
  tool: string
  sessionID: string
  callID: string
  args?: unknown
}

export function createV2ToolBeforeHookHandler(
  enforcementGuard: (
    input: { tool: string; sessionID: string; callID: string },
    output?: { args?: unknown },
  ) => void,
  commandNormalizer: (
    input: { tool: string; sessionID: string; callID: string },
    output?: { args?: unknown },
  ) => Promise<void>,
) {
  return async (event: V2ToolBeforeEvent): Promise<void> => {
    try {
      enforcementGuard(
        { tool: event.tool, sessionID: event.sessionID, callID: event.callID },
        { args: event.args },
      )
      await commandNormalizer(
        { tool: event.tool, sessionID: event.sessionID, callID: event.callID },
        { args: event.args },
      )
    } catch (err) {
      log.warn('[Pantheon V2] Tool before-hook failed:', err)
    }
  }
}

/**
 * Tool execute.after hook — augments read output with hashline tags
 * and applies context sandbox truncation.
 *
 * Registered via: `ctx.tool.hook("execute.after", handler)`
 */
export interface V2ToolAfterEvent {
  tool: string
  sessionID: string
  callID: string
  args?: unknown
  output: string
}

export function createV2ToolAfterHookHandler(
  readEnhancer: (
    input: { tool: string; sessionID: string; callID: string; args?: unknown },
    output: { output: string },
  ) => Promise<void>,
  sandboxHandler: (
    input: { tool: string; sessionID: string; callID: string; args?: unknown },
    output: { output: string },
  ) => Promise<void>,
) {
  return async (event: V2ToolAfterEvent): Promise<void> => {
    try {
      const input = {
        tool: event.tool,
        sessionID: event.sessionID,
        callID: event.callID,
        args: event.args,
      }
      const output = { output: event.output }
      await sandboxHandler(input, output)
      await readEnhancer(input, output)
      event.output = output.output
    } catch (err) {
      log.warn('[Pantheon V2] Tool after-hook failed:', err)
    }
  }
}
