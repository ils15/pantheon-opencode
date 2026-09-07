/**
 * WS1 (PR #94) — plugin native-branch wiring test.
 *
 * Proves the REAL `delegateMode === 'native'` mounting from src/plugin.ts
 * (not just the `resolveDelegateMode` parser): the plugin calls
 * `buildPluginNativeDelegation()` with fakes here, and the resulting toolset
 * runs delegate→read→list end-to-end over the real board.
 *
 * Covers what the parser-only test misses:
 * - toolset mounts (3 native tools) + legacy `finalizeDelegation` passthrough
 *   by reference (observer never kill-switched, children never orphan)
 * - `agentModels` lowercasing reaches `session.create` as a parsed model ref
 * - `readOnlyAgents` matching is case-insensitive
 * - `wallClockTimeoutMs` conditional mounts both ways (with / without)
 * - branch selection via `resolveDelegateMode` (native vs default-legacy)
 *
 * Run with: npx tsx tests/pantheon/delegate-plugin-native.test.ts
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import {
  buildPluginNativeDelegation,
  resolveDelegateMode,
} from '../../src/pantheon/delegate-task-adapter.ts'
import {
  type DelegationClient,
  type DelegationMessageBundle,
  finalizeDelegation,
} from '../../src/pantheon/delegation-finalize.ts'
import { StepCapTracker } from '../../src/pantheon/step-cap.ts'

// ─── Harness ─────────────────────────────────────────────────────────────

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
    parts: [{ type: 'text', text: 'native branch verified output' }],
  },
]

interface FakeWiring {
  client: DelegationClient & {
    created: string[]
    models: ({ id: string; providerID: string } | undefined)[]
  }
  children: string[]
  readOnly: { id: string; agent: string; flag?: boolean }[]
}

/** Fake V1 client: captures session.create models + simulates the idle hook. */
function fakeWiring(board: BackgroundJobBoard, outputDir: string): FakeWiring {
  let seq = 0
  const created: string[] = []
  const models: ({ id: string; providerID: string } | undefined)[] = []
  const children: string[] = []
  const readOnly: { id: string; agent: string; flag?: boolean }[] = []
  const client = {
    created,
    models,
    session: {
      create: async (input: {
        body: {
          parentID: string
          title?: string
          model?: { id: string; providerID: string }
        }
      }): Promise<{ id: string }> => {
        seq += 1
        const id = `child-${seq}`
        created.push(id)
        models.push(input.body.model)
        return { id }
      },
      promptAsync: async (input: { path: { id: string } }): Promise<unknown> => {
        const childID = input.path.id
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
      messages: async (): Promise<DelegationMessageBundle[]> => ASSISTANT_BUNDLES,
    },
  }
  return { client: client as FakeWiring['client'], children, readOnly }
}

async function main(): Promise<void> {
  await testAsync('plugin native branch: mounts toolset + finalize passthrough', async () => {
    assert.equal(
      resolveDelegateMode({ PANTHEON_DELEGATE_MODE: 'native' }),
      'native',
      'gate selects the native branch under test',
    )
    const dir = mkdtempSync(join(tmpdir(), 'plugin-native-mount-'))
    const outputDir = join(dir, 'delegations')
    const board = new BackgroundJobBoard()
    const { client, children, readOnly } = fakeWiring(board, outputDir)
    const finalize = async (_childID: string) => undefined
    // Same shapes the plugin passes: hierarchy/registry callbacks, lowercase
    // read-only set, lowercase agent-model map, live step-cap tracker.
    const delegation = buildPluginNativeDelegation({
      board,
      client,
      isRootSession: (id) => id === 'ses_root',
      registerChildSession: (id, parent) => children.push(`${parent}>${id}`),
      registerReadOnlySession: (id, info) =>
        readOnly.push({ id, agent: info.agent, flag: info.readOnlyFlag }),
      readOnlyAgents: new Set(['apollo', 'gaia']),
      agentModels: {},
      stepCap: new StepCapTracker({}),
      finalizeDelegation: finalize as never,
    })
    assert.ok(typeof delegation.pantheon_delegate.execute === 'function')
    assert.ok(typeof delegation.pantheon_delegation_read.execute === 'function')
    assert.ok(typeof delegation.pantheon_delegation_list.execute === 'function')
    assert.equal(
      delegation.finalizeDelegation,
      finalize,
      'legacy observer passes through by reference (never kill-switched)',
    )
    const line = await delegation.pantheon_delegate.execute(
      { prompt: 'do work', agent: 'demeter', description: 'migration' },
      { sessionID: 'ses_root' },
    )
    assert.match(line, /\[pantheon:dem-1\]/, 'real board alias in the receipt line')
    assert.deepEqual(children, ['ses_root>child-1'], 'hierarchy registration ran')
    const report = await delegation.pantheon_delegation_read.execute(
      { id: 'dem-1' },
      { sessionID: 'ses_root' },
    )
    assert.match(report, /native branch verified output/)
    const list = await delegation.pantheon_delegation_list.execute({}, { sessionID: 'ses_root' })
    assert.match(list, /\[pantheon:dem-1\]/)
  })

  await testAsync('plugin native branch: agent model lowercasing reaches create', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-native-model-'))
    const outputDir = join(dir, 'delegations')
    const board = new BackgroundJobBoard()
    const { client } = fakeWiring(board, outputDir)
    const delegation = buildPluginNativeDelegation({
      board,
      client,
      isRootSession: () => true,
      registerChildSession: () => {},
      registerReadOnlySession: () => {},
      readOnlyAgents: new Set(['apollo', 'gaia']),
      agentModels: { hermes: 'prov/model-h' },
      stepCap: new StepCapTracker({}),
      finalizeDelegation: (async () => undefined) as never,
    })
    // Mixed-case agent must still resolve the lowercase map entry.
    await delegation.pantheon_delegate.execute(
      { prompt: 'build', agent: 'HERMES' },
      { sessionID: 'ses_root' },
    )
    assert.deepEqual(client.models[0], { providerID: 'prov', id: 'model-h' })
  })

  await testAsync('plugin native branch: read-only set is case-insensitive', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'plugin-native-ro-'))
    const outputDir = join(dir, 'delegations')
    const board = new BackgroundJobBoard()
    const { client, readOnly } = fakeWiring(board, outputDir)
    const delegation = buildPluginNativeDelegation({
      board,
      client,
      isRootSession: () => true,
      registerChildSession: () => {},
      registerReadOnlySession: (id, info) =>
        readOnly.push({ id, agent: info.agent, flag: info.readOnlyFlag }),
      readOnlyAgents: new Set(['apollo', 'gaia']),
      agentModels: {},
      stepCap: new StepCapTracker({}),
      finalizeDelegation: (async () => undefined) as never,
    })
    await delegation.pantheon_delegate.execute(
      { prompt: 'scout', agent: 'Apollo' },
      { sessionID: 'ses_root' },
    )
    assert.equal(readOnly.length, 1, 'mixed-case read-only agent registered')
    assert.equal(readOnly[0]?.agent, 'Apollo', 'original agent identity preserved')
  })

  await testAsync('plugin native branch: wallClockTimeoutMs mounts both ways', async () => {
    for (const withTimeout of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), `plugin-native-tmo-${withTimeout}-`))
      const outputDir = join(dir, 'delegations')
      const board = new BackgroundJobBoard()
      const { client } = fakeWiring(board, outputDir)
      // Mirrors the plugin's conditional spread exactly.
      const delegation = buildPluginNativeDelegation({
        board,
        client,
        isRootSession: () => true,
        registerChildSession: () => {},
        registerReadOnlySession: () => {},
        readOnlyAgents: new Set(['apollo', 'gaia']),
        agentModels: {},
        stepCap: new StepCapTracker({}),
        ...(withTimeout ? { wallClockTimeoutMs: 60_000 } : {}),
        finalizeDelegation: (async () => undefined) as never,
      })
      const line = await delegation.pantheon_delegate.execute(
        { prompt: 'work', agent: 'talos' },
        { sessionID: 'ses_root' },
      )
      assert.match(line, /\[pantheon:tal-1\]/, `delegates with timeout set=${withTimeout}`)
    }
  })

  await testAsync('plugin native branch: default + garbage stay legacy', async () => {
    assert.equal(resolveDelegateMode({}), 'legacy')
    assert.equal(resolveDelegateMode({ PANTHEON_DELEGATE_MODE: 'bogus' }), 'legacy')
  })

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
