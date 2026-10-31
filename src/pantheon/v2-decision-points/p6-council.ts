/**
 * P6 (council) shadow adapter — `rank` + `score` over council candidates.
 *
 * Ranking is the shared deterministic contract: score descending, id ascending,
 * a justification per candidate. The `score` question is a real validated
 * `ask.score` over the top-ranked candidate, built with at most
 * {@link COUNCIL_SCORE_LEVELS} ordinal levels. Shadow has no responder, so an
 * unanswered question is recorded as `council.no.answer` rather than being
 * filled with a fabricated level; a supplied answer is resolved through the
 * shared contract and still changes nothing.
 *
 * What was measured is the prompt payload **shape** and the presence of the
 * candidate surface (F-08); a populated `prompt.agents` was never observed
 * (PM-07), so this adapter never reads the admission payload and never claims
 * that a council ran. It consumes candidates a caller already has.
 */

import { evaluateAskAnswer, type ScoreQuestion, validateAsk } from '../v2-decision-contracts.ts'
import { rankCandidates } from '../v2-decision-rank.ts'
import {
  observeShadow,
  type ShadowDecision,
  type ShadowRecord,
  type ShadowSink,
} from '../v2-decision-shadow.ts'

/** Ordinal levels of the council score question (2..10 is the contract range). */
export const COUNCIL_SCORE_LEVELS = 5

const QUESTION_TEXT = 'Rate the priority of the top-ranked council candidate.'

export type CouncilSource = 'candidates' | 'none'

export interface CouncilPointResult {
  readonly record: ShadowRecord
  /** `candidates` when a candidate array was observed, `none` otherwise. */
  readonly councilSource: CouncilSource
  /** Ranked ids, best first; empty on every failure. */
  readonly rankedIds: readonly string[]
  /** The validated score question, or `null` when none could be built. */
  readonly question: ScoreQuestion | null
  /** Resolved ordinal level, or `null` when no valid answer was supplied. */
  readonly score: number | null
  /** Token explaining the decision; always present. */
  readonly reason: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Contract failure codes are uppercase; record tokens are lower-case dotted. */
function tokenOf(code: string): string {
  return code.toLowerCase().split('_').join('.')
}

interface CouncilAnalysis {
  readonly decision: ShadowDecision
  readonly source: CouncilSource
  readonly ids: readonly string[]
  readonly question: ScoreQuestion | null
  readonly score: number | null
}

function refusal(reason: string, source: CouncilSource = 'none'): CouncilAnalysis {
  return {
    decision: { decision: 'refusal', reason },
    source,
    ids: [],
    question: null,
    score: null,
  }
}

function analyze(input: unknown): CouncilAnalysis {
  const candidates = isRecord(input) ? input.candidates : undefined
  if (candidates === undefined || candidates === null) {
    return refusal('council.source.absent')
  }
  if (!Array.isArray(candidates)) return refusal('council.source.unsupported')
  if (candidates.length === 0) return refusal('council.source.empty', 'candidates')

  const ranked = rankCandidates(candidates)
  if (!ranked.ok) return refusal(`council.rank.${tokenOf(ranked.code)}`, 'candidates')

  const requestedLevels = isRecord(input) ? input.levels : undefined
  const levels = requestedLevels === undefined ? COUNCIL_SCORE_LEVELS : requestedLevels
  const validated = validateAsk({
    mode: 'score',
    id: 'p6.council',
    text: QUESTION_TEXT,
    levels,
  })
  if (!validated.ok) {
    return refusal(`council.question.${tokenOf(validated.code)}`, 'candidates')
  }
  const question = validated.question as ScoreQuestion
  const ids = ranked.ordered.map((candidate) => candidate.id)

  const answer = isRecord(input) ? input.answer : undefined
  if (answer === undefined) {
    // Shadow has no responder. Recording the ranked order is the observation;
    // no level is invented for the unanswered question.
    return {
      decision: { decision: 'rank', reason: 'council.no.answer' },
      source: 'candidates',
      ids,
      question,
      score: null,
    }
  }
  const resolution = evaluateAskAnswer(question, answer)
  if (resolution.status === 'score') {
    return {
      decision: { decision: 'score', reason: 'council.score.resolved' },
      source: 'candidates',
      ids,
      question,
      score: resolution.level,
    }
  }
  return {
    decision: {
      decision: 'refusal',
      reason: resolution.status === 'refusal' ? 'council.score.refused' : 'council.score.failed',
    },
    source: 'candidates',
    ids,
    question,
    score: null,
  }
}

/**
 * Observe P6 in shadow.
 *
 * @param input `{ candidates, levels?, answer? }`. Candidates are never mutated.
 * @param sink  Optional shadow-record observer.
 */
export function evaluateCouncilPoint(input: unknown, sink?: ShadowSink): CouncilPointResult {
  let analysis: CouncilAnalysis = refusal('council.source.absent')
  const record = observeShadow(
    'P6',
    input,
    (isolated) => {
      analysis = analyze(isolated)
      return analysis.decision
    },
    sink,
  )

  const contained = record.decision === 'unavailable'
  return {
    record,
    councilSource: contained ? 'none' : analysis.source,
    rankedIds: contained ? [] : analysis.ids,
    question: contained ? null : analysis.question,
    score: contained ? null : analysis.score,
    reason: record.reason,
  }
}
