import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import {
  buildJ1Tab,
  J1_FLAG_ENV,
  J1_THRESHOLD_DEFAULT,
  J1_THRESHOLD_ENV,
  j1ModeFromEnv,
  j1ThresholdFromEnv,
} from '../src/plugins/tui/src/j1-gate-status.ts'

const GATE_SOURCE = new URL('../src/pantheon/jev-risk-gate.ts', import.meta.url)

describe('j1 gate section (TUI-local replica)', () => {
  it('maps the ladder exactly like the runtime gate', () => {
    assert.equal(j1ModeFromEnv({ [J1_FLAG_ENV]: 'enforce' }), 'enforce')
    assert.equal(j1ModeFromEnv({ [J1_FLAG_ENV]: 'warn' }), 'warn')
    assert.equal(j1ModeFromEnv({ [J1_FLAG_ENV]: 'shadow' }), 'shadow')
    assert.equal(j1ModeFromEnv({ [J1_FLAG_ENV]: '1' }), 'shadow')
    assert.equal(j1ModeFromEnv({ [J1_FLAG_ENV]: 'on' }), 'shadow')
    assert.equal(j1ModeFromEnv({ [J1_FLAG_ENV]: 'true' }), 'shadow')
    assert.equal(j1ModeFromEnv({ [J1_FLAG_ENV]: '' }), 'off')
    assert.equal(j1ModeFromEnv({ [J1_FLAG_ENV]: 'whatever' }), 'off')
  })

  it('clamps the threshold and falls back to the default on junk', () => {
    assert.equal(j1ThresholdFromEnv({ [J1_THRESHOLD_ENV]: '0.9' }), 0.9)
    assert.equal(j1ThresholdFromEnv({ [J1_THRESHOLD_ENV]: '0' }), 0)
    assert.equal(j1ThresholdFromEnv({ [J1_THRESHOLD_ENV]: '1' }), 1)
    assert.equal(j1ThresholdFromEnv({ [J1_THRESHOLD_ENV]: '' }), J1_THRESHOLD_DEFAULT)
    assert.equal(j1ThresholdFromEnv({ [J1_THRESHOLD_ENV]: 'abc' }), J1_THRESHOLD_DEFAULT)
    assert.equal(j1ThresholdFromEnv({ [J1_THRESHOLD_ENV]: '5' }), J1_THRESHOLD_DEFAULT)
    assert.equal(J1_THRESHOLD_DEFAULT, 0.8)
  })

  it('drift pins the replica against the runtime source text', () => {
    const source = readFileSync(GATE_SOURCE, 'utf8')
    assert.ok(source.includes(`'${J1_FLAG_ENV}'`), 'flag env name drifted')
    assert.ok(source.includes(`'${J1_THRESHOLD_ENV}'`), 'threshold env name drifted')
    assert.ok(source.includes('= 0.8'), 'default threshold drifted')
    for (const mode of ['off', 'shadow', 'warn', 'enforce']) {
      assert.ok(
        source.includes(`'${mode}'`),
        `ladder mode '${mode}' no longer exists in the runtime gate`,
      )
    }
  })

  it('reports override disablement and says the section is env-only', () => {
    const active = buildJ1Tab({ [J1_FLAG_ENV]: 'enforce' }, false)
    const rows = active.groups.flatMap((group) => group.rows)
    const modeRow = rows.find((row) => row.id === 'j1.mode')
    assert.equal(modeRow.value, 'enforce')
    assert.ok(rows.some((row) => row.id === 'j1.gate' && row.value === 'active'))
    const killed = buildJ1Tab({ [J1_FLAG_ENV]: 'enforce' }, true)
    const killedRows = killed.groups.flatMap((group) => group.rows)
    assert.ok(
      killedRows.some((row) => row.id === 'j1.gate' && row.value === 'disabled via overrides'),
    )
    const hintRows = killedRows.filter((row) => row.note !== undefined)
    assert.ok(
      hintRows.some((row) => row.note.includes('restart')),
      'must say a restart applies',
    )
    for (const row of rows) {
      assert.equal(row.cycle, undefined, 'the tab is read-only — no cyclers here')
    }
  })

  it('warn is surfaced as reserved', () => {
    const tab = buildJ1Tab({ [J1_FLAG_ENV]: 'warn' }, false)
    const modeRow = tab.groups.flatMap((group) => group.rows).find((row) => row.id === 'j1.mode')
    assert.match(modeRow.note, /RESERVED/)
  })
})
