import { strict as assert } from 'node:assert'
import {
  LOCAL_DECISION_ROUTER_ENV,
  type LocalDecisionInput,
  recommendLocalDecision,
} from '../../src/pantheon/local-decision-router.ts'
import {
  type LocalDecisionPolicy,
  type LocalOrchestrationInput,
  loadLocalDecisionPolicy,
  recommendLocalOrchestration,
} from '../../src/pantheon/local-orchestration.ts'
import { PANTHEON_AGENTS } from '../../src/pantheon/v2-delegation-enforce.ts'

const enabledEnv = { [LOCAL_DECISION_ROUTER_ENV]: '1' }

function sampleInput(overrides: Partial<LocalDecisionInput> = {}): LocalDecisionInput {
  return {
    schemaVersion: 1,
    domains: ['hermes'],
    complexity: {
      boundedness: 0,
      reversibility: 0,
      dependencies: 0,
      uncertainty: 0,
      verification: 0,
    },
    gateStatus: 'none',
    ...overrides,
  }
}

function testDisabledByDefault(): void {
  const previousValue = process.env[LOCAL_DECISION_ROUTER_ENV]
  delete process.env[LOCAL_DECISION_ROUTER_ENV]
  try {
    const recommendation = recommendLocalDecision(sampleInput())
    assert.equal(recommendation.decision, 'abstain')
    assert.equal(recommendation.reasonCode, 'DISABLED')
    assert.equal(recommendation.complexity.label, 'abstain')
    assert.equal(recommendation.complexity.reasonCode, 'DISABLED')
  } finally {
    if (previousValue === undefined) delete process.env[LOCAL_DECISION_ROUTER_ENV]
    else process.env[LOCAL_DECISION_ROUTER_ENV] = previousValue
  }
}

function testRoutesOnlyExactCanonicalSpecialistRoles(): void {
  for (const role of PANTHEON_AGENTS) {
    const recommendation = recommendLocalDecision(sampleInput({ domains: [role] }), enabledEnv)
    if (role === 'zeus') {
      assert.equal(recommendation.decision, 'abstain')
      assert.equal(recommendation.reasonCode, 'UNROUTABLE_ROLE')
      continue
    }
    assert.equal(recommendation.decision, 'route')
    assert.equal(recommendation.agent, role)
    assert.equal(recommendation.policyVersion, 'local-decision-router/v1')
    assert.ok(recommendation.agent)
    assert.ok(PANTHEON_AGENTS.has(recommendation.agent))
  }
}

function testAbstainsForUnknownAndAmbiguousDomains(): void {
  const unknown = recommendLocalDecision(sampleInput({ domains: ['devops'] }), enabledEnv)
  assert.equal(unknown.decision, 'abstain')
  assert.equal(unknown.reasonCode, 'UNKNOWN_DOMAIN')

  const ambiguous = recommendLocalDecision(
    sampleInput({ domains: ['hermes', 'aphrodite'] }),
    enabledEnv,
  )
  assert.equal(ambiguous.decision, 'abstain')
  assert.equal(ambiguous.reasonCode, 'AMBIGUOUS_DOMAIN')
}

function testClassifiesOnlyStructuredComplexityDimensions(): void {
  const base = sampleInput()
  assert.equal(recommendLocalDecision(base, enabledEnv).complexity.label, 'low')

  const medium = sampleInput({
    complexity: { ...base.complexity, uncertainty: 1 },
  })
  assert.equal(recommendLocalDecision(medium, enabledEnv).complexity.label, 'medium')

  const high = sampleInput({
    complexity: { ...base.complexity, dependencies: 2 },
  })
  assert.equal(recommendLocalDecision(high, enabledEnv).complexity.label, 'high')

  const withText = {
    ...base,
    taskText: 'this text must not influence complexity',
  } as LocalDecisionInput
  const ignored = recommendLocalDecision(withText, enabledEnv)
  assert.equal(ignored.decision, 'abstain')
  assert.equal(ignored.complexity.label, 'abstain')
  assert.equal(ignored.reasonCode, 'INVALID_INPUT')
}

