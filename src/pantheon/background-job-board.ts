/**
 * Background Job Board — state machine for tracking background agent jobs.
 *
 * Tracks jobs through a state machine (running → completed/error/cancelled → reconciled),
 * supports alias generation per session, persistence via adapter, auto-wake signal files,
 * and terminal state listeners (persist-before-notify write-ahead-log pattern).
 *
 * Pure TypeScript — zero external dependencies beyond Node.js builtins (fs/path).
 *
 * @module background-job-board
 */

import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { createPantheonLogger } from './logger.ts'

// Silence-by-default TUI policy (pantheon-hooks L42-58): console output in a
// plugin renders into the opencode TUI — the "lixo". Board internals log to
// .pantheon/logs/hooks.log; console echo is opt-in via PANTHEON_HOOKS_LOG=1.
const log = createPantheonLogger({ module: 'BackgroundJobBoard' })

// ─── Types ─────────────────────────────────────────────────────────────

/** Valid states for a background job. */
export type BackgroundJobState = 'running' | 'completed' | 'error' | 'cancelled' | 'reconciled'

/** Terminal states that can transition to reconciled. */
const TERMINAL_STATES: ReadonlySet<BackgroundJobState> = new Set([
  'completed',
  'error',
  'cancelled',
])

/**
 * Transitions allowed via `updateStatus()`.
 * Each entry defines which target states are reachable from the current state.
 * Only running → terminal, or same-terminal → same-terminal (idempotent re-notify).
 */
const UPDATE_TRANSITIONS: Record<BackgroundJobState, ReadonlySet<BackgroundJobState>> = {
  running: new Set(['completed', 'error', 'cancelled']),
  completed: new Set(['completed']),
  error: new Set(['error']),
  cancelled: new Set(['cancelled']),
  reconciled: new Set([]),
}

/** A file context reference read during a job's execution. */
export interface ContextFile {
  path: string
  lineCount: number
  lastReadAt: number
}

/** Full record of a background agent job. */
export interface BackgroundJobRecord {
  taskID: string
  parentSessionID: string
  /** Agent name, e.g. "apollo", "hermes". */
  agent: string
  /** Human-readable description of the job. */
  description: string
  /** Optional objective for the job. */
  objective?: string
  /** Current state in the state machine. */
  state: BackgroundJobState
  /** Whether the job timed out (distinct from error state). */
  timedOut: boolean
  /** Short unique alias within the parent session, e.g. "apo-1". */
  alias: string
  /** Epoch ms when the job was launched. */
  launchedAt: number
  /** Epoch ms when the job reached a terminal state. */
  completedAt?: number
  /** Epoch ms of the last state change. */
  updatedAt: number
  /** Optional summary of the result. */
  resultSummary?: string
  /** Most recent error message. */
  lastStatusError?: string
  /** Cumulative error count across retries. */
  totalErrors: number
  /** Cumulative timeout count. */
  timeoutCount: number
  /** True if the job is in a terminal state that hasn't been reconciled yet. */
  terminalUnreconciled: boolean
  /** Files read during execution. */
  contextFiles: ContextFile[]
}

/** Input for launching a new job. */
export interface LaunchInput {
  taskID: string
  parentSessionID: string
  agent: string
  description: string
  objective?: string
  contextFiles?: ContextFile[]
}

/** Input for updating a job's status to a terminal state. */
export interface StatusInput {
  taskID: string
  state: 'completed' | 'error' | 'cancelled'
  resultSummary?: string
  error?: string
  timedOut?: boolean
}

/** Configuration options for the BackgroundJobBoard. */
export interface BoardOptions {
  /** Maximum concurrent jobs per agent (default: 3). */
  maxConcurrentPerAgent?: number
  /** Maximum completed jobs kept per agent for reuse (default: 3). */
  maxReusablePerAgent?: number
  /**
   * Directory for auto-wake signal files.
   * When set, a `.signal.json` file is atomically written on every terminal transition.
   * When null or undefined, no signal files are written.
   */
  signalDir?: string | null
}

