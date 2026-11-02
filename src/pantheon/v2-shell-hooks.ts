/**
 * V2 shell-hook parity — the shell hooks that ran only on the V1 generation.
 *
 * The V1 plugin (`src/plugins/pantheon-hooks.ts`, removed in 2.0) ran them from
 * its `tool.execute.before` / `tool.execute.after` handlers:
 *
 *   - `format-multi-language.sh` on every completed tool call (post-write
 *     formatting);
 *   - `on-subagent-delegation-start.sh` / `-stop.sh`, which append the
 *     `delegations.log` audit records (start/stop joined on `delegation_id`).
 *
 * V1 was a SEPARATE plugin and was never loaded on a V2-only install —
 * `opencode.json` `plugins` declares only `src/plugin-v2` — so both were dead
 * on V2, and 2.0 removed the V1 plugin outright. This module is the only
 * remaining wiring. The scripts themselves are environment-independent (they
 * read the Claude Code payload from stdin and write their own log files), so
 * they are run through the same `runHook` runner the secret scan already uses;
 * no legacy plugin import is needed and none is introduced.
 *
 * What is derived here, and why it is not a second implementation of V1:
 *
 *   - `delegation_id` — a UUID generated in the BEFORE hook and carried to the
 *     STOP hook through a callID-keyed record, which is how the two log lines
 *     join (the deleted V1 plugin did the same).
 *   - `agent_id` — `tool_input.subagent_type` (or `agent`/`target`) first, the
 *     tool name last, mirroring V1's `delegationAgent`. The AFTER-time args are
 *     never used to derive it, because a background dispatch returns
 *     `{task_id, state}` there and no agent.
 *   - `status` — `failure` on an error event, `dispatched` when the result
 *     carries a `task_id` or a running/queued state, `success` otherwise. A
 *     background dispatch is DISPATCH, never a fabricated success.
 *
 * Fail-open by contract: every call is wrapped, so a missing script, a timeout
 * or a malformed payload can never break the tool call it observes. The audit
 * trail is telemetry; the security decisions live in the guards, not here.
 *
 * @module v2-shell-hooks
 */

import { randomUUID } from 'node:crypto'
import { type HookPayload, type HookResult, runHook } from './hook-runner.ts'
import {
  appendDelegationAuditLine,
  delegationStartLine,
  delegationStopLine,
  formatterApplies,
} from './v2-hook-engine.ts'

/**
 * Delegation tool names. MIRRORS `DELEGATION_TOOL_RE` in the V1 plugin
 * (`src/plugins/pantheon-hooks.ts`, removed in 2.0). Deliberately duplicated
 * rather than ever imported: the V1 plugin is gone, and V2 must not couple to
 * legacy module layout for one regex. The drift risk against
 * scripts/hooks/on-subagent-delegation-*.sh (which accept the same tool
 * family) is asserted by tests/pantheon/v2-shell-hooks.test.ts.
 */
export const V2_DELEGATION_TOOL_RE = /^(task|.*subagent.*)$/i

/** Scripts, by the names `scripts/hooks/` ships. */
export const FORMATTER_SCRIPT = 'format-multi-language.sh'
export const DELEGATION_START_SCRIPT = 'on-subagent-delegation-start.sh'
export const DELEGATION_STOP_SCRIPT = 'on-subagent-delegation-stop.sh'

/** One audit/formatter invocation. Injected in tests to avoid spawning a shell. */
export type V2ShellRunner = (script: string, payload: HookPayload) => Promise<HookResult>

const IDLE_RESULT: HookResult = { code: 0, stdout: '', stderr: '', signal: null, timedOut: false }

/**
 * In-process dispatcher. Start/stop audit lines are written directly (same
 * JSON shape and LOG_DIR resolution as the shell scripts); the formatter
 * still spawns when the tool call touched a formattable file and is skipped —
 * without a child process — for every call the script would no-op anyway.
 */