function testGateStatusIsSeparateFromComplexity(): void {
  const input = sampleInput({ gateStatus: 'human_approval_required' })
  const recommendation = recommendLocalDecision(input, enabledEnv)
  assert.equal(recommendation.complexity.label, 'low')
  assert.equal(recommendation.gateStatus, 'human_approval_required')

  const unresolved = recommendLocalDecision(
    sampleInput({ gateStatus: 'unknown' as never }),
    enabledEnv,
  )
  assert.equal(unresolved.decision, 'abstain')
  assert.equal(unresolved.agent, null)
  assert.equal(unresolved.reasonCode, 'INVALID_INPUT')
  assert.equal(unresolved.gateStatus, 'unresolved')
  assert.equal(unresolved.complexity.label, 'abstain')
}

function testMalformedInputsAbstainWithoutChangingInputOrDispatchPolicy(): void {
  const input = sampleInput({
    complexity: {
      boundedness: 0,
      reversibility: 0,
      dependencies: 3,
      uncertainty: 0,
      verification: 0,
    },
  })
  const before = structuredClone(input)
  const recommendation = recommendLocalDecision(input, enabledEnv)
  assert.equal(recommendation.decision, 'abstain')
  assert.equal(recommendation.agent, null)
  assert.equal(recommendation.reasonCode, 'INVALID_INPUT')
  assert.equal(recommendation.complexity.label, 'abstain')
  assert.equal(recommendation.complexity.reasonCode, 'INVALID_COMPLEXITY')
  assert.deepEqual(input, before)
  assert.equal(Object.hasOwn(recommendation, 'dispatch'), false)
  assert.equal(Object.hasOwn(recommendation, 'permissions'), false)
  assert.equal(Object.hasOwn(recommendation, 'grants'), false)

  const unsupported = recommendLocalDecision(
    { ...sampleInput(), schemaVersion: 99 } as unknown as LocalDecisionInput,
    enabledEnv,
  )
  assert.equal(unsupported.decision, 'abstain')
  assert.equal(unsupported.reasonCode, 'INVALID_INPUT')
  assert.equal(unsupported.complexity.label, 'abstain')

  const unreadable = new Proxy(sampleInput(), {
    getPrototypeOf: () => {
      throw new Error('malformed structured input')
    },
  })
  assert.doesNotThrow(() => recommendLocalDecision(unreadable, enabledEnv))
  assert.equal(recommendLocalDecision(unreadable, enabledEnv).reasonCode, 'INVALID_INPUT')
}

function testRecommendationIsDeterministic(): void {
  const input = sampleInput({
    complexity: {
      boundedness: 0,
      reversibility: 1,
      dependencies: 0,
      uncertainty: 0,
      verification: 1,
    },
  })
  assert.deepEqual(
    recommendLocalDecision(input, enabledEnv),
    recommendLocalDecision(input, enabledEnv),
  )
}

function samplePolicy(): LocalDecisionPolicy {
  return {
    agents: {
      zeus: {
        canDelegateTo: ['hermes', 'aphrodite', 'gaia'],
        skills: ['agent-coordination'],
        capabilities: ['memory_recall'],
        canReceiveDelegation: true,
      },
      hermes: {
        canDelegateTo: ['apollo'],
        skills: ['tdd-with-agents'],
        capabilities: [],
        canReceiveDelegation: true,
      },
      aphrodite: {
        canDelegateTo: [],
        skills: ['visual-review-pipeline'],
        capabilities: [],
        canReceiveDelegation: true,
      },
      gaia: {
        canDelegateTo: [],
        skills: [],
        capabilities: [],
        canReceiveDelegation: true,
      },
    },
    permissionTask: { '*': 'allow', gaia: 'deny' },
  }
}

function sampleOrchestrationInput(
  overrides: Partial<LocalOrchestrationInput> = {},
): LocalOrchestrationInput {
  return {
    schemaVersion: 1,
    candidateAgents: ['hermes'],
    domain: null,
    candidateSkillIds: ['tdd-with-agents', 'not-installed'],
    candidateResourceIds: ['pantheon://routing', 'pantheon://memory-bank/private.md'],
    memorySearchRelevant: true,
    gateStatus: 'human_approval_required',
    complexity: {
      boundedness: 0,
      reversibility: 0,
      dependencies: 1,
      uncertainty: 0,
      verification: 0,
    },
    ...overrides,
  }
}

