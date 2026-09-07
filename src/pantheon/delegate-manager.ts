/**
 * Delegate Manager (WS1, PR #94) — thin manager over the native task() call.
 *
 * Relaunch of the 1.4.2 delegation as a THIN manager: launch / monitor /
 * reconcile over an injected `task()`-shaped function. No monolithic
 * scheduler: no timers of its own beyond wait/timeout bounds, no idle-event
 * plumbing, no hidden queues. Completion is recorded ONLY after the result
 * is verified (non-empty content); anything else becomes `error`.
 *
 * - Minimal records: every launch returns `{ id, agent, state, line }`
 *   (id, agent, state, one short line). Full reports only via `read()`.
 * - Auto-reconcile + signal delete on the spot after every terminal state.
 * - Entry cap + aggressive prune of completed/reconciled jobs.
 * - Concurrency limit (read live from the board) + foreground fallback.
 * - Model failover across an ordered model list.
 * - Step budgets reuse StepCapTracker (routing.yml max_steps, already
 *   extended beyond zeus) + summarize-and-stop cut.
 * - Kill-switch: `PANTHEON_DELEGATION=off` disables launch/read/list.
 *
 * The V1 fire-and-forget path (delegation.ts) is untouched; the plugin wires
 * this manager in front of it behind `PANTHEON_DELEGATE_MODE`.
 *
 * @module delegate-manager
 */

import { z } from 'zod'
import type { BackgroundJobBoard, BackgroundJobRecord } from './background-job-board.ts'
import type { DelegationToolset } from './delegation.ts'
import {
  DELEGATION_DEFAULTS,
  type DelegationClient,
  readDelegationReport,
} from './delegation-finalize.ts'
import {
  buildStopInstruction,
  cappedSummary,
  DEFAULT_MAX_STEPS,
  type StepCapTracker,
} from './step-cap.ts'

// ─── Types ─────────────────────────────────────────────────────────────

/** Input shape for the native task() call (injected — fake in tests). */
export interface NativeTaskInput {
  agent: string
  prompt: string
  model?: string
  signal?: AbortSignal
  /** Board taskID assigned by the manager (== child session id on V1 hosts). */
  taskID: string
  parentSessionID: string
}

/** Result shape for the native task() call. */
export interface NativeTaskResult {
  content?: string | null
  tokensInput?: number
  tokensOutput?: number
}

/** task()-shaped function: run one agent turn and return its result. */
export type NativeTaskFn = (input: NativeTaskInput) => Promise<NativeTaskResult>

/** Minimal launch receipt: id, agent, state, one short line. */
export interface ManagerReceipt {
  id: string
  agent: string
  state: 'reconciled' | 'error'
  line: string
}

export interface LaunchArgs {
  agent: string
  prompt: string
  description?: string
  model?: string
  /**
   * Board taskID to register. The V1 session adapter supplies the child
   * session id here so the idle hook and the manager share one record.
   * Defaults to a generated `native-<ts>-<seq>` id.
   */
  taskID?: string
}

export interface DelegateManagerOptions {
  board: BackgroundJobBoard
  task: NativeTaskFn
  parentSessionID: string
  /** Env mapping (default: process.env). Kill-switch reads PANTHEON_DELEGATION. */
  env?: Record<string, string | undefined>
  /** Ordered model list for failover (default: single attempt, inherited model). */
  models?: string[]
  /** Per-attempt wall-clock budget in ms (default: 120_000). */
  timeoutMs?: number
  /** read() wait budget in ms (default: 60_000). */
  readTimeoutMs?: number
  /** Run inline without a board record when concurrency is full (default: true). */
  foregroundFallback?: boolean
  /** Hard cap on board entries; oldest terminal jobs evicted first (default: 50). */
  maxEntries?: number
  /** Aggressive prune: completed/reconciled jobs kept (default: 10). */
  keepCompleted?: number
  /** Per-agent step budgets (routing.yml max_steps). */
  stepCap?: StepCapTracker
}

export interface DelegateManager {
  launch(args: LaunchArgs): Promise<ManagerReceipt>
  read(idOrAlias: string): Promise<string>
  list(): Promise<string[]>
  recover(): Promise<void>
}

