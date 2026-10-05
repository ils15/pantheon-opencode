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
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { migrateV1toV2 } from '../scripts/install/config-migration.mjs'
import {
  installOpenCode,
  isGlobalConfigDir,
  MANAGED_FIELDS,
  pluginReferenceIdentity,
  resolveInstalledPlugin,
  resolveTuiCopyTarget,
  tuiConfigLocations,
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

test('resolveInstalledPlugin maps the V2 plugin directory into the installed package', () => {
  const result = resolveInstalledPlugin('src/plugin-v2')
  assert.equal(result, join(ROOT, 'src', 'plugin-v2'))
})

test('resolveInstalledPlugin migrates the legacy V2 file ref to the plugin directory', () => {
  assert.equal(resolveInstalledPlugin('src/plugin-v2.ts'), join(ROOT, 'src', 'plugin-v2'))
  assert.equal(
    resolveInstalledPlugin(join(ROOT, 'src', 'plugin-v2.ts')),
    join(ROOT, 'src', 'plugin-v2'),
  )
})

test('V2 npm-shorthand and legacy refs share the directory identity', () => {
  const dir = join(ROOT, 'src', 'plugin-v2')
  for (const ref of ['pantheon-opencode/plugin-v2', 'src/plugin-v2.ts']) {
    assert.equal(pluginReferenceIdentity(ref), 'src/plugin-v2')
  }
  assert.equal(pluginReferenceIdentity(dir), 'src/plugin-v2')
})

test('resolveInstalledPlugin preserves a third-party plugin-v2 file path', () => {
  const thirdParty = '/tmp/vendor/pantheon-opencode/src/plugin-v2.ts'
  assert.equal(resolveInstalledPlugin(thirdParty), thirdParty)
  assert.notEqual(pluginReferenceIdentity(thirdParty), 'src/plugin-v2')
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
  for (const ref of ['src/plugin.ts', 'src/plugins/pantheon-hooks.ts', 'src/plugin-v2']) {
    const result = resolveInstalledPlugin(ref)
    assert.ok(result.startsWith(join(ROOT, 'src')), `expected ROOT-derived path, got ${result}`)
    assert.ok(existsSync(result), `resolved path does not exist in package: ${result}`)
  }
})

test('resolveInstalledPlugin passes through non-src plugin refs unchanged', () => {
  assert.equal(resolveInstalledPlugin('@scope/custom-plugin'), '@scope/custom-plugin')
  assert.equal(resolveInstalledPlugin('pantheon-hooks'), 'pantheon-hooks')
})

test('scope helpers distinguish project and flat global layouts', () => {
  assert.equal(isGlobalConfigDir(join(homedir(), '.config', 'opencode')), true)
  assert.equal(isGlobalConfigDir(join(homedir(), '.opencode')), true)
  assert.equal(isGlobalConfigDir('/tmp/project'), false)
  assert.equal(
    resolveTuiCopyTarget('/tmp/.config/opencode'),
    join('/tmp/.config/opencode', 'plugins', 'pantheon-tui'),
  )
  const locations = tuiConfigLocations('/tmp/project')
  assert.equal(new Set(locations).size, locations.length)
  assert.ok(locations.includes(join('/tmp/project', '.opencode', 'tui.json')))
})

// ─── End-to-end config merge (installOpenCode into temp dirs) ──────────────
// Exercises the full installer config pipeline: plugin registration, the
// instructions merge (section D) and the model/small_model merge. The
// 'runtime' component is excluded so no venv/health-check side effects run.

const COMPONENTS = ['agents', 'skills', 'instructions', 'commands', 'plugins']

/** Run a real (non-dry-run) install into `target`, optionally seeding an
 * existing opencode.json first. Returns the merged config. */
async function runInstall(target, existingConfig = null, version = 'v1') {
  if (existingConfig !== null) {
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'opencode.json'), JSON.stringify(existingConfig, null, 2))
  }
  await installOpenCode(target, false, false, COMPONENTS, {
    yes: true,
    headless: true,
    version,
  })
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

