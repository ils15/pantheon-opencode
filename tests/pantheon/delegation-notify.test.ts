/**
 * Tests for the Delegation Notify module (Phase 3) — completion notifications
 * for background jobs delivered via the queue + flush channel (the spike
 * refuted client push), plus the event→finalize wiring
 * (session.idle / session.error → finalizeDelegation).
 *
 * Uses a fake client + real in-memory BackgroundJobBoard — no opencode runtime.
 *
 * Run with: npx tsx tests/pantheon/delegation-notify.test.ts
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import { createDelegationTools, type FinalizeInput } from '../../src/pantheon/delegation.ts'
import {
  buildTaskNotification,
  type DelegationEventLike,
  DelegationNotifier,
  handleDelegationEvent,
} from '../../src/pantheon/delegation-notify.ts'

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

// ─── Fake client ───────────────────────────────────────────────────────

class FakeClient {
  messagesCalls: string[] = []
  messagesResult: Array<{
    info: { role: string }
    parts: Array<{ type: string; text: string }>
  }> = [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'fake assistant output' }] }]
  private childCounter = 0

  readonly session = {
    create: async (): Promise<{ id: string }> => {
      this.childCounter += 1
      return { id: `ses_child_${this.childCounter}` }
    },
    promptAsync: async (): Promise<unknown> => ({}),
    messages: async (input: { path: { id: string } }): Promise<unknown> => {
      this.messagesCalls.push(input.path.id)
      return this.messagesResult
    },
  }
}

const ROOT = 'ses_root'

function makeCtx(sessionID = ROOT) {
  return { sessionID, directory: '/tmp', worktree: '/tmp', agent: 'zeus' }
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  await testAsync(
    'notifyParent success: builds <task-notification> text, queues, flush marks sent',
    async () => {
      const board = new BackgroundJobBoard()
      const notifier = new DelegationNotifier()
      const job = await board.registerLaunch({
        taskID: 'ses_job_1',
        parentSessionID: ROOT,
        agent: 'apollo',
        description: 'Search codebase',
      })
      await board.updateStatus({
        taskID: 'ses_job_1',
        state: 'completed',
        resultSummary: 'Found 3 matches',
      })

      // Queue the completion notification for the parent session.
      assert.equal(notifier.notifyParent(job), true, 'notifyParent accepts the job')
      assert.equal(notifier.pendingCount(ROOT), 1)
      assert.ok(notifier.hasPending(ROOT), 'notification awaits delivery for the parent')

      // The channel: the next chat.message for the parent flushes the queue,
      // prepending the <task-notification> block onto the first text part.
      const output = { parts: [{ type: 'text', text: 'please continue' }] }
      assert.equal(notifier.flushQueue(ROOT, output), 1, 'flushQueue delivers the notification')
      assert.equal(notifier.pendingCount(ROOT), 0, 'delivered notifications leave the queue')
      assert.equal(notifier.sentCount(ROOT), 1, 'delivered notifications are marked sent')

      const text = String((output.parts[0] as { text?: string }).text)
      assert.ok(text.startsWith('<task-notification>'), 'block starts with <task-notification>')
      assert.ok(text.includes('<task id="ses_job_1"'), 'block carries the task id')
      assert.ok(text.includes('apo-1'), 'block carries the alias')
      assert.ok(text.includes('completed'), 'block carries the terminal state')
      assert.ok(text.includes('Found 3 matches'), 'block carries the result summary')
      assert.ok(
        text.includes('Result: Found 3 matches'),
        'block marks the child output origin with a Result: prefix',
      )
      assert.ok(text.endsWith('please continue'), 'original user text is preserved after the block')
    },
  )

  await testAsync(
    'queue-on-failure: no deliverable parent message → stays queued; wrong-session flush is a no-op',
    async () => {
      const board = new BackgroundJobBoard()
      const notifier = new DelegationNotifier()
      const job = await board.registerLaunch({
        taskID: 'ses_job_2',
        parentSessionID: ROOT,
        agent: 'hermes',
        description: 'Build the service',
      })
      notifier.notifyParent(job)

      // A flush for a DIFFERENT parent must not touch this queue.
      assert.equal(notifier.flushQueue('ses_other_parent', { parts: [] }), 0)
      assert.ok(notifier.hasPending(ROOT), 'notification stays queued while the parent is silent')

      // Deliver into an output with NO text part → the block is unshifted as a
      // new text part (the graceful-degradation injection path).
      const output = { parts: [] as unknown[] }
      assert.equal(notifier.flushQueue(ROOT, output), 1)
      assert.equal(output.parts.length, 1)
      assert.equal((output.parts[0] as { type?: string }).type, 'text')
      assert.ok(
        String((output.parts[0] as { text?: string }).text).includes('Delegation [her-1]'),
        'unshifted part carries the notification body',
      )
      assert.equal(notifier.pendingCount(ROOT), 0)
      assert.equal(notifier.sentCount(ROOT), 1)
    },
  )

  await testAsync(
    'flush-on-parent-message: queue delivers exactly on the parent next message, once',
    async () => {
      const notifier = new DelegationNotifier()
      notifier.queueNotification(ROOT, 'notif A')
      assert.ok(notifier.hasPending(ROOT))

      const output = { parts: [{ type: 'text', text: 'hi' }] }
      assert.equal(notifier.flushQueue(ROOT, output), 1)
      assert.ok(String((output.parts[0] as { text?: string }).text).includes('notif A'))
      assert.equal(notifier.pendingCount(ROOT), 0)

      // A second flush for the same parent delivers nothing (queue is drained).
      assert.equal(notifier.flushQueue(ROOT, { parts: [] }), 0)
      assert.equal(notifier.sentCount(ROOT), 1)
    },
  )

  await testAsync('flush ordering: multiple queued notifications flush in FIFO order', async () => {
    const notifier = new DelegationNotifier()
    notifier.queueNotification(ROOT, 'first')
    notifier.queueNotification(ROOT, 'second')
    notifier.queueNotification(ROOT, 'third')
    assert.equal(notifier.pendingCount(ROOT), 3)

    const output = { parts: [{ type: 'text', text: 'base' }] }
    assert.equal(notifier.flushQueue(ROOT, output), 3)
    const text = String((output.parts[0] as { text?: string }).text)
    assert.ok(text.indexOf('first') < text.indexOf('second'), 'first precedes second')
    assert.ok(text.indexOf('second') < text.indexOf('third'), 'second precedes third')
    assert.equal(notifier.pendingCount(ROOT), 0)
    assert.equal(notifier.sentCount(ROOT), 3)
  })

  await testAsync(
    'bounded queue: a full parent queue drops new entries instead of growing unbounded',
    async () => {
      const notifier = new DelegationNotifier()
      let accepted = true
      for (let i = 0; i < 10; i += 1) {
        accepted = notifier.queueNotification(ROOT, `n${i}`) && accepted
      }
      assert.equal(accepted, true, 'first ten entries are accepted')
      assert.equal(
        notifier.queueNotification(ROOT, 'overflow'),
        false,
        'full queue drops the entry',
      )
      assert.equal(notifier.pendingCount(ROOT), 10)
    },
  )

  await testAsync(
    'bounded queue: a dropped entry logs a warning via the injected logger',
    async () => {
      const warnings: string[] = []
      const notifier = new DelegationNotifier({ warn: (msg: string) => warnings.push(msg) })
      for (let i = 0; i < 10; i += 1) {
        notifier.queueNotification(ROOT, `n${i}`)
      }
      assert.equal(notifier.queueNotification(ROOT, 'overflow'), false)
      assert.equal(warnings.length, 1, 'exactly one warning is logged for the dropped entry')
      assert.ok(
        warnings[0].includes('dropped'),
        'warning mentions that the notification was dropped',
      )
      assert.ok(warnings[0].includes(ROOT), 'warning names the parent session')
      assert.ok(warnings[0].includes('10'), 'warning cites the per-parent bound')
    },
  )

  await testAsync(
    'timedOut job notification carries the timeout status (onTerminal covers timeout finalizes)',
    async () => {
      const board = new BackgroundJobBoard()
      await board.registerLaunch({
        taskID: 'ses_t',
        parentSessionID: ROOT,
        agent: 'apollo',
        description: 'Slow task',
      })
      await board.updateStatus({
        taskID: 'ses_t',
        state: 'error',
        timedOut: true,
        error: 'timed out after 1ms',
      })
      const timedOutJob = board.get('ses_t')
      assert.ok(timedOutJob, 'timed out job must exist on the board')
      const text = buildTaskNotification(timedOutJob)
      assert.ok(text.includes('state="error"'), 'timeout notification carries the error state')
      assert.ok(text.includes('timed out'), 'timeout notification carries the timeout status')
    },
  )

  await testAsync(
    'event→finalize wiring: session.idle → completed, session.error → error, unknown → no-op',
    async () => {
      const board = new BackgroundJobBoard()
      await board.registerLaunch({
        taskID: 'ses_child_1',
        parentSessionID: ROOT,
        agent: 'apollo',
        description: 'Find patterns',
      })
      const calls: Array<{ id: string; opts: FinalizeInput }> = []
      const finalizeSpy = async (id: string, opts: FinalizeInput): Promise<unknown> => {
        calls.push({ id, opts })
        return {}
      }
      const deps = { board, finalize: finalizeSpy }

      // session.idle on a board job → finalize as completed.
      const idleEv: DelegationEventLike = {
        type: 'session.idle',
        properties: { sessionID: 'ses_child_1' },
      }
      assert.equal(await handleDelegationEvent(idleEv, deps), true, 'idle event is handled')
      assert.deepEqual(calls, [{ id: 'ses_child_1', opts: { state: 'completed' } }])

      // session.error on a board job → finalize as error with the message.
      const errEv: DelegationEventLike = {
        type: 'session.error',
        properties: { sessionID: 'ses_child_1', error: { message: 'provider exploded' } },
      }
      assert.equal(await handleDelegationEvent(errEv, deps), true, 'error event is handled')
      assert.deepEqual(calls[1], {
        id: 'ses_child_1',
        opts: { state: 'error', error: 'provider exploded' },
      })

      // session.error with a string error is normalized too.
      const errStr: DelegationEventLike = {
        type: 'session.error',
        properties: { sessionID: 'ses_child_1', error: 'boom' },
      }
      assert.equal(await handleDelegationEvent(errStr, deps), true)
      const errorCall = calls[2]
      assert.ok(errorCall, 'third finalize call must exist')
      assert.deepEqual(errorCall.opts, { state: 'error', error: 'boom' })

      // Unknown session (no board membership) → no-op, finalize NOT called.
      const stranger: DelegationEventLike = {
        type: 'session.idle',
        properties: { sessionID: 'ses_stranger' },
      }
      assert.equal(await handleDelegationEvent(stranger, deps), false, 'unknown session is ignored')
      assert.equal(calls.length, 3, 'no finalize for unknown sessions')

      // Non-session events → no-op.
      assert.equal(
        await handleDelegationEvent({ type: 'session.created', properties: {} }, deps),
        false,
      )
      assert.equal(calls.length, 3)
    },
  )

  await testAsync(
    'idle fires multiple times → finalize idempotent, onTerminal queues the notification exactly once',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'notify-idempotent-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        const notifier = new DelegationNotifier()
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })
        // The plugin wires onTerminal → notifyParent: the single notification point.
        board.onTerminal((taskID: string) => {
          const job = board.get(taskID)
          if (job) notifier.notifyParent(job)
        })

        await tools.pantheon_delegate.execute({ prompt: 'Implement X', agent: 'hermes' }, makeCtx())
        const finalize = (id: string, opts: FinalizeInput) => tools.finalizeDelegation(id, opts)
        const idleEv: DelegationEventLike = {
          type: 'session.idle',
          properties: { sessionID: 'ses_child_1' },
        }

        assert.equal(await handleDelegationEvent(idleEv, { board, finalize }), true)
        const completedJob = board.get('ses_child_1')
        assert.ok(completedJob, 'job must exist after finalize')
        assert.equal(completedJob.state, 'completed')
        assert.equal(notifier.pendingCount(ROOT), 1, 'onTerminal queues exactly one notification')

        // Second idle on the same child → idempotent: no throw, same terminal
        // state, and NO second notification (board only re-notifies same-terminal).
        assert.equal(await handleDelegationEvent(idleEv, { board, finalize }), true)
        const completedAgain = board.get('ses_child_1')
        assert.ok(completedAgain, 'job must still exist after re-idle')
        assert.equal(completedAgain.state, 'completed')
        assert.equal(notifier.pendingCount(ROOT), 1, 're-idle must not queue a duplicate')

        // The report was (re)written by both finalize runs.
        const md = readFileSync(join(tmp, ROOT, 'her-1.md'), 'utf-8')
        assert.ok(md.includes('fake assistant output'), 'report written with pulled output')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

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
