/**
 * Comprehensive tests for BackgroundJobBoard.
 *
 * Run with: npx tsx tests/pantheon/background-job-board.test.ts
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BackgroundJobBoard,
  type BackgroundJobRecord,
  type ContextFile,
  type PersistenceAdapter,
} from '../../src/pantheon/background-job-board.ts'

// ─── Helpers ───────────────────────────────────────────────────────────

const results: { name: string; passed: boolean; error?: string }[] = []

async function testAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    results.push({ name, passed: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ name, passed: false, error: msg })
  }
}

function makeLaunch(
  overrides: Partial<{
    taskID: string
    parentSessionID: string
    agent: string
    description: string
    contextFiles: ContextFile[]
  }> = {},
) {
  return {
    taskID: overrides.taskID ?? `task_${Math.random().toString(36).slice(2, 8)}`,
    parentSessionID: overrides.parentSessionID ?? 'ses_test',
    agent: overrides.agent ?? 'apollo',
    description: overrides.description ?? 'Test job',
    contextFiles: overrides.contextFiles,
  }
}

// ─── In-Memory Persistence Adapter (for testing) ───────────────────────

class InMemoryPersistence implements PersistenceAdapter {
  private store = new Map<string, BackgroundJobRecord>()

  async saveJob(record: BackgroundJobRecord): Promise<void> {
    this.store.set(record.taskID, structuredClone(record))
  }

  async loadAllJobs(): Promise<BackgroundJobRecord[]> {
    return Array.from(this.store.values()).map((r) => structuredClone(r))
  }

  async deleteJob(taskID: string): Promise<void> {
    this.store.delete(taskID)
  }

  get size() {
    return this.store.size
  }
}

/** Persistence adapter that records every deleteJob call (for prune verification). */
class SpyPersistence extends InMemoryPersistence {
  readonly deletedTaskIDs: string[] = []

  async deleteJob(taskID: string): Promise<void> {
    this.deletedTaskIDs.push(taskID)
    return super.deleteJob(taskID)
  }
}

