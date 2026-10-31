/**
 * Offline harness for the Phase 0b decision primitives.
 *
 * Each registry point gets 24 synthetic cases — 12 normal, 6 refusal and 6
 * adversarial — exercising the primitive(s) the point declares, the policy that
 * admits or denies it, the shadow no-op, and the telemetry allowlist. The suite
 * asserts the per-point minimums (>= 20 total, >= 5 refusal, >= 5 adversarial)
 * instead of trusting a hand count.
 *
 * Nothing here calls a provider, opens a socket or touches the filesystem except
 * to read the module sources for the offline assertion. No claim of token or
 * quality gain is made: the harness checks contracts, not improvements.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-harness.test.ts
 */
import { strict as assert } from 'node:assert'
import { readdirSync, readFileSync } from 'node:fs'
import {
  evaluateAskAnswer,
  rankCandidates,
  resolveVerify,
  validateAsk,
} from '../../src/pantheon/v2-decision-contracts.ts'
import {
  consumeDecisionEvents,
  P7_TURN_END_EVENT_TYPE,
} from '../../src/pantheon/v2-decision-events.ts'
import { decideHeuristic } from '../../src/pantheon/v2-decision-heuristic.ts'
import {
  createDecisionBudget,
  evaluateDecisionPolicy,
} from '../../src/pantheon/v2-decision-policy.ts'
import {
  auditDecisionRegistry,
  DECISION_POINT_IDS,
  DECISION_POINT_REGISTRY,
  type DecisionPoint,
  type DecisionPointId,
  type DecisionPrimitive,
} from '../../src/pantheon/v2-decision-registry.ts'
import { observeShadow } from '../../src/pantheon/v2-decision-shadow.ts'
import { createTelemetrySink, sanitizeTelemetry } from '../../src/pantheon/v2-decision-telemetry.ts'
import {
  HOST_EVENT_ENVELOPES_F13,
  HOST_PROMPT_PAYLOAD_F08,
  HOSTILE_TELEMETRY,
  RANK_CANDIDATES,
  VALID_CHOICE,
  VALID_NOUL,
  VALID_SCORE,
} from './v2-decision-fixtures.ts'

type CaseKind = 'normal' | 'refusal' | 'adversarial'

interface HarnessCase {
  readonly id: string
  readonly point: DecisionPointId
  readonly kind: CaseKind
  readonly run: () => void | Promise<void>
}

const cases: HarnessCase[] = []

// ─── Primitive probes ──────────────────────────────────────────────────

function expectPrimitiveNormal(primitive: DecisionPrimitive, variant: number): void {
  if (primitive === 'choice') {
    const result = evaluateAskAnswer(VALID_CHOICE, { kind: 'choice', index: (variant % 3) + 1 })
    assert.equal(result.status, 'choice')
  } else if (primitive === 'noul') {
    const result = evaluateAskAnswer(VALID_NOUL, { kind: 'noul', value: (variant % 2) as 0 | 1 })
    assert.equal(result.status, 'noul')
  } else if (primitive === 'score') {
    const result = evaluateAskAnswer(VALID_SCORE, { kind: 'score', level: (variant % 5) + 1 })
    assert.equal(result.status, 'score')
  } else if (primitive === 'rank') {
    const result = rankCandidates(RANK_CANDIDATES)
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.ordered.length, RANK_CANDIDATES.length)
  } else {
    const result = resolveVerify(
      { id: 'hc', mandatory: true },
      variant % 2 === 0 ? 'PASS' : 'BLOCK',
    )
    assert.equal(result.verdict, variant % 2 === 0 ? 'PASS' : 'BLOCK')
    assert.equal(result.reasonCode, 'VERDICT')
  }
}

