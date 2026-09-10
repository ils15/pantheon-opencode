/**
 * Board gap + non-duplication tests for native task() → BackgroundJobBoard.
 *
 * 1. native task_id launched via task(background=true) appears on the board
 * 2. double session.created for same child does NOT create a duplicate record
 *
 * Run with: npx tsx tests/pantheon/native-task-board-gap.test.ts
 */
import { strict as assert } from 'node:assert'

import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import { createV2EventDispatcher } from '../../src/pantheon/v2-events.ts'

// ─── Harness (repo pattern) ────────────────────────────────────────────

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

// ─── Tests ─────────────────────────────────────────────────────────────

async function main() {
  await testAsync(
    'native task_id launched via task(background=true) appears on the board',
    async () => {
      const board = new BackgroundJobBoard()
      const dispatcher = createV2EventDispatcher({
        board,
        finalize: async () => undefined,
        goalLoop: { hasActiveGoal: async () => false, onIdle: async () => {} },
        todoEnforcer: { onIdle: async () => {} },
      })

      // O que o host emite quando um `task(background=true)` inline dispara:
      // uma child session com parentID (== parent session do dispatch).
      await dispatcher.handleEvent({
        type: 'session.created',
        properties: { info: { id: 'ses_native_task_1', parentID: 'ses_parent_1' } },
      })

      const job = board.get('ses_native_task_1')
      assert.ok(
        job !== undefined,
        'GAP: native task_id ses_native_task_1 not observed by BackgroundJobBoard ' +
          '(board.get returned undefined after session.created with parentID)',
      )
    },
  )

  // ─── Non-duplication proof ────────────────────────────────────────
  await testAsync(
    'double session.created for same child does NOT create a duplicate board record',
    async () => {
      const board = new BackgroundJobBoard()
      const dispatcher = createV2EventDispatcher({
        board,
        finalize: async () => undefined,
        goalLoop: { hasActiveGoal: async () => false, onIdle: async () => {} },
        todoEnforcer: { onIdle: async () => {} },
      })

      const event = {
        type: 'session.created' as const,
        properties: { info: { id: 'ses_dedup_child', parentID: 'ses_parent_dedup' } },
      }

      // Fire the same event twice (simulates re-dispatch or V1 idle hook race).
      await dispatcher.handleEvent(event)
      await dispatcher.handleEvent(event)

      const job = board.get('ses_dedup_child')
      assert.ok(job !== undefined, 'child should exist on the board after first event')

      // Board must have exactly 1 record for this parent — no duplicate.
      const allJobs = board.list('ses_parent_dedup')
      assert.strictEqual(
        allJobs.length,
        1,
        `EXACTLY 1 record expected, got ${allJobs.length} — put-if-absent broken`,
      )
    },
  )

  await testAsync('concurrent session.created claims exactly one board record', async () => {
    const board = new BackgroundJobBoard()
    const dispatcher = createV2EventDispatcher({
      board,
      finalize: async () => undefined,
      goalLoop: { hasActiveGoal: async () => false, onIdle: async () => {} },
      todoEnforcer: { onIdle: async () => {} },
    })
    const event = {
      type: 'session.created' as const,
      properties: { info: { id: 'ses_race_child', parentID: 'ses_race_parent' } },
    }
    await Promise.all([dispatcher.handleEvent(event), dispatcher.handleEvent(event)])
    assert.equal(board.list('ses_race_parent').length, 1)
  })

  const failed = results.filter((r) => !r.passed)
  for (const r of results) {
    if (r.passed) console.log(`PASS - ${r.name}`)
    else console.log(`FAIL - ${r.name}\n  ${r.error}`)
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exit(1)
}

void main()
