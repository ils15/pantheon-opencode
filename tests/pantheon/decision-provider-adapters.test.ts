import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  DECISION_PROVIDER_ADAPTERS,
  type DecisionProviderId,
  PROVIDER_MAX_RESPONSE_BYTES,
  PROVIDER_REQUEST_TIMEOUT_MS,
} from '../../src/pantheon/local-decision-provider-matrix.ts'
import {
  buildDecisionPayload,
  buildProviderRequest,
  type DecisionPayload,
  parseProviderDecision,
} from '../../src/pantheon/local-decision-provider-protocol.ts'

const PROVIDERS: DecisionProviderId[] = [
  'openai-decisions',
  'typesafe-jev',
  'opencode-console-jev',
  'opencode-console-jev-free',
]

function payload(withAgent = true): DecisionPayload {
  const built = buildDecisionPayload({
    request: 'implement a backend endpoint',
    skillIds: ['tdd-with-agents', 'simplify'],
    ...(withAgent ? { agentIds: ['hermes'] } : {}),
  })
  assert.ok(built)
  return built
}

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
  confidence = 0.9,
): Record<string, unknown> {
  const state = requestBody.state as {
    skills?: Array<{ id: string }>
    agents?: Array<{ id: string }>
  }
  const skillChoices = [...(state.skills ?? []).map((entry) => entry.id), 'abstain']
  const answers: Record<string, unknown> = {
    skill: {
      type: 'choice',
      choice: skill ?? 'abstain',
      confidence,
      probabilities: probabilities(skillChoices, skill),
    },
  }
  if (state.agents !== undefined) {
    const agentChoices = [...state.agents.map((entry) => entry.id), 'abstain']
    answers.agent = {
      type: 'choice',
      choice: agent ?? 'abstain',
      confidence,
      probabilities: probabilities(agentChoices, agent),
    }
  }
  return { model: 'jev-1.14.0', answers }
}

function openAiResponse(
  requestBody: Record<string, unknown>,
  skill: string | null,
  agent: string | null,
): Record<string, unknown> {
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
  return { model: 'gpt-6-luna', answers }
}

function testProviderMatrixIsPinnedAndConsoleStaysIneligible(): void {
  assert.deepEqual(Object.keys(DECISION_PROVIDER_ADAPTERS).sort(), [...PROVIDERS].sort())
  assert.equal(DECISION_PROVIDER_ADAPTERS['openai-decisions'].model, 'gpt-6-luna')
  assert.equal(DECISION_PROVIDER_ADAPTERS['openai-decisions'].protocol, 'openai')
  assert.equal(
    DECISION_PROVIDER_ADAPTERS['openai-decisions'].endpoint,
    'https://api.openai.com/v1/decisions',
  )
  assert.equal(DECISION_PROVIDER_ADAPTERS['typesafe-jev'].model, 'jev-1.14.0')
  assert.equal(DECISION_PROVIDER_ADAPTERS['typesafe-jev'].protocol, 'systemone')
  assert.equal(
    DECISION_PROVIDER_ADAPTERS['typesafe-jev'].endpoint,
    'https://api.typesafe.ai/v1/systemone',
  )
  assert.equal(DECISION_PROVIDER_ADAPTERS['opencode-console-jev'].egressEligible, false)
  assert.equal(DECISION_PROVIDER_ADAPTERS['opencode-console-jev-free'].egressEligible, false)
  assert.equal(PROVIDER_REQUEST_TIMEOUT_MS, 5_000)
  assert.equal(PROVIDER_MAX_RESPONSE_BYTES, 64 * 1024)
  assert.equal(buildProviderRequest('opencode-console-jev', payload()), null)
  assert.equal(buildProviderRequest('opencode-console-jev-free', payload()), null)
}

