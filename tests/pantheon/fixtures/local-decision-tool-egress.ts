import { strict as assert } from 'node:assert'
import { writeUserDecisionRouterConfig } from '../../../scripts/install/decision-router-config.mjs'
import {
  type BudgetProvider,
  openLocalDecisionBudgetLedger,
} from '../../../src/pantheon/local-decision-budget.ts'
import {
  createLocalDecisionTool,
  createV2LocalDecisionDefinition,
} from '../../../src/pantheon/local-decision-tool.ts'
import type {
  LocalDecisionPolicy,
  LocalOrchestrationInput,
} from '../../../src/pantheon/local-orchestration.ts'

const rootConfig = process.env.XDG_CONFIG_HOME
const rootState = process.env.XDG_STATE_HOME
assert.ok(rootConfig && rootState)

writeUserDecisionRouterConfig(
  {
    schema_version: 2,
    enabled: true,
    selection: { mode: 'explicit', provider: 'typesafe-jev', model: 'jev-1.14.0' },
    egress_consent: true,
    enabled_candidates: [{ provider: 'typesafe-jev', model: 'jev-1.14.0' }],
  },
  { env: { HOME: process.env.HOME, XDG_CONFIG_HOME: rootConfig } },
)

const ledger = openLocalDecisionBudgetLedger()
try {
  const caps = { monthlyCapMicros: 5_000_000, perDecisionCapMicros: 1_000_000 }
  const provider: BudgetProvider = 'typesafe-jev'
  ledger.configureUserCaps(caps)
  ledger.configureProviderCaps(provider, caps)
  ledger.configureModelCaps(provider, 'jev-1.14.0', caps)
  assert.equal(
    ledger.confirmBudgetPeriod(null, new Date().toISOString().slice(0, 7)).status,
    'confirmed',
  )
} finally {
  ledger.close()
}

const policy: LocalDecisionPolicy = {
  agents: {
    zeus: {
      canDelegateTo: ['hermes', 'aphrodite'],
      canReceiveDelegation: true,
      capabilities: ['memory_recall'],
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
}
const input: LocalOrchestrationInput = {
  schemaVersion: 1,
  candidateAgents: ['hermes', 'aphrodite'],
  domain: null,
  candidateSkillIds: [],
  candidateResourceIds: [],
  memorySearchRelevant: false,
  gateStatus: 'none',
  complexity: {
    boundedness: 0,
    reversibility: 0,
    dependencies: 0,
    uncertainty: 0,
    verification: 0,
  },
}

let fetchCalls = 0
globalThis.fetch = (async () => {
  fetchCalls += 1
  throw new Error('provider fetch blocked by isolated regression test')
}) as typeof fetch

const tool = createLocalDecisionTool({ loadPolicy: async () => policy })
const result = JSON.parse(await tool.execute(input, { agent: 'zeus' } as never))
assert.equal(result.agent, null)
assert.equal(result.reasonCode, 'AMBIGUOUS_CANDIDATE')
assert.equal(result.decision, 'abstain')
assert.equal(result.action, 'advisory_only')
assert.equal(Object.hasOwn(result, 'dispatch'), false)
assert.equal(fetchCalls, 0)

const v2Tool = createV2LocalDecisionDefinition({ loadPolicy: async () => policy })
const v2Result = await v2Tool.execute(input as unknown as Record<string, unknown>, {
  agent: 'zeus',
})
const v2Plan = JSON.parse(v2Result.output)
assert.equal(v2Plan.reasonCode, 'AMBIGUOUS_CANDIDATE')
assert.equal(v2Plan.decision, 'abstain')
assert.equal(fetchCalls, 0)
