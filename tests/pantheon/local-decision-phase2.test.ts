import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  DECISION_PROVIDER_BUDGET_MAPPING,
  DECISION_ROUTER_MODELS,
  REMOTELY_ELIGIBLE_DECISION_PROVIDERS,
  readUserDecisionRouterConfig,
  writeUserDecisionRouterConfig,
} from '../../scripts/install/decision-router-config.mjs'
import {
  hasDelegationSignal,
  recommendLocalDecisionAgent,
} from '../../src/pantheon/local-decision-agents.ts'
import {
  LOCAL_DECISION_BUDGET_PROVIDERS,
  openLocalDecisionBudgetLedger,
  resolveLocalDecisionBudgetDbPath,
} from '../../src/pantheon/local-decision-budget.ts'
import {
  applyDecisionRouterToPrompt,
  applyTurnDecisionToPrompt,
} from '../../src/pantheon/local-decision-prompt.ts'
import {
  buildDecisionPayload,
  DECISION_PROVIDER_ADAPTERS,
  parseProviderDecision,
  runProviderDecision,
} from '../../src/pantheon/local-decision-provider.internal.ts'
import {
  PROVIDER_MAX_RESPONSE_BYTES,
  PROVIDER_REQUEST_TIMEOUT_MS,
} from '../../src/pantheon/local-decision-provider-matrix.ts'
import { selectPantheonSkills } from '../../src/pantheon/local-decision-skills.ts'
import {
  clearTurnDecisionCache,
  decideForTurn,
  type TurnDecision,
} from '../../src/pantheon/local-decision-turn.ts'
import {
  clearLocalDecisionPolicyCache,
  type LocalDecisionPolicy,
  loadLocalDecisionPolicy,
} from '../../src/pantheon/local-orchestration.ts'
import {
  PANTHEON_AGENT_IDS,
  PANTHEON_SKILL_CATALOG,
  PANTHEON_SKILL_IDS,
} from '../../src/pantheon/pantheon-decision-catalog.ts'

const CURRENT_PERIOD = new Date().toISOString().slice(0, 7)
const CAPS = { monthlyCapMicros: 5_000_000, perDecisionCapMicros: 1_000_000 }
const KEY_NAMES = ['OPENAI_API_KEY', 'TYPESAFE_API_KEY', 'OPENCODE_API_KEY'] as const

interface TestEnvironment {
  root: string
  home: string
  config: string
  state: string
}

function sandbox(): TestEnvironment {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-decision-phase2-'))
  return {
    root,
    home: root,
    config: join(root, 'config'),
    state: join(root, 'state'),
  }
}

async function withEnvironment(
  environment: TestEnvironment,
  run: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>()
  const values: Record<string, string | undefined> = {
    HOME: environment.home,
    XDG_CONFIG_HOME: environment.config,
    XDG_STATE_HOME: environment.state,
    TYPESAFE_API_KEY: 'synthetic-test-only-key',
    OPENAI_API_KEY: 'synthetic-test-only-key',
    OPENCODE_API_KEY: undefined,
  }
  for (const key of [...KEY_NAMES, 'HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']) {
    previous.set(key, process.env[key])
  }
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  const originalFetch = globalThis.fetch
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(environment.root, { recursive: true, force: true })
  }
}

function writeEnabledConfig(provider: 'typesafe-jev' | 'openai-decisions' = 'typesafe-jev') {
  const model = DECISION_ROUTER_MODELS[provider][0] as string
  writeUserDecisionRouterConfig({
    schema_version: 2,
    enabled: true,
    selection: { mode: 'explicit', provider, model },
    egress_consent: true,
    enabled_candidates: [{ provider, model }],
  })
}

function confirmCaps(provider: 'typesafe-jev' | 'openai-decisions') {
  const model = DECISION_ROUTER_MODELS[provider][0] as string
  const ledger = openLocalDecisionBudgetLedger({ dbPath: resolveLocalDecisionBudgetDbPath() })
  try {
    ledger.configureUserCaps(CAPS)
    ledger.configureProviderCaps(provider, CAPS)
    ledger.configureModelCaps(provider, model, CAPS)
    assert.equal(ledger.confirmBudgetPeriod(null, CURRENT_PERIOD).status, 'confirmed')
  } finally {
    ledger.close()
  }
}

/**
 * Stand-in for the host `permission.assert` capability. The host's allow path
 * resolves `undefined`; only a throw (or an explicit denial marker) denies.
 * Consent and caps are enforced by the config gate, not by this stub.
 */
async function permissionStub(_input: Record<string, unknown>): Promise<void> {}

function probabilities(
  choices: readonly string[],
  selected: string | null,
): Record<string, number> {
  const record: Record<string, number> = {}
  const ids = choices.filter((choice) => choice !== 'abstain')
  if (selected === null) {
    record.abstain = 0.8
    const share = ids.length === 0 ? 0 : 0.2 / ids.length
    for (const id of ids) record[id] = share
    return record
  }
  record[selected] = 0.8
  record.abstain = 0.1
  const others = ids.filter((id) => id !== selected)
  const share = others.length === 0 ? 0 : 0.1 / others.length
  for (const id of others) record[id] = share
  if (others.length === 0) record.abstain = 0.2
  return record
}

function systemOneResponse(
  requestBody: Record<string, unknown>,
  skill: string | null,
  agent: string | null,
  overrides: Record<string, unknown> = {},
) {
  const state = requestBody.state as
    | { skills?: Array<{ id: string }>; agents?: Array<{ id: string }> }
    | undefined
  const skillChoices = [...(state?.skills ?? []).map((entry) => entry.id), 'abstain']
  const answers: Record<string, unknown> = {
    skill: {
      type: 'choice',
      choice: skill ?? 'abstain',
      confidence: 0.9,
      probabilities: probabilities(skillChoices, skill),
    },
  }
  if (state?.agents !== undefined) {
    const agentChoices = [...state.agents.map((entry) => entry.id), 'abstain']
    answers.agent = {
      type: 'choice',
      choice: agent ?? 'abstain',
      confidence: 0.9,
      probabilities: probabilities(agentChoices, agent),
    }
  }
  return {
    model: 'jev-1.14.0',
    answers,
    usage: { input_tokens: 1_000, output_tokens: 10 },
    ...overrides,
  }
}