// issue #158: an opencode.json left pointing at a lockfile-pinned older
// install (e.g. node_modules/pantheon-opencode@1.4.1, which still ships the
// removed pantheon_delegate tool) must be realigned onto the current package
// by init/sync, so the registered tool surface stops drifting.
test('sync realigns a stale node_modules plugin path onto the current package (issue #158)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-drift-'))
  try {
    const staleRoot = '/home/admin/node_modules/pantheon-opencode'
    const config = await runInstall(target, {
      plugin: [join(staleRoot, 'src', 'plugin.ts'), THIRD_PARTY_PLUGIN],
      plugins: [join(staleRoot, 'src', 'plugin-v2')],
    })
    // The stale V1 and V2 refs are rewritten into THIS package; the
    // third-party plugin survives untouched.
    assert.ok(
      config.plugin.includes(join(ROOT, 'src', 'plugin.ts')),
      `stale V1 ref not realigned: ${JSON.stringify(config.plugin)}`,
    )
    assert.ok(
      config.plugin.every((ref) => !String(ref).includes(staleRoot)),
      `stale node_modules copy still registered: ${JSON.stringify(config.plugin)}`,
    )
    assert.ok(
      config.plugins.every((ref) => !String(ref).includes(staleRoot)),
      `stale V2 node_modules copy still registered: ${JSON.stringify(config.plugins)}`,
    )
    assert.ok(config.plugin.includes(THIRD_PARTY_PLUGIN), 'third-party plugin must be preserved')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 downgrade keeps the legacy plugins key with third-party plugins, preserving user provider and compaction values', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-v1-legacy-'))
  try {
    const config = await runInstall(
      target,
      {
        plugins: ['npm:user-plugin'],
        provider: { custom: { options: { endpoint: 'https://example.test' } } },
        compaction: { prune: false },
      },
      'v1',
    )
    // The legacy `plugins` key is preserved verbatim (minus Pantheon refs) so
    // third-party registrations survive a V1 downgrade; only Pantheon-owned
    // entries are stripped and re-registered under the singular `plugin` key.
    assert.deepEqual(config.plugins, ['npm:user-plugin'])
    assert.ok(config.plugin.includes(join(ROOT, 'src', 'plugin.ts')))
    assert.ok(config.plugin.includes(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')))
    assert.equal(config.provider.custom.options.endpoint, 'https://example.test')
    assert.equal(config.compaction.prune, false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V2 normalizes the legacy mcp.servers wrapper and preserves user MCP servers', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-v2-mcp-'))
  try {
    const config = await runInstall(
      target,
      {
        mcp: {
          servers: { enabled: false, customSetting: 'keep' },
          userServer: { type: 'remote', url: 'https://user.example/mcp', enabled: true },
        },
      },
      'v2',
    )
    // OpenCode 1.18.x has no mcp.servers wrapper ("Missing key
    // mcp.servers.enabled"): the legacy wrapper is unwrapped to flat keys and
    // its non-server scalar entries are dropped.
    assert.equal(config.mcp.servers, undefined)
    assert.equal(config.mcp.userServer.url, 'https://user.example/mcp')
    assert.equal(config.mcp.userServer.enabled, true)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('global install uses flat component directories and repairs a legacy V2 config', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'opencode-global-'))
  const target = join(parent, 'opencode')
  const previousXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = parent
  try {
    const config = await installOpenCode(target, false, false, COMPONENTS, {
      yes: true,
      headless: true,
      version: 'v2',
    }).then(() => JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8')))
    assert.ok(existsSync(join(target, 'agents')))
    assert.ok(existsSync(join(target, 'skills')))
    assert.ok(Array.isArray(config.plugins))
    assert.equal(config.plugin, undefined)
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
    rmSync(parent, { recursive: true, force: true })
  }
})

test('runtime-only install copies executable MCP assets and remains idempotent', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-runtime-'))
  try {
    await installOpenCode(target, false, false, ['runtime'], {
      yes: true,
      headless: true,
      version: 'v2',
    })
    const runtime = join(target, '.opencode')
    const config = JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8'))
    // MCP stays a flat named-server map for BOTH versions (no mcp.servers
    // wrapper — OpenCode 1.18.x rejects it with "Missing key
    // mcp.servers.enabled").
    assert.equal(config.mcp.servers, undefined)
    assert.equal(config.mcp['pantheon-resources'].enabled, true)
    assert.equal(config.mcp['pantheon-code-mode'].enabled, true)
    assert.ok(existsSync(join(runtime, 'scripts', 'mcp_resources.py')))
    assert.ok(existsSync(join(runtime, 'requirements-vision.txt')))
    // Code-mode payload is seeded from the packaged .pantheon/code-mode dir
    // (project layout: <target>/.opencode/.pantheon/code-mode).
    const codeModeDir = join(runtime, '.pantheon', 'code-mode')
    assert.ok(existsSync(codeModeDir), 'code-mode dir must be created by runtime install')
    assert.ok(
      existsSync(join(codeModeDir, 'compress-inline.py')),
      'code-mode scripts must be seeded from the packaged payload',
    )
    // tiers.json is an untracked dev-repo artifact (not in package "files"),
    // so the runtime copy is existsSync-gated: the destination must exist
    // exactly when the source does.
    assert.equal(
      existsSync(join(runtime, '.pantheon', 'tiers.json')),
      existsSync(join(ROOT, '.pantheon', 'tiers.json')),
    )
    const before = readFileSync(join(runtime, 'scripts', 'code_mode.py'), 'utf8')
    await installOpenCode(target, false, false, ['runtime'], {
      yes: true,
      headless: true,
      version: 'v2',
    })
    assert.equal(readFileSync(join(runtime, 'scripts', 'code_mode.py'), 'utf8'), before)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('global runtime install seeds <config>/.pantheon/code-mode', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'opencode-global-runtime-'))
  const target = join(parent, 'opencode')
  const previousXdg = process.env.XDG_CONFIG_HOME
  process.env.XDG_CONFIG_HOME = parent
  try {
    await installOpenCode(target, false, false, ['runtime'], {
      yes: true,
      headless: true,
      version: 'v2',
    })
    const codeModeDir = join(target, '.pantheon', 'code-mode')
    assert.ok(existsSync(codeModeDir), 'global code-mode dir must be created')
    assert.ok(
      existsSync(join(codeModeDir, 'compress-inline.py')),
      'global code-mode scripts must be seeded from the packaged payload',
    )
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previousXdg
    rmSync(parent, { recursive: true, force: true })
  }
})

