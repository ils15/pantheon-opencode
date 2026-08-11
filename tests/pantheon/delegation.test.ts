/**
 * Tests for the Delegation Core (Phase 2) — pantheon_delegate /
 * pantheon_delegation_read / pantheon_delegation_list tools + finalize path.
 *
 * Uses a fake client (stub session.create/promptAsync/messages) and an
 * in-memory BackgroundJobBoard — no opencode runtime required.
 *
 * Run with: npx tsx tests/pantheon/delegation.test.ts
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  BackgroundJobBoard,
  type BackgroundJobRecord,
} from '../../src/pantheon/background-job-board.ts'
import { createDelegationTools, type DelegationToolset } from '../../src/pantheon/delegation.ts'
import { readDelegationReport } from '../../src/pantheon/delegation-finalize.ts'

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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Poll until `fn` is truthy or `timeoutMs` elapses. */
async function waitFor(fn: () => boolean, timeoutMs = 2000, label = 'condition'): Promise<void> {
  const start = Date.now()
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error(`waitFor timed out: ${label}`)
    await sleep(10)
  }
}

// ─── Fake client ───────────────────────────────────────────────────────

interface FakeCreateInput {
  body: {
    parentID: string
    title?: string
    model?: { id: string; providerID: string }
  }
}
interface FakePromptInput {
  path: { id: string }
  body: { agent: string; parts: Array<{ type: string; text: string }> }
}

class FakeClient {
  created: FakeCreateInput[] = []
  prompted: FakePromptInput[] = []
  messagesCalls: string[] = []
  /** When set, session.create rejects with this error (F3). */
  createError: Error | null = null
  messagesResult: Array<{ info: { role: string }; parts: Array<{ type: string; text: string }> }> =
    [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'fake assistant output' }] }]
  private childCounter = 0

  readonly session = {
    create: async (input: FakeCreateInput): Promise<{ id: string }> => {
      if (this.createError) throw this.createError
      this.created.push(input)
      this.childCounter += 1
      return { id: `ses_child_${this.childCounter}` }
    },
    promptAsync: async (input: FakePromptInput): Promise<unknown> => {
      this.prompted.push(input)
      return { task_id: input.path.id, state: 'running' }
    },
    messages: async (input: { path: { id: string } }): Promise<unknown> => {
      this.messagesCalls.push(input.path.id)
      return this.messagesResult
    },
  }
}

const ROOT = 'ses_root'
const CHILD = 'ses_child_outer'

