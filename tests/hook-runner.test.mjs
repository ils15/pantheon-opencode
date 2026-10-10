/**
 * hook-runner.test.mjs — TDD tests for the Pantheon security-hooks runner
 * (src/plugins/hook-runner.ts).
 *
 * Validates the P0 fix approved by Council Synthesis 2026-08-05:
 *  - the runner uses node:child_process (version-proof, no Bun Shell `$`)
 *  - the Claude Code stdin protocol is honored: {tool_name, tool_input,
 *    agent_id, session_id} JSON is written to the hook script's stdin
 *  - destructive commands / secrets / Talos scope violations are blocked
 *    by the hook scripts (nonzero exit) and surfaced as results, never thrown
 *
 * Run: node --test tests/hook-runner.test.mjs
 * (Node >= 22.18 imports the .ts module natively via type stripping.)
 */

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveHooksDir, runHook } from '../src/plugins/hook-runner.ts'

const SESSION_ID = 'test-session-001'

test('resolveHooksDir points at scripts/hooks with 9 executable scripts', () => {
  const dir = resolveHooksDir()
  assert.match(dir, /scripts\/hooks\/?$/)
  for (const script of [
    'validate-talos-scope.sh',
    'validate-tool-safety.sh',
    'format-multi-language.sh',
    'validate-post-conditions.sh',
    'on-subagent-delegation-start.sh',
    'on-subagent-delegation-stop.sh',
    'log-session-start.sh',
    'audit-imports.sh',
    'run-type-check.sh',
  ]) {
    assert.ok(existsSync(join(dir, script)), `missing script: ${script}`)
  }
})

// ─── validate-tool-safety.sh (approved validation case) ─────────────────

test('blocks destructive command: rm -rf / (exit 1)', async () => {
  const res = await runHook('validate-tool-safety.sh', {
    tool_name: 'bash',
    tool_input: { command: 'rm -rf /' },
    agent_id: 'hermes',
    session_id: SESSION_ID,
  })
  assert.equal(res.code, 1, `expected exit 1, got ${res.code}: ${res.stderr}`)
  assert.match(res.stderr, /SECURITY BLOCKED/)
})

test('blocks destructive command: rm -rf /* (exit 1)', async () => {
  const res = await runHook('validate-tool-safety.sh', {
    tool_name: 'bash',
    tool_input: { command: 'rm -rf /*' },
    agent_id: 'hermes',
    session_id: SESSION_ID,
  })
  assert.equal(res.code, 1)
})

test('passes harmless command (exit 0)', async () => {
  const res = await runHook('validate-tool-safety.sh', {
    tool_name: 'bash',
    tool_input: { command: 'echo hello && ls -la' },
    agent_id: 'hermes',
    session_id: SESSION_ID,
  })
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}: ${res.stderr}`)
})

// ─── validate-talos-scope.sh (approved validation case) ─────────────────

test('blocks talos from touching schema.sql (exit 2)', async () => {
  const res = await runHook('validate-talos-scope.sh', {
    tool_name: 'edit',
    tool_input: { filePath: 'schema.sql' },
    agent_id: 'talos',
    session_id: SESSION_ID,
  })
  assert.equal(res.code, 2, `expected exit 2, got ${res.code}: ${res.stderr}`)
})

test('allows non-talos agent touching schema.sql (exit 0)', async () => {
  const res = await runHook('validate-talos-scope.sh', {
    tool_name: 'edit',
    tool_input: { filePath: 'schema.sql' },
    agent_id: 'hermes',
    session_id: SESSION_ID,
  })
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}: ${res.stderr}`)
})

