/**
 * Tests for the Dispatch Guard (Wave 4, PR #46) — auto-retry-on-empty for
 * background delegations.
 *
 * classifyResult() maps a dispatch result to one of:
 *   - 'content'      — has text content, no retry needed
 *   - 'empty-mode1'  — no content AND no tokens (nothing came back at all)
 *   - 'empty-mode2'  — no content but tokens present (reasoning happened,
 *                      text part lost — the themis Wave-2 failure signature)
 *
 * maybeRetry() redispatch once on mode1/mode2 when retryOnEmpty is enabled.
 * Retry cap is HARD at 1 — a retried result that is still empty is returned
 * as-is, never redispatched a second time. The guard is stateful per
 * instance (retry budget of 1); it does NOT intercept task() — integration
 * is manual-orchestration (documented in zeus.md; opencode 1.18.x cannot
 * intercept task completion via hooks).
 *
 * Run with: npx tsx tests/pantheon/dispatch-guard.test.ts
 */
import { strict as assert } from 'node:assert'

import { createDispatchGuard, type DispatchResultLike } from '../../src/pantheon/dispatch-guard.ts'

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

/** Track how many times redispatch was invoked (live read via calls()). */
function countingRedispatch(results: DispatchResultLike[]) {
  let calls = 0
  const redispatch = async () => {
    calls += 1
    const next = results[Math.min(calls - 1, results.length - 1)]
    assert.ok(next !== undefined, 'redispatch result queue is never exhausted')
    return next
  }
  return { redispatch, calls: () => calls }
}

// ═══════════════════════════════════════════════════════════════════════

async function main() {
  await testAsync('classify: content present → "content"; whitespace-only → empty', async () => {
    const guard = createDispatchGuard()
    assert.equal(guard.classifyResult({ content: 'full report' }), 'content')
    assert.equal(guard.classifyResult({ content: '   ' }), 'empty-mode1')
    assert.equal(guard.classifyResult({}), 'empty-mode1')
    assert.equal(guard.classifyResult({ content: '' }), 'empty-mode1')
  })

  await testAsync(
    'classify: no content but tokens present → "empty-mode2" (themis signature)',
    async () => {
      const guard = createDispatchGuard()
      assert.equal(guard.classifyResult({ tokensInput: 1200, tokensOutput: 40 }), 'empty-mode2')
      assert.equal(guard.classifyResult({ tokensOutput: 1 }), 'empty-mode2')
    },
  )

  await testAsync('mode1 empty → retried once → returns the redispatched content', async () => {
    const guard = createDispatchGuard({ logger: { warn: () => {} } })
    const t = countingRedispatch([{ content: 'recovered after retry' }])
    const out = await guard.maybeRetry({ content: '' }, t.redispatch)
    assert.equal(out.retried, true, 'retried flag set')
    assert.equal(t.calls(), 1, 'redispatch invoked exactly once')
    assert.equal(out.result.content, 'recovered after retry')
    assert.equal(out.classification, 'content')
  })

  await testAsync('mode2 empty (tokens, no text) → retried once', async () => {
    const guard = createDispatchGuard({ logger: { warn: () => {} } })
    const t = countingRedispatch([{ content: 'fixed' }])
    const out = await guard.maybeRetry({ tokensInput: 900, tokensOutput: 10 }, t.redispatch)
    assert.equal(out.retried, true)
    assert.equal(t.calls(), 1, 'mode2 triggers a redispatch')
    assert.equal(out.result.content, 'fixed')
  })

  await testAsync('cap: retried result still empty → NO second retry (hard cap 1)', async () => {
    const guard = createDispatchGuard({ logger: { warn: () => {} } })
    const t = countingRedispatch([{ content: '' }])
    const first = await guard.maybeRetry({ content: '' }, t.redispatch)
    assert.equal(first.retried, true, 'first empty → retried once')
    assert.equal(t.calls(), 1)
    const second = await guard.maybeRetry(first.result, t.redispatch)
    assert.equal(second.retried, false, 'empty-after-retry is NOT redispatched again')
    assert.equal(t.calls(), 1, 'redispatch called exactly once total')
  })

  await testAsync('non-empty result → no retry at all', async () => {
    const guard = createDispatchGuard({ logger: { warn: () => {} } })
    const t = countingRedispatch([{ content: 'never needed' }])
    const out = await guard.maybeRetry({ content: 'already complete' }, t.redispatch)
    assert.equal(out.retried, false)
    assert.equal(t.calls(), 0, 'redispatch never called for content results')
    assert.equal(out.classification, 'content')
  })

  await testAsync('retryOnEmpty:false → empty result is returned, never redispatched', async () => {
    const guard = createDispatchGuard({ retryOnEmpty: false, logger: { warn: () => {} } })
    const t = countingRedispatch([{ content: 'should not be used' }])
    const out = await guard.maybeRetry({ content: '' }, t.redispatch)
    assert.equal(out.retried, false)
    assert.equal(t.calls(), 0)
    assert.equal(out.classification, 'empty-mode1')
  })

  await testAsync('logger.warn called when a retry fires', async () => {
    const warned: string[] = []
    const guard = createDispatchGuard({ logger: { warn: (m) => warned.push(m) } })
    await guard.maybeRetry({ content: '' }, async () => ({ content: 'ok' }))
    assert.equal(warned.length, 1, 'one warning logged for the retry')
    assert.ok(warned[0]?.includes('empty-mode1'), 'warning names the classification')
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
