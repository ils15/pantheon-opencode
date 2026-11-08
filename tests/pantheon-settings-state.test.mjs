import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  aboutRows,
  isBehaviorDisabled,
  SETTINGS_BEHAVIORS,
  SETTINGS_TOGGLABLE_IDS,
  serializeOverrides,
  toggledOverrides,
} from '../src/plugins/tui/src/pantheon-settings-state.ts'

describe('settings behaviors registry', () => {
  it('carries the seven 2.0 behaviors with unique ids', () => {
    const ids = SETTINGS_BEHAVIORS.map((b) => b.id)
    assert.equal(ids.length, 7)
    assert.equal(new Set(ids).size, 7, 'behavior ids must be unique')
    for (const id of ids) assert.match(id, /^(skill|gate)-/)
  })

  it('every behavior is togglable from the settings window', () => {
    for (const behavior of SETTINGS_BEHAVIORS) {
      assert.ok(SETTINGS_TOGGLABLE_IDS.has(behavior.id))
    }
  })
})

describe('toggle + serialize round-trip', () => {
  it('toggling a disabled behavior back removes the entry', () => {
    const disabled = toggledOverrides({}, 'gate-j1-risk-gate')
    assert.equal(isBehaviorDisabled(disabled, 'gate-j1-risk-gate'), true)
    const enabled = toggledOverrides(disabled, 'gate-j1-risk-gate')
    assert.equal(isBehaviorDisabled(enabled, 'gate-j1-risk-gate'), false)
  })

  it('serializes sorted and stable for review-friendly diffs', () => {
    const a = toggledOverrides({}, 'gate-j1-risk-gate')
    const b = toggledOverrides(a, 'skill-tdd-with-agents')
    const text = serializeOverrides(b)
    assert.match(text, /"gate-j1-risk-gate"/)
    assert.match(text, /"skill-tdd-with-agents"/)
    assert.equal(serializeOverrides(b), text, 'serialization is stable')
  })

  it('unknown ids still round-trip (registry drift does not strand user state)', () => {
    const disabled = toggledOverrides({}, 'not-in-registry')
    assert.equal(isBehaviorDisabled(disabled, 'not-in-registry'), true)
  })
})

describe('about rows', () => {
  it('names the version and the 2.x-only posture', () => {
    const rows = aboutRows({ version: '2.0.0-beta.1', skillCount: 23, agentCount: 14 })
    assert.ok(rows.some((row) => row.includes('2.0.0-beta.1')))
    assert.ok(rows.some((row) => row.includes('V1 contract is removed')))
  })
})
