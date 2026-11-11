import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildAutonomyTab } from '../src/plugins/tui/src/autonomy-state.ts'
import { buildDecisionTab } from '../src/plugins/tui/src/decision-router-state.ts'
import { buildJ1Tab } from '../src/plugins/tui/src/j1-gate-status.ts'
import { resolveLanguage, SUPPORTED_LANGUAGES, t } from '../src/plugins/tui/src/settings-i18n.ts'

describe('TUI settings i18n resolution', () => {
  it('exposes auto, pt-BR and en supported languages', () => {
    assert.deepEqual(SUPPORTED_LANGUAGES, ['auto', 'pt-BR', 'en'])
  })

  it('respects explicit language preferences over environment', () => {
    assert.equal(resolveLanguage('pt-BR', { LANG: 'en_US.UTF-8' }), 'pt-BR')
    assert.equal(resolveLanguage('en', { LANG: 'pt_BR.UTF-8' }), 'en')
  })

  it('detects pt-BR from LANG or LC_ALL in auto mode', () => {
    assert.equal(resolveLanguage('auto', { LANG: 'pt_BR.UTF-8' }), 'pt-BR')
    assert.equal(resolveLanguage(undefined, { LC_ALL: 'pt_PT.UTF-8' }), 'pt-BR')
    assert.equal(resolveLanguage(undefined, { LANG: 'pt-BR' }), 'pt-BR')
  })

  it('falls back to en when no Portuguese locale is detected', () => {
    assert.equal(resolveLanguage('auto', { LANG: 'C.UTF-8' }), 'en')
    assert.equal(resolveLanguage(undefined, {}), 'en')
    assert.equal(resolveLanguage('unknown', { LANG: 'fr_FR.UTF-8' }), 'en')
  })

  it('translates known entries using t helper', async () => {
    const { I18N } = await import('../src/plugins/tui/src/settings-i18n.ts')
    assert.equal(t(I18N.tabs.decision, 'pt-BR'), 'Decisão (Jev)')
    assert.equal(t(I18N.tabs.decision, 'en'), 'Decision (Jev)')
    assert.equal(t(I18N.tabs.safety, 'pt-BR'), 'Segurança (J1)')
  })
})

describe('Bilingual settings tabs rendering', () => {
  it('renders Decision tab localized in pt-BR', () => {
    const tabPt = buildDecisionTab(
      {
        config: {
          schema_version: 1,
          enabled: false,
          selection: { mode: 'local' },
          egress_consent: false,
          enabled_candidates: [],
        },
        corrupt: false,
      },
      {},
      new Set(),
      new Set(),
      'pt-BR',
    )
    assert.equal(tabPt.title, 'Decisão')
    const rows = tabPt.groups.flatMap((g) => g.rows)
    const routerRow = rows.find((r) => r.id === 'decision.enabled')
    assert.equal(routerRow.name, 'Assistente Jev')
    assert.match(routerRow.note, /tempo real/)

    const targetRow = rows.find((r) => r.id === 'decision.selection.target')
    assert.ok(targetRow !== undefined, 'decision target is permanently visible in v2.0.1')
    assert.equal(targetRow.name, 'Modelo de decisão')
    assert.match(targetRow.note, /ciclar seleciona modelo remoto/)
  })

  it('renders Autonomy tab localized in pt-BR', () => {
    const tabPt = buildAutonomyTab({
      goalLoop: { enabled: true, cooldownMs: 5000, maxContinuations: 25 },
      budgets: { monthlyUsd: 10, perDecisionUsd: 0.25 },
      languagePref: 'pt-BR',
    })
    assert.equal(tabPt.title, 'Autonomia')
    const rows = tabPt.groups.flatMap((g) => g.rows)
    const monthly = rows.find((r) => r.id === 'autonomy.budget.monthly')
    assert.equal(monthly.name, 'Teto mensal')
    assert.match(monthly.note, /USD para arbitragem/)
  })

  it('renders J1 safety tab localized in pt-BR', () => {
    const tabPt = buildJ1Tab({ PANTHEON_J1_RISK_SCORE: 'shadow' }, false, 'pt-BR')
    assert.equal(tabPt.title, 'Segurança J1')
    const rows = tabPt.groups.flatMap((g) => g.rows)
    const modeRow = rows.find((r) => r.id === 'j1.mode')
    assert.equal(modeRow.name, 'Modo de execução')
    assert.match(modeRow.note, /telemetria/)
  })
})
