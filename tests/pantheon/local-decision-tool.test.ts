import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createLocalDecisionTool,
  createV2LocalDecisionDefinition,
} from '../../src/pantheon/local-decision-tool.ts'
import type {
  LocalDecisionPolicy,
  LocalOrchestrationInput,
} from '../../src/pantheon/local-orchestration.ts'

const policy: LocalDecisionPolicy = {
  agents: {
    zeus: {
      canDelegateTo: ['hermes'],
      canReceiveDelegation: true,
      capabilities: ['memory_recall'],
      skills: [],
    },
    hermes: {
      canDelegateTo: ['apollo'],
      canReceiveDelegation: true,
      capabilities: [],
      skills: [],
    },
  },
  permissionTask: { '*': 'allow' },
}

const input: LocalOrchestrationInput = {
  schemaVersion: 1,
  candidateAgents: ['hermes'],
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

async function testV1ToolRequiresHostReportedZeusAndDoesNotDispatch(): Promise<void> {
  let policyLoads = 0
  const tool = createLocalDecisionTool({
    loadPolicy: async () => {
      policyLoads += 1
      return policy
    },
  })

  const deniedText = await tool.execute(input, { agent: 'hermes' } as never)
  assert.equal(JSON.parse(deniedText).reasonCode, 'CALLER_NOT_ZEUS')
  assert.equal(policyLoads, 0)
  const missingIdentityText = await tool.execute(input, {} as never)
  assert.equal(JSON.parse(missingIdentityText).reasonCode, 'CALLER_NOT_ZEUS')
  assert.equal(policyLoads, 0)

  const resultText = await tool.execute(input, { agent: 'zeus' } as never)
  const result = JSON.parse(resultText)
  assert.equal(result.decision, 'recommend')
  assert.equal(result.agent, 'hermes')
  assert.equal(result.action, 'advisory_only')
  assert.equal(Object.hasOwn(result, 'dispatch'), false)
  assert.equal(policyLoads, 1)
}

async function testV2DefinitionHasStructuredSchemaAndZeusExecutionGuard(): Promise<void> {
  const definition = createV2LocalDecisionDefinition({ loadPolicy: async () => policy })
  assert.equal(definition.name, 'pantheon_local_decision')
  assert.equal(definition.input.additionalProperties, false)
  assert.deepEqual(Object.keys(definition.input.properties as Record<string, unknown>).sort(), [
    'candidateAgents',
    'candidateResourceIds',
    'candidateSkillIds',
    'complexity',
    'domain',
    'gateStatus',
    'memorySearchRelevant',
    'schemaVersion',
  ])

  const denied = await definition.execute(input as unknown as Record<string, unknown>, {
    agent: 'apollo',
  })
  assert.equal(JSON.parse(denied.output).reasonCode, 'CALLER_NOT_ZEUS')
  const missingIdentity = await definition.execute(input as unknown as Record<string, unknown>, {})
  assert.equal(JSON.parse(missingIdentity.output).reasonCode, 'CALLER_NOT_ZEUS')
  const result = await definition.execute(input as unknown as Record<string, unknown>, {
    agent: 'zeus',
  })
  assert.equal(JSON.parse(result.output).agent, 'hermes')
}

async function testAmbiguityStaysLocalInSanitizedProviderReadyChild(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-local-decision-test-'))
  try {
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        fileURLToPath(new URL('./fixtures/local-decision-tool-egress.ts', import.meta.url)),
      ],
      {
        cwd: fileURLToPath(new URL('../../', import.meta.url)),
        env: {
          HOME: root,
          XDG_CONFIG_HOME: join(root, 'config'),
          XDG_STATE_HOME: join(root, 'state'),
          TYPESAFE_API_KEY: 'synthetic-test-only-key',
        },
        stdio: 'ignore',
      },
    )
    assert.equal(child.status, 0, 'ambiguous route must not call provider fetch')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

await testV1ToolRequiresHostReportedZeusAndDoesNotDispatch()
await testV2DefinitionHasStructuredSchemaAndZeusExecutionGuard()
await testAmbiguityStaysLocalInSanitizedProviderReadyChild()
console.log('local decision tool tests passed')
