/**
 * P2a — skill source reporting and the empty-selection reason (D3).
 *
 * P2 is an empirical no-op on the default path (F-09, PRE-02): the host sends
 * `skills: "undefined"` (F-08), so nothing is ever narrowed there. This suite
 * asserts that measured shape and that every empty skill selection carries an
 * explicit reason. The array-shaped cases are labelled as synthetic host
 * shapes, because no populated `prompt.skills` was ever observed (PM-07).
 *
 * Run with: npx tsx tests/pantheon/v2-decision-p2.test.ts
 */
import { strict as assert } from 'node:assert'
import {
  applyTurnDecisionToPrompt,
  normalizeMeasuredValue,
  resolveSkillSource,
} from '../../src/pantheon/local-decision-prompt.ts'
import type { TurnDecision } from '../../src/pantheon/local-decision-turn.ts'
import { evaluateSkillPoint } from '../../src/pantheon/v2-decision-points/p2-skill.ts'
import type { ShadowRecord } from '../../src/pantheon/v2-decision-shadow.ts'
import { HOST_PROMPT_PAYLOAD_F08 } from './v2-decision-fixtures.ts'

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
  checks += 1
  void name
}

const REASON_TOKEN = /^[a-z0-9][a-z0-9.:-]{0,63}$/

const selection = (...skillIds: string[]): TurnDecision => ({
  schemaVersion: 1,
  active: true,
  source: 'local',
  skillIds,
  agent: null,
  reasonCode: 'LOCAL_SELECTION',
})

check('the measured host shape is a no-op with an explicit reason (F-08, F-09)', () => {
  const prompt = { text: 'request', skills: 'undefined', agents: 'undefined' }
  const result = applyTurnDecisionToPrompt(prompt, selection('tdd-with-agents'))
  assert.equal(result.skillsFiltered, false)
  assert.equal(result.skillsSource, 'none')
  assert.equal(result.reason, 'skills.source.absent')
  assert.equal(prompt.skills, 'undefined', 'the sentinel is never rewritten')
})

check('the "null" sentinel is treated as absent too', () => {
  const prompt = { text: 'request', skills: 'null' }
  const result = applyTurnDecisionToPrompt(prompt, selection('tdd-with-agents'))
  assert.equal(result.skillsFiltered, false)
  assert.equal(result.skillsSource, 'none')
  assert.equal(prompt.skills, 'null')
})

check('every empty skill selection carries a reason (D3)', () => {
  const cases: ReadonlyArray<readonly [string, unknown, TurnDecision]> = [
    ['sentinel "undefined"', { text: 't', skills: 'undefined' }, selection('simplify')],
    ['sentinel "null"', { text: 't', skills: 'null' }, selection('simplify')],
    ['absent', { text: 't' }, selection('simplify')],
    ['null', { text: 't', skills: null }, selection('simplify')],
    ['empty array', { text: 't', skills: [] }, selection('simplify')],
    ['non-array shape', { text: 't', skills: { name: 'simplify' } }, selection('simplify')],
    ['empty advisory selection', { text: 't', skills: ['simplify'] }, selection()],
    ['disjoint selection', { text: 't', skills: ['simplify'] }, selection('tdd-with-agents')],
    ['unstable identifiers', { text: 't', skills: [{ label: 'simplify' }] }, selection('simplify')],
    ['inactive decision', { text: 't', skills: 'undefined' }, { ...selection('simplify') }],
  ]
  for (const [label, prompt, decision] of cases) {
    const result = applyTurnDecisionToPrompt(prompt, decision)
    assert.equal(result.skillsFiltered, false, label)
    assert.equal(typeof result.reason, 'string', label)
    assert.match(result.reason, REASON_TOKEN, label)
  }
  const inactive = applyTurnDecisionToPrompt(
    { text: 't', skills: 'undefined' },
    { ...selection('simplify'), active: false },
  )
  assert.equal(inactive.reason, 'decision.inactive')
})

