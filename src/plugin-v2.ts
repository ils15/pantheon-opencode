/**
 * Pantheon V2 Plugin — full orchestration plugin for OpenCode V2.
 *
 * Registers:
 * - 3 unconditional self-sufficient tools via V2 tool.transform (hashline_edit,
 *   pantheon_cost, pantheon_model) plus up to 2 host-dependent ones: native
 *   `vision_describe` when the host exposes the V2 model catalog (it resolves
 *   OpenCode Zen auth and sends images directly to the selected multimodal
 *   model), and `pantheon_bounded_read` when the host exposes its permission
 *   and session APIs (root Zeus sessions only).
 *   The goal tools need V1 infrastructure and are absent from this surface.
 * - 5 event subscriptions (session.created, idle, deleted, error, compacted)
 * - Session hooks (prompt, context, compaction)
 * - A tool `execute.before` hook that ENFORCES read-only sessions: the agent
 *   arrives on the host's event, a read-only agent (apollo/gaia) registers its
 *   session, and the shared `createEnforcementGuard` throws to deny
 *   `hashline_edit` / `pantheon_model` / `edit` / `write` / `bash` / `task`.
 *   See `registerV2ToolHooks`.
 * - The SAME `execute.before` hook runs scripts/hooks/scan-secrets.sh over the
 *   tool input and throws on exit 2 (high-confidence token match). This is the
 *   ONLY hard security block on the V2 surface. It is wired HERE, not delegated
 *   to `src/plugins/pantheon-hooks.ts`: opencode.json declares only
 *   `src/plugin-v2` in `plugins`, so the V1 plugin never loads on a V2-only
 *   install and V1's identical block was inert by construction.

 * - A tool `execute.after` hook and a permission hook, with permission
 *   evaluation enforcing the caller/target matrix for Pantheon agents
 *
 * Every tool registered through `draft.add` MUST declare `output`, and its
 * `execute` MUST resolve to a value carrying `output`. The host enforces the
 * two as a pair — see `V2ToolDraft` for the exact contract.
 *
 * ## The host domains the SDK types do not carry
 *
 * `@opencode-ai/plugin` 1.18.33 types `PluginContext` as exactly:
 *   options · agent · aisdk · catalog · command · integration · plugin ·
 *   reference · skill
 * — no `tool`, `event`, `permission` or `session`. The pin does not carry
 * them, and the `latest` release (`1.19.4`, 2026-10-22) restructures the
 * package instead of typing them, so following the newest SDK release does
 * not resolve this: it is a STRUCTURAL DECLARATION task, not a pin
 * reconciliation.
 *
 * A live opencode 2.0.22+ host DOES have these domains, with the shapes this module
 * uses. Measured by `tests/canary/plugin-v2-tool-canary.test.mjs`, which loads
 * this file through the real loader and records `Object.keys(ctx)` from inside
 * the host:
 *
 *   agent aisdk app command event experimental generate integration location
 *   mcp model options permission plugin provider reference rpc session shell
 *   skill storage tool vcs websearch worktree
 *
 *   ctx.tool.transform        function
 *   ctx.tool.hook             function
 *   ctx.tool.list             function
 *   ctx.event.subscribe       function
 *   ctx.permission.hook       function
 *   ctx.session.hook          function
 *   ctx.catalog               absent
 *
 * `HostPluginContext` below declares exactly the minimum of that, and
 * `hostDomains` is the SINGLE documented cast that reaches them — replacing the
 * six repeated `as unknown as Record<string, unknown>` casts this file carried
 * (Phases 2, 3, 4, 5, 6 and 7 — every phase except Phase 1, which reads the
 * SDK-typed domains directly), each of which type-checked nothing at all. The
 * per-domain definition checks stay: `registerV2Tools` still returns `false`
 * and marks `tool-transform` when `ctx.tool.transform` is missing, and likewise
 * for the others. The cast is not a licence to assume: the canary above is what
 * proves the domains exist on a real host, and it fails if they stop existing.
 *
 * If the SDK ever exposes these host domains, replacing `hostDomains` with the real
 * type is a one-line change. Do NOT make that change while 1.18.x lacks them.
 *
 * V2_UNSUPPORTED_FEATURES distinguishes adapter limitations from observed
 * host-absent APIs; setup handles optional registrations on a best-effort basis.
 *
 * @module plugin-v2
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { realpath as realpathAsync } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AgentDraft,
  CommandDraft,
  PluginContext,
  ReferenceDraft,
} from '@opencode-ai/plugin/v2/promise'
import { define } from '@opencode-ai/plugin/v2/promise'
import { buildCompactionContext } from './pantheon/compaction-context.ts'
import {
  CONTEXT_PRUNER_CONFIG_KEYS,
  describeContextPrunerConfigIssues,
  type PruneSite,
  type PruneStats,
  pruneMessages,
  resolveContextPrunerConfig,
} from './pantheon/context-pruner.ts'
import {
  createEnforcementGuard,
  normalizeDelegationAgent,
  readOnlyRegistry,
  syncReadOnlySession,
  type ToolExecuteBeforeInput,
  type ToolExecuteBeforeOutput,
  zeusReadGuard,
} from './pantheon/delegation-enforce.ts'
import { GOAL_LOOP_DEFAULTS, GoalStore } from './pantheon/goal-loop.ts'
import {
  applyMemoryInjection,
  MemoryInjectionCache,
  resolveMemoryInjectionConfig,
  warnInvalidMemoryInjectionConfig,
} from './pantheon/memory-context.ts'
import { getSharedBoard } from './pantheon/shared-board.ts'
import {
  TODO_ENFORCER_DEFAULTS,
  TodoEnforcer,
  type TodoEnforcerChild,
  type TodoEnforcerClient,
  type TodoEnforcerMessage,
  type TodoLike,
  todoEnforcerEnabledFromEnv,
} from './pantheon/todo-enforcer.ts'
import {
  BOUNDED_READ_TOOL,
  createV2BoundedReadTool,
  type V2BoundedReadOriginRegistry,
} from './pantheon/v2-bounded-read.ts'
import {
  createV2Bridge,
  getRegisteredV2Bridge,
  getV2BridgeFromContext,
  injectBridge,
  type PantheonV2Bridge,
  registerV2Bridge,
  type V2ContextLike,
} from './pantheon/v2-bridge.ts'
import {
  type AuthoritativeSession,
  evaluateV2Delegation,
  PANTHEON_AGENTS,
  type V2PermissionEvent,
  V2SubagentOriginRegistry,
  v2ResourceTarget,
} from './pantheon/v2-delegation-enforce.ts'
import { createV2ExecuteAfter, resolveV2SandboxConfig } from './pantheon/v2-execute-after.ts'
import { applyV2ModelOverrides, readV2ModelConfiguration } from './pantheon/v2-model-overrides.ts'
import { createV2ShellHooks, type V2ShellRunner } from './pantheon/v2-shell-hooks.ts'
import { createV2ToolDefinitions, type V2ToolResult } from './pantheon/v2-tools.ts'
import { V2_UNSUPPORTED_FEATURE_SEED } from './pantheon/v2-unsupported.mjs'
import { buildV2VisionPromptContext, type V2VisionRuntime } from './pantheon/v2-vision.ts'
import { sanitizeVisionHistory } from './pantheon/vision.ts'
import { type HookPayload, type HookResult, runHook } from './plugins/hook-runner.ts'

// ─── Unsupported Features Registry ───────────────────────────────────────

/**
 * Features not implemented by the current Pantheon V2 adapter or absent from
 * the observed host. A listed feature is not necessarily a host-absent API.
 * Additional features are appended during setup when a required API is missing.
 */
/**
 * Live unsupported-feature list: the shared seed plus anything `markUnsupported`
 * appends while this process talks to a real host.
 *
 * The seed lives in `src/pantheon/v2-unsupported.mjs` — a plain-`.mjs` module —
 * so that the V2 installer and `scripts/doctor.mjs` report the SAME strings
 * without either of them having to import TypeScript. This array stays a
 * mutable copy rather than the shared seed itself: `markUnsupported` appends to
 * it, and the seed must stay frozen. `getUnsupportedFeatures()` still returns
 * this exact reference.
 */
export const V2_UNSUPPORTED_FEATURES: string[] = [...V2_UNSUPPORTED_FEATURE_SEED]

// ─── Constants ───────────────────────────────────────────────────────────

const POLICY_MARKER = '<!-- pantheon-v2-policy -->'
const POLICY = `${POLICY_MARKER}\nFollow Pantheon routing policy: delegate implementation work to the named specialist and do not claim work was performed without verification.`

/** 2.0.16 `system` on a session hook payload is `Array<SystemPart>`. */
interface SystemPart {
  type: 'text'
  text: string
}

function isTextPart(entry: unknown): entry is SystemPart {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof (entry as { text?: unknown }).text === 'string'
  )
}

/**
 * Extract text from a `system` entry. The host's own coercion accepts a bare
 * string, but the canonical 2.0.16 shape is `{ type: 'text', text }`; the
 * string branch is retained so the handler still works against a host that
 * sends primitives. Never throws.
 */
function systemEntryText(entry: unknown): string | null {
  try {
    if (typeof entry === 'string') return entry
    if (isTextPart(entry)) return entry.text
    return null
  } catch {
    return null
  }
}

function hasPolicyMarker(arr: unknown[]): boolean {
  try {
    return arr.some((s) => {
      const t = systemEntryText(s)
      return t?.includes(POLICY_MARKER) ?? false
    })
  } catch {
    return false
  }
}

/**
 * Normalize a `system` value to the 2.0.16 `Array<SystemPart>` shape.
 *
 * `SessionContext.system` is `Array<SystemPart>` where a part is
 * `{ type: 'text', text }`. A raw string (the whole value, or an element) is
 * not that shape, so it is upgraded: element strings become parts, and a bare
 * string value becomes a one-element part array. Non-array, non-string values
 * are returned unchanged.
 *
 * Returns the normalized array, or `null` when `system` is neither a string
 * nor an array (nothing to normalize).
 */
function normalizeSystemToParts(system: unknown): unknown[] | null {
  if (typeof system === 'string') {
    return [{ type: 'text', text: system } satisfies SystemPart]
  }
  if (!Array.isArray(system)) return null
  for (let i = 0; i < system.length; i++) {
    const entry = system[i]
    if (typeof entry === 'string') {
      system[i] = { type: 'text', text: entry } satisfies SystemPart
    }
  }
  return system
}

/** Set once, so a payload without a `system` channel warns once per process. */
let compactionChannelWarned = false

/** Set once, so a failed bridge construction logs one line per process. */
let bridgeFailureLogged = false

/**
 * Append text blocks to a hook payload's `system` channel.
 *
 * Returns `false` when the payload carries no usable channel (absent, or a
 * shape that is neither string nor array) — the caller decides whether that is
 * worth a diagnostic. A bare-string `system` is replaced by its part array on
 * the payload itself, because the host reads the property, not our copy.
 *
 * Used by the V2 compaction hook (#266) to inject the compaction context
 * blocks V1 pushes into `output.context`.
 */
function appendSystemBlocks(
  target: { system?: unknown } | null | undefined,
  blocks: readonly string[],
): boolean {
  if (target == null || blocks.length === 0) return false
  const normalized = normalizeSystemToParts(target.system)
  if (normalized == null) return false
  if (typeof target.system === 'string') target.system = normalized
  for (const block of blocks) normalized.push({ type: 'text', text: block } satisfies SystemPart)
  return true
}

