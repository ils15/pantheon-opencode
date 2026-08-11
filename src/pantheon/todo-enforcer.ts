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
 *   1. user-activity — a session whose user sent a message within
 *      `userActivityQuietMs` is being driven interactively → skip;
 *   2. board-running — a session with a running background job is skipped
 *      (the parent is busy; the child session itself is never routed here);
 *   3. native-children — opencode `task(background=true)` children are NOT on
 *      our board, so `session.children()` is checked: an active child (its
 *      `time.updated` newer than `childActiveMs`) means the parent is still
 *      waiting on a native background task → skip. Throws fail open (log +
 *      inject) so version-sensitive APIs never break the enforcer;
 *   4. in-flight — one injection per idle, never concurrent;
 *   5. cooldown — exponential per-session backoff `cooldownBaseMs *
 *      2^min(failures, max)`, failures increment when an injection does not
 *      clear todos (the next idle shows the same-or-worse incomplete count);
 *   6. max-consecutive-failures — stop injecting after the cap; the failure
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
import { createPantheonLogger } from './logger.ts'

// Silence-by-default TUI policy (pantheon-hooks L42-58): the default warn
// fallback logs to .pantheon/logs/hooks.log; console echo is opt-in via
// PANTHEON_HOOKS_LOG=1. `deps.logger` injection stays for tests.
const log = createPantheonLogger({ module: 'pantheon-todo' })

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
  /** Skip injection this long after a user message in the session. */
  userActivityQuietMs: 30000,
  /** A native child whose `time.updated` is newer than this is still running. */
  childActiveMs: 120000,
} as const

/**
 * Runtime kill-switch: `PANTHEON_TODO_ENFORCER=off` disables the enforcer.
 * Read at plugin construction — routing.yml is a doc mirror only, this env
 * var is the real runtime switch (COMPACTION_MAX_ITEMS precedent).
 */
export function todoEnforcerEnabledFromEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (env.PANTHEON_TODO_ENFORCER ?? '').trim().toLowerCase() !== 'off'
}

// ─── Types ─────────────────────────────────────────────────────────────

/** Structural view of a session todo item (SDK Todo: status is a string). */
export interface TodoLike {
  content?: string
  status: string
  priority?: string
  id?: string
}

/**
 * Structural view of a child session from `session.children()` (SDK Session).
 * Only `time.updated` is used — a running native background task keeps
 * updating its session while streaming; a completed one freezes.
 */
export interface TodoEnforcerChild {
  id: string
  time?: { updated?: number }
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
    children(input: { path: { id: string } }): Promise<TodoEnforcerChild[]>
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
  /** Skip injection while a user message is more recent than this. */
  userActivityQuietMs?: number
  /** Native child sessions newer than this are considered active/running. */
  childActiveMs?: number
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
  /** Last user-message timestamp per session (wired from chat.message). */
  private readonly lastUserMessageAt = new Map<string, number>()

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
      userActivityQuietMs: opts.userActivityQuietMs ?? TODO_ENFORCER_DEFAULTS.userActivityQuietMs,
      childActiveMs: opts.childActiveMs ?? TODO_ENFORCER_DEFAULTS.childActiveMs,
      now: opts.now ?? Date.now,
    }
    this.warn = deps.logger?.warn ?? ((message: string) => log.warn(message))
  }

  /**
   * Record that the user just sent a message in `sessionID` (wired from the
   * plugin `chat.message` hook). Suppresses injection for `userActivityQuietMs`
   * — an interactive session is being driven by the user, don't nag it.
   */
  noteUserActivity(sessionID: string): void {
    this.lastUserMessageAt.set(sessionID, this.options.now())
  }

  /**
   * List the session's PENDING todos (not completed/cancelled) — the same
   * incomplete filter as the idle continuation, exposed for the compaction
   * context builder. Returns [] when the enforcer is disabled or the todo
   * API fails (fail-open: the compaction hook must never break the
   * session).
   */
  async listPendingTodos(sessionID: string): Promise<TodoLike[]> {
    if (!this.options.enabled) return []
    try {
      const todos = await this.client.session.todo({ path: { id: sessionID } })
      return todos.filter((todo) => todo.status !== 'completed' && todo.status !== 'cancelled')
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      this.warn(`todo list failed for session ${sessionID}: ${reason}`)
      return []
    }
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

    // Guard 1: user activity — a fresh user message means the session is being
    // driven interactively; don't nag it.
    const lastUser = this.lastUserMessageAt.get(sessionID)
    if (lastUser !== undefined && now - lastUser < this.options.userActivityQuietMs) return

    // Guard 2: a session with a running board job is busy — skip.
    if (this.board.list(sessionID).some((job) => job.state === 'running')) return

    // Guard 3: native background task() children are NOT on our board — an
    // active child means the parent is still waiting on it, so skip.
    if ((await this.activeChildren(sessionID, now)) > 0) return

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
   * Count active native child sessions. opencode `task(background=true)`
   * children are NOT registered on our board, so the only way to see them is
   * `session.children()`. A child is active while its `time.updated` is newer
   * than `childActiveMs` — a running background task keeps updating its
   * session while streaming; a completed one freezes. Fail-open: when the
   * children API is unavailable (older opencode / permission), log and return
   * 0 so the enforcer still works on version-sensitive runtimes.
   */
  private async activeChildren(sessionID: string, now: number): Promise<number> {
    try {
      const children = await this.client.session.children({ path: { id: sessionID } })
      return children.filter((child) => {
        const updated = child.time?.updated
        return typeof updated === 'number' && now - updated < this.options.childActiveMs
      }).length
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      this.warn(`todo children check failed for session ${sessionID}: ${reason}`)
      return 0
    }
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