// ─── Kill-switch ───────────────────────────────────────────────────────

/** False only when `PANTHEON_DELEGATION=off` (case-insensitive). */
export function isDelegationEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.PANTHEON_DELEGATION ?? '').trim().toLowerCase() !== 'off'
}

export type DelegateMode = 'native' | 'legacy'
export function resolveDelegateMode(
  env: Record<string, string | undefined> = process.env,
): DelegateMode {
  return (env.PANTHEON_DELEGATE_MODE ?? '').trim().toLowerCase() === 'native' ? 'native' : 'legacy'
}

// ─── Helpers ───────────────────────────────────────────────────────────

const LINE_MAX = 160

function firstLine(text: string, max = 80): string {
  const line =
    (text ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function shortState(state: BackgroundJobRecord['state']): string {
  switch (state) {
    case 'completed':
      return 'OK'
    case 'error':
      return 'ERR'
    case 'cancelled':
      return 'CAN'
    case 'running':
      return 'RUN'
    default:
      return 'REC'
  }
}

function boardLine(job: BackgroundJobRecord): string {
  const desc = firstLine(job.description, 80)
  return `[pantheon:${job.alias}] ${job.agent} — ${desc} — ${shortState(job.state)}`.slice(
    0,
    LINE_MAX,
  )
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, guard]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

// ─── Factory ───────────────────────────────────────────────────────────

export function createDelegateManager(options: DelegateManagerOptions): DelegateManager {
  const {
    board,
    task,
    parentSessionID,
    env = process.env,
    models = [],
    timeoutMs = 120_000,
    readTimeoutMs = 60_000,
    foregroundFallback = true,
    maxEntries = 50,
    keepCompleted = 10,
    stepCap,
  } = options

  // Synchronous in-flight reservations per agent: launch() must decide
  // background vs foreground BEFORE its first await, otherwise concurrent
  // launches without interleaved awaits would all see an empty board.
  const pendingByAgent = new Map<string, number>()
  let seq = 0
  const foregroundRecent: { agent: string; line: string; at: number }[] = []

  function pending(agent: string): number {
    return pendingByAgent.get(agent.toLowerCase()) ?? 0
  }

  function guardEnabled(): void {
    if (!isDelegationEnabled(env)) {
      throw new Error('pantheon delegation disabled (PANTHEON_DELEGATION=off)')
    }
  }

  async function runTask(
    agent: string,
    prompt: string,
    explicitModel: string | undefined,
    taskID: string,
  ): Promise<{ ok: true; result: NativeTaskResult } | { ok: false; error: string }> {
    const attempts: (string | undefined)[] =
      explicitModel !== undefined ? [explicitModel] : models.length > 0 ? models : [undefined]
    let lastError = 'no model attempts configured'
    for (const model of attempts) {
      try {
        const controller = new AbortController()
        const result = await withTimeout(
          task({
            agent,
            prompt,
            signal: controller.signal,
            taskID,
            parentSessionID,
            ...(model !== undefined ? { model } : {}),
          }),
          timeoutMs,
          `task(${agent})`,
        )
        return { ok: true, result }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
    }
    return { ok: false, error: lastError }
  }

  async function settle(
    taskID: string,
    alias: string,
    verifyError?: string,
  ): Promise<ManagerReceipt> {
    const job = board.get(taskID)
    if (!job) throw new Error(`job ${taskID} vanished after terminal state`)
    // The receipt reports the VERIFIED outcome, not the raw terminal state:
    // a `completed` the manager could not verify stays `error` for the
    // caller ("complete ONLY after verified result"). Reconcile is only the
    // acknowledgment that the result was consumed.
    const terminalState = job.state
    const failed = verifyError !== undefined || terminalState === 'error'
    // Auto-reconcile + delete the signal file on the spot.
    if (job.state !== 'reconciled') await board.markReconciled(taskID)
    await board.deleteSignal(alias)
    // Teto de entradas + prune agressivo de completed.
    await board.pruneCompleted(keepCompleted)
    await board.enforceEntryCap(maxEntries)
    const settled = board.get(taskID)
    const line = failed
      ? `[pantheon:${alias}] ${job.agent} — ERROR: ${firstLine(verifyError ?? settled?.lastStatusError ?? job.lastStatusError ?? 'failed', 90)}`.slice(
          0,
          LINE_MAX,
        )
      : boardLine(settled ?? job)
    return { id: taskID, agent: job.agent, state: failed ? 'error' : 'reconciled', line }
  }

  /** Apply a terminal transition best-effort: a racing hook may have gotten there first. */
  async function applyTerminal(
    taskID: string,
    state: 'completed' | 'error',
    fields: { resultSummary?: string; error?: string },
  ): Promise<void> {
    try {
      await board.updateStatus({ taskID, state, ...fields })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.startsWith('Invalid state transition')) throw err
      // Lost the race to another terminal writer (e.g. the V1 idle hook) —
      // the record stands; verification still governs the receipt.
    }
  }

  async function launchBackground(args: LaunchArgs, prompt: string): Promise<ManagerReceipt> {
    const key = args.agent.toLowerCase()
    pendingByAgent.set(key, pending(args.agent) + 1)
    seq += 1
    const taskID = args.taskID ?? `native-${Date.now()}-${seq}`
    try {
      const record = await board.registerLaunch({
        taskID,
        parentSessionID,
        agent: args.agent,
        description: args.description ?? firstLine(args.prompt, 120),
      })
      const outcome = await runTask(args.agent, prompt, args.model, taskID)
      if (!outcome.ok) {
        await applyTerminal(taskID, 'error', { error: outcome.error })
        return await settle(taskID, record.alias, outcome.error)
      }
      if (typeof outcome.result.content !== 'string' || outcome.result.content.trim() === '') {
        const verifyError = 'task result empty — not verified, never completed'
        await applyTerminal(taskID, 'error', { error: verifyError })
        return await settle(taskID, record.alias, verifyError)
      }
      await applyTerminal(taskID, 'completed', {
        resultSummary: firstLine(outcome.result.content, 500),
      })
      return await settle(taskID, record.alias)
    } finally {
      pendingByAgent.set(key, Math.max(0, pending(args.agent) - 1))
    }
  }

  async function launchForeground(args: LaunchArgs, prompt: string): Promise<ManagerReceipt> {
    seq += 1
    const id = args.taskID ?? `fg-${Date.now()}-${seq}`
    const outcome = await runTask(args.agent, prompt, args.model, id)
    const ok =
      outcome.ok &&
      typeof outcome.result.content === 'string' &&
      outcome.result.content.trim() !== ''
    const detail = ok
      ? firstLine((outcome as { ok: true; result: NativeTaskResult }).result.content ?? '', 90)
      : `ERROR: ${(outcome as { ok: false; error: string }).error ?? 'empty result — not verified'}`
    const line = `[native] ${args.agent} — ${detail} — ${ok ? 'OK' : 'ERR'} (foreground)`.slice(
      0,
      LINE_MAX,
    )
    foregroundRecent.push({ agent: args.agent, line, at: Date.now() })
    if (foregroundRecent.length > 20) foregroundRecent.splice(0, foregroundRecent.length - 20)
    return { id, agent: args.agent, state: ok ? 'reconciled' : 'error', line }
  }

  return {
    async launch(args: LaunchArgs): Promise<ManagerReceipt> {
      guardEnabled()
      // R4 step budgets (routing.yml max_steps, every agent): capped agents
      // skip dispatch with a stop summary — no session, no board job.
      let prompt = args.prompt
      if (stepCap !== undefined) {
        const maxSteps = stepCap.maxStepsFor(args.agent)
        if (stepCap.isCapped(args.agent)) {
          const line = cappedSummary(args.agent, maxSteps ?? DEFAULT_MAX_STEPS).slice(0, LINE_MAX)
          return { id: `cap-${Date.now()}`, agent: args.agent, state: 'reconciled', line }
        }
        const rec = stepCap.recordStep(args.agent)
        if (rec.capped && rec.maxSteps !== undefined) {
          prompt = `${args.prompt}${buildStopInstruction(args.agent, rec.maxSteps)}`
        }
      }
      // Synchronous routing decision: background when a slot is free,
      // foreground fallback when full, clean rejection otherwise.
      const free =
        board.canDispatch(args.agent) && pending(args.agent) < board.maxConcurrentPerAgent
      if (free) return launchBackground(args, prompt)
      if (foregroundFallback) return launchForeground(args, prompt)
      throw new Error(
        `pantheon_delegate rejected: concurrency limit reached for agent "${args.agent}"`,
      )
    },

    async read(idOrAlias: string): Promise<string> {
      guardEnabled()
      const job = board.resolve(parentSessionID, idOrAlias) ?? board.get(idOrAlias)
      if (!job) throw new Error(`delegation not found: ${idOrAlias}`)
      const terminal = await withTimeout(
        board.waitForTerminal(job.taskID, readTimeoutMs),
        readTimeoutMs + 5_000,
        `read(${idOrAlias})`,
      )
      if (terminal.state !== 'reconciled') await board.markReconciled(terminal.taskID)
      await board.deleteSignal(terminal.alias)
      if (terminal.state === 'error' && !terminal.resultSummary) {
        return `# Delegation Report — ${terminal.alias}\n\nERROR: ${terminal.lastStatusError ?? 'failed'}\n`
      }
      return (
        `# Delegation Report — ${terminal.alias}\n\n` +
        `${terminal.resultSummary ?? terminal.lastStatusError ?? terminal.state}\n`
      )
    },

    async list(): Promise<string[]> {
      guardEnabled()
      const lines = board.list(parentSessionID).map((job) => boardLine(job))
      for (const fg of foregroundRecent) lines.push(fg.line)
      return lines
    },

    async recover(): Promise<void> {
      await board.recoverRunningJobs()
    },
  }
}

// Native delegation tools live with the manager so the plugin mounts the
// manager directly; there is intentionally no adapter or kill-switch wrapper.
const delegateArgs = {
  prompt: z.string().min(1),
  agent: z.string().min(1),
  description: z.string().optional(),
  read_only: z.boolean().optional(),
  model: z.string().optional(),
} satisfies z.ZodRawShape
const readArgs = { id: z.string().min(1) } satisfies z.ZodRawShape
const listArgs = {} satisfies z.ZodRawShape
export interface ToolContextLike {
  sessionID: string
  agent?: string
}
export interface SessionTaskOptions {
  client: DelegationClient
  board: BackgroundJobBoard
  outputDir?: string
  promptTimeoutMs?: number
  settleTimeoutMs?: number
}
export function parseModelRef(model: string): { id: string; providerID: string } | undefined {
  const idx = model.indexOf('/')
  return idx > 0 && idx < model.length - 1
    ? { providerID: model.slice(0, idx), id: model.slice(idx + 1) }
    : undefined
}
export function extractOutputSection(md: string | undefined): string {
  if (md === undefined) return ''
  const at = md.indexOf('## Output')
  const body = at < 0 ? md : md.slice(at + 9)
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
  const modelRef = model === undefined ? undefined : parseModelRef(model)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      client.session
        .promptAsync({
          path: { id: taskID },
          body: {
            agent,
            ...(modelRef === undefined ? {} : { model: modelRef }),
            parts: [{ type: 'text', text: prompt }],
          },
          ...(signal === undefined ? {} : { signal }),
        })
        .then(undefined, (error: unknown) => {
          throw new Error(
            `promptAsync rejected: ${error instanceof Error ? error.message : String(error)}`,
          )
        }),
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
export function createSessionTaskFn(options: SessionTaskOptions): NativeTaskFn {
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
    return { content: extractOutputSection(md) || terminal.resultSummary || '' }
  }
}
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
function shortFirstLine(text: string, max = 60): string {
  const line =
    text
      .split('\n')
      .map((item) => item.trim())
      .find(Boolean) ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}
export function createNativeDelegateTools(wiring: NativeDelegateWiring): NativeDelegateToolset {
  const {
    board,
    client,
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
    ...(wiring.outputDir === undefined ? {} : { outputDir: wiring.outputDir }),
    ...(managerOptions.timeoutMs === undefined
      ? {}
      : { promptTimeoutMs: managerOptions.timeoutMs }),
  })
  const managers = new Map<string, DelegateManager>()
  const managerFor = (parentSessionID: string): DelegateManager => {
    const existing = managers.get(parentSessionID)
    if (existing !== undefined) return existing
    const manager = createDelegateManager({
      ...managerOptions,
      board,
      task,
      parentSessionID,
      env,
      ...(stepCap === undefined ? {} : { stepCap }),
    })
    managers.set(parentSessionID, manager)
    return manager
  }
  return {
    pantheon_delegate: {
      description: 'Dispatch a background agent as a child session and return a verified receipt.',
      args: delegateArgs,
      execute: async (args, ctx) => {
        if (!isDelegationEnabled(env))
          throw new Error('pantheon delegation disabled (PANTHEON_DELEGATION=off)')
        if (!isRootSession(ctx.sessionID))
          throw new Error(
            `pantheon_delegate rejected: session ${ctx.sessionID} is a sub-session — only root sessions can delegate`,
          )
        const model = args.model ?? agentModel?.(args.agent)
        let childID: string
        try {
          const modelRef = model === undefined ? undefined : parseModelRef(model)
          const created = await client.session.create({
            body: {
              parentID: ctx.sessionID,
              title: args.description ?? shortFirstLine(args.prompt),
              ...(modelRef === undefined ? {} : { model: modelRef }),
            },
          })
          childID = created.id
        } catch (error) {
          return `pantheon_delegate failed: session.create rejected: ${error instanceof Error ? error.message : String(error)}`
        }
        registerChildSession?.(childID, ctx.sessionID)
        if (args.read_only === true || isReadOnlyAgent?.(args.agent) === true)
          registerReadOnlySession?.(childID, {
            agent: args.agent,
            ...(args.read_only === undefined ? {} : { readOnlyFlag: args.read_only }),
          })
        const receipt = await managerFor(ctx.sessionID).launch({
          agent: args.agent,
          prompt: args.prompt,
          ...(args.description === undefined ? {} : { description: args.description }),
          ...(args.model === undefined ? {} : { model: args.model }),
          taskID: childID,
        })
        return receipt.line
      },
    },
    pantheon_delegation_read: {
      description: 'Block until a delegation finishes, then return its verified report.',
      args: readArgs,
      execute: async (args, ctx) => {
        if (!isDelegationEnabled(env))
          throw new Error('pantheon delegation disabled (PANTHEON_DELEGATION=off)')
        return managerFor(ctx.sessionID).read(args.id)
      },
    },
    pantheon_delegation_list: {
      description: 'List background delegations.',
      args: listArgs,
      execute: async (_args, ctx) => {
        if (!isDelegationEnabled(env))
          throw new Error('pantheon delegation disabled (PANTHEON_DELEGATION=off)')
        const lines = await managerFor(ctx.sessionID).list()
        return lines.length > 0 ? lines.join('\n') : 'No delegations.'
      },
    },
  }
}
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
export type PluginNativeDelegation = NativeDelegateToolset & {
  finalizeDelegation: DelegationToolset['finalizeDelegation']
}
export function buildPluginNativeDelegation(
  wiring: PluginNativeDelegationWiring,
): PluginNativeDelegation {
  return {
    ...createNativeDelegateTools({
      board: wiring.board,
      client: wiring.client,
      isRootSession: wiring.isRootSession,
      registerChildSession: wiring.registerChildSession,
      registerReadOnlySession: wiring.registerReadOnlySession,
      isReadOnlyAgent: (agent) => wiring.readOnlyAgents.has(agent.toLowerCase()),
      agentModel: (agent) => wiring.agentModels[agent.toLowerCase()],
      stepCap: wiring.stepCap,
      ...(wiring.wallClockTimeoutMs === undefined
        ? {}
        : { managerOptions: { timeoutMs: wiring.wallClockTimeoutMs } }),
    }),
    finalizeDelegation: wiring.finalizeDelegation,
  }
}
