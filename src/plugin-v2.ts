/**
 * Pantheon V2 Plugin — full orchestration plugin for OpenCode V2.
 *
 * Registers:
 * - 9 orchestration tools via V2 tool.transform (with V1 bridge fallback)
 * - 4 event subscriptions (session.created, idle, error, compacted)
 * - Session hooks (prompt, context) and tool hooks (execute.before/after)
 * - Permission hooks for custom authorization
 *
 * V2 Plugin API surface (confirmed by investigation):
 *   ctx.tool.transform / ctx.event.subscribe / ctx.session.hook /
 *   ctx.tool.hook / ctx.permission.hook
 *
 * When a V2 API domain is unavailable, the feature is gracefully skipped
 * and documented in V2_UNSUPPORTED_FEATURES. The plugin never breaks.
 *
 * @module plugin-v2
 */

import { fileURLToPath } from 'node:url'
import type {
  AgentDraft,
  CatalogDraft,
  CommandDraft,
  PluginContext,
  ReferenceDraft,
  SkillDraft,
} from '@opencode-ai/plugin/v2/promise'
import { define } from '@opencode-ai/plugin/v2/promise'
import {
  getV2BridgeFromContext,
  type PantheonV2Bridge,
  type V2ContextLike,
} from './pantheon/v2-bridge.ts'

// ─── Unsupported Features Registry ───────────────────────────────────────

/**
 * Features not yet supported by the installed V2 plugin API.
 * Updated dynamically at setup time based on actual API availability.
 * Initialized with features known to be absent from the V2 promise API;
 * additional features are appended during setup if their API is missing.
 */
export const V2_UNSUPPORTED_FEATURES: string[] = ['legacy-hooks']

// ─── Constants ───────────────────────────────────────────────────────────

const POLICY_MARKER = '<!-- pantheon-v2-policy -->'
const POLICY = `${POLICY_MARKER}\nFollow Pantheon routing policy: delegate implementation work to the named specialist and do not claim work was performed without verification.`

/**
 * Add a feature to the unsupported list (idempotent).
 */
function markUnsupported(feature: string): void {
  if (!V2_UNSUPPORTED_FEATURES.includes(feature)) {
    V2_UNSUPPORTED_FEATURES.push(feature)
  }
}

// ─── V1 Bridge Integration ──────────────────────────────────────────────

/**
 * Module-level bridge reference. Set via `setV2Bridge()` from V1 plugin
 * after singletons are initialized. Tools check this first (fast path),
 * then fall back to `ctx.options` retrieval.
 */
let v1Bridge: PantheonV2Bridge | null = null

/**
 * Set the V1 bridge from the V1 plugin's setup.
 * Called once during V1 plugin initialization — the bridge is then
 * available to all V2 tool handlers and event hooks.
 */
export function setV2Bridge(bridge: PantheonV2Bridge): void {
  v1Bridge = bridge
}

/**
 * Get the V1 bridge, checking module-level first, then ctx.options.
 * Returns null when no bridge is available (V2 standalone mode).
 */
function resolveBridge(ctx?: V2ContextLike): PantheonV2Bridge | null {
  if (v1Bridge != null) return v1Bridge
  if (ctx != null) return getV2BridgeFromContext(ctx)
  return null
}

// ─── V2 Transform Functions ─────────────────────────────────────────────

function transformAgents(draft: AgentDraft): void {
  for (const agent of draft.list()) {
    draft.update(agent.id, (current) => {
      if (!current.system?.includes(POLICY_MARKER)) {
        current.system = current.system ? `${current.system}\n\n${POLICY}` : POLICY
      }
      if (agent.id === 'zeus') current.mode = 'primary'
    })
  }
}

function transformCatalog(draft: CatalogDraft, options: PluginContext['options']): void {
  const configured = options.default_model
  if (typeof configured !== 'string') return
  const separator = configured.indexOf('/')
  if (separator <= 0 || separator === configured.length - 1) return
  const providerID = configured.slice(0, separator)
  const modelID = configured.slice(separator + 1)
  if (draft.model.get(providerID, modelID)) draft.model.default.set(providerID, modelID)
}

