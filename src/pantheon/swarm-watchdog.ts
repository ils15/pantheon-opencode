/**
 * Deterministic Plugin Stall Watchdog (`swarm-watchdog.ts`).
 *
 * Observes `PantheonBus` progress events (`job:*`, `board:message`,
 * `agent:execution:receipt`, `review:verdict`, `themis:reflex:escalated`) and
 * periodically inspects `BackgroundJobBoard` on a `.unref()`'d interval to
 * detect stalled running jobs, unreconciled terminal jobs, and quota
 * exhaustion with exponential backoff and per-job alert caps.
 *
 * @module pantheon/swarm-watchdog
 */

import type { BackgroundJobBoard, BackgroundJobRecord } from './background-job-board.ts'
import { appendBoardMessage } from './board-messages.ts'
import { getSharedBus, type SwarmStallDetectedEventPayload } from './bus.ts'
import { getSharedBoard } from './shared-board.ts'

export interface SwarmWatchdogOptions {
  readonly board?: BackgroundJobBoard
  readonly workspaceDir?: string
  readonly checkIntervalMs?: number
  readonly stallThresholdMs?: number
  readonly unreconciledThresholdMs?: number
  readonly baseBackoffMs?: number
  readonly maxAlertsPerJob?: number
  readonly appendAlertMessage?: boolean
  readonly now?: () => number
  readonly onStall?: (payload: SwarmStallDetectedEventPayload) => void
}

interface AlertTracking {
  attempts: number
  lastAlertAt: number
}

const DEFAULT_CHECK_INTERVAL_MS = 15_000
const DEFAULT_STALL_THRESHOLD_MS = 90_000
const DEFAULT_UNRECONCILED_THRESHOLD_MS = 45_000
const DEFAULT_BASE_BACKOFF_MS = 30_000
const DEFAULT_MAX_ALERTS_PER_JOB = 3
const QUOTA_ERROR_RE = /quota|rate.?limit|too many requests|429|capacity/i

export class SwarmWatchdog {
  private readonly board: BackgroundJobBoard
  private readonly workspaceDir: string | undefined
  private readonly checkIntervalMs: number
  private readonly stallThresholdMs: number
  private readonly unreconciledThresholdMs: number
  private readonly baseBackoffMs: number
  private readonly maxAlertsPerJob: number
  private readonly appendAlertMessage: boolean
  private readonly now: () => number
  private readonly onStall: ((payload: SwarmStallDetectedEventPayload) => void) | undefined

  private readonly lastActivityByTask = new Map<string, number>()
  private readonly lastActivityByAgent = new Map<string, number>()
  private readonly alertsByTask = new Map<string, AlertTracking>()
  private readonly busUnsubs: Array<() => void> = []
  private timer: NodeJS.Timeout | null = null
  private started = false

  constructor(options: SwarmWatchdogOptions = {}) {
    this.board = options.board ?? getSharedBoard()
    this.workspaceDir = options.workspaceDir
    this.checkIntervalMs = options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS
    this.stallThresholdMs = options.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS
    this.unreconciledThresholdMs =
      options.unreconciledThresholdMs ?? DEFAULT_UNRECONCILED_THRESHOLD_MS
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS
    this.maxAlertsPerJob = options.maxAlertsPerJob ?? DEFAULT_MAX_ALERTS_PER_JOB
    this.appendAlertMessage = options.appendAlertMessage ?? true
    this.now = options.now ?? Date.now
    this.onStall = options.onStall
  }

  /** Start subscribing to PantheonBus activity signals and running the `.unref()`'d poll timer. */
  start(): void {
    if (this.started) return
    this.started = true
    const bus = getSharedBus()
    this.busUnsubs.push(
      bus.on('job:created', (ev) => this.recordTaskActivity(ev.taskID, ev.agent)),
      bus.on('job:updated', (ev) => this.recordTaskActivity(ev.taskID, ev.agent)),
      bus.on('job:terminal', (ev) => this.recordTaskActivity(ev.taskID, ev.agent)),
      bus.on('job:reconciled', (ev) => {
        this.lastActivityByTask.delete(ev.taskID)
        this.alertsByTask.delete(ev.taskID)
      }),
      bus.on('board:message', (ev) => {
        if (ev.from !== 'watchdog') {
          this.lastActivityByAgent.set(ev.from.toLowerCase(), this.now())
        }
      }),
      bus.on('agent:execution:receipt', (ev) => {
        this.recordTaskActivity(ev.taskID, ev.agent)
      }),
      bus.on('review:verdict', (ev) => {
        this.lastActivityByAgent.set(ev.targetAgent.toLowerCase(), this.now())
      }),
      bus.on('themis:reflex:escalated', (ev) => {
        this.recordTaskActivity(ev.taskID, ev.agent)
      }),
    )

    if (this.checkIntervalMs > 0 && Number.isFinite(this.checkIntervalMs)) {
      this.timer = setInterval(() => {
        void this.checkOnce()
      }, this.checkIntervalMs)
      this.timer.unref?.()
    }
  }

