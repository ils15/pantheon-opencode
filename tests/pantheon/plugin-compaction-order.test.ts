/** Verify compaction context is populated before the compacted event fires. */
import { strict as assert } from 'node:assert'

type HookOutput = { context: string[] }

type PluginHooks = {
  tool: {
    pantheon_delegate: {
      execute: (args: unknown, context: unknown) => Promise<unknown>
    }
  }
  event: (input: { event: { type: string; properties: { sessionID: string } } }) => Promise<void>
  'experimental.session.compacting': (
    input: { sessionID: string },
    output: HookOutput,
  ) => Promise<void>
}

async function main(): Promise<void> {
  process.env.PANTHEON_PLUGIN_ONCE = 'off'
  const sessionID = `ses-compaction-order-${Date.now()}`
  const client = {
    session: {
      list: async () => ({ data: [], error: undefined }),
      create: async () => ({ data: { id: `ses-child-${sessionID}` }, error: undefined }),
      promptAsync: async () => ({ data: { status: 'running' }, error: undefined }),
    },
  }
  const { default: plugin } = await import('../../src/plugin.ts')
  const hooks = (await plugin({ client } as never)) as unknown as PluginHooks

  const delegationResult = await hooks.tool.pantheon_delegate.execute(
    { agent: 'apollo', prompt: 'preserve this running delegation', read_only: true },
    { sessionID, agent: 'hermes' },
  )
  assert.equal(typeof delegationResult, 'string', String(delegationResult))
  assert.match(String(delegationResult), /started|delegation/i, String(delegationResult))

  const output: HookOutput = { context: [] }
  await hooks['experimental.session.compacting']({ sessionID }, output)
  assert.ok(
    output.context.some((block) => block.includes('Background Delegations (running):')),
    `running delegation must be present in the compacting hook output: ${JSON.stringify(output.context)}`,
  )
  assert.ok(output.context.some((block) => block.includes('preserve this running delegation')))

  // The later event must not be required to prepare the context, nor duplicate
  // it into a future cycle.
  await hooks.event({ event: { type: 'session.compacted', properties: { sessionID } } })
  const nextOutput: HookOutput = { context: [] }
  await hooks['experimental.session.compacting']({ sessionID }, nextOutput)
  assert.equal(
    nextOutput.context.filter((block) => block.includes('preserve this running delegation')).length,
    1,
  )

  console.log('✅ plugin compaction hook order: 1 passed, 0 failed')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
