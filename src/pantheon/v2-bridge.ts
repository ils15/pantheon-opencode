/**
 * V1→V2 Bridge — passes V1 infrastructure singletons through V2 context options.
 *
 * The V2 plugin (`plugin-v2.ts`) registers tools via `ctx.tool.transform()` but
 * lacks the runtime singletons (BackgroundJobBoard, delegation client, goal store,
 * todo enforcer, vision handler) that live in the V1 plugin. This bridge:
 *
 *   1. Wraps V1 singletons into a portable `PantheonV2Bridge` interface.
 *   2. Attaches the bridge to V2 `ctx.options` so V2 tool handlers can access it.
 *   3. Provides `getV2BridgeFromContext()` for V2 tools to retrieve the bridge.
 *
 * Design: the bridge is **optional** — V2 plugin works without it (graceful
 * fallback with limited functionality). V1 and V2 are never directly coupled;
 * communication is via the `PantheonV2Bridge` interface only.
 *
 * @module v2-bridge
 */

import type { BackgroundJobBoard } from './background-job-board.ts'
import type { DelegationClient } from './delegation-finalize.ts'
import type { GoalStore } from './goal-store.ts'
import type { TodoEnforcer } from './todo-enforcer.ts'

// ─── Types ─────────────────────────────────────────────────────────────

/**
 * Minimal structural view of the V2 PluginContext — we only need `options`
 * to inject/retrieve the bridge. Avoids importing V2 SDK types directly.
 */
export interface V2ContextLike {
  options: Record<string, unknown>
}

/** Structural view of the V1 PluginInput — the fields the bridge needs. */
export interface V1PluginInput {
  client: unknown
  directory: string
}

/**
 * Vision handler surface — the subset of the V1 vision handler the bridge
 * exposes. Full type is the return of `createVisionHandler(input)`, but we
 * only need the hook functions for V2 event delegation.
 */
export interface VisionHandler {
  chatMessage: (...args: unknown[]) => Promise<void>
  messagesTransform: (...args: unknown[]) => Promise<void>
  event: (...args: unknown[]) => Promise<void>
}

/**
 * Full bridge interface — all V1 infrastructure V2 tools need.
 *
 * Every field is optional to support partial initialization and graceful
 * degradation when V1 infrastructure is not available.
 */
export interface PantheonV2Bridge {
  /** Background job board — tracks running/completed/cancelled delegated jobs. */
  board?: BackgroundJobBoard
  /** Structural delegation client — creates child sessions and sends prompts. */
  delegationClient?: DelegationClient
  /** Goal store — file-based persistence for full-auto goal loop. */
  goalStore?: GoalStore
  /** Todo enforcer — idle continuation when todos are incomplete. */
  todoEnforcer?: TodoEnforcer
  /** Vision handler — image analysis, chat message enrichment, event handling. */
  visionHandler?: VisionHandler
}

/**
 * Extended V2 context options that carry the bridge.
 * The bridge is attached under the `__pantheonV1Bridge` key to avoid
 * collisions with user-defined options.
 */
export const BRIDGE_OPTIONS_KEY = '__pantheonV1Bridge' as const

// ─── Bridge Factory ────────────────────────────────────────────────────

/**
 * Create a bridge from V1 singletons.
 *
 * Call this inside the V1 plugin's `setup()` AFTER the singletons are
 * initialized, then pass the result to V2 via `ctx.options`.
 *
 * @example
 * ```ts
 * // In V1 plugin setup (plugin.ts):
 * const bridge = createV2Bridge({ board, delegationClient, goalStore, ... })
 * // Then pass bridge to V2 context via options
 * ```
 */
export function createV2Bridge(singletons: PantheonV2Bridge): PantheonV2Bridge {
  // Return a frozen copy — bridge consumers must not mutate singletons.
  return Object.freeze({ ...singletons })
}

/**
 * Retrieve the bridge from a V2 PluginContext.
 *
 * Returns `null` when the bridge was not injected (V2 running standalone
 * or V1 not yet initialized). V2 tools should check for null and
 * degrade gracefully.
 *
 * @example
 * ```ts
 * // In a V2 tool handler:
 * const bridge = getV2BridgeFromContext(ctx)
 * if (!bridge?.board) {
 *   return { text: 'Background job board unavailable — delegation disabled.' }
 * }
 * ```
 */
export function getV2BridgeFromContext(ctx: V2ContextLike): PantheonV2Bridge | null {
  const bridge = ctx.options[BRIDGE_OPTIONS_KEY]
  if (bridge != null && typeof bridge === 'object') {
    return bridge as PantheonV2Bridge
  }
  return null
}

/**
 * Inject the bridge into a V2 PluginContext's options.
 *
 * Call this in the V1 plugin to make the bridge available to V2 tools.
 * Safe to call multiple times — subsequent calls overwrite the previous bridge.
 */
export function injectBridge(ctx: V2ContextLike, bridge: PantheonV2Bridge): void {
  ctx.options[BRIDGE_OPTIONS_KEY] = bridge
}