test('allows talos doing harmless edits (exit 0)', async () => {
  const res = await runHook('validate-talos-scope.sh', {
    tool_name: 'edit',
    tool_input: { filePath: 'src/components/Button.tsx' },
    agent_id: 'talos',
    session_id: SESSION_ID,
  })
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}: ${res.stderr}`)
})

// ─── runner robustness ──────────────────────────────────────────────────

test('runHook NEVER throws on missing script — resolves with code 1', async () => {
  let res
  try {
    res = await runHook('does-not-exist.sh', { session_id: SESSION_ID })
  } catch (err) {
    assert.fail(`runHook must never throw, got: ${err}`)
  }
  assert.notEqual(res.code, 0)
  assert.match(res.stderr, /ENOENT|spawn|failed/i)
})

test('runHook never rejects on a non-serializable payload', async () => {
  const payload = { tool_input: { circular: null } }
  payload.tool_input.circular = payload

  const res = await runHook('validate-tool-safety.sh', payload)
  assert.equal(typeof res.code, 'number')
  assert.equal(res.code, 1)
  assert.equal(res.timedOut, false)
  assert.match(res.stderr, /payload serialization failed/i)
})

test('returns exit code and captures stdout/stderr from a custom hook', async () => {
  const hooksDir = mkdtempSync(join(tmpdir(), 'pantheon-hook-runner-'))
  const script = join(hooksDir, 'emit.sh')
  try {
    writeFileSync(script, '#!/bin/sh\nprintf "hook stdout"\nprintf "hook stderr" >&2\nexit 7\n')
    chmodSync(script, 0o755)

    const res = await runHook('emit.sh', {}, { cwd: hooksDir })
    assert.equal(res.code, 7)
    assert.equal(res.stdout, 'hook stdout')
    assert.equal(res.stderr, 'hook stderr')
    assert.equal(res.signal, null)
    assert.equal(res.timedOut, false)
  } finally {
    rmSync(hooksDir, { recursive: true, force: true })
  }
})

test('kills a timed-out hook with SIGKILL and returns a structured result', async () => {
  const hooksDir = mkdtempSync(join(tmpdir(), 'pantheon-hook-runner-'))
  const script = join(hooksDir, 'hang.sh')
  try {
    writeFileSync(script, '#!/bin/sh\nprintf "before timeout"\nsleep 10\n')
    chmodSync(script, 0o755)

    const res = await runHook('hang.sh', {}, { cwd: hooksDir, timeout: 50 })
    assert.equal(res.code, 1)
    assert.equal(res.signal, 'SIGKILL')
    assert.equal(res.timedOut, true)
    assert.equal(res.stdout, 'before timeout')
    assert.equal(typeof res.stderr, 'string')
  } finally {
    rmSync(hooksDir, { recursive: true, force: true })
  }
})

test('kills a timed-out hook and its background process group', {
  skip: process.platform === 'win32',
}, async () => {
  const hooksDir = mkdtempSync(join(tmpdir(), 'pantheon-hook-runner-'))
  const script = join(hooksDir, 'descendant.sh')
  const marker = join(hooksDir, 'descendant-survived')
  try {
    writeFileSync(
      script,
      `#!/bin/sh
(sleep 2; printf survived > '${marker}') &
wait
`,
    )
    chmodSync(script, 0o755)

    const res = await runHook('descendant.sh', {}, { cwd: hooksDir, timeout: 50 })
    assert.equal(res.timedOut, true)
    assert.equal(res.signal, 'SIGKILL')

    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(existsSync(marker), false, 'background descendant survived the process-group kill')
  } finally {
    rmSync(hooksDir, { recursive: true, force: true })
  }
})

test('runHook never throws on a script that reads no stdin (env protocol)', async () => {
  // log-session-start.sh uses env vars (SESSION_ID/LOG_DIR), not stdin —
  // the runner must map payload fields into the env so it works end to end.
  const logDir = mkdtempSync(join(tmpdir(), 'pantheon-hooks-test-'))
  try {
    const res = await runHook(
      'log-session-start.sh',
      { session_id: 'env-protocol-xyz' },
      { env: { LOG_DIR: logDir } },
    )
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}: ${res.stderr}`)
    const log = readFileSync(join(logDir, 'sessions.log'), 'utf8')
    assert.match(log, /"event":"SessionStart"/)
    assert.match(log, /env-protocol-xyz/)
  } finally {
    rmSync(logDir, { recursive: true, force: true })
  }
})

