/**
 * Tests for the Delegation Classifier — stuck-agent detection, empty-response
 * classification, budget-exhausted detection, timeout classification, and
 * structured delegation results.
 *
 * TDD: these tests MUST fail before implementation.
 *
 * Run with: npx tsx tests/pantheon/delegation-classifier.test.ts
 */
import { strict as assert } from 'node:assert'

import {
  classifyEmptyResponse,
  classifyStuckAgent,
  classifyTimeout,
  type DelegationResult,
  formatDelegationResult,
  isRetryableResult,
} from '../../src/pantheon/delegation-classifier.ts'

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
  // ─── classifyEmptyResponse ──────────────────────────────────────────

  await testAsync('classifyEmptyResponse: empty string → empty-mode1', async () => {
    const result = classifyEmptyResponse('')
    assert.equal(result.mode, 'empty-mode1')
    assert.equal(result.hasContent, false)
    assert.equal(result.hasTokens, false)
  })

  await testAsync('classifyEmptyResponse: whitespace-only → empty-mode1', async () => {
    const result = classifyEmptyResponse('   \n\t  ')
    assert.equal(result.mode, 'empty-mode1')
    assert.equal(result.hasContent, false)
  })

  await testAsync('classifyEmptyResponse: null/undefined → empty-mode1', async () => {
    assert.equal(classifyEmptyResponse(null).mode, 'empty-mode1')
    assert.equal(classifyEmptyResponse(undefined).mode, 'empty-mode1')
  })

  await testAsync('classifyEmptyResponse: text content → content', async () => {
    const result = classifyEmptyResponse('Here are my findings...')
    assert.equal(result.mode, 'content')
    assert.equal(result.hasContent, true)
  })

  await testAsync('classifyEmptyResponse: tokens but no text → empty-mode2', async () => {
    const result = classifyEmptyResponse('', { tokensInput: 150, tokensOutput: 0 })
    assert.equal(result.mode, 'empty-mode2')
    assert.equal(result.hasContent, false)
    assert.equal(result.hasTokens, true)
  })

  await testAsync('classifyEmptyResponse: tokens AND text → content (text wins)', async () => {
    const result = classifyEmptyResponse('Report here', { tokensInput: 100, tokensOutput: 50 })
    assert.equal(result.mode, 'content')
  })

  // ─── classifyStuckAgent ─────────────────────────────────────────────

  await testAsync('classifyStuckAgent: normal completed report → success', async () => {
    const result = classifyStuckAgent('# Delegation Report\n\n## Output\n\nHere are the findings.')
    assert.equal(result.status, 'success')
  })

  await testAsync('classifyStuckAgent: "Maximum steps reached" → budget-exhausted', async () => {
    const result = classifyStuckAgent(
      '# Delegation Report\n\n## Output\n\nMaximum steps for this agent have been reached.',
    )
    assert.equal(result.status, 'budget-exhausted')
    assert.ok(result.recommendation, 'should have a recommendation')
    assert.ok(result.recommendation!.includes('step budget'), 'recommendation mentions step budget')
  })

  await testAsync('classifyStuckAgent: "step budget exhausted" → budget-exhausted', async () => {
    const result = classifyStuckAgent('The step budget was exhausted before the task completed.')
    assert.equal(result.status, 'budget-exhausted')
  })

  await testAsync(
    'classifyStuckAgent: partial result + budget-exhausted → partialResult included',
    async () => {
      const report =
        '# Delegation Report\n\n## Output\n\nFound 3 files:\n- src/a.ts\n- src/b.ts\n\nMaximum steps for this agent have been reached.'
      const result = classifyStuckAgent(report)
      assert.equal(result.status, 'budget-exhausted')
      assert.ok(result.partialResult, 'should have partialResult')
      assert.ok(
        result.partialResult!.includes('Found 3 files'),
        'partialResult should have content before the marker',
      )
    },
  )

  await testAsync('classifyStuckAgent: empty report → empty (not success)', async () => {
    const result = classifyStuckAgent('# Delegation Report\n\n## Output\n\n_No output captured._')
    assert.equal(result.status, 'empty')
  })

  // ─── classifyTimeout ────────────────────────────────────────────────

  await testAsync('classifyTimeout: no report, no messages → timeout-empty', async () => {
    const result = classifyTimeout({ report: undefined, hasMessages: false, retryCount: 0 })
    assert.equal(result.status, 'timeout')
    assert.equal(result.subType, 'timeout-empty')
    assert.equal(result.retryCount, 0)
    assert.ok(result.recommendation, 'should have a recommendation')
  })

  await testAsync('classifyTimeout: report with content → timeout-with-partial', async () => {
    const result = classifyTimeout({
      report: '## Output\n\nPartial findings...',
      hasMessages: true,
      retryCount: 0,
    })
    assert.equal(result.status, 'timeout')
    assert.equal(result.subType, 'timeout-with-partial')
    assert.ok(result.partialResult, 'should include partialResult')
  })

  await testAsync(
    'classifyTimeout: no report but messages exist → timeout-with-partial',
    async () => {
      const result = classifyTimeout({
        report: undefined,
        hasMessages: true,
        retryCount: 0,
      })
      assert.equal(result.status, 'timeout')
      assert.equal(result.subType, 'timeout-with-partial')
    },
  )

  await testAsync('classifyTimeout: already retried → timeout-exhausted', async () => {
    const result = classifyTimeout({
      report: undefined,
      hasMessages: false,
      retryCount: 1,
    })
    assert.equal(result.status, 'timeout')
    assert.equal(result.subType, 'timeout-exhausted')
  })

  await testAsync('classifyTimeout: report + already retried → timeout-exhausted', async () => {
    const result = classifyTimeout({
      report: '## Output\n\nSome stuff...',
      hasMessages: true,
      retryCount: 1,
    })
    assert.equal(result.status, 'timeout')
    assert.equal(result.subType, 'timeout-exhausted')
    assert.ok(result.partialResult, 'should preserve partialResult even when exhausted')
  })

  // ─── isRetryableResult ──────────────────────────────────────────────

  await testAsync('isRetryableResult: empty-mode1 → true', async () => {
    const result: DelegationResult = {
      status: 'empty',
      content: '',
      retryCount: 0,
      classification: 'empty-mode1',
    }
    assert.equal(isRetryableResult(result), true)
  })

  await testAsync('isRetryableResult: empty-mode2 → true', async () => {
    const result: DelegationResult = {
      status: 'empty',
      content: '',
      retryCount: 0,
      classification: 'empty-mode2',
    }
    assert.equal(isRetryableResult(result), true)
  })

  await testAsync('isRetryableResult: timeout-empty with retryCount=0 → true', async () => {
    const result: DelegationResult = {
      status: 'timeout',
      content: '',
      retryCount: 0,
      classification: undefined,
      subType: 'timeout-empty',
    }
    assert.equal(isRetryableResult(result), true)
  })

  await testAsync('isRetryableResult: already retried (retryCount=1) → false', async () => {
    const result: DelegationResult = {
      status: 'empty',
      content: '',
      retryCount: 1,
      classification: 'empty-mode1',
    }
    assert.equal(isRetryableResult(result), false)
  })

  await testAsync('isRetryableResult: success → false', async () => {
    const result: DelegationResult = {
      status: 'success',
      content: 'Report...',
      retryCount: 0,
    }
    assert.equal(isRetryableResult(result), false)
  })

  await testAsync('isRetryableResult: budget-exhausted → false', async () => {
    const result: DelegationResult = {
      status: 'budget-exhausted',
      content: 'Max steps reached.',
      retryCount: 0,
    }
    assert.equal(isRetryableResult(result), false)
  })

  await testAsync('isRetryableResult: error → false', async () => {
    const result: DelegationResult = {
      status: 'error',
      content: '',
      retryCount: 0,
    }
    assert.equal(isRetryableResult(result), false)
  })

  // ─── formatDelegationResult ─────────────────────────────────────────

  await testAsync('formatDelegationResult: success → content text', async () => {
    const result: DelegationResult = {
      status: 'success',
      content: 'Here are the findings...',
      retryCount: 0,
    }
    const formatted = formatDelegationResult(result)
    assert.equal(formatted, 'Here are the findings...')
  })

  await testAsync(
    'formatDelegationResult: empty-mode1 → structured message with retry info',
    async () => {
      const result: DelegationResult = {
        status: 'empty',
        content: '',
        retryCount: 0,
        classification: 'empty-mode1',
      }
      const formatted = formatDelegationResult(result)
      assert.ok(formatted.includes('empty'), 'should mention empty')
      assert.ok(
        formatted.includes('mode1') || formatted.includes('no tokens'),
        'should classify mode',
      )
      assert.ok(formatted.includes('retry') || formatted.includes('Retry'), 'should mention retry')
    },
  )

  await testAsync(
    'formatDelegationResult: budget-exhausted → recommendation included',
    async () => {
      const result: DelegationResult = {
        status: 'budget-exhausted',
        content: 'Partial...',
        retryCount: 0,
        partialResult: 'Found 3 files...',
        recommendation: 'Agent hit step budget; partial result available.',
      }
      const formatted = formatDelegationResult(result)
      assert.ok(formatted.includes('budget') || formatted.includes('step'), 'should mention budget')
      assert.ok(formatted.includes('partial'), 'should mention partial result')
    },
  )

  await testAsync(
    'formatDelegationResult: timeout-with-partial → partialResult in output',
    async () => {
      const result: DelegationResult = {
        status: 'timeout',
        content: '',
        retryCount: 0,
        subType: 'timeout-with-partial',
        partialResult: 'Some progress...',
        recommendation: 'Agent timed out but partial work exists.',
      }
      const formatted = formatDelegationResult(result)
      assert.ok(
        formatted.includes('[TIMEOUT') || formatted.includes('timeout'),
        `should mention timeout, got: ${formatted}`,
      )
      assert.ok(formatted.includes('partial'), `should mention partial, got: ${formatted}`)
    },
  )

  await testAsync('formatDelegationResult: timeout-exhausted → escalate message', async () => {
    const result: DelegationResult = {
      status: 'timeout',
      content: '',
      retryCount: 1,
      subType: 'timeout-exhausted',
      partialResult: 'Some progress...',
    }
    const formatted = formatDelegationResult(result)
    assert.ok(
      formatted.includes('exhausted') || formatted.includes('escalat'),
      'should mention exhaustion/escalation',
    )
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