/**
 * Add a feature to the unsupported list (idempotent).
 */
function markUnsupported(feature: string): void {
  if (!V2_UNSUPPORTED_FEATURES.includes(feature)) {
    V2_UNSUPPORTED_FEATURES.push(feature)
  }
}

// ─── Host context domains the SDK types do not carry ────────────────────

/**
 * The minimal shape of `ctx.tool` this module uses, as a live opencode 2.0.22
 * host provides it. `transform` registers the Pantheon tools, `hook` installs
 * the `execute.before`/`execute.after` guards, `list` is the host-built
 * descriptor dump the canary asserts on.
 */
interface V2ToolDomain {
  transform?: (cb: (draft: V2ToolDraft) => void) => Promise<unknown>
  hook?: (name: string, handler: (event: unknown) => void | Promise<void>) => Promise<unknown>
  list?: () => Promise<unknown>
}

/** The minimal shape of `ctx.event`: one async-iterable subscription. */
interface V2EventDomain {
  subscribe?: (opts?: { signal?: AbortSignal }) => AsyncIterable<V2SessionEvent>
}

/**
 * The minimal shape of `ctx.permission`.
 *
 * The V2.0.25 live contract supplies an `evaluate` event with `resources`;
 * runtime validation remains defensive because SDK declarations omit this
 * domain and the host may evolve independently.
 */
interface V2PermissionDomain {
  assert?: (input: Record<string, unknown>) => Promise<unknown>
  hook?: (
    name: string,
    handler: (event: unknown, output?: unknown) => void | Promise<void>,
  ) => Promise<unknown>
}

/**
 * The minimal shape of `ctx.session` used by this module. `get` follows the V2
 * Promise API's object input (`{ sessionID }`); session hooks accept any string
 * and silently drop an unknown one, which is why the host-backed hook canary
 * exists.
 */
interface V2SessionDomain {
  hook?: (name: string, handler: (event: unknown) => void | Promise<void>) => Promise<unknown>
  get?: (input: { sessionID: string }) => Promise<unknown>
}

interface V2LocationDomain {
  directory?: string
  project?: { id?: string }
}

interface V2ModelDomain {
  list?: V2VisionRuntime['model']['list']
}

interface V2GenerateDomain {
  text?: (input: { model: { providerID: string; id: string }; prompt: string }) => Promise<unknown>
}

/** `PluginContext` plus the host domains 1.18.x omits. See the module header. */
interface HostPluginContext extends PluginContext {
  tool?: V2ToolDomain
  event?: V2EventDomain
  permission?: V2PermissionDomain
  session?: V2SessionDomain
  model?: V2ModelDomain
  generate?: V2GenerateDomain
  location?: V2LocationDomain
}

/**
 * THE cast to the host's context. Every optional member stays optional and every
 * caller re-checks before use, so this narrows nothing away: it replaces five
 * anonymous `Record<string, unknown>` casts with one named, documented,
 * type-checked boundary.
 *
 * When the SDK ships these four domains, delete this function and use
 * `PluginContext` directly.
 */
function hostDomains(context: PluginContext): HostPluginContext {
  return context as HostPluginContext
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
  // Also publish process-wide so a V1 load that registers FIRST and a V2 load
  // that resolves SECOND converge on one bridge (see v2-bridge.ts).
  registerV2Bridge(bridge)
}

/**
 * Get the V1 bridge, checking module-level first, then the process-wide
 * registration, then ctx.options.
 * Returns null when no bridge is available (V2 standalone mode).
 */
function resolveBridge(ctx?: V2ContextLike): PantheonV2Bridge | null {
  if (v1Bridge != null) return v1Bridge
  const registered = getRegisteredV2Bridge()
  if (registered != null) {
    v1Bridge = registered
    return registered
  }
  if (ctx != null) return getV2BridgeFromContext(ctx)
  return null
}

/**
 * The subset of the host's `session` domain a `TodoEnforcerClient` needs.
 *
 * Declared structurally and checked at runtime instead of being added to
 * {@link V2SessionDomain} on faith: the measured 2.1.4 host exposes
 * `hook`/`get`/`list`/`create`/`remove`/`prompt`/`generate`/`interrupt` on that
 * domain. Its `prompt` takes `{ sessionID, text }` and is a DIFFERENT call from
 * V1's `promptAsync({ path, body: { agent?, model?, parts } })` — the enforcer's
 * agent/model inheritance has no V2 counterpart — and whether it exposes
 * `todo`/`messages`/`children` at all is not measured by the repository. The
 * check below therefore requires the V1 shape exactly: a client built on a
 * method that is absent (or on a same-named method with a different contract)
 * would throw inside the enforcer's fail-open guards and leave idle
 * continuation silently dead again — the exact defect this wiring closes.
 */
interface V2TodoSessionMethods {
  todo?: (input: { path: { id: string } }) => Promise<unknown>
  messages?: (input: { path: { id: string } }) => Promise<unknown>
  children?: (input: { path: { id: string } }) => Promise<unknown>
  promptAsync?: (input: { path: { id: string }; body: Record<string, unknown> }) => Promise<unknown>
}

const V2_TODO_CLIENT_METHODS = ['todo', 'messages', 'children', 'promptAsync'] as const

/**
 * Adapt the host's `session` domain to the {@link TodoEnforcerClient} the V1
 * enforcer instance expects, or `undefined` when the domain does not carry the
 * four methods. The input shape is V1's (`{ path: { id } }`) because the
 * enforcer is the V1 instance — this is an adapter, not a second enforcer.
 */
function createV2TodoEnforcerClient(
  session: V2SessionDomain | undefined,
): TodoEnforcerClient | undefined {
  if (session === undefined) return undefined
  const methods = session as V2TodoSessionMethods
  for (const method of V2_TODO_CLIENT_METHODS) {
    if (typeof methods[method] !== 'function') return undefined
  }
  // Every method is present: the guard above is the only place absence is
  // tolerated, so the assertions below cannot fire at runtime.
  const todo = methods.todo as NonNullable<V2TodoSessionMethods['todo']>
  const messages = methods.messages as NonNullable<V2TodoSessionMethods['messages']>
  const children = methods.children as NonNullable<V2TodoSessionMethods['children']>
  const promptAsync = methods.promptAsync as NonNullable<V2TodoSessionMethods['promptAsync']>
  return {
    session: {
      todo: (input) => todo.call(session, input) as Promise<TodoLike[]>,
      messages: (input) => messages.call(session, input) as Promise<TodoEnforcerMessage[]>,
      children: (input) => children.call(session, input) as Promise<TodoEnforcerChild[]>,
      promptAsync: (input) => promptAsync.call(session, input),
    },
  }
}

/**
 * Construct the V1→V2 bridge IN the V2 entry and publish it on both channels
 * (issue #265).
 *
 * Before this, `setV2Bridge`/`injectBridge`/`createV2Bridge` had no production
 * caller: `resolveBridge()` always returned null, so `onSessionIdle` reached a
 * null enforcer and idle continuation never ran on any V2 install — including
 * the V1+V2 co-load, because nothing had ever put a bridge in `ctx.options`
 * either.
 *
 * What is genuinely constructible without a V1 `PluginInput`:
 *
 *   - `board` — a process-wide singleton (`getSharedBoard`), the same instance
 *     V1 and the hooks plugin use.
 *   - `todoEnforcer` — the V1 class, fed by an adapter over the host's session
 *     domain. Present only when that domain exposes the four methods the
 *     enforcer uses; otherwise the reduction is marked (`idle-todo-enforcer`)
 *     and, because the marker is one a migrating user must be told about, it
 *     is also part of the static seed.
 *
 * Files in the bridge that need a V1 `client` (goal loop, vision handler) stay
 * out: `goal-tools` already declares the goal surface absent, and the vision
 * handler is V1-only.
 */
function installV2Bridge(context: PluginContext): TodoEnforcer | undefined {
  // Co-load guard (#265 review): a bridge with an enforcer may already exist —
  // registered by V1 in this process, or by an earlier V2 setup. Building a
  // second enforcer would answer the same `session.idle` twice (V1's dispatcher
  // and this plugin each inject a continuation prompt). Reuse, never overwrite.
  const existing = resolveBridge(context)
  if (existing?.todoEnforcer !== undefined) {
    injectBridge(context, existing)
    return existing.todoEnforcer
  }

  const todoClient = createV2TodoEnforcerClient(hostDomains(context).session)
  if (todoClient === undefined) markUnsupported('idle-todo-enforcer')
  const board = getSharedBoard()
  const todoEnforcer =
    todoClient === undefined
      ? undefined
      : new TodoEnforcer({
          client: todoClient,
          board,
          options: { ...TODO_ENFORCER_DEFAULTS, enabled: todoEnforcerEnabledFromEnv() },
        })
  const bridge = createV2Bridge({ board, ...(todoEnforcer === undefined ? {} : { todoEnforcer }) })
  // Two channels, both needed: `ctx.options` is what a handler holding the
  // context reads (`resolveBridge(ctx)`), and the module-level reference is
  // what the event handlers use, since they receive no context.
  injectBridge(context, bridge)
  setV2Bridge(bridge)
  // Returned so the compaction hook can list the session's PENDING TODOS with
  // the same instance — the `<todo_context>` half of V1's compaction blocks
  // needs exactly `listPendingTodos`, and the host exposes no todo listing of
  // its own.
  return todoEnforcer
}

// ─── V2 Transform Functions ─────────────────────────────────────────────

