/**
 * Tests for the Todo Preserver (release-134 Phase 3) — post-compaction todo
 * restore via tool.execute.before interception.
 *
 * The SDK (1.18.11) exposes NO todo write (SessionTodoData.body?: never — the
 * `/session/{id}/todo` route is GET-only), so restore cannot be a direct API
 * call. The preserver instead:
 *   1. CAPTURES the full todo list in `experimental.session.compacting`;
 *   2. activates the pending snapshot on the `session.compacted` event;
 *   3. rewrites the FIRST `todowrite` of that session within the restore
 *      window with the EXACT captured list, denies subsequent writes in the
 *      window with a clear message, and passes everything else through.
 *
 * Every failure mode is fail-open — the hooks never throw (the only
 * deliberate throw is the restore-window denial).
 *
 * Run with: npx tsx tests/pantheon/todo-preserve.test.ts
 */
import { strict as assert } from 'node:assert'
import type { TodoLike } from '../../src/pantheon/todo-enforcer.ts'
import {
  RESTORE_WINDOW_MS,
  SNAPSHOT_TTL_MS,
  TodoPreserver,
  type TodoPreserverClient,
  TodoRestoreInProgressError,
  type TodoWriteBeforeOutput,
} from '../../src/pantheon/todo-preserve.ts'

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
  todos: TodoLike[] = []
  todoCalls: string[] = []
  todoImpl: (id: string) => Promise<TodoLike[]> = async () => this.todos

  readonly session = {
    todo: async (input: { path: { id: string } }): Promise<TodoLike[]> => {
      this.todoCalls.push(input.path.id)
      return this.todoImpl(input.path.id)
    },
  }

  asClient(): TodoPreserverClient {
    return { session: this.session }
  }
}

const ROOT = 'ses_root'
const OTHER = 'ses_other'

/** Mixed-status fixture — restore is a FULL list, terminal todos included. */
const SNAPSHOT: TodoLike[] = [
  { id: 't1', content: 'wire the directive', status: 'in_progress', priority: 'high' },
  { id: 't2', content: 'run the suite', status: 'pending', priority: 'medium' },
  { id: 't3', content: 'done', status: 'completed', priority: 'low' },
]

function modelWrite(todos: TodoLike[]): TodoWriteBeforeOutput {
  return { args: { todos } }
}

