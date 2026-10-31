/**
 * P8 — the narrowing-only proof for the guardrail over `permission.evaluate`.
 *
 * The premise this file is built on is a negative one: PM-09 records that
 * `permission.evaluate` and `execute.before` were registered and **never
 * fired**. No payload shape below is therefore evidence; the inputs are the
 * *declared* contract plus hostile variants. What is proven here is not "P8
 * works in the host" — it is that P8 cannot widen, cannot grant, cannot throw
 * and is off when the flag is absent.
 *
 * Two properties are enumerated rather than argued:
 *
 *   1. `p8(x) ⊆ baseline(x)` over every (baseline, event, flag) triple in the
 *      grid below — the result is the baseline or `deny`, never anything wider.
 *   2. no grant path: a decision can report `'allow'` only when the baseline was
 *      already `'allow'`, so the value is an echo and not a grant. The module
 *      source is also scanned for an effect assignment to `'allow'`.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-p8.test.ts
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  applyP8ToPermissionEvent,
  createP8Guardrail,
  evaluateP8Guardrail,
  P8_EFFECT_RANK,
  P8_GUARDRAIL_FLAG_ENV,
  P8_PATH_COVERAGE,
  P8_RULES,
  p8EffectRank,
  p8GuardrailEnabledFromEnv,
  p8NarrowsOnly,
} from '../../src/pantheon/v2-decision-points/p8-guardrail.ts'

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
  checks += 1
  void name
}

const REASON_TOKEN = /^[a-z0-9][a-z0-9.:-]{0,63}$/
const EFFECTS = ['allow', 'ask', 'deny'] as const

/**
 * Baselines: the three declared effects plus values a host could plausibly
 * hand over by accident. Everything outside the three must refuse — an
 * unrecognized baseline cannot be proven a superset of anything.
 */
const BASELINES: readonly unknown[] = [
  'allow',
  'ask',
  'deny',
  undefined,
  null,
  '',
  'ALLOW',
  'Allow',
  'permit',
  0,
  1,
  true,
  {},
  [],
]

type Payload = Record<string, unknown>

function throwingEvent(): Payload {
  const event = {} as Payload
  Object.defineProperty(event, 'effect', {
    enumerable: true,
    get() {
      throw new Error('hostile getter')
    },
  })
  return event
}

function unreadableActionEvent(): Payload {
  const event = { sessionID: 'ses_a' } as Payload
  Object.defineProperty(event, 'action', {
    enumerable: true,
    get() {
      throw new Error('hostile getter')
    },
  })
  return event
}

/**
 * Event shapes: the declared contract plus adversarial variants (missing
 * fields, control characters, wrong types, hostile getters, frozen objects,
 * a throwing proxy).
 */
const EVENTS: readonly unknown[] = [
  undefined,
  null,
  {},
  { action: 'read', sessionID: 'ses_a' },
  { action: 'write' },
  { action: '', sessionID: 'ses_a' },
  { action: 'read\nbash', sessionID: 'ses_a' },
  { action: 'read\u0000', sessionID: 'ses_a' },
  { action: 42, sessionID: 'ses_a' },
  { action: 'decision.egress', sessionID: 'ses_a' },
  { action: 'read', sessionID: '   ' },
  { action: 'read', sessionID: 'ses_a', resources: ['file.ts'] },
  { action: 'read', sessionID: 'ses_a', resources: [] },
  { action: 'READ.deny', sessionID: 'ses_a', effect: 'allow' },
  { action: 'read', sessionID: 'ses_a', effect: 'ask' },
  Object.freeze({ action: 'read', sessionID: 'ses_a', effect: 'ask' }),
  Object.preventExtensions({ action: 'read', sessionID: 'ses_a', effect: 'allow' }),
  throwingEvent(),
  unreadableActionEvent(),
  new Proxy({} as Payload, {
    get() {
      throw new Error('hostile proxy')
    },
    has() {
      throw new Error('hostile proxy')
    },
  }),
]

/** Baseline carried by an event, read without letting a getter escape. */
function baselineOf(event: unknown): unknown {
  try {
    if (event === null || typeof event !== 'object') return undefined
    return (event as Payload).effect
  } catch {
    return undefined
  }
}

function assertSubset(baseline: unknown, effect: unknown, label: string): void {
  const baseRank = p8EffectRank(baseline)
  if (baseRank === null) {
    assert.equal(effect, 'unavailable', `${label}: unprovable baseline must refuse`)
    return
  }
  assert.ok(
    p8NarrowsOnly(baseline, effect),
    `${label}: ${String(effect)} is wider than ${String(baseline)}`,
  )
  // No grant path: a wider value may only ever be the baseline echoed back.
  if (effect === 'allow') assert.equal(baseline, 'allow', `${label}: fabricated allow`)
  if (effect === 'ask') assert.equal(baseline, 'ask', `${label}: fabricated ask`)
}

