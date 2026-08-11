/**
 * Tests for Compaction Context (Phase 4 + release-134 Phase 2) —
 * delegation-compaction.ts.
 *
 * buildCompactionContext(board, {sessionID, maxItems, goals, todos}) returns
 * context blocks for the `experimental.session.compacting` hook:
 *   - `<pantheon-context directive>` — preservation directive (prefix)
 *   - `<mission_context>` — active goals (omitted when absent/disabled/empty)
 *   - `<todo_context>` — pending todos (omitted when absent/disabled/empty)
 *   - running delegations (alias, agent, started, truncated prompt)
 *   - unread terminal delegations (≤ max_compaction_items, newest first)
 *   - reconciled jobs excluded entirely
 *   - totally empty state → empty array (no orphan directive)
 *
 * Run with: npx tsx tests/pantheon/delegation-compaction.test.ts
 */
import { strict as assert } from 'node:assert'

import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import {
  PANTHEON_COMPACTION_DIRECTIVE,
  buildCompactionContext,
  type CompactionGoalSource,
  type CompactionTodoSource,
} from '../../src/pantheon/delegation-compaction.ts'
import type { Goal } from '../../src/pantheon/goal-store.ts'
import type { TodoLike } from '../../src/pantheon/todo-enforcer.ts'

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

// ─── Release-134 Phase 2 fixtures ──────────────────────────────────────

function goalSource(goals: Goal[], enabled = true): CompactionGoalSource {
  return { enabled, list: async () => goals }
}

function todoSource(todos: TodoLike[], enabled = true): CompactionTodoSource {
  return { enabled, list: async () => todos }
}

const ACTIVE_GOAL: Goal = {
  id: ROOT,
  sessionID: ROOT,
  objective: 'ship compaction v2',
  status: 'in_progress',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_001,
  continuationCount: 2,
}

const DONE_GOAL: Goal = { ...ACTIVE_GOAL, status: 'done' }

const PENDING_TODO: TodoLike = {
  id: 'todo_1',
  content: 'wire the directive',
  status: 'in_progress',
  priority: 'high',
}

