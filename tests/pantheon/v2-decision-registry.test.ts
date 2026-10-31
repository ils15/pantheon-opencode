/**
 * Registry audit — the C4 closure.
 *
 * The binding property is negative: a point that declares `measured` without a
 * single `F-` evidence id is a violation, and the harness fails on it. That case
 * is constructed here explicitly, because a rule that cannot fail is decorative.
 *
 * `measured` means the SURFACE was measured. It never means an effect was
 * measured; no entry in this registry claims an effect.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-registry.test.ts
 */
import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import {
  auditDecisionRegistry,
  DECISION_POINT_IDS,
  DECISION_POINT_REGISTRY,
  type DecisionPoint,
  findDecisionPoint,
  PREMISE_IDS,
  PREMISE_REGISTER,
} from '../../src/pantheon/v2-decision-registry.ts'

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
  checks += 1
  void name
}

const point = (id: string): DecisionPoint => {
  const found = findDecisionPoint(id)
  assert.ok(found, `missing point ${id}`)
  return found
}

check('the shipped registry passes its own audit', () => {
  const audit = auditDecisionRegistry()
  assert.deepEqual(audit.violations, [])
  assert.equal(audit.ok, true)
})

check('a measured point without an evidence id fails the audit', () => {
  const broken = DECISION_POINT_REGISTRY.map((entry) =>
    entry.id === 'P3'
      ? { ...entry, status: 'measured' as const, evidence: [], blockingCondition: null }
      : entry,
  )
  const audit = auditDecisionRegistry(broken)
  assert.equal(audit.ok, false)
  assert.equal(
    audit.violations.some(
      (violation) => violation.code === 'MEASURED_WITHOUT_EVIDENCE' && violation.pointId === 'P3',
    ),
    true,
    'the harness must fail when measured carries no evidence',
  )
})

check('a premise without a blocking condition fails the audit', () => {
  const broken = DECISION_POINT_REGISTRY.map((entry) =>
    entry.id === 'P5' ? { ...entry, blockingCondition: null } : entry,
  )
  const audit = auditDecisionRegistry(broken)
  assert.equal(audit.ok, false)
  assert.equal(
    audit.violations.some((violation) => violation.code === 'PREMISE_WITHOUT_BLOCKING_CONDITION'),
    true,
  )
})

check('a deferred point without a trigger or blocking condition fails the audit', () => {
  // Built from P7's shape but forced back to `deferred`: P7 itself is now
  // measured (PROBE-D selected branch 1), so it can no longer carry this case.
  const broken = DECISION_POINT_REGISTRY.map((entry) => {
    if (entry.id !== 'P7') return entry
    const { trigger: _trigger, ...withoutTrigger } = entry
    return { ...withoutTrigger, status: 'deferred' as const, blockingCondition: null }
  })
  const audit = auditDecisionRegistry(broken)
  assert.equal(audit.ok, false)
  const codes = new Set(audit.violations.map((violation) => violation.code))
  assert.equal(codes.has('DEFERRED_WITHOUT_BLOCKING_CONDITION'), true)
  assert.equal(codes.has('DEFERRED_WITHOUT_TRIGGER'), true)
})

check('an unregistered premise fails the audit', () => {
  const broken = DECISION_POINT_REGISTRY.map((entry) =>
    entry.id === 'P1' ? { ...entry, premises: ['PM-99'] } : entry,
  )
  const audit = auditDecisionRegistry(broken)
  assert.equal(audit.ok, false)
  assert.equal(
    audit.violations.some((violation) => violation.code === 'UNKNOWN_PREMISE'),
    true,
  )
})

check('the registry covers P1..P11 exactly once', () => {
  assert.deepEqual(
    DECISION_POINT_REGISTRY.map((entry) => entry.id),
    [...DECISION_POINT_IDS],
  )
})

check('the premise register covers PM-03..PM-15 plus PRE-01/PRE-02', () => {
  assert.deepEqual(
    PREMISE_REGISTER.map((entry) => entry.id),
    [...PREMISE_IDS],
  )
  const ids = new Set(PREMISE_REGISTER.map((entry) => entry.id))
  for (let index = 3; index <= 15; index += 1) {
    assert.equal(ids.has(`PM-${String(index).padStart(2, '0')}`), true)
  }
})

