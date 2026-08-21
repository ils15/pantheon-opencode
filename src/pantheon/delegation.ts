/**
 * Delegation Core (Phase 2) — the three background-delegation tools plus the
 * finalize lifecycle hook, built on the BackgroundJobBoard.
 *
 * Tools (STRUCTURAL shape — matches what opencode expects: `{description,
 * args (zod shape), execute(args, ctx)}`; zod is imported directly — the
 * `@opencode-ai/plugin` package is a devDep and is NEVER runtime-imported):
 *   - `pantheon_delegate({prompt, agent, description?})` — create a child
 *     session (parentID = caller), register it on the board, arm a timeout,
 *     and fire-and-forget `session.promptAsync` on the child (NO noReply —
 *     the spike refuted noReply as a push mechanism). Completion is observed
 *     via `session.idle` on the child and finalized through
 *     `finalizeDelegation` (exposed on the toolset for the Phase 3 event hook).
 *   - `pantheon_delegation_read({id})` — block via `board.waitForTerminal`,
 *     return the report markdown, mark the job reconciled.
 *   - `pantheon_delegation_list()` — job list with `[unread]` for terminal-
 *     unreconciled jobs.
 *
 * Depth guard (root-session detection): the ToolContext carries NO parentID
 * (spike), so root detection is configurable. Resolution order:
 *   1. `options.isRootSession(sessionID)` custom predicate;
 *   2. `options.rootSessions` explicit allowlist, with `options.isChildSession`
 *      authoritative when supplied by the plugin. SDK session metadata is
 *      registered from parentID; no prompt/name inference is used.
 *   3. default (no rootSessions): any session WE created via
 *      `session.create` is a sub-session; everything else is treated as
 *      root for standalone compatibility. The plugin supplies the SDK-backed
 *      hierarchy at runtime.
 *
 * Read-only enforcement is Phase 4 — `read_only` is exposed on the delegate
 * args and the child session is registered in the read-only registry when the
 * delegate is read-only (explicit flag or agent ∈ readOnlyAgents), which the
 * plugin's `tool.execute.before` guard enforces.
 *
 * @module delegation
 */

import { z } from 'zod'

import type { BackgroundJobBoard, BackgroundJobRecord } from './background-job-board.ts'
import {
  isDelegationAllowed,
  normalizeDelegationAgent,
  readOnlyRegistry,
} from './delegation-enforce.ts'
import {
  DELEGATION_DEFAULTS,
  type DelegationClient,
  type DelegationDeps,
  type DelegationMessageBundle,
  type DelegationOptions,
  type FinalizeInput,
  finalizeDelegation as finalizeDelegationReport,
  readDelegationReport,
} from './delegation-finalize.ts'
import { createPantheonLogger } from './logger.ts'
import { missingProviderKeyEnv, resolveActivePreset } from './presets.mjs'

export type {
  DelegationClient,
  DelegationClientSession,
  DelegationMessageBundle,
  DelegationOptions,
  FinalizeInput,
} from './delegation-finalize.ts'
export { DELEGATION_DEFAULTS } from './delegation-finalize.ts'

// Fase B3: these are runtime controls, not routing/frontmatter fields. The
// plugin reads them from the environment, while tests and embedders can pass
// the same values through DelegationOptions.
export const B3_DEFAULT_EXCEPTION_BUDGET = 5

function readIntegerEnv(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  minimum: number,
): number {
  const raw = env[name]?.trim()
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback
}

/** Resolve the two supported read-only delegation exception budgets. */
export function resolveDelegationBudgets(
  env: Record<string, string | undefined> = process.env,
): ReadonlyMap<string, number> {
  return new Map([
    [
      'athena->apollo',
      readIntegerEnv(env, 'PANTHEON_ATHENA_APOLLO_BUDGET', B3_DEFAULT_EXCEPTION_BUDGET, 0),
    ],
    [
      'hermes->apollo',
      readIntegerEnv(env, 'PANTHEON_HERMES_APOLLO_BUDGET', B3_DEFAULT_EXCEPTION_BUDGET, 0),
    ],
  ])
}

