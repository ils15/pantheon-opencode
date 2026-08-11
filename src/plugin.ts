import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import type { PluginConfig } from 'opencode'
import { BackgroundJobBoard } from './pantheon/background-job-board.ts'
import { reassertAfterCompaction } from './pantheon/compaction-assert.ts'
import { createCostCommand } from './pantheon/cost-command.ts'
import { createDelegationTools, type DelegationClient } from './pantheon/delegation.ts'
import { buildCompactionContext } from './pantheon/delegation-compaction.ts'
import { createEnforcementGuard, readOnlyRegistry } from './pantheon/delegation-enforce.ts'
import { handleDelegationEvent } from './pantheon/delegation-notify.ts'
import { FilePersistenceAdapter } from './pantheon/file-persistence.ts'
import { GOAL_LOOP_DEFAULTS, GoalLoop, GoalStore } from './pantheon/goal-loop.ts'
import { createReadEnhancer } from './pantheon/hashline/read-enhancer.ts'
import { createHashlineEditTool } from './pantheon/hashline/tool.ts'
import { createIdleDispatcher } from './pantheon/idle-continuation.ts'
import { createPantheonLogger } from './pantheon/logger.ts'
import { applyActivePresetToConfig, loadRoutingAgentModels } from './pantheon/presets.mjs'
import {
  TODO_ENFORCER_DEFAULTS,
  TodoEnforcer,
  type TodoEnforcerClient,
  todoEnforcerEnabledFromEnv,
} from './pantheon/todo-enforcer.ts'
import { TodoPreserver } from './pantheon/todo-preserve.ts'
import { activePresetCandidates, createVisionHandler } from './pantheon/vision.ts'

// ─── Background Job Board Singleton ────────────────────────────────────

// Silence-by-default TUI policy (pantheon-hooks L42-58): console output in a
// plugin writes to the process stdout/stderr, which the opencode TUI renders
// directly into the terminal — the "lixo". Every line goes to
// .pantheon/logs/hooks.log; the console echo is opt-in via PANTHEON_HOOKS_LOG=1.
const log = createPantheonLogger({ module: 'pantheon-plugin' })

// Fase 6 (release-134): the delegation toolset's options.agentModels (branch
// (b) of resolveChildModel) is wired from routing.yml's default (first)
// preset — a STATIC per-agent model mapping independent of the active preset,
// so delegated children get a sane model even without an active preset (the
// previous production wiring left branch (b) dead: delegation depended 100%
// on the active preset). Built ONCE at module load, never per dispatch.
// Fail-open: a missing/corrupt routing.yml yields {} (warned by the helper)
// and delegation falls back to the active preset / opencode default — the
// plugin never throws at startup.
const routingAgentModels = loadRoutingAgentModels({ logger: log })

const board = new BackgroundJobBoard({
  maxConcurrentPerAgent: 3,
  signalDir: '.pantheon/deepwork/board-signals',
})
const persistence = new FilePersistenceAdapter('.pantheon/board/state.json')
board.setPersistence(persistence)
board
  .recoverRunningJobs()
  .catch((err) => log.error('[Pantheon Plugin] Failed to recover running jobs:', err))
// ─── Phase 3: Board terminal audit log ─────────────────────────────────

// The onTerminal listener is the completion AUDIT point: it writes a
// file-only log line (console echo opt-in via PANTHEON_HOOKS_LOG). There is
// deliberately NO chat delivery — the user policy is zero delegation
// notifications in the transcript. Completion visibility lives in the board
// `[unread]` marker (pantheon_delegation_list), pantheon_delegation_read,
// TUI toasts (pantheon-hooks, PANTHEON_TOASTS gate) and compaction
// carry-forward.
board.onTerminal((taskID: string) => {
  const job = board.get(taskID)
  if (!job) return
  log.info(
    `[Pantheon Plugin] Board terminal: [${job.alias}] ${job.description} → ${job.state}${job.resultSummary ? ` — ${job.resultSummary}` : ''}`,
  )
})

