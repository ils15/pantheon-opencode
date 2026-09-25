/**
 * Tests for FilePersistenceAdapter.
 *
 * Run with: npx tsx tests/pantheon/file-persistence.test.ts
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BackgroundJobBoard,
  type BackgroundJobRecord,
} from '../../src/pantheon/background-job-board.ts'
import {
  FilePersistenceAdapter,
  type PersistenceFsOps,
  salvageRecords,
} from '../../src/pantheon/file-persistence.ts'

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
  }> = {},
) {
  return {
    taskID: overrides.taskID ?? `task_${Math.random().toString(36).slice(2, 8)}`,
    parentSessionID: overrides.parentSessionID ?? 'ses_test',
    agent: overrides.agent ?? 'apollo',
    description: overrides.description ?? 'Test job',
  }
}

/** Build a complete BackgroundJobRecord with sensible defaults. */
function makeRecord(
  taskID: string,
  overrides: Partial<BackgroundJobRecord> = {},
): BackgroundJobRecord {
  const now = Date.now()
  return {
    taskID,
    parentSessionID: 'ses_test',
    agent: 'apollo',
    description: 'record',
    state: 'running',
    timedOut: false,
    alias: `apo-${taskID}`,
    launchedAt: now,
    updatedAt: now,
    totalErrors: 0,
    timeoutCount: 0,
    terminalUnreconciled: false,
    contextFiles: [],
    ...overrides,
  }
}

