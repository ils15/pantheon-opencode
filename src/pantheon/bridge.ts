/**
 * Legacy bridge — passes legacy infrastructure singletons through 2.x context options.
 *
 * The plugin (`src/plugin.ts`) registers tools via `ctx.tool.transform()` but
 * lacks the runtime singletons (BackgroundJobBoard, delegation client, goal store,
 * todo enforcer, vision handler) that live in the V1 plugin. This bridge:
 *
 *   1. Wraps V1 singletons into a portable `PantheonBridge` interface.
 *   2. Attaches the bridge to the host `ctx.options` so tool handlers can access it.
 *   3. Provides `getBridgeFromContext()` for tools to retrieve the bridge.
 *
 * Design: the bridge is **optional** — the plugin works without it (graceful
 * fallback with limited functionality). The legacy modules and the 2.x entry are never directly coupled;
 * communication is via the `PantheonBridge` interface only.
 *
 * @module bridge
 */

import type { BackgroundJobBoard } from './background-job-board.ts'
import type { GoalStore } from './goal-store.ts'
import type { TodoEnforcer } from './todo-enforcer.ts'

// ─── Types ─────────────────────────────────────────────────────────────

/**
 * Minimal structural view of the host PluginContext — we only need `options`
 * to inject/retrieve the bridge. Avoids importing the 2.x SDK types directly.
 */
export interface ContextLike {
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
 * only need the hook functions for event delegation.
 */
export interface VisionHandler {
  chatMessage: (...args: unknown[]) => Promise<void>
  messagesTransform: (...args: unknown[]) => Promise<void>
  event: (...args: unknown[]) => Promise<void>
}

/**
 * Full bridge interface — all legacy infrastructure the tools need.
 *
 * Every field is optional to support partial initialization and graceful
 * degradation when V1 infrastructure is not available.
 */
export interface PantheonBridge {
  /** Background job board — tracks running/completed/cancelled delegated jobs. */
  board?: BackgroundJobBoard
  /** Goal store — file-based persistence for full-auto goal loop. */
  goalStore?: GoalStore
  /** Todo enforcer — idle continuation when todos are incomplete. */
  todoEnforcer?: TodoEnforcer
  /** Vision handler — image analysis, chat message enrichment, event handling. */
  visionHandler?: VisionHandler
}

/**
 * Extended context options that carry the bridge.
 * The bridge is attached under the `__pantheonV1Bridge` key to avoid
 * collisions with user-defined options.
 */
export const BRIDGE_OPTIONS_KEY = '__pantheonV1Bridge' as const

// ─── Bridge Factory ────────────────────────────────────────────────────

/**
 * Create a bridge from V1 singletons.
 *
 * Call this inside the V1 plugin's `setup()` AFTER the singletons are
 * initialized, then pass the result to the host via `ctx.options`.
 *
 * @example
 * ```ts
 * // In V1 plugin setup (plugin.ts):
 * const bridge = createBridge({ board, goalStore, ... })
 * // Then pass bridge to the context via options
 * ```
 */
export function createBridge(singletons: PantheonBridge): PantheonBridge {
  // Return a frozen copy — bridge consumers must not mutate singletons.
  return Object.freeze({ ...singletons })
}

/**
 * Retrieve the bridge from a host PluginContext.
 *
 * Returns `null` when the bridge was not injected (2.x running standalone
 * or legacy modules not yet initialized). Tools should check for null and
 * degrade gracefully.
 *
 * @example
 * ```ts
 * // In a tool handler:
 * const bridge = getBridgeFromContext(ctx)
 * if (!bridge?.board) {
 *   return { text: 'Background job board unavailable — delegation disabled.' }
 * }
 * ```
 */
export function getBridgeFromContext(ctx: ContextLike): PantheonBridge | null {
  const bridge = ctx.options[BRIDGE_OPTIONS_KEY]
  if (bridge != null && typeof bridge === 'object') {
    return bridge as PantheonBridge
  }
  return null
}

/**
 * Inject the bridge into a host PluginContext's options.
 *
 * Call this during legacy setup to make the bridge available to the tools.
 * Safe to call multiple times — subsequent calls overwrite the previous bridge.
 */
export function injectBridge(ctx: ContextLike, bridge: PantheonBridge): void {
  ctx.options[BRIDGE_OPTIONS_KEY] = bridge
}

// ─── Process-wide registration (cross-generation) ──────────────────────

/**
 * The bridge registered by whichever plugin loaded first in this process.
 *
 * The module-level handle lives HERE rather than in `src/plugin.ts` because V1
 * must be able to publish its singletons WITHOUT importing the plugin: a
 * V1-only install never loaded `src/plugin.ts`, and importing it just to hand
 * over a bridge would pull the 2.x `define()` into that process.
 *
 * Why registration matters: in a process that loads both generations (npm +
 * repo double load, or a mixed config), the legacy idle dispatcher and the 2.x entry
 * would otherwise each build a TodoEnforcer and answer the same `session.idle`
 * twice — two continuation prompts for one idle. 1.x registers; 2.x reuses.
 */
let registeredBridge: PantheonBridge | null = null

/** Publish (or, with `null`, clear) the process-wide bridge. */
export function registerBridge(bridge: PantheonBridge | null): void {
  registeredBridge = bridge
}

/** The bridge published by this process, or null. */
export function getRegisteredBridge(): PantheonBridge | null {
  return registeredBridge
}
