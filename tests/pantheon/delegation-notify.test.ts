/**
 * Tests for the Delegation event wiring module (Phase 3, user policy) — the
 * `event`-hook complement of the board: `session.idle` / `session.error` on a
 * child session that is a board job → `finalizeDelegation` (Phase 2).
 *
 * User policy: ZERO delegation notifications in the chat transcript — no
 * `<task-notification>` block is ever injected into a `chat.message` output,
 * and no queued delivery path exists. Completion visibility lives in the
 * legitimate channels only: the board `[unread]` marker
 * (`pantheon_delegation_list`), `pantheon_delegation_read`, TUI toasts
 * (pantheon-hooks, PANTHEON_TOASTS gate) and compaction carry-forward.
 * The plugin's `onTerminal` listener writes a file-only log line.
 *
 * These tests cover ONLY the preserved wiring. The removed notification API
 * (DelegationNotifier / buildTaskNotification / flushQueue) no longer exists —
 * the type checker rejects any import of it.
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
  type DelegationEventLike,
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
    'idle fires multiple times → finalize idempotent, exactly ONE terminal transition (no echo)',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'notify-idempotent-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })
        // The plugin wires onTerminal → the file-only audit log. Count the
        // firings: there must be EXACTLY ONE per job — never a reconciled echo.
        const terminalFires: string[] = []
        board.onTerminal((taskID: string) => terminalFires.push(taskID))

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
        assert.equal(terminalFires.length, 1, 'terminal transition fires onTerminal exactly once')

        // Second idle on the same child → idempotent: no throw, same terminal
        // state, and NO second terminal transition (the board never re-fires).
        assert.equal(await handleDelegationEvent(idleEv, { board, finalize }), true)
        const completedAgain = board.get('ses_child_1')
        assert.ok(completedAgain, 'job must still exist after re-idle')
        assert.equal(completedAgain.state, 'completed')
        assert.equal(terminalFires.length, 1, 're-idle must not re-fire onTerminal')

        // Reconcile (pantheon_delegation_read acknowledgment) is NOT a
        // completion event — it must not re-fire onTerminal either.
        await board.markReconciled('ses_child_1')
        assert.equal(terminalFires.length, 1, 'reconcile must not re-fire onTerminal')

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
