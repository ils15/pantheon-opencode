/**
 * delegation-bugs.test.ts — Regression tests for delegation mode bugs
 *
 * Covers:
 *   P0-1: readOnlyRegistry bypass on retry (read-only child not registered)
 *   P0-2: Kill-switch PANTHEON_DELEGATION=off not enforced on legacy tools
 *   P1-1: Signal leak — legacy finalize does not delete signal files
 *   P1-2: recoverRunningJobs does not persist or notify terminal
 *   P1-3: registerLaunch does not enforce maxConcurrentPerAgent atomically
 *   P1-4: pruneCompleted/enforceEntryCap not called in legacy finalize
 *   P1-1/P1-4 (merged from delegation-wake-prune.test.ts): legacy
 *         finalizeDelegation deletes the signal file and invokes
 *         pruneCompleted/enforceEntryCap with the configured options.
 *
 * Run: npx tsx tests/pantheon/delegation-bugs.test.ts
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BackgroundJobBoard,
  type BackgroundJobRecord,
  type PersistenceAdapter,
} from '../../src/pantheon/background-job-board.ts'
import { createDelegationTools } from '../../src/pantheon/delegation.ts'
import { readOnlyRegistry } from '../../src/pantheon/delegation-enforce.ts'
import { finalizeDelegation } from '../../src/pantheon/delegation-finalize.ts'
import { tmpDelegationDir } from './helpers/tmp-dir.ts'

// ─── Harness ───────────────────────────────────────────────────────────

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ─── In-Memory Persistence ─────────────────────────────────────────────

class InMemoryPersistence implements PersistenceAdapter {
  private store = new Map<string, BackgroundJobRecord>()
  readonly savedTaskIDs: string[] = []
  readonly deletedTaskIDs: string[] = []

  async saveJob(record: BackgroundJobRecord): Promise<void> {
    this.store.set(record.taskID, structuredClone(record))
    this.savedTaskIDs.push(record.taskID)
  }
  async loadAllJobs(): Promise<BackgroundJobRecord[]> {
    return Array.from(this.store.values()).map((r) => structuredClone(r))
  }
  async deleteJob(taskID: string): Promise<void> {
    this.store.delete(taskID)
    this.deletedTaskIDs.push(taskID)
  }
  get size() {
    return this.store.size
  }
}

// ─── Fake Client ───────────────────────────────────────────────────────

interface FakeCreateInput {
  body: { parentID: string; title?: string; model?: { id: string; providerID: string } }
}
interface FakePromptInput {
  path: { id: string }
  body: {
    agent: string
    model?: { id: string; providerID: string }
    parts: Array<{ type: string; text: string }>
  }
}

class FakeClient {
  created: FakeCreateInput[] = []
  prompted: FakePromptInput[] = []
  /** All promptAsync calls (including rejected ones) */
  allPromptCalls: FakePromptInput[] = []
  /** Delay for session.create to test concurrency */
  createDelayMs = 0
  /** When set, session.create rejects */
  createError: Error | null = null
  /** When set, promptAsync rejects */
  promptErrors: Error[] = []

  /** Session IDs passed to session.delete (orphan-cleanup spy). */
  deleted: string[] = []
  private childCounter = 0

  readonly session = {
    create: async (input: FakeCreateInput): Promise<{ id: string }> => {
      if (this.createError) throw this.createError
      if (this.createDelayMs > 0) await sleep(this.createDelayMs)
      this.created.push(input)
      this.childCounter++
      return { id: `ses_child_${this.childCounter}` }
    },
    promptAsync: async (input: FakePromptInput): Promise<unknown> => {
      this.allPromptCalls.push(input)
      if (this.promptErrors.length > 0) {
        const err = this.promptErrors.shift()
        if (err) throw err
      }
      this.prompted.push(input)
      return { status: 'accepted' }
    },
    messages: async (_input: unknown): Promise<unknown[]> => {
      return [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'fake output' }] }]
    },

    delete: async (input: { path: { id: string } }): Promise<unknown> => {
      this.deleted.push(input.path.id)
      return {}
    },
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────

function makeLaunch(
  overrides: Partial<{
    taskID: string
    parentSessionID: string
    agent: string
    description: string
  }> = {},
) {
  return {
    taskID: overrides.taskID ?? `task_${Math.random().toString(36).slice(2, 8)}`,
    parentSessionID: overrides.parentSessionID ?? 'ses_root',
    agent: overrides.agent ?? 'apollo',
    description: overrides.description ?? 'Test job',
  }
}

