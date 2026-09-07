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

import type { BackgroundJobBoard, BackgroundJobRecord } from './background-job-board.ts'
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