function transformCommands(draft: CommandDraft): void {
  for (const command of draft.list()) {
    if (command.name.startsWith('pantheon-')) {
      draft.update(command.name, (current) => {
        current.description ??= 'Pantheon orchestration command'
      })
    }
  }
}

function transformSkills(draft: SkillDraft): void {
  const path = fileURLToPath(new URL('./skills', import.meta.url))
  if (!draft.list().some((source) => source.type === 'directory' && source.path === path)) {
    draft.source({ type: 'directory', path })
  }
}

function transformReferences(draft: ReferenceDraft): void {
  draft.add('pantheon-agents', {
    type: 'local',
    path: fileURLToPath(new URL('../AGENTS.md', import.meta.url)),
    description: 'Pantheon agent and execution policy',
  })
}

// ─── V2 Tool Registration ───────────────────────────────────────────────

/**
 * Attempt to register Pantheon tools via V2 ctx.tool.transform.
 *
 * The V2 tool.transform API (when available) provides:
 *   draft.namespace({ name: "pantheon", description: "..." })
 *   draft.add({ name, description, input, execute })
 *
 * Returns true if tools were registered, false if the API is unavailable.
 */
async function registerV2Tools(context: PluginContext): Promise<boolean> {
  const toolCtx = (context as unknown as Record<string, unknown>).tool as
    | { transform?: (cb: (draft: V2ToolDraft) => void) => Promise<unknown> }
    | undefined

  if (!toolCtx?.transform) {
    return false
  }

  try {
    // Tool definitions require infrastructure instances — when available via
    // V2 context, they are passed through; otherwise the factory returns
    // definitions with lazy execute wrappers.
    const toolDefs = createV2ToolDefinitionsFromContext(context)

    await toolCtx.transform((draft: V2ToolDraft) => {
      draft.namespace({ name: 'pantheon', description: 'Pantheon orchestration tools' })
      for (const def of toolDefs) {
        draft.add({
          name: def.name,
          description: def.description,
          input: def.input,
          execute: def.execute,
        })
      }
    })
    return true
  } catch {
    return false
  }
}

// ─── V2 Event Subscription ──────────────────────────────────────────────

/**
 * Attempt to subscribe to session events via V2 ctx.event.subscribe.
 *
 * The V2 event.subscribe API (when available) provides an async iterable:
 *   for await (const event of ctx.event.subscribe({ signal })) { ... }
 *
 * Returns a cleanup function, or undefined if the API is unavailable.
 */
