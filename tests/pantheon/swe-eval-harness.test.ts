import assert from 'node:assert/strict'
import test from 'node:test'
import { CANONICAL_SWE_EVAL_TASKS, evaluateSweTask } from '../../src/pantheon/swe-eval-harness.ts'

test('SWE evaluation harness verifies RED -> GREEN transitions on multi-file tasks and mints receipts', async () => {
  for (const task of CANONICAL_SWE_EVAL_TASKS) {
    const result = await evaluateSweTask(task)
    assert.equal(
      result.failedBeforePatch,
      true,
      `Task ${task.id} must fail hidden test suite before patch (RED)`,
    )
    assert.equal(
      result.passedAfterPatch,
      true,
      `Task ${task.id} must pass hidden test suite after patch (GREEN)`,
    )
    assert.match(result.receiptId, /^rcpt_[0-9a-f]{16}$/)
  }
})

test('built server bundle (src/plugin/index.js) loads in pure Node ESM without tsx or @opentui/solid errors', async () => {
  const mod = (await import('../../src/plugin/index.js')) as {
    default?: { id?: string; setup?: unknown }
    UNSUPPORTED_FEATURES?: unknown
    disposePlugin?: unknown
  }
  assert.equal(mod.default?.id, 'pantheon-opencode')
  assert.equal(typeof mod.default?.setup, 'function')
  assert.ok(Array.isArray(mod.UNSUPPORTED_FEATURES))
  assert.equal(typeof mod.disposePlugin, 'function')
})
