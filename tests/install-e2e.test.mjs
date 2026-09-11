/**
 * install-e2e.test.mjs — End-to-end tests for the V1 and V2 install paths
 *
 * Validates the complete flow of `init --opencode-version=v1|v2`:
 *  - Config shape per version (V1: plugin singular/permission object/agent
 *    singular; V2: plugins plural/providers/permissions array/agents object)
 *  - Third-party plugins preserved
 *  - TUI registration correct
 *  - Idempotent (byte-identical) output
 *  - Snapshot key structure
 *  - Cross-version overwrites and round-trips
 *
 * Version-generic tests run for both versions; shape-specific assertions live
 * in their own sections.
 *
 * Run: node --test tests/install-e2e.test.mjs
 */
import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { installOpenCode } from '../scripts/install/opencode.mjs'
import { ROOT } from '../scripts/install/shared.mjs'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const V2_PLUGIN = join(ROOT, 'src', 'plugin-v2')
// Legacy V2 refs (migrated by the installer into V2_PLUGIN): the npm
// shorthand the beta resolves via npm install (NpmInstallFailedError) and the
// pre-directory-contract file path (loader warns "must be a directory").
const V2_EXPORT = 'pantheon-opencode/plugin-v2'
const V2_LEGACY_FILE = 'src/plugin-v2.ts'
const THIRD_PARTY_PLUGIN = '/tmp/vendor/src/plugin.ts'

const COMPONENTS = ['agents', 'skills', 'instructions', 'commands', 'plugins']
const VERSIONS = ['v1', 'v2']

