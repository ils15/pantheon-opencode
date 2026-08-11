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
 *   2. `options.rootSessions` explicit allowlist;
 *   3. default: any session WE created via `session.create` is a sub-session;
 *      everything else is treated as root. Phase 3 should pass the root
 *      registry derived from `session.created` events (Session.parentID
 *      undefined ⇒ root) for authoritative enforcement.
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
import { readOnlyRegistry } from './delegation-enforce.ts'
import {
  DELEGATION_DEFAULTS,
  type DelegationClient,
  type DelegationDeps,
  type DelegationOptions,
  type FinalizeInput,
  finalizeDelegation as finalizeDelegationReport,
  readDelegationReport,
} from './delegation-finalize.ts'
import { createPantheonLogger } from './logger.ts'
import { resolveActivePreset } from './presets.mjs'

export type {
  DelegationClient,
  DelegationClientSession,
  DelegationMessageBundle,
  DelegationOptions,
  FinalizeInput,
} from './delegation-finalize.ts'
export { DELEGATION_DEFAULTS } from './delegation-finalize.ts'

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

// ─── Model resolution ──────────────────────────────────────────────────

/** Session model ref accepted by the opencode server's session.create. */
export interface ChildSessionModelRef {
  id: string
  providerID: string
}

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

// ─── Factory ───────────────────────────────────────────────────────────

/**
 * Build the delegation toolset. Keeps per-instance state: the set of child
 * sessions WE created (depth-guard default) and the per-job timeout timers
 * (cleared on finalize, `.unref()`'d so they never hold the process open).
 */
export function createDelegationTools(input: CreateDelegationToolsInput): DelegationToolset {
  const { board, client } = input
  const options: DelegationOptions = input.options ?? {}
  const deps: DelegationDeps = { board, client, options }
  const outputDir = options.outputDir ?? DELEGATION_DEFAULTS.outputDir
  const timeoutMs = options.timeoutMs ?? DELEGATION_DEFAULTS.timeoutMs
  const readTimeoutMs = options.readTimeoutMs ?? DELEGATION_DEFAULTS.readTimeoutMs

  const knownChildren = new Set<string>()
  const timers = new Map<string, NodeJS.Timeout>()

  function isRootSession(sessionID: string): boolean {
    if (options.isRootSession !== undefined) return options.isRootSession(sessionID)
    if (options.rootSessions !== undefined) return options.rootSessions.has(sessionID)
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

      // session.create failure → return a clear error as TEXT (tools return
      // errors as text, not thrown) and register NO job on the board — an
      // unhandled rejection here would otherwise lose the failure entirely.
      // The child model is resolved from (a) the explicit `model` option,
      // (b) options.agentModels (routing.yml), (c) the active preset — else
      // left unset so opencode's default applies (warned below).
      const childModel = resolveChildModel(options, args.agent, args.model)
      if (childModel === undefined) {
        options.logger?.warn?.(
          `[pantheon-delegate] no model resolved for agent "${args.agent}" — ` +
            "child session will use opencode's default model (may require API keys)",
        )
      }
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
        return `pantheon_delegate failed to create child session: ${reason}`
      }
      const childSessionID = created.id
      knownChildren.add(childSessionID)

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
      'report markdown and mark the job reconciled. Resolves by alias or task ID.',
    args: readArgs,
    execute: async (args, ctx) => {
      const job = board.resolve(ctx.sessionID, args.id)
      if (!job) {
        return `Unknown delegation "${args.id}" for this session. Use pantheon_delegation_list to see active delegations.`
      }

      let terminal: BackgroundJobRecord
      try {
        terminal = await board.waitForTerminal(job.taskID, readTimeoutMs)
      } catch {
        return `Timed out after ${readTimeoutMs}ms waiting for delegation "${args.id}" ([${job.alias}]).`
      }

      const md = await readDelegationReport(outputDir, terminal)
      if (md === undefined) {
        return `Delegation [${terminal.alias}] reached state ${terminal.state} but no report file was found.`
      }

      await board.markReconciled(job.taskID)
      return md
    },
  }

  const pantheon_delegation_list: DelegationTool<typeof listArgs> = {
    description:
      'List background delegations for the current session, with [unread] for finished jobs.',
    args: listArgs,
    execute: async (_args, ctx) => {
      const jobs = board.list(ctx.sessionID)
      if (jobs.length === 0) return 'No background delegations for this session.'

      const lines = jobs.map((j) => {
        const unread = j.terminalUnreconciled ? ' [unread]' : ''
        return `  [${j.alias}] ${j.agent} — ${j.description} — ${stateLabel(j.state)}${unread}`
      })
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
