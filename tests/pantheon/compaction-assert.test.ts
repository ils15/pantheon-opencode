/**
 * Tests for Compaction Re-Assertion (release-134 Phase 4) — compaction-assert.ts.
 *
 * After a session is compacted, the system state may have changed since the
 * summary was built (new delegations launched, goals updated). The model would
 * operate on stale state. The re-assertion module builds a COMPACT fresh-state
 * block (running/unread delegations + active goals, ≤ REASSERT_MAX_LINES) and
 * enqueues it into the SHARED chat-reminder buffer (chat-reminders.ts), which
 * the pantheon-hooks `chat.message` hook delivers as a <system-reminder> into
 * the session's next message (P0 guard protects subagent fires — see (f)).
 *
 * Spec:
 *   (a) running/unread delegations → reminder enqueued with a summary
 *   (b) active goals → included in the reminder (same gating as Phase 2)
 *   (c) empty state → NO reminder (silent skip)
 *   (d) board/goals/enqueue failing → fail-open, never throws
 *   (e) TTL: expired reminders are not delivered (drainFreshChatReminders)
 *   (f) subagent (no messageID) → P0 guard keeps the reminder queued — zero
 *       crash (documented; the guard itself is covered by
 *       tests/pantheon-hooks-chat.test.mjs)
 *
 * Run with: npx tsx tests/pantheon/compaction-assert.test.ts
 */
import { strict as assert } from 'node:assert'

import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import {
  CHAT_REMINDER_TTL_MS,
  drainFreshChatReminders,
  enqueueChatReminder,
  pendingChatReminders,
} from '../../src/pantheon/chat-reminders.ts'
import {
  type CompactionAssertDeps,
  REASSERT_MAX_LINES,
  reassertAfterCompaction,
} from '../../src/pantheon/compaction-assert.ts'
import type { CompactionGoalSource } from '../../src/pantheon/delegation-compaction.ts'
import type { Goal } from '../../src/pantheon/goal-store.ts'

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

/** Clear the shared buffer between tests (module-level production state). */
function clearBuffer(): void {
  pendingChatReminders.length = 0
}

