/**
 * Phase-2 tests for the local decision surface, post fetch-path removal.
 *
 * The direct-provider branch (payload allowlist, endpoint matrix, transport
 * bounds, turn cache) was removed with the legacy fetch runner; the native
 * route is the explicit `pantheon_jev_decide` tool, covered by
 * jev-decisions.test.ts. What remains here is the production local path:
 * deterministic selection, prompt application bounds, hook local-only
 * behavior, and the package-level contracts.
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeUserDecisionRouterConfig } from '../../scripts/install/decision-router-config.mjs'
import {
  hasDelegationSignal,
  recommendLocalDecisionAgent,
} from '../../src/pantheon/local-decision-agents.ts'
import {
  applyDecisionRouterToPrompt,
  applyTurnDecisionToPrompt,
} from '../../src/pantheon/local-decision-prompt.ts'
import { selectPantheonSkills } from '../../src/pantheon/local-decision-skills.ts'
import type { TurnDecision } from '../../src/pantheon/local-decision-turn.ts'
import { localDecisionForTest, shouldRefine } from '../../src/pantheon/local-decision-turn.ts'
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
  }
  for (const key of ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']) {
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

function writeEnabledConfig(): void {
  writeUserDecisionRouterConfig({
    schema_version: 2,
    enabled: true,
    selection: { mode: 'explicit', provider: 'opencode-console-jev', model: 'jev-1.13' },
    egress_consent: true,
    enabled_candidates: [{ provider: 'opencode-console-jev', model: 'jev-1.13' }],
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

function testDeterministicRefineHeuristic(): void {
  // Field beta.22→23: the owner wants refinement ACCESSIBLE and mechanical —
  // no Jev deciding whether to refine (negative economics). Pure text rules.
  assert.equal(
    shouldRefine(
      'refatora o dashboard do meu projeto: os calculos de saque tao errados, queria abas separadas, e a fonte ta pequena e ruim. melhora tudo isso',
    ),
    true,
    'vague multi-concern refines',
  )
  assert.equal(
    shouldRefine('corrija o typo na linha 3 do README'),
    false,
    'a one-liner never refines',
  )
  assert.equal(
    shouldRefine('refatora o dashboard e melhora a fonte. criterios de aceite: testes passando'),
    false,
    'explicit acceptance criteria suppress the flag',
  )
  assert.equal(
    shouldRefine('melhora a fonte do dashboard'),
    false,
    'single concern, short — execute',
  )
  assert.equal(
    shouldRefine(
      'rewrite the auth module and restructure the config, also fix the migration scripts please',
    ),
    true,
    'EN multi-concern refines too',
  )
  // The turn decision carries the flag end to end.
  process.env.PANTHEON_LOCAL_DECISION_ROUTER = '1'
  try {
    const decision = localDecisionForTest(
      'refatora o dashboard: calculos errados, abas separadas, fonte ruim',
      samplePolicy(),
    )
    assert.equal(decision.refineRecommended, true, 'the flag rides the turn decision')
  } finally {
    delete process.env.PANTHEON_LOCAL_DECISION_ROUTER
  }
}

function testAgentSkillFallbackFeedsPtDelegations(): void {
  // D3 (field reports beta.13-16): same domain, EN fed / PT starved.
  process.env.PANTHEON_LOCAL_DECISION_ROUTER = '1'
  try {
    const en = decideLocalForTurnSync(
      'delegar para hermes: implement a FastAPI backend endpoint with pytest',
    )
    assert.equal(en.agent, 'hermes')
    assert.ok(en.skillIds.length > 0, 'EN feeds')
    const pt = decideLocalForTurnSync(
      'delegar: implementar um endpoint FastAPI com testes de integracao',
    )
    assert.equal(pt.agent, 'hermes')
    assert.ok(pt.skillIds.length > 0, 'PT no longer starves (D3)')
    assert.ok(pt.skillIds.includes('tdd-with-agents'), 'the fallback is hermes-relevant')
    // A no-signal request stays skill-only, no agent fallback leaks.
    const quiet = decideLocalForTurnSync('apenas um comentario qualquer sem delegacao')
    assert.equal(quiet.agent, null)
  } finally {
    delete process.env.PANTHEON_LOCAL_DECISION_ROUTER
  }
}

function decideLocalForTurnSync(request: string) {
  // The env flag is read at call time; policy load is best-effort (undefined
  // policy still routes skills, agent needs policy — read it like prod does).
  const decision = localDecisionForTest(request, samplePolicy())
  return decision
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

async function testDisabledConfigLeavesPromptUntouchedAndFetchesNothing(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    writeUserDecisionRouterConfig({
      schema_version: 2,
      enabled: false,
      selection: { mode: 'explicit', provider: 'opencode-console-jev', model: 'jev-1.13' },
      egress_consent: true,
      enabled_candidates: [{ provider: 'opencode-console-jev', model: 'jev-1.13' }],
    })
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

async function testPromptHookSuppressesVisibleMarkerWithoutEgress(): Promise<void> {
  const environment = sandbox()
  await withEnvironment(environment, async () => {
    writeEnabledConfig()
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
    assert.equal(applied.markerApplied, false)
    assert.equal(applied.skillsFiltered, false)
    assert.equal(applied.skillsSource, 'none')
    assert.equal(applied.reason, 'skills.source.absent')
    // The visible marker is suppressed (1.6.2-beta.10): the host chat rendered
    // the HTML comment to the user. The router itself still runs, without egress.
    assert.equal(admission.prompt.text, 'implement a backend endpoint with pytest')
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
  assert.equal(applied.markerApplied, false)
  assert.equal(prompt.text, 'original request', 'no visible marker is appended')
  assert.equal(applied.skillsFiltered, true, 'synthetic host shape only')
  assert.equal(applied.skillsSource, 'prompt')
  assert.deepEqual(prompt.skills, [{ name: 'tdd-with-agents' }])
  const repeated = applyTurnDecisionToPrompt(prompt, decision)
  assert.equal(repeated.markerApplied, false)
  assert.equal(prompt.text, 'original request')
  assert.deepEqual(prompt.skills, [{ name: 'tdd-with-agents' }])
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

function testFetchProviderPathIsRemoved(): void {
  for (const relative of [
    'src/pantheon/local-decision-provider.internal.ts',
    'src/pantheon/local-decision-provider-protocol.ts',
  ]) {
    assert.equal(
      existsSync(new URL(`../../${relative}`, import.meta.url)),
      false,
      `${relative} was removed with the direct-fetch provider path`,
    )
  }
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { exports: Record<string, string> }
  assert.equal(Object.hasOwn(packageJson.exports, './local-decision-provider'), false)
  assert.equal(Object.hasOwn(packageJson.exports, './local-decision-turn'), false)
  assert.equal(Object.hasOwn(packageJson.exports, './local-decision-router'), true)
  const v1 = readFileSync(new URL('../../src/plugin.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(v1, /local-decision-provider|runProviderDecision|decideForTurn/)
  const v2 = readFileSync(new URL('../../src/plugin.ts', import.meta.url), 'utf8')
  const promptModule = readFileSync(
    new URL('../../src/pantheon/local-decision-prompt.ts', import.meta.url),
    'utf8',
  )
  assert.doesNotMatch(v2, /runProviderDecision/)
  assert.match(v2, /applyDecisionRouterToPrompt\(/)
  assert.doesNotMatch(promptModule, /decideForTurn|runProviderDecision|globalThis\.fetch/)
  assert.match(promptModule, /decideLocalForTurn/)
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

testCatalogAndSkillSelection()
testAgentRecommendationOnlyUsesEligibleCandidates()
await testDisabledConfigLeavesPromptUntouchedAndFetchesNothing()
await testPromptHookSuppressesVisibleMarkerWithoutEgress()
testPromptApplicationIsIdempotentAndBounded()
testFetchProviderPathIsRemoved()
testEmptySelectionNeverErasesHostSkills()
await testPolicyCacheIsProcessScopedAndInvalidatable()
testAgentSkillFallbackFeedsPtDelegations()
testDeterministicRefineHeuristic()

console.log('local decision phase 2 tests passed')
