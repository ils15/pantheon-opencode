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
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runHook, resolveHooksDir } from '../src/plugins/hook-runner.ts'

const SESSION_ID = 'test-session-001'

test('resolveHooksDir points at scripts/hooks with 10 executable scripts', () => {
  const dir = resolveHooksDir()
  assert.match(dir, /scripts\/hooks\/?$/)
  for (const script of [
    'validate-talos-scope.sh',
    'scan-secrets.sh',
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

// ─── scan-secrets.sh ────────────────────────────────────────────────────
// Hybrid blocking contract (user-approved (c), 2026-08-06 — see the
// pantheon-hooks.ts header and scripts/hooks/scan-secrets.sh):
//   exit 0 — no match.
//   exit 1 — LOW_CONFIDENCE match only (header/KEY NAMES: the Bifrost header
//            name alone, api_key=, password=, secret=). Advisory: the
//            plugin logs + toasts, does NOT block.
//   exit 2 — HIGH_CONFIDENCE match (real provider token formats). The
//            plugin BLOCKS the tool call (throws after logging).

test('blocks high-confidence hardcoded secret in tool input (exit 2 — hybrid block)', async () => {
  const githubPrefix = ['gh', 'p_'].join('')
  const res = await runHook('scan-secrets.sh', {
    tool_name: 'bash',
    tool_input: { command: `curl -H "Authorization: token ${githubPrefix + 'a'.repeat(36)}" https://api.github.com` },
    agent_id: 'hermes',
    session_id: SESSION_ID,
  })
  assert.equal(res.code, 2, `expected exit 2 (block), got ${res.code}: ${res.stderr}`)
  assert.match(res.stderr, /SECRET SCAN/)
  assert.match(res.stderr, /BLOCKED/, 'stderr must indicate the tool call is blocked')
})

test('blocks a high-confidence provider token and never logs its raw value', async () => {
  const token = ['sk', '-bf-', 'fixture-', 'a'.repeat(24)].join('')
  const res = await runHook('scan-secrets.sh', {
    tool_name: 'bash',
    tool_input: { command: `printf '%s' '${token}'` },
    agent_id: 'hermes',
    session_id: SESSION_ID,
  })
  assert.equal(res.code, 2, `expected exit 2 (block), got ${res.code}: ${res.stderr}`)
  assert.doesNotMatch(res.stderr, new RegExp(token), 'scanner logs must not expose the token')
  assert.match(res.stderr, /\*\*\*\*/)
})

test('accepts safe placeholder text that resembles a documented token pattern', async () => {
  const placeholder = ['sk', '-bf-', '<REDACTED>'].join('')
  const githubPrefix = ['gh', 'p_'].join('')
  const res = await runHook('scan-secrets.sh', {
    tool_name: 'bash',
    tool_input: { command: `printf '%s %s' '${placeholder}' '${githubPrefix}<PLACEHOLDER>'` },
    agent_id: 'hermes',
    session_id: SESSION_ID,
  })
  assert.equal(res.code, 0, `safe placeholders must not block, got ${res.code}: ${res.stderr}`)
  assert.equal(res.stderr, '')
})

test('treats low-confidence header name alone as advisory (exit 1, no block)', async () => {
  // Header name assembled from parts so this file never contains the literal
  // name (self-match avoidance — see tests/test_secret_scan.mjs).
  const bifrostHeader = ['x', '-bf-', 'vk'].join('')
  const res = await runHook('scan-secrets.sh', {
    tool_name: 'bash',
    tool_input: { command: `curl -H "${bifrostHeader}: abc123" https://example.com` },
    agent_id: 'hermes',
    session_id: SESSION_ID,
  })
  assert.equal(res.code, 1, `expected exit 1 (advisory), got ${res.code}: ${res.stderr}`)
  assert.match(res.stderr, /SECRET SCAN/)
  assert.match(res.stderr, /low confidence/i)
})

test('passes clean input (exit 0)', async () => {
  const res = await runHook('scan-secrets.sh', {
    tool_name: 'bash',
    tool_input: { command: 'ls -la && git status' },
    agent_id: 'hermes',
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

test('runHook never rejects on a non-serializable payload and fails closed', async () => {
  const payload = { tool_input: { circular: null } }
  payload.tool_input.circular = payload

  const res = await runHook('scan-secrets.sh', payload)
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

test('kills a timed-out hook and its background process group', { skip: process.platform === 'win32' }, async () => {
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
  assert.ok(
    elapsed < 2000,
    `empty-payload hook took ${elapsed.toFixed(0)}ms — stdin not closed`,
  )
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
      !Object.prototype.hasOwnProperty.call(last, 'task_id'),
      'empty task_id must be omitted from the line, not emitted as ""',
    )
    assert.equal(last.duration_ms, null, 'missing duration must be null, not a string')
  } finally {
    rmSync(logDir, { recursive: true, force: true })
  }
})
