/**
 * V2 event-consumption contract — the only shape P7 and future event consumers
 * may use (PLAN §5.2).
 *
 * Measured facts this module is built on:
 *
 *   - F-11: `ctx.event.subscribe` takes ONE argument and returns an async
 *     iterable. A callback passed as an argument is never invoked (0/4 runs),
 *     and a type argument does not filter on the server.
 *   - F-13: the envelope is `{ id, created, type, durable, location?, data }`;
 *     `data.sessionID` is the session carrier for `session.*` types.
 *
 * Therefore:
 *
 *   1. `subscribe({ signal })` is called with exactly one argument and the
 *      result is consumed with `for await`.
 *   2. Type filtering happens here, on `event.type`, not on the host.
 *   3. The session id is read from `event.data.sessionID` and nowhere else.
 *      The unmetered legacy envelope field is never read.
 *   4. Consumption ends through `AbortSignal`; there is no dispose handle.
 *   5. The measured host is 2.2.5. Absence of `session.idle` and
 *      `session.compacted` there is not a claim about other host versions.
 */

export const P7_TURN_END_EVENT_TYPE = 'session.execution.succeeded'

export interface HostEventEnvelope {
  readonly id?: unknown
  readonly created?: unknown
  readonly type?: unknown
  readonly durable?: unknown
  readonly location?: unknown
  readonly data?: unknown
}

export interface EventSubscribeOptions {
  readonly signal: AbortSignal
}

export interface DecisionEventSource {
  subscribe(options: EventSubscribeOptions): AsyncIterable<HostEventEnvelope>
}

export interface DecisionEvent {
  readonly type: string
  readonly sessionID: string
}

export type EventConsumptionFailure = 'SUBSCRIBE_FAILED' | 'STREAM_FAILED'

export interface EventConsumptionOptions {
  /** Event types the consumer cares about. Filtering is client-side. */
  readonly types: readonly string[]
  readonly signal: AbortSignal
  readonly onEvent: (event: DecisionEvent) => void
  /** Upper bound so a harness run cannot consume an unbounded stream. */
  readonly maxEvents?: number
}

export interface EventConsumptionSummary {
  readonly delivered: number
  readonly matched: number
  readonly skippedType: number
  readonly skippedMissingSession: number
  readonly handlerErrors: number
  readonly aborted: boolean
  readonly failure: EventConsumptionFailure | null
}

const DEFAULT_MAX_EVENTS = 10_000
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function emptySummary(overrides: Partial<EventConsumptionSummary> = {}): EventConsumptionSummary {
  return {
    delivered: 0,
    matched: 0,
    skippedType: 0,
    skippedMissingSession: 0,
    handlerErrors: 0,
    aborted: false,
    failure: null,
    ...overrides,
  }
}

/**
 * Read the measured carrier only: `data.sessionID`.
 *
 * This function deliberately touches two properties (`data`, `data.sessionID`);
 * a test wraps the envelope in a proxy whose other fields throw, proving the
 * legacy field is never read.
 */
export function readEventSessionID(envelope: unknown): string | null {
  if (!isRecord(envelope)) return null
  const data = envelope.data
  if (!isRecord(data)) return null
  const sessionID = data.sessionID
  if (typeof sessionID !== 'string') return null
  const trimmed = sessionID.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * Consume an event stream under the contract above.
 *
 * The returned summary is diagnostic only; nothing in it changes admission.
 * A missing session carrier is counted, never guessed.
 */
export async function consumeDecisionEvents(
  source: DecisionEventSource,
  options: EventConsumptionOptions,
): Promise<EventConsumptionSummary> {
  const signal = options.signal
  if (signal.aborted) return emptySummary({ aborted: true })

  const wanted = new Set(options.types.filter((type) => TOKEN.test(type)))
  const maxEvents =
    options.maxEvents !== undefined && Number.isInteger(options.maxEvents) && options.maxEvents > 0
      ? options.maxEvents
      : DEFAULT_MAX_EVENTS

  let stream: AsyncIterable<HostEventEnvelope>
  try {
    stream = source.subscribe({ signal })
  } catch {
    return emptySummary({ failure: 'SUBSCRIBE_FAILED' })
  }

  let delivered = 0
  let matched = 0
  let skippedType = 0
  let skippedMissingSession = 0
  let handlerErrors = 0
  let aborted = false
  let failure: EventConsumptionFailure | null = null

  try {
    for await (const envelope of stream) {
      if (signal.aborted) {
        aborted = true
        break
      }
      delivered += 1
      const type = isRecord(envelope) ? envelope.type : undefined
      if (typeof type !== 'string' || !wanted.has(type)) {
        skippedType += 1
      } else {
        const sessionID = readEventSessionID(envelope)
        if (sessionID === null) {
          skippedMissingSession += 1
        } else {
          matched += 1
          try {
            options.onEvent(Object.freeze({ type, sessionID }))
          } catch {
            handlerErrors += 1
          }
        }
      }
      if (delivered >= maxEvents) break
    }
  } catch {
    if (signal.aborted) aborted = true
    else failure = 'STREAM_FAILED'
  }

  return emptySummary({
    delivered,
    matched,
    skippedType,
    skippedMissingSession,
    handlerErrors,
    aborted,
    failure,
  })
}
