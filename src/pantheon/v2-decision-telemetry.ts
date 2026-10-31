/**
 * V2 decision telemetry — allowlist sanitisation, closing defect D10.
 *
 * Telemetry must never carry prompt, response, user content, credentials or
 * free-form text. The strongest way to guarantee that is not to scrub known
 * keys but to accept only a small allowlist whose values are constrained to
 * short tokens and bounded numbers:
 *
 *   schemaVersion, point, decision, effect, reason, mode, durationMs, candidateCount
 *
 * Any other key is dropped and only a count is reported. Neither the key nor
 * its value is ever copied into the result, so no attacker-controlled string
 * reaches telemetry through a rejection path.
 *
 * `effect` is fixed to `'none'`. An event that claims anything else is rejected
 * outright: this layer has no measured effect to report, and silently rewriting
 * the claim would hide the caller's error.
 *
 * The sink is in-memory and bounded. It performs no I/O, so the offline harness
 * can assert exactly what would be emitted.
 */

import type { DecisionPointId } from './v2-decision-registry.ts'

export const TELEMETRY_SCHEMA_VERSION = 1
export const TELEMETRY_FIELDS = [
  'schemaVersion',
  'point',
  'decision',
  'effect',
  'reason',
  'mode',
  'durationMs',
  'candidateCount',
] as const

export type TelemetryField = (typeof TELEMETRY_FIELDS)[number]
export type TelemetryMode = 'shadow' | 'active' | 'off' | 'migration'

export interface DecisionTelemetryEvent {
  readonly schemaVersion: typeof TELEMETRY_SCHEMA_VERSION
  readonly point: DecisionPointId
  readonly decision: string
  readonly effect: 'none'
  readonly reason: string
  readonly mode?: TelemetryMode
  readonly durationMs?: number
  readonly candidateCount?: number
}

export type TelemetryRejection = 'INVALID_INPUT' | 'MISSING_REQUIRED_FIELD' | 'EFFECT_NOT_MEASURED'

export type TelemetryResult =
  | {
      readonly ok: true
      readonly event: DecisionTelemetryEvent
      readonly droppedFieldCount: number
    }
  | {
      readonly ok: false
      readonly reasonCode: TelemetryRejection
      readonly droppedFieldCount: number
    }

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const POINT_ID = /^P(?:[1-9]|1[01])$/
const TELEMETRY_KEYS: ReadonlySet<string> = new Set(TELEMETRY_FIELDS)
const MODES: ReadonlySet<string> = new Set(['shadow', 'active', 'off', 'migration'])
const DURATION_MAX_MS = 60_000
const CANDIDATE_MAX = 10_000
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value)
}

function isPointId(value: unknown): value is DecisionPointId {
  return typeof value === 'string' && POINT_ID.test(value)
}

function rejected(reasonCode: TelemetryRejection, droppedFieldCount: number): TelemetryResult {
  return { ok: false, reasonCode, droppedFieldCount }
}

/**
 * Reduce an arbitrary record to the telemetry allowlist.
 *
 * Required survivors: `point`, `decision` and `reason`. `effect`, when present,
 * must already be `'none'`; the output always carries `'none'`.
 */
export function sanitizeTelemetry(input: unknown): TelemetryResult {
  if (!isRecord(input)) return rejected('INVALID_INPUT', 0)

  let droppedFieldCount = 0
  const drop = (): void => {
    droppedFieldCount += 1
  }

  let point: DecisionPointId | null = null
  let decision: string | null = null
  let reason: string | null = null
  let mode: TelemetryMode | null = null
  let durationMs: number | null = null
  let candidateCount: number | null = null
  let effectNotMeasured = false

  for (const key of Object.keys(input).sort()) {
    const value = input[key]
    if (!TELEMETRY_KEYS.has(key)) {
      drop()
      continue
    }
    switch (key) {
      case 'schemaVersion':
        if (value !== TELEMETRY_SCHEMA_VERSION) drop()
        break
      case 'point':
        if (isPointId(value)) point = value
        else drop()
        break
      case 'decision':
        if (isToken(value)) decision = value
        else drop()
        break
      case 'reason':
        if (isToken(value)) reason = value
        else drop()
        break
      case 'mode':
        if (typeof value === 'string' && MODES.has(value)) {
          mode = value as TelemetryMode
        } else {
          drop()
        }
        break
      case 'durationMs':
        if (
          typeof value === 'number' &&
          Number.isFinite(value) &&
          value >= 0 &&
          value <= DURATION_MAX_MS
        ) {
          durationMs = value
        } else {
          drop()
        }
        break
      case 'candidateCount':
        if (
          Number.isInteger(value) &&
          (value as number) >= 0 &&
          (value as number) <= CANDIDATE_MAX
        ) {
          candidateCount = value as number
        } else {
          drop()
        }
        break
      case 'effect':
        if (value === 'none') break
        effectNotMeasured = true
        drop()
        break
      default:
        drop()
    }
  }

  if (effectNotMeasured) return rejected('EFFECT_NOT_MEASURED', droppedFieldCount)
  if (point === null || decision === null || reason === null) {
    return rejected('MISSING_REQUIRED_FIELD', droppedFieldCount)
  }

  const event: DecisionTelemetryEvent = {
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    point,
    decision,
    effect: 'none',
    reason,
    ...(mode !== null ? { mode } : {}),
    ...(durationMs !== null ? { durationMs } : {}),
    ...(candidateCount !== null ? { candidateCount } : {}),
  }
  return { ok: true, event: Object.freeze(event), droppedFieldCount }
}

/** In-memory, bounded telemetry collector. No I/O, no network. */
export interface TelemetrySink {
  emit(input: unknown): TelemetryResult
  events(): readonly DecisionTelemetryEvent[]
  size(): number
}

export function createTelemetrySink(maxEvents = 1_000): TelemetrySink {
  if (!Number.isInteger(maxEvents) || maxEvents < 0 || maxEvents > 100_000) {
    throw new RangeError('maxEvents must be an integer in 0..100000')
  }
  const collected: DecisionTelemetryEvent[] = []
  return {
    emit(input: unknown) {
      const result = sanitizeTelemetry(input)
      if (result.ok && collected.length < maxEvents) collected.push(result.event)
      return result
    },
    events() {
      return Object.freeze([...collected])
    },
    size() {
      return collected.length
    },
  }
}
