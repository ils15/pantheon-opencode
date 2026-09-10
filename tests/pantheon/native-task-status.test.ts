/**
 * Tests for Native Task Status — classifies BackgroundJobRecord results
 * from native task() delegation into actionable NativeTaskStatus codes.
 *
 * Covers all 9 statuses in the union type:
 *   OK, UNSUPPORTED, UNAVAILABLE, INVALID_INPUT, INVALID_STATE,
 *   CONFLICT, CORRUPT_DATA, TIMEOUT, ESCALATE
 *
 * TDD: these tests MUST fail before implementation.
 *
 * Run with: npx tsx tests/pantheon/native-task-status.test.ts
 */
import { strict as assert } from 'node:assert'
import type { BackgroundJobRecord } from '../../src/pantheon/background-job-board.ts'
import {
  classifyNativeResult,
  type NativeTaskStatus,
} from '../../src/pantheon/native-task-status.ts'

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

// ─── Helpers ───────────────────────────────────────────────────────────

function makeRecord(overrides: Partial<BackgroundJobRecord> = {}): BackgroundJobRecord {
  return {
    taskID: 'task_1',
    parentSessionID: 'ses_parent',
    agent: 'hermes',
    description: 'test job',
    state: 'completed',
    timedOut: false,
    alias: 'her-1',
    launchedAt: Date.now(),
    updatedAt: Date.now(),
    totalErrors: 0,
    timeoutCount: 0,
    terminalUnreconciled: false,
    contextFiles: [],
    ...overrides,
  }
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  // ── OK: completed + verified content ────────────────────────────────

  await testAsync('classifyNativeResult: completed + non-empty resultSummary → OK', async () => {
    const job = makeRecord({
      state: 'completed',
      resultSummary: '## subtask_summary\nfiles_changed: [src/foo.ts]',
    })
    const status = classifyNativeResult(job)
    assert.equal(status, 'OK')
  })

  // ── UNAVAILABLE: empty output / provider rejection ──────────────────

  await testAsync('classifyNativeResult: error + empty output → UNAVAILABLE', async () => {
    const job = makeRecord({
      state: 'error',
      resultSummary: '',
      lastStatusError: 'BackendAdmissionRejected',
    })
    const status = classifyNativeResult(job)
    assert.equal(status, 'UNAVAILABLE')
  })

  await testAsync(
    'classifyNativeResult: completed + empty output → UNAVAILABLE (silent failure)',
    async () => {
      const job = makeRecord({
        state: 'completed',
        resultSummary: '',
      })
      const status = classifyNativeResult(job)
      assert.equal(status, 'UNAVAILABLE')
    },
  )

  await testAsync(
    'classifyNativeResult: error + provider error message → UNAVAILABLE',
    async () => {
      const job = makeRecord({
        state: 'error',
        resultSummary: undefined,
        lastStatusError: 'rate_limit_exceeded',
      })
      const status = classifyNativeResult(job)
      assert.equal(status, 'UNAVAILABLE')
    },
  )

  await testAsync(
    'classifyNativeResult: missing native API in lastStatusError → UNSUPPORTED',
    async () => {
      const status = classifyNativeResult(
        makeRecord({ state: 'error', lastStatusError: 'native task API not supported by host' }),
      )
      assert.equal(status, 'UNSUPPORTED')
    },
  )

  await testAsync('classifyNativeResult: provider failure remains UNAVAILABLE', async () => {
    const status = classifyNativeResult(
      makeRecord({ state: 'error', lastStatusError: 'provider request failed: rate limit' }),
    )
    assert.equal(status, 'UNAVAILABLE')
  })

  // ── TIMEOUT: startup_failed ─────────────────────────────────────────

  await testAsync('classifyNativeResult: startup_failed → TIMEOUT', async () => {
    const job = makeRecord({
      state: 'startup_failed',
      timedOut: true,
    })
    const status = classifyNativeResult(job)
    assert.equal(status, 'TIMEOUT')
  })

  await testAsync('classifyNativeResult: startup_unknown + timedOut → TIMEOUT', async () => {
    const job = makeRecord({
      state: 'startup_unknown',
      timedOut: true,
    })
    const status = classifyNativeResult(job)
    assert.equal(status, 'TIMEOUT')
  })

  // ── CONFLICT: board can't dispatch / concurrency exceeded ───────────

  await testAsync(
    'classifyNativeResult: with verifyError containing "canDispatch" → CONFLICT',
    async () => {
      const job = makeRecord({
        state: 'error',
        lastStatusError: 'concurrency limit reached',
      })
      const status = classifyNativeResult(job, 'canDispatch=false: concurrency exceeded')
      assert.equal(status, 'CONFLICT')
    },
  )

  // ── INVALID_INPUT: agent not recognized ─────────────────────────────

  await testAsync(
    'classifyNativeResult: with verifyError containing "invalid agent" → INVALID_INPUT',
    async () => {
      const job = makeRecord({
        agent: 'nonexistent-agent',
        state: 'error',
      })
      const status = classifyNativeResult(job, 'invalid agent: nonexistent-agent')
      assert.equal(status, 'INVALID_INPUT')
    },
  )

  // ── INVALID_STATE: child already terminal ───────────────────────────

  await testAsync(
    'classifyNativeResult: with verifyError "already terminal" → INVALID_STATE',
    async () => {
      const job = makeRecord({
        state: 'completed',
        resultSummary: 'done',
      })
      const status = classifyNativeResult(job, 'child already in terminal state')
      assert.equal(status, 'INVALID_STATE')
    },
  )

  // ── CORRUPT_DATA: output can't be parsed ────────────────────────────

  await testAsync('classifyNativeResult: with verifyError "corrupt" → CORRUPT_DATA', async () => {
    const job = makeRecord({
      state: 'completed',
      resultSummary: '\x00\x01\x02invalid json',
    })
    const status = classifyNativeResult(job, 'output corrupt: parse failed')
    assert.equal(status, 'CORRUPT_DATA')
  })

  // ── ESCALATE: unrecoverable failure ─────────────────────────────────

  await testAsync('classifyNativeResult: with verifyError "unrecoverable" → ESCALATE', async () => {
    const job = makeRecord({
      state: 'error',
      totalErrors: 5,
      lastStatusError: 'fatal: unrecoverable error after retries',
    })
    const status = classifyNativeResult(job, 'unrecoverable: max retries exceeded')
    assert.equal(status, 'ESCALATE')
  })

  // ── Edge case: no verifyError, no lastStatusError, error state ──────

  await testAsync(
    'classifyNativeResult: error + no error info → UNAVAILABLE (safe default)',
    async () => {
      const job = makeRecord({
        state: 'error',
        lastStatusError: undefined,
      })
      const status = classifyNativeResult(job)
      assert.equal(status, 'UNAVAILABLE')
    },
  )

  // ── Type check: return type is NativeTaskStatus ─────────────────────

  await testAsync(
    'classifyNativeResult: return value is assignable to NativeTaskStatus',
    async () => {
      const job = makeRecord({ state: 'completed', resultSummary: 'ok' })
      const status: NativeTaskStatus = classifyNativeResult(job)
      const allStatuses: NativeTaskStatus[] = [
        'OK',
        'UNSUPPORTED',
        'UNAVAILABLE',
        'INVALID_INPUT',
        'INVALID_STATE',
        'CONFLICT',
        'CORRUPT_DATA',
        'TIMEOUT',
        'ESCALATE',
      ]
      assert.ok(
        allStatuses.includes(status),
        `status "${status}" must be one of the 9 NativeTaskStatus values`,
      )
    },
  )

  // ── REPORT ──────────────────────────────────────────────────────────

  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed)

  console.log('')
  for (const r of results) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? `: ${r.error}` : ''}`)
  }
  console.log(`\nResults: ${passed} passed, ${failed.length} failed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main()