function openAiResponse(
  requestBody: Record<string, unknown>,
  skill: string | null,
  agent: string | null,
) {
  const input = requestBody.input as Array<{
    content: Array<{ data: { skills: Array<{ id: string }>; agents?: Array<{ id: string }> } }>
  }>
  const state = input[0]?.content[0]?.data
  assert.ok(state)
  const skillChoices = [...state.skills.map((entry) => entry.id), 'abstain']
  const skillProbabilities = probabilities(skillChoices, skill)
  const answers: Array<Record<string, unknown>> = [
    {
      type: 'choice',
      name: 'skill',
      choice: skill ?? 'abstain',
      confidence: 0.9,
      probabilities: skillChoices.map((value) => ({
        value,
        probability: skillProbabilities[value],
      })),
    },
  ]
  if (state.agents !== undefined) {
    const agentChoices = [...state.agents.map((entry) => entry.id), 'abstain']
    const agentProbabilities = probabilities(agentChoices, agent)
    answers.push({
      type: 'choice',
      name: 'agent',
      choice: agent ?? 'abstain',
      confidence: 0.9,
      probabilities: agentChoices.map((value) => ({
        value,
        probability: agentProbabilities[value],
      })),
    })
  }
  return {
    model: 'gpt-6-luna',
    answers,
    usage: {
      input_tokens: 1_000,
      output_tokens: 10,
      total_tokens: 1_010,
      input_tokens_details: { cache_write_tokens: 0, cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  }
}

function responseWith(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function samplePolicy(overrides: Partial<LocalDecisionPolicy> = {}): LocalDecisionPolicy {
  return {
    agents: {
      zeus: {
        canDelegateTo: ['hermes', 'aphrodite'],
        canReceiveDelegation: true,
        capabilities: [],
        skills: [],
      },
      hermes: {
        canDelegateTo: [],
        canReceiveDelegation: true,
        capabilities: [],
        skills: [],
      },
      aphrodite: {
        canDelegateTo: [],
        canReceiveDelegation: true,
        capabilities: [],
        skills: [],
      },
    },
    permissionTask: { '*': 'allow' },
    ...overrides,
  }
}

function testCatalogAndSkillSelection(): void {
  assert.equal(PANTHEON_SKILL_CATALOG.length, 20)
  assert.equal(PANTHEON_AGENT_IDS.size, 14)
  const request = 'Please implement the FastAPI endpoint with pytest and a database migration.'
  const first = selectPantheonSkills(request)
  const second = selectPantheonSkills(request)
  assert.deepEqual(first, second)
  assert.ok(first.skillIds.length > 0)
  assert.ok(first.skillIds.length <= 4)
  assert.ok(first.skillIds.length < PANTHEON_SKILL_CATALOG.length)
  assert.ok(first.skillIds.every((id) => PANTHEON_SKILL_IDS.has(id)))
  assert.deepEqual(selectPantheonSkills('').skillIds, [])
  assert.equal(selectPantheonSkills('qwertyuiop').reasonCode, 'NO_LOCAL_MATCH')
}

function testAgentRecommendationOnlyUsesEligibleCandidates(): void {
  const policy = samplePolicy()
  assert.equal(hasDelegationSignal('implement a FastAPI backend endpoint'), true)
  assert.equal(hasDelegationSignal('write a short poem'), false)
  assert.equal(
    recommendLocalDecisionAgent('implement a FastAPI backend endpoint', policy).agent,
    'hermes',
  )
  const deniedPolicy = samplePolicy({
    permissionTask: { '*': 'allow', hermes: 'deny' },
  })
  assert.equal(
    recommendLocalDecisionAgent('implement a FastAPI backend endpoint', deniedPolicy).agent,
    null,
  )
  const noGrant = samplePolicy({
    agents: {
      ...policy.agents,
      zeus: { ...policy.agents.zeus, canDelegateTo: ['aphrodite'] },
    },
  })
  assert.equal(
    recommendLocalDecisionAgent('implement a FastAPI backend endpoint', noGrant).agent,
    null,
  )
  const noSignal = recommendLocalDecisionAgent('write a short poem', policy)
  assert.equal(noSignal.agent, null)
  assert.equal(noSignal.reasonCode, 'NO_DELEGATION_SIGNAL')
}

function testPayloadIsExactAndAllowlisted(): void {
  const payload = buildDecisionPayload({
    request: '  implement a backend endpoint  ',
    skillIds: ['tdd-with-agents', 'simplify'],
    agentIds: ['hermes'],
  })
  assert.ok(payload)
  assert.deepEqual(Object.keys(payload).sort(), ['agents', 'request', 'skills'])
  assert.equal(payload.request, 'implement a backend endpoint')
  assert.deepEqual(
    payload.skills.map((entry) => entry.id),
    ['simplify', 'tdd-with-agents'],
  )
  assert.deepEqual(
    payload.agents?.map((entry) => entry.id),
    ['hermes'],
  )
  assert.equal(buildDecisionPayload({ request: 'x', skillIds: ['not-a-skill'] }), null)
  assert.equal(
    buildDecisionPayload({ request: 'x', skillIds: ['simplify'], agentIds: ['zeus'] }),
    null,
  )
  assert.equal(buildDecisionPayload({ request: 'x'.repeat(12_001), skillIds: ['simplify'] }), null)
  assert.equal(
    buildDecisionPayload({
      request: `deploy with token ${'sk-'}${'abcdefghijklmnopqrstuvwx'}`,
      skillIds: ['simplify'],
    }),
    null,
    'a high-confidence credential never leaves the process',
  )
  for (const id of ['files', 'transcript', 'memory', 'system', 'messages']) {
    assert.equal(Object.hasOwn(payload as unknown as Record<string, unknown>, id), false)
  }
}

function testProviderMatrixIsSingleAndFailClosed(): void {
  assert.deepEqual(
    DECISION_PROVIDER_ADAPTERS['typesafe-jev'].accountingProvider,
    DECISION_PROVIDER_BUDGET_MAPPING['typesafe-jev'],
  )
  for (const [provider, mapping] of Object.entries(DECISION_PROVIDER_BUDGET_MAPPING)) {
    assert.ok(LOCAL_DECISION_BUDGET_PROVIDERS.includes(mapping as never), provider)
  }
  assert.deepEqual(REMOTELY_ELIGIBLE_DECISION_PROVIDERS, ['openai-decisions', 'typesafe-jev'])
  assert.equal(DECISION_PROVIDER_ADAPTERS['opencode-console-jev'].egressEligible, false)
  assert.equal(DECISION_PROVIDER_ADAPTERS['opencode-console-jev-free'].egressEligible, false)
  assert.equal(runProviderDecision.length, 1, 'the runner accepts only one capability object')
}

async function testNoConfigMeansZeroFetch(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      throw new Error('egress blocked')
    }) as typeof fetch
    const result = await runProviderDecision({
      payload: buildDecisionPayload({ request: 'test', skillIds: ['simplify'] }),
      permissionAssert: permissionStub,
      sessionID: 'ses-test',
      messageID: 'msg-test',
    })
    assert.equal(result.status, 'fallback')
    assert.equal(result.reasonCode, 'DISABLED')
    assert.equal(fetchCalls, 0)
  })
}

