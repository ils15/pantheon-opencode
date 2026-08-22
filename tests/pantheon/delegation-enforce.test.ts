/**
 * Tests for Read-Only Enforcement (Phase 4) — delegation-enforce.ts.
 *
 * Throw matrix for the `tool.execute.before` guard:
 *   - read-only session (registered via delegate read_only / readOnlyAgents):
 *     edit | write | bash | task → guard THROWS with an actionable message
 *   - non-read-only session: same tools → allowed
 *   - unknown session: default policy ALLOWS (normal agent work must not break)
 *   - non-blocked tools (read/grep/glob) in read-only session → allowed
 *
 * Registry population: createDelegationTools registers the CHILD session as
 * read-only when `read_only: true` is passed or the agent ∈ readOnlyAgents.
 *
 * Run with: npx tsx tests/pantheon/delegation-enforce.test.ts
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import { createDelegationTools } from '../../src/pantheon/delegation.ts'
import {
  ALLOWED_PATHS,
  createEnforcementGuard,
  DEFAULT_BLOCKED_TOOLS,
  readOnlyRegistry,
  type ToolExecuteBeforeHandler,
  ZEUS_READ_DENY_PATTERNS,
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

const ROOT = 'ses_root'
const CHILD = 'ses_child_1'

function makeCtx(sessionID = ROOT) {
  return { sessionID, directory: '/tmp', worktree: '/tmp', agent: 'zeus' }
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

// ─── Fake client (minimal — delegate tool only needs create/promptAsync) ─

class FakeClient {
  readonly session = {
    create: async (): Promise<{ id: string }> => ({ id: CHILD }),
    promptAsync: async (): Promise<unknown> => ({ state: 'running' }),
    messages: async (): Promise<unknown> => [],
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
        assert.match(err!.message, /read-only/i, `message must explain WHY (${tool})`)
        assert.match(
          err!.message,
          /pantheon_delegate|delegate/i,
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
      for (const tool of ['read', 'grep', 'glob', 'pantheon_delegation_read']) {
        const err = await runGuard(guard, tool, 'ses_ro')
        assert.equal(err, null, `read-only agent must still be able to call "${tool}"`)
      }
    },
  )

  await testAsync(
    'registry: delegate with read_only=true registers the CHILD session as read-only → guard blocks it',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'enforce-readonly-flag-'))
      try {
        readOnlyRegistry.clear()
        const board = new BackgroundJobBoard()
        const tools = createDelegationTools({
          board,
          client: new FakeClient(),
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })

        await tools.pantheon_delegate.execute(
          { prompt: 'Read-only investigation', agent: 'apollo', read_only: true },
          makeCtx(),
        )

        assert.equal(
          readOnlyRegistry.has(CHILD),
          true,
          'child session must be registered as read-only when read_only=true',
        )
        const guard = makeGuard()
        const err = await runGuard(guard, 'edit', CHILD)
        assert.ok(err, 'registered read-only child must be blocked from editing')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
        readOnlyRegistry.clear()
      }
    },
  )

  await testAsync(
    'registry: delegate with agent ∈ readOnlyAgents registers the CHILD session as read-only',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'enforce-agentset-'))
      try {
        readOnlyRegistry.clear()
        const board = new BackgroundJobBoard()
        const tools = createDelegationTools({
          board,
          client: new FakeClient(),
          options: {
            rootSessions: new Set([ROOT]),
            outputDir: tmp,
            readOnlyAgents: new Set(['apollo', 'gaia']),
          },
        })

        await tools.pantheon_delegate.execute(
          { prompt: 'Scout the codebase', agent: 'apollo' },
          makeCtx(),
        )

        assert.equal(
          readOnlyRegistry.has(CHILD),
          true,
          'agent in readOnlyAgents must register the child as read-only',
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
        readOnlyRegistry.clear()
      }
    },
  )

  await testAsync(
    'registry: agent name matching is case-insensitive (Apollo === apollo)',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'enforce-case-'))
      try {
        readOnlyRegistry.clear()
        const board = new BackgroundJobBoard()
        const tools = createDelegationTools({
          board,
          client: new FakeClient(),
          options: {
            rootSessions: new Set([ROOT]),
            outputDir: tmp,
            readOnlyAgents: new Set(['apollo']),
          },
        })

        await tools.pantheon_delegate.execute({ prompt: 'Scout', agent: 'Apollo' }, makeCtx())

        assert.equal(readOnlyRegistry.has(CHILD), true, 'agent matching must be case-insensitive')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
        readOnlyRegistry.clear()
      }
    },
  )

  await testAsync(
    'registry: write-capable delegate (no flag, not in readOnlyAgents) is NOT registered',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'enforce-write-'))
      try {
        readOnlyRegistry.clear()
        const board = new BackgroundJobBoard()
        const tools = createDelegationTools({
          board,
          client: new FakeClient(),
          options: { rootSessions: new Set([ROOT]), outputDir: tmp },
        })

        await tools.pantheon_delegate.execute(
          { prompt: 'Implement the endpoint', agent: 'hermes' },
          makeCtx(),
        )

        assert.equal(
          readOnlyRegistry.has(CHILD),
          false,
          'write-capable delegate must NOT be registered as read-only',
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
        readOnlyRegistry.clear()
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
