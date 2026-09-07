/**
 * V1 Session Task Adapter (WS1, PR #94) — task()-shaped function over the V1
 * SDK session surface (`session.create` / `promptAsync` / `messages`).
 *
 * The thin manager (delegate-manager.ts) orchestrates launch → monitor →
 * reconcile → verify; THIS module is the only place that touches the host:
 *
 * - `createSessionTaskFn()` — prompt acceptance (bounded) + completion
 *   observed via the board (the idle hook / finalize path owns the terminal
 *   transition) + verified content pulled from the MD report written by
 *   `finalizeDelegation`. No MD report (or an empty one) means the result is
 *   NOT verified — the manager records `error`, never `completed`.
 * - `createNativeDelegateTools()` — the three delegation tools in the same
 *   structural shape as the legacy toolset, wired to per-parent managers.
 *   The child session is created FIRST so `taskID == childSessionID`: the
 *   V1 idle hook and the manager share one board record (no double
 *   registration, no scheduler of its own).
 *
 * The legacy fire-and-forget path (delegation.ts) is untouched; the plugin
 * selects legacy vs native via `PANTHEON_DELEGATE_MODE`.
 *
 * @module delegate-task-adapter
 */

import { z } from 'zod'

import type { BackgroundJobBoard } from './background-job-board.ts'
import {
  createDelegateManager,
  type DelegateManager,
  type DelegateManagerOptions,
  isDelegationEnabled,
  type NativeTaskFn,
} from './delegate-manager.ts'
import type { DelegationToolset } from './delegation.ts'
import {
  DELEGATION_DEFAULTS,
  type DelegationClient,
  readDelegationReport,
} from './delegation-finalize.ts'
import type { StepCapTracker } from './step-cap.ts'

// ─── Mode gate + kill-switch ───────────────────────────────────────────

/** Delegation backend selected by `PANTHEON_DELEGATE_MODE`. */
export type DelegateMode = 'native' | 'legacy'

/**
 * Resolve the delegation backend: `PANTHEON_DELEGATE_MODE=native` selects the
 * thin native manager; anything else (unset, `legacy`, garbage) stays on the
 * V1 fire-and-forget path. Fail-safe default = legacy (V1 intacto).
 */
export function resolveDelegateMode(
  env: Record<string, string | undefined> = process.env,
): DelegateMode {
  return (env.PANTHEON_DELEGATE_MODE ?? '').trim().toLowerCase() === 'native' ? 'native' : 'legacy'
}

/** Minimal structural shape of a delegation tool (legacy or native). */
export interface KillSwitchableTool {
  description: string
  args: unknown
  // biome-ignore lint/suspicious/noExplicitAny: tool args/ctx shapes differ per toolset
  execute: (args: any, ctx: any) => Promise<string>
}

/**
 * Wrap a delegation toolset with the `PANTHEON_DELEGATION=off` kill-switch.
 * Every entry exposing `execute()` is guarded (throws when disabled);
 * non-tool entries (e.g. legacy `finalizeDelegation`) pass through
 * untouched — the completion observer must keep working so children never
 * orphan. Native tools already guard internally; wrapping them again is a
 * harmless double-check. Returns a new object; the input is untouched.
 */
export function withDelegationKillSwitch<T extends object>(
  toolset: T,
  env: Record<string, string | undefined> = process.env,
): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(toolset)) {
    const tool = value as Partial<KillSwitchableTool>
    if (tool !== null && typeof tool === 'object' && typeof tool.execute === 'function') {
      const execute = tool.execute.bind(tool)
      out[key] = {
        ...(tool as Record<string, unknown>),
        // biome-ignore lint/suspicious/noExplicitAny: passthrough to the wrapped tool
        execute: async (args: any, ctx: any) => {
          if (!isDelegationEnabled(env)) {
            throw new Error('pantheon delegation disabled (PANTHEON_DELEGATION=off)')
          }
          return execute(args, ctx)
        },
      }
    } else {
      out[key] = value
    }
  }
  return out as T
}

// ─── Args schemas (same contract as the legacy toolset) ────────────────

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

export interface ToolContextLike {
  sessionID: string
  agent?: string
}

// ─── Session task function ─────────────────────────────────────────────

export interface SessionTaskAdapterOptions {
  client: DelegationClient
  board: BackgroundJobBoard
  outputDir?: string
  /** Bound for the promptAsync acceptance request (default: 60_000). */
  promptTimeoutMs?: number
  /** Bound for observing the terminal transition (default: 900_000). */
  settleTimeoutMs?: number
}

/** Split `provider/model` into the `{ id, providerID }` ref session.create expects. */
export function parseModelRef(model: string): { id: string; providerID: string } | undefined {
  const idx = model.indexOf('/')
  if (idx <= 0 || idx === model.length - 1) return undefined
  return { providerID: model.slice(0, idx), id: model.slice(idx + 1) }
}

