/**
 * update-notifier.test.ts — the pin + notify decision core.
 *
 * Notices fire once per newer version, TTL-cached; a stable install is never
 * advertised a beta (the update guard owns that crossing); offline and
 * older-registry states stay silent.
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  comparePantheonVersions,
  nextCheckState,
  pickUpdateNotice,
  UPDATE_CHECK_TTL_MS,
} from '../../src/pantheon/update-notifier.ts'

const NOW = 1_800_000_000_000

describe('comparePantheonVersions', () => {
  it('orders releases and betas semver-style', () => {
    assert.ok(comparePantheonVersions('2.0.0-beta.1', '1.7.0') > 0)
    assert.ok(comparePantheonVersions('2.0.0', '2.0.0-beta.1') > 0)
    assert.ok(comparePantheonVersions('2.0.0-beta.2', '2.0.0-beta.1') > 0)
    assert.ok(comparePantheonVersions('2.0.0-rc.1', '2.0.0-beta.7') > 0)
    assert.ok(comparePantheonVersions('2.0.0-rc.2', '2.0.0-rc.1') > 0)
    assert.ok(comparePantheonVersions('2.0.0', '2.0.0-rc.1') > 0)
    assert.equal(comparePantheonVersions('2.0.0-beta.1', '2.0.0-beta.1'), 0)
    assert.equal(comparePantheonVersions('2.0.0-rc.1', '2.0.0-rc.1'), 0)
  })
})

describe('pickUpdateNotice', () => {
  it('fires once per newer version', () => {
    const first = pickUpdateNotice({
      currentVersion: '2.0.0-beta.1',
      latestVersion: '2.0.0-beta.2',
      state: {},
      nowMs: NOW,
    })
    assert.equal(first?.version, '2.0.0-beta.2')
    assert.match(first?.message ?? '', /pantheon-opencode update/)
  })

  it('stays silent inside the TTL and after notifying the same version', () => {
    const state = { lastCheckMs: NOW - 1000, lastNotifiedVersion: '2.0.0-beta.2' }
    assert.equal(
      pickUpdateNotice({
        currentVersion: '2.0.0-beta.1',
        latestVersion: '2.0.0-beta.2',
        state,
        nowMs: NOW,
      }),
      null,
      'TTL not elapsed',
    )
    const afterTtl = pickUpdateNotice({
      currentVersion: '2.0.0-beta.1',
      latestVersion: '2.0.0-beta.2',
      state: { lastCheckMs: NOW - UPDATE_CHECK_TTL_MS - 1, lastNotifiedVersion: '2.0.0-beta.2' },
      nowMs: NOW,
    })
    assert.equal(afterTtl, null, 'same version must not re-notify')
  })

  it('a stable install is never advertised a beta', () => {
    assert.equal(
      pickUpdateNotice({
        currentVersion: '2.0.0',
        latestVersion: '2.1.0-beta.1',
        state: {},
        nowMs: NOW,
      }),
      null,
    )
  })

  it('older or equal registry versions stay silent', () => {
    assert.equal(
      pickUpdateNotice({
        currentVersion: '2.0.0-beta.1',
        latestVersion: '2.0.0-beta.1',
        state: {},
        nowMs: NOW,
      }),
      null,
    )
    assert.equal(
      pickUpdateNotice({
        currentVersion: '2.0.0',
        latestVersion: '1.9.0',
        state: {},
        nowMs: NOW,
      }),
      null,
    )
  })

  it('a stable install is advertised the stable line', () => {
    const notice = pickUpdateNotice({
      currentVersion: '2.0.0-beta.1',
      latestVersion: '2.0.0',
      state: {},
      nowMs: NOW,
    })
    assert.equal(notice?.version, '2.0.0')
  })
})

describe('nextCheckState', () => {
  it('stamps the TTL and carries the notified version', () => {
    const notice = { version: '2.1.0', message: 'x' }
    const state = nextCheckState({ lastNotifiedVersion: '2.0.0' }, notice, NOW)
    assert.deepEqual(state, { lastCheckMs: NOW, lastNotifiedVersion: '2.1.0' })
  })

  it('keeps the previous notified version when silent', () => {
    const state = nextCheckState({ lastNotifiedVersion: '2.0.0' }, null, NOW)
    assert.deepEqual(state, { lastCheckMs: NOW, lastNotifiedVersion: '2.0.0' })
  })
})