const defaultRunner: V2ShellRunner = async (script, payload) => {
  const record = (payload ?? {}) as Record<string, unknown>
  const tool = typeof record.tool_name === 'string' ? record.tool_name : ''
  if (script === DELEGATION_START_SCRIPT) {
    const delegationID = typeof record.delegation_id === 'string' ? record.delegation_id : ''
    const agent = typeof record.agent_id === 'string' ? record.agent_id : ''
    const sessionID = typeof record.session_id === 'string' ? record.session_id : ''
    const task =
      record.tool_input !== null && typeof record.tool_input === 'object'
        ? String((record.tool_input as Record<string, unknown>).description ?? '')
        : ''
    appendDelegationAuditLine(
      delegationStartLine({ agent, task, sessionID, delegationID, now: Date.now() }),
    )
    return IDLE_RESULT
  }
  if (script === DELEGATION_STOP_SCRIPT) {
    const delegationID = typeof record.delegation_id === 'string' ? record.delegation_id : ''
    const agent = typeof record.agent_id === 'string' ? record.agent_id : ''
    const sessionID = typeof record.session_id === 'string' ? record.session_id : ''
    const status = typeof record.status === 'string' ? record.status : ''
    const taskID = typeof record.task_id === 'string' ? record.task_id : ''
    const duration =
      typeof record.duration_ms === 'number' && Number.isFinite(record.duration_ms)
        ? Math.max(0, Math.round(record.duration_ms))
        : null
    appendDelegationAuditLine(
      delegationStopLine({
        agent,
        status,
        reason: status,
        task:
          record.tool_input !== null && typeof record.tool_input === 'object'
            ? String((record.tool_input as Record<string, unknown>).description ?? '')
            : '',
        sessionID,
        result: record.tool_output ?? null,
        delegationID,
        taskID,
        durationMs: duration,
        now: Date.now(),
      }),
    )
    return IDLE_RESULT
  }
  if (script === FORMATTER_SCRIPT) {
    if (!formatterApplies(tool, record.tool_input)) return IDLE_RESULT
    return runHook(script, payload)
  }
  return runHook(script, payload)
}

/** Hard cap on pending records — a tool result may never arrive. */
const MAX_PENDING_STARTS = 256

interface DelegationStart {
  delegationId: string
  agent: string
  startedAt: number
}

/** The `execute.before` fields this module reads. */
interface V2BeforeEvent {
  tool?: unknown
  sessionID?: unknown
  agent?: unknown
  id?: unknown
  input?: unknown
}

/** The `execute.after` fields this module reads. */
interface V2AfterEvent extends V2BeforeEvent {
  status?: unknown
  result?: unknown
}

/** Payload with the lifecycle keys the audit scripts read. */
type AuditPayload = HookPayload & Record<string, unknown>

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** `tool_input.subagent_type` (or agent/target) first, the tool name last. */
export function delegationAgent(tool: string, args: unknown): string {
  if (args !== null && typeof args === 'object') {
    const record = args as Record<string, unknown>
    for (const key of ['subagent_type', 'subagentType', 'agent', 'target']) {
      const candidate = record[key]
      if (typeof candidate === 'string' && candidate.trim() !== '') return candidate
    }
  }
  return tool
}

/** Task id from a background dispatch result, or '' when absent. */
export function extractTaskID(result: unknown): string {
  if (result === null || typeof result !== 'object') return ''
  const record = result as Record<string, unknown>
  const direct = record.task_id ?? record.taskID
  if (typeof direct === 'string') return direct
  const metadata = record.metadata
  if (metadata !== null && typeof metadata === 'object') {
    const nested = (metadata as Record<string, unknown>).task_id
    if (typeof nested === 'string') return nested
  }
  return ''
}

/** `success` | `failure` | `dispatched`, never a fabricated success. */
export function delegationStatus(event: V2AfterEvent): string {
  if (event.status === 'error') return 'failure'
  const result = event.result
  if (result !== null && typeof result === 'object') {
    const metadata = (result as Record<string, unknown>).metadata
    if (metadata !== null && typeof metadata === 'object') {
      for (const key of ['status', 'state']) {
        const value = (metadata as Record<string, unknown>)[key]
        if (
          typeof value === 'string' &&
          /^(running|queued|pending|scheduled)$/i.test(value.trim())
        ) {
          return 'dispatched'
        }
      }
    }
  }
  return extractTaskID(result) !== '' ? 'dispatched' : 'success'
}

/**
 * Build the two V2 shell-hook handlers.
 *
 * `run` and `now` exist for tests; production uses `runHook` and `Date.now`.
 */