/** Resolve an optional positive wall-clock timeout from the environment. */
export function resolveDelegationTimeoutMs(
  env: Record<string, string | undefined> = process.env,
): number | undefined {
  const raw = env.PANTHEON_DELEGATION_TIMEOUT_MS?.trim()
  if (raw === undefined || raw === '') return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

// ─── Types ─────────────────────────────────────────────────────────────

// Silence-by-default TUI policy (pantheon-hooks L42-58): console output in a
// plugin renders into the opencode TUI — the "lixo". Errors go to
// .pantheon/logs/hooks.log; console echo is opt-in via PANTHEON_HOOKS_LOG=1.
const log = createPantheonLogger({ module: 'pantheon-delegate' })

/** Structural view of the tool context opencode passes to execute(). */
export interface ToolContextLike {
  sessionID: string
  directory?: string
  worktree?: string
  /**
   * The OpenCode SDK's ToolContext declares this as required. It remains
   * optional here because the structural test/embedding surface can be
   * supplied by older hosts; B3 must skip enforcement when it is absent.
   */
  agent?: string
}

/** A delegation tool: description + zod args shape + execute. */
export interface DelegationTool<Args extends z.ZodRawShape = z.ZodRawShape> {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, ctx: ToolContextLike): Promise<string>
}

/** The full toolset returned by createDelegationTools(). */
export interface DelegationToolset {
  pantheon_delegate: DelegationTool<typeof delegateArgs>
  pantheon_delegation_read: DelegationTool<typeof readArgs>
  pantheon_delegation_list: DelegationTool<typeof listArgs>
  /** Lifecycle hook for the Phase 3 event wiring (session.idle on the child). */
  finalizeDelegation: (
    childSessionID: string,
    opts: FinalizeInput,
  ) => Promise<BackgroundJobRecord | undefined>
}

/** Input for createDelegationTools(). */
export interface CreateDelegationToolsInput {
  board: BackgroundJobBoard
  client: DelegationClient
  options?: DelegationOptions
}

// ─── Args schemas ──────────────────────────────────────────────────────

const delegateArgs = {
  prompt: z.string().min(1).describe('Task prompt delivered to the background agent.'),
  agent: z.string().min(1).describe('Agent name, e.g. "apollo" or "hermes".'),
  description: z.string().optional().describe('Human-readable description shown on the job board.'),
  read_only: z.boolean().optional().describe('Advisory flag for Phase 4 read-only enforcement.'),
  model: z
    .string()
    .optional()
    .describe(
      'Explicit model for the child session (provider/model, e.g. "opencode/deepseek-v4-flash-free").',
    ),
} satisfies z.ZodRawShape

const readArgs = {
  id: z.string().min(1).describe('Job alias (e.g. "apo-1") or task ID to read.'),
} satisfies z.ZodRawShape

const listArgs = {} satisfies z.ZodRawShape

// ─── State labels ──────────────────────────────────────────────────────

function stateLabel(state: BackgroundJobRecord['state']): string {
  switch (state) {
    case 'running':
      return 'RUNNING'
    case 'completed':
      return 'OK'
    case 'error':
      return 'ERR'
    case 'cancelled':
      return 'CANCELLED'
    case 'reconciled':
      return 'RECONCILED'
  }
}

/** Normalize the SDK-provided caller agent without inventing an identity. */
const normalizeToolAgent = normalizeDelegationAgent

// ─── Agent activity sampling ────────────────────────────────────────────
//
// Visibility for `pantheon_delegation_read` / `pantheon_delegation_list`
// (issue: the read blocks silently while the child works). While a read waits
// on `waitForTerminal` it periodically samples the CHILD session's messages
// via the same `client.session.messages` the finalize path uses, and the
// collected lines are appended to the report as `## Agent Activity`.
//
// Fail-open by design: a missing/throwing `session.messages` (or empty
// response) degrades to the current behavior — report without a section —
// and NEVER breaks the read. No streaming/SSE, no persistent timers: the
// poll lives inside the read's existing wait and is cleared when it settles.