function inputFor(tool: string, sessionID: string, callID: string) {
  return { tool, sessionID, callID }
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  // (a) capture: GET called on compacting when there are todos; empty list →
  //     nothing stored (later writes pass through untouched).
  await testAsync(
    'capture: GETs the todo list and stores a snapshot when todos exist',
    async () => {
      const clock = { t: 1_000 }
      const client = new FakeClient()
      client.todos = [...SNAPSHOT]
      const preserver = new TodoPreserver({
        client: client.asClient(),
        options: { now: () => clock.t },
      })

      await preserver.capture(ROOT)
      assert.deepEqual(client.todoCalls, [ROOT], 'capture GETs the session todo list')
      assert.equal(client.todoCalls.length, 1, 'exactly one GET per capture')

      // The stored snapshot restores the EXACT list (full, terminal included).
      await preserver.onCompacted(ROOT)
      const output = modelWrite([
        { id: 't9', content: 'model partial rewrite', status: 'pending', priority: 'low' },
      ])
      await preserver.beforeTodoWrite(inputFor('todowrite', ROOT, 'c1'), output)
      assert.deepEqual(output.args.todos, SNAPSHOT, 'restored list is the exact captured snapshot')
    },
  )

  await testAsync('capture: empty todo list → no snapshot, no restore (zero noise)', async () => {
    const client = new FakeClient()
    client.todos = []
    const preserver = new TodoPreserver({ client: client.asClient() })

    await preserver.capture(ROOT)
    assert.deepEqual(
      client.todoCalls,
      [ROOT],
      'capture always GETs (empty is only known after the call)',
    )

    await preserver.onCompacted(ROOT)
    const output = modelWrite([
      { id: 't9', content: 'new task', status: 'pending', priority: 'low' },
    ])
    await preserver.beforeTodoWrite(inputFor('todowrite', ROOT, 'c1'), output)
    assert.deepEqual(
      output.args.todos,
      [{ id: 't9', content: 'new task', status: 'pending', priority: 'low' }],
      'empty snapshot → the model write passes through untouched',
    )
  })

  // (b) compacted → first todowrite rewritten with the exact snapshot;
  //     second todowrite in the window → clear throw.
  await testAsync(
    'compacted → first todowrite rewritten with the exact snapshot; second throws clearly',
    async () => {
      const clock = { t: 0 }
      const client = new FakeClient()
      client.todos = [...SNAPSHOT]
      const preserver = new TodoPreserver({
        client: client.asClient(),
        options: { now: () => clock.t },
      })

      await preserver.capture(ROOT)
      await preserver.onCompacted(ROOT)

      const first = modelWrite([
        { id: 't9', content: 'model rewrite', status: 'pending', priority: 'low' },
      ])
      await preserver.beforeTodoWrite(inputFor('todowrite', ROOT, 'c1'), first)
      assert.deepEqual(first.args.todos, SNAPSHOT, 'first todowrite carries the exact snapshot')

      const second = modelWrite([
        { id: 't9', content: 'another rewrite', status: 'pending', priority: 'low' },
      ])
      await assert.rejects(
        preserver.beforeTodoWrite(inputFor('todowrite', ROOT, 'c2'), second),
        (err: unknown) =>
          err instanceof TodoRestoreInProgressError &&
          err.message.includes('retry in a moment') &&
          err.message.includes(ROOT),
        'second todowrite inside the window is denied with a clear message',
      )
    },
  )

  // (c) guard: outside the restore window / other session → pass through.
  await testAsync('guard: todowrite after the restore window passes through', async () => {
    const clock = { t: 0 }
    const client = new FakeClient()
    client.todos = [...SNAPSHOT]
    const preserver = new TodoPreserver({
      client: client.asClient(),
      options: { now: () => clock.t },
    })

    await preserver.capture(ROOT)
    await preserver.onCompacted(ROOT)

    clock.t = RESTORE_WINDOW_MS + 1 // window over (5s), still inside the TTL
    const output = modelWrite([
      { id: 't9', content: 'late rewrite', status: 'pending', priority: 'low' },
    ])
    await preserver.beforeTodoWrite(inputFor('todowrite', ROOT, 'c1'), output)
    assert.deepEqual(
      output.args.todos,
      [{ id: 't9', content: 'late rewrite', status: 'pending', priority: 'low' }],
      'after the window the model write passes through',
    )
  })

  await testAsync('guard: todowrite for a different session passes through', async () => {
    const clock = { t: 0 }
    const client = new FakeClient()
    client.todos = [...SNAPSHOT]
    const preserver = new TodoPreserver({
      client: client.asClient(),
      options: { now: () => clock.t },
    })

    await preserver.capture(ROOT)
    await preserver.onCompacted(ROOT)

    const output = modelWrite([
      { id: 't9', content: 'other session', status: 'pending', priority: 'low' },
    ])
    await preserver.beforeTodoWrite(inputFor('todowrite', OTHER, 'c1'), output)
    assert.deepEqual(
      output.args.todos,
      [{ id: 't9', content: 'other session', status: 'pending', priority: 'low' }],
      'sessions without a pending snapshot are never intercepted',
    )
  })

  await testAsync('guard: non-todowrite tools pass through even mid-restore', async () => {
    const clock = { t: 0 }
    const client = new FakeClient()
    client.todos = [...SNAPSHOT]
    const preserver = new TodoPreserver({
      client: client.asClient(),
      options: { now: () => clock.t },
    })

    await preserver.capture(ROOT)
    await preserver.onCompacted(ROOT)

    const output = modelWrite([
      { id: 't9', content: 'irrelevant', status: 'pending', priority: 'low' },
    ])
    await preserver.beforeTodoWrite(inputFor('edit', ROOT, 'c1'), output)
    assert.deepEqual(
      output.args.todos,
      [{ id: 't9', content: 'irrelevant', status: 'pending', priority: 'low' }],
      'the guard only intercepts todowrite',
    )
  })

  // (d) fail-open: GET unavailable / event without snapshot / malformed
  //     hook output → never throws.
  await testAsync('fail-open: capture GET failure → warn, no throw', async () => {
    const warnings: string[] = []
    const client = new FakeClient()
    client.todoImpl = async () => {
      throw new Error('todo endpoint exploded')
    }
    const preserver = new TodoPreserver({
      client: client.asClient(),
      logger: { warn: (m: string) => warnings.push(m) },
    })

    await preserver.capture(ROOT) // must not throw
    assert.ok(
      warnings.some((w) => w.includes('capture') && w.includes('todo')),
      'capture failure is logged',
    )

    // No snapshot was stored → a todowrite passes through.
    const output = modelWrite([
      { id: 't9', content: 'still works', status: 'pending', priority: 'low' },
    ])
    await preserver.beforeTodoWrite(inputFor('todowrite', ROOT, 'c1'), output)
    assert.deepEqual(
      output.args.todos,
      [{ id: 't9', content: 'still works', status: 'pending', priority: 'low' }],
      'failed capture never blocks todowrite',
    )
  })

  await testAsync(
    'fail-open: compacted event without a snapshot → no throw, no restore',
    async () => {
      const preserver = new TodoPreserver({ client: new FakeClient().asClient() })
      await preserver.onCompacted(ROOT) // must not throw
    },
  )

  await testAsync(
    'fail-open: malformed hook output (missing args) → warn, pass through',
    async () => {
      const warnings: string[] = []
      const clock = { t: 0 }
      const client = new FakeClient()
      client.todos = [...SNAPSHOT]
      const preserver = new TodoPreserver({
        client: client.asClient(),
        options: { now: () => clock.t },
        logger: { warn: (m: string) => warnings.push(m) },
      })

      await preserver.capture(ROOT)
      await preserver.onCompacted(ROOT)

      const output = {} as TodoWriteBeforeOutput // args absent at runtime
      await preserver.beforeTodoWrite(inputFor('todowrite', ROOT, 'c1'), output) // must not throw
      assert.ok(
        warnings.some((w) => w.includes('args')),
        'missing args is logged',
      )
    },
  )

  // (e) TTL: a snapshot expired before the restore attempt is dropped.
  await testAsync(
    'TTL: expired snapshot is never restored (distinct from the window)',
    async () => {
      const clock = { t: 0 }
      const client = new FakeClient()
      client.todos = [...SNAPSHOT]
      // Window (120s) outlives the TTL (60s) so the TTL check is exercised on
      // its own: at t=61s the snapshot is expired but still inside the window.
      const preserver = new TodoPreserver({
        client: client.asClient(),
        options: { now: () => clock.t, restoreWindowMs: 120_000, snapshotTtlMs: SNAPSHOT_TTL_MS },
      })

      await preserver.capture(ROOT)
      await preserver.onCompacted(ROOT)

      clock.t = SNAPSHOT_TTL_MS + 1_000
      const output = modelWrite([{ id: 't9', content: 'late', status: 'pending', priority: 'low' }])
      await preserver.beforeTodoWrite(inputFor('todowrite', ROOT, 'c1'), output)
      assert.deepEqual(
        output.args.todos,
        [{ id: 't9', content: 'late', status: 'pending', priority: 'low' }],
        'expired snapshot → pass through',
      )
    },
  )

  await testAsync('TTL: compacted event arriving after the TTL is a no-op', async () => {
    const clock = { t: 0 }
    const client = new FakeClient()
    client.todos = [...SNAPSHOT]
    const preserver = new TodoPreserver({
      client: client.asClient(),
      options: { now: () => clock.t },
    })

    await preserver.capture(ROOT)
    clock.t = SNAPSHOT_TTL_MS + 5_000 // compacted fires after the snapshot died
    await preserver.onCompacted(ROOT)

    const output = modelWrite([
      { id: 't9', content: 'late event', status: 'pending', priority: 'low' },
    ])
    await preserver.beforeTodoWrite(inputFor('todowrite', ROOT, 'c1'), output)
    assert.deepEqual(
      output.args.todos,
      [{ id: 't9', content: 'late event', status: 'pending', priority: 'low' }],
      'no activation without a fresh snapshot',
    )
  })

  // tryWriteApi: version-sensitive direct-write hook. A future SDK may expose
  // a todo write; when an adapter succeeds the snapshot is dropped and
  // interception is skipped; when absent/failing, interception proceeds.
  await testAsync(
    'tryWriteApi: successful direct write → snapshot dropped, no interception',
    async () => {
      const clock = { t: 0 }
      const client = new FakeClient()
      client.todos = [...SNAPSHOT]
      let writeArgs: { sessionID: string; todos: TodoLike[] } | undefined
      const preserver = new TodoPreserver({
        client: client.asClient(),
        options: {
          now: () => clock.t,
          tryWriteApi: async (sessionID, todos) => {
            writeArgs = { sessionID, todos }
            return true
          },
        },
      })

      await preserver.capture(ROOT)
      await preserver.onCompacted(ROOT)

      assert.deepEqual(
        writeArgs,
        { sessionID: ROOT, todos: SNAPSHOT },
        'direct write attempted with the snapshot',
      )

      const output = modelWrite([
        { id: 't9', content: 'post-restore write', status: 'pending', priority: 'low' },
      ])
      await preserver.beforeTodoWrite(inputFor('todowrite', ROOT, 'c1'), output)
      assert.deepEqual(
        output.args.todos,
        [{ id: 't9', content: 'post-restore write', status: 'pending', priority: 'low' }],
        'successful API restore → todowrite passes through',
      )
    },
  )

  await testAsync(
    'tryWriteApi: absent or failing adapter → interception path (1.18.11 behavior)',
    async () => {
      const clock = { t: 0 }
      const client = new FakeClient()
      client.todos = [...SNAPSHOT]
      const warnings: string[] = []

      // No adapter injected (SDK 1.18.11 reality) → interception restores.
      const plain = new TodoPreserver({
        client: client.asClient(),
        options: { now: () => clock.t },
      })
      await plain.capture(ROOT)
      await plain.onCompacted(ROOT)
      const out = modelWrite([{ id: 't9', content: 'x', status: 'pending', priority: 'low' }])
      await plain.beforeTodoWrite(inputFor('todowrite', ROOT, 'c1'), out)
      assert.deepEqual(out.args.todos, SNAPSHOT, 'no adapter → interception restores the snapshot')

      // Throwing adapter → warn + fall back to interception.
      const failingClient = new FakeClient()
      failingClient.todos = [...SNAPSHOT]
      const failing = new TodoPreserver({
        client: failingClient.asClient(),
        options: {
          now: () => clock.t,
          tryWriteApi: async () => {
            throw new Error('future write api rejected')
          },
        },
        logger: { warn: (m: string) => warnings.push(m) },
      })
      await failing.capture(ROOT)
      await failing.onCompacted(ROOT)
      assert.ok(
        warnings.some((w) => w.includes('write API')),
        'adapter failure is logged',
      )
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
