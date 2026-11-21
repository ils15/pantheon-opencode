import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

test('the ./plugin export loads from a clean production-only consumer', () => {
  const work = mkdtempSync(join(tmpdir(), 'pantheon-plugin-consumer-'))
  const consumer = join(work, 'consumer')
  const loader = join(consumer, 'load-plugins.ts')
  mkdirSync(consumer)
  writeFileSync(
    join(consumer, 'package.json'),
    `${JSON.stringify({ name: 'plugin-pack-check', private: true, type: 'module' })}\n`,
  )

  try {
    const packOutput = execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', work],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    )
    const tarball = join(work, readJsonFromPack(packOutput).filename)

    execFileSync(
      'npm',
      [
        'install',
        '--prefix',
        consumer,
        '--omit=dev',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--prefer-offline',
        tarball,
      ],
      { cwd: ROOT, encoding: 'utf8' },
    )

    const installedRoot = join(consumer, 'node_modules', 'pantheon-opencode')
    const installedManifest = readJson(join(installedRoot, 'package.json'))
    assert.equal(installedManifest.type, 'module')
    assert.equal(
      installedManifest.dependencies['@opencode-ai/plugin'],
      readJson(join(ROOT, 'package.json')).dependencies['@opencode-ai/plugin'],
    )
    assert.equal(installedManifest.devDependencies?.['@opencode-ai/plugin'], undefined)
    // The single plugin export: ./plugin -> the entry file at src/plugin.ts.
    assert.equal(installedManifest.exports['./plugin'], './src/plugin.ts')
    assert.equal(
      installedManifest.exports['./local-decision-router'],
      './src/pantheon/local-decision-router.ts',
    )

    const consumerLock = readJson(join(consumer, 'package-lock.json'))
    const runtimePlugin = consumerLock.packages['node_modules/@opencode-ai/plugin']
    assert.ok(runtimePlugin, 'the runtime dependency must be installed')
    assert.equal(runtimePlugin.dev, undefined, 'the runtime dependency must not be dev-only')

    writeFileSync(
      loader,
      [
        "import { existsSync } from 'node:fs'",
        "import plugin from 'pantheon-opencode/plugin'",
        "import serverPlugin from 'pantheon-opencode/server'",
        "if (plugin.id !== 'pantheon-opencode') throw new Error('invalid default export')",
        "if (typeof plugin.setup !== 'function') throw new Error('setup is not callable')",
        "if (serverPlugin.id !== 'pantheon-opencode') throw new Error('invalid server export')",
        'const agents = new Map()',
        'const skills = new Map()',
        'const commands = new Map()',
        'const refs = new Map()',
        'await serverPlugin.setup({',
        '  options: {},',
        '  location: { directory: process.cwd() },',
        '  agent: {',
        '    transform: async (cb) => {',
        '      cb({',
        '        list: () => Array.from(agents.values()),',
        '        get: (id) => agents.get(id),',
        '        default: () => {},',
        '        update: (id, fn) => {',
        '          const rec = agents.get(id) ?? { id, name: id, request: { body: {} }, permissions: [] }',
        '          agents.set(id, rec)',
        '          fn(rec)',
        '        },',
        '      })',
        '      return { dispose: async () => {} }',
        '    },',
        '  },',
        '  command: {',
        '    transform: async (cb) => {',
        '      cb({ add: (def) => commands.set(def.name, def), list: () => [], update: () => {} })',
        '      return { dispose: async () => {} }',
        '    },',
        '  },',
        '  reference: {',
        '    transform: async (cb) => {',
        '      cb({ add: (name, ref) => refs.set(name, ref) })',
        '      return { dispose: async () => {} }',
        '    },',
        '  },',
        '  skill: {',
        '    transform: async (cb) => {',
        '      cb({ add: (s) => skills.set(s.id, s), get: (id) => skills.get(id), list: () => [] })',
        '      return { dispose: async () => {} }',
        '    },',
        '  },',
        '})',
        "if (!agents.has('zeus') || agents.size < 14) throw new Error('expected >=14 agents, got ' + String(agents.size))",
        "if (skills.size < 25) throw new Error('expected >=25 skills, got ' + String(skills.size))",
        "if (commands.size < 8) throw new Error('expected >=8 commands, got ' + String(commands.size))",
        "const refPath = refs.get('pantheon-agents')?.path",
        "if (!refPath || !existsSync(refPath)) throw new Error('missing reference file: ' + String(refPath))",
        "console.log('plugin export loaded')",
        '',
      ].join('\n'),
    )
    execFileSync('npx', ['--yes', '--prefer-offline', '--package=tsx@4.19.4', 'tsx', loader], {
      cwd: consumer,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '--conditions=import' },
    })
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
})

function readJsonFromPack(output) {
  const metadata = JSON.parse(output)
  assert.equal(metadata.length, 1)
  return metadata[0]
}
