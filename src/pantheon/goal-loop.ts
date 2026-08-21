/**
 * Full-auto Goal Loop (Wave 3, PR #46) — one active goal per session,
 * continued automatically while idle. `pantheon_goal_create` starts a goal;
 * `pantheon_goal_update` moves it pending → in_progress → done; while
 * active, `GoalLoop.onIdle` re-injects the continuation prompt (objective
 * restated from the store) until marked done. Council-approved cut: NO LLM
 * completion-audit prompt — the state machine is the source of truth.
 *
 * Persistence: FILE-based GoalStore (`.pantheon/goals/<sessionID>.json`,
 * atomic tmp+rename). Opt-in `full_auto.enabled: false` default. Guards:
 * board-running skip, in-flight Set, cooldown, max_continuations cap (25).
 * Injectable now() clock. Pure TypeScript — zero runtime deps.
 *
 * @module goal-loop
 */

import { z } from 'zod'

import type { BackgroundJobBoard } from './background-job-board.ts'
import type { ToolContextLike } from './delegation.ts'
import { GoalStore } from './goal-store.ts'
import { createPantheonLogger } from './logger.ts'
import { safeSessionPath } from './session-guard.ts'
import type { TodoEnforcerMessage } from './todo-enforcer.ts'

// Silence-by-default TUI policy (pantheon-hooks L42-58): warn → hooks.log,
// console echo opt-in via PANTHEON_HOOKS_LOG=1. `deps.logger` stays for tests.
const log = createPantheonLogger({ module: 'pantheon-goal' })

export type { Goal, GoalStatus } from './goal-store.ts'
export { GoalStore }

// ─── Constants ─────────────────────────────────────────────────────────

/** Continuation text injected into idle sessions. `{objective}` is substituted. */
export const GOAL_CONTINUATION_PROMPT = 'Continue goal: {objective}'

/** Defaults matching routing.yml `full_auto`. */
export const GOAL_LOOP_DEFAULTS = {
  enabled: false,
  cooldownMs: 5000,
  maxContinuations: 25,
} as const

// ─── Types ─────────────────────────────────────────────────────────────

/** Structural client surface — the subset of the SDK the loop uses. */
export interface GoalLoopClient {
  session: {
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

/** Tunables (all optional — see GOAL_LOOP_DEFAULTS). */
export interface GoalLoopOptions {
  enabled?: boolean
  /** Minimum gap between continuations (ms). */
  cooldownMs?: number
  /** Hard cap on continuations per goal — after this the loop halts. */
  maxContinuations?: number
  /** Injectable clock (testable), defaults to `Date.now`. */
  now?: () => number
}

/** Dependencies threaded to the loop (structural board — list only). */
export interface GoalLoopDeps {
  store: GoalStore
  client: GoalLoopClient
  board: Pick<BackgroundJobBoard, 'list'>
  options?: GoalLoopOptions
  logger?: { warn: (message: string) => void }
}

type InheritedContext = {
  agent?: string
  model?: { providerID: string; modelID: string }
}

/** Render a tool failure as error text (tools return errors as TEXT). */
function toolFailure(prefix: string, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err)
  return `${prefix} failed: ${reason}`
}

// ─── Args schemas ──────────────────────────────────────────────────────

const goalCreateArgs = {
  objective: z.string().min(1).describe('The goal objective the session keeps working toward.'),
} satisfies z.ZodRawShape

const goalUpdateArgs = {
  status: z.enum(['pending', 'in_progress', 'done']).optional().describe('New goal status.'),
  objective: z.string().min(1).optional().describe('New goal objective.'),
} satisfies z.ZodRawShape

const goalGetArgs = {} satisfies z.ZodRawShape

/** One structural goal tool: description + zod args shape + execute (delegation.ts shape). */
export type GoalTool<Args extends z.ZodRawShape> = {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, ctx: ToolContextLike): Promise<string>
}

/** The three goal tools. */
export interface GoalToolset {
  pantheon_goal_create: GoalTool<typeof goalCreateArgs>
  pantheon_goal_update: GoalTool<typeof goalUpdateArgs>
  pantheon_goal_get: GoalTool<typeof goalGetArgs>
}

// ─── GoalLoop ──────────────────────────────────────────────────────────

/**
 * Re-inject a continuation prompt into idle sessions with an active goal.
 * Per-session state: last-continuation timestamp (cooldown) and an in-flight
 * set (never concurrent). `onIdle` never throws — the event hook can never
 * break the session.
 */
export class GoalLoop {
  private readonly store: GoalStore
  private readonly client: GoalLoopClient
  private readonly board: Pick<BackgroundJobBoard, 'list'>
  private readonly options: Required<GoalLoopOptions>
  private readonly warn: (message: string) => void

  private readonly inFlight = new Set<string>()
  private readonly lastContinuationAt = new Map<string, number>()

  constructor(deps: GoalLoopDeps) {
    this.store = deps.store
    this.client = deps.client
    this.board = deps.board
    const opts = deps.options ?? {}
    this.options = {
      enabled: opts.enabled ?? GOAL_LOOP_DEFAULTS.enabled,
      cooldownMs: opts.cooldownMs ?? GOAL_LOOP_DEFAULTS.cooldownMs,
      maxContinuations: opts.maxContinuations ?? GOAL_LOOP_DEFAULTS.maxContinuations,
      now: opts.now ?? Date.now,
    }
    this.warn = deps.logger?.warn ?? ((message: string) => log.warn(message))
  }

