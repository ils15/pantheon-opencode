/**
 * D2 — `artifact-management` reachability under a material gate/planning
 * requirement.
 *
 * The defect: the skill was reachable only through the literal keywords
 * `artifact`/`artifacts`/`planned`/`multi-phase`/`impl`, so a request that
 * materially demanded a gate or a plan reached no skill at all.
 *
 * Scope: selection reachability only. This suite makes no claim about prompt
 * narrowing — P2 remains an empirical no-op on the default path (F-09) — and
 * it asserts nothing about filtering.
 *
 * Run with: npx tsx tests/pantheon/local-decision-d2.test.ts
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeUserDecisionRouterConfig } from '../../scripts/install/decision-router-config.mjs'
import {
  MAX_SELECTED_SKILLS,
  selectPantheonSkills,
} from '../../src/pantheon/local-decision-skills.ts'
import { clearTurnDecisionCache, decideForTurn } from '../../src/pantheon/local-decision-turn.ts'

const ARTIFACT_KEYWORDS = /\b(artifacts?|planned|multi-phase|impl)\b/

/** The case that motivated D2: material gate language, no artifact keyword. */
const GATE_REQUEST =
  'Add OAuth login across the API and the web client. It is a breaking change that needs human approval and a rollback plan before cutover.'

/** Material planning language, again with no artifact keyword present. */
const PLANNING_REQUEST =
  'Plan the migration across four milestones and write a work breakdown before editing code.'

function testGateRequirementReachesTheSkill(): void {
  assert.doesNotMatch(GATE_REQUEST, ARTIFACT_KEYWORDS, 'reachability cannot come from the table')
  const selection = selectPantheonSkills(GATE_REQUEST)
  assert.equal(selection.materialRequirement, 'gate')
  assert.equal(selection.reasonCode, 'SELECTED_BY_MATERIAL_REQUIREMENT')
  assert.equal(selection.skillIds[0], 'artifact-management')
}

function testPlanningRequirementReachesTheSkill(): void {
  assert.doesNotMatch(
    PLANNING_REQUEST,
    ARTIFACT_KEYWORDS,
    'reachability cannot come from the table',
  )
  const selection = selectPantheonSkills(PLANNING_REQUEST)
  assert.equal(selection.materialRequirement, 'planning')
  assert.equal(selection.reasonCode, 'SELECTED_BY_MATERIAL_REQUIREMENT')
  assert.equal(selection.skillIds[0], 'artifact-management')
  // Reversibility is planning, not a gate: no approval/cutover/irreversible token.
  const rollbackOnly = selectPantheonSkills('Define a rollback before the release.')
  assert.equal(rollbackOnly.materialRequirement, 'planning')
  assert.equal(rollbackOnly.skillIds[0], 'artifact-management')
}

function testGateWinsWhenBothArePresent(): void {
  const selection = selectPantheonSkills(
    'Plan the rollout phases and get human approval before the cutover.',
  )
  assert.equal(selection.materialRequirement, 'gate')
  assert.equal(selection.skillIds[0], 'artifact-management')
}

function testOrdinaryRequestsAreUnaffected(): void {
  const selection = selectPantheonSkills('implement a backend endpoint with pytest')
  assert.equal(selection.materialRequirement, null)
  assert.equal(selection.reasonCode, 'SELECTED_BY_KEYWORDS')
  assert.equal(selection.skillIds.includes('artifact-management'), false)
  // A keyword-only artifact match keeps the keyword reason and no material token.
  const keyword = selectPantheonSkills('produce the planned artifacts')
  assert.equal(keyword.materialRequirement, null)
  assert.equal(keyword.reasonCode, 'SELECTED_BY_KEYWORDS')
  assert.equal(keyword.skillIds.includes('artifact-management'), true)
}

function testMaterialSeatRespectsTheBudget(): void {
  const tight = selectPantheonSkills(`${GATE_REQUEST} Use pytest and review the tests.`, 2)
  assert.equal(tight.skillIds.length, 2)
  assert.equal(tight.skillIds[0], 'artifact-management')
  const single = selectPantheonSkills(GATE_REQUEST, 1)
  assert.deepEqual(single.skillIds, ['artifact-management'])
  const full = selectPantheonSkills(GATE_REQUEST)
  assert.ok(full.skillIds.length <= MAX_SELECTED_SKILLS)
  assert.ok(full.skillIds.length < 20, 'the catalog is never returned as a fallback')
  assert.deepEqual(selectPantheonSkills(GATE_REQUEST), full, 'selection is deterministic')
}

function testInvalidInputStaysExplicit(): void {
  assert.deepEqual(selectPantheonSkills(''), {
    skillIds: [],
    reasonCode: 'INVALID_INPUT',
    materialRequirement: null,
  })
  assert.equal(selectPantheonSkills(GATE_REQUEST, 0).reasonCode, 'INVALID_INPUT')
  assert.equal(selectPantheonSkills('qwertyuiop').reasonCode, 'NO_LOCAL_MATCH')
  assert.equal(selectPantheonSkills('qwertyuiop').materialRequirement, null)
}

/**
 * The decision surface must carry the seat, not just the helper: `decideForTurn`
 * is the only production caller of `selectPantheonSkills`.
 */
async function testTurnDecisionCarriesTheSeat(): Promise<void> {
  const environment = mkdtempSync(join(tmpdir(), 'pantheon-decision-d2-'))
  const keys = ['HOME', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME'] as const
  const previous = new Map<string, string | undefined>(keys.map((key) => [key, process.env[key]]))
  process.env.HOME = environment
  process.env.XDG_CONFIG_HOME = join(environment, 'config')
  process.env.XDG_STATE_HOME = join(environment, 'state')
  try {
    writeUserDecisionRouterConfig({
      schema_version: 2,
      enabled: true,
      selection: { mode: 'local' },
      egress_consent: false,
      enabled_candidates: [],
    })
    clearTurnDecisionCache()
    const decision = await decideForTurn({
      request: GATE_REQUEST,
      sessionID: 'ses-d2',
      messageID: 'msg-d2',
    })
    assert.equal(decision.active, true)
    assert.equal(decision.source, 'local')
    assert.equal(decision.skillIds[0], 'artifact-management')
    assert.equal(decision.reasonCode, 'LOCAL_SELECTION')
  } finally {
    clearTurnDecisionCache()
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(environment, { recursive: true, force: true })
  }
}

testGateRequirementReachesTheSkill()
testPlanningRequirementReachesTheSkill()
testGateWinsWhenBothArePresent()
testOrdinaryRequestsAreUnaffected()
testMaterialSeatRespectsTheBudget()
testInvalidInputStaysExplicit()
await testTurnDecisionCarriesTheSeat()

console.log('local decision D2 reachability tests passed')
