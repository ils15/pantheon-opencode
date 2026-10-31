/**
 * V2 decision registry — P1…P11 with an explicit status per point.
 *
 * A `measured` status means the *surface* was measured in a runtime probe
 * (presence, shape or channel). It never means the *effect* was measured:
 * effect requires a mutation observed in the following turn (condition C6) and
 * remains unmeasured for every point. `premise` means the surface or catalog
 * this point needs was not measured; the premise is registered by id in
 * `v2-decision-premises.ts`, and its canonical text lives in `STATUS.md` § Premissas. `deferred` means the
 * final design is suspended by an open condition and no effect is authorised.
 *
 * Evidence ids follow PLAN §5.4 (F-01…F-18, I-01) and are never renumbered.
 * `measured` points must cite at least one `F-` id; `premise` and `deferred`
 * points must carry the blocking condition. {@link auditDecisionRegistry}
 * enforces both properties, and the harness treats a violation as a failure.
 */

import type { AskMode } from './v2-decision-contracts.ts'
import { DECISION_POINT_REGISTRY } from './v2-decision-points.ts'
import { PREMISE_IDS, PREMISE_REGISTER, type PremiseEntry } from './v2-decision-premises.ts'

export const DECISION_POINT_IDS = [
  'P1',
  'P2',
  'P3',
  'P4',
  'P5',
  'P6',
  'P7',
  'P8',
  'P9',
  'P10',
  'P11',
] as const

export type DecisionPointId = (typeof DECISION_POINT_IDS)[number]
export type DecisionPointStatus = 'measured' | 'premise' | 'deferred'
export type DecisionPointMode = 'shadow' | 'off' | 'migration'

export type DecisionSurface =
  | 'agent'
  | 'skill'
  | 'complexity'
  | 'memory'
  | 'verification'
  | 'council'
  | 'loop'
  | 'guardrail'
  | 'compaction'
  | 'claims'
  | 'catalog'

export type DecisionPrimitive = AskMode | 'rank' | 'verify'

export interface DecisionEventShape {
  /** Event type the adapter consumes, when the point is event-driven. */
  readonly type: string
  /** Measured carrier path for the session id. */
  readonly carrier: 'data.sessionID'
  /** Envelope fields that are absent from the measured shape and must not be read. */
  readonly forbiddenCarriers: readonly string[]
}

export interface DecisionPoint {
  readonly id: DecisionPointId
  readonly surface: DecisionSurface
  readonly hostPoint: string
  readonly primitives: readonly DecisionPrimitive[]
  readonly mode: DecisionPointMode
  readonly status: DecisionPointStatus
  /** Set only when the measurement was narrower than the point's full scope. */
  readonly scope?: 'top-level-session-only'
  /** Unmeasured scope, named so it cannot be mistaken for measured coverage. */
  readonly unknowns?: readonly string[]
  readonly evidence: readonly string[]
  readonly premises: readonly string[]
  /** Non-null for every `premise` and `deferred` point. */
  readonly blockingCondition: string | null
  readonly trigger?: string
  readonly eventShape?: DecisionEventShape
  /** Required for guardrail points: the hard barrier they may never widen. */
  readonly securityInvariant?: string
  readonly notes: string
}

export { DECISION_POINT_REGISTRY } from './v2-decision-points.ts'
export {
  PREMISE_IDS,
  PREMISE_REGISTER,
  type PremiseEntry,
} from './v2-decision-premises.ts'

const EVIDENCE_ID = /^(?:F-\d{2}|I-\d{2})$/
const MEASURED_EVIDENCE_ID = /^F-\d{2}$/
const FORBIDDEN_CATALOG_REFERENCE = new RegExp(['ctx', 'catalog'].join('\\.'))

export type RegistryViolationCode =
  | 'POINT_SET_MISMATCH'
  | 'DUPLICATE_POINT'
  | 'MEASURED_WITHOUT_EVIDENCE'
  | 'PREMISE_WITHOUT_BLOCKING_CONDITION'
  | 'DEFERRED_WITHOUT_BLOCKING_CONDITION'
  | 'DEFERRED_WITHOUT_TRIGGER'
  | 'UNKNOWN_EVIDENCE_ID'
  | 'UNKNOWN_PREMISE'
  | 'MISSING_PREMISE_REGISTER_ENTRY'
  | 'GUARDRAIL_WITHOUT_SECURITY_INVARIANT'
  | 'CATALOG_REFERENCE_PRESENT'

