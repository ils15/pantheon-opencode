/**
 * P9 (memory at compaction) shadow adapter — measured carrier only.
 *
 * Measured on the OpenCode 2.2.5 host (PROBE-A, §5.4):
 *
 *   - F-01: the compaction payload carries a **top-level `sessionID`** string.
 *     The nested `session` object is ABSENT; reading a nested session id would
 *     key the decision by a carrier this host never sends. This adapter reads
 *     `payload.sessionID` and nothing else as the session carrier.
 *   - F-02: text crosses in `payload.system` as an **array** of parts. Injection
 *     is a pushed part; the `system(string)` branch is dead on 2.2.5 and is
 *     never written here. A string carrier is a shape drift and is refused.
 *   - F-03: the summary is persisted as a `compaction` message and re-injected
 *     as a user checkpoint next turn, correlated by that message id. Correlation
 *     therefore comes from the caller, never from the payload.
 *   - F-04: manual and automatic compaction share the carrier; the automatic
 *     path simply carries fewer `messages`.
 *
 * Fail-closed: a missing or unusable top-level session id produces **no
 * decision at all** — no retention, no priority — because there is no key to
 * attribute it to. The same holds for an unusable `system` carrier and for an
 * absent memory source: nothing is guessed from a partial payload.
 *
 * Scope, stated so it cannot be over-read: the carrier is measured on
 * **top-level** sessions and on a **child** session. PROBE-G §3.1 spawned a real
 * child session and compacted it 3/3: the hook fires there, the payload carries
 * the child's `sessionID` at top level, and the shape is identical to the
 * top-level one (same 7 keys, no nested `session`, `system` an array of 4 parts),
 * so no child-specific branch is needed. `reason:"overflow"` remains UNKNOWN and
 * is deliberately not designed for: PROBE-G §3.2 could not induce it in 6 error
 * shapes — the host retried and completed, and the one failure-recovery
 * compaction observed was persisted as `reason:"auto"`. The checkpoint
 * summary/reinjection inside a child session was not exercised (PROBE-G §4.6),
 * and the `messages` channel was never exercised (PM-05), so this adapter does
 * not depend on it. Shadow: the decision is recorded and the record says
 * `effect: 'none'`.
 */

import { rankCandidates } from '../v2-decision-rank.ts'
import {
  observeShadow,
  type ShadowDecision,
  type ShadowRecord,
  type ShadowSink,
} from '../v2-decision-shadow.ts'

/** Score thresholds that raise priority to level 2 and level 3. */
export const COMPACTION_PRIORITY_THRESHOLDS = Object.freeze([0.5, 0.75] as const)

/**
 * The adapter's own retention policy — declared, frozen and never measured.
 *
 * `retainAbove: 0` means a candidate with a non-positive rank score is not
 * retained. Priority is `1 + thresholds met by the top retained score`, so the
 * level rises with support and never falls when a candidate is added. This is
 * a deterministic convention, not a claim about memory quality, and in shadow
 * it changes nothing.
 */
export const COMPACTION_RETENTION_POLICY = Object.freeze({
  retainAbove: 0,
  priorityThresholds: COMPACTION_PRIORITY_THRESHOLDS,
})

export interface CompactionMemoryDecision {
  /** `noul`: 1 retain, 0 discard. */
  readonly retain: 0 | 1
  /** `score`: ordinal priority 1–3, or `null` when nothing is retained. */
  readonly priority: 1 | 2 | 3 | null
  /** Retained ids in rank order; empty on discard. */
  readonly retainedIds: readonly string[]
}

export interface CompactionMemoryPointResult {
  readonly record: ShadowRecord
  /** Top-level session id (F-01), or `null` when it could not be read. */
  readonly sessionID: string | null
  /** The id this observation is keyed by — the top-level session id, never nested. */
  readonly decisionKey: string | null
  /** Number of `system` parts observed (F-02); `0` when the carrier was unusable. */
  readonly systemPartCount: number
  /** `null` when no decision could be stated (fail-closed). */
  readonly memoryDecision: CompactionMemoryDecision | null
  /** Caller-supplied `compaction` message id used to correlate the next turn (F-03). */
  readonly compactionMessageID: string | null
  /** Token explaining the decision; always present. */
  readonly reason: string
}

/** A single-line identifier: a control character would break any record line. */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

interface Value<T> {
  readonly ok: boolean
  readonly value: T | null
  readonly reason: string
}

function ok<T>(value: T): Value<T> {
  return { ok: true, value, reason: '' }
}

function fail<T>(reason: string): Value<T> {
  return { ok: false, value: null, reason }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUsableString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !hasControlCharacter(value)
}

/** Read the session carrier: top-level `sessionID` only (F-01). */
function readSessionID(payload: Record<string, unknown>): Value<string> {
  const candidate = payload.sessionID
  if (candidate === undefined || candidate === null) {
    return fail('compaction.session.absent')
  }
  if (!isUsableString(candidate)) return fail('compaction.session.invalid')
  return ok(candidate.trim())
}