/** Real fs backed ops with overridable rename/readFile for fault injection. */
function makeOps(
  renameOverride?: PersistenceFsOps['rename'],
  readFileOverride?: PersistenceFsOps['readFile'],
): PersistenceFsOps {
  return {
    mkdir: async (dir) => {
      await fsp.mkdir(dir, { recursive: true })
    },
    readFile: readFileOverride ?? ((path, encoding) => fsp.readFile(path, encoding)),
    rename: renameOverride ?? ((from, to) => fsp.rename(from, to)),
    openForWrite: (path) => fsp.open(path, 'w'),
    unlink: (path) => fsp.unlink(path),
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

      const jobA = loaded.find((r) => r.taskID === 'job-a')
      assert.ok(jobA)
      assert.equal(jobA?.state, 'completed')
      assert.equal(jobA?.resultSummary, 'Done A')

      const jobB = loaded.find((r) => r.taskID === 'job-b')
      assert.ok(jobB)
      assert.equal(jobB?.state, 'running')
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
      assert.equal(loaded[0]?.taskID, 'real-job')
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

  await testAsync(
    'deleteJob on nonexistent entry does not throw and leaves file untouched',
    async () => {
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
    },
  )

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
      assert.equal(recovered?.state, 'error')
      assert.ok(recovered?.lastStatusError?.includes('Process restarted'))
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  // ═══════════════════════════════════════════════════════════════════════
  // P0 — ROBUST PERSISTENCE (corruption, concurrency, rename ENOENT)
  // ═══════════════════════════════════════════════════════════════════════

  await testAsync('P0: salvageRecords extracts complete records from truncated JSON', async () => {
    const truncated =
      '[{"taskID":"a","state":"running"},{"taskID":"b","state":"running"},{"taskID":"c","sta'
    const salvaged = salvageRecords(truncated)
    assert.equal(salvaged.length, 2, 'only the two complete objects are salvageable')
    assert.deepEqual(
      salvaged.map((r) => r.taskID),
      ['a', 'b'],
    )
  })

  await testAsync(
    'P0: loadAllJobs survives NUL-corrupted state.json (backup + no throw)',
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'fp-nul-'))
      try {
        const statePath = join(tmpDir, 'state.json')
        writeFileSync(statePath, `\u0000\u0000\u0000${'x'.repeat(32)}\u0000`, 'utf-8')
        const adapter = new FilePersistenceAdapter(statePath)

        const loaded = await adapter.loadAllJobs()
        assert.deepEqual(loaded, [], 'corrupt file yields empty state, never throws')

        const backups = readdirSync(tmpDir).filter((f) => f.includes('.corrupt-'))
        assert.equal(backups.length, 1, 'corrupt file is backed up exactly once')
        assert.equal(existsSync(statePath), false, 'corrupt file is moved out of the way')
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'P0: loadAllJobs survives unterminated JSON string and salvages valid records',
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'fp-unterminated-'))
      try {
        const statePath = join(tmpDir, 'state.json')
        // First object is valid and complete; the second is truncated mid-string.
        writeFileSync(
          statePath,
          '[{"taskID":"a","state":"completed","alias":"apo-a"},{"taskID":"b","alias":"apo-b',
          'utf-8',
        )
        const adapter = new FilePersistenceAdapter(statePath)

        const loaded = await adapter.loadAllJobs()
        assert.equal(loaded.length, 1, 'complete leading record is recovered')
        assert.equal(loaded[0]?.taskID, 'a')
        assert.ok(
          readdirSync(tmpDir).some((f) => f.includes('.corrupt-')),
          'corrupt file is backed up',
        )
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    },
  )

  await testAsync('P0: deleteJob on corrupted state.json does not throw or loop', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'fp-del-corrupt-'))
    try {
      const statePath = join(tmpDir, 'state.json')
      writeFileSync(statePath, '\u0000[{"taskID":"a","alias":"apo-a', 'utf-8')
      const adapter = new FilePersistenceAdapter(statePath)

      // Several delete attempts must all resolve without throwing (no loop).
      await adapter.deleteJob('a')
      await adapter.deleteJob('a')
      await adapter.deleteJob('ghost')

      const backups = readdirSync(tmpDir).filter((f) => f.includes('.corrupt-'))
      assert.equal(backups.length, 1, 'corrupt file backed up only once')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  await testAsync(
    'P0: concurrent writes from two adapters serialize (no lost job, no rename ENOENT)',
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'fp-concurrent-'))
      try {
        const statePath = join(tmpDir, 'state.json')
        const a = new FilePersistenceAdapter(statePath)
        const b = new FilePersistenceAdapter(statePath)

        // Simulate plugin×native firing at the same tick.
        await Promise.all([
          a.saveJob(makeRecord('job-a', { alias: 'apo-1' })),
          b.saveJob(makeRecord('job-b', { alias: 'her-1' })),
          a.saveJob(makeRecord('job-c', { alias: 'apo-2' })),
        ])

        const raw = readFileSync(statePath, 'utf-8')
        const parsed = JSON.parse(raw) as BackgroundJobRecord[]
        assert.equal(parsed.length, 3, 'all concurrent writes survive')
        assert.deepEqual(parsed.map((r) => r.taskID).sort(), ['job-a', 'job-b', 'job-c'])
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'P0: writeState recovers from rename ENOENT by recreating dir and retrying',
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'fp-enoent-'))
      try {
        const statePath = join(tmpDir, 'nested', 'state.json')
        let renameAttempts = 0
        const ops = makeOps(async (from, to) => {
          renameAttempts++
          if (renameAttempts <= 2) {
            const err = new Error('rename lost the race') as NodeJS.ErrnoException
            err.code = 'ENOENT'
            throw err
          }
          await fsp.rename(from, to)
        })
        const adapter = new FilePersistenceAdapter(statePath, ops)

        await adapter.saveJob(makeRecord('retry-1', { alias: 'apo-1' }))
        await adapter.saveJob(makeRecord('retry-2', { alias: 'apo-2' }))

        assert.ok(renameAttempts >= 3, 'retried after ENOENT before succeeding')
        const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as BackgroundJobRecord[]
        assert.equal(parsed.length, 2, 'both records persisted after retry recovery')
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'P0: saveJob aborts on non-ENOENT read error (EIO) and preserves existing state',
    async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'fp-eio-'))
      try {
        const statePath = join(tmpDir, 'state.json')
        // Seed one real record with a healthy adapter.
        const healthy = new FilePersistenceAdapter(statePath)
        await healthy.saveJob(makeRecord('existing', { alias: 'apo-1' }))
        const before = readFileSync(statePath, 'utf-8')

        // A second adapter whose reads fail with EIO (not ENOENT).
        const eio = new Error('simulated I/O error') as NodeJS.ErrnoException
        eio.code = 'EIO'
        const ops = makeOps(undefined, async () => {
          throw eio
        })
        const faulty = new FilePersistenceAdapter(statePath, ops)

        // Must NOT throw and must NOT overwrite the on-disk state.
        await faulty.saveJob(makeRecord('new-record', { alias: 'her-1' }))

        const after = readFileSync(statePath, 'utf-8')
        assert.equal(after, before, 'failed read must not overwrite existing state')
        const parsed = JSON.parse(after) as BackgroundJobRecord[]
        assert.equal(parsed.length, 1, 'only the original record remains')
        assert.equal(parsed[0]?.taskID, 'existing')
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    },
  )

  // ═══════════════════════════════════════════════════════════════════════
  // SUMMARY (inside main)
  // ═══════════════════════════════════════════════════════════════════════
  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed)

  console.log('')
  for (const r of results) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? ': ' + r.error : ''}`)
  }
  console.log(`
Results: ${passed} passed, ${failed.length} failed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main()
