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
 *     ({tool, sessionID, callID}). P0-4 (2026-08-06): a `chat.params` hook
 *     records the active agent per session (sessionAgent map), so payloadFor()
 *     now resolves the real agent_id — validate-talos-scope.sh enforces the
 *     Talos file-count boundary; the agent-agnostic scan-secrets and
 *     validate-tool-safety protections remain fully active.
 *   - tool.execute.before CAN hard-deny — the old "cannot hard-deny" claim
 *     below this line is OUTDATED for 1.18.x (verified 2026-08-06 on the
 *     INSTALLED 1.18.13 binary + the opencode plugin docs): a `throw new
 *     Error(...)` from the hook propagates because Plugin.trigger invokes
 *     each hook as `yield* v.promise(async () => hook(input, output))` with
 *     NO try/catch — the rejection fails the tool's execute promise BEFORE
 *     the tool body runs (the docs' .env-protection example relies on this).
 *     The permission system remains the primary deny path, but a thrown
 *     hook error is now a supported hard block (hybrid blocking, Fix 2
 *     2026-08-06): scan-secrets.sh exits 2 on high-confidence token matches
 *     → the plugin logs via reportFailure (non-TUI channels) and THEN throws
 *     the DELIBERATE block error — the ONLY throw in this plugin. Exit 1
 *     (low-confidence header/KEY names) stays advisory: toast + logs, no
 *     block.
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
 *     EXCEPTION (Fix 2, 2026-08-06): the deliberate scan-secrets high-
 *     confidence block — when scan-secrets.sh exits 2, the hook awaits
 *     reportFailure FIRST (app.log + hooks.log) and only then throws. The
 *     throw is deliberately NOT swallowed by the surrounding try/catch
 *     (handled via a blockError variable thrown after it), because that
 *     rejection is what opencode propagates to fail the tool call.
 *   - TUI lifecycle toasts (PANTHEON_TOASTS gate, read once at plugin load):
 *     the base toast mechanism (notifyToast → client.tui.showToast) surfaces
 *     hook-failure error toasts plus subagent delegation lifecycle events —
 *     "🚀 <agent> em execução" (tool.execute.before), "✅ <agent> concluiu"
 *     (tool.execute.after), and olympians/council summaries. The gate is now
 *     CATEGORY-based — each notification declares one of `errors`,
 *     `delegations` or `council` and only fires when its category is enabled:
 *       PANTHEON_TOASTS=off           → no categories (empty set)
 *       PANTHEON_TOASTS=errors        → {errors} (hook/agent failures only)
 *       PANTHEON_TOASTS=delegations   → {errors, delegations, council} (default)
 *       PANTHEON_TOASTS=council       → {errors, council}
 *       PANTHEON_TOASTS=all           → {errors, delegations, council}
 *     Unknown values fall back to the default. The gate controls the TUI
 *     display + chat-reminder fallback ONLY — every fired toast is also
 *     recorded to the structured log + hooks.log (script 'toast', level
 *     'info') so the toast trail stays auditable at any setting.
 *   - Severity priority (2026-08-06): errors/blockers — hook failures
 *     ("⚠️ Hook ..."), derivable agent failures ("⚠️ <agent> falhou: ...")
 *     and session.error events — ALWAYS notify individually, exempt from the
 *     2s throttle and from aggregation. Success/completion notifications
 *     aggregate (olympians summaries / 3-in-6s group), never individually
 *     when the agent belongs to a detected group.
 *   - Olympians detection (2026-08-06): 2+ delegation task calls within
 *     OLYMPIANS_DETECT_WINDOW_MS collapse into ONE group. The 2nd call fires a
 *     single "⚙️ Olympians: N agentes em formação"; later members only update
 *     the group buffer. When every member's completion has been observed the
 *     group fires one "✅ Olympians: N/N concluídos (...)" aggregate.
 *     One group buffer at a time (groups rarely overlap); a task call more
 *     than OLYMPIANS_DETECT_WINDOW_MS after the previous one starts a fresh
 *     group.
 *   - session.idle flush (2026-08-06): the `event` hook additionally handles
 *     `session.idle`. When the orchestrator goes idle, pending completion
 *     reminders are flushed as ONE aggregated chat reminder (individual
 *     "✅ <agent> concluiu" lines collapse into "✅ N agentes concluídos (...)")
 *     and re-armed with a fresh timestamp — so the completion summary
 *     survives until the next user message (delivered via chat.message) instead
 *     of expiring after CHAT_REMINDER_TTL_MS while the user reads the reply.
 *     Partial groups (some members completed, some never reported) and
 *     interrupted council counters are also flushed/reset here.
 *   - Council notifications (new category 2026-08-06): a `task` whose prompt/
 *     description matches "council"/"conselho"/"synthesi" is treated as council
 *     activity — "🏛️ Council: especialistas consultados" on start and
 *     "✅ Veredito pronto" once every dispatched council specialist completes.
 *     Category `council` (gated independently of `delegations`).
 *   - OpenCode 1.18.13 DROPS tui.toast.show (diagnosed 2026-08-06 via sandbox
 *     probe: headless `opencode serve` on 1.18.13 + /event SSE observation):
 *     the TUI core handler gates on `if (workspace !== workspace.current())
 *     return;` and /tui/show-toast publishes events with NO workspace tag
 *     (properties are {title, message, variant, duration} only). The
 *     `?directory=` query param even routes the event OFF the global event
 *     stream (to a directory-scoped stream a plugin client never subscribes
 *     to), and `?workspace=` requires a per-TUI-client `wrk_` id a plugin
 *     cannot discover (non-wrk values → HTTP 500 "Expected a string starting
 *     with wrk"). The upstream fix (server-side workspace tagging) only exists
 *     in NEWER opencode versions. THEREFORE on 1.18.13 the toast path below is
 *     a documented TUI no-op and agent-lifecycle feedback is surfaced via the
 *     oh-my-openagent fallback pattern: a `chat.message` hook injects queued
 *     signals (see pendingChatReminders / enqueueChatReminder below) as ONE
 *     <system-reminder> text part into the next user message. Toasts stay in
 *     place for future opencode versions that render them — upgrade opencode
 *     for real TUI toasts.
 *   - tool.execute.after payload fix (P1-1 follow-up, 2026-08-06): the after
 *     hook receives `(input, output)` where `output` = {title, output,
 *     metadata} — the REAL tool result. It is now merged into the payload
 *     passed to the stop-hook scripts as `tool_output` (additive key) plus a
 *     plugin-derived `status` ('success' | 'failure' | 'dispatched' |
 *     'unknown'), so on-subagent-delegation-stop.sh can log honest completion
 *     instead of the old args-only 'unknown'. Payload schema stays compatible
 *     — scripts read stdin JSON; new keys are additive.
 *   - P0-5 (2026-08-06, user test battery): the task tool's BACKGROUND dispatch
 *     arrives as free TEXT — `<task id="ses_..." state="running">\n<summary>
 *     Background task started</summary>...` — NOT JSON (verified in the
 *     installed 1.18.14 binary; metadata carries `background:true` + `jobId`,
 *     no state key). deriveResultStatus now detects the TEXT signature (+
 *     `metadata.background === true`) so background launches record
 *     'dispatched' instead of the previous false 'success'; extractTaskId
 *     pulls the real `ses_...` id via `task id="ses_..."`. appendHookLog
 *     splits multi-line messages so EVERY hooks.log line carries the ISO
 *     prefix. GAP C: the bash tool's non-zero exit codes now fire an
 *     individual ⚠️ error notification (signal: `metadata.exit`, verified
 *     1.18.14 — {title, output, metadata: {output, exit, truncated}}).
 *   - Background-mode contract (P0-1/P0-2, 2026-08-06, 2nd council session):
 *     the `task` tool in BACKGROUND mode returns IMMEDIATELY with
 *     {task_id, state:'running'} — tool.execute.after therefore observes
 *     DISPATCH, not completion. The stop-hook payload now separates the
 *     delegation-LIFECYCLE fields (agent, delegation_id, task_id, status,
 *     duration_ms) from the free-text result blob (tool_output): agent, status
 *     and session_id are never derived from result text (prim() sanitizer
 *     strips non-primitive junk), and a background launch is recorded as
 *     status:'dispatched' — never 'success'. REAL completion of background
 *     tasks is NOT observable via tool.execute.after on opencode 1.18.13 (no
 *     second after-event fires) — documented platform limitation, not a
 *     telemetry bug. delegation_id is generated in tool.execute.before
 *     (crypto.randomUUID), keyed by callID, and threaded to BOTH the start and
 *     the stop hook so delegations.log joins Start↔Stop on it; duration_ms is
 *     computed from the before-record start timestamp; task_id is extracted
 *     from the result into its OWN payload field.
 *   - P0-5 (2026-08-06, user test battery): the runtime ACTUALLY delivers the
 *     background dispatch as free TEXT, not JSON — `<task id="ses_..."
 *     state="running">\n<summary>Background task started</summary>...` (verified
 *     in the installed 1.18.14 binary; metadata carries `background:true` +
 *     `jobId`, no state key). deriveResultStatus now detects that TEXT
 *     signature (+ `metadata.background === true`) and extractTaskId pulls the
 *     `ses_...` id via `task id="ses_..."`. The stop-hook script's TSV handoff
 *     (8 fields read with `cut -fN`) was replaced by a JSON round-trip because
 *     a REAL newline in result_snippet shifted fields 5-8 into garbage;
 *     result_snippet is newline/tab-collapsed + 200-char-truncated before the
 *     JSON. appendHookLog splits multi-line messages so EVERY line gets the
 *     ISO prefix. GAP C: bash tool non-zero exit codes now fire an individual
 *     ⚠️ error notification (signal: `metadata.exit`, verified 1.18.14).
 *
 * IMPORTANT (OpenCode 1.18.11 legacy loader): this module must export EXACTLY
 * ONE function-valued export — the default plugin (see src/plugin.ts L47-52).
 * Helpers live in ./hook-runner.ts and are imported from there.
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import type { Part } from '@opencode-ai/sdk'
import { type HookPayload, type HookResult, runHook } from './hook-runner.ts'

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

/** Notification categories gated by PANTHEON_TOASTS (see header). */
type ToastCategory = 'errors' | 'delegations' | 'council'

/**
 * TUI toast gate — PANTHEON_TOASTS=off|errors|delegations|council|all, read
 * once at plugin load (opencode startup). Default "delegations" = {errors,
 * delegations, council}: hook-failure + delegation-lifecycle + council toasts. The gate is a Set
 * of enabled categories; every notification declares its category and is
 * skipped unless enabled. "off" = empty set, "all" = every category. Unknown
 * values fall back to the default. The gate controls the TUI display +
 * chat-reminder fallback ONLY — the structured log + hooks.log channels
 * always write (every fired toast is recorded via reportFailure with script
 * 'toast').
 */
const rawToastMode = (process.env.PANTHEON_TOASTS ?? '').trim().toLowerCase()
function parseToastCategories(mode: string): ReadonlySet<ToastCategory> {
  switch (mode) {
    case 'off':
      return new Set()
    case 'errors':
      return new Set(['errors'])
    case 'council':
      return new Set(['errors', 'council'])
    case 'all':
      return new Set(['errors', 'delegations', 'council'])
    default:
      // Unknown value (or unset) → default: errors + delegations + council.
      return new Set(['errors', 'delegations', 'council'])
  }
}
const ENABLED_TOAST_CATEGORIES: ReadonlySet<ToastCategory> = parseToastCategories(rawToastMode)

function toastCategoryEnabled(cat: ToastCategory): boolean {
  return ENABLED_TOAST_CATEGORIES.has(cat)
}

/**
 * Delegation toast anti-spam: olympians dispatch up to 5 subagents in parallel,
 * so raw per-agent toasts would spam the TUI. Two guards:
 *   - Rate limit: at most ONE delegation toast per 2000ms (lastToastAt).
 *     Throttled toasts are skipped, never backlogged — the aggregate summary
 *     covers them. Error toasts bypass this throttle (severity priority).
 *   - Aggregation: 3+ distinct agents completing within a 6s window collapse
 *     into a single "✅ N agentes concluídos (...)" toast via a small rolling
 *     buffer (Map<agent, completion timestamp>) flushed on the 3rd in-window
 *     completion. Agents belonging to a detected group use olympians
 *     aggregation instead (see OLYMPIANS_DETECT_WINDOW_MS below).
 */
const TOAST_MIN_INTERVAL_MS = 2000
const GROUP_COMPLETE_WINDOW_MS = 6000
const GROUP_COMPLETE_MIN = 3
let lastToastAt = 0
const completedAgents = new Map<string, number>()

/**
 * Olympians detection (see header): 2+ delegation task calls within the window
 * collapse into ONE group. `detected` flips on the 2nd in-window call (the
 * olympians-start notification fires exactly once); `pendingCompletions`
 * tracks members whose completion has NOT yet been observed, so the idle
 * flush can report partial groups. A task call more than
 * OLYMPIANS_DETECT_WINDOW_MS after the previous one (lastTaskAt) starts a
 * fresh group buffer.
 */
const OLYMPIANS_DETECT_WINDOW_MS = 10_000

type Olympians = {
  id: string
  agents: Set<string>
  startedAt: number
  lastTaskAt: number
  pendingCompletions: Set<string>
  doneCount: number
  detected: boolean
}

let activeOlympians: Olympians | null = null
let olympiansSeq = 0

/**
 * Council notifications (new category, see header): a `task` whose prompt/
 * description matches the council markers is treated as council activity.
 * `councilStartNotified` fires "🏛️ Council: especialistas consultados" once;
 * `pendingCouncilCalls` tracks the callIDs of dispatched council specialists
 * (the after-hook args do NOT repeat the description, so completion is matched
 * by callID); `✅ Veredito pronto` fires when every dispatched council
 * specialist has completed. Counters reset on fire and at session.idle (an
 * interrupted council must not block a later council's verdict).
 */
const COUNCIL_RE = /council|conselho|synthesi/i
let councilStartNotified = false
let councilDispatchCount = 0
let councilDoneCount = 0
const pendingCouncilCalls = new Set<string>()

/**
 * P0-4 session→agent map: opencode tool.execute hooks carry NO agent_id in
 * their payload ({tool, sessionID, callID}), so validate-talos-scope.sh never
 * knows who called the tool. The `chat.params` hook fires per assistant turn
 * with the active agent name — record it per session here, then payloadFor()
 * resolves agent_id from this map (falling back to an inline agent field when
 * present). Bounded: entries older than 30min are pruned when the map exceeds
 * 50 sessions, so stale sessions cannot accumulate.
 */
const sessionAgent = new Map<string, { agent: string; at: number }>()

/**
 * P0-4 advisory content guard: risky edit/write/bash targets (migrations,
 * alembic, models/, auth, secrets) or bulk multi-file operations (>3 unique
 * file-ish args) surface as a 'warn' log line via reportFailure — advisory
 * ONLY, never blocks (the permission system is the real deny path).
 */
const RISKY_PATH_RE = /migration|schema\.sql|alembic|models\/|auth|password|token|secret/i

/**
 * Fix 1 (2026-08-06): high-confidence secret token formats — mirrors
 * scripts/hooks/scan-secrets.sh HIGH_CONFIDENCE_PATTERNS. Used by maskSecret()
 * to REDACT secret VALUES from any plugin log line: the talos-guard must
 * never write a raw credential to hooks.log (a real `sk-bf-...` token leaked
 * in plain text there on 2026-08-06). Header/KEY names (the Bifrost header alone,
 * api_key=...) are deliberately NOT matched — they are not secret values.
 */
const SECRET_MASK_RE =
  /(sk-bf-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{36,}|glpat-[A-Za-z0-9_-]{20}|sk-[a-zA-Z0-9]{20,}|sk_live_[a-zA-Z0-9]{20,}|sk_test_[a-zA-Z0-9]{20,}|xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}|bearer\s+[a-zA-Z0-9_.-]{20,}|eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*)/gi

/**
 * Fix 1: replace every high-confidence secret match with '****' so log lines
 * (hooks.log, structured log, toasts, chat reminders) can never expose a raw
 * token value. Applied to every path that echoes tool-arg or tool-result
 * content (talos-guard hit, safeRun script output, agentFailedToast reason).
 */
function maskSecret(text: string): string {
  return text.replace(SECRET_MASK_RE, '****')
}

/**
 * Fix 2 (2026-08-06): message thrown when scan-secrets.sh exits 2
 * (HIGH_CONFIDENCE token match). This is the ONLY deliberate throw in the
 * plugin — it is thrown AFTER reportFailure so the log channels always write
 * first, and it is NOT swallowed by the hook's try/catch: opencode's
 * Plugin.trigger has no catch around hook invocations, so the rejection
 * propagates and fails the tool's execute promise BEFORE the tool runs.
 */
const SECRET_BLOCK_MESSAGE =
  '[pantheon-hooks] Bloqueado: segredo de alta confiança detectado no tool input — consulte .pantheon/logs/hooks.log'

/**
 * P2 (2026-08-06): talos-guard is restricted to WRITE-INTENT operations.
 * Read-only tools (find/grep/search) legitimately match RISKY_PATH_RE (e.g.
 * grepping for 'auth') and must NEVER trigger the advisory. edit/write/patch
 * always write; bash only when the command contains a write operator
 * (redirect to a file, mv/cp/rm/tee, sed -i, git commit/push). `2>&1` fd
 * duplication is NOT a file write and does not trigger.
 */
const WRITE_INTENT_TOOLS = new Set(['edit', 'write', 'patch'])
const BASH_WRITE_INTENT_RE = />>|>(?!&)|\b(mv|cp|rm|tee)\b|\bsed\s+-i\b|\bgit\s+(commit|push)\b/

/**
 * Strong failure markers for the tool RESULT (tool.execute.after output).
 * Deliberately conservative — a completed task whose output merely mentions
 * an error word must not be mislabeled a failure. Mirrored by the stop-hook
 * script's own markers.
 */
const RESULT_FAILURE_MARKERS =
  /\b(refused|denied|traceback|exception|unhandled|fatal)\b|failed to|unable to|timed out|error:/i

/**
 * P0-2 delegation correlation: every delegation gets a delegation_id in
 * tool.execute.before (crypto.randomUUID), threaded through the payload to
 * BOTH the start and the stop hook so delegations.log joins Start↔Stop on it.
 * Records are keyed by callID (stable across before/after for the same tool
 * call — the council tracking already relies on this) and hold the BEFORE-time
 * agent, so the after-hook agent can never be contaminated by a merged result
 * blob. Bounded: at most DELEGATION_TRACK_MAX entries, entries older than
 * DELEGATION_TRACK_TTL_MS are pruned.
 */
type DelegationStart = {
  delegation_id: string
  agent: string
  startedAt: number
}
const delegationStarts = new Map<string, DelegationStart>()
const DELEGATION_TRACK_MAX = 100
const DELEGATION_TRACK_TTL_MS = 30 * 60 * 1000

/** P0-1: background-dispatch state values (dispatch, not completion). */
const BACKGROUND_STATE_RE = /^(running|queued|pending|scheduled|dispatched)$/i

/** P0-1: free-text task_id extraction from a JSON-ish tool result. */
const TASK_ID_RE = /"task_id"\s*:\s*"?([^",\s}]+)"?/i