function transformAgents(draft: AgentDraft): void {
  // Beta 19192 guard (issue #92): draft may not have `list`, or list()
  // may return a non-iterable. Never throw — mark unsupported and return.
  let agents: Iterable<{ id: string }>
  try {
    const maybeList = (draft as unknown as { list?: unknown }).list
    if (typeof maybeList !== 'function') {
      markUnsupported('agent-transform-list')
      return
    }
    const result = (maybeList as (this: unknown) => unknown).call(draft)
    if (
      result == null ||
      typeof (result as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function'
    ) {
      markUnsupported('agent-transform-list')
      return
    }
    agents = result as Iterable<{ id: string }>
  } catch {
    markUnsupported('agent-transform-list')
    return
  }
  try {
    const modelConfiguration = readV2ModelConfiguration()
    if (modelConfiguration.warnings.length > 0) {
      // The V2 server PluginContext has no documented user-visible notification
      // or logging channel; preserve the degradation for status diagnostics.
      markUnsupported('agent-model-overrides')
    }
    applyV2ModelOverrides(draft, modelConfiguration.overrides)
  } catch {
    // Model configuration is optional. Preserve host models if it cannot be read.
    markUnsupported('agent-model-overrides')
  }
  try {
    for (const agent of agents) {
      draft.update(agent.id, (current) => {
        // Beta 19192 hardening + SystemPart SKIP: `system` may be a non-string
        // (host shape drift, e.g. object). `?.` covers only null/undefined, not
        // wrong types — guard with typeof. String path preserved; empty/absent
        // degrades to POLICY; truthy non-string OBJECT is SKIPPED (preserve host
        // shape, avoid schema validation failure). Other primitives degrade to
        // POLICY. Never throw.
        try {
          const sys: unknown = (current as { system?: unknown }).system
          if (typeof sys === 'string' && sys.includes(POLICY_MARKER)) {
            // Policy already present — nothing to do.
          } else if (typeof sys === 'string' && sys) {
            current.system = `${sys}\n\n${POLICY}`
          } else if (sys == null || sys === '') {
            current.system = POLICY
          } else if (typeof sys === 'object') {
            // Host object shape (e.g. SystemPart): SKIP instead of overwriting.
          } else {
            current.system = POLICY
          }
        } catch {
          // Fail-open: leave agent untouched on unexpected shape.
        }
        if (agent.id === 'zeus') current.mode = 'primary'
      })
    }
  } catch {
    markUnsupported('agent-transform')
  }
}

function transformCommands(draft: CommandDraft): void {
  // Beta 19192 guard (issue #92): draft may not have `list`, or list()
  // may return a non-iterable. Never throw — mark unsupported and return.
  let commands: Iterable<{ name: string }>
  try {
    const maybeList = (draft as unknown as { list?: unknown }).list
    if (typeof maybeList !== 'function') {
      markUnsupported('command-transform-list')
      return
    }
    const result = (maybeList as (this: unknown) => unknown).call(draft)
    if (
      result == null ||
      typeof (result as { [Symbol.iterator]?: unknown })[Symbol.iterator] !== 'function'
    ) {
      markUnsupported('command-transform-list')
      return
    }
    commands = result as Iterable<{ name: string }>
  } catch {
    markUnsupported('command-transform-list')
    return
  }
  try {
    for (const command of commands) {
      if (command.name.startsWith('pantheon-')) {
        draft.update(command.name, (current) => {
          current.description ??= 'Pantheon orchestration command'
        })
      }
    }
  } catch {
    markUnsupported('command-transform')
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
 *   draft.add({ name, description, input, output, execute })
 *
 * `output` is part of the required shape, not an optional extra: see
 * `V2ToolDraft` for the host contract that makes it mandatory.
 *
 * Returns true if tools were registered, false if the API is unavailable.
 */
async function registerV2Tools(
  context: PluginContext,
  boundedRead?: ReturnType<typeof createV2BoundedReadTool>['definition'],
): Promise<boolean> {
  const host = hostDomains(context)
  const toolCtx = host.tool

  if (!toolCtx?.transform) {
    return false
  }

  try {
    // Tool definitions carry their own `output` declaration; the draft requires
    // it, and the host rejects a definition whose result shape cannot satisfy
    // the declaration it makes.
    const model = host.model
    const visionReady = typeof model?.list === 'function'
    if (!visionReady) markUnsupported('vision-tool')
    const visionRuntime = visionReady ? ({ model } as V2VisionRuntime) : undefined
    const toolDefs = createV2ToolDefinitions(visionRuntime)
    if (boundedRead !== undefined) toolDefs.push(boundedRead)

    await toolCtx.transform((draft: V2ToolDraft) => {
      // Catalog grouping only. The host computes a tool's registration id as
      // `options.namespace === undefined ? name : `${namespace}_${name}``, and
      // `draft.namespace()` does NOT set `options.namespace` on later `add`
      // calls — so the tools stay `hashline_edit` / `pantheon_cost` /
      // `pantheon_model`, not `pantheon_*`. That bare name is what the
      // enforcement guard's blocked-tool list matches on; see
      // `adaptV2ExecuteBeforeEvent`.
      draft.namespace({ name: 'pantheon', description: 'Pantheon orchestration tools' })
      for (const def of toolDefs) {
        draft.add({
          name: def.name,
          description: def.description,
          input: def.input,
          // Required by the host contract: without this the tool fails on
          // every call with "Tool result declared output without an output
          // schema". Must stay paired with def.execute resolving to `output`.
          output: def.output,
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
function subscribeV2Events(
  context: PluginContext,
  onTurnEnd?: (sessionID: string) => void,
): (() => void) | undefined {
  const eventCtx = hostDomains(context).event

  if (!eventCtx?.subscribe) {
    return undefined
  }

  const controller = new AbortController()
  void (async () => {
    try {
      // biome-ignore lint/style/noNonNullAssertion: subscribe guaranteed by guard above
      for await (const event of eventCtx.subscribe!({ signal: controller.signal })) {
        await handleV2SessionEvent(event)
        if (event.type === 'session.idle' || event.type === 'session.deleted') {
          const properties = event.properties ?? {}
          const info = properties.info
          const infoID =
            info !== null && typeof info === 'object' ? (info as { id?: unknown }).id : undefined
          const sessionID =
            typeof properties.sessionID === 'string'
              ? properties.sessionID
              : typeof infoID === 'string'
                ? infoID
                : undefined
          if (sessionID) onTurnEnd?.(sessionID)
        }
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
    case 'session.deleted':
      await onSessionDeleted(event)
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

/**
 * Record the v2.0.29 lifecycle event in the opt-in F4A canary. Runtime events
 * use a `{ id, created, type, data }` envelope; the child data carries
 * `sessionID`, `parentID` and `agent`. Admission itself does not depend on this
 * subscription: it checks the current permission source and `ctx.session.get`
 * synchronously, so resumed roots and children use the same path.
 */
async function onSessionCreated(event: V2SessionEvent): Promise<void> {
  const payload = event as V2SessionEvent & Record<string, unknown>
  const properties = event.properties ?? {}
  const data =
    event.data !== null && typeof event.data === 'object'
      ? (event.data as Record<string, unknown>)
      : {}
  const info = properties.info ?? data.info
  const sessionInfo =
    info !== null && typeof info === 'object' ? (info as Record<string, unknown>) : {}
  writeV2AdmissionProof('session.created', {
    eventKeys: Object.keys(payload),
    propertyKeys: Object.keys(properties),
    dataKeys: Object.keys(data),
    infoKeys: Object.keys(sessionInfo),
    id:
      sessionInfo.id ??
      sessionInfo.sessionID ??
      data.id ??
      data.sessionID ??
      properties.id ??
      properties.sessionID ??
      payload.sessionID ??
      null,
    parentID: sessionInfo.parentID ?? data.parentID ?? properties.parentID ?? null,
    agent: sessionInfo.agent ?? data.agent ?? properties.agent ?? null,
  })
  const _bridge = resolveBridge()
  if (_bridge?.board != null) {
    // Bridge present ⇒ this process also loaded V1, whose own event hook owns
    // root-session registration. Intentionally nothing to do on the V2 side.
  }
}

async function onSessionIdle(_event: V2SessionEvent): Promise<void> {
  // Temp-image sweep on the V2-only path: DELIBERATELY DEFERRED.
  //
  // V1 unlinks a session's temp images on `session.idle`/`session.deleted`
  // (`cleanupSessionTempImages`, grace-guarded and refcounted). V2 cannot reuse
  // it: `saveDataUrlImageSync` (the V2 materialization path) receives no session
  // id, so there is no per-session `path → createdAt` map to sweep, and the
  // content-hash temp dir is refcounted ONLY on the V1 path. The one reusable
  // piece, `enforceTempFileCap`, is already invoked off every V2 save
  // (`saveDataUrlImageSync`), so disk usage is bounded without an idle pass —
  // re-running it here would be redundant, and a GLOBAL age-based unlink fired
  // by one session's idle could delete a file another live session still
  // references. Delivery is also best-effort: with no `ctx.event.subscribe`
  // the stream is unsupported (`markUnsupported('event-stream')`) and no idle
  // ever arrives. Implementing this safely needs V2-side session threading
  // first; until then it stays deferred rather than approximated.
  //
  // Idle continuation — goal loop / todo enforcer dispatch. The bridge is
  // constructed by THIS module in `installV2Bridge` (Phase 0) and holds the
  // V1 TodoEnforcer instance when the host's session domain exposes the
  // methods the enforcer uses. Before issue #265 nothing injected a bridge on
  // the V2 path, so this call was a guaranteed no-op on every install.
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

/**
 * Session-deleted handler: drop the read-only registration.
 *
 * `readOnlyRegistry` is a process-wide singleton and the `execute.before` hook
 * populates it on every delegated `apollo`/`gaia` call. V1 prunes it on
 * `session.deleted` (`src/plugin.ts`); V2 did not, so on a long-lived host
 * every finished investigation session stayed registered for the life of the
 * process — a slow leak, and a stale entry that would keep denying tools if
 * the id were ever reused.
 *
 * This mirrors V1: unregister the session, which drops its agent entry with it
 * (the registry stores one `ReadOnlyEntry` per session id). V1 also clears a
 * `sessionAgents` map here; V2 has no such map and needs no equivalent, since
 * it reads the active agent off the event instead of caching it.
 *
 * The id is read from `properties.sessionID` — the field the sibling
 * `session.idle` handler already uses — falling back to V1's
 * `properties.info.id`. Both spellings are accepted because the V2 SDK types
 * `session.deleted` as `{ sessionID, info }` and a miss here is a silent leak,
 * which is precisely the bug this handler exists to close.
 *
 * A payload with NEITHER spelling is fail-open, and unavoidably so: unregistering
 * is what needs the id, so an id that cannot be resolved cannot be cleaned up
 * and the entry survives. The docstring used to leave that as a documented
 * silent branch; it now warns on the way out, because the only other symptom of
 * a renamed field is a registry that grows for the life of the process.
 */
async function onSessionDeleted(event: V2SessionEvent): Promise<void> {
  const properties = event.properties
  if (properties === undefined) return
  const info = properties.info
  const sessionID =
    typeof properties.sessionID === 'string'
      ? properties.sessionID
      : info !== null && typeof info === 'object'
        ? (info as { id?: unknown }).id
        : undefined
  if (typeof sessionID !== 'string' || sessionID === '') {
    // Fail-open by necessity, loud by choice: the entry for this session (if
    // any) cannot be identified, so it stays registered. Same `console.warn`
    // channel as the event-subscription error above — this module has no
    // logger, and a diagnostic nobody reads on stderr is still a silent leak.
    console.warn(
      '[Pantheon V2] session.deleted carried no session id ' +
        '(neither properties.sessionID nor properties.info.id); ' +
        'its read-only registration cannot be pruned and will persist.',
    )
    return
  }
  readOnlyRegistry.unregister(sessionID)
  memoryInjectionCache.delete(sessionID)
}

/**
 * Session-error handler: no V2-side implementation.
 *
 * The board error transition lives in V1's event hook, which is not loaded on
 * a V2-only install. There is nothing to do here — deliberately, rather than
 * describing behaviour this handler does not have.
 */
async function onSessionError(_event: V2SessionEvent): Promise<void> {}

/**
 * Session-compacted handler: no V2-side implementation.
 *
 * Todo preservation and compaction context build live in the V1 path
 * (`todo-preserve.ts`, driven by V1's compaction hook), which is not loaded on
 * a V2-only install.
 */
async function onSessionCompacted(_event: V2SessionEvent): Promise<void> {}

// ─── V2 Session Hooks ───────────────────────────────────────────────────

/**
 * One-line prune stats entry through the existing hooks.log channel only when
 * a pass actually rewrote something. Silent no-ops (below threshold, protected
 * window, already-pruned) stay silent so a compaction does not add noise for
 * every request.
 */
function logContextPrune(stats: PruneStats): void {
  if (!stats.changed) return
  appendV2HookLog(
    `[context-pruner] site=${stats.site} messages=${stats.messagesTouched} ` +
      `parts=${stats.partsPruned} est_tokens_saved=${stats.estimatedTokensSaved}`,
  )
}

/**
 * Fail-open diagnostics: at most ONE line per session, whatever the engine
 * threw or however malformed the payload was. Bounded so a long-lived host
 * cannot accumulate session ids forever.
 */
const pruneFailureSessions = new Set<string>()
const PRUNE_FAILURE_SESSIONS_MAX = 256

function logPruneFailureOnce(sessionID: unknown, site: PruneSite, error: unknown): void {
  const session = typeof sessionID === 'string' && sessionID !== '' ? sessionID : ''
  const key = session !== '' ? session : `${site}:unknown`
  if (pruneFailureSessions.has(key)) return
  if (pruneFailureSessions.size >= PRUNE_FAILURE_SESSIONS_MAX) pruneFailureSessions.clear()
  pruneFailureSessions.add(key)
  const message = error instanceof Error ? error.message : String(error)
  appendV2HookLog(`[context-pruner] failed open site=${site} session=${key}: ${message}`)
}

/**
 * A compaction payload whose `messages` is absent or misnamed is a shape drift,
 * not a normal no-op: the feature is always-on at that site, so silence would
 * hide the drift forever. Report `not-array`/`malformed` with the same
 * once-per-session channel as a thrown failure. The `context` caller invokes
 * this only when the feature is enabled.
 */
function logPruneShapeIssue(stats: PruneStats, sessionID: unknown, site: PruneSite): void {
  if (stats.skipReason !== 'not-array' && stats.skipReason !== 'malformed') return
  const detail =
    stats.skipReason === 'not-array'
      ? 'not-array: payload.messages is not an array; input left unchanged'
      : 'malformed: unexpected message shape; input left unchanged'
  logPruneFailureOnce(sessionID, site, new Error(detail))
}

/**
 * Config typos are otherwise invisible: `keepTurn: 7` resolves to the default 4
 * and the operator believes it applied. Warn ONCE per process, name the
 * ignored keys and the accepted keys, and keep the fail-open resolution.
 */
let contextPrunerConfigWarned = false

function warnContextPrunerConfigOnce(options: unknown): void {
  if (contextPrunerConfigWarned) return
  try {
    const issues = describeContextPrunerConfigIssues(options)
    if (issues.length === 0) return
    contextPrunerConfigWarned = true
    appendV2HookLog(
      `[context-pruner] ignored invalid context_pruner config: ${issues.join('; ')}; ` +
        `accepted keys: ${CONTEXT_PRUNER_CONFIG_KEYS.join(', ')}`,
    )
  } catch {
    // A validator must never break setup; silence is the only safe fallback.
    contextPrunerConfigWarned = true
  }
}

// ─── Ambient memory injection (opt-in, V2 context hook) ─────────────────

/**
 * One payload per session, computed on the session's first request. Bounded by
 * `MEMORY_CACHE_MAX_SESSIONS` inside the cache (FIFO), so a long-lived host
 * cannot grow it without limit. The payload is built, rendered and logged by
 * `memory-context.ts`; this module only supplies the hook wiring and the
 * `hooks.log` channel.
 */
const memoryInjectionCache = new MemoryInjectionCache()

/**
 * Empty description cache for {@link sanitizeVisionHistory}.
 *
 * V1 fills this from the vision handler (per-part text captured at
 * `chat.message` time). V2 has no equivalent cache, so the sanitizer falls back
 * to its own placeholder text for every image part — which is the contract that
 * matters: an image never reaches the provider as image content.
 */
const V2_VISION_HISTORY_TEXT: ReadonlyMap<string, ReadonlyMap<string, string>> = new Map()

/**
 * Register session hooks via V2 ctx.session.hook.
 *
 * The V2 session.hook API (when available) provides:
 *   ctx.session.hook("prompt", handler)  — message admission
 *   ctx.session.hook("context", handler) — system context injection
 *   ctx.session.hook("compaction", handler) — registered in setup Phase 7
 *
 * Returns true if any hooks were registered.
 */
async function registerV2SessionHooks(context: PluginContext): Promise<boolean> {
  // Config validity is independent of hook availability; warn before the early
  // return so a typo is visible even on a host that registers no session hook.
  warnContextPrunerConfigOnce(context.options)
  warnInvalidMemoryInjectionConfig(context.options, appendV2HookLog)
  const sessionCtx = hostDomains(context).session

  if (!sessionCtx?.hook) {
    return false
  }

  // Resolved once, mirroring `resolveV2SandboxConfig(context.options)`: the
  // per-request context prune is opt-in because it invalidates the provider
  // prompt cache and has no measured cost baseline. The compaction site below
  // applies the rules unconditionally.
  const prunerConfig = resolveContextPrunerConfig(context.options)

  // Ambient memory injection is opt-in and default OFF: with `enabled: false`
  // this hook adds nothing, so `system` stays byte-identical to the policy-only
  // output. Resolved here (not per request) for the same reason as the pruner.
  const memoryConfig = resolveMemoryInjectionConfig(context.options)

  let registered = false

  try {
    // "context" hook — inject routing policy + compaction state
    await sessionCtx.hook('context', (event: unknown) => {
      try {
        // Opt-in lifetime proof for the host-backed hook canary (MODE=real).
        // Inert unless PANTHEON_HOOK_CANARY_LIFETIME_PROOF is set.
        if (process.env.PANTHEON_HOOK_CANARY_LIFETIME_PROOF) {
          try {
            appendFileSync(
              process.env.PANTHEON_HOOK_CANARY_LIFETIME_PROOF,
              'plugin-v2:session.hook:context\n',
            )
          } catch {
            // Best-effort instrumentation.
          }
        }
        // 2.0.16 payload is `{ system: Array<SystemPart> }`. Normalize any
        // string entries to `{ type: 'text', text }` parts and append the
        // policy as a part. Junk entries are ignored; a non-array,
        // non-string system is left untouched. Never throws (fail-open).
        const ctx = event as
          | { system?: unknown; messages?: unknown; sessionID?: unknown }
          | null
          | undefined
        if (ctx == null) return
        const normalized = normalizeSystemToParts(ctx.system)
        if (normalized != null) {
          // A bare string is replaced by its part array; an array is mutated in
          // place (the host may read the original reference).
          if (typeof ctx.system === 'string') ctx.system = normalized
          if (!hasPolicyMarker(normalized)) {
            normalized.push({ type: 'text', text: POLICY } satisfies SystemPart)
          }
        }
        // Opt-in ambient memory injection: the top-K memories relevant to the
        // session's first user message, computed once per session and re-added
        // verbatim on later requests. Deliberately OUTSIDE the block above: with
        // `enabled: true` and no usable `system` there is nowhere to push, and
        // the module reports `skip=no-system` once per session instead of the
        // feature going silently inert. Off by default, so this is the only
        // thing `enabled: false` skips.
        if (memoryConfig.enabled) {
          applyMemoryInjection(
            normalized ?? ctx.system,
            ctx.messages,
            ctx.sessionID,
            memoryConfig,
            memoryInjectionCache,
            appendV2HookLog,
          )
        }
        // Vision history sanitization (V1
        // `experimental.chat.messages.transform` parity, #266). Image parts are
        // replaced with their cached description, or with the same placeholder
        // V1 uses, BEFORE a text-only provider serializer can turn them into
        // `image_url` content. The host's `context` payload carries the
        // provider-bound `messages` array and honors mutations per request, so
        // this is the same seam V1's transform occupies.
        //
        // The description map is empty on V2 by construction: descriptions are
        // cached by the V1 vision handler, which has no V2 counterpart (V2
        // materializes the image and asks the model to call `vision_describe`).
        // Every image part therefore becomes the placeholder — the safety
        // property V1's transform exists for — never a raw image.
        try {
          sanitizeVisionHistory({ messages: ctx.messages }, V2_VISION_HISTORY_TEXT)
        } catch (error) {
          logPruneFailureOnce(ctx.sessionID, 'context', error)
        }
        // Opt-in DCP: same engine as the compaction site, but per-request
        // pruning invalidates the prompt cache, so it runs only when
        // `context_pruner.enabled` is explicitly true. Disabled = the hook is
        // byte-for-byte the previous behaviour.
        if (prunerConfig.enabled) {
          try {
            const stats = pruneMessages(ctx.messages, prunerConfig, 'context')
            logContextPrune(stats)
            logPruneShapeIssue(stats, ctx.sessionID, 'context')
          } catch (error) {
            logPruneFailureOnce(ctx.sessionID, 'context', error)
          }
        }
      } catch {
        // Fail-open: never throw to the host.
      }
    })
    registered = true
  } catch {
    // Context hook not supported
  }

  try {
    // "prompt" hook — preserve attached image references and add model-visible
    // instructions so Zeus can inspect visual context and pass it to the
    // implementation specialist before editing.
    await sessionCtx.hook('prompt', (event: unknown) => {
      try {
        // 2.0.29 host payload: `{ sessionID, messageID, prompt: { text,
        // files, agents, skills }, metadata, delivery }`. The session id is
        // top-level (verified against the host's `SessionPrompt.prepare`), so a
        // data: attachment's panic-free moment also relays it to the MCP.
        const admission = event as {
          sessionID?: unknown
          prompt?: { text?: unknown; files?: unknown }
        } | null
        const prompt = admission?.prompt
        if (!prompt || typeof prompt.text !== 'string') return
        if (prompt.text.includes('<!-- pantheon-v2-visual-context -->')) return
        const sessionID =
          typeof admission?.sessionID === 'string' && admission.sessionID.trim() !== ''
            ? admission.sessionID
            : undefined
        const visualContext = buildV2VisionPromptContext(prompt.files, prompt.text, sessionID)
        if (visualContext) prompt.text = `${prompt.text}\n\n${visualContext}`
      } catch {
        // Fail-open: malformed/unsupported prompt shapes must not block input.
      }
    })
    registered = true
  } catch {
    // Prompt hook not supported
  }

  return registered
}

// ─── V2 Secret Scan ─────────────────────────────────────────────────────

/**
 * High-confidence secret token formats — MIRRORS `SECRET_MASK_RE` in
 * src/plugins/pantheon-hooks.ts (V1) and `HIGH_CONFIDENCE_PATTERNS` in
 * scripts/hooks/scan-secrets.sh.
 *
 * Duplicated rather than imported because the V1 module is a separate plugin
 * that is NOT loaded on a V2-only install (see the module header), and pulling
 * it in for one regex would resurrect exactly the V1-hook coupling V2 exists to
 * remove. The drift risk is real and is asserted by a test in
 * tests/pantheon/plugin-v2-contract.test.ts.
 *
 * Applied to every log line this module writes, so a hook trail can never
 * contain a raw credential. Header/KEY names (the Bifrost header alone,
 * `api_key=...`) are deliberately NOT matched: they are not secret values.
 */
const SECRET_MASK_RE =
  /(sk-bf-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{36,}|glpat-[A-Za-z0-9_-]{20}|sk-[a-zA-Z0-9]{20,}|sk_live_[a-zA-Z0-9]{20,}|sk_test_[a-zA-Z0-9]{20,}|xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}|bearer\s+[a-zA-Z0-9_.-]{20,}|eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*)/gi

/** Replace every high-confidence secret match with '****'. */
function maskSecret(text: string): string {
  return text.replace(SECRET_MASK_RE, '****')
}

/**
 * Message thrown when scan-secrets.sh exits 2 (a high-confidence token match).
 *
 * This is the only deliberate throw on the V2 surface. opencode's
 * Plugin.trigger has no catch around hook invocations, so the rejection
 * propagates and fails the tool's execute promise BEFORE the tool body runs —
 * the same hard block V1 has (src/plugins/pantheon-hooks.ts
 * `SECRET_BLOCK_MESSAGE`), which was inert on a V2-only install because
 * pantheon-hooks.ts is never loaded there (opencode.json `plugins` declares only
 * `src/plugin-v2`).
 *
 * English, like every other message this module emits: this string surfaces in
 * the user's session as the tool error, so it is read by whoever hit the block,
 * not by the code that raised it. A Portuguese release note elsewhere in the
 * repo is not a reason for the runtime message to be Portuguese too.
 */
const SECRET_BLOCK_MESSAGE =
  '[plugin-v2] Blocked: high-confidence secret detected in tool input — see .pantheon/logs/hooks.log'

/**
 * Message thrown when the secret scanner cannot produce a trustworthy verdict —
 * the script is missing/unexecutable, the child timed out or was killed, the
 * payload could not be serialized, the report was malformed, or the exit status
 * was unexpected.
 *
 * This is a deliberate fail-CLOSED denial. The previous handler blocked only
 * `code === 2` and treated every other outcome as advisory — but the runner
 * reports a missing script, a spawn failure and a payload-serialization failure
 * as `code: 1` too (src/plugins/hook-runner.ts), so a broken scanner read as a
 * clean advisory and the tool ran, silently disabling the only hard secret block
 * on the V2 surface.
 *
 * English and user-facing, like {@link SECRET_BLOCK_MESSAGE}. It carries no
 * scanner output on purpose: a scan that failed mid-flight may still be holding
 * the raw payload, and the denial must not become the leak it exists to prevent.
 */
const SECRET_SCAN_UNAVAILABLE_MESSAGE =
  '[plugin-v2] Blocked: the secret scanner could not complete, so this tool call was denied (fail-closed) — see .pantheon/logs/hooks.log'

/**
 * Append one masked, ISO-stamped line to .pantheon/logs/hooks.log under the
 * working directory, and return whether it landed.
 *
 * V1's `reportFailure` also writes to `client.app.log` and shows a TUI toast.
 * The V2 `PluginContext` exposes NEITHER (it is
 * `{options, agent, aisdk, catalog, command, integration, plugin, reference,
 * skill}` — no `client`, no `directory`), so this module has only the file
 * channel. That is a real reduction in observability versus V1, stated here
 * rather than implied. Best-effort by contract: a logging failure must never
 * take down the session.
 */
function appendV2HookLog(line: string): boolean {
  const masked = maskSecret(line)
  if (masked === '') return false
  const stamp = new Date().toISOString()
  // Multi-line scanner stderr would otherwise produce continuation lines with
  // no timestamp (V1's P0-5 fix) — one message becomes N timestamped lines.
  const body = masked
    .split('\n')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => `[${stamp}] ${part}`)
    .join('\n')
  if (body === '') return false
  try {
    const dir = path.join(process.cwd(), '.pantheon', 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(path.join(dir, 'hooks.log'), `${body}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

// ─── BENCH Hook Timing (beta-10 latency slice, Phase 0) ────────────────

/**
 * BENCH INSTRUMENTATION — observation only, zero behavior change.
 *
 * The beta-10 latency slice measures the V2 tool hook chain. These helpers
 * record the start/end of `execute.before` and `execute.after` per tool call
 * and append one single-line `[bench]` entry per hook end to the EXISTING
 * hooks.log channel (same appendV2HookLog path as every other line: masked,
 * stamped, best-effort, never throwing). The lines are consumed by
 * bench/lib/hooklog.mjs.
 *
 * Deliberate properties:
 *   - the log call happens in `finally`, so denied calls (read-only guard,
 *     secret block) are timed too, and the denial still propagates unchanged
 *   - the join key is the host callID (`event.id`); a TTL-bounded map prunes
 *     stale entries so a background/never-after call cannot leak memory
 *   - `since_before_ms=unavailable` when no before record exists — the bench
 *     contract never lets "unavailable" be encoded as 0
 */

/** Entries older than this are pruned (a task tool result may never fire after). */
const BENCH_TIMING_TTL_MS = 5 * 60_000
/** Hard cap — mirrors the V1 delegationStarts bound. */
const BENCH_TIMING_MAX = 256

const benchTimings = new Map<string, number>()

function pruneBenchTimings(now: number): void {
  for (const [callID, startedAt] of benchTimings) {
    if (now - startedAt > BENCH_TIMING_TTL_MS) benchTimings.delete(callID)
  }
  while (benchTimings.size >= BENCH_TIMING_MAX) {
    let oldestID: string | null = null
    let oldestAt = Number.POSITIVE_INFINITY
    for (const [id, at] of benchTimings) {
      if (at < oldestAt) {
        oldestAt = at
        oldestID = id
      }
    }
    if (oldestID === null) break
    benchTimings.delete(oldestID)
  }
}

/** Read `{tool, id}` off a V2 tool event without assuming its exact shape. */
function benchEventIdentity(event: unknown): { tool: string; callID: string } {
  if (event === null || typeof event !== 'object') return { tool: '', callID: '' }
  const payload = event as { tool?: unknown; id?: unknown }
  return {
    tool: typeof payload.tool === 'string' ? payload.tool : '',
    callID: typeof payload.id === 'string' ? payload.id : '',
  }
}

/**
 * Append one `[bench]` timing line for a finished hook phase. Best-effort and
 * exception-free by construction (appendV2HookLog never throws).
 */
function logBenchHookTiming(phase: 'before' | 'after', event: unknown, startedAt: number): void {
  try {
    const { tool, callID } = benchEventIdentity(event)
    const endedAt = Date.now()
    if (phase === 'before') {
      if (callID !== '') {
        benchTimings.set(callID, startedAt)
        pruneBenchTimings(startedAt)
      }
      appendV2HookLog(
        `[bench] tool.execute.before end tool=${tool} callID=${callID} ` +
          `started_at=${new Date(startedAt).toISOString()} duration_ms=${endedAt - startedAt}`,
      )
      return
    }
    const beforeAt = callID !== '' ? benchTimings.get(callID) : undefined
    if (beforeAt !== undefined) benchTimings.delete(callID)
    const sinceBefore = beforeAt === undefined ? 'unavailable' : String(endedAt - beforeAt)
    appendV2HookLog(
      `[bench] tool.execute.after end tool=${tool} callID=${callID} ` +
        `duration_ms=${endedAt - startedAt} since_before_ms=${sinceBefore}`,
    )
  } catch {
    // Instrumentation must never affect the hook chain.
  }
}

// ─── V2 Secret-Scan Verdict ─────────────────────────────────────────────

/**
 * The scanner's own report marker, written to stderr on every non-clean run
 * (exit 1 advisory, exit 2 block). It is the discriminator between a genuine
 * low-confidence advisory and a runner infrastructure failure, BOTH of which
 * surface as `code === 1`: the runner's own failures (missing/unexecutable
 * script, spawn error, payload-serialization error) resolve a structured
 * `HookResult` with `code: 1` and no scan report, while the real scanner's
 * advisory always carries this marker. Requiring it means a scanner that stops
 * reporting fails toward a denial, never toward a silent allow.
 */
const SECRET_SCAN_MARKER = '[SECRET SCAN]'

/** Sanitized failure classes — logged in place of raw scanner output. */
type SecretScanFailureReason =
  | 'scanner-timeout'
  | 'scanner-signal'
  | 'scanner-spawn-failure'
  | 'scanner-serialization-failure'
  | 'scanner-malformed-output'
  | 'scanner-unexpected-exit'

type SecretScanDecision =
  | { action: 'allow' }
  | { action: 'advisory' }
  | { action: 'block' }
  | { action: 'fail-closed'; reason: SecretScanFailureReason }

/**
 * The runner's own infrastructure-failure messages (see hook-runner.ts), matched
 * at the start of stderr where the runner is the only writer. Matching a prefix
 * rather than a substring keeps a scan report that merely happens to quote one
 * of these phrases from flipping a valid advisory into a denial.
 */
const SCANNER_INFRA_FAILURES: ReadonlyArray<[string, SecretScanFailureReason]> = [
  ['payload serialization failed:', 'scanner-serialization-failure'],
  ['spawn failed:', 'scanner-spawn-failure'],
  ['hook script failed to spawn:', 'scanner-spawn-failure'],
]

/**
 * Classify one secret-scan {@link HookResult} into an enforcement decision.
 *
 * fail-closed by construction: `allow` and `advisory` are reachable only from a
 * result that is unambiguously a completed scanner run. Everything else —
 * timeout, signal, spawn/serialization failure, missing report, unknown or
 * unexpected exit status — denies. `advisory` additionally requires the
 * scanner's own report marker, which is what separates an exit-1 advisory from
 * the runner's exit-1 infrastructure failure.
 *
 * `block` covers the high-confidence match (exit 2); the caller turns it into
 * the user-facing block.
 */
function evaluateSecretScanResult(scan: HookResult): SecretScanDecision {
  if (scan.timedOut) return { action: 'fail-closed', reason: 'scanner-timeout' }
  if (scan.signal !== null) return { action: 'fail-closed', reason: 'scanner-signal' }
  if (!Number.isInteger(scan.code)) {
    return { action: 'fail-closed', reason: 'scanner-malformed-output' }
  }
  for (const [signature, reason] of SCANNER_INFRA_FAILURES) {
    if (scan.stderr.startsWith(signature)) return { action: 'fail-closed', reason }
  }
  if (scan.code === 0) return { action: 'allow' }
  if (scan.code === 2) return { action: 'block' }
  if (scan.code === 1) {
    return scan.stderr.includes(SECRET_SCAN_MARKER)
      ? { action: 'advisory' }
      : { action: 'fail-closed', reason: 'scanner-malformed-output' }
  }
  return { action: 'fail-closed', reason: 'scanner-unexpected-exit' }
}

/** Invocation of scripts/hooks/scan-secrets.sh used by the tool guard. */
type SecretScanRunner = (payload: HookPayload) => Promise<HookResult>

const defaultSecretScanRunner: SecretScanRunner = (payload) => runHook('scan-secrets.sh', payload)

let secretScanRunner: SecretScanRunner = defaultSecretScanRunner

/**
 * Test seam — override (or, with `null`, restore) the V2 secret-scan runner.
 *
 * Exported only for tests/pantheon/plugin-v2-contract.test.ts, which injects
 * structured {@link HookResult}s (missing scanner, timeout, malformed output)
 * that the real script cannot be made to produce on demand. There is no
 * production caller; the shipped handler always uses `defaultSecretScanRunner`.
 */
export function setV2SecretScanRunnerForTests(runner: SecretScanRunner | null): void {
  secretScanRunner = runner ?? defaultSecretScanRunner
}

// ─── V2 Tool Hooks ──────────────────────────────────────────────────────

/**
 * The `tool.execute.before` event as the host dispatches it (opencode 2.0.22).
 *
 * Transcribed from the host's tool service:
 *
 *   trigger("tool", "execute.before", { tool, sessionID, agent, messageID, id, input })
 *
 * Two shape differences from V1's positional `(input, output)` pair, both
 * handled by {@link adaptV2ExecuteBeforeEvent}: the host passes ONE payload
 * object, and the tool arguments live on `input` where V1 called them
 * `output.args`.
 *
 * `agent` is a required field of the host's tool context
 * (`ToolInvocation.context = { sessionID, agent, messageID, id }`), so the
 * active agent arrives on the very event the enforcement guard needs. V1 had to
 * learn it from a separate `chat.params` hook and keep a session→agent map; V2
 * does not have to, and neither does this module.
 */
interface V2ToolExecuteBeforeEvent {
  tool?: unknown
  sessionID?: unknown
  messageID?: unknown
  agent?: unknown
  id?: unknown
  input?: unknown
}

/**
 * Read-only enforcement for the V2 tool surface.
 *
 * The same factory, the same `DEFAULT_BLOCKED_TOOLS` and the same read-only set
 * that V1 uses, so the two surfaces cannot drift on what counts as a mutating
 * tool — `hashline_edit` and `pantheon_model` are denied here for exactly the
 * reason they are denied in V1.
 *
 * Deliberately NOT passed `getSessionAgent` / `isRootSession` / `isChildSession`.
 * There are TWO distinct reasons, and conflating them is what produced a wrong
 * causal chain here once already — keep them apart:
 *
 * 1. MISSING `getSessionAgent` (wiring). This is what would deny every
 *    `task()` call. V2 learns the active agent from the `execute.before` event
 *    itself and keeps no session→agent map, so there is no lookup to hand the
 *    guard. The guard would call `isDelegationAllowed(undefined, target)`,
 *    which returns `false`, and throw "caller agent is unavailable" — for
 *    every caller, including Zeus. Note what is NOT happening: an unseeded
 *    `isRootSession` would *pass* the root gate (`isRoot` reports `true` for an
 *    unknown session), so the hierarchy is not what denies here.
 *
 * 2. UNWIRED HIERARCHY (design). `SessionHierarchyRegistry` is what gates
 *    exactly two things, and nothing else: the depth-2 child deny
 *    (`isChildSession`) and the root-session gate (`isRootSession`). Left
 *    unseeded, `isChild` is `false` for every session, so depth-2 would never
 *    fire on a genuine child — a hierarchy that cannot tell a child from a root
 *    is not a trustworthy input to either check.
 *
 *    "Unwired", not "impossible": the V2 `session.created` event carries
 *    `properties.info: Session` including `parentID?`, the same field V1 seeds
 *    from on the same event, so one line in `onSessionCreated` would seed live
 *    sessions (see its docstring). What has no V2 equivalent is V1's SECOND
 *    source, the `client.session.list()` startup seed — V2's `PluginContext`
 *    exposes no `client`. Whether a live 2.0.22 host populates `info.parentID`
 *    is UNVERIFIED; no canary reads an event payload. So the correct summary is
 *    "seeded for nothing", not "unseedable", and the guard's omission is right
 *    today for the weaker reason that nothing seeds it at all.
 *
 * Omitting all three skips the branch wholesale: the guard only enters it when
 * `options?.isRootSession !== undefined`. `task` is still denied inside a
 * read-only session via the blocked-tool list, so the read-only half of depth-2
 * holds for apollo/gaia.
 *
 * The caller/target half is NOT this guard's job on V2, and that is a division
 * of labour rather than a gap: V2 delegates through the native `subagent` tool
 * and its `permission.hook('evaluate')` handler, which calls
 * `evaluateV2Delegation` — the matrix (zeus → anyone; athena/hermes → apollo)
 * plus the same depth-2 rule, expressed as "a caller session that carries a
 * `parentID` is denied". Both are proved in
 * tests/pantheon/plugin-v2-contract.test.ts and
 * tests/pantheon/v2-delegation-enforce.test.ts.
 *
 * The Zeus read guard is a SEPARATE call in the same `execute.before` handler
 * (issue #264), fed from the same event `agent`; it is not part of this guard.
 */
const v2EnforcementGuard = createEnforcementGuard({
  getReadOnlySessions: () => readOnlyRegistry.sessionIDs(),
})

/**
 * Project a V2 `execute.before` event onto the two-argument shape
 * `createEnforcementGuard` was built for.
 *
 * `tool` is the host's registration id, computed as
 * `options.namespace === undefined ? name : `${namespace}_${name}``. Pantheon
 * declares a namespace for catalog grouping but sets `options.namespace` on no
 * tool, so the id is the bare name (`hashline_edit`) and the blocked-tool match
 * fires. A tool that opted into `options.namespace` would gain a prefix and stop
 * matching — the integration test in tests/pantheon/plugin-v2-contract.test.ts
 * drives the real registration path and asserts on the registered names, so
 * that drift fails a test instead of silently disabling enforcement.
 *
 * A missing `sessionID` maps to the empty key: the registry lookup then matches
 * the event's own (absent) identity, so a blocked tool in a read-only session is
 * still denied. Fail-closed on the one axis that matters.
 */
function adaptV2ExecuteBeforeEvent(event: unknown): {
  input: ToolExecuteBeforeInput
  output: ToolExecuteBeforeOutput
  agent: unknown
} {
  const payload = (event ?? {}) as V2ToolExecuteBeforeEvent
  return {
    input: {
      tool: typeof payload.tool === 'string' ? payload.tool : '',
      sessionID: typeof payload.sessionID === 'string' ? payload.sessionID : '',
      callID: typeof payload.id === 'string' ? payload.id : '',
    },
    output: { args: payload.input },
    agent: payload.agent,
  }
}

/**
 * Test seam — override (or, with `null`, restore) the V2 shell-hook runner.
 *
 * Exported only for tests/pantheon/plugin-v2-contract.test.ts, which asserts
 * that the REGISTERED `execute.before`/`execute.after` handlers invoke the
 * formatter and the delegation audit scripts. Spawning the real scripts would
 * make the assertion depend on the shell, not on the wiring; the scripts
 * themselves are covered by tests/pantheon/v2-shell-hooks.test.ts.
 */
export function setV2ShellRunnerForTests(runner: V2ShellRunner | null): void {
  shellRunnerOverride = runner ?? undefined
}

let shellRunnerOverride: V2ShellRunner | undefined

/**
 * Test seam — clear the module-level bridge AND the process-wide registration.
 *
 * Exported only for tests/pantheon/plugin-v2-contract.test.ts. The co-load guard
 * makes `installV2Bridge` reuse an existing bridge (so V1's enforcer is never
 * duplicated), which means a test that asserts the CONSTRUCTION path has to
 * start from "no bridge". Production has no caller: a process keeps its bridge
 * for its lifetime.
 */
export function resetV2BridgeForTests(): void {
  v1Bridge = null
  registerV2Bridge(null)
}

/**
 * Register tool execution hooks via V2 ctx.tool.hook.
 *
 * The V2 tool.hook API (when available) provides:
 *   ctx.tool.hook("execute.before", handler) — pre-execution guard
 *   ctx.tool.hook("execute.after", handler)  — post-execution augment
 *
 * Returns true if any hooks were registered.
 */
async function registerV2ToolHooks(
  context: PluginContext,
  subagentOrigins: V2SubagentOriginRegistry,
  boundedReadOrigins?: V2BoundedReadOriginRegistry,
): Promise<{ registered: boolean; beforeRegistered: boolean }> {
  const toolCtx = hostDomains(context).tool

  if (!toolCtx?.hook) {
    return { registered: false, beforeRegistered: false }
  }

  // V1 shell-hook parity (#266): formatter on every after-event, delegation
  // audit start/stop. Both scripts are environment-independent, so they are
  // invoked through the same runner the secret scan uses.
  const shellHooks = createV2ShellHooks({
    ...(shellRunnerOverride === undefined ? {} : { run: shellRunnerOverride }),
    onUnkeyed: appendV2HookLog,
  })

  let registered = false
  let beforeRegistered = false

  try {
    // "execute.before" — read-only enforcement. Throwing from this handler
    // DENIES the tool call and the host surfaces the message to the session,
    // which is how the guard blocks a mutating tool in a read-only session.
    //
    // This is the enforcement point for the V2 surface, not a delegation to
    // V1: `src/plugin.ts` is not loaded when only `plugin-v2` is configured
    // (opencode.json `plugins`), so the V1 `tool.execute.before` hook does not
    // exist in that process. The guard below is instantiated here and consulted
    // here; without it the tools registered by registerV2Tools would be a live
    // write path in every session, including read-only ones.
    await toolCtx.hook('execute.before', async (event: unknown) => {
      const benchStartedAt = Date.now()
      const { input, output, agent } = adaptV2ExecuteBeforeEvent(event)
      try {
        // V2's equivalent of V1's `chat.params` trigger: the host puts the active
        // agent on the event itself, so registering here needs no separate hook
        // and no session→agent map. A non-read-only (or absent) agent revokes the
        // registration, which also covers an in-session agent switch.
        syncReadOnlySession(readOnlyRegistry, input.sessionID, agent)
        // Zeus read guard (issue #264). V1 wires this from its `chat.params`
        // session→agent map (`src/plugin.ts`); V2 has no such map because the
        // host puts the active agent on THIS event, so the guard is fed from
        // the event's `agent` field — the same identity the read-only
        // registry above already trusts.
        //
        // Fail-closed on casing: `zeusReadGuard` compares the agent with an
        // exact `!== 'zeus'`, so a host that reports `Zeus` would silently
        // disable the guard. Normalizing through the shared
        // `normalizeDelegationAgent` keeps the comparison meaningful without
        // changing the predicate V1 uses.
        //
        // Runs BEFORE the read-only guard, matching V1's chain order. Both
        // throw to deny; neither is inside the scanner's try/catch, so a
        // denial keeps propagating to the host.
        zeusReadGuard(input.tool, output.args, normalizeDelegationAgent(agent))
        // Deliberately OUTSIDE the try/catch below: a read-only denial must keep
        // propagating to the host, not be swallowed as a scanner failure.
        await v2EnforcementGuard(input, output)

        // High-confidence secret scan (scripts/hooks/scan-secrets.sh). This is the
        // ONLY hard block on the V2 surface, and it exists here — rather than via
        // `src/plugins/pantheon-hooks.ts` — because that module is a separate
        // plugin that is never loaded on a V2-only install: opencode.json
        // `plugins` declares only `src/plugin-v2`. V1's scan-secrets block was
        // therefore inert by construction, not by misconfiguration.
        //
        // exit 0 → allow. exit 1 with a valid scanner report → advisory, logged
        // only. exit 2 (high-confidence match) → deny. A scanner that does NOT
        // produce a trustworthy verdict — missing/unexecutable script, timeout,
        // killed child, spawn/serialization failure, malformed or unexpected
        // output — is fail-CLOSED: this pending tool call is denied, the session
        // is not. (runHook resolves a structured result instead of rejecting, so
        // the exit-code-only reading below cannot lean on an exception.)
        let blockError: Error | null = null
        try {
          const payload: HookPayload = {
            tool_name: input.tool,
            tool_input: output.args ?? {},
            agent_id: typeof agent === 'string' ? agent : '',
            session_id: input.sessionID,
          }
          const scan = await secretScanRunner(payload)
          const decision = evaluateSecretScanResult(scan)
          if (decision.action === 'block') {
            appendV2HookLog(SECRET_BLOCK_MESSAGE)
            appendV2HookLog(scan.stderr)
            blockError = new Error(SECRET_BLOCK_MESSAGE)
          } else if (decision.action === 'advisory') {
            // Advisory: log only, never block.
            appendV2HookLog(scan.stderr)
          } else if (decision.action === 'fail-closed') {
            // Sanitized failure category only — never the scanner's raw stderr,
            // which on a failure path is unverified and may carry the very
            // payload the scan exists to keep out of logs.
            appendV2HookLog(`${SECRET_SCAN_UNAVAILABLE_MESSAGE} (${decision.reason})`)
            blockError = new Error(SECRET_SCAN_UNAVAILABLE_MESSAGE)
          }
        } catch {
          // The runner is contracted to resolve a structured result, so this only
          // guards an unexpected throw (including a future change to the runner).
          // A scanner that cannot run is fail-CLOSED: deny this call rather than
          // let it through with no scan at all.
          appendV2HookLog(SECRET_SCAN_UNAVAILABLE_MESSAGE)
          blockError = new Error(SECRET_SCAN_UNAVAILABLE_MESSAGE)
        }
        if (blockError !== null) throw blockError
        const boundedReadOrigin = boundedReadOrigins?.capture(event)
        const eventTool = (event as V2ToolExecuteBeforeEvent | null)?.tool
        if (eventTool === BOUNDED_READ_TOOL && boundedReadOrigin === undefined) {
          throw new Error('BOUND_READ_UNAUTHORIZED')
        }
        if (boundedReadOrigin !== undefined) {
          writeV2AdmissionProof('tool.execute.before bounded-read', {
            sessionID: boundedReadOrigin.sessionID,
            messageID: boundedReadOrigin.messageID,
            callID: boundedReadOrigin.callID,
            agent: boundedReadOrigin.agent,
          })
        }
        const origin = subagentOrigins.capture(event)
        if (origin !== undefined) {
          writeV2AdmissionProof('tool.execute.before', { ...origin })
        }
        // Delegation audit START record (#266). Deliberately AFTER every guard
        // and the secret scan: a denied call must not leave a start record with
        // no matching stop. The formatter/stop halves run in `execute.after`.
        await shellHooks.before(event)
      } finally {
        // BENCH instrumentation — observation only; runs on the deny paths too.
        logBenchHookTiming('before', event, benchStartedAt)
      }
    })
    registered = true
    beforeRegistered = true
  } catch {
    // Tool before-hook not supported
  }

  try {
    // "execute.after" — the V1 parity chain (task-result-guard →
    // context-sandbox → read-enhancer) rebuilt on the V2 event shape.
    //
    // This IS behaviour, not a registration point: on a V2-only install the V1
    // `pantheon-hooks` plugin is not loaded, so this handler is the only thing
    // that truncates oversized output and tags `read` with hashline refs.
    // The sandbox config comes from `ctx.options.context_sandbox` (the V2 copy
    // the installer writes — V2.0.25 drops the V1 top-level key), resolved with
    // the same resolver V1 uses.
    const v2ExecuteAfter = createV2ExecuteAfter({
      sandbox: resolveV2SandboxConfig(context.options),
    })
    await toolCtx.hook('execute.after', async (event: unknown) => {
      const benchStartedAt = Date.now()
      try {
        subagentOrigins.forget(event)
        boundedReadOrigins?.forget(event)
        await v2ExecuteAfter(event)
        // Formatter + delegation audit STOP (#266). Awaited for the same
        // reason V1 awaits it: the log record should exist before the tool
        // result is surfaced. Failures are swallowed inside the module.
        await shellHooks.after(event)
      } finally {
        // BENCH instrumentation — observation only; the awaited call means the
        // duration covers the whole parity chain, not just its dispatch.
        logBenchHookTiming('after', event, benchStartedAt)
      }
    })
    registered = true
  } catch {
    // Tool after-hook not supported
  }

  return { registered, beforeRegistered }
}

// ─── V2 Permission Hook ─────────────────────────────────────────────────

/**
 * Register permission hook via V2 ctx.permission.hook.
 *
 * The V2 permission.hook API (when available) provides:
 *   ctx.permission.hook("evaluate", handler) — host permission evaluation
 * The handler receives one mutable PermissionEvaluation event; decisions are
 * written to event.effect/event.message (there is no separate V1-style output).
 *
 * Returns true if the hook was registered.
 */
async function registerV2PermissionHook(
  context: PluginContext,
  subagentOrigins: V2SubagentOriginRegistry,
): Promise<boolean> {
  const domains = hostDomains(context)
  const permCtx = domains.permission

  if (!permCtx?.hook) {
    markUnsupported('permission-hook')
    return false
  }

  try {
    await permCtx.hook('evaluate', async (rawEvent: unknown) => {
      const event = rawEvent as V2PermissionEvent | null
      const effectBefore = event?.effect
      let origin: ReturnType<V2SubagentOriginRegistry['consume']>
      let decision: string | null = null
      let callerSessionParentID: unknown
      const writeProof = (): void => {
        const proofPath = process.env.PANTHEON_HOOK_CANARY_PERMISSION_PROOF
        if (!proofPath || !event || !Array.isArray(event.resources)) return
        try {
          appendFileSync(
            proofPath,
            `permission.evaluate ${JSON.stringify({
              action: event.action,
              resources: event.resources,
              agent: event.agent,
              sessionID: event.sessionID,
              callerSessionParentID: callerSessionParentID ?? null,
              source: event.source,
              matchedOrigin: origin ?? null,
              decision,
              effect: event.effect,
              message: event.message,
              eventFields: ['action', 'resources', 'agent', 'sessionID', 'source', 'effect'].filter(
                (key) => Object.hasOwn(event, key),
              ),
              effectBefore: effectBefore ?? null,
              effectAfter: event.effect ?? null,
            })}\n`,
          )
        } catch {
          // Instrumentation is best-effort and must not affect permission flow.
        }
      }
      const deny = (reason: string): void => {
        if (event === null || typeof event !== 'object') {
          throw new Error(
            `permission event is unavailable; denying V2 permission evaluation (${reason})`,
          )
        }
        event.effect = 'deny'
        event.message = `Pantheon delegation denied: ${reason}`
        if (event.effect !== 'deny') {
          throw new Error(
            `permission event is not mutable; denying V2 permission evaluation (${reason})`,
          )
        }
        writeProof()
      }

      if (event?.effect === 'deny') {
        writeProof()
        return // explicit host deny is final
      }
      if (event == null) {
        deny('permission event is missing')
        return
      }
      if (!Array.isArray(event.resources) || event.resources.length === 0) {
        deny('permission resources are missing or malformed')
        return
      }
      const targets = event.resources.map(v2ResourceTarget)
      if (targets.some((target) => target === undefined)) {
        deny('permission resource target is malformed')
        return
      }
      const hasPantheonTarget = targets.some((target) => PANTHEON_AGENTS.has(target ?? ''))
      let session: AuthoritativeSession | undefined
      if (hasPantheonTarget) {
        origin = subagentOrigins.consume(event)
        if (origin === undefined) {
          deny('matching host subagent tool origin is missing or stale')
          return
        }
        const sessionID = typeof event.sessionID === 'string' ? event.sessionID.trim() : ''
        if (!sessionID) {
          deny('caller session ID is missing')
          return
        }

        const sessionDomain = domains.session
        if (!sessionDomain || typeof sessionDomain.get !== 'function') {
          deny('session lookup API is unavailable')
          return
        }

        let retrieved: unknown
        try {
          retrieved = await sessionDomain.get({ sessionID })
        } catch {
          deny('caller session lookup failed')
          return
        }
        if (retrieved === null || retrieved === undefined) {
          deny('caller session was not found')
          return
        }
        if (typeof retrieved !== 'object' || Array.isArray(retrieved)) {
          deny('caller session lookup returned invalid data')
          return
        }
        session = retrieved as AuthoritativeSession
        callerSessionParentID = session.parentID
      }

      // Native-only resources remain under host policy. If a Pantheon target
      // appears anywhere, the shared policy evaluates the complete resource set.
      decision = evaluateV2Delegation(event, session, event.effect, origin)
      if (decision === 'deny') deny('caller or target is not allowed by delegation policy')
      else writeProof()
    })
    return true
  } catch {
    markUnsupported('permission-hook')
    return false
  }
}

// ─── Tool Definition Factory ─────────────────────────────────────────────

/**
 * Minimal structural view of the V2 tool draft.
 *
 * `output` is REQUIRED. The host (opencode 2.0.22) enforces a biconditional on
 * a tool's declared `output` and the value its `execute` resolves to:
 * `def.output === undefined` together with `'output' in result` throws
 * "Tool result declared output without an output schema", and a declared
 * `output` whose result omits the key throws "Tool did not return its
 * declared output". A missing declaration therefore fails every call, so the
 * field is mandatory here rather than optional.
 */
interface V2ToolDraft {
  namespace(config: { name: string; description: string }): void
  add(tool: {
    name: string
    description: string
    input: Record<string, unknown>
    output: Record<string, unknown>
    execute: (input: Record<string, unknown>, context: unknown) => Promise<V2ToolResult>
  }): void
}

export type { V2ToolDef, V2ToolResult } from './pantheon/v2-tools.ts'

// ─── Plugin Definition ───────────────────────────────────────────────────

/** Event type from V2 event stream. */
interface V2SessionEvent {
  type: string
  properties?: Record<string, unknown>
  data?: unknown
}

/** Opt-in trace used by the isolated F4A canary; never logs prompts or inputs. */
function writeV2AdmissionProof(label: string, detail: Record<string, unknown>): void {
  const proofPath = process.env.PANTHEON_HOOK_CANARY_PERMISSION_PROOF
  if (!proofPath) return
  try {
    appendFileSync(proofPath, `${label} ${JSON.stringify(detail)}\n`)
  } catch {
    // Proof is best-effort and must not affect admission behavior.
  }
}

async function prepareV2BoundedRead(
  context: PluginContext,
): Promise<ReturnType<typeof createV2BoundedReadTool> | undefined> {
  const host = hostDomains(context)
  const directory = host.location?.directory
  const projectID = host.location?.project?.id
  const session = host.session
  const permission = host.permission
  if (
    typeof directory !== 'string' ||
    directory.trim() === '' ||
    typeof projectID !== 'string' ||
    projectID.trim() === '' ||
    typeof session?.get !== 'function' ||
    typeof permission?.assert !== 'function' ||
    typeof host.event?.subscribe !== 'function' ||
    typeof host.tool?.transform !== 'function' ||
    typeof host.tool?.hook !== 'function'
  ) {
    markUnsupported('bounded-read')
    return undefined
  }

  const rootDirectory = await realpathAsync(directory).catch(() => undefined)
  if (rootDirectory === undefined) {
    markUnsupported('bounded-read')
    return undefined
  }

  return createV2BoundedReadTool({
    rootDirectory,
    projectID,
    getSession: (sessionID) => {
      if (typeof session.get !== 'function') throw new Error('session lookup unavailable')
      return session.get.call(session, { sessionID })
    },
    assertPermission: (request) => {
      if (typeof permission.assert !== 'function') throw new Error('permission API unavailable')
      return permission.assert.call(permission, request)
    },
    scanContent: async ({ content, agent, sessionID, callID }) => {
      try {
        const scan = await secretScanRunner({
          tool_name: BOUNDED_READ_TOOL,
          tool_input: { content },
          agent_id: agent,
          session_id: sessionID,
        })
        const decision = evaluateSecretScanResult(scan)
        if (decision.action === 'allow') return 'allow'
        const reason = decision.action === 'fail-closed' ? decision.reason : 'content-match'
        appendV2HookLog(
          `[SECRET SCAN] bounded read withheld session=${sessionID} callID=${callID} reason=${reason}`,
        )
        return decision.action === 'fail-closed' ? 'unavailable' : 'deny'
      } catch {
        appendV2HookLog(
          `[SECRET SCAN] bounded read withheld session=${sessionID} callID=${callID} reason=scanner-failure`,
        )
        return 'unavailable'
      }
    },
  })
}

/** Cleanup function type. */
type CleanupFn = () => void

/** Active cleanup handlers for the plugin lifecycle. */
const activeCleanups: CleanupFn[] = []

export const plugin = define({
  id: 'pantheon-opencode-v2',

  async setup(context: PluginContext): Promise<void> {
    // ─── Phase 0: V1→V2 bridge (issue #265) ────────────────────────────
    // First, because the event subscription below can deliver `session.idle`
    // as soon as it starts: a bridge installed after it would lose the first
    // idle of the process. Constructing it here is what makes
    // `resolveBridge()` non-null on a V2 install — before this, the factory
    // and the injector had no production call site at all.
    //
    // The returned enforcer (when the host session domain supports it) is the
    // single instance: Phase 7 asks it for pending todos and the idle path asks
    // it to continue, so there are never two.
    //
    // Guarded, because this phase is the only one that MUTATES the context:
    // `injectBridge` writes `ctx.options`, and an unguarded throw here would
    // reject `setup()` and remove every later registration with it — the read
    // guard, the secret scan and all tools. A degraded run is far better than a
    // plugin that registers nothing, and the degradation is reported (`v1-bridge`
    // in the live unsupported list) instead of being invisible.
    let idleEnforcer: TodoEnforcer | undefined
    try {
      idleEnforcer = installV2Bridge(context)
    } catch (error) {
      idleEnforcer = undefined
      markUnsupported('v1-bridge')
      if (!bridgeFailureLogged) {
        bridgeFailureLogged = true
        const reason = error instanceof Error ? error.message : String(error)
        appendV2HookLog(
          `[v1-bridge] construction failed; continuing without a bridge ` +
            `(idle continuation and todo context unavailable): ${reason}`,
        )
      }
    }

    // ─── Phase 1: V2 Transforms (isolated per-domain, best-effort) ────
    // Each transform registration is individually wrapped and settled via Promise.allSettled:
    // a rejection marks only that transform unsupported
    // and does not reject setup() or prevent later hook registrations.
    // See issue #92.
    //
    // Pantheon's Phase 1/config transform registrations cover agent, command,
    // and reference; ctx.tool.transform is attempted separately in Phase 2.
    // ctx.integration and ctx.skill are present on a live 2.0.22 host and neither
    // is registered here — that is a Pantheon scope choice, not a host gap.
    // ctx.catalog is the one domain the host does not provide.
    // Phase 1 registers against the SDK-typed `context.agent` / `.command` /
    // `.reference` directly; the host domains the SDK omits are reached only
    // through `hostDomains` (see the module header).
    const phase1Transforms: Array<{ feature: string; register: () => Promise<unknown> }> = [
      { feature: 'agent-transform', register: () => context.agent.transform(transformAgents) },
      {
        feature: 'command-transform',
        register: () => context.command.transform(transformCommands),
      },
      {
        feature: 'reference-transform',
        register: () => context.reference.transform(transformReferences),
      },
    ]
    const phase1Results = await Promise.allSettled(
      phase1Transforms.map((t) => Promise.resolve().then(() => t.register())),
    )
    phase1Results.forEach((result, index) => {
      // biome-ignore lint/style/noNonNullAssertion: index always in bounds — parallel arrays
      const feature = phase1Transforms[index]!.feature
      if (result.status === 'rejected') {
        markUnsupported(feature)
      }
    })

    const subagentOrigins = new V2SubagentOriginRegistry()
    const boundedRead = await prepareV2BoundedRead(context).catch(() => undefined)
    if (boundedRead === undefined) markUnsupported('bounded-read')

    // ─── Phase 2: V2 Event Subscription (best-effort) ────────────────
    const eventCleanup = subscribeV2Events(context, boundedRead?.clearSession)
    if (eventCleanup) {
      activeCleanups.push(eventCleanup)
    } else {
      markUnsupported('event-stream')
    }

    // ─── Phase 3: V2 Session Hooks (best-effort) ─────────────────────
    const sessionHooksRegistered = await registerV2SessionHooks(context).catch(() => false)
    if (!sessionHooksRegistered) {
      markUnsupported('session-hooks')
    }

    // ─── Phase 4: V2 Tool Hooks (best-effort) ────────────────────────
    const toolHookResult = await registerV2ToolHooks(
      context,
      subagentOrigins,
      boundedRead?.origins,
    ).catch(() => ({ registered: false, beforeRegistered: false }))
    if (!toolHookResult.registered) {
      markUnsupported('tool-execute-hooks')
    }

    // ─── Phase 5: V2 Tool Registration (best-effort) ─────────────────
    const boundedReadDefinition = toolHookResult.beforeRegistered
      ? boundedRead?.definition
      : undefined
    if (boundedRead !== undefined && boundedReadDefinition === undefined) {
      markUnsupported('bounded-read')
    }
    const toolsRegistered = await registerV2Tools(context, boundedReadDefinition).catch(() => false)
    if (!toolsRegistered) markUnsupported('tool-transform')

    // ─── Phase 6: V2 Permission Hook (best-effort) ───────────────────
    await registerV2PermissionHook(context, subagentOrigins).catch(() => false)

    // ─── Phase 7: V2 Compaction Hook (best-effort) ───────────────────
    const compactionCtx = hostDomains(context).session
    if (compactionCtx?.hook) {
      // File-based goal store, constructed once: the compaction context needs
      // active goals per session, and the store needs no host API (same
      // `.pantheon/goals` directory V1 uses).
      const goalStore = new GoalStore({ dir: '.pantheon/goals' })
      try {
        // 2.0.16 `SessionHooks` key is `compaction` (the migration doc maps
        // `experimental.session.compacting` → `ctx.session.hook("compaction")`).
        // `compacting` is not a valid key: the registry accepts any string and
        // silently drops unknown names, so the old name was a permanent no-op.
        // Proven by the canary's negative control.
        await compactionCtx.hook('compaction', async (event: unknown) => {
          try {
            // Opt-in lifetime proof for the host-backed hook canary
            // (tests/pantheon/plugin-v2-hook-canary.test.mjs, MODE=real). It is
            // inert unless PANTHEON_HOOK_CANARY_LIFETIME_PROOF is set, so
            // production behaviour is unchanged. This exists because a rename to
            // `compacting` was a silent no-op for an unknown length of time: the
            // canary can now observe that THIS registration fired.
            if (process.env.PANTHEON_HOOK_CANARY_LIFETIME_PROOF) {
              try {
                appendFileSync(
                  process.env.PANTHEON_HOOK_CANARY_LIFETIME_PROOF,
                  'plugin-v2:session.hook:compaction\n',
                )
              } catch {
                // Proof is best-effort: never let instrumentation break the host.
              }
            }

            // DCP dynamic context pruning (V2 only). This hook receives the
            // provider-bound array exactly before the summarization request,
            // and mutations are honored per request — the persisted session is
            // untouched. Apply the rules by default: it only changes what feeds
            // the summary. Never set `input.result`: the model must summarize
            // the pruned history, not be replaced by a canned summary.
            //
            // The host's compaction payload is
            // `{ session, agent, model, tools, system, messages, … }` — the id
            // is on `session.id`, NOT top-level `sessionID` (measured against
            // the 2.1.4 host; both spellings are accepted below).
            const payload = event as {
              sessionID?: unknown
              session?: { id?: unknown }
              messages?: unknown
              system?: unknown
            } | null
            const sessionID =
              typeof payload?.sessionID === 'string'
                ? payload.sessionID
                : typeof payload?.session?.id === 'string'
                  ? payload.session.id
                  : undefined
            const prunerConfig = resolveContextPrunerConfig(context.options)
            const stats = pruneMessages(payload?.messages, prunerConfig, 'compaction')
            logContextPrune(stats)
            logPruneShapeIssue(stats, sessionID, 'compaction')

            // Compaction context (V1 `experimental.session.compacting`
            // parity, #266). The SAME builder V1 uses — directive +
            // `<mission_context>` — pushed into the payload's `system` array,
            // which is the only text sink the V2 compaction hook exposes
            // (`context` is the session-hook name in V1, not a field here).
            //
            // The `<todo_context>` section is present only when the bridge
            // built a real enforcer (host session domain exposes the todo
            // listing), and `<tool_ceiling>` has no V2 producer at all — both
            // reductions are declared in the capability seed instead of
            // silently missing.
            const blocks = await buildCompactionContext({
              ...(sessionID === undefined ? {} : { sessionID }),
              goals: {
                // Same gate V1 uses: the goal loop is disabled in this build,
                // so `<mission_context>` is omitted on both surfaces.
                enabled: GOAL_LOOP_DEFAULTS.enabled,
                list: (id: string) => goalStore.list(id),
              },
              ...(idleEnforcer === undefined
                ? {}
                : {
                    todos: {
                      // V1's own source: `TodoEnforcer.listPendingTodos`.
                      enabled: todoEnforcerEnabledFromEnv(),
                      list: (id: string) => idleEnforcer.listPendingTodos(id),
                    },
                  }),
            })
            if (blocks.length > 0 && !appendSystemBlocks(payload, blocks)) {
              // The payload carried no usable `system`. Diagnostic once per
              // process: a silent miss here would look like "no goals".
              if (!compactionChannelWarned) {
                compactionChannelWarned = true
                appendV2HookLog(
                  '[compaction-context] payload.system is not a string or array; ' +
                    'compaction context could not be injected',
                )
              }
            }
          } catch (error) {
            // Fail-open: any unexpected shape or engine failure must not kill
            // the compaction request. One diagnostic line per session maximum.
            logPruneFailureOnce(
              (event as { sessionID?: unknown } | null)?.sessionID,
              'compaction',
              error,
            )
          }
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
 * The current list of unsupported V2 features.
 *
 * Read by the installer and by `doctor` (both via the shared seed in
 * `src/pantheon/v2-unsupported.mjs`) so the markers a user is shown are the
 * same ones this returns, rather than a hand-copied duplicate.
 *
 * This returns the LIVE array: the shared seed plus whatever `markUnsupported`
 * appended while this process talked to a real host.
 */
export function getUnsupportedFeatures(): readonly string[] {
  return V2_UNSUPPORTED_FEATURES
}

export default plugin
