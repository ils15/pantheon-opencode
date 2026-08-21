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

import { isValidSessionId } from '../../src/pantheon/session-guard.ts'
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

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  await testAsync('isValidSessionId: valid ses_ id passa', async () => {
    assert.equal(isValidSessionId('ses_abc123'), true)
    assert.equal(isValidSessionId('ses_1234567890'), true)
    assert.equal(isValidSessionId('ses_root'), true)
  })

  await testAsync('isValidSessionId: "%7BsessionID%7D" falha (placeholder URL-encoded)', async () => {
    assert.equal(isValidSessionId('%7BsessionID%7D'), false)
    assert.equal(isValidSessionId('{sessionID}'), false)
    assert.equal(isValidSessionId(''), false)
    assert.equal(isValidSessionId(null), false)
    assert.equal(isValidSessionId(undefined), false)
  })

  await testAsync('createZeusRetryHelper classifica empty (mode1/mode2) vs content', async () => {
    const helper = createZeusRetryHelper({ logger: { warn: () => {} } })
    // mode1: sem conteudo e sem tokens
    assert.equal(helper.guard.classifyResult({ content: '' }), 'empty-mode1')
    assert.equal(helper.guard.classifyResult({}), 'empty-mode1')
    assert.equal(helper.guard.classifyResult({ content: '   ' }), 'empty-mode1')
    // mode2: sem texto mas com tokens (assinatura themis Wave-2)
    assert.equal(helper.guard.classifyResult({ tokensInput: 1200, tokensOutput: 10 }), 'empty-mode2')
    assert.equal(helper.guard.classifyResult({ content: '', tokensOutput: 1 }), 'empty-mode2')
    // content: tem texto
    assert.equal(helper.guard.classifyResult({ content: 'relatorio completo' }), 'content')
  })

  await testAsync('createZeusRetryHelper executeWithRetry: empty dispara retry e escalate', async () => {
    const helper = createZeusRetryHelper({ logger: { warn: () => {} } })
    let calls = 0
    const redispatch = async () => {
      calls += 1
      return { content: 'recovered' }
    }
    const out = await helper.executeWithRetry({ content: '' }, redispatch)
    assert.equal(out.retried, true, 'empty deve disparar retry')
    assert.equal(out.classification, 'content', 'após retry com conteúdo, classificação é content')
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
  })

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
