/**
 * P1 (agent) shadow behaviour.
 *
 * Every assertion uses the measured prompt shape (F-08: `agents: "undefined"`)
 * except the one labelled synthetic, because a populated `prompt.agents` was
 * never observed (PM-07). Shadow is proven the transactional way: the
 * admission payload is unchanged after the adapter runs, and a payload that
 * already carries the admission marker is unchanged too — the marker is
 * asserted separately.
 *
 * Run with: npx tsx tests/pantheon/v2-decision-p1.test.ts
 */
import { strict as assert } from 'node:assert'
import { applyTurnDecisionToPrompt } from '../../src/pantheon/local-decision-prompt.ts'
import type { TurnDecision } from '../../src/pantheon/local-decision-turn.ts'
import { evaluateAgentPoint } from '../../src/pantheon/v2-decision-points/p1-agent.ts'
import type { ShadowRecord } from '../../src/pantheon/v2-decision-shadow.ts'
import { HOST_PROMPT_PAYLOAD_F08 } from './v2-decision-fixtures.ts'

let checks = 0
const check = (name: string, fn: () => void): void => {
  fn()
  checks += 1
  void name
}

check('the measured payload yields a contained refusal, not a throw', () => {
  const payload = structuredClone(HOST_PROMPT_PAYLOAD_F08)
  const before = structuredClone(payload)
  const result = evaluateAgentPoint(payload)
  assert.deepEqual(payload, before, 'shadow never mutates admission')
  assert.equal(result.agentSource, 'none')
  assert.deepEqual(result.agentIds, [])
  assert.deepEqual(result.record, {
    point: 'P1',
    decision: 'refusal',
    effect: 'none',
    reason: 'no.candidates',
  })
})

check('the "undefined"/"null" sentinels are absent, not candidate names', () => {
  for (const sentinel of ['undefined', 'null']) {
    const result = evaluateAgentPoint({ prompt: { text: 't', agents: sentinel } })
    assert.equal(result.agentSource, 'none', sentinel)
    assert.deepEqual(result.agentIds, [], sentinel)
    assert.equal(result.reason, 'no.candidates', sentinel)
  }
})

check('a populated list is a premise and is never given invented evidence (PM-07)', () => {
  // Synthetic host shape: populated prompt.agents was never observed.
  const payload = {
    prompt: { text: 't', agents: [{ name: 'hermes' }, 'themis', { name: 'hermes' }] },
  }
  const before = structuredClone(payload)
  const result = evaluateAgentPoint(payload)
  assert.deepEqual(payload, before)
  assert.equal(result.agentSource, 'agents')
  assert.deepEqual(result.agentIds, ['hermes', 'themis'])
  assert.equal(result.record.decision, 'refusal')
  assert.equal(result.reason, 'insufficient.evidence')
})

check('an already-marked payload keeps only its marker (effect asserted separately)', () => {
  const decision: TurnDecision = {
    schemaVersion: 1,
    active: true,
    source: 'local',
    skillIds: [],
    agent: 'hermes',
    reasonCode: 'LOCAL_SELECTION',
  }
  const prompt = { text: 'request', skills: 'undefined', agents: 'undefined' }
  applyTurnDecisionToPrompt(prompt, decision)
  const snapshot = structuredClone(prompt)
  const result = evaluateAgentPoint({ sessionID: 'ses_x', prompt })
  assert.deepEqual(prompt, snapshot, 'shadow adds nothing on top of the marker')
  assert.match(prompt.text, /<!-- pantheon-decision-router:v1 source=local agent=hermes -->/)
  assert.equal(result.record.effect, 'none')
})

check('one record per evaluation; a throwing sink never escapes', () => {
  const records: ShadowRecord[] = []
  evaluateAgentPoint({ prompt: { agents: 'undefined' } }, (record) => records.push(record))
  assert.equal(records.length, 1)
  assert.equal(records[0]?.point, 'P1')
  const contained = evaluateAgentPoint({ prompt: { agents: 'undefined' } }, () => {
    throw new Error('sink failure')
  })
  assert.equal(contained.record.effect, 'none')
})

check('a hostile payload is recorded as unclonable and never reaches the decision', () => {
  const result = evaluateAgentPoint({ prompt: { agents: 'undefined' }, callback: () => 1 })
  assert.equal(result.record.decision, 'unavailable')
  assert.equal(result.record.reason, 'payload_not_clonable')
  const nonObject = evaluateAgentPoint('not-a-payload')
  assert.equal(nonObject.record.effect, 'none')
  assert.equal(nonObject.reason, 'no.candidates')
})

console.log(`V2 decision P1: ${checks} groups passed`)
