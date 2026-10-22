/**
 * install-config-migration.test.mjs — TDD tests for V1↔V2 config migration
 *
 * Test suite for the config-migration.mjs module that converts
 * opencode.json between V1 (object-based) and V2 (array-based) formats.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { pathToFileURL } from 'node:url'
import {
  CONTEXT_SANDBOX_LIMIT_FIELDS,
  MANAGED_AGENT_FIELDS,
  managedAgentFieldDrift,
  mergeContextSandboxBlocks,
  migrateV1toV2,
  migrateV2toV1,
} from '../scripts/install/config-migration.mjs'
import { applyMcpServerEntries, MANAGED_FIELDS } from '../scripts/install/opencode.mjs'
import { ROOT } from '../scripts/install/shared.mjs'

const MIGRATION_MODULE = join(ROOT, 'scripts', 'install', 'config-migration.mjs')

/**
 * Agent fields that belong to the user: the merge must carry them across when
 * only the V1 block has them, and must never overwrite them with the V1 value
 * when both do. Used by the gap-fill tests; kept out of MANAGED_AGENT_FIELDS
 * on purpose, which those tests assert rather than assume.
 */
const USER_FIELDS = ['description', 'model', 'provider', 'mcp']
for (const field of USER_FIELDS) {
  assert.ok(
    !MANAGED_AGENT_FIELDS.includes(field),
    `USER_FIELDS must stay non-managed, or the gap-fill tests assert the wrong thing: ${field}`,
  )
}

/**
 * Run `fn` while capturing console.warn output. Warnings are part of the
 * migration contract — a permission conflict must be reported with what
 * actually happened, so tests assert on the message, not only on the result.
 */
function withCapturedWarnings(fn) {
  const original = console.warn
  const warnings = []
  console.warn = (...args) => warnings.push(args.map(String).join(' '))
  try {
    return { value: fn(), warnings }
  } finally {
    console.warn = original
  }
}

/**
 * Conservative glob matcher used to evaluate the emitted rules the way the
 * host does (last-match-wins). `*` on its own is the catch-all; `**` crosses
 * `/`; other `*` do not.
 */
function globMatches(pattern, resource) {
  if (pattern === '*') return true
  let source = '^'
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*'
        i++
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
    }
  }
  return new RegExp(`${source}$`).test(resource)
}

