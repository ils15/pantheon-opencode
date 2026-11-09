import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildAboutTab,
  buildGatesTab,
  canWriteOverrides,
  GATES_ENABLED_CYCLE,
  isBehaviorDisabled,
  mergedOverrides,
  SETTINGS_BEHAVIORS,
  SETTINGS_TOGGLABLE_IDS,
  serializeOverrides,
  tabRows,
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

  it('a replace entry survives disable and is restored on re-enable', () => {
    const authored = {
      'skill-tdd-with-agents': { action: 'replace', content: 'my custom skill' },
    }
    const disabled = toggledOverrides(authored, 'skill-tdd-with-agents')
    assert.equal(isBehaviorDisabled(disabled, 'skill-tdd-with-agents'), true)
    assert.equal(disabled['skill-tdd-with-agents'].content, 'my custom skill')
    const restored = toggledOverrides(disabled, 'skill-tdd-with-agents')
    assert.deepEqual(restored['skill-tdd-with-agents'], {
      action: 'replace',
      content: 'my custom skill',
    })
  })

  it('a settings-written disable is removed outright (no toggle noise)', () => {
    const disabled = toggledOverrides({}, 'gate-context-pruner')
    const enabled = toggledOverrides(disabled, 'gate-context-pruner')
    assert.equal('gate-context-pruner' in enabled, false)
  })
})

describe('overrides load model', () => {
  const load = (global, project, corruptGlobal = false) => ({
    global,
    project,
    corruptGlobal,
  })

  it('the project file wins per id for display (runtime precedence)', () => {
    const merged = mergedOverrides(
      load(
        { 'gate-context-pruner': { action: 'disable' } },
        { 'gate-context-pruner': { action: 'replace', content: 'x' } },
      ),
    )
    assert.equal(isBehaviorDisabled(merged, 'gate-context-pruner'), false)
  })

  it('writes are refused while the global file is corrupt', () => {
    assert.equal(canWriteOverrides(load({}, {}, true)), false)
    assert.equal(canWriteOverrides(load({}, {})), true)
  })
})

describe('gates tab', () => {
  it('marks project-owned rows as read-only (no cycle) with a winning note', () => {
    const tab = buildGatesTab(load_fixture({}, { 'gate-j1-risk-gate': { action: 'disable' } }))
    const row = tabRows(tab).find((row) => row.id === 'gate.gate-j1-risk-gate')
    assert.equal(row.name, 'J1 risk gate (project)')
    assert.equal(row.cycle, undefined)
    assert.match(row.note, /project file wins at runtime/)
    assert.equal(row.value, 'disabled')
  })

  it('global rows stay cyclable and reflect the merged state', () => {
    const tab = buildGatesTab(load_fixture({ 'skill-auto-continue': { action: 'disable' } }, {}))
    const row = tabRows(tab).find((row) => row.id === 'gate.skill-auto-continue')
    assert.equal(row.value, 'disabled')
    assert.deepEqual(row.cycle, GATES_ENABLED_CYCLE)
    assert.equal(row.note, 'Continue multi-step todos while keeping safety gates.')
  })

  it('a corrupt global file takes the cycle away (writes refused)', () => {
    const tab = buildGatesTab(load_fixture({}, {}, true))
    for (const row of tabRows(tab)) {
      assert.equal(row.cycle, undefined, `${row.id} must not stage on a corrupt file`)
    }
  })

  it('groups install skills then runtime gates, all namespaced under gate.', () => {
    const tab = buildGatesTab(load_fixture({}, {}))
    assert.equal(tab.groups.length, 2)
    assert.deepEqual(
      tab.groups.map((group) => group.title),
      ['Install skills', 'Runtime gates'],
    )
    assert.deepEqual(
      tabRows(tab).map((row) => row.id),
      SETTINGS_BEHAVIORS.map((behavior) => `gate.${behavior.id}`),
    )
  })
})

describe('about tab', () => {
  it('names the version and the 2.x-only posture', () => {
    const tab = buildAboutTab('2.0.0-beta.2')
    const rows = tabRows(tab)
    assert.equal(rows[0].value, 'v2.0.0-beta.2')
    assert.ok(rows.some((row) => row.note.includes('V1 contract is removed')))
  })
})

function load_fixture(global, project, corruptGlobal = false) {
  return { global, project, corruptGlobal }
}
