import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  DECISION_PROVIDER_BUDGET_MAPPING,
  DECISION_ROUTER_MODELS,
  DEFAULT_USER_DECISION_ROUTER_CONFIG,
} from '../../scripts/install/decision-router-config.mjs'
import {
  assertDecisionEgressOptIn,
  DECISION_EGRESS_DEFAULT,
  DECISION_EGRESS_EXERCISED_PATHS,
  DECISION_EGRESS_TRANSPORT,
  findUnverifiedEgressEndpoints,
  resolveDecisionEgress,
  v2DecisionEgressMaySend,
} from '../../src/pantheon/decision-egress.ts'
import { DECISION_PROVIDER_ADAPTERS } from '../../src/pantheon/local-decision-provider-matrix.ts'

const OPENAI = { provider: 'openai-decisions', model: 'gpt-6-luna' }
const JEV = { provider: 'typesafe-jev', model: 'jev-1.14.0' }

function enabledConfig(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 2,
    enabled: true,
    selection: { mode: 'explicit', provider: OPENAI.provider, model: OPENAI.model },
    egress_consent: true,
    enabled_candidates: [OPENAI],
    ...overrides,
  }
}

/** Phase 7 gate: egress is opt-in and the default is off. */
test('the default posture is off and nothing may send without an explicit opt-in', () => {
  assert.equal(DECISION_EGRESS_DEFAULT, 'off')

  const defaults = resolveDecisionEgress(DEFAULT_USER_DECISION_ROUTER_CONFIG)
  assert.deepEqual(defaults, { mode: 'off', reason: 'DISABLED', candidates: 0 })
  assert.equal(v2DecisionEgressMaySend(defaults), false)
  assert.throws(() => assertDecisionEgressOptIn(defaults), /Decision egress is off \(DISABLED\)/)

  // Enablement alone, consent alone, and a local selection all stay off.
  assert.equal(
    resolveDecisionEgress(enabledConfig({ enabled: false }), [OPENAI]).reason,
    'DISABLED',
  )
  assert.equal(
    resolveDecisionEgress(enabledConfig({ egress_consent: false }), [OPENAI]).reason,
    'CONSENT_MISSING',
  )
  assert.equal(
    resolveDecisionEgress(enabledConfig({ selection: { mode: 'local' } }), [OPENAI]).reason,
    'LOCAL_SELECTION',
  )
  // Consent without a cap-eligible candidate is still off.
  assert.equal(resolveDecisionEgress(enabledConfig(), []).reason, 'NO_ELIGIBLE_CANDIDATE')
})

test('only an explicit opt-in with one eligible candidate may send', () => {
  const state = resolveDecisionEgress(enabledConfig(), [OPENAI])
  assert.deepEqual(state, {
    mode: 'opt-in',
    reason: 'EXPLICIT_OPT_IN',
    provider: OPENAI.provider,
    candidate: OPENAI,
  })
  assert.equal(v2DecisionEgressMaySend(state), true)
  assert.doesNotThrow(() => assertDecisionEgressOptIn(state))

  // A selection that is not the eligible candidate stays off.
  assert.equal(
    resolveDecisionEgress(enabledConfig({ selection: { mode: 'explicit', ...JEV } }), [OPENAI])
      .reason,
    'NO_ELIGIBLE_CANDIDATE',
  )
})

/** D5 at the egress layer: 0, 1 and 2+ Auto candidates are three outcomes. */
test('Auto cardinality is explicit: none, single and ambiguous are distinct', () => {
  const auto = enabledConfig({ selection: { mode: 'auto' } })

  assert.deepEqual(resolveDecisionEgress(auto, []), {
    mode: 'off',
    reason: 'NO_ELIGIBLE_CANDIDATE',
    candidates: 0,
  })
  assert.equal(resolveDecisionEgress(auto, [OPENAI]).reason, 'EXPLICIT_OPT_IN')
  assert.deepEqual(
    resolveDecisionEgress(
      enabledConfig({ selection: { mode: 'auto' }, enabled_candidates: [OPENAI, JEV] }),
      [OPENAI, JEV],
    ),
    { mode: 'off', reason: 'AMBIGUOUS_CANDIDATES', candidates: 2 },
  )
})

