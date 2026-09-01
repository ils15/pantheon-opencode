/**
 * install-config-migration.test.mjs — TDD tests for V1↔V2 config migration
 *
 * Test suite for the config-migration.mjs module that converts
 * opencode.json between V1 (object-based) and V2 (array-based) formats.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { migrateV1toV2, migrateV2toV1 } from '../scripts/install/config-migration.mjs'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Real-world V1 config from this project's opencode.json */
const V1_CONFIG = {
  $schema: 'https://opencode.ai/config.json',
  provider: {
    'opencode-go': {
      models: {
        'mimo-v2.5': {
          attachment: true,
          modalities: { input: ['text', 'image'] },
        },
      },
    },
  },
  default_agent: 'zeus',
  plugins: ['pantheon-opencode/plugin-v2'],
  experimental: { subagent_depth: 2 },
  permission: {
    skill: { '*': 'allow' },
    websearch: 'deny',
    bash: {
      'git *': 'allow',
      'npm *': 'allow',
      'npx *': 'allow',
      'pytest *': 'allow',
      'ruff *': 'allow',
      'pip *': 'allow',
      'python3 *': 'allow',
    },
  },
  mcp: {
    bifrost: {
      type: 'remote',
      url: 'https://llm.ofertachina.cloud/mcp',
      enabled: true,
    },
  },
  agent: {
    talos: {
      permission: {
        edit: {
          '*': 'allow',
          '**/migrations/**': 'deny',
          '**/alembic/**': 'deny',
          '**/models/**': 'deny',
          '**/auth/**': 'deny',
          '**/*.sql': 'deny',
        },
        bash: {
          '*': 'allow',
          'alembic *': 'deny',
        },
      },
    },
  },
}

/** Minimal V1 config with variant field */
const V1_WITH_VARIANT = {
  provider: {
    anthropic: {
      models: {
        'claude-sonnet-4-5': { variant: 'high' },
      },
    },
  },
}

/**
 * Expected V2 output of migrateV1toV2(V1_CONFIG).
 *
 * Permission order follows V1 object key iteration:
 * skill → websearch → bash (shell entries).
 * MCP has no timeout since V1 had none.
 */
