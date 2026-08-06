/**
 * pantheon-hooks.ts — Pantheon runtime security-hook plugin for OpenCode.
 *
 * Re-created per Council Synthesis 2026-08-05 (P0): the previous hook plugin
 * was removed on 24-25/07 because it used the Bun Shell `$` from the plugin
 * API, whose interface has NO `.timeout()` method — every hook crashed with
 * `TypeError: $.quiet().nothrow().timeout is not a function`. The 10 functional
 * scripts in scripts/hooks/ (gitleaks covers only staged files, NOT tool
 * calls) were left orphaned. This plugin wires them back into the opencode
 * runtime via `node:child_process` (version-proof — see hook-runner.ts).
 *
 * Hook mapping (Claude Code protocol payload {tool_name, tool_input,
 * agent_id, session_id} delivered on the script stdin):
 *   - tool.execute.before → validate-talos-scope.sh, scan-secrets.sh,
 *     validate-tool-safety.sh + on-subagent-delegation-start.sh (only when the
 *     tool is a delegation tool such as `task`, to keep the audit log honest)
 *   - tool.execute.after  → format-multi-language.sh, log-session-start.sh +
 *     on-subagent-delegation-stop.sh (delegation tool only)
 *   - event session.created → log-session-start.sh, validate-post-conditions.sh
 *
 * Notes:
 *   - `agent_id` is NOT present in the opencode tool.execute hook payloads
 *     ({tool, sessionID, callID}), so it is passed as '' — validate-talos-scope
 *     then takes its safe skip path; the agent-agnostic scan-secrets and
 *     validate-tool-safety protections remain fully active.
 *   - tool.execute hooks cannot hard-deny the tool call through this API
 *     (the output only mutates args; real deny is the permission system), so
 *     violations surface as stderr + non-zero exit codes logged below.
 *   - Logging policy (P0 fix 2026-08-06): NON-ZERO exit → NEVER console.
 *     `console.error` in a plugin writes to the process stderr, which the
 *     opencode TUI renders directly into the terminal — that polluted the
 *     chat with `[pantheon-hooks:scan-secrets.sh] exit 1: [SECRET SCAN]...`
 *     spam on every tool call. Non-zero exits now go to THREE non-TUI channels:
 *       1. client.tui.showToast() — one short, deduped TUI toast (per
 *          (script, exit code, masked match) per session) so the user gets a
 *          single visible signal instead of terminal spam;
 *       2. client.app.log() — structured entry in the opencode log file
 *          (service "pantheon-hooks", level "error") — never the TUI;
 *       3. .pantheon/logs/hooks.log — project-local one-line append, matching
 *          the audit-hook pattern of persisting to log files on disk.
 *     Zero exit → SILENT by default. Audit scripts (log-session-start,
 *     on-subagent-delegation-*) still write their log FILES (sessions.log,
 *     delegations.log) from inside the .sh scripts. Set PANTHEON_HOOKS_LOG=1
 *     (or "debug") to re-enable the zero-exit audit echo for debugging — it is
 *     routed to the structured log + hooks.log, never the TUI.
 *     The env var is read once at plugin load time (opencode startup).
 *   - Hooks NEVER throw: every body is try/catch'd and only logs. All three
 *     reporting channels (toast, app.log, file append) are individually
 *     try/catch'd so a failure in one can never take down the session.
 *   - TUI delegation toasts (PANTHEON_TOASTS gate, read once at plugin load):
 *     the base toast mechanism (notifyToast → client.tui.showToast) now also
 *     surfaces subagent delegation lifecycle events on top of the existing
 *     hook-failure error toasts — "🚀 <agent> em execução" (tool.execute.before)
 *     and "✅ <agent> concluiu" (tool.execute.after). Anti-spam for parallel
 *     waves (up to 5 agents): delegation toasts are rate-limited to ONE per
 *     2000ms (throttled toasts are skipped, never backlogged — the aggregate
 *     summary covers them) and 3+ distinct agents completing within a 6s
 *     window collapse into a single "✅ N agentes concluídos (...)" toast.
 *     Env gate:
 *       PANTHEON_TOASTS=off           → no TUI toasts at all
 *       PANTHEON_TOASTS=errors        → hook-failure toasts only
 *       PANTHEON_TOASTS=delegations   → errors + delegation toasts (default)
 *       PANTHEON_TOASTS=all           → everything
 *     The gate controls the TUI display ONLY — every fired toast is also
 *     recorded to the structured log + hooks.log (script 'toast', level
 *     'info') so the toast trail stays auditable at any setting.
 *
 * IMPORTANT (OpenCode 1.18.11 legacy loader): this module must export EXACTLY
 * ONE function-valued export — the default plugin (see src/plugin.ts L47-52).
 * Helpers live in ./hook-runner.ts and are imported from there.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import { type HookPayload, runHook } from './hook-runner.ts'

/** Tools that represent a subagent delegation (opencode `task` tool etc.). */
const DELEGATION_TOOL_RE = /^(task|.*delegate.*|.*subagent.*)$/i

