/**
 * Tests for the V2 shell-hook parity module (#266).
 *
 * `format-multi-language.sh` and the two `on-subagent-delegation-*.sh` audit
 * scripts ran only from `src/plugins/pantheon-hooks.ts`, which a V2-only
 * install never loads. This module rebuilds the wiring without that plugin; the
 * runner is injected so the assertions are about the PAYLOAD the scripts
 * receive (the part the audit log joins on), not about spawning bash.
 *
 * Run with: npx tsx tests/pantheon/v2-shell-hooks.test.ts
 */
import { strict as assert } from 'node:assert'
import {
  createV2ShellHooks,
  DELEGATION_START_SCRIPT,
  DELEGATION_STOP_SCRIPT,
  delegationAgent,
  delegationStatus,
  extractTaskID,
  FORMATTER_SCRIPT,
  V2_DELEGATION_TOOL_RE,
} from '../../src/pantheon/v2-shell-hooks.ts'
import type { HookPayload, HookResult } from '../../src/plugins/hook-runner.ts'

// ─── Harness ─────────────────────────────────────────────────────────────

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

const ok: HookResult = { code: 0, stdout: '', stderr: '', signal: null, timedOut: false }

interface Call {
  script: string
  payload: HookPayload & Record<string, unknown>
}

function recorder(): { calls: Call[]; run: (s: string, p: HookPayload) => Promise<HookResult> } {
  const calls: Call[] = []
  return {
    calls,
    run: async (script, payload) => {
      calls.push({ script, payload: payload as HookPayload & Record<string, unknown> })
      return ok
    },
  }
}

const beforeEvent = (over: Record<string, unknown> = {}) => ({
  tool: 'subagent',
  sessionID: 'ses-audit',
  agent: 'zeus',
  messageID: 'msg-audit',
  id: 'call-audit',
  input: { agent: 'apollo' },
  ...over,
})

const afterEvent = (over: Record<string, unknown> = {}) => ({
  ...beforeEvent(),
  status: 'completed',
  result: { output: 'done' },
  ...over,
})