/** Last rule that matches decides, exactly like the host measurement. */
function effectiveEffect(permissions, action, resource) {
  let effect
  for (const rule of permissions) {
    if (rule.action === action && globMatches(rule.resource, resource)) effect = rule.effect
  }
  return effect
}

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
  plugins: ['src/plugin-v2'],
  experimental: { subagent_depth: 2 },
  permission: {
    skill: { '*': 'allow' },
    websearch: 'deny',
    task: { '*': 'allow' },
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
      url: 'https://example.com/mcp',
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
 * Permission order is the canonical emission order, not V1 key iteration:
 * least specific first (* → globs → literal) so the most specific matching
 * rule wins under last-match-wins; at equal specificity, least restrictive
 * first (allow → ask → deny/unknown ordering), with code-unit tie-breaks.
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
  plugins: ['src/plugin-v2'],
  experimental: { subagent_depth: 2 },
  permissions: [
    { action: 'shell', resource: 'git *', effect: 'allow' },
    { action: 'shell', resource: 'npm *', effect: 'allow' },
    { action: 'shell', resource: 'npx *', effect: 'allow' },
    { action: 'shell', resource: 'pip *', effect: 'allow' },
    { action: 'shell', resource: 'pytest *', effect: 'allow' },
    { action: 'shell', resource: 'python3 *', effect: 'allow' },
    { action: 'shell', resource: 'ruff *', effect: 'allow' },
    { action: 'skill', resource: '*', effect: 'allow' },
    { action: 'subagent', resource: '*', effect: 'allow' },
    { action: 'websearch', resource: '*', effect: 'deny' },
  ],
  mcp: {
    bifrost: {
      type: 'remote',
      url: 'https://example.com/mcp',
      enabled: true,
    },
  },
  agents: {
    talos: {
      permissions: [
        { action: 'edit', resource: '*', effect: 'allow' },
        { action: 'edit', resource: '**/*.sql', effect: 'deny' },
        { action: 'edit', resource: '**/alembic/**', effect: 'deny' },
        { action: 'edit', resource: '**/auth/**', effect: 'deny' },
        { action: 'edit', resource: '**/migrations/**', effect: 'deny' },
        { action: 'edit', resource: '**/models/**', effect: 'deny' },
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
      const subagentPerm = v2.permissions.find((p) => p.action === 'subagent')
      assert.deepEqual(subagentPerm, { action: 'subagent', resource: '*', effect: 'allow' })
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

    it('maps V1 permission.write to the host action the V2 hosts evaluate (edit)', () => {
      // P0-5 evidence: every V2 host (2.0.22, 2.0.30, 2.1.0, 2.1.2) evaluates a
      // `write` tool call under the action name `edit`, so a rule emitted as
      // `write` never decides that call — `permission.write: deny` must block
      // writes, which only an `edit` rule does.
      const v2 = migrateV1toV2({ permission: { write: 'deny' } })
      assert.deepEqual(v2.permissions, [{ action: 'edit', resource: '*', effect: 'deny' }])
    })

    it('maps agent-level permission.write to edit as well', () => {
      const v2 = migrateV1toV2({
        agent: { hermes: { permission: { write: { 'src/**': 'deny' } } } },
      })
      assert.deepEqual(v2.agents.hermes.permissions, [
        { action: 'edit', resource: 'src/**', effect: 'deny' },
      ])
    })

    it('resolves a write+edit collision by restrictiveness, not iteration order', () => {
      // Both V1 keys collapse onto `edit`. The winner must be deny regardless of
      // which key the object happens to list first, and the collision must not
      // emit two conflicting rules for the same action+resource.
      const orders = [
        { write: 'deny', edit: 'allow' },
        { edit: 'allow', write: 'deny' },
        { write: 'allow', edit: 'deny' },
        { edit: 'deny', write: 'allow' },
        { write: 'ask', edit: 'allow' },
        { edit: 'allow', write: 'ask' },
        { write: 'allow', edit: 'ask' },
      ]
      const expected = ['deny', 'deny', 'deny', 'deny', 'ask', 'ask', 'ask']
      for (const [index, permission] of orders.entries()) {
        const v2 = migrateV1toV2({ permission })
        assert.deepEqual(
          v2.permissions,
          [{ action: 'edit', resource: '*', effect: expected[index] }],
          `wrong resolution for ${JSON.stringify(permission)}`,
        )
      }
    })

    it('keeps non-colliding write/edit resource rules as separate edit entries', () => {
      const v2 = migrateV1toV2({
        permission: { write: { '*.md': 'allow' }, edit: { '*.lock': 'deny' } },
      })
      assert.deepEqual(v2.permissions, [
        { action: 'edit', resource: '*.md', effect: 'allow' },
        { action: 'edit', resource: '*.lock', effect: 'deny' },
      ])
    })

    // ── P0-5 security review: deny must never be demoted ───────────────────
    it('never demotes deny to an unrecognized effect, in either order', () => {
      const orders = [
        { edit: 'deny', write: 'bogus' },
        { write: 'bogus', edit: 'deny' },
      ]
      for (const permission of orders) {
        const v2 = migrateV1toV2({ permission })
        assert.deepEqual(
          v2.permissions,
          [{ action: 'edit', resource: '*', effect: 'deny' }],
          `deny was lost for ${JSON.stringify(permission)}`,
        )
      }
    })

    it('never lets an unrecognized effect replace a known effect, in either order', () => {
      const cases = [
        { permission: { edit: 'allow', write: 'bogus' }, expected: 'allow' },
        { permission: { write: 'bogus', edit: 'allow' }, expected: 'allow' },
        { permission: { edit: 'ask', write: 'bogus' }, expected: 'ask' },
        { permission: { write: 'bogus', edit: 'ask' }, expected: 'ask' },
      ]
      for (const { permission, expected } of cases) {
        const { value: v2 } = withCapturedWarnings(() => migrateV1toV2({ permission }))
        assert.deepEqual(
          v2.permissions,
          [{ action: 'edit', resource: '*', effect: expected }],
          `wrong resolution for ${JSON.stringify(permission)}`,
        )
      }
    })

    it('keeps the first effect when both are unrecognized, and says so honestly', () => {
      const { value: first, warnings } = withCapturedWarnings(() =>
        migrateV1toV2({ permission: { write: 'bogus-a', edit: 'bogus-b' } }),
      )
      assert.deepEqual(first.permissions, [{ action: 'edit', resource: '*', effect: 'bogus-a' }])
      assert.ok(
        warnings.some((m) => m.includes('unrecognized') && m.includes('keeping the first')),
        `warning must describe keeping the first: ${JSON.stringify(warnings)}`,
      )

      const { value: second } = withCapturedWarnings(() =>
        migrateV1toV2({ permission: { edit: 'bogus-b', write: 'bogus-a' } }),
      )
      assert.deepEqual(second.permissions, [{ action: 'edit', resource: '*', effect: 'bogus-b' }])
    })

    it('describes an ignored unrecognized effect instead of claiming restrictiveness', () => {
      const { warnings } = withCapturedWarnings(() =>
        migrateV1toV2({ permission: { edit: 'deny', write: 'bogus' } }),
      )
      assert.ok(warnings.some((m) => m.includes('unrecognized') && m.includes('deny')))
      assert.ok(
        !warnings.some((m) => m.includes('more restrictive')),
        `deny-vs-unknown must not be described as a restrictiveness win: ${JSON.stringify(warnings)}`,
      )
    })

    // ── P0-5 security review: Object.prototype keys are not actions ────────
    it('passes prototype-named V1 permission keys through as literal string actions', () => {
      // JSON.parse creates own `__proto__`/`constructor`/`toString` keys that an
      // object literal cannot. `map[key] || key` used to resolve the inherited
      // values and emit entries with a missing or object-valued `action`.
      const permission = JSON.parse('{"__proto__":"deny","constructor":"deny","toString":"deny"}')
      const v2 = migrateV1toV2({ permission })
      assert.equal(v2.permissions.length, 3)
      for (const entry of v2.permissions) {
        assert.equal(
          typeof entry.action,
          'string',
          `action must be a string: ${JSON.stringify(entry)}`,
        )
      }
      assert.deepEqual(v2.permissions.map((p) => p.action).sort(), [
        '__proto__',
        'constructor',
        'toString',
      ])
    })

    // ── P0-5 MCP gating: `permission.mcp.<server>` must become an action rule ──
    // Measured on 2.0.29/2.0.30/2.1.0/2.1.2/2.1.3: the host evaluates an MCP
    // tool call as `<server>_<tool>` with resources ["*"]. The V1 key
    // `permission.mcp.<server>` (and `action:"mcp"`, and `resource`) is inert,
    // so passing it through produced a config that protected nothing.
    describe('permission.mcp translation (P0-5 MCP gating evidence)', () => {
      it('translates permission.mcp.<server>: deny to the enforced <server>_* glob', () => {
        const v2 = migrateV1toV2({
          permission: { mcp: { 'pantheon-code-mode': 'deny' } },
        })
        assert.deepEqual(v2.permissions, [
          { action: 'pantheon-code-mode_*', resource: '*', effect: 'deny' },
        ])
        assert.equal(
          v2.permissions.some((rule) => rule.action === 'mcp'),
          false,
          'the inert `mcp` action must not be emitted',
        )
      })

      it('translates permission.mcp.<server>: allow to an explicit allow glob', () => {
        const v2 = migrateV1toV2({
          permission: { mcp: { 'pantheon-memory': 'allow' } },
        })
        assert.deepEqual(v2.permissions, [
          { action: 'pantheon-memory_*', resource: '*', effect: 'allow' },
        ])
      })

      it('emits no rule for an invalid server name and says why (B7)', () => {
        for (const server of ['*', 'my server']) {
          const { value: v2, warnings } = withCapturedWarnings(() =>
            migrateV1toV2({ permission: { mcp: { [server]: 'deny' } } }),
          )
          assert.deepEqual(
            v2.permissions,
            [],
            `no rule for invalid server ${JSON.stringify(server)}`,
          )
          const message = warnings.join('\n')
          assert.match(message, /invalid/i, `the warning must say the name is invalid: ${message}`)
          assert.ok(
            message.includes(server),
            `the warning must name the invalid server: ${message}`,
          )
          assert.match(message, /no rule was emitted/i, message)
        }
      })

      it('emits no rule for permission.mcp.<server>: ask and says why', () => {
        const { value: v2, warnings } = withCapturedWarnings(() =>
          migrateV1toV2({
            permission: { mcp: { 'pantheon-vision': 'ask' } },
          }),
        )
        assert.deepEqual(v2.permissions, [], 'ask must not become a rule at all')
        const message = warnings.join('\n')
        assert.match(message, /pantheon-vision/, `the server must be named: ${message}`)
        assert.match(message, /ask/i)
        assert.match(message, /not expressible/i)
        assert.match(message, /remain/i, 'the warning must state the tool stays available')
        assert.match(message, /deny/i, 'the warning must name the enforceable alternative')
        assert.doesNotMatch(
          message,
          /translated|converted to "deny"/i,
          `ask must not be described as converted: ${message}`,
        )
      })

      it('is deterministic for the same permission.mcp in a different key order', () => {
        const forward = {
          'pantheon-vision': 'ask',
          'pantheon-code-mode': 'deny',
          'pantheon-memory': 'allow',
        }
        const reversed = {
          'pantheon-memory': 'allow',
          'pantheon-code-mode': 'deny',
          'pantheon-vision': 'ask',
        }
        const first = withCapturedWarnings(() => migrateV1toV2({ permission: { mcp: forward } }))
        const second = withCapturedWarnings(() => migrateV1toV2({ permission: { mcp: reversed } }))
        assert.deepEqual(first.value.permissions, second.value.permissions)
        assert.deepEqual(first.warnings, second.warnings)
        assert.deepEqual(first.value.permissions, [
          { action: 'pantheon-code-mode_*', resource: '*', effect: 'deny' },
          { action: 'pantheon-memory_*', resource: '*', effect: 'allow' },
        ])
      })

      it('leaves other MCP server effects and the rest of the V1 block untouched', () => {
        const { value: v2, warnings } = withCapturedWarnings(() =>
          migrateV1toV2({
            permission: {
              mcp: { 'pantheon-code-mode': 'deny', 'pantheon-vision': 'ask' },
              read: 'allow',
            },
          }),
        )
        assert.deepEqual(v2.permissions, [
          { action: 'pantheon-code-mode_*', resource: '*', effect: 'deny' },
          { action: 'read', resource: '*', effect: 'allow' },
        ])
        assert.equal(warnings.length, 1, JSON.stringify(warnings))
      })
    })

    // ── B2 (policy 2): specificity decides between distinct resources ───────
    // `*` → glob → literal, so under last-match-wins the most specific rule
    // wins. Within one specificity, allow → ask → unknown → deny (most
    // restrictive last).
    describe('permission rule ordering — specificity decides', () => {
      const denyWildcardFirst = { write: 'deny', edit: { 'src/**': 'allow' } }
      const allowNestedFirst = { edit: { 'src/**': 'allow' }, write: 'deny' }

      it('produces the same canonical config regardless of V1 key order', () => {
        const first = migrateV1toV2({ permission: denyWildcardFirst }).permissions
        const second = migrateV1toV2({ permission: allowNestedFirst }).permissions
        assert.deepEqual(first, second)
        assert.deepEqual(first, [
          { action: 'edit', resource: '*', effect: 'deny' },
          { action: 'edit', resource: 'src/**', effect: 'allow' },
        ])
      })

      it('lets the specific allow win inside the broad deny, in either order', () => {
        // The trailing `src/**` allow overrides the catch-all deny for that
        // scope; everything outside it stays denied.
        for (const permission of [denyWildcardFirst, allowNestedFirst]) {
          const rules = migrateV1toV2({ permission }).permissions
          assert.equal(effectiveEffect(rules, 'edit', 'src/index.ts'), 'allow')
          assert.equal(effectiveEffect(rules, 'edit', 'README.md'), 'deny')
        }
      })

      it('resolves wildcard allow + nested-glob deny to deny, in either order', () => {
        const orders = [
          { write: 'allow', edit: { 'src/**': 'deny' } },
          { edit: { 'src/**': 'deny' }, write: 'allow' },
        ]
        for (const permission of orders) {
          const rules = migrateV1toV2({ permission }).permissions
          assert.deepEqual(rules, [
            { action: 'edit', resource: '*', effect: 'allow' },
            { action: 'edit', resource: 'src/**', effect: 'deny' },
          ])
          assert.equal(effectiveEffect(rules, 'edit', 'src/index.ts'), 'deny')
        }
      })

      it('does not warn for the intended scoped allow inside a broad deny', () => {
        // The V1 resource map is the documented way to express an exception to
        // a catch-all. Warning on it would fire for every mnemosyne-style
        // template, so the decision is: same-source scoping is intentional.
        const { warnings } = withCapturedWarnings(() =>
          migrateV1toV2({ permission: denyWildcardFirst }),
        )
        assert.ok(
          !warnings.some((m) => m.includes('does not apply')),
          `unexpected suppression warning: ${JSON.stringify(warnings)}`,
        )
      })

      it('warns when a persisted V2 deny is neutralised by a V1 allow in a scope', () => {
        const merges = [
          {
            permission: { write: { 'src/generated/**': 'allow' } },
            permissions: [{ action: 'edit', resource: '*', effect: 'deny' }],
          },
          {
            permission: { write: { '*': 'deny' } },
            permissions: [{ action: 'edit', resource: 'src/generated/**', effect: 'allow' }],
          },
        ]
        for (const config of merges) {
          const { warnings } = withCapturedWarnings(() => migrateV1toV2(config))
          assert.ok(
            warnings.some(
              (m) =>
                m.includes('does not apply') &&
                m.includes('deny') &&
                m.includes('src/generated/**'),
            ),
            `missing cross-source warning: ${JSON.stringify(warnings)}`,
          )
        }
      })

      it('is stable with three or more rules of mixed specificity', () => {
        const orderA = { edit: { 'src/a.ts': 'allow', 'src/**': 'deny', '*': 'ask' } }
        const orderB = { edit: { '*': 'ask', 'src/**': 'deny', 'src/a.ts': 'allow' } }
        const first = migrateV1toV2({ permission: orderA }).permissions
        const second = migrateV1toV2({ permission: orderB }).permissions
        assert.deepEqual(first, second)
        assert.deepEqual(first, [
          { action: 'edit', resource: '*', effect: 'ask' },
          { action: 'edit', resource: 'src/**', effect: 'deny' },
          { action: 'edit', resource: 'src/a.ts', effect: 'allow' },
        ])
      })
    })

    // ── B2 (policy 2): the real mnemosyne template ──────────────────────────
    describe('permission rule ordering — mnemosyne memory-bank scope', () => {
      const MNEMOSYNE_PERMISSION = {
        bash: 'deny',
        read: 'allow',
        grep: 'allow',
        write: {
          '*': 'deny',
          '.pantheon/memory-bank/**': 'allow',
          '.pantheon/deepwork/**': 'allow',
        },
        edit: {
          '*': 'deny',
          '.pantheon/memory-bank/**': 'allow',
          '.pantheon/deepwork/**': 'allow',
        },
        task: { '*': 'deny' },
      }

      const convert = (permission) =>
        migrateV1toV2({ agent: { mnemosyne: { permission } } }).agents.mnemosyne.permissions

      it('keeps the memory-bank and deepwork write scopes usable, denying the rest', () => {
        const rules = convert(MNEMOSYNE_PERMISSION)
        assert.deepEqual(
          rules.filter((rule) => rule.action === 'edit'),
          [
            { action: 'edit', resource: '*', effect: 'deny' },
            { action: 'edit', resource: '.pantheon/deepwork/**', effect: 'allow' },
            { action: 'edit', resource: '.pantheon/memory-bank/**', effect: 'allow' },
          ],
        )
        assert.equal(
          effectiveEffect(rules, 'edit', '.pantheon/memory-bank/01-active-context.md'),
          'allow',
        )
        assert.equal(effectiveEffect(rules, 'edit', '.pantheon/deepwork/task.md'), 'allow')
        assert.equal(effectiveEffect(rules, 'edit', 'src/index.ts'), 'deny')
        assert.equal(effectiveEffect(rules, 'edit', 'README.md'), 'deny')
        assert.equal(
          rules.some((rule) => rule.action === 'write'),
          false,
          'write is the host edit action',
        )
      })

      it('is deterministic for the same template in a different key order', () => {
        const reordered = {
          task: { '*': 'deny' },
          edit: {
            '.pantheon/memory-bank/**': 'allow',
            '.pantheon/deepwork/**': 'allow',
            '*': 'deny',
          },
          write: {
            '.pantheon/deepwork/**': 'allow',
            '*': 'deny',
            '.pantheon/memory-bank/**': 'allow',
          },
          grep: 'allow',
          read: 'allow',
          bash: 'deny',
        }
        assert.deepEqual(convert(reordered), convert(MNEMOSYNE_PERMISSION))
      })
    })

    // ── B6: never reorder a V2-only array into a weaker decision ────────────
    describe('existing V2 permissions ordering (B6)', () => {
      const literalDeny = [
        { action: 'edit', resource: 'a.ts', effect: 'allow' },
        { action: 'edit', resource: '*', effect: 'deny' },
      ]
      const globDeny = [
        { action: 'edit', resource: 'src/generated/**', effect: 'allow' },
        { action: 'edit', resource: '*', effect: 'deny' },
      ]

      it('does not reorder a V2-only array, so a literal deny stays deny', () => {
        const { value: v2, warnings } = withCapturedWarnings(() =>
          migrateV1toV2({ permissions: literalDeny }),
        )
        assert.deepEqual(v2.permissions, literalDeny, 'V2-only order must be preserved')
        assert.equal(effectiveEffect(v2.permissions, 'edit', 'a.ts'), 'deny')
        assert.ok(
          !warnings.some((m) => /canonical order|reorder/i.test(m)),
          JSON.stringify(warnings),
        )
      })

      it('does not reorder a V2-only array, so a glob deny stays deny', () => {
        const { value: v2, warnings } = withCapturedWarnings(() =>
          migrateV1toV2({ permissions: globDeny }),
        )
        assert.deepEqual(v2.permissions, globDeny)
        assert.equal(effectiveEffect(v2.permissions, 'edit', 'src/generated/client.ts'), 'deny')
        assert.ok(
          !warnings.some((m) => /canonical order|reorder/i.test(m)),
          JSON.stringify(warnings),
        )
      })

      it('does not treat an empty V1 block as a reason to reorder a pure V2 array', () => {
        const cases = [
          { input: literalDeny, resource: 'a.ts' },
          { input: globDeny, resource: 'src/generated/client.ts' },
        ]
        for (const { input, resource } of cases) {
          const { value: v2, warnings } = withCapturedWarnings(() =>
            migrateV1toV2({ permission: {}, permissions: input }),
          )
          assert.deepEqual(v2.permissions, input, 'an empty V1 block must not touch the V2 array')
          assert.equal(effectiveEffect(v2.permissions, 'edit', resource), 'deny')
          assert.ok(
            !warnings.some((m) => m.includes('canonical order')),
            `no reorder warning expected: ${JSON.stringify(warnings)}`,
          )
          assert.ok(
            !warnings.some((m) => m.includes('both "permission"')),
            `an empty V1 block is not a merge: ${JSON.stringify(warnings)}`,
          )
        }
      })

      it('warns when a merge reorders a deny into an allow (literal)', () => {
        const { value: v2, warnings } = withCapturedWarnings(() =>
          migrateV1toV2({ permission: { read: 'allow' }, permissions: literalDeny }),
        )
        assert.equal(effectiveEffect(v2.permissions, 'edit', 'a.ts'), 'allow')
        const message = warnings.find((m) => m.includes('canonical order'))
        assert.ok(message, `missing ordering warning: ${JSON.stringify(warnings)}`)
        assert.match(message, /a\.ts/)
        assert.match(message, /deny/)
        assert.match(message, /allow/)
      })

      it('warns when a merge reorders a deny into an allow (glob)', () => {
        const { warnings } = withCapturedWarnings(() =>
          migrateV1toV2({ permission: { read: 'allow' }, permissions: globDeny }),
        )
        assert.ok(
          warnings.some(
            (m) =>
              m.includes('canonical order') && m.includes('src/generated/**') && m.includes('deny'),
          ),
          JSON.stringify(warnings),
        )
      })

      it('does not warn when reordering leaves the effective effect unchanged', () => {
        const disjoint = [
          { action: 'edit', resource: 'x.ts', effect: 'allow' },
          { action: 'edit', resource: 'src/**', effect: 'deny' },
        ]
        const { warnings } = withCapturedWarnings(() =>
          migrateV1toV2({ permission: { read: 'allow' }, permissions: disjoint }),
        )
        assert.ok(!warnings.some((m) => m.includes('canonical order')), JSON.stringify(warnings))
      })

      it('does not throw on malformed entries and preserves them with a warning', () => {
        const malformed = [null, { action: 'read', resource: '*', effect: 'allow' }]
        const v2Only = withCapturedWarnings(() => migrateV1toV2({ permissions: malformed }))
        assert.deepEqual(v2Only.value.permissions, malformed)
        assert.ok(
          v2Only.warnings.some((m) => /malformed/i.test(m)),
          JSON.stringify(v2Only.warnings),
        )

        const merged = withCapturedWarnings(() =>
          migrateV1toV2({ permission: { read: 'allow' }, permissions: malformed }),
        )
        assert.ok(merged.value.permissions.includes(null), 'malformed entry preserved')
        assert.ok(
          merged.warnings.some((m) => /malformed/i.test(m)),
          JSON.stringify(merged.warnings),
        )
      })
    })

    it('should convert MCP format (enabled → disabled)', () => {
      const v2 = migrateV1toV2(V1_CONFIG)
      assert.ok(v2.mcp.bifrost, 'flat mcp.bifrost exists')
      assert.equal(v2.mcp.servers, undefined, 'mcp.servers wrapper is not valid')
      const b = v2.mcp.bifrost
      assert.equal(b.enabled, true, 'enabled flag is preserved')
      assert.equal(b.timeout, undefined, 'no timeout when V1 had none')
    })

    it('should convert MCP timeout when present', () => {
      const v1WithTimeout = {
        mcp: {
          myserver: { type: 'local', enabled: true, timeout: 30000 },
        },
      }
      const v2 = migrateV1toV2(v1WithTimeout)
      assert.equal(v2.mcp.myserver.timeout, 30000)
    })

    it('should drop the legacy boolean feature toggle left by the servers wrapper', () => {
      // Installers that seeded `mcp.servers = { enabled: true }` left a
      // non-server entry behind; unwrapping must not turn it into an empty
      // server object that OpenCode 1.18.x would reject.
      const legacy = {
        mcp: {
          servers: { enabled: true },
          bifrost: { type: 'remote', url: 'https://example.com/mcp', enabled: true },
        },
      }
      const v2 = migrateV1toV2(legacy)
      assert.ok(v2.mcp.bifrost, 'real server preserved')
      assert.equal(v2.mcp.servers, undefined, 'wrapper removed')
      assert.equal(v2.mcp.enabled, undefined, 'boolean toggle not converted to a server entry')
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

  // ── `agent` + `agents` coexistence ───────────────────────────────────────
  // The installed opencode.json carries BOTH blocks: `agent` (V1 singular,
  // written by the v1 install path) and `agents` (V2 plural). Renaming one
  // onto the other with a shallow spread let whichever key came second replace
  // the whole per-agent object, so the Pantheon-managed merge — source,
  // temperature, permissions — was thrown away on a real config.
  //
  // The fix reuses the semantics the installer already applies at
  // install/opencode.mjs:881-884: the V2 `agents` block is the base and the
  // framework-managed fields coming from the V1 `agent` block overwrite it.
  // Everything the user set and Pantheon does not manage is preserved.
  describe('migrateV1toV2 — agent and agents coexist', () => {
    it('renames a pure V1 agent block into agents', () => {
      const v2 = migrateV1toV2({
        agent: { zeus: { mode: 'primary', source: 'agents/zeus.md' } },
      })
      assert.equal(v2.agent, undefined, 'singular block removed')
      assert.deepEqual(v2.agents, { zeus: { mode: 'primary', source: 'agents/zeus.md' } })
    })

    it('leaves an already-V2 agents block untouched', () => {
      const agents = { zeus: { mode: 'subagent', steps: 53 } }
      const v2 = migrateV1toV2({ agents })
      assert.deepEqual(v2.agents, agents, 'no conversion needed, no rewrite')
    })

    it('merges both blocks for the same agent instead of clobbering', () => {
      const v2 = migrateV1toV2({
        agent: { zeus: { source: 'agents/zeus.md', temperature: 0.2 } },
        agents: { zeus: { mode: 'subagent', steps: 53 } },
      })
      assert.equal(v2.agents.zeus.source, 'agents/zeus.md', 'managed field from V1 survives')
      assert.equal(v2.agents.zeus.temperature, 0.2, 'managed field from V1 survives')
      assert.equal(v2.agents.zeus.mode, 'subagent', 'user field from V2 preserved')
      assert.equal(v2.agents.zeus.steps, 53, 'user field from V2 preserved')
    })

    it('unions agents that appear in only one of the two blocks', () => {
      const v2 = migrateV1toV2({
        agent: { onlyV1: { mode: 'primary' }, both: { source: 'agents/both.md' } },
        agents: { onlyV2: { mode: 'subagent' }, both: { mode: 'subagent' } },
      })
      assert.deepEqual(Object.keys(v2.agents).sort(), ['both', 'onlyV1', 'onlyV2'])
      assert.equal(v2.agents.onlyV1.mode, 'primary', 'V1-only agent migrated')
      assert.equal(v2.agents.onlyV2.mode, 'subagent', 'V2-only agent untouched')
      assert.equal(v2.agents.both.source, 'agents/both.md', 'shared agent merged')
      assert.equal(v2.agents.both.mode, 'subagent', 'shared agent kept the user field')
    })

    it('lets the framework-managed field win when both blocks set it', () => {
      // Same precedence as install/opencode.mjs:881-884 — managed fields are
      // framework-owned, so the V1 value is authoritative.
      const v2 = migrateV1toV2({
        agent: { zeus: { mode: 'primary', temperature: 0.2 } },
        agents: { zeus: { mode: 'subagent', temperature: 0.9 } },
      })
      assert.equal(v2.agents.zeus.mode, 'primary', 'managed field overwritten by the V1 value')
      assert.equal(v2.agents.zeus.temperature, 0.2, 'managed field overwritten by the V1 value')
    })

    it('still carries steps when it is present in the input', () => {
      // Agnosticism guard: the converter moves values, it never drops them.
      // Stripping the stale ceiling is the installer's job (opencode.mjs).
      const v2 = migrateV1toV2({ agent: { zeus: { mode: 'primary', steps: 45 } } })
      assert.equal(v2.agents.zeus.steps, 45, 'the pure converter must not lose fields')
    })

    it('falls back to replacing when the existing agents block is not an object', () => {
      const notAMap = migrateV1toV2({
        agent: { zeus: { mode: 'primary' } },
        agents: 'nope',
      })
      assert.deepEqual(notAMap.agents, { zeus: { mode: 'primary' } }, 'previous behaviour: replace')

      const badEntry = migrateV1toV2({
        agent: { zeus: { mode: 'primary' } },
        agents: { zeus: 'nope' },
      })
      assert.deepEqual(
        badEntry.agents,
        { zeus: { mode: 'primary' } },
        'previous behaviour: replace',
      )
    })

    it('carries over a V1-only field instead of dropping it (N3)', () => {
      // The installer preserves `description` on an existing agent — it is
      // written for NEW agents only, never for existing ones ("Existing agent
      // fields belong to the user"). So the migration must not treat it as
      // framework-managed, but dropping it because the V2 base happens to lack
      // the key loses the user's value outright, and nothing writes it back on
      // any later install. V1-only keys are therefore carried over; the base
      // still wins on conflict.
      const migrated = migrateV1toV2({
        agent: { zeus: { description: 'from V1' } },
        agents: { zeus: { model: 'x' } },
      })
      assert.deepEqual(
        migrated.agents.zeus,
        { model: 'x', description: 'from V1' },
        'a V1-only field must survive the merge, not vanish',
      )
    })

    it('lets the V2 base keep its own value when both blocks set the field', () => {
      // Counterpart of the test above: carrying over is a gap fill, not a
      // takeover. `description` stays user-owned, so the base wins.
      const migrated = migrateV1toV2({
        agent: { zeus: { description: 'from V1' } },
        agents: { zeus: { description: 'from V2' } },
      })
      assert.equal(migrated.agents.zeus.description, 'from V2', 'user field from V2 preserved')
    })

    it('carries over any field the base lacks, not just description', () => {
      // The gap fill is not description-specific. Any key living only in the V1
      // block used to vanish here — `model`, `provider` and `mcp` included,
      // which are exactly the values the installer's own merge calls
      // user-customized ("Preserve user-customized fields (model, provider,
      // mcp, etc.)"). Once dropped, no later install writes them back.
      for (const field of USER_FIELDS) {
        const migrated = migrateV1toV2({
          agent: { zeus: { [field]: 'from V1' } },
          agents: { zeus: { mode: 'subagent' } },
        })
        assert.equal(
          migrated.agents.zeus[field],
          'from V1',
          `a key present only in the V1 block must survive the merge: ${field}`,
        )
      }
    })

    it('never lets the gap fill overwrite a value the base already has', () => {
      // Counterpart of the test above: carrying over fills a hole, it is not a
      // takeover. Only MANAGED_AGENT_FIELDS is framework-owned; every other key
      // is the user's, so the V2 base keeps its value. Asserting the fields are
      // non-managed keeps a future list change from failing here for a reason
      // this test never claimed.
      for (const field of USER_FIELDS) {
        const migrated = migrateV1toV2({
          agent: { zeus: { [field]: 'from V1' } },
          agents: { zeus: { [field]: 'from V2' } },
        })
        assert.equal(
          migrated.agents.zeus[field],
          'from V2',
          `a non-managed key present in both blocks must keep the base value: ${field}`,
        )
      }
    })

    it('produces the same result whichever order agent and agents appear in', () => {
      // The bug these tests guard was order-dependent: whichever key came second
      // replaced the other block wholesale, so a config carrying both in the
      // `agents`-first order silently lost the managed merge, and the
      // `agent`-first order silently lost the user's fields. Order independence
      // is the invariant the fix actually delivers, and the one a refactor is
      // most likely to break without anyone noticing — the two blocks are read
      // in whatever order the JSON happens to have. Asserted as an equality
      // between the two constructions rather than by restating the merge rules
      // twice, which would only re-derive whatever the current code does.
      const v1Block = { zeus: { mode: 'primary', source: 'agents/zeus.md' } }
      const v2Block = { zeus: { mode: 'subagent', steps: 53 }, onlyV2: { mode: 'subagent' } }
      // Literal insertion order in the literals below is the order the
      // migration iterates (`Object.entries` of the seed), so these two seeds
      // really do exercise the two orders.
      const agentFirst = migrateV1toV2({ agent: v1Block, agents: v2Block })
      const agentsFirst = migrateV1toV2({ agents: v2Block, agent: v1Block })
      assert.deepEqual(agentFirst, agentsFirst, 'key order must not change the result')
      // Pin the content as well: "equal" on its own would also hold if both
      // orders dropped everything on the way through.
      assert.deepEqual(agentFirst.agents.zeus, {
        mode: 'primary',
        source: 'agents/zeus.md',
        steps: 53,
      })
      assert.deepEqual(Object.keys(agentsFirst.agents).sort(), ['onlyV2', 'zeus'])
    })

    it('every field the migration declares managed overwrites the V2 base', () => {
      // Behavioral half of the guard: whatever MANAGED_AGENT_FIELDS claims must
      // actually win over the base when both blocks are present.
      for (const field of MANAGED_AGENT_FIELDS) {
        const merged = migrateV1toV2({
          agent: { zeus: { [field]: 'from-v1' } },
          agents: { zeus: { mode: 'subagent' } },
        }).agents.zeus
        assert.equal(merged[field], 'from-v1', `managed field ${field} must overwrite the V2 base`)
      }
    })

    it('uses the same managed-field list as the installer, in both directions', () => {
      // The two lists must not drift: the migration reimplements the installer's
      // merge because it runs before it, so both must agree on the field names.
      // `source` is written next to MANAGED_FIELDS, so the migration must treat
      // it as managed too. Equality is asserted as a SET in both directions —
      // checking one side only would let a field the migration claims as managed
      // start overwriting user config that the installer never touches.
      assert.deepEqual(
        managedAgentFieldDrift([...MANAGED_FIELDS, 'source']),
        { onlyInMigration: [], onlyInInstaller: [] },
        'the managed-field lists must be equal as sets, in both directions',
      )
    })

    it('the drift guard fails when the migration list gains a field (N1)', async () => {
      // The destructive failure this guard exists for: adding `model` to the
      // migration's managed list makes it overwrite the user's model on every
      // install, and the old one-directional guard stayed green. Assert the
      // guard rejects the mutation. Applied to a COPY of the module so the repo
      // is never dirtied.
      const dir = mkdtempSync(join(tmpdir(), 'pantheon-drift-'))
      try {
        const copy = join(dir, 'config-migration.mjs')
        const original = readFileSync(MIGRATION_MODULE, 'utf8')
        const mutated = original.replace(
          /(const MANAGED_AGENT_FIELDS = (?:Object\.freeze\(\s*)?\[)/,
          "$1\n  'model',",
        )
        assert.notEqual(mutated, original, 'the mutation must apply, or this test is vacuous')
        writeFileSync(copy, mutated)
        const drifted = await import(pathToFileURL(copy).href)
        assert.deepEqual(
          drifted.managedAgentFieldDrift([...MANAGED_FIELDS, 'source']),
          { onlyInMigration: ['model'], onlyInInstaller: [] },
          'a field added to the migration list must be reported as drift',
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('the drift guard fails when the installer list gains a field', () => {
      // Same guard, opposite side: a field the installer starts writing must be
      // reported too, or the migration would stop mirroring it.
      assert.deepEqual(managedAgentFieldDrift([...MANAGED_FIELDS, 'source', 'steps']), {
        onlyInMigration: [],
        onlyInInstaller: ['steps'],
      })
    })
  })

  // ── `permission` + `permissions` coexistence ─────────────────────────────
  // A config can carry the V1 `permission` block and the V2 `permissions`
  // array at the same time. Before, whichever key the object listed last
  // replaced the other wholesale, so the converted V1 rules (or the existing
  // V2 array) were silently dropped. The V2 array is the base; V1 rules are
  // merged into it and conflicts resolve by restrictiveness, so both key
  // orders produce the same result.
  describe('migrateV1toV2 — permission and permissions coexist', () => {
    const V1_PERMISSION = { edit: 'allow', bash: { 'git *': 'allow' } }
    const V2_PERMISSIONS = [
      { action: 'edit', resource: '*', effect: 'deny' },
      { action: 'shell', resource: 'npm *', effect: 'allow' },
    ]
    const normalize = (permissions) =>
      permissions.map((p) => `${p.action}\u0000${p.resource}\u0000${p.effect}`).sort()

    it('produces the same merged permissions whichever key comes first', () => {
      const orders = [
        { permission: V1_PERMISSION, permissions: V2_PERMISSIONS },
        { permissions: V2_PERMISSIONS, permission: V1_PERMISSION },
      ]
      const results = orders.map((config) => normalize(migrateV1toV2(config).permissions))
      assert.deepEqual(results[0], results[1])
      assert.deepEqual(
        results[0],
        normalize([
          { action: 'edit', resource: '*', effect: 'deny' },
          { action: 'shell', resource: 'npm *', effect: 'allow' },
          { action: 'shell', resource: 'git *', effect: 'allow' },
        ]),
      )
    })

    it('never discards the existing V2 array', () => {
      const orders = [
        { permission: { edit: 'allow' }, permissions: V2_PERMISSIONS },
        { permissions: V2_PERMISSIONS, permission: { edit: 'allow' } },
      ]
      for (const config of orders) {
        const { value: v2 } = withCapturedWarnings(() => migrateV1toV2(config))
        const rules = normalize(v2.permissions)
        assert.ok(rules.includes('shell\u0000npm *\u0000allow'), 'V2-only rule survived')
        assert.ok(rules.includes('edit\u0000*\u0000deny'), 'V2 deny survived')
      }
    })

    it('never discards the rules converted from the V1 block', () => {
      const orders = [
        { permission: { bash: { 'git *': 'deny' } }, permissions: [] },
        { permissions: [], permission: { bash: { 'git *': 'deny' } } },
      ]
      for (const config of orders) {
        const v2 = migrateV1toV2(config)
        assert.deepEqual(v2.permissions, [{ action: 'shell', resource: 'git *', effect: 'deny' }])
      }
    })

    it('warns when the two blocks carry a real conflict', () => {
      const { warnings } = withCapturedWarnings(() =>
        migrateV1toV2({ permission: { edit: 'allow' }, permissions: V2_PERMISSIONS }),
      )
      assert.ok(
        warnings.some((m) => m.includes('conflicting') && m.includes('more restrictive')),
        `conflict must be reported: ${JSON.stringify(warnings)}`,
      )
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
      assert.equal(v1.permission.task, 'allow')
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

    // ── P0-5 security review: the reverse map is not "last wins" ───────────
    it('resolves duplicate V2 rules by restrictiveness, not array order', () => {
      const orders = [
        [
          { action: 'edit', resource: '*', effect: 'deny' },
          { action: 'edit', resource: '*', effect: 'allow' },
        ],
        [
          { action: 'edit', resource: '*', effect: 'allow' },
          { action: 'edit', resource: '*', effect: 'deny' },
        ],
      ]
      for (const permissions of orders) {
        const v1 = migrateV2toV1({ permissions })
        assert.equal(v1.permission.edit, 'deny', JSON.stringify(permissions))
      }
    })

    it('applies the same restrictiveness to resource-level collisions', () => {
      const v1 = migrateV2toV1({
        permissions: [
          { action: 'edit', resource: 'src/**', effect: 'allow' },
          { action: 'edit', resource: 'src/**', effect: 'deny' },
        ],
      })
      assert.deepEqual(v1.permission.edit, { 'src/**': 'deny' })
    })

    it('keeps prototype-named V2 actions as literal own keys', () => {
      const v1 = migrateV2toV1({
        permissions: ['__proto__', 'constructor', 'toString'].map((action) => ({
          action,
          resource: '*',
          effect: 'deny',
        })),
      })
      for (const action of ['__proto__', 'constructor', 'toString']) {
        assert.ok(Object.hasOwn(v1.permission, action), `${action} must be an own key`)
        assert.equal(v1.permission[action], 'deny')
      }
      assert.equal(Object.getPrototypeOf(v1.permission), Object.prototype)
      assert.equal(Object.hasOwn(v1.permission, '[object Object]'), false)
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
      assert.ok(v2.mcp.bifrost)
      assert.ok(v2.agents)
      // Permission count: 7 shell + 1 skill + 1 websearch + 1 subagent = 10
      assert.equal(v2.permissions.length, 10)
      // Agent permission count: 6 edit + 2 shell = 8
      assert.equal(v2.agents.talos.permissions.length, 8)
      // MCP disabled
      assert.equal(v2.mcp.bifrost.enabled, true)
    })
  })

  describe('mergeContextSandboxBlocks — V1 top-level → V2 plugin options', () => {
    it('copies the legacy block verbatim when there is no explicit V2 value', () => {
      const legacy = { enabled: false, limits: { read: { maxLines: 12, keepHead: 4 } } }
      assert.deepEqual(mergeContextSandboxBlocks(undefined, legacy), legacy)
    })

    it('lets an explicit V2 leaf win over the legacy leaf', () => {
      const merged = mergeContextSandboxBlocks(
        { limits: { read: { maxLines: 10 } } },
        { limits: { read: { maxLines: 5, keepHead: 3 } } },
      )
      assert.deepEqual(merged, { limits: { read: { maxLines: 10, keepHead: 3 } } })
    })

    it('lets an explicit V2 enabled win over the legacy enabled', () => {
      assert.equal(mergeContextSandboxBlocks({ enabled: true }, { enabled: false }).enabled, true)
      assert.equal(mergeContextSandboxBlocks({ enabled: false }, { enabled: true }).enabled, false)
    })

    it('preserves explicit false and numeric 0 (not treated as unset)', () => {
      const merged = mergeContextSandboxBlocks(
        { enabled: false, limits: { read: { keepHead: 0 } } },
        { enabled: true, limits: { read: { keepHead: 9, keepTail: 2 } } },
      )
      assert.equal(merged.enabled, false)
      assert.equal(merged.limits.read.keepHead, 0)
      assert.equal(merged.limits.read.keepTail, 2)
    })

    it('fills every known leaf group from the legacy block', () => {
      const merged = mergeContextSandboxBlocks(undefined, {
        limits: {
          read: { maxLines: 1, keepHead: 2, keepTail: 3 },
          grep: { maxResults: 4, keepTop: 5 },
          glob: { maxFiles: 6, keepTop: 7 },
          webfetch: { maxChars: 8, keepHead: 9 },
        },
      })
      assert.deepEqual(merged.limits, {
        read: { maxLines: 1, keepHead: 2, keepTail: 3 },
        grep: { maxResults: 4, keepTop: 5 },
        glob: { maxFiles: 6, keepTop: 7 },
        webfetch: { maxChars: 8, keepHead: 9 },
      })
    })

    it('returns an empty object for an empty legacy block', () => {
      assert.deepEqual(mergeContextSandboxBlocks(undefined, {}), {})
    })

    it('is idempotent — merging the result again changes nothing', () => {
      const legacy = { enabled: false, limits: { read: { maxLines: 3 } } }
      const once = mergeContextSandboxBlocks(undefined, legacy)
      const twice = mergeContextSandboxBlocks(once, legacy)
      assert.deepEqual(twice, once)
    })

    it('rejects a null legacy block', () => {
      assert.throws(() => mergeContextSandboxBlocks(undefined, null), /must be an object/)
    })

    it('rejects a non-object legacy block', () => {
      assert.throws(() => mergeContextSandboxBlocks(undefined, 'off'), /must be an object/)
      assert.throws(() => mergeContextSandboxBlocks(undefined, [1, 2]), /must be an object/)
    })

    it('rejects a non-boolean enabled', () => {
      assert.throws(() => mergeContextSandboxBlocks(undefined, { enabled: 'yes' }), /boolean/)
    })

    it('rejects a null limits object', () => {
      assert.throws(() => mergeContextSandboxBlocks(undefined, { limits: null }), /limits must be/)
    })

    it('rejects a null known leaf group', () => {
      assert.throws(
        () => mergeContextSandboxBlocks(undefined, { limits: { read: null } }),
        /limits\.read must be an object/,
      )
    })

    it('rejects a non-numeric or negative leaf', () => {
      assert.throws(
        () => mergeContextSandboxBlocks(undefined, { limits: { read: { maxLines: 'big' } } }),
        /non-negative number/,
      )
      assert.throws(
        () => mergeContextSandboxBlocks(undefined, { limits: { grep: { keepTop: -1 } } }),
        /non-negative number/,
      )
      assert.throws(
        () => mergeContextSandboxBlocks(undefined, { limits: { read: { keepTail: Number.NaN } } }),
        /non-negative number/,
      )
    })

    it('ignores unknown keys rather than rejecting them', () => {
      const merged = mergeContextSandboxBlocks(undefined, {
        custom: true,
        limits: { read: { maxLines: 2, customLeaf: 99 } },
      })
      assert.deepEqual(merged, { limits: { read: { maxLines: 2 } } })
    })

    it('exposes the field map used for validation', () => {
      assert.deepEqual(Object.keys(CONTEXT_SANDBOX_LIMIT_FIELDS), [
        'read',
        'grep',
        'glob',
        'webfetch',
      ])
    })
  })
})

// ---------------------------------------------------------------------------
// Installer defaults: `permission.mcp.<server>: ask` is not enforceable
// ---------------------------------------------------------------------------

describe('applyMcpServerEntries — MCP ask warning', () => {
  const context = { runtimeTarget: '/tmp/pantheon-runtime', venvPython: '/tmp/venv/bin/python3' }

  it('keeps the ask defaults but warns that they do not gate the server', () => {
    const config = {}
    const { warnings } = applyMcpServerEntries(config, context)

    assert.equal(config.permission.mcp['pantheon-code-mode'], 'ask')
    assert.equal(config.permission.mcp['pantheon-vision'], 'ask')
    assert.equal(warnings.length, 2, JSON.stringify(warnings))
    for (const server of ['pantheon-code-mode', 'pantheon-vision']) {
      const message = warnings.find((warning) => warning.includes(`permission.mcp.${server}`))
      assert.ok(message, `no warning named ${server}: ${JSON.stringify(warnings)}`)
      assert.match(message, /not enforceable/i)
      assert.match(message, /remain available/i)
      assert.match(message, new RegExp(`${server}_\\*`))
    }
  })

  it('does not warn when the MCP permission map has no ask entry', () => {
    const config = {
      permission: { mcp: { 'pantheon-code-mode': 'deny', 'pantheon-vision': 'deny' } },
    }
    const { warnings } = applyMcpServerEntries(config, context)
    assert.deepEqual(warnings, [])
  })

  it('does not warn for V1, where the MCP permission semantics were not measured', () => {
    const config = {}
    const { warnings } = applyMcpServerEntries(config, { ...context, version: 'v1' })
    assert.deepEqual(warnings, [])
    assert.equal(config.permission.mcp['pantheon-code-mode'], 'ask')
  })

  it('does not repeat the installer ask warning during a V2 install', () => {
    const config = {}
    const installer = applyMcpServerEntries(config, context)
    assert.equal(installer.warnings.length, 2, 'the installer reports one per ask server')

    const { warnings } = withCapturedWarnings(() => migrateV1toV2(config))
    const duplicates = warnings.filter(
      (message) => /ask/i.test(message) && /pantheon-(code-mode|vision)/.test(message),
    )
    assert.deepEqual(
      duplicates,
      [],
      `the migration repeated the warning: ${JSON.stringify(warnings)}`,
    )
  })

  it('still warns from the migration path when the installer did not run', () => {
    const { warnings } = withCapturedWarnings(() =>
      migrateV1toV2({ permission: { mcp: { 'custom-server': 'ask' } } }),
    )
    assert.equal(
      warnings.filter((message) => message.includes('custom-server')).length,
      1,
      JSON.stringify(warnings),
    )
  })
})
