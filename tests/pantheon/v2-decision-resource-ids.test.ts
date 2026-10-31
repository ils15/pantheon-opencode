/**
 * Namespaced decision resource ids (D13).
 *
 * Two properties are binding:
 *
 *   1. every id is namespaced and derived from its raw identifier — never
 *      hand-assigned per point;
 *   2. two distinct ids can never quietly become the same resource.
 *
 * The second is only meaningful if the collision rule can fail, so the test
 * constructs a real collision (`P-1` and `P 1` both slug to `p-1`) and requires
 * the detector to report it.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-resource-ids.test.ts
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { PREMISE_REGISTER } from '../../src/pantheon/v2-decision-premises.ts'
import {
  DECISION_POINT_IDS,
  DECISION_POINT_REGISTRY,
} from '../../src/pantheon/v2-decision-registry.ts'
import {
  DECISION_RESOURCE_SCHEME,
  decisionEvidenceResourceId,
  decisionPointResourceId,
  decisionPremiseResourceId,
  decisionResourceId,
  decisionResourceRefs,
  decisionResourceSlug,
  decisionSurfaceResourceId,
  findDecisionResourceIdCollisions,
  isDecisionResourceId,
} from '../../src/pantheon/v2-decision-resource-ids.ts'

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
  checks += 1
  void name
}

check('ids are namespaced under the decision scheme', () => {
  assert.equal(decisionPointResourceId('P1'), `${DECISION_RESOURCE_SCHEME}/points/p1`)
  assert.equal(decisionSurfaceResourceId('memory'), `${DECISION_RESOURCE_SCHEME}/surfaces/memory`)
  assert.equal(decisionPremiseResourceId('PM-09'), `${DECISION_RESOURCE_SCHEME}/premises/pm-09`)
  assert.equal(decisionEvidenceResourceId('F-13'), `${DECISION_RESOURCE_SCHEME}/evidence/f-13`)
  assert.equal(decisionEvidenceResourceId('I-01'), `${DECISION_RESOURCE_SCHEME}/evidence/i-01`)
})

check('the derivation is deterministic and idempotent', () => {
  assert.equal(decisionResourceSlug('P1'), 'p1')
  assert.equal(decisionResourceSlug('PM-09'), 'pm-09')
  assert.equal(decisionResourceSlug('session.hook.prompt'), 'session-hook-prompt')
  assert.equal(decisionResourceSlug('  P1  '), 'p1')
  assert.equal(decisionResourceSlug(decisionResourceSlug('PM-09')), 'pm-09')
  assert.equal(decisionPointResourceId('P11'), decisionPointResourceId('P11'))
  assert.equal(decisionResourceId('premise', 'PM-09'), decisionResourceId('premise', 'pm-09'))
})

check('a raw id with no slug is rejected instead of producing a bare namespace', () => {
  for (const raw of ['', '   ', '---', '!!!', '///']) {
    assert.throws(() => decisionResourceSlug(raw), RangeError, JSON.stringify(raw))
  }
  assert.throws(
    () => decisionResourceSlug('a'.repeat(65)),
    RangeError,
    'long ids must not produce an unbounded segment',
  )
  assert.throws(() => decisionResourceSlug(42 as unknown as string), TypeError)
})

check('isDecisionResourceId accepts derived ids and rejects raw or malformed ones', () => {
  for (const id of [
    decisionPointResourceId('P1'),
    decisionSurfaceResourceId('catalog'),
    decisionPremiseResourceId('PRE-02'),
    decisionEvidenceResourceId('F-05'),
  ]) {
    assert.equal(isDecisionResourceId(id), true, id)
  }
  for (const value of [
    'P1',
    'memory',
    'pantheon://decisions/points/p1',
    `${DECISION_RESOURCE_SCHEME}/points/P1`,
    `${DECISION_RESOURCE_SCHEME}/points/`,
    `${DECISION_RESOURCE_SCHEME}/points/p1/extra`,
    `${DECISION_RESOURCE_SCHEME}/unknown/p1`,
  ]) {
    assert.equal(isDecisionResourceId(value), false, value)
  }
})

check('the kind segment keeps same-named resources apart', () => {
  const asPoint = decisionResourceId('point', 'memory')
  const asSurface = decisionResourceId('surface', 'memory')
  assert.notEqual(asPoint, asSurface)
  assert.equal(
    findDecisionResourceIdCollisions([
      { kind: 'point', id: 'memory' },
      { kind: 'surface', id: 'memory' },
    ]).length,
    0,
  )
})

check('a collision between two distinct ids is detected', () => {
  const collisions = findDecisionResourceIdCollisions([
    { kind: 'point', id: 'P-1' },
    { kind: 'point', id: 'P 1' },
  ])
  assert.deepEqual([...collisions], [`${DECISION_RESOURCE_SCHEME}/points/p-1`])
  // The same ref repeated is not a collision: a shared premise is one resource.
  assert.deepEqual(
    [
      ...findDecisionResourceIdCollisions([
        { kind: 'premise', id: 'PM-09' },
        { kind: 'premise', id: 'PM-09' },
      ]),
    ],
    [],
  )
})

check('every registry resource is namespaced and free of collisions', () => {
  const refs = decisionResourceRefs(DECISION_POINT_REGISTRY)
  assert.equal(findDecisionResourceIdCollisions(refs).length, 0)
  for (const ref of refs) {
    const id = decisionResourceId(ref.kind, ref.id)
    assert.equal(id.startsWith(`${DECISION_RESOURCE_SCHEME}/`), true, id)
    assert.equal(isDecisionResourceId(id), true, id)
  }
  const points = refs.filter((ref) => ref.kind === 'point').map((ref) => ref.id)
  assert.deepEqual(points, [...DECISION_POINT_IDS])
})

check('every premise and evidence id in the registry maps to a distinct resource', () => {
  const refs = decisionResourceRefs(DECISION_POINT_REGISTRY)
  const premises = new Set(
    refs.filter((ref) => ref.kind === 'premise').map((ref) => decisionPremiseResourceId(ref.id)),
  )
  const registered = new Set(PREMISE_REGISTER.map((entry) => decisionPremiseResourceId(entry.id)))
  for (const id of premises) assert.equal(registered.has(id), true, id)
  const evidence = [
    ...new Set(refs.filter((ref) => ref.kind === 'evidence').map((ref) => ref.id)),
  ].map((id) => decisionEvidenceResourceId(id))
  assert.equal(new Set(evidence).size, evidence.length)
})

check('resource ids are derived, not hand-assigned in the registry table', () => {
  const source = readFileSync(
    new URL('../../src/pantheon/v2-decision-points.ts', import.meta.url),
    'utf8',
  )
  assert.equal(source.includes('pantheon://'), false)
})

console.log(`V2 decision resource ids: ${checks} groups passed`)
