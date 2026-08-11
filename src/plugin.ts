import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import type { PluginConfig } from 'opencode'
import { BackgroundJobBoard } from './pantheon/background-job-board.ts'
import { createCostCommand } from './pantheon/cost-command.ts'
import { createDelegationTools, type DelegationClient } from './pantheon/delegation.ts'
import { buildCompactionContext } from './pantheon/delegation-compaction.ts'
import { createEnforcementGuard, readOnlyRegistry } from './pantheon/delegation-enforce.ts'
import { DelegationNotifier, handleDelegationEvent } from './pantheon/delegation-notify.ts'
import { FilePersistenceAdapter } from './pantheon/file-persistence.ts'
import { GOAL_LOOP_DEFAULTS, GoalLoop, GoalStore } from './pantheon/goal-loop.ts'
import { createReadEnhancer } from './pantheon/hashline/read-enhancer.ts'
import { createHashlineEditTool } from './pantheon/hashline/tool.ts'
import { createIdleDispatcher } from './pantheon/idle-continuation.ts'
import { applyActivePresetToConfig } from './pantheon/presets.mjs'
import {
  TODO_ENFORCER_DEFAULTS,
  TodoEnforcer,
  type TodoEnforcerClient,
} from './pantheon/todo-enforcer.ts'
import { activePresetCandidates, createVisionHandler } from './pantheon/vision.ts'

// ─── Background Job Board Singleton ────────────────────────────────────

const board = new BackgroundJobBoard({
  maxConcurrentPerAgent: 3,
  signalDir: '.pantheon/deepwork/board-signals',
})
const persistence = new FilePersistenceAdapter('.pantheon/board/state.json')
board.setPersistence(persistence)
board
  .recoverRunningJobs()
  .catch((err) => console.error('[Pantheon Plugin] Failed to recover running jobs:', err))
// ─── Phase 3: Completion Notifications ────────────────────────────────

// The notifier is the completion channel: the spike refuted client push
// (noReply delivers nothing to the parent), so terminal-job notifications are
// QUEUED here and injected into the parent's next chat.message by the flush in
// the 'chat.message' hook below (graceful-degradation path). Gated by the same
// env as pantheon-hooks toasts: PANTHEON_TOASTS=off disables queueing.
const notifier = new DelegationNotifier()
const notificationsEnabled = (process.env.PANTHEON_TOASTS ?? '').trim().toLowerCase() !== 'off'

board.onTerminal((taskID: string) => {
  const job = board.get(taskID)
  if (!job) return
  console.log(
    `[Pantheon Plugin] Board terminal: [${job.alias}] ${job.description} → ${job.state}${job.resultSummary ? ` — ${job.resultSummary}` : ''}`,
  )
  // Queue the completion notification for the job's parent session. The
  // onTerminal listener is the SINGLE notification point — the timeout path
  // (timeout finalize → updateStatus) and the event path (session.idle →
  // finalizeDelegation → updateStatus) both transition the board and fire
  // here, so every terminal job (incl. timedOut) gets exactly one notification.
  if (notificationsEnabled) {
    notifier.notifyParent(job)
  }
})

// Periodically prune terminal/reconciled jobs (24h TTL, every 30 min).
// pruneExpired is async and internally swallows persistence errors, so the
// void-catch here is purely defensive. .unref() ensures the timer never
// keeps the process alive on its own.
setInterval(
  () => {
    void board
      .pruneExpired(86_400_000)
      .catch((err: unknown) =>
        console.error('[Pantheon Plugin] Background board prune failed:', err),
      )
  },
  30 * 60 * 1000,
).unref()

// ─── Phase 4: Read-Only Enforcement + Compaction Context ───────────────

// The read-only registry is populated by createDelegationTools (delegation.ts)
// when a delegate is read-only (explicit flag or agent ∈ readOnlyAgents).
// The guard denies edit/write/bash/task inside those sessions by throwing
// from tool.execute.before; unknown sessions are allowed (safe default).
const enforcementGuard = createEnforcementGuard({
  getReadOnlySessions: () => readOnlyRegistry.sessionIDs(),
})

