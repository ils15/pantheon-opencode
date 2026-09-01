import { strict as assert } from 'node:assert'
import { readFile } from 'node:fs/promises'

type Registration = { dispose: () => Promise<void> }

function registration(disposed: string[], name: string): Registration {
  return {
    dispose: async () => {
      disposed.push(name)
    },
  }
}

async function main(): Promise<void> {
  const { default: plugin, V2_UNSUPPORTED_FEATURES } = await import('../../src/plugin-v2.ts')
  const pluginSource = await readFile(new URL('../../src/plugin-v2.ts', import.meta.url), 'utf8')
  assert.match(pluginSource, /fileURLToPath/)
  assert.doesNotMatch(pluginSource, /\.pathname/)
  assert.equal(plugin.id, 'pantheon-opencode-v2')
  assert.equal(typeof plugin.setup, 'function')
  assert.ok(V2_UNSUPPORTED_FEATURES.includes('legacy-hooks'))

  const disposed: string[] = []
  const transforms: string[] = []
  const agents = [{ id: 'zeus', mode: 'subagent', system: 'existing' }]
  const commands = [{ name: 'pantheon-run' }]
  const skills: unknown[] = []
  const references: string[] = []
  const context = {
    options: {},
    agent: {
      transform: async (callback: (draft: never) => void) => {
        transforms.push('agent')
        callback({
          list: () => agents,
          update: (_id: string, update: (agent: (typeof agents)[number]) => void) =>
            update(agents[0]),
        } as never)
        return registration(disposed, 'agent')
      },
    },
    aisdk: {},
    catalog: {
      transform: async (callback: (draft: never) => void) => {
        transforms.push('catalog')
        callback({ model: { get: () => undefined, default: { set: () => {} } } } as never)
        return registration(disposed, 'catalog')
      },
    },
    command: {
      transform: async (callback: (draft: never) => void) => {
        transforms.push('command')
        callback({
          list: () => commands,
          update: (_name: string, update: (command: (typeof commands)[number]) => void) =>
            update(commands[0]),
        } as never)
        return registration(disposed, 'command')
      },
    },
    integration: { transform: async () => registration(disposed, 'integration') },
    plugin: { add: async () => {}, remove: async () => {} },
    reference: {
      transform: async (callback: (draft: never) => void) => {
        transforms.push('reference')
        callback({ add: (name: string) => references.push(name) } as never)
        return registration(disposed, 'reference')
      },
    },
    skill: {
      transform: async (callback: (draft: never) => void) => {
        transforms.push('skill')
        callback({ list: () => skills, source: (source: unknown) => skills.push(source) } as never)
        return registration(disposed, 'skill')
      },
    },
  }

  await plugin.setup(context as never)
  assert.deepEqual(transforms, ['agent', 'catalog', 'command', 'reference', 'skill'])
  assert.equal(agents[0].mode, 'primary')
  assert.match(agents[0].system, /Pantheon routing policy/)
  assert.equal(commands[0].description, 'Pantheon orchestration command')
  assert.deepEqual(references, ['pantheon-agents'])
  assert.equal(skills.length, 1)
  assert.deepEqual(disposed, [])

  console.log('✅ plugin V2 contract: 7 passed, 0 failed')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