const COMPLETED_TODO: TodoLike = { id: 'todo_2', content: 'finished work', status: 'completed' }

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  await testAsync('empty state → empty context array', async () => {
    const board = new BackgroundJobBoard()
    assert.deepEqual(await buildCompactionContext(board, { sessionID: ROOT }), [])
    assert.deepEqual(await buildCompactionContext(board, { sessionID: ROOT, maxItems: 5 }), [])
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

      const blocks = await buildCompactionContext(board, { sessionID: ROOT })
      assert.equal(blocks.length, 2, 'directive + running block')

      const block = blocks[1]!
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

    const blocks = await buildCompactionContext(board, { sessionID: ROOT })
    assert.equal(blocks.length, 2, 'directive + unread terminal block')
    const block = blocks[1]!
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

    const blocks = await buildCompactionContext(board, { sessionID: ROOT })
    assert.equal(blocks.length, 3, 'directive + running + unread blocks')
    assert.ok(blocks[1]!.startsWith('Background Delegations (running):'))
    assert.ok(blocks[2]!.startsWith('Background Delegations (finished, unread):'))
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

    const blocks = await buildCompactionContext(board, { sessionID: ROOT })
    assert.equal(blocks.length, 2, 'directive + running block only')
    const block = blocks[1]!
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

      const blocks = await buildCompactionContext(board, { sessionID: ROOT, maxItems: 2 })
      assert.equal(blocks.length, 3, 'directive + running + capped unread blocks')
      const terminalBlock = blocks[2]!
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

    const blocks = await buildCompactionContext(board, { sessionID: ROOT })
    assert.equal(blocks.length, 2)
    assert.ok(blocks[1]!.includes('my job'))
    assert.ok(!blocks[1]!.includes('their job'), 'other session jobs must be excluded')
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

    const blocks = await buildCompactionContext(board, { sessionID: ROOT })
    const block = blocks[1]!
    assert.ok(block.includes('ERR'), 'error job must carry ERR label')
    assert.ok(block.includes('CAN'), 'cancelled job must carry CAN label')
  })

  // ═══ release-134 Phase 2: directive + mission/todo sections ═══════════

  await testAsync('preservation directive precedes the delegation blocks', async () => {
    const board = new BackgroundJobBoard()
    await addRunning(board, { taskID: 'ses_r1', description: 'in flight', at: 1_000 })

    const blocks = await buildCompactionContext(board, { sessionID: ROOT })
    assert.equal(blocks.length, 2, 'directive + delegation block')
    assert.ok(
      blocks[0]!.startsWith('<pantheon-context directive>'),
      'directive must be the first section',
    )
    assert.ok(blocks[0]!.includes(PANTHEON_COMPACTION_DIRECTIVE), 'directive text must be present')
    assert.ok(blocks[1]!.startsWith('Background Delegations (running):'), 'delegation unchanged')
  })

  await testAsync('mission_context emitted when the goal source has active goals', async () => {
    const board = new BackgroundJobBoard()
    const blocks = await buildCompactionContext(board, {
      sessionID: ROOT,
      goals: goalSource([ACTIVE_GOAL]),
    })

    assert.equal(blocks.length, 2, 'directive + mission block')
    assert.ok(blocks[0]!.startsWith('<pantheon-context directive>'))
    const block = blocks[1]!
    assert.ok(block.startsWith('<mission_context>'), 'mission section must be tagged')
    assert.ok(block.includes(ACTIVE_GOAL.id), 'mission must include the goal id')
    assert.ok(block.includes(ACTIVE_GOAL.objective), 'mission must include the goal objective')
    assert.ok(block.includes(ACTIVE_GOAL.status), 'mission must include the goal status')
  })

  await testAsync(
    'mission_context omitted when the goal source is empty, disabled, or all-done',
    async () => {
      const board = new BackgroundJobBoard()
      assert.deepEqual(
        await buildCompactionContext(board, { sessionID: ROOT, goals: goalSource([]) }),
        [],
        'no goals → no mission section',
      )
      assert.deepEqual(
        await buildCompactionContext(
          board,
          { sessionID: ROOT, goals: goalSource([ACTIVE_GOAL], false) },
        ),
        [],
        'goal loop disabled → no mission section',
      )
      assert.deepEqual(
        await buildCompactionContext(board, { sessionID: ROOT, goals: goalSource([DONE_GOAL]) }),
        [],
        'only done goals → no mission section',
      )
    },
  )

  await testAsync('todo_context emitted when the todo source has pending todos', async () => {
    const board = new BackgroundJobBoard()
    const blocks = await buildCompactionContext(board, {
      sessionID: ROOT,
      todos: todoSource([PENDING_TODO, COMPLETED_TODO]),
    })

    assert.equal(blocks.length, 2, 'directive + todo block')
    assert.ok(blocks[0]!.startsWith('<pantheon-context directive>'))
    const block = blocks[1]!
    assert.ok(block.startsWith('<todo_context>'), 'todo section must be tagged')
    assert.ok(block.includes(PENDING_TODO.content ?? ''), 'todo must include the description')
    assert.ok(block.includes(PENDING_TODO.status), 'todo must include the status')
    assert.ok(!block.includes('finished work'), 'completed todos must be filtered out')
  })

  await testAsync('todo_context omitted when the todo source is empty or disabled', async () => {
    const board = new BackgroundJobBoard()
    assert.deepEqual(
      await buildCompactionContext(board, { sessionID: ROOT, todos: todoSource([]) }),
      [],
      'no todos → no todo section',
    )
    assert.deepEqual(
      await buildCompactionContext(board, { sessionID: ROOT, todos: todoSource([PENDING_TODO], false) }),
      [],
      'todo enforcer disabled → no todo section',
    )
    assert.deepEqual(
      await buildCompactionContext(board, { sessionID: ROOT, todos: todoSource([COMPLETED_TODO]) }),
      [],
      'only completed todos → no todo section',
    )
  })

  await testAsync('full stack: directive → mission → todo → delegation', async () => {
    const board = new BackgroundJobBoard()
    await addRunning(board, { taskID: 'ses_r1', description: 'in flight', at: 1_000 })

    const blocks = await buildCompactionContext(board, {
      sessionID: ROOT,
      goals: goalSource([ACTIVE_GOAL]),
      todos: todoSource([PENDING_TODO]),
    })
    assert.equal(blocks.length, 4, 'directive + mission + todo + delegation')
    assert.ok(blocks[0]!.startsWith('<pantheon-context directive>'))
    assert.ok(blocks[1]!.startsWith('<mission_context>'))
    assert.ok(blocks[2]!.startsWith('<todo_context>'))
    assert.ok(blocks[3]!.startsWith('Background Delegations (running):'))
  })

  await testAsync(
    'totally empty (no goals/todos/delegations) → empty array, no orphan directive',
    async () => {
      const board = new BackgroundJobBoard()
      const blocks = await buildCompactionContext(board, {
        sessionID: ROOT,
        goals: goalSource([]),
        todos: todoSource([]),
      })
      assert.deepEqual(blocks, [], 'empty state must not push a lone directive')
    },
  )

  await testAsync('failing goal/todo sources are skipped without breaking the rest', async () => {
    const board = new BackgroundJobBoard()
    await addRunning(board, { taskID: 'ses_r1', description: 'in flight', at: 1_000 })

    const blocks = await buildCompactionContext(board, {
      sessionID: ROOT,
      goals: {
        enabled: true,
        list: async () => {
          throw new Error('store down')
        },
      },
      todos: {
        enabled: true,
        list: async () => {
          throw new Error('sdk down')
        },
      },
    })
    assert.equal(blocks.length, 2, 'directive + delegation survive source failures')
    assert.ok(blocks[1]!.includes('in flight'), 'delegation block must still be produced')
  })

  await testAsync('without sessionID: mission/todo omitted, delegation kept', async () => {
    const board = new BackgroundJobBoard()
    await addRunning(board, { taskID: 'ses_r1', description: 'in flight', at: 1_000 })

    const blocks = await buildCompactionContext(board, {
      goals: goalSource([ACTIVE_GOAL]),
      todos: todoSource([PENDING_TODO]),
    })
    assert.equal(blocks.length, 2, 'directive + delegation only')
    assert.ok(!blocks[1]!.includes('ship compaction'), 'goal/todo sections need a sessionID')
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