check('P7 records the branch-1 selection: measured coverage, execution counter, flag off', () => {
  const p7 = point('P7')
  assert.equal(p7.status, 'measured')
  assert.equal(p7.mode, 'migration')
  assert.equal(p7.trigger, 'session.execution.succeeded')
  assert.equal(p7.eventShape?.carrier, 'data.sessionID')
  assert.equal(p7.eventShape?.forbiddenCarriers.includes('properties'), true)
  assert.equal(p7.blockingCondition, null)
  assert.equal(p7.notes.includes('PROBE-D'), true)
  assert.equal(p7.notes.includes('Branch 1'), true)
  assert.equal(p7.notes.includes('per EXECUTION, not per turn'), true)
  assert.equal(p7.notes.includes('OFF by default'), true)
  for (const id of ['F-11', 'F-12', 'F-13', 'I-01']) {
    assert.equal(p7.evidence.includes(id), true, id)
  }
  // PROBE-D facts await reviewer F-id assignment: this change must not invent
  // F-18 or later.
  for (const id of p7.evidence) {
    const measured = /^F-(\d{2})$/.exec(id)
    if (measured !== null) assert.equal(Number(measured[1]) <= 17, true, id)
  }
})

check('P9 is measured on top-level sessions only and says so', () => {
  const p9 = point('P9')
  assert.equal(p9.status, 'measured')
  assert.equal(p9.scope, 'top-level-session-only')
  assert.equal(p9.evidence.includes('F-01'), true)
  assert.equal(p9.evidence.includes('F-02'), true)
  assert.equal(
    p9.unknowns?.some((entry) => entry.includes('child-session')),
    true,
  )
  assert.equal(p9.premises.includes('PM-04'), true)
})

check('P11 is measured against the absent host catalog and the tool draft', () => {
  const p11 = point('P11')
  assert.equal(p11.status, 'measured')
  assert.equal(p11.evidence.includes('F-05'), true)
  assert.equal(p11.evidence.includes('F-07'), true)
  assert.equal(p11.hostPoint, 'own adapter in tool.transform')
  assert.equal(p11.premises.includes('PM-08'), true)
})

check('P8 is a premise, starts off and carries the hard-barrier invariant', () => {
  const p8 = point('P8')
  assert.equal(p8.status, 'premise')
  assert.equal(p8.mode, 'off')
  assert.equal(p8.premises.includes('PM-09'), true)
  assert.match(p8.securityInvariant ?? '', /execute\.before/)
  assert.match(p8.securityInvariant ?? '', /denies/)
})

check('P2 is advisory-only after P2b was cancelled by measurement', () => {
  const p2 = point('P2')
  assert.equal(p2.status, 'advisory')
  assert.equal(p2.mode, 'shadow')
  assert.equal(p2.premises.includes('PRE-02'), true)
  assert.equal(p2.premises.includes('PM-13'), true)
  assert.equal(p2.evidence.includes('F-09'), true)
  assert.equal(typeof p2.blockingCondition, 'string')
  assert.match(p2.blockingCondition ?? '', /P2b cancelled by measurement/)
  assert.match(p2.blockingCondition ?? '', /no measured mutation surface/)
  assert.match(p2.blockingCondition ?? '', /project skills/)
  assert.equal(p2.notes.includes('P2 é no-op empírico no caminho default'), true)
  assert.equal(p2.notes.includes('P2 filters'), false)
  assert.equal(p2.notes.includes('P2 narrows'), false)
})

check('an advisory point without a blocking condition fails the audit', () => {
  const broken = DECISION_POINT_REGISTRY.map((entry) =>
    entry.id === 'P2' ? { ...entry, blockingCondition: ' ' } : entry,
  )
  const audit = auditDecisionRegistry(broken)
  assert.equal(audit.ok, false)
  assert.equal(
    audit.violations.some(
      (violation) =>
        violation.code === 'ADVISORY_WITHOUT_BLOCKING_CONDITION' && violation.pointId === 'P2',
    ),
    true,
  )
})

check('every premise and deferred point names what blocks it', () => {
  for (const entry of DECISION_POINT_REGISTRY) {
    if (entry.status === 'measured') continue
    assert.equal(typeof entry.blockingCondition, 'string', entry.id)
    assert.equal((entry.blockingCondition ?? '').length > 0, true, entry.id)
  }
})

check('no V2 decision module reads the absent host catalog', () => {
  const directory = new URL('../../src/pantheon/', import.meta.url)
  const modules = readdirSync(directory).filter(
    (name) => name.startsWith('v2-decision-') && name.endsWith('.ts'),
  )
  assert.equal(modules.length >= 7, true, 'expected the Phase 0b modules')
  for (const name of modules) {
    const source = readFileSync(new URL(name, directory), 'utf8')
    assert.equal(source.includes('ctx.catalog'), false, name)
  }
})

check('the heuristic has no scalar certainty field anywhere in its source', () => {
  const source = readFileSync(
    new URL('../../src/pantheon/v2-decision-heuristic.ts', import.meta.url),
    'utf8',
  )
  assert.equal(source.includes('confidence'), false)
  assert.equal(/confidence\s*:/.test(source), false)
})

check('the registry is frozen', () => {
  assert.equal(Object.isFrozen(DECISION_POINT_REGISTRY), true)
  assert.equal(Object.isFrozen(DECISION_POINT_REGISTRY[0]), true)
})

console.log(`V2 decision registry: ${checks} groups passed`)