const V2_EXPECTED = {
  $schema: 'https://opencode.ai/config.json',
  providers: {
    'opencode-go': {
      models: {
        'mimo-v2.5': {
          modalities: { input: ['text', 'image'] },
          media: true,
        },
      },
    },
  },
  default_agent: 'zeus',
  plugins: ['pantheon-opencode/plugin-v2'],
  experimental: { subagent_depth: 2 },
  permissions: [
    { action: 'skill', resource: '*', effect: 'allow' },
    { action: 'websearch', resource: '*', effect: 'deny' },
    { action: 'shell', resource: 'git *', effect: 'allow' },
    { action: 'shell', resource: 'npm *', effect: 'allow' },
    { action: 'shell', resource: 'npx *', effect: 'allow' },
    { action: 'shell', resource: 'pytest *', effect: 'allow' },
    { action: 'shell', resource: 'ruff *', effect: 'allow' },
    { action: 'shell', resource: 'pip *', effect: 'allow' },
    { action: 'shell', resource: 'python3 *', effect: 'allow' },
  ],
  mcp: {
    servers: {
      bifrost: {
        type: 'remote',
        url: 'https://llm.ofertachina.cloud/mcp',
        disabled: false,
      },
    },
  },
  agents: {
    talos: {
      permissions: [
        { action: 'edit', resource: '*', effect: 'allow' },
        { action: 'edit', resource: '**/migrations/**', effect: 'deny' },
        { action: 'edit', resource: '**/alembic/**', effect: 'deny' },
        { action: 'edit', resource: '**/models/**', effect: 'deny' },
        { action: 'edit', resource: '**/auth/**', effect: 'deny' },
        { action: 'edit', resource: '**/*.sql', effect: 'deny' },
        { action: 'shell', resource: '*', effect: 'allow' },
        { action: 'shell', resource: 'alembic *', effect: 'deny' },
      ],
    },
  },
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('config-migration', () => {
  describe('migrateV1toV2', () => {
    it('should rename top-level keys', () => {
      const v2 = migrateV1toV2(V1_CONFIG)
      assert.ok(v2.providers, 'provider → providers')
      assert.ok(v2.agents, 'agent → agents')
      assert.ok(v2.permissions, 'permission → permissions')
      assert.ok(v2.default_agent, 'default_agent preserved')
      assert.equal(v2.providers['opencode-go'].models['mimo-v2.5'].media, true)
    })

    it('should remove old V1 top-level keys', () => {
      const v2 = migrateV1toV2(V1_CONFIG)
      assert.equal(v2.provider, undefined, 'provider removed')
      assert.equal(v2.agent, undefined, 'agent removed')
      assert.equal(v2.permission, undefined, 'permission removed')
    })

    it('should convert permission object to array', () => {
      const v2 = migrateV1toV2(V1_CONFIG)
      assert.ok(Array.isArray(v2.permissions), 'permissions is array')
      // shell commands
      const shellPerms = v2.permissions.filter((p) => p.action === 'shell')
      assert.equal(shellPerms.length, 7, '7 shell permissions')
      // skill
      const skillPerm = v2.permissions.find((p) => p.action === 'skill')
      assert.deepEqual(skillPerm, { action: 'skill', resource: '*', effect: 'allow' })
      // websearch
      const wsPerm = v2.permissions.find((p) => p.action === 'websearch')
      assert.deepEqual(wsPerm, { action: 'websearch', resource: '*', effect: 'deny' })
    })

    it('should convert agent permissions (nested)', () => {
      const v2 = migrateV1toV2(V1_CONFIG)
      const talos = v2.agents.talos
      assert.ok(Array.isArray(talos.permissions), 'agent permissions is array')
      assert.equal(talos.permissions.length, 8, '8 agent permissions')
      const editDenyMigrations = talos.permissions.find(
        (p) => p.action === 'edit' && p.resource === '**/migrations/**',
      )
      assert.deepEqual(editDenyMigrations, {
        action: 'edit',
        resource: '**/migrations/**',
        effect: 'deny',
      })
    })

    it('should convert MCP format (enabled → disabled)', () => {
      const v2 = migrateV1toV2(V1_CONFIG)
      assert.ok(v2.mcp.servers, 'mcp.servers exists')
      assert.equal(v2.mcp.bifrost, undefined, 'old mcp.bifrost removed')
      const b = v2.mcp.servers.bifrost
      assert.equal(b.disabled, false, 'enabled:true → disabled:false')
      assert.equal(b.timeout, undefined, 'no timeout when V1 had none')
    })

    it('should convert MCP timeout when present', () => {
      const v1WithTimeout = {
        mcp: {
          myserver: { type: 'local', enabled: true, timeout: 30000 },
        },
      }
      const v2 = migrateV1toV2(v1WithTimeout)
      assert.deepEqual(v2.mcp.servers.myserver.timeout, {
        catalog: 30000,
        execution: 30000,
      })
    })

    it('should handle provider model variant → #suffix', () => {
      const v2 = migrateV1toV2(V1_WITH_VARIANT)
      const modelKey = Object.keys(v2.providers.anthropic.models)[0]
      assert.equal(modelKey, 'claude-sonnet-4-5#high', 'variant becomes #suffix')
      const model = v2.providers.anthropic.models[modelKey]
      assert.equal(model.variant, undefined, 'variant field removed')
    })

    it('should rename model-level attachment → media', () => {
      const v2 = migrateV1toV2(V1_CONFIG)
      const model = v2.providers['opencode-go'].models['mimo-v2.5']
      assert.equal(model.media, true, 'attachment renamed to media')
      assert.equal(model.attachment, undefined, 'attachment removed')
    })

    it('should not mutate the original config (deep clone)', () => {
      const original = JSON.parse(JSON.stringify(V1_CONFIG))
      migrateV1toV2(V1_CONFIG)
      assert.deepEqual(V1_CONFIG, original, 'original unchanged')
    })

    it('should pass through unknown fields', () => {
      const configWithUnknown = {
        ...V1_CONFIG,
        my_custom_field: { nested: true },
        permission: { ...V1_CONFIG.permission, custom_action: { '*': 'allow' } },
      }
      const v2 = migrateV1toV2(configWithUnknown)
      assert.equal(v2.my_custom_field.nested, true, 'unknown top-level preserved')
      const customPerm = v2.permissions.find((p) => p.action === 'custom_action')
      assert.ok(customPerm, 'unknown permission action preserved')
    })

    it('should handle empty config', () => {
      const v2 = migrateV1toV2({})
      assert.deepEqual(v2, {}, 'empty config returns empty')
    })

    it('should handle config with only $schema', () => {
      const v2 = migrateV1toV2({ $schema: 'https://opencode.ai/config.json' })
      assert.equal(v2.$schema, 'https://opencode.ai/config.json')
    })
  })

  describe('migrateV2toV1', () => {
    it('should reverse top-level renames', () => {
      const v1 = migrateV2toV1(V2_EXPECTED)
      assert.ok(v1.provider, 'providers → provider')
      assert.ok(v1.agent, 'agents → agent')
      assert.ok(v1.permission, 'permissions → permission')
    })

    it('should remove V2-only keys', () => {
      const v1 = migrateV2toV1(V2_EXPECTED)
      assert.equal(v1.providers, undefined)
      assert.equal(v1.agents, undefined)
      assert.equal(v1.permissions, undefined)
    })

    it('should convert permissions array back to object', () => {
      const v1 = migrateV2toV1(V2_EXPECTED)
      assert.ok(typeof v1.permission === 'object' && !Array.isArray(v1.permission))
      // bash (shell) permissions grouped
      assert.deepEqual(v1.permission.bash, {
        'git *': 'allow',
        'npm *': 'allow',
        'npx *': 'allow',
        'pytest *': 'allow',
        'ruff *': 'allow',
        'pip *': 'allow',
        'python3 *': 'allow',
      })
      // skill with only * resource → scalar
      assert.equal(v1.permission.skill, 'allow')
      // websearch with only * resource → scalar
      assert.equal(v1.permission.websearch, 'deny')
    })

    it('should convert agent permissions back to nested object', () => {
      const v1 = migrateV2toV1(V2_EXPECTED)
      assert.ok(typeof v1.agent.talos.permission === 'object')
      assert.deepEqual(v1.agent.talos.permission.edit, {
        '*': 'allow',
        '**/migrations/**': 'deny',
        '**/alembic/**': 'deny',
        '**/models/**': 'deny',
        '**/auth/**': 'deny',
        '**/*.sql': 'deny',
      })
    })

    it('should reverse MCP format (disabled → enabled, no timeout passthrough)', () => {
      const v1 = migrateV2toV1(V2_EXPECTED)
      assert.ok(v1.mcp.bifrost, 'servers.bifrost → mcp.bifrost')
      assert.equal(v1.mcp.bifrost.enabled, true, 'disabled:false → enabled:true')
      assert.equal(v1.mcp.bifrost.timeout, undefined, 'no timeout when V2 had none')
      assert.equal(v1.mcp.servers, undefined, 'servers removed')
    })

    it('should reverse MCP timeout object → flat number', () => {
      const v2WithTimeout = {
        mcp: {
          servers: {
            myserver: {
              type: 'local',
              disabled: false,
              timeout: { catalog: 15000, execution: 30000 },
            },
          },
        },
      }
      const v1 = migrateV2toV1(v2WithTimeout)
      assert.equal(v1.mcp.myserver.timeout, 30000, 'execution timeout used')
    })

    it('should rename model-level media → attachment', () => {
      const v2 = {
        providers: { myprovider: { models: { 'gpt-4': { media: true } } } },
      }
      const v1 = migrateV2toV1(v2)
      assert.equal(v1.provider.myprovider.models['gpt-4'].attachment, true)
      assert.equal(v1.provider.myprovider.models['gpt-4'].media, undefined)
    })

    it('should not mutate the original config (deep clone)', () => {
      const original = JSON.parse(JSON.stringify(V2_EXPECTED))
      migrateV2toV1(V2_EXPECTED)
      assert.deepEqual(V2_EXPECTED, original, 'original unchanged')
    })

    it('should handle empty V2 config', () => {
      const v1 = migrateV2toV1({})
      assert.deepEqual(v1, {})
    })
  })

  describe('round-trip', () => {
    it('V1 → V2 → V1 preserves core structure', () => {
      const v2 = migrateV1toV2(V1_CONFIG)
      const v1back = migrateV2toV1(v2)
      // Top-level structure
      assert.deepEqual(Object.keys(v1back).sort(), Object.keys(V1_CONFIG).sort())
      // Permissions object structure — bash commands
      assert.ok(typeof v1back.permission === 'object')
      assert.deepEqual(v1back.permission.bash, V1_CONFIG.permission.bash)
      // Agent permissions
      assert.deepEqual(v1back.agent.talos.permission, V1_CONFIG.agent.talos.permission)
      // MCP
      assert.equal(v1back.mcp.bifrost.enabled, true)
      assert.equal(v1back.mcp.bifrost.url, V1_CONFIG.mcp.bifrost.url)
      // Provider
      assert.deepEqual(Object.keys(v1back.provider), Object.keys(V1_CONFIG.provider))
    })

    it('V2 → V1 → V2 preserves data', () => {
      const v1 = migrateV2toV1(V2_EXPECTED)
      const v2back = migrateV1toV2(v1)
      // Permissions (may differ in order but same content)
      assert.deepEqual(
        v2back.permissions.sort((a, b) => a.action.localeCompare(b.action)),
        V2_EXPECTED.permissions.sort((a, b) => a.action.localeCompare(b.action)),
      )
      assert.deepEqual(v2back.agents, V2_EXPECTED.agents)
      assert.deepEqual(v2back.mcp, V2_EXPECTED.mcp)
    })
  })

  describe('snapshot test — project opencode.json → V2', () => {
    it('matches expected V2 snapshot', () => {
      const v2 = migrateV1toV2(JSON.parse(JSON.stringify(V1_CONFIG)))
      assert.equal(v2.$schema, 'https://opencode.ai/config.json')
      assert.ok(v2.providers['opencode-go'])
      assert.ok(v2.permissions)
      assert.ok(Array.isArray(v2.permissions))
      assert.ok(v2.mcp.servers)
      assert.ok(v2.agents)
      // Permission count: 7 shell + 1 skill + 1 websearch = 9
      assert.equal(v2.permissions.length, 9)
      // Agent permission count: 6 edit + 2 shell = 8
      assert.equal(v2.agents.talos.permissions.length, 8)
      // MCP disabled
      assert.equal(v2.mcp.servers.bifrost.disabled, false)
    })
  })
})
