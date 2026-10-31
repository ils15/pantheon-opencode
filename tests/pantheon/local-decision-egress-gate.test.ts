import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DECISION_ROUTER_MODELS,
  writeUserDecisionRouterConfig,
} from '../../scripts/install/decision-router-config.mjs'
import {
  openLocalDecisionBudgetLedger,
  resolveLocalDecisionBudgetDbPath,
} from '../../src/pantheon/local-decision-budget.ts'
import {
  assertDecisionEgressPermission,
  buildDecisionEgressRequest,
  DECISION_EGRESS_ACTION,
  DECISION_EGRESS_SOURCE_PREFIX,
  isDecisionAssertionDenial,
  resolveDecisionEgressConsent,
} from '../../src/pantheon/local-decision-egress-gate.ts'
import {
  buildDecisionPayload,
  runProviderDecision,
} from '../../src/pantheon/local-decision-provider.internal.ts'

const CURRENT_PERIOD = new Date().toISOString().slice(0, 7)
const CAPS = { monthlyCapMicros: 5_000_000, perDecisionCapMicros: 1_000_000 }
const ENDPOINT = 'https://api.typesafe.ai/v1/systemone'
const PROVIDER = 'typesafe-jev'

interface TestEnvironment {
  root: string
  config: string
  state: string
}

function sandbox(): TestEnvironment {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-decision-egress-'))
  return { root, config: join(root, 'config'), state: join(root, 'state') }
}

async function withEnvironment(
  environment: TestEnvironment,
  run: () => Promise<void>,
): Promise<void> {
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'TYPESAFE_API_KEY'] as const
  const previous = new Map<string, string | undefined>()
  for (const key of keys) previous.set(key, process.env[key])
  process.env.HOME = environment.root
  process.env.XDG_CONFIG_HOME = environment.config
  process.env.XDG_STATE_HOME = environment.state
  process.env.TYPESAFE_API_KEY = 'synthetic-test-only-key'
  const originalFetch = globalThis.fetch
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
    for (const key of keys) {
      const value = previous.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(environment.root, { recursive: true, force: true })
  }
}

function writeEnabledConfig({ consent = true }: { consent?: boolean } = {}): void {
  const model = DECISION_ROUTER_MODELS[PROVIDER][0] as string
  writeUserDecisionRouterConfig({
    schema_version: 2,
    enabled: true,
    selection: { mode: 'explicit', provider: PROVIDER, model },
    egress_consent: consent,
    enabled_candidates: [{ provider: PROVIDER, model }],
  })
}

function confirmCaps(): void {
  const model = DECISION_ROUTER_MODELS[PROVIDER][0] as string
  const ledger = openLocalDecisionBudgetLedger({ dbPath: resolveLocalDecisionBudgetDbPath() })
  try {
    ledger.configureUserCaps(CAPS)
    ledger.configureProviderCaps(PROVIDER, CAPS)
    ledger.configureModelCaps(PROVIDER, model, CAPS)
    assert.equal(ledger.confirmBudgetPeriod(null, CURRENT_PERIOD).status, 'confirmed')
  } finally {
    ledger.close()
  }
}

function payload() {
  return buildDecisionPayload({
    request: 'implement a backend endpoint',
    skillIds: ['tdd-with-agents'],
  })
}

function testRequestShape(): void {
  const request = buildDecisionEgressRequest({
    sessionID: 'ses-egress',
    messageID: 'msg-egress',
    endpoint: ENDPOINT,
  })
  assert.equal(request.action, DECISION_EGRESS_ACTION)
  assert.deepEqual(request.resources, [ENDPOINT])
  assert.deepEqual(request.save, [])
  assert.deepEqual(request.source, {
    type: 'tool',
    id: `${DECISION_EGRESS_SOURCE_PREFIX}ses-egress:msg-egress`,
    messageID: 'msg-egress',
  })
  assert.equal(Object.hasOwn(request, 'agent'), false, 'agent is never fabricated')
  assert.equal(
    buildDecisionEgressRequest({
      sessionID: 'ses-egress',
      messageID: 'msg-egress',
      endpoint: ENDPOINT,
      agent: 'hermes',
    }).agent,
    'hermes',
    'a known agent is forwarded',
  )
}