/** Per-version fixture seeds: the user plugin spec and a third-party seed. */
const VERSION_FIXTURES = {
  v1: { userPlugin: '@scope/custom-v1-plugin' },
  v2: { userPlugin: '@scope/custom-v2-plugin' },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run install for the given version, returning the generated config.
 * Optionally seeds an existing opencode.json before install.
 */
async function runInstall(target, version, existingConfig = null) {
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

// ---------------------------------------------------------------------------
// 1. Version-generic behavior (both v1 and v2)
// ---------------------------------------------------------------------------

for (const version of VERSIONS) {
  test(`[${version}] fresh install sets $schema`, async () => {
    const target = mkdtempSync(join(tmpdir(), `pantheon-e2e-${version}-schema-`))
    try {
      const config = await runInstall(target, version)
      assert.equal(config.$schema, 'https://opencode.ai/config.json')
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  test(`[${version}] writes experimental.subagent_depth=2`, async () => {
    const target = mkdtempSync(join(tmpdir(), `pantheon-e2e-${version}-depth-`))
    try {
      const config = await runInstall(target, version)
      assert.ok(config.experimental !== undefined, 'config must have experimental')
      assert.equal(config.experimental.subagent_depth, 2)
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  test(`[${version}] registers TUI plugin in tui.json and copies it to config dir`, async () => {
    const target = mkdtempSync(join(tmpdir(), `pantheon-e2e-${version}-tui-`))
    try {
      await runInstall(target, version)
      const tuiJsonPath = join(target, '.opencode', 'tui.json')
      assert.ok(existsSync(tuiJsonPath), 'tui.json must exist after install')
      const tuiConfig = JSON.parse(readFileSync(tuiJsonPath, 'utf8'))
      const pluginList = tuiConfig.plugin || tuiConfig.plugins
      assert.ok(pluginList !== undefined, 'tui.json must have plugin (or plugins) key')
      assert.ok(Array.isArray(pluginList), 'tui.json plugin list must be an array')
      assert.ok(
        pluginList.some((p) => typeof p === 'string' && p.includes('pantheon-tui')),
        'tui.json must register pantheon-tui plugin',
      )
      assert.ok(
        existsSync(join(target, '.opencode', 'plugins', 'pantheon-tui')),
        'pantheon-tui copy directory must exist',
      )
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  test(`[${version}] preserves user instructions alongside AGENTS.md`, async () => {
    const target = mkdtempSync(join(tmpdir(), `pantheon-e2e-${version}-instr-`))
    try {
      const config = await runInstall(target, version, {
        instructions: ['my-instructions.md'],
      })
      assert.ok(Array.isArray(config.instructions), 'instructions must be an array')
      assert.ok(config.instructions.includes('AGENTS.md'), 'instructions must include AGENTS.md')
      assert.ok(
        config.instructions.includes('my-instructions.md'),
        'User instructions must be preserved',
      )
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  test(`[${version}] install is idempotent (byte-identical on rerun)`, async () => {
    const target = mkdtempSync(join(tmpdir(), `pantheon-e2e-${version}-idempotent-`))
    try {
      await runInstall(target, version)
      const configPath = join(target, 'opencode.json')
      const firstBytes = readFileSync(configPath, 'utf8')
      await runInstall(target, version)
      assert.equal(
        readFileSync(configPath, 'utf8'),
        firstBytes,
        'config must be byte-identical on rerun',
      )
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  test(`[${version}] idempotent with third-party plugins`, async () => {
    const target = mkdtempSync(join(tmpdir(), `pantheon-e2e-${version}-idemp-3p-`))
    try {
      const seed =
        version === 'v1'
          ? { plugin: [THIRD_PARTY_PLUGIN, VERSION_FIXTURES.v1.userPlugin] }
          : { plugin: [THIRD_PARTY_PLUGIN], plugins: [VERSION_FIXTURES.v2.userPlugin] }
      await runInstall(target, version, seed)
      const configPath = join(target, 'opencode.json')
      const firstBytes = readFileSync(configPath, 'utf8')
      await runInstall(target, version)
      assert.equal(
        readFileSync(configPath, 'utf8'),
        firstBytes,
        'config with 3P plugins must be byte-identical on rerun',
      )
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  test(`[${version}] preserves third-party plugins`, async () => {
    const target = mkdtempSync(join(tmpdir(), `pantheon-e2e-${version}-3p-`))
    try {
      const userPlugin = VERSION_FIXTURES[version].userPlugin
      const config = await runInstall(target, version, {
        plugin: [THIRD_PARTY_PLUGIN],
        ...(version === 'v1' ? {} : { plugins: [userPlugin] }),
      })
      assert.ok(
        config.plugin.includes(THIRD_PARTY_PLUGIN),
        `Third-party plugin ${THIRD_PARTY_PLUGIN} must be preserved`,
      )
      if (version === 'v2') {
        assert.ok(config.plugins.includes(userPlugin), 'third-party V2 plugin preserved')
      }
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })
}

// ---------------------------------------------------------------------------
// 2. V1 shape specifics
// ---------------------------------------------------------------------------

test('V1 fresh install produces plugin (singular) as array', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-fresh-'))
  try {
    const config = await runInstall(target, 'v1')
    assert.ok(Array.isArray(config.plugin), 'config.plugin must be an array')
    assert.ok(config.plugin.length >= 2, 'plugin array must have at least 2 pantheon entries')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 fresh install registers src/plugin.ts and pantheon-hooks.ts', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-managed-'))
  try {
    const config = await runInstall(target, 'v1')
    assert.ok(
      config.plugin.includes(join(ROOT, 'src', 'plugin.ts')),
      `src/plugin.ts missing from V1 plugin array: ${JSON.stringify(config.plugin)}`,
    )
    assert.ok(
      config.plugin.includes(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')),
      `pantheon-hooks.ts missing from V1 plugin array: ${JSON.stringify(config.plugin)}`,
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 fresh install does NOT include V2 plugin entry in plugin array', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-no-v2-'))
  try {
    const config = await runInstall(target, 'v1')
    const hasV2Export = config.plugin.some(
      (p) =>
        p === V2_EXPORT ||
        p === V2_LEGACY_FILE ||
        p === join(ROOT, 'src', 'plugin-v2.ts') ||
        p === V2_PLUGIN,
    )
    assert.ok(!hasV2Export, 'V1 config must not contain V2 plugin entry')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 fresh install has permission as object and no V2-only keys', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-shape-'))
  try {
    const config = await runInstall(target, 'v1')
    assert.ok(config.permission !== undefined, 'V1 config must have permission key')
    assert.ok(
      typeof config.permission === 'object' && !Array.isArray(config.permission),
      'V1 permission must be an object, not an array',
    )
    assert.ok(!('agents' in config), 'V1 config must not have agents (plural) key')
    assert.ok(!('providers' in config), 'V1 config must not have providers (plural) key')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 fresh install does NOT use V2 mcp.servers format', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-mcp-'))
  try {
    const config = await runInstall(target, 'v1')
    if (config.mcp !== undefined) {
      assert.ok(
        typeof config.mcp === 'object' && !Array.isArray(config.mcp),
        'V1 mcp must be an object',
      )
      assert.ok(
        !('servers' in config.mcp),
        'V1 mcp must not have servers sub-key (that is V2 format)',
      )
    }
    assert.ok(!('servers' in (config.mcp || {})), 'V1 must not use mcp.servers format')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 fresh install has agent as singular object (not agents)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-agent-'))
  try {
    const config = await runInstall(target, 'v1')
    if ('agent' in config) {
      assert.ok(
        typeof config.agent === 'object' && !Array.isArray(config.agent),
        'V1 agent must be a named object',
      )
    }
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 removes todoContinuation (rejected by recent OpenCode)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-todo-'))
  try {
    const config = await runInstall(target, 'v1', { todoContinuation: true })
    assert.equal(
      Object.hasOwn(config, 'todoContinuation'),
      false,
      'V1 must remove todoContinuation',
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 adds current managed plugins even when stale refs exist', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-stale-'))
  try {
    const config = await runInstall(target, 'v1', {
      plugin: [
        '/old/install/src/plugin.ts',
        '/old/install/src/plugins/pantheon-hooks.ts',
        THIRD_PARTY_PLUGIN,
      ],
    })
    assert.ok(
      config.plugin.includes(join(ROOT, 'src', 'plugin.ts')),
      'Must have current src/plugin.ts',
    )
    assert.ok(
      config.plugin.includes(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')),
      'Must have current pantheon-hooks.ts',
    )
    assert.ok(config.plugin.includes(THIRD_PARTY_PLUGIN))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 keeps third-party plugins in plugins key untouched', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-3pv2-'))
  try {
    const config = await runInstall(target, 'v1', {
      plugin: [THIRD_PARTY_PLUGIN],
      plugins: ['custom-v2-plugin'],
    })
    assert.deepEqual(config.plugins, ['custom-v2-plugin'])
    assert.ok(config.plugin.includes(THIRD_PARTY_PLUGIN))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 config snapshot has expected key structure', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-snapshot-'))
  try {
    const config = await runInstall(target, 'v1')
    assert.ok('$schema' in config, 'snapshot must have $schema')
    assert.ok('plugin' in config, 'snapshot must have plugin (singular)')
    assert.ok('permission' in config, 'snapshot must have permission (singular)')
    assert.ok('experimental' in config, 'snapshot must have experimental')
    assert.ok('instructions' in config, 'snapshot must have instructions')
    assert.ok(!('plugins' in config), 'V1 snapshot must not have plugins (plural)')
    assert.ok(!('providers' in config), 'V1 snapshot must not have providers (plural)')
    assert.ok(!('permissions' in config), 'V1 snapshot must not have permissions (plural)')
    assert.ok(!('agents' in config), 'V1 snapshot must not have agents (plural)')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 config snapshot permissions contain skill allow rule', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-snap-perm-'))
  try {
    const config = await runInstall(target, 'v1')
    assert.ok(config.permission.skill !== undefined, 'V1 snapshot permission must have skill key')
    assert.deepEqual(config.permission.skill, { '*': 'allow' })
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 includes talos agent with permission configuration', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-talos-'))
  try {
    const config = await runInstall(target, 'v1')
    assert.ok(
      config.agent !== undefined && config.agent.talos !== undefined,
      'V1 config must have agent.talos',
    )
    assert.ok(config.agent.talos.permission !== undefined, 'talos must have permission')
    assert.ok(
      typeof config.agent.talos.permission === 'object' &&
        !Array.isArray(config.agent.talos.permission),
      'talos.permission must be an object',
    )
    assert.ok('read' in config.agent.talos.permission, 'talos must have read permission')
    assert.ok('edit' in config.agent.talos.permission, 'talos must have edit permission')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. V2 shape specifics
// ---------------------------------------------------------------------------

test('V2 fresh install produces plugins (plural) as array with managed dir entry', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v2-fresh-'))
  try {
    const config = await runInstall(target, 'v2')
    assert.ok(Array.isArray(config.plugins), 'config.plugins must be an array')
    assert.ok(
      config.plugins.includes(V2_PLUGIN),
      `V2 plugin dir ${V2_PLUGIN} missing from plugins array: ${JSON.stringify(config.plugins)}`,
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V2 fresh install registers a directory that carries the loader contract', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v2-dircontract-'))
  try {
    const config = await runInstall(target, 'v2')
    assert.ok(config.plugins.includes(V2_PLUGIN), 'V2 plugin entry missing')
    assert.ok(
      existsSync(V2_PLUGIN) && statSync(V2_PLUGIN).isDirectory(),
      `entry must be a directory: ${V2_PLUGIN}`,
    )
    assert.ok(
      existsSync(join(V2_PLUGIN, 'index.ts')),
      `entry directory must carry a real index.ts: ${V2_PLUGIN}`,
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V2 fresh install does NOT include V1 plugin entries or V1-shape keys', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v2-shape-'))
  try {
    const config = await runInstall(target, 'v2')
    assert.ok(!('provider' in config), 'V2 config must not have top-level provider (singular)')
    assert.ok(!('agent' in config), 'V2 config must not have agent (singular) key')
    const hasV1Delegation = config.plugins.some((p) => p === join(ROOT, 'src', 'plugin.ts'))
    const hasV1Hooks = config.plugins.some(
      (p) => p === join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts'),
    )
    assert.ok(!hasV1Delegation, 'V2 config must not contain V1 src/plugin.ts')
    assert.ok(!hasV1Hooks, 'V2 config must not contain V1 pantheon-hooks.ts')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V2 fresh install has permissions as array and flat MCP keys', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v2-perms-'))
  try {
    const config = await runInstall(target, 'v2')
    assert.ok(
      !('permission' in config),
      'V2 config must not have top-level permission (singular object)',
    )
    if ('permissions' in config) {
      assert.ok(Array.isArray(config.permissions), 'V2 permissions must be an array')
    }
    if ('mcp' in config) {
      assert.ok(typeof config.mcp === 'object' && config.mcp !== null, 'V2 mcp must be an object')
      assert.ok(!('servers' in config.mcp), 'V2 mcp must not have servers sub-key')
      assert.ok(config.mcp.bifrost, 'V2 mcp must retain the flat bifrost server')
    }
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V2 fresh install has agents as named object with array permissions', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v2-agents-'))
  try {
    const config = await runInstall(target, 'v2')
    if ('agents' in config) {
      assert.ok(
        typeof config.agents === 'object' && !Array.isArray(config.agents),
        'V2 agents must be a named object (not an array)',
      )
      for (const [agentName, agentCfg] of Object.entries(config.agents)) {
        if (agentCfg.permissions !== undefined) {
          assert.ok(
            Array.isArray(agentCfg.permissions),
            `V2 agent ${agentName}.permissions must be an array`,
          )
        }
      }
    }
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V2 preserves todoContinuation (not rewritten for V2)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v2-todo-'))
  try {
    const config = await runInstall(target, 'v2', { todoContinuation: true })
    assert.equal(config.todoContinuation, true)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V2 removes Pantheon V2 refs from plugins before adding the managed entry', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v2-dedup-'))
  try {
    const config = await runInstall(target, 'v2', {
      plugins: [V2_EXPORT, V2_LEGACY_FILE, V2_PLUGIN, 'other-plugin'],
    })
    const v2Count = config.plugins.filter((p) => p === V2_PLUGIN).length
    assert.equal(v2Count, 1, 'V2 plugin must appear exactly once')
    assert.ok(!config.plugins.includes(V2_EXPORT), 'npm-shorthand ref must migrate')
    assert.ok(!config.plugins.includes(V2_LEGACY_FILE), 'legacy file ref must migrate')
    assert.ok(config.plugins.includes('other-plugin'))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V2 cleans V1 Pantheon refs from plugin key', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v2-cleanup-'))
  try {
    const config = await runInstall(target, 'v2', {
      plugin: [
        join(ROOT, 'src', 'plugin.ts'),
        join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts'),
        THIRD_PARTY_PLUGIN,
      ],
    })
    assert.ok(
      !config.plugin.includes(join(ROOT, 'src', 'plugin.ts')),
      'V2 must remove V1 src/plugin.ts from plugin key',
    )
    assert.ok(
      !config.plugin.includes(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')),
      'V2 must remove V1 pantheon-hooks.ts from plugin key',
    )
    assert.ok(config.plugin.includes(THIRD_PARTY_PLUGIN))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V2 config snapshot has expected V2 key structure', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v2-snapshot-'))
  try {
    const config = await runInstall(target, 'v2')
    assert.ok('$schema' in config, 'snapshot must have $schema')
    assert.ok('plugins' in config, 'snapshot must have plugins (plural)')
    assert.ok('experimental' in config, 'snapshot must have experimental')
    assert.ok('instructions' in config, 'snapshot must have instructions')
    assert.ok(!('plugin' in config), 'V2 snapshot must not have plugin (singular)')
    assert.ok(!('provider' in config), 'V2 snapshot must not have provider (singular)')
    assert.ok(!('permission' in config), 'V2 snapshot must not have permission (singular)')
    assert.ok(!('agent' in config), 'V2 snapshot must not have agent (singular)')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V2 config snapshot permissions contain skill allow rule', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v2-snap-perm-'))
  try {
    const config = await runInstall(target, 'v2')
    if ('permissions' in config && Array.isArray(config.permissions)) {
      const skillPerm = config.permissions.find((p) => p.action === 'skill' && p.resource === '*')
      assert.ok(skillPerm !== undefined, 'permissions must include skill * allow')
      assert.equal(skillPerm.effect, 'allow')
    }
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V2 includes talos agent with permissions configuration', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v2-talos-'))
  try {
    const config = await runInstall(target, 'v2')
    assert.ok(
      config.agents !== undefined && config.agents.talos !== undefined,
      'V2 config must have agents.talos',
    )
    if (config.agents.talos.permissions !== undefined) {
      assert.ok(
        Array.isArray(config.agents.talos.permissions),
        'talos.permissions must be an array in V2',
      )
    } else if (config.agents.talos.permission !== undefined) {
      assert.ok(
        typeof config.agents.talos.permission === 'object',
        'talos.permission must be an object',
      )
    }
    const permObj = config.agents.talos.permission || {}
    if (Array.isArray(config.agents.talos.permissions)) {
      const permActions = config.agents.talos.permissions.map((p) => p.action)
      assert.ok(
        permActions.includes('read') || permActions.includes('edit'),
        'talos permissions must include read or edit',
      )
    } else {
      assert.ok(
        'read' in permObj || 'edit' in permObj,
        'talos permission must include read or edit',
      )
    }
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. Cross-version overwrites and round-trips
// ---------------------------------------------------------------------------

test('V1 after V2 adds V1 config keys (plugin, permission, provider)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-after-v2-'))
  try {
    await runInstall(target, 'v2')
    const v1Config = await runInstall(target, 'v1')
    assert.ok('plugin' in v1Config, 'After V1 overwrite, config must have plugin (singular)')
    assert.ok(
      typeof v1Config.permission === 'object' && !Array.isArray(v1Config.permission),
      'After V1 overwrite, permission must be object',
    )
    assert.ok(
      v1Config.plugin.includes(join(ROOT, 'src', 'plugin.ts')),
      'V1 plugin must contain delegation plugin',
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V2 after V1 adds V2 config keys (plugins, providers, permissions)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v2-after-v1-'))
  try {
    const v1Config = await runInstall(target, 'v1')
    assert.ok('plugin' in v1Config, 'V1 config must have plugin')
    const v2Config = await runInstall(target, 'v2')
    assert.ok('plugins' in v2Config, 'After V2 overwrite, config must have plugins (plural)')
    assert.ok(v2Config.plugins.includes(V2_PLUGIN), 'V2 plugin must be present')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1→V2 round-trip adds V2 plugin entry', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-roundtrip-v2-'))
  try {
    const v1Config = await runInstall(target, 'v1')
    assert.ok('plugin' in v1Config, 'Must start with V1 config')
    const v2Config = await runInstall(target, 'v2')
    assert.ok('plugins' in v2Config, 'Must have V2 plugins key after V2 install')
    assert.ok(v2Config.plugins.includes(V2_PLUGIN), 'V2 plugin must be present')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V2→V1 round-trip adds V1 plugin and delegation plugin', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-roundtrip-v1-'))
  try {
    const v2Config = await runInstall(target, 'v2')
    assert.ok('plugins' in v2Config, 'Must start with V2 config')
    const v1Config = await runInstall(target, 'v1')
    assert.ok('plugin' in v1Config, 'Must have V1 plugin key after V1 install')
    assert.ok(
      v1Config.plugin.includes(join(ROOT, 'src', 'plugin.ts')),
      'V1 delegation plugin must be present',
    )
    assert.ok(
      v1Config.plugin.includes(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')),
      'V1 hooks plugin must be present',
    )
    assert.ok(
      typeof v1Config.permission === 'object' && !Array.isArray(v1Config.permission),
      'V1 must have permission as object',
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