function testRequestBodiesUseOnlyDocumentedFields(): void {
  const data = payload()
  const systemOne = buildProviderRequest('typesafe-jev', data)
  assert.ok(systemOne)
  assert.deepEqual(Object.keys(systemOne).sort(), ['model', 'questions', 'state'])
  assert.equal(systemOne.model, 'jev-1.14.0')
  assert.deepEqual(systemOne.state, data)
  const systemQuestions = systemOne.questions as Record<string, { criteria: object }>
  assert.deepEqual(Object.keys(systemQuestions).sort(), ['agent', 'skill'])
  assert.deepEqual(Object.keys(systemQuestions.skill?.criteria ?? {}).sort(), [
    'abstain',
    'simplify',
    'tdd-with-agents',
  ])

  const openAi = buildProviderRequest('openai-decisions', data)
  assert.ok(openAi)
  assert.deepEqual(Object.keys(openAi).sort(), ['input', 'model', 'questions'])
  assert.equal(openAi.model, 'gpt-6-luna')
  const input = openAi.input as Array<{
    role: string
    content: Array<{ type: string; data: unknown }>
  }>
  assert.equal(input.length, 1)
  assert.equal(input[0]?.role, 'user')
  assert.equal(input[0]?.content[0]?.type, 'input_json')
  assert.deepEqual(input[0]?.content[0]?.data, data)
  const openAiQuestions = openAi.questions as Array<{ name: string; choices: unknown[] }>
  assert.deepEqual(
    openAiQuestions.map((question) => question.name),
    ['skill', 'agent'],
  )
}

function testParseProviderDecisionAcceptsOnlyExactCandidates(): void {
  const data = payload()
  const requestBody = buildProviderRequest('typesafe-jev', data)
  assert.ok(requestBody)

  const decided = parseProviderDecision(
    'typesafe-jev',
    systemOneResponse(requestBody, 'simplify', 'hermes'),
    data,
  )
  assert.deepEqual(decided, {
    status: 'decided',
    skillIds: ['simplify'],
    agent: 'hermes',
  })

  const abstain = parseProviderDecision(
    'typesafe-jev',
    systemOneResponse(requestBody, null, null),
    data,
  )
  assert.equal(abstain.status, 'abstain')

  const lowConfidence = parseProviderDecision(
    'typesafe-jev',
    systemOneResponse(requestBody, 'simplify', 'hermes', 0.79),
    data,
  )
  assert.equal(lowConfidence.status, 'abstain')

  const wrongModel = parseProviderDecision(
    'typesafe-jev',
    { ...systemOneResponse(requestBody, 'simplify', 'hermes'), model: 'jev-other' },
    data,
  )
  assert.equal(wrongModel.status, 'invalid')

  const undeclaredAgent = parseProviderDecision(
    'typesafe-jev',
    systemOneResponse(requestBody, 'simplify', 'aphrodite'),
    data,
  )
  assert.equal(undeclaredAgent.status, 'invalid')

  const badDistribution = systemOneResponse(requestBody, 'simplify', 'hermes')
  ;(
    (badDistribution.answers as Record<string, { probabilities: Record<string, number> }>).skill
      ?.probabilities as Record<string, number>
  ).simplify = 0.5
  assert.equal(parseProviderDecision('typesafe-jev', badDistribution, data).status, 'invalid')

  const openAiBody = buildProviderRequest('openai-decisions', data)
  assert.ok(openAiBody)
  const openAiDecided = parseProviderDecision(
    'openai-decisions',
    openAiResponse(openAiBody, 'tdd-with-agents', 'hermes'),
    data,
  )
  assert.deepEqual(openAiDecided, {
    status: 'decided',
    skillIds: ['tdd-with-agents'],
    agent: 'hermes',
  })
  const refusal = openAiResponse(openAiBody, null, null)
  ;(refusal.answers as unknown[])[0] = { type: 'refusal', name: 'skill' }
  assert.equal(parseProviderDecision('openai-decisions', refusal, data).status, 'abstain')
}

function testPublicPackageSurfaceIsExactlyTheDocumentedEntrypoints(): void {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { exports?: Record<string, string>; files?: string[] }
  const exports = packageJson.exports ?? {}
  assert.deepEqual(Object.keys(exports).sort(), [
    './local-decision-router',
    './plugin',
    './plugin-v2',
    './v2-bridge',
  ])
  for (const target of Object.values(exports)) {
    assert.doesNotMatch(target, /local-decision-provider\.internal/)
    assert.doesNotMatch(target, /decision-provider-adapters/)
  }
  assert.equal(
    packageJson.files?.some((entry) => entry.includes('decision-provider-adapters')),
    false,
    'the dead bait path must not remain in packed files',
  )
  assert.ok(packageJson.files?.includes('src/pantheon/**'))
}

testProviderMatrixIsPinnedAndConsoleStaysIneligible()
testRequestBodiesUseOnlyDocumentedFields()
testParseProviderDecisionAcceptsOnlyExactCandidates()
testPublicPackageSurfaceIsExactlyTheDocumentedEntrypoints()

console.log('decision provider protocol tests passed')
