import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  buildAboutTab,
  buildGatesTab,
  tabRows,
} from '../src/plugins/tui/src/pantheon-settings-state.ts'
import {
  buildUpdatesTab,
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
    const section = buildUpdatesTab({
      currentVersion: '2.0.0-beta.2',
      state: {},
      nowMs: 10 * HOUR,
    })
    const check = section.groups.flatMap((g) => g.rows).find((row) => row.id === 'update.check')
    assert.equal(check.name, 'Check now')
    assert.equal(check.value, 'never checked')
    assert.match(check.note, /enter probes the registry/)
    assert.equal(check.action, 'update-check')
  })

  it('shows a newer version with the update remedy', () => {
    const section = buildUpdatesTab({
      currentVersion: '2.0.0-beta.2',
      state: {},
      lastCheckedVersion: '2.0.0-beta.3',
      nowMs: 10 * HOUR,
    })
    const latest = section.groups.flatMap((g) => g.rows).find((row) => row.id === 'update.latest')
    assert.equal(latest.value, 'v2.0.0-beta.3 available')
    assert.match(latest.note, /pantheon-opencode update/)
  })

  it('shows up-to-date without advertising a downgrade', () => {
    const section = buildUpdatesTab({
      currentVersion: '2.0.0-beta.3',
      state: { lastCheckMs: 10 * HOUR, lastNotifiedVersion: '2.0.0-beta.2' },
      nowMs: 11 * HOUR,
    })
    const latest = section.groups.flatMap((g) => g.rows).find((row) => row.id === 'update.latest')
    assert.equal(latest.value, 'up to date')
    const check = section.groups.flatMap((g) => g.rows).find((row) => row.id === 'update.check')
    assert.match(check.value, /1h ago/)
  })

  it('never offers a beta to a stable install from the beta-tag fetch', () => {
    // The beta registry tag can legitimately answer with a beta while the
    // user runs stable only when they manually asked for beta — this window
    // asks the tag matching the RUNNING channel, so a stable current version
    // asking `latest` that returns a beta must not be shown as an upgrade.
    const section = buildUpdatesTab({
      currentVersion: '2.0.0',
      state: {},
      lastCheckedVersion: '2.1.0-beta.1',
      nowMs: 10 * HOUR,
    })
    const latest = section.groups.flatMap((g) => g.rows).find((row) => row.id === 'update.latest')
    assert.equal(latest.value, 'up to date')
  })
})

describe('window section composition (order contract)', () => {
  const load = { global: {}, project: {}, corruptGlobal: false }
  const sections = (currentVersion) => [buildGatesTab(load), buildAboutTab(currentVersion)]

  it('the flat row order is stable so up/down cannot jump across renders', () => {
    const flat = tabRows(sections('2.0.0-beta.2')[0])
    assert.equal(flat.length, 7)
    assert.equal(flat[0].id, 'gate.skill-auto-continue')
  })
})