/** Persistence adapter interface — injected by the plugin layer. */
export interface PersistenceAdapter {
  saveJob(record: BackgroundJobRecord): Promise<void>
  loadAllJobs(): Promise<BackgroundJobRecord[]>
  deleteJob(taskID: string): Promise<void>
}

/** A pending `waitForTerminal()` registration for a taskID. */
interface TerminalWaiter {
  resolve: (job: BackgroundJobRecord) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

// ─── Agent Prefix Mapping ──────────────────────────────────────────────

const AGENT_PREFIXES: Record<string, string> = {
  apollo: 'apo',
  hermes: 'her',
  aphrodite: 'aph',
  demeter: 'dem',
  themis: 'the',
  prometheus: 'pro',
  hephaestus: 'hep',
  nyx: 'nyx',
  athena: 'ath',
  gaia: 'gai',
  iris: 'iri',
  mnemosyne: 'mne',
  talos: 'tal',
}

function getAgentPrefix(agent: string): string {
  return AGENT_PREFIXES[agent.toLowerCase()] ?? 'job'
}

// ─── BackgroundJobBoard ────────────────────────────────────────────────

/**
 * In-memory job board that tracks background agent jobs through a state machine.
 *
 * Features:
 * - Strict state machine with validated transitions
 * - Per-session, per-agent alias generation (apo-1, her-2, …)
 * - Optional persistence via injected PersistenceAdapter
 * - Optional auto-wake signal files on terminal transitions
 * - Terminal state listeners with persist-before-notify guarantee
 * - expire/prune helpers for session lifecycle management
 */
export class BackgroundJobBoard {
  private readonly jobs: Map<string, BackgroundJobRecord> = new Map()
  /**
   * aliasCounters[parentSessionID][agentPrefix] → next counter value
   */
  private readonly aliasCounters: Map<string, Map<string, number>> = new Map()
  private readonly terminalListeners: Set<(taskID: string) => void> = new Set()
  private readonly terminalWaiters: Map<string, TerminalWaiter[]> = new Map()
  private readonly options: Required<BoardOptions>
  private persistence: PersistenceAdapter | null = null

  constructor(options?: BoardOptions) {
    this.options = {
      maxConcurrentPerAgent: options?.maxConcurrentPerAgent ?? 3,
      maxReusablePerAgent: options?.maxReusablePerAgent ?? 3,
      signalDir: options?.signalDir ?? null,
    }
  }

  // ─── Persistence ────────────────────────────────────────────────────

  /** Inject a persistence adapter. Must be called before `recoverRunningJobs()`. */
  setPersistence(adapter: PersistenceAdapter): void {
    this.persistence = adapter
  }

  /**
   * Recover previously persisted jobs on startup.
   * Any jobs left in `running` state are marked as `error` (orphaned by crash).
   */
  async recoverRunningJobs(): Promise<void> {
    if (!this.persistence) return
    const records = await this.persistence.loadAllJobs()
    for (const record of records) {
      if (record.state === 'running') {
        record.state = 'error'
        record.lastStatusError = 'Process restarted — job marked as errored'
        record.updatedAt = Date.now()
        record.totalErrors++
      }
      this.jobs.set(record.taskID, record)
    }
  }

  // ─── Core Operations ────────────────────────────────────────────────

  /**
   * Register a new job launch.
   * The job starts in the `running` state with a generated alias.
   */
  async registerLaunch(input: LaunchInput): Promise<BackgroundJobRecord> {
    const prefix = getAgentPrefix(input.agent)
    let sessionCounters = this.aliasCounters.get(input.parentSessionID)
    if (!sessionCounters) {
      sessionCounters = new Map()
      this.aliasCounters.set(input.parentSessionID, sessionCounters)
    }
    const counter = (sessionCounters.get(prefix) ?? 0) + 1
    sessionCounters.set(prefix, counter)

    const now = Date.now()
    const record: BackgroundJobRecord = {
      taskID: input.taskID,
      parentSessionID: input.parentSessionID,
      agent: input.agent,
      description: input.description,
      ...(input.objective !== undefined ? { objective: input.objective } : {}),
      state: 'running',
      timedOut: false,
      alias: `${prefix}-${counter}`,
      launchedAt: now,
      updatedAt: now,
      totalErrors: 0,
      timeoutCount: 0,
      terminalUnreconciled: false,
      contextFiles: input.contextFiles ?? [],
    }

    this.jobs.set(input.taskID, record)
    await this.persistRecord(record)
    return record
  }

