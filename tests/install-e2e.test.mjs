/**
 * install-e2e.test.mjs — End-to-end tests for the OpenCode 2.x install path
 *
 * Pantheon 2.0 targets OpenCode 2.x only (`init --opencode-version v2|auto`).
 * Validates the complete flow:
 *  - Config shape (plugins plural/providers/permissions array/agents object)
 *  - Third-party plugins preserved, legacy V1-shaped configs migrated
 *  - TUI registration correct (no tui.json; config.plugins only)
 *  - Idempotent (byte-identical) output
 *  - Snapshot key structure
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
import { test as nodeTest } from 'node:test'

import { installOpenCode } from '../scripts/install/opencode.mjs'
import { ROOT } from '../scripts/install/shared.mjs'

// Real-install tier: see tests/install-opencode.test.mjs. Excluded from
// `test:node`, opted into by `npm run test:install` (mandatory in the release
// gate).
const INSTALL_TIER = process.env.PANTHEON_RUN_INSTALL_TESTS === '1'
const SKIP_REASON = INSTALL_TIER
  ? false
  : 'install tier: run `npm run test:install` (PANTHEON_RUN_INSTALL_TESTS=1)'
const test = (name, fn) => nodeTest(name, { skip: SKIP_REASON }, fn)

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

/** Return the package/path referenced by a string or object-form plugin entry. */
function pluginReference(entry) {
  return typeof entry === 'string' ? entry : entry?.package
}

/** Assert that config has one managed V2 entry in the current object contract. */
function assertManagedV2Plugin(config) {
  const entries = config.plugins.filter((entry) => pluginReference(entry) === V2_PLUGIN)
  assert.equal(entries.length, 1, 'V2 plugin must appear exactly once')
  assert.equal(typeof entries[0], 'object', 'V2 plugin entry must use object form')
  assert.equal(entries[0].package, V2_PLUGIN, 'V2 plugin package must be the managed directory')
  assert.ok(
    entries[0].options !== null &&
      typeof entries[0].options === 'object' &&
      !Array.isArray(entries[0].options),
    'V2 plugin entry must have an options object',
  )
}

const COMPONENTS = ['agents', 'skills', 'instructions', 'commands', 'plugins']
// OpenCode 2.x is the only supported generation.
const VERSIONS = ['v2']
const USER_PLUGIN = '@scope/custom-v2-plugin'

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

