import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import {
  comparePantheonVersions,
  formatUpdateBadge,
  formatUpdateToast,
  getAvailableUpdateVersion,
  isNewerUpdateAvailable,
  nextCheckState,
  packageSpecForVersion,
  pickUpdateNotice,
  resolveCachedAvailableUpdate,
  setAvailableUpdateVersion,
  subscribeAvailableUpdate,
  UPDATE_CHECK_TTL_MS,
  withKnownLatest,
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
    assert.match(first?.message ?? '', /opencode plugin update pantheon-opencode@beta/)
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
    assert.equal(isNewerUpdateAvailable('2.2.0', '2.3.0-beta.1'), false)
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

  it('formats persistent badges and localized toasts for newer versions only', () => {
    assert.equal(packageSpecForVersion('2.2.0-beta.9'), 'pantheon-opencode@beta')
    assert.equal(packageSpecForVersion('2.2.0'), 'pantheon-opencode')

    assert.equal(
      formatUpdateBadge('2.2.0-beta.9', '2.2.0-beta.10', { isPt: true }),
      '↑ v2.2.0-beta.10 disponível · /pantheon-settings',
    )
    assert.equal(
      formatUpdateBadge('2.2.0-beta.9', '2.2.0-beta.10', { compact: true }),
      '↑ v2.2.0-beta.10 (/pantheon-settings)',
    )
    assert.equal(formatUpdateBadge('2.2.0-beta.9', '2.2.0-beta.9', { isPt: true }), null)
    assert.equal(formatUpdateBadge('2.2.0', '2.3.0-beta.1', { isPt: true }), null)

    const toastPt = formatUpdateToast('2.2.0-beta.9', '2.2.0-beta.10', true)
    assert.equal(toastPt.title, 'Pantheon v2.2.0-beta.10 disponível')
    assert.match(toastPt.message, /opencode plugin update pantheon-opencode@beta/)
  })

  it('hydrates cached update announcements and notifies subscribers on state transitions', () => {
    const stamped = withKnownLatest(
      { lastCheckMs: NOW, lastNotifiedVersion: '2.1.6' },
      '2.2.0-beta.10',
    )
    assert.equal(resolveCachedAvailableUpdate('2.2.0-beta.9', stamped), '2.2.0-beta.10')
    assert.equal(resolveCachedAvailableUpdate('2.2.0-beta.10', stamped), null)

    const seen = []
    const unsubscribe = subscribeAvailableUpdate((v) => seen.push(v))
    try {
      setAvailableUpdateVersion('2.2.0-beta.10')
      setAvailableUpdateVersion('2.2.0-beta.10')
      assert.equal(getAvailableUpdateVersion(), '2.2.0-beta.10')
      setAvailableUpdateVersion(null)
      assert.deepEqual(seen, ['2.2.0-beta.10', null])
    } finally {
      setAvailableUpdateVersion(null)
      unsubscribe()
    }
  })

  it('wires persistent update announcement and periodic check cleanup in TUI entry', () => {
    const entry = readFileSync(join(process.cwd(), 'src/plugins/tui/src/index.tsx'), 'utf8')
    assert.match(entry, /formatUpdateBadge/)
    assert.match(entry, /setInterval\([\s\S]*?checkForPantheonUpdate[\s\S]*?UPDATE_CHECK_TTL_MS/)
    assert.match(entry, /clearInterval\(updateNoticeInterval\)/)
  })
})
