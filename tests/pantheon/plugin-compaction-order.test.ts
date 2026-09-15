/**
 * Verify the REAL plugin factory's `experimental.session.compacting` hook
 * builds the surviving compaction context (release-134 Phase 2 + Fase 2 of the
 * delegate removal): the preservation directive and `<todo_context>`.
 *
 * The delegation carry-forward section was removed with the delegation
 * toolset, so this test now proves the hook no longer depends on the board
 * and still snapshots pending todos for the post-compaction restore.
 *
 * Run with: npx tsx tests/pantheon/plugin-compaction-order.test.ts
 */
import { strict as assert } from 'node:assert'

import { useTmpProjectDir } from './helpers/tmp-dir.ts'

// This test drives the REAL plugin factory, whose shared BackgroundJobBoard
// persists `.pantheon/board/state.json` relative to cwd. Isolate BEFORE the
// plugin (and therefore getSharedBoard) is imported so nothing leaks into the
// repo's real board.
useTmpProjectDir('pantheon-compaction-order-')

type HookOutput = { context: string[] }

type PluginHooks = {
  event: (input: { event: { type: string; properties: { sessionID: string } } }) => Promise<void>
  'experimental.session.compacting': (
    input: { sessionID: string },
    output: HookOutput,
  ) => Promise<void>
}

async function main(): Promise<void> {
  process.env.PANTHEON_PLUGIN_ONCE = 'off'
  const sessionID = `ses-compaction-order-${Date.now()}`
  const pendingTodos = [
    { id: 'todo-1', content: 'wire the slim compaction hook', status: 'pending' },
    { id: 'todo-2', content: 'already finished', status: 'completed' },
  ]
  const client = {
    session: {
      list: async () => ({ data: [], error: undefined }),
      todo: async () => ({ data: pendingTodos, error: undefined }),
      messages: async () => ({ data: [], error: undefined }),
      children: async () => ({ data: [], error: undefined }),
      create: async () => ({ data: { id: 'child' }, error: undefined }),
      promptAsync: async () => ({ data: {}, error: undefined }),
    },
  }
  const { default: plugin } = await import('../../src/plugin.ts')
  const hooks = (await plugin({ client } as never)) as unknown as PluginHooks

  const output: HookOutput = { context: [] }
  await hooks['experimental.session.compacting']({ sessionID }, output)

  const joined = output.context.join('\n')
  assert.ok(
    joined.includes('<pantheon-context directive>'),
    `preservation directive must be present: ${JSON.stringify(output.context)}`,
  )
  assert.ok(
    output.context.some((block) => block.includes('<todo_context>')),
    `pending todos must be present in the compacting hook output: ${JSON.stringify(output.context)}`,
  )
  assert.ok(
    joined.includes('wire the slim compaction hook'),
    'pending todo content must be carried',
  )
  assert.ok(!joined.includes('already finished'), 'completed todos must be filtered out')
  assert.ok(
    !joined.includes('Background Delegations'),
    'delegation carry-forward must be gone from the compaction context',
  )
  assert.equal(
    output.context.filter((block) => block.includes('<todo_context>')).length,
    1,
    'todo context must not duplicate within a single compacting cycle',
  )

  // The later event must not be required to prepare the context, nor duplicate
  // it into a future cycle.
  await hooks.event({ event: { type: 'session.compacted', properties: { sessionID } } })
  const nextOutput: HookOutput = { context: [] }
  await hooks['experimental.session.compacting']({ sessionID }, nextOutput)
  assert.equal(
    nextOutput.context.filter((block) => block.includes('<todo_context>')).length,
    1,
    'todo context must stay a single block on the next cycle',
  )

  console.log('✅ plugin compaction hook order: 4 passed, 0 failed')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