// ─── regression: no stdin hang (runtime P0 report) ──────────────────────

test('regression: validate-talos-scope resolves in < 2s (no stdin hang)', async () => {
  // Reported symptom: "Hook validate-talos-scope.sh timed out after 30000ms"
  // per tool call — caused by a version that left the child reading the TUI
  // stdin. The current runner closes stdin after writing the payload, so the
  // script must exit immediately (milliseconds), not 30s.
  const start = performance.now()
  const res = await runHook('validate-talos-scope.sh', {
    tool_name: 'edit',
    tool_input: {},
    agent_id: 'hermes',
    session_id: SESSION_ID,
  })
  const elapsed = performance.now() - start
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}: ${res.stderr}`)
  assert.ok(
    elapsed < 2000,
    `hook took ${elapsed.toFixed(0)}ms — stdin hang detected (must be < 2000ms)`,
  )
})

test('regression: runHook closes stdin even with EMPTY payload ({}), resolves fast', async () => {
  const start = performance.now()
  const res = await runHook('validate-talos-scope.sh', {})
  const elapsed = performance.now() - start
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}: ${res.stderr}`)
  assert.ok(elapsed < 2000, `empty-payload hook took ${elapsed.toFixed(0)}ms — stdin not closed`)
})

// ─── on-subagent-delegation-stop.sh delegations.log line format ─────────
// 1.3.4 regression: the log line used to emit `task_id: ""` (empty) and
// `duration_ms` as a STRING (prim() stringified the plugin's numeric value).
// The line must carry the REAL task id (never empty when a job exists) and a
// NUMERIC duration_ms.

test('delegation stop log: task_id is the real id and duration_ms is numeric', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'pantheon-delegation-log-'))
  try {
    const res = await runHook(
      'on-subagent-delegation-stop.sh',
      {
        tool_name: 'task',
        tool_input: { subagent_type: 'apollo', description: 'Find X' },
        session_id: 'ses_parent_1',
        delegation_id: 'del-001',
        task_id: 'ses_child_99',
        duration_ms: 1234,
        status: 'success',
        tool_output: { title: 'ok', output: 'done', metadata: null },
      },
      { env: { LOG_DIR: logDir } },
    )
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}: ${res.stderr}`)
    const lines = readFileSync(join(logDir, 'delegations.log'), 'utf8').trim().split('\n')
    const last = JSON.parse(lines[lines.length - 1])
    assert.equal(last.event, 'SubagentStop')
    assert.equal(last.task_id, 'ses_child_99', 'task_id must be the real child id, never ""')
    assert.equal(typeof last.duration_ms, 'number', 'duration_ms must be numeric, not a string')
    assert.equal(last.duration_ms, 1234)
  } finally {
    rmSync(logDir, { recursive: true, force: true })
  }
})

test('delegation stop log: empty task_id is OMITTED and unparseable duration is null', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'pantheon-delegation-log-empty-'))
  try {
    const res = await runHook(
      'on-subagent-delegation-stop.sh',
      {
        tool_name: 'task',
        tool_input: { subagent_type: 'apollo', description: 'Find X' },
        session_id: 'ses_parent_2',
        delegation_id: 'del-002',
        task_id: '',
        status: 'success',
        tool_output: { title: 'ok', output: 'done', metadata: null },
      },
      { env: { LOG_DIR: logDir } },
    )
    assert.equal(res.code, 0, `expected exit 0, got ${res.code}: ${res.stderr}`)
    const lines = readFileSync(join(logDir, 'delegations.log'), 'utf8').trim().split('\n')
    const last = JSON.parse(lines[lines.length - 1])
    assert.ok(
      !Object.hasOwn(last, 'task_id'),
      'empty task_id must be omitted from the line, not emitted as ""',
    )
    assert.equal(last.duration_ms, null, 'missing duration must be null, not a string')
  } finally {
    rmSync(logDir, { recursive: true, force: true })
  }
})