// Mirrors routing.yml background_delegation.max_compaction_items.
const COMPACTION_MAX_ITEMS = 10

// Root-session registry for the delegation depth guard: sessions created
// without a parentID are roots. Populated from `session.created` events in the
// event hook — the authoritative complement to the knownChildren default
// ("any session WE created is a sub-session") in delegation.ts.
const rootSessions = new Set<string>()

/** Extract the SDK error message ({name, data: {message}}) or a fallback. */
function sdkErrorMessage(error: { data?: { message?: string } } | null | undefined): string {
  const message = error?.data?.message
  return typeof message === 'string' && message.trim() !== '' ? message : 'request failed'
}

/**
 * Adapt the opencode SDK client to the structural DelegationClient the
 * delegation toolset expects: the SDK wraps every call in a
 * `{data, error, request, response}` result while delegation.ts uses direct
 * returns. Errors surface as throws so the toolset's own error handling
 * (tool errors returned as TEXT) keeps working.
 */
function adaptDelegationClient(client: PluginInput['client']): DelegationClient {
  return {
    session: {
      create: async (input) => {
        const body: { parentID?: string; title?: string } = { parentID: input.body.parentID }
        if (input.body.title !== undefined) body.title = input.body.title
        const result = await client.session.create({ body })
        if (result.error) throw new Error(sdkErrorMessage(result.error))
        return { id: result.data.id }
      },
      promptAsync: async (input) => {
        const result = await client.session.promptAsync({
          path: input.path,
          body: { agent: input.body.agent, parts: input.body.parts },
        })
        if (result.error) throw new Error(sdkErrorMessage(result.error))
        return result.data
      },
      messages: async (input) => {
        const result = await client.session.messages({ path: input.path })
        if (result.error) throw new Error(sdkErrorMessage(result.error))
        return result.data
      },
    },
  }
}

/**
 * Adapt the opencode SDK client to the structural TodoEnforcerClient the
 * todo enforcer expects: unwraps the SDK `{data, error, request, response}`
 * result and surfaces errors as throws (the enforcer swallows + logs them,
 * so the event hook can never break the session).
 */
function adaptTodoEnforcerClient(client: PluginInput['client']): TodoEnforcerClient {
  return {
    session: {
      todo: async (input) => {
        const result = await client.session.todo({ path: input.path })
        if (result.error) throw new Error(sdkErrorMessage(result.error))
        return result.data
      },
      messages: async (input) => {
        const result = await client.session.messages({ path: input.path })
        if (result.error) throw new Error(sdkErrorMessage(result.error))
        return result.data
      },
      promptAsync: async (input) => {
        const result = await client.session.promptAsync({ path: input.path, body: input.body })
        if (result.error) throw new Error(sdkErrorMessage(result.error))
        return result.data
      },
    },
  }
}

/**
 * Pantheon plugin for OpenCode. Pasted images are intercepted via the
 * `chat.message` hook (proven to fire in opencode 1.18.11). When a provider
 * key is available — env PANTHEON_OPENCODE_API_KEY / OPENCODE_API_KEY, or the
 * opencode auth store for `opencode auth login` users — the image is
 * described NATIVELY by the multimodal model via the opencode Zen
 * OpenAI-compatible endpoint, and replaced with the text description — no MCP
 * tool required. Without a key the legacy pattern applies: the image is
 * replaced with a text instruction telling the model to call a vision MCP tool
 * (default `pantheon_vision_vision_describe`). Either way the image never reaches
 * the main provider, so text-only models cannot fail with an `image_url` error.
 *
 * The canonical `pantheon-vision` MCP owns the standalone describe/OCR/analyze
 * tools. The installed OpenCode plugin API exposes no stable pre-provider
 * message hook (1.18.11 only exposes the experimental history transform), so
 * that transform is retained as the runtime-compatible fallback. If a stable
 * provider-bound hook is added, register the same sanitizer there instead of
 * assuming this experimental hook is guaranteed to run.
 *
 * IMPORTANT (OpenCode 1.18.11 legacy loader): this module must export EXACTLY
 * ONE function-valued export — the default plugin. The legacy loader does
 * `Object.values(mod)` and invokes every function export as a plugin factory;
 * any named function export (e.g. a re-exported helper like
 * generateInjectionPrompt) is called with a PluginInput object and can throw.
 * Helpers live in src/pantheon/vision.ts and are imported from there directly.
 */
