import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import { readBoardMessages } from '../../src/pantheon/board-messages.ts'
import { getSharedBus, type SwarmStallDetectedEventPayload } from '../../src/pantheon/bus.ts'
import { readCockpitBusEvents, wireCockpitBusRecorder } from '../../src/pantheon/cockpit-events.ts'
import { clearWaitEdge, recordWaitEdge, SwarmWatchdog } from '../../src/pantheon/swarm-watchdog.ts'

test('SwarmWatchdog detects stalled running jobs with exponential backoff and caps at maxAlertsPerJob', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-watchdog-'))
  const board = new BackgroundJobBoard()
  const bus = getSharedBus()
  const alerts: SwarmStallDetectedEventPayload[] = []
  const off = bus.on('swarm:stall:detected', (ev) => alerts.push(ev))
  const stopCockpit = wireCockpitBusRecorder(dir)

  let fakeNow = Date.now()
  const watchdog = new SwarmWatchdog({
    board,
    workspaceDir: dir,
    now: () => fakeNow,
    checkIntervalMs: 60_000,
    stallThresholdMs: 10_000,
    unreconciledThresholdMs: 5_000,
    baseBackoffMs: 10_000,
    maxAlertsPerJob: 2,
  })

  try {
    await board.registerLaunch({
      taskID: 'task-stall-1',
      parentSessionID: 'ses-parent',
      agent: 'hermes',
      description: 'Implement API endpoint',
    })

    // Before threshold: 0 alerts
    fakeNow += 5_000
    assert.equal((await watchdog.checkOnce()).length, 0)

    // Past stallThresholdMs (10s): attempt 1 fires
    fakeNow += 6_000
    const first = await watchdog.checkOnce()
    assert.equal(first.length, 1)
    assert.equal(first[0]?.reason, 'no_progress')
    assert.equal(first[0]?.attempt, 1)

    // Within backoff (10s * 2^0 = 10s): suppressed
    fakeNow += 5_000
    assert.equal((await watchdog.checkOnce()).length, 0)

    // Past backoff: attempt 2 fires
    fakeNow += 6_000
    const second = await watchdog.checkOnce()
    assert.equal(second.length, 1)
    assert.equal(second[0]?.attempt, 2)

    // Capped at maxAlertsPerJob = 2
    fakeNow += 60_000
    assert.equal((await watchdog.checkOnce()).length, 0)

    // Wait briefly for async [alert] appendBoardMessage
    await new Promise((r) => setTimeout(r, 30))
    const boardMsgs = readBoardMessages(dir, { channel: 'swarm' })
    assert.ok(boardMsgs.messages.some((m) => m.from === 'watchdog' && m.tag === 'alert'))

    const cockpitEvents = readCockpitBusEvents(dir, 20)
    const stallEv = cockpitEvents.find((ev) => ev.kind === 'swarm:stall:detected')
    assert.ok(stallEv)
    assert.equal(stallEv.attentionCategory, 'stuck')
    assert.equal(stallEv.severity, 'warn')
    assert.equal(alerts.length, 2)
  } finally {
    watchdog.stop()
    stopCockpit()
    off()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SwarmWatchdog detects unreconciled terminal jobs and resets on reconcile or activity', async () => {
  const board = new BackgroundJobBoard()
  let fakeNow = Date.now()
  const watchdog = new SwarmWatchdog({
    board,
    now: () => fakeNow,
    stallThresholdMs: 100_000,
    unreconciledThresholdMs: 5_000,
    baseBackoffMs: 10_000,
    maxAlertsPerJob: 3,
    appendAlertMessage: false,
  })
  watchdog.start()

  try {
    await board.registerLaunch({
      taskID: 'task-unrec-1',
      parentSessionID: 'ses-parent',
      agent: 'apollo',
      description: 'Audit files',
    })
    await board.updateStatus({
      taskID: 'task-unrec-1',
      state: 'completed',
      resultSummary: 'Finished audit',
    })

    fakeNow += 6_000
    const alerts = await watchdog.checkOnce()
    assert.equal(alerts.length, 1)
    assert.equal(alerts[0]?.reason, 'unreconciled_terminal')

    await board.markReconciled('task-unrec-1')
    fakeNow += 30_000
    assert.equal((await watchdog.checkOnce()).length, 0)
  } finally {
    watchdog.stop()
  }
})

test('SwarmWatchdog detects circular wait cycles and posts [deadlock] alert with backoff', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-watchdog-deadlock-'))
  const board = new BackgroundJobBoard()
  let fakeNow = Date.now()
  const watchdog = new SwarmWatchdog({
    board,
    workspaceDir: dir,
    now: () => fakeNow,
    stallThresholdMs: 100_000,
    unreconciledThresholdMs: 100_000,
    baseBackoffMs: 10_000,
    maxAlertsPerJob: 2,
  })

  try {
    recordWaitEdge('hermes', 'themis')
    recordWaitEdge('themis', 'hermes')

    // First check: posts [deadlock]
    await watchdog.checkOnce()
    await new Promise((r) => setTimeout(r, 30))
    let msgs = readBoardMessages(dir, { channel: 'swarm' }).messages.filter(
      (m) => m.tag === 'deadlock',
    )
    assert.equal(msgs.length, 1)
    assert.ok(msgs[0]?.body.includes('[deadlock]'))
    assert.ok(msgs[0]?.mentions.includes('hermes'))
    assert.ok(msgs[0]?.mentions.includes('themis'))

    // Within backoff (5s < 10s): suppressed
    fakeNow += 5_000
    await watchdog.checkOnce()
    await new Promise((r) => setTimeout(r, 30))
    msgs = readBoardMessages(dir, { channel: 'swarm' }).messages.filter((m) => m.tag === 'deadlock')
    assert.equal(msgs.length, 1)

    // Past backoff (10s): attempt 2 fires
    fakeNow += 6_000
    await watchdog.checkOnce()
    await new Promise((r) => setTimeout(r, 30))
    msgs = readBoardMessages(dir, { channel: 'swarm' }).messages.filter((m) => m.tag === 'deadlock')
    assert.equal(msgs.length, 2)

    // Capped at maxAlertsPerJob = 2
    fakeNow += 60_000
    await watchdog.checkOnce()
    await new Promise((r) => setTimeout(r, 30))
    msgs = readBoardMessages(dir, { channel: 'swarm' }).messages.filter((m) => m.tag === 'deadlock')
    assert.equal(msgs.length, 2)

    // Clear cycle -> backoff resets, no new alerts
    clearWaitEdge('themis')
    fakeNow += 60_000
    await watchdog.checkOnce()
    await new Promise((r) => setTimeout(r, 30))
    msgs = readBoardMessages(dir, { channel: 'swarm' }).messages.filter((m) => m.tag === 'deadlock')
    assert.equal(msgs.length, 2)

    // Re-introduce 3-node cycle -> alerts again
    recordWaitEdge('themis', 'apollo')
    recordWaitEdge('apollo', 'hermes')
    await watchdog.checkOnce()
    await new Promise((r) => setTimeout(r, 30))
    msgs = readBoardMessages(dir, { channel: 'swarm' }).messages.filter((m) => m.tag === 'deadlock')
    assert.equal(msgs.length, 3)
  } finally {
    clearWaitEdge('hermes')
    clearWaitEdge('themis')
    clearWaitEdge('apollo')
    watchdog.stop()
    rmSync(dir, { recursive: true, force: true })
  }
})
