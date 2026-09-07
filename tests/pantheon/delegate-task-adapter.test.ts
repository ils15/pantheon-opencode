/**
 * WS1 — V1 session task adapter tests (delegate-task-adapter.ts).
 *
 * Covers createSessionTaskFn over a fake V1 client + the real board +
 * finalizeDelegation (simulated idle hook), plus the native toolset wiring:
 * kill-switch, depth guard, create-failure TEXT, read/list passthrough.
 *
 * Run with: npx tsx tests/pantheon/delegate-task-adapter.test.ts
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import { createDelegateManager } from '../../src/pantheon/delegate-manager.ts'
import {
  createNativeDelegateTools,
  createSessionTaskFn,
  extractOutputSection,
  parseModelRef,
  resolveDelegateMode,
  withDelegationKillSwitch,
} from '../../src/pantheon/delegate-task-adapter.ts'
import {
  type DelegationClient,
  type DelegationMessageBundle,
  finalizeDelegation,
} from '../../src/pantheon/delegation-finalize.ts'

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

const ASSISTANT_BUNDLES: DelegationMessageBundle[] = [
  {
    info: { role: 'assistant' },
    parts: [{ type: 'text', text: 'adapter verified output' }],
  },
]

interface FakeClientOptions {
  messages?: DelegationMessageBundle[]
  promptImpl?: (childID: string) => Promise<unknown>
  createImpl?: (parentID: string) => Promise<{ id: string }>
}

function fakeClient(
  board: BackgroundJobBoard,
  outputDir: string,
  opts: FakeClientOptions = {},
): DelegationClient & { created: string[] } {
  let seq = 0
  const created: string[] = []
  const client = {
    created,
    session: {
      create: async (input: { body: { parentID: string } }): Promise<{ id: string }> => {
        if (opts.createImpl) return opts.createImpl(input.body.parentID)
        seq += 1
        const id = `child-${seq}`
        created.push(id)
        return { id }
      },
      promptAsync: async (input: { path: { id: string } }): Promise<unknown> => {
        const childID = input.path.id
        if (opts.promptImpl) return opts.promptImpl(childID)
        // Simulate the V1 idle hook: finalize shortly after acceptance.
        setTimeout(() => {
          void finalizeDelegation(
            { board, client: client as DelegationClient, options: { outputDir } },
            childID,
            { state: 'completed' },
          )
        }, 5)
        return { accepted: true }
      },
      messages: async (): Promise<DelegationMessageBundle[]> => opts.messages ?? ASSISTANT_BUNDLES,
    },
  }
  return client as DelegationClient & { created: string[] }
}

async function main(): Promise<void> {
  await testAsync('adapter e2e: prompt→finalize→verified MD→reconciled', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-e2e-'))
    const outputDir = join(dir, 'delegations')
    const signalDir = join(dir, 'signals')
    const board = new BackgroundJobBoard({ signalDir })
    const client = fakeClient(board, outputDir)
    const task = createSessionTaskFn({ client, board, outputDir, settleTimeoutMs: 5_000 })
    const mgr = createDelegateManager({ board, task, parentSessionID: 'ses_root', env: {} })
    const created = await client.session.create({ body: { parentID: 'ses_root' } })
    const receipt = await mgr.launch({ agent: 'apollo', prompt: 'scout', taskID: created.id })
    assert.equal(receipt.state, 'reconciled')
    assert.match(receipt.line, /\[pantheon:apo-1\]/)
    const job = board.get(created.id)
    assert.equal(job?.state, 'reconciled')
    assert.equal(existsSync(join(signalDir, `${job?.alias}.signal.json`)), false)
    const mdFiles = readdirSync(join(outputDir, 'ses_root'))
    assert.deepEqual(mdFiles, [`${job?.alias}.md`])
    const report = await mgr.read(created.id)
    assert.match(report, /adapter verified output/)
  })

  await testAsync('adapter: prompt rejected → manager records error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-rej-'))
    const outputDir = join(dir, 'delegations')
    const board = new BackgroundJobBoard()
    const client = fakeClient(board, outputDir, {
      promptImpl: async () => {
        throw new Error('host quota exceeded')
      },
    })
    const task = createSessionTaskFn({ client, board, outputDir, settleTimeoutMs: 2_000 })
    const mgr = createDelegateManager({ board, task, parentSessionID: 'ses_root', env: {} })
    const receipt = await mgr.launch({ agent: 'hermes', prompt: 'x', taskID: 'child-9' })
    assert.equal(receipt.state, 'error')
    assert.match(receipt.line, /host quota exceeded/)
  })

  await testAsync('adapter: terminal without MD falls back to resultSummary', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-sum-'))
    const outputDir = join(dir, 'delegations')
    const board = new BackgroundJobBoard()
    const client = fakeClient(board, outputDir, {
      promptImpl: async (childID) => {
        setTimeout(() => {
          void board.updateStatus({
            taskID: childID,
            state: 'completed',
            resultSummary: 'manual summary',
          })
        }, 5)
        return { accepted: true }
      },
    })
    const task = createSessionTaskFn({ client, board, outputDir, settleTimeoutMs: 2_000 })
    const mgr = createDelegateManager({ board, task, parentSessionID: 'ses_root', env: {} })
    const receipt = await mgr.launch({ agent: 'nyx', prompt: 'x', taskID: 'child-7' })
    assert.equal(receipt.state, 'reconciled')
    const report = await mgr.read('child-7')
    assert.match(report, /manual summary/)
  })

  await testAsync('adapter: terminal with no content anywhere → not verified', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-empty-'))
    const outputDir = join(dir, 'delegations')
    const board = new BackgroundJobBoard()
    const client = fakeClient(board, outputDir, {
      promptImpl: async (childID) => {
        setTimeout(() => {
          void board.updateStatus({ taskID: childID, state: 'completed' })
        }, 5)
        return { accepted: true }
      },
    })
    const task = createSessionTaskFn({ client, board, outputDir, settleTimeoutMs: 2_000 })
    const mgr = createDelegateManager({ board, task, parentSessionID: 'ses_root', env: {} })
    const receipt = await mgr.launch({ agent: 'talos', prompt: 'x', taskID: 'child-3' })
    assert.equal(receipt.state, 'error')
    assert.match(receipt.line, /not verified/i)
  })

  await testAsync('parseModelRef + extractOutputSection units', async () => {
    assert.deepEqual(parseModelRef('opencode/deepseek-v4-flash-free'), {
      providerID: 'opencode',
      id: 'deepseek-v4-flash-free',
    })
    assert.equal(parseModelRef('no-slash'), undefined)
    assert.equal(parseModelRef('/empty'), undefined)
    const md = '# Delegation Report — apo-1\n\n## Output\n\nhello world\n\n**Error**: boom\n'
    assert.equal(extractOutputSection(md), 'hello world')
    assert.equal(extractOutputSection(undefined), '')
  })

  await testAsync('native tools: kill-switch blocks delegate/read/list', async () => {
    const board = new BackgroundJobBoard()
    const client = fakeClient(board, mkdtempSync(join(tmpdir(), 'adapter-kill-')))
    const tools = createNativeDelegateTools({
      board,
      client,
      env: { PANTHEON_DELEGATION: 'off' },
      isRootSession: () => true,
    })
    await assert.rejects(
      () => tools.pantheon_delegate.execute({ prompt: 'x', agent: 'apollo' }, { sessionID: 's' }),
      /disabled/,
    )
    await assert.rejects(
      () => tools.pantheon_delegation_read.execute({ id: 'apo-1' }, { sessionID: 's' }),
      /disabled/,
    )
    await assert.rejects(
      () => tools.pantheon_delegation_list.execute({}, { sessionID: 's' }),
      /disabled/,
    )
  })

  await testAsync('native tools: sub-session delegate rejected', async () => {
    const board = new BackgroundJobBoard()
    const client = fakeClient(board, mkdtempSync(join(tmpdir(), 'adapter-depth-')))
    const tools = createNativeDelegateTools({
      board,
      client,
      env: {},
      isRootSession: (id) => id === 'ses_root',
    })
    await assert.rejects(
      () =>
        tools.pantheon_delegate.execute({ prompt: 'x', agent: 'apollo' }, { sessionID: 'child-1' }),
      /sub-session/,
    )
    assert.equal(client.created.length, 0, 'no child created for rejected dispatch')
  })

  await testAsync('native tools: create failure returns TEXT error', async () => {
    const board = new BackgroundJobBoard()
    const client = fakeClient(board, mkdtempSync(join(tmpdir(), 'adapter-create-')), {
      createImpl: async () => {
        throw new Error('sdk down')
      },
    })
    const tools = createNativeDelegateTools({ board, client, env: {}, isRootSession: () => true })
    const out = await tools.pantheon_delegate.execute(
      { prompt: 'x', agent: 'apollo' },
      { sessionID: 's' },
    )
    assert.match(out, /session\.create rejected: sdk down/)
  })

  await testAsync('native tools: delegate→read→list roundtrip', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-tools-'))
    const outputDir = join(dir, 'delegations')
    const board = new BackgroundJobBoard()
    const client = fakeClient(board, outputDir)
    const seen: string[] = []
    const tools = createNativeDelegateTools({
      board,
      client,
      outputDir,
      env: {},
      isRootSession: () => true,
      registerChildSession: (id, parent) => seen.push(`${parent}>${id}`),
    })
    const line = await tools.pantheon_delegate.execute(
      { prompt: 'do work', agent: 'demeter', description: 'migration' },
      { sessionID: 'ses_root' },
    )
    assert.match(line, /\[pantheon:dem-1\]/)
    assert.deepEqual(seen, ['ses_root>child-1'])
    const report = await tools.pantheon_delegation_read.execute(
      { id: 'dem-1' },
      { sessionID: 'ses_root' },
    )
    assert.match(report, /adapter verified output/)
    const list = await tools.pantheon_delegation_list.execute({}, { sessionID: 'ses_root' })
    assert.match(list, /\[pantheon:dem-1\]/)
    const empty = createNativeDelegateTools({
      board: new BackgroundJobBoard(),
      client,
      env: {},
      isRootSession: () => true,
    })
    assert.equal(
      await empty.pantheon_delegation_list.execute({}, { sessionID: 'other' }),
      'No delegations.',
    )
  })

  // ─── Mode gate + kill-switch helper ──────────────────────────────────

  await testAsync('resolveDelegateMode: default + garbage → legacy (V1 intacto)', async () => {
    assert.equal(resolveDelegateMode({}), 'legacy')
    assert.equal(resolveDelegateMode({ PANTHEON_DELEGATE_MODE: 'legacy' }), 'legacy')
    assert.equal(resolveDelegateMode({ PANTHEON_DELEGATE_MODE: 'bogus' }), 'legacy')
    assert.equal(resolveDelegateMode({ PANTHEON_DELEGATE_MODE: 'native' }), 'native')
    assert.equal(resolveDelegateMode({ PANTHEON_DELEGATE_MODE: ' Native ' }), 'native')
    assert.equal(resolveDelegateMode({ PANTHEON_DELEGATE_MODE: 'NATIVE' }), 'native')
  })

  await testAsync(
    'withDelegationKillSwitch: off blocks tools, passes finalizeDelegation through',
    async () => {
      let calls = 0
      const finalize = async (_childID: string) => {
        calls += 1
        return calls
      }
      const toolset = {
        pantheon_delegate: {
          description: 'd',
          args: {},
          execute: async () => 'launched',
        },
        finalizeDelegation: finalize,
      }
      const wrapped = withDelegationKillSwitch(toolset, { PANTHEON_DELEGATION: 'off' })
      await assert.rejects(
        () => wrapped.pantheon_delegate.execute({}, { sessionID: 's' }),
        /disabled/,
      )
      assert.equal(await wrapped.finalizeDelegation('child-1'), 1, 'observer never kill-switched')
      assert.notEqual(wrapped.pantheon_delegate, toolset.pantheon_delegate, 'returns a new object')
    },
  )

  await testAsync('withDelegationKillSwitch: enabled is a transparent passthrough', async () => {
    const toolset = {
      pantheon_delegation_list: {
        description: 'l',
        args: {},
        execute: async () => 'No delegations.',
      },
    }
    const wrapped = withDelegationKillSwitch(toolset, {})
    assert.equal(
      await wrapped.pantheon_delegation_list.execute({}, { sessionID: 's' }),
      'No delegations.',
    )
  })

  await testAsync(
    'native tools: read-only agent registers session with agent identity',
    async () => {
      const board = new BackgroundJobBoard()
      const client = fakeClient(board, mkdtempSync(join(tmpdir(), 'adapter-ro-')))
      const seen: { id: string; agent: string; flag?: boolean }[] = []
      const tools = createNativeDelegateTools({
        board,
        client,
        env: {},
        isRootSession: () => true,
        isReadOnlyAgent: (agent) => agent.toLowerCase() === 'apollo',
        registerReadOnlySession: (id, info) =>
          seen.push({ id, agent: info.agent, flag: info.readOnlyFlag }),
      })
      await tools.pantheon_delegate.execute(
        { prompt: 'scout', agent: 'apollo' },
        { sessionID: 'ses_root' },
      )
      assert.equal(seen.length, 1)
      assert.equal(seen[0]?.agent, 'apollo')
      await tools.pantheon_delegate.execute(
        { prompt: 'build', agent: 'hermes' },
        { sessionID: 'ses_root' },
      )
      assert.equal(seen.length, 1, 'write-capable agent is not registered read-only')
    },
  )

  // ─── Report ────────────────────────────────────────────────────────────

  const failed = results.filter((r) => !r.passed)
  for (const r of results) {
    if (r.passed) console.log(`ok - ${r.name}`)
    else console.log(`FAIL - ${r.name}\n  ${r.error}`)
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) process.exit(1)
}

main()
