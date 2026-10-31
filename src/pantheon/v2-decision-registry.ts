/**
 * V2 decision registry — P1…P11 with an explicit status per point.
 *
 * A `measured` status means the *surface* was measured in a runtime probe
 * (presence, shape or channel). It never means the *effect* was measured:
 * effect requires a mutation observed in the following turn — the criterion C6
 * answered for prompt/skill/tool mutations in PROBE-E — and no point's own
 * effect has been measured. `premise` means the surface or catalog
 * this point needs was not measured; the premise is registered by id in
 * `v2-decision-premises.ts`, and its canonical text lives in `STATUS.md` § Premissas. `deferred` means the
 * final design is suspended by an open condition and no effect is authorised.
 * `advisory` means the surface was measured, the specified effect was measured
 * *unreachable*, and the point therefore only records an observation: it
 * applies no decision and may never be described as having one.
 *
 * Evidence ids follow PLAN §5.4 (F-01…F-32, I-01) and are never renumbered.
 * `measured` points must cite at least one `F-` id; `premise`, `advisory` and
 * `deferred` points must carry the blocking condition.
 * {@link auditDecisionRegistry} enforces both properties, and the harness
 * treats a violation as a failure.
 *
 * ## Tool-vs-hook boundary (D12)
 *
 * Every point declares two things and they are checked against each other, so
 * neither can drift alone:
 *
 *   - `hostSurface` — the host API namespace that would carry the decision;
 *   - `toolOrHook` — `tool` when that namespace is the tool surface
 *     (`ctx.tool.transform`, a model-invocable Pantheon tool), `hook` when it
 *     is a host-invoked surface (a session hook, `permission.evaluate`,
 *     `execute.after`, the compaction hook, or the event channel).
 *
 * A catalog *read* (`ctx.skill`, the tool draft) never makes a point a tool
 * point; the boundary is where the decision would be applied. A point that
 * touched both would be ambiguous, so the declaration is exactly one of the
 * two values and the audit rejects anything else. The declared `hostPoint`
 * must also name the declared surface, which makes the declaration falsifiable
 * without executing anything.
 *
 * ## Resource ids (D13)
 *
 * Resource ids are not stored per point: they are derived by
 * `v2-decision-resource-ids.ts` from the point id, the domain surface, the
 * premises and the evidence ids. The audit rejects a collision between two
 * distinct ids, and the ids are always namespaced under
 * `pantheon://v2-decision/`.
 */

import type { AskMode } from './v2-decision-contracts.ts'
import { DECISION_POINT_REGISTRY } from './v2-decision-points.ts'
import { PREMISE_IDS, PREMISE_REGISTER, type PremiseEntry } from './v2-decision-premises.ts'
import {
  decisionResourceRefs,
  findDecisionResourceIdCollisions,
} from './v2-decision-resource-ids.ts'

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
export type DecisionPointStatus = 'measured' | 'premise' | 'advisory' | 'deferred'
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

/** Host API namespace that carries the decision (D12). */
export type DecisionHostSurface =
  | 'tool.invoke'
  | 'tool.transform'
  | 'session.hook.prompt'
  | 'session.hook.context'
  | 'session.hook.compaction'
  | 'session.hook.execute.after'
  | 'permission.evaluate'
  | 'event.channel'

/** The tool-vs-hook boundary. Exactly one value per point; never both. */
export type DecisionToolOrHook = 'tool' | 'hook'

/** Every host surface the registry may declare. */
export const DECISION_HOST_SURFACES: readonly DecisionHostSurface[] = Object.freeze([
  'tool.invoke',
  'tool.transform',
  'session.hook.prompt',
  'session.hook.context',
  'session.hook.compaction',
  'session.hook.execute.after',
  'permission.evaluate',
  'event.channel',
])

/**
 * The only correct side of the boundary for each host surface.
 *
 * `tool.transform` is a tool point even though the host invokes the transform:
 * it acts on the tool namespace. The event channel is a hook point even though
 * it is not a session hook: it is host-driven and model-invocable. The rule is
 * namespace membership, not invocation direction.
 */
export const TOOL_OR_HOOK_BY_HOST_SURFACE: Readonly<
  Record<DecisionHostSurface, DecisionToolOrHook>
> = Object.freeze({
  'tool.invoke': 'tool',
  'tool.transform': 'tool',
  'session.hook.prompt': 'hook',
  'session.hook.context': 'hook',
  'session.hook.compaction': 'hook',
  'session.hook.execute.after': 'hook',
  'permission.evaluate': 'hook',
  'event.channel': 'hook',
})

