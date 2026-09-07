/**
 * WS1 Delegate relaunch — thin manager over native task().
 *
 * E2E + unit coverage for src/pantheon/delegate-manager.ts:
 *   - dispatch → monitor → reconcile → verify (complete ONLY after verified result)
 *   - crash recovery via board (recoverRunningJobs marks running as error)
 *   - kill-switch PANTHEON_DELEGATION=off
 *   - concurrency limit + foreground fallback + model failover
 *   - step budgets (max_steps beyond zeus) + summarize-and-stop cut
 *   - minimal records (id, agent, state, 1 line) + entry cap + aggressive
 *     prune of completed + auto-reconcile + signal delete on the spot
 *   - unified list with [native] / [pantheon] tags per line
 *
 * Run with: npx tsx tests/pantheon/delegate-manager.test.ts
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import {
  createDelegateManager,
  type DelegateManagerOptions,
  isDelegationEnabled,
  type NativeTaskFn,
} from '../../src/pantheon/delegate-manager.ts'
import { StepCapTracker } from '../../src/pantheon/step-cap.ts'

// ─── Harness ───────────────────────────────────────────────────────────

const results: { name: string; passed: boolean; error?: string }[] = []

async function testAsync(name: string, fn: () => Promise<void> | void) {
  try {
    await fn()
    results.push({ name, passed: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ name, passed: false, error: msg })
  }
}

/** In-memory persistence adapter for crash-recovery tests. */
function memoryPersistence() {
  const store = new Map<string, Record<string, unknown>>()
  return {
    store,
    async saveJob(record: Record<string, unknown>): Promise<void> {
      store.set(record.taskID as string, { ...record })
    },
    async loadAllJobs(): Promise<never[]> {
      return Array.from(store.values()) as never[]
    },
    async deleteJob(taskID: string): Promise<void> {
      store.delete(taskID)
    },
  }
}

const okTask: NativeTaskFn = async () => ({
  content: '# Report\n\nDone. All checks green.',
  tokensInput: 10,
  tokensOutput: 5,
})

function makeBoard(signalDir?: string): BackgroundJobBoard {
  return new BackgroundJobBoard({
    maxConcurrentPerAgent: 2,
    signalDir: signalDir ?? null,
  })
}

function makeManager(
  board: BackgroundJobBoard,
  taskFn: NativeTaskFn = okTask,
  extra?: Partial<DelegateManagerOptions>,
): ReturnType<typeof createDelegateManager> {
  return createDelegateManager({
    board,
    task: taskFn,
    parentSessionID: 'ses_root',
    env: {},
    ...extra,
  })
}

// ─── 1. E2E dispatch → monitor → reconcile → verify ─────────────────────