/** Cap for one activity line (~200 chars, spec). */
const ACTIVITY_LINE_MAX = 200
/** How often the read re-samples child activity while waiting (ms). */
const ACTIVITY_POLL_MS = 2000
/** Keep only the latest N readable entries per sample. */
const ACTIVITY_LINES = 3

/**
 * Mutable collector shared between the wait loop and the read result.
 * `sampled` distinguishes "messages unavailable/never succeeded" (fail-open
 * → NO activity section, current behavior) from "messages OK but nothing
 * readable" (→ `_no activity captured_` section).
 */
interface ActivityCollector {
  /** Readable activity lines captured so far (latest window). */
  lines: string[]
  /** True once session.messages returned a bundle list at least once. */
  sampled: boolean
}

/** Collapse whitespace and cap a single line at ~200 chars. */
function truncateActivityLine(text: string, max = ACTIVITY_LINE_MAX): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  return `${clean.slice(0, max - 1)}…`
}

/** Readable tool args from a tool part (SDK ToolPart.metadata.input), or ''. */
function toolArgsFromPart(part: { metadata?: { input?: unknown } }): string {
  const meta = part.metadata
  const raw = meta !== undefined && 'input' in meta ? meta.input : meta
  if (raw === undefined) return ''
  try {
    const s = typeof raw === 'string' ? raw : JSON.stringify(raw)
    return s === '' || s === '{}' ? '' : s
  } catch {
    return ''
  }
}

/**
 * One readable activity line per message bundle — tool calls first (highest
 * signal), then the first non-empty text part. Image/attachment/reasoning
 * parts are skipped (only `text` and `tool` parts are user-visible).
 */
function activityLineFromBundle(bundle: DelegationMessageBundle): string | undefined {
  const role = bundle.info?.role
  const parts = bundle.parts ?? []
  for (const part of parts) {
    if (part.type === 'tool' && typeof part.tool === 'string' && part.tool !== '') {
      const args = toolArgsFromPart(part)
      return truncateActivityLine(`tool: ${part.tool}${args !== '' ? ` ${args}` : ''}`)
    }
  }
  for (const part of parts) {
    if (part.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') {
      const label = role === 'user' ? 'user' : 'assistant'
      return truncateActivityLine(`${label}: ${part.text.trim()}`)
    }
  }
  return undefined
}

/**
 * Sample the child's latest readable activity into `collector` (replace
 * window). Fail-open: unavailable/throwing messages leaves the collector
 * untouched (previous lines, or none → `_no activity captured_`), while a
 * successful (even empty) response marks the collector as sampled.
 */
async function sampleChildActivity(
  client: DelegationClient,
  childSessionID: string,
  collector: ActivityCollector,
): Promise<void> {
  if (typeof client.session.messages !== 'function') return
  try {
    const bundles = await client.session.messages({ path: { id: childSessionID } })
    if (!Array.isArray(bundles)) return
    collector.sampled = true
    if (bundles.length === 0) return
    const fresh = bundles
      .map((b) => activityLineFromBundle(b))
      .filter((l): l is string => l !== undefined)
      .slice(-ACTIVITY_LINES)
    if (fresh.length > 0) {
      collector.lines.length = 0
      collector.lines.push(...fresh)
    }
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    log.warn(`[pantheon-delegate] activity sample failed (fail-open): ${reason}`)
  }
}

/** Last readable activity line for a child, or undefined when unavailable. */
async function lastChildActivity(
  client: DelegationClient,
  childSessionID: string,
): Promise<string | undefined> {
  if (typeof client.session.messages !== 'function') return undefined
  try {
    const bundles = await client.session.messages({ path: { id: childSessionID } })
    if (!Array.isArray(bundles)) return undefined
    for (let i = bundles.length - 1; i >= 0; i--) {
      const bundle = bundles[i]
      if (bundle === undefined) continue
      const line = activityLineFromBundle(bundle)
      if (line !== undefined) return line
    }
    return undefined
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    log.warn(`[pantheon-delegate] last activity fetch failed (fail-open): ${reason}`)
    return undefined
  }
}

