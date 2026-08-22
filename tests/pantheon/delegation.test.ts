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
import {
  collectRootSessionIDs,
  createDelegationTools,
  type DelegationToolset,
  resolveDelegationBudgets,
  resolveDelegationTimeoutMs,
} from '../../src/pantheon/delegation.ts'
import {
  createEnforcementGuard,
  isDelegationAllowed,
  SessionHierarchyRegistry,
} from '../../src/pantheon/delegation-enforce.ts'
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
  body: {
    agent: string
    model?: { id: string; providerID: string }
    parts: Array<{ type: string; text: string }>
  }
}

class FakeClient {
  created: FakeCreateInput[] = []
  prompted: FakePromptInput[] = []
  messagesCalls: string[] = []
  /** When set, session.create rejects with this error (F3). */
  createError: Error | null = null
  /** Delay session.create to exercise concurrent budget reservations. */
  createDelayMs = 0
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
      if (this.createDelayMs > 0) await sleep(this.createDelayMs)
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

function makeCtx(sessionID = ROOT, agent = 'zeus') {
  return { sessionID, directory: '/tmp', worktree: '/tmp', agent }
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
        assert.equal(job?.state, 'running')
        assert.equal(job?.alias, 'apo-1')
        assert.equal(job?.parentSessionID, ROOT)

        // promptAsync fired on the child WITHOUT noReply (push-less completion)
        assert.equal(client.created.length, 1)
        assert.equal(client.created[0]?.body.parentID, ROOT)
        assert.equal(client.prompted.length, 1)
        assert.equal(client.prompted[0]?.path.id, 'ses_child_1')
        assert.equal(client.prompted[0]?.body.agent, 'apollo')
        assert.equal(client.prompted[0]?.body.parts[0]?.text, 'Find auth patterns')
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
        assert.deepEqual(client.created[0]?.body.model, {
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
        assert.deepEqual(client.created[0]?.body.model, {
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
        assert.deepEqual(client.created[0]?.body.model, {
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
        assert.equal(client.created[0]?.body.model, undefined, 'no model field in create body')
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
    '(P1) resolved provider without API key → child created with fallback opencode-go/deepseek-v4-flash + warn',
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
            // is UNSET → fallback must kick in. The fallback provider
            // (opencode-go) is exempt from the key gate → usable.
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
        assert.deepEqual(client.created[0]?.body.model, {
          id: 'deepseek-v4-flash',
          providerID: 'opencode-go',
        })
        assert.ok(
          warnings.some((w) => /API key/i.test(w) && /fallback|deepseek-v4-flash/i.test(w)),
          `expected a missing-key fallback warning, got: ${warnings.join('; ')}`,
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    '(P1) fallback provider (opencode-go) needs no API key → delegation proceeds even with no keys configured',
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
            // go-openai: resolved provider openai key UNSET. The fallback
            // provider opencode-go is exempt from the key gate (sandbox
            // default, 2026-08-21) → the delegation proceeds via the
            // fallback instead of erroring.
            presetEnv: { PANTHEON_MODEL_PRESET: 'go-openai' },
            logger: { warn: (msg) => warnings.push(msg) },
          },
        })

        const result = await tools.pantheon_delegate.execute(
          { prompt: 'Find X', agent: 'apollo' },
          makeCtx(),
        )

        assert.ok(
          result.includes('apo-1'),
          `delegation proceeds via opencode-go fallback, got: ${result}`,
        )
        assert.equal(client.created.length, 1)
        assert.deepEqual(client.created[0]?.body.model, {
          id: 'deepseek-v4-flash',
          providerID: 'opencode-go',
        })
        assert.ok(
          warnings.some((w) => /API key/i.test(w) && /fallback|deepseek-v4-flash/i.test(w)),
          `expected a missing-key fallback warning, got: ${warnings.join('; ')}`,
        )
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
        assert.deepEqual(client.created[0]?.body.model, {
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
        assert.deepEqual(client.created[0]?.body.model, {
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
      assert.deepEqual(client.created[0]?.body.model, {
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
        assert.deepEqual(client.created[0]?.body.model, {
          id: 'deepseek-v4-flash-free',
          providerID: 'opencode',
        })
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    '(e) promptAsync forwards resolved model to child session',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-prompt-model-'))
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
            presetEnv: { PANTHEON_OPENCODE_API_KEY: 'sk-test' },
          },
        })

        await tools.pantheon_delegate.execute({ prompt: 'Do X', agent: 'apollo' }, makeCtx())

        assert.equal(client.prompted.length, 1, 'promptAsync must be called exactly once')
        const body = client.prompted[0]?.body as {
          agent: string
          model?: { id: string; providerID: string }
          parts: Array<{ type: string; text: string }>
        }
        assert.deepEqual(
          body.model,
          { id: 'deepseek-v4-flash-free', providerID: 'opencode' },
          'promptAsync must receive the resolved model in body.model',
        )
        assert.equal(body.agent, 'apollo')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    '(b) depth guard preserved: a child WE created is rejected even when rootSessions does not contain it',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-depth-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })

        // Root delegates → creates child ses_child_1 (enters knownChildren).
        await tools.pantheon_delegate.execute({ prompt: 'Root task', agent: 'apollo' }, makeCtx())

        // The child we created tries to delegate → rejected: the allowlist
        // does NOT contain ses_child_1, but knownChildren does (fallback).
        await assert.rejects(
          tools.pantheon_delegate.execute(
            { prompt: 'Nested delegation', agent: 'apollo' },
            makeCtx('ses_child_1'),
          ),
          /root session/,
        )
        assert.equal(client.created.length, 1, 'no session may be created for a rejected delegate')
        assert.equal(board.list().length, 1)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    '(b2) depth guard with EMPTY allowlist (post-restart): known child still rejected',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-depth-empty-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        // Simulate a restart before the session.list() seed populated the
        // registry: the allowlist is EMPTY, yet the knownChildren fallback
        // must still block a child we create.
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set<string>(), outputDir: tmp },
        })

        // Resumed root delegates → creates child ses_child_1 (knownChildren).
        await tools.pantheon_delegate.execute(
          { prompt: 'Root task', agent: 'apollo' },
          makeCtx('ses_resumed_root'),
        )

        await assert.rejects(
          tools.pantheon_delegate.execute(
            { prompt: 'Nested delegation', agent: 'apollo' },
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
    '(a) resumed session: in NEITHER rootSessions nor knownChildren → treated as root, can delegate',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-resumed-'))
      try {
        const board = new BackgroundJobBoard()
        const client = new FakeClient()
        // Post-restart: the allowlist is empty (session.created events are
        // not replayed for pre-existing sessions) and the resumed root was
        // never created by THIS tools instance. It must be allowed to
        // delegate — this is the compaction-134 bug scenario.
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set<string>(), outputDir: tmp },
        })

        const result = await tools.pantheon_delegate.execute(
          { prompt: 'Resumed root task', agent: 'apollo' },
          makeCtx('ses_resumed_root'),
        )

        assert.ok(
          result.includes('apo-1'),
          `resumed root must be allowed to delegate, got: ${result}`,
        )
        assert.equal(client.created.length, 1, 'delegation must create a child session')
        assert.equal(board.get('ses_child_1')?.parentSessionID, 'ses_resumed_root')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync('(c) session listed in rootSessions → can delegate', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'delegation-allowlist-'))
    try {
      const board = new BackgroundJobBoard()
      const client = new FakeClient()
      const tools = createDelegationTools({
        board,
        client,
        options: { rootSessions: new Set([ROOT]), outputDir: tmp },
      })

      const result = await tools.pantheon_delegate.execute(
        { prompt: 'Allowlisted root', agent: 'apollo' },
        makeCtx(ROOT),
      )
      assert.ok(result.includes('apo-1'), `allowlisted root must delegate, got: ${result}`)
      assert.equal(client.created.length, 1)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  await testAsync(
    '(d) collectRootSessionIDs: seeds only sessions WITHOUT a parentID (2 roots + 1 child → 2 roots)',
    async () => {
      const roots = collectRootSessionIDs([
        { id: 'ses_root_1' },
        { id: 'ses_root_2', parentID: undefined },
        { id: 'ses_child_1', parentID: 'ses_root_1' },
        { id: 'ses_child_2', parentID: 'ses_root_2' },
      ])
      assert.deepEqual([...roots].sort(), ['ses_root_1', 'ses_root_2'])
      assert.equal(roots.has('ses_child_1'), false, 'children must never be seeded as roots')
      assert.equal(roots.has('ses_child_2'), false)
    },
  )

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

  await testAsync('B2 runtime matrix: root Zeus may delegate', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'delegation-b2-zeus-'))
    try {
      const board = new BackgroundJobBoard()
      const client = new FakeClient()
      const tools = createDelegationTools({
        board,
        client,
        options: { rootSessions: new Set([ROOT]), outputDir: tmp, enforceRuntimeMatrix: true },
      })
      const result = await tools.pantheon_delegate.execute(
        { prompt: 'Zeus dispatch', agent: 'hermes' },
        makeCtx(ROOT, 'zeus'),
      )
      assert.match(result, /her-1/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  await testAsync('B2 runtime matrix: athena/hermes may only delegate to apollo', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'delegation-b2-exceptions-'))
    try {
      const board = new BackgroundJobBoard({ maxConcurrentPerAgent: 10 })
      const client = new FakeClient()
      const tools = createDelegationTools({
        board,
        client,
        options: { rootSessions: new Set([ROOT]), outputDir: tmp, enforceRuntimeMatrix: true },
      })
      await tools.pantheon_delegate.execute(
        { prompt: 'Athena scout', agent: 'apollo' },
        makeCtx(ROOT, 'athena'),
      )
      await tools.pantheon_delegate.execute(
        { prompt: 'Hermes scout', agent: 'apollo' },
        makeCtx(ROOT, 'hermes'),
      )
      for (const caller of ['athena', 'hermes']) {
        await assert.rejects(
          tools.pantheon_delegate.execute(
            { prompt: 'Forbidden', agent: 'zeus' },
            makeCtx(ROOT, caller),
          ),
          /runtime delegation matrix denied/,
        )
      }
      assert.equal(client.created.length, 2)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  await testAsync('B2 runtime matrix: absent ToolContext.agent is fail-closed', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'delegation-b2-no-agent-'))
    try {
      const board = new BackgroundJobBoard()
      const client = new FakeClient()
      const tools = createDelegationTools({
        board,
        client,
        options: { rootSessions: new Set([ROOT]), outputDir: tmp, enforceRuntimeMatrix: true },
      })
      await assert.rejects(
        tools.pantheon_delegate.execute(
          { prompt: 'Unknown caller', agent: 'apollo' },
          { sessionID: ROOT, directory: '/tmp', worktree: '/tmp' },
        ),
        /ToolContext\.agent is unavailable/,
      )
      assert.equal(client.created.length, 0)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  await testAsync(
    'B2 session hierarchy uses parentID and does not classify resumed children as roots',
    async () => {
      const hierarchy = new SessionHierarchyRegistry()
      hierarchy.registerMany([
        { id: 'root_after_restart' },
        { id: 'native_task_child', parentID: 'root_after_restart' },
      ])
      assert.equal(hierarchy.isRoot('root_after_restart'), true)
      assert.equal(hierarchy.isChild('native_task_child'), true)
      assert.equal(hierarchy.isRoot('native_task_child'), false)
      assert.equal(isDelegationAllowed('zeus', 'hermes'), true)
      assert.equal(isDelegationAllowed('athena', 'apollo'), true)
      assert.equal(isDelegationAllowed('hermes', 'apollo'), true)
      assert.equal(isDelegationAllowed('athena', 'hermes'), false)
      assert.equal(isDelegationAllowed(undefined, 'apollo'), false)
    },
  )

  await testAsync(
    'B2 hierarchy seed states are fail-open before/after delayed or failed session.list',
    async () => {
      const hierarchy = new SessionHierarchyRegistry()
      const resumedRoot = 'resumed-root'
      const resumedChild = 'resumed-child'

      hierarchy.beginSeed()
      assert.equal(hierarchy.isRoot(resumedRoot), true)
      assert.equal(hierarchy.isChild(resumedRoot), false)

      hierarchy.completeSeed([{ id: resumedRoot }, { id: resumedChild, parentID: resumedRoot }])
      assert.equal(hierarchy.isRoot(resumedRoot), true)
      assert.equal(hierarchy.isRoot(resumedChild), false)
      assert.equal(hierarchy.isChild(resumedChild), true)

      const failed = new SessionHierarchyRegistry()
      failed.beginSeed()
      failed.failSeed()
      assert.equal(failed.isRoot('root-after-list-failure'), true)
      failed.register({ id: resumedChild, parentID: resumedRoot })
      assert.equal(failed.isRoot(resumedChild), false)
    },
  )

  await testAsync(
    'B2 factory defaults runtime matrix enforcement; legacy mode requires explicit false',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-b2-default-'))
      try {
        const strictTools = createDelegationTools({
          board: new BackgroundJobBoard(),
          client: new FakeClient(),
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })
        await assert.rejects(
          strictTools.pantheon_delegate.execute(
            { prompt: 'Missing identity', agent: 'apollo' },
            { sessionID: ROOT, directory: '/tmp', worktree: '/tmp' },
          ),
          /ToolContext\.agent is unavailable/,
        )

        const legacyTools = createDelegationTools({
          board: new BackgroundJobBoard(),
          client: new FakeClient(),
          options: { rootSessions: new Set([ROOT]), outputDir: tmp, enforceRuntimeMatrix: false },
        })
        const result = await legacyTools.pantheon_delegate.execute(
          { prompt: 'Explicit legacy host', agent: 'apollo' },
          { sessionID: ROOT, directory: '/tmp', worktree: '/tmp' },
        )
        assert.match(result, /apo-1/)
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'B2 native task hook applies root, child, exception, and missing-agent rules',
    async () => {
      const hierarchy = new SessionHierarchyRegistry()
      hierarchy.register({ id: ROOT })
      hierarchy.register({ id: 'native_child', parentID: ROOT })
      const agents = new Map<string, string>([
        [ROOT, 'zeus'],
        ['athena_root', 'athena'],
      ])
      hierarchy.register({ id: 'athena_root' })
      const guard = createEnforcementGuard({
        getReadOnlySessions: () => new Set(),
        options: {
          isRootSession: (sessionID) => hierarchy.isRoot(sessionID),
          isChildSession: (sessionID) => hierarchy.isChild(sessionID),
          getSessionAgent: (sessionID) => agents.get(sessionID),
        },
      })
      await guard(
        { tool: 'task', sessionID: ROOT, callID: 'zeus-task' },
        { args: { subagent_type: 'hermes' } },
      )
      await guard(
        { tool: 'task', sessionID: 'athena_root', callID: 'athena-task' },
        { args: { subagent_type: 'apollo' } },
      )
      await assert.rejects(
        guard(
          { tool: 'task', sessionID: 'native_child', callID: 'child-task' },
          { args: { subagent_type: 'apollo' } },
        ),
        /child session/,
      )
      await assert.rejects(
        guard(
          { tool: 'task', sessionID: 'athena_root', callID: 'bad-task' },
          { args: { subagent_type: 'hermes' } },
        ),
        /runtime matrix|delegation denied/,
      )
      hierarchy.register({ id: 'unknown-root' })
      await assert.rejects(
        guard(
          { tool: 'task', sessionID: 'unknown-root', callID: 'missing-agent' },
          { args: { subagent_type: 'apollo' } },
        ),
        /caller agent is unavailable/,
      )
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
    'B3: athena→apollo and hermes→apollo budgets are per exception and per parent session',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-budget-'))
      try {
        const board = new BackgroundJobBoard({ maxConcurrentPerAgent: 10 })
        const client = new FakeClient()
        const tools = createDelegationTools({
          board,
          client,
          options: {
            rootSessions: new Set([ROOT]),
            outputDir: tmp,
            delegationBudgets: new Map([
              ['athena->apollo', 1],
              ['hermes->apollo', 2],
            ]),
          },
        })

        await tools.pantheon_delegate.execute(
          { prompt: 'Athena scout', agent: 'apollo' },
          makeCtx(ROOT, 'athena'),
        )
        await assert.rejects(
          tools.pantheon_delegate.execute(
            { prompt: 'Athena scout again', agent: 'apollo' },
            makeCtx(ROOT, 'athena'),
          ),
          /budget exhausted.*athena->apollo/i,
        )

        await tools.pantheon_delegate.execute(
          { prompt: 'Hermes scout 1', agent: 'apollo' },
          makeCtx(ROOT, 'hermes'),
        )
        await tools.pantheon_delegate.execute(
          { prompt: 'Hermes scout 2', agent: 'apollo' },
          makeCtx(ROOT, 'hermes'),
        )
        await assert.rejects(
          tools.pantheon_delegate.execute(
            { prompt: 'Hermes scout 3', agent: 'apollo' },
            makeCtx(ROOT, 'hermes'),
          ),
          /budget exhausted.*hermes->apollo/i,
        )
        assert.equal(client.created.length, 3, 'only budgeted child sessions should be created')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'B3: unknown caller agent skips the budget and emits actionable telemetry',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'delegation-budget-unknown-agent-'))
      try {
        const board = new BackgroundJobBoard({ maxConcurrentPerAgent: 10 })
        const client = new FakeClient()
        const warnings: string[] = []
        const tools = createDelegationTools({
          board,
          client,
          options: {
            rootSessions: new Set([ROOT]),
            outputDir: tmp,
            delegationBudgets: new Map([['athena->apollo', 0]]),
            // Legacy structural host: explicitly opt out of the runtime
            // matrix while still exercising the process-scoped budget path.
            enforceRuntimeMatrix: false,
            logger: { warn: (message) => warnings.push(message) },
          },
        })

        // No agent field: neither the target name nor any other local state
        // may be used as a caller identity. The configured budget is skipped.
        await tools.pantheon_delegate.execute(
          { prompt: 'Unknown caller scout', agent: 'apollo' },
          { sessionID: ROOT, directory: '/tmp', worktree: '/tmp' },
        )
        await tools.pantheon_delegate.execute(
          { prompt: 'Unknown caller scout again', agent: 'apollo' },
          { sessionID: ROOT, directory: '/tmp', worktree: '/tmp', agent: '   ' },
        )

        assert.equal(
          client.created.length,
          2,
          'unknown identity must not be falsely budget-rejected',
        )
        const budgetWarnings = warnings.filter((warning) => /B3 budget skipped/i.test(warning))
        assert.equal(budgetWarnings.length, 2)
        assert.ok(budgetWarnings.every((warning) => /no budget limit applied/i.test(warning)))
        assert.ok(budgetWarnings.every((warning) => /ToolContext\.agent/i.test(warning)))
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'B3: budget and timeout environment parsers accept valid values and reject invalid values',
    async () => {
      const budgets = resolveDelegationBudgets({
        PANTHEON_ATHENA_APOLLO_BUDGET: '2',
        PANTHEON_HERMES_APOLLO_BUDGET: '0',
      })
      assert.equal(budgets.get('athena->apollo'), 2)
      assert.equal(budgets.get('hermes->apollo'), 0)
      assert.equal(
        resolveDelegationBudgets({ PANTHEON_ATHENA_APOLLO_BUDGET: '-1' }).get('athena->apollo'),
        5,
      )
      assert.equal(resolveDelegationTimeoutMs({ PANTHEON_DELEGATION_TIMEOUT_MS: '2500' }), 2500)
      assert.equal(
        resolveDelegationTimeoutMs({ PANTHEON_DELEGATION_TIMEOUT_MS: 'not-a-number' }),
        undefined,
      )
    },
  )

  await testAsync('B3: concurrent dispatches reserve the real budget atomically', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'delegation-budget-concurrent-'))
    try {
      const board = new BackgroundJobBoard({ maxConcurrentPerAgent: 10 })
      const client = new FakeClient()
      client.createDelayMs = 15
      const tools = createDelegationTools({
        board,
        client,
        options: {
          rootSessions: new Set([ROOT]),
          outputDir: tmp,
          delegationBudgets: new Map([['athena->apollo', 2]]),
        },
      })

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, (_, index) =>
          tools.pantheon_delegate.execute(
            { prompt: `Concurrent scout ${index}`, agent: 'apollo' },
            makeCtx(ROOT, 'athena'),
          ),
        ),
      )

      assert.equal(client.created.length, 2, 'only two concurrent calls may reserve the budget')
      assert.equal(results.filter((result) => result.status === 'rejected').length, 4)
      assert.equal(board.getRunningCount('apollo'), 2)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

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

        const job = board.get('ses_child_1')
        assert.ok(job)
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

        const job = board.get('ses_child_1')
        assert.ok(job)
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
        assert.equal(job?.state, 'completed')
        assert.equal(job?.terminalUnreconciled, true)
        assert.equal(job?.timedOut, false)

        // Messages were pulled from the child session
        assert.deepEqual(client.messagesCalls, ['ses_child_1', 'ses_child_1'])

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
        assert.equal(board.get('ses_child_1')?.state, 'completed')
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
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? `: ${r.error}` : ''}`)
  }
  console.log(`\nResults: ${passed} passed, ${failed.length} failed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main()

// Keep type imports referenced for toolset shape documentation in editors.
export type { DelegationToolset }
