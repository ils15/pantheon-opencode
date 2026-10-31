/**
 * P4 (memory) shadow adapter — `rank` over memory candidates.
 *
 * P4 sits on the measured carrier (`src/pantheon` memory reaches the model
 * through the `system` array, F-02, and survives compaction as a checkpoint,
 * F-03). The *candidate source* itself was not measured, so this adapter does
 * not reshape it: it consumes the shared `rank` contract unchanged and refuses
 * when the source is absent or does not already satisfy that contract. A
 * missing justification is never invented, and an absent source is never
 * treated as an empty ranking.
 *
 * Shadow by construction: `observeShadow` clones and freezes the source, the
 * record always says `effect: 'none'`, and no failure — including an unclonable
 * source — is rethrown into admission.
 */

import { type RankFailure, rankCandidates } from '../v2-decision-rank.ts'
import {
  observeShadow,
  type ShadowDecision,
  type ShadowRecord,
  type ShadowSink,
} from '../v2-decision-shadow.ts'

export type MemorySource = 'candidates' | 'none'

export interface MemoryPointResult {
  readonly record: ShadowRecord
  /** `candidates` when the source was a candidate array, `none` otherwise. */
  readonly memorySource: MemorySource
  /** Deterministic ranked ids; empty on every failure. */
  readonly rankedMemoryIds: readonly string[]
  /** Token explaining the decision; always present. */
  readonly reason: string
}

/**
 * Retrieval comparison record for PLAN Phase 2.
 *
 * BM25 stays the baseline. The embeddings arm is **NOT RUN**: this task has no
 * embedding provider and no network, and hand-authored vectors would measure
 * the fixture rather than an embedding model. No number is reported here and no
 * adoption decision is claimed; promoting embeddings requires a measured
 * comparison, not this record.
 */
export const MEMORY_RETRIEVAL_COMPARISON = Object.freeze({
  baseline: 'bm25',
  embeddings: 'not_run',
  reason:
    'offline: no embedding model available; synthetic vectors would measure the fixture, not embeddings',
} as const)

interface MemoryDecision {
  readonly decision: ShadowDecision
  readonly source: MemorySource
  readonly ids: readonly string[]
}

/** Contract failure codes are uppercase; record tokens are lower-case dotted. */
function tokenOf(code: RankFailure): string {
  return code.toLowerCase().split('_').join('.')
}

/**
 * Classify one observed source.
 *
 * The array is passed through to `rankCandidates` untouched: what the rank
 * contract rejects is reported, never repaired.
 */
function classifyMemorySource(source: unknown): MemoryDecision {
  if (source === undefined || source === null) {
    return {
      decision: { decision: 'refusal', reason: 'memory.source.absent' },
      source: 'none',
      ids: [],
    }
  }
  if (!Array.isArray(source)) {
    return {
      decision: { decision: 'refusal', reason: 'memory.source.unsupported' },
      source: 'none',
      ids: [],
    }
  }
  if (source.length === 0) {
    return {
      decision: { decision: 'refusal', reason: 'memory.source.empty' },
      source: 'candidates',
      ids: [],
    }
  }
  const ranked = rankCandidates(source)
  if (!ranked.ok) {
    return {
      decision: { decision: 'refusal', reason: `memory.rank.${tokenOf(ranked.code)}` },
      source: 'candidates',
      ids: [],
    }
  }
  return {
    decision: { decision: 'rank', reason: 'memory.ranked' },
    source: 'candidates',
    ids: ranked.ordered.map((candidate) => candidate.id),
  }
}

/**
 * Observe P4 in shadow.
 *
 * @param source Memory candidate source. Never mutated.
 * @param sink   Optional shadow-record observer.
 */
export function evaluateMemoryPoint(source: unknown, sink?: ShadowSink): MemoryPointResult {
  let observed: MemoryDecision = {
    decision: { decision: 'refusal', reason: 'memory.source.absent' },
    source: 'none',
    ids: [],
  }
  const record = observeShadow(
    'P4',
    source,
    (isolated) => {
      const classified = classifyMemorySource(isolated)
      observed = classified
      return classified.decision
    },
    sink,
  )

  const failed = record.decision === 'unavailable'
  return {
    record,
    memorySource: failed ? 'none' : observed.source,
    rankedMemoryIds: failed ? [] : observed.ids,
    reason: record.reason,
  }
}
