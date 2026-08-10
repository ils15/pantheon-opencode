/**
 * Tests for Delegation Compaction Context (Phase 4) — delegation-compaction.ts.
 *
 * buildCompactionContext(board, {sessionID, maxItems}) returns context blocks
 * for the `experimental.session.compacting` hook:
 *   - running delegations (alias, agent, started, truncated prompt)
 *   - unread terminal delegations (≤ max_compaction_items, newest first)
 *   - reconciled jobs excluded entirely
 *   - empty state → empty array
 *
 * Run with: npx tsx tests/pantheon/delegation-compaction.test.ts
 */
import { strict as assert } from 'node:assert'

import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import { buildCompactionContext } from '../../src/pantheon/delegation-compaction.ts'

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

const ROOT = 'ses_root'
const OTHER = 'ses_other'

/** Register a running job; returns the record with a deterministic timestamp. */
async function addRunning(
  board: BackgroundJobBoard,
  opts: { taskID: string; agent?: string; description: string; parent?: string; at: number },
) {
  const rec = await board.registerLaunch({
    taskID: opts.taskID,
    parentSessionID: opts.parent ?? ROOT,
    agent: opts.agent ?? 'apollo',
    description: opts.description,
  })
  rec.launchedAt = opts.at
  rec.updatedAt = opts.at
  return rec
}

/** Register + move to terminal (unreconciled unless reconciled=true). */
async function addTerminal(
  board: BackgroundJobBoard,
  opts: {
    taskID: string
    agent?: string
    description: string
    state?: 'completed' | 'error' | 'cancelled'
    parent?: string
    at: number
    reconciled?: boolean
  },
) {
  const rec = await board.registerLaunch({
    taskID: opts.taskID,
    parentSessionID: opts.parent ?? ROOT,
    agent: opts.agent ?? 'apollo',
    description: opts.description,
  })
  rec.launchedAt = opts.at
  await board.updateStatus({ taskID: opts.taskID, state: opts.state ?? 'completed' })
  const updated = board.get(opts.taskID)!
  updated.updatedAt = opts.at
  if (opts.reconciled === true) {
    await board.markReconciled(opts.taskID)
  }
  return rec
}

