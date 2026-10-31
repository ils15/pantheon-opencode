/**
 * P7 (loop) migration adapter — a per-EXECUTION counter on the measured event
 * channel.
 *
 * PLAN §5.1 branch 1 was selected by measurement (PROBE-D §7): the channel
 * covers child sessions and background work, so this adapter is built on
 * `session.execution.succeeded`. It consumes through the 0b contract
 * (`v2-decision-events.ts`, PLAN §5.2) and reads only `data.sessionID`; the
 * unmetered `properties` field is never read.
 *
 * ## The counter is per execution, not per turn (PROBE-D §4.3)
 *
 * `session.execution.started` and `session.execution.succeeded` are 1:1 in
 * 44/44 measured executions. An execution is the drain of a session's inbox,
 * and the mapping to turns is not one-to-one:
 *
 *   - one prompt drained at a time → +1 (T1–T4: 1 prompt = 1 execution;
 *     M1: 3 prompts = 3 executions);
 *   - a manual/scheduled compaction job gets its own execution → +1
 *     (C2: 2 prompts + 1 compaction = 3 executions);
 *   - automatic compaction happens *inside* a running execution → +0
 *     (C1: 1 prompt + auto compaction = 1 execution);
 *   - a background job notification that arrives after the parent's drain
 *     opens a new execution → +1 on the parent (B3/B4/B5 = 2; B1/B2 = 1,
 *     where the notification was folded into the running drain);
 *   - 46 inbox items produced 44 executions: items that arrive during a drain
 *     are folded into it (B1/B2), so neither prompts nor inbox items are the
 *     counted unit.
 *
 * A child session's executions are keyed by the child's own `sessionID`
 * (13/13 children carry one). The event does **not** carry `parentID`
 * (44/44), so this adapter never derives a parent; attribution, when a caller
 * needs it, comes from `session.created.parentID` or `ctx.session.get`
 * (PROBE-D §4.1).
 *
 * ## Fail-closed
 *
 * A payload without a usable `data.sessionID`, a payload of another type, and
 * a malformed payload all produce **no decision** with a reason token. Nothing
 * is guessed from `properties`, from a top-level field, or from a partial
 * shape, and nothing is thrown into the dispatch loop.
 *
 * ## No effect
 *
 * The flag is OFF by default (`PANTHEON_V2_P7_LOOP`), so the plugin wiring is
 * inert. Even when enabled, this adapter only observes and records: the shadow
 * record says `effect: 'none'`, and activation is Phase 4b, not this module.
 * `execute.before` remains the only hard barrier.
 *
 * ## The execution cap is advisory
 *
 * `P7_LOOP_MAX_EXECUTIONS` is a declared convention, not an enforced limit.
 * `reset()` is caller-supplied, and no measured surface in the probed host
 * delivers a user-input signal to call it: nothing in this process clears a
 * streak, on any event. A long session therefore crosses the declared cap and
 * the decision becomes `loop.stop` — which, with `effect: 'none'`, changes
 * nothing the host does. The cap is not claimed to reset on any event; it
 * resets only when a caller invokes `reset(sessionID)` explicitly.
 */

import {
  consumeDecisionEvents,
  type DecisionEvent,
  type DecisionEventSource,
  type EventConsumptionOptions,
  type EventConsumptionSummary,
  P7_TURN_END_EVENT_TYPE,
  readEventSessionID,
} from '../v2-decision-events.ts'
import { observeShadow, type ShadowRecord, type ShadowSink } from '../v2-decision-shadow.ts'

/** On/off switch read by the plugin wiring. Any other value means off. */
export const P7_LOOP_FLAG_ENV = 'PANTHEON_V2_P7_LOOP'

/** Execution counts at which the ordinal loop-pressure score rises. */
export const P7_LOOP_SCORE_THRESHOLDS = Object.freeze([2, 4] as const)

/** Declared, advisory cap: past this many executions the adapter reports `loop.stop`. */
export const P7_LOOP_MAX_EXECUTIONS = 12

/**
 * The adapter's own policy — declared, frozen and never measured.
 *
 * `score` is `1 + thresholds met`, so it rises with consecutive executions and
 * saturates at 3. `noul` permits a continuation up to the cap; past it, the
 * declared answer is to stop. This is a deterministic convention, not a claim
 * about loop quality, and the cap is **advisory**: `reset()` is caller-supplied
 * and no measured surface in the probed host provides a user-input signal, so
 * nothing in this process resets a streak. See the module header.
 */
export const P7_LOOP_POLICY = Object.freeze({
  scoreThresholds: P7_LOOP_SCORE_THRESHOLDS,
  maxExecutions: P7_LOOP_MAX_EXECUTIONS,
})

/** `noul` + `score` over the per-session execution count. */
export interface P7LoopDecision {
  /** `noul`: 1 permits a continuation, 0 stops at the declared cap. */
  readonly continueLoop: 0 | 1
  /** `score`: ordinal loop pressure, 1..3. */
  readonly level: 1 | 2 | 3
}