async function testNoCapOrPermissionMeansZeroFetch(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    writeEnabledConfig('typesafe-jev')
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      throw new Error('egress blocked')
    }) as typeof fetch
    const payload = buildDecisionPayload({
      request: 'implement a backend endpoint',
      skillIds: ['tdd-with-agents'],
    })
    const noCaps = await runProviderDecision({
      payload,
      permissionAssert: permissionStub,
      sessionID: 'ses-test',
      messageID: 'msg-no-cap',
    })
    assert.equal(noCaps.reasonCode, 'NO_ELIGIBLE_CANDIDATE')
    assert.equal(fetchCalls, 0)

    confirmCaps('typesafe-jev')
    const denied = await runProviderDecision({
      payload,
      permissionAssert: async () => {
        throw new Error('denied')
      },
      sessionID: 'ses-test',
      messageID: 'msg-denied',
    })
    assert.equal(denied.reasonCode, 'PERMISSION_DENIED')
    assert.equal(fetchCalls, 0)
  })
}

async function testEligibleTurnCallsExactlyOnceAndReconciles(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    writeEnabledConfig('typesafe-jev')
    confirmCaps('typesafe-jev')
    const requests: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      requests.push({ url, init })
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      return responseWith(systemOneResponse(body, 'tdd-with-agents', 'hermes'))
    }) as unknown as typeof fetch
    let permissionCalls = 0
    const payload = buildDecisionPayload({
      request: 'implement a backend endpoint',
      skillIds: ['tdd-with-agents', 'simplify'],
      agentIds: ['hermes'],
    })
    const result = await runProviderDecision({
      payload,
      permissionAssert: async () => {
        permissionCalls += 1
      },
      sessionID: 'ses-test',
      messageID: 'msg-test',
    })
    assert.equal(result.status, 'decided')
    assert.equal(result.provider, 'typesafe-jev')
    assert.deepEqual(result.skillIds, ['tdd-with-agents'])
    assert.equal(result.agent, 'hermes')
    assert.equal(requests.length, 1)
    assert.equal(permissionCalls, 1)
    assert.equal(requests[0]?.url, 'https://api.typesafe.ai/v1/systemone')
    const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>
    assert.equal(body.model, 'jev-1.14.0')
    assert.deepEqual(body.state, payload)
    assert.deepEqual(Object.keys(body.state as Record<string, unknown>).sort(), [
      'agents',
      'request',
      'skills',
    ])
    const ledger = openLocalDecisionBudgetLedger({ dbPath: resolveLocalDecisionBudgetDbPath() })
    try {
      assert.equal(ledger.listUncertainReservations().length, 0)
    } finally {
      ledger.close()
    }
    assert.equal(readUserDecisionRouterConfig().enabled, true)
  })
}

/**
 * The host rejects `source: { type: 'prompt', messageID }` with
 * `SchemaError: Expected Permission.Source`. Mocks that ignore the input never
 * catch that mismatch, so these gates validate the accepted union member.
 */
function assertAcceptedDecisionSource(input: Record<string, unknown>): void {
  assert.equal(input.action, 'decision.egress')
  const source = input.source as Record<string, unknown> | undefined
  assert.equal(source?.type, 'tool', 'assert source must be the host-accepted tool member')
  assert.equal(typeof source?.id, 'string')
  const messageID = source?.messageID
  assert.equal(typeof messageID, 'string')
  assert.equal(source?.id, `pantheon-decision:${input.sessionID}:${messageID}`)
  assert.equal(Array.isArray(input.resources) ? input.resources.length : -1, 1)
}

async function testPermissionAssertUsesAcceptedSourceShape(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    writeEnabledConfig('typesafe-jev')
    confirmCaps('typesafe-jev')
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      return responseWith(systemOneResponse(body, 'tdd-with-agents', null))
    }) as typeof fetch

    const runnerInputs: Array<Record<string, unknown>> = []
    const runnerResult = await runProviderDecision({
      payload: buildDecisionPayload({
        request: 'implement a backend endpoint',
        skillIds: ['tdd-with-agents'],
      }),
      permissionAssert: async (input) => {
        assertAcceptedDecisionSource(input)
        runnerInputs.push(input)
      },
      sessionID: 'ses-source',
      messageID: 'msg-source-runner',
    })
    assert.equal(runnerResult.status, 'decided')
    assert.equal(runnerInputs.length, 1)

    const turnInputs: Array<Record<string, unknown>> = []
    const turnResult = await decideForTurn({
      request: 'implement a backend endpoint with pytest',
      sessionID: 'ses-source-turn',
      messageID: 'msg-source-turn',
      permissionAssert: async (input) => {
        assertAcceptedDecisionSource(input)
        turnInputs.push(input)
      },
    })
    assert.equal(turnResult.source, 'typesafe-jev')
    assert.equal(turnInputs.length, 1)
  })
}

async function testOpenAiProviderUsesFixedEndpointAndPayload(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    writeEnabledConfig('openai-decisions')
    confirmCaps('openai-decisions')
    const requests: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      requests.push({ url, init })
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      return responseWith(openAiResponse(body, 'tdd-with-agents', 'hermes'))
    }) as unknown as typeof fetch
    const payload = buildDecisionPayload({
      request: 'implement a backend endpoint',
      skillIds: ['tdd-with-agents', 'simplify'],
      agentIds: ['hermes'],
    })
    const result = await runProviderDecision({
      payload,
      permissionAssert: permissionStub,
      sessionID: 'ses-openai',
      messageID: 'msg-openai',
    })
    assert.equal(result.status, 'decided')
    assert.equal(result.provider, 'openai-decisions')
    assert.equal(requests[0]?.url, 'https://api.openai.com/v1/decisions')
    const body = JSON.parse(String(requests[0]?.init.body)) as Record<string, unknown>
    assert.equal(body.model, 'gpt-6-luna')
    const input = body.input as Array<{ content: Array<{ type: string; data: unknown }> }>
    assert.equal(input[0]?.content[0]?.type, 'input_json')
    assert.deepEqual(input[0]?.content[0]?.data, payload)
  })
}

