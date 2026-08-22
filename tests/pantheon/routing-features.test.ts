/**
 * Integration tests for the R1/R4/O5 wiring:
 *
 *   - R4 via createDelegationTools: an agent at max_steps is forced to stop
 *     (delegation skipped with a capped summary, NO child session created);
 *     a dispatch that hits the cap appends the stop instruction to the prompt.
 *   - O5 via createDelegationTools: denied agents are removed from the
 *     delegate tool description entirely; the runtime matrix honors the
 *     permission.task rules.
 *   - R1 via createZeusRetryHelper: error-type retries with exponential
 *     backoff and provider cooldown skip.
 *
 * Run with: npx tsx tests/pantheon/routing-features.test.ts
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import { createDelegationTools } from '../../src/pantheon/delegation.ts'
import { DEFAULT_RETRY_POLICY, ProviderCooldownTracker } from '../../src/pantheon/retry-policy.ts'
import { StepCapTracker } from '../../src/pantheon/step-cap.ts'
import { createZeusRetryHelper } from '../../src/pantheon/zeus-delegate-with-retry.ts'

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

class FakeClient {
  readonly session = {
    create: async (): Promise<{ id: string }> => ({ id: CHILD }),
    promptAsync: async (): Promise<unknown> => ({ state: 'running' }),
    messages: async (): Promise<unknown> => [],
  }
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  // ── R4: step caps in the delegate tool ───────────────────────────────
  await testAsync(
    'R4: agent already at max_steps → delegation skipped with a capped summary, NO session created',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'r4-capped-'))
      let created = 0
      const client = {
        session: {
          create: async () => {
            created += 1
            return { id: CHILD }
          },
          promptAsync: async () => ({ state: 'running' }),
          messages: async () => [],
        },
      }
      try {
        const tracker = new StepCapTracker({ apollo: 1 })
        tracker.recordStep('apollo') // at cap already
        const board = new BackgroundJobBoard()
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp, stepCapTracker: tracker },
        })
        const out = await tools.pantheon_delegate.execute(
          { prompt: 'scout the codebase', agent: 'apollo' },
          makeCtx(),
        )
        assert.match(out, /STEP CAP REACHED/, 'returns a capped summary')
        assert.match(out, /skipped/i, 'no new work was started')
        assert.equal(created, 0, 'no child session created for a capped agent')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'R4: dispatch that hits the cap appends the stop instruction to the prompt',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'r4-stop-instr-'))
      let promptSent = ''
      const client = {
        session: {
          create: async () => ({ id: CHILD }),
          promptAsync: async (input: { body: { parts: Array<{ text: string }> } }) => {
            promptSent = input.body.parts[0]?.text ?? ''
            return { state: 'running' }
          },
          messages: async () => [],
        },
      }
      try {
        const tracker = new StepCapTracker({ apollo: 1 })
        const board = new BackgroundJobBoard()
        const tools = createDelegationTools({
          board,
          client,
          options: { rootSessions: new Set([ROOT]), outputDir: tmp, stepCapTracker: tracker },
        })
        await tools.pantheon_delegate.execute({ prompt: 'investigate', agent: 'apollo' }, makeCtx())
        assert.match(promptSent, /STEP CAP REACHED/, 'stop instruction injected into the prompt')
        assert.match(promptSent, /investigate/, 'original prompt preserved')
        assert.match(promptSent, /summarize/i, 'forces summarize-and-stop')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  // ── O5: permission globs in the delegate tool ────────────────────────
  await testAsync(
    'O5: denied agents are REMOVED from the delegate tool description entirely',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'o5-desc-'))
      try {
        const board = new BackgroundJobBoard()
        const tools = createDelegationTools({
          board,
          client: new FakeClient(),
          options: {
            rootSessions: new Set([ROOT]),
            outputDir: tmp,
            permissionTask: { '*': 'deny', 'orchestrator-*': 'allow' },
            agentNames: ['orchestrator-zeus', 'hermes', 'apollo'],
          },
        })
        const description = tools.pantheon_delegate.description
        assert.ok(description.includes('orchestrator-zeus'), 'allowed agent listed')
        assert.ok(!description.includes('hermes'), 'denied agent removed from the description')
        assert.ok(!description.includes('apollo'), 'denied agent removed from the description')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'O5: runtime matrix honors permission.task (deny blocks the dispatch)',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'o5-matrix-'))
      try {
        const board = new BackgroundJobBoard()
        const tools = createDelegationTools({
          board,
          client: new FakeClient(),
          options: {
            rootSessions: new Set([ROOT]),
            outputDir: tmp,
            permissionTask: { '*': 'deny', apollo: 'allow' },
          },
        })
        // zeus → apollo allowed by both matrix and globs
        const ok = await tools.pantheon_delegate.execute(
          { prompt: 'scout', agent: 'apollo' },
          makeCtx(),
        )
        assert.match(ok, /Delegated to apollo/, 'allowed target dispatches')

        // zeus → hermes: matrix allows, but permission.task denies
        await assert.rejects(
          tools.pantheon_delegate.execute({ prompt: 'implement', agent: 'hermes' }, makeCtx()),
          /runtime delegation matrix denied|not allowed/,
          'permission.task deny blocks the dispatch',
        )
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  // ── R1: retry helper with policy + cooldown ──────────────────────────
  await testAsync(
    'R1: rate_limit error → retries with backoff until the budget is exhausted, then escalates',
    async () => {
      const sleeps: number[] = []
      const helper = createZeusRetryHelper({
        retryPolicy: { ...DEFAULT_RETRY_POLICY, rate_limit: 2 },
        provider: 'opencode',
        sleep: async (ms) => {
          sleeps.push(ms)
        },
        logger: { warn: () => {} },
      })
      let calls = 0
      const out = await helper.executeWithRetry({ content: '' }, async () => {
        calls += 1
        throw new Error('429 rate limit')
      })
      assert.equal(out.retried, true, 'rate_limit triggers retries')
      assert.equal(calls, 2, 'rate_limit: 2 → exactly 2 retries')
      assert.equal(out.escalate, true, 'budget exhausted → escalate')
      assert.deepEqual(sleeps, [1000, 2000], 'exponential backoff delays')
    },
  )

  await testAsync('R1: auth error → 0 retries (escalate immediately)', async () => {
    const helper = createZeusRetryHelper({
      retryPolicy: DEFAULT_RETRY_POLICY,
      provider: 'opencode',
      sleep: async () => {},
      logger: { warn: () => {} },
    })
    let calls = 0
    const out = await helper.executeWithRetry(
      { content: '', error: new Error('401 unauthorized') },
      async () => {
        calls += 1
        throw new Error('401 unauthorized')
      },
    )
    assert.equal(out.retried, false, 'auth never retries')
    assert.equal(calls, 0, 'redispatch never invoked')
    assert.equal(out.escalate, true)
  })

  await testAsync(
    'R1: provider in cooldown → skipped (no retry, escalate immediately)',
    async () => {
      const cooldown = new ProviderCooldownTracker({ allowedFails: 1, cooldownTimeSeconds: 60 })
      cooldown.recordFailure('opencode') // trip the cooldown
      const helper = createZeusRetryHelper({
        retryPolicy: DEFAULT_RETRY_POLICY,
        cooldown,
        provider: 'opencode',
        sleep: async () => {},
        logger: { warn: () => {} },
      })
      let calls = 0
      const out = await helper.executeWithRetry({ content: '' }, async () => {
        calls += 1
        return { content: 'should not run' }
      })
      assert.equal(out.retried, false, 'cooldown overrides the retry policy')
      assert.equal(calls, 0, 'no redispatch while the provider is in cooldown')
      assert.equal(out.escalate, true)
    },
  )

  await testAsync(
    'R1: content result records success (resets the provider failure counter)',
    async () => {
      const cooldown = new ProviderCooldownTracker({ allowedFails: 2, cooldownTimeSeconds: 60 })
      const helper = createZeusRetryHelper({
        retryPolicy: DEFAULT_RETRY_POLICY,
        cooldown,
        provider: 'opencode',
        sleep: async () => {},
        logger: { warn: () => {} },
      })
      const out = await helper.executeWithRetry({ content: 'full report' }, async () => ({
        content: 'x',
      }))
      assert.equal(out.escalate, false)
      assert.equal(cooldown.failCount('opencode'), 0, 'success resets the counter')
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