/** D11: the endpoints are retained inert, and the removed gateway is not in the router. */
test('provider endpoints are declared unwired and no gateway provider reaches egress', () => {
  assert.equal(DECISION_EGRESS_TRANSPORT.wired, false)
  assert.equal(DECISION_EGRESS_TRANSPORT.wireStatus, 'unwired')
  assert.match(DECISION_EGRESS_TRANSPORT.note, /never claims the transport was removed/)
  for (const endpoint of DECISION_EGRESS_TRANSPORT.endpoints) {
    assert.match(endpoint, /^https:\/\//)
  }
  assert.ok(DECISION_EGRESS_TRANSPORT.endpoints.includes('https://api.openai.com/v1/decisions'))
  assert.ok(
    DECISION_EGRESS_TRANSPORT.endpoints.some((endpoint) => {
      const parsed = new URL(endpoint)
      return (
        parsed.protocol === 'https:' &&
        parsed.hostname === 'api.typesafe.ai' &&
        parsed.pathname === '/v1/systemone'
      )
    }),
  )

  const removedGateway = 'bifrost'
  assert.deepEqual(
    Object.keys(DECISION_ROUTER_MODELS).filter((id) => id.toLowerCase().includes(removedGateway)),
    [],
  )
  assert.deepEqual(
    Object.keys(DECISION_PROVIDER_BUDGET_MAPPING).filter((id) =>
      id.toLowerCase().includes(removedGateway),
    ),
    [],
  )
  for (const provider of ['opencode-console-jev', 'opencode-console-jev-free']) {
    assert.match(DECISION_PROVIDER_ADAPTERS[provider].model, /^jev-1\.13/)
  }
})

/**
 * C10: an endpoint that is not provably wired must be ASSERTED unwired. This
 * fails on a declared endpoint that is neither declared `unwired` nor covered by
 * an exercised path, and on a `wired` claim with no measurement behind it.
 *
 * Verification covers only the paths a probe exercised — none — so no endpoint
 * may be reported as wired. `permission.evaluate.egress` is likewise unreachable
 * in the probed host: a tool declaring that permission registers but is never
 * advertised to the provider (PROBE-F §3.9).
 */
test('a declared endpoint is either asserted unwired or exercised, never silently unverified', () => {
  const declared = [...DECISION_EGRESS_TRANSPORT.endpoints]
  assert.equal(declared.length, 3)
  assert.deepEqual([...DECISION_EGRESS_EXERCISED_PATHS], [], 'no probe issued a request')

  for (const endpoint of declared) {
    assert.ok(
      Object.hasOwn(DECISION_EGRESS_TRANSPORT.endpointWireStatus, endpoint),
      `${endpoint} declares no wire status`,
    )
    assert.equal(DECISION_EGRESS_TRANSPORT.endpointWireStatus[endpoint], 'unwired', endpoint)
  }
  // The exercised-path list may only name declared endpoints.
  for (const path of DECISION_EGRESS_EXERCISED_PATHS) {
    assert.ok(declared.includes(path), `${path} is claimed as exercised but is not declared`)
  }
  assert.deepEqual(
    [
      ...findUnverifiedEgressEndpoints(
        declared,
        DECISION_EGRESS_TRANSPORT.endpointWireStatus,
        DECISION_EGRESS_EXERCISED_PATHS,
      ),
    ],
    [],
    'every declared endpoint must be asserted unwired or exercised',
  )

  // The check itself must fail closed, or the assertion above proves nothing.
  const missing = 'https://example.test/missing-status'
  const unproven = 'https://example.test/unproven-wire'
  assert.deepEqual([...findUnverifiedEgressEndpoints([missing], {}, [])], [missing])
  assert.deepEqual(
    [...findUnverifiedEgressEndpoints([unproven], { [unproven]: 'wired' }, [])],
    [unproven],
  )
  assert.deepEqual(
    [...findUnverifiedEgressEndpoints([unproven], { [unproven]: 'wired' }, [unproven])],
    [],
  )
  assert.deepEqual([...findUnverifiedEgressEndpoints([missing], { [missing]: 'unwired' }, [])], [])
})