  /** Stop the watchdog timer and unsubscribe from all bus listeners. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    for (const unsub of this.busUnsubs) {
      try {
        unsub()
      } catch {
        /* best-effort cleanup */
      }
    }
    this.busUnsubs.length = 0
    this.started = false
  }

  /** Record fresh activity for a job/agent and reset its backoff counter. */
  recordTaskActivity(taskID: string, agent?: string): void {
    const ts = this.now()
    this.lastActivityByTask.set(taskID, ts)
    this.alertsByTask.delete(taskID)
    if (agent) {
      this.lastActivityByAgent.set(agent.toLowerCase(), ts)
    }
  }

  private effectiveLastActivity(job: BackgroundJobRecord): number {
    const taskSeen = this.lastActivityByTask.get(job.taskID) ?? 0
    const agentSeen = this.lastActivityByAgent.get(job.agent.toLowerCase()) ?? 0
    return Math.max(job.updatedAt, job.launchedAt, taskSeen, agentSeen)
  }

  private classifyStall(
    job: BackgroundJobRecord,
    currentTime: number,
  ): { reason: SwarmStallDetectedEventPayload['reason']; idleMs: number } | null {
    if (
      job.lastStatusError &&
      QUOTA_ERROR_RE.test(job.lastStatusError) &&
      job.state !== 'reconciled'
    ) {
      const idleMs = Math.max(0, currentTime - (job.completedAt ?? job.updatedAt))
      if (idleMs >= this.unreconciledThresholdMs || job.state === 'error') {
        return { reason: 'quota_exhausted', idleMs }
      }
    }

    if (job.state === 'running') {
      const lastActive = this.effectiveLastActivity(job)
      const idleMs = Math.max(0, currentTime - lastActive)
      if (idleMs >= this.stallThresholdMs) {
        return { reason: 'no_progress', idleMs }
      }
      return null
    }

    if (job.terminalUnreconciled && job.state !== 'reconciled') {
      const terminalAt = job.completedAt ?? job.updatedAt
      const idleMs = Math.max(0, currentTime - terminalAt)
      if (idleMs >= this.unreconciledThresholdMs) {
        return { reason: 'unreconciled_terminal', idleMs }
      }
    }

    return null
  }

  /** Inspect `BackgroundJobBoard` once and emit backoff-gated stall alerts. */
  async checkOnce(): Promise<SwarmStallDetectedEventPayload[]> {
    const currentTime = this.now()
    const emitted: SwarmStallDetectedEventPayload[] = []
    const bus = getSharedBus()

    for (const job of this.board.list()) {
      if (job.state === 'reconciled') {
        this.alertsByTask.delete(job.taskID)
        continue
      }
      const stall = this.classifyStall(job, currentTime)
      if (!stall) continue

      const tracker = this.alertsByTask.get(job.taskID) ?? { attempts: 0, lastAlertAt: 0 }
      if (tracker.attempts >= this.maxAlertsPerJob) continue

      if (tracker.attempts > 0) {
        const requiredWait = this.baseBackoffMs * 2 ** (tracker.attempts - 1)
        if (currentTime - tracker.lastAlertAt < requiredWait) continue
      }

      const attempt = tracker.attempts + 1
      this.alertsByTask.set(job.taskID, { attempts: attempt, lastAlertAt: currentTime })

      const payload: SwarmStallDetectedEventPayload = {
        taskID: job.taskID,
        alias: job.alias,
        agent: job.agent,
        parentSessionID: job.parentSessionID,
        reason: stall.reason,
        idleMs: stall.idleMs,
        attempt,
        timestamp: currentTime,
      }
      emitted.push(payload)
      bus.emit('swarm:stall:detected', payload)
      this.onStall?.(payload)

      if (this.workspaceDir && this.appendAlertMessage) {
        void appendBoardMessage(this.workspaceDir, {
          channel: 'swarm',
          threadId: 'watchdog',
          from: 'watchdog',
          to: [job.agent, 'zeus'],
          tag: 'alert',
          body: `[alert] @${job.agent} @zeus job ${job.alias} (${job.taskID}) stalled (${stall.reason}, idle=${Math.round(stall.idleMs / 1000)}s, attempt ${attempt}/${this.maxAlertsPerJob})`,
          timestamp: currentTime,
        }).catch(() => {
          /* watchdog board alert is strictly best-effort */
        })
      }
    }

    return emitted
  }
}

/** Construct and start a `SwarmWatchdog` for `workspaceDir`, returning its `stop()` cleanup. */
export function wireSwarmWatchdog(
  workspaceDir: string,
  options: Omit<SwarmWatchdogOptions, 'workspaceDir'> = {},
): () => void {
  const watchdog = new SwarmWatchdog({ ...options, workspaceDir })
  watchdog.start()
  return () => watchdog.stop()
}