function expectPrimitiveRefusal(primitive: DecisionPrimitive, variant: number): void {
  if (primitive === 'choice' || primitive === 'noul' || primitive === 'score') {
    if (variant % 2 === 0) {
      const result = evaluateAskAnswer(
        primitive === 'choice' ? VALID_CHOICE : primitive === 'noul' ? VALID_NOUL : VALID_SCORE,
        { kind: 'refusal' },
      )
      assert.equal(result.status, 'refusal')
    } else {
      const result = evaluateAskAnswer(
        primitive === 'choice' ? VALID_CHOICE : primitive === 'noul' ? VALID_NOUL : VALID_SCORE,
        undefined,
      )
      assert.equal(result.status, 'failed')
      if (result.status === 'failed') assert.equal(result.reasonCode, 'FAILED_TO_RESPOND')
    }
    return
  }
  if (primitive === 'rank') {
    if (variant % 2 === 0) {
      const result = rankCandidates([])
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.code, 'NO_CANDIDATES')
    } else {
      const result = rankCandidates([
        { id: 'dup', score: 1, justification: 'a' },
        { id: 'dup', score: 2, justification: 'b' },
      ])
      assert.equal(result.ok, false)
      if (!result.ok) assert.equal(result.code, 'DUPLICATE_ID')
    }
    return
  }
  if (variant % 2 === 0) {
    const blocked = resolveVerify({ id: 'hc', mandatory: true }, undefined)
    assert.equal(blocked.verdict, 'BLOCK')
    assert.notEqual(blocked.reasonCode, 'VERDICT')
  } else {
    const advisory = resolveVerify({ id: 'hc', mandatory: false }, { confidence: 1 })
    assert.equal(advisory.verdict, 'FAIL')
  }
}

function expectPrimitiveAdversarial(primitive: DecisionPrimitive, variant: number): void {
  if (primitive === 'choice') {
    const labels =
      variant % 3 === 0
        ? ['a', 'a']
        : variant % 3 === 1
          ? Array.from({ length: 256 }, (_, index) => `l-${index}`)
          : ['good', 'bad\nline']
    const result = validateAsk({ mode: 'choice', id: 'q', text: 't', labels })
    assert.equal(result.ok, false)
    if (variant % 5 === 4) {
      const outOfRange = evaluateAskAnswer(VALID_CHOICE, { kind: 'choice', index: 99 })
      assert.equal(outOfRange.status, 'failed')
    }
    return
  }
  if (primitive === 'noul') {
    const result = evaluateAskAnswer(VALID_NOUL, { kind: 'noul', value: 2 })
    assert.equal(result.status, 'failed')
    return
  }
  if (primitive === 'score') {
    const levels = variant % 2 === 0 ? 11 : 1
    const result = validateAsk({ mode: 'score', id: 'q', text: 't', levels })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'INVALID_LEVELS')
    return
  }
  if (primitive === 'rank') {
    const bad =
      variant % 3 === 0
        ? { id: 'a b', score: 1, justification: 'x' }
        : variant % 3 === 1
          ? { id: 'a', score: Number.NaN, justification: 'x' }
          : { id: 'a', score: 1, justification: ' ' }
    const result = rankCandidates([bad])
    assert.equal(result.ok, false)
    return
  }
  const response = variant % 3 === 0 ? { confidence: 1 } : variant % 3 === 1 ? null : 'PASS '
  const result = resolveVerify({ id: 'hc', mandatory: true }, response)
  assert.equal(result.verdict, 'BLOCK')
}

// ─── Generic cases, scoped to a point ──────────────────────────────────

function registryEntry(point: DecisionPointId): DecisionPoint {
  const entry = DECISION_POINT_REGISTRY.find((candidate) => candidate.id === point)
  assert.ok(entry, `registry entry ${point}`)
  return entry
}

