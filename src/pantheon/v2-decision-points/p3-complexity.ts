/**
 * P3 (complexity) shadow adapter.
 *
 * Two properties are made explicit here, because the V1 surface left both
 * ambiguous (D1, D4).
 *
 * D4 — label polarity and `label = max`. A dimension vector is classified by
 * its **maximum** dimension score: `2 → high`, `1 → medium`, otherwise `low`.
 * Higher is always more complex, and {@link COMPLEXITY_LABEL_LEVEL} maps the
 * label to a `score` level that increases with it (`low = 1` … `high = 3`).
 * Raising any dimension can never lower the label.
 *
 * D1 — `gateStatus` has an observable effect. The same complexity vector yields
 * a different decision and reason per gate: `none → score`, `review_required →
 * advisory` (classification is usable only as advice), and
 * `human_approval_required` / `unresolved → refusal`. In shadow the effect is
 * the record itself; no admission decision is changed.
 */

import {
  classifyLocalDecisionComplexity,
  type LocalDecisionComplexityDimensions,
  type LocalDecisionGateStatus,
} from '../local-decision-router.ts'
import {
  observeShadow,
  type ShadowDecision,
  type ShadowRecord,
  type ShadowSink,
} from '../v2-decision-shadow.ts'

export type ComplexityLabel = 'low' | 'medium' | 'high' | 'abstain'
export type ComplexityLevel = 1 | 2 | 3

/** Polarity: the level rises with the label, so `high` is the most complex. */
export const COMPLEXITY_LABEL_LEVEL: Readonly<Record<'low' | 'medium' | 'high', ComplexityLevel>> =
  Object.freeze({ low: 1, medium: 2, high: 3 })

const GATE_STATUSES: ReadonlySet<string> = new Set([
  'none',
  'review_required',
  'human_approval_required',
  'unresolved',
])

export interface ComplexityPointResult {
  readonly record: ShadowRecord
  readonly label: ComplexityLabel
  /** `null` for `abstain`: no ordinal level is invented for an invalid vector. */
  readonly level: ComplexityLevel | null
  readonly gateStatus: LocalDecisionGateStatus | null
  readonly reason: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Gate outcome: only `none` leaves the classification free of advice or refusal. */
function gateOutcome(
  gate: LocalDecisionGateStatus,
  label: Exclude<ComplexityLabel, 'abstain'>,
): ShadowDecision {
  if (gate === 'none') return { decision: `score.${label}`, reason: 'gate.none' }
  if (gate === 'review_required') {
    return { decision: `advisory.${label}`, reason: 'gate.review.required' }
  }
  if (gate === 'human_approval_required') {
    return { decision: 'refusal', reason: 'gate.human.approval.required' }
  }
  return { decision: 'refusal', reason: 'gate.unresolved' }
}

/**
 * Observe P3 in shadow.
 *
 * @param input `{ complexity, gateStatus }` — structured dimensions plus the
 *              security status, which never changes the label itself.
 * @param sink  Optional shadow-record observer.
 */
export function evaluateComplexityPoint(input: unknown, sink?: ShadowSink): ComplexityPointResult {
  const complexity = isRecord(input) ? input.complexity : undefined
  const rawGate = isRecord(input) ? input.gateStatus : undefined
  const classified = classifyLocalDecisionComplexity(
    complexity as LocalDecisionComplexityDimensions | undefined,
  )
  const gateStatus =
    typeof rawGate === 'string' && GATE_STATUSES.has(rawGate)
      ? (rawGate as LocalDecisionGateStatus)
      : null

  let decision: ShadowDecision
  if (classified.label === 'abstain') {
    decision = { decision: 'refusal', reason: 'complexity.invalid' }
  } else if (gateStatus === null) {
    decision = { decision: 'refusal', reason: 'invalid.gate' }
  } else {
    decision = gateOutcome(gateStatus, classified.label)
  }

  return {
    record: observeShadow('P3', input, () => decision, sink),
    label: classified.label,
    level: classified.label === 'abstain' ? null : COMPLEXITY_LABEL_LEVEL[classified.label],
    gateStatus,
    reason: decision.reason,
  }
}