/**
 * P0-5 (2026-08-06): TEXT background-dispatch signature — the ACTUAL runtime
 * format of the task tool in BACKGROUND mode on opencode 1.18.x (verified in
 * the installed 1.18.14 binary): the tool returns IMMEDIATELY with free TEXT
 * (not JSON) `<task id="ses_..." state="running">\n<summary>Background task
 * started</summary>...` plus `metadata.background === true` and a `jobId`.
 * Attribute order is id-then-state (as emitted by the runtime); the `i` flag
 * tolerates case differences. Matched against title+output text.
 */
const BACKGROUND_DISPATCH_TEXT_RE =
  /<task\s+[^>]*\bid="(ses_[^"]+)"[^>]*\bstate="(running|queued|pending|scheduled|dispatched)"/i

/** P0-5: extract the REAL task id from the TEXT form `task id="ses_..."`. */
const TASK_ID_TEXT_RE = /\btask\s+id="(ses_[^"]+)"/i

/**
 * 1.18.13 chat.message fallback buffer (oh-my-openagent pattern — see header):
 * opencode 1.18.13 drops tui.toast.show events (untagged), so every signal
 * that would fire a toast is ALSO queued here and injected into the next user
 * message by the 'chat.message' hook as a single <system-reminder> text part.
 * Bounded: at most CHAT_REMINDER_MAX entries, each expiring
 * CHAT_REMINDER_TTL_MS after its tool event. Consumed (and cleared) by the
 * chat.message hook. Full-buffer enqueues are SKIPPED, never unbounded — the
 * olympians/3-in-6s aggregates still cover delegation groups, matching the
 * "throttled toasts are skipped, never backlogged" anti-spam philosophy.
 * session.idle flushes the buffer into ONE fresh aggregated entry (see
 * flushIdleReminders) so completions survive until the next user message.
 */
