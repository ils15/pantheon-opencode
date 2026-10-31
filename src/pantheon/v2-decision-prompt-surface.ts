/**
 * Prompt-surface shadow wiring — P1, P2, P3, P6 and P10 share one hook payload.
 *
 * All five read the same admission event at `session.hook('prompt')`. This
 * module constructs each adapter once per invocation and hands it a projection
 * of the payload that contains **only** `prompt.agents` and `prompt.skills`:
 *
 *   - prompt text, files and metadata never enter shadow, so no content can
 *     reach a shadow record or telemetry;
 *   - cloning a prompt-sized payload five times per turn would be a cost this
 *     no-op must not impose, and the invariant is "no delay".
 *
 * Shadow is a no-op by construction: `observeShadow` clones and freezes the
 * projection, every record says `effect: 'none'`, and no failure — adapter,
 * projection or sink — is rethrown into the hook. Nothing here mutates
 * admission; in particular P2 stays advisory and the projection carries no
 * draft list, so it can neither filter skills nor claim to.
 *
 * Some adapters have no input on this surface (P3 wants a complexity vector,
 * P6 council candidates, P10 counsellor claims). They are invoked with the same
 * projection and record their own refusal token — `complexity.invalid`,
 * `council.source.absent`, `claims.absent`. No input is fabricated to make a
 * record look like a decision.
 */

import type { SkillsSource } from './local-decision-prompt.ts'
import { evaluateAgentPoint } from './v2-decision-points/p1-agent.ts'
import { evaluateSkillPoint } from './v2-decision-points/p2-skill.ts'
import { evaluateComplexityPoint } from './v2-decision-points/p3-complexity.ts'
import { evaluateCouncilPoint } from './v2-decision-points/p6-council.ts'
import { evaluateClaimsPoint } from './v2-decision-points/p10-claims.ts'
import type { ShadowRecord, ShadowSink } from './v2-decision-shadow.ts'

/** Registry ids wired at the prompt hook by this module. */
export const PROMPT_SURFACE_POINT_IDS = Object.freeze(['P1', 'P2', 'P3', 'P6', 'P10'] as const)

/** Registry mode every point above declares; telemetry must carry it. */
export const PROMPT_SURFACE_MODE = 'shadow' as const

export interface PromptSurfaceObservation {
  readonly records: readonly ShadowRecord[]
  /** P2a observation only: which source the skill list came from, and why. */
  readonly skills: {
    readonly skillsSource: SkillsSource
    readonly reason: string
  }
}

export interface PromptSurfacePayload {
  readonly prompt?: Readonly<Record<string, unknown>>
}

const PROJECTED_PROMPT_KEYS = ['agents', 'skills'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Project the admission payload down to the fields the adapters may read.
 *
 * Exported so the no-op test can prove the projection carries no prompt text,
 * no file bytes and no metadata.
 */
export function projectPromptSurfacePayload(admission: unknown): PromptSurfacePayload {
  if (!isRecord(admission) || !isRecord(admission.prompt)) return {}
  const prompt = admission.prompt
  const projected: Record<string, unknown> = {}
  for (const key of PROJECTED_PROMPT_KEYS) {
    if (Object.hasOwn(prompt, key)) projected[key] = prompt[key]
  }
  return Object.freeze({ prompt: Object.freeze(projected) })
}

/**
 * Observe the five prompt-surface points in shadow.
 *
 * @param admission Host admission payload. Read only; never mutated.
 * @param sink      Optional observer of the shadow records.
 */
export function observePromptSurface(
  admission: unknown,
  sink?: ShadowSink,
): PromptSurfaceObservation {
  const payload = projectPromptSurfacePayload(admission)
  const records: ShadowRecord[] = []
  const collect: ShadowSink = (record) => {
    records.push(record)
    if (sink === undefined) return
    try {
      sink(record)
    } catch {
      // An observer failure must not become an admission failure.
    }
  }

  let skills: PromptSurfaceObservation['skills'] = {
    skillsSource: 'none',
    reason: 'decision_error',
  }
  const observers: readonly (() => void)[] = [
    () => evaluateAgentPoint(payload, collect),
    () => {
      const skillPoint = evaluateSkillPoint(payload, collect)
      skills = { skillsSource: skillPoint.skillsSource, reason: skillPoint.reason }
    },
    () => evaluateComplexityPoint(payload, collect),
    () => evaluateCouncilPoint(payload, collect),
    () => evaluateClaimsPoint(payload, collect),
  ]
  for (const observe of observers) {
    try {
      observe()
    } catch {
      // One point's failure must not silence the other four.
    }
  }

  return { records: Object.freeze(records), skills }
}
