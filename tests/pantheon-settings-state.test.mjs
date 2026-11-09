import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildAboutSection,
  buildGatesSection,
  canWriteOverrides,
  firstSelectableId,
  flatSelectableRows,
  isBehaviorDisabled,
  mergedOverrides,
  SETTINGS_BEHAVIORS,
  SETTINGS_TOGGLABLE_IDS,
  selectableRows,
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

describe('gates section', () => {
  it('marks project-owned rows and makes them non-selectable', () => {
    const section = buildGatesSection(
      load_fixture({}, { 'gate-j1-risk-gate': { action: 'disable' } }),
    )
    const row = section.rows.find((row) => row.id === 'gate.gate-j1-risk-gate')
    assert.equal(row.title, 'J1 risk gate (project)')
    assert.equal(row.selectable, false)
    assert.equal(row.source, 'project')
    assert.equal(row.disabled, true)
  })

  it('global rows stay selectable and reflect the merged state', () => {
    const section = buildGatesSection(
      load_fixture({ 'skill-auto-continue': { action: 'disable' } }, {}),
    )
    const row = section.rows.find((row) => row.id === 'gate.skill-auto-continue')
    assert.equal(row.disabled, true)
    assert.equal(row.selectable, true)
    assert.equal(row.source, 'global')
  })

  it('the hint refuses writes while corrupt and points at doctor', () => {
    const corrupt = buildGatesSection(load_fixture({}, {}, true))
    assert.match(corrupt.hint, /writes refused/)
    assert.match(corrupt.hint, /doctor --fix/)
    const clean = buildGatesSection(load_fixture({}, {}))
    assert.match(clean.hint, /enter: disable\/enable/)
  })

  it('every row is namespaced under gate. and selectable in registry order', () => {
    const section = buildGatesSection(load_fixture({}, {}))
    assert.deepEqual(
      selectableRows(section).map((row) => row.id),
      SETTINGS_BEHAVIORS.map((behavior) => `gate.${behavior.id}`),
    )
  })
})

describe('section model', () => {
  it('flatSelectableRows concatenates sections in order and skips info rows', () => {
    const a = buildGatesSection(load_fixture({}, {}))
    const b = buildAboutSection('2.0.0-beta.1')
    const flat = flatSelectableRows([a, b])
    assert.equal(flat.length, 7, 'about rows are info-only')
    assert.equal(firstSelectableId([a, b]), 'gate.skill-auto-continue')
    assert.equal(firstSelectableId([]), undefined)
  })
})

describe('about section', () => {
  it('names the version and the 2.x-only posture', () => {
    const section = buildAboutSection('2.0.0-beta.2')
    assert.equal(section.rows[0].title, 'Pantheon v2.0.0-beta.2')
    assert.ok(section.rows.some((row) => row.description.includes('V1 contract is removed')))
    for (const row of section.rows) assert.equal(row.selectable, false)
  })
})

function load_fixture(global, project, corruptGlobal = false) {
  return { global, project, corruptGlobal }
}