/** Text after `## Output` (cut before a trailing `**Error**:` line). */
export function extractOutputSection(md: string | undefined): string {
  if (md === undefined) return ''
  const marker = '## Output'
  const at = md.indexOf(marker)
  const body = at < 0 ? md : md.slice(at + marker.length)
  const errAt = body.indexOf('\n**Error**:')
  return (errAt < 0 ? body : body.slice(0, errAt)).trim()
}

async function promptAccept(
  client: DelegationClient,
  taskID: string,
  agent: string,
  prompt: string,
  model: string | undefined,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<void> {
  const modelRef = model !== undefined ? parseModelRef(model) : undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      client.session
        .promptAsync({
          path: { id: taskID },
          body: {
            agent,
            ...(modelRef !== undefined ? { model: modelRef } : {}),
            parts: [{ type: 'text', text: prompt }],
          },
          ...(signal !== undefined ? { signal } : {}),
        })
        .then(
          () => undefined,
          (error: unknown) => {
            throw new Error(
              `promptAsync rejected: ${error instanceof Error ? error.message : String(error)}`,
            )
          },
        ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`promptAsync timed out after ${timeoutMs}ms`)),
          timeoutMs,
        )
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Build the task()-shaped function over a V1 session client.
 * The child session MUST already exist with id == input.taskID (created by
 * the tool wrapper before manager.launch so both share one board record).
 */
export function createSessionTaskFn(options: SessionTaskAdapterOptions): NativeTaskFn {
  const {
    client,
    board,
    outputDir = DELEGATION_DEFAULTS.outputDir,
    promptTimeoutMs = 60_000,
    settleTimeoutMs = DELEGATION_DEFAULTS.timeoutMs,
  } = options
  return async ({ agent, prompt, model, signal, taskID }) => {
    await promptAccept(client, taskID, agent, prompt, model, signal, promptTimeoutMs)
    const terminal = await board.waitForTerminal(taskID, settleTimeoutMs)
    const md = await readDelegationReport(outputDir, terminal)
    const content = extractOutputSection(md) || terminal.resultSummary || ''
    return { content }
  }
}

// ─── Native toolset ────────────────────────────────────────────────────

export interface NativeDelegateWiring {
  board: BackgroundJobBoard
  client: DelegationClient
  outputDir?: string
  env?: Record<string, string | undefined>
  isRootSession: (sessionID: string) => boolean
  registerChildSession?: (sessionID: string, parentID: string) => void
  registerReadOnlySession?: (
    sessionID: string,
    info: { agent: string; readOnlyFlag?: boolean },
  ) => void
  isReadOnlyAgent?: (agent: string) => boolean
  /** Per-agent model override in `provider/model` form (preset/routing). */
  agentModel?: (agent: string) => string | undefined
  managerOptions?: Partial<
    Omit<DelegateManagerOptions, 'board' | 'task' | 'parentSessionID' | 'env'>
  >
  stepCap?: StepCapTracker
}

export interface NativeDelegateToolset {
  pantheon_delegate: {
    description: string
    args: typeof delegateArgs
    execute(args: z.infer<z.ZodObject<typeof delegateArgs>>, ctx: ToolContextLike): Promise<string>
  }
  pantheon_delegation_read: {
    description: string
    args: typeof readArgs
    execute(args: z.infer<z.ZodObject<typeof readArgs>>, ctx: ToolContextLike): Promise<string>
  }
  pantheon_delegation_list: {
    description: string
    args: typeof listArgs
    execute(args: z.infer<z.ZodObject<typeof listArgs>>, ctx: ToolContextLike): Promise<string>
  }
}

