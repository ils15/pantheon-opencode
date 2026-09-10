/**
 * Tests for the Task Result Guard — detects empty task() results from native
 * opencode subagent calls and converts them to explicit errors.
 *
 * Bug context (reproduced 2026-09-10): task() native creates a child session
 * that inherits the parent transcript. When the payload exceeds the provider's
 * admission limit (e.g. free-tier max_outstanding_uncached_prefill_tokens=1000
 * vs 57k incoming tokens), the stream errors with BackendAdmissionRejected.
 * The error is NOT propagated — the child loop exits normally, the child
 * session goes idle with zero assistant/tool output, and opencode marks the
 * task as `completed` with empty content. The parent LLM receives an empty
 * result and proceeds as if the task succeeded.
 *
 * The guard intercepts this in the `tool.execute.after` hook: when the tool
 * is `task` and the output is empty/whitespace-only, it replaces the output
 * with an explicit error message so the parent sees a failure, not silence.
 *
 * Run with: npx tsx tests/pantheon/task-result-guard.test.ts
 */
import { strict as assert } from 'node:assert'

import {
  createTaskResultGuard,
  EMPTY_TASK_ERROR,
  type TaskGuardInput,
  type TaskGuardOutput,
} from '../../src/pantheon/task-result-guard.ts'

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
  // ── RED: empty task result → error ──────────────────────────────────

  await testAsync('task tool with empty string output → replaced with error', async () => {
    const guard = createTaskResultGuard()
    const input: TaskGuardInput = { tool: 'task', sessionID: 'ses_test1', callID: 'c1', args: {} }
    const output: TaskGuardOutput = { output: '' }
    await guard(input, output)
    assert.equal(output.output, EMPTY_TASK_ERROR)
  })

  await testAsync('task tool with whitespace-only output → replaced with error', async () => {
    const guard = createTaskResultGuard()
    const input: TaskGuardInput = { tool: 'task', sessionID: 'ses_test2', callID: 'c2', args: {} }
    const output: TaskGuardOutput = { output: '   \n  \t  ' }
    await guard(input, output)
    assert.equal(output.output, EMPTY_TASK_ERROR)
  })

  await testAsync('task tool with null output → replaced with error', async () => {
    const guard = createTaskResultGuard()
    const input: TaskGuardInput = { tool: 'task', sessionID: 'ses_test3', callID: 'c3', args: {} }
    const output: TaskGuardOutput = { output: null as unknown as string }
    await guard(input, output)
    assert.equal(output.output, EMPTY_TASK_ERROR)
  })

  await testAsync('task tool with undefined output → replaced with error', async () => {
    const guard = createTaskResultGuard()
    const input: TaskGuardInput = { tool: 'task', sessionID: 'ses_test4', callID: 'c4', args: {} }
    const output: TaskGuardOutput = { output: undefined as unknown as string }
    await guard(input, output)
    assert.equal(output.output, EMPTY_TASK_ERROR)
  })

  // ── GREEN: non-task tools pass through untouched ────────────────────

  await testAsync('read tool with empty output → NOT modified (different tool)', async () => {
    const guard = createTaskResultGuard()
    const input: TaskGuardInput = { tool: 'read', sessionID: 'ses_test5', callID: 'c5', args: {} }
    const output: TaskGuardOutput = { output: '' }
    await guard(input, output)
    assert.equal(output.output, '', 'read tool output must not be modified')
  })

  await testAsync('bash tool with empty output → NOT modified', async () => {
    const guard = createTaskResultGuard()
    const input: TaskGuardInput = { tool: 'bash', sessionID: 'ses_test6', callID: 'c6', args: {} }
    const output: TaskGuardOutput = { output: '' }
    await guard(input, output)
    assert.equal(output.output, '', 'bash tool output must not be modified')
  })

  // ── GREEN: task with content → pass through ─────────────────────────

  await testAsync('task tool with real content → NOT modified', async () => {
    const guard = createTaskResultGuard()
    const input: TaskGuardInput = { tool: 'task', sessionID: 'ses_test7', callID: 'c7', args: {} }
    const output: TaskGuardOutput = { output: '## subtask_summary\nfiles_changed: [src/foo.ts]' }
    await guard(input, output)
    assert.equal(
      output.output,
      '## subtask_summary\nfiles_changed: [src/foo.ts]',
      'non-empty task output must pass through',
    )
  })

  await testAsync('task tool with single-word content → NOT modified', async () => {
    const guard = createTaskResultGuard()
    const input: TaskGuardInput = { tool: 'task', sessionID: 'ses_test8', callID: 'c8', args: {} }
    const output: TaskGuardOutput = { output: 'done' }
    await guard(input, output)
    assert.equal(output.output, 'done')
  })

  // ── Edge cases ──────────────────────────────────────────────────────

  await testAsync('guard is idempotent — calling twice does not double-escape', async () => {
    const guard = createTaskResultGuard()
    const input: TaskGuardInput = { tool: 'task', sessionID: 'ses_test9', callID: 'c9', args: {} }
    const output: TaskGuardOutput = { output: '' }
    await guard(input, output)
    await guard(input, output)
    assert.equal(output.output, EMPTY_TASK_ERROR, 'idempotent — same error on second call')
  })

  await testAsync('guard with logger receives warning on empty task', async () => {
    const warnings: string[] = []
    const guard = createTaskResultGuard({ logger: { warn: (m: string) => warnings.push(m) } })
    const input: TaskGuardInput = { tool: 'task', sessionID: 'ses_test10', callID: 'c10', args: {} }
    const output: TaskGuardOutput = { output: '' }
    await guard(input, output)
    assert.equal(warnings.length, 1, 'one warning logged')
    assert.ok(warnings[0]?.includes('ses_test10'), 'warning includes session ID')
    assert.ok(warnings[0]?.includes('task'), 'warning names the tool')
  })

  await testAsync('guard without logger does not throw', async () => {
    const guard = createTaskResultGuard()
    const input: TaskGuardInput = { tool: 'task', sessionID: 'ses_test11', callID: 'c11', args: {} }
    const output: TaskGuardOutput = { output: '' }
    await guard(input, output)
    assert.equal(output.output, EMPTY_TASK_ERROR)
  })

  // ── REPORT ──────────────────────────────────────────────────────────

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