function testOrchestrationFastPathIsAdvisoryAndCatalogFiltered(): void {
  const plan = recommendLocalOrchestration(sampleOrchestrationInput(), 'zeus', samplePolicy())

  assert.equal(plan.decision, 'recommend')
  assert.equal(plan.agent, 'hermes')
  assert.deepEqual(plan.skillIds, ['tdd-with-agents'])
  assert.deepEqual(plan.resourceIds, ['pantheon://routing'])
  assert.equal(plan.recommendMemorySearch, true)
  assert.equal(plan.gateStatus, 'human_approval_required')
  assert.equal(plan.complexity.label, 'medium')
  assert.equal(plan.action, 'advisory_only')
  assert.equal(Object.hasOwn(plan, 'dispatch'), false)
  assert.equal(Object.hasOwn(plan, 'permissions'), false)
}

function testOrchestrationAbstainsWhenCandidatesAreNotUniquelyResolved(): void {
  const policy = samplePolicy()
  const ambiguous = recommendLocalOrchestration(
    sampleOrchestrationInput({ candidateAgents: ['hermes', 'aphrodite'] }),
    'zeus',
    policy,
  )
  assert.equal(ambiguous.decision, 'abstain')
  assert.equal(ambiguous.reasonCode, 'AMBIGUOUS_CANDIDATE')
  assert.equal(ambiguous.agent, null)

  const unknownDomain = recommendLocalOrchestration(
    sampleOrchestrationInput({
      candidateAgents: ['hermes', 'aphrodite'],
      domain: 'gaia',
    }),
    'zeus',
    policy,
  )
  assert.equal(unknownDomain.decision, 'abstain')
  assert.equal(unknownDomain.reasonCode, 'DOMAIN_NOT_ELIGIBLE')

  const freeText = recommendLocalOrchestration(
    { ...sampleOrchestrationInput(), taskText: 'must never be consumed' },
    'zeus',
    policy,
  )
  assert.equal(freeText.decision, 'abstain')
  assert.equal(freeText.reasonCode, 'INVALID_INPUT')
}

function testOrchestrationFiltersRoutingGrantsAndRequiresZeus(): void {
  const blockedOnly = recommendLocalOrchestration(
    sampleOrchestrationInput({ candidateAgents: ['gaia'] }),
    'zeus',
    samplePolicy(),
  )
  assert.equal(blockedOnly.decision, 'abstain')
  assert.equal(blockedOnly.reasonCode, 'NO_ELIGIBLE_CANDIDATE')

  const nonZeus = recommendLocalOrchestration(sampleOrchestrationInput(), 'hermes', samplePolicy())
  assert.equal(nonZeus.decision, 'abstain')
  assert.equal(nonZeus.reasonCode, 'CALLER_NOT_ZEUS')

  const missingGrants = recommendLocalOrchestration(sampleOrchestrationInput(), 'zeus', {
    ...samplePolicy(),
    permissionTask: {},
  })
  assert.equal(missingGrants.decision, 'abstain')
  assert.equal(missingGrants.reasonCode, 'POLICY_UNAVAILABLE')
}

async function testLocalPolicyLoadsCanonicalRoutingAndGrantData(): Promise<void> {
  const policy = await loadLocalDecisionPolicy()
  assert.ok(policy)
  assert.ok(policy.agents.zeus?.canDelegateTo.includes('hermes'))
  assert.ok(policy.agents.hermes?.skills.includes('tdd-with-agents'))
  assert.equal(policy.permissionTask['*'], 'allow')
}

testDisabledByDefault()
testRoutesOnlyExactCanonicalSpecialistRoles()
testAbstainsForUnknownAndAmbiguousDomains()
testClassifiesOnlyStructuredComplexityDimensions()
testGateStatusIsSeparateFromComplexity()
testMalformedInputsAbstainWithoutChangingInputOrDispatchPolicy()
testRecommendationIsDeterministic()
testOrchestrationFastPathIsAdvisoryAndCatalogFiltered()
testOrchestrationAbstainsWhenCandidatesAreNotUniquelyResolved()
testOrchestrationFiltersRoutingGrantsAndRequiresZeus()
await testLocalPolicyLoadsCanonicalRoutingAndGrantData()

console.log('local decision router tests passed')