/**
 * When set to a truthy value ("1" or "debug"), zero-exit audit-hook output is
 * echoed for debugging (opt-in). Default (unset): fully silent on success —
 * the .sh scripts still persist their log FILES on disk. Read at plugin load.
 * The debug echo goes to the structured log + hooks.log, never the TUI.
 */
const AUDIT_LOG_ENABLED = (process.env.PANTHEON_HOOKS_LOG ?? '').trim() !== ''

/** Scripts whose zero-exit stderr is relayed when PANTHEON_HOOKS_LOG is set. */
const AUDIT_HOOKS = new Set([
  'log-session-start.sh',
  'on-subagent-delegation-start.sh',
  'on-subagent-delegation-stop.sh',
  'validate-post-conditions.sh',
])

/**
 * Dedupe keys for TUI toasts: `${script}|${exit code}|${masked match}`.
 * Same security signal is toasted at most once per session — repeated false
 * positives on every tool call must not re-toast and annoy the user.
 */
const toastShown = new Set<string>()

/**
 * TUI toast gate — PANTHEON_TOASTS=off|errors|delegations|all, read once at
 * plugin load (opencode startup). Default "delegations" = hook-failure toasts
 * + delegation lifecycle toasts. "errors" = hook-failure toasts only. "off" =
 * no TUI toasts at all. "all" = everything. Unknown values fall back to the
 * default. The gate controls the TUI display ONLY — the structured log +
 * hooks.log channels always write (every fired toast is recorded via
 * reportFailure with script 'toast').
 */
const rawToastMode = (process.env.PANTHEON_TOASTS ?? '').trim().toLowerCase()
const TOAST_MODE: 'off' | 'errors' | 'delegations' | 'all' =
  rawToastMode === 'off' || rawToastMode === 'errors' || rawToastMode === 'all'
    ? rawToastMode
    : 'delegations'
const ERROR_TOASTS_ENABLED = TOAST_MODE !== 'off'
const DELEGATION_TOASTS_ENABLED = TOAST_MODE === 'delegations' || TOAST_MODE === 'all'

/**
 * Delegation toast anti-spam: waves dispatch up to 5 subagents in parallel,
 * so raw per-agent toasts would spam the TUI. Two guards:
 *   - Rate limit: at most ONE delegation toast per 2000ms (lastToastAt).
 *     Throttled toasts are skipped, never backlogged — the aggregate summary
 *     covers them.
 *   - Aggregation: 3+ distinct agents completing within a 6s window collapse
 *     into a single "✅ N agentes concluídos (...)" toast via a small rolling
 *     buffer (Map<agent, completion timestamp>) flushed on the 3rd in-window
 *     completion.
 */
const TOAST_MIN_INTERVAL_MS = 2000
const TOAST_AGGREGATE_WINDOW_MS = 6000
const TOAST_AGGREGATE_MIN = 3
let lastToastAt = 0
const completedAgents = new Map<string, number>()

/** Variants accepted by the opencode TUI showToast (TuiShowToastData.body.variant). */
type ToastVariant = 'info' | 'success' | 'warning' | 'error'

/** Options for notifyToast: message, TUI variant, duration, optional session dedupe key. */
type ToastOptions = {
  message: string
  variant: ToastVariant
  duration?: number
  dedupeKey?: string
}

/** Logging context threaded through safeRun — provided by the plugin input. */
type HookContext = Pick<PluginInput, 'client' | 'directory'>

