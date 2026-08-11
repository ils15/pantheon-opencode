/**
 * Tests for the TODO Enforcer (Wave 1) — keeps root/non-board sessions working
 * on their todo list when the session goes idle.
 *
 * Guards (council-approved cut — latch/skipAgents/countdown-toast removed):
 *   1. board-running — a session with a running background job is skipped
 *      (the parent is busy; the child session itself is handled by the
 *      delegation event path, NOT the enforcer);
 *   2. in-flight — one injection per idle, never concurrent;
 *   3. cooldown — exponential per-session backoff 5000 * 2^min(failures, 5) ms,
 *      failures increment when an injection doesn't clear todos;
 *   4. max-consecutive-failures — stop injecting after N failures, reset after
 *      a quiet period.
 *
 * Uses a fake client + real in-memory BackgroundJobBoard — no opencode runtime.
 *
 * Run with: npx tsx tests/pantheon/todo-enforcer.test.ts
 */
import { strict as assert } from 'node:assert'

import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import {
  TODO_CONTINUATION_PROMPT,
  TODO_ENFORCER_DEFAULTS,
  TodoEnforcer,
  type TodoEnforcerChild,
  type TodoEnforcerClient,
  type TodoEnforcerMessage,
  type TodoLike,
  todoEnforcerEnabledFromEnv,
} from '../../src/pantheon/todo-enforcer.ts'

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

interface PromptAsyncCall {
  id: string
  body: { agent?: string; model?: unknown; parts: Array<{ type: string; text: string }> }
}

class FakeClient {
  todos: TodoLike[] = []
  messagesResult: TodoEnforcerMessage[] = []
  todoCalls: string[] = []
  promptAsyncCalls: PromptAsyncCall[] = []
  todoImpl: (id: string) => Promise<TodoLike[]> = async () => this.todos
  promptAsyncImpl: (input: PromptAsyncCall) => Promise<unknown> = async () => ({})
  childrenResult: TodoEnforcerChild[] = []
  childrenImpl: (id: string) => Promise<TodoEnforcerChild[]> = async () => this.childrenResult

  /** Optional broken TUI — the enforcer must never touch it. */
  tui?: { showToast: () => Promise<never> }

  readonly session = {
    todo: async (input: { path: { id: string } }): Promise<TodoLike[]> => {
      this.todoCalls.push(input.path.id)
      return this.todoImpl(input.path.id)
    },
    messages: async (): Promise<TodoEnforcerMessage[]> => this.messagesResult,
    children: async (input: { path: { id: string } }): Promise<TodoEnforcerChild[]> => {
      return this.childrenImpl(input.path.id)
    },
    promptAsync: async (input: {
      path: { id: string }
      body: PromptAsyncCall['body']
    }): Promise<unknown> => {
      this.promptAsyncCalls.push({ id: input.path.id, body: input.body })
      return this.promptAsyncImpl({ id: input.path.id, body: input.body })
    },
  }

  asClient(): TodoEnforcerClient {
    return { session: this.session }
  }
}

const ROOT = 'ses_root'

function incompleteTodos(count: number): TodoLike[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `todo_${i}`,
    content: `task ${i}`,
    status: 'pending',
    priority: 'medium',
  }))
}