async function testUnreconciledUsageKeepsHoldAndFallsBack(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    writeEnabledConfig('typesafe-jev')
    confirmCaps('typesafe-jev')
    let fetchCalls = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      fetchCalls += 1
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      const response = systemOneResponse(body, 'tdd-with-agents', null)
      delete (response as { usage?: unknown }).usage
      return responseWith(response)
    }) as unknown as typeof fetch
    const result = await runProviderDecision({
      payload: buildDecisionPayload({
        request: 'implement a backend endpoint',
        skillIds: ['tdd-with-agents'],
      }),
      permissionAssert: permissionStub,
      sessionID: 'ses-usage',
      messageID: 'msg-usage',
    })
    assert.equal(result.status, 'fallback')
    assert.equal(result.reasonCode, 'USAGE_UNRECONCILED')
    assert.equal(fetchCalls, 1)
    const ledger = openLocalDecisionBudgetLedger({ dbPath: resolveLocalDecisionBudgetDbPath() })
    try {
      const holds = ledger.listUncertainReservations()
      assert.equal(holds.length, 1)
      assert.equal(holds[0]?.state, 'pending')
    } finally {
      ledger.close()
    }
  })
}

async function testInvalidOutputFallsBackAfterOneCall(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    writeEnabledConfig('typesafe-jev')
    confirmCaps('typesafe-jev')
    let fetchCalls = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      fetchCalls += 1
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      return responseWith(systemOneResponse(body, 'not-a-skill', 'hermes'))
    }) as unknown as typeof fetch
    const result = await runProviderDecision({
      payload: buildDecisionPayload({
        request: 'implement a backend endpoint',
        skillIds: ['tdd-with-agents'],
        agentIds: ['hermes'],
      }),
      permissionAssert: permissionStub,
      sessionID: 'ses-test',
      messageID: 'msg-test',
    })
    assert.equal(result.status, 'fallback')
    assert.equal(result.reasonCode, 'INVALID_PROVIDER_RESPONSE')
    assert.equal(fetchCalls, 1)
  })
}

async function testTurnCacheKeepsOneCallPerTurn(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    clearTurnDecisionCache()
    writeEnabledConfig('typesafe-jev')
    confirmCaps('typesafe-jev')
    let fetchCalls = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      fetchCalls += 1
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      return responseWith(systemOneResponse(body, 'tdd-with-agents', null))
    }) as unknown as typeof fetch
    const first = await decideForTurn({
      request: 'implement a backend endpoint with pytest',
      sessionID: 'ses-turn',
      messageID: 'msg-turn',
      permissionAssert: permissionStub,
    })
    const second = await decideForTurn({
      request: 'implement a backend endpoint with pytest',
      sessionID: 'ses-turn',
      messageID: 'msg-turn',
      permissionAssert: permissionStub,
    })
    assert.deepEqual(first, second)
    assert.equal(fetchCalls, 1)
    assert.ok(first.skillIds.length > 0)

    const [concurrentA, concurrentB] = await Promise.all([
      decideForTurn({
        request: 'implement a backend endpoint with pytest',
        sessionID: 'ses-turn',
        messageID: 'msg-concurrent',
        permissionAssert: permissionStub,
      }),
      decideForTurn({
        request: 'implement a backend endpoint with pytest',
        sessionID: 'ses-turn',
        messageID: 'msg-concurrent',
        permissionAssert: permissionStub,
      }),
    ])
    assert.deepEqual(concurrentA, concurrentB)
    assert.equal(fetchCalls, 2, 'exactly one call per distinct turn')
  })
}

async function testConsoleFreeProviderNeverFetches(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    writeUserDecisionRouterConfig({
      schema_version: 2,
      enabled: true,
      selection: {
        mode: 'explicit',
        provider: 'opencode-console-jev-free',
        model: 'jev-1.13-free',
      },
      egress_consent: true,
      enabled_candidates: [{ provider: 'opencode-console-jev-free', model: 'jev-1.13-free' }],
    })
    confirmCaps('typesafe-jev')
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      throw new Error('must not fetch')
    }) as typeof fetch
    const result = await runProviderDecision({
      payload: buildDecisionPayload({ request: 'test', skillIds: ['simplify'] }),
      permissionAssert: permissionStub,
      sessionID: 'ses-test',
      messageID: 'msg-console',
    })
    assert.equal(result.reasonCode, 'NO_ELIGIBLE_CANDIDATE')
    assert.equal(fetchCalls, 0)
  })
}

async function testDisabledConfigLeavesPromptUntouchedAndFetchesNothing(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    clearTurnDecisionCache()
    writeUserDecisionRouterConfig({
      schema_version: 2,
      enabled: false,
      selection: { mode: 'explicit', provider: 'typesafe-jev', model: 'jev-1.14.0' },
      egress_consent: true,
      enabled_candidates: [{ provider: 'typesafe-jev', model: 'jev-1.14.0' }],
    })
    confirmCaps('typesafe-jev')
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      throw new Error('must not fetch')
    }) as typeof fetch
    const admission = {
      sessionID: 'ses-off',
      messageID: 'msg-off',
      prompt: {
        text: 'implement a backend endpoint with pytest',
        skills: [{ name: 'tdd-with-agents' }, { name: 'simplify' }],
      },
    }
    const before = structuredClone(admission)
    const applied = await applyDecisionRouterToPrompt(admission)
    assert.equal(applied.markerApplied, false)
    assert.equal(applied.skillsFiltered, false)
    assert.equal(applied.skillsSource, 'none')
    assert.match(applied.reason, /^[a-z0-9][a-z0-9.:-]{0,63}$/)
    assert.deepEqual(admission, before)
    assert.equal(fetchCalls, 0)
  })
}

