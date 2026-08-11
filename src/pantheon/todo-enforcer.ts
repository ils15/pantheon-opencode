/**
 * TODO Enforcer (Wave 1) — keeps root/non-board sessions working on their
 * todo list when the session goes idle.
 *
 * The plugin's `event` hook dispatches `session.idle`: board-child sessions go
 * to the delegation finalize path (`handleDelegationEvent`), everything else
 * (roots, non-board sessions) goes to `TodoEnforcer.onIdle`. The enforcer
 * re-injects a continuation prompt when the session went idle with incomplete
 * todos, so the agent keeps working on its task list instead of stopping.
 *
 * Guards (council-approved cut — latch/skipAgents/countdown-toast removed):
 *   1. board-running — a session with a running background job is skipped
 *      (the parent is busy; the child session itself is never routed here);
 *   2. in-flight — one injection per idle, never concurrent;
 *   3. cooldown — exponential per-session backoff `cooldownBaseMs *
 *      2^min(failures, max)`, failures increment when an injection does not
 *      clear todos (the next idle shows the same-or-worse incomplete count);
 *   4. max-consecutive-failures — stop injecting after the cap; the failure
 *      counter resets after a quiet period (`failureResetMs`) and when an
 *      injection makes progress (streak semantics).
 *
 * DONE detection: all todos `completed`/`cancelled` (or no todos at all) →
 * no injection this idle. The todo re-fetch is cheap, so no done-latch is
 * needed.
 *
 * The enforcer NEVER touches the TUI (no toast — council cut: toasts are
 * no-ops on opencode 1.18.13). It depends only on `session.todo`,
 * `session.messages` (agent/model inheritance via the last assistant
 * message) and `session.promptAsync`
 * (injection).
 *
 * Pure TypeScript — zero runtime dependencies beyond the board types.
 *
 * @module todo-enforcer
 */

import type { BackgroundJobBoard } from './background-job-board.ts'

// ─── Constants ─────────────────────────────────────────────────────────

/**
 * Version-controlled continuation text injected into the idle session.
 * Exported for tests and so the routing.yml comment stays in sync.
 */
export const TODO_CONTINUATION_PROMPT =
  'Incomplete tasks remain in your todo list. Continue working on them. Do not stop until all are done. If you believe all work is complete, critically re-examine whether the completion claim is verifiable.'

/** Defaults matching routing.yml `todo_enforcer`. */
export const TODO_ENFORCER_DEFAULTS = {
  enabled: true,
  cooldownBaseMs: 5000,
  maxConsecutiveFailures: 5,
  failureResetMs: 300000,
} as const

// ─── Types ─────────────────────────────────────────────────────────────

/** Structural view of a session todo item (SDK Todo: status is a string). */
export interface TodoLike {
  content?: string
  status: string
  priority?: string
  id?: string
}

/**
 * Structural view of one message bundle from `session.messages()`. The SDK
 * returns `{ info: Message, parts: Part[] }` — user messages carry `agent`
 * on `info`, assistant messages carry `providerID`/`modelID` (or a `model`
 * object).
 */
export interface TodoEnforcerMessage {
  info?: {
    role?: string
    agent?: string
    model?: { providerID?: string; modelID?: string }
    providerID?: string
    modelID?: string
  }
  parts?: Array<{ type?: string; text?: string }>
}

/** Structural client surface — the subset of the SDK the enforcer uses. */
export interface TodoEnforcerClient {
  session: {
    todo(input: { path: { id: string } }): Promise<TodoLike[]>
    messages(input: { path: { id: string } }): Promise<TodoEnforcerMessage[]>
    promptAsync(input: {
      path: { id: string }
      body: {
        agent?: string
        model?: { providerID: string; modelID: string }
        parts: Array<{ type: 'text'; text: string }>
      }
    }): Promise<unknown>
  }
}

/** Tunables (all optional — see TODO_ENFORCER_DEFAULTS). */
export interface TodoEnforcerOptions {
  enabled?: boolean
  /** Base cooldown after a failed injection; doubles per failure. */
  cooldownBaseMs?: number
  /** Stop injecting after this many consecutive failures. */
  maxConsecutiveFailures?: number
  /** Quiet period after which the failure counter resets. */
  failureResetMs?: number
  /** Injectable clock (testable), defaults to `Date.now`. */
  now?: () => number
}

/** Dependencies threaded to the enforcer (structural board — list only). */
export interface TodoEnforcerDeps {
  client: TodoEnforcerClient
  board: Pick<BackgroundJobBoard, 'list'>
  options?: TodoEnforcerOptions
  logger?: { warn: (message: string) => void }
}

type InheritedContext = {
  agent?: string
  model?: { providerID: string; modelID: string }
}

// ─── TodoEnforcer ──────────────────────────────────────────────────────

/**
 * Re-inject a continuation prompt into idle sessions that still have
 * incomplete todos. Per-session state: last injection time, the incomplete
 * count at injection, the pending outcome check, and the consecutive-failure
 * counter. All guards are best-effort — `onIdle` never throws, so the event
 * hook can never break the session.
 */
export class TodoEnforcer {
  private readonly client: TodoEnforcerClient
  private readonly board: Pick<BackgroundJobBoard, 'list'>
  private readonly options: Required<TodoEnforcerOptions>
  private readonly warn: (message: string) => void