function buildCases(entry: DecisionPoint): HarnessCase[] {
  const point = entry.id
  const built: HarnessCase[] = []
  const add = (kind: CaseKind, name: string, run: () => void | Promise<void>): void => {
    built.push({ id: `${point}:${kind}:${name}`, point, kind, run })
  }

  // Normal (12)
  add('normal', 'policy-admission', () => {
    const decision = evaluateDecisionPolicy(
      {},
      { point, pointMode: entry.mode, status: entry.status },
    )
    assert.equal(decision.effect, 'none')
    if (entry.status === 'deferred') {
      assert.equal(decision.admitted, false)
    } else if (entry.mode === 'migration') {
      // Migration points replace active behaviour and are never admitted as
      // shadow (PLAN §5.1). P7 reached this branch when PROBE-D selected
      // branch 1, so the invariant is stated here instead of assumed.
      assert.equal(decision.admitted, false)
      assert.equal(decision.reasonCode, 'MIGRATION_NOT_SHADOW')
    } else if (entry.mode === 'off') {
      assert.equal(decision.admitted, false)
    } else {
      assert.equal(decision.admitted, true)
      assert.equal(decision.mode, 'shadow')
    }
  })
  add('normal', 'policy-replay', () => {
    const request = { point, pointMode: entry.mode, status: entry.status }
    assert.deepEqual(evaluateDecisionPolicy({}, request), evaluateDecisionPolicy({}, request))
  })
  add('normal', 'shadow-noop', () => {
    const payload = structuredClone(HOST_PROMPT_PAYLOAD_F08)
    const before = structuredClone(payload)
    const record = observeShadow(point, payload, () => ({
      decision: 'choice',
      reason: 'UNIQUE_MAX_EVIDENCE',
    }))
    assert.equal(record.effect, 'none')
    assert.equal(record.decision, 'choice')
    assert.deepEqual(payload, before)
  })
  add('normal', 'shadow-throwing-sink', () => {
    const record = observeShadow(
      point,
      HOST_PROMPT_PAYLOAD_F08,
      () => ({ decision: 'noul', reason: 'UNIQUE_MAX_EVIDENCE' }),
      () => {
        throw new Error('observer exploded')
      },
    )
    assert.equal(record.effect, 'none')
    assert.equal(record.decision, 'noul')
  })
  add('normal', 'telemetry-shadow-record', () => {
    const record = observeShadow(point, HOST_PROMPT_PAYLOAD_F08, () => ({
      decision: 'choice',
      reason: 'UNIQUE_MAX_EVIDENCE',
    }))
    const result = sanitizeTelemetry({ ...record, mode: 'shadow' })
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.event.point, point)
      assert.equal(result.event.effect, 'none')
    }
  })
  add('normal', 'telemetry-drops-content', () => {
    const result = sanitizeTelemetry({
      point,
      decision: 'choice',
      reason: 'UNIQUE_MAX_EVIDENCE',
      prompt: 'private prompt',
    })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(JSON.stringify(result).includes('private prompt'), false)
  })
  add('normal', 'registry-status-rules', () => {
    if (entry.status === 'measured') {
      assert.equal(
        entry.evidence.some((id) => /^F-\d{2}$/.test(id)),
        true,
      )
    } else {
      assert.equal((entry.blockingCondition ?? '').length > 0, true)
    }
  })
  add('normal', 'budget-consumption', () => {
    const budget = createDecisionBudget(1)
    const config = { budget }
    const request = { point, pointMode: entry.mode, status: entry.status }
    const first = evaluateDecisionPolicy(config, request)
    const second = evaluateDecisionPolicy(config, request)
    if (first.admitted) assert.equal(second.reasonCode, 'BUDGET_EXHAUSTED')
    else assert.equal(second.admitted, false)
  })
  const primitives = entry.primitives
  const primitiveAt = (index: number): DecisionPrimitive =>
    primitives[index % primitives.length] ?? 'choice'
  add('normal', 'primitive-1', () => expectPrimitiveNormal(primitiveAt(0), 0))
  add('normal', 'primitive-2', () => expectPrimitiveNormal(primitiveAt(1), 1))
  add('normal', 'primitive-3', () => expectPrimitiveNormal(primitiveAt(2), 2))
  add('normal', 'primitive-replay', () => {
    const primitive = primitiveAt(0)
    const first = primitiveResult(primitive)
    const second = primitiveResult(primitive)
    assert.deepEqual(first, second)
    assert.deepEqual(JSON.parse(JSON.stringify(first)), first)
  })

  // Refusal (6)
  add('refusal', 'unknown-point', () => {
    const decision = evaluateDecisionPolicy({}, { ...entry, point: 'P99' })
    assert.equal(decision.admitted, false)
    assert.equal(decision.reasonCode, 'UNKNOWN_POINT')
  })
  add('refusal', 'zero-budget', () => {
    const decision = evaluateDecisionPolicy(
      { budget: createDecisionBudget(0) },
      { point, pointMode: entry.mode, status: entry.status },
    )
    if (entry.status === 'deferred' || entry.mode === 'off') {
      assert.equal(decision.admitted, false)
    } else if (entry.mode === 'migration') {
      assert.equal(decision.reasonCode, 'MIGRATION_NOT_SHADOW')
    } else {
      assert.equal(decision.reasonCode, 'BUDGET_EXHAUSTED')
    }
  })
  add('refusal', 'closed-gate', () => {
    const decision = evaluateDecisionPolicy(
      { closedGates: ['C6'] },
      { point, pointMode: entry.mode, status: entry.status, requiredGates: ['C6'] },
    )
    if (entry.status === 'deferred' || entry.mode === 'off') {
      assert.equal(decision.admitted, false)
    } else if (entry.mode === 'migration') {
      assert.equal(decision.reasonCode, 'MIGRATION_NOT_SHADOW')
    } else {
      assert.equal(decision.reasonCode, 'GATE_CLOSED')
    }
  })
  add('refusal', 'missing-telemetry-field', () => {
    const result = sanitizeTelemetry({ point, decision: 'choice' })
    assert.equal(result.ok, false)
  })
  add('refusal', 'primitive-refusal-1', () => expectPrimitiveRefusal(primitiveAt(0), 0))
  add('refusal', 'primitive-refusal-2', () => expectPrimitiveRefusal(primitiveAt(1), 1))

  // Adversarial (6)
  add('adversarial', 'shadow-mutation', () => {
    const payload = structuredClone(HOST_PROMPT_PAYLOAD_F08)
    const before = structuredClone(payload)
    observeShadow(point, payload, (isolated) => {
      const copy = isolated as { prompt: { skills: unknown } }
      copy.prompt.skills = ['fabricated']
      return { decision: 'choice', reason: 'UNIQUE_MAX_EVIDENCE' }
    })
    assert.deepEqual(payload, before)
  })
  add('adversarial', 'telemetry-injection', () => {
    for (const hostile of HOSTILE_TELEMETRY) {
      const serialised = JSON.stringify(sanitizeTelemetry(hostile))
      for (const secret of ['secret password', 'private content', 'sk-live-not-a-real-key']) {
        assert.equal(serialised.includes(secret), false)
      }
    }
  })
  add('adversarial', 'telemetry-hostile-key', () => {
    const result = sanitizeTelemetry({
      point,
      decision: 'choice',
      reason: 'UNIQUE_MAX_EVIDENCE',
      'private field name': 'x',
    })
    assert.equal(result.ok, true)
    assert.equal(JSON.stringify(result).includes('private field name'), false)
  })
  add('adversarial', 'primitive-adversarial-1', () => expectPrimitiveAdversarial(primitiveAt(0), 0))
  add('adversarial', 'primitive-adversarial-2', () => expectPrimitiveAdversarial(primitiveAt(1), 1))
  add('adversarial', 'registry-tamper', () => {
    assert.throws(() => {
      ;(entry as { status: string }).status = 'measured'
    })
    assert.equal(entry.status, registryEntry(point).status)
  })

  return built
}

