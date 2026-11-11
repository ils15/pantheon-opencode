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
import { tabRows } from '../src/plugins/tui/src/pantheon-settings-state.ts'
import {
  applyTuiRow,
  buildTuiTab,
  clearTuiDraftPreview,
  DEFAULT_TUI_PREFS,
  GAUGE_STYLES,
  normalizeTuiPrefs,
  previewTuiPrefs,
  savedTuiPrefs,
  setTuiDraftPreview,
  tuiDraftPreview,
  tuiPrefs,
  tuiRowValue,
} from '../src/plugins/tui/src/tui-prefs.ts'

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

  it('handles legacy store shapes where layout is missing without throwing', () => {
    const legacyPrefs = structuredClone(DEFAULT_TUI_PREFS)
    delete legacyPrefs.layout
    assert.doesNotThrow(() => {
      const rows = tabRows(buildTuiTab(legacyPrefs))
      assert.equal(rows.find((row) => row.id === 'tui.layout.preset').value, 'comfortable')
    })
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

  it('supports bar shapes, widths, even-mark, and layout preset', () => {
    const draft = structuredClone(DEFAULT_TUI_PREFS)
    applyTuiRow(draft, 'tui.sidebar.context.barShape', 'dots')
    applyTuiRow(draft, 'tui.sidebar.context.barWidth', 'wide')
    applyTuiRow(draft, 'tui.sidebar.context.evenMark', 'enabled')
    applyTuiRow(draft, 'tui.layout.preset', 'compact')
    applyTuiRow(draft, 'tui.layout.separator', 'pipes')
    applyTuiRow(draft, 'tui.layout.settingsView', 'fullscreen')

    assert.equal(tuiRowValue(draft, 'tui.sidebar.context.barShape'), 'dots')
    assert.equal(tuiRowValue(draft, 'tui.sidebar.context.barWidth'), 'wide')
    assert.equal(tuiRowValue(draft, 'tui.sidebar.context.evenMark'), 'enabled')
    assert.equal(tuiRowValue(draft, 'tui.layout.preset'), 'compact')
    assert.equal(tuiRowValue(draft, 'tui.layout.separator'), 'pipes')
    assert.equal(tuiRowValue(draft, 'tui.layout.settingsView'), 'fullscreen')
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

describe('previewTuiPrefs & live draft preview', () => {
  it('returns base unchanged when draft is empty or undefined', () => {
    assert.deepEqual(previewTuiPrefs(DEFAULT_TUI_PREFS, undefined), DEFAULT_TUI_PREFS)
    assert.deepEqual(previewTuiPrefs(DEFAULT_TUI_PREFS, {}), DEFAULT_TUI_PREFS)
  })

  it('overlays staged tui draft changes without mutating base', () => {
    const base = structuredClone(DEFAULT_TUI_PREFS)
    const draft = {
      'tui.sidebar.context.barShape': 'braille',
      'tui.sidebar.context.barWidth': 'compact',
      'tui.sidebar.context.evenMark': 'enabled',
      'tui.layout.preset': 'compact',
      'tui.sidebar.header.session': 'disabled',
    }
    const preview = previewTuiPrefs(base, draft)

    assert.equal(preview.sidebar.context.barShape, 'braille')
    assert.equal(preview.sidebar.context.barWidth, 'compact')
    assert.equal(preview.sidebar.context.evenMark, true)
    assert.equal(preview.layout.preset, 'compact')
    assert.equal(preview.sidebar.header.session, false)

    // Base remains completely untouched
    assert.equal(base.sidebar.context.barShape, 'line')
    assert.equal(base.sidebar.context.barWidth, 'standard')
    assert.equal(base.sidebar.context.evenMark, false)
    assert.equal(base.layout.preset, 'comfortable')
    assert.equal(base.sidebar.header.session, true)
  })

  it('ignores non-tui keys in draft', () => {
    const preview = previewTuiPrefs(DEFAULT_TUI_PREFS, {
      'gate.foo': 'disabled',
      'decision.mode': 'auto',
    })
    assert.deepEqual(preview, DEFAULT_TUI_PREFS)
  })

  it('tuiPrefs reacts live to setTuiDraftPreview and clearTuiDraftPreview', () => {
    clearTuiDraftPreview()
    assert.equal(tuiDraftPreview(), undefined)
    assert.equal(tuiPrefs().sidebar.context.barShape, 'line')

    setTuiDraftPreview({
      'tui.sidebar.context.barShape': 'braille',
      'tui.sidebar.context.barWidth': 'compact',
      'tui.sidebar.context.evenMark': 'enabled',
    })

    assert.equal(tuiPrefs().sidebar.context.barShape, 'braille')
    assert.equal(tuiPrefs().sidebar.context.barWidth, 'compact')
    assert.equal(tuiPrefs().sidebar.context.evenMark, true)
    // savedTuiPrefs still shows base
    assert.equal(savedTuiPrefs().sidebar.context.barShape, 'line')

    clearTuiDraftPreview()
    assert.equal(tuiDraftPreview(), undefined)
    assert.equal(tuiPrefs().sidebar.context.barShape, 'line')
    assert.equal(tuiPrefs().sidebar.context.barWidth, 'standard')
    assert.equal(tuiPrefs().sidebar.context.evenMark, false)
  })
})