  /** Guard 2: sessions with an in-flight onIdle (reserved synchronously). */
  private readonly inFlight = new Set<string>()
  /** Last injection timestamp per session. */
  private readonly lastInjectionAt = new Map<string, number>()
  /** Incomplete-todo count recorded at the last injection per session. */
  private readonly lastInjectedIncomplete = new Map<string, number>()
  /** True when the last injection's outcome has NOT been evaluated yet. */
  private readonly pendingCheck = new Map<string, boolean>()
  /** Consecutive failures per session. */
  private readonly failures = new Map<string, number>()

  constructor(deps: TodoEnforcerDeps) {
    this.client = deps.client
    this.board = deps.board
    const opts = deps.options ?? {}
    this.options = {
      enabled: opts.enabled ?? TODO_ENFORCER_DEFAULTS.enabled,
      cooldownBaseMs: opts.cooldownBaseMs ?? TODO_ENFORCER_DEFAULTS.cooldownBaseMs,
      maxConsecutiveFailures:
        opts.maxConsecutiveFailures ?? TODO_ENFORCER_DEFAULTS.maxConsecutiveFailures,
      failureResetMs: opts.failureResetMs ?? TODO_ENFORCER_DEFAULTS.failureResetMs,
      now: opts.now ?? Date.now,
    }
    this.warn =
      deps.logger?.warn ?? ((message: string) => console.warn(`[pantheon-todo] ${message}`))
  }

  /**
   * Handle a `session.idle` event for a non-board session. Evaluates the
   * previous injection's outcome, applies the guards, and injects the
   * continuation prompt when incomplete todos remain and the guards allow.
   * Never throws — internal failures are logged and swallowed.
   */
  async onIdle(sessionID: string): Promise<void> {
    if (!this.options.enabled) return
    if (this.inFlight.has(sessionID)) return
    this.inFlight.add(sessionID)
    try {
      await this.handleIdle(sessionID)
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      this.warn(`todo injection failed for session ${sessionID}: ${reason}`)
    } finally {
      this.inFlight.delete(sessionID)
    }
  }

  private async handleIdle(sessionID: string): Promise<void> {
    const now = this.options.now()

    // Guard 1: a session with a running background job is busy — skip.
    if (this.board.list(sessionID).some((job) => job.state === 'running')) return

    const todos = await this.client.session.todo({ path: { id: sessionID } })
    const incomplete = todos.filter(
      (todo) => todo.status !== 'completed' && todo.status !== 'cancelled',
    ).length

    // DONE detection: nothing left to enforce. Drop any pending outcome check.
    if (incomplete === 0) {
      this.pendingCheck.delete(sessionID)
      return
    }

    // Evaluate the previous injection: same-or-worse count → failure; making
    // progress breaks the streak. Only one evaluation per injection.
    if (this.pendingCheck.get(sessionID) === true) {
      const before = this.lastInjectedIncomplete.get(sessionID)
      if (before !== undefined && incomplete >= before) {
        this.failures.set(sessionID, (this.failures.get(sessionID) ?? 0) + 1)
      } else {
        this.failures.set(sessionID, 0)
      }
      this.pendingCheck.delete(sessionID)
    }

    // Quiet-period reset: a long silence since the last injection clears the
    // failure counter (prevents permanent lock-out).
    const lastInjection = this.lastInjectionAt.get(sessionID)
    if (
      lastInjection !== undefined &&
      (this.failures.get(sessionID) ?? 0) > 0 &&
      now - lastInjection >= this.options.failureResetMs
    ) {
      this.failures.set(sessionID, 0)
    }

    const failures = this.failures.get(sessionID) ?? 0

    // Guard 4: consecutive-failure cap reached → stop injecting.
    if (failures >= this.options.maxConsecutiveFailures) return

    // Guard 3: exponential cooldown since the last injection.
    if (lastInjection !== undefined && now - lastInjection < this.cooldownMs(failures)) {
      return
    }

    // Inject. The attempt timestamp is recorded BEFORE the call so a failed
    // (throwing) injection still applies the cooldown — no hot retry loop.
    this.lastInjectionAt.set(sessionID, now)
    const inherited = await this.inheritAgentOrModel(sessionID)
    await this.client.session.promptAsync({
      path: { id: sessionID },
      body: {
        ...(inherited.agent !== undefined ? { agent: inherited.agent } : {}),
        ...(inherited.model !== undefined ? { model: inherited.model } : {}),
        parts: [{ type: 'text', text: TODO_CONTINUATION_PROMPT }],
      },
    })
    this.lastInjectedIncomplete.set(sessionID, incomplete)
    this.pendingCheck.set(sessionID, true)
  }

  /** Cooldown for a given failure count: base * 2^min(failures, cap). */
  private cooldownMs(failures: number): number {
    return (
      this.options.cooldownBaseMs * 2 ** Math.min(failures, this.options.maxConsecutiveFailures)
    )
  }

  /**
   * Inherit the agent (or model) from the LAST assistant message so the
   * continuation runs in the same context as the session's last turn. Returns
   * an empty object when no assistant message carries usable context — the
   * SDK then applies the session default.
   */
  private async inheritAgentOrModel(sessionID: string): Promise<InheritedContext> {
    const messages = await this.client.session.messages({ path: { id: sessionID } })
    for (const msg of [...messages].reverse()) {
      const info = msg.info
      if (info === undefined || info.role !== 'assistant') continue
      if (typeof info.agent === 'string' && info.agent !== '') {
        return { agent: info.agent }
      }
      const providerID = info.model?.providerID ?? info.providerID
      const modelID = info.model?.modelID ?? info.modelID
      if (
        typeof providerID === 'string' &&
        providerID !== '' &&
        typeof modelID === 'string' &&
        modelID !== ''
      ) {
        return { model: { providerID, modelID } }
      }
    }
    return {}
  }
}