async function testAssertContract(): Promise<void> {
  const request = buildDecisionEgressRequest({
    sessionID: 'ses-egress',
    messageID: 'msg-egress',
    endpoint: ENDPOINT,
  })

  // Measured host contract: deny throws, allow resolves undefined.
  assert.equal(
    await assertDecisionEgressPermission(async () => {
      throw new Error('Permission denied: decision.egress')
    }, request),
    'deny',
    'a thrown host denial is a deny',
  )
  assert.equal(
    await assertDecisionEgressPermission(async () => undefined, request),
    'allow',
    'the host allow path resolves undefined',
  )

  // Defensive shapes for a host that returns the decision instead of throwing.
  assert.equal(
    await assertDecisionEgressPermission(async () => ({ effect: 'deny' }), request),
    'deny',
  )
  assert.equal(
    await assertDecisionEgressPermission(async () => ({ decision: 'rejected' }), request),
    'deny',
  )
  assert.equal(
    await assertDecisionEgressPermission(async () => ({ status: 'denied' }), request),
    'deny',
  )
  assert.equal(await assertDecisionEgressPermission(async () => false, request), 'deny')
  assert.equal(
    await assertDecisionEgressPermission(async () => ({ effect: 'allow' }), request),
    'allow',
  )
  assert.equal(
    await assertDecisionEgressPermission(async () => ({ id: 'req-1' }), request),
    'allow',
  )

  // The host words a denial as prose. A returned host denial — bare string or
  // wrapped in `message`/`error` — must still be a deny, and an `ok: false`
  // envelope is a deny too.
  assert.equal(
    await assertDecisionEgressPermission(async () => 'Permission denied: decision.egress', request),
    'deny',
    'a returned host denial message is a deny',
  )
  assert.equal(
    await assertDecisionEgressPermission(
      async () => ({ message: 'Permission denied: decision.egress' }),
      request,
    ),
    'deny',
    'a denial carried in `message` is a deny',
  )
  assert.equal(
    await assertDecisionEgressPermission(async () => ({ error: 'forbidden' }), request),
    'deny',
    'a denial carried in `error` is a deny',
  )
  assert.equal(
    await assertDecisionEgressPermission(async () => ({ ok: false }), request),
    'deny',
    'an ok:false envelope is a deny',
  )
  assert.equal(
    await assertDecisionEgressPermission(async () => ({ ok: true, message: 'allowed' }), request),
    'allow',
    'a permissive envelope is not mistaken for a denial',
  )
  assert.equal(isDecisionAssertionDenial(null), false)
  assert.equal(isDecisionAssertionDenial('deny'), true)
  assert.equal(isDecisionAssertionDenial('Permission denied: decision.egress'), true)
  assert.equal(isDecisionAssertionDenial('not allowed by policy'), true)
  assert.equal(isDecisionAssertionDenial('blocked by policy'), true)
  assert.equal(isDecisionAssertionDenial('not blocked'), false, 'a negated block is not a denial')
  assert.equal(isDecisionAssertionDenial({ status: 'allow', message: 'not blocked' }), false)
  assert.equal(isDecisionAssertionDenial({ status: 'allow', message: 'ok' }), false)
}

async function testConsentGateMatrix(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    const unconfigured = resolveDecisionEgressConsent()
    assert.equal(unconfigured.ok, false)
    assert.equal(unconfigured.ok ? null : unconfigured.reasonCode, 'DISABLED')

    writeEnabledConfig({ consent: false })
    const noConsent = resolveDecisionEgressConsent()
    assert.equal(noConsent.ok, false)
    assert.equal(noConsent.ok ? null : noConsent.reasonCode, 'CONSENT_MISSING')

    writeUserDecisionRouterConfig({
      schema_version: 2,
      enabled: true,
      selection: { mode: 'local' },
      egress_consent: false,
      enabled_candidates: [],
    })
    const localMode = resolveDecisionEgressConsent()
    assert.equal(localMode.ok, false)
    assert.equal(localMode.ok ? null : localMode.reasonCode, 'CONSENT_MISSING')

    writeEnabledConfig()
    const uncapped = resolveDecisionEgressConsent()
    assert.equal(uncapped.ok, false, 'no confirmed caps means no eligible candidate')
    assert.equal(uncapped.ok ? null : uncapped.reasonCode, 'NO_ELIGIBLE_CANDIDATE')

    confirmCaps()
    const allowed = resolveDecisionEgressConsent()
    assert.equal(allowed.ok, true)
    assert.equal(allowed.ok ? allowed.selected.provider : null, PROVIDER)
    assert.equal(allowed.ok ? allowed.selected.adapter.endpoint : null, ENDPOINT)
  })
}

