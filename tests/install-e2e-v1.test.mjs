/**
 * install-e2e-v1.test.mjs — End-to-end tests for V1 installation path
 *
 * Validates the complete flow of `init --opencode-version=v1`:
 *  - Config shape matches V1 format (plugin singular, permission object,
 *    mcp top-level, agent singular)
 *  - Third-party plugins preserved
 *  - TUI registration correct
 *  - Idempotent output
 *  - Snapshot comparison
 *
 * Run: node --test tests/install-e2e-v1.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { installOpenCode } from '../scripts/install/opencode.mjs'
import { ROOT } from '../scripts/install/shared.mjs'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const V2_PLUGIN = 'pantheon-opencode/plugin-v2'
const THIRD_PARTY_PLUGIN = '/tmp/vendor/src/plugin.ts'
const _THIRD_PARTY_HOOKS = '/tmp/pantheon-opencode-vendor/src/plugins/pantheon-hooks.ts'
const _THIRD_PARTY_PANTHEON_OPENCODE_PLUGIN = '/tmp/vendor/pantheon-opencode/src/plugin.ts'
const _THIRD_PARTY_PANTHEON_PLUGIN = '/tmp/vendor/pantheon/src/plugin.ts'
const THIRD_PARTY_USER_PLUGIN = '@scope/custom-v1-plugin'

const COMPONENTS = ['agents', 'skills', 'instructions', 'commands', 'plugins']

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run install with --opencode-version=v1, returning the generated config.
 * Optionally seeds an existing opencode.json before install.
 */
async function runV1Install(target, existingConfig = null) {
  if (existingConfig !== null) {
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'opencode.json'), JSON.stringify(existingConfig, null, 2))
  }
  await installOpenCode(target, false, false, COMPONENTS, {
    yes: true,
    headless: true,
    version: 'v1',
  })
  return JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8'))
}

// ---------------------------------------------------------------------------
// 1. Fresh install V1 — config shape
// ---------------------------------------------------------------------------