  /**
   * Update a job's state to a terminal state.
   *
   * Valid transitions: `running` → `completed`|`error`|`cancelled`
   * Idempotent: terminal → same terminal (re-notifies listeners, re-persists).
   * Rejected: `running` → `running`, terminal → different terminal, `reconciled` → anything.
   *
   * Follows write-ahead-log: persist → signal → notify listeners.
   */
  async updateStatus(input: StatusInput): Promise<BackgroundJobRecord | undefined> {
    const job = this.jobs.get(input.taskID)
    if (!job) return undefined

    const allowed = UPDATE_TRANSITIONS[job.state]
    if (!allowed.has(input.state)) {
      throw new Error(
        `Invalid state transition: ${job.state} → ${input.state} for job ${input.taskID}`,
      )
    }

    const wasTerminal = TERMINAL_STATES.has(job.state)
    const willBeTerminal = TERMINAL_STATES.has(input.state)

    // --- mutate in-memory state ---
    job.state = input.state
    job.updatedAt = Date.now()

    if (input.resultSummary !== undefined) {
      job.resultSummary = input.resultSummary
    }
    if (input.error !== undefined) {
      job.lastStatusError = input.error
    }
    if (input.timedOut !== undefined) {
      job.timedOut = input.timedOut
    }
    if (input.state === 'error') {
      job.totalErrors++
    }
    if (input.timedOut) {
      job.timeoutCount++
    }
    if (willBeTerminal) {
      if (job.completedAt === undefined) {
        job.completedAt = Date.now()
      }
      job.terminalUnreconciled = true
    }

    // --- write-ahead log: persist before notify ---
    await this.persistRecord(job)

    // --- signal on terminal states ---
    if (willBeTerminal) {
      await this.writeSignal(job)
    }

    // --- notify listeners on first terminal transition ---
    if (willBeTerminal && !wasTerminal) {
      this.notifyTerminal(job.taskID)
    }

    return job
  }

  /**
   * Cancel a running job.
   *
   * More permissive than `updateStatus({ state: 'cancelled' })` — it allows
   * cancelling from any non-terminal state. Idempotent on already-cancelled jobs.
   */
  async markCancelled(taskID: string, reason?: string): Promise<BackgroundJobRecord | undefined> {
    const job = this.jobs.get(taskID)
    if (!job) return undefined

    if (job.state === 'reconciled') {
      throw new Error(`Cannot cancel reconciled job ${taskID}`)
    }

    if (job.state === 'cancelled') {
      // Idempotent — re-persist and re-signal
      await this.persistRecord(job)
      await this.writeSignal(job)
      return job
    }

    if (job.state !== 'running') {
      throw new Error(
        `Cannot cancel job ${taskID} in state ${job.state} — only running jobs can be cancelled`,
      )
    }

    const wasTerminal = TERMINAL_STATES.has(job.state)
    job.state = 'cancelled'
    job.updatedAt = Date.now()
    if (reason !== undefined) {
      job.lastStatusError = reason
    }
    job.completedAt ??= Date.now()
    job.terminalUnreconciled = true

    await this.persistRecord(job)
    await this.writeSignal(job)

    if (!wasTerminal) {
      this.notifyTerminal(job.taskID)
    }

    return job
  }

  /**
   * Mark a terminal job as reconciled (acknowledged/consumed by the orchestrator).
   *
   * Valid: only `completed`, `error`, or `cancelled` → `reconciled`.
   * Idempotent: already-reconciled jobs are returned as-is.
   * Rejected: `running` → `reconciled`.
   */
  async markReconciled(taskID: string): Promise<BackgroundJobRecord | undefined> {
    const job = this.jobs.get(taskID)
    if (!job) return undefined

    if (job.state === 'reconciled') {
      return job
    }

    if (!TERMINAL_STATES.has(job.state)) {
      throw new Error(
        `Cannot reconcile job ${taskID} in state ${job.state} — only terminal states can be reconciled`,
      )
    }

    const wasTerminalUnreconciled = job.terminalUnreconciled
    job.state = 'reconciled'
    job.updatedAt = Date.now()
    job.terminalUnreconciled = false

    await this.persistRecord(job)
    await this.writeSignal(job)

    if (wasTerminalUnreconciled) {
      this.notifyTerminal(job.taskID)
    }

    return job
  }

