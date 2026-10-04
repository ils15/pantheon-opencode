/**
 * Pantheon V2 Plugin — full orchestration plugin for OpenCode V2.
 *
 * Registers:
 * - 3 self-sufficient tools via V2 tool.transform (hashline_edit,
 *   pantheon_cost, pantheon_model — see ./pantheon/v2-tools.ts; the goal tools
 *   need V1 infrastructure and are absent from this surface)
 * - 4 event subscriptions (session.created, idle, error, compacted)
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

 * - A tool `execute.after` hook and a permission hook, registered as
 *   registration points with no V2-side behaviour
 *
 * Every tool registered through `draft.add` MUST declare `output`, and its
 * `execute` MUST resolve to a value carrying `output`. The host enforces the
 * two as a pair — see `V2ToolDraft` for the exact contract.
 *
 * ## The four domains the SDK types do not carry
 *
 * `@opencode-ai/plugin` 1.18.33 types `PluginContext` as exactly:
 *   options · agent · aisdk · catalog · command · integration · plugin ·
 *   reference · skill
 * — no `tool`, `event`, `permission` or `session`. 1.18.34 (`latest`) is the
 * same, so following the stable SDK line does not resolve this: it is a
 * STRUCTURAL DECLARATION task, not a pin reconciliation.
 *
 * A live opencode 2.0.22 host DOES have all four, with the shapes this module
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
 * If the SDK ever exposes these four, replacing `hostDomains` with the real
 * type is a one-line change. Do NOT make that change while 1.18.x lacks them.
 *
 * V2_UNSUPPORTED_FEATURES distinguishes adapter limitations from observed
 * host-absent APIs; setup handles optional registrations on a best-effort basis.
 *
 * @module plugin-v2
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  AgentDraft,
  CommandDraft,
  PluginContext,
  ReferenceDraft,
} from '@opencode-ai/plugin/v2/promise'
import { define } from '@opencode-ai/plugin/v2/promise'
import {
  createEnforcementGuard,
  readOnlyRegistry,
  syncReadOnlySession,
  type ToolExecuteBeforeInput,
  type ToolExecuteBeforeOutput,
} from './pantheon/delegation-enforce.ts'
import {
  getV2BridgeFromContext,
  type PantheonV2Bridge,
  type V2ContextLike,
} from './pantheon/v2-bridge.ts'
import { createV2ToolDefinitions, type V2ToolResult } from './pantheon/v2-tools.ts'
import { V2_UNSUPPORTED_FEATURE_SEED } from './pantheon/v2-unsupported.mjs'
import { type HookPayload, runHook } from './plugins/hook-runner.ts'

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
 * Only a hook name and a handler: the plugin registers `evaluate` as a
 * registration point and deliberately runs no V2-side permission logic, so no
 * richer payload type is claimed here.
 */
interface V2PermissionDomain {
  hook?: (name: string, handler: (event: unknown) => void | Promise<void>) => Promise<unknown>
}

/**
 * The minimal shape of `ctx.session`.
 *
 * Only `hook(name, handler)`. The host accepts any string and silently drops an
 * unknown one — which is why the hook names below were a live defect once and
 * why the host-backed hook canary exists.
 */
interface V2SessionDomain {
  hook?: (name: string, handler: (event: unknown) => void | Promise<void>) => Promise<unknown>
}