test('V1 fresh install produces plugin (singular) as array', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-fresh-'))
  try {
    const config = await runV1Install(target)
    assert.ok(Array.isArray(config.plugin), 'config.plugin must be an array')
    assert.ok(config.plugin.length >= 2, 'plugin array must have at least 2 pantheon entries')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 fresh install registers src/plugin.ts', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-delegation-'))
  try {
    const config = await runV1Install(target)
    const resolvedDelegation = join(ROOT, 'src', 'plugin.ts')
    assert.ok(
      config.plugin.includes(resolvedDelegation),
      `src/plugin.ts missing from V1 plugin array: ${JSON.stringify(config.plugin)}`,
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 fresh install registers src/plugins/pantheon-hooks.ts', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-hooks-'))
  try {
    const config = await runV1Install(target)
    const resolvedHooks = join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')
    assert.ok(
      config.plugin.includes(resolvedHooks),
      `pantheon-hooks.ts missing from V1 plugin array: ${JSON.stringify(config.plugin)}`,
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 fresh install does NOT include V2 plugin entry in plugin array', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-no-v2-'))
  try {
    const config = await runV1Install(target)
    const hasV2Export = config.plugin.some(
      (p) => p === V2_PLUGIN || p === join(ROOT, 'src', 'plugin-v2.ts'),
    )
    assert.ok(!hasV2Export, 'V1 config must not contain V2 plugin entry')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 fresh install has permission as object (not array)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-perm-'))
  try {
    const config = await runV1Install(target)
    assert.ok(config.permission !== undefined, 'V1 config must have permission key')
    assert.ok(
      typeof config.permission === 'object' && !Array.isArray(config.permission),
      'V1 permission must be an object, not an array',
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 fresh install does NOT use V2 mcp.servers format', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-mcp-'))
  try {
    const config = await runV1Install(target)
    // V1 config may or may not have mcp key depending on components.
    // When present, it must be flat keys (not mcp.servers).
    if (config.mcp !== undefined) {
      assert.ok(
        typeof config.mcp === 'object' && !Array.isArray(config.mcp),
        'V1 mcp must be an object',
      )
      // V1 format: mcp has flat keys, NOT mcp.servers
      assert.ok(
        !('servers' in config.mcp),
        'V1 mcp must not have servers sub-key (that is V2 format)',
      )
    }
    // Must NOT have V2-style mcp.servers at top level
    assert.ok(!('servers' in (config.mcp || {})), 'V1 must not use mcp.servers format')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 fresh install has agent as singular object (not agents)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-agent-'))
  try {
    const config = await runV1Install(target)
    // V1 may or may not have agent key — but it must NOT have 'agents' (plural)
    assert.ok(!('agents' in config), 'V1 config must not have agents (plural) key')
    // If agent exists, it must be an object
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

test('V1 fresh install has provider (singular, not providers)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-prov-'))
  try {
    const config = await runV1Install(target)
    // V1 may or may not have provider — but must NOT have 'providers'
    assert.ok(!('providers' in config), 'V1 config must not have providers (plural) key')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. Third-party plugin preservation
// ---------------------------------------------------------------------------

test('V1 preserves third-party plugins in plugin array', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-3p-'))
  try {
    const config = await runV1Install(target, {
      plugin: [THIRD_PARTY_PLUGIN, THIRD_PARTY_USER_PLUGIN],
    })
    assert.ok(
      config.plugin.includes(THIRD_PARTY_PLUGIN),
      `Third-party plugin ${THIRD_PARTY_PLUGIN} must be preserved`,
    )
    assert.ok(
      config.plugin.includes(THIRD_PARTY_USER_PLUGIN),
      `Third-party user plugin ${THIRD_PARTY_USER_PLUGIN} must be preserved`,
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 preserves third-party V2 plugins in plugins key', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-3pv2-'))
  try {
    const config = await runV1Install(target, {
      plugin: [THIRD_PARTY_PLUGIN],
      plugins: ['custom-v2-plugin'],
    })
    // V1 keeps third-party plugins in plugins key untouched
    assert.deepEqual(config.plugins, ['custom-v2-plugin'])
    // V1 preserves third-party in plugin array
    assert.ok(config.plugin.includes(THIRD_PARTY_PLUGIN))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 adds current managed plugins even when stale refs exist', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-stale-'))
  try {
    const config = await runV1Install(target, {
      plugin: [
        '/old/install/src/plugin.ts',
        '/old/install/src/plugins/pantheon-hooks.ts',
        THIRD_PARTY_PLUGIN,
      ],
    })
    // Current ROOT-derived paths must be present
    assert.ok(
      config.plugin.includes(join(ROOT, 'src', 'plugin.ts')),
      'Must have current src/plugin.ts',
    )
    assert.ok(
      config.plugin.includes(join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')),
      'Must have current pantheon-hooks.ts',
    )
    // Third-party preserved
    assert.ok(config.plugin.includes(THIRD_PARTY_PLUGIN))
    // Stale paths may be kept if they are not recognized as Pantheon managed refs
    // (the installer deduplicates by identity, not by path prefix)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. TUI registration
// ---------------------------------------------------------------------------

test('V1 registers TUI plugin in tui.json', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-tui-'))
  try {
    await runV1Install(target)
    const tuiJsonPath = join(target, '.opencode', 'tui.json')
    assert.ok(existsSync(tuiJsonPath), 'tui.json must exist after V1 install')

    const tuiConfig = JSON.parse(readFileSync(tuiJsonPath, 'utf8'))
    // tui.json uses 'plugin' (singular) array — the OpenCode V1 tui loader key
    const pluginList = tuiConfig.plugin || tuiConfig.plugins
    assert.ok(pluginList !== undefined, 'tui.json must have plugin (or plugins) key')
    assert.ok(Array.isArray(pluginList), 'tui.json plugin list must be an array')
    // Must contain the pantheon-tui copied directory
    const hasTui = pluginList.some((p) => typeof p === 'string' && p.includes('pantheon-tui'))
    assert.ok(hasTui, 'tui.json must register pantheon-tui plugin')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 copies TUI plugin to config dir', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-tuifile-'))
  try {
    await runV1Install(target)
    const tuiCopyDir = join(target, '.opencode', 'plugins', 'pantheon-tui')
    assert.ok(existsSync(tuiCopyDir), 'pantheon-tui copy directory must exist')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. $schema and compatibility
// ---------------------------------------------------------------------------

test('V1 fresh install sets $schema', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-schema-'))
  try {
    const config = await runV1Install(target)
    assert.ok(config.$schema !== undefined, 'V1 config must have $schema')
    assert.equal(config.$schema, 'https://opencode.ai/config.json')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 removes todoContinuation (rejected by recent OpenCode)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-todo-'))
  try {
    const config = await runV1Install(target, { todoContinuation: true })
    assert.equal(
      Object.hasOwn(config, 'todoContinuation'),
      false,
      'V1 must remove todoContinuation',
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 writes experimental.subagent_depth=2', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-depth-'))
  try {
    const config = await runV1Install(target)
    assert.ok(config.experimental !== undefined, 'V1 config must have experimental')
    assert.equal(config.experimental.subagent_depth, 2)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. Idempotency
// ---------------------------------------------------------------------------

test('V1 install is idempotent (byte-identical on rerun)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-idempotent-'))
  try {
    await runV1Install(target)
    const configPath = join(target, 'opencode.json')
    const firstBytes = readFileSync(configPath, 'utf8')

    await installOpenCode(target, false, false, COMPONENTS, {
      yes: true,
      headless: true,
      version: 'v1',
    })
    const secondBytes = readFileSync(configPath, 'utf8')
    assert.equal(secondBytes, firstBytes, 'V1 config must be byte-identical on rerun')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 install is idempotent with third-party plugins', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-idemp-3p-'))
  try {
    await runV1Install(target, {
      plugin: [THIRD_PARTY_PLUGIN, THIRD_PARTY_USER_PLUGIN],
    })
    const configPath = join(target, 'opencode.json')
    const firstBytes = readFileSync(configPath, 'utf8')

    await installOpenCode(target, false, false, COMPONENTS, {
      yes: true,
      headless: true,
      version: 'v1',
    })
    const secondBytes = readFileSync(configPath, 'utf8')
    assert.equal(secondBytes, firstBytes, 'V1 config with 3P plugins must be byte-identical')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. Snapshot comparison
// ---------------------------------------------------------------------------

test('V1 config snapshot has expected key structure', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-snapshot-'))
  try {
    const config = await runV1Install(target)

    // Must have these keys
    assert.ok('$schema' in config, 'snapshot must have $schema')
    assert.ok('plugin' in config, 'snapshot must have plugin (singular)')
    assert.ok('permission' in config, 'snapshot must have permission (singular)')
    assert.ok('experimental' in config, 'snapshot must have experimental')
    assert.ok('instructions' in config, 'snapshot must have instructions')

    // Must NOT have these V2 keys
    assert.ok(!('plugins' in config), 'V1 snapshot must not have plugins (plural)')
    assert.ok(!('providers' in config), 'V1 snapshot must not have providers (plural)')
    assert.ok(!('permissions' in config), 'V1 snapshot must not have permissions (plural)')
    assert.ok(!('agents' in config), 'V1 snapshot must not have agents (plural)')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 config snapshot plugin array contains managed paths', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-snap-plugin-'))
  try {
    const config = await runV1Install(target)

    const resolvedDelegation = join(ROOT, 'src', 'plugin.ts')
    const resolvedHooks = join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')
    assert.ok(
      config.plugin.includes(resolvedDelegation),
      'V1 snapshot must include resolved src/plugin.ts',
    )
    assert.ok(
      config.plugin.includes(resolvedHooks),
      'V1 snapshot must include resolved pantheon-hooks.ts',
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 config snapshot permissions contain skill allow rule', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-snap-perm-'))
  try {
    const config = await runV1Install(target)

    assert.ok(config.permission.skill !== undefined, 'V1 snapshot permission must have skill key')
    assert.deepEqual(config.permission.skill, { '*': 'allow' })
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7. Cross-version: V1 after V2 — V1 overwrites correctly
// ---------------------------------------------------------------------------

test('V1 after V2 adds V1 config keys (plugin, permission, provider)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-after-v2-'))
  try {
    // First install V2
    await installOpenCode(target, false, false, COMPONENTS, {
      yes: true,
      headless: true,
      version: 'v2',
    })

    // Now install V1
    await installOpenCode(target, false, false, COMPONENTS, {
      yes: true,
      headless: true,
      version: 'v1',
    })
    const v1Config = JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8'))

    // V1 config must have V1 shape keys
    assert.ok('plugin' in v1Config, 'After V1 overwrite, config must have plugin (singular)')
    assert.ok(
      typeof v1Config.permission === 'object' && !Array.isArray(v1Config.permission),
      'After V1 overwrite, permission must be object',
    )
    // V1 may coexist with leftover V2 keys from previous install — the V1
    // installer adds V1 keys but doesn't strip V2-only keys
    assert.ok(
      v1Config.plugin.includes(join(ROOT, 'src', 'plugin.ts')),
      'V1 plugin must contain delegation plugin',
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 8. Instructions merge
// ---------------------------------------------------------------------------

test('V1 fresh install includes AGENTS.md in instructions', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-instr-'))
  try {
    const config = await runV1Install(target)
    assert.ok(Array.isArray(config.instructions), 'instructions must be an array')
    assert.ok(config.instructions.includes('AGENTS.md'), 'instructions must include AGENTS.md')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V1 preserves user instructions alongside AGENTS.md', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-instr-user-'))
  try {
    const config = await runV1Install(target, {
      instructions: ['my-instructions.md'],
    })
    assert.ok(config.instructions.includes('AGENTS.md'))
    assert.ok(
      config.instructions.includes('my-instructions.md'),
      'User instructions must be preserved',
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 9. Agent permissions (talos edit deny rules)
// ---------------------------------------------------------------------------

test('V1 includes talos agent with permission configuration', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v1-talos-'))
  try {
    const config = await runV1Install(target)
    assert.ok(
      config.agent !== undefined && config.agent.talos !== undefined,
      'V1 config must have agent.talos',
    )
    assert.ok(config.agent.talos.permission !== undefined, 'talos must have permission')
    // Talos permission must be an object with action keys
    assert.ok(
      typeof config.agent.talos.permission === 'object' &&
        !Array.isArray(config.agent.talos.permission),
      'talos.permission must be an object',
    )
    // Talos must have at least read and edit permissions
    assert.ok('read' in config.agent.talos.permission, 'talos must have read permission')
    assert.ok('edit' in config.agent.talos.permission, 'talos must have edit permission')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