// ═══════════════════════════════════════════════════════════════════════
// P0-1: READ-ONLY BYPASS ON RETRY
// ═══════════════════════════════════════════════════════════════════════

async function testP0_1() {
  await testAsync('P0-1: readOnlyRegistry contains retryID after retry', async () => {
    const client = new FakeClient()
    client.promptErrors.push(new Error('startup rejected'))

    const board = new BackgroundJobBoard()
    readOnlyRegistry.clear()
    const tools = createDelegationTools({
      board,
      client: client as never,
      options: {
        rootSessions: new Set(['ses_root']),
        outputDir: tmpDelegationDir('bugs-'),
        readOnlyAgents: new Set(['apollo']),
        enforceRuntimeMatrix: false,
        bootstrapTimeoutMs: 50,
        bootstrapPollIntervalMs: 10,
        wallClockTimeoutMs: 10_000,
        promptTimeoutMs: 200,
        now: Date.now,
        sleep: (ms: number) => sleep(ms),
      },
    })

    const result = await tools.pantheon_delegate.execute(
      { prompt: 'investigate', agent: 'apollo', read_only: true },
      { sessionID: 'ses_root' },
    )

    assert.ok(result.includes('retry=1'), `Expected retry mention in result: ${result}`)

    // Track ALL promptAsync calls (including rejected ones) via allPromptCalls
    const allChildIDs: string[] = []
    for (const p of client.allPromptCalls) {
      allChildIDs.push(p.path.id)
    }

    assert.ok(allChildIDs.length >= 2, `Expected >= 2 prompted sessions, got ${allChildIDs.length}`)

    const retryID = allChildIDs[1]
    assert.ok(
      readOnlyRegistry.has(retryID),
      `retry session ${retryID} should be in readOnlyRegistry but was not — ` +
        `registry has: ${[...readOnlyRegistry.sessionIDs()].join(', ')}`,
    )
  })

  await testAsync('P0-1: readOnly NOT registered when agent is not readOnly', async () => {
    const client = new FakeClient()
    client.promptErrors.push(new Error('startup rejected'))

    const board = new BackgroundJobBoard()
    readOnlyRegistry.clear()
    const tools = createDelegationTools({
      board,
      client: client as never,
      options: {
        rootSessions: new Set(['ses_root']),
        outputDir: tmpDelegationDir('bugs-'),
        readOnlyAgents: new Set(['apollo']),
        enforceRuntimeMatrix: false,
        bootstrapTimeoutMs: 50,
        bootstrapPollIntervalMs: 10,
        wallClockTimeoutMs: 10_000,
        promptTimeoutMs: 200,
        now: Date.now,
        sleep: (ms: number) => sleep(ms),
      },
    })

    await tools.pantheon_delegate.execute(
      { prompt: 'implement something', agent: 'hermes' },
      { sessionID: 'ses_root' },
    )

    // Track ALL promptAsync calls via allPromptCalls
    const allChildIDs: string[] = []
    for (const p of client.allPromptCalls) {
      allChildIDs.push(p.path.id)
    }
    assert.ok(allChildIDs.length >= 1, 'Expected at least 1 prompted session')
    for (const id of allChildIDs) {
      assert.ok(!readOnlyRegistry.has(id), `hermes session ${id} should NOT be in readOnlyRegistry`)
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════
// P0-2: KILL-SWITCH NOT ENFORCED ON LEGACY TOOLS
// ═══════════════════════════════════════════════════════════════════════

async function testP0_2() {
  await testAsync('P0-2: legacy delegate throws when PANTHEON_DELEGATION=off', async () => {
    const client = new FakeClient()
    const board = new BackgroundJobBoard()
    const tools = createDelegationTools({
      board,
      client: client as never,
      options: {
        rootSessions: new Set(['ses_root']),
        outputDir: tmpDelegationDir('bugs-'),
        enforceRuntimeMatrix: false,
        delegationEnabled: false,
      },
    })

    let threw = false
    try {
      await tools.pantheon_delegate.execute(
        { prompt: 'test', agent: 'apollo' },
        { sessionID: 'ses_root' },
      )
    } catch (e: unknown) {
      threw = true
      const msg = e instanceof Error ? e.message : String(e)
      assert.ok(
        msg.includes('disabled') || msg.includes('off'),
        `Error should mention disabled/off: ${msg}`,
      )
    }
    assert.ok(threw, 'pantheon_delegate should throw when delegation is disabled')
  })

  await testAsync('P0-2: legacy read throws when PANTHEON_DELEGATION=off', async () => {
    const client = new FakeClient()
    const board = new BackgroundJobBoard()
    const tools = createDelegationTools({
      board,
      client: client as never,
      options: {
        rootSessions: new Set(['ses_root']),
        outputDir: tmpDelegationDir('bugs-'),
        enforceRuntimeMatrix: false,
        delegationEnabled: false,
      },
    })

    let threw = false
    try {
      await tools.pantheon_delegation_read.execute({ id: 'apo-1' }, { sessionID: 'ses_root' })
    } catch (e: unknown) {
      threw = true
      const msg = e instanceof Error ? e.message : String(e)
      assert.ok(
        msg.includes('disabled') || msg.includes('off'),
        `Error should mention disabled/off: ${msg}`,
      )
    }
    assert.ok(threw, 'pantheon_delegation_read should throw when delegation is disabled')
  })

  await testAsync('P0-2: legacy list throws when PANTHEON_DELEGATION=off', async () => {
    const client = new FakeClient()
    const board = new BackgroundJobBoard()
    const tools = createDelegationTools({
      board,
      client: client as never,
      options: {
        rootSessions: new Set(['ses_root']),
        outputDir: tmpDelegationDir('bugs-'),
        enforceRuntimeMatrix: false,
        delegationEnabled: false,
      },
    })

    let threw = false
    try {
      await tools.pantheon_delegation_list.execute({}, { sessionID: 'ses_root' })
    } catch (e: unknown) {
      threw = true
      const msg = e instanceof Error ? e.message : String(e)
      assert.ok(
        msg.includes('disabled') || msg.includes('off'),
        `Error should mention disabled/off: ${msg}`,
      )
    }
    assert.ok(threw, 'pantheon_delegation_list should throw when delegation is disabled')
  })

  await testAsync('P0-2: legacy tools work when delegation is enabled (default)', async () => {
    const client = new FakeClient()
    const board = new BackgroundJobBoard()
    const tools = createDelegationTools({
      board,
      client: client as never,
      options: {
        rootSessions: new Set(['ses_root']),
        outputDir: tmpDelegationDir('bugs-'),
        enforceRuntimeMatrix: false,
        // delegationEnabled defaults to true
      },
    })

    // Should NOT throw
    const result = await tools.pantheon_delegate.execute(
      { prompt: 'test', agent: 'apollo' },
      { sessionID: 'ses_root' },
    )
    assert.ok(typeof result === 'string', 'Should return a string result')
  })
}

// ═══════════════════════════════════════════════════════════════════════
// P1-1: SIGNAL LEAK — legacy finalize does not delete signals
// ═══════════════════════════════════════════════════════════════════════

async function testP1_1() {
  await testAsync('P1-1: signal file deleted after legacy finalize', async () => {
    const signalDir = mkdtempSync(join(tmpdir(), 'pantheon-signal-'))
    try {
      const client = new FakeClient()
      const board = new BackgroundJobBoard({ signalDir })
      const tools = createDelegationTools({
        board,
        client: client as never,
        options: {
          rootSessions: new Set(['ses_root']),
          enforceRuntimeMatrix: false,
          outputDir: signalDir,
          bootstrapTimeoutMs: 50,
          bootstrapPollIntervalMs: 10,
          wallClockTimeoutMs: 10_000,
          promptTimeoutMs: 200,
          now: Date.now,
          sleep: (ms: number) => sleep(ms),
        },
      })

      // Register a job manually and transition to terminal
      const job = await board.registerLaunch(makeLaunch({ agent: 'apollo' }))
      // Write signal
      await board.updateStatus({ taskID: job.taskID, state: 'completed', resultSummary: 'done' })

      // Signal file should exist
      const signalPath = join(signalDir, `${job.alias}.signal.json`)
      assert.ok(existsSync(signalPath), `Signal file should exist before finalize: ${signalPath}`)

      // Finalize (legacy path)
      await tools.finalizeDelegation(job.taskID, { state: 'completed' })

      // After finalize + reconcile, signal should be deleted
      assert.ok(
        !existsSync(signalPath),
        `Signal file should be deleted after legacy finalize: ${signalPath}`,
      )
    } finally {
      rmSync(signalDir, { recursive: true, force: true })
    }
  })

  await testAsync('P1-1: no stale signal files after successful delegation cycle', async () => {
    const signalDir = mkdtempSync(join(tmpdir(), 'pantheon-signal-'))
    try {
      const client = new FakeClient()
      const board = new BackgroundJobBoard({ signalDir })
      const tools = createDelegationTools({
        board,
        client: client as never,
        options: {
          rootSessions: new Set(['ses_root']),
          enforceRuntimeMatrix: false,
          outputDir: signalDir,
          bootstrapTimeoutMs: 50,
          bootstrapPollIntervalMs: 10,
          wallClockTimeoutMs: 10_000,
          promptTimeoutMs: 200,
          now: Date.now,
          sleep: (ms: number) => sleep(ms),
        },
      })

      // Complete a full delegation
      await tools.pantheon_delegate.execute(
        { prompt: 'scout', agent: 'apollo' },
        { sessionID: 'ses_root' },
      )

      // Wait for the child to finish
      await sleep(50)

      // Finalize the job
      const jobs = board.list('ses_root')
      for (const j of jobs) {
        if (j.state === 'running') {
          await board.updateStatus({ taskID: j.taskID, state: 'completed', resultSummary: 'done' })
        }
        await tools.finalizeDelegation(j.taskID, { state: 'completed' })
      }

      // No signal files should remain
      const { readdirSync } = await import('node:fs')
      const files = readdirSync(signalDir).filter((f) => f.endsWith('.signal.json'))
      assert.equal(
        files.length,
        0,
        `No signal files should remain after full cycle, found: ${files.join(', ')}`,
      )
    } finally {
      rmSync(signalDir, { recursive: true, force: true })
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════
// P1-2: recoverRunningJobs does not persist or notify
// ═══════════════════════════════════════════════════════════════════════

async function testP1_2() {
  await testAsync('P1-2: recoverRunningJobs persists error state to persistence', async () => {
    const persistence = new InMemoryPersistence()
    const signalDir = mkdtempSync(join(tmpdir(), 'pantheon-recover-'))
    try {
      const board = new BackgroundJobBoard({ signalDir })
      board.setPersistence(persistence)

      // Register a job, then persist it
      const _job = await board.registerLaunch(
        makeLaunch({ taskID: 'ses_crashed_1', agent: 'hermes' }),
      )

      // Verify persisted
      assert.ok(persistence.size > 0, 'Job should be persisted after registerLaunch')

      // Simulate crash: create a fresh board that loads from persistence
      const board2 = new BackgroundJobBoard({ signalDir })
      board2.setPersistence(persistence)
      await board2.recoverRunningJobs()

      // The recovered job should be in error state
      const recovered = board2.get('ses_crashed_1')
      assert.ok(recovered, 'Recovered job should exist')
      assert.equal(recovered?.state, 'error', 'Recovered job should be in error state')
      assert.ok(
        recovered?.lastStatusError?.includes('restarted'),
        'Error should mention process restarted',
      )

      // The persistence should have the error state (persistRecord was called)
      const persisted = await persistence.loadAllJobs()
      const persistedJob = persisted.find((j) => j.taskID === 'ses_crashed_1')
      assert.ok(persistedJob, 'Persisted job should exist')
      assert.equal(persistedJob?.state, 'error', 'Persisted job should be in error state')
    } finally {
      rmSync(signalDir, { recursive: true, force: true })
    }
  })

  await testAsync('P1-2: recoverRunningJobs writes signal for terminal jobs', async () => {
    const persistence = new InMemoryPersistence()
    const signalDir = mkdtempSync(join(tmpdir(), 'pantheon-recover-signal-'))
    try {
      const board = new BackgroundJobBoard({ signalDir })
      board.setPersistence(persistence)

      // Register and persist
      await board.registerLaunch(makeLaunch({ taskID: 'ses_crash_2', agent: 'apollo' }))

      // Recover on fresh board
      const board2 = new BackgroundJobBoard({ signalDir })
      board2.setPersistence(persistence)
      await board2.recoverRunningJobs()

      // Signal file should be written for the recovered job
      const signalPath = join(signalDir, 'apo-1.signal.json')
      assert.ok(
        existsSync(signalPath),
        `Signal file should be written during recovery: ${signalPath}`,
      )
    } finally {
      rmSync(signalDir, { recursive: true, force: true })
    }
  })

  await testAsync('P1-2: recoverRunningJobs notifies terminal listeners', async () => {
    const persistence = new InMemoryPersistence()
    const signalDir = mkdtempSync(join(tmpdir(), 'pantheon-recover-listen-'))
    try {
      const board = new BackgroundJobBoard({ signalDir })
      board.setPersistence(persistence)

      // Register and persist
      await board.registerLaunch(makeLaunch({ taskID: 'ses_crash_3', agent: 'apollo' }))

      // Recover on fresh board
      const board2 = new BackgroundJobBoard({ signalDir })
      board2.setPersistence(persistence)

      const notified: string[] = []
      board2.onTerminal((taskID) => notified.push(taskID))
      await board2.recoverRunningJobs()

      assert.ok(
        notified.includes('ses_crash_3'),
        `Terminal listener should be notified for recovered job, got: ${notified.join(', ')}`,
      )
    } finally {
      rmSync(signalDir, { recursive: true, force: true })
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════
// P1-3: CONCURRENCY NOT ATOMIC
// ═══════════════════════════════════════════════════════════════════════

async function testP1_3() {
  await testAsync('P1-3: registerLaunch rejects when maxConcurrentPerAgent exceeded', async () => {
    const board = new BackgroundJobBoard({ maxConcurrentPerAgent: 2 })

    // Fill the concurrency slots
    await board.registerLaunch(makeLaunch({ agent: 'apollo' }))
    await board.registerLaunch(makeLaunch({ agent: 'apollo' }))

    // Third should be rejected atomically (within registerLaunch, before any await)
    let threw = false
    try {
      await board.registerLaunch(makeLaunch({ agent: 'apollo' }))
    } catch (e: unknown) {
      threw = true
      const msg = e instanceof Error ? e.message : String(e)
      assert.ok(
        msg.includes('concurrency') || msg.includes('limit'),
        `Error should mention concurrency limit: ${msg}`,
      )
    }
    assert.ok(threw, 'registerLaunch should throw when concurrency limit is exceeded')
  })

  await testAsync(
    'P1-3: registerLaunchIfAbsent rejects when concurrent limit exceeded',
    async () => {
      const board = new BackgroundJobBoard({ maxConcurrentPerAgent: 1 })

      await board.registerLaunch(makeLaunch({ taskID: 't1', agent: 'apollo' }))

      let threw = false
      try {
        await board.registerLaunchIfAbsent(makeLaunch({ taskID: 't2', agent: 'apollo' }))
      } catch (_e: unknown) {
        threw = true
      }
      assert.ok(threw, 'registerLaunchIfAbsent should reject when concurrency limit is hit')
    },
  )

  await testAsync('P1-3: registerLaunch refusal on initial child cleans up orphan', async () => {
    const client = new FakeClient()
    const board = new BackgroundJobBoard({ maxConcurrentPerAgent: 1 })
    readOnlyRegistry.clear()

    // Race: a concurrent dispatch claims the only slot during session.create,
    // after the pre-check but before the initial registerLaunch.
    const originalCreate = client.session.create
    let firstCreate = true
    client.session.create = async (input: FakeCreateInput) => {
      if (firstCreate) {
        firstCreate = false
        await board.registerLaunch(makeLaunch({ taskID: 'race_blocker', agent: 'apollo' }))
      }
      return originalCreate(input)
    }

    const tools = createDelegationTools({
      board,
      client: client as never,
      options: {
        rootSessions: new Set(['ses_root']),
        outputDir: tmpDelegationDir('bugs-'),
        readOnlyAgents: new Set(['apollo']),
        enforceRuntimeMatrix: false,
        bootstrapTimeoutMs: 50,
        bootstrapPollIntervalMs: 10,
        wallClockTimeoutMs: 10_000,
        promptTimeoutMs: 200,
        now: Date.now,
        sleep: (ms: number) => sleep(ms),
      },
    })

    const result = await tools.pantheon_delegate.execute(
      { prompt: 'investigate', agent: 'apollo', read_only: true },
      { sessionID: 'ses_root' },
    )

    assert.ok(result.includes('rejected'), `expected a clear rejection, got: ${result}`)
    assert.ok(!client.deleted.includes('race_blocker'), 'the blocker is not ours to delete')
    assert.ok(client.deleted.includes('ses_child_1'), 'orphan child session should be deleted')
    assert.ok(
      !readOnlyRegistry.has('ses_child_1'),
      'orphan child must be removed from readOnlyRegistry',
    )
    assert.equal(client.allPromptCalls.length, 0, 'no prompt should be sent on refusal')
    assert.equal(board.getRunningCount('apollo'), 1, 'only the blocker remains running')
  })

  await testAsync('P1-3: retry re-validates concurrency and cleans up orphan', async () => {
    const client = new FakeClient()
    // First prompt is rejected synchronously → the delegate attempts one retry.
    client.promptErrors.push(new Error('startup rejected'))
    const board = new BackgroundJobBoard({ maxConcurrentPerAgent: 1 })
    readOnlyRegistry.clear()

    // Race: a concurrent dispatch claims the only slot after the initial child
    // is finalized and before the retry registers (injected on the 2nd create).
    const originalCreate = client.session.create
    let createCalls = 0
    client.session.create = async (input: FakeCreateInput) => {
      createCalls++
      if (createCalls === 2) {
        await board.registerLaunch(makeLaunch({ taskID: 'race_blocker', agent: 'apollo' }))
      }
      return originalCreate(input)
    }

    const tools = createDelegationTools({
      board,
      client: client as never,
      options: {
        rootSessions: new Set(['ses_root']),
        outputDir: tmpDelegationDir('bugs-'),
        readOnlyAgents: new Set(['apollo']),
        enforceRuntimeMatrix: false,
        bootstrapTimeoutMs: 50,
        bootstrapPollIntervalMs: 10,
        wallClockTimeoutMs: 10_000,
        promptTimeoutMs: 200,
        now: Date.now,
        sleep: (ms: number) => sleep(ms),
      },
    })

    const result = await tools.pantheon_delegate.execute(
      { prompt: 'investigate', agent: 'apollo', read_only: true },
      { sessionID: 'ses_root' },
    )

    assert.ok(result.includes('rejected'), `expected a clear retry rejection, got: ${result}`)
    assert.ok(result.includes('retry'), `rejection should mark the retry path: ${result}`)
    assert.ok(client.deleted.includes('ses_child_2'), 'orphan retry session should be deleted')
    assert.ok(
      !readOnlyRegistry.has('ses_child_2'),
      'retry session must be removed from readOnlyRegistry',
    )
    assert.equal(client.allPromptCalls.length, 1, 'retry prompt must not be sent after refusal')
    assert.equal(board.canDispatch('apollo'), false, 'retry re-validated the concurrency limit')
  })
}

// ═══════════════════════════════════════════════════════════════════════
// P1-4: NO PRUNE/CAP IN LEGACY
// ═══════════════════════════════════════════════════════════════════════

async function testP1_4() {
  await testAsync('P1-4: legacy finalize triggers prune and entry cap', async () => {
    const client = new FakeClient()
    const board = new BackgroundJobBoard({ maxConcurrentPerAgent: 3 })
    const tools = createDelegationTools({
      board,
      client: client as never,
      options: {
        rootSessions: new Set(['ses_root']),
        enforceRuntimeMatrix: false,
        outputDir: mkdtempSync(join(tmpdir(), 'pantheon-prune-')),
        keepCompleted: 2,
        maxEntries: 50,
        bootstrapTimeoutMs: 50,
        bootstrapPollIntervalMs: 10,
        wallClockTimeoutMs: 10_000,
        promptTimeoutMs: 200,
        now: Date.now,
        sleep: (ms: number) => sleep(ms),
      },
    })

    // Create 5 completed jobs
    const taskIDs: string[] = []
    for (let i = 0; i < 5; i++) {
      const tid = `prune_task_${i}`
      taskIDs.push(tid)
      const _job = await board.registerLaunch(makeLaunch({ taskID: tid, agent: 'apollo' }))
      await board.updateStatus({ taskID: tid, state: 'completed', resultSummary: `result ${i}` })
    }

    // All 5 should exist before finalize
    assert.equal(board.size(), 5, 'All 5 jobs should exist before finalize')

    // Finalize one — this should trigger prune/cap
    await tools.finalizeDelegation(taskIDs[0], { state: 'completed' })

    // keepCompleted=2 is configured above (the real default is 10); with 5
    // completed jobs, finalizeDelegation must call pruneCompleted(2) and evict
    // the 3 oldest. This is only observable if the prune path actually runs.
    const sizeAfter = board.size()
    assert.equal(
      sizeAfter,
      2,
      `finalize should prune to keepCompleted=2, got board size ${sizeAfter}`,
    )
  })

  await testAsync('P1-4: pruneCompleted removes oldest completed jobs', async () => {
    const board = new BackgroundJobBoard()

    // Create 5 completed jobs
    for (let i = 0; i < 5; i++) {
      const _job = await board.registerLaunch(makeLaunch({ taskID: `p_${i}` }))
      await board.updateStatus({ taskID: `p_${i}`, state: 'completed', resultSummary: `r${i}` })
    }

    assert.equal(board.size(), 5)

    // Prune to keep only 2
    const evicted = await board.pruneCompleted(2)
    assert.equal(evicted, 3, 'Should evict 3 jobs')
    assert.equal(board.size(), 2, 'Should keep 2 jobs')
  })

  await testAsync('P1-4: enforceEntryCap removes oldest when over cap', async () => {
    const board = new BackgroundJobBoard()

    for (let i = 0; i < 5; i++) {
      await board.registerLaunch(makeLaunch({ taskID: `cap_${i}` }))
      await board.updateStatus({ taskID: `cap_${i}`, state: 'completed', resultSummary: `r${i}` })
    }

    const evicted = await board.enforceEntryCap(3)
    assert.equal(evicted, 2, 'Should evict 2 jobs')
    assert.equal(board.size(), 3, 'Should keep 3 jobs')
  })
}

// ═══════════════════════════════════════════════════════════════════════
// P1-1 / P1-4: LEGACY finalizeDelegation WAKE + PRUNE
// (merged from delegation-wake-prune.test.ts)
// ═══════════════════════════════════════════════════════════════════════

function makeFinalizeDeps(board: BackgroundJobBoard, signalDir: string) {
  return {
    board,
    client: {
      session: {
        messages: async () => [
          { info: { role: 'assistant' }, parts: [{ type: 'text' as const, text: 'work done' }] },
        ],
      },
    },
    options: { outputDir: signalDir },
  } as Parameters<typeof finalizeDelegation>[0]
}

async function testWakePrune() {
  await testAsync('WP: signal file deleted after legacy finalize', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'wp-signal-'))
    const signalDir = join(tmpDir, 'signals')
    mkdirSync(signalDir, { recursive: true })

    try {
      // Create a board WITH signalDir so writeSignal produces files.
      const board = new BackgroundJobBoard({ signalDir })

      await board.registerLaunch({
        taskID: 'sig-child-1',
        parentSessionID: 'root',
        agent: 'apollo',
        description: 'signal leak test',
      })

      // Transition to terminal — this writes the .signal.json file.
      await board.updateStatus({ taskID: 'sig-child-1', state: 'completed', resultSummary: 'ok' })

      const job = board.get('sig-child-1')
      assert.ok(job, 'job registered')
      const signalPath = join(signalDir, `${job.alias}.signal.json`)
      assert.ok(existsSync(signalPath), 'signal file exists before finalize')

      const deps = makeFinalizeDeps(board, tmpDir)
      const finalized = await finalizeDelegation(deps, 'sig-child-1', { state: 'completed' })
      assert.ok(finalized, 'finalize returned a job')

      // After finalize, the signal file must be gone.
      assert.ok(!existsSync(signalPath), 'signal file deleted after finalize (P1-1)')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  await testAsync('P1-1: no signal survives finalize + markReconciled reconcile', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'wp-signal-reconcile-'))
    const signalDir = join(tmpDir, 'signals')
    mkdirSync(signalDir, { recursive: true })

    try {
      const board = new BackgroundJobBoard({ signalDir })

      await board.registerLaunch({
        taskID: 'reconcile-child-1',
        parentSessionID: 'root',
        agent: 'prometheus',
        description: 'reconcile signal leak test',
      })

      // Terminal transition writes the auto-wake signal.
      await board.updateStatus({
        taskID: 'reconcile-child-1',
        state: 'completed',
        resultSummary: 'done',
      })
      const job = board.get('reconcile-child-1')
      assert.ok(job, 'job registered')
      const signalPath = join(signalDir, `${job.alias}.signal.json`)
      assert.ok(existsSync(signalPath), 'signal file exists before finalize')

      const deps = makeFinalizeDeps(board, tmpDir)
      await finalizeDelegation(deps, 'reconcile-child-1', { state: 'completed' })

      // The read path acknowledges the job: finalize is followed by reconcile.
      await board.markReconciled('reconcile-child-1')

      assert.equal(board.get('reconcile-child-1')?.state, 'reconciled')
      assert.ok(
        !existsSync(signalPath),
        'markReconciled must not re-write the signal for a reconciled job (P1-1)',
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  await testAsync('WP: pruneCompleted and enforceEntryCap are called', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'wp-prune-'))

    try {
      const board = new BackgroundJobBoard()
      const pruneCalls: number[] = []
      const capCalls: number[] = []

      // Intercept pruneCompleted and enforceEntryCap via spy.
      const origPrune = board.pruneCompleted.bind(board)
      board.pruneCompleted = async (keepNewest: number) => {
        pruneCalls.push(keepNewest)
        return origPrune(keepNewest)
      }
      const origCap = board.enforceEntryCap.bind(board)
      board.enforceEntryCap = async (maxEntries: number) => {
        capCalls.push(maxEntries)
        return origCap(maxEntries)
      }

      // Also spy deleteSignal to confirm P1-1 in the same run.
      const deleteCalls: string[] = []
      const origDelete = board.deleteSignal.bind(board)
      board.deleteSignal = async (alias: string) => {
        deleteCalls.push(alias)
        return origDelete(alias)
      }

      await board.registerLaunch({
        taskID: 'prune-child-1',
        parentSessionID: 'root',
        agent: 'hermes',
        description: 'prune test',
      })

      const deps = makeFinalizeDeps(board, tmpDir)
      await finalizeDelegation(deps, 'prune-child-1', { state: 'completed' })

      // pruneCompleted was invoked with default keepCompleted=10.
      assert.ok(pruneCalls.length >= 1, 'pruneCompleted was called at least once')
      assert.equal(pruneCalls[0], 10, 'pruneCompleted default keepCompleted = 10')

      // enforceEntryCap was invoked with default maxEntries=50.
      assert.ok(capCalls.length >= 1, 'enforceEntryCap was called at least once')
      assert.equal(capCalls[0], 50, 'enforceEntryCap default maxEntries = 50')

      // deleteSignal was called with the job's alias.
      assert.ok(deleteCalls.length >= 1, 'deleteSignal was called at least once')
      assert.equal(
        deleteCalls[0],
        board.get('prune-child-1')?.alias,
        'deleteSignal called with correct alias',
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  await testAsync('WP: custom keepCompleted / maxEntries flow through', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'wp-opts-'))

    try {
      const board = new BackgroundJobBoard()
      const pruneCalls: number[] = []
      const capCalls: number[] = []

      const origPrune = board.pruneCompleted.bind(board)
      board.pruneCompleted = async (keepNewest: number) => {
        pruneCalls.push(keepNewest)
        return origPrune(keepNewest)
      }
      const origCap = board.enforceEntryCap.bind(board)
      board.enforceEntryCap = async (maxEntries: number) => {
        capCalls.push(maxEntries)
        return origCap(maxEntries)
      }

      await board.registerLaunch({
        taskID: 'opts-child-1',
        parentSessionID: 'root',
        agent: 'demeter',
        description: 'custom options test',
      })

      const deps = makeFinalizeDeps(board, tmpDir)
      deps.options = { ...deps.options, keepCompleted: 5, maxEntries: 20 }

      await finalizeDelegation(deps, 'opts-child-1', { state: 'completed' })

      assert.equal(pruneCalls[0], 5, 'custom keepCompleted=5 passed through')
      assert.equal(capCalls[0], 20, 'custom maxEntries=20 passed through')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
}

// ═══════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  // Clean up any leftover readOnly entries from other tests
  readOnlyRegistry.clear?.()

  console.log('Running delegation bug regression tests...\n')

  await testP0_1()
  await testP0_2()
  await testP1_1()
  await testP1_2()
  await testP1_3()
  await testP1_4()
  await testWakePrune()

  console.log('\n─── Results ───')
  let passed = 0
  let failed = 0
  for (const r of results) {
    const icon = r.passed ? '\u2705' : '\u274c'
    console.log(`  ${icon} ${r.name}`)
    if (!r.passed) {
      console.log(`     Error: ${r.error}`)
      failed++
    } else {
      passed++
    }
  }
  console.log(`\n  Total: ${passed} passed, ${failed} failed out of ${results.length}`)

  if (failed > 0) {
    console.log('\nFAILED')
    process.exit(1)
  } else {
    console.log('\nPASSED')
  }
}

main().catch((err) => {
  console.error('Unhandled error:', err)
  process.exit(1)
})
