import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  comparePantheonVersions,
  nextCheckState,
  pickUpdateNotice,
  UPDATE_CHECK_TTL_MS,
} from '../src/plugins/tui/src/update-notice.ts'

const NOW = 1_800_000_000_000

describe('tui update-notice core', () => {
  it('orders releases and betas semver-style', () => {
    assert.ok(comparePantheonVersions('2.0.0', '2.0.0-beta.1') > 0)
    assert.ok(comparePantheonVersions('2.0.0-rc.1', '2.0.0-beta.7') > 0)
    assert.ok(comparePantheonVersions('2.0.0-rc.2', '2.0.0-rc.1') > 0)
    assert.ok(comparePantheonVersions('2.0.0', '2.0.0-rc.1') > 0)
    assert.equal(comparePantheonVersions('2.0.0-beta.1', '2.0.0-beta.1'), 0)
    assert.equal(comparePantheonVersions('2.0.0-rc.1', '2.0.0-rc.1'), 0)
  })

  it('notifies once per newer version, silent in the TTL', () => {
    const first = pickUpdateNotice({
      currentVersion: '2.0.0-beta.1',
      latestVersion: '2.0.0-beta.2',
      state: {},
      nowMs: NOW,
    })
    assert.equal(first?.version, '2.0.0-beta.2')
    assert.equal(
      pickUpdateNotice({
        currentVersion: '2.0.0-beta.1',
        latestVersion: '2.0.0-beta.2',
        state: { lastCheckMs: NOW - 100, lastNotifiedVersion: '2.0.0-beta.2' },
        nowMs: NOW,
      }),
      null,
    )
    assert.equal(UPDATE_CHECK_TTL_MS, 6 * 60 * 60 * 1000)
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

  it('nextCheckState carries the notified version or keeps the previous one', () => {
    assert.deepEqual(nextCheckState({ lastNotifiedVersion: '2.0.0' }, { version: '2.1.0' }, NOW), {
      lastCheckMs: NOW,
      lastNotifiedVersion: '2.1.0',
    })
    assert.deepEqual(nextCheckState({ lastNotifiedVersion: '2.0.0' }, null, NOW), {
      lastCheckMs: NOW,
      lastNotifiedVersion: '2.0.0',
    })
  })
})
