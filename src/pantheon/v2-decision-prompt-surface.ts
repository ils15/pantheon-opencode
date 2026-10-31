/**
 * Prompt-surface shadow wiring — P1 and P2 share one hook payload.
 *
 * Both read the same admission event at `session.hook('prompt')`. This module
 * constructs each adapter once per invocation and hands it a projection of the
 * payload that contains **only** `prompt.agents` and `prompt.skills`:
 *
 *   - prompt text, files and metadata never enter shadow, so no content can
 *     reach a shadow record or telemetry;
 *   - cloning a prompt-sized payload twice per turn would be a cost this no-op
 *     must not impose, and the invariant is "no delay".
 *
 * Shadow is a no-op by construction: `observeShadow` clones and freezes the
 * projection, every record says `effect: 'none'`, and no failure — adapter,
 * projection or sink — is rethrown into the hook. Nothing here mutates
 * admission; in particular P2 stays advisory and the projection carries no
 * draft list, so it can neither filter skills nor claim to.
 *
 * The other points once wired here are gone. P3 declares `tool.invoke` and is
 * now constructed at the tool that actually carries `complexity` and
 * `gateStatus` (`local-decision-tool.ts`); P6 and P10 declared this hook but
 * this payload never carries council candidates or counsellor claims, so they
 * are not constructed at all (`wired: false`) instead of recording a permanent
 * refusal from a surface that cannot feed them.
 */

import type { SkillsSource } from './local-decision-prompt.ts'
import { evaluateAgentPoint } from './v2-decision-points/p1-agent.ts'
import { evaluateSkillPoint } from './v2-decision-points/p2-skill.ts'
import type { ShadowRecord, ShadowSink } from './v2-decision-shadow.ts'

/** Registry ids wired at the prompt hook by this module. */
export const PROMPT_SURFACE_POINT_IDS = Object.freeze(['P1', 'P2'] as const)

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
 * Observe the two prompt-surface points in shadow.
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
  ]
  for (const observe of observers) {
    try {
      observe()
    } catch {
      // One point's failure must not silence the other.
    }
  }

  return { records: Object.freeze(records), skills }
}