const CHAT_REMINDER_MAX = 10
const CHAT_REMINDER_TTL_MS = 60_000
const pendingChatReminders: { text: string; at: number }[] = []

/** Queue one chat-reminder line, pruning expired entries first. Never throws. */
function enqueueChatReminder(text: string): void {
  const now = Date.now()
  for (let i = pendingChatReminders.length - 1; i >= 0; i--) {
    const r = pendingChatReminders[i]
    if (r !== undefined && now - r.at > CHAT_REMINDER_TTL_MS) pendingChatReminders.splice(i, 1)
  }
  if (pendingChatReminders.length >= CHAT_REMINDER_MAX) return
  pendingChatReminders.push({ text, at: now })
}

/** Variants accepted by the opencode TUI showToast (TuiShowToastData.body.variant). */
type ToastVariant = 'info' | 'success' | 'warning' | 'error'

/** Options for notifyToast: message, TUI variant, category gate, duration, optional session dedupe key. */
type ToastOptions = {
  message: string
  variant: ToastVariant
  /** Gate category — the toast only fires when PANTHEON_TOASTS enables it. */
  category: ToastCategory
  duration?: number
  dedupeKey?: string
  /** Optional TUI toast headline (opencode showToast body.title). */
  title?: string
  /**
   * Optional text for the 1.18.13 chat.message <system-reminder> fallback.
   * Defaults to `message` when omitted — the reminder mirrors the toast.
   */
  reminder?: string
}

/** Logging context threaded through safeRun — provided by the plugin input. */
type HookContext = Pick<PluginInput, 'client' | 'directory'>