async function testPromptHookKeepsLocalRecommendationWithoutEgress(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    writeUserDecisionRouterConfig({
      schema_version: 2,
      enabled: true,
      selection: { mode: 'explicit', provider: 'typesafe-jev', model: 'jev-1.14.0' },
      egress_consent: true,
      enabled_candidates: [{ provider: 'typesafe-jev', model: 'jev-1.14.0' }],
    })
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      throw new Error('production prompt hook must not egress')
    }) as typeof fetch
    const admission = {
      sessionID: 'ses-hook',
      messageID: 'msg-hook',
      prompt: {
        text: 'implement a backend endpoint with pytest',
        agents: 'undefined',
        skills: 'undefined',
      },
    }
    const applied = await applyDecisionRouterToPrompt(admission)
    assert.equal(applied.markerApplied, true)
    assert.equal(applied.skillsFiltered, false)
    assert.equal(applied.skillsSource, 'none')
    assert.equal(applied.reason, 'skills.source.absent')
    assert.match(
      admission.prompt.text,
      /<!-- pantheon-decision-router:v1 source=local skills=[a-z0-9,-]+(?: agent=[a-z0-9-]+)? -->/,
    )
    assert.equal(fetchCalls, 0)
  })
}

function testPromptApplicationIsIdempotentAndBounded(): void {
  const decision: TurnDecision = {
    schemaVersion: 1,
    active: true,
    source: 'local',
    skillIds: ['tdd-with-agents', 'not-a-skill'],
    agent: 'hermes',
    reasonCode: 'LOCAL_SELECTION',
  }
  // SYNTHETIC host shape: a populated `prompt.skills` array was never observed
  // (F-08 sends the string "undefined"), so this case exercises the guard code
  // only. It is not a measured effect and no filtering is claimed for P2.
  const prompt = {
    text: 'original request',
    skills: [{ name: 'tdd-with-agents' }, { name: 'simplify' }, { name: 'not-a-skill' }],
  }
  const applied = applyTurnDecisionToPrompt(prompt, decision)
  assert.equal(applied.markerApplied, true)
  assert.equal(applied.skillsFiltered, true, 'synthetic host shape only')
  assert.equal(applied.skillsSource, 'prompt')
  assert.deepEqual(prompt.skills, [{ name: 'tdd-with-agents' }])
  assert.match(
    prompt.text,
    /<!-- pantheon-decision-router:v1 source=local skills=tdd-with-agents agent=hermes -->/,
  )
  const repeated = applyTurnDecisionToPrompt(prompt, decision)
  assert.equal(repeated.markerApplied, false)
  assert.equal((prompt.text.match(/pantheon-decision-router:v1/g) ?? []).length, 1)
  const unknownShape = { text: 'x', skills: [{ label: 'tdd-with-agents' }] }
  assert.equal(applyTurnDecisionToPrompt(unknownShape, decision).skillsFiltered, false)
  assert.deepEqual(unknownShape.skills, [{ label: 'tdd-with-agents' }])
  // Measured host shape: the same decision cannot reach the skill list (F-08, F-09).
  const measured = { text: 'x', skills: 'undefined' }
  const measuredResult = applyTurnDecisionToPrompt(measured, decision)
  assert.equal(measuredResult.skillsFiltered, false)
  assert.equal(measuredResult.skillsSource, 'none')
  assert.equal(measuredResult.reason, 'skills.source.absent')
  assert.equal(measured.skills, 'undefined')
}