const plugin: Plugin = async (input: PluginInput) => {
  const vision = createVisionHandler(input)
  // Phase 2/3: background delegation toolset + the bound finalize lifecycle
  // hook. Completion is observed through the event hook below
  // (session.idle / session.error on a child) → finalizeDelegation.
  const delegation = createDelegationTools({
    board,
    client: adaptDelegationClient(input.client),
    options: { rootSessions, readOnlyAgents: new Set(['apollo', 'gaia']) },
  })

  // Wave 1 (PR #46): TODO continuation enforcer for root/non-board sessions.
  // Mirrors routing.yml `todo_enforcer` (plugin scope has no routing.yml
  // access — COMPACTION_MAX_ITEMS pattern). The event hook routes non-board
  // session.idle events here; board-child idles go to finalizeDelegation.
  const todoEnforcer = new TodoEnforcer({
    client: adaptTodoEnforcerClient(input.client),
    board,
    options: TODO_ENFORCER_DEFAULTS,
  })

  // Wave 3 (PR #46): full-auto goal loop — opt-in (`full_auto.enabled:
  // false` default, mirrored by GOAL_LOOP_DEFAULTS). File-based GoalStore
  // (`.pantheon/goals/<sessionID>.json` — the plugin layer cannot reach MCP
  // KV). Idle routing: an active goal owns the idle (goal loop); otherwise
  // the todo enforcer gets it (see idle-continuation.ts).
  const goalStore = new GoalStore({ dir: '.pantheon/goals' })
  const goalLoop = new GoalLoop({
    store: goalStore,
    client: adaptTodoEnforcerClient(input.client),
    board,
    options: GOAL_LOOP_DEFAULTS,
  })
  const goalTools = goalLoop.tools()
  const idleDispatcher = createIdleDispatcher({ goalLoop, todoEnforcer })

  // Wave 2 (PR #46): hashline — tag-anchored edits. The read enhancer
  // (tool.execute.after) augments `read` output with per-line sha256 tags
  // (`12#XJ|content`); hashline_edit anchors edits to those refs. Additive —
  // the plugin has no tool.execute.after yet, and pantheon-hooks.ts (a
  // separate plugin instance) keeps its own. Mirrors routing.yml `hashline`.
  const hashlineEdit = createHashlineEditTool()
  const readEnhancer = createReadEnhancer()

  // Wave 4 (PR #46): /cost — delegation cost + token visibility. Reads
  // opencode.db read-only (node:sqlite, falls back to scripts/cost.mjs).
  // Fully wired (unlike dispatch-guard, which is manual-orchestration-only
  // because opencode 1.18.x cannot intercept task completion via hooks).
  const costCommand = createCostCommand()

  return {
    config: async (config: PluginConfig) => {
      config.agentsPath = config.agentsPath ?? []
      config.agentsPath.push(new URL('./agents', import.meta.url).pathname)
      config.skillsPaths = config.skillsPaths ?? []
      config.skillsPaths.push(new URL('./skills', import.meta.url).pathname)

      // Apply the active model preset (`init --preset` / `set-tier` write
      // .pantheon/active-preset.json): resolve it with the SAME candidate
      // order the vision handler uses (project > XDG > HOME) and mutate the
      // agent models / reasoning effort / fallback models + provider configs.
      // Fail-safe: without an active preset the config is untouched; a missing
      // provider key is logged and skipped — the hook must never break startup
      // (set-tier already fail-fast validates keys at write time). Vision
      // rotation stays in vision.ts, which resolves its model independently.
      try {
        const resolved = applyActivePresetToConfig(config, {
          candidates: activePresetCandidates(),
        })
        if (resolved) {
          console.log(
            `[Pantheon Plugin] Applied model preset: ${resolved.name} (${resolved.source})`,
          )
        }
      } catch {
        // Fully STATIC warning — the thrown error object is tainted because
        // presets.mjs constructs it with the provider's apiKeyEnv name (e.g.
        // PANTHEON_OPENCODE_API_KEY), and CodeQL's clear-text logging dataflow
        // flags ANY interpolation derived from it — including err.name and
        // err.message. The env var name is not itself sensitive to log, but
        // the scanner cannot distinguish it, so nothing derived from the error
        // may appear here. Diagnostics (provider id + env var) are already
        // emitted by applyActivePresetToConfig's own logger before it throws.
        // The catch binding is intentionally omitted so no tainted value can
        // ever reach this log line (CodeQL alert #11).
        console.warn('[plugin] preset application failed (see logs for details)')
      }
    },
    // Phase 2: background delegation tools (structural — matches the `tool`
    // hook field shape; read_only sessions feed the Phase 4 registry).
    tool: {
      pantheon_delegate: delegation.pantheon_delegate,
      pantheon_delegation_read: delegation.pantheon_delegation_read,
      pantheon_delegation_list: delegation.pantheon_delegation_list,
      hashline_edit: hashlineEdit,
      // Wave 3 (PR #46): full-auto goal tools (single active goal/session).
      pantheon_goal_create: goalTools.pantheon_goal_create,
      pantheon_goal_update: goalTools.pantheon_goal_update,
      pantheon_goal_get: goalTools.pantheon_goal_get,
      // Wave 4 (PR #46): /cost — delegation cost report from opencode.db.
      pantheon_cost: costCommand.pantheon_cost,
    },
    'chat.message': async (hookInput, output) => {
      await vision.chatMessage(hookInput, output)
      // Phase 3: deliver queued completion notifications into the parent's
      // context (prepended onto the first text part). No-op when the queue is
      // empty or the parent session has no pending notifications.
      notifier.flushQueue(hookInput.sessionID, output)
    },
    'experimental.chat.messages.transform': vision.messagesTransform,
    event: async ({ event: ev }) => {
      // Phase 3: sessions created without a parent are roots for the depth guard.
      if (ev.type === 'session.created') {
        const info = ev.properties.info
        if (info && info.parentID === undefined) rootSessions.add(info.id)
      }
      // Phase 3: observe completion on child sessions → finalizeDelegation.
      // The board transition fires onTerminal → notifier.notifyParent (the
      // single notification point). Unknown sessions are a no-op.
      try {
        const delegated = await handleDelegationEvent(ev, {
          board,
          finalize: (childSessionID, opts) => delegation.finalizeDelegation(childSessionID, opts),
        })
        // Wave 1/3: non-board idle → idle dispatcher. Board children are
        // handled by handleDelegationEvent above; everything else (roots,
        // non-board sessions) is routed by priority: an active goal owns the
        // idle (goal loop), otherwise the todo enforcer re-injects. Neither
        // onIdle ever throws (internal failures are logged + swallowed), so
        // the session is safe.
        if (!delegated && ev.type === 'session.idle') {
          await idleDispatcher.onIdle(ev.properties.sessionID)
        }
      } catch (err) {
        // The event hook must never break the session.
        console.error('[Pantheon Plugin] Delegation event handling failed:', err)
      }
      await vision.event({ event: ev })
    },
    // Phase 4: deny mutating tools in read-only delegated sessions. Additive
    // key — does not touch Phase 3's tools/event/onTerminal/chat.message.
    'tool.execute.before': enforcementGuard,
    // Wave 2 (PR #46): augment `read` output with hashline tags. Additive —
    // pantheon-hooks.ts (a separate plugin instance) owns its own
    // tool.execute.after, so there is no key collision. Non-read tools pass
    // through untouched.
    'tool.execute.after': readEnhancer,
    // Phase 4: keep in-flight background delegations visible across
    // compaction (running + unread terminal jobs). Guarded: only pushes when
    // there is something to preserve.
    'experimental.session.compacting': async (_input, output) => {
      const blocks = buildCompactionContext(board, {
        sessionID: _input.sessionID,
        maxItems: COMPACTION_MAX_ITEMS,
      })
      if (blocks.length > 0) {
        output.context.push(...blocks)
      }
    },
  }
}

export default plugin
