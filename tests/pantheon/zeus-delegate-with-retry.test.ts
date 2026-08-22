/**
 * Minimal tests for zeusDelegateWithRetry helper + session-guard.
 *
 * - isValidSessionId: valid id passa
 * - isValidSessionId: "%7BsessionID%7D" (URL-encoded placeholder) falha
 * - createZeusRetryHelper classifica empty (mode1/mode2) e content corretamente
 *
 * Run with: npx tsx tests/pantheon/zeus-delegate-with-retry.test.ts
 */
import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BackgroundJobBoard } from '../../src/pantheon/background-job-board.ts'
import { DEFAULT_RETRY_POLICY, ProviderCooldownTracker } from '../../src/pantheon/retry-policy.ts'
import { isValidSessionId } from '../../src/pantheon/session-guard.ts'
import {
  createZeusRetryHelper,
  ZeusEscalationError,
  zeusDelegateWithRetry,
} from '../../src/pantheon/zeus-delegate-with-retry.ts'

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

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  await testAsync('isValidSessionId: valid ses_ id passa', async () => {
    assert.equal(isValidSessionId('ses_abc123'), true)
    assert.equal(isValidSessionId('ses_1234567890'), true)
    assert.equal(isValidSessionId('ses_root'), true)
  })

  await testAsync(
    'isValidSessionId: "%7BsessionID%7D" falha (placeholder URL-encoded)',
    async () => {
      assert.equal(isValidSessionId('%7BsessionID%7D'), false)
      assert.equal(isValidSessionId('{sessionID}'), false)
      assert.equal(isValidSessionId(''), false)
      assert.equal(isValidSessionId(null), false)
      assert.equal(isValidSessionId(undefined), false)
    },
  )

  await testAsync('createZeusRetryHelper classifica empty (mode1/mode2) vs content', async () => {
    const helper = createZeusRetryHelper({ logger: { warn: () => {} } })
    // mode1: sem conteudo e sem tokens
    assert.equal(helper.guard.classifyResult({ content: '' }), 'empty-mode1')
    assert.equal(helper.guard.classifyResult({}), 'empty-mode1')
    assert.equal(helper.guard.classifyResult({ content: '   ' }), 'empty-mode1')
    // mode2: sem texto mas com tokens (assinatura themis Wave-2)
    assert.equal(
      helper.guard.classifyResult({ tokensInput: 1200, tokensOutput: 10 }),
      'empty-mode2',
    )
    assert.equal(helper.guard.classifyResult({ content: '', tokensOutput: 1 }), 'empty-mode2')
    // content: tem texto
    assert.equal(helper.guard.classifyResult({ content: 'relatorio completo' }), 'content')
  })

  await testAsync(
    'createZeusRetryHelper executeWithRetry: empty dispara retry e escalate',
    async () => {
      const helper = createZeusRetryHelper({ logger: { warn: () => {} } })
      let calls = 0
      const redispatch = async () => {
        calls += 1
        return { content: 'recovered' }
      }
      const out = await helper.executeWithRetry({ content: '' }, redispatch)
      assert.equal(out.retried, true, 'empty deve disparar retry')
      assert.equal(
        out.classification,
        'content',
        'após retry com conteúdo, classificação é content',
      )
      assert.equal(out.escalate, false, 'content não escala')
      assert.equal(calls, 1)

      // empty que continua vazio após retry → escalate
      const helper2 = createZeusRetryHelper({ logger: { warn: () => {} } })
      const out2 = await helper2.executeWithRetry({ content: '' }, async () => ({ content: '' }))
      assert.equal(out2.retried, true)
      assert.equal(out2.escalate, true, 'ainda vazio após 1 retry → escalate')
      assert.equal(out2.classification, 'empty-mode1')

      // content não retry
      const helper3 = createZeusRetryHelper({ logger: { warn: () => {} } })
      let calls3 = 0
      const out3 = await helper3.executeWithRetry({ content: 'already ok' }, async () => {
        calls3 += 1
        return { content: 'never' }
      })
      assert.equal(out3.retried, false, 'content não deve retry')
      assert.equal(out3.escalate, false)
      assert.equal(calls3, 0)
    },
  )

  // ═══════════════════════════════════════════════════════════════════════
  // R1 HIGH-LEVEL PATH — zeusDelegateWithRetry with retryPolicy/cooldown.
  // The high-level helper's dispatchResult never carries an error (empty
  // results classify as 'other'), so these tests exercise the policy
  // mechanics end-to-end: policy-driven 0-retry escalate, policy-driven
  // retry-then-success, and cooldown skip. Exact auth/rate_limit error
  // classification is covered at the low level in routing-features.test.ts.

  await testAsync(
    'R1 high-level: retryPolicy other:1 → empty first result retries once, second run recovers content',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'r1-high-retry-'))
      let created = 0
      const board = new BackgroundJobBoard()
      const client = {
        session: {
          create: async () => ({ id: `ses_child_${++created}` }),
          promptAsync: async (input: { path: { id: string } }) => {
            // Make the SECOND run succeed: write the report + mark terminal
            // (persist-before-notify, mirroring finalizeDelegation).
            if (input.path.id === 'ses_child_2') {
              const job = board.get(input.path.id)
              if (job) {
                await mkdir(join(tmp, 'ses_root'), { recursive: true })
                await writeFile(
                  join(tmp, 'ses_root', `${job.alias}.md`),
                  '# Delegation Report — recovered\n\n## Output\n\nrecovered content\n',
                  'utf-8',
                )
                await board.updateStatus({
                  taskID: input.path.id,
                  state: 'completed',
                  resultSummary: 'recovered content',
                })
              }
            }
            return { state: 'running' }
          },
          messages: async () => [],
        },
      }
      try {
        const out = await zeusDelegateWithRetry({
          board,
          client,
          sessionID: 'ses_root',
          agent: 'apollo',
          prompt: 'scout the codebase',
          outputDir: tmp,
          readTimeoutMs: 50, // first run times out fast → empty result
          retryPolicy: { ...DEFAULT_RETRY_POLICY, other: 1 },
          provider: 'default',
          logger: { warn: () => {} },
        })
        assert.equal(out.retried, true, 'empty first result triggers the R1 retry')
        assert.equal(out.classification, 'content', 'second run recovered content')
        assert.match(out.report, /recovered content/, 'report comes from the second run')
        assert.equal(created, 2, 'two child sessions: first + one retry')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'R1 high-level: retryPolicy other:0 → 0 retries, escalate immediately',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'r1-high-zero-'))
      let created = 0
      const client = {
        session: {
          create: async () => {
            created += 1
            return { id: `ses_child_${created}` }
          },
          promptAsync: async () => ({ state: 'running' }),
          messages: async () => [],
        },
      }
      try {
        await assert.rejects(
          zeusDelegateWithRetry({
            board: new BackgroundJobBoard(),
            client,
            sessionID: 'ses_root',
            agent: 'apollo',
            prompt: 'scout',
            outputDir: tmp,
            readTimeoutMs: 50,
            retryPolicy: { ...DEFAULT_RETRY_POLICY, other: 0 },
            logger: { warn: () => {} },
          }),
          ZeusEscalationError,
          'policy other:0 → 0 retries → escalate',
        )
        assert.equal(created, 1, 'no retry fired')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
    },
  )

  await testAsync(
    'R1 high-level: provider in cooldown → skipped (no retry, escalate immediately)',
    async () => {
      const tmp = mkdtempSync(join(tmpdir(), 'r1-high-cooldown-'))
      let created = 0
      const cooldown = new ProviderCooldownTracker({ allowedFails: 1, cooldownTimeSeconds: 60 })
      cooldown.recordFailure('default') // trip the cooldown
      const client = {
        session: {
          create: async () => {
            created += 1
            return { id: `ses_child_${created}` }
          },
          promptAsync: async () => ({ state: 'running' }),
          messages: async () => [],
        },
      }
      try {
        await assert.rejects(
          zeusDelegateWithRetry({
            board: new BackgroundJobBoard(),
            client,
            sessionID: 'ses_root',
            agent: 'apollo',
            prompt: 'scout',
            outputDir: tmp,
            readTimeoutMs: 50,
            retryPolicy: { ...DEFAULT_RETRY_POLICY, other: 1 },
            cooldown,
            provider: 'default',
            logger: { warn: () => {} },
          }),
          ZeusEscalationError,
          'cooldown overrides the retry policy → escalate without retry',
        )
        assert.equal(created, 1, 'no redispatch while the provider is in cooldown')
      } finally {
        rmSync(tmp, { recursive: true, force: true })
      }
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