function testV1AndPackageBoundsStayClosed(): void {
  const v1 = readFileSync(new URL('../../src/plugin.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(v1, /local-decision-provider|runProviderDecision|decideForTurn/)
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { exports: Record<string, string> }
  assert.equal(Object.hasOwn(packageJson.exports, './local-decision-provider'), false)
  assert.equal(Object.hasOwn(packageJson.exports, './local-decision-turn'), false)
  assert.equal(Object.hasOwn(packageJson.exports, './local-decision-router'), true)
  const adapterSource = readFileSync(
    new URL('../../src/pantheon/local-decision-provider.internal.ts', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(adapterSource, /\bretry\(|maxRetries|baseURL|fallbackProvider/)
  const v2 = readFileSync(new URL('../../src/plugin-v2.ts', import.meta.url), 'utf8')
  const promptModule = readFileSync(
    new URL('../../src/pantheon/local-decision-prompt.ts', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(v2, /runProviderDecision|experimental\.generate\.decisions/)
  assert.match(v2, /applyDecisionRouterToPrompt\(/)
  assert.doesNotMatch(promptModule, /decideForTurn|runProviderDecision|globalThis\.fetch/)
  assert.match(promptModule, /decideLocalForTurn/)
}

function testRejectedSecretShapesStayLocal(): void {
  const shapes = [
    `sk-proj-${'a'.repeat(24)}`,
    `sk-svcacct-${'b'.repeat(24)}`,
    `sk-admin-${'c'.repeat(24)}`,
    `sk-ant-api03-${'d'.repeat(24)}`,
    'password=hunter2hunter2',
    `api_key=${'abcdef1234567890'}`,
    `API-KEY: ${'abcdef1234567890'}`,
    `ghp_${'x'.repeat(36)}`,
    `Bearer ${'y'.repeat(24)}`,
  ]
  for (const shape of shapes) {
    assert.equal(
      buildDecisionPayload({ request: `use ${shape}`, skillIds: ['simplify'] }),
      null,
      shape,
    )
  }
  for (const prose of [
    'plan the task-force-rollout and the risk-based-review of disk-usage',
    'sort the desk-organization-matrix and mask-generation-pipeline notes',
  ]) {
    assert.ok(
      buildDecisionPayload({ request: prose, skillIds: ['simplify'] }),
      `legitimate prose is not a credential shape: ${prose}`,
    )
  }
  assert.ok(
    buildDecisionPayload({
      request: 'use the api key from the host permission store',
      skillIds: ['simplify'],
    }),
    'ordinary prose about keys is not a credential shape',
  )
}

function testEmptySelectionNeverErasesHostSkills(): void {
  const emptySelection: TurnDecision = {
    schemaVersion: 1,
    active: true,
    source: 'local',
    skillIds: [],
    agent: 'hermes',
    reasonCode: 'LOCAL_SELECTION',
  }

  // Measured host shape (F-08): no skill list is reachable at all.
  const measured = { text: 'request', skills: 'undefined', agents: 'undefined' }
  const measuredResult = applyTurnDecisionToPrompt(measured, {
    ...emptySelection,
    skillIds: ['simplify'],
  })
  assert.equal(measuredResult.skillsFiltered, false)
  assert.equal(measuredResult.skillsSource, 'none')
  assert.equal(measuredResult.reason, 'skills.source.absent')
  assert.equal(measured.skills, 'undefined')

  // Synthetic host shape (never observed): only the empty-selection guard is
  // under test here; it is not a measured effect of P2.
  const hostPrompt = () => ({
    text: 'request',
    skills: [{ name: 'worktrees' }, { name: 'simplify' }],
  })
  const empty = hostPrompt()
  const emptyResult = applyTurnDecisionToPrompt(empty, emptySelection)
  assert.equal(emptyResult.skillsFiltered, false)
  assert.equal(emptyResult.reason, 'selection.empty')
  assert.deepEqual(empty.skills, [{ name: 'worktrees' }, { name: 'simplify' }])

  const disjoint = hostPrompt()
  const disjointResult = applyTurnDecisionToPrompt(disjoint, {
    ...emptySelection,
    skillIds: ['tdd-with-agents'],
    agent: null,
  })
  assert.equal(disjointResult.skillsFiltered, false)
  assert.equal(disjointResult.reason, 'skills.selection.disjoint')
  assert.deepEqual(disjoint.skills, [{ name: 'worktrees' }, { name: 'simplify' }])

  const valid = hostPrompt()
  const validResult = applyTurnDecisionToPrompt(valid, {
    ...emptySelection,
    skillIds: ['simplify'],
    agent: null,
  })
  assert.equal(validResult.skillsFiltered, true, 'synthetic host shape only')
  assert.equal(validResult.reason, 'skills.synthetic.narrowed')
  assert.deepEqual(valid.skills, [{ name: 'simplify' }])
}

async function testPolicyCacheIsProcessScopedAndInvalidatable(): Promise<void> {
  clearLocalDecisionPolicyCache()
  const first = await loadLocalDecisionPolicy()
  assert.ok(first)
  assert.equal(await loadLocalDecisionPolicy(), first, 'routing.yml is parsed once per process')
  clearLocalDecisionPolicyCache()
  const second = await loadLocalDecisionPolicy()
  assert.ok(second)
  assert.notEqual(second, first)
  assert.deepEqual(second, first)
}

async function testAutoWithTwoCandidatesNeverFailsOver(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    writeUserDecisionRouterConfig({
      schema_version: 2,
      enabled: true,
      selection: { mode: 'auto' },
      egress_consent: true,
      enabled_candidates: [
        { provider: 'typesafe-jev', model: 'jev-1.14.0' },
        { provider: 'openai-decisions', model: 'gpt-6-luna' },
      ],
    })
    const ledger = openLocalDecisionBudgetLedger({ dbPath: resolveLocalDecisionBudgetDbPath() })
    try {
      ledger.configureUserCaps(CAPS)
      for (const provider of ['typesafe-jev', 'openai-decisions'] as const) {
        const model = DECISION_ROUTER_MODELS[provider][0] as string
        ledger.configureProviderCaps(provider, CAPS)
        ledger.configureModelCaps(provider, model, CAPS)
      }
      assert.equal(ledger.confirmBudgetPeriod(null, CURRENT_PERIOD).status, 'confirmed')
    } finally {
      ledger.close()
    }
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      throw new Error('must not fetch')
    }) as typeof fetch
    const result = await runProviderDecision({
      payload: buildDecisionPayload({ request: 'test', skillIds: ['simplify'] }),
      permissionAssert: permissionStub,
      sessionID: 'ses-auto',
      messageID: 'msg-auto',
    })
    assert.equal(result.reasonCode, 'NO_ELIGIBLE_CANDIDATE')
    assert.equal(fetchCalls, 0)
  })
}

async function testEgressGatesNeverFetch(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    const model = 'jev-1.14.0'
    let fetchCalls = 0
    globalThis.fetch = (async () => {
      fetchCalls += 1
      throw new Error('must not fetch')
    }) as typeof fetch
    const payload = buildDecisionPayload({
      request: 'implement a backend endpoint',
      skillIds: ['tdd-with-agents'],
    })
    assert.ok(payload)
    const run = (messageID: string) =>
      runProviderDecision({
        payload,
        permissionAssert: permissionStub,
        sessionID: 'ses-gate',
        messageID,
      })

    writeUserDecisionRouterConfig({
      schema_version: 2,
      enabled: true,
      selection: { mode: 'explicit', provider: 'typesafe-jev', model },
      egress_consent: false,
      enabled_candidates: [{ provider: 'typesafe-jev', model }],
    })
    confirmCaps('typesafe-jev')
    assert.equal((await run('msg-no-consent')).reasonCode, 'CONSENT_MISSING')
    assert.equal(fetchCalls, 0)

    writeEnabledConfig('typesafe-jev')
    delete process.env.TYPESAFE_API_KEY
    assert.equal((await run('msg-no-credential')).reasonCode, 'CREDENTIAL_MISSING')
    assert.equal(fetchCalls, 0)
    process.env.TYPESAFE_API_KEY = 'synthetic-test-only-key'

    const dbPath = resolveLocalDecisionBudgetDbPath()
    const mutate = (sql: string, ...params: Array<string | number>) => {
      const db = new DatabaseSync(dbPath)
      try {
        db.prepare(sql).run(...params)
      } finally {
        db.close()
      }
    }
    mutate("UPDATE ledger_state SET active_period_utc = '2000-01' WHERE id = 1")
    assert.equal((await run('msg-wrong-period')).reasonCode, 'NO_ELIGIBLE_CANDIDATE')
    assert.equal(fetchCalls, 0)

    mutate('UPDATE ledger_state SET active_period_utc = ? WHERE id = 1', CURRENT_PERIOD)
    mutate(
      "INSERT INTO budget_freezes (scope, provider, model, period_utc, reason, created_at_ms) VALUES ('model', 'typesafe-jev', 'jev-1.14.0', ?, 'overrun', ?)",
      CURRENT_PERIOD,
      Date.now(),
    )
    assert.equal((await run('msg-frozen')).reasonCode, 'NO_ELIGIBLE_CANDIDATE')
    assert.equal(fetchCalls, 0)
  })
}

async function testTransportIsBoundedAndNeverRetries(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    writeEnabledConfig('typesafe-jev')
    confirmCaps('typesafe-jev')
    const payload = buildDecisionPayload({
      request: 'implement a backend endpoint',
      skillIds: ['tdd-with-agents'],
    })
    let calls = 0
    const run = (messageID: string) =>
      runProviderDecision({
        payload,
        permissionAssert: permissionStub,
        sessionID: 'ses-transport',
        messageID,
      })

    globalThis.fetch = (async () => {
      calls += 1
      return new Response('{}', { status: 503 })
    }) as typeof fetch
    assert.equal((await run('msg-503')).reasonCode, 'TRANSPORT_FAILED')
    assert.equal(calls, 1)

    calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      throw new Error('transport down')
    }) as typeof fetch
    assert.equal((await run('msg-throw')).reasonCode, 'TRANSPORT_FAILED')
    assert.equal(calls, 1)

    calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(16))
            controller.close()
          },
        }),
        {
          status: 200,
          headers: { 'content-length': String(PROVIDER_MAX_RESPONSE_BYTES + 1) },
        },
      )
    }) as typeof fetch
    assert.equal((await run('msg-content-length')).reasonCode, 'TRANSPORT_FAILED')
    assert.equal(calls, 1)

    calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(PROVIDER_MAX_RESPONSE_BYTES + 1))
            controller.close()
          },
        }),
        { status: 200 },
      )
    }) as typeof fetch
    assert.equal((await run('msg-stream')).reasonCode, 'TRANSPORT_FAILED')
    assert.equal(calls, 1)
  })
}

