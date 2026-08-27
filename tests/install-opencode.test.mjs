/**
 * install-opencode.test.mjs — TDD tests for the Hermetic plugin resolution in
 * scripts/install/opencode.mjs (resolveInstalledPlugin).
 *
 * Validates the packaging fix for PR #45 (delegation plugin at package root):
 *  - plugin ref `src/plugin.ts` (registered in the packaged opencode.json)
 *    resolves to <ROOT>/src/plugin.ts inside the INSTALLED package, never a
 *    developer-machine absolute path
 *  - `src/plugins/*` refs (pantheon-hooks) keep resolving to the package
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
import { installOpenCode, resolveInstalledPlugin } from '../scripts/install/opencode.mjs'
import { ROOT } from '../scripts/install/shared.mjs'

// Simulates the developer machine path being baked into the packaged config
// (the REAL dev path differs per machine — this one must never appear in
// resolver output regardless of the machine running the test).
const FOREIGN_DEV_PATH = '/home/otherdev/pantheon'

test('resolveInstalledPlugin maps root-level src/plugin.ts into the installed package', () => {
  const result = resolveInstalledPlugin(`${FOREIGN_DEV_PATH}/src/plugin.ts`)
  assert.equal(result, join(ROOT, 'src', 'plugin.ts'))
  assert.ok(!result.startsWith(FOREIGN_DEV_PATH), 'must not leak the developer path')
})

test('resolveInstalledPlugin maps relative src/plugin.ts into the installed package', () => {
  const result = resolveInstalledPlugin('src/plugin.ts')
  assert.equal(result, join(ROOT, 'src', 'plugin.ts'))
})

test('resolveInstalledPlugin still maps src/plugins/* hooks plugin into the installed package', () => {
  const result = resolveInstalledPlugin(`${FOREIGN_DEV_PATH}/src/plugins/pantheon-hooks.ts`)
  assert.equal(result, join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts'))
})

test('resolveInstalledPlugin never emits a developer-machine absolute path', () => {
  for (const ref of [
    `${FOREIGN_DEV_PATH}/src/plugin.ts`,
    `${FOREIGN_DEV_PATH}/src/plugins/pantheon-hooks.ts`,
    'src/plugin.ts',
    'src/plugins/pantheon-hooks.ts',
  ]) {
    const result = resolveInstalledPlugin(ref)
    assert.ok(
      !result.includes(FOREIGN_DEV_PATH),
      `leaked developer path for ref ${ref}: got ${result}`,
    )
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
      plugin: ['@scope/custom-plugin', '/home/otherdev/pantheon/src/plugin.ts'],
    })
    assert.ok(config.plugin.includes('@scope/custom-plugin'), 'user plugin preserved')
    // Stale dev-machine path replaced by the installed-package path.
    assert.ok(
      config.plugin.includes(join(ROOT, 'src', 'plugin.ts')),
      `delegation plugin not re-registered: ${JSON.stringify(config.plugin)}`,
    )
    assert.ok(
      config.plugin.includes(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')),
      `hooks plugin not registered: ${JSON.stringify(config.plugin)}`,
    )
    // No duplicate entries for the same plugin file.
    const pluginFiles = config.plugin.map((p) => p.split('/').pop())
    assert.equal(pluginFiles.filter((f) => f === 'plugin.ts').length, 1)
    assert.equal(pluginFiles.filter((f) => f === 'pantheon-hooks.ts').length, 1)
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