/**
 * Wait for a terminal board state while sampling the child's activity every
 * ACTIVITY_POLL_MS (first sample fires immediately — a quick finalize can
 * still capture something). The interval is cleared when the wait settles;
 * collection never delays the terminal resolution.
 */
async function waitForTerminalWithActivity(
  board: BackgroundJobBoard,
  client: DelegationClient,
  taskID: string,
  timeoutMs: number,
  collector: ActivityCollector,
): Promise<BackgroundJobRecord> {
  void sampleChildActivity(client, taskID, collector)
  const timer = setInterval(() => {
    void sampleChildActivity(client, taskID, collector)
  }, ACTIVITY_POLL_MS)
  timer.unref()
  try {
    return await board.waitForTerminal(taskID, timeoutMs)
  } finally {
    clearInterval(timer)
  }
}

/** Render the trailing activity section appended to the read result. */
export function formatActivitySection(lines: string[]): string {
  if (lines.length === 0) return '## Agent Activity\n\n_no activity captured_'
  return `## Agent Activity\n\n${lines.map((l) => `- ${l}`).join('\n')}`
}

// ─── Model resolution ──────────────────────────────────────────────────

/** Session model ref accepted by the opencode server's session.create. */
export interface ChildSessionModelRef {
  id: string
  providerID: string
}

/**
 * Known-good fallback model (P1, 2026-08-11 — release 1.3.4, updated
 * 2026-08-21 for sandbox without PANTHEON_OPENCODE_API_KEY): when an
 * AUTO-RESOLVED model (routing.yml agent entry / active preset) points at a
 * provider whose API key is not configured, the child is dispatched on the
 * `opencode-go` provider instead — `opencode-go/deepseek-v4-flash`
 * via https://opencode.ai/zen/go/v1 works without an external API key
 * (Go subscription / opencode auth, sandbox default). Validated with the
 * same providerKeyConfigured gate as the resolved model, with an
 * opencode-go exception for the sandbox; an explicit caller-supplied
 * `model` always wins over this fallback.
 */
const FALLBACK_MODEL = 'opencode-go/deepseek-v4-flash'

/**
 * Split a `provider/model` model ID (e.g. `opencode/deepseek-v4-flash-free`)
 * into the `{ id, providerID }` ref the session.create body expects.
 * Returns undefined for malformed IDs (no slash, empty segments).
 */
function splitModelRef(model: string): ChildSessionModelRef | undefined {
  const slash = model.indexOf('/')
  if (slash <= 0 || slash === model.length - 1) return undefined
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) }
}

/**
 * Resolve the child session model with priority:
 *   1. explicit `model` option passed to the delegate tool;
 *   2. `options.agentModels[agent]` (routing.yml agent entry, case-insensitive);
 *   3. the active preset's agent entry via resolveActivePreset();
 *   4. fallback: undefined — the child is created without a model (the
 *      caller warns) so opencode's default applies.
 */
function resolveChildModel(
  options: DelegationOptions,
  agent: string,
  explicitModel?: string,
): ChildSessionModelRef | undefined {
  // (a) explicit model option on the delegate tool call
  if (explicitModel !== undefined && explicitModel !== '') {
    const ref = splitModelRef(explicitModel)
    if (ref !== undefined) return ref
  }
  const key = agent.toLowerCase()
  // (b) routing.yml agent entry wired through options.agentModels
  const mapped = options.agentModels?.[key]
  if (mapped !== undefined && mapped !== '') {
    const ref = splitModelRef(mapped)
    if (ref !== undefined) return ref
  }
  // (c) active preset agent entry (resolveActivePreset reads routing.yml
  // presets + .pantheon/active-preset.json). Guarded — a broken routing.yml
  // must never kill the delegate.
  try {
    const presetModel = resolveActivePreset({
      ...(options.presetEnv !== undefined ? { env: options.presetEnv } : {}),
      ...(options.logger !== undefined ? { logger: options.logger } : {}),
    })?.agents?.[key]?.model
    if (presetModel !== undefined && presetModel !== '') {
      const ref = splitModelRef(presetModel)
      if (ref !== undefined) return ref
    }
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    options.logger?.warn?.(`[pantheon-delegate] active preset resolution failed: ${reason}`)
  }
  return undefined
}