export interface RegistryViolation {
  readonly code: RegistryViolationCode
  readonly pointId: string | null
  readonly detail: string
}

export interface RegistryAudit {
  readonly ok: boolean
  readonly violations: readonly RegistryViolation[]
}

/**
 * Audit the registry against the binding rules.
 *
 * The critical one: a point declaring `measured` with no `F-` evidence id is a
 * violation. A point cannot claim a measured surface it does not cite.
 */
export function auditDecisionRegistry(
  points: readonly DecisionPoint[] = DECISION_POINT_REGISTRY,
  premises: readonly PremiseEntry[] = PREMISE_REGISTER,
): RegistryAudit {
  const violations: RegistryViolation[] = []
  const premiseIds = new Set(premises.map((premise) => premise.id))
  const pointIds = new Set<string>()

  if (points.length !== DECISION_POINT_IDS.length) {
    violations.push({
      code: 'POINT_SET_MISMATCH',
      pointId: null,
      detail: `expected ${DECISION_POINT_IDS.length} points, received ${points.length}`,
    })
  }
  for (const id of DECISION_POINT_IDS) {
    if (!points.some((point) => point.id === id)) {
      violations.push({ code: 'POINT_SET_MISMATCH', pointId: id, detail: 'point is missing' })
    }
  }
  for (const id of PREMISE_IDS) {
    if (!premiseIds.has(id)) {
      violations.push({
        code: 'MISSING_PREMISE_REGISTER_ENTRY',
        pointId: null,
        detail: `${id} is not registered`,
      })
    }
  }

  for (const point of points) {
    if (pointIds.has(point.id)) {
      violations.push({ code: 'DUPLICATE_POINT', pointId: point.id, detail: 'duplicate id' })
    }
    pointIds.add(point.id)

    if (point.status === 'measured') {
      if (!point.evidence.some((id) => MEASURED_EVIDENCE_ID.test(id))) {
        violations.push({
          code: 'MEASURED_WITHOUT_EVIDENCE',
          pointId: point.id,
          detail: 'measured points must cite at least one F- evidence id',
        })
      }
    } else {
      const code =
        point.status === 'deferred'
          ? 'DEFERRED_WITHOUT_BLOCKING_CONDITION'
          : 'PREMISE_WITHOUT_BLOCKING_CONDITION'
      if (point.blockingCondition === null || point.blockingCondition.trim().length === 0) {
        violations.push({ code, pointId: point.id, detail: 'blocking condition is required' })
      }
      if (point.status === 'deferred' && !point.trigger) {
        violations.push({
          code: 'DEFERRED_WITHOUT_TRIGGER',
          pointId: point.id,
          detail: 'deferred points must name their trigger',
        })
      }
    }
    for (const evidenceId of point.evidence) {
      if (!EVIDENCE_ID.test(evidenceId)) {
        violations.push({
          code: 'UNKNOWN_EVIDENCE_ID',
          pointId: point.id,
          detail: `${evidenceId} is not an evidence id`,
        })
      }
    }
    for (const premiseId of point.premises) {
      if (!premiseIds.has(premiseId)) {
        violations.push({
          code: 'UNKNOWN_PREMISE',
          pointId: point.id,
          detail: `${premiseId} is not registered`,
        })
      }
    }
    if (point.surface === 'guardrail' && !point.securityInvariant) {
      violations.push({
        code: 'GUARDRAIL_WITHOUT_SECURITY_INVARIANT',
        pointId: point.id,
        detail: 'guardrail points must carry the hard-barrier invariant',
      })
    }
    if (FORBIDDEN_CATALOG_REFERENCE.test(JSON.stringify(point))) {
      violations.push({
        code: 'CATALOG_REFERENCE_PRESENT',
        pointId: point.id,
        detail: 'the host catalog context is absent from the measured surface',
      })
    }
  }

  return { ok: violations.length === 0, violations: Object.freeze(violations) }
}

/** Convenience lookup used by the policy and the harness. */
export function findDecisionPoint(id: string): DecisionPoint | undefined {
  return DECISION_POINT_REGISTRY.find((point) => point.id === id)
}