/** Register a running job for the root session with a deterministic clock. */
async function addRunning(
  board: BackgroundJobBoard,
  opts: { taskID: string; agent?: string; description: string; at: number },
) {
  const rec = await board.registerLaunch({
    taskID: opts.taskID,
    parentSessionID: ROOT,
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
    at: number
    reconciled?: boolean
  },
) {
  const rec = await board.registerLaunch({
    taskID: opts.taskID,
    parentSessionID: ROOT,
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

function goalSource(goals: Goal[], enabled = true): CompactionGoalSource {
  return { enabled, list: async () => goals }
}

const ACTIVE_GOAL: Goal = {
  id: 'g1',
  sessionID: ROOT,
  objective: 'ship compaction v2',
  status: 'in_progress',
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_001,
  continuationCount: 2,
}

const DONE_GOAL: Goal = { ...ACTIVE_GOAL, status: 'done' }

/** Baseline deps — tests override what they exercise. */
function depsFor(overrides: Partial<CompactionAssertDeps>): CompactionAssertDeps {
  const board = new BackgroundJobBoard()
  return { sessionID: ROOT, board, ...overrides }
}

/** The single queued reminder's text (assumes exactly one was enqueued). */
function queuedText(): string {
  assert.equal(pendingChatReminders.length, 1, 'exactly one reminder enqueued')
  const entry = pendingChatReminders[0]
  assert.ok(entry !== undefined, 'reminder entry exists')
  return entry.text
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  // (a) running + unread delegations → reminder enqueued with a summary.
  await testAsync('(a) running + unread delegations → reminder enqueued with summary', async () => {
    clearBuffer()
    const board = new BackgroundJobBoard()
    const running = await addRunning(board, {
      taskID: 't1',
      agent: 'apollo',
      description: 'search widgets',
      at: 100,
    })
    const done = await addTerminal(board, {
      taskID: 't2',
      agent: 'hermes',
      description: 'implement API',
      state: 'completed',
      at: 200,
    })
    // A reconciled terminal job is NOT fresh state — must be excluded.
    await addTerminal(board, {
      taskID: 't3',
      agent: 'talos',
      description: 'old fix',
      at: 150,
      reconciled: true,
    })

    const enqueued = await reassertAfterCompaction(depsFor({ board }))
    assert.equal(enqueued, true, 'reminder was enqueued')

    const text = queuedText()
    assert.match(text, /State re-assertion after compaction/, 'header present')
    assert.match(
      text,
      new RegExp(`running \\[${running.alias}\\] apollo — search widgets`),
      'running job line present',
    )
    assert.match(
      text,
      new RegExp(`unread \\[${done.alias}\\] hermes — implement API — OK`),
      'unread terminal line with state label',
    )
    assert.ok(!text.includes('t3'), 'reconciled job excluded from fresh state')
    assert.ok(!text.includes('[tal-1]'), 'reconciled job not mentioned')
    clearBuffer()
  })

  // (b) active goals → included (gated on enabled, non-done, like Phase 2).
  await testAsync('(b) active goals included; done/disabled goals omitted', async () => {
    clearBuffer()
    const board = new BackgroundJobBoard()
    await addRunning(board, {
      taskID: 't1',
      agent: 'apollo',
      description: 'search widgets',
      at: 100,
    })

    const enqueued = await reassertAfterCompaction(
      depsFor({ board, goals: goalSource([ACTIVE_GOAL, DONE_GOAL]) }),
    )
    assert.equal(enqueued, true, 'reminder was enqueued')
    const text = queuedText()
    assert.match(text, /goal \[g1\] ship compaction v2 — in_progress/, 'active goal line present')
    assert.ok(!text.includes('done'), 'done goal excluded')
    clearBuffer()

    // Disabled goal source (GOAL_LOOP_DEFAULTS.enabled === false) → omitted.
    const disabled = await reassertAfterCompaction(
      depsFor({ board, goals: goalSource([ACTIVE_GOAL], false) }),
    )
    assert.equal(disabled, true, 'delegations alone still enqueue')
    assert.ok(!queuedText().includes('goal '), 'disabled goals never included')
    clearBuffer()
  })

  // (c) empty state → NO reminder (silent skip).
  await testAsync('(c) empty state → no reminder (silent skip)', async () => {
    clearBuffer()
    const board = new BackgroundJobBoard()
    const enqueued = await reassertAfterCompaction(depsFor({ board }))
    assert.equal(enqueued, false, 'nothing to assert → skipped')
    assert.equal(pendingChatReminders.length, 0, 'no reminder enqueued')
    clearBuffer()

    // Only done goals → still nothing fresh.
    const onlyDone = await reassertAfterCompaction(
      depsFor({ board, goals: goalSource([DONE_GOAL]) }),
    )
    assert.equal(onlyDone, false, 'done-only goals → skip')
    assert.equal(pendingChatReminders.length, 0, 'no reminder enqueued')
    clearBuffer()
  })

  // (d) board/goals/enqueue failing → fail-open, never throws.
  await testAsync('(d) board failure → fail-open, no throw, warn, no reminder', async () => {
    clearBuffer()
    const warns: string[] = []
    const throwingBoard = {
      list: () => {
        throw new Error('board down')
      },
    }
    const enqueued = await reassertAfterCompaction(
      depsFor({ board: throwingBoard, logger: { warn: (m) => warns.push(m) } }),
    )
    assert.equal(enqueued, false, 'fail-open → skipped')
    assert.equal(pendingChatReminders.length, 0, 'no reminder enqueued')
    assert.ok(warns.length >= 1, 'failure warned (silence-by-default logger)')
    assert.ok(warns[0]!.includes('board down'), 'warn carries the reason')
    clearBuffer()
  })

  await testAsync('(d) goals failure → fail-open, no throw, warn, no reminder', async () => {
    clearBuffer()
    const warns: string[] = []
    const board = new BackgroundJobBoard()
    const failingGoals = {
      enabled: true,
      list: async () => {
        throw new Error('goals store down')
      },
    }
    const enqueued = await reassertAfterCompaction(
      depsFor({ board, goals: failingGoals, logger: { warn: (m) => warns.push(m) } }),
    )
    assert.equal(enqueued, false, 'fail-open → skipped')
    assert.equal(pendingChatReminders.length, 0, 'no reminder enqueued')
    assert.ok(
      warns.some((w) => w.includes('goals store down')),
      'warn carries the goals reason',
    )
    clearBuffer()
  })

  await testAsync('(d) enqueue failure → fail-open, no throw, warn', async () => {
    clearBuffer()
    const warns: string[] = []
    const board = new BackgroundJobBoard()
    await addRunning(board, {
      taskID: 't1',
      agent: 'apollo',
      description: 'search widgets',
      at: 100,
    })
    const failingEnqueue = () => {
      throw new Error('buffer full')
    }
    const enqueued = await reassertAfterCompaction(
      depsFor({ board, enqueue: failingEnqueue, logger: { warn: (m) => warns.push(m) } }),
    )
    assert.equal(enqueued, false, 'fail-open → skipped')
    assert.equal(pendingChatReminders.length, 0, 'no reminder enqueued (enqueue threw)')
    assert.ok(
      warns.some((w) => w.includes('buffer full')),
      'warn carries the enqueue reason',
    )
    clearBuffer()
  })

  // (e) TTL: expired reminders are not delivered (drainFreshChatReminders).
  await testAsync('(e) expired reminders dropped by delivery drain; fresh delivered', async () => {
    clearBuffer()
    const now = Date.now()
    pendingChatReminders.push({ text: 'stale reminder', at: now - CHAT_REMINDER_TTL_MS - 1 })
    pendingChatReminders.push({ text: 'fresh reminder', at: now })

    const body = drainFreshChatReminders()
    assert.equal(body, 'fresh reminder', 'expired entry dropped, fresh delivered')
    assert.equal(pendingChatReminders.length, 0, 'buffer drained after delivery')
    clearBuffer()

    // Only-expired → nothing delivered, buffer cleared (no leak).
    pendingChatReminders.push({ text: 'stale only', at: Date.now() - CHAT_REMINDER_TTL_MS - 1 })
    const empty = drainFreshChatReminders()
    assert.equal(empty, undefined, 'nothing fresh → nothing delivered')
    assert.equal(pendingChatReminders.length, 0, 'stale entries pruned, no leak')
    clearBuffer()
  })

  await testAsync('(e) enqueueChatReminder prunes expired entries before pushing', async () => {
    clearBuffer()
    pendingChatReminders.push({ text: 'stale', at: Date.now() - CHAT_REMINDER_TTL_MS - 1 })
    enqueueChatReminder('fresh')
    assert.equal(pendingChatReminders.length, 1, 'stale pruned, only the fresh entry remains')
    const entry = pendingChatReminders[0]!
    assert.equal(entry.text, 'fresh', 'fresh entry kept')
    clearBuffer()
  })

  // (f) subagent (no messageID) → P0 guard keeps the reminder queued — zero crash.
  await testAsync(
    '(f) subagent fire (no messageID) cannot lose the re-assertion reminder',
    async () => {
      clearBuffer()
      const board = new BackgroundJobBoard()
      const running = await addRunning(board, {
        taskID: 't1',
        agent: 'apollo',
        description: 'search widgets',
        at: 100,
      })

      const enqueued = await reassertAfterCompaction(depsFor({ board }))
      assert.equal(enqueued, true, 'reminder enqueued')

      // P0 guard (src/plugins/pantheon-hooks.ts chat.message): `if
      // (!input.messageID) return` fires BEFORE any drain — a child-session
      // promptAsync fire (messageID empty/undefined) injects nothing AND leaves
      // the buffer untouched, so the reminder survives for the parent's next
      // real (msg_-ID'd) message. The guard itself is integration-tested in
      // tests/pantheon-hooks-chat.test.mjs; this asserts the buffer contract
      // the re-assertion relies on: no drain on the subagent path.
      assert.equal(
        pendingChatReminders.length,
        1,
        'reminder still queued after (simulated) subagent fire',
      )

      // Next real message: drain delivers it.
      const body = drainFreshChatReminders()
      assert.ok(
        body !== undefined && body.includes(`running [${running.alias}]`),
        'delivered on the next real message',
      )
      clearBuffer()
    },
  )

  // Budget guard: the block stays compact (items ≤ REASSERT_MAX_LINES).
  await testAsync('block stays within REASSERT_MAX_LINES', async () => {
    clearBuffer()
    const board = new BackgroundJobBoard()
    for (let i = 0; i < 12; i++) {
      await addRunning(board, { taskID: `t${i}`, agent: 'apollo', description: `job ${i}`, at: i })
    }
    const enqueued = await reassertAfterCompaction(depsFor({ board }))
    assert.equal(enqueued, true, 'reminder enqueued')
    const lines = queuedText().split('\n')
    assert.equal(lines.length, 1 + REASSERT_MAX_LINES, 'header + capped item lines')
    clearBuffer()
  })

  // ─── Report ──────────────────────────────────────────────────────────
  let failed = 0
  for (const r of results) {
    if (r.passed) {
      console.log(`  ✅ ${r.name}`)
    } else {
      failed++
      console.error(`  ❌ ${r.name}\n     ${r.error}`)
    }
  }
  console.log(`\n${results.length - failed}/${results.length} passed`)
  if (failed > 0) process.exit(1)
}

void main()
