/**
 * V2 ranking contract — deterministic order with per-item justification.
 *
 * Score descending, then id ascending, so the same candidates always produce
 * the same order. The output is plain JSON-serialisable data.
 */

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

export interface RankCandidate {
  readonly id: string
  readonly score: number
  readonly justification: string
}

export interface RankedCandidate extends RankCandidate {
  readonly rank: number
}

export type RankFailure =
  | 'NO_CANDIDATES'
  | 'INVALID_SHAPE'
  | 'DUPLICATE_ID'
  | 'INVALID_ID'
  | 'INVALID_SCORE'
  | 'MISSING_JUSTIFICATION'

export type RankResult =
  | { readonly ok: true; readonly ordered: readonly RankedCandidate[] }
  | { readonly ok: false; readonly code: RankFailure; readonly detail: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value)
}

/**
 * Rank candidates deterministically: score descending, then id ascending.
 * Every candidate carries its own justification; ties are stable and therefore
 * replayable by the harness.
 */
export function rankCandidates(candidates: unknown): RankResult {
  if (!Array.isArray(candidates)) {
    return { ok: false, code: 'INVALID_SHAPE', detail: 'candidates must be an array' }
  }
  if (candidates.length === 0) {
    return { ok: false, code: 'NO_CANDIDATES', detail: 'at least one candidate is required' }
  }
  const ids = new Set<string>()
  const valid: RankCandidate[] = []
  for (const candidate of candidates) {
    if (!isRecord(candidate)) {
      return { ok: false, code: 'INVALID_SHAPE', detail: 'candidate must be an object' }
    }
    if (!isToken(candidate.id)) {
      return { ok: false, code: 'INVALID_ID', detail: 'candidate id must be a short token' }
    }
    if (ids.has(candidate.id)) {
      return { ok: false, code: 'DUPLICATE_ID', detail: 'candidate ids must be unique' }
    }
    ids.add(candidate.id)
    if (typeof candidate.score !== 'number' || !Number.isFinite(candidate.score)) {
      return { ok: false, code: 'INVALID_SCORE', detail: 'score must be a finite number' }
    }
    if (!isNonEmptyString(candidate.justification)) {
      return {
        ok: false,
        code: 'MISSING_JUSTIFICATION',
        detail: 'every candidate needs a justification',
      }
    }
    valid.push({
      id: candidate.id,
      score: candidate.score,
      justification: candidate.justification,
    })
  }
  const sorted = [...valid].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
  const ordered = sorted.map((candidate, index) => ({ ...candidate, rank: index + 1 }))
  return { ok: true, ordered: Object.freeze(ordered) }
}