async function main(): Promise<void> {
  await testAsync('e2e: dispatch→monitor→reconcile→verify completes verified', async () => {
    const board = makeBoard()
    const mgr = makeManager(board)
    const receipt = await mgr.launch({ agent: 'apollo', prompt: 'scout the repo' })
    assert.equal(receipt.agent, 'apollo')
    assert.equal(receipt.state, 'reconciled', 'complete ONLY after verified result')
    assert.match(receipt.line, /\[pantheon:[a-z]+-\d+\]/, 'line carries [pantheon:alias] tag')
    assert.ok(receipt.line.length <= 160, 'record is a single short line')
    const job = board.get(receipt.id)
    assert.equal(job?.state, 'reconciled')
    assert.equal(job?.terminalUnreconciled, false)
  })

  await testAsync('e2e: read() returns verified report and reconciles', async () => {
    const board = makeBoard()
    let release!: (v: { content: string }) => void
    const gate = new Promise<{ content: string }>((res) => {
      release = res
    })
    const mgr = makeManager(board, () => gate)
    const launched = mgr.launch({ agent: 'hermes', prompt: 'build it' })
    // monitor while running
    const listing = await mgr.list()
    assert.ok(
      listing.some((l) => l.includes('[pantheon:') && l.includes('RUN')),
      'running job visible in list',
    )
    release({ content: 'final report body' })
    const receipt = await launched
    assert.equal(receipt.state, 'reconciled')
    const report = await mgr.read(receipt.id)
    assert.match(report, /final report body/)
  })

  // ─── 2. Complete ONLY after verified result ────────────────────────────

  await testAsync('empty task result → error, never completed', async () => {
    const board = makeBoard()
    const mgr = makeManager(board, async () => ({ content: '   ' }))
    const receipt = await mgr.launch({ agent: 'apollo', prompt: 'empty' })
    assert.equal(receipt.state, 'error')
    assert.match(receipt.line, /not verified|empty/i)
    const job = board.get(receipt.id)
    assert.notEqual(job?.state, 'completed')
  })

  await testAsync('task throw → error recorded with message', async () => {
    const board = makeBoard()
    const mgr = makeManager(board, async () => {
      throw new Error('provider boom')
    })
    const receipt = await mgr.launch({ agent: 'apollo', prompt: 'boom' })
    assert.equal(receipt.state, 'error')
    assert.match(receipt.line, /provider boom/)
  })

  // ─── 3. Crash recovery via board ───────────────────────────────────────

  await testAsync('crash recovery: running jobs marked error on restart', async () => {
    const persistence = memoryPersistence()
    const dir = mkdtempSync(join(tmpdir(), 'board-crash-'))
    const board = new BackgroundJobBoard({ signalDir: dir })
    board.setPersistence(persistence as never)
    const before = await board.registerLaunch({
      taskID: 'child-crash',
      parentSessionID: 'ses_root',
      agent: 'apollo',
      description: 'orphaned by crash',
    })
    assert.equal(before.state, 'running')
    // simulate process restart: fresh board, same persistence
    const board2 = new BackgroundJobBoard({ signalDir: dir })
    board2.setPersistence(persistence as never)
    await board2.recoverRunningJobs()
    const recovered = board2.get('child-crash')
    assert.equal(recovered?.state, 'error', 'recoverRunningJobs marks running as error')
    assert.match(recovered?.lastStatusError ?? '', /restart|crash/i)
    // manager surfaces the recovered error through read()
    const mgr = createDelegateManager({
      board: board2,
      task: okTask,
      parentSessionID: 'ses_root',
      env: {},
    })
    const report = await mgr.read('child-crash')
    assert.match(report, /error/i)
  })

  // ─── 4. Kill-switch ────────────────────────────────────────────────────

  await testAsync('kill-switch: PANTHEON_DELEGATION=off blocks launch/read/list', async () => {
    assert.equal(isDelegationEnabled({ PANTHEON_DELEGATION: 'off' }), false)
    assert.equal(isDelegationEnabled({ PANTHEON_DELEGATION: 'ON' }), true)
    assert.equal(isDelegationEnabled({}), true)
    const board = makeBoard()
    const mgr = makeManager(board, okTask, { env: { PANTHEON_DELEGATION: 'off' } })
    await assert.rejects(() => mgr.launch({ agent: 'apollo', prompt: 'x' }), /disabled/)
    await assert.rejects(() => mgr.read('anything'), /disabled/)
    await assert.rejects(() => mgr.list(), /disabled/)
  })

  // ─── 5. Concurrency + foreground fallback + model failover ─────────────

  await testAsync('concurrency full → foreground fallback runs inline', async () => {
    const board = makeBoard()
    // occupy both slots with stuck tasks
    let releaseAll!: () => void
    const gate = new Promise<void>((res) => {
      releaseAll = res
    })
    const stuck: NativeTaskFn = () => gate.then(() => ({ content: 'stuck done' }))
    const mgr = makeManager(board, stuck)
    const a = mgr.launch({ agent: 'apollo', prompt: 'a' })
    const b = mgr.launch({ agent: 'apollo', prompt: 'b' })
    // third dispatch exceeds maxConcurrentPerAgent=2 → foreground fallback
    let foregroundRan = false
    const mgrFg = createDelegateManager({
      board,
      task: async () => {
        foregroundRan = true
        return { content: 'foreground result' }
      },
      parentSessionID: 'ses_root',
      env: {},
      foregroundFallback: true,
    })
    const receipt = await mgrFg.launch({ agent: 'apollo', prompt: 'c' })
    assert.equal(receipt.state, 'reconciled')
    assert.ok(foregroundRan, 'foreground fallback executed inline')
    assert.match(receipt.line, /\[native\]/, 'foreground line tagged [native]')
    assert.equal(board.get(receipt.id), undefined, 'foreground run leaves no board record')
    releaseAll()
    await a
    await b
  })

  await testAsync('concurrency full without fallback → clean rejection', async () => {
    const board = makeBoard()
    let releaseAll!: () => void
    const gate = new Promise<void>((res) => {
      releaseAll = res
    })
    const stuck: NativeTaskFn = () => gate.then(() => ({ content: 'x' }))
    const mgr = makeManager(board, stuck, { foregroundFallback: false })
    const a = mgr.launch({ agent: 'apollo', prompt: 'a' })
    const b = mgr.launch({ agent: 'apollo', prompt: 'b' })
    await assert.rejects(() => mgr.launch({ agent: 'apollo', prompt: 'c' }), /concurrency/i)
    releaseAll()
    await a
    await b
  })

  await testAsync('model failover: tries fallbacks in order', async () => {
    const board = makeBoard()
    const seen: (string | undefined)[] = []
    const flaky: NativeTaskFn = async (input) => {
      seen.push(input.model)
      if (input.model !== 'model-c') throw new Error('model unavailable: quota')
      return { content: 'ok on c' }
    }
    const mgr = makeManager(board, flaky, {
      models: ['model-a', 'model-b', 'model-c'],
    })
    const receipt = await mgr.launch({ agent: 'hermes', prompt: 'failover' })
    assert.equal(receipt.state, 'reconciled')
    assert.deepEqual(seen, ['model-a', 'model-b', 'model-c'])
  })

  // ─── 6. Step budgets + summarize-and-stop ──────────────────────────────

  await testAsync('step cap: capped agent skips dispatch, no board job', async () => {
    const board = makeBoard()
    let calls = 0
    const mgr = makeManager(
      board,
      async () => {
        calls++
        return { content: 'x' }
      },
      {
        stepCap: new StepCapTracker({ apollo: 1 }),
      },
    )
    const first = await mgr.launch({ agent: 'apollo', prompt: 'one' })
    assert.equal(first.state, 'reconciled')
    const second = await mgr.launch({ agent: 'apollo', prompt: 'two' })
    assert.match(second.line, /STEP CAP REACHED/i, 'capped delegation returns stop summary')
    assert.equal(calls, 1, 'no task executed for capped agent')
    assert.equal(board.list().length, 1, 'no board job for capped delegation')
  })

  await testAsync('step cap: cap hit mid-dispatch appends stop instruction', async () => {
    const board = makeBoard()
    let seenPrompt = ''
    const mgr = makeManager(
      board,
      async (input) => {
        seenPrompt = input.prompt
        return { content: 'summarized' }
      },
      {
        stepCap: new StepCapTracker({ hermes: 1 }),
      },
    )
    await mgr.launch({ agent: 'hermes', prompt: 'work' })
    assert.match(
      seenPrompt,
      /stop.*summarize|summarize-and-stop/i,
      'stop instruction appended at cap',
    )
  })

  // ─── 7. Caps, prune, auto-reconcile, signal delete ─────────────────────

  await testAsync('auto-reconcile deletes the signal file on the spot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'board-signal-'))
    const board = makeBoard(dir)
    const mgr = makeManager(board)
    const receipt = await mgr.launch({ agent: 'nyx', prompt: 'watch' })
    const job = board.get(receipt.id)
    assert.equal(job?.state, 'reconciled')
    assert.equal(existsSync(join(dir, `${job?.alias}.signal.json`)), false)
  })

  await testAsync('entry cap + aggressive prune keep completed bounded', async () => {
    const board = makeBoard()
    const mgr = makeManager(board, okTask, { maxEntries: 5, keepCompleted: 2 })
    for (let i = 0; i < 7; i++) {
      await mgr.launch({ agent: 'talos', prompt: `job ${i}` })
    }
    assert.ok(board.list().length <= 5, `board bounded (got ${board.list().length})`)
    const done = board.list().filter((j) => j.state === 'completed' || j.state === 'reconciled')
    assert.ok(done.length <= 5, 'completed aggressively pruned')
  })

  await testAsync('minimal records: receipt has id, agent, state, one line', async () => {
    const board = makeBoard()
    const mgr = makeManager(board)
    const receipt = await mgr.launch({ agent: 'demeter', prompt: 'migrate' })
    assert.deepEqual(Object.keys(receipt).sort(), ['agent', 'id', 'line', 'state'])
    assert.ok(!receipt.line.includes('\n'), 'single line')
  })

  await testAsync('unified list tags every line [native] or [pantheon]', async () => {
    const board = makeBoard()
    const mgr = makeManager(board)
    await mgr.launch({ agent: 'apollo', prompt: 'a' })
    const lines = await mgr.list()
    assert.ok(lines.length >= 1)
    for (const line of lines) {
      assert.ok(line.includes('[native]') || line.includes('[pantheon:'), `tagged: ${line}`)
    }
  })

  await testAsync('read on missing job rejects with clear error', async () => {
    const board = makeBoard()
    const mgr = makeManager(board)
    await assert.rejects(() => mgr.read('nope'), /not found/i)
  })

  // ─── Report ────────────────────────────────────────────────────────────

  const failed = results.filter((r) => !r.passed)
  for (const r of results) {
    if (r.passed) console.log(`ok - ${r.name}`)
    else console.log(`FAIL - ${r.name}\n  ${r.error}`)
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exit(1)
}

main()