/** The tool.execute.after hook result ({title, output, metadata} — see header). */
type ToolExecuteAfterResult = { title: string; output: string; metadata: unknown }

function trim(s: string, max = 2000): string {
  const t = s.trim()
  return t.length > max ? `${t.slice(0, max)}…` : t
}

/** Translate the opencode hook event into the Claude Code protocol payload. */
function payloadFor(
  input: { tool: string; sessionID: string },
  toolInput: unknown,
  extra?: Record<string, unknown>,
): HookPayload {
  return {
    tool_name: input.tool,
    tool_input: toolInput ?? {},
    // tool.execute hooks carry no agent — resolve it from the sessionAgent map
    // (populated by the chat.params hook) with an inline agent field fallback.
    agent_id:
      sessionAgent.get(input.sessionID)?.agent ??
      (input as { agent?: { id?: string } }).agent?.id ??
      '',
    session_id: input.sessionID,
    ...(extra ?? {}),
  }
}

/**
 * P0-1/P0-2: the tool.execute.after payload. Separates the delegation-
 * LIFECYCLE fields (agent, delegation_id, task_id, status, duration_ms) from
 * the free-text result blob (tool_output). `start` is the tool.execute.before
 * record keyed by callID — when present, its agent wins (the after-hook args
 * may carry the MERGED background result {task_id, state}, never a
 * subagent_type). Additive keys only — scripts read stdin JSON, so the schema
 * stays compatible with older payloads.
 */
function afterPayloadFor(
  input: { tool: string; sessionID: string },
  args: unknown,
  result: ToolExecuteAfterResult | null,
  start?: DelegationStart,
): HookPayload {
  const extra: Record<string, unknown> = {
    tool_output: result,
    status: deriveResultStatus(result),
  }
  if (start !== undefined) {
    extra.agent_id = start.agent
    extra.delegation_id = start.delegation_id
    extra.duration_ms = Math.max(0, Date.now() - start.startedAt)
  }
  const taskID = extractTaskId(result)
  if (taskID !== '') extra.task_id = taskID
  return payloadFor(input, args, extra)
}

/**
 * Derive 'success' | 'failure' | 'dispatched' | 'unknown' from the tool
 * result. Precedence:
 *   1. background-dispatch signature → 'dispatched': the task tool in
 *      BACKGROUND mode returns immediately with {task_id, state:'running'}
 *      (or 'queued'/'pending') — that is DISPATCH, not completion (P0-1);
 *   2. explicit status-ish fields in metadata (existing logic);
 *   3. failure markers in the result text;
 *   4. non-empty output (real completion evidence) → 'success';
 *   5. 'unknown'. Never throws.
 */
function deriveResultStatus(
  result: ToolExecuteAfterResult | null | undefined,
): 'success' | 'failure' | 'dispatched' | 'unknown' {
  if (result === null || result === undefined) return 'unknown'
  const meta = result.metadata
  if (meta !== null && typeof meta === 'object') {
    const m = meta as Record<string, unknown>
    // P0-1: background-dispatch state values first ('running'/'queued'/...).
    for (const key of ['status', 'state']) {
      const v = m[key]
      if (typeof v === 'string' && BACKGROUND_STATE_RE.test(v.trim())) return 'dispatched'
    }
    for (const key of ['status', 'state', 'ok', 'success', 'error', 'failed']) {
      if (key in m) {
        const v = m[key]
        if (typeof v === 'boolean') return v ? 'success' : 'failure'
        if (typeof v === 'string') {
          const low = v.trim().toLowerCase()
          if (
            [
              'success',
              'successful',
              'completed',
              'complete',
              'done',
              'finished',
              'ok',
              'true',
              '1',
            ].includes(low)
          ) {
            return 'success'
          }
          if (
            [
              'failure',
              'failed',
              'error',
              'refused',
              'denied',
              'exception',
              'false',
              '0',
              'cancelled',
              'canceled',
              'aborted',
            ].includes(low)
          ) {
            return 'failure'
          }
        }
      }
    }
    // P0-1: task_id field with no terminal status above — background dispatch.
    if (m.task_id !== undefined || m.taskId !== undefined) return 'dispatched'
    // P0-5: `background: true` marks a background launch (verified 1.18.14:
    // the dispatch result metadata is {..., background: true, jobId}).
    if (m.background === true) return 'dispatched'
  }
  const text = `${result.title ?? ''} ${result.output ?? ''}`
  // P0-1: JSON-as-string output {"task_id":..., "state":"running"} — the
  // background dispatch signature delivered as free text inside the result.
  if (typeof result.output === 'string' && result.output.trim() !== '') {
    const parsed = tryParseJsonObject(result.output)
    if (parsed !== null && (parsed.task_id !== undefined || parsed.taskId !== undefined)) {
      return 'dispatched'
    }
    // P0-5: TEXT background-dispatch signature — the ACTUAL runtime format on
    // 1.18.x: `<task id="ses_..." state="running">\n<summary>Background task
    // started</summary>...`. Without this, the blob fell through to the
    // non-empty-output → 'success' branch below — the false success observed
    // by the user's test battery (2026-08-06).
    if (BACKGROUND_DISPATCH_TEXT_RE.test(text)) return 'dispatched'
  }
  if (RESULT_FAILURE_MARKERS.test(text)) return 'failure'
  if (typeof result.output === 'string' && result.output.trim() !== '') return 'success'
  return 'unknown'
}

/**
 * P0-1 sanitizer: coerce a payload value to a plain string; non-primitive junk
 * (objects/arrays from a merged result blob) becomes ''. Guards the
 * delegation-lifecycle fields so agent/status/task_id can never be polluted.
 */
function prim(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v)
  return ''
}

/** Parse a JSON-object string into a plain record (null when not JSON). */
function tryParseJsonObject(text: string): Record<string, unknown> | null {
  const t = text.trim()
  if (!t.startsWith('{')) return null
  try {
    const v = JSON.parse(t) as unknown
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return v as Record<string, unknown>
    }
  } catch {
    // Not JSON — null.
  }
  return null
}

/**
 * P0-1: extract the background `task_id` into its OWN clean field — never
 * concatenated into agent/status. Sources: metadata (task_id/taskId) →
 * JSON-as-string in output → free-text regex over the result.
 */
function extractTaskId(result: ToolExecuteAfterResult | null | undefined): string {
  if (result === null || result === undefined) return ''
  const meta = result.metadata
  if (meta !== null && typeof meta === 'object') {
    const m = meta as Record<string, unknown>
    const direct = m.task_id ?? m.taskId
    if (direct !== undefined) return prim(direct)
  }
  if (typeof result.output === 'string' && result.output.trim() !== '') {
    const parsed = tryParseJsonObject(result.output)
    if (parsed !== null) {
      const direct = parsed.task_id ?? parsed.taskId
      if (direct !== undefined) return prim(direct)
    }
    const m = TASK_ID_RE.exec(result.output)
    if (m?.[1] !== undefined) return m[1]
    // P0-5: TEXT form `<task id="ses_..." state="running">` — the runtime
    // background-dispatch format (id sits in its own attribute, not JSON).
    const mt = TASK_ID_TEXT_RE.exec(result.output)
    if (mt?.[1] !== undefined) return mt[1]
  }
  return ''
}

/** P0-2: prune stale delegation records; over the cap, drop oldest first. */
function pruneDelegationStarts(now: number): void {
  for (const [callID, rec] of delegationStarts) {
    if (now - rec.startedAt > DELEGATION_TRACK_TTL_MS) delegationStarts.delete(callID)
  }
  while (delegationStarts.size >= DELEGATION_TRACK_MAX) {
    let oldestID: string | null = null
    let oldestAt = Infinity
    for (const [callID, rec] of delegationStarts) {
      if (rec.startedAt < oldestAt) {
        oldestAt = rec.startedAt
        oldestID = callID
      }
    }
    if (oldestID === null) break
    delegationStarts.delete(oldestID)
  }
}