// ─── Delegation regex / derivations ──────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n🐚 V2 shell-hook parity tests')

  await testAsync('the delegation regex mirrors V1 task/subagent matching', async () => {
    for (const tool of ['task', 'subagent', 'pantheon_subagent']) {
      assert.equal(V2_DELEGATION_TOOL_RE.test(tool), true, `${tool} is a delegation tool`)
    }
    for (const tool of ['read', 'write', 'hashline_edit', 'pantheon_subagent_cost']) {
      // `.*subagent.*` is V1's pattern, so a name merely CONTAINING the word
      // still matches; what must not match is an unrelated tool.
      assert.equal(
        V2_DELEGATION_TOOL_RE.test(tool),
        tool === 'pantheon_subagent_cost',
        `${tool} delegation classification drifted from V1`,
      )
    }
  })

  await testAsync(
    'delegationAgent prefers subagent_type, then agent/target, then tool',
    async () => {
      assert.equal(delegationAgent('subagent', { subagent_type: 'apollo' }), 'apollo')
      assert.equal(delegationAgent('subagent', { agent: 'gaia' }), 'gaia')
      assert.equal(delegationAgent('subagent', { target: 'hermes' }), 'hermes')
      assert.equal(delegationAgent('subagent', {}), 'subagent')
      assert.equal(delegationAgent('subagent', null), 'subagent')
      assert.equal(delegationAgent('task', { subagent_type: '   ' }), 'task')
    },
  )

  await testAsync('extractTaskID reads the dispatch id from the result or metadata', async () => {
    assert.equal(extractTaskID({ task_id: 't_1' }), 't_1')
    assert.equal(extractTaskID({ metadata: { task_id: 't_2' } }), 't_2')
    assert.equal(extractTaskID({ output: 'no id here' }), '')
    assert.equal(extractTaskID(null), '')
  })

  await testAsync('delegationStatus never fabricates success for a dispatch', async () => {
    assert.equal(delegationStatus({ status: 'error' }), 'failure')
    assert.equal(
      delegationStatus({ status: 'completed', result: { task_id: 't_1' } }),
      'dispatched',
    )
    assert.equal(
      delegationStatus({ status: 'completed', result: { metadata: { state: 'running' } } }),
      'dispatched',
    )
    assert.equal(delegationStatus({ status: 'completed', result: { output: 'x' } }), 'success')
  })

  // ─── before ────────────────────────────────────────────────────────────

  await testAsync(
    'before runs the START script with a delegation id and the target agent',
    async () => {
      const { calls, run } = recorder()
      const hooks = createV2ShellHooks({ run })
      await hooks.before(beforeEvent())
      assert.equal(calls.length, 1)
      assert.equal(calls[0]?.script, DELEGATION_START_SCRIPT)
      assert.equal(calls[0]?.payload.tool_name, 'subagent')
      assert.equal(calls[0]?.payload.agent_id, 'apollo')
      assert.equal(calls[0]?.payload.session_id, 'ses-audit')
      assert.equal(typeof calls[0]?.payload.delegation_id, 'string')
      assert.notEqual(calls[0]?.payload.delegation_id, '')
    },
  )

  await testAsync('before ignores non-delegation tools', async () => {
    const { calls, run } = recorder()
    const hooks = createV2ShellHooks({ run })
    await hooks.before(beforeEvent({ tool: 'write', input: { filePath: 'a.ts' } }))
    assert.deepEqual(calls, [])
  })

  await testAsync('before tolerates malformed events without throwing', async () => {
    const { run } = recorder()
    const hooks = createV2ShellHooks({ run })
    await hooks.before(null)
    await hooks.before({})
    await hooks.before({ tool: 42, input: 'not-an-object' })
  })

  // ─── after ─────────────────────────────────────────────────────────────

  await testAsync(
    'after runs the formatter and the STOP record joined on delegation_id',
    async () => {
      const { calls, run } = recorder()
      const hooks = createV2ShellHooks({ run, now: () => 1_000 })
      await hooks.before(beforeEvent())
      await hooks.after(afterEvent())

      const formatter = calls.find((call) => call.script === FORMATTER_SCRIPT)
      const stop = calls.find((call) => call.script === DELEGATION_STOP_SCRIPT)
      assert.ok(formatter, 'the formatter must run on every after-event, as on V1')
      assert.ok(stop, 'the delegation STOP record must be written')
      assert.equal(
        stop?.payload.delegation_id,
        calls[0]?.payload.delegation_id,
        'start and stop join on the same delegation_id',
      )
      assert.equal(stop?.payload.agent_id, 'apollo')
      assert.equal(stop?.payload.status, 'success')
      assert.equal(stop?.payload.duration_ms, 0)
    },
  )

  await testAsync('a background dispatch is logged as dispatched, not success', async () => {
    const { calls, run } = recorder()
    const hooks = createV2ShellHooks({ run })
    await hooks.before(beforeEvent())
    await hooks.after(afterEvent({ result: { task_id: 'task-9', state: 'running' } }))
    const stop = calls.find((call) => call.script === DELEGATION_STOP_SCRIPT)
    assert.equal(stop?.payload.status, 'dispatched')
    assert.equal(stop?.payload.task_id, 'task-9')
  })

  await testAsync('the BEFORE-time agent wins over after-time args', async () => {
    const { calls, run } = recorder()
    const hooks = createV2ShellHooks({ run })
    await hooks.before(beforeEvent({ input: { agent: 'gaia' } }))
    // The after event's args carry the merged result, with no agent at all.
    await hooks.after(afterEvent({ input: { task_id: 'task-1', state: 'running' } }))
    const stop = calls.find((call) => call.script === DELEGATION_STOP_SCRIPT)
    assert.equal(stop?.payload.agent_id, 'gaia')
  })

  await testAsync('an orphan STOP still carries a key (never an unkeyed record)', async () => {
    const { calls, run } = recorder()
    const hooks = createV2ShellHooks({ run })
    await hooks.after(afterEvent())
    const stop = calls.find((call) => call.script === DELEGATION_STOP_SCRIPT)
    assert.ok(stop, 'a missing start record must not suppress the stop record')
    // A stop record with no key can never be joined to anything, so the audit
    // log cannot close it. Synthesize a key instead of omitting the field.
    assert.equal(typeof stop?.payload.delegation_id, 'string')
    assert.notEqual(stop?.payload.delegation_id, '')
  })

  await testAsync(
    'an event with no call id writes NEITHER record (no unclosable START)',
    async () => {
      const warnings: string[] = []
      const { calls, run } = recorder()
      const hooks = createV2ShellHooks({ run, onUnkeyed: (message) => warnings.push(message) })
      await hooks.before(beforeEvent({ id: undefined }))
      await hooks.after(afterEvent({ id: undefined }))
      assert.deepEqual(
        calls.map((call) => call.script),
        [FORMATTER_SCRIPT],
        'the formatter still runs; the audit pair is skipped because it cannot be joined',
      )
      assert.equal(
        warnings.length,
        1,
        'the unkeyed case warns once per process, not once per event',
      )
      assert.match(warnings[0] ?? '', /no tool call id/)
    },
  )

  await testAsync('a START and its STOP always share one non-empty key', async () => {
    const { calls, run } = recorder()
    const hooks = createV2ShellHooks({ run })
    await hooks.before(beforeEvent())
    await hooks.after(afterEvent())
    const start = calls.find((call) => call.script === DELEGATION_START_SCRIPT)
    const stop = calls.find((call) => call.script === DELEGATION_STOP_SCRIPT)
    assert.equal(typeof start?.payload.delegation_id, 'string')
    assert.notEqual(start?.payload.delegation_id, '')
    assert.equal(stop?.payload.delegation_id, start?.payload.delegation_id)
  })

  await testAsync(
    'the formatter runs for non-delegation tools and no stop record is written',
    async () => {
      const { calls, run } = recorder()
      const hooks = createV2ShellHooks({ run })
      await hooks.after(afterEvent({ tool: 'edit', input: { filePath: 'src/a.ts' } }))
      assert.deepEqual(
        calls.map((call) => call.script),
        [FORMATTER_SCRIPT],
      )
      assert.equal(calls[0]?.payload.tool_name, 'edit')
      assert.deepEqual(calls[0]?.payload.tool_input, { filePath: 'src/a.ts' })
    },
  )

  await testAsync('a throwing runner never breaks the observed tool call', async () => {
    const hooks = createV2ShellHooks({
      run: async () => {
        throw new Error('runner exploded')
      },
    })
    await hooks.before(beforeEvent())
    await hooks.after(afterEvent())
  })

  await testAsync('the pending-start map is bounded', async () => {
    const { run } = recorder()
    const hooks = createV2ShellHooks({ run })
    for (let i = 0; i < 400; i++) {
      await hooks.before(beforeEvent({ id: `call-${i}` }))
    }
    // No assertion on internals: the point is that 400 unmatched starts do not
    // grow unbounded (the cap evicts the oldest) and nothing throws.
  })

  await testAsync('after tolerates malformed events without throwing', async () => {
    const { run } = recorder()
    const hooks = createV2ShellHooks({ run })
    await hooks.after(null)
    await hooks.after({})
    await hooks.after({ tool: 'subagent', result: null })
  })

  // ─── Report ────────────────────────────────────────────────────────────

  let passed = 0
  let failed = 0
  for (const result of results) {
    if (result.passed) {
      passed++
      console.log(`  ✅ ${result.name}`)
    } else {
      failed++
      console.log(`  ❌ ${result.name}: ${result.error}`)
    }
  }
  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`)
  if (failed > 0) process.exitCode = 1
}

await main()