export interface P7LoopPointResult {
  /** `null` when disabled or when the payload yields no decision. */
  readonly record: ShadowRecord | null
  readonly enabled: boolean
  /** Child or top-level session id read from `data.sessionID`; never a parent. */
  readonly sessionID: string | null
  /** Executions delivered for this session; never a turn or inbox-item count. */
  readonly executionCount: number
  /** `null` when no decision could be stated (fail-closed). */
  readonly loopDecision: P7LoopDecision | null
  /** Token explaining the outcome; always present. */
  readonly reason: string
}

export interface P7LoopPointOptions {
  /** Defaults to `false`: the adapter is inert unless explicitly enabled. */
  readonly enabled?: boolean
  readonly sink?: ShadowSink
}

export interface P7LoopConsumeOptions {
  readonly signal: AbortSignal
  /** Upper bound so a harness run cannot consume an unbounded stream. */
  readonly maxEvents?: number
}

export interface P7LoopPoint {
  readonly enabled: boolean
  /** Observe one raw host envelope from a dispatch loop. Never throws. */
  observe(payload: unknown): P7LoopPointResult
  /** Consume a stream through the 0b contract, filtering client-side. */
  subscribe(
    source: DecisionEventSource,
    options: P7LoopConsumeOptions,
  ): Promise<EventConsumptionSummary>
  /** Executions recorded for a session since construction (or last reset). */
  executionCount(sessionID: string): number
  /** Clear one session's streak. Caller-supplied only — the cap is advisory. */
  reset(sessionID: string): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Whether the operator explicitly enabled the flag. Absence means off. */
export function p7LoopEnabledFromEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env[P7_LOOP_FLAG_ENV] ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'on' || raw === 'true'
}

function decisionFor(executionCount: number): P7LoopDecision {
  const met = P7_LOOP_SCORE_THRESHOLDS.filter((threshold) => executionCount >= threshold).length
  return Object.freeze({
    continueLoop: executionCount <= P7_LOOP_MAX_EXECUTIONS ? 1 : 0,
    level: Math.min(3, 1 + met) as 1 | 2 | 3,
  })
}

function noDecision(
  enabled: boolean,
  sessionID: string | null,
  executionCount: number,
  reason: string,
): P7LoopPointResult {
  return Object.freeze({
    record: null,
    enabled,
    sessionID,
    executionCount,
    loopDecision: null,
    reason,
  })
}

/**
 * Create a P7 adapter instance.
 *
 * State is per instance and per session: one counter per `sessionID`, never a
 * process-wide turn count. A child session is counted on its own id.
 */
export function createP7LoopPoint(options: P7LoopPointOptions = {}): P7LoopPoint {
  const enabled = options.enabled === true
  const executions = new Map<string, number>()

  function recordExecution(sessionID: string): P7LoopPointResult {
    if (!enabled) return noDecision(false, sessionID, 0, 'p7.disabled')

    const executionCount = (executions.get(sessionID) ?? 0) + 1
    executions.set(sessionID, executionCount)

    const record = observeShadow(
      'P7',
      { sessionID, executionCount },
      (isolated) => {
        const count =
          isRecord(isolated) && typeof isolated.executionCount === 'number'
            ? isolated.executionCount
            : 0
        const decision = decisionFor(count)
        return decision.continueLoop === 1
          ? { decision: 'loop.continue', reason: 'p7.execution.counted' }
          : { decision: 'loop.stop', reason: 'p7.execution.exhausted' }
      },
      options.sink,
    )

    const contained = record.decision === 'unavailable'
    return Object.freeze({
      record,
      enabled: true,
      sessionID,
      executionCount,
      loopDecision: contained ? null : decisionFor(executionCount),
      reason: record.reason,
    })
  }

  function observe(payload: unknown): P7LoopPointResult {
    if (!enabled) return noDecision(false, null, 0, 'p7.disabled')
    if (!isRecord(payload)) return noDecision(true, null, 0, 'p7.event.absent')
    if (typeof payload.type !== 'string') return noDecision(true, null, 0, 'p7.event.absent')
    if (payload.type !== P7_TURN_END_EVENT_TYPE) {
      return noDecision(true, null, 0, 'p7.event.unrelated')
    }
    const sessionID = readEventSessionID(payload)
    if (sessionID === null) return noDecision(true, null, 0, 'p7.session.absent')
    return recordExecution(sessionID)
  }

  async function subscribe(
    source: DecisionEventSource,
    consumeOptions: P7LoopConsumeOptions,
  ): Promise<EventConsumptionSummary> {
    const consumption: EventConsumptionOptions = {
      types: [P7_TURN_END_EVENT_TYPE],
      signal: consumeOptions.signal,
      onEvent: (event: DecisionEvent) => {
        if (event.type !== P7_TURN_END_EVENT_TYPE) return
        recordExecution(event.sessionID)
      },
      ...(consumeOptions.maxEvents === undefined ? {} : { maxEvents: consumeOptions.maxEvents }),
    }
    return consumeDecisionEvents(source, consumption)
  }

  return Object.freeze({
    enabled,
    observe,
    subscribe,
    executionCount(sessionID: string): number {
      return executions.get(sessionID) ?? 0
    },
    reset(sessionID: string): void {
      executions.delete(sessionID)
    },
  })
}