function primitiveResult(primitive: DecisionPrimitive): unknown {
  if (primitive === 'choice') {
    return evaluateAskAnswer(VALID_CHOICE, { kind: 'choice', index: 1 })
  }
  if (primitive === 'noul') return evaluateAskAnswer(VALID_NOUL, { kind: 'noul', value: 1 })
  if (primitive === 'score') return evaluateAskAnswer(VALID_SCORE, { kind: 'score', level: 3 })
  if (primitive === 'rank') return rankCandidates(RANK_CANDIDATES)
  return resolveVerify({ id: 'hc', mandatory: true }, 'PASS')
}

// ─── Run ───────────────────────────────────────────────────────────────

const run = async (): Promise<void> => {
  for (const entry of DECISION_POINT_REGISTRY) {
    const pointCases = buildCases(entry)
    assert.equal(pointCases.length >= 20, true, `${entry.id} has ${pointCases.length} cases`)
    const refusals = pointCases.filter((testCase) => testCase.kind === 'refusal').length
    const adversarial = pointCases.filter((testCase) => testCase.kind === 'adversarial').length
    assert.equal(refusals >= 5, true, `${entry.id} has ${refusals} refusal cases`)
    assert.equal(adversarial >= 5, true, `${entry.id} has ${adversarial} adversarial cases`)
    cases.push(...pointCases)
  }
  assert.deepEqual([...new Set(cases.map((testCase) => testCase.point))], [...DECISION_POINT_IDS])

  for (const testCase of cases) await testCase.run()

  const audit = auditDecisionRegistry()
  assert.deepEqual(audit.violations, [])

  // The turn-end channel is consumed as an iterable; the registry names the
  // type and the carrier, and the measured envelopes match.
  const seen: string[] = []
  const summary = await consumeDecisionEvents(
    {
      subscribe: () => {
        return (async function* () {
          for (const envelope of HOST_EVENT_ENVELOPES_F13) yield envelope
        })()
      },
    },
    {
      types: [P7_TURN_END_EVENT_TYPE],
      signal: new AbortController().signal,
      onEvent: (event) => seen.push(event.sessionID),
    },
  )
  assert.equal(summary.matched, 1)
  assert.deepEqual(seen, ['ses_fixture_0001'])

  // No live provider and no Bifrost in any Phase 0b module.
  const directory = new URL('../../src/pantheon/', import.meta.url)
  const modules = readdirSync(directory).filter(
    (name) => name.startsWith('v2-decision-') && name.endsWith('.ts'),
  )
  for (const name of modules) {
    const source = readFileSync(new URL(name, directory), 'utf8')
    for (const forbidden of ['node:http', 'node:https', 'node:net', 'undici', 'Bifrost']) {
      assert.equal(source.includes(forbidden), false, `${name} references ${forbidden}`)
    }
    assert.equal(/fetch\s*\(/.test(source), false, `${name} calls fetch`)
  }

  // The heuristic refuses instead of fabricating a winner.
  assert.equal(decideHeuristic({ candidates: [] }).kind, 'refusal')

  const counts = {
    total: cases.length,
    normal: cases.filter((testCase) => testCase.kind === 'normal').length,
    refusal: cases.filter((testCase) => testCase.kind === 'refusal').length,
    adversarial: cases.filter((testCase) => testCase.kind === 'adversarial').length,
  }
  const sink = createTelemetrySink(4)
  sink.emit({ point: 'P1', decision: 'choice', reason: 'UNIQUE_MAX_EVIDENCE' })
  assert.equal(sink.size(), 1)

  console.log(
    `V2 decision harness: ${counts.total} cases (${counts.normal} normal, ${counts.refusal} refusal, ${counts.adversarial} adversarial) across ${DECISION_POINT_IDS.length} points`,
  )
}

await run()