export function createV2ShellHooks(
  options: {
    run?: V2ShellRunner
    now?: () => number
    /** Diagnostic sink for the unkeyed-event case (wired to hooks.log). */
    onUnkeyed?: (message: string) => void
  } = {},
): {
  before(event: unknown): Promise<void>
  after(event: unknown): Promise<void>
} {
  const run = options.run ?? defaultRunner
  const now = options.now ?? Date.now
  const starts = new Map<string, DelegationStart>()
  /** Set once: a host that never sends `id` must not flood the log. */
  let unkeyedWarned = false
  const warnUnkeyed = (phase: string): void => {
    if (unkeyedWarned) return
    unkeyedWarned = true
    options.onUnkeyed?.(
      `[delegation-audit] ${phase} event carries no tool call id; the audit record was skipped ` +
        'because a START without a key can never be joined by its STOP',
    )
  }

  /** Fire and swallow: telemetry must never break the observed tool call. */
  const fire = async (script: string, payload: AuditPayload): Promise<void> => {
    try {
      await run(script, payload)
    } catch {
      // Deliberately silent: the scripts log their own failures, and a thrown
      // audit hook would turn a completed tool call into an error.
    }
  }

  const basePayload = (event: V2BeforeEvent): AuditPayload => ({
    tool_name: text(event.tool),
    tool_input: event.input ?? {},
    agent_id: text(event.agent),
    session_id: text(event.sessionID),
  })

  return {
    async before(rawEvent: unknown): Promise<void> {
      if (rawEvent === null || typeof rawEvent !== 'object') return
      const event = rawEvent as V2BeforeEvent
      const tool = text(event.tool)
      if (!V2_DELEGATION_TOOL_RE.test(tool)) return
      const callID = text(event.id)
      if (callID === '') {
        // A START record with no joinable key is a record that can never be
        // closed: the after-event carries no id either, so the STOP would have
        // to omit `delegation_id` and the audit log would hold an orphan line
        // forever. Refuse to write it, and say so once.
        warnUnkeyed('execute.before')
        return
      }
      const start: DelegationStart = {
        delegationId: randomUUID(),
        agent: delegationAgent(tool, event.input),
        startedAt: now(),
      }
      while (starts.size >= MAX_PENDING_STARTS) {
        const oldest = starts.keys().next().value
        if (oldest === undefined) break
        starts.delete(oldest)
      }
      starts.set(callID, start)
      await fire(DELEGATION_START_SCRIPT, {
        ...basePayload(event),
        agent_id: start.agent,
        delegation_id: start.delegationId,
      })
    },

    async after(rawEvent: unknown): Promise<void> {
      if (rawEvent === null || typeof rawEvent !== 'object') return
      const event = rawEvent as V2AfterEvent
      const tool = text(event.tool)
      const payload = basePayload(event)
      // V1 ran the formatter on every after-event; the script no-ops when the
      // tool call touched no file it recognises.
      await fire(FORMATTER_SCRIPT, payload)
      if (!V2_DELEGATION_TOOL_RE.test(tool)) return
      const callID = text(event.id)
      if (callID === '') {
        // Mirrors the before-hook: no key means no join, so no record.
        warnUnkeyed('execute.after')
        return
      }
      const start = starts.get(callID)
      starts.delete(callID)
      const taskID = extractTaskID(event.result)
      await fire(DELEGATION_STOP_SCRIPT, {
        ...payload,
        ...(start === undefined
          ? {
              // No BEFORE record (the call was rejected before the audit ran, or
              // the record was evicted). The STOP still needs a key field to be a
              // well-formed audit line, so it gets a fresh one — an orphan STOP,
              // never an unkeyed one.
              delegation_id: randomUUID(),
            }
          : {
              // The BEFORE-time agent wins: the AFTER-time args may carry the
              // merged background result, which has no subagent_type.
              agent_id: start.agent,
              delegation_id: start.delegationId,
              duration_ms: Math.max(0, now() - start.startedAt),
            }),
        status: delegationStatus(event),
        tool_output: event.result ?? null,
        ...(taskID === '' ? {} : { task_id: taskID }),
      })
    },
  }
}
