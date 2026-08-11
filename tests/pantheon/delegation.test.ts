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
import { loadRoutingAgentModels } from '../../src/pantheon/presets.mjs'

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
  /** When set, session.messages rejects with this error (fail-open paths). */
  messagesError: Error | null = null
  messagesResult: Array<{
    info: { role: string }
    parts: Array<{ type?: string; text?: string; tool?: string; metadata?: { input?: unknown } }>
  }> = [{ info: { role: 'assistant' }, parts: [{ type: 'text', text: 'fake assistant output' }] }]
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
      if (this.messagesError) throw this.messagesError
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
            // opencode provider requires PANTHEON_OPENCODE_API_KEY (routing.yml)
            presetEnv: { PANTHEON_OPENCODE_API_KEY: 'sk-test' },
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
            // opencode provider requires PANTHEON_OPENCODE_API_KEY (routing.yml).
            presetEnv: {
              PANTHEON_MODEL_PRESET: 'go-deepseek',
              PANTHEON_OPENCODE_API_KEY: 'sk-test',
            },
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

  await testAsync(
    '(P1) resolved provider without API key → child created with fallback opencode/deepseek-v4-flash-free + warn',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-key-fallback-'))
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
            // go-openai: apollo → openai/gpt-5.6-luna-fast. PANTHEON_OPENAI_API_KEY
            // is UNSET → fallback must kick in. The fallback provider (opencode)
            // IS configured → usable.
            presetEnv: {
              PANTHEON_MODEL_PRESET: 'go-openai',
              PANTHEON_OPENCODE_API_KEY: 'sk-fallback',
            },
            logger: { warn: (msg) => warnings.push(msg) },
          },
        })

        const result = await tools.pantheon_delegate.execute(
          { prompt: 'Find X', agent: 'apollo' },
          makeCtx(),
        )

        assert.ok(result.includes('apo-1'), `delegation proceeds via fallback, got: ${result}`)
        assert.equal(client.created.length, 1)
        assert.deepEqual(client.created[0]!.body.model, {
          id: 'deepseek-v4-flash-free',
          providerID: 'opencode',
        })
        assert.ok(
          warnings.some((w) => /API key/i.test(w) && /fallback|deepseek-v4-flash-free/i.test(w)),
          `expected a missing-key fallback warning, got: ${warnings.join('; ')}`,
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    '(P1) fallback provider ALSO without API key → clear error TEXT, NO job on board',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-key-none-'))
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
            // go-openai: resolved provider openai key UNSET; fallback provider
            // opencode key ALSO unset → no usable model at all.
            presetEnv: { PANTHEON_MODEL_PRESET: 'go-openai' },
            logger: { warn: (msg) => warnings.push(msg) },
          },
        })

        const result = await tools.pantheon_delegate.execute(
          { prompt: 'Find X', agent: 'apollo' },
          makeCtx(),
        )

        assert.ok(/no usable model/i.test(result), `expected clear error text, got: ${result}`)
        assert.match(result, /PANTHEON_OPENAI_API_KEY/, 'error must name the missing env var')
        assert.equal(client.created.length, 0, 'no session may be created without a usable model')
        assert.equal(board.list().length, 0, 'no job may be registered when creation fails')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    '(P1) resolved provider WITH API key configured → resolved model used normally, no warning',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-key-present-'))
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
            presetEnv: {
              PANTHEON_MODEL_PRESET: 'go-openai',
              PANTHEON_OPENAI_API_KEY: 'sk-openai',
            },
            logger: { warn: (msg) => warnings.push(msg) },
          },
        })

        await tools.pantheon_delegate.execute({ prompt: 'Find X', agent: 'apollo' }, makeCtx())

        assert.equal(client.created.length, 1)
        assert.deepEqual(client.created[0]!.body.model, {
          id: 'gpt-5.6-luna-fast',
          providerID: 'openai',
        })
        assert.equal(warnings.length, 0, 'key present — no warning expected')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    '(P1) EXPLICIT model in the tool call is respected even without provider key (warn only)',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-key-explicit-'))
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
            // Empty env: openai key is missing, but the explicit model wins.
            presetEnv: {},
            logger: { warn: (msg) => warnings.push(msg) },
          },
        })

        await tools.pantheon_delegate.execute(
          { prompt: 'Find X', agent: 'apollo', model: 'openai/gpt-5.6-terra' },
          makeCtx(),
        )

        assert.equal(client.created.length, 1)
        assert.deepEqual(client.created[0]!.body.model, {
          id: 'gpt-5.6-terra',
          providerID: 'openai',
        })
        assert.ok(
          warnings.some((w) => /API key/i.test(w)),
          `explicit model must still warn on the missing key, got: ${warnings.join('; ')}`,
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync('(d) precedence: explicit model option beats options.agentModels', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'delegation-precedence-'))
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
          // agentModels is present, but the explicit caller model must win.
          agentModels: { apollo: 'opencode/deepseek-v4-flash-free' },
          // Empty env: openai key is missing — the explicit model is still
          // respected (warned, never overridden).
          presetEnv: {},
          logger: { warn: (msg) => warnings.push(msg) },
        },
      })

      await tools.pantheon_delegate.execute(
        { prompt: 'Find X', agent: 'apollo', model: 'openai/gpt-5.6-terra' },
        makeCtx(),
      )

      assert.equal(client.created.length, 1)
      assert.deepEqual(client.created[0]!.body.model, {
        id: 'gpt-5.6-terra',
        providerID: 'openai',
      })
      assert.ok(
        warnings.some((w) => /API key/i.test(w)),
        `explicit model wins but must still warn on the missing key, got: ${warnings.join('; ')}`,
      )
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  await testAsync(
    '(c) integration: agentModels built from routing.yml (loadRoutingAgentModels) drives branch (b)',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-routing-models-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        const tools = createDelegationTools({
          board,
          client,
          options: {
            rootSessions: new Set([ROOT]),
            outputDir: tmp,
            // Same source the plugin wires (Fase 6): routing.yml's default
            // agent→model mapping. The opencode provider requires
            // PANTHEON_OPENCODE_API_KEY (routing.yml go-deepseek apiKeyEnv).
            agentModels: loadRoutingAgentModels(),
            presetEnv: { PANTHEON_OPENCODE_API_KEY: 'sk-test' },
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
    '(a) read collects child activity during the wait and includes ## Agent Activity in the result',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-activity-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })

        await tools.pantheon_delegate.execute({ prompt: 'Find X', agent: 'apollo' }, makeCtx())
        // Read blocks while running — the wait samples the child's messages
        const readPromise = tools.pantheon_delegation_read.execute({ id: 'apo-1' }, makeCtx())
        await sleep(20)
        await tools.finalizeDelegation('ses_child_1', { state: 'completed' })

        const content = await readPromise
        assert.ok(
          content.includes('## Agent Activity'),
          'read result must include the activity section',
        )
        assert.ok(
          content.includes('fake assistant output'),
          'activity must surface the child assistant text',
        )
        assert.ok(
          !content.includes('_no activity captured_'),
          'activity section must not be empty when messages are available',
        )
        // Report body stays intact (backward compatible)
        assert.ok(content.includes('## Output'), 'report markdown must remain present')
        assert.ok(content.includes('apo-1'), 'report must still identify the alias')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    '(b) activity with a tool call shows the tool name + truncated args',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-activity-tool-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        client.messagesResult = [
          {
            info: { role: 'assistant' },
            parts: [
              {
                type: 'tool',
                tool: 'bash',
                metadata: { input: 'grep -rn "search term" src/ --include="*.ts"' },
              },
            ],
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
        assert.ok(content.includes('tool: bash'), `activity must name the tool, got: ${content}`)
        assert.ok(content.includes('grep -rn'), 'activity must include the (truncated) tool args')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    '(c) read is fail-open: session.messages throwing → report as before, no activity section, no crash',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-activity-failopen-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        client.messagesError = new Error('fake messages failure')
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
        assert.ok(
          !content.includes('## Agent Activity'),
          'no activity section when messages are unavailable',
        )
        assert.ok(content.includes('## Output'), 'report markdown still returned')
        assert.ok(content.includes('apo-1'), 'report still identifies the alias')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'read with empty/unreadable messages → ## Agent Activity with _no activity captured_',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-activity-empty-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        client.messagesResult = []
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
        assert.ok(content.includes('## Agent Activity'), 'section must be present')
        assert.ok(
          content.includes('_no activity captured_'),
          'empty messages must render the no-activity marker',
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    '(d) list: running job shows `last activity:` line; unavailable messages keep current format',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-list-activity-'))
      try {
        // Running job WITH session.messages → last activity line present
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })
        await tools.pantheon_delegate.execute(
          { prompt: 'Running task', agent: 'hermes' },
          makeCtx(),
        )
        const listing = await tools.pantheon_delegation_list.execute({}, makeCtx())
        assert.ok(listing.includes('[her-1]'), 'list shows the running job')
        assert.ok(listing.includes('last activity:'), 'running job must show a last activity line')
        assert.ok(
          listing.includes('fake assistant output'),
          'last activity line surfaces the assistant text',
        )

        // Running job WITHOUT session.messages (throwing) → current format, no activity line
        const board2 = new BackgroundJobBoard()
        const client2 = new FakeClient()
        client2.messagesError = new Error('fake messages failure')
        const tools2 = createDelegationTools({
          board: board2,
          client: client2,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })
        await tools2.pantheon_delegate.execute(
          { prompt: 'Running task', agent: 'hermes' },
          makeCtx(),
        )
        const listing2 = await tools2.pantheon_delegation_list.execute({}, makeCtx())
        assert.ok(listing2.includes('[her-1]'), 'list still shows the running job')
        assert.ok(
          !listing2.includes('last activity:'),
          'no last activity line when messages are unavailable',
        )

        // Terminal jobs never show activity lines
        await tools.finalizeDelegation('ses_child_1', { state: 'completed' })
        const listing3 = await tools.pantheon_delegation_list.execute({}, makeCtx())
        assert.ok(listing3.includes('[unread]'), 'terminal job keeps its flags')
        assert.ok(
          !listing3.includes('last activity:'),
          'terminal jobs keep the current format (no activity line)',
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    '(e) truncation: long activity message is cut at ~200 chars without breaking',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-activity-trunc-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        client.messagesResult = [
          {
            info: { role: 'assistant' },
            parts: [{ type: 'text', text: 'L'.repeat(500) }],
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
        const activitySection = content.slice(content.indexOf('## Agent Activity'))
        const activityLine = activitySection.split('\n').find((l) => l.startsWith('- '))
        assert.ok(activityLine !== undefined, 'activity section must have a line')
        assert.ok(
          activityLine.slice(2).length <= 200,
          `activity line must be truncated to ~200 chars, got ${activityLine.slice(2).length}`,
        )
        // The report's Output section keeps the full text — truncation applies
        // to the ACTIVITY line only.
        assert.ok(
          !activitySection.includes('L'.repeat(500)),
          'activity must truncate the long message',
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

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