// Periodically prune terminal/reconciled jobs (24h TTL, every 30 min).
// pruneExpired is async and internally swallows persistence errors, so the
// void-catch here is purely defensive. .unref() ensures the timer never
// keeps the process alive on its own.
setInterval(
  () => {
    void board
      .pruneExpired(86_400_000)
      .catch((err: unknown) => log.error('[Pantheon Plugin] Background board prune failed:', err))
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
        const body: {
          parentID?: string
          title?: string
          model?: { id: string; providerID: string }
        } = { parentID: input.body.parentID }
        if (input.body.title !== undefined) body.title = input.body.title
        // Forward the routed child model (E2E fix): without it the child
        // falls back to the key-gated default model and dies at startup.
        if (input.body.model !== undefined) body.model = input.body.model
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
      children: async (input) => {
        const result = await client.session.children({ path: input.path })
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
    options: {
      rootSessions,
      readOnlyAgents: new Set(['apollo', 'gaia']),
      agentModels: routingAgentModels,
    },
  })

  // Wave 1 (PR #46): TODO continuation enforcer for root/non-board sessions.
  // Mirrors routing.yml `todo_enforcer` (plugin scope has no routing.yml
  // access — COMPACTION_MAX_ITEMS pattern). The event hook routes non-board
  // session.idle events here; board-child idles go to finalizeDelegation.
  // Runtime kill-switch: PANTHEON_TODO_ENFORCER=off (routing.yml is a doc
  // mirror only — the env var is the real switch, PANTHEON_TOASTS pattern).
  const todoEnforcer = new TodoEnforcer({
    client: adaptTodoEnforcerClient(input.client),
    board,
    options: { ...TODO_ENFORCER_DEFAULTS, enabled: todoEnforcerEnabledFromEnv() },
  })

  // release-134 Phase 3: post-compaction todo restore. Captures the session's
  // todo list in 'experimental.session.compacting', activates the snapshot on
  // 'session.compacted', and rewrites the first post-compaction `todowrite`
  // with the exact list (todo-preserve.ts). Additive + fail-open: every step
  // degrades to a logged warn, never throws in a hook.
  const todoPreserver = new TodoPreserver({
    client: adaptTodoEnforcerClient(input.client),
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
          log.info(`[Pantheon Plugin] Applied model preset: ${resolved.name} (${resolved.source})`)
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
        log.warn('[plugin] preset application failed (see logs for details)')
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
      // No delegation notification delivery here — the user policy is ZERO
      // notification text injected into the chat transcript (previously the
      // notifier.flushQueue prepend). pantheon-hooks' chat-reminders.ts keeps
      // its own <system-reminder> channel, untouched.
      // Wave 1: a user message is activity — the todo enforcer's
      // user-activity gate skips injection for userActivityQuietMs afterwards.
      todoEnforcer.noteUserActivity(hookInput.sessionID)
    },
    'experimental.chat.messages.transform': vision.messagesTransform,
    event: async ({ event: ev }) => {
      // Phase 3: sessions created without a parent are roots for the depth guard.
      if (ev.type === 'session.created') {
        const info = ev.properties.info
        if (info && info.parentID === undefined) rootSessions.add(info.id)
      }
      // release-134 Phase 3: activate the todo snapshot captured at
      // compacting time — the first todowrite within the restore window is
      // rewritten with the exact list (see todo-preserve.ts). Fail-open.
      if (ev.type === 'session.compacted') {
        await todoPreserver.onCompacted(ev.properties.sessionID)
        // release-134 Phase 4: re-assert post-compaction state — enqueue a
        // fresh-state reminder (running/unread board jobs + active goals) for
        // the session's next chat.message delivery. Fail-open (never throws).
        await reassertAfterCompaction({
          sessionID: ev.properties.sessionID,
          board,
          goals: {
            enabled: GOAL_LOOP_DEFAULTS.enabled,
            list: (s: string) => goalStore.list(s),
          },
        })
      }
      // Phase 3: observe completion on child sessions → finalizeDelegation.
      // The board transition fires onTerminal → the file-only audit log (no
      // chat delivery — see the onTerminal listener above). Unknown sessions
      // are a no-op.
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
        log.error('[Pantheon Plugin] Delegation event handling failed:', err)
      }
      await vision.event({ event: ev })
    },
    // Phase 4: deny mutating tools in read-only delegated sessions. Additive
    // key — does not touch Phase 3's tools/event/onTerminal/chat.message.
    'tool.execute.before': async (input, output) => {
      // Chain: the read-only enforcement guard runs first (denies mutating
      // tools in read-only sessions), then release-134 Phase 3 rewrites the
      // first post-compaction `todowrite` with the captured todo snapshot.
      // Both are no-ops for non-matching sessions/tools; the preserver is
      // fail-open (only its intentional restore denial throws).
      await enforcementGuard(input)
      await todoPreserver.beforeTodoWrite(input, output)
    },
    // Wave 2 (PR #46): augment `read` output with hashline tags. Additive —
    // pantheon-hooks.ts (a separate plugin instance) owns its own
    // tool.execute.after, so there is no key collision. Non-read tools pass
    // through untouched.
    'tool.execute.after': readEnhancer,
    // Phase 4 + release-134 Phase 2: keep the session's working state across
    // compaction — preservation directive, active goals (<mission_context>),
    // pending todos (<todo_context>), and in-flight background delegations
    // (running + unread terminal ≤ max_compaction_items). Guarded: only
    // pushes when there is something to preserve; a build failure must never
    // break the experimental compaction hook.
    'experimental.session.compacting': async (_input, output) => {
      try {
        const blocks = await buildCompactionContext(board, {
          sessionID: _input.sessionID,
          maxItems: COMPACTION_MAX_ITEMS,
          goals: {
            enabled: GOAL_LOOP_DEFAULTS.enabled,
            list: (sessionID: string) => goalStore.list(sessionID),
          },
          todos: {
            enabled: todoEnforcerEnabledFromEnv(),
            list: (sessionID: string) => todoEnforcer.listPendingTodos(sessionID),
          },
        })
        if (blocks.length > 0) {
          output.context.push(...blocks)
        }
        // release-134 Phase 3 (additive): snapshot the session's full todo
        // list for post-compaction restore. Best-effort — a GET failure is
        // logged and the compaction proceeds normally.
        await todoPreserver.capture(_input.sessionID)
      } catch (err: unknown) {
        log.warn('[Pantheon Plugin] Compaction context build failed:', err)
      }
    },
  }
}

export default plugin