async function testRequestShapeTimeoutAndSizeBounds(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    assert.equal(PROVIDER_REQUEST_TIMEOUT_MS, 5_000)
    assert.equal(PROVIDER_MAX_RESPONSE_BYTES, 64 * 1024)
    writeEnabledConfig('typesafe-jev')
    confirmCaps('typesafe-jev')
    const payload = buildDecisionPayload({
      request: 'implement a backend endpoint',
      skillIds: ['tdd-with-agents'],
    })
    assert.ok(payload)
    const requests: Array<{ url: string; init: RequestInit }> = []
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      requests.push({ url, init })
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      return responseWith(systemOneResponse(body, 'tdd-with-agents', null))
    }) as unknown as typeof fetch
    const result = await runProviderDecision({
      payload,
      permissionAssert: permissionStub,
      sessionID: 'ses-shape',
      messageID: 'msg-shape',
    })
    assert.equal(result.status, 'decided')
    assert.equal(requests.length, 1)
    const request = requests[0]
    assert.ok(request)
    assert.equal(request.url, DECISION_PROVIDER_ADAPTERS['typesafe-jev'].endpoint)
    assert.equal(request.init.method, 'POST')
    assert.equal(request.init.redirect, 'error')
    assert.equal(request.init.referrerPolicy, 'no-referrer')
    assert.ok(request.init.signal instanceof AbortSignal)
    const headers = request.init.headers as Record<string, string>
    assert.equal(headers['content-type'], 'application/json')
    assert.equal(headers.authorization, 'Bearer synthetic-test-only-key')
    const body = JSON.parse(String(request.init.body)) as Record<string, unknown>
    assert.equal(body.model, 'jev-1.14.0')
    assert.deepEqual(body.state, payload)
  })
}

async function testUnparseableResponseKeepsHold(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    writeEnabledConfig('typesafe-jev')
    confirmCaps('typesafe-jev')
    globalThis.fetch = (async () =>
      new Response('not-json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch
    const result = await runProviderDecision({
      payload: buildDecisionPayload({
        request: 'implement a backend endpoint',
        skillIds: ['tdd-with-agents'],
      }),
      permissionAssert: permissionStub,
      sessionID: 'ses-invalid',
      messageID: 'msg-invalid',
    })
    assert.equal(result.reasonCode, 'TRANSPORT_FAILED')
    const ledger = openLocalDecisionBudgetLedger({ dbPath: resolveLocalDecisionBudgetDbPath() })
    try {
      const holds = ledger.listUncertainReservations()
      assert.equal(holds.length, 1)
      assert.equal(holds[0]?.state, 'pending')
    } finally {
      ledger.close()
    }
  })
}

async function testReuseReassertsOnlyForANewGate(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    clearTurnDecisionCache()
    writeEnabledConfig('typesafe-jev')
    confirmCaps('typesafe-jev')
    let fetchCalls = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      fetchCalls += 1
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      return responseWith(systemOneResponse(body, 'tdd-with-agents', null))
    }) as typeof fetch
    const base = {
      request: 'implement a backend endpoint with pytest',
      sessionID: 'ses-reuse',
      messageID: 'msg-reuse',
    }
    const first = await decideForTurn({ ...base, permissionAssert: permissionStub })
    assert.equal(first.source, 'typesafe-jev')
    assert.equal(fetchCalls, 1)

    const denied = await decideForTurn({
      ...base,
      permissionAssert: async () => {
        throw new Error('denied')
      },
    })
    assert.equal(denied.active, false)
    assert.equal(denied.reasonCode, 'PERMISSION_DENIED')
    assert.equal(fetchCalls, 1)

    const missing = await decideForTurn(base)
    assert.equal(missing.reasonCode, 'PERMISSION_UNAVAILABLE')
    assert.equal(fetchCalls, 1)

    const again = await decideForTurn({ ...base, permissionAssert: permissionStub })
    assert.deepEqual(again, first)
    assert.equal(fetchCalls, 1)

    const concurrent = { ...base, messageID: 'msg-reuse-concurrent' }
    const [allowed, rejected] = await Promise.all([
      decideForTurn({ ...concurrent, permissionAssert: permissionStub }),
      decideForTurn({
        ...concurrent,
        permissionAssert: async () => {
          throw new Error('denied')
        },
      }),
    ])
    assert.equal(allowed.active, true)
    assert.equal(rejected.reasonCode, 'PERMISSION_DENIED')
    assert.equal(fetchCalls, 2)

    // The same gate identity (the stable plugin closure) is asked once per
    // cached turn: a cache hit must not duplicate an interactive prompt.
    let gateCalls = 0
    const stableGate = async (_input: Record<string, unknown>) => {
      gateCalls += 1
    }
    const stableTurn = { ...base, messageID: 'msg-reuse-stable' }
    const stableFirst = await decideForTurn({ ...stableTurn, permissionAssert: stableGate })
    const stableSecond = await decideForTurn({ ...stableTurn, permissionAssert: stableGate })
    assert.deepEqual(stableSecond, stableFirst)
    assert.equal(gateCalls, 1, 'a cache hit with the same gate is not re-asserted')
    assert.equal(fetchCalls, 3)

    // A different caller gate for the same cached turn is still fail-closed.
    const stableDenied = await decideForTurn({
      ...stableTurn,
      permissionAssert: async () => {
        throw new Error('denied')
      },
    })
    assert.equal(stableDenied.active, false)
    assert.equal(stableDenied.reasonCode, 'PERMISSION_DENIED')
    assert.equal(gateCalls, 1, 'a denied gate does not re-run the allowed gate')
    assert.equal(fetchCalls, 3)
  })
}