const LONG_PROMPT = `Probe the entire codebase for async patterns across every module. ${'x'.repeat(200)}`

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  await testAsync('empty state → empty context array', async () => {
    const board = new BackgroundJobBoard()
    assert.deepEqual(buildCompactionContext(board, { sessionID: ROOT }), [])
    assert.deepEqual(buildCompactionContext(board, { sessionID: ROOT, maxItems: 5 }), [])
  })

  await testAsync(
    'running delegations → block with alias, agent, started, truncated prompt',
    async () => {
      const board = new BackgroundJobBoard()
      const rec = await addRunning(board, {
        taskID: 'ses_r1',
        agent: 'apollo',
        description: LONG_PROMPT,
        at: 1_700_000_000_000,
      })

      const blocks = buildCompactionContext(board, { sessionID: ROOT })
      assert.equal(blocks.length, 1, 'only the running block is produced')

      const block = blocks[0]!
      assert.ok(block.startsWith('Background Delegations (running):'))
      assert.ok(block.includes('[apo-1]'), 'block must include the job alias')
      assert.ok(block.includes('apollo'), 'block must include the agent name')
      assert.ok(
        block.includes(new Date(rec.launchedAt).toISOString()),
        'block must include the started timestamp (ISO)',
      )
      // Prompt truncated: first ~100 chars present, tail absent
      assert.ok(
        block.includes(LONG_PROMPT.slice(0, 100)),
        'block must include the truncated prompt head',
      )
      assert.ok(!block.includes('y'.repeat(20)), 'block must NOT include the prompt tail')
      assert.ok(block.includes('…'), 'truncation must be marked')
    },
  )

  await testAsync('unread terminal delegations → block with newest first ordering', async () => {
    const board = new BackgroundJobBoard()
    await addTerminal(board, { taskID: 'ses_t1', description: 'old task', at: 1_000 })
    await addTerminal(board, { taskID: 'ses_t2', description: 'new task', at: 3_000 })
    await addTerminal(board, { taskID: 'ses_t3', description: 'middle task', at: 2_000 })

    const blocks = buildCompactionContext(board, { sessionID: ROOT })
    assert.equal(blocks.length, 1)
    const block = blocks[0]!
    assert.ok(block.startsWith('Background Delegations (finished, unread):'))
    assert.ok(block.includes('[unread]'), 'terminal-unreconciled jobs must carry [unread]')

    const newIdx = block.indexOf('[apo-2]')
    const midIdx = block.indexOf('[apo-3]')
    const oldIdx = block.indexOf('[apo-1]')
    assert.ok(newIdx >= 0 && midIdx >= 0 && oldIdx >= 0, 'all three jobs must appear')
    assert.ok(
      newIdx < midIdx && midIdx < oldIdx,
      'unread terminal jobs must be sorted newest-first',
    )
  })

  await testAsync('running + unread terminal → two blocks in stable order', async () => {
    const board = new BackgroundJobBoard()
    await addRunning(board, { taskID: 'ses_r1', description: 'in flight', at: 5_000 })
    await addTerminal(board, { taskID: 'ses_t1', description: 'done', at: 4_000 })

    const blocks = buildCompactionContext(board, { sessionID: ROOT })
    assert.equal(blocks.length, 2)
    assert.ok(blocks[0]!.startsWith('Background Delegations (running):'))
    assert.ok(blocks[1]!.startsWith('Background Delegations (finished, unread):'))
  })

  await testAsync('reconciled jobs are excluded from both blocks', async () => {
    const board = new BackgroundJobBoard()
    await addRunning(board, { taskID: 'ses_r1', description: 'in flight', at: 5_000 })
    await addTerminal(board, {
      taskID: 'ses_t1',
      description: 'read already',
      at: 4_000,
      reconciled: true,
    })

    const blocks = buildCompactionContext(board, { sessionID: ROOT })
    assert.equal(blocks.length, 1)
    const block = blocks[0]!
    assert.ok(block.includes('in flight'), 'running job must still appear')
    assert.ok(
      !block.includes('read already'),
      'reconciled job must not appear in the compaction context',
    )
  })

  await testAsync(
    'respects max_compaction_items cap on unread terminal (newest kept)',
    async () => {
      const board = new BackgroundJobBoard()
      for (let i = 1; i <= 5; i++) {
        await addTerminal(board, {
          taskID: `ses_t${i}`,
          description: `task ${i}`,
          at: i * 1_000,
        })
      }
      // Running jobs are NOT capped — they are active work.
      await addRunning(board, { taskID: 'ses_r1', description: 'in flight', at: 9_000 })

      const blocks = buildCompactionContext(board, { sessionID: ROOT, maxItems: 2 })
      assert.equal(blocks.length, 2, 'running + capped unread blocks both present')
      const terminalBlock = blocks[1]!
      assert.ok(terminalBlock.includes('[apo-5]'), 'newest unread must be kept')
      assert.ok(terminalBlock.includes('[apo-4]'), 'second-newest unread must be kept')
      assert.ok(!terminalBlock.includes('[apo-3]'), 'older unread must be capped away')
      assert.ok(!terminalBlock.includes('[apo-1]'), 'oldest unread must be capped away')
    },
  )

  await testAsync("scoped by sessionID: other sessions' jobs are excluded", async () => {
    const board = new BackgroundJobBoard()
    await addRunning(board, { taskID: 'ses_mine', description: 'my job', at: 1_000 })
    await addRunning(board, {
      taskID: 'ses_theirs',
      description: 'their job',
      parent: OTHER,
      at: 2_000,
    })

    const blocks = buildCompactionContext(board, { sessionID: ROOT })
    assert.equal(blocks.length, 1)
    assert.ok(blocks[0]!.includes('my job'))
    assert.ok(!blocks[0]!.includes('their job'), 'other session jobs must be excluded')
  })

  await testAsync('error/cancelled terminal jobs render with their status label', async () => {
    const board = new BackgroundJobBoard()
    await addTerminal(board, {
      taskID: 'ses_e1',
      agent: 'hermes',
      description: 'crashed task',
      state: 'error',
      at: 1_000,
    })
    await addTerminal(board, {
      taskID: 'ses_c1',
      agent: 'talos',
      description: 'cancelled task',
      state: 'cancelled',
      at: 2_000,
    })

    const blocks = buildCompactionContext(board, { sessionID: ROOT })
    const block = blocks[0]!
    assert.ok(block.includes('ERR'), 'error job must carry ERR label')
    assert.ok(block.includes('CAN'), 'cancelled job must carry CAN label')
  })

  // ═══════════════════════════════════════════════════════════════════════

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
