/**
 * Verifies model wiring through the real plugin factory and delegation tool.
 * Run with: npx tsx tests/pantheon/plugin-agent-model-wiring.test.ts
 */
import { strict as assert } from 'node:assert'

type CreateBody = { model?: { id: string; providerID: string } }

function fakeClient(created: CreateBody[]): Record<string, unknown> {
  return {
    session: {
      list: async () => [],
      create: async ({ body }: { body: CreateBody }) => {
        created.push(body)
        return { id: `child-${created.length}` }
      },
      promptAsync: async () => ({}),
    },
  }
}

async function runFactory(preset: string | undefined): Promise<CreateBody> {
  if (preset === undefined) delete process.env.PANTHEON_MODEL_PRESET
  else process.env.PANTHEON_MODEL_PRESET = preset

  const created: CreateBody[] = []
  const { default: plugin } = await import('../../src/plugin.ts')
  const instance = await plugin({ client: fakeClient(created) } as never)
  const tool = (
    instance as never as {
      tool: { pantheon_delegate: { execute: (args: unknown, ctx: unknown) => Promise<unknown> } }
    }
  ).tool.pantheon_delegate
  await tool.execute(
    { agent: 'apollo', prompt: 'test wiring', read_only: true },
    { sessionID: `root-${preset ?? 'none'}`, agent: 'hermes' },
  )
  assert.equal(created.length, 1)
  return created[0]
}

async function main(): Promise<void> {
  // The documented test escape hatch lets both configurations run through the
  // real factory without changing production double-registration behavior.
  process.env.PANTHEON_PLUGIN_ONCE = 'off'
  const withoutProfile = await runFactory('none')
  assert.equal(withoutProfile.model, undefined, 'without profile, model is omitted')

  const withProfile = await runFactory('go-fast')
  assert.deepEqual(withProfile.model, {
    providerID: 'opencode-go',
    id: 'deepseek-v4-flash',
  })

  console.log('✅ plugin agentModels wiring: 2 passed, 0 failed')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
