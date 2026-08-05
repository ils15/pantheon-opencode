/**
 * plugin-log-policy.test.mjs — regression test for the pantheon-hooks logging
 * policy (silence-by-default; PANTHEON_HOOKS_LOG=1 opt-in for audit echo).
 *
 * Fires the plugin's `event` hook (session.created) directly through the real
 * plugin module and asserts:
 *   1. default (env unset) → ZERO hook lines on the console
 *   2. PANTHEON_HOOKS_LOG=1   → audit hooks echo to the console
 *   3. both modes → the .sh scripts still write sessions.log to disk
 *
 * Run: node --test tests/plugin-log-policy.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PLUGIN_URL = new URL('../src/plugins/pantheon-hooks.ts', import.meta.url).href

/** Fire session.created through the real plugin; capture console output. */
async function fireSession(logDir, debug) {
  const lines = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...a) => lines.push(`[log] ${a.join(' ')}`)
  console.error = (...a) => lines.push(`[err] ${a.join(' ')}`)
  process.env.LOG_DIR = logDir
  if (debug) process.env.PANTHEON_HOOKS_LOG = '1'
  else delete process.env.PANTHEON_HOOKS_LOG
  try {
    // ?debug=N busts the ESM cache so AUDIT_LOG_ENABLED (module-level const)
    // is re-read with the current env for each phase.
    const url = debug ? `${PLUGIN_URL}?debug=1` : PLUGIN_URL
    const mod = await import(url)
    const hooks = await mod.default({})
    await hooks.event({
      event: { type: 'session.created', properties: { info: { id: 'test-silence-xyz' } } },
    })
  } finally {
    console.log = origLog
    console.error = origErr
  }
  return lines
}

test('default: audit hooks are SILENT on console but still write their log FILE', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'plg-silent-'))
  try {
    const lines = await fireSession(logDir, false)
    const hookLines = lines.filter((l) => l.includes('[pantheon-hooks:'))
    assert.equal(hookLines.length, 0, `expected silence, got: ${hookLines.join(' | ')}`)
    const fileContent = readFileSync(join(logDir, 'sessions.log'), 'utf8')
    assert.match(fileContent, /"event":"SessionStart"/)
    assert.match(fileContent, /test-silence-xyz/)
  } finally {
    rmSync(logDir, { recursive: true, force: true })
  }
})

test('PANTHEON_HOOKS_LOG=1 re-enables the audit echo (opt-in debug)', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'plg-debug-'))
  try {
    const lines = await fireSession(logDir, true)
    const hookLines = lines.filter((l) => l.includes('[pantheon-hooks:'))
    assert.ok(hookLines.length > 0, 'debug mode must echo audit hooks')
    assert.match(hookLines.join(' '), /log-session-start\.sh/)
    // File logging still happens in debug mode too.
    const fileContent = readFileSync(join(logDir, 'sessions.log'), 'utf8')
    assert.match(fileContent, /test-silence-xyz/)
  } finally {
    rmSync(logDir, { recursive: true, force: true })
  }
})