// ═══════════════════════════════════════════════════════════════════════
// REGISTER LAUNCH
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  await testAsync('registerLaunch creates a running job with defaults', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch())

    assert.equal(job.state, 'running')
    assert.equal(job.timedOut, false)
    assert.equal(job.totalErrors, 0)
    assert.equal(job.timeoutCount, 0)
    assert.equal(job.terminalUnreconciled, false)
    assert.ok(job.launchedAt > 0)
    assert.ok(job.updatedAt > 0)
    assert.equal(job.completedAt, undefined)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // UPDATE STATUS — state machine
  // ═══════════════════════════════════════════════════════════════════════

  await testAsync('updateStatus running → completed', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch())

    const updated = await board.updateStatus({
      taskID: job.taskID,
      state: 'completed',
      resultSummary: 'All good',
    })

    assert.ok(updated)
    assert.equal(updated!.state, 'completed')
    assert.equal(updated!.resultSummary, 'All good')
    assert.equal(updated!.terminalUnreconciled, true)
    assert.ok(updated!.completedAt)
  })

  await testAsync('updateStatus running → error', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch())

    const updated = await board.updateStatus({
      taskID: job.taskID,
      state: 'error',
      error: 'Something broke',
      timedOut: false,
    })

    assert.ok(updated)
    assert.equal(updated!.state, 'error')
    assert.equal(updated!.lastStatusError, 'Something broke')
    assert.equal(updated!.totalErrors, 1)
    assert.equal(updated!.timedOut, false)
  })

  await testAsync('updateStatus running → cancelled', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch())

    const updated = await board.updateStatus({
      taskID: job.taskID,
      state: 'cancelled',
    })

    assert.ok(updated)
    assert.equal(updated!.state, 'cancelled')
  })

  await testAsync('updateStatus with timedOut flag', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch())

    const updated = await board.updateStatus({
      taskID: job.taskID,
      state: 'error',
      error: 'Timed out',
      timedOut: true,
    })

    assert.ok(updated)
    assert.equal(updated!.timedOut, true)
    assert.equal(updated!.timeoutCount, 1)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // UPDATE STATUS — invalid transitions
  // ═══════════════════════════════════════════════════════════════════════

  await testAsync('updateStatus running → running throws', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch())

    await assert.rejects(
      // @ts-expect-error — testing invalid state transition
      board.updateStatus({ taskID: job.taskID, state: 'running' }),
      /Invalid state transition/,
    )
  })

  await testAsync('updateStatus completed → running throws', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch())
    await board.updateStatus({ taskID: job.taskID, state: 'completed' })

    await assert.rejects(
      // @ts-expect-error — testing invalid state transition
      board.updateStatus({ taskID: job.taskID, state: 'running' }),
      /Invalid state transition/,
    )
  })

  await testAsync('updateStatus completed → error throws', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch())
    await board.updateStatus({ taskID: job.taskID, state: 'completed' })

    await assert.rejects(
      board.updateStatus({ taskID: job.taskID, state: 'error' }),
      /Invalid state transition/,
    )
  })

  await testAsync('updateStatus reconciled → anything throws', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch())
    await board.updateStatus({ taskID: job.taskID, state: 'completed' })
    await board.markReconciled(job.taskID)

    await assert.rejects(
      board.updateStatus({ taskID: job.taskID, state: 'completed' }),
      /Invalid state transition/,
    )
  })

  // ═══════════════════════════════════════════════════════════════════════
  // UPDATE STATUS — idempotent same-state
  // ═══════════════════════════════════════════════════════════════════════

  await testAsync('updateStatus completed → completed is idempotent', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch())
    await board.updateStatus({ taskID: job.taskID, state: 'completed', resultSummary: 'v1' })
    const updated = await board.updateStatus({
      taskID: job.taskID,
      state: 'completed',
      resultSummary: 'v2',
    })

    assert.ok(updated)
    assert.equal(updated!.state, 'completed')
    assert.equal(updated!.resultSummary, 'v2') // last write wins
  })

  await testAsync('updateStatus error → error is idempotent (accumulates errors)', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch())

    await board.updateStatus({ taskID: job.taskID, state: 'error', error: 'first' })
    assert.equal(job.totalErrors, 1)

    await board.updateStatus({ taskID: job.taskID, state: 'error', error: 'second' })
    assert.equal(job.totalErrors, 2)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // MARK CANCELLED
  // ═══════════════════════════════════════════════════════════════════════

  await testAsync('markCancelled from running', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch())

    const cancelled = await board.markCancelled(job.taskID, 'User cancelled')
    assert.ok(cancelled)
    assert.equal(cancelled!.state, 'cancelled')
    assert.equal(cancelled!.lastStatusError, 'User cancelled')
  })

  await testAsync('markCancelled from non-running terminal throws', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch())
    await board.updateStatus({ taskID: job.taskID, state: 'completed' })

    await assert.rejects(board.markCancelled(job.taskID), /Cannot cancel/)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // MARK RECONCILED
  // ═══════════════════════════════════════════════════════════════════════

  await testAsync('markReconciled from completed', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch())
    await board.updateStatus({ taskID: job.taskID, state: 'completed' })

    const reconciled = await board.markReconciled(job.taskID)
    assert.ok(reconciled)
    assert.equal(reconciled!.state, 'reconciled')
    assert.equal(reconciled!.terminalUnreconciled, false)
  })

  await testAsync('markReconciled from running throws', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch())

    await assert.rejects(board.markReconciled(job.taskID), /only terminal states/)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // CONCURRENCY
  // ═══════════════════════════════════════════════════════════════════════

  await testAsync('canDispatch respects maxConcurrentPerAgent', async () => {
    const board = new BackgroundJobBoard({ maxConcurrentPerAgent: 2 })
    assert.ok(board.canDispatch('apollo'))

    await board.registerLaunch(makeLaunch({ agent: 'apollo', parentSessionID: 's1' }))
    assert.ok(board.canDispatch('apollo'))

    await board.registerLaunch(makeLaunch({ agent: 'apollo', parentSessionID: 's1' }))
    assert.equal(board.canDispatch('apollo'), false) // at limit

    // Different agent is not blocked
    assert.ok(board.canDispatch('hermes'))
  })

  // ═══════════════════════════════════════════════════════════════════════
  // TERMINAL STATE LISTENERS
  // ═══════════════════════════════════════════════════════════════════════

  await testAsync('onTerminal fires when job reaches terminal state', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch())
    const fired: string[] = []

    board.onTerminal((taskID) => fired.push(taskID))
    await board.updateStatus({ taskID: job.taskID, state: 'completed' })

    assert.equal(fired.length, 1)
    assert.equal(fired[0], job.taskID)
  })

  await testAsync('onTerminal fires only once for first terminal transition', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch())
    const fired: string[] = []

    board.onTerminal((taskID) => fired.push(taskID))
    await board.updateStatus({ taskID: job.taskID, state: 'completed' })

    // Re-applying same state (idempotent) should NOT fire again
    await board.updateStatus({ taskID: job.taskID, state: 'completed' })
    assert.equal(fired.length, 1)
  })

  await testAsync('onTerminal fires for markCancelled', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch())
    const fired: string[] = []

    board.onTerminal((taskID) => fired.push(taskID))
    await board.markCancelled(job.taskID)

    assert.equal(fired.length, 1)
    assert.equal(fired[0], job.taskID)
  })

  await testAsync(
    'markReconciled does NOT re-fire onTerminal (reconcile is an acknowledgment)',
    async () => {
      const board = new BackgroundJobBoard()
      const job = await board.registerLaunch(makeLaunch())
      const fired: string[] = []

      board.onTerminal((taskID) => fired.push(taskID))
      await board.updateStatus({ taskID: job.taskID, state: 'completed' })
      assert.equal(fired.length, 1) // first fire from updateStatus — the only terminal transition

      await board.markReconciled(job.taskID)
      assert.equal(fired.length, 1) // reconcile must not fire terminal listeners (no duplicate notification)
      const reconciled = board.get(job.taskID)
      assert.ok(reconciled)
      assert.equal(reconciled.state, 'reconciled')
    },
  )

  await testAsync('removeTerminalListener stops firing', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch())
    const fired: string[] = []

    const listener = (taskID: string) => fired.push(taskID)
    board.onTerminal(listener)
    board.removeTerminalListener(listener)

    await board.updateStatus({ taskID: job.taskID, state: 'completed' })
    assert.equal(fired.length, 0)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // WAIT FOR TERMINAL
  // ═══════════════════════════════════════════════════════════════════════

  await testAsync('waitForTerminal resolves when job reaches terminal state', async () => {
    const board = new BackgroundJobBoard()
    await board.registerLaunch(makeLaunch({ taskID: 'wait-1' }))

    const promise = board.waitForTerminal('wait-1', 1_000)
    await board.updateStatus({ taskID: 'wait-1', state: 'completed', resultSummary: 'done' })

    const result = await promise
    assert.equal(result.state, 'completed')
    assert.equal(result.resultSummary, 'done')
  })

  await testAsync('waitForTerminal resolves immediately for already-terminal job', async () => {
    const board = new BackgroundJobBoard()
    const job = await board.registerLaunch(makeLaunch({ taskID: 'wait-done' }))
    await board.updateStatus({ taskID: job.taskID, state: 'completed' })

    const result = await board.waitForTerminal('wait-done', 1_000)
    assert.equal(result.state, 'completed')
  })

  await testAsync('waitForTerminal rejects on timeout when job never terminates', async () => {
    const board = new BackgroundJobBoard()
    await board.registerLaunch(makeLaunch({ taskID: 'wait-never' }))

    await assert.rejects(board.waitForTerminal('wait-never', 50), /Timed out after 50ms/)
  })

  await testAsync('waitForTerminal supports multiple concurrent waiters', async () => {
    const board = new BackgroundJobBoard()
    await board.registerLaunch(makeLaunch({ taskID: 'wait-multi' }))

    const p1 = board.waitForTerminal('wait-multi', 1_000)
    const p2 = board.waitForTerminal('wait-multi', 1_000)

    await board.updateStatus({ taskID: 'wait-multi', state: 'completed' })

    const [r1, r2] = await Promise.all([p1, p2])
    assert.equal(r1.state, 'completed')
    assert.equal(r2.state, 'completed')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // CLEANUP
  // ═══════════════════════════════════════════════════════════════════════

  await testAsync(
    'pruneExpired removes old TERMINAL jobs but never prunes running jobs',
    async () => {
      const board = new BackgroundJobBoard()
      const oldCompleted = await board.registerLaunch(makeLaunch({ taskID: 'old-completed' }))
      await board.updateStatus({ taskID: oldCompleted.taskID, state: 'completed' })
      // registerLaunch/updateStatus return the LIVE record — mutate updatedAt to age it
      oldCompleted.updatedAt = Date.now() - 100_000

      const oldRunning = await board.registerLaunch(makeLaunch({ taskID: 'old-running' }))
      oldRunning.updatedAt = Date.now() - 100_000

      const newJob = await board.registerLaunch(makeLaunch({ taskID: 'new-job' }))
      newJob.updatedAt = Date.now() - 1_000

      await board.pruneExpired(10_000) // TTL = 10s

      assert.equal(board.get('old-completed'), undefined) // pruned (terminal + old)
      assert.ok(board.get('old-running'), 'running jobs are NEVER pruned, even when old')
      assert.ok(board.get('new-job'))
    },
  )

  await testAsync('pruneExpired calls persistence.deleteJob for each pruned job', async () => {
    const board = new BackgroundJobBoard()
    const adapter = new SpyPersistence()
    board.setPersistence(adapter)

    const a = await board.registerLaunch(makeLaunch({ taskID: 'prune-a' }))
    await board.updateStatus({ taskID: a.taskID, state: 'completed' })
    a.updatedAt = Date.now() - 100_000

    const b = await board.registerLaunch(makeLaunch({ taskID: 'prune-b' }))
    await board.updateStatus({ taskID: b.taskID, state: 'error' })
    b.updatedAt = Date.now() - 100_000

    // Old running job must NOT be pruned or deleted
    const running = await board.registerLaunch(makeLaunch({ taskID: 'prune-run' }))
    running.updatedAt = Date.now() - 100_000

    await board.pruneExpired(10_000)

    assert.deepEqual(adapter.deletedTaskIDs.sort(), ['prune-a', 'prune-b'])
    assert.ok(board.get('prune-run'), 'running job survives pruning')
    const persisted = await adapter.loadAllJobs()
    assert.equal(persisted.length, 1) // only the running job remains persisted
    assert.equal(persisted[0]?.taskID, 'prune-run')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // PERSISTENCE ADAPTER
  // ═══════════════════════════════════════════════════════════════════════

  await testAsync('setPersistence saves job on registerLaunch', async () => {
    const board = new BackgroundJobBoard()
    const adapter = new InMemoryPersistence()
    board.setPersistence(adapter)

    assert.equal(adapter.size, 0)
    await board.registerLaunch(makeLaunch({ taskID: 'persist-1' }))
    assert.equal(adapter.size, 1)

    const loaded = await adapter.loadAllJobs()
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]!.taskID, 'persist-1')
  })

  await testAsync('setPersistence saves job on updateStatus', async () => {
    const board = new BackgroundJobBoard()
    const adapter = new InMemoryPersistence()
    board.setPersistence(adapter)

    const job = await board.registerLaunch(makeLaunch({ taskID: 'persist-2' }))
    await board.updateStatus({ taskID: job.taskID, state: 'completed', resultSummary: 'persisted' })

    const loaded = await adapter.loadAllJobs()
    const persisted = loaded.find((r) => r.taskID === 'persist-2')
    assert.ok(persisted)
    assert.equal(persisted!.state, 'completed')
    assert.equal(persisted!.resultSummary, 'persisted')
  })

  await testAsync('recoverRunningJobs marks orphaned running jobs as error', async () => {
    const board = new BackgroundJobBoard()
    const adapter = new InMemoryPersistence()

    // Simulate a previous session crash by manually saving a running job
    await adapter.saveJob({
      taskID: 'orphan-1',
      parentSessionID: 'ses_crash',
      agent: 'apollo',
      description: 'Orphaned job',
      state: 'running',
      timedOut: false,
      alias: 'apo-1',
      launchedAt: Date.now() - 5000,
      updatedAt: Date.now() - 5000,
      totalErrors: 0,
      timeoutCount: 0,
      terminalUnreconciled: false,
      contextFiles: [],
    })

    board.setPersistence(adapter)
    await board.recoverRunningJobs()

    const recovered = board.get('orphan-1')
    assert.ok(recovered)
    assert.equal(recovered!.state, 'error')
    assert.ok(recovered!.lastStatusError?.includes('Process restarted'))
    assert.equal(recovered!.totalErrors, 1)
  })

  await testAsync('recoverRunningJobs preserves terminal jobs', async () => {
    const board = new BackgroundJobBoard()
    const adapter = new InMemoryPersistence()

    await adapter.saveJob({
      taskID: 'completed-1',
      parentSessionID: 'ses_prev',
      agent: 'apollo',
      description: 'Already done',
      state: 'completed',
      timedOut: false,
      alias: 'apo-1',
      launchedAt: Date.now() - 5000,
      updatedAt: Date.now() - 5000,
      completedAt: Date.now() - 5000,
      totalErrors: 0,
      timeoutCount: 0,
      terminalUnreconciled: true,
      contextFiles: [],
      resultSummary: 'Done before crash',
    })

    board.setPersistence(adapter)
    await board.recoverRunningJobs()

    const recovered = board.get('completed-1')
    assert.ok(recovered)
    assert.equal(recovered!.state, 'completed')
    assert.equal(recovered!.resultSummary, 'Done before crash')
  })

  // ═══════════════════════════════════════════════════════════════════════
  // SIGNAL FILES
  // ═══════════════════════════════════════════════════════════════════════

  await testAsync('writeSignal creates .signal.json file on terminal transition', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'board-signal-test-'))
    try {
      const board = new BackgroundJobBoard({ signalDir: tmpDir })
      const job = await board.registerLaunch(makeLaunch({ agent: 'apollo' }))
      await board.updateStatus({ taskID: job.taskID, state: 'completed', resultSummary: 'Done' })

      const signalFile = join(tmpDir, 'apo-1.signal.json')
      assert.ok(existsSync(signalFile), 'signal file should exist')

      const content = JSON.parse(readFileSync(signalFile, 'utf-8'))
      assert.equal(content.taskID, job.taskID)
      assert.equal(content.alias, 'apo-1')
      assert.equal(content.agent, 'apollo')
      assert.equal(content.state, 'completed')
      assert.equal(content.summary, 'Done')
      assert.ok(content.timestamp > 0)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  await testAsync('no signal file when signalDir is null', async () => {
    const board = new BackgroundJobBoard() // signalDir defaults to null
    const job = await board.registerLaunch(makeLaunch())
    await board.updateStatus({ taskID: job.taskID, state: 'completed' })
    // No assertion needed — just verifying it doesn't throw
  })

  await testAsync('signal file uses atomic write (tmp + rename)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'board-atomic-'))
    try {
      const board = new BackgroundJobBoard({ signalDir: tmpDir })
      const job = await board.registerLaunch(makeLaunch({ agent: 'hermes' }))
      await board.updateStatus({ taskID: job.taskID, state: 'error', error: 'fail' })

      // The .tmp file should be gone (renamed to .signal.json)
      const tmpFile = join(tmpDir, 'her-1.signal.tmp')
      const signalFile = join(tmpDir, 'her-1.signal.json')
      assert.equal(existsSync(tmpFile), false, 'tmp file should be gone after rename')
      assert.ok(existsSync(signalFile), 'signal file should exist')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // CONCURRENCY DEFAULTS
  // ═══════════════════════════════════════════════════════════════════════

  await testAsync('default maxConcurrentPerAgent is 3', async () => {
    const board = new BackgroundJobBoard()
    assert.equal(board.canDispatch('apollo'), true)
    await board.registerLaunch(makeLaunch({ agent: 'apollo' }))
    await board.registerLaunch(makeLaunch({ agent: 'apollo' }))
    await board.registerLaunch(makeLaunch({ agent: 'apollo' }))
    assert.equal(board.canDispatch('apollo'), false)
  })

  // ═══════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════

  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed)

  console.log('')
  for (const r of results) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? ': ' + r.error : ''}`)
  }
  console.log(`\nResults: ${passed} passed, ${failed.length} failed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main()