  /** True when the session has an active (non-done) goal. Used by the idle dispatcher. */
  async hasActiveGoal(sessionID: string): Promise<boolean> {
    return this.store.hasActive(sessionID)
  }

  /** Handle a `session.idle` event for a session with an active goal. Never throws. */
  async onIdle(sessionID: string): Promise<void> {
    if (!this.options.enabled) return
    if (this.inFlight.has(sessionID)) return
    this.inFlight.add(sessionID)
    try {
      await this.handleIdle(sessionID)
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      this.warn(`goal continuation failed for session ${sessionID}: ${reason}`)
    } finally {
      this.inFlight.delete(sessionID)
    }
  }

  private async handleIdle(sessionID: string): Promise<void> {
    const goal = await this.store.load(sessionID)
    // DONE (or absent) goal → nothing to continue.
    if (goal === undefined || goal.status === 'done') return

    // A session with a running background job is busy — skip.
    if (this.board.list(sessionID).some((job) => job.state === 'running')) return

    // Hard cap: stop the loop once the cap is reached.
    if (goal.continuationCount >= this.options.maxContinuations) return

    const now = this.options.now()
    const last = this.lastContinuationAt.get(sessionID)
    if (last !== undefined && now - last < this.options.cooldownMs) return

    // Timestamp BEFORE the call — a failed injection still applies the
    // cooldown (no hot retry loop).
    this.lastContinuationAt.set(sessionID, now)
    const inherited = await this.inheritAgentOrModel(sessionID)
    const prompt = GOAL_CONTINUATION_PROMPT.replace('{objective}', goal.objective)
    const promptPath = safeSessionPath(sessionID)
    if (!promptPath) {
      this.warn(`goal continuation skipped: invalid sessionID "${sessionID}"`)
      return
    }
    await this.client.session.promptAsync({
      path: promptPath.path,
      body: {
        ...(inherited.agent !== undefined ? { agent: inherited.agent } : {}),
        ...(inherited.model !== undefined ? { model: inherited.model } : {}),
        parts: [{ type: 'text', text: prompt }],
      },
    })
    goal.continuationCount += 1
    goal.updatedAt = now
    await this.store.save(goal)
  }

  /**
   * Inherit the agent (or model) from the LAST assistant message so the
   * continuation runs in the same context as the session's last turn.
   */
  private async inheritAgentOrModel(sessionID: string): Promise<InheritedContext> {
    const path = safeSessionPath(sessionID)
    if (!path) {
      this.warn(`inherit skipped: invalid sessionID "${sessionID}"`)
      return {}
    }
    const messages = await this.client.session.messages(path)
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

  /** Build the three structural goal tools (single active goal per session). */
  tools(): GoalToolset {
    return {
      pantheon_goal_create: {
        description:
          'Create the single active goal for this session. The goal loop then continues the session automatically on idle until the goal is marked done.',
        args: goalCreateArgs,
        execute: async (args, ctx) => {
          try {
            this.store.sanitizeSessionID(ctx.sessionID)
            const existing = await this.store.load(ctx.sessionID)
            if (existing !== undefined && existing.status !== 'done') {
              return `pantheon_goal_create failed: session ${ctx.sessionID} already has an active goal`
            }
            const now = this.options.now()
            await this.store.save({
              id: ctx.sessionID,
              sessionID: ctx.sessionID,
              objective: args.objective,
              status: 'pending',
              createdAt: now,
              updatedAt: now,
              continuationCount: 0,
            })
            return `Goal created (${ctx.sessionID}): ${args.objective}`
          } catch (err: unknown) {
            return toolFailure('pantheon_goal_create', err)
          }
        },
      },
      pantheon_goal_update: {
        description:
          'Update the active goal: set status (pending/in_progress/done) and/or rewrite the objective. Setting status to done stops all further continuations.',
        args: goalUpdateArgs,
        execute: async (args, ctx) => {
          try {
            const goal = await this.store.load(ctx.sessionID)
            if (goal === undefined) {
              return `pantheon_goal_update failed: no active goal for session ${ctx.sessionID}`
            }
            if (args.status === undefined && args.objective === undefined) {
              return 'pantheon_goal_update failed: provide status and/or objective'
            }
            if (args.objective !== undefined) goal.objective = args.objective
            if (args.status !== undefined) goal.status = args.status
            goal.updatedAt = this.options.now()
            await this.store.save(goal)
            return `Goal updated: status=${goal.status}, objective=${goal.objective}`
          } catch (err: unknown) {
            return toolFailure('pantheon_goal_update', err)
          }
        },
      },
      pantheon_goal_get: {
        description: 'Return the active goal for this session (status, objective, continuations).',
        args: goalGetArgs,
        execute: async (_args, ctx) => {
          try {
            const goal = await this.store.load(ctx.sessionID)
            if (goal === undefined) {
              return `No active goal for session ${ctx.sessionID}`
            }
            return `Goal (${goal.id}): status=${goal.status}, objective=${goal.objective}, continuations=${goal.continuationCount}`
          } catch (err: unknown) {
            return toolFailure('pantheon_goal_get', err)
          }
        },
      },
    }
  }
}