/** Append one line to .pantheon/logs/hooks.log under the project directory. */
async function appendHookLog(directory: string, line: string): Promise<void> {
  const dir = join(directory, '.pantheon', 'logs')
  await mkdir(dir, { recursive: true })
  // P2 (2026-08-06): every line carries an ISO timestamp so the hook trail is
  // chronologically readable — [2026-08-06T13:00:00.000Z] message.
  // P0-5 (2026-08-06): a message containing real newlines (e.g. multi-line
  // stderr) used to produce continuation lines WITHOUT the timestamp prefix
  // (user evidence: `[SECRET SCAN] High-confidence hardcoded secret
  // detected…` with no prefix). Split on \n, trim each piece, skip empties,
  // and write `[ISO] piece` per line — one message → N fully-timestamped
  // lines. Same ISO stamp for the whole message (they are one event).
  const stamp = new Date().toISOString()
  const body = line
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => `[${stamp}] ${p}`)
    .join('\n')
  if (body === '') return
  await appendFile(join(dir, 'hooks.log'), `${body}\n`, 'utf8')
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
  level: 'error' | 'info' | 'warn' = 'error',
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
 * most once). Gated by the notification's category (PANTHEON_TOASTS). Best-
 * effort: headless mode or a missing TUI endpoint must never throw out of a
 * hook. Every fired toast is also recorded via reportFailure (script 'toast',
 * level 'info') so the toast trail is auditable — the log channels write
 * regardless of the display gate.
 */
