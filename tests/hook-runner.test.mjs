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
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
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

test('blocks hardcoded secret in tool input (exit 1)', async () => {
  const res = await runHook('scan-secrets.sh', {
    tool_name: 'bash',
    tool_input: { command: `curl -H "Authorization: token ${'ghp_' + 'a'.repeat(36)}" https://api.github.com` },
    agent_id: 'hermes',
    session_id: SESSION_ID,
  })
  assert.equal(res.code, 1, `expected exit 1, got ${res.code}: ${res.stderr}`)
  assert.match(res.stderr, /SECRET SCAN/)
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
