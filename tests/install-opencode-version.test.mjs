import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  deduplicatePluginReferences,
  installOpenCode,
  parseOpenCodeVersion,
  pluginReferenceIdentity,
  resolveInstalledPlugin,
  resolveOpenCodeVersion,
} from '../scripts/install/opencode.mjs'
import { ROOT } from '../scripts/install/shared.mjs'

const NO_COMPONENTS = []
const V2_PLUGIN = 'pantheon-opencode/plugin-v2'
const THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN = '/tmp/vendor/pantheon-opencode/src/plugin.ts'
const THIRD_PARTY_PANTHEON_PLUGIN = '/tmp/vendor/pantheon/src/plugin.ts'

async function installConfig(existingConfig, version) {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-version-'))
  try {
    writeFileSync(join(target, 'opencode.json'), JSON.stringify(existingConfig, null, 2))
    await installOpenCode(target, false, false, NO_COMPONENTS, {
      headless: true,
      version,
    })
    return JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8'))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
}

test('parses --opencode-version=v1, v2, and auto', () => {
  assert.equal(parseOpenCodeVersion(['init', '--opencode-version=v1']), 'v1')
  assert.equal(parseOpenCodeVersion(['init', '--opencode-version=v2']), 'v2')
  assert.equal(parseOpenCodeVersion(['init', '--opencode-version=auto']), 'auto')
})

test('parses separated version values and rejects invalid values', () => {
  assert.equal(parseOpenCodeVersion(['init', '--opencode-version', 'v1']), 'v1')
  assert.equal(parseOpenCodeVersion(['init', '--opencode-version', 'v2']), 'v2')
  assert.equal(parseOpenCodeVersion(['init', '--opencode-version', 'auto']), 'auto')
  assert.throws(
    () => parseOpenCodeVersion(['init', '--opencode-version=v3']),
    /expected v1, v2, or auto/,
  )
  assert.throws(() => parseOpenCodeVersion(['init', '--version', 'v3']), /expected v1, v2, or auto/)
})

test('auto resolves an explicit environment or opencode2 binary hint', () => {
  assert.equal(resolveOpenCodeVersion('auto', { env: { OPENCODE_VERSION: 'v2' } }), 'v2')
  assert.equal(resolveOpenCodeVersion('auto', { env: {}, binary: '/usr/bin/opencode2' }), 'v2')
  assert.equal(resolveOpenCodeVersion('auto', { env: {}, binary: '/usr/bin/opencode' }), 'v1')
  assert.throws(() => resolveOpenCodeVersion('v3'), /expected v1, v2, or auto/)
})

test('v1 preserves config.plugins and third-party paths in config.plugin', async () => {
  const config = await installConfig(
    {
      plugin: [THIRD_PARTY_PANTHEON_PLUGIN, '@scope/custom-plugin'],
      plugins: ['custom-v2-plugin'],
    },
    'v1',
  )

  assert.deepEqual(config.plugins, ['custom-v2-plugin'])
  assert.equal(config.plugin.filter((entry) => entry.endsWith('/plugin.ts')).length, 2)
  assert.ok(config.plugin.includes(THIRD_PARTY_PANTHEON_PLUGIN))
  assert.equal(config.plugin.filter((entry) => entry.endsWith('/pantheon-hooks.ts')).length, 1)
  assert.ok(config.plugin.includes('@scope/custom-plugin'))
  assert.ok(config.plugin.includes(join(ROOT, 'src', 'plugin.ts')))
  assert.ok(config.plugin.includes(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')))
})

test('v2 preserves config.plugin and registers the shipped V2 entrypoint', async () => {
  const config = await installConfig(
    {
      plugin: ['user-v1-plugin'],
      plugins: ['user-v2-plugin'],
    },
    'v2',
  )

  assert.deepEqual(config.plugin, ['user-v1-plugin'])
  assert.equal(config.plugins[0], 'user-v2-plugin')
  assert.ok(config.plugins.includes(V2_PLUGIN))
  assert.ok(!config.plugins.includes(join(ROOT, 'src', 'plugin-v2.ts')))
  assert.ok(!config.plugins.some((entry) => entry === join(ROOT, 'src', 'plugin.ts')))
})

test('v1 to v2 migration removes Pantheon V1 refs and preserves third-party plugins', async () => {
  const config = await installConfig(
    {
      plugin: [THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN, THIRD_PARTY_PANTHEON_PLUGIN, 'third-party-v1'],
      plugins: [V2_PLUGIN, 'third-party-v2'],
    },
    'v2',
  )

  assert.deepEqual(config.plugin, [
    THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN,
    THIRD_PARTY_PANTHEON_PLUGIN,
    'third-party-v1',
  ])
  assert.deepEqual(config.plugins, ['third-party-v2', V2_PLUGIN])
})

test('v2 to v1 migration removes Pantheon V2 refs and preserves third-party plugins', async () => {
  const config = await installConfig(
    {
      plugin: ['third-party-v1', THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN],
      plugins: [V2_PLUGIN, 'third-party-v2', THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN],
    },
    'v1',
  )

  assert.deepEqual(config.plugins, ['third-party-v2', THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN])
  assert.deepEqual(config.plugin, [
    'third-party-v1',
    THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN,
    join(ROOT, 'src', 'plugin.ts'),
    join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts'),
  ])
})

test('auto selects V2 and V1 during migrations without mixing Pantheon refs', async () => {
  const previousVersion = process.env.OPENCODE_VERSION
  try {
    process.env.OPENCODE_VERSION = 'v2'
    const v2 = await installConfig(
      {
        plugin: [THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN, 'third-party-v1'],
        plugins: [V2_PLUGIN, 'third-party-v2'],
      },
      'auto',
    )
    assert.deepEqual(v2.plugin, [THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN, 'third-party-v1'])
    assert.deepEqual(v2.plugins, ['third-party-v2', V2_PLUGIN])

    process.env.OPENCODE_VERSION = 'v1'
    const v1 = await installConfig(
      {
        plugin: ['third-party-v1'],
        plugins: [V2_PLUGIN, 'third-party-v2'],
      },
      'auto',
    )
    assert.deepEqual(v1.plugins, ['third-party-v2'])
    assert.ok(v1.plugin.includes(join(ROOT, 'src', 'plugin.ts')))
    assert.ok(!v1.plugin.includes(V2_PLUGIN))
  } finally {
    if (previousVersion === undefined) delete process.env.OPENCODE_VERSION
    else process.env.OPENCODE_VERSION = previousVersion
  }
})

test('does not install or register TUI when the plugins component is omitted', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-no-plugins-'))
  try {
    await installOpenCode(target, false, false, NO_COMPONENTS, {
      headless: true,
      version: 'v1',
    })
    assert.equal(existsSync(join(target, '.opencode', 'tui.json')), false)
    assert.equal(existsSync(join(target, '.opencode', 'plugins', 'pantheon-tui')), false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('v1 removes legacy todoContinuation rejected by recent OpenCode releases', async () => {
  const config = await installConfig({ todoContinuation: true }, 'v1')

  assert.equal(Object.hasOwn(config, 'todoContinuation'), false)
})

test('v2 preserves todoContinuation because its configuration is not rewritten', async () => {
  const config = await installConfig({ todoContinuation: true }, 'v2')

  assert.equal(config.todoContinuation, true)
})

test('exact installed package plugin paths remain managed', () => {
  const delegation = resolveInstalledPlugin(join(ROOT, 'src', 'plugin.ts'))
  const hooks = resolveInstalledPlugin(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts'))
  assert.equal(delegation, join(ROOT, 'src', 'plugin.ts'))
  assert.equal(hooks, join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts'))
  assert.ok(existsSync(delegation))
  assert.ok(existsSync(hooks))
})

test('external plugin paths under pantheon-named directories remain untouched', () => {
  assert.equal(
    resolveInstalledPlugin(THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN),
    THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN,
  )
  assert.equal(resolveInstalledPlugin(THIRD_PARTY_PANTHEON_PLUGIN), THIRD_PARTY_PANTHEON_PLUGIN)
})

test('plugin deduplication uses Pantheon identity or full path, never basename', () => {
  const refs = deduplicatePluginReferences([
    '/home/old/src/plugin.ts',
    join(ROOT, 'src', 'plugin.ts'),
    '/user/plugin.ts',
    '/another/plugin.ts',
    'custom-plugin',
    'custom-plugin',
  ])
  assert.equal(refs.filter((entry) => pluginReferenceIdentity(entry) === 'src/plugin.ts').length, 1)
  assert.ok(refs.includes('/user/plugin.ts'))
  assert.ok(refs.includes('/another/plugin.ts'))
  assert.equal(refs.filter((entry) => entry === 'custom-plugin').length, 1)
})