/** `PluginContext` plus the four domains 1.18.x omits. See the module header. */
interface HostPluginContext extends PluginContext {
  tool?: V2ToolDomain
  event?: V2EventDomain
  permission?: V2PermissionDomain
  session?: V2SessionDomain
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
async function registerV2Tools(context: PluginContext): Promise<boolean> {
  const toolCtx = hostDomains(context).tool

  if (!toolCtx?.transform) {
    return false
  }

  try {
    // Tool definitions carry their own `output` declaration; the draft requires
    // it, and the host rejects a definition whose result shape cannot satisfy
    // the declaration it makes.
    const toolDefs = createV2ToolDefinitions()

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
function subscribeV2Events(context: PluginContext): (() => void) | undefined {
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

/**
 * Session-created handler: currently a no-op on the V2-only surface.
 *
 * V1 seeds session state here (`sessionHierarchy.register(info)` plus the
 * root-session set) from the full session metadata carried by its own event.
 * The V2 event does not carry that metadata, and — more to the point — V1 is a
 * separate plugin instance that is not loaded when only `plugin-v2` is
 * configured. So nothing runs here on a V2-only install. Do not read the bridge
 * check below as coverage: a non-null bridge means a host process that ALSO
 * loaded V1, and V1 does the seeding itself.
 *
 * The absent hierarchy seed is why the V2 enforcement guard is built without
 * `isRootSession` / `isChildSession`; see `docs/UPGRADING.md`, "Known
 * limitation — V2 enforcement covers the blocked-tool list, not the V1
 * delegation matrix".
 */
async function onSessionCreated(_event: V2SessionEvent): Promise<void> {
  const _bridge = resolveBridge()
  if (_bridge?.board != null) {
    // Bridge present ⇒ this process also loaded V1, whose own event hook owns
    // root-session registration. Intentionally nothing to do on the V2 side.
  }
}

async function onSessionIdle(_event: V2SessionEvent): Promise<void> {
  // Idle continuation — goal loop / todo enforcer dispatch. This one really
  // does delegate: `bridge.todoEnforcer` is the V1 enforcer instance, reached
  // only in a process that also loaded V1. On a V2-only install the bridge
  // resolves to null and idle continuation does not run.
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
 * Register session hooks via V2 ctx.session.hook.
 *
 * The V2 session.hook API (when available) provides:
 *   ctx.session.hook("prompt", handler)  — message admission
 *   ctx.session.hook("context", handler) — system context injection
 *
 * Returns true if any hooks were registered.
 */
async function registerV2SessionHooks(context: PluginContext): Promise<boolean> {
  const sessionCtx = hostDomains(context).session

  if (!sessionCtx?.hook) {
    return false
  }

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
        const ctx = event as { system?: unknown } | null | undefined
        if (ctx == null) return
        const normalized = normalizeSystemToParts(ctx.system)
        if (normalized == null) return
        // A bare string is replaced by its part array; an array is mutated in
        // place (the host may read the original reference).
        if (typeof ctx.system === 'string') ctx.system = normalized
        if (!hasPolicyMarker(normalized)) {
          normalized.push({ type: 'text', text: POLICY } satisfies SystemPart)
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
    // "prompt" hook — vision message interception
    await sessionCtx.hook('prompt', (_event: unknown) => {
      // Vision interception. No V2-side implementation: the handler lives in
      // the V1 path (`vision.chatMessage`), which is not loaded on a V2-only
      // install. This is a permanent no-op there, not a graceful degradation —
      // nothing is delegated, because there is nothing here to delegate to.
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
 * Deliberately NOT passed `getSessionAgent` / `isRootSession` / `isChildSession`:
 * those drive V1's native-`task()` delegation matrix, which needs a session
 * hierarchy seeded from session metadata. `SessionHierarchyRegistry.isRoot`
 * reports `true` for unknown sessions while unseeded, so passing an unseeded
 * predicate here would DENY every `task()` call in every session. Leaving them
 * out skips that branch (the guard tests `options?.isRootSession !== undefined`).
 * `task` is still denied inside a read-only session via the blocked-tool list,
 * so depth-2 holds for apollo/gaia; the caller/target matrix itself is NOT
 * enforced on V2. That is a known gap, not a covered case.
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
 * Register tool execution hooks via V2 ctx.tool.hook.
 *
 * The V2 tool.hook API (when available) provides:
 *   ctx.tool.hook("execute.before", handler) — pre-execution guard
 *   ctx.tool.hook("execute.after", handler)  — post-execution augment
 *
 * Returns true if any hooks were registered.
 */
async function registerV2ToolHooks(context: PluginContext): Promise<boolean> {
  const toolCtx = hostDomains(context).tool

  if (!toolCtx?.hook) {
    return false
  }

  let registered = false

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
      const { input, output, agent } = adaptV2ExecuteBeforeEvent(event)
      // V2's equivalent of V1's `chat.params` trigger: the host puts the active
      // agent on the event itself, so registering here needs no separate hook
      // and no session→agent map. A non-read-only (or absent) agent revokes the
      // registration, which also covers an in-session agent switch.
      syncReadOnlySession(readOnlyRegistry, input.sessionID, agent)
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
      // exit 2 → block. exit 1 (low-confidence header/KEY names) → advisory,
      // logged only. A scanner failure (missing script, timeout) is fail-OPEN:
      // runHook never rejects, and an infrastructure error must not deny
      // unrelated tool calls.
      let blockError: Error | null = null
      try {
        const payload: HookPayload = {
          tool_name: input.tool,
          tool_input: output.args ?? {},
          agent_id: typeof agent === 'string' ? agent : '',
          session_id: input.sessionID,
        }
        const scan = await runHook('scan-secrets.sh', payload)
        if (scan.code === 2) {
          appendV2HookLog(SECRET_BLOCK_MESSAGE)
          appendV2HookLog(scan.stderr)
          blockError = new Error(SECRET_BLOCK_MESSAGE)
        } else if (scan.code === 1) {
          // Advisory: log only, never block.
          appendV2HookLog(scan.stderr)
        }
      } catch {
        // Never let the scanner take down the session — runHook resolves a
        // structured result instead of rejecting, so this is belt-and-braces.
      }
      if (blockError !== null) throw blockError
    })
    registered = true
  } catch {
    // Tool before-hook not supported
  }

  try {
    // "execute.after" — hashline read enhance + context sandbox.
    //
    // Registration point only: there is no V2-side behaviour here. The
    // enhancer/sandbox live in the V1 path (`pantheon-hooks.ts` +
    // `context-sandbox.ts`), a separate plugin instance that is not loaded when
    // only `plugin-v2` is configured.
    await toolCtx.hook('execute.after', (_event: unknown) => {
      // Intentionally empty.
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
  const permCtx = hostDomains(context).permission

  if (!permCtx?.hook) {
    markUnsupported('permission-hook')
    return false
  }

  try {
    await permCtx.hook('evaluate', (_event: unknown) => {
      // Registration point only — no V2-side permission logic. Read-only
      // enforcement does NOT run here: it runs in the `execute.before` handler
      // above, which is the hook the host consults before a tool executes. Do
      // not read this as "the V1 guards cover it": V1 is a different plugin
      // instance and is not loaded when only `plugin-v2` is configured.
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
}

/** Cleanup function type. */
type CleanupFn = () => void

/** Active cleanup handlers for the plugin lifecycle. */
const activeCleanups: CleanupFn[] = []

export const plugin = define({
  id: 'pantheon-opencode-v2',

  async setup(context: PluginContext): Promise<void> {
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
    // `.reference` directly; the four domains the SDK omits are reached only
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
    const compactionCtx = hostDomains(context).session
    if (compactionCtx?.hook) {
      try {
        // 2.0.16 `SessionHooks` key is `compaction` (the migration doc maps
        // `experimental.session.compacting` → `ctx.session.hook("compaction")`).
        // `compacting` is not a valid key: the registry accepts any string and
        // silently drops unknown names, so the old name was a permanent no-op.
        // Proven by the canary's negative control.
        await compactionCtx.hook('compaction', (_event: unknown) => {
          // Compaction context build — injects active goals, pending todos,
          // and in-flight delegations. No V2-side implementation: that build
          // lives in the V1 path, which is not loaded on a V2-only install.
          // This registration is a real hook (the canary below proves it
          // fires) with no V2 behaviour behind it.
          //
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
