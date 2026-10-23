/**
 * V2 shell-hook parity — the two V1 shell hooks that had no V2 equivalent.
 *
 * V1 runs them from `src/plugins/pantheon-hooks.ts` (`tool.execute.before` /
 * `tool.execute.after`):
 *
 *   - `format-multi-language.sh` on every completed tool call (post-write
 *     formatting);
 *   - `on-subagent-delegation-start.sh` / `-stop.sh`, which append the
 *     `delegations.log` audit records (start/stop joined on `delegation_id`).
 *
 * `pantheon-hooks.ts` is a SEPARATE plugin and is never loaded on a V2-only
 * install — `opencode.json` `plugins` declares only `src/plugin-v2` — so both
 * were dead on V2. The scripts themselves are environment-independent (they
 * read the Claude Code payload from stdin and write their own log files), so
 * they are run through the same `runHook` runner the secret scan already uses;
 * no V1 plugin import is needed and none is introduced.
 *
 * What is derived here, and why it is not a second implementation of V1:
 *
 *   - `delegation_id` — a UUID generated in the BEFORE hook and carried to the
 *     STOP hook through a callID-keyed record, which is how the two log lines
 *     join (V1 does the same in `pantheon-hooks.ts`).
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
import { type HookPayload, type HookResult, runHook } from '../plugins/hook-runner.ts'

/**
 * Delegation tool names. MIRRORS `DELEGATION_TOOL_RE` in
 * `src/plugins/pantheon-hooks.ts` (V1). Duplicated rather than imported: that
 * module is the V1 plugin, not loaded on a V2-only install, and importing it
 * for one regex would resurrect the V1 coupling V2 exists to remove. The drift
 * risk is asserted by tests/pantheon/v2-shell-hooks.test.ts.
 */
export const V2_DELEGATION_TOOL_RE = /^(task|.*subagent.*)$/i

/** Scripts, by the names `scripts/hooks/` ships. */
export const FORMATTER_SCRIPT = 'format-multi-language.sh'
export const DELEGATION_START_SCRIPT = 'on-subagent-delegation-start.sh'
export const DELEGATION_STOP_SCRIPT = 'on-subagent-delegation-stop.sh'

/** One script invocation. Injected in tests to avoid spawning a shell. */
export type V2ShellRunner = (script: string, payload: HookPayload) => Promise<HookResult>

const defaultRunner: V2ShellRunner = (script, payload) => runHook(script, payload)

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
export function createV2ShellHooks(options: { run?: V2ShellRunner; now?: () => number } = {}): {
  before(event: unknown): Promise<void>
  after(event: unknown): Promise<void>
} {
  const run = options.run ?? defaultRunner
  const now = options.now ?? Date.now
  const starts = new Map<string, DelegationStart>()

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
      const start: DelegationStart = {
        delegationId: randomUUID(),
        agent: delegationAgent(tool, event.input),
        startedAt: now(),
      }
      if (callID !== '') {
        while (starts.size >= MAX_PENDING_STARTS) {
          const oldest = starts.keys().next().value
          if (oldest === undefined) break
          starts.delete(oldest)
        }
        starts.set(callID, start)
      }
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
      // V1 runs the formatter on every after-event; the script no-ops when the
      // tool call touched no file it recognises.
      await fire(FORMATTER_SCRIPT, payload)
      if (!V2_DELEGATION_TOOL_RE.test(tool)) return
      const callID = text(event.id)
      const start = callID !== '' ? starts.get(callID) : undefined
      if (callID !== '') starts.delete(callID)
      const taskID = extractTaskID(event.result)
      await fire(DELEGATION_STOP_SCRIPT, {
        ...payload,
        ...(start === undefined
          ? {}
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