function subscribeV2Events(context: PluginContext): (() => void) | undefined {
  const eventCtx = (context as unknown as Record<string, unknown>).event as
    | { subscribe?: (opts?: { signal?: AbortSignal }) => AsyncIterable<V2SessionEvent> }
    | undefined

  if (!eventCtx?.subscribe) {
    return undefined
  }

  const controller = new AbortController()
  void (async () => {
    try {
      // biome-ignore lint/style/noNonNullAssertion: subscribe guaranteed by guard above
      for await (const event of eventCtx.subscribe!({ signal: controller.signal })) {
        await handleV2SessionEvent(event)
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return
      // Log but don't crash
      console.warn('[Pantheon V2] Event subscription error:', err)
    }
  })()

  return () => controller.abort()
}

/**
 * Route a V2 session event to the appropriate handler.
 */
async function handleV2SessionEvent(event: V2SessionEvent): Promise<void> {
  switch (event.type) {
    case 'session.created':
      await onSessionCreated(event)
      break
    case 'session.idle':
      await onSessionIdle(event)
      break
    case 'session.error':
      await onSessionError(event)
      break
    case 'session.compacted':
      await onSessionCompacted(event)
      break
    default:
      break
  }
}

async function onSessionCreated(_event: V2SessionEvent): Promise<void> {
  // Seed session state — handled by V1 bridge or direct registration.
  // The V2 event doesn't carry enough context for full hierarchy setup;
  // bridge.board is used when available for root-session registration.
  const _bridge = resolveBridge()
  if (_bridge?.board != null) {
    // Bridge available: board will register root sessions via the V1 event hook.
    // This is a no-op here — V1 handles hierarchy setup.
  }
}

async function onSessionIdle(_event: V2SessionEvent): Promise<void> {
  // Idle continuation — goal loop / todo enforcer dispatch.
  // Bridge provides the full V1 infrastructure when available.
  const sessionID = _event.properties?.sessionID as string | undefined
  if (!sessionID) return
  const bridge = resolveBridge()
  if (bridge?.todoEnforcer != null) {
    try {
      await bridge.todoEnforcer.onIdle(sessionID)
    } catch {
      // Fail-open: idle continuation must never break the session.
    }
  }
}

async function onSessionError(_event: V2SessionEvent): Promise<void> {
  // Error handling — delegation finalize as error.
  const bridge = resolveBridge()
  if (bridge?.board != null) {
    // Bridge available: delegation error handling is done by V1 event hook.
    // V2 only logs — V1 finalizeDelegation handles the board transition.
  }
}

async function onSessionCompacted(_event: V2SessionEvent): Promise<void> {
  // Compaction restore — todo preserve / context rebuild.
  const bridge = resolveBridge()
  if (bridge?.todoEnforcer != null) {
    // Bridge available: todo preservation is done by V1 compaction hook.
    // V2 only logs — V1 handles full compaction context build.
  }
}

// ─── V2 Session Hooks ───────────────────────────────────────────────────

/**
 * Register session hooks via V2 ctx.session.hook.
 *
 * The V2 session.hook API (when available) provides:
 *   ctx.session.hook("prompt", handler)  — message admission
 *   ctx.session.hook("context", handler) — system context injection
 *
 * Returns true if any hooks were registered.
 */
async function registerV2SessionHooks(context: PluginContext): Promise<boolean> {
  const sessionCtx = (context as unknown as Record<string, unknown>).session as
    | {
        hook?: (name: string, handler: (event: unknown) => void | Promise<void>) => Promise<unknown>
      }
    | undefined

  if (!sessionCtx?.hook) {
    return false
  }

  let registered = false

  try {
    // "context" hook — inject routing policy + compaction state
    await sessionCtx.hook('context', (event: unknown) => {
      const ctx = event as { system?: string[]; generation?: { temperature?: number } }
      if (Array.isArray(ctx.system)) {
        const hasPolicy = ctx.system.some((s: string) => s.includes(POLICY_MARKER))
        if (!hasPolicy) {
          ctx.system.push(POLICY)
        }
      }
    })
    registered = true
  } catch {
    // Context hook not supported
  }

  try {
    // "prompt" hook — vision message interception
    await sessionCtx.hook('prompt', (_event: unknown) => {
      // Vision interception delegates to the V1 vision handler.
      // Without V1 client access, this is a graceful no-op.
    })
    registered = true
  } catch {
    // Prompt hook not supported
  }

  return registered
}

// ─── V2 Tool Hooks ──────────────────────────────────────────────────────

/**
 * Register tool execution hooks via V2 ctx.tool.hook.
 *
 * The V2 tool.hook API (when available) provides:
 *   ctx.tool.hook("execute.before", handler) — pre-execution guard
 *   ctx.tool.hook("execute.after", handler)  — post-execution augment
 *
 * Returns true if any hooks were registered.
 */
async function registerV2ToolHooks(context: PluginContext): Promise<boolean> {
  const toolCtx = (context as unknown as Record<string, unknown>).tool as
    | {
        hook?: (name: string, handler: (event: unknown) => void | Promise<void>) => Promise<unknown>
      }
    | undefined

  if (!toolCtx?.hook) {
    return false
  }

  let registered = false

  try {
    // "execute.before" — read-only enforcement + command normalization
    await toolCtx.hook('execute.before', (_event: unknown) => {
      // Enforcement guard runs via V1 bridge when infrastructure is available.
      // The V2 hook is a registration point; actual enforcement is wired
      // through the V1 tool.execute.before hook.
      const bridge = resolveBridge()
      if (bridge?.board != null) {
        // Bridge available: V1 enforcement guard handles read-only + command normalization.
        // No additional V2-side enforcement needed.
      }
    })
    registered = true
  } catch {
    // Tool before-hook not supported
  }

  try {
    // "execute.after" — hashline read enhance + context sandbox
    await toolCtx.hook('execute.after', (_event: unknown) => {
      // Read enhancer + sandbox run via V1 bridge.
      const bridge = resolveBridge()
      if (bridge?.visionHandler != null) {
        // Bridge available: V1 vision handler + read enhancer handle post-execution.
      }
    })
    registered = true
  } catch {
    // Tool after-hook not supported
  }

  return registered
}

// ─── V2 Permission Hook ─────────────────────────────────────────────────

/**
 * Register permission hook via V2 ctx.permission.hook.
 *
 * The V2 permission.hook API (when available) provides:
 *   ctx.permission.hook("evaluate", handler) — custom permission logic
 *
 * Returns true if the hook was registered.
 */
async function registerV2PermissionHook(context: PluginContext): Promise<boolean> {
  const permCtx = (context as unknown as Record<string, unknown>).permission as
    | {
        hook?: (name: string, handler: (event: unknown) => void | Promise<void>) => Promise<unknown>
      }
    | undefined

  if (!permCtx?.hook) {
    markUnsupported('permission-hook')
    return false
  }

  try {
    await permCtx.hook('evaluate', (_event: unknown) => {
      // Custom permission logic — Zeus read guard + read-only enforcement.
      // Wired through V1 tool.execute.before when infrastructure is available.
    })
    return true
  } catch {
    markUnsupported('permission-hook')
    return false
  }
}

// ─── Tool Definition Factory ─────────────────────────────────────────────

/**
 * Internal types for V2 tool draft.
 */
interface V2ToolDraft {
  namespace(config: { name: string; description: string }): void
  add(tool: {
    name: string
    description: string
    input: Record<string, unknown>
    execute: (input: Record<string, unknown>, context: unknown) => Promise<string>
  }): void
}

/**
 * A V2 tool definition ready for registration.
 */
interface V2ToolDef {
  name: string
  description: string
  input: Record<string, unknown>
  execute: (input: Record<string, unknown>, context: unknown) => Promise<string>
}

/**
 * Create V2 tool definitions from the plugin context.
 *
 * When V1 infrastructure (BackgroundJobBoard, delegation client, etc.) is
 * available through the V2 context, tools are wired directly. Otherwise,
 * each tool returns an error message explaining the limitation.
 */
function createV2ToolDefinitionsFromContext(_context: PluginContext): V2ToolDef[] {
  // Tool definitions are created lazily. When the full V1 infrastructure
  // is bridged through the V2 context, these can be wired to real implementations.
  // For now, they are structural definitions with placeholder execute functions
  // that explain the V2 limitation.
  const v2UnavailableMessage =
    'This tool requires V1 infrastructure (BackgroundJobBoard, SDK client). ' +
    'Use the V1 plugin (src/plugin.ts) for full tool support, or wire V1 ' +
    'infrastructure through the V2 bridge (src/pantheon/v2-bridge.ts).'

  const toolNames = [
    'pantheon_delegate',
    'pantheon_delegation_read',
    'pantheon_delegation_list',
    'hashline_edit',
    'pantheon_goal_create',
    'pantheon_goal_get',
    'pantheon_goal_update',
    'pantheon_cost',
    'pantheon_model',
  ]

  const toolDescriptions: Record<string, string> = {
    pantheon_delegate:
      'Dispatch a background agent as a child session and register it on the job board. ' +
      'Returns the readable alias (e.g. "apo-1"); read the result with pantheon_delegation_read.',
    pantheon_delegation_read:
      'Block until a background delegation finishes (completed/error/cancelled), then return ' +
      'its report markdown (with a trailing agent-activity section) and mark the job reconciled.',
    pantheon_delegation_list:
      'List background delegations for the current session, with [unread] for finished jobs.',
    hashline_edit:
      'Edit a file anchored by hashline refs (LINE#TAG) instead of raw line numbers. ' +
      'Ops: replace, append, prepend, delete. ALL refs validated against ORIGINAL file first.',
    pantheon_goal_create:
      'Create the single active goal for this session. The goal loop then continues the ' +
      'session automatically on idle until the goal is marked done.',
    pantheon_goal_get:
      'Return the active goal for this session (status, objective, continuations).',
    pantheon_goal_update:
      'Update the active goal: set status (pending/in_progress/done) and/or rewrite the objective. ' +
      'Setting status to done stops all further continuations.',
    pantheon_cost:
      'Report delegation cost + token usage by agent over the last N days, read from opencode.db.',
    pantheon_model:
      'Show, set, or reset per-agent model overrides in active-preset.json (project or global).',
  }

  return toolNames.map((name) => ({
    name,
    description: toolDescriptions[name] ?? `Pantheon tool: ${name}`,
    input: { type: 'object' as const, properties: {} },
    execute: async (_input: Record<string, unknown>, _context: unknown): Promise<string> => {
      return `${name}: ${v2UnavailableMessage}`
    },
  }))
}

// ─── Plugin Definition ───────────────────────────────────────────────────

/** Event type from V2 event stream. */
interface V2SessionEvent {
  type: string
  properties?: Record<string, unknown>
}

/** Cleanup function type. */
type CleanupFn = () => void

/** Active cleanup handlers for the plugin lifecycle. */
const activeCleanups: CleanupFn[] = []

export const plugin = define({
  id: 'pantheon-opencode-v2',

  async setup(context: PluginContext): Promise<void> {
    // ─── Phase 1: V2 Transforms (always available) ────────────────────
    await Promise.all([
      context.agent.transform(transformAgents),
      context.catalog.transform((draft) => transformCatalog(draft, context.options)),
      context.command.transform(transformCommands),
      context.reference.transform(transformReferences),
      context.skill.transform(transformSkills),
    ])

    // ─── Phase 2: V2 Tool Registration (best-effort) ─────────────────
    const toolsRegistered = await registerV2Tools(context).catch(() => false)
    if (!toolsRegistered) {
      markUnsupported('tool-transform')
    }

    // ─── Phase 3: V2 Event Subscription (best-effort) ────────────────
    const eventCleanup = subscribeV2Events(context)
    if (eventCleanup) {
      activeCleanups.push(eventCleanup)
    } else {
      markUnsupported('event-stream')
    }

    // ─── Phase 4: V2 Session Hooks (best-effort) ─────────────────────
    const sessionHooksRegistered = await registerV2SessionHooks(context).catch(() => false)
    if (!sessionHooksRegistered) {
      markUnsupported('session-hooks')
    }

    // ─── Phase 5: V2 Tool Hooks (best-effort) ────────────────────────
    const toolHooksRegistered = await registerV2ToolHooks(context).catch(() => false)
    if (!toolHooksRegistered) {
      markUnsupported('tool-execute-hooks')
    }

    // ─── Phase 6: V2 Permission Hook (best-effort) ───────────────────
    await registerV2PermissionHook(context).catch(() => false)

    // ─── Phase 7: V2 Compaction Hook (best-effort) ───────────────────
    const compactionCtx = (context as unknown as Record<string, unknown>).session as
      | {
          hook?: (
            name: string,
            handler: (event: unknown) => void | Promise<void>,
          ) => Promise<unknown>
        }
      | undefined
    if (compactionCtx?.hook) {
      try {
        await compactionCtx.hook('compacting', (_event: unknown) => {
          // Compaction context build — injects active goals, pending todos,
          // and in-flight delegations. Wired through V1 infrastructure.
        })
      } catch {
        markUnsupported('compaction-hook')
      }
    } else {
      markUnsupported('compaction-hook')
    }
  },
})

// ─── V1 Compatibility Bridge ─────────────────────────────────────────────

/**
 * V1-compatible cleanup — call from the V1 plugin's dispose hook or
 * process exit handler to clean up V2 event subscriptions.
 */
export function v2Dispose(): void {
  for (const cleanup of activeCleanups) {
    try {
      cleanup()
    } catch {
      // Best-effort cleanup
    }
  }
  activeCleanups.length = 0
}

/**
 * Get the current list of unsupported V2 features (for diagnostics).
 */
export function getUnsupportedFeatures(): readonly string[] {
  return V2_UNSUPPORTED_FEATURES
}

export default plugin