let evaluatedCases = 0

check('p8(x) is a subset of baseline(x) for every (baseline, event, flag) triple', () => {
  for (const baseline of BASELINES) {
    for (const [eventIndex, event] of EVENTS.entries()) {
      for (const enabled of [false, true]) {
        const label = `baseline=${String(baseline)} enabled=${enabled} event#${eventIndex}`
        let result: ReturnType<typeof evaluateP8Guardrail> | undefined
        assert.doesNotThrow(() => {
          result = evaluateP8Guardrail({ baseline, event }, { enabled })
        }, `${label}: evaluation threw`)
        assert.ok(result)
        assertSubset(baseline, result.effect, label)
        assert.match(result.reason, REASON_TOKEN, `${label}: reason token`)
        for (const rule of result.rules) {
          assert.ok(P8_RULES.includes(rule as (typeof P8_RULES)[number]), `${label}: ${rule}`)
        }
        if (p8EffectRank(baseline) === null) {
          assert.equal(result.decision, 'guardrail.refusal', `${label}: refusal expected`)
          assert.equal(result.rules.length, 0, `${label}: refusal names no rule`)
        }
        if (!enabled) {
          assert.equal(result.narrowed, false, `${label}: disabled never narrows`)
          assert.equal(result.rules.length, 0, `${label}: disabled consults no rule`)
        }
        evaluatedCases += 1
      }
    }
  }
})

let appliedCases = 0

check('applyP8ToPermissionEvent only ever leaves the baseline or writes deny', () => {
  for (const event of EVENTS) {
    for (const enabled of [false, true]) {
      const before = baselineOf(event)
      let result: ReturnType<typeof applyP8ToPermissionEvent> | undefined
      assert.doesNotThrow(() => {
        result = applyP8ToPermissionEvent(event, { enabled })
      }, 'apply threw into admission')
      assert.ok(result)
      const after = baselineOf(event)
      if (p8EffectRank(before) === null) {
        assert.equal(after, before, 'an unreadable baseline is never written')
      } else {
        assert.ok(
          p8NarrowsOnly(before, after),
          `apply wrote ${String(after)} over ${String(before)}`,
        )
      }
      assertSubset(before, result.effect, `apply result enabled=${enabled}`)
      assert.ok(
        after === before || after === 'deny',
        `apply wrote ${String(after)} over ${String(before)}`,
      )
      assert.equal(
        result.wrote,
        after === 'deny' && before !== 'deny',
        'wrote must describe an actual deny write',
      )
      if (p8EffectRank(before) === null) {
        assert.equal(after, before, 'an unreadable baseline is never written')
        assert.equal(result.wrote, false)
      }
      if (!enabled) assert.equal(result.wrote, false, 'disabled must not write')
      appliedCases += 1
    }
  }
})

check('no rule can widen any baseline', () => {
  let combinations = 0
  for (const rule of P8_RULES) {
    void rule
    for (const baseline of EFFECTS) {
      // Rule-matched evaluation: an event that matches every declared rule.
      const result = evaluateP8Guardrail(
        { baseline, event: { action: 'bad action \u0007' } },
        { enabled: true },
      )
      assert.ok(p8NarrowsOnly(baseline, result.effect), `${rule}: widened ${baseline}`)
      if (baseline === 'deny') assert.equal(result.effect, 'deny')
      else assert.equal(result.effect, 'deny', `${rule}: a matching rule is a deny`)
      combinations += 1
    }
  }
  assert.equal(combinations, P8_RULES.length * EFFECTS.length)
})

check('the flag is off by default and only an explicit truthy value enables it', () => {
  assert.equal(p8GuardrailEnabledFromEnv({}), false)
  assert.equal(p8GuardrailEnabledFromEnv({ [P8_GUARDRAIL_FLAG_ENV]: '' }), false)
  assert.equal(p8GuardrailEnabledFromEnv({ [P8_GUARDRAIL_FLAG_ENV]: '0' }), false)
  assert.equal(p8GuardrailEnabledFromEnv({ [P8_GUARDRAIL_FLAG_ENV]: 'yes' }), false)
  assert.equal(p8GuardrailEnabledFromEnv({ [P8_GUARDRAIL_FLAG_ENV]: 'enable' }), false)
  for (const truthy of ['1', 'on', 'true', ' TRUE ']) {
    assert.equal(p8GuardrailEnabledFromEnv({ [P8_GUARDRAIL_FLAG_ENV]: truthy }), true)
  }

  const disabled = createP8Guardrail()
  assert.equal(disabled.enabled, false)
  const allowEvent = { action: 'read', sessionID: 'ses_a', effect: 'allow' }
  assert.equal(disabled.apply(allowEvent).wrote, false)
  assert.equal(allowEvent.effect, 'allow', 'a disabled guardrail writes nothing')
  assert.equal(disabled.evaluate({ baseline: 'allow', event: allowEvent }).reason, 'p8.disabled')
})

