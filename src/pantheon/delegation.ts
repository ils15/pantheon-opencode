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
  classifyStuckAgent,
  type DelegationResult,
  formatDelegationResult,
} from './delegation-classifier.ts'
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
import { finalizeIdleChildrenWithoutMd } from './delegation-notify.ts'
import { createPantheonLogger } from './logger.ts'
import { buildAgentListDescription } from './permission-globs.ts'
import { buildStopInstruction, cappedSummary, DEFAULT_MAX_STEPS } from './step-cap.ts'

export type {
  DelegationClient,
  DelegationClientSession,
  DelegationMessageBundle,
  DelegationOptions,
  FinalizeInput,
} from './delegation-finalize.ts'
export { DELEGATION_DEFAULTS } from './delegation-finalize.ts'
export type { IdleChildScanDeps } from './delegation-notify.ts'
export { finalizeIdleChildrenWithoutMd, startIdleChildScan } from './delegation-notify.ts'

// Fase B3: these are runtime controls, not routing/frontmatter fields. The
// plugin reads them from the environment, while tests and embedders can pass
// the same values through DelegationOptions.
export const B3_DEFAULT_EXCEPTION_BUDGET = 5

/** Maximum time spent proving that an accepted prompt actually booted. */
export const BOOTSTRAP_TIMEOUT_MS = 5_000
/** Default cadence for the bounded bootstrap probe. */
export const BOOTSTRAP_POLL_INTERVAL_MS = 250

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

type BootstrapOutcome =
  | { status: 'started'; elapsedMs: number; reason: string }
  | { status: 'startup_failed' | 'bootstrap_unknown'; elapsedMs: number; reason: string }

type PromptOutcome =
  | { status: 'accepted'; value: unknown }
  | { status: 'rejected'; reason: string }
  | { status: 'timeout'; reason: string }

/**
 * Bound the SDK request itself, not just the board watchdog.  The AbortSignal
 * is passed to hosts that support it; the race also protects older hosts that
 * ignore the signal and never settle their promise.
 */
