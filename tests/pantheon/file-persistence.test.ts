/**
 * Tests for FilePersistenceAdapter and consumeWakeSignals.
 *
 * Run with: npx tsx tests/pantheon/file-persistence.test.ts
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  BackgroundJobBoard,
  type BackgroundJobRecord,
} from '../../src/pantheon/background-job-board.ts'
import { FilePersistenceAdapter } from '../../src/pantheon/file-persistence.ts'
import { consumeWakeSignals } from '../../src/pantheon/auto-wake.ts'

// ─── Helpers ───────────────────────────────────────────────────────────

const results: { name: string; passed: boolean; error?: string }[] = []

function test(name: string, fn: () => void) {
  try {
    fn()
    results.push({ name, passed: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ name, passed: false, error: msg })
  }
}

async function testAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    results.push({ name, passed: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ name, passed: false, error: msg })
  }
}

function makeLaunch(overrides: Partial<{
  taskID: string
  parentSessionID: string
  agent: string
  description: string
}> = {}) {
  return {
    taskID: overrides.taskID ?? `task_${Math.random().toString(36).slice(2, 8)}`,
    parentSessionID: overrides.parentSessionID ?? 'ses_test',
    agent: overrides.agent ?? 'apollo',
    description: overrides.description ?? 'Test job',
  }
}

async function main() {
// ═══════════════════════════════════════════════════════════════════════
// FILE PERSISTENCE ADAPTER (single state.json)
// ═══════════════════════════════════════════════════════════════════════

await testAsync('saveJob writes to state.json file', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'fp-save-'))
  try {
    const statePath = join(tmpDir, 'state.json')
    const adapter = new FilePersistenceAdapter(statePath)
    const record: BackgroundJobRecord = {
      taskID: 'test-save-1',
      parentSessionID: 'ses_1',
      agent: 'apollo',
      description: 'Save test',
      state: 'running',
      timedOut: false,
      alias: 'apo-1',
      launchedAt: Date.now(),
      updatedAt: Date.now(),
      totalErrors: 0,
      timeoutCount: 0,
      terminalUnreconciled: false,
      contextFiles: [],
    }

    await adapter.saveJob(record)

    assert.ok(existsSync(statePath), 'state.json should exist')

    const content = JSON.parse(readFileSync(statePath, 'utf-8'))
    assert.ok(Array.isArray(content), 'state.json should contain an array')
    assert.equal(content.length, 1)
    assert.equal(content[0].taskID, 'test-save-1')
    assert.equal(content[0].state, 'running')
    assert.equal(content[0].alias, 'apo-1')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

await testAsync('saveJob uses atomic write (no .tmp file left behind)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'fp-atomic-'))
  try {
    const statePath = join(tmpDir, 'state.json')
    const adapter = new FilePersistenceAdapter(statePath)
    const record: BackgroundJobRecord = {
      taskID: 'test-atomic',
      parentSessionID: 'ses_1',
      agent: 'hermes',
      description: 'Atomic test',
      state: 'completed',
      timedOut: false,
      alias: 'her-1',
      launchedAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: Date.now(),
      totalErrors: 0,
      timeoutCount: 0,
      terminalUnreconciled: true,
      contextFiles: [],
      resultSummary: 'Done',
    }

    await adapter.saveJob(record)

    // The .tmp file should be gone (renamed to state.json)
    const tmpFile = statePath + '.tmp'
    assert.equal(existsSync(tmpFile), false, '.tmp file should be gone after rename')
    assert.ok(existsSync(statePath), 'state.json should exist')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

await testAsync('loadAllJobs reads all jobs from state.json', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'fp-load-'))
  try {
    const statePath = join(tmpDir, 'state.json')
    const adapter = new FilePersistenceAdapter(statePath)

    // Save two jobs
    await adapter.saveJob({
      taskID: 'job-a',
      parentSessionID: 's1',
      agent: 'apollo',
      description: 'Job A',
      state: 'completed',
      timedOut: false,
      alias: 'apo-1',
      launchedAt: 1000,
      updatedAt: 2000,
      completedAt: 2000,
      totalErrors: 0,
      timeoutCount: 0,
      terminalUnreconciled: true,
      contextFiles: [],
      resultSummary: 'Done A',
    })

    await adapter.saveJob({
      taskID: 'job-b',
      parentSessionID: 's1',
      agent: 'hermes',
      description: 'Job B',
      state: 'running',
      timedOut: false,
      alias: 'her-1',
      launchedAt: 1000,
      updatedAt: 1000,
      totalErrors: 0,
      timeoutCount: 0,
      terminalUnreconciled: false,
      contextFiles: [],
    })

    const loaded = await adapter.loadAllJobs()
    assert.equal(loaded.length, 2)

    const jobA = loaded.find(r => r.taskID === 'job-a')!
    assert.ok(jobA)
    assert.equal(jobA.state, 'completed')
    assert.equal(jobA.resultSummary, 'Done A')

    const jobB = loaded.find(r => r.taskID === 'job-b')!
    assert.ok(jobB)
    assert.equal(jobB.state, 'running')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

await testAsync('loadAllJobs returns empty array when state.json does not exist', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'fp-empty-'))
  try {
    const statePath = join(tmpDir, 'state.json')
    const adapter = new FilePersistenceAdapter(statePath)
    const loaded = await adapter.loadAllJobs()
    assert.equal(loaded.length, 0)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

await testAsync('loadAllJobs ignores stale .tmp files', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'fp-skips-'))
  try {
    const statePath = join(tmpDir, 'state.json')
    const adapter = new FilePersistenceAdapter(statePath)

    // Write a valid state.json
    await adapter.saveJob({
      taskID: 'real-job',
      parentSessionID: 's1',
      agent: 'apollo',
      description: 'Real',
      state: 'completed',
      timedOut: false,
      alias: 'apo-1',
      launchedAt: 1000,
      updatedAt: 2000,
      completedAt: 2000,
      totalErrors: 0,
      timeoutCount: 0,
      terminalUnreconciled: true,
      contextFiles: [],
      resultSummary: 'OK',
    })

    // Write a stale .tmp file (simulating interrupted atomic write)
    writeFileSync(statePath + '.tmp', '["garbage"]', 'utf-8')

    const loaded = await adapter.loadAllJobs()
    assert.equal(loaded.length, 1) // only real-job from state.json
    assert.equal(loaded[0]!.taskID, 'real-job')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

await testAsync('deleteJob removes a job from state.json (persisted + atomic)', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'fp-del-'))
  try {
    const statePath = join(tmpDir, 'state.json')
    const adapter = new FilePersistenceAdapter(statePath)

    await adapter.saveJob({
      taskID: 'keep-me',
      parentSessionID: 's1',
      agent: 'apollo',
      description: 'Keep me',
      state: 'completed',
      timedOut: false,
      alias: 'apo-1',
      launchedAt: 1000,
      updatedAt: 2000,
      completedAt: 2000,
      totalErrors: 0,
      timeoutCount: 0,
      terminalUnreconciled: true,
      contextFiles: [],
      resultSummary: 'Kept',
    })

    await adapter.saveJob({
      taskID: 'delete-me',
      parentSessionID: 's1',
      agent: 'hermes',
      description: 'Delete me',
      state: 'completed',
      timedOut: false,
      alias: 'her-1',
      launchedAt: 1000,
      updatedAt: 2000,
      completedAt: 2000,
      totalErrors: 0,
      timeoutCount: 0,
      terminalUnreconciled: true,
      contextFiles: [],
      resultSummary: 'Bye',
    })

    assert.ok(existsSync(statePath))

    await adapter.deleteJob('delete-me')

    // Reload from disk with a FRESH adapter — proves the deletion persisted
    const fresh = new FilePersistenceAdapter(statePath)
    const loaded = await fresh.loadAllJobs()
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]?.taskID, 'keep-me')
    assert.equal(loaded[0]?.resultSummary, 'Kept')

    // Atomic write: no .tmp file left behind after the delete
    assert.equal(existsSync(`${statePath}.tmp`), false, '.tmp file should be gone after rename')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

await testAsync('deleteJob on nonexistent entry does not throw and leaves file untouched', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'fp-dne-'))
  try {
    const statePath = join(tmpDir, 'state.json')
    const adapter = new FilePersistenceAdapter(statePath)

    await adapter.saveJob({
      taskID: 'keep-me',
      parentSessionID: 's1',
      agent: 'apollo',
      description: 'Keep',
      state: 'completed',
      timedOut: false,
      alias: 'apo-1',
      launchedAt: 1000,
      updatedAt: 2000,
      completedAt: 2000,
      totalErrors: 0,
      timeoutCount: 0,
      terminalUnreconciled: true,
      contextFiles: [],
      resultSummary: 'OK',
    })

    // Should not throw
    await adapter.deleteJob('does-not-exist')

    // Existing records untouched
    const content = JSON.parse(readFileSync(statePath, 'utf-8'))
    assert.equal(content.length, 1)
    assert.equal(content[0].taskID, 'keep-me')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

await testAsync('FilePersistenceAdapter works end-to-end with BackgroundJobBoard', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'fp-e2e-'))
  try {
    const statePath = join(tmpDir, 'state.json')
    const adapter = new FilePersistenceAdapter(statePath)
    const board = new BackgroundJobBoard()
    board.setPersistence(adapter)

    const job = await board.registerLaunch(makeLaunch({ taskID: 'e2e-test' }))
    assert.ok(existsSync(statePath))

    await board.updateStatus({
      taskID: job.taskID,
      state: 'completed',
      resultSummary: 'E2E passed',
    })

    const persisted = JSON.parse(readFileSync(statePath, 'utf-8'))
    assert.ok(Array.isArray(persisted))
    assert.equal(persisted.length, 1)
    assert.equal(persisted[0].state, 'completed')
    assert.equal(persisted[0].resultSummary, 'E2E passed')
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

await testAsync('FilePersistenceAdapter recovers orphaned running jobs', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'fp-recover-'))
  try {
    const statePath = join(tmpDir, 'state.json')
    const adapter = new FilePersistenceAdapter(statePath)

    // Simulate a pre-existing running job (orphan from crash) via state.json
    writeFileSync(
      statePath,
      JSON.stringify([
        {
          taskID: 'orphan',
          parentSessionID: 'ses_crash',
          agent: 'apollo',
          description: 'Orphaned',
          state: 'running',
          timedOut: false,
          alias: 'apo-1',
          launchedAt: Date.now() - 5000,
          updatedAt: Date.now() - 5000,
          totalErrors: 0,
          timeoutCount: 0,
          terminalUnreconciled: false,
          contextFiles: [],
        },
      ]),
      'utf-8',
    )

    const board = new BackgroundJobBoard()
    board.setPersistence(adapter)
    await board.recoverRunningJobs()

    const recovered = board.get('orphan')
    assert.ok(recovered)
    assert.equal(recovered!.state, 'error')
    assert.ok(recovered!.lastStatusError?.includes('Process restarted'))
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
})

// ═══════════════════════════════════════════════════════════════════════
// AUTO-WAKE CONSUMER (unchanged — operates on signal files independently)
// ═══════════════════════════════════════════════════════════════════════

await testAsync('consumeWakeSignals returns signals from board', async () => {
  const signalDir = mkdtempSync(join(tmpdir(), 'aw-signals-'))
  try {
    const board = new BackgroundJobBoard({ signalDir })
    const job = await board.registerLaunch(makeLaunch({
      agent: 'apollo',
      description: 'Wake test',
    }))

    // Trigger signal by completing
    await board.updateStatus({
      taskID: job.taskID,
      state: 'completed',
      resultSummary: 'Wake call',
    })

    const signals = await consumeWakeSignals(signalDir)
    assert.equal(signals.length, 1)

    const s = signals[0]!
    assert.equal(s.taskID, job.taskID)
    assert.equal(s.alias, job.alias)
    assert.equal(s.agent, 'apollo')
    assert.equal(s.state, 'completed')
    assert.equal(s.summary, 'Wake call')
    assert.ok(s.timestamp > 0)
  } finally {
    rmSync(signalDir, { recursive: true, force: true })
  }
})

await testAsync('consumeWakeSignals renames .signal.json to .consumed.json', async () => {
  const signalDir = mkdtempSync(join(tmpdir(), 'aw-rename-'))
  try {
    const board = new BackgroundJobBoard({ signalDir })
    const job = await board.registerLaunch(makeLaunch({
      agent: 'hermes',
      description: 'Rename test',
    }))
    await board.updateStatus({ taskID: job.taskID, state: 'completed' })

    const signalFile = join(signalDir, 'her-1.signal.json')
    const consumedFile = join(signalDir, 'her-1.consumed.json')

    // Before consume: signal exists, consumed does not
    assert.ok(existsSync(signalFile))
    assert.equal(existsSync(consumedFile), false)

    await consumeWakeSignals(signalDir)

    // After consume: signal is gone, consumed exists
    assert.equal(existsSync(signalFile), false)
    assert.ok(existsSync(consumedFile))
  } finally {
    rmSync(signalDir, { recursive: true, force: true })
  }
})

await testAsync('consumeWakeSignals returns empty for no signals', async () => {
  const signalDir = mkdtempSync(join(tmpdir(), 'aw-empty-'))
  try {
    const signals = await consumeWakeSignals(signalDir)
    assert.equal(signals.length, 0)
  } finally {
    rmSync(signalDir, { recursive: true, force: true })
  }
})

await testAsync('consumeWakeSignals is idempotent (second call returns empty)', async () => {
  const signalDir = mkdtempSync(join(tmpdir(), 'aw-idem-'))
  try {
    const board = new BackgroundJobBoard({ signalDir })
    const job = await board.registerLaunch(makeLaunch({
      agent: 'apollo',
      description: 'Idempotent test',
    }))
    await board.updateStatus({ taskID: job.taskID, state: 'completed' })

    const first = await consumeWakeSignals(signalDir)
    assert.equal(first.length, 1)

    const second = await consumeWakeSignals(signalDir)
    assert.equal(second.length, 0) // already consumed

    // Third call also empty
    const third = await consumeWakeSignals(signalDir)
    assert.equal(third.length, 0)
  } finally {
    rmSync(signalDir, { recursive: true, force: true })
  }
})

await testAsync('consumeWakeSignals handles error state signals', async () => {
  const signalDir = mkdtempSync(join(tmpdir(), 'aw-error-'))
  try {
    const board = new BackgroundJobBoard({ signalDir })
    const job = await board.registerLaunch(makeLaunch({
      agent: 'hermes',
      description: 'Error test',
    }))
    await board.updateStatus({
      taskID: job.taskID,
      state: 'error',
      error: 'Something failed',
    })

    const signals = await consumeWakeSignals(signalDir)
    assert.equal(signals.length, 1)
    assert.equal(signals[0]!.state, 'error')
    assert.equal(signals[0]!.summary, null) // no resultSummary set for error
  } finally {
    rmSync(signalDir, { recursive: true, force: true })
  }
})

await testAsync('consumeWakeSignals handles cancelled state signals', async () => {
  const signalDir = mkdtempSync(join(tmpdir(), 'aw-cancel-'))
  try {
    const board = new BackgroundJobBoard({ signalDir })
    const job = await board.registerLaunch(makeLaunch({
      agent: 'apollo',
      description: 'Cancel test',
    }))
    await board.markCancelled(job.taskID, 'User aborted')

    const signals = await consumeWakeSignals(signalDir)
    assert.equal(signals.length, 1)
    assert.equal(signals[0]!.state, 'cancelled')
  } finally {
    rmSync(signalDir, { recursive: true, force: true })
  }
})

await testAsync('consumeWakeSignals returns non-existent dir gracefully', async () => {
  const signals = await consumeWakeSignals('/tmp/nonexistent-signal-dir-12345')
  assert.equal(signals.length, 0)
})

// ═══════════════════════════════════════════════════════════════════════
// SUMMARY (inside main)
// ═══════════════════════════════════════════════════════════════════════

const passed = results.filter(r => r.passed).length
const failed = results.filter(r => !r.passed)

console.log('')
for (const r of results) {
  console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? ': ' + r.error : ''}`)
}
console.log(`
Results: ${passed} passed, ${failed.length} failed`)
process.exit(failed.length > 0 ? 1 : 0)
}

main()
