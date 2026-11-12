import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildAutonomyTab } from '../src/plugins/tui/src/autonomy-state.ts'
import { buildDecisionTab } from '../src/plugins/tui/src/decision-router-state.ts'
import { buildJ1Tab } from '../src/plugins/tui/src/j1-gate-status.ts'
import {
  buildAboutTab,
  buildChangelogTab,
  buildGatesTab,
} from '../src/plugins/tui/src/pantheon-settings-state.ts'
import { buildPresetTab } from '../src/plugins/tui/src/preset-state.ts'
import { resolveLanguage, SUPPORTED_LANGUAGES, t } from '../src/plugins/tui/src/settings-i18n.ts'
import { buildTuiTab, DEFAULT_TUI_PREFS } from '../src/plugins/tui/src/tui-prefs.ts'

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
    assert.equal(resolveLanguage('auto', { LANG: 'C.UTF-8', TZ: 'UTC' }), 'en')
    assert.equal(resolveLanguage(undefined, { TZ: 'UTC' }), 'en')
    assert.equal(resolveLanguage('unknown', { LANG: 'fr_FR.UTF-8', TZ: 'UTC' }), 'en')
  })

  it('detects pt-BR from Brazilian timezone even when LANG is C.UTF-8', () => {
    assert.equal(resolveLanguage('auto', { LANG: 'C.UTF-8', TZ: 'America/Sao_Paulo' }), 'pt-BR')
    assert.equal(resolveLanguage(undefined, { TZ: 'America/Fortaleza' }), 'pt-BR')
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
    assert.equal(targetRow.name, 'Modelo de Decisão')
    assert.match(targetRow.note, /ciclar seleciona modelo remoto/)

    const consentRow = rows.find((r) => r.id === 'decision.consent')
    assert.equal(consentRow.name, 'Acesso à Nuvem')
  })

  it('renders Autonomy tab localized in pt-BR', () => {
    const tabPt = buildAutonomyTab({
      goalLoop: { enabled: true, cooldownMs: 5000, maxContinuations: 25 },
      budgets: { monthlyUsd: 10, perDecisionUsd: 0.25 },
      languagePref: 'pt-BR',
    })
    assert.equal(tabPt.title, 'Autonomia')
    const rows = tabPt.groups.flatMap((g) => g.rows)
    const goalLoop = rows.find((r) => r.id === 'autonomy.goal_loop.enabled')
    assert.equal(goalLoop.name, 'Loop Contínuo')
    const monthly = rows.find((r) => r.id === 'autonomy.budget.monthly')
    assert.equal(monthly.name, 'Teto Mensal (USD)')
    assert.match(monthly.note, /USD para arbitragem/)
    const perDecision = rows.find((r) => r.id === 'autonomy.budget.perDecision')
    assert.equal(perDecision.name, 'Teto por Consulta')

    const soloRow = rows.find((r) => r.id === 'autonomy.gradient.solo')
    assert.equal(soloRow.name, 'Decisão solo')
    assert.equal(soloRow.value, 'autônomo')

    const jevRow = rows.find((r) => r.id === 'autonomy.gradient.jev')
    assert.equal(jevRow.name, 'Decisão Jev')
    assert.equal(jevRow.value, 'arbitrado')

    const humanRow = rows.find((r) => r.id === 'autonomy.gradient.human')
    assert.equal(humanRow.name, 'Aprovação humana')
    assert.equal(humanRow.value, 'revisão humana')
  })

  it('renders Gates tab localized in pt-BR', () => {
    const tabPt = buildGatesTab({ global: {}, project: {}, corruptGlobal: false }, 'pt-BR')
    assert.equal(tabPt.title, 'Gates')
    assert.equal(tabPt.groups[0].title, 'Skills instaladas')
    assert.equal(tabPt.groups[1].title, 'Portões de execução')
  })

  it('renders Preset tab localized in pt-BR', () => {
    const tabPt = buildPresetTab({ globalName: 'go-fast', projectName: null }, 'pt-BR')
    assert.equal(tabPt.title, 'Preset')
    assert.equal(tabPt.groups[0].title, 'Predefinição de modelo')
    const presetRow = tabPt.groups[0].rows.find((r) => r.id === 'preset')
    assert.equal(presetRow.name, 'Predefinição')
    assert.match(presetRow.note, /gravação atômica/)
  })

  it('renders About tab localized in pt-BR with rich system metadata', () => {
    const tabPt = buildAboutTab('2.0.4', {
      nodeVersion: '26.4.0',
      platform: 'linux',
      preset: 'go-fast',
      decisionEnabled: true,
      j1Mode: 'enforce',
      languagePref: 'pt-BR',
    })
    assert.equal(tabPt.title, 'Sobre')
    assert.equal(tabPt.groups[0].title, 'Sistema & Plataforma')
    assert.equal(tabPt.groups[1].title, 'Governança & Roteamento')
    assert.equal(tabPt.groups[2].title, 'Projeto & Referências')

    const rows = tabPt.groups.flatMap((g) => g.rows)
    assert.equal(rows.find((r) => r.id === 'about.version').name, 'Versão')
    assert.equal(rows.find((r) => r.id === 'about.behaviors').name, 'Comportamentos')
    assert.equal(rows.find((r) => r.id === 'about.preset').value, 'go-fast')
    assert.equal(rows.find((r) => r.id === 'about.decision').value, 'ativado')
    assert.equal(rows.find((r) => r.id === 'about.j1').value, 'enforce')
  })

  it('renders Changelog tab cleanly without duplicated titles', () => {
    const tabPt = buildChangelogTab(
      '2.0.4',
      [
        {
          title: 'Container & JupyterHub Support',
          detail: 'Auto-detect environments and relax directory trust checks.',
        },
      ],
      'pt-BR',
    )
    assert.equal(tabPt.title, 'Changelog')
    assert.equal(tabPt.groups[0].title, 'Novidades na versão v2.0.4')
    const itemRow = tabPt.groups[0].rows[0]
    assert.equal(itemRow.value, '', 'value column is empty to avoid title overlap')
    assert.equal(itemRow.note, 'Auto-detect environments and relax directory trust checks.')
  })

  it('renders J1 safety tab localized in pt-BR', () => {
    const tabPt = buildJ1Tab({ PANTHEON_J1_RISK_SCORE: 'shadow' }, false, 'pt-BR')
    assert.equal(tabPt.title, 'Segurança J1')
    const rows = tabPt.groups.flatMap((g) => g.rows)
    const modeRow = rows.find((r) => r.id === 'j1.mode')
    assert.equal(modeRow.name, 'Modo de Operação')
    assert.match(modeRow.note, /telemetria/)
    const gateRow = rows.find((r) => r.id === 'j1.gate')
    assert.equal(gateRow.name, 'Portão de Segurança')
  })

  it('renders TUI tab localized in pt-BR', () => {
    const tabPt = buildTuiTab(DEFAULT_TUI_PREFS, 'pt-BR')
    assert.equal(tabPt.title, 'TUI')
    assert.equal(tabPt.groups[0].title, 'Predefinição & Layout')
    const rows = tabPt.groups.flatMap((g) => g.rows)
    const langRow = rows.find((r) => r.id === 'tui.layout.language')
    assert.equal(langRow.name, 'Idioma / Language')
    assert.match(langRow.note, /fuso/)
  })
})