async function promptWithTimeout(
  client: DelegationClient,
  input: Parameters<DelegationClient['session']['promptAsync']>[0],
  timeoutMs: number,
): Promise<PromptOutcome> {
  const controller = new AbortController()
  let timer: NodeJS.Timeout | undefined
  const operation = client.session.promptAsync({ ...input, signal: controller.signal }).then(
    (value) => ({ status: 'accepted' as const, value }),
    (error: unknown) => ({
      status: 'rejected' as const,
      reason: error instanceof Error ? error.message : String(error),
    }),
  )
  try {
    return await Promise.race([
      operation,
      new Promise<PromptOutcome>((resolve) => {
        timer = setTimeout(() => {
          controller.abort()
          resolve({ status: 'timeout', reason: `promptAsync timed out after ${timeoutMs}ms` })
        }, timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const RUNNING_SESSION_STATES = new Set(['busy', 'running', 'processing', 'retry', 'pending'])

async function boundedProbe<T>(operation: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  if (timeoutMs <= 0) return undefined
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs)
        timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

function isRunningSession(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const state = record.status ?? record.state
  return typeof state === 'string' && RUNNING_SESSION_STATES.has(state.toLowerCase())
}

function hasDurableMessage(value: unknown): boolean {
  if (!Array.isArray(value)) return false
  return value.some((bundle) => {
    if (typeof bundle !== 'object' || bundle === null) return false
    const info = (bundle as { info?: { role?: unknown } }).info
    return info?.role === 'user' || info?.role === 'assistant'
  })
}

async function bootstrapChild(
  client: DelegationClient,
  childSessionID: string,
  accepted: unknown,
  options: DelegationOptions,
): Promise<BootstrapOutcome> {
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const timeoutMs = options.bootstrapTimeoutMs ?? BOOTSTRAP_TIMEOUT_MS
  const intervalMs = options.bootstrapPollIntervalMs ?? BOOTSTRAP_POLL_INTERVAL_MS
  const startedAt = now()
  const hasMessagesAPI = typeof client.session.messages === 'function'
  const hasStatusAPI = typeof client.session.get === 'function'
  const acceptedRunning = isRunningSession(accepted)

  if (!hasMessagesAPI && !hasStatusAPI) {
    return acceptedRunning
      ? {
          status: 'started',
          elapsedMs: now() - startedAt,
          reason: 'prompt accepted by legacy host',
        }
      : {
          status: 'bootstrap_unknown',
          elapsedMs: now() - startedAt,
          reason:
            'host exposes neither session.messages nor session.get and prompt had no running evidence',
        }
  }

  let sawProbe = false
  while (now() - startedAt < timeoutMs) {
    let durable = false
    let running = acceptedRunning
    const remainingMs = timeoutMs - (now() - startedAt)
    if (hasMessagesAPI) {
      try {
        const messagesAPI = client.session.messages
        if (messagesAPI === undefined) continue
        const messages = await boundedProbe(
          messagesAPI({ path: { id: childSessionID } }),
          remainingMs,
        )
        if (messages !== undefined) {
          sawProbe = true
          durable = hasDurableMessage(messages)
        }
      } catch {
        // A transient endpoint failure is diagnosed after the bounded window.
      }
    }
    if (hasStatusAPI) {
      try {
        const statusAPI = client.session.get
        if (statusAPI === undefined) continue
        const status = await boundedProbe(
          statusAPI({ path: { id: childSessionID } }),
          timeoutMs - (now() - startedAt),
        )
        if (status !== undefined) {
          running = running || isRunningSession(status)
          sawProbe = true
        }
      } catch {
        // Fail closed only after the bounded window; never create an unbounded poll.
      }
    }
    if (durable)
      return {
        status: 'started',
        elapsedMs: now() - startedAt,
        reason: 'durable child message observed',
      }
    if (running)
      return {
        status: 'started',
        elapsedMs: now() - startedAt,
        reason: 'child session reports running/processing',
      }
    await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - (now() - startedAt))))
  }
  return sawProbe
    ? {
        status: 'startup_failed',
        elapsedMs: now() - startedAt,
        reason: `no durable message or running state after ${timeoutMs}ms`,
      }
    : {
        status: 'bootstrap_unknown',
        elapsedMs: now() - startedAt,
        reason: `bootstrap probes were unavailable after ${timeoutMs}ms`,
      }
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
  /** Proactive finalize for idle children without MD reports (Fix 2). */
  finalizeIdleChildrenWithoutMd: typeof finalizeIdleChildrenWithoutMd
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

/** Canonical 14-agent roster (O5 tool-description default). */
export const CANONICAL_AGENTS: readonly string[] = [
  'zeus',
  'athena',
  'apollo',
  'hermes',
  'aphrodite',
  'demeter',
  'themis',
  'prometheus',
  'hephaestus',
  'nyx',
  'gaia',
  'iris',
  'mnemosyne',
  'talos',
]

function stateLabel(state: BackgroundJobRecord['state']): string {
  switch (state) {
    case 'running':
      return 'RUNNING'
    case 'completed':
      return 'OK'
    case 'error':
      return 'ERR'
    case 'startup_failed':
      return 'STARTUP FAILED'
    case 'startup_unknown':
      return 'STARTUP UNKNOWN'
    case 'cancelled':
      return 'CANCELLED'
    case 'reconciled':
      return 'RECONCILED'
  }
}

/** Normalize the SDK-provided caller agent without inventing an identity. */
const normalizeToolAgent = normalizeDelegationAgent

/**
 * O5: the delegate tool description. When permission.task rules are
 * configured, denied agents are REMOVED from the description entirely (not
 * just blocked at call time) — the caller never sees them as invocable.
 */
function buildDelegateDescription(options: DelegationOptions): string {
  const base =
    'Dispatch a background agent as a child session and register it on the job board. ' +
    'Returns the readable alias (e.g. "apo-1"); read the result with ' +
    'pantheon_delegation_read. Only root sessions may delegate.'
  if (options.permissionTask === undefined) return base
  const roster = options.agentNames ?? CANONICAL_AGENTS
  return `${base} Allowed subagents: ${buildAgentListDescription(options.permissionTask, roster)}.`
}

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

const MODEL_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:+-]*$/
const MODEL_REF_HINT =
  'Expected a non-empty "provider/model-id" reference with exactly one slash, no whitespace/control characters, backslashes, or path traversal. Remove the override or use that format.'

type ModelOverrideSource = 'explicit' | 'agentModels'

function invalidModelOverride(source: ModelOverrideSource): string {
  return `pantheon_delegate rejected: invalid ${source} model override. ${MODEL_REF_HINT}`
}

/**
 * Split a `provider/model` model ID (e.g. `opencode/deepseek-v4-flash-free`)
 * into the `{ id, providerID }` ref the session.create body expects.
 * Returns undefined for malformed or unsafe IDs.
 */
function splitModelRef(model: unknown): ChildSessionModelRef | undefined {
  if (typeof model !== 'string' || !MODEL_REF_PATTERN.test(model)) return undefined
  const slash = model.indexOf('/')
  return { providerID: model.slice(0, slash), id: model.slice(slash + 1) }
}

/**
 * Resolve the child session model from explicit or agent-specific overrides.
 * When neither override is present, return undefined so OpenCode can apply
 * native model inheritance.
 */
function resolveChildModel(
  options: DelegationOptions,
  agent: string,
  explicitModel?: string,
): { model: ChildSessionModelRef | undefined; error: string | undefined } {
  // (a) explicit model option on the delegate tool call
  if (explicitModel !== undefined) {
    const ref = splitModelRef(explicitModel)
    if (ref !== undefined) return { model: ref, error: undefined }
    return { model: undefined, error: invalidModelOverride('explicit') }
  }
  const key = agent.toLowerCase()
  // (b) agent-specific model override (routing.yml agent entry via agentModels)
  const mapped = options.agentModels?.[key]
  if (mapped !== undefined) {
    const ref = splitModelRef(mapped)
    if (ref !== undefined) return { model: ref, error: undefined }
    return { model: undefined, error: invalidModelOverride('agentModels') }
  }
  return { model: undefined, error: undefined }
}

/**
 * Resolve a child model without selecting a provider or model on the caller's
 * behalf. OpenCode owns native inheritance when this returns no model; if the
 * host requires one, its session.create/promptAsync error is returned with
 * the normal diagnostic rather than silently choosing a fallback.
 *
 * @returns `{ model, error }` — at most one of `model` / `error` is set;
 *   both may be unset (no model resolved, warn emitted).
 */
function resolveUsableChildModel(
  options: DelegationOptions,
  agent: string,
  explicitModel: string | undefined,
): { model: ChildSessionModelRef | undefined; error: string | undefined } {
  const resolved = resolveChildModel(options, agent, explicitModel)
  if (resolved.error !== undefined || resolved.model !== undefined) return resolved
  options.logger?.warn?.(
    `[pantheon-delegate] no model resolved for agent "${agent}" — ` +
      'omitting model so OpenCode can inherit it from the parent session',
  )
  return resolved
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
    description: buildDelegateDescription(options),
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

      // R4: per-agent step caps. An agent already at max_steps is forced to
      // summarize-and-stop — the delegation is skipped with a capped summary
      // (no session, no board job, no budget consumed). Otherwise record the
      // step; when THIS step hits the cap, append the stop instruction to
      // the prompt so the agent summarizes and stops instead of continuing.
      let effectivePrompt = args.prompt
      const stepCap = options.stepCapTracker
      if (stepCap !== undefined) {
        const maxSteps = stepCap.maxStepsFor(args.agent)
        if (stepCap.isCapped(args.agent)) {
          return cappedSummary(args.agent, maxSteps ?? DEFAULT_MAX_STEPS)
        }
        const rec = stepCap.recordStep(args.agent)
        if (rec.capped && rec.maxSteps !== undefined) {
          effectivePrompt = `${args.prompt}${buildStopInstruction(args.agent, rec.maxSteps)}`
        }
      }

      // Fase B3: only the two read-only exceptions are budgeted. The official
      // SDK provides the current agent on ToolContext. If a structural/older
      // host omits it, do NOT infer identity from prompt, target, or process
      // state: the budget is explicitly skipped and the delegation continues.
      const parentAgent = normalizeToolAgent(ctx.agent)
      const targetAgent = args.agent.toLowerCase()
      if (
        options.enforceRuntimeMatrix === true &&
        !isDelegationAllowed(parentAgent, targetAgent, options.permissionTask)
      ) {
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
      // Resolution order: explicit delegate model > active-preset agent model
      // > omit (native inheritance). small_model is never used for delegated
      // children.
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
            title: args.description ?? effectivePrompt.slice(0, 80),
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
        description: args.description ?? effectivePrompt,
        objective: effectivePrompt,
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

      const promptBody = {
        agent: args.agent,
        ...(childModel !== undefined ? { model: childModel } : {}),
        parts: [{ type: 'text' as const, text: effectivePrompt }],
      }
      const promptOutcome = await promptWithTimeout(
        client,
        { path: { id: childSessionID }, body: promptBody },
        options.promptTimeoutMs ?? options.bootstrapTimeoutMs ?? BOOTSTRAP_TIMEOUT_MS,
      )
      let bootstrap: BootstrapOutcome
      let safeRetry = false
      if (promptOutcome.status === 'rejected') {
        // A synchronous rejection is the only safe automatic retry signal: the
        // host explicitly told us that it did not accept the request.
        bootstrap = {
          status: 'startup_failed',
          elapsedMs: 0,
          reason: `promptAsync rejected: ${promptOutcome.reason}`,
        }
        safeRetry = true
      } else if (promptOutcome.status === 'timeout') {
        // A timeout is ambiguous: the server may have accepted the prompt even
        // though the client never received its response. Never resend it.
        bootstrap = { status: 'startup_failed', elapsedMs: 0, reason: promptOutcome.reason }
      } else {
        bootstrap = await bootstrapChild(client, childSessionID, promptOutcome.value, options)
      }
      log.info(
        `[pantheon-delegate] bootstrap child=${childSessionID} elapsed=${bootstrap.elapsedMs}ms reason=${bootstrap.reason}`,
      )
      if (bootstrap.status === 'started') {
        return (
          `Delegated to ${args.agent}: [${job.alias}] (task ${childSessionID}).\n` +
          `Read the result with pantheon_delegation_read({ id: "${job.alias}" }).`
        )
      }

      // Every startup diagnosis is terminal for this child. Only a prompt
      // rejection (known not accepted) permits one fresh-session retry;
      // accepted-empty, unavailable APIs, and request timeouts do not.
      const boardStartupState =
        bootstrap.status === 'bootstrap_unknown' ? 'startup_unknown' : 'startup_failed'
      await finalize(childSessionID, {
        state: boardStartupState,
        error: `${bootstrap.status}: ${bootstrap.reason}`,
      })
      if (!safeRetry) {
        const finalResult: DelegationResult = {
          status: bootstrap.status,
          content: `Child session ${childSessionID} did not start (${bootstrap.reason}).`,
          retryCount: 0,
          recommendation:
            bootstrap.status === 'bootstrap_unknown'
              ? 'Inspect the child session in the board/TUI and retry manually only after confirming the prompt was not accepted.'
              : 'Inspect the child session/host promptAsync implementation; no automatic retry was attempted because acceptance was ambiguous.',
        }
        return formatDelegationResult(finalResult)
      }

      let retry: { id: string }
      try {
        retry = await client.session.create({
          body: {
            parentID: ctx.sessionID,
            title: args.description ?? effectivePrompt.slice(0, 80),
            ...(childModel !== undefined ? { model: childModel } : {}),
          },
        })
      } catch (err: unknown) {
        const reason = err instanceof Error ? err.message : String(err)
        return `[STARTUP FAILED] ${bootstrap.status}: ${bootstrap.reason}; retry creation failed: ${reason}`
      }
      const retryID = retry.id
      knownChildren.add(retryID)
      options.registerChildSession?.(retryID, ctx.sessionID)
      const retryJob = await board.registerLaunch({
        taskID: retryID,
        parentSessionID: ctx.sessionID,
        agent: args.agent,
        description: args.description ?? effectivePrompt,
        objective: effectivePrompt,
      })
      const retryTimer = setTimeout(() => {
        timers.delete(retryID)
        void finalize(retryID, {
          state: 'error',
          error: `Delegation [${retryJob.alias}] timed out after ${timeoutMs}ms without reaching a terminal state`,
          timedOut: true,
        }).catch((err: unknown) =>
          log.error('[pantheon-delegate] retry timeout finalize failed:', err),
        )
      }, timeoutMs)
      retryTimer.unref()
      timers.set(retryID, retryTimer)
      const retryPrompt = await promptWithTimeout(
        client,
        { path: { id: retryID }, body: promptBody },
        options.promptTimeoutMs ?? options.bootstrapTimeoutMs ?? BOOTSTRAP_TIMEOUT_MS,
      )
      let retryBootstrap: BootstrapOutcome
      if (retryPrompt.status === 'rejected') {
        retryBootstrap = {
          status: 'startup_failed',
          elapsedMs: 0,
          reason: `retry promptAsync rejected: ${retryPrompt.reason}`,
        }
      } else if (retryPrompt.status === 'timeout') {
        retryBootstrap = { status: 'startup_failed', elapsedMs: 0, reason: retryPrompt.reason }
      } else {
        retryBootstrap = await bootstrapChild(client, retryID, retryPrompt.value, options)
      }
      log.info(
        `[pantheon-delegate] bootstrap retry child=${retryID} elapsed=${retryBootstrap.elapsedMs}ms reason=${retryBootstrap.reason}`,
      )
      if (retryBootstrap.status === 'started') {
        return (
          `Delegated to ${args.agent}: [${retryJob.alias}] (task ${retryID}); retry=1.\n` +
          `Read the result with pantheon_delegation_read({ id: "${retryJob.alias}" }).`
        )
      }
      await finalize(retryID, {
        state: retryBootstrap.status === 'bootstrap_unknown' ? 'startup_unknown' : 'startup_failed',
        error: `startup retry exhausted: ${retryBootstrap.status}: ${retryBootstrap.reason}`,
      })
      const finalResult: DelegationResult = {
        status: retryBootstrap.status,
        content: `Child session ${retryID} did not start (${retryBootstrap.reason}).`,
        retryCount: 1,
        recommendation:
          'Inspect the child session/host promptAsync implementation; no further automatic retries will be attempted.',
      }
      return formatDelegationResult(finalResult)
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

      // Classify the result for stuck-agent detection
      const classification = classifyStuckAgent(md)
      const hasActivity = collector.sampled || collector.lines.length > 0
      const activitySuffix = hasActivity ? `\n\n${formatActivitySection(collector.lines)}` : ''

      if (classification.status === 'success') {
        await board.markReconciled(job.taskID)
        // Backward compatible: success reports returned as-is
        if (!hasActivity) return md
        return `${md.replace(/\n+$/, '')}${activitySuffix}`
      }

      // Non-success: build structured DelegationResult and format
      const delegationResult: DelegationResult = {
        status: classification.status === 'empty' ? 'empty' : classification.status,
        content: md,
        retryCount: 0,
        partialResult: classification.partialResult,
        recommendation: classification.recommendation,
      }

      await board.markReconciled(job.taskID)
      const formatted = formatDelegationResult(delegationResult)
      return `${formatted}${activitySuffix}`
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
    finalizeIdleChildrenWithoutMd,
  }
}