/**
 * Resolve a USABLE child model for a delegate dispatch, gating the resolved
 * provider's API key (P1, 2026-08-11 — release 1.3.4):
 *
 *   1. resolve the model with the existing precedence (explicit `model` >
 *      options.agentModels > active preset) — see resolveChildModel.
 *   2. provider key gate: the resolved provider requires its apiKeyEnv env
 *      var (routing.yml preset defs — same source applyPreset enforces at
 *      startup). No gate (native providers) or key present → usable as-is.
 *   3. key MISSING + EXPLICIT caller model → respected anyway (user intent),
 *      warned.
 *   4. key MISSING + AUTO-resolved model → fall back to FALLBACK_MODEL
 *      (validated the same way). Fallback also unusable → returns an `error`
 *      TEXT (the caller returns it from the tool — never throws) and the
 *      caller registers NO job on the board.
 *
 * The no-model case (nothing resolved) keeps the pre-existing behavior:
 * warn and let the child use opencode's default.
 *
 * @returns `{ model, error }` — at most one of `model` / `error` is set;
 *   both may be unset (no model resolved, warn emitted).
 */
function resolveUsableChildModel(
  options: DelegationOptions,
  agent: string,
  explicitModel: string | undefined,
): { model: ChildSessionModelRef | undefined; error: string | undefined } {
  const env = options.presetEnv ?? process.env
  const explicit = explicitModel !== undefined && explicitModel !== ''
  const warn = (msg: string) => options.logger?.warn?.(msg)

  const model = resolveChildModel(options, agent, explicitModel)
  if (model === undefined) {
    warn(
      `[pantheon-delegate] no model resolved for agent "${agent}" — ` +
        "child session will use opencode's default model (may require API keys)",
    )
    return { model: undefined, error: undefined }
  }

  const missingVar = missingProviderKeyEnv(model.providerID, { env })
  if (missingVar === undefined) return { model, error: undefined }

  if (explicit) {
    // Rule of precedence: the caller's explicit model is respected — warn only.
    warn(
      `[pantheon-delegate] model "${explicitModel}" provider "${model.providerID}" requires ` +
        `API key ${missingVar} (unset) — respecting the explicit model anyway`,
    )
    return { model, error: undefined }
  }

  // Auto-resolved (agentModels / preset) → try the known-good fallback.
  const fallback = splitModelRef(FALLBACK_MODEL)
  if (fallback !== undefined && (fallback.providerID === 'opencode-go' || missingProviderKeyEnv(fallback.providerID, { env }) === undefined)) {
    warn(
      `[pantheon-delegate] provider "${model.providerID}" requires API key ${missingVar} ` +
        `(unset) — falling back to ${FALLBACK_MODEL}`,
    )
    return { model: fallback, error: undefined }
  }

  const message =
    `pantheon_delegate: no usable model for agent "${agent}" — provider "${model.providerID}" ` +
    `requires API key (set ${missingVar} or PANTHEON_MODEL_PRESET)`
  warn(`[pantheon-delegate] ${message}`)
  return { model: undefined, error: message }
}

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Pure helper: collect the IDs of root sessions (parentID === undefined)
 * from a session list. Used to SEED the depth-guard allowlist at startup —
 * opencode does not replay `session.created` events for sessions that exist
 * before plugin load, so a resumed root would never enter `rootSessions`
 * and the depth guard would reject its pantheon_delegate calls after a
 * restart. Fail-open contract lives at the call site (plugin.ts): a failed
 * `session.list()` leaves the registry untouched, never crashes startup.
 */
export function collectRootSessionIDs(
  sessions: ReadonlyArray<{ id: string; parentID?: string }>,
): Set<string> {
  const roots = new Set<string>()
  for (const session of sessions) {
    if (session.parentID === undefined) roots.add(session.id)
  }
  return roots
}

