/**
 * plugin-log-policy.test.mjs — regression test for the pantheon-hooks logging
 * policy (P0 fix 2026-08-06: silence-by-default, NEVER console/TUI;
 * PANTHEON_HOOKS_LOG=1 opt-in debug echo → structured log + hooks.log).
 *
 * Fires the plugin's `event` hook (session.created) directly through the real
 * plugin module and asserts:
 *   1. default (env unset) → ZERO hook lines on the console, no audit echo on
 *      the structured log (client.app.log) and no hooks.log file; the .sh
 *      scripts still write their sessions.log FILE to disk.
 *   2. PANTHEON_HOOKS_LOG=1 → the audit echo is routed to the NON-TUI
 *      channels: the opencode structured log (client.app.log) AND
 *      .pantheon/logs/hooks.log — and STILL never the console (console.error
 *      in a plugin renders into the TUI; that was the original bug).
 *   3. both modes → the .sh scripts still write sessions.log to disk.
 *
 * Run: node --test tests/plugin-log-policy.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PLUGIN_URL = new URL('../src/plugins/pantheon-hooks.ts', import.meta.url).href

/**
 * Fire session.created through the real plugin with a mock client whose
 * app.log captures the structured-log entries (the channel the audit echo is
 * routed to by design). Also captures console output to prove the TUI stays
 * clean in BOTH modes. `logDir` is both the LOG_DIR for the .sh scripts and
 * the plugin's project directory (hooks.log lands in
 * `<logDir>/.pantheon/logs/hooks.log`).
 */
async function fireSession(logDir, debug) {
  const consoleLines = []
  const appLogs = []
  const origLog = console.log
  const origErr = console.error
  console.log = (...a) => consoleLines.push(`[log] ${a.join(' ')}`)
  console.error = (...a) => consoleLines.push(`[err] ${a.join(' ')}`)
  process.env.LOG_DIR = logDir
  if (debug) process.env.PANTHEON_HOOKS_LOG = '1'
  else delete process.env.PANTHEON_HOOKS_LOG
  try {
    // ?debug=N busts the ESM cache so AUDIT_LOG_ENABLED (module-level const)
    // is re-read with the current env for each phase.
    const url = debug ? `${PLUGIN_URL}?debug=1` : PLUGIN_URL
    const mod = await import(url)
    const hooks = await mod.default({
      directory: logDir,
      client: {
        app: { log: async ({ body }) => appLogs.push(body) },
        tui: { showToast: async () => {} },
      },
    })
    await hooks.event({
      event: { type: 'session.created', properties: { info: { id: 'test-silence-xyz' } } },
    })
  } finally {
    console.log = origLog
    console.error = origErr
  }
  return { consoleLines, appLogs }
}

test('default: audit hooks are SILENT (console + structured log + hooks.log) but still write their log FILE', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'plg-silent-'))
  try {
    const { consoleLines, appLogs } = await fireSession(logDir, false)
    const hookLines = consoleLines.filter((l) => l.includes('[pantheon-hooks:'))
    assert.equal(hookLines.length, 0, `expected console silence, got: ${hookLines.join(' | ')}`)
    const audit = appLogs.filter((l) => l.message.includes('[pantheon-hooks:'))
    assert.equal(
      audit.length,
      0,
      `expected no structured-log audit echo, got: ${audit.map((l) => l.message).join(' | ')}`,
    )
    assert.equal(
      existsSync(join(logDir, '.pantheon', 'logs', 'hooks.log')),
      false,
      'hooks.log must not be created when no hook reports (silent default)',
    )
    // File logging still happens — the .sh script writes sessions.log itself.
    const fileContent = readFileSync(join(logDir, 'sessions.log'), 'utf8')
    assert.match(fileContent, /"event":"SessionStart"/)
    assert.match(fileContent, /test-silence-xyz/)
  } finally {
    rmSync(logDir, { recursive: true, force: true })
  }
})

test('PANTHEON_HOOKS_LOG=1 routes the audit echo to structured log + hooks.log, NEVER console', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'plg-debug-'))
  try {
    const { consoleLines, appLogs } = await fireSession(logDir, true)
    const hookLines = consoleLines.filter((l) => l.includes('[pantheon-hooks:'))
    assert.equal(
      hookLines.length,
      0,
      `debug mode must NEVER echo to the console/TUI, got: ${hookLines.join(' | ')}`,
    )
    const audit = appLogs.filter((l) => l.message.includes('[pantheon-hooks:log-session-start.sh]'))
    assert.ok(
      audit.length > 0,
      'debug mode must route the audit echo to the structured log (client.app.log)',
    )
    assert.ok(
      audit.some((l) => l.level === 'info' && /Session start logged/.test(l.message)),
      'audit entry must be level info and carry the script stderr',
    )
    // hooks.log on disk mirrors the structured log (never the TUI).
    const hooksLog = join(logDir, '.pantheon', 'logs', 'hooks.log')
    assert.equal(existsSync(hooksLog), true, 'debug mode must write hooks.log')
    const fileContent = readFileSync(hooksLog, 'utf8')
    assert.match(fileContent, /\[pantheon-hooks:log-session-start\.sh\]/)
    assert.match(fileContent, /Session start logged/)
    // File logging still happens in debug mode too.
    const sessions = readFileSync(join(logDir, 'sessions.log'), 'utf8')
    assert.match(sessions, /test-silence-xyz/)
  } finally {
    rmSync(logDir, { recursive: true, force: true })
  }
})
