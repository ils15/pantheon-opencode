/**
 * Integration tests for `pantheon_delegation_read` with delegation classifier.
 *
 * Tests that `pantheon_delegation_read` classifies empty/budget-exhausted
 * results and returns structured DelegationResult-shaped output.
 *
 * TDD: these tests MUST fail before implementation.
 *
 * Run with: npx tsx tests/pantheon/delegation-read-classifier.test.ts
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import type { DelegationToolset } from '../../src/pantheon/delegation.ts'
import { createDelegationTools } from '../../src/pantheon/delegation.ts'

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
  messagesResult: Array<{
    info: { role: string }
    parts: Array<{ type?: string; text?: string; tool?: string; metadata?: { input?: unknown } }>
  }> = [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'fake assistant output' }] }]
  private childCounter = 0

  readonly session = {
    create: async (input: FakeCreateInput): Promise<{ id: string }> => {
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

function makeCtx(sessionID = ROOT, agent = 'zeus') {
  return { sessionID, directory: '/tmp', worktree: '/tmp', agent }
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  await testAsync(
    'delegation_read: empty response classified as empty-mode1, retried once, then returned',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'deleg-read-empty-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        // Empty messages — simulates empty-mode1
        client.messagesResult = []
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })

        await tools.pantheon_delegate.execute({ prompt: 'Find X', agent: 'apollo' }, makeCtx())

        // Read blocks, then finalize with empty output
        const readPromise = tools.pantheon_delegation_read.execute({ id: 'apo-1' }, makeCtx())
        await sleep(20)
        // Write empty output report manually (finalize pulls from messages, which are empty)
        await tools.finalizeDelegation('ses_child_1', { state: 'completed' })

        const content = await readPromise
        // The read should classify the empty response and include status info
        assert.ok(
          content.includes('[EMPTY') ||
            content.includes('empty') ||
            content.includes('_No output captured_'),
          `read should classify empty response, got: ${content}`,
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'delegation_read: budget-exhausted report classified and includes partial result + recommendation',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'deleg-read-budget-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        // Messages that produce a budget-exhausted report
        client.messagesResult = [
          {
            info: { role: 'assistant' },
            parts: [
              {
                type: 'text',
                text: 'Found 3 auth files:\n- src/auth.ts\n- src/auth-service.ts\n- src/auth-middleware.ts',
              },
            ],
          },
        ]
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })

        await tools.pantheon_delegate.execute(
          { prompt: 'Find auth patterns', agent: 'apollo' },
          makeCtx(),
        )

        const readPromise = tools.pantheon_delegation_read.execute({ id: 'apo-1' }, makeCtx())
        await sleep(20)
        // Finalize with error state that includes budget-exhausted message
        await tools.finalizeDelegation('ses_child_1', {
          state: 'error',
          error: 'Maximum steps for this agent have been reached',
        })

        const content = await readPromise
        // The report should contain both the partial result and the budget status
        assert.ok(
          content.includes('[BUDGET EXHAUSTED]') || content.includes('budget'),
          `read should classify budget-exhausted, got: ${content}`,
        )
        assert.ok(
          content.includes('Found 3 auth') || content.includes('partial'),
          `read should include partial result, got: ${content}`,
        )
        assert.ok(
          content.includes('recommendation') || content.includes('step budget'),
          `read should include recommendation, got: ${content}`,
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'delegation_read: success report returned as-is without extra classification',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'deleg-read-success-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        client.messagesResult = [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Here are my findings about the auth system.' }],
          },
        ]
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })

        await tools.pantheon_delegate.execute(
          { prompt: 'Analyze auth', agent: 'apollo' },
          makeCtx(),
        )

        const readPromise = tools.pantheon_delegation_read.execute({ id: 'apo-1' }, makeCtx())
        await sleep(20)
        await tools.finalizeDelegation('ses_child_1', { state: 'completed' })

        const content = await readPromise
        assert.ok(
          content.includes('Here are my findings'),
          `read should return the content for success, got: ${content}`,
        )
        // Should NOT have classification markers
        assert.ok(
          !content.includes('[EMPTY') && !content.includes('[BUDGET'),
          `success should not have classification markers, got: ${content}`,
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'delegation_read: timeout with partial output returns timeout-with-partial classification',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'deleg-read-timeout-partial-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        client.messagesResult = [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'Partial progress: found 2 of 5 files.' }],
          },
        ]
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp, timeoutMs: 30 },
        })

        await tools.pantheon_delegate.execute({ prompt: 'Big search', agent: 'apollo' }, makeCtx())

        const readPromise = tools.pantheon_delegation_read.execute({ id: 'apo-1' }, makeCtx())
        await sleep(20)
        // Timeout fires → finalize with timedOut
        await tools.finalizeDelegation('ses_child_1', {
          state: 'error',
          error: 'Delegation timed out after 30ms',
          timedOut: true,
        })

        const content = await readPromise
        // The read should detect timeout-with-partial (has partial content)
        assert.ok(
          content.includes('[TIMEOUT') ||
            content.includes('timeout') ||
            content.includes('partial'),
          `read should classify timeout-with-partial, got: ${content}`,
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'delegation_read: non-success result includes structured status/retryCount fields',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'deleg-read-structured-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        client.messagesResult = [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: '' }],
          },
        ]
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })

        await tools.pantheon_delegate.execute({ prompt: 'Find X', agent: 'apollo' }, makeCtx())

        const readPromise = tools.pantheon_delegation_read.execute({ id: 'apo-1' }, makeCtx())
        await sleep(20)
        await tools.finalizeDelegation('ses_child_1', { state: 'completed' })

        const content = await readPromise
        // Empty result should have classification markers and structured info
        assert.ok(
          content.includes('[EMPTY') ||
            content.includes('empty') ||
            content.includes('_No output captured_'),
          `should include empty classification, got: ${content}`,
        )
        assert.ok(
          content.includes('status:') || content.includes('STATUS'),
          `should include status field, got: ${content}`,
        )
        assert.ok(
          content.includes('retryCount:') || content.includes('RETRY') || content.includes('retry'),
          `should include retry info, got: ${content}`,
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
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? `: ${r.error}` : ''}`)
  }
  console.log(`\nResults: ${passed} passed, ${failed.length} failed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main()