function trim(s: string, max = 2000): string {
  const t = s.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** Translate the opencode hook event into the Claude Code protocol payload. */
function payloadFor(input: { tool: string; sessionID: string }, toolInput: unknown): HookPayload {
  return {
    tool_name: input.tool,
    tool_input: toolInput ?? {},
    // tool.execute hooks carry no agent — '' lets talos-scope skip safely.
    agent_id: (input as { agent?: { id?: string } }).agent?.id ?? '',
    session_id: input.sessionID,
  }
}

/** Append one line to .pantheon/logs/hooks.log under the project directory. */
async function appendHookLog(directory: string, line: string): Promise<void> {
  const dir = join(directory, '.pantheon', 'logs')
  await mkdir(dir, { recursive: true })
  await appendFile(join(dir, 'hooks.log'), `${line}\n`, 'utf8')
}

/**
 * Persist a hook result line to the non-TUI channels: the opencode structured
 * log (client.app.log) and the project hooks.log file. Both are best-effort
 * and individually guarded — a reporting failure must never throw out of a hook.
 */
async function reportFailure(
  ctx: HookContext,
  message: string,
  extra: Record<string, unknown>,
  level: 'error' | 'info' = 'error',
): Promise<void> {
  try {
    await ctx.client.app.log({
      body: { service: 'pantheon-hooks', level, message, extra },
    })
  } catch {
    // Structured log is best-effort; the file append below still runs.
  }
  try {
    await appendHookLog(ctx.directory, message)
  } catch {
    // File log is best-effort; nothing else to fall back to.
  }
}

/**
 * Show ONE short, single-line TUI toast with an optional dedupe key. Deduped
 * per key per session (key added before showing, so repeated signals toast at
 * most once). Best-effort: headless mode or a missing TUI endpoint must never
 * throw out of a hook. Every fired toast is also recorded via reportFailure
 * (script 'toast', level 'info') so the toast trail is auditable — the log
 * channels write regardless of the PANTHEON_TOASTS display gate.
 */
async function notifyToast(ctx: HookContext, opts: ToastOptions): Promise<void> {
  try {
    if (opts.dedupeKey) {
      if (toastShown.has(opts.dedupeKey)) return
      toastShown.add(opts.dedupeKey)
    }
    await ctx.client.tui.showToast({
      body: { message: opts.message, variant: opts.variant, duration: opts.duration ?? 4000 },
    })
    await reportFailure(
      ctx,
      `[pantheon-hooks:toast] ${opts.message}`,
      {
        script: 'toast',
        variant: opts.variant,
        duration: opts.duration ?? 4000,
        dedupeKey: opts.dedupeKey ?? null,
      },
      'info',
    )
  } catch {
    // No TUI / headless: toast is best-effort, logs already persisted.
  }
}

/**
 * Rate-limited delegation toast: at most ONE per TOAST_MIN_INTERVAL_MS.
 * Throttled toasts are skipped (never queued/backlogged) — the aggregated
 * completion summary covers the wave. Only applies to delegation toasts;
 * hook-failure toasts keep their plain session dedupe.
 */
async function throttledToast(ctx: HookContext, opts: ToastOptions): Promise<void> {
  const now = Date.now()
  if (now - lastToastAt < TOAST_MIN_INTERVAL_MS) return
  lastToastAt = now
  await notifyToast(ctx, opts)
}

/**
 * Extract the subagent type from a delegation tool's args (opencode `task`
 * tool passes `subagent_type`, e.g. 'apollo' / 'hermes'). Falls back to the
 * tool name when the field is missing so the toast still identifies what ran.
 * Never throws — malformed args are treated as empty.
 */
function delegationAgent(tool: string, args?: unknown): string {
  try {
    const a = (args ?? {}) as Record<string, unknown>
    const candidate = a.subagent_type ?? a.subagentType
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
  } catch {
    // Malformed args — fall through to the tool name.
  }
  return tool
}

/** 🚀 delegation-started toast (variant 'info', 2500ms), deduped per agent. */
async function delegationStartedToast(ctx: HookContext, agent: string): Promise<void> {
  if (!DELEGATION_TOASTS_ENABLED) return
  await throttledToast(ctx, {
    message: `🚀 ${agent} em execução`,
    variant: 'info',
    duration: 2500,
    dedupeKey: `${agent}|start`,
  })
}

/**
 * ✅ delegation-completed toast (variant 'success', 3000ms), deduped per agent.
 * Anti-spam aggregation: when 3+ distinct agents complete within a 6s window,
 * the individual toasts are REPLACED by one "✅ N agentes concluídos (...)"
 * toast and the buffer is flushed. The aggregate bypasses the 2s throttle so
 * the wave summary is always visible — it is inherently rare (≥3 agents / 6s).
 */
async function delegationDoneToast(ctx: HookContext, agent: string): Promise<void> {
  if (!DELEGATION_TOASTS_ENABLED) return
  const now = Date.now()
  for (const [name, at] of completedAgents) {
    if (now - at > TOAST_AGGREGATE_WINDOW_MS) completedAgents.delete(name)
  }
  completedAgents.set(agent, now)
  if (completedAgents.size >= TOAST_AGGREGATE_MIN) {
    const count = completedAgents.size
    const names = [...completedAgents.keys()].sort().join(', ')
    completedAgents.clear()
    await notifyToast(ctx, {
      message: `✅ ${count} agentes concluídos (${names})`,
      variant: 'success',
      duration: 4000,
      dedupeKey: `aggregate|${names}`,
    })
    return
  }
  await throttledToast(ctx, {
    message: `✅ ${agent} concluiu`,
    variant: 'success',
    duration: 3000,
    dedupeKey: `${agent}|done`,
  })
}

/**
 * Run one hook with the logging policy; NEVER throw out of the hook.
 *
 * Non-zero exit → structured log + hooks.log + one deduped TUI toast.
 * Zero exit   → silent, unless PANTHEON_HOOKS_LOG is set for audit scripts
 *               (echo routed to structured log + hooks.log, never the TUI).
 * No console.error / console.log anywhere in this path — the TUI stays clean.
 */
async function safeRun(ctx: HookContext, script: string, payload: HookPayload): Promise<void> {
  try {
    const result = await runHook(script, payload)
    const tag = `[pantheon-hooks:${script}]`
    const extra = { script, code: result.code, timedOut: result.timedOut, tool: payload.tool_name }
    if (result.code !== 0) {
      const message = `${tag} exit ${result.code}${result.timedOut ? ' (timed out)' : ''}: ${trim(result.stderr || result.stdout || 'no output')}`
      await reportFailure(ctx, message, extra)
      if (ERROR_TOASTS_ENABLED) {
        const match = trim(result.stderr || result.stdout || 'no output', 120)
        const suffix = result.timedOut ? ' (timeout)' : ''
        void notifyToast(ctx, {
          message: `⚠️ Hook ${script}: exit ${result.code}${suffix} — see log`,
          variant: 'error',
          duration: 4000,
          dedupeKey: `${script}|${result.code}|${match}`,
        })
      }
    } else if (AUDIT_LOG_ENABLED && AUDIT_HOOKS.has(script) && result.stderr.trim()) {
      // Opt-in only (PANTHEON_HOOKS_LOG=1): audit scripts echo their FILE
      // writes here for debugging. Default is silence — the .sh scripts
      // already persist sessions.log / delegations.log on disk. Echo goes to
      // the structured log + hooks.log, never the TUI console.
      const message = `${tag} ${trim(result.stderr)}`
      await reportFailure(ctx, message, extra, 'info')
    }
  } catch (err) {
    // runHook never throws, but the hook body must survive anything.
    const message = `[pantheon-hooks:${script}] unexpected failure: ${err instanceof Error ? err.message : String(err)}`
    try {
      await ctx.client.app.log({
        body: {
          service: 'pantheon-hooks',
          level: 'error',
          message,
          extra: { script, tool: payload.tool_name },
        },
      })
    } catch {
      // Best-effort; never throw out of the hook.
    }
    try {
      await appendHookLog(ctx.directory, message)
    } catch {
      // Best-effort; never throw out of the hook.
    }
  }
}

const plugin: Plugin = async ({ client, directory }) => {
  const ctx: HookContext = { client, directory }
  return {
    'tool.execute.before': async (input, output) => {
      try {
        const payload = payloadFor(input, output.args ?? {})
        const hooks = ['validate-talos-scope.sh', 'scan-secrets.sh', 'validate-tool-safety.sh']
        if (DELEGATION_TOOL_RE.test(input.tool)) {
          hooks.push('on-subagent-delegation-start.sh')
          // tool.execute.before carries args on `output` (typed); `input.args`
          // also exists at runtime — read from whichever is present.
          void delegationStartedToast(
            ctx,
            delegationAgent(input.tool, output?.args ?? (input as { args?: unknown }).args),
          )
        }
        await Promise.all(hooks.map((script) => safeRun(ctx, script, payload)))
      } catch {
        // Never let a hook take down the opencode session.
      }
    },
    'tool.execute.after': async (input) => {
      try {
        const payload = payloadFor(input, input.args ?? {})
        const hooks = ['format-multi-language.sh']
        if (DELEGATION_TOOL_RE.test(input.tool)) {
          hooks.push('on-subagent-delegation-stop.sh')
          void delegationDoneToast(ctx, delegationAgent(input.tool, input.args))
        }
        await Promise.all(hooks.map((script) => safeRun(ctx, script, payload)))
      } catch {
        // Never let a hook take down the opencode session.
      }
    },
    event: async ({ event: ev }) => {
      try {
        if (ev.type === 'session.created') {
          const payload: HookPayload = { session_id: ev.properties.info.id }
          await Promise.all(
            ['log-session-start.sh', 'validate-post-conditions.sh'].map((script) =>
              safeRun(ctx, script, payload),
            ),
          )
        }
      } catch {
        // Never let a hook take down the opencode session.
      }
    },
  }
}

export default plugin