async function testRunnerRefusesBeforeAssert(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    let fetchCalls = 0
    let assertCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      throw new Error('egress must stay off')
    }) as typeof fetch
    const permissionAssert = async () => {
      assertCalls += 1
    }

    const disabled = await runProviderDecision({
      payload: payload(),
      permissionAssert,
      sessionID: 'ses-egress',
      messageID: 'msg-egress',
    })
    assert.equal(disabled.status, 'fallback')
    assert.equal(disabled.reasonCode, 'DISABLED')
    assert.equal(assertCalls, 0, 'the host is not asked when config forbids egress')
    assert.equal(fetchCalls, 0)

    writeEnabledConfig()
    const uncapped = await runProviderDecision({
      payload: payload(),
      permissionAssert,
      sessionID: 'ses-egress',
      messageID: 'msg-egress',
    })
    assert.equal(uncapped.reasonCode, 'NO_ELIGIBLE_CANDIDATE')
    assert.equal(assertCalls, 0, 'the host is not asked without a cap-valid candidate')
    assert.equal(fetchCalls, 0)

    writeEnabledConfig({ consent: false })
    const noConsent = await runProviderDecision({
      payload: payload(),
      permissionAssert,
      sessionID: 'ses-egress',
      messageID: 'msg-egress',
    })
    assert.equal(noConsent.reasonCode, 'CONSENT_MISSING')
    assert.equal(assertCalls, 0)
    assert.equal(fetchCalls, 0)
  })
}

async function testDeniedAssertionMeansZeroFetch(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    writeEnabledConfig()
    confirmCaps()
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      throw new Error('egress must stay off')
    }) as typeof fetch

    const thrown = await runProviderDecision({
      payload: payload(),
      permissionAssert: async () => {
        throw new Error('Permission denied: decision.egress')
      },
      sessionID: 'ses-egress',
      messageID: 'msg-egress',
    })
    assert.equal(thrown.status, 'fallback')
    assert.equal(thrown.reasonCode, 'PERMISSION_DENIED')
    assert.equal(fetchCalls, 0, 'a thrown host denial blocks egress')

    const returned = await runProviderDecision({
      payload: payload(),
      permissionAssert: async () => ({ effect: 'deny' }),
      sessionID: 'ses-egress',
      messageID: 'msg-egress',
    })
    assert.equal(returned.reasonCode, 'PERMISSION_DENIED')
    assert.equal(fetchCalls, 0, 'a returned denial blocks egress')

    const missing = await runProviderDecision({
      payload: payload(),
      sessionID: 'ses-egress',
      messageID: 'msg-egress',
    })
    assert.equal(missing.reasonCode, 'PERMISSION_UNAVAILABLE')
    assert.equal(fetchCalls, 0)
  })
}

async function testAllowedAssertionReachesExactlyOneFetch(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    writeEnabledConfig()
    confirmCaps()
    const assertions: Array<Record<string, unknown>> = []
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      throw new Error('transport fails after the request is attempted')
    }) as typeof fetch

    const result = await runProviderDecision({
      payload: payload(),
      // Resolving is the host's allow path; it is the only observable allow.
      permissionAssert: async (input) => {
        assertions.push(input)
        return undefined
      },
      sessionID: 'ses-egress',
      messageID: 'msg-egress',
    })

    assert.equal(fetchCalls, 1, 'consent + caps + non-denying assert reach transport once')
    assert.equal(result.status, 'fallback')
    assert.equal(result.reasonCode, 'TRANSPORT_FAILED', 'the probe fetch fails after egress starts')
    assert.equal(assertions.length, 1)
    assert.equal(assertions[0]?.action, DECISION_EGRESS_ACTION)
    assert.deepEqual(assertions[0]?.resources, [ENDPOINT])
    assert.equal(assertions[0]?.sessionID, 'ses-egress')
  })
}

await testRequestShape()
await testAssertContract()
await testConsentGateMatrix()
await testRunnerRefusesBeforeAssert()
await testDeniedAssertionMeansZeroFetch()
await testAllowedAssertionReachesExactlyOneFetch()