test('fresh init records successful component states and leaves unselected components pending', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-install-state-'))
  try {
    await installOpenCode(target, false, false, ['agents', 'skills', 'commands'], {
      yes: true,
      headless: true,
      version: 'v2',
    })
    const state = JSON.parse(readFileSync(join(target, '.pantheon', 'install-state.json'), 'utf8'))
    assert.equal(state.components.agents.status, 'installed')
    assert.equal(state.components.skills.status, 'installed')
    assert.equal(state.components.plugins.status, 'pending')
    assert.equal(state.components.runtime.status, 'pending')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

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

  test(`[${version}] installs Pantheon slash commands in the host project command directory`, async () => {
    const target = mkdtempSync(join(tmpdir(), `pantheon-e2e-${version}-commands-`))
    try {
      await runInstall(target, version)
      const commandDir = join(target, 'commands')
      const misplacedDir = join(target, '.opencode', 'commands')
      const installed = join(commandDir, 'pantheon-deepwork.md')

      assert.ok(
        existsSync(installed),
        `Pantheon /pantheon-deepwork must be installed at ${installed}`,
      )
      assert.equal(
        readFileSync(installed, 'utf8'),
        readFileSync(join(ROOT, 'commands', 'pantheon-deepwork.md'), 'utf8'),
      )
      assert.equal(
        existsSync(misplacedDir),
        false,
        `commands must not be installed at ${misplacedDir}`,
      )
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })

  test(`[${version}] installs the host-compatible TUI plugin entry`, async () => {
    const target = mkdtempSync(join(tmpdir(), `pantheon-e2e-${version}-tui-`))
    try {
      await runInstall(target, version)
      assert.ok(
        existsSync(join(target, '.opencode', 'plugins', 'pantheon-tui')),
        'pantheon-tui copy directory must exist',
      )
      const tuiPluginDir = join(target, '.opencode', 'plugins', 'pantheon-tui')
      assert.equal(
        existsSync(join(target, '.opencode', 'tui.json')),
        false,
        'the 2.x host discovers local plugin entrypoints; it does not use project tui.json',
      )
      assert.equal(
        readFileSync(join(tuiPluginDir, 'tui.ts'), 'utf8'),
        readFileSync(join(ROOT, 'src', 'plugins', 'tui', 'tui-v2.ts'), 'utf8'),
      )
      assert.equal(
        readFileSync(join(tuiPluginDir, 'index.ts'), 'utf8'),
        readFileSync(join(ROOT, 'src', 'plugins', 'tui', 'index-v2.ts'), 'utf8'),
      )
      assert.equal(
        JSON.parse(readFileSync(join(tuiPluginDir, 'package.json'), 'utf8')).exports['./tui'],
        './dist/tui-v2.js',
      )
      const tuiPackage = JSON.parse(readFileSync(join(tuiPluginDir, 'package.json'), 'utf8'))
      assert.ok(tuiPackage.files.includes('tui.ts'), 'npm package must ship the TUI entrypoint')
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
      const seed = { plugin: [THIRD_PARTY_PLUGIN], plugins: [USER_PLUGIN] }
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
      const config = await runInstall(target, version, {
        plugin: [THIRD_PARTY_PLUGIN],
        plugins: [USER_PLUGIN],
      })
      assert.ok(
        config.plugin.includes(THIRD_PARTY_PLUGIN),
        `Third-party plugin ${THIRD_PARTY_PLUGIN} must be preserved`,
      )
      assert.ok(config.plugins.includes(USER_PLUGIN), 'third-party 2.x plugin preserved')
    } finally {
      rmSync(target, { recursive: true, force: true })
    }
  })
}

// ---------------------------------------------------------------------------
// 2. V2 shape specifics
// ---------------------------------------------------------------------------

test('V2 fresh install produces plugins (plural) as array with managed dir entry', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v2-fresh-'))
  try {
    const config = await runInstall(target, 'v2')
    assert.ok(Array.isArray(config.plugins), 'config.plugins must be an array')
    assertManagedV2Plugin(config)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V2 fresh install registers a directory that carries the loader contract', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v2-dircontract-'))
  try {
    const config = await runInstall(target, 'v2')
    assertManagedV2Plugin(config)
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
      // Server names are the user's own — the installer never invents one, and
      // this install carries no `runtime` component, so any entry here came
      // from the user. Assert the shape for whatever they are called.
      for (const [name, server] of Object.entries(config.mcp)) {
        assert.equal(
          typeof server === 'object' && server !== null && !Array.isArray(server),
          true,
          `V2 mcp.${name} must be a server config object`,
        )
      }
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

test('V2 project agents are installed where the V2 config directory discovers them', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v2-agent-files-'))
  try {
    const config = await runInstall(target, 'v2')

    assert.ok(existsSync(join(target, 'agents', 'hermes.md')))
    assert.ok(existsSync(join(target, 'agents', 'themis.md')))
    assert.ok(!existsSync(join(target, '.opencode', 'agents', 'hermes.md')))
    assert.equal(config.agents.hermes.source, 'agents/hermes.md')
    assert.equal(config.agents.themis.source, 'agents/themis.md')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('V2 agent MCP permissions follow mcp_tools allowlists', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v2-mcp-perms-'))
  try {
    const config = await runInstall(target, 'v2')
    const rules = config.agents.zeus.permissions
    const effect = (action) => rules.findLast((rule) => rule.action === action)?.effect
    assert.equal(effect('subagent'), 'allow')
    assert.equal(effect('task'), undefined)
    assert.equal(effect('pantheon_memory_*'), 'deny')
    assert.equal(effect('pantheon_memory_memory_search'), 'allow')
    assert.equal(effect('pantheon_memory_memory_store'), undefined)
    assert.equal(effect('pantheon_persistence_context_save'), 'allow')
    assert.equal(effect('pantheon_persistence_context_list'), undefined)
    assert.equal(
      config.agents.gaia.permissions.findLast(
        (rule) => rule.action === 'pantheon_vision_vision_analyze',
      )?.effect,
      'allow',
    )

    const mnemosyneRules = config.agents.mnemosyne.permissions
    assert.equal(
      mnemosyneRules.findLast((rule) => rule.action === 'pantheon_memory_memory_forget')?.effect,
      'allow',
    )
    assert.equal(
      mnemosyneRules.some((rule) => rule.action === 'pantheon_memory_memory_delete'),
      false,
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('agents receive only the skills declared in canonical frontmatter', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-agent-skills-v2-'))
  try {
    const config = await runInstall(target, 'v2')
    const rules = config.agents.zeus.permissions.filter((rule) => rule.action === 'skill')
    const effect = (skill) => rules.findLast((rule) => rule.resource === skill)?.effect
    assert.equal(effect('*'), 'deny')
    assert.equal(effect('agent-coordination'), 'allow')
    assert.equal(effect('simplify'), 'allow')
    assert.equal(effect('code-review-checklist'), undefined)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('manual goal tools have exact per-agent grants in the generated config', async () => {
  const goalTools = ['goal_create', 'goal_get', 'goal_update', 'goal_done']
  const expectedFor = (agent) => {
    if (agent === 'zeus') return new Set(goalTools)
    return new Set()
  }

  const target = mkdtempSync(join(tmpdir(), 'pantheon-goal-grants-v2-'))
  try {
    const config = await runInstall(target, 'v2')
    const agents = config.agents
    assert.ok(agents.zeus && agents.athena && agents.themis)
    for (const [agentName, agent] of Object.entries(agents)) {
      const expected = expectedFor(agentName)
      const rules = agent.permissions
      const exactRule = (tool) =>
        rules.findLast((rule) => rule.action === `pantheon_persistence_${tool}`)
      const serverDeny = rules.findLast((rule) => rule.action === 'pantheon_persistence_*')
      assert.equal(serverDeny?.effect, 'deny', `${agentName} default deny`)
      for (const tool of goalTools) {
        assert.equal(
          exactRule(tool)?.effect,
          expected.has(tool) ? 'allow' : undefined,
          `${agentName}/${tool}`,
        )
      }
    }
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('read-only codemap grants are limited to Apollo and Athena; indexing remains denied', async () => {
  const codeTools = ['code_query', 'code_neighbors']
  const otherMemoryTools = [
    'memory_store',
    'memory_recall',
    'memory_forget',
    'memory_list',
    'memory_stats',
  ]
  const expectedAgents = new Set(['apollo', 'athena'])

  const target = mkdtempSync(join(tmpdir(), 'pantheon-codemap-grants-v2-'))
  try {
    const config = await runInstall(target, 'v2')
    const agents = config.agents
    assert.ok(agents.apollo && agents.athena && agents.zeus)

    for (const [agentName, agent] of Object.entries(agents)) {
      const expected = expectedAgents.has(agentName)
      const rules = agent.permissions
      const effect = (action) => rules.findLast((rule) => rule.action === action)?.effect
      assert.equal(effect('pantheon_memory_*'), 'deny', `${agentName} Memory default deny`)
      assert.equal(
        effect('pantheon_memory_code_index'),
        undefined,
        `${agentName}/code_index must remain denied`,
      )
      for (const tool of codeTools) {
        assert.equal(
          effect(`pantheon_memory_${tool}`),
          expected ? 'allow' : undefined,
          `${agentName}/${tool}`,
        )
      }
      if (expected) {
        assert.equal(effect('pantheon_memory_memory_search'), 'allow', `${agentName} memory_search`)
        for (const tool of otherMemoryTools) {
          assert.equal(
            effect(`pantheon_memory_${tool}`),
            undefined,
            `${agentName}/${tool} must remain ungranted`,
          )
        }
        assert.equal(effect('pantheon_code_mode_*'), 'deny', `${agentName} Code Mode deny`)
        assert.equal(effect('pantheon_code_mode_execute_code_script'), undefined)
      }
      if (agentName === 'mnemosyne') {
        assert.equal(effect('pantheon_memory_memory_search'), 'allow')
        for (const tool of otherMemoryTools) {
          assert.equal(effect(`pantheon_memory_${tool}`), 'allow')
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
    assertManagedV2Plugin(config)
    const references = config.plugins.map(pluginReference)
    assert.ok(!references.includes(V2_EXPORT), 'npm-shorthand ref must migrate')
    assert.ok(!references.includes(V2_LEGACY_FILE), 'legacy file ref must migrate')
    assert.ok(references.includes('other-plugin'))
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
// 3. Legacy-config migration (a V1-shaped config is recognized, never recreated)
// ---------------------------------------------------------------------------

test('V2 install over a legacy V1-shaped config adds V2 config keys (plugins, providers, permissions)', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-v2-after-v1-'))
  try {
    // A pre-2.0 config on disk: singular `plugin`/`permission` keys, no
    // `plugins` list. The install recognizes the legacy shape and migrates it.
    const legacy = await runInstall(target, 'v2', {
      plugin: [THIRD_PARTY_PLUGIN, join(ROOT, 'src', 'plugin.ts')],
      permission: { bash: { '*': 'allow' } },
    })
    assert.ok('plugin' in legacy, 'the legacy singular key survives for third-party entries')
    const v2Config = await runInstall(target, 'v2')
    assert.ok('plugins' in v2Config, 'After V2 overwrite, config must have plugins (plural)')
    assertManagedV2Plugin(v2Config)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('legacy V1-shaped config round-trip adds the V2 plugin entry', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-e2e-roundtrip-v2-'))
  try {
    // Seed the exact marker of a pre-2.0 install instead of running a V1
    // install (the V1 code path no longer exists).
    const seeded = await runInstall(target, 'v2', {
      plugin: [join(ROOT, 'src', 'plugin.ts'), join(ROOT, 'src', 'plugins', 'pantheon-hooks.ts')],
    })
    assert.ok(
      !seeded.plugin?.includes(join(ROOT, 'src', 'plugin.ts')),
      'the stale V1 ref must be stripped on the first V2 install',
    )
    const v2Config = await runInstall(target, 'v2')
    assert.ok('plugins' in v2Config, 'Must have V2 plugins key after the V2 install')
    assertManagedV2Plugin(v2Config)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