async function notifyToast(ctx: HookContext, opts: ToastOptions): Promise<void> {
  try {
    if (opts.dedupeKey) {
      if (toastShown.has(opts.dedupeKey)) return
      toastShown.add(opts.dedupeKey)
    }
    if (!toastCategoryEnabled(opts.category)) return
    // 1.18.13 fallback: queue the same signal for the chat.message hook (the
    // TUI drops tui.toast.show on 1.18.13 — see header). Enqueued even if
    // showToast fails, so headless/no-TUI servers still surface feedback.
    enqueueChatReminder(opts.reminder ?? opts.message)
    await ctx.client.tui.showToast({
      body: {
        ...(opts.title !== undefined ? { title: opts.title } : {}),
        message: opts.message,
        variant: opts.variant,
        duration: opts.duration ?? 4000,
      },
    })
    await reportFailure(
      ctx,
      `[pantheon-hooks:toast] ${opts.message}`,
      {
        script: 'toast',
        category: opts.category,
        title: opts.title ?? null,
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
 * completion summary covers the group. Only applies to delegation lifecycle
 * toasts; error toasts (hook failures, agent failures) bypass the throttle
 * entirely (severity priority) and keep their plain session dedupe.
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
  await throttledToast(ctx, {
    title: 'Delegação',
    message: `🚀 ${agent} em execução`,
    variant: 'info',
    duration: 2500,
    category: 'delegations',
    dedupeKey: `${agent}|start`,
  })
}

/**
 * ✅ delegation-completed toast (variant 'success', 3000ms), deduped per agent.
 * Anti-spam aggregation: when 3+ distinct agents complete within a 6s window,
 * the individual toasts are REPLACED by one "✅ N agentes concluídos (...)"
 * toast and the buffer is flushed. The aggregate bypasses the 2s throttle so
 * the group summary is always visible — it is inherently rare (≥3 agents / 6s).
 * Agents belonging to a detected group are handled by olympians aggregation
 * instead (handleOlympiansCompletion) and never reach this path.
 */
async function delegationDoneToast(ctx: HookContext, agent: string): Promise<void> {
  const now = Date.now()
  for (const [name, at] of completedAgents) {
    if (now - at > GROUP_COMPLETE_WINDOW_MS) completedAgents.delete(name)
  }
  completedAgents.set(agent, now)
  if (completedAgents.size >= GROUP_COMPLETE_MIN) {
    const count = completedAgents.size
    const names = [...completedAgents.keys()].sort().join(', ')
    completedAgents.clear()
    await notifyToast(ctx, {
      title: 'Delegação',
      message: `✅ ${count} agentes concluídos (${names})`,
      variant: 'success',
      duration: 4000,
      category: 'delegations',
      dedupeKey: `group-complete|${names}`,
    })
    return
  }
  await throttledToast(ctx, {
    title: 'Delegação',
    message: `✅ ${agent} concluiu`,
    variant: 'success',
    duration: 3000,
    category: 'delegations',
    dedupeKey: `${agent}|done`,
  })
}

/** ⚙️ olympians-detected toast — fires ONCE per group (on the 2nd in-window task call). */
async function notifyOlympiansStarted(ctx: HookContext, olympians: Olympians): Promise<void> {
  const count = olympians.agents.size
  await notifyToast(ctx, {
    title: 'Olympians',
    message: `⚙️ Olympians: ${count} agentes em formação`,
    variant: 'info',
    duration: 3000,
    category: 'delegations',
    dedupeKey: `olympians-start|${olympians.id}`,
  })
}

/** ✅ olympians-complete toast — fires once when every group member has completed. */
async function notifyOlympiansComplete(ctx: HookContext, olympians: Olympians): Promise<void> {
  const names = [...olympians.agents].sort().join(', ')
  await notifyToast(ctx, {
    title: 'Olympians',
    message: `✅ Olympians: ${olympians.doneCount}/${olympians.agents.size} concluídos (${names})`,
    variant: 'success',
    duration: 4000,
    category: 'delegations',
    dedupeKey: `olympians-complete|${olympians.id}`,
  })
}

/**
 * ⚠️ agent-failed toast (severity priority — category 'errors', individual,
 * exempt from throttle and aggregation). Fired when the tool result carries
 * failure evidence. Never deduped: every failure surfaces.
 */
async function agentFailedToast(
  ctx: HookContext,
  agent: string,
  result: ToolExecuteAfterResult | null,
): Promise<void> {
  const raw = result?.output ?? result?.title ?? ''
  // Fix 1: the failure reason echoes tool RESULT content — mask any token so
  // the toast/chat-reminder/hooks.log trail never exposes a raw secret.
  const reason = maskSecret(
    trim(typeof raw === 'string' && raw.trim() !== '' ? raw : 'tool failed', 120),
  )
  await notifyToast(ctx, {
    title: 'Delegação',
    message: `⚠️ ${agent} falhou: ${reason}`,
    variant: 'error',
    duration: 5000,
    category: 'errors',
  })
}

/**
 * GAP C (2026-08-06): ⚠️ bash-command-failed notification (severity priority
 * — category 'errors', individual, exempt from the 2s throttle and from
 * aggregation, never deduped). Fired when the bash tool result reports a
 * non-zero exit code; exit 0 → silent. The exit-code signal is
 * `metadata.exit` on the after-hook result — empirically verified against the
 * installed opencode 1.18.14 binary: the shell tool returns
 * {title, output, metadata: {output, exit, truncated}} where `exit` is the
 * real process exit code (number, or null on timeout/abort). Fix 1: the
 * reason echoes tool RESULT content — mask any token so the trail never
 * exposes a raw secret.
 */
async function bashFailedToast(
  ctx: HookContext,
  exitCode: number | null,
  result: ToolExecuteAfterResult | null,
): Promise<void> {
  const raw = result?.output ?? result?.title ?? ''
  const firstLine = typeof raw === 'string' ? (raw.split('\n')[0] ?? '').trim() : ''
  const reason = maskSecret(trim(firstLine, 100))
  await notifyToast(ctx, {
    title: 'Comando',
    message:
      exitCode !== null
        ? `⚠️ comando falhou: exit ${exitCode}${reason !== '' ? ` — ${reason}` : ''}`
        : `⚠️ comando falhou${reason !== '' ? `: ${reason}` : ''}`,
    variant: 'error',
    duration: 5000,
    category: 'errors',
  })
}

/**
 * Olympians-aware delegation start. Returns nothing; side effects:
 *   - 1st task of a window → starts a group buffer + fires the individual 🚀
 *   - 2nd+ task within the window → joins the group; the 2nd call fires the
 *     single ⚙️ olympians notification (later members only update the buffer)
 */
function onDelegationStart(ctx: HookContext, agent: string): void {
  const now = Date.now()
  if (activeOlympians !== null && now - activeOlympians.lastTaskAt <= OLYMPIANS_DETECT_WINDOW_MS) {
    activeOlympians.lastTaskAt = now
    activeOlympians.agents.add(agent)
    activeOlympians.pendingCompletions.add(agent)
    if (activeOlympians.agents.size === 2) {
      activeOlympians.detected = true
      void notifyOlympiansStarted(ctx, activeOlympians)
    }
    // No individual 🚀 toast for 2nd+ members — the group notification covers them.
    return
  }
  activeOlympians = {
    id: `olympians-${now}-${++olympiansSeq}`,
    agents: new Set([agent]),
    startedAt: now,
    lastTaskAt: now,
    pendingCompletions: new Set([agent]),
    doneCount: 0,
    detected: false,
  }
  void delegationStartedToast(ctx, agent)
}

/**
 * Olympians-aware delegation completion. Returns true when the completion was
 * consumed by the group (its individual ✅ is suppressed in favor of the group
 * aggregate); false when the agent is not part of a detected group and should
 * fall through to the normal 3-in-6s / individual completion toast. Also
 * invoked for FAILED members (severity): the failure toast fires separately
 * and the member still counts as done for the group summary.
 */
function handleOlympiansCompletion(ctx: HookContext, agent: string): boolean {
  if (activeOlympians === null || !activeOlympians.agents.has(agent)) return false
  if (activeOlympians.pendingCompletions.has(agent)) {
    activeOlympians.doneCount++
    activeOlympians.pendingCompletions.delete(agent)
  }
  if (!activeOlympians.detected) {
    // Never became a real group (only this agent) — release and fall through.
    activeOlympians = null
    return false
  }
  if (activeOlympians.doneCount >= activeOlympians.agents.size) {
    void notifyOlympiansComplete(ctx, activeOlympians)
    activeOlympians = null
  }
  return true
}

/** Conservative council detection: description/prompt mentions council terms. */
function isCouncilTask(tool: string, args?: unknown): boolean {
  if (!DELEGATION_TOOL_RE.test(tool)) return false
  try {
    const a = (args ?? {}) as Record<string, unknown>
    const text = [a.prompt, a.description, a.task, a.taskDesc, a.detail]
      .filter((x): x is string => typeof x === 'string')
      .join(' ')
    return COUNCIL_RE.test(text)
  } catch {
    // Malformed args — not a council task.
    return false
  }
}

/** 🏛️ council-started notification — fires once per council (category 'council'). */
function onCouncilStart(ctx: HookContext): void {
  councilDispatchCount++
  if (councilStartNotified) return
  councilStartNotified = true
  void notifyToast(ctx, {
    title: 'Council',
    message: '🏛️ Council: especialistas consultados',
    variant: 'info',
    duration: 3500,
    category: 'council',
  })
}

/** ✅ council verdict notification — fires once all dispatched specialists finished. */
function onCouncilDone(ctx: HookContext): void {
  councilDoneCount++
  if (councilDispatchCount > 0 && councilDoneCount >= councilDispatchCount) {
    void notifyToast(ctx, {
      title: 'Council',
      message: '✅ Veredito pronto',
      variant: 'success',
      duration: 4000,
      category: 'council',
    })
    // Reset so a subsequent council session starts fresh (verdicts never re-fire).
    councilDispatchCount = 0
    councilDoneCount = 0
    councilStartNotified = false
    pendingCouncilCalls.clear()
  }
}

/**
 * session.idle flush (see header): aggregate any pending chat reminders into
 * ONE fresh <system-reminder> entry (individual ✅ completions collapse into
 * "✅ N agentes concluídos (...)"), report partial groups whose members never
 * all completed, and reset interrupted council counters. The chat.message
 * hook remains the delivery path — the flushed entry has a fresh timestamp so
 * it survives until the next user message instead of expiring while the user
 * reads the reply.
 */
function flushIdleReminders(ctx: HookContext): void {
  if (ENABLED_TOAST_CATEGORIES.size === 0) {
    pendingChatReminders.length = 0
    activeOlympians = null
    return
  }
  const now = Date.now()
  const fresh = pendingChatReminders.filter((r) => now - r.at <= CHAT_REMINDER_TTL_MS)
  pendingChatReminders.length = 0

  // Partial group: some members completed but the group never finished (their
  // completion was suppressed waiting for the aggregate). Report the subset.
  const partialGroup = activeOlympians
  if (partialGroup !== null) {
    const done = [...partialGroup.agents].filter((a) => !partialGroup.pendingCompletions.has(a))
    if (partialGroup.detected && partialGroup.doneCount > 0 && done.length > 0) {
      fresh.push({
        text:
          done.length === 1
            ? `✅ ${done[0]} concluiu`
            : `✅ ${done.length} agentes concluídos (${done.sort().join(', ')})`,
        at: now,
      })
    }
  }
  activeOlympians = null

  // Interrupted council counters must not block a later council's verdict —
  // but ONLY when no council specialist is still running. Synchronous
  // councils finish specialists at different times (nyx ~11s / prometheus
  // ~21s / themis ~38s): session.idle fires mid-flight, so resetting here
  // would drop the "✅ Veredito pronto" toast. Skip the reset while
  // pendingCouncilCalls is non-empty — onCouncilDone resets on the verdict.
  if (pendingCouncilCalls.size === 0) {
    councilDispatchCount = 0
    councilDoneCount = 0
    councilStartNotified = false
  }

  // Collapse individual ✅ completions into one aggregate line.
  const doneAgents: string[] = []
  const others: string[] = []
  for (const r of fresh) {
    const m = /^✅ (.+?) concluiu$/.exec(r.text)
    if (m?.[1] !== undefined) doneAgents.push(m[1])
    else others.push(r.text)
  }
  const lines: string[] = []
  if (doneAgents.length > 0) {
    lines.push(
      doneAgents.length === 1
        ? `✅ ${doneAgents[0]} concluiu`
        : `✅ ${doneAgents.length} agentes concluídos (${doneAgents.sort().join(', ')})`,
    )
  }
  lines.push(...others)
  if (lines.length === 0) return

  // ONE aggregated entry, fresh timestamp — chat.message delivers it next.
  enqueueChatReminder(lines.join('\n'))
  void reportFailure(
    ctx,
    `[pantheon-hooks:idle-flush] ${lines.join(' | ')}`,
    { script: 'idle-flush', count: fresh.length },
    'info',
  )
}

/**
 * Run one hook with the logging policy; NEVER throw out of the hook.
 *
 * Non-zero exit → structured log + hooks.log + one deduped TUI toast.
 * Zero exit   → silent, unless PANTHEON_HOOKS_LOG is set for audit scripts
 *               (echo routed to structured log + hooks.log, never the TUI).
 * No console.error / console.log anywhere in this path — the TUI stays clean.
 *
 * Returns the underlying HookResult (or null on unexpected failure) so the
 * tool.execute.before handler can inspect scan-secrets.sh's exit code for the
 * Fix-2 hybrid block (code 2 = high-confidence token → throw after logging).
 */
async function safeRun(
  ctx: HookContext,
  script: string,
  payload: HookPayload,
): Promise<HookResult | null> {
  try {
    const result = await runHook(script, payload)
    const tag = `[pantheon-hooks:${script}]`
    const extra = { script, code: result.code, timedOut: result.timedOut, tool: payload.tool_name }
    if (result.code !== 0) {
      // Fix 1: maskSecret() defense-in-depth — script stderr is normally
      // already masked by the .sh scripts, but the hook trail must never
      // echo a raw token even if a future script regresses.
      const message = `${tag} exit ${result.code}${result.timedOut ? ' (timed out)' : ''}: ${maskSecret(trim(result.stderr || result.stdout || 'no output'))}`
      await reportFailure(ctx, message, extra)
      const match = maskSecret(trim(result.stderr || result.stdout || 'no output', 120))
      const suffix = result.timedOut ? ' (timeout)' : ''
      void notifyToast(ctx, {
        title: 'Pantheon Hook',
        message: `⚠️ Hook ${script}: exit ${result.code}${suffix} — see log`,
        variant: 'error',
        duration: 4000,
        category: 'errors',
        dedupeKey: `${script}|${result.code}|${match}`,
      })
    } else if (AUDIT_LOG_ENABLED && AUDIT_HOOKS.has(script) && result.stderr.trim()) {
      // Opt-in only (PANTHEON_HOOKS_LOG=1): audit scripts echo their FILE
      // writes here for debugging. Default is silence — the .sh scripts
      // already persist sessions.log / delegations.log on disk. Echo goes to
      // the structured log + hooks.log, never the TUI console.
      const message = `${tag} ${maskSecret(trim(result.stderr))}`
      await reportFailure(ctx, message, extra, 'info')
    }
    return result
  } catch (err) {
    // runHook never throws, but the hook body must survive anything.
    const message = `[pantheon-hooks:${script}] unexpected failure: ${maskSecret(err instanceof Error ? err.message : String(err))}`
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
    return null
  }
}

const plugin: Plugin = async ({ client, directory }) => {
  const ctx: HookContext = { client, directory }
  return {
    'tool.execute.before': async (input, output) => {
      // Fix 2 (2026-08-06): the ONLY deliberate throw in this plugin. Set
      // inside the try but thrown AFTER it — every log channel (safeRun's
      // reportFailure + the explicit block reportFailure below) is awaited
      // BEFORE the throw, and the throw is not swallowed by the hook's
      // catch: opencode propagates the rejection to fail the tool call.
      let blockError: Error | null = null
      try {
        const hooks = ['validate-talos-scope.sh', 'scan-secrets.sh', 'validate-tool-safety.sh']
        // P0-2: the delegation record must exist BEFORE the payload is built
        // so the start hook receives the delegation_id the stop hook joins on.
        let payload = payloadFor(input, output?.args ?? {})
        if (DELEGATION_TOOL_RE.test(input.tool)) {
          hooks.push('on-subagent-delegation-start.sh')
          // tool.execute.before carries args on `output` (typed); `input.args`
          // also exists at runtime — read from whichever is present.
          const args = output?.args ?? (input as { args?: unknown }).args
          const start: DelegationStart = {
            delegation_id: crypto.randomUUID(),
            agent: delegationAgent(input.tool, args),
            startedAt: Date.now(),
          }
          delegationStarts.set(input.callID, start)
          pruneDelegationStarts(start.startedAt)
          // P0-1: agent_id + delegation_id ride on the payload — the stop
          // hook resolves its agent from the START record, never from
          // after-time args that may carry the merged background result.
          payload = payloadFor(input, args, {
            agent_id: start.agent,
            delegation_id: start.delegation_id,
          })
          if (isCouncilTask(input.tool, args)) {
            // Track by callID — the after-hook args do NOT repeat the
            // council description, so completion is matched via this set.
            pendingCouncilCalls.add(input.callID)
            onCouncilStart(ctx)
          }
          onDelegationStart(ctx, start.agent)
        }
        // P2 (2026-08-06): talos-guard is restricted to WRITE-INTENT operations
        // — edit/write/patch, or bash with a write operator (>, >>, mv, cp, rm,
        // sed -i, tee, git commit/push). Read-only find/grep must NEVER trigger
        // (they legitimately match RISKY_PATH_RE, e.g. grepping for 'auth').
        // Advisory only, never blocks, never throws.
        const guardArgs = (output?.args ?? (input as { args?: unknown }).args ?? {}) as Record<
          string,
          unknown
        >
        const rawCommand = guardArgs.command ?? guardArgs.cmd
        const bashCommand = typeof rawCommand === 'string' ? rawCommand : ''
        const isWriteIntent =
          WRITE_INTENT_TOOLS.has(input.tool) ||
          (input.tool === 'bash' && BASH_WRITE_INTENT_RE.test(bashCommand))
        if (isWriteIntent) {
          try {
            const values: string[] = []
            const scan = (v: unknown): void => {
              if (typeof v === 'string') values.push(v)
              else if (Array.isArray(v)) v.forEach(scan)
              else if (v !== null && typeof v === 'object') {
                for (const x of Object.values(v)) scan(x)
              }
            }
            scan(guardArgs)
            let hit: string | null = null
            for (const v of values) {
              if (RISKY_PATH_RE.test(v)) {
                hit = v
                break
              }
            }
            if (hit !== null) {
              // Fix 1: NEVER log the raw matched value — a real secret in a
              // write-intent arg (e.g. bash `old_token = "sk-bf-..."`) leaked
              // in plain text to hooks.log on 2026-08-06. maskSecret() keeps
              // only the tool name + masked path/arg context + signal count.
              void reportFailure(
                ctx,
                `[talos-guard] ⚠️ Operação em área sensível: ${maskSecret(hit.slice(0, 160))}`,
                { script: 'talos-guard', tool: input.tool, category: 'errors' },
                'warn',
              )
            } else {
              const uniqueFiles = new Set(
                values.filter((v) => v.includes('/') && /(^|\/)[^/\s]+\.[a-z0-9]+$/i.test(v)),
              )
              if (uniqueFiles.size > 3) {
                void reportFailure(
                  ctx,
                  `[talos-guard] ⚠️ Operação multi-arquivo: ${uniqueFiles.size} arquivos`,
                  {
                    script: 'talos-guard',
                    tool: input.tool,
                    category: 'errors',
                    count: uniqueFiles.size,
                  },
                  'warn',
                )
              }
            }
          } catch {
            // Advisory only — a failure here must never take down the hook.
          }
        }
        // Fix 2 hybrid blocking: safeRun returns each script's HookResult;
        // scan-secrets.sh exits 2 on HIGH_CONFIDENCE token matches
        // (sk-bf-*, AKIA..., ghp_..., glpat-..., JWT, bearer...) → BLOCK the
        // tool call. Exit 1 (low-confidence header/KEY names) stays advisory
        // — safeRun already logged + toasted it, no block. The toast for
        // code 1/2 fires inside safeRun BEFORE we reach the throw, and the
        // reportFailure below is awaited first — log channels always write.
        const results = await Promise.all(
          hooks.map(async (script) => ({ script, result: await safeRun(ctx, script, payload) })),
        )
        const scan = results.find((r) => r.script === 'scan-secrets.sh')
        if (scan?.result?.code === 2) {
          await reportFailure(
            ctx,
            SECRET_BLOCK_MESSAGE,
            { script: 'scan-secrets', tool: input.tool, blocked: true, code: 2 },
            'error',
          )
          blockError = new Error(SECRET_BLOCK_MESSAGE)
        }
      } catch {
        // Never let a hook take down the opencode session — except the
        // deliberate high-confidence block thrown below.
      }
      if (blockError !== null) throw blockError
    },
    'tool.execute.after': async (input, output) => {
      try {
        const args = (input as { args?: unknown }).args ?? {}
        // P1-1 fix: `output` is the REAL tool result ({title, output,
        // metadata}). P0-1/P0-2: the lifecycle fields (agent, delegation_id,
        // task_id, status, duration_ms) are derived from the before-record +
        // result — never from result text blobs.
        const result: ToolExecuteAfterResult | null = output ?? null
        // GAP C (2026-08-06): monitor command-runner exit codes. Signal used:
        // `metadata.exit` on the after-hook result — empirically verified
        // against the installed opencode 1.18.14 binary (the shell tool
        // returns {title, output, metadata: {output, exit, truncated}}). The
        // exit code is a real number; non-zero → individual error
        // notification (severity priority — never throttled/aggregated);
        // exit 0 → silent. Fallback for custom runners where `exit` is
        // absent: strong failure markers in the output trigger the same
        // notification (documented signal: marker match).
        if (input.tool === 'bash' && result !== null) {
          let exitCode: number | null = null
          if (result.metadata !== null && typeof result.metadata === 'object') {
            const m = result.metadata as Record<string, unknown>
            if (typeof m.exit === 'number') exitCode = m.exit
          }
          if (exitCode !== null && exitCode !== 0) {
            void bashFailedToast(ctx, exitCode, result)
          } else if (
            exitCode === null &&
            typeof result.output === 'string' &&
            RESULT_FAILURE_MARKERS.test(result.output)
          ) {
            void bashFailedToast(ctx, null, result)
          }
        }
        let payload = afterPayloadFor(input, args, result)
        const hooks = ['format-multi-language.sh']
        if (DELEGATION_TOOL_RE.test(input.tool)) {
          hooks.push('on-subagent-delegation-stop.sh')
          const start = delegationStarts.get(input.callID)
          // P0-1: agent comes from the START record (before-time args are
          // clean); the after-hook args may hold the MERGED background result
          // {task_id, state} with no subagent_type — never derive from those.
          const agent = start?.agent ?? delegationAgent(input.tool, args)
          const resultStatus = deriveResultStatus(result)
          if (start !== undefined) {
            payload = afterPayloadFor(input, args, result, start)
            delegationStarts.delete(input.callID)
          }
          // Severity (c): agent failures notify individually — never
          // throttled, never aggregated. Success/completion aggregates.
          if (resultStatus === 'failure') {
            void agentFailedToast(ctx, agent, result)
            void handleOlympiansCompletion(ctx, agent)
          } else if (resultStatus === 'dispatched') {
            // P0-1: BACKGROUND launch — tool.execute.after fires at dispatch
            // (the task tool returns {task_id, state:'running'} immediately).
            // NOT a completion: do not mark the group done and do not fire ✅
            // — that would corrupt olympians aggregation. Real completion of
            // background tasks is unobservable on 1.18.13 (see header).
          } else {
            const handledByOlympians = handleOlympiansCompletion(ctx, agent)
            if (!handledByOlympians) void delegationDoneToast(ctx, agent)
          }
          if (pendingCouncilCalls.delete(input.callID)) onCouncilDone(ctx)
        }
        await Promise.all(hooks.map((script) => safeRun(ctx, script, payload)))
      } catch {
        // Never let a hook take down the opencode session.
      }
    },
    // P0-4 session→agent map: fires per assistant turn with the active agent
    // name — record it so tool.execute hooks can resolve agent_id for
    // validate-talos-scope.sh. 'title' (session-title turns) is ignored.
    // Bounded: prunes entries older than 30min once the map exceeds 50.
    'chat.params': async (input) => {
      try {
        if (input.agent && input.agent !== 'title') {
          sessionAgent.set(input.sessionID, { agent: input.agent, at: Date.now() })
          if (sessionAgent.size > 50) {
            const cutoff = Date.now() - 30 * 60 * 1000
            for (const [k, v] of sessionAgent) {
              if (v.at < cutoff) sessionAgent.delete(k)
            }
          }
        }
      } catch {
        // Never let a hook take down the opencode session.
      }
    },
    // 1.18.13 fallback (Path C, oh-my-openagent pattern): the TUI drops
    // tui.toast.show events on opencode 1.18.13 (untagged — see header), so
    // queued agent-lifecycle signals (delegation start/done, hook failures,
    // olympians/council summaries) are injected here as ONE <system-reminder> text
    // part into the next user message, then cleared.
    // P0 (2026-08-11, live E2E — release blocker): this hook ALSO fires for the
    // child session's client.session.promptAsync (the old "subagent prompts use
    // a different path" claim is FALSE on 1.18.13), where input.messageID is
    // EMPTY/undefined. Injecting there with `?? ''` produced a part opencode's
    // schema rejects (SchemaError: Expected a string starting with "msg", got
    // "") → prompt_async failed → every delegation died in ~20ms. The guard
    // below skips injection ENTIRELY on that path WITHOUT draining the buffer,
    // so the reminder still lands on the parent's next real message.
    'chat.message': async (input, output) => {
      try {
        if (ENABLED_TOAST_CATEGORIES.size === 0) return
        if (pendingChatReminders.length === 0) return
        // Subagent promptAsync fires have no messageID — injecting any part
        // with an empty messageID crashes the child session (schema reject).
        // Early return BEFORE the buffer drain keeps the reminder queued for
        // the parent's next real (msg_-ID'd) message.
        if (!input.messageID) return
        const now = Date.now()
        const fresh = pendingChatReminders.filter((r) => now - r.at <= CHAT_REMINDER_TTL_MS)
        pendingChatReminders.length = 0
        if (fresh.length === 0) return
        const body = fresh.map((r) => r.text).join('\n')
        // Minimal TextPart — the core backfills messageID/sessionID for
        // hook-injected parts (see opencode chat.message trigger pipeline).
        // The guard above guarantees input.messageID is a non-empty string,
        // so no `?? ''` fallback is needed (an explicit "" is schema-rejected).
        output.parts.push({
          id: `prt_${crypto.randomUUID()}`,
          sessionID: input.sessionID,
          messageID: input.messageID,
          type: 'text',
          text: `<system-reminder>\n${body}\n</system-reminder>`,
        } satisfies Part)
        await reportFailure(
          ctx,
          `[pantheon-hooks:chat-reminder] ${body}`,
          { script: 'chat-reminder', count: fresh.length },
          'info',
        )
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
        } else if (ev.type === 'session.idle') {
          // Primary flush trigger for pending completion reminders (see header).
          flushIdleReminders(ctx)
        } else if (ev.type === 'session.error') {
          // Severity (c): any ❌/⚠️ event notifies individually, never
          // aggregated or throttled.
          const err: unknown = ev.properties.error
          const msg =
            typeof err === 'object' &&
            err !== null &&
            'message' in err &&
            typeof (err as { message: unknown }).message === 'string'
              ? String((err as { message: string }).message)
              : 'session error'
          void notifyToast(ctx, {
            title: 'Pantheon',
            message: `❌ ${trim(msg, 120)}`,
            variant: 'error',
            duration: 5000,
            category: 'errors',
          })
        }
      } catch {
        // Never let a hook take down the opencode session.
      }
    },
  }
}

export default plugin