check('a supplied draft list is reported, never applied (advisory, P2b is conditional)', () => {
  const prompt = { text: 'request', skills: 'undefined', agents: 'undefined' }
  const before = structuredClone(prompt)
  const result = applyTurnDecisionToPrompt(prompt, selection('tdd-with-agents'), [
    { name: 'tdd-with-agents' },
    { name: 'simplify' },
  ])
  assert.equal(result.skillsFiltered, false)
  assert.equal(result.skillsSource, 'draft')
  assert.equal(result.reason, 'skills.source.draft')
  assert.equal(prompt.skills, 'undefined', 'a draft source never rewrites the skill field')
  assert.equal(prompt.agents, 'undefined')
  assert.deepEqual({ ...prompt, text: 'request' }, before, 'only the marker touches admission')
})

check(
  'a real prompt array is the prompt source; narrowing happens only on that unmeasured shape',
  () => {
    // Synthetic host shape: no populated prompt.skills was ever observed (F-08, PM-07).
    const prompt = {
      text: 'request',
      skills: [{ name: 'tdd-with-agents' }, { name: 'simplify' }],
    }
    const result = applyTurnDecisionToPrompt(prompt, selection('tdd-with-agents'))
    assert.equal(result.skillsSource, 'prompt')
    assert.equal(result.reason, 'skills.synthetic.narrowed')
    assert.deepEqual(prompt.skills, [{ name: 'tdd-with-agents' }])
  },
)

check('the measured sentinel normalizes to absent, a real value does not', () => {
  assert.equal(normalizeMeasuredValue('undefined'), undefined)
  assert.equal(normalizeMeasuredValue('null'), undefined)
  assert.equal(normalizeMeasuredValue(undefined), undefined)
  assert.equal(normalizeMeasuredValue(null), undefined)
  assert.deepEqual(normalizeMeasuredValue(['simplify']), ['simplify'])
  assert.equal(normalizeMeasuredValue('simplify'), 'simplify')
})

check('the prompt list wins over a draft list; the draft only fills an absence', () => {
  const both = resolveSkillSource([{ name: 'simplify' }], [{ name: 'worktrees' }])
  assert.equal(both.skillsSource, 'prompt')
  assert.deepEqual(both.skillIds, ['simplify'])
  assert.equal(both.reason, 'skills.source.prompt')
  const absent = resolveSkillSource('undefined', [{ name: 'worktrees' }])
  assert.equal(absent.skillsSource, 'draft')
  assert.deepEqual(absent.skillIds, ['worktrees'])
  const none = resolveSkillSource('undefined', 'null')
  assert.equal(none.skillsSource, 'none')
  assert.deepEqual(none.skillIds, [])
})

check('the P2 shadow adapter leaves the measured payload untouched', () => {
  const payload = structuredClone(HOST_PROMPT_PAYLOAD_F08)
  const before = structuredClone(payload)
  const result = evaluateSkillPoint(payload)
  assert.deepEqual(payload, before, 'admission payload must be unchanged')
  assert.equal(result.skillsSource, 'none')
  assert.equal(result.rankedSkillIds.length, 0)
  assert.equal(result.record.effect, 'none')
  assert.equal(result.record.decision, 'refusal')
  assert.equal(result.record.reason, 'skills.source.absent')
})

check('the P2 shadow adapter ranks a draft list without touching admission', () => {
  const payload = structuredClone(HOST_PROMPT_PAYLOAD_F08)
  const before = structuredClone(payload)
  const records: ShadowRecord[] = []
  const result = evaluateSkillPoint(payload, (record) => records.push(record), [
    { name: 'worktrees' },
    { name: 'simplify' },
  ])
  assert.deepEqual(payload, before)
  assert.equal(result.skillsSource, 'draft')
  assert.deepEqual(result.rankedSkillIds, ['simplify', 'worktrees'])
  assert.equal(records.length, 1)
  assert.equal(records[0]?.effect, 'none')
  assert.equal(records[0]?.decision, 'rank')
})

check('a hostile payload becomes a contained record, never a throw', () => {
  const payload = { prompt: { skills: 'undefined' }, callback: () => 1 }
  const result = evaluateSkillPoint(payload)
  assert.equal(result.record.decision, 'unavailable')
  assert.equal(result.record.reason, 'payload_not_clonable')
  const nonObject = evaluateSkillPoint('not-a-payload')
  assert.equal(nonObject.record.effect, 'none')
})

console.log(`V2 decision P2: ${checks} groups passed`)
