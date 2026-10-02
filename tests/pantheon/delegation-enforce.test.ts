/**
 * Tests for Read-Only Enforcement (Phase 4) — delegation-enforce.ts.
 *
 * Throw matrix for the `tool.execute.before` guard:
 *   - read-only session (registered directly via `readOnlyRegistry`):
 *     edit | write | bash | task → guard THROWS with an actionable message
 *   - non-read-only session: same tools → allowed
 *   - unknown session: default policy ALLOWS (normal agent work must not break)
 *   - non-blocked tools (read/grep/glob) in read-only session → allowed
 *
 * The legacy delegate toolset that populated `readOnlyRegistry` was removed in
 * favour of native `task()`; the registry is now populated by the plugin's
 * `chat.params` hook via `syncReadOnlySession` (apollo/gaia — the read-only
 * agents from routing.yml) and pruned on `session.deleted`.
 *
 * Run with: npx tsx tests/pantheon/delegation-enforce.test.ts
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

import yaml from 'js-yaml'

import {
  createEnforcementGuard,
  DEFAULT_BLOCKED_TOOLS,
  isReadOnlyAgent,
  READ_ONLY_AGENTS,
  ReadOnlySessionRegistry,
  readOnlyRegistry,
  syncReadOnlySession,
  type ToolExecuteBeforeHandler,
  zeusReadGuard,
} from '../../src/pantheon/delegation-enforce.ts'

// ─── Harness ───────────────────────────────────────────────────────────

const results: { name: string; passed: boolean; error?: string }[] = []

async function testAsync(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    results.push({ name, passed: true })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ name, passed: false, error: msg })
  }
}

function makeGuard(): ToolExecuteBeforeHandler {
  return createEnforcementGuard({ getReadOnlySessions: () => readOnlyRegistry.sessionIDs() })
}

/** Invoke the guard, returning the thrown error or null when allowed. */
async function runGuard(
  guard: ToolExecuteBeforeHandler,
  tool: string,
  sessionID: string,
): Promise<Error | null> {
  try {
    await guard({ tool, sessionID, callID: `call-${tool}-${sessionID}` })
    return null
  } catch (e: unknown) {
    return e instanceof Error ? e : new Error(String(e))
  }
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  await testAsync(
    'throw matrix: edit|write|bash|task THROW for a registered read-only session, with why + what-to-do message',
    async () => {
      readOnlyRegistry.clear()
      readOnlyRegistry.register('ses_ro', { agent: 'apollo' })
      const guard = makeGuard()

      for (const tool of DEFAULT_BLOCKED_TOOLS) {
        const err = await runGuard(guard, tool, 'ses_ro')
        assert.ok(err, `tool "${tool}" must be denied in a read-only session`)
        assert.match(err?.message, /read-only/i, `message must explain WHY (${tool})`)
        assert.match(
          err?.message,
          /task|dispatch|delegate/i,
          `message must say WHAT TO DO INSTEAD (${tool})`,
        )
      }
      assert.equal(DEFAULT_BLOCKED_TOOLS.has('task'), true, 'task must be blocked (depth-2)')
    },
  )

  await testAsync('non-read-only session: same tools are allowed (no throw)', async () => {
    readOnlyRegistry.clear()
    readOnlyRegistry.register('ses_ro', { agent: 'apollo' })
    const guard = makeGuard()
    for (const tool of DEFAULT_BLOCKED_TOOLS) {
      const err = await runGuard(guard, tool, 'ses_rw')
      assert.equal(err, null, `tool "${tool}" must be allowed for a non-read-only session`)
    }
  })

  await testAsync(
    'unknown session: default policy ALLOWS (normal agent work is never blocked)',
    async () => {
      readOnlyRegistry.clear()
      const guard = makeGuard()
      for (const tool of DEFAULT_BLOCKED_TOOLS) {
        const err = await runGuard(guard, tool, 'ses_unknown')
        assert.equal(
          err,
          null,
          `tool "${tool}" must be allowed for an unregistered session (safe default)`,
        )
      }
    },
  )

  await testAsync(
    'non-blocked tools (read/grep/glob) stay allowed in read-only sessions',
    async () => {
      readOnlyRegistry.clear()
      readOnlyRegistry.register('ses_ro', { agent: 'apollo' })
      const guard = makeGuard()
      for (const tool of ['read', 'grep', 'glob', 'webfetch']) {
        const err = await runGuard(guard, tool, 'ses_ro')
        assert.equal(err, null, `read-only agent must still be able to call "${tool}"`)
      }
    },
  )

  await testAsync(
    'registry: unregister + clear remove sessions (test hygiene / dynamic revocation)',
    async () => {
      readOnlyRegistry.clear()
      readOnlyRegistry.register('ses_a', { agent: 'apollo' })
      readOnlyRegistry.register('ses_b', { agent: 'gaia' })
      assert.equal(readOnlyRegistry.has('ses_a'), true)
      assert.equal(readOnlyRegistry.sessionIDs().size, 2)

      readOnlyRegistry.unregister('ses_a')
      assert.equal(readOnlyRegistry.has('ses_a'), false)
      assert.equal(readOnlyRegistry.has('ses_b'), true)

      readOnlyRegistry.clear()
      assert.equal(readOnlyRegistry.sessionIDs().size, 0)
    },
  )

  // ═══════════════════════════════════════════════════════════════════════
  // Zeus Read Guard Tests
  // ═══════════════════════════════════════════════════════════════════════

  await testAsync('zeus read guard: Zeus + read src/index.ts → denied', async () => {
    const err = (() => zeusReadGuard('read', { filePath: 'src/index.ts' }, 'zeus')) as () => void
    assert.throws(err, /delegate to @apollo/, 'Zeus must not read src/ files')
  })

  await testAsync(
    'zeus read guard: Zeus + read README.md → allowed (markdown exception)',
    async () => {
      zeusReadGuard('read', { filePath: 'README.md' }, 'zeus')
    },
  )

  await testAsync(
    'zeus read guard: Zeus + read .pantheon/memory.md → allowed (.pantheon/ exception)',
    async () => {
      zeusReadGuard('read', { filePath: '.pantheon/memory.md' }, 'zeus')
    },
  )

  await testAsync('zeus read guard: Zeus + glob src/**/*.ts → denied', async () => {
    const err = () => zeusReadGuard('glob', { pattern: 'src/**/*.ts' }, 'zeus')
    assert.throws(err, /delegate to @apollo/, 'Zeus must not glob src/ patterns')
  })

  await testAsync('zeus read guard: Zeus + grep "pattern" src/ → denied', async () => {
    const err = () => zeusReadGuard('grep', { pattern: 'src/foo' }, 'zeus')
    assert.throws(err, /delegate to @apollo/, 'Zeus must not grep in src/')
  })

  await testAsync(
    'zeus read guard: Non-Zeus + read src/index.ts → allowed (no change)',
    async () => {
      zeusReadGuard('read', { filePath: 'src/index.ts' }, 'hermes')
      zeusReadGuard('read', { filePath: 'src/index.ts' }, 'apollo')
      zeusReadGuard('read', { filePath: 'src/index.ts' }, undefined)
    },
  )

  await testAsync('zeus read guard: Zeus + read tests/test.ts → denied', async () => {
    const err = () => zeusReadGuard('read', { filePath: 'tests/test.ts' }, 'zeus')
    assert.throws(err, /delegate to @apollo/, 'Zeus must not read tests/')
  })

  await testAsync(
    'zeus read guard: Zeus + read memories/fact.md → allowed (memories/ exception)',
    async () => {
      zeusReadGuard('read', { filePath: 'memories/fact.md' }, 'zeus')
    },
  )

  await testAsync('zeus read guard: Zeus + read scripts/deploy.sh → denied', async () => {
    const err = () => zeusReadGuard('read', { filePath: 'scripts/deploy.sh' }, 'zeus')
    assert.throws(err, /delegate to @apollo/, 'Zeus must not read scripts/')
  })

  await testAsync(
    'zeus read guard: Zeus + non-read tool (edit) on src/ → allowed (guard only covers read/glob/grep)',
    async () => {
      zeusReadGuard('edit', { filePath: 'src/index.ts' }, 'zeus')
    },
  )

  // ═══════════════════════════════════════════════════════════════════════
  // Read-Only Registry Population (production path)
  // ═══════════════════════════════════════════════════════════════════════

  await testAsync(
    'production population: syncReadOnlySession(apollo|gaia) registers the session and every blocked tool is denied (incl. hashline_edit)',
    async () => {
      const registry = new ReadOnlySessionRegistry()
      const guard = createEnforcementGuard({
        getReadOnlySessions: () => registry.sessionIDs(),
      })

      assert.deepEqual(
        [...DEFAULT_BLOCKED_TOOLS].sort(),
        ['bash', 'edit', 'hashline_edit', 'task', 'write'],
        'host covers edit/write/bash/task — hashline_edit is the plugin tool the guard must add',
      )

      for (const agent of ['apollo', 'gaia']) {
        const sid = `ses_prod_${agent}`
        assert.equal(syncReadOnlySession(registry, sid, agent), true, `${agent} must register`)
        assert.equal(registry.has(sid), true)
        for (const tool of DEFAULT_BLOCKED_TOOLS) {
          const err = await runGuard(guard, tool, sid)
          assert.ok(err, `tool "${tool}" must be denied for a plugin-populated read-only session`)
          assert.match(err?.message, /read-only/i)
        }
      }
    },
  )

  await testAsync(
    'production population: non-read-only / absent agent never registers and unregisters on agent switch',
    async () => {
      const registry = new ReadOnlySessionRegistry()

      assert.equal(syncReadOnlySession(registry, 'ses_switch', 'hermes'), false)
      assert.equal(registry.has('ses_switch'), false)

      assert.equal(syncReadOnlySession(registry, 'ses_switch', 'apollo'), true)
      assert.equal(registry.has('ses_switch'), true)

      // Agent switch inside the same session → registration is revoked.
      assert.equal(syncReadOnlySession(registry, 'ses_switch', 'hermes'), false)
      assert.equal(registry.has('ses_switch'), false)

      assert.equal(syncReadOnlySession(registry, 'ses_absent', undefined), false)
      assert.equal(syncReadOnlySession(registry, 'ses_absent', 'ZEUS'), false)
      assert.equal(isReadOnlyAgent('APOLLO'), true, 'identity is normalized case-insensitively')
      assert.equal(isReadOnlyAgent('hermes'), false)
      assert.equal(isReadOnlyAgent(undefined), false)
    },
  )

  await testAsync(
    'READ_ONLY_AGENTS mirrors routing.yml background_delegation.read_only_agents (no drift)',
    async () => {
      const routing = yaml.load(
        readFileSync(new URL('../../src/routing.yml', import.meta.url), 'utf8'),
      ) as { background_delegation?: { read_only_agents?: string[] } }
      const fromRouting = (routing.background_delegation?.read_only_agents ?? []).map((agent) =>
        agent.toLowerCase(),
      )
      assert.deepEqual(
        [...READ_ONLY_AGENTS].sort(),
        fromRouting.sort(),
        'READ_ONLY_AGENTS must match routing.yml read_only_agents',
      )
    },
  )

  await testAsync(
    'plugin wiring: chat.params populates the registry and session.deleted unregisters it',
    async () => {
      const source = readFileSync(new URL('../../src/plugin.ts', import.meta.url), 'utf8')
      assert.match(
        source,
        /'chat\.params':[\s\S]*?syncReadOnlySession\(\s*readOnlyRegistry/,
        'chat.params must call syncReadOnlySession(readOnlyRegistry, …) to populate the registry',
      )
      assert.match(
        source,
        /ev\.type === 'session\.deleted'[\s\S]{0,200}readOnlyRegistry\.unregister/,
        'session.deleted must unregister the read-only session',
      )
    },
  )

  // ═══════════════════════════════════════════════════════════════════════

  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed)

  console.log('')
  for (const r of results) {
    console.log(`  ${r.passed ? 'PASS' : 'FAIL'} ${r.name}${r.error ? `: ${r.error}` : ''}`)
  }
  console.log(`\nResults: ${passed} passed, ${failed.length} failed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

main()