async function testCachedReuseRereadsConsentGate(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    clearTurnDecisionCache()
    writeEnabledConfig('typesafe-jev')
    confirmCaps('typesafe-jev')
    const model = DECISION_ROUTER_MODELS['typesafe-jev'][0] as string
    let fetchCalls = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      fetchCalls += 1
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      return responseWith(systemOneResponse(body, 'tdd-with-agents', null))
    }) as typeof fetch
    const base = {
      request: 'implement a backend endpoint with pytest',
      sessionID: 'ses-reuse-consent',
      messageID: 'msg-reuse-consent',
    }
    const first = await decideForTurn({ ...base, permissionAssert: permissionStub })
    assert.equal(first.source, 'typesafe-jev')
    assert.equal(fetchCalls, 1)

    // Revoking consent must invalidate an already cached remote decision even
    // though this gate identity is memoized as allowed.
    writeUserDecisionRouterConfig({
      schema_version: 2,
      enabled: true,
      selection: { mode: 'explicit', provider: 'typesafe-jev', model },
      egress_consent: false,
      enabled_candidates: [{ provider: 'typesafe-jev', model }],
    })
    const revoked = await decideForTurn({ ...base, permissionAssert: permissionStub })
    assert.equal(revoked.active, false)
    assert.equal(revoked.reasonCode, 'CONSENT_MISSING')
    assert.equal(fetchCalls, 1)

    // Disabling the router denies the cached turn the same way.
    writeUserDecisionRouterConfig({
      schema_version: 2,
      enabled: false,
      selection: { mode: 'explicit', provider: 'typesafe-jev', model },
      egress_consent: true,
      enabled_candidates: [{ provider: 'typesafe-jev', model }],
    })
    const disabled = await decideForTurn({ ...base, permissionAssert: permissionStub })
    assert.equal(disabled.reasonCode, 'DISABLED')
    assert.equal(fetchCalls, 1)

    // Restoring the gate restores the cached decision without a second request.
    writeEnabledConfig('typesafe-jev')
    const restored = await decideForTurn({ ...base, permissionAssert: permissionStub })
    assert.deepEqual(restored, first)
    assert.equal(fetchCalls, 1)
  })
}

async function testTurnCacheBoundIsDocumentedAndEvictionRepeatsOneRequest(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    clearTurnDecisionCache()
    writeUserDecisionRouterConfig({
      schema_version: 2,
      enabled: true,
      selection: { mode: 'local' },
      egress_consent: false,
      enabled_candidates: [],
    })
    const base = {
      request: 'implement a backend endpoint with pytest',
      sessionID: 'ses-fifo',
    }
    for (let index = 0; index < 129; index += 1) {
      const decision = await decideForTurn({ ...base, messageID: `msg-${index}` })
      assert.equal(decision.source, 'local')
    }

    writeEnabledConfig('typesafe-jev')
    confirmCaps('typesafe-jev')
    let fetchCalls = 0
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      fetchCalls += 1
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      return responseWith(systemOneResponse(body, 'tdd-with-agents', null))
    }) as typeof fetch

    const evicted = await decideForTurn({
      ...base,
      messageID: 'msg-0',
      permissionAssert: permissionStub,
    })
    assert.equal(evicted.source, 'typesafe-jev')
    assert.equal(fetchCalls, 1, 'an evicted turn may repeat the single bounded request')

    const cached = await decideForTurn({
      ...base,
      messageID: 'msg-2',
      permissionAssert: permissionStub,
    })
    assert.equal(cached.source, 'local')
    assert.equal(fetchCalls, 1)
  })
}

function testParseRejectsUndeclaredAgent(): void {
  const payload = buildDecisionPayload({
    request: 'implement a backend endpoint',
    skillIds: ['tdd-with-agents'],
    agentIds: ['hermes'],
  })
  assert.ok(payload)
  const response = systemOneResponse({ state: payload }, 'tdd-with-agents', 'aphrodite')
  ;(response.answers as Record<string, unknown>).agent = {
    type: 'choice',
    choice: 'aphrodite',
    confidence: 0.9,
    probabilities: { aphrodite: 0.9, abstain: 0.1 },
  }
  assert.equal(parseProviderDecision('typesafe-jev', response, payload).status, 'invalid')
}

testCatalogAndSkillSelection()
testAgentRecommendationOnlyUsesEligibleCandidates()
testPayloadIsExactAndAllowlisted()
testRejectedSecretShapesStayLocal()
testProviderMatrixIsSingleAndFailClosed()
await testPolicyCacheIsProcessScopedAndInvalidatable()
await testNoConfigMeansZeroFetch()
await testNoCapOrPermissionMeansZeroFetch()
await testAutoWithTwoCandidatesNeverFailsOver()
await testEgressGatesNeverFetch()
await testEligibleTurnCallsExactlyOnceAndReconciles()
await testPermissionAssertUsesAcceptedSourceShape()
await testOpenAiProviderUsesFixedEndpointAndPayload()
await testRequestShapeTimeoutAndSizeBounds()
await testTransportIsBoundedAndNeverRetries()
await testUnparseableResponseKeepsHold()
await testUnreconciledUsageKeepsHoldAndFallsBack()
await testInvalidOutputFallsBackAfterOneCall()
await testTurnCacheKeepsOneCallPerTurn()
await testReuseReassertsOnlyForANewGate()
await testCachedReuseRereadsConsentGate()
await testTurnCacheBoundIsDocumentedAndEvictionRepeatsOneRequest()
await testConsoleFreeProviderNeverFetches()
await testDisabledConfigLeavesPromptUntouchedAndFetchesNothing()
await testPromptHookKeepsLocalRecommendationWithoutEgress()
testPromptApplicationIsIdempotentAndBounded()
testEmptySelectionNeverErasesHostSkills()
testV1AndPackageBoundsStayClosed()
testParseRejectsUndeclaredAgent()

console.log('local decision phase 2 tests passed')
