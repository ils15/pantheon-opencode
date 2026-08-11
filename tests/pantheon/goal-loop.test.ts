/**
 * Tests for the Full-Auto Goal Loop (Wave 3, PR #46) — one active goal per
 * session, continued automatically while the session is idle.
 *
 * State machine: pending → in_progress → done. `done` stops all further
 * continuations (council cut: no LLM completion-audit prompt — the state
 * machine is the source of truth).
 *
 * Guards: board-running skip, in-flight Set, cooldown (injectable clock),
 * max_continuations hard cap (25). Opt-in: enabled defaults to false.
 *
 * GoalStore persists to `.pantheon/goals/<sessionID>.json` with atomic
 * tmp+rename writes; session IDs with `..`, `/`, or `\` are rejected
 * (path-traversal guard).
 *
 * Uses a fake client + real in-memory BackgroundJobBoard + temp dirs.
 *
 * Run with: npx tsx tests/pantheon/goal-loop.test.ts
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import {
  GOAL_CONTINUATION_PROMPT,
  type Goal,
  GoalLoop,
  type GoalLoopClient,
  GoalStore,
} from '../../src/pantheon/goal-loop.ts'
import type { TodoEnforcerMessage } from '../../src/pantheon/todo-enforcer.ts'

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

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'pantheon-goals-'))
}

// ─── Fake client ───────────────────────────────────────────────────────

interface GoalPromptAsyncCall {
  id: string
  body: {
    agent?: string
    model?: unknown
    parts: Array<{ type: string; text: string }>
  }
}

class FakeGoalClient {
  messagesResult: TodoEnforcerMessage[] = []
  promptAsyncCalls: GoalPromptAsyncCall[] = []
  promptAsyncImpl: (call: GoalPromptAsyncCall) => Promise<unknown> = async () => ({})

  readonly session = {
    messages: async (): Promise<TodoEnforcerMessage[]> => this.messagesResult,
    promptAsync: async (input: {
      path: { id: string }
      body: GoalPromptAsyncCall['body']
    }): Promise<unknown> => {
      const call = { id: input.path.id, body: input.body }
      this.promptAsyncCalls.push(call)
      return this.promptAsyncImpl(call)
    },
  }

  asClient(): GoalLoopClient {
    return { session: this.session }
  }
}

const ROOT = 'ses_root'

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  await testAsync(
    'create → get → update round-trip; status machine pending → in_progress → done',
    async () => {
      const dir = freshDir()
      try {
        const store = new GoalStore({ dir })
        const loop = new GoalLoop({
          store,
          client: new FakeGoalClient().asClient(),
          board: new BackgroundJobBoard(),
        })
        const tools = loop.tools()

        const created = await tools.pantheon_goal_create.execute(
          { objective: 'Ship Wave 3' },
          { sessionID: ROOT },
        )
        assert.ok(created.includes('Goal created'), 'create reports success')

        const got = await tools.pantheon_goal_get.execute({}, { sessionID: ROOT })
        assert.ok(got.includes('pending'), 'fresh goal starts pending')
        assert.ok(got.includes('Ship Wave 3'), 'get restates the objective')

        const updated = await tools.pantheon_goal_update.execute(
          { status: 'in_progress', objective: 'Ship Wave 3 with tests' },
          { sessionID: ROOT },
        )
        assert.ok(updated.includes('in_progress'), 'update applies the new status')
        assert.ok(updated.includes('Ship Wave 3 with tests'), 'update applies the new objective')

        const got2 = await tools.pantheon_goal_get.execute({}, { sessionID: ROOT })
        assert.ok(got2.includes('in_progress'), 'get reflects in_progress')
        assert.ok(got2.includes('Ship Wave 3 with tests'), 'get reflects the updated objective')

        await tools.pantheon_goal_update.execute({ status: 'done' }, { sessionID: ROOT })
        const got3 = await tools.pantheon_goal_get.execute({}, { sessionID: ROOT })
        assert.ok(got3.includes('done'), 'get reflects done')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  await testAsync('store survives reload — atomic file, continuationCount persisted', async () => {
    const dir = freshDir()
    try {
      const loop = new GoalLoop({
        store: new GoalStore({ dir }),
        client: new FakeGoalClient().asClient(),
        board: new BackgroundJobBoard(),
        options: { now: () => 1_000 },
      })
      await loop
        .tools()
        .pantheon_goal_create.execute({ objective: 'Persist me' }, { sessionID: ROOT })

      // A brand-new store instance reads the same file → the JSON survived.
      const fresh = new GoalStore({ dir })
      const goal = await fresh.load(ROOT)
      assert.ok(goal !== undefined, 'goal loads from disk')
      assert.equal(goal?.objective, 'Persist me')
      assert.equal(goal?.status, 'pending')
      assert.equal(goal?.createdAt, 1_000)
      assert.equal(goal?.updatedAt, 1_000)
      assert.equal(goal?.continuationCount, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync(
    'path traversal rejected — ../ and / in sessionID throw; tool returns error text',
    async () => {
      const dir = freshDir()
      try {
        const store = new GoalStore({ dir })
        assert.throws(() => store.sanitizeSessionID('../evil'), /Invalid/, '.. is rejected')
        assert.throws(() => store.sanitizeSessionID('a/b'), /Invalid/, 'slash is rejected')
        assert.throws(() => store.sanitizeSessionID('a\\b'), /Invalid/, 'backslash is rejected')
        await assert.rejects(() => store.load('../evil'), /Invalid/, 'load rejects traversal')
        await assert.rejects(
          () => store.save({ sessionID: 'a/b' } as Goal),
          /Invalid/,
          'save rejects traversal',
        )

        const loop = new GoalLoop({
          store,
          client: new FakeGoalClient().asClient(),
          board: new BackgroundJobBoard(),
        })
        const result = await loop
          .tools()
          .pantheon_goal_create.execute({ objective: 'x' }, { sessionID: '../evil' })
        assert.ok(result.includes('failed'), 'tool surfaces the traversal rejection as error text')
        const list = await store.list('../x').catch(() => [])
        assert.equal(list.length, 0, 'no file was ever written outside the goal dir')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'idle with active goal → continuation injected with objective restatement; continuationCount increments; agent inherited',
    async () => {
      const dir = freshDir()
      try {
        const client = new FakeGoalClient()
        client.messagesResult = [
          { info: { role: 'user', agent: 'zeus' } },
          { info: { role: 'assistant', agent: 'hermes' } },
        ]
        const loop = new GoalLoop({
          store: new GoalStore({ dir }),
          client: client.asClient(),
          board: new BackgroundJobBoard(),
          options: { enabled: true, now: () => 0 },
        })
        await loop
          .tools()
          .pantheon_goal_create.execute({ objective: 'Land Wave 3' }, { sessionID: ROOT })

        await loop.onIdle(ROOT)

        assert.equal(client.promptAsyncCalls.length, 1, 'one continuation injected')
        const call = client.promptAsyncCalls[0]
        assert.equal(call.id, ROOT, 'injection targets the goal session')
        assert.equal(call.body.agent, 'hermes', 'agent inherited from the last assistant message')
        assert.ok(
          call.body.parts[0].text.includes('Land Wave 3'),
          'objective restated from the store in the prompt',
        )
        assert.ok(!call.body.parts[0].text.includes('{objective}'), 'placeholder fully substituted')

        const fresh = new GoalStore({ dir })
        const goal = await fresh.load(ROOT)
        assert.equal(goal?.continuationCount, 1, 'continuationCount persisted after the injection')
        assert.equal(goal?.status, 'pending', 'goal remains active')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  await testAsync('update status done → no further continuations', async () => {
    const dir = freshDir()
    try {
      const client = new FakeGoalClient()
      const clock = { t: 0 }
      const loop = new GoalLoop({
        store: new GoalStore({ dir }),
        client: client.asClient(),
        board: new BackgroundJobBoard(),
        options: { enabled: true, now: () => clock.t },
      })
      await loop
        .tools()
        .pantheon_goal_create.execute({ objective: 'Finish it' }, { sessionID: ROOT })

      await loop.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 1, 'active goal → one continuation')

      await loop.tools().pantheon_goal_update.execute({ status: 'done' }, { sessionID: ROOT })
      clock.t = 10_000 // well past any cooldown
      await loop.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 1, 'done goal → no further continuations')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync(
    'max_continuations hard cap (25) halts the loop; custom cap progression',
    async () => {
      const dir = freshDir()
      try {
        // Default cap 25: pre-seeded goal at the cap → never injects.
        const store = new GoalStore({ dir })
        await store.save({
          id: ROOT,
          sessionID: ROOT,
          objective: 'seeded',
          status: 'in_progress',
          createdAt: 0,
          updatedAt: 0,
          continuationCount: 25,
        })
        const client = new FakeGoalClient()
        const capped = new GoalLoop({
          store,
          client: client.asClient(),
          board: new BackgroundJobBoard(),
          options: { enabled: true, now: () => 0 },
        })
        await capped.onIdle(ROOT)
        assert.equal(client.promptAsyncCalls.length, 0, 'at the cap → no injection')

        // Custom small cap: loop runs until the cap, then halts.
        const dir2 = freshDir()
        try {
          const client2 = new FakeGoalClient()
          const loop2 = new GoalLoop({
            store: new GoalStore({ dir: dir2 }),
            client: client2.asClient(),
            board: new BackgroundJobBoard(),
            options: { enabled: true, now: () => 0, cooldownMs: 0, maxContinuations: 2 },
          })
          await loop2
            .tools()
            .pantheon_goal_create.execute({ objective: 'Two shots' }, { sessionID: ROOT })
          await loop2.onIdle(ROOT)
          await loop2.onIdle(ROOT)
          await loop2.onIdle(ROOT)
          assert.equal(client2.promptAsyncCalls.length, 2, 'cap reached after two injections')
          const fresh = new GoalStore({ dir: dir2 })
          assert.equal((await fresh.load(ROOT))?.continuationCount, 2)
        } finally {
          rmSync(dir2, { recursive: true, force: true })
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  await testAsync('board-running guard: active goal + running job → skipped', async () => {
    const dir = freshDir()
    try {
      const board = new BackgroundJobBoard()
      await board.registerLaunch({
        taskID: 'ses_child_1',
        parentSessionID: ROOT,
        agent: 'apollo',
        description: 'Search codebase',
      })
      const client = new FakeGoalClient()
      const loop = new GoalLoop({
        store: new GoalStore({ dir }),
        client: client.asClient(),
        board,
        options: { enabled: true, now: () => 0 },
      })
      await loop
        .tools()
        .pantheon_goal_create.execute({ objective: 'Busy parent' }, { sessionID: ROOT })

      await loop.onIdle(ROOT)
      assert.equal(
        client.promptAsyncCalls.length,
        0,
        'no continuation while the session has a running board job',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync(
    'in-flight guard: second idle while an injection is pending → skipped',
    async () => {
      const dir = freshDir()
      try {
        const client = new FakeGoalClient()
        let release: () => void = () => {}
        const gate = new Promise<void>((resolve) => {
          release = resolve
        })
        client.promptAsyncImpl = async () => {
          await gate
          return {}
        }
        const loop = new GoalLoop({
          store: new GoalStore({ dir }),
          client: client.asClient(),
          board: new BackgroundJobBoard(),
          options: { enabled: true, now: () => 0 },
        })
        await loop
          .tools()
          .pantheon_goal_create.execute({ objective: 'No overlap' }, { sessionID: ROOT })

        const first = loop.onIdle(ROOT)
        const second = loop.onIdle(ROOT)
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        assert.equal(client.promptAsyncCalls.length, 1, 'only the first idle injects')

        release()
        await first
        await second
        assert.equal(
          client.promptAsyncCalls.length,
          1,
          'the in-flight injection is never duplicated',
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )

  await testAsync('cooldown applied: 5000ms between continuations (injectable clock)', async () => {
    const dir = freshDir()
    try {
      const clock = { t: 0 }
      const client = new FakeGoalClient()
      const loop = new GoalLoop({
        store: new GoalStore({ dir }),
        client: client.asClient(),
        board: new BackgroundJobBoard(),
        options: { enabled: true, now: () => clock.t },
      })
      await loop.tools().pantheon_goal_create.execute({ objective: 'Pace me' }, { sessionID: ROOT })

      await loop.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 1, 'first idle injects')

      clock.t = 1_000
      await loop.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 1, 'within the 5000ms cooldown → no injection')

      clock.t = 6_000
      await loop.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 2, 'after the cooldown → injects again')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync('enabled:false → never injects, even with an active goal', async () => {
    const dir = freshDir()
    try {
      const client = new FakeGoalClient()
      const loop = new GoalLoop({
        store: new GoalStore({ dir }),
        client: client.asClient(),
        board: new BackgroundJobBoard(),
        options: { enabled: false, now: () => 0 },
      })
      await loop
        .tools()
        .pantheon_goal_create.execute({ objective: 'Off by default' }, { sessionID: ROOT })

      await loop.onIdle(ROOT)
      await loop.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 0, 'disabled goal loop never injects')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await testAsync(
    'GOAL_CONTINUATION_PROMPT carries the objective placeholder + action instruction',
    async () => {
      assert.ok(
        GOAL_CONTINUATION_PROMPT.includes('{objective}'),
        'prompt restates the objective via the {objective} placeholder',
      )
      assert.ok(
        GOAL_CONTINUATION_PROMPT.includes('pantheon_goal_update'),
        'prompt tells the agent to mark the goal done via pantheon_goal_update',
      )
    },
  )

  await testAsync('no goal at all → idle is a no-op', async () => {
    const dir = freshDir()
    try {
      const client = new FakeGoalClient()
      const loop = new GoalLoop({
        store: new GoalStore({ dir }),
        client: client.asClient(),
        board: new BackgroundJobBoard(),
        options: { now: () => 0 },
      })
      await loop.onIdle(ROOT)
      await loop.onIdle(ROOT)
      assert.equal(client.promptAsyncCalls.length, 0, 'no goal → no continuation')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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