  // ─── Queries ─────────────────────────────────────────────────────────

  /** Look up a job by its taskID. */
  get(taskID: string): BackgroundJobRecord | undefined {
    return this.jobs.get(taskID)
  }

  /**
   * List jobs, optionally filtered by parent session ID.
   * Returns a snapshot (shallow copy) of the matching records.
   */
  list(parentSessionID?: string): BackgroundJobRecord[] {
    const all = Array.from(this.jobs.values())
    if (!parentSessionID) return [...all]
    return all.filter((j) => j.parentSessionID === parentSessionID)
  }

  /**
   * Resolve a job by either taskID or alias within a parent session.
   * Checks exact taskID first, then falls back to alias matching.
   */
  resolve(parentSessionID: string, taskIDOrAlias: string): BackgroundJobRecord | undefined {
    // Exact taskID match (session-scoped)
    const byID = this.jobs.get(taskIDOrAlias)
    if (byID?.parentSessionID === parentSessionID) return byID

    // Alias match within session
    for (const job of this.jobs.values()) {
      if (job.parentSessionID === parentSessionID && job.alias === taskIDOrAlias) {
        return job
      }
    }

    return undefined
  }

  /** Check whether a new job can be dispatched for the given agent (concurrency limit). */
  canDispatch(agent: string): boolean {
    return this.getRunningCount(agent) < this.options.maxConcurrentPerAgent
  }

  /** Count currently running jobs, optionally filtered by agent. */
  getRunningCount(agent?: string): number {
    let count = 0
    for (const job of this.jobs.values()) {
      if (job.state === 'running' && (agent === undefined || job.agent === agent)) {
        count++
      }
    }
    return count
  }

  // ─── Terminal State Listeners ────────────────────────────────────────

  /** Register a listener that fires when a job reaches a terminal state. */
  onTerminal(listener: (taskID: string) => void): void {
    this.terminalListeners.add(listener)
  }

  /** Remove a previously registered terminal state listener. */
  removeTerminalListener(listener: (taskID: string) => void): void {
    this.terminalListeners.delete(listener)
  }

