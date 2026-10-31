/**
 * V2 decision heuristic — evidence counting with refusal as a first-class outcome.
 *
 * The heuristic emits no scalar certainty field. Its only inputs are candidate
 * ids and the evidence ids attached to each candidate, and its only outputs are
 * a unique choice or a refusal. This is intentional: a scalar would let a later
 * adapter treat a guess as authorisation.
 *
 * A refusal is a success, not an error:
 *
 *   - `NO_CANDIDATES`    — nothing to choose from.
 *   - `INSUFFICIENT_EVIDENCE` — the best candidate cites less evidence than the
 *     caller requires.
 *   - `TIE`              — two or more candidates cite the same maximum amount;
 *     the heuristic refuses instead of inventing a tie-break.
 *   - `INVALID_INPUT`    — the request does not match the contract.
 *
 * Duplicate evidence ids inside one candidate are counted once, so repeating an
 * id cannot manufacture support.
 */

export interface HeuristicCandidate {
  readonly id: string
  readonly evidence: readonly string[]
}

export interface HeuristicRequest {
  readonly candidates: readonly HeuristicCandidate[]
  readonly minimumEvidence?: number
}

export type HeuristicRefusalReason =
  | 'NO_CANDIDATES'
  | 'INSUFFICIENT_EVIDENCE'
  | 'TIE'
  | 'INVALID_INPUT'

export type HeuristicOutcome =
  | {
      readonly kind: 'choice'
      readonly candidateId: string
      readonly evidenceCount: number
      readonly reasonCode: 'UNIQUE_MAX_EVIDENCE'
    }
  | {
      readonly kind: 'refusal'
      readonly reasonCode: HeuristicRefusalReason
      readonly candidateIds: readonly string[]
    }

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const DEFAULT_MINIMUM_EVIDENCE = 1

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN.test(value)
}

function refusal(
  reasonCode: HeuristicRefusalReason,
  candidateIds: readonly string[] = [],
): HeuristicOutcome {
  return Object.freeze({
    kind: 'refusal',
    reasonCode,
    candidateIds: Object.freeze([...candidateIds].sort()),
  })
}

/**
 * Decide from evidence counts alone.
 *
 * The comparison is exact and total: highest unique evidence count wins, ties
 * refuse, and a winner below `minimumEvidence` refuses.
 */
export function decideHeuristic(request: unknown): HeuristicOutcome {
  if (!isRecord(request)) return refusal('INVALID_INPUT')
  const candidates = request.candidates
  if (!Array.isArray(candidates)) return refusal('INVALID_INPUT')
  if (candidates.length === 0) return refusal('NO_CANDIDATES')

  const minimum = request.minimumEvidence ?? DEFAULT_MINIMUM_EVIDENCE
  if (!Number.isInteger(minimum) || (minimum as number) < 1 || (minimum as number) > 100) {
    return refusal('INVALID_INPUT')
  }

  const counts = new Map<string, number>()
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !isToken(candidate.id)) return refusal('INVALID_INPUT')
    if (counts.has(candidate.id)) return refusal('INVALID_INPUT')
    const evidence = candidate.evidence
    if (!Array.isArray(evidence)) return refusal('INVALID_INPUT')
    const unique = new Set<string>()
    for (const id of evidence) {
      if (!isToken(id)) return refusal('INVALID_INPUT')
      unique.add(id)
    }
    counts.set(candidate.id, unique.size)
  }

  let best = 0
  for (const count of counts.values()) {
    if (count > best) best = count
  }
  const top = [...counts.entries()].filter(([, count]) => count === best).map(([id]) => id)

  if (best < (minimum as number)) return refusal('INSUFFICIENT_EVIDENCE', top)
  if (top.length > 1) return refusal('TIE', top)

  const [candidateId] = top
  if (candidateId === undefined) return refusal('NO_CANDIDATES')
  return Object.freeze({
    kind: 'choice',
    candidateId,
    evidenceCount: best,
    reasonCode: 'UNIQUE_MAX_EVIDENCE',
  })
}