check('enabled: a valid allow passes through, an unattributable allow narrows', () => {
  const guardrail = createP8Guardrail({ enabled: true })

  const attributed = { action: 'read', sessionID: 'ses_a', effect: 'allow' }
  const kept = guardrail.apply(attributed)
  assert.equal(kept.decision, 'guardrail.keep')
  assert.equal(kept.effect, 'allow')
  assert.equal(kept.wrote, false)
  assert.equal(attributed.effect, 'allow')

  const unattributed = { action: 'read', effect: 'allow' }
  const narrowed = guardrail.apply(unattributed)
  assert.equal(narrowed.decision, 'guardrail.narrow')
  assert.equal(narrowed.narrowed, true)
  assert.equal(narrowed.wrote, true)
  assert.deepEqual(narrowed.rules, ['p8.rule.allow.unattributed'])
  assert.equal(unattributed.effect, 'deny')

  const denial = { action: 'read', effect: 'deny' }
  const unchanged = guardrail.apply(denial)
  assert.equal(unchanged.decision, 'guardrail.keep')
  assert.equal(unchanged.wrote, false)
  assert.equal(denial.effect, 'deny')

  const frozen = Object.freeze({ action: 'read', effect: 'allow' })
  const rejected = guardrail.apply(frozen)
  assert.equal(rejected.reason, 'p8.write.rejected')
  assert.equal(rejected.narrowed, false)
  assert.equal(rejected.wrote, false)
  assert.equal(rejected.effect, 'allow', 'a refused write leaves the baseline in place')
})

check('the path coverage table is entirely unmeasured and names PM-09', () => {
  assert.equal(P8_PATH_COVERAGE.length > 0, true)
  const paths = new Set<string>()
  for (const path of P8_PATH_COVERAGE) {
    assert.equal(path.status, 'unmeasured', `${path.path} claims a measurement it lacks`)
    assert.deepEqual([...path.evidence], ['PM-09'], `${path.path} must cite PM-09`)
    assert.equal(paths.has(path.path), false, `${path.path} is duplicated`)
    paths.add(path.path)
  }
  assert.equal(paths.size, P8_PATH_COVERAGE.length)
  assert.equal(
    P8_PATH_COVERAGE.some((path) => path.status === 'measured'),
    false,
    'no path on this surface has been measured',
  )
})

check('the module is offline, synchronous and offers no grant path', () => {
  const source = readFileSync(
    new URL('../../src/pantheon/v2-decision-points/p8-guardrail.ts', import.meta.url),
    'utf8',
  )
  for (const forbidden of [
    'node:http',
    'node:https',
    'node:net',
    'node:fs',
    'undici',
    'fetch(',
    'await ',
    'setTimeout',
    "hook('execute.before'",
    "hook('permission.evaluate'",
    'throw new Error',
  ]) {
    assert.equal(source.includes(forbidden), false, `module contains ${forbidden}`)
  }
  // No branch assigns or returns `allow` as an effect.
  assert.equal(/effect\s*[:=]\s*['"]allow['"]/.test(source), false, 'grant-shaped assignment')
  assert.equal(/return\s+['"]allow['"]/.test(source), false, 'grant-shaped return')
  // The invariant is stated where the next editor will read it.
  assert.equal(source.includes('execute.before'), true)
  assert.equal(source.includes('PM-09'), true)
})

check('the baseline rank order is deny < ask < allow', () => {
  assert.equal(P8_EFFECT_RANK.deny < P8_EFFECT_RANK.ask, true)
  assert.equal(P8_EFFECT_RANK.ask < P8_EFFECT_RANK.allow, true)
  assert.equal(p8NarrowsOnly('allow', 'deny'), true)
  assert.equal(p8NarrowsOnly('ask', 'deny'), true)
  assert.equal(p8NarrowsOnly('deny', 'deny'), true)
  assert.equal(p8NarrowsOnly('deny', 'allow'), false)
  assert.equal(p8NarrowsOnly('ask', 'allow'), false)
  assert.equal(p8NarrowsOnly('allow', 'unavailable'), false)
})

console.log(
  `V2 decision P8: ${checks} groups passed (${evaluatedCases} evaluations, ${appliedCases} applications)`,
)
