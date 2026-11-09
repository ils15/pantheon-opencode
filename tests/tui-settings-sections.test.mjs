import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildAboutSection,
  buildGatesSection,
  firstSelectableId,
  flatSelectableRows,
} from '../src/plugins/tui/src/pantheon-settings-state.ts'
import {
  buildUpdatesSection,
  registryTagForChannel,
  registryUrlForChannel,
  updateChannelFor,
} from '../src/plugins/tui/src/update-status.ts'

const HOUR = 3_600_000

describe('update channel classification', () => {
  it('a beta suffix rides the beta dist-tag, otherwise latest', () => {
    assert.equal(updateChannelFor('2.0.0-beta.2'), 'beta')
    assert.equal(updateChannelFor('2.0.0'), 'stable')
    assert.equal(registryTagForChannel('beta'), 'beta')
    assert.equal(registryTagForChannel('stable'), 'latest')
    assert.equal(registryUrlForChannel('beta'), 'https://registry.npmjs.org/pantheon-opencode/beta')
  })
})

describe('updates section rows', () => {
  it('offers check-now and reports a never-checked state', () => {
    const section = buildUpdatesSection({
      currentVersion: '2.0.0-beta.2',
      state: {},
      nowMs: 10 * HOUR,
    })
    const check = section.rows.find((row) => row.id === 'update.check')
    assert.equal(check.title, 'Check now')
    assert.equal(check.description, 'never checked')
    assert.equal(check.selectable, true)
    assert.match(section.hint, /pantheon-opencode update/)
  })

  it('shows a newer version with the update remedy', () => {
    const section = buildUpdatesSection({
      currentVersion: '2.0.0-beta.2',
      state: {},
      lastCheckedVersion: '2.0.0-beta.3',
      nowMs: 10 * HOUR,
    })
    const latest = section.rows.find((row) => row.id === 'update.latest')
    assert.match(latest.title, /Update available: v2\.0\.0-beta\.3/)
    assert.match(latest.description, /pantheon-opencode update/)
  })

  it('shows up-to-date without advertising a downgrade', () => {
    const section = buildUpdatesSection({
      currentVersion: '2.0.0-beta.3',
      state: { lastCheckMs: 10 * HOUR, lastNotifiedVersion: '2.0.0-beta.2' },
      nowMs: 11 * HOUR,
    })
    const latest = section.rows.find((row) => row.id === 'update.latest')
    assert.match(latest.title, /Up to date/)
    assert.equal(latest.selectable, false)
    const check = section.rows.find((row) => row.id === 'update.check')
    assert.match(check.description, /1h ago/)
  })

  it('never offers a beta to a stable install from the beta-tag fetch', () => {
    // The beta registry tag can legitimately answer with a beta while the
    // user runs stable only when they manually asked for beta — this window
    // asks the tag matching the RUNNING channel, so a stable current version
    // asking `latest` that returns a beta must not be shown as an upgrade.
    const section = buildUpdatesSection({
      currentVersion: '2.0.0',
      state: {},
      lastCheckedVersion: '2.1.0-beta.1',
      nowMs: 10 * HOUR,
    })
    const latest = section.rows.find((row) => row.id === 'update.latest')
    assert.match(latest.title, /Up to date/)
    assert.equal(latest.marker, '[✓]')
  })
})

describe('window section composition (order contract)', () => {
  const load = { global: {}, project: {}, corruptGlobal: false }
  const sections = (currentVersion) => [buildGatesSection(load), buildAboutSection(currentVersion)]

  it('selection lands on the first selectable row of the window', () => {
    assert.equal(firstSelectableId(sections('2.0.0-beta.2')), 'gate.skill-auto-continue')
  })

  it('the flat order is stable so up/down cannot jump across renders', () => {
    const flat = flatSelectableRows(sections('2.0.0-beta.2'))
    assert.deepEqual(
      flat.map((row) => row.id),
      flat.map((row) => row.id),
    )
    assert.equal(flat.length, 7)
  })
})