/** Read the text carrier: an array of `{ type, text }` parts (F-02). */
function readSystem(payload: Record<string, unknown>): Value<number> {
  const system = payload.system
  if (system === undefined || system === null) return fail('compaction.system.absent')
  if (!Array.isArray(system)) return fail('compaction.system.unsupported')
  if (system.length === 0) return fail('compaction.system.empty')
  for (const part of system) {
    if (!isRecord(part) || typeof part.text !== 'string') {
      return fail('compaction.system.invalid')
    }
  }
  return ok(system.length)
}

/** Read the caller-supplied correlation id; a payload-carried id is not a source. */
function readCorrelation(input: Record<string, unknown>): string | null {
  return isUsableString(input.compactionMessageID) ? input.compactionMessageID.trim() : null
}

interface MemoryAnalysis {
  readonly decision: ShadowDecision
  readonly sessionID: string | null
  readonly systemPartCount: number
  readonly memoryDecision: CompactionMemoryDecision | null
  readonly compactionMessageID: string | null
}

function refusal(reason: string): MemoryAnalysis {
  return {
    decision: { decision: 'refusal', reason },
    sessionID: null,
    systemPartCount: 0,
    memoryDecision: null,
    compactionMessageID: null,
  }
}

/** Apply the declared retention policy to a non-empty ranked candidate list. */
function applyPolicy(ranked: readonly { id: string; score: number }[]): {
  decision: ShadowDecision
  memoryDecision: CompactionMemoryDecision
} {
  const retained = ranked.filter(
    (candidate) => candidate.score > COMPACTION_RETENTION_POLICY.retainAbove,
  )
  const top = retained[0]
  if (top === undefined) {
    return {
      decision: { decision: 'memory.discard', reason: 'compaction.memory.discarded' },
      memoryDecision: { retain: 0, priority: null, retainedIds: [] },
    }
  }
  const met = COMPACTION_PRIORITY_THRESHOLDS.filter((threshold) => top.score >= threshold).length
  const priority = Math.min(3, 1 + met) as 1 | 2 | 3
  return {
    decision: { decision: 'memory.retain', reason: 'compaction.memory.retained' },
    memoryDecision: {
      retain: 1,
      priority,
      retainedIds: retained.map((candidate) => candidate.id),
    },
  }
}

function analyze(input: unknown): MemoryAnalysis {
  if (!isRecord(input) || !isRecord(input.payload)) {
    return refusal('compaction.payload.absent')
  }
  const payload = input.payload

  const session = readSessionID(payload)
  if (!session.ok || session.value === null) {
    return refusal(session.reason || 'compaction.session.absent')
  }
  const sessionID = session.value

  const correlation = readCorrelation(input)
  const system = readSystem(payload)
  if (!system.ok || system.value === null) {
    return {
      decision: { decision: 'refusal', reason: system.reason },
      sessionID,
      systemPartCount: 0,
      memoryDecision: null,
      compactionMessageID: correlation,
    }
  }

  const candidates = input.candidates
  if (candidates === undefined || candidates === null) {
    return {
      decision: { decision: 'refusal', reason: 'compaction.memory.source.absent' },
      sessionID,
      systemPartCount: system.value,
      memoryDecision: null,
      compactionMessageID: correlation,
    }
  }
  if (!Array.isArray(candidates)) {
    return {
      decision: { decision: 'refusal', reason: 'compaction.memory.source.unsupported' },
      sessionID,
      systemPartCount: system.value,
      memoryDecision: null,
      compactionMessageID: correlation,
    }
  }
  if (candidates.length === 0) {
    return {
      decision: { decision: 'memory.discard', reason: 'compaction.memory.none' },
      sessionID,
      systemPartCount: system.value,
      memoryDecision: { retain: 0, priority: null, retainedIds: [] },
      compactionMessageID: correlation,
    }
  }

  const ranked = rankCandidates(candidates)
  if (!ranked.ok) {
    return {
      decision: {
        decision: 'refusal',
        reason: `memory.rank.${ranked.code.toLowerCase().split('_').join('.')}`,
      },
      sessionID,
      systemPartCount: system.value,
      memoryDecision: null,
      compactionMessageID: correlation,
    }
  }

  const applied = applyPolicy(ranked.ordered)
  return {
    decision: applied.decision,
    sessionID,
    systemPartCount: system.value,
    memoryDecision: applied.memoryDecision,
    compactionMessageID: correlation,
  }
}

/**
 * Observe P9 in shadow.
 *
 * @param input `{ payload, candidates?, compactionMessageID? }` — the compaction
 *              payload is observed, never written; nothing is pushed into it.
 * @param sink  Optional shadow-record observer.
 */
export function evaluateCompactionMemoryPoint(
  input: unknown,
  sink?: ShadowSink,
): CompactionMemoryPointResult {
  let analysis: MemoryAnalysis = refusal('compaction.payload.absent')
  const record = observeShadow(
    'P9',
    input,
    (isolated) => {
      analysis = analyze(isolated)
      return analysis.decision
    },
    sink,
  )

  const contained = record.decision === 'unavailable'
  const sessionID = contained ? null : analysis.sessionID
  return {
    record,
    sessionID,
    decisionKey: sessionID,
    systemPartCount: contained ? 0 : analysis.systemPartCount,
    memoryDecision: contained ? null : analysis.memoryDecision,
    compactionMessageID: contained ? null : analysis.compactionMessageID,
    reason: record.reason,
  }
}
