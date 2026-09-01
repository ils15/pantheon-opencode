/**
 * install-opencode.test.mjs — TDD tests for the Hermetic plugin resolution in
 * scripts/install/opencode.mjs (resolveInstalledPlugin).
 *
 * Validates the packaging fix for PR #45 (delegation plugin at package root):
 *  - exact managed refs resolve to <ROOT>/src/* inside the installed package
 *  - absolute third-party refs with the same basename remain untouched
 *  - non-src plugin refs (npm specs, etc.) pass through unchanged
 *
 * Run: node --test tests/install-opencode.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  installOpenCode,
  pluginReferenceIdentity,
  resolveInstalledPlugin,
} from '../scripts/install/opencode.mjs'
import { ROOT } from '../scripts/install/shared.mjs'

const THIRD_PARTY_PLUGIN = '/tmp/vendor/src/plugin.ts'
const THIRD_PARTY_HOOKS = '/tmp/pantheon-opencode-vendor/src/plugins/pantheon-hooks.ts'
const THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN = '/tmp/vendor/pantheon-opencode/src/plugin.ts'
const THIRD_PARTY_PANTHEON_PLUGIN = '/tmp/vendor/pantheon/src/plugin.ts'

test('resolveInstalledPlugin maps the exact relative root plugin into the installed package', () => {
  const result = resolveInstalledPlugin('src/plugin.ts')
  assert.equal(result, join(ROOT, 'src', 'plugin.ts'))
})

test('resolveInstalledPlugin preserves a third-party plugin with the same basename', () => {
  assert.equal(resolveInstalledPlugin(THIRD_PARTY_PLUGIN), THIRD_PARTY_PLUGIN)
  assert.equal(resolveInstalledPlugin(THIRD_PARTY_HOOKS), THIRD_PARTY_HOOKS)
})

test('resolveInstalledPlugin preserves third-party paths under pantheon-named directories', () => {
  assert.equal(
    resolveInstalledPlugin(THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN),
    THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN,
  )
  assert.equal(resolveInstalledPlugin(THIRD_PARTY_PANTHEON_PLUGIN), THIRD_PARTY_PANTHEON_PLUGIN)
  assert.notEqual(
    pluginReferenceIdentity(THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN),
    pluginReferenceIdentity('src/plugin.ts'),
  )
  assert.notEqual(
    pluginReferenceIdentity(THIRD_PARTY_PANTHEON_PLUGIN),
    pluginReferenceIdentity('src/plugin.ts'),
  )
})

test('resolveInstalledPlugin maps the exact relative hooks plugin into the installed package', () => {
  const result = resolveInstalledPlugin('src/plugins/pantheon-hooks.ts')
  assert.equal(result, join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts'))
})

test('resolveInstalledPlugin recognizes only exact installed paths as managed', () => {
  for (const ref of [
    join(ROOT, 'src', 'plugin.ts'),
    join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts'),
  ]) {
    const result = resolveInstalledPlugin(ref)
    assert.equal(result, ref)
  }
})

test('resolved plugin paths exist inside the package (ROOT-derived, not stale refs)', () => {
  for (const ref of ['src/plugin.ts', 'src/plugins/pantheon-hooks.ts']) {
    const result = resolveInstalledPlugin(ref)
    assert.ok(result.startsWith(join(ROOT, 'src')), `expected ROOT-derived path, got ${result}`)
    assert.ok(existsSync(result), `resolved path does not exist in package: ${result}`)
  }
})

test('resolveInstalledPlugin passes through non-src plugin refs unchanged', () => {
  assert.equal(resolveInstalledPlugin('@scope/custom-plugin'), '@scope/custom-plugin')
  assert.equal(resolveInstalledPlugin('pantheon-hooks'), 'pantheon-hooks')
})

test('plugin identities do not collapse third-party paths by basename or marker text', () => {
  assert.notEqual(
    pluginReferenceIdentity(THIRD_PARTY_PLUGIN),
    pluginReferenceIdentity('src/plugin.ts'),
  )
  assert.notEqual(
    pluginReferenceIdentity(THIRD_PARTY_HOOKS),
    pluginReferenceIdentity('src/plugins/pantheon-hooks.ts'),
  )
  assert.equal(
    pluginReferenceIdentity({ package: 'pantheon-opencode/plugin' }),
    pluginReferenceIdentity('src/plugin.ts'),
  )
})

// ─── End-to-end config merge (installOpenCode into temp dirs) ──────────────
// Exercises the full installer config pipeline: plugin registration, the
// instructions merge (section D) and the model/small_model merge. The
// 'runtime' component is excluded so no venv/health-check side effects run.

const COMPONENTS = ['agents', 'skills', 'instructions', 'commands', 'plugins']

/** Run a real (non-dry-run) install into `target`, optionally seeding an
 * existing opencode.json first. Returns the merged config. */
