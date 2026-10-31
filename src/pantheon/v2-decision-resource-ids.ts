/**
 * Namespaced resource ids for the V2 decision layer (D13).
 *
 * Every id is derived from a kind and a raw identifier — never hand-assigned
 * per point — so the same raw id always yields the same resource id, and two
 * ids can only collide if their slugs collide:
 *
 *   `pantheon://v2-decision/<kind>/<slug>`
 *
 * The kind segment is part of the identity: a point id `memory` and a surface
 * `memory` are different resources, not a collision. {@link
 * findDecisionResourceIdCollisions} reports ids that two *distinct* raw ids
 * mapped onto, which is the only failure the derivation can produce.
 *
 * Slugs are lowercased and punctuation is folded to `-`, so `PM-09` and
 * `pm 09` are the same resource. That is intentional normalisation, and it is
 * why a collision check is required rather than assumed.
 */

import type { DecisionPoint, DecisionPointId, DecisionSurface } from './v2-decision-registry.ts'

/** Scheme shared by every decision-layer resource id. */
export const DECISION_RESOURCE_SCHEME = 'pantheon://v2-decision'

export type DecisionResourceKind = 'point' | 'surface' | 'premise' | 'evidence'

const KIND_SEGMENT: Readonly<Record<DecisionResourceKind, string>> = Object.freeze({
  point: 'points',
  surface: 'surfaces',
  premise: 'premises',
  evidence: 'evidence',
})

const MAX_SLUG_LENGTH = 64
const RESOURCE_ID_PATTERN = new RegExp(
  `^${DECISION_RESOURCE_SCHEME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}` +
    '/(?:points|surfaces|premises|evidence)/[a-z0-9]+(?:-[a-z0-9]+)*$',
)

/**
 * Deterministic slug for a raw identifier.
 *
 * Throws for input with no alphanumeric content or above the length bound: an
 * empty or unbounded segment is not a resource id.
 */
export function decisionResourceSlug(raw: string): string {
  if (typeof raw !== 'string') throw new TypeError('resource id must be a string')
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length === 0) throw new RangeError(`resource id ${JSON.stringify(raw)} has no slug`)
  if (slug.length > MAX_SLUG_LENGTH) {
    throw new RangeError(`resource id ${JSON.stringify(raw)} exceeds ${MAX_SLUG_LENGTH} characters`)
  }
  return slug
}

/** Build a namespaced resource id from a kind and a raw identifier. */
export function decisionResourceId(kind: DecisionResourceKind, raw: string): string {
  return `${DECISION_RESOURCE_SCHEME}/${KIND_SEGMENT[kind]}/${decisionResourceSlug(raw)}`
}

export function decisionPointResourceId(id: DecisionPointId): string {
  return decisionResourceId('point', id)
}

export function decisionSurfaceResourceId(surface: DecisionSurface): string {
  return decisionResourceId('surface', surface)
}

export function decisionPremiseResourceId(id: string): string {
  return decisionResourceId('premise', id)
}

export function decisionEvidenceResourceId(id: string): string {
  return decisionResourceId('evidence', id)
}

/** Whether a string is a fully namespaced decision resource id. */
export function isDecisionResourceId(value: string): boolean {
  return RESOURCE_ID_PATTERN.test(value)
}

export interface DecisionResourceRef {
  readonly kind: DecisionResourceKind
  readonly id: string
}

/**
 * Resource ids two distinct `(kind, raw id)` pairs mapped onto.
 *
 * Identical refs repeated across points are not collisions: the same premise
 * cited by two points is one resource. Only different raw ids resolving to the
 * same resource id are reported.
 */
export function findDecisionResourceIdCollisions(
  refs: readonly DecisionResourceRef[],
): readonly string[] {
  const origins = new Map<string, string>()
  const collisions: string[] = []
  for (const ref of refs) {
    const resourceId = decisionResourceId(ref.kind, ref.id)
    const origin = `${ref.kind}:${ref.id}`
    const previous = origins.get(resourceId)
    if (previous === undefined) {
      origins.set(resourceId, origin)
      continue
    }
    if (previous !== origin && !collisions.includes(resourceId)) collisions.push(resourceId)
  }
  return Object.freeze(collisions)
}

/** Every resource the registry names: points, surfaces, premises and evidence. */
export function decisionResourceRefs(
  points: readonly DecisionPoint[],
): readonly DecisionResourceRef[] {
  const refs: DecisionResourceRef[] = []
  for (const point of points) {
    refs.push({ kind: 'point', id: point.id }, { kind: 'surface', id: point.surface })
    for (const premise of point.premises) refs.push({ kind: 'premise', id: premise })
    for (const evidence of point.evidence) refs.push({ kind: 'evidence', id: evidence })
  }
  return Object.freeze(refs)
}
