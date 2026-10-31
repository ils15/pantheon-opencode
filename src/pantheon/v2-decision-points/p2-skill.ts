/**
 * P2 (skill) shadow adapter.
 *
 * P2a reports *where* the skill list came from — the prompt payload or the
 * per-turn draft (`ctx.skill.list()`, F-06) — and refuses with an explicit
 * reason when neither source is usable. It reports only: P2 is an empirical
 * no-op on the default path (F-09, PRE-02), and effective narrowing (P2b) is
 * conditional on C6 and is not implemented here.
 *
 * Shadow by construction: the admission payload is cloned and frozen by
 * `observeShadow`, the record always says `effect: 'none'`, and no failure is
 * rethrown into admission.
 */

import { resolveSkillSource, type SkillsSource } from '../local-decision-prompt.ts'
import { rankCandidates } from '../v2-decision-rank.ts'
import {
  observeShadow,
  type ShadowDecision,
  type ShadowRecord,
  type ShadowSink,
} from '../v2-decision-shadow.ts'

export interface SkillPointResult {
  readonly record: ShadowRecord
  /** Which source produced the observed list: the prompt, the draft, or none. */
  readonly skillsSource: SkillsSource
  /** Token explaining the decision; always present. */
  readonly reason: string
  /** Deterministic order of the observed source list; empty when there is none. */
  readonly rankedSkillIds: readonly string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read `prompt.skills` from an admission payload without normalizing it. */
function promptSkills(admission: unknown): unknown {
  if (!isRecord(admission)) return undefined
  const prompt = admission.prompt
  return isRecord(prompt) ? prompt.skills : undefined
}

/**
 * Observe P2 in shadow.
 *
 * @param admission  Host admission payload (never mutated).
 * @param sink       Optional shadow-record observer.
 * @param draftSkills Optional per-turn draft list; observed, never applied.
 */
export function evaluateSkillPoint(
  admission: unknown,
  sink?: ShadowSink,
  draftSkills?: unknown,
): SkillPointResult {
  const resolution = resolveSkillSource(promptSkills(admission), draftSkills)
  let rankedSkillIds: readonly string[] = []
  let decision: ShadowDecision = { decision: 'refusal', reason: resolution.reason }

  if (resolution.skillIds.length > 0) {
    const ranked = rankCandidates(
      resolution.skillIds.map((id) => ({
        id,
        score: 1,
        justification: `source.${resolution.skillsSource}`,
      })),
    )
    if (ranked.ok) {
      rankedSkillIds = ranked.ordered.map((candidate) => candidate.id)
      decision = { decision: 'rank', reason: `rank.source.${resolution.skillsSource}` }
    }
  }

  const record = observeShadow('P2', admission, () => decision, sink)
  return {
    record,
    skillsSource: resolution.skillsSource,
    reason: decision.reason,
    rankedSkillIds,
  }
}
