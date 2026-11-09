/**
 * tui-prefs.test.mjs — the TUI personalization core (beta.5).
 *
 * Pure module: normalize (default-merge over stored JSON), the cycler tab
 * builder, applyTuiRow (in-place, mutate-callback shaped) and the value
 * reader. The durable store itself is host-side and never runs here.
 *
 * Run: node --test tests/tui-prefs.test.mjs
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  applyTuiRow,
  buildTuiTab,
  DEFAULT_TUI_PREFS,
  GAUGE_STYLES,
  normalizeTuiPrefs,
  tuiRowValue,
} from '../src/plugins/tui/src/tui-prefs.ts'
import { tabRows } from '../src/plugins/tui/src/pantheon-settings-state.ts'

describe('normalizeTuiPrefs', () => {
  it('returns the defaults for junk input', () => {
    assert.deepEqual(normalizeTuiPrefs(null), DEFAULT_TUI_PREFS)
    assert.deepEqual(normalizeTuiPrefs('nope'), DEFAULT_TUI_PREFS)
    assert.deepEqual(normalizeTuiPrefs(undefined), DEFAULT_TUI_PREFS)
  })

  it('merges a partial stored shape over the defaults per key', () => {
    const prefs = normalizeTuiPrefs({
      sidebar: { blocks: { git: false }, context: { gauge: 'percent' } },
      footer: { prompt: false },
    })
    assert.equal(prefs.sidebar.blocks.git, false)
    assert.equal(prefs.sidebar.blocks.context, true, 'untouched keys stay default')
    assert.equal(prefs.sidebar.context.gauge, 'percent')
    assert.equal(prefs.footer.prompt, false)
    assert.equal(prefs.footer.home, true)
    assert.equal(prefs.sidebar.header.version, true)
  })

  it('a junk gauge value falls back to the default, never stored raw', () => {
    const prefs = normalizeTuiPrefs({ sidebar: { context: { gauge: 'rainbow' } } })
    assert.equal(prefs.sidebar.context.gauge, 'both')
  })

  it('non-boolean junk coerces to the default', () => {
    const prefs = normalizeTuiPrefs({ sidebar: { blocks: { git: 'yes-please' } } })
    assert.equal(prefs.sidebar.blocks.git, true)
  })
})

describe('buildTuiTab', () => {
  it('exposes every pref as a cycler row with the dotted tui. id', () => {
    const tab = buildTuiTab(DEFAULT_TUI_PREFS)
    const rows = tabRows(tab)
    const ids = rows.map((row) => row.id)
    for (const expected of [
      'tui.sidebar.header.version',
      'tui.sidebar.block.git',
      'tui.sidebar.context.gauge',
      'tui.sidebar.context.localSpend',
      'tui.footer.prompt',
      'tui.footer.home',
    ]) {
      assert.ok(ids.includes(expected), `missing row ${expected}`)
    }
  })

  it('boolean rows cycle enabled/disabled; the gauge row carries the four styles', () => {
    const rows = tabRows(buildTuiTab(DEFAULT_TUI_PREFS))
    const git = rows.find((row) => row.id === 'tui.sidebar.block.git')
    assert.deepEqual(git.cycle, ['enabled', 'disabled'])
    assert.equal(git.value, 'enabled')
    const gauge = rows.find((row) => row.id === 'tui.sidebar.context.gauge')
    assert.deepEqual(gauge.cycle, GAUGE_STYLES)
    assert.equal(gauge.value, 'both')
  })

  it('rows reflect the prefs values, not the defaults', () => {
    const prefs = normalizeTuiPrefs({
      sidebar: { blocks: { dispatch: false }, context: { gauge: 'bar' } },
    })
    const rows = tabRows(buildTuiTab(prefs))
    assert.equal(rows.find((row) => row.id === 'tui.sidebar.block.dispatch').value, 'disabled')
    assert.equal(rows.find((row) => row.id === 'tui.sidebar.context.gauge').value, 'bar')
  })
})

describe('applyTuiRow', () => {
  it('mutates the draft in place (the storage mutate callback shape)', () => {
    const draft = structuredClone(DEFAULT_TUI_PREFS)
    applyTuiRow(draft, 'tui.sidebar.block.git', 'disabled')
    assert.equal(draft.sidebar.blocks.git, false)
    applyTuiRow(draft, 'tui.sidebar.context.gauge', 'percent')
    assert.equal(draft.sidebar.context.gauge, 'percent')
    applyTuiRow(draft, 'tui.footer.prompt', 'disabled')
    assert.equal(draft.footer.prompt, false)
  })

  it('unknown ids and junk values are no-ops (fail-open)', () => {
    const draft = structuredClone(DEFAULT_TUI_PREFS)
    applyTuiRow(draft, 'tui.sidebar.block.nope', 'disabled')
    applyTuiRow(draft, 'tui.sidebar.context.gauge', 'rainbow')
    assert.deepEqual(draft, DEFAULT_TUI_PREFS)
  })

  it('a full stage→apply round trip lands every staged value', () => {
    const draft = structuredClone(DEFAULT_TUI_PREFS)
    applyTuiRow(draft, 'tui.sidebar.block.todo', 'disabled')
    applyTuiRow(draft, 'tui.footer.home', 'disabled')
    assert.equal(tuiRowValue(draft, 'tui.sidebar.block.todo'), 'disabled')
    assert.equal(tuiRowValue(draft, 'tui.footer.home'), 'disabled')
    assert.equal(tuiRowValue(draft, 'tui.sidebar.block.git'), 'enabled')
    assert.equal(tuiRowValue(draft, 'not.a.row'), undefined)
  })
})