/**
 * Build the delegation toolset. Keeps per-instance state: the set of child
 * sessions WE created (depth-guard default) and the per-job timeout timers
 * (cleared on finalize, `.unref()`'d so they never hold the process open).
 */
export function createDelegationTools(input: CreateDelegationToolsInput): DelegationToolset {
  const { board, client } = input
  // Runtime matrix enforcement is the safe default for every host. A legacy
  // structural embedder must opt out explicitly with `false`; omission must
  // never silently widen the delegation surface.
  const options: DelegationOptions = { enforceRuntimeMatrix: true, ...(input.options ?? {}) }
  const deps: DelegationDeps = { board, client, options }
  const outputDir = options.outputDir ?? DELEGATION_DEFAULTS.outputDir
  const timeoutMs = options.wallClockTimeoutMs ?? options.timeoutMs ?? DELEGATION_DEFAULTS.timeoutMs
  const readTimeoutMs = options.readTimeoutMs ?? DELEGATION_DEFAULTS.readTimeoutMs

  const knownChildren = new Set<string>()
  const timers = new Map<string, NodeJS.Timeout>()
  // Fase B3: per-parent-session delegation budget tracking, scoped to this
  // factory/process instance. Keyed by `${parentSessionID}:${parentAgent}->${targetAgent}`;
  // it is not restart-persistent because the factory has no reliable store.
  const budgetUsage = new Map<string, number>()

  function isRootSession(sessionID: string): boolean {
    if (options.isChildSession?.(sessionID) === true) return false
    if (options.isRootSession !== undefined) return options.isRootSession(sessionID)
    if (options.rootSessions !== undefined) {
      // compaction-134 (fix layer 2): the allowlist alone is NOT
      // authoritative. opencode does not replay `session.created` events for
      // pre-existing sessions, so after a restart the resumed root never
      // entered rootSessions (the plugin seeds it from session.list() at
      // startup, but that seed is fail-open). A session is a sub-session
      // ONLY if WE created it as a child (knownChildren — filled on every
      // pantheon_delegate dispatch). Everything unknown is treated as root:
      // resumed/unknown sessions can delegate, while the real depth guard
      // (a child of a delegate cannot re-delegate) is preserved.
      return options.rootSessions.has(sessionID) || !knownChildren.has(sessionID)
    }
    return !knownChildren.has(sessionID)
  }

  function clearTimer(childSessionID: string): void {
    const timer = timers.get(childSessionID)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(childSessionID)
    }
  }

  /** Bound finalize: clear the job timer, then run the report + transition. */
  async function finalize(
    childSessionID: string,
    opts: FinalizeInput,
  ): Promise<BackgroundJobRecord | undefined> {
    clearTimer(childSessionID)
    return finalizeDelegationReport(deps, childSessionID, opts)
  }

  const pantheon_delegate: DelegationTool<typeof delegateArgs> = {
    description:
      'Dispatch a background agent as a child session and register it on the job board. ' +
      'Returns the readable alias (e.g. "apo-1"); read the result with ' +
      'pantheon_delegation_read. Only root sessions may delegate.',
    args: delegateArgs,
    execute: async (args, ctx) => {
      if (!isRootSession(ctx.sessionID)) {
        throw new Error(
          `pantheon_delegate rejected: session ${ctx.sessionID} is a sub-session — only root sessions can delegate`,
        )
      }
      if (!board.canDispatch(args.agent)) {
        throw new Error(
          `pantheon_delegate rejected: concurrency limit reached for agent "${args.agent}" ` +
            `(${board.getRunningCount(args.agent)} running)`,
        )
      }

      // Fase B3: only the two read-only exceptions are budgeted. The official
      // SDK provides the current agent on ToolContext. If a structural/older
      // host omits it, do NOT infer identity from prompt, target, or process
      // state: the budget is explicitly skipped and the delegation continues.
      const parentAgent = normalizeToolAgent(ctx.agent)
      const targetAgent = args.agent.toLowerCase()
      if (options.enforceRuntimeMatrix === true && !isDelegationAllowed(parentAgent, targetAgent)) {
        const reason =
          parentAgent === undefined
            ? 'ToolContext.agent is unavailable'
            : `${parentAgent}->${targetAgent} is not allowed`
        options.logger?.warn?.(
          `[pantheon-delegate] runtime delegation denied for session ${ctx.sessionID}: ${reason}`,
        )
        throw new Error(`pantheon_delegate rejected: runtime delegation matrix denied (${reason})`)
      }
      if (
        parentAgent === undefined &&
        !options.enforceRuntimeMatrix &&
        (options.delegationBudgets?.size ?? 0) > 0
      ) {
        const message =
          `[pantheon-delegate] B3 budget skipped: current agent unavailable for session ${ctx.sessionID}; ` +
          `no budget limit applied to ${targetAgent}. Runtime must provide ToolContext.agent ` +
          '(the official SDK field) to enforce the configured exception budget.'
        ;(options.logger?.warn ?? ((msg: string) => log.warn(msg)))(message)
      }
      const budgetKey =
        parentAgent === undefined ? undefined : `${ctx.sessionID}:${parentAgent}->${targetAgent}`
      const budget =
        parentAgent === undefined
          ? undefined
          : options.delegationBudgets?.get(`${parentAgent}->${targetAgent}`)
      let budgetReserved = false
      if (budgetKey !== undefined && budget !== undefined) {
        const used = budgetUsage.get(budgetKey) ?? 0
        if (used >= budget) {
          throw new Error(
            `pantheon_delegate rejected: delegation budget exhausted for ${parentAgent}->${targetAgent} ` +
              `(${used}/${budget} dispatches used in this session). ` +
              'Configure the corresponding PANTHEON_*_APOLLO_BUDGET environment variable or DelegationOptions.',
          )
        }
        // Reserve before the first await so concurrent calls cannot overshoot.
        budgetUsage.set(budgetKey, used + 1)
        budgetReserved = true
      }

      // session.create failure → return a clear error as TEXT (tools return
      // errors as text, not thrown) and register NO job on the board — an
      // unhandled rejection here would otherwise lose the failure entirely.
      // The child model is resolved with a provider API-key gate (P1): the
      // resolved model (explicit `model` > options.agentModels > active
      // preset) is used when its provider key is configured; an explicit
      // caller model is always respected (warned); an auto-resolved model
      // whose provider key is missing falls back to the known-good
      // opencode-go/deepseek-v4-flash; if nothing usable remains the
      // failure is returned as TEXT below — no session, no board job.
      const resolved = resolveUsableChildModel(options, args.agent, args.model)
      if (resolved.error !== undefined) {
        if (budgetReserved && budgetKey !== undefined)
          budgetUsage.set(budgetKey, (budgetUsage.get(budgetKey) ?? 1) - 1)
        return resolved.error
      }
      const childModel = resolved.model
      let created: { id: string }
      try {
        created = await client.session.create({
          body: {
            parentID: ctx.sessionID,
            title: args.description ?? args.prompt.slice(0, 80),
            ...(childModel !== undefined ? { model: childModel } : {}),
          },
        })
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err)
        if (budgetReserved && budgetKey !== undefined) {
          budgetUsage.set(budgetKey, Math.max(0, (budgetUsage.get(budgetKey) ?? 1) - 1))
        }
        return `pantheon_delegate failed to create child session: ${reason}`
      }
      const childSessionID = created.id
      knownChildren.add(childSessionID)
      options.registerChildSession?.(childSessionID, ctx.sessionID)

      // Phase 4 read-only enforcement: register the child session in the
      // read-only registry when the delegate is read-only — explicit
      // `read_only: true` on the call, or the agent ∈ readOnlyAgents
      // (case-insensitive). The plugin's tool.execute.before guard then
      // denies edit/write/bash/task inside that session.
      const readOnly =
        args.read_only === true || (options.readOnlyAgents?.has(args.agent.toLowerCase()) ?? false)
      if (readOnly) {
        const entry: { agent: string; readOnlyFlag?: boolean } = { agent: args.agent }
        if (args.read_only !== undefined) entry.readOnlyFlag = args.read_only
        readOnlyRegistry.register(childSessionID, entry)
      }

      const job = await board.registerLaunch({
        taskID: childSessionID,
        parentSessionID: ctx.sessionID,
        agent: args.agent,
        description: args.description ?? args.prompt,
        objective: args.prompt,
      })

      // Timeout manager: cleared on finalize, unref'd so the timer never
      // keeps the process alive on its own.
      const timer = setTimeout(() => {
        timers.delete(childSessionID)
        void finalize(childSessionID, {
          state: 'error',
          error: `Delegation [${job.alias}] timed out after ${timeoutMs}ms without reaching a terminal state`,
          timedOut: true,
        }).catch((err: unknown) => log.error('[pantheon-delegate] timeout finalize failed:', err))
      }, timeoutMs)
      timer.unref()
      timers.set(childSessionID, timer)

      // Fire-and-forget — completion is observed via session.idle on the
      // child (spike: noReply does NOT deliver anything to the parent).
      void client.session
        .promptAsync({
          path: { id: childSessionID },
          body: { agent: args.agent, parts: [{ type: 'text', text: args.prompt }] },
        })
        .catch((err: unknown) => log.error('[pantheon-delegate] promptAsync failed:', err))

      return (
        `Delegated to ${args.agent}: [${job.alias}] (task ${childSessionID}).\n` +
        `Read the result with pantheon_delegation_read({ id: "${job.alias}" }).`
      )
    },
  }

  const pantheon_delegation_read: DelegationTool<typeof readArgs> = {
    description:
      'Block until a background delegation finishes (completed/error/cancelled), then return its ' +
      'report markdown (with a trailing agent-activity section) and mark the job reconciled. ' +
      'Resolves by alias or task ID.',
    args: readArgs,
    execute: async (args, ctx) => {
      const job = board.resolve(ctx.sessionID, args.id)
      if (!job) {
        return `Unknown delegation "${args.id}" for this session. Use pantheon_delegation_list to see active delegations.`
      }

      // Sample the child's messages while waiting so the caller sees what the
      // agent is doing — fail-open: no messages support → report as before.
      const collector: ActivityCollector = { lines: [], sampled: false }
      let terminal: BackgroundJobRecord
      try {
        terminal = await waitForTerminalWithActivity(
          board,
          client,
          job.taskID,
          readTimeoutMs,
          collector,
        )
      } catch {
        return `Timed out after ${readTimeoutMs}ms waiting for delegation "${args.id}" ([${job.alias}]).`
      }

      const md = await readDelegationReport(outputDir, terminal)
      if (md === undefined) {
        return `Delegation [${terminal.alias}] reached state ${terminal.state} but no report file was found.`
      }

      await board.markReconciled(job.taskID)
      // Fail-open: if session.messages never succeeded, keep the report as-is.
      if (!collector.sampled && collector.lines.length === 0) return md
      return `${md.replace(/\n+$/, '')}\n\n${formatActivitySection(collector.lines)}`
    },
  }

  const pantheon_delegation_list: DelegationTool<typeof listArgs> = {
    description:
      'List background delegations for the current session, with [unread] for finished jobs.',
    args: listArgs,
    execute: async (_args, ctx) => {
      const jobs = board.list(ctx.sessionID)
      if (jobs.length === 0) return 'No background delegations for this session.'

      const lines = await Promise.all(
        jobs.map(async (j) => {
          const unread = j.terminalUnreconciled ? ' [unread]' : ''
          const base = `  [${j.alias}] ${j.agent} — ${j.description} — ${stateLabel(j.state)}${unread}`
          // Running jobs get a live `last activity:` line (fail-open fetch).
          if (j.state !== 'running') return base
          const last = await lastChildActivity(client, j.taskID)
          return last === undefined ? base : `${base}\n    last activity: ${last}`
        }),
      )
      return `Background Delegations (${jobs.length}):\n${lines.join('\n')}`
    },
  }

  return {
    pantheon_delegate,
    pantheon_delegation_read,
    pantheon_delegation_list,
    finalizeDelegation: finalize,
  }
}