function makeCtx(sessionID = ROOT) {
  return { sessionID, directory: '/tmp', worktree: '/tmp', agent: 'zeus' }
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  await testAsync(
    'pantheon_delegate happy path: registers job, arms timeout, fires promptAsync, returns alias',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-happy-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })

        const result = await tools.pantheon_delegate.execute(
          { prompt: 'Find auth patterns', agent: 'apollo', description: 'Search codebase' },
          makeCtx(),
        )

        // Readable alias in the result
        assert.ok(result.includes('apo-1'), `result should include alias, got: ${result}`)

        // Job registered on board with taskID = child sessionID
        const job = board.get('ses_child_1')
        assert.ok(job, 'job should be registered with taskID = child session id')
        assert.equal(job!.state, 'running')
        assert.equal(job!.alias, 'apo-1')
        assert.equal(job!.parentSessionID, ROOT)

        // promptAsync fired on the child WITHOUT noReply (push-less completion)
        assert.equal(client.created.length, 1)
        assert.equal(client.created[0]!.body.parentID, ROOT)
        assert.equal(client.prompted.length, 1)
        assert.equal(client.prompted[0]!.path.id, 'ses_child_1')
        assert.equal(client.prompted[0]!.body.agent, 'apollo')
        assert.equal(client.prompted[0]!.body.parts[0]!.text, 'Find auth patterns')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'delegate passes explicit model option through to session.create body',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-model-explicit-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })

        await tools.pantheon_delegate.execute(
          { prompt: 'Find X', agent: 'apollo', model: 'opencode/deepseek-v4-flash-free' },
          makeCtx(),
        )

        assert.equal(client.created.length, 1)
        assert.deepEqual(client.created[0]!.body.model, {
          id: 'deepseek-v4-flash-free',
          providerID: 'opencode',
        })
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'delegate resolves child model from options.agentModels (routing.yml agent entry)',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-model-agents-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        const tools = createDelegationTools({
          board,
          client,
          options: {
            rootSessions: new Set([ROOT]),
            outputDir: tmp,
            agentModels: { apollo: 'opencode/deepseek-v4-flash-free' },
          },
        })

        await tools.pantheon_delegate.execute({ prompt: 'Find X', agent: 'apollo' }, makeCtx())

        assert.equal(client.created.length, 1)
        assert.deepEqual(client.created[0]!.body.model, {
          id: 'deepseek-v4-flash-free',
          providerID: 'opencode',
        })
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'delegate falls back to resolveActivePreset agent model when no explicit/agentModels model',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-model-preset-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        const warnings: string[] = []
        const tools = createDelegationTools({
          board,
          client,
          options: {
            rootSessions: new Set([ROOT]),
            outputDir: tmp,
            // No agentModels — the delegate must resolve the active preset
            // itself (default routing.yml) and use the preset's apollo model.
            presetEnv: { PANTHEON_MODEL_PRESET: 'go-deepseek' },
            logger: { warn: (msg) => warnings.push(msg) },
          },
        })

        await tools.pantheon_delegate.execute({ prompt: 'Find X', agent: 'apollo' }, makeCtx())

        assert.equal(client.created.length, 1)
        assert.deepEqual(client.created[0]!.body.model, {
          id: 'deepseek-v4-flash-free',
          providerID: 'opencode',
        })
        assert.equal(warnings.length, 0, 'preset model resolves — no warning expected')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'delegate without any model source: still creates child, logs a warning, no model in body',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-model-none-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        const warnings: string[] = []
        const tools = createDelegationTools({
          board,
          client,
          options: {
            rootSessions: new Set([ROOT]),
            outputDir: tmp,
            presetEnv: { PANTHEON_MODEL_PRESET: 'none' },
            logger: { warn: (msg) => warnings.push(msg) },
          },
        })

        const result = await tools.pantheon_delegate.execute(
          { prompt: 'Find X', agent: 'apollo' },
          makeCtx(),
        )

        assert.equal(client.created.length, 1, 'child session still created without a model')
        assert.equal(client.created[0]!.body.model, undefined, 'no model field in create body')
        assert.ok(result.includes('apo-1'), 'delegation proceeds normally')
        assert.ok(
          warnings.some((w) => /no model/i.test(w)),
          `expected a no-model warning, got: ${warnings.join('; ')}`,
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync('depth guard: delegate from a SUB-session caller is rejected', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'delegation-depth-'))
    try {
      const board = new BackgroundJobBoard()
      const client = new FakeClient()
      const tools = createDelegationTools({
        board,
        client,
        options: { rootSessions: new Set([ROOT]), outputDir: tmp },
      })

      await assert.rejects(
        tools.pantheon_delegate.execute(
          { prompt: 'Nested delegation', agent: 'apollo' },
          makeCtx(CHILD),
        ),
        /root session/,
      )
      assert.equal(client.created.length, 0, 'no session may be created for a rejected delegate')
      assert.equal(board.list().length, 0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  await testAsync(
    'depth guard: a session we created as a child cannot delegate again (self-learning)',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-depth2-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        // No explicit rootSessions — the guard defaults to "anything we created
        // as a child is a sub-session".
        const tools = createDelegationTools({ board, client, options: { outputDir: tmp } })

        // Root delegates → creates child ses_child_1
        await tools.pantheon_delegate.execute({ prompt: 'First', agent: 'apollo' }, makeCtx(ROOT))

        // The created child tries to delegate → rejected by knownChildren
        await assert.rejects(
          tools.pantheon_delegate.execute(
            { prompt: 'Nested', agent: 'apollo' },
            makeCtx('ses_child_1'),
          ),
          /root session/,
        )
        assert.equal(client.created.length, 1, 'nested delegate must not create a session')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'canDispatch saturation: maxConcurrentPerAgent exceeded → rejected with clear message',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-sat-'))
      try {
        const board = new BackgroundJobBoard({ maxConcurrentPerAgent: 1 })
        const client = new FakeClient()
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })

        // First delegate takes the single apollo slot
        await tools.pantheon_delegate.execute({ prompt: 'First', agent: 'apollo' }, makeCtx())

        // Second delegate for the same agent → saturation rejection
        await assert.rejects(
          tools.pantheon_delegate.execute({ prompt: 'Second', agent: 'apollo' }, makeCtx()),
          /concurrency limit|limit reached|1\/1/,
        )
        assert.equal(client.created.length, 1, 'saturated delegate must not create a session')

        // A different agent is not blocked
        const hermesResult = await tools.pantheon_delegate.execute(
          { prompt: 'Other agent', agent: 'hermes' },
          makeCtx(),
        )
        assert.ok(hermesResult.includes('her-1'))
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'timeout finalize: timer fires without idle → error state with timedOut flag + [TIMEOUT REACHED] marker',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-timeout-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        // Partial output only — the child never reports idle
        client.messagesResult = [
          { info: { role: 'assistant' }, parts: [{ type: 'text', text: 'partial progress only' }] },
        ]
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp, timeoutMs: 30 },
        })

        await tools.pantheon_delegate.execute({ prompt: 'Slow task', agent: 'apollo' }, makeCtx())

        await waitFor(() => board.get('ses_child_1')?.state === 'error', 3000, 'timeout finalize')

        const job = board.get('ses_child_1')!
        assert.equal(job.state, 'error')
        assert.equal(job.timedOut, true)
        assert.equal(job.timeoutCount, 1)
        assert.ok(
          /timed out/i.test(job.lastStatusError ?? ''),
          `error should mention timeout: ${job.lastStatusError}`,
        )

        // Partial output written with the marker
        const mdPath = join(tmp, ROOT, 'apo-1.md')
        const content = readFileSync(mdPath, 'utf-8')
        assert.ok(
          content.includes('[TIMEOUT REACHED]'),
          'md must carry the [TIMEOUT REACHED] marker',
        )
        assert.ok(
          content.includes('partial progress only'),
          'md must include the partial output pulled',
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'pantheon_delegation_read blocks via waitForTerminal, returns md content, marks reconciled',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-read-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })

        await tools.pantheon_delegate.execute({ prompt: 'Find X', agent: 'apollo' }, makeCtx())

        // Read blocks while the job is running…
        const readPromise = tools.pantheon_delegation_read.execute({ id: 'apo-1' }, makeCtx())

        // …and completes once the child reaches a terminal state (session.idle).
        await sleep(20)
        await tools.finalizeDelegation('ses_child_1', { state: 'completed' })

        const content = await readPromise
        assert.ok(
          content.includes('fake assistant output'),
          'read should return the pulled md content',
        )
        assert.ok(content.includes('apo-1'), 'read content should identify the job alias')

        const job = board.get('ses_child_1')!
        assert.equal(job.state, 'reconciled', 'read must mark the job reconciled')
        assert.equal(job.terminalUnreconciled, false)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync('pantheon_delegation_read: unknown ID → clear error message', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'delegation-unknown-'))
    try {
      const board = new BackgroundJobBoard()
      const client = new FakeClient()
      const tools = createDelegationTools({
        board,
        client,
        options: { rootSessions: new Set([ROOT]), outputDir: tmp },
      })

      const result = await tools.pantheon_delegation_read.execute({ id: 'nope' }, makeCtx())
      assert.ok(/unknown|not found/i.test(result), `expected unknown-id message, got: ${result}`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  await testAsync(
    'pantheon_delegation_list: shows [unread] for terminal-unreconciled jobs',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-list-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })

        await tools.pantheon_delegate.execute({ prompt: 'Done task', agent: 'apollo' }, makeCtx())
        await tools.pantheon_delegate.execute(
          { prompt: 'Running task', agent: 'hermes' },
          makeCtx(),
        )
        // One job reaches terminal but is NOT reconciled yet
        await tools.finalizeDelegation('ses_child_1', { state: 'completed' })

        const listing = await tools.pantheon_delegation_list.execute({}, makeCtx())
        assert.ok(listing.includes('[apo-1]'), 'list should show the completed job by alias')
        assert.ok(listing.includes('[unread]'), 'terminal-unreconciled job must carry [unread]')
        assert.ok(!listing.includes('[her-1] [unread]'), 'running job must NOT carry [unread]')

        // After reading (reconcile), the [unread] flag disappears
        await tools.pantheon_delegation_read.execute({ id: 'apo-1' }, makeCtx())
        const listing2 = await tools.pantheon_delegation_list.execute({}, makeCtx())
        assert.ok(!listing2.includes('[unread]'), 'reconciled job must lose the [unread] flag')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'finalize path: session.idle → messages pulled → md written atomically → board completed',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-finalize-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp, timeoutMs: 30 },
        })

        await tools.pantheon_delegate.execute({ prompt: 'Implement X', agent: 'hermes' }, makeCtx())

        // Simulate the event hook observing session.idle on the child.
        const job = await tools.finalizeDelegation('ses_child_1', { state: 'completed' })

        assert.ok(job, 'finalize returns the updated job')
        assert.equal(job!.state, 'completed')
        assert.equal(job!.terminalUnreconciled, true)
        assert.equal(job!.timedOut, false)

        // Messages were pulled from the child session
        assert.deepEqual(client.messagesCalls, ['ses_child_1'])

        // md file written atomically under .pantheon/delegations/<root>/<alias>.md
        const mdPath = join(tmp, ROOT, 'her-1.md')
        const content = readFileSync(mdPath, 'utf-8')
        assert.ok(content.includes('fake assistant output'), 'md must contain the pulled output')
        assert.ok(content.includes('her-1'), 'md must reference the alias')

        // No leftover .tmp files — atomic write (tmp + rename) completed
        const leftovers = readdirSync(join(tmp, ROOT)).filter((f) => f.endsWith('.tmp'))
        assert.deepEqual(leftovers, [], 'no .tmp files may remain after finalize')

        // Timeout timer was cleared — no late timeout can flip the job to error
        // (the armed timeoutMs=30 would have fired during this sleep otherwise)
        await sleep(60)
        assert.equal(board.get('ses_child_1')!.state, 'completed')
        const after = readFileSync(mdPath, 'utf-8')
        assert.ok(!after.includes('[TIMEOUT REACHED]'), 'cleared timer must not stamp the report')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync('finalize on unknown session returns undefined', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'delegation-unknown-finalize-'))
    try {
      const board = new BackgroundJobBoard()
      const client = new FakeClient()
      const tools = createDelegationTools({
        board,
        client,
        options: { rootSessions: new Set([ROOT]), outputDir: tmp },
      })
      const result = await tools.finalizeDelegation('ses_never_created', { state: 'completed' })
      assert.equal(result, undefined)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  await testAsync(
    'path traversal guard (F1): parentSessionID with ../ / \\ is rejected, no file escapes the delegation dir',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-traversal-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })

        // Register jobs with malicious parentSessionIDs directly on the board —
        // simulate an invalid/compromised session ID reaching the finalize path.
        const evilParents = ['../evil', 'evil/session', 'evil\\session']
        let firstEvilJob: BackgroundJobRecord | undefined
        for (const [i, parent] of evilParents.entries()) {
          const taskID = `ses_evil_${i}`
          const record = await board.registerLaunch({
            taskID,
            parentSessionID: parent,
            agent: 'apollo',
            description: 'evil parent',
          })
          firstEvilJob ??= record
          await assert.rejects(
            tools.finalizeDelegation(taskID, { state: 'completed' }),
            /Invalid parentSessionID/,
            `finalize must reject parentSessionID: ${parent}`,
          )
        }

        // Nothing may have escaped the delegation dir — the guard must reject
        // BEFORE any mkdir/write under a traversed path.
        assert.deepEqual(readdirSync(tmp), [], 'no report may be written under a malicious parent')
        assert.ok(
          !existsSync(join(tmp, '..', 'evil')),
          'no directory may be created outside the delegation dir',
        )

        // readDelegationReport must refuse the same malicious parentSessionID.
        assert.ok(firstEvilJob, 'first evil job must have been registered')
        await assert.rejects(
          readDelegationReport(tmp, firstEvilJob),
          /Invalid parentSessionID/,
          'readDelegationReport must reject a traversing parentSessionID',
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'session.create failure (F3): delegate returns error text, no job registered on board',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-createfail-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        client.createError = new Error('fake session.create failure')
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })

        // Tools return errors as TEXT, not thrown — match the module pattern.
        const result = await tools.pantheon_delegate.execute(
          { prompt: 'Do the thing', agent: 'apollo' },
          makeCtx(),
        )

        assert.ok(
          /failed to create/i.test(result),
          `delegate must return a clear error text, got: ${result}`,
        )
        assert.equal(board.list().length, 0, 'no job may be registered when session.create fails')
        assert.equal(
          client.prompted.length,
          0,
          'promptAsync must not fire when session.create fails',
        )
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
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? ': ' + r.error : ''}`)
  }
  console.log(`\nResults: ${passed} passed, ${failed.length} failed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main()

// Keep type imports referenced for toolset shape documentation in editors.
export type { DelegationToolset }