  /**
   * Resolve with the job record once the job reaches a terminal state
   * (`completed`, `error`, `cancelled`, or `reconciled`), or reject with a
   * timeout error if `timeoutMs` elapses first.
   *
   * Resolves immediately when the job is already terminal at call time.
   * Multiple concurrent waiters for the same taskID all resolve.
   */
  waitForTerminal(taskID: string, timeoutMs: number): Promise<BackgroundJobRecord> {
    const existing = this.jobs.get(taskID)
    if (existing && (TERMINAL_STATES.has(existing.state) || existing.state === 'reconciled')) {
      return Promise.resolve(existing)
    }

    return new Promise<BackgroundJobRecord>((resolve, reject) => {
      const waiter: TerminalWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeTerminalWaiter(taskID, waiter)
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for job ${taskID} to reach a terminal state`,
            ),
          )
        }, timeoutMs),
      }
      const waiters = this.terminalWaiters.get(taskID) ?? []
      waiters.push(waiter)
      this.terminalWaiters.set(taskID, waiters)
    })
  }

  private removeTerminalWaiter(taskID: string, waiter: TerminalWaiter): void {
    const waiters = this.terminalWaiters.get(taskID)
    if (!waiters) return
    const idx = waiters.indexOf(waiter)
    if (idx < 0) return
    waiters.splice(idx, 1)
    if (waiters.length === 0) {
      this.terminalWaiters.delete(taskID)
    }
  }

  private resolveTerminalWaiters(taskID: string): void {
    const waiters = this.terminalWaiters.get(taskID)
    if (!waiters) return
    this.terminalWaiters.delete(taskID)
    const job = this.jobs.get(taskID)
    for (const waiter of waiters) {
      clearTimeout(waiter.timer)
      if (job) {
        waiter.resolve(job)
      } else {
        waiter.reject(new Error(`Job ${taskID} was removed before reaching a terminal state`))
      }
    }
  }

  // ─── Prompt Integration ──────────────────────────────────────────────

  /**
   * Generate a formatted prompt fragment for the agent system prompt,
   * showing all background jobs for the given parent session.
   * Returns `undefined` when there are no jobs (caller can skip the section).
   */
  formatForPrompt(parentSessionID: string): string | undefined {
    const jobs = this.list(parentSessionID)
    if (jobs.length === 0) return undefined

    const lines = jobs.map((j) => {
      const status =
        j.state === 'completed'
          ? 'OK'
          : j.state === 'error'
            ? 'ERR'
            : j.state === 'cancelled'
              ? 'CAN'
              : j.state === 'running'
                ? 'RUN'
                : 'REC'
      return `  [${j.alias}] ${j.description} — ${status}`
    })

    return `Background Jobs:\n${lines.join('\n')}`
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────

  /**
   * Remove jobs whose `updatedAt` is older than `ttlMs` milliseconds.
   *
   * Only TERMINAL (completed/error/cancelled) and reconciled jobs are pruned —
   * running jobs are never pruned. Each pruned job is also removed from the
   * persistence adapter so it doesn't resurface after a restart.
   */
  async pruneExpired(ttlMs: number): Promise<void> {
    const now = Date.now()
    const expired: BackgroundJobRecord[] = []
    for (const job of this.jobs.values()) {
      const isDone = TERMINAL_STATES.has(job.state) || job.state === 'reconciled'
      if (isDone && now - job.updatedAt > ttlMs) {
        expired.push(job)
      }
    }
    for (const job of expired) {
      this.jobs.delete(job.taskID)
      await this.deletePersisted(job.taskID)
    }
  }

  /** Remove all jobs belonging to a parent session. */
  clearParent(parentSessionID: string): void {
    for (const [taskID, job] of this.jobs) {
      if (job.parentSessionID === parentSessionID) {
        this.jobs.delete(taskID)
      }
    }
  }

  // ─── Internal Helpers ────────────────────────────────────────────────

  private async persistRecord(record: BackgroundJobRecord): Promise<void> {
    if (!this.persistence) return
    try {
      await this.persistence.saveJob(record)
    } catch (err) {
      log.error(`[BackgroundJobBoard] Failed to persist job ${record.taskID}:`, err)
    }
  }

  private async deletePersisted(taskID: string): Promise<void> {
    if (!this.persistence) return
    try {
      await this.persistence.deleteJob(taskID)
    } catch (err) {
      log.error(`[BackgroundJobBoard] Failed to delete persisted job ${taskID}:`, err)
    }
  }

  private notifyTerminal(taskID: string): void {
    for (const listener of this.terminalListeners) {
      try {
        listener(taskID)
      } catch (err) {
        log.error(`[BackgroundJobBoard] Terminal listener error for ${taskID}:`, err)
      }
    }
    this.resolveTerminalWaiters(taskID)
  }

  private async writeSignal(record: BackgroundJobRecord): Promise<void> {
    const signalDir = this.options.signalDir
    if (!signalDir) return

    const signalPath = join(signalDir, `${record.alias}.signal.json`)
    const tmpPath = join(signalDir, `${record.alias}.signal.tmp`)
    const content = JSON.stringify({
      taskID: record.taskID,
      alias: record.alias,
      agent: record.agent,
      state: record.state,
      summary: record.resultSummary ?? null,
      timestamp: Date.now(),
    })

    try {
      await mkdir(dirname(signalPath), { recursive: true })
      await writeFile(tmpPath, content, 'utf-8')
      await rename(tmpPath, signalPath)
    } catch (err) {
      log.error(`[BackgroundJobBoard] Failed to write signal for ${record.alias}:`, err)
    }
  }
}