/** A token the declared `hostPoint` must contain, so the claim is falsifiable. */
const HOST_POINT_TOKENS: Readonly<Record<DecisionHostSurface, readonly string[]>> = Object.freeze({
  'tool.invoke': ['tool pantheon_local_decision'],
  'tool.transform': ['tool.transform'],
  'session.hook.prompt': ['prompt'],
  'session.hook.context': ['context'],
  'session.hook.compaction': ['compaction'],
  'session.hook.execute.after': ['execute.after'],
  'permission.evaluate': ['permission.evaluate'],
  'event.channel': ['session.execution.succeeded'],
})

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
  /** Host API namespace that would carry the decision. */
  readonly hostSurface: DecisionHostSurface
  /** Explicit D12 declaration, validated against `hostSurface`. */
  readonly toolOrHook: DecisionToolOrHook
  readonly hostPoint: string
  readonly primitives: readonly DecisionPrimitive[]
  readonly mode: DecisionPointMode
  readonly status: DecisionPointStatus
  /**
   * Whether the shipped plugin actually constructs this point's adapter.
   *
   * This is a claim about the source, not about a probe: the audit in
   * `tests/pantheon/v2-decision-wiring.test.ts` derives the answer from the
   * production import graph rooted at `src/plugin-v2.ts` and fails when this
   * flag disagrees. It also derives *where* the handler is constructed and
   * fails when a wired point's construction site is not its declared
   * `hostSurface` — a handler called from the wrong hook is not wiring. It is
   * never derived from a hand-maintained list — a second list would repeat the
   * "described as active, produces nothing" defect this field exists to expose.
   */
  readonly wired: boolean
  /**
   * Set only when the measurement was narrower than the point's full scope.
   * `top-level-session-only`: only top-level sessions were exercised.
   * `overflow-unmeasured`: sessions (top-level and child) were exercised, but
   * the context-exhaustion path that would request `reason:"overflow"` was not.
   */
  readonly scope?: 'top-level-session-only' | 'overflow-unmeasured'
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
  | 'ADVISORY_WITHOUT_BLOCKING_CONDITION'
  | 'DEFERRED_WITHOUT_BLOCKING_CONDITION'
  | 'DEFERRED_WITHOUT_TRIGGER'
  | 'UNKNOWN_EVIDENCE_ID'
  | 'UNKNOWN_PREMISE'
  | 'MISSING_PREMISE_REGISTER_ENTRY'
  | 'GUARDRAIL_WITHOUT_SECURITY_INVARIANT'
  | 'CATALOG_REFERENCE_PRESENT'
  | 'UNKNOWN_HOST_SURFACE'
  | 'AMBIGUOUS_TOOL_OR_HOOK'
  | 'TOOL_OR_HOOK_MISMATCH'
  | 'HOST_SURFACE_HOST_POINT_MISMATCH'
  | 'RESOURCE_ID_COLLISION'

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
          : point.status === 'advisory'
            ? 'ADVISORY_WITHOUT_BLOCKING_CONDITION'
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
    const hostSurface = point.hostSurface
    const surfaceIsKnown = DECISION_HOST_SURFACES.includes(hostSurface)
    if (!surfaceIsKnown) {
      violations.push({
        code: 'UNKNOWN_HOST_SURFACE',
        pointId: point.id,
        detail: `${String(hostSurface)} is not a host surface`,
      })
    }
    if (point.toolOrHook !== 'tool' && point.toolOrHook !== 'hook') {
      violations.push({
        code: 'AMBIGUOUS_TOOL_OR_HOOK',
        pointId: point.id,
        detail: 'a point declares exactly one side: tool or hook',
      })
    } else if (surfaceIsKnown && point.toolOrHook !== TOOL_OR_HOOK_BY_HOST_SURFACE[hostSurface]) {
      violations.push({
        code: 'TOOL_OR_HOOK_MISMATCH',
        pointId: point.id,
        detail: `${hostSurface} is a ${TOOL_OR_HOOK_BY_HOST_SURFACE[hostSurface]} surface, not ${point.toolOrHook}`,
      })
    }
    if (
      surfaceIsKnown &&
      !HOST_POINT_TOKENS[hostSurface].some((token) => point.hostPoint.includes(token))
    ) {
      violations.push({
        code: 'HOST_SURFACE_HOST_POINT_MISMATCH',
        pointId: point.id,
        detail: `hostPoint does not name the declared surface ${hostSurface}`,
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

  for (const resourceId of findDecisionResourceIdCollisions(decisionResourceRefs(points))) {
    violations.push({
      code: 'RESOURCE_ID_COLLISION',
      pointId: null,
      detail: `${resourceId} is produced by more than one id`,
    })
  }

  return { ok: violations.length === 0, violations: Object.freeze(violations) }
}

/** Convenience lookup used by the policy and the harness. */
export function findDecisionPoint(id: string): DecisionPoint | undefined {
  return DECISION_POINT_REGISTRY.find((point) => point.id === id)
}
