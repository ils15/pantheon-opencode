import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  DECISION_PROVIDER_BUDGET_MAPPING,
  DECISION_ROUTER_MODELS,
  DEFAULT_USER_DECISION_ROUTER_CONFIG,
} from '../../scripts/install/decision-router-config.mjs'
import { DECISION_PROVIDER_ADAPTERS } from '../../src/pantheon/local-decision-provider-matrix.ts'
import {
  assertV2DecisionEgressOptIn,
  resolveV2DecisionEgress,
  V2_DECISION_EGRESS_DEFAULT,
  V2_DECISION_EGRESS_TRANSPORT,
  v2DecisionEgressMaySend,
} from '../../src/pantheon/v2-decision-egress.ts'

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
  assert.equal(V2_DECISION_EGRESS_DEFAULT, 'off')

  const defaults = resolveV2DecisionEgress(DEFAULT_USER_DECISION_ROUTER_CONFIG)
  assert.deepEqual(defaults, { mode: 'off', reason: 'DISABLED', candidates: 0 })
  assert.equal(v2DecisionEgressMaySend(defaults), false)
  assert.throws(() => assertV2DecisionEgressOptIn(defaults), /Decision egress is off \(DISABLED\)/)

  // Enablement alone, consent alone, and a local selection all stay off.
  assert.equal(
    resolveV2DecisionEgress(enabledConfig({ enabled: false }), [OPENAI]).reason,
    'DISABLED',
  )
  assert.equal(
    resolveV2DecisionEgress(enabledConfig({ egress_consent: false }), [OPENAI]).reason,
    'CONSENT_MISSING',
  )
  assert.equal(
    resolveV2DecisionEgress(enabledConfig({ selection: { mode: 'local' } }), [OPENAI]).reason,
    'LOCAL_SELECTION',
  )
  // Consent without a cap-eligible candidate is still off.
  assert.equal(resolveV2DecisionEgress(enabledConfig(), []).reason, 'NO_ELIGIBLE_CANDIDATE')
})

test('only an explicit opt-in with one eligible candidate may send', () => {
  const state = resolveV2DecisionEgress(enabledConfig(), [OPENAI])
  assert.deepEqual(state, {
    mode: 'opt-in',
    reason: 'EXPLICIT_OPT_IN',
    provider: OPENAI.provider,
    candidate: OPENAI,
  })
  assert.equal(v2DecisionEgressMaySend(state), true)
  assert.doesNotThrow(() => assertV2DecisionEgressOptIn(state))

  // A selection that is not the eligible candidate stays off.
  assert.equal(
    resolveV2DecisionEgress(enabledConfig({ selection: { mode: 'explicit', ...JEV } }), [OPENAI])
      .reason,
    'NO_ELIGIBLE_CANDIDATE',
  )
})

/** D5 at the egress layer: 0, 1 and 2+ Auto candidates are three outcomes. */
test('Auto cardinality is explicit: none, single and ambiguous are distinct', () => {
  const auto = enabledConfig({ selection: { mode: 'auto' } })

  assert.deepEqual(resolveV2DecisionEgress(auto, []), {
    mode: 'off',
    reason: 'NO_ELIGIBLE_CANDIDATE',
    candidates: 0,
  })
  assert.equal(resolveV2DecisionEgress(auto, [OPENAI]).reason, 'EXPLICIT_OPT_IN')
  assert.deepEqual(
    resolveV2DecisionEgress(
      enabledConfig({ selection: { mode: 'auto' }, enabled_candidates: [OPENAI, JEV] }),
      [OPENAI, JEV],
    ),
    { mode: 'off', reason: 'AMBIGUOUS_CANDIDATES', candidates: 2 },
  )
})

/** D11: the endpoints are retained inert, and the removed gateway is not in the router. */
test('provider endpoints are declared unwired and no gateway provider reaches egress', () => {
  assert.equal(V2_DECISION_EGRESS_TRANSPORT.wired, false)
  assert.equal(V2_DECISION_EGRESS_TRANSPORT.wireStatus, 'unwired')
  assert.match(V2_DECISION_EGRESS_TRANSPORT.note, /never claims the transport was removed/)
  for (const endpoint of V2_DECISION_EGRESS_TRANSPORT.endpoints) {
    assert.match(endpoint, /^https:\/\//)
  }
  assert.ok(V2_DECISION_EGRESS_TRANSPORT.endpoints.includes('https://api.openai.com/v1/decisions'))
  assert.ok(
    V2_DECISION_EGRESS_TRANSPORT.endpoints.some((endpoint) => {
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
    assert.equal(DECISION_PROVIDER_ADAPTERS[provider].egressEligible, false)
  }
})