function firstLine(text: string, max = 60): string {
  const line =
    (text ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

export function createNativeDelegateTools(wiring: NativeDelegateWiring): NativeDelegateToolset {
  const {
    board,
    client,
    outputDir = DELEGATION_DEFAULTS.outputDir,
    env = process.env,
    isRootSession,
    registerChildSession,
    registerReadOnlySession,
    isReadOnlyAgent,
    agentModel,
    managerOptions = {},
    stepCap,
  } = wiring
  const task = createSessionTaskFn({
    client,
    board,
    outputDir,
    ...(managerOptions.timeoutMs !== undefined
      ? { promptTimeoutMs: managerOptions.timeoutMs }
      : {}),
  })
  // One thin manager per parent session; the board is shared.
  const managers = new Map<string, DelegateManager>()
  function managerFor(parentSessionID: string): DelegateManager {
    let manager = managers.get(parentSessionID)
    if (!manager) {
      manager = createDelegateManager({
        ...managerOptions,
        board,
        task,
        parentSessionID,
        env,
        ...(stepCap !== undefined ? { stepCap } : {}),
      })
      managers.set(parentSessionID, manager)
    }
    return manager
  }

  return {
    pantheon_delegate: {
      description:
        'Dispatch a background agent as a child session (native task() semantics: the call returns only after the verified result). Returns one line `[pantheon:<alias>] <agent> — <summary> — <state>`.',
      args: delegateArgs,
      execute: async (args, ctx) => {
        if (!isDelegationEnabled(env)) {
          throw new Error('pantheon delegation disabled (PANTHEON_DELEGATION=off)')
        }
        if (!isRootSession(ctx.sessionID)) {
          throw new Error(
            `pantheon_delegate rejected: session ${ctx.sessionID} is a sub-session — only root sessions can delegate`,
          )
        }
        const model = args.model ?? agentModel?.(args.agent)
        let childID: string
        try {
          const modelRef = model !== undefined ? parseModelRef(model) : undefined
          const created = await client.session.create({
            body: {
              parentID: ctx.sessionID,
              title: args.description ?? firstLine(args.prompt),
              ...(modelRef !== undefined ? { model: modelRef } : {}),
            },
          })
          childID = created.id
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err)
          return `pantheon_delegate failed: session.create rejected: ${reason}`
        }
        registerChildSession?.(childID, ctx.sessionID)
        if (args.read_only === true || isReadOnlyAgent?.(args.agent) === true) {
          const info: { agent: string; readOnlyFlag?: boolean } = { agent: args.agent }
          if (args.read_only !== undefined) info.readOnlyFlag = args.read_only
          registerReadOnlySession?.(childID, info)
        }
        const receipt = await managerFor(ctx.sessionID).launch({
          agent: args.agent,
          prompt: args.prompt,
          ...(args.description !== undefined ? { description: args.description } : {}),
          ...(args.model !== undefined ? { model: args.model } : {}),
          taskID: childID,
        })
        return receipt.line
      },
    },
    pantheon_delegation_read: {
      description:
        'Block until a background delegation finishes, then return its verified report markdown and mark the job reconciled.',
      args: readArgs,
      execute: async (args, ctx) => {
        if (!isDelegationEnabled(env)) {
          throw new Error('pantheon delegation disabled (PANTHEON_DELEGATION=off)')
        }
        return managerFor(ctx.sessionID).read(args.id)
      },
    },
    pantheon_delegation_list: {
      description: 'List background delegations with [pantheon:<alias>] / [native] tags per line.',
      args: listArgs,
      execute: async (_args, ctx) => {
        if (!isDelegationEnabled(env)) {
          throw new Error('pantheon delegation disabled (PANTHEON_DELEGATION=off)')
        }
        const lines = await managerFor(ctx.sessionID).list()
        return lines.length > 0 ? lines.join('\n') : 'No delegations.'
      },
    },
  }
}

// ─── Plugin native branch (WS1, PR #94) ─────────────────────────────────
//
// Extracted verbatim from the `delegateMode === 'native'` branch in
// src/plugin.ts so the real mounting (model lowercasing, read-only set,
// conditional managerOptions, finalizeDelegation passthrough) is unit
// testable with fakes — importing plugin.ts itself would pull module-level
// singletons (board, timers, logger). The plugin calls this helper; the
// wiring test calls the same helper with the same shapes.

/** Raw materials the plugin owns for the native branch. */
export interface PluginNativeDelegationWiring {
  board: BackgroundJobBoard
  client: DelegationClient
  isRootSession: (sessionID: string) => boolean
  registerChildSession: (sessionID: string, parentID: string) => void
  registerReadOnlySession: (
    sessionID: string,
    info: { agent: string; readOnlyFlag?: boolean },
  ) => void
  readOnlyAgents: ReadonlySet<string>
  agentModels: Record<string, string | undefined>
  stepCap: StepCapTracker
  wallClockTimeoutMs?: number
  finalizeDelegation: DelegationToolset['finalizeDelegation']
}

/** Native toolset + the legacy completion observer (never kill-switched). */
export type PluginNativeDelegation = NativeDelegateToolset & {
  finalizeDelegation: DelegationToolset['finalizeDelegation']
}

export function buildPluginNativeDelegation(
  wiring: PluginNativeDelegationWiring,
): PluginNativeDelegation {
  const {
    board,
    client,
    isRootSession,
    registerChildSession,
    registerReadOnlySession,
    readOnlyAgents,
    agentModels,
    stepCap,
    wallClockTimeoutMs,
    finalizeDelegation,
  } = wiring
  return {
    ...createNativeDelegateTools({
      board,
      client,
      isRootSession,
      registerChildSession,
      registerReadOnlySession,
      isReadOnlyAgent: (agent) => readOnlyAgents.has(agent.toLowerCase()),
      agentModel: (agent) => agentModels[agent.toLowerCase()],
      stepCap,
      ...(wallClockTimeoutMs !== undefined
        ? { managerOptions: { timeoutMs: wallClockTimeoutMs } }
        : {}),
    }),
    finalizeDelegation,
  }
}