function completedTodos(): TodoLike[] {
  return [
    { id: 't1', content: 'done', status: 'completed', priority: 'low' },
    { id: 't2', content: 'cancelled', status: 'cancelled', priority: 'low' },
  ]
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  await testAsync('all todos complete → no injection; later idles remain no-ops', async () => {
    const client = new FakeClient()
    client.todos = completedTodos()
    const enforcer = new TodoEnforcer({
      client: client.asClient(),
      board: new BackgroundJobBoard(),
    })

    await enforcer.onIdle(ROOT)
    await enforcer.onIdle(ROOT)

    assert.equal(client.promptAsyncCalls.length, 0, 'no promptAsync when all todos are terminal')
  })

  await testAsync(
    'incomplete todos → exactly one promptAsync with the continuation prompt; agent inherited from last assistant message',
    async () => {
      const client = new FakeClient()
      client.todos = incompleteTodos(2)
      client.messagesResult = [
        { info: { role: 'user', agent: 'zeus' } },
        { info: { role: 'assistant', agent: 'hermes' } },
      ]
      const enforcer = new TodoEnforcer({
        client: client.asClient(),
        board: new BackgroundJobBoard(),
      })

      await enforcer.onIdle(ROOT)
      await enforcer.onIdle(ROOT) // cooldown blocks a second injection

      assert.equal(client.promptAsyncCalls.length, 1, 'exactly one injection per idle window')
      const call = client.promptAsyncCalls[0]
      assert.equal(call.id, ROOT, 'injection targets the idle session')
      assert.equal(call.body.parts.length, 1)
      assert.equal(call.body.parts[0].type, 'text')
      assert.equal(
        call.body.parts[0].text,
        TODO_CONTINUATION_PROMPT,
        'injection carries the version-controlled continuation prompt',
      )
      assert.equal(call.body.agent, 'hermes', 'agent inherited from the last assistant message')
    },
  )

  await testAsync(
    'model fallback: assistant message without agent → promptAsync inherits the model instead',
    async () => {
      const client = new FakeClient()
      client.todos = incompleteTodos(1)
      client.messagesResult = [
        { info: { role: 'assistant', providerID: 'opencode-go', modelID: 'deepseek-v4-flash' } },
      ]
      const enforcer = new TodoEnforcer({
        client: client.asClient(),
        board: new BackgroundJobBoard(),
      })

      await enforcer.onIdle(ROOT)

      assert.equal(client.promptAsyncCalls.length, 1)
      const call = client.promptAsyncCalls[0]
      assert.equal(call.body.agent, undefined, 'no agent when the assistant message has none')
      assert.deepEqual(call.body.model, {
        providerID: 'opencode-go',
        modelID: 'deepseek-v4-flash',
      })
    },
  )

  await testAsync(
    'board-running guard: session with a running background job → skipped',
    async () => {
      const board = new BackgroundJobBoard()
      await board.registerLaunch({
        taskID: 'ses_child_1',
        parentSessionID: ROOT,
        agent: 'apollo',
        description: 'Search codebase',
      })
      const client = new FakeClient()
      client.todos = incompleteTodos(3)
      const enforcer = new TodoEnforcer({ client: client.asClient(), board })

      await enforcer.onIdle(ROOT)

      assert.equal(
        client.promptAsyncCalls.length,
        0,
        'no injection while the session has a running board job',
      )
    },
  )

  await testAsync(
    'in-flight guard: second idle while an injection is pending → skipped, never concurrent',
    async () => {
      const client = new FakeClient()
      client.todos = incompleteTodos(1)
      let releaseInjection: () => void = () => {}
      const gate = new Promise<void>((resolve) => {
        releaseInjection = resolve
      })
      client.promptAsyncImpl = async () => {
        await gate
        return {}
      }
      const enforcer = new TodoEnforcer({
        client: client.asClient(),
        board: new BackgroundJobBoard(),
      })

      const first = enforcer.onIdle(ROOT)
      const second = enforcer.onIdle(ROOT)
      // Let the first idle progress to the (blocked) injection; the second
      // idle must have returned early at the in-flight guard.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      assert.equal(client.promptAsyncCalls.length, 1, 'only the first idle injects')
      assert.equal(client.todoCalls.length, 1, 'the second idle never even fetched todos')

      releaseInjection()
      await first
      await second

      assert.equal(client.promptAsyncCalls.length, 1, 'the in-flight injection is never duplicated')
    },
  )

  await testAsync(
    'cooldown guard: failed injections back off 5000 → 10000 → 20000 ms (injectable clock)',
    async () => {
      const clock = { t: 0 }
      const client = new FakeClient()
      const enforcer = new TodoEnforcer({
        client: client.asClient(),
        board: new BackgroundJobBoard(),
        options: { now: () => clock.t },
      })
      const injectTimes: number[] = []

      // t=0: first injection (failures 0). Three todos remain.
      client.todos = incompleteTodos(3)
      await enforcer.onIdle(ROOT)
      injectTimes.push(clock.t)

      // t=1000: progress (3 → 2) breaks any failure streak → base cooldown 5000.
      clock.t = 1000
      client.todos = incompleteTodos(2)
      await enforcer.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 1, 'within the 5000ms cooldown → no injection')

      // t=6000: cooldown (5000ms) elapsed → second injection.
      clock.t = 6000
      await enforcer.onIdle(ROOT)
      injectTimes.push(clock.t)
      assert.equal(client.promptAsyncCalls.length, 2)

      // t=7000: stuck (still 2) → failure 1 → cooldown 10000ms.
      clock.t = 7000
      await enforcer.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 2, '10000ms cooldown after failure 1')

      // t=16000: cooldown elapsed (6000 + 10000) → third injection.
      clock.t = 16000
      await enforcer.onIdle(ROOT)
      injectTimes.push(clock.t)
      assert.equal(client.promptAsyncCalls.length, 3)

      // t=17000: stuck → failure 2 → cooldown 20000ms.
      clock.t = 17000
      await enforcer.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 3, '20000ms cooldown after failure 2')

      // t=36000: cooldown elapsed (16000 + 20000) → fourth injection.
      clock.t = 36000
      await enforcer.onIdle(ROOT)
      injectTimes.push(clock.t)
      assert.equal(client.promptAsyncCalls.length, 4)

      assert.deepEqual(
        injectTimes,
        [0, 6000, 16000, 36000],
        'injection gaps follow the exponential backoff ladder',
      )
    },
  )

  await testAsync(
    'max-consecutive-failures: stop injecting after the cap; quiet period resets',
    async () => {
      const clock = { t: 0 }
      const client = new FakeClient()
      client.todos = incompleteTodos(3)
      const enforcer = new TodoEnforcer({
        client: client.asClient(),
        board: new BackgroundJobBoard(),
        options: {
          cooldownBaseMs: 1000,
          maxConsecutiveFailures: 3,
          failureResetMs: 60_000,
          now: () => clock.t,
        },
      })
      const injectTimes: number[] = []

      // Three failed injections → three failures (cooldown 1000/2000/4000).
      await enforcer.onIdle(ROOT)
      injectTimes.push(clock.t)
      clock.t = 1000
      await enforcer.onIdle(ROOT) // failure 1; cooldown 2000 → skip
      clock.t = 3000
      await enforcer.onIdle(ROOT) // inject #2
      injectTimes.push(clock.t)
      clock.t = 4000
      await enforcer.onIdle(ROOT) // failure 2; cooldown 4000 → skip
      clock.t = 7000
      await enforcer.onIdle(ROOT) // inject #3
      injectTimes.push(clock.t)
      clock.t = 8000
      await enforcer.onIdle(ROOT) // failure 3 = cap → stopped
      assert.equal(client.promptAsyncCalls.length, 3)

      // Still stuck, well after cooldown, but BEFORE the quiet period → stopped.
      clock.t = 20_000
      await enforcer.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 3, 'no injection after the failure cap')

      // Quiet period (60s since the last injection at t=7000) elapsed → reset.
      clock.t = 80_000
      await enforcer.onIdle(ROOT)
      injectTimes.push(clock.t)
      assert.equal(client.promptAsyncCalls.length, 4, 'quiet period resets the failure counter')

      assert.deepEqual(injectTimes, [0, 3000, 7000, 80_000])
    },
  )

  await testAsync(
    'showToast absent or throwing → swallowed (enforcer has zero TUI dependency)',
    async () => {
      // Absent TUI.
      const client = new FakeClient()
      client.todos = incompleteTodos(1)
      const enforcer = new TodoEnforcer({
        client: client.asClient(),
        board: new BackgroundJobBoard(),
      })
      await enforcer.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 1, 'injection works without a tui surface')

      // Throwing TUI.
      const brokenClient = new FakeClient()
      brokenClient.todos = incompleteTodos(1)
      brokenClient.tui = {
        showToast: async (): Promise<never> => {
          throw new Error('tui toast broken')
        },
      }
      const enforcer2 = new TodoEnforcer({
        client: brokenClient.asClient(),
        board: new BackgroundJobBoard(),
      })
      await enforcer2.onIdle(ROOT)
      assert.equal(brokenClient.promptAsyncCalls.length, 1, 'a broken tui never blocks injection')
    },
  )

  await testAsync('session with no todos at all → no-op', async () => {
    const client = new FakeClient()
    client.todos = []
    const enforcer = new TodoEnforcer({
      client: client.asClient(),
      board: new BackgroundJobBoard(),
    })

    await enforcer.onIdle(ROOT)
    await enforcer.onIdle(ROOT)

    assert.equal(client.promptAsyncCalls.length, 0, 'empty todo list → nothing to enforce')
  })

  await testAsync('enabled:false → never injects', async () => {
    const client = new FakeClient()
    client.todos = incompleteTodos(3)
    const enforcer = new TodoEnforcer({
      client: client.asClient(),
      board: new BackgroundJobBoard(),
      options: { enabled: false },
    })

    await enforcer.onIdle(ROOT)

    assert.equal(client.promptAsyncCalls.length, 0, 'disabled enforcer never injects')
  })

  await testAsync(
    'promptAsync rejection → swallowed + logged; cooldown applies; in-flight released',
    async () => {
      const clock = { t: 0 }
      const warnings: string[] = []
      const client = new FakeClient()
      client.todos = incompleteTodos(2)
      client.promptAsyncImpl = async () => {
        throw new Error('provider exploded')
      }
      const enforcer = new TodoEnforcer({
        client: client.asClient(),
        board: new BackgroundJobBoard(),
        options: { now: () => clock.t },
        logger: { warn: (m: string) => warnings.push(m) },
      })

      await enforcer.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 1, 'the failing injection was attempted')
      assert.ok(
        warnings.some((w) => w.includes('todo') && w.includes('injection')),
        'injection failure is logged',
      )

      // Cooldown still applies to the failed attempt → no immediate retry.
      clock.t = 1000
      await enforcer.onIdle(ROOT)
      assert.equal(
        client.promptAsyncCalls.length,
        1,
        'no retry inside the cooldown after a failure',
      )

      // And the in-flight guard was released (the idle above ran to completion).
      clock.t = 6000
      await enforcer.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 2, 'in-flight released → a later idle retries')
    },
  )

  await testAsync('todo fetch rejection → swallowed + logged; no injection', async () => {
    const warnings: string[] = []
    const client = new FakeClient()
    client.todoImpl = async () => {
      throw new Error('todo endpoint exploded')
    }
    const enforcer = new TodoEnforcer({
      client: client.asClient(),
      board: new BackgroundJobBoard(),
      logger: { warn: (m: string) => warnings.push(m) },
    })

    await enforcer.onIdle(ROOT)

    assert.equal(client.promptAsyncCalls.length, 0, 'no injection when the todo fetch fails')
    assert.ok(
      warnings.some((w) => w.includes('todo')),
      'todo fetch failure is logged',
    )
  })

  await testAsync(
    'native-children guard: active child → skip; no children → injects; terminal child → injects',
    async () => {
      const clock = { t: 1_000_000 }
      const client = new FakeClient()
      client.todos = incompleteTodos(3)
      const enforcer = new TodoEnforcer({
        client: client.asClient(),
        board: new BackgroundJobBoard(),
        options: { now: () => clock.t },
      })

      // Active native background child (updated 1s ago, childActiveMs=120s) → skip.
      client.childrenResult = [{ id: 'child_1', time: { updated: clock.t - 1000 } }]
      await enforcer.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 0, 'active native child → no injection')

      // No children at all → inject.
      client.childrenResult = []
      await enforcer.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 1, 'no children → injection proceeds')

      // Terminal child (updated 300s ago, past the 120s window) → inject.
      clock.t = 1_006_000 // past the 5000ms cooldown from the injection above
      client.todos = incompleteTodos(2) // progress 3→2 breaks the failure streak
      client.childrenResult = [{ id: 'child_1', time: { updated: clock.t - 300_000 } }]
      await enforcer.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 2, 'terminal child → injection proceeds')
    },
  )

  await testAsync(
    'native-children guard: children() throwing → fail-open (logged, still injects)',
    async () => {
      const warnings: string[] = []
      const client = new FakeClient()
      client.todos = incompleteTodos(2)
      client.childrenImpl = async () => {
        throw new Error('children endpoint unavailable')
      }
      const enforcer = new TodoEnforcer({
        client: client.asClient(),
        board: new BackgroundJobBoard(),
        logger: { warn: (m: string) => warnings.push(m) },
      })

      await enforcer.onIdle(ROOT)

      assert.equal(client.promptAsyncCalls.length, 1, 'children API failure never blocks injection')
      assert.ok(
        warnings.some((w) => w.includes('children')),
        'children failure is logged',
      )
    },
  )

  await testAsync(
    'user-activity gate: message within userActivityQuietMs → skip; after → injects',
    async () => {
      const clock = { t: 0 }
      const client = new FakeClient()
      client.todos = incompleteTodos(2)
      const enforcer = new TodoEnforcer({
        client: client.asClient(),
        board: new BackgroundJobBoard(),
        options: { now: () => clock.t },
      })

      enforcer.noteUserActivity(ROOT) // records t=0 (lastUserMessageAt)
      await enforcer.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 0, 'fresh user message → no injection')

      clock.t = 10_000 // still inside the 30s quiet window
      await enforcer.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 0, 'within quiet window → still skipped')

      clock.t = 60_000 // past the 30s window
      await enforcer.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 1, 'after quiet window → injection proceeds')
    },
  )

  await testAsync(
    'PANTHEON_TODO_ENFORCER=off → disabled (never injects even with incomplete todos)',
    async () => {
      // Env parsing (case-insensitive, only exact "off" disables).
      assert.equal(todoEnforcerEnabledFromEnv({ PANTHEON_TODO_ENFORCER: 'off' }), false)
      assert.equal(todoEnforcerEnabledFromEnv({ PANTHEON_TODO_ENFORCER: 'OFF' }), false)
      assert.equal(todoEnforcerEnabledFromEnv({}), true)
      assert.equal(todoEnforcerEnabledFromEnv({ PANTHEON_TODO_ENFORCER: 'false' }), true)

      // End-to-end: the plugin wires the env read into the enabled flag.
      const client = new FakeClient()
      client.todos = incompleteTodos(3)
      const enforcer = new TodoEnforcer({
        client: client.asClient(),
        board: new BackgroundJobBoard(),
        options: {
          ...TODO_ENFORCER_DEFAULTS,
          enabled: todoEnforcerEnabledFromEnv({ PANTHEON_TODO_ENFORCER: 'off' }),
        },
      })

      await enforcer.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 0, 'kill-switch off → never injects')
    },
  )

  await testAsync(
    'listPendingTodos → pending only; [] when disabled or on API failure (fail-open)',
    async () => {
      const client = new FakeClient()
      client.todos = [...incompleteTodos(2), ...completedTodos()]
      const enforcer = new TodoEnforcer({
        client: client.asClient(),
        board: new BackgroundJobBoard(),
        options: { enabled: true },
      })

      const pending = await enforcer.listPendingTodos(ROOT)
      assert.equal(pending.length, 2, 'completed/cancelled todos must be filtered out')
      assert.ok(
        pending.every((t) => t.status !== 'completed' && t.status !== 'cancelled'),
        'only pending/in_progress todos remain',
      )

      const disabled = new TodoEnforcer({
        client: new FakeClient().asClient(),
        board: new BackgroundJobBoard(),
        options: { enabled: false },
      })
      assert.deepEqual(await disabled.listPendingTodos(ROOT), [], 'disabled → []')

      const broken = new FakeClient()
      broken.todoImpl = async () => {
        throw new Error('api down')
      }
      const failOpen = new TodoEnforcer({
        client: broken.asClient(),
        board: new BackgroundJobBoard(),
        options: { enabled: true },
      })
      assert.deepEqual(await failOpen.listPendingTodos(ROOT), [], 'API failure → [] (fail-open)')
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