test('V2 upgrade merges and deduplicates user plugins without overwriting config.plugins', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-v2-plugins-'))
  try {
    const userPlugin = 'npm:@acme/my-plugin'
    const config = await runInstall(
      target,
      { plugins: [userPlugin, userPlugin], theme: 'user-theme' },
      'v2',
    )
    assert.equal(config.plugin, undefined)
    // V2 registers the plugin DIRECTORY inside the installed package
    // (<pkg>/src/plugin-v2, whose index.ts shim re-exports the real entry):
    // the beta loader rejects file paths ("must be a directory") and resolves
    // `a/b` shorthands via npm install (NpmInstallFailedError) — never the V1
    // local-file paths, which stay V1-only.
    assert.deepEqual(config.plugins, [userPlugin, join(ROOT, 'src', 'plugin-v2')])
    assert.equal(config.theme, 'user-theme')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// Regression: a repository-root opencode.json is a contributor's PERSONAL dev
// harness. Reading it unconditionally injected the developer's provider/plugins
// into every generated config. The merge is now opt-in via --merge-dev-config.
test('default install never reads a repository-root opencode.json', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-no-dev-merge-'))
  const devDir = mkdtempSync(join(tmpdir(), 'pantheon-dev-config-'))
  const devConfig = join(devDir, 'opencode.json')
  try {
    // A dev config that WOULD be merged if the file were read implicitly.
    writeFileSync(
      devConfig,
      JSON.stringify({
        plugins: ['npm:@acme/should-not-appear'],
        provider: { devonly: { options: { endpoint: 'https://dev.invalid' } } },
        compaction: { devonly: true },
      }),
    )
    // Prove the coupling is closed: this dev config is never referenced, and
    // the installer consults no repository-root opencode.json on the default
    // path (opts.mergeDevConfig is undefined → pantheonConfig stays null).
    const config = await installOpenCode(target, false, false, COMPONENTS, {
      yes: true,
      headless: true,
      version: 'v1',
    }).then(() => JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8')))
    assert.ok(
      !config.plugins?.includes('npm:@acme/should-not-appear') &&
        !config.plugin?.includes('npm:@acme/should-not-appear'),
      'dev config plugin must not leak into a default install',
    )
    assert.equal(config.provider?.devonly, undefined, 'dev provider must not leak')
    assert.equal(config.compaction?.devonly, undefined, 'dev compaction must not leak')
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(devDir, { recursive: true, force: true })
  }
})

test('--merge-dev-config merges third-party plugin/provider/compaction from the given config', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-dev-merge-'))
  const devDir = mkdtempSync(join(tmpdir(), 'pantheon-dev-config-'))
  const devConfig = join(devDir, 'opencode.json')
  try {
    // A real dev config carries both plugin shapes; V1 reads the singular key.
    writeFileSync(
      devConfig,
      JSON.stringify({
        plugin: ['npm:@acme/merged-plugin'],
        plugins: ['npm:@acme/merged-plugin'],
        provider: { merged: { options: { endpoint: 'https://merged.invalid' } } },
        compaction: { merged: true },
      }),
    )
    const config = await installOpenCode(target, false, false, COMPONENTS, {
      yes: true,
      headless: true,
      version: 'v1',
      mergeDevConfig: devConfig,
    }).then(() => JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8')))
    // V1 keeps the singular plugin list and the flat provider/compaction keys,
    // so the merged third-party entries are directly observable.
    assert.ok(
      config.plugin.includes('npm:@acme/merged-plugin'),
      'explicitly merged plugin must be present',
    )
    assert.equal(config.provider.merged.options.endpoint, 'https://merged.invalid')
    assert.equal(config.compaction.merged, true)
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(devDir, { recursive: true, force: true })
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

    // Explicit 'v1' on BOTH sides: this asserts idempotency, not the host
    // gate. runInstall defaults to 'v1', so leaving this call on the default
    // made the two halves disagree on any 2.x developer host.
    await installOpenCode(target, false, false, COMPONENTS, {
      yes: true,
      headless: true,
      version: 'v1',
    })
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

// ─── Stale `steps` removal on managed agents ────────────────────────────────
// Dropping `steps` from the canonical agent frontmatter stopped Pantheon from
// *writing* a step ceiling, but the installer is additive by design
// (install/opencode.mjs:886-887) and has no delete path — so every config
// installed before that change kept its stale value forever.
//
// Scope is the agents Pantheon manages. A user-defined agent is never touched,
// and the V1 singular `agent` block is deliberately left alone (V1 in
// retirement). The V2 `agents` block is produced in exactly one place — the
// `version === 'v2'` branch that calls migrateV1toV2 — so that is the single
// choke point; config-migration.mjs stays a pure shape converter and the
// delete runs after it.

test('v2 install strips a stale steps ceiling from a managed agent', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-steps-v2-'))
  try {
    const config = await runInstall(
      target,
      { agent: { zeus: { mode: 'primary', steps: 45, permission: { edit: 'allow' } } } },
      'v2',
    )
    // The stale value rode in on the V1 `agent` block and was carried across
    // by migrateV1toV2; the install must strip it so the host default wins.
    assert.equal(config.agents.zeus.steps, undefined)
    // Everything else about the managed agent is untouched.
    assert.equal(config.agents.zeus.mode, 'primary')
    assert.equal(config.agents.zeus.source, '.opencode/agents/zeus.md')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('v2 install strips a stale steps ceiling from a config that is already V2-only', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-steps-v2only-'))
  try {
    const config = await runInstall(
      target,
      // No singular `agent` block. This is the steady state: what every install
      // sees from the second run onward, once a v2 install has written a V2-only
      // config. Every other test in this group seeded the V1 shape, so the path
      // real users actually live on was unexercised.
      { agents: { zeus: { mode: 'primary', steps: 45, model: 'x' } } },
      'v2',
    )
    // The installer still rebuilt the singular block from the canonical agents
    // and merged it in, so this went through the coexistence path — and the
    // stale ceiling the migration carried across still has to go.
    assert.equal(config.agent, undefined, 'the singular block is gone after a v2 install')
    assert.equal(config.agents.zeus.steps, undefined, 'stale ceiling dropped in steady state too')
    // The cleanup is a delete of one key, not a replace: the user's own model
    // rides through untouched.
    assert.equal(config.agents.zeus.model, 'x', "the user's model survives the cleanup")
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('v1 install leaves the singular agent block steps value alone', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-steps-v1-'))
  try {
    const config = await runInstall(
      target,
      { agent: { zeus: { mode: 'primary', steps: 45 } } },
      'v1',
    )
    // The cleanup is V2-only: `agent` (singular) is the retiring V1 shape and
    // is never written by a v2 install, so touching it would be pointless and
    // would regress a V1 downgrade.
    assert.equal(config.agent.zeus.steps, 45)
    assert.equal(config.agents, undefined)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('v2 install preserves steps on an agent the user defined', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-steps-user-'))
  try {
    const config = await runInstall(
      target,
      {
        agent: { zeus: { mode: 'primary', steps: 45 }, meuAgente: { mode: 'subagent', steps: 12 } },
      },
      'v2',
    )
    // Over-deletion guard: `meuAgente` is not a Pantheon-managed agent, so it
    // is outside the cleanup's scope and keeps the user's value. Only the
    // managed `zeus` loses its stale ceiling.
    assert.equal(config.agents.meuAgente.steps, 12)
    assert.equal(config.agents.zeus.steps, undefined)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('the installer has no remaining write path for steps', async () => {
  const source = readFileSync(join(ROOT, 'scripts', 'install', 'opencode.mjs'), 'utf8')
  // Two writers existed: the frontmatter extraction and the MANAGED_FIELDS
  // merge list. Both are gone, so the post-migration delete has no write path
  // left to contradict it on the same pass.
  assert.doesNotMatch(
    source,
    /\bfm\.steps\b/,
    'frontmatter still copies fm.steps into the agent config',
  )
  // Read the exported constant, not a regex over the source: a constant built
  // differently would silently narrow what this assertion checks.
  assert.ok(
    !MANAGED_FIELDS.includes('steps'),
    "MANAGED_FIELDS still merges 'steps' into existing and new agents",
  )
  // Behavioral half of the same invariant: a fresh install writes no ceiling.
  for (const version of ['v1', 'v2']) {
    const target = mkdtempSync(join(tmpdir(), `pantheon-steps-fresh-${version}-`))
    try {
      const config = await runInstall(target, null, version)
      const agents = version === 'v2' ? config.agents : config.agent
      assert.ok(agents && typeof agents === 'object', `fresh ${version} install wrote no agents`)
      for (const [name, entry] of Object.entries(agents)) {
        assert.equal(entry.steps, undefined, `fresh ${version} install wrote steps on ${name}`)
      }
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  }
})

test('migrateV1toV2 still carries steps and the installer drops it afterwards', async () => {
  // config-migration.mjs must stay a pure shape converter: the `{ ...agentConfig }`
  // spread there (config-migration.mjs:329) is what carries `steps` into V2, and
  // stripping it there would make the converter lossy for every caller. The
  // delete belongs downstream in opencode.mjs, inside the v2 branch.
  const migrated = migrateV1toV2({ agent: { zeus: { mode: 'primary', steps: 45 } } })
  assert.equal(migrated.agents.zeus.steps, 45, 'the pure converter must not lose fields')

  const target = mkdtempSync(join(tmpdir(), 'pantheon-steps-migrate-'))
  try {
    const config = await runInstall(
      target,
      { agent: { zeus: { mode: 'primary', steps: 45 } } },
      'v2',
    )
    assert.equal(config.agents.zeus.steps, undefined)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('a managed agent absent from the config is created without steps', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-steps-new-'))
  try {
    // Seed only a user agent, so every Pantheon agent takes the "new agent"
    // creation branch and is built purely from the canonical frontmatter.
    const config = await runInstall(target, { agent: { meuAgente: { mode: 'subagent' } } }, 'v2')
    const zeus = config.agents.zeus
    assert.ok(zeus, 'the managed agent must be created')
    assert.equal(zeus.steps, undefined, 'a newly created agent must not gain a steps ceiling')
    assert.equal(zeus.source, '.opencode/agents/zeus.md')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// ─── Coexistence of the `agent` and `agents` blocks ─────────────────────────
// The installed opencode.json carries BOTH blocks, so a v2 install always hit
// the case where migrateV1toV2 renamed the singular block onto an existing
// plural one. The shallow spread replaced the whole per-agent object, which
// threw away the Pantheon-managed merge (source, temperature, permissions).
// The installer semantics at opencode.mjs:881-884 are the contract: managed
// fields overwrite, user fields are preserved.

test('v2 install keeps the managed agent merge when agent and agents coexist', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-agents-coexist-'))
  try {
    const config = await runInstall(
      target,
      {
        agent: { zeus: { mode: 'primary', temperature: 0.2, permission: { edit: 'deny' } } },
        agents: { zeus: { mode: 'subagent', steps: 45 }, meuAgente: { mode: 'subagent' } },
      },
      'v2',
    )
    const zeus = config.agents.zeus
    // Managed fields from the V1 block survive the rename.
    assert.equal(zeus.source, '.opencode/agents/zeus.md', 'managed source must not be discarded')
    assert.equal(zeus.temperature, 0.2, 'managed temperature must not be discarded')
    assert.deepEqual(
      zeus.permissions.filter((p) => p.action === 'edit'),
      [{ action: 'edit', resource: '*', effect: 'deny' }],
      'managed permissions must not be discarded',
    )
    assert.equal(zeus.mode, 'primary', 'a managed field set by both blocks takes the V1 value')
    // User fields from the V2 block are preserved, and the stale ceiling on
    // the managed agent is still stripped by the post-migration delete.
    assert.equal(zeus.steps, undefined, 'the managed steps strip must still run')
    assert.deepEqual(config.agents.meuAgente, { mode: 'subagent' }, 'V2-only agent untouched')
    assert.equal(config.agent, undefined, 'the singular block is still consumed by the rename')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
