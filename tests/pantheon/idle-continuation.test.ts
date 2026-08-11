/**
 * Tests for the Idle Continuation Dispatcher (Wave 3, PR #46) — routes
 * `session.idle` events to the subsystem that owns the idle.
 *
 * Priority: an ACTIVE GOAL owns the idle (goalLoop.onIdle); without an
 * active goal the todo enforcer gets it (self-guards on its own enabled
 * flag). Board-child sessions never reach the dispatcher — the plugin's
 * event hook routes those to the delegation finalize path first
 * (`handleDelegationEvent` returns true) and only calls the dispatcher on
 * the `!delegated` branch.
 *
 * Uses fake loop/enforcer spies (independent testability) plus a real
 * TodoEnforcer for the disabled case and a real BackgroundJobBoard +
 * handleDelegationEvent for the board-child semantics.
 *
 * Run with: npx tsx tests/pantheon/idle-continuation.test.ts
 */
import { strict as assert } from 'node:assert'

import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import { handleDelegationEvent } from '../../src/pantheon/delegation-notify.ts'
import { createIdleDispatcher, type IdleDispatcher } from '../../src/pantheon/idle-continuation.ts'
import { TodoEnforcer } from '../../src/pantheon/todo-enforcer.ts'

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

/** Minimal todo-enforcer client (only what the disabled enforcer touches). */
function fakeEnforcerClient() {
  let promptAsyncCalls = 0
  return {
    promptAsyncCalls: () => promptAsyncCalls,
    client: {
      session: {
        todo: async () => [{ id: 't1', content: 'task', status: 'pending' }],
        messages: async () => [],
        promptAsync: async () => {
          promptAsyncCalls += 1
          return {}
        },
      },
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  await testAsync('goal active → goalLoop.onIdle called; todoEnforcer spy NOT called', async () => {
    const goalLoopCalls: string[] = []
    const enforcerCalls: string[] = []
    const dispatcher = createIdleDispatcher({
      goalLoop: {
        hasActiveGoal: async (id: string) => {
          assert.equal(id, ROOT)
          return true
        },
        onIdle: async (id: string) => {
          goalLoopCalls.push(id)
        },
      },
      todoEnforcer: {
        onIdle: async (id: string) => {
          enforcerCalls.push(id)
        },
      },
    })

    await dispatcher.onIdle(ROOT)

    assert.deepEqual(goalLoopCalls, [ROOT], 'goal loop owns the idle')
    assert.deepEqual(enforcerCalls, [], 'todo enforcer is NOT invoked while a goal is active')
  })

  await testAsync('no goal + enforcer enabled → todoEnforcer.onIdle called', async () => {
    const goalLoopCalls: string[] = []
    const enforcerCalls: string[] = []
    const dispatcher = createIdleDispatcher({
      goalLoop: {
        hasActiveGoal: async () => false,
        onIdle: async (id: string) => {
          goalLoopCalls.push(id)
        },
      },
      todoEnforcer: {
        onIdle: async (id: string) => {
          enforcerCalls.push(id)
        },
      },
    })

    await dispatcher.onIdle(ROOT)

    assert.deepEqual(goalLoopCalls, [], 'goal loop untouched without a goal')
    assert.deepEqual(enforcerCalls, [ROOT], 'todo enforcer receives the idle')
  })

  await testAsync(
    'no goal + enforcer disabled → neither injects (enforcer self-guards)',
    async () => {
      const fake = fakeEnforcerClient()
      const enforcer = new TodoEnforcer({
        client: fake.client,
        board: new BackgroundJobBoard(),
        options: { enabled: false },
      })
      const dispatcher = createIdleDispatcher({
        goalLoop: {
          hasActiveGoal: async () => false,
          onIdle: async () => {
            throw new Error('goalLoop must not be called without a goal')
          },
        },
        todoEnforcer: enforcer,
      })

      await dispatcher.onIdle(ROOT)

      assert.equal(
        fake.promptAsyncCalls(),
        0,
        'disabled enforcer never injects through the dispatcher',
      )
    },
  )

  await testAsync(
    'board child session idle → delegation path claims it; dispatcher never invoked',
    async () => {
      const board = new BackgroundJobBoard()
      const childID = 'ses_child'
      await board.registerLaunch({
        taskID: childID,
        parentSessionID: ROOT,
        agent: 'apollo',
        description: 'Search codebase',
      })

      // The plugin event hook runs handleDelegationEvent FIRST; board children
      // return true (delegated), so the dispatcher branch is never reached.
      const delegated = await handleDelegationEvent(
        { type: 'session.idle', properties: { sessionID: childID } },
        { board, finalize: async () => ({}) },
      )
      assert.equal(delegated, true, 'delegation path claims board-child idles')

      let dispatcherCalls = 0
      const dispatcher: IdleDispatcher = createIdleDispatcher({
        goalLoop: {
          hasActiveGoal: async () => true,
          onIdle: async () => {
            dispatcherCalls += 1
          },
        },
        todoEnforcer: {
          onIdle: async () => {
            dispatcherCalls += 1
          },
        },
      })
      // Mirror of the plugin gate: `if (!delegated && ev.type === 'session.idle')`.
      if (!delegated) {
        await dispatcher.onIdle(childID)
      }
      assert.equal(dispatcherCalls, 0, 'dispatcher is not invoked for board-child idles')
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