async function runInstall(target, existingConfig = null) {
  if (existingConfig !== null) {
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'opencode.json'), JSON.stringify(existingConfig, null, 2))
  }
  await installOpenCode(target, false, false, COMPONENTS, { yes: true, headless: true })
  return JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8'))
}

test('fresh install registers BOTH pantheon plugins (plugin.ts + pantheon-hooks.ts)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-fresh-'))
  try {
    const config = await runInstall(target)
    assert.ok(Array.isArray(config.plugin), 'config.plugin must be an array')
    assert.ok(
      config.plugin.includes(join(ROOT, 'src', 'plugin.ts')),
      `delegation plugin missing from fresh install: ${JSON.stringify(config.plugin)}`,
    )
    assert.ok(
      config.plugin.includes(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')),
      `hooks plugin missing from fresh install: ${JSON.stringify(config.plugin)}`,
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('fresh install writes experimental.subagent_depth=2 and is byte-identical on rerun', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-depth-'))
  try {
    await runInstall(target)
    const configPath = join(target, 'opencode.json')
    const firstBytes = readFileSync(configPath, 'utf8')
    const firstConfig = JSON.parse(firstBytes)
    assert.equal(firstConfig.experimental?.subagent_depth, 2)
    assert.equal('subagent_depth' in firstConfig, false)

    await installOpenCode(target, false, false, COMPONENTS, { yes: true, headless: true })
    assert.equal(readFileSync(configPath, 'utf8'), firstBytes)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('upgrade migrates a user top-level subagent_depth into experimental', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-depth-migrate-'))
  try {
    const config = await runInstall(target, { subagent_depth: 7 })
    assert.equal(config.experimental?.subagent_depth, 7)
    assert.equal('subagent_depth' in config, false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('fresh install instructions key is exactly [AGENTS.md]', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-instr-'))
  try {
    const config = await runInstall(target)
    assert.deepEqual(config.instructions, ['AGENTS.md'])
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('upgrade strips stale instructions globs, keeps user entries + AGENTS.md', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-upgrade-'))
  try {
    const config = await runInstall(target, {
      instructions: [
        'AGENTS.md',
        'instructions/*.instructions.md',
        'src/instructions/*.instructions.md',
        'docs/user-guide.md',
      ],
    })
    assert.deepEqual(
      config.instructions,
      ['AGENTS.md', 'docs/user-guide.md'],
      'stale *.instructions.md globs must be stripped, user entries kept',
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('upgrade preserves user plugins and adds both pantheon plugins (dedupe)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-upgrade-plugins-'))
  try {
    const config = await runInstall(target, {
      plugin: ['@scope/custom-plugin', THIRD_PARTY_PLUGIN, THIRD_PARTY_HOOKS],
    })
    assert.ok(config.plugin.includes('@scope/custom-plugin'), 'user plugin preserved')
    assert.ok(config.plugin.includes(THIRD_PARTY_PLUGIN), 'third-party plugin path preserved')
    assert.ok(config.plugin.includes(THIRD_PARTY_HOOKS), 'third-party hooks path preserved')
    assert.ok(
      config.plugin.includes(join(ROOT, 'src', 'plugin.ts')),
      `delegation plugin not re-registered: ${JSON.stringify(config.plugin)}`,
    )
    assert.ok(
      config.plugin.includes(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')),
      `hooks plugin not registered: ${JSON.stringify(config.plugin)}`,
    )
    // The managed entries are unique, while third-party entries with the same
    // basenames remain independent registrations.
    const pluginFiles = config.plugin.map((p) => p.split('/').pop())
    assert.equal(pluginFiles.filter((f) => f === 'plugin.ts').length, 2)
    assert.equal(pluginFiles.filter((f) => f === 'pantheon-hooks.ts').length, 2)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('fresh install does not inject top-level model defaults', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-model-'))
  try {
    const config = await runInstall(target, {})
    assert.equal(Object.hasOwn(config, 'model'), false)
    assert.equal(Object.hasOwn(config, 'small_model'), false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('invalid existing config aborts without replacing it or touching its backup', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-invalid-config-'))
  const configPath = join(target, 'opencode.json')
  const backupPath = `${configPath}.bak`
  const invalidConfig = '{"provider":'
  const backup = '{"provider":{"kept":true}}\n'
  try {
    writeFileSync(configPath, invalidConfig)
    writeFileSync(backupPath, backup)

    await assert.rejects(
      () => installOpenCode(target, false, false, COMPONENTS, { yes: true, headless: true }),
      /Invalid JSON.*opencode\.json/,
    )
    assert.equal(readFileSync(configPath, 'utf8'), invalidConfig)
    assert.equal(readFileSync(backupPath, 'utf8'), backup)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('preserves existing falsy values and user-owned config keys', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-falsy-config-'))
  try {
    const config = await runInstall(target, {
      model: null,
      small_model: false,
      default_agent: 0,
      provider: null,
      compaction: '',
      permission: false,
      instructions: 0,
      plugin: null,
      experimental: false,
      $schema: '',
      credentials: '',
      active_preset: false,
      user_setting: 0,
    })

    assert.equal(config.model, null)
    assert.equal(config.small_model, false)
    assert.equal(config.default_agent, 0)
    assert.equal(config.provider, null)
    assert.equal(config.compaction, '')
    assert.equal(config.permission, false)
    assert.equal(config.instructions, 0)
    assert.equal(config.plugin, null)
    assert.equal(config.experimental, false)
    assert.equal(config.$schema, '')
    assert.equal(config.credentials, '')
    assert.equal(config.active_preset, false)
    assert.equal(config.user_setting, 0)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('--model/--small-model flags override the install default', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-model-flags-'))
  try {
    mkdirSync(target, { recursive: true })
    await installOpenCode(target, false, false, COMPONENTS, {
      yes: true,
      headless: true,
      model: 'opencode-go/mimo-v2.5-pro',
      smallModel: 'opencode/mimo-v2.5-free',
    })
    const config = JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8'))
    assert.equal(config.model, 'opencode-go/mimo-v2.5-pro')
    assert.equal(config.small_model, 'opencode/mimo-v2.5-free')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('--model only changes model and preserves an existing small_model', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-model-only-'))
  try {
    const configPath = join(target, 'opencode.json')
    mkdirSync(target, { recursive: true })
    writeFileSync(configPath, JSON.stringify({ small_model: 'existing/small' }))
    await installOpenCode(target, false, false, COMPONENTS, {
      yes: true,
      headless: true,
      model: 'provider/main-model',
    })
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(config.model, 'provider/main-model')
    assert.equal(config.small_model, 'existing/small')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('--small-model only changes small_model and preserves an existing model', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-small-model-only-'))
  try {
    const configPath = join(target, 'opencode.json')
    mkdirSync(target, { recursive: true })
    writeFileSync(configPath, JSON.stringify({ model: 'existing/main' }))
    await installOpenCode(target, false, false, COMPONENTS, {
      yes: true,
      headless: true,
      smallModel: 'provider/small-model',
    })
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(config.model, 'existing/main')
    assert.equal(config.small_model, 'provider/small-model')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('existing target model values are preserved independently', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-model-repo-'))
  try {
    // The helper seeds TARGET/opencode.json; this is a user config, not the
    // repository's canonical opencode.json.
    const config = await runInstall(target, {
      model: 'repo/custom-model',
      small_model: 'repo/custom-small-model',
    })
    assert.equal(config.model, 'repo/custom-model')
    assert.equal(config.small_model, 'repo/custom-small-model')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('CLI forwards --model and --small-model to a project install', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-model-cli-'))
  try {
    const result = spawnSync(
      process.execPath,
      [
        join(ROOT, 'bin', 'pantheon-init.mjs'),
        'init',
        '--project',
        '--headless',
        '--yes',
        '--no-mcp',
        '--model',
        'provider/main-model',
        '--small-model',
        'provider/small-model',
      ],
      { cwd: target, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    const config = JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8'))
    assert.equal(config.model, 'provider/main-model')
    assert.equal(config.small_model, 'provider/small-model')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('user-set model is never overwritten by the merge', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-model-user-'))
  try {
    const config = await runInstall(target, { model: 'user/custom-model' })
    assert.equal(config.model, 'user/custom-model')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// V2 native config migration tests
// ---------------------------------------------------------------------------

/** Run install with --opencode-version=v2, returning the native V2 config. */
async function runV2Install(target, existingConfig = null) {
  if (existingConfig !== null) {
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'opencode.json'), JSON.stringify(existingConfig, null, 2))
  }
  await installOpenCode(target, false, false, COMPONENTS, { yes: true, headless: true, version: 'v2' })
  return JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8'))
}

test('V2 install produces providers (not provider) in output', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-v2-providers-'))
  try {
    const config = await runV2Install(target)
    // V2 format: providers is an array (or undefined if none configured)
    // V1 format: provider is an object
    assert.ok(!('provider' in config), 'V2 config must not have top-level provider')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V2 install produces permissions as array (not object)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-v2-permissions-'))
  try {
    const config = await runV2Install(target)
    // V2 format: permissions is an array
    // V1 format: permission is an object with keys like bash, mcp, skill
    assert.ok(!('permission' in config), 'V2 config must not have top-level permission object')
    if ('permissions' in config) {
      assert.ok(Array.isArray(config.permissions), 'V2 permissions must be an array')
    }
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V2 install produces mcp.servers (not flat mcp keys)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-v2-mcp-'))
  try {
    const config = await runV2Install(target)
    // V2 format: mcp is { servers: [...] } with ordered array
    // V1 format: mcp has flat keys like mcp['pantheon-resources'] = { ... }
    if ('mcp' in config) {
      assert.ok(typeof config.mcp === 'object' && config.mcp !== null, 'V2 mcp must be an object')
      assert.ok('servers' in config.mcp, 'V2 mcp must have servers key')
      assert.ok(Array.isArray(config.mcp.servers), 'V2 mcp.servers must be an array')
    }
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V2 install produces agents as named object (not flat agent)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-v2-agents-'))
  try {
    const config = await runV2Install(target)
    // V2 format: agents is { name: { model, permissions: [...] } } (named object)
    // V1 format: agent has the same shape but uses flat permission objects
    assert.ok(!('agent' in config), 'V2 config must not have top-level agent key')
    if ('agents' in config) {
      assert.ok(typeof config.agents === 'object' && !Array.isArray(config.agents),
        'V2 agents must be a named object (not an array)')
      // Per-agent permissions should be arrays (V2 format)
      for (const [, agentCfg] of Object.entries(config.agents)) {
        if (agentCfg.permissions !== undefined) {
          assert.ok(Array.isArray(agentCfg.permissions),
            'V2 agent.permissions must be an array')
        }
      }
    }
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V2 install is idempotent (same output on rerun)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-v2-idempotent-'))
  try {
    await runV2Install(target)
    const configPath = join(target, 'opencode.json')
    const firstBytes = readFileSync(configPath, 'utf8')

    await installOpenCode(target, false, false, COMPONENTS, { yes: true, headless: true, version: 'v2' })
    const secondBytes = readFileSync(configPath, 'utf8')
    assert.equal(secondBytes, firstBytes, 'V2 config must be byte-identical on rerun')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
