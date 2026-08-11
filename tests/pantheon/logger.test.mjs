/**
 * logger.test.mjs — regression tests for src/pantheon/logger.ts, the
 * silence-by-default TUI logging policy shared with pantheon-hooks.
 *
 * Policy (pantheon-hooks.ts L42-58): console output in a plugin writes to
 * the process stdout/stderr, which the opencode TUI renders directly into
 * the terminal — that was the "lixo" pollution (e.g. `[Pantheon Plugin] Board
 * terminal: ...` lines in the TUI footer). Pantheon modules must therefore
 * NEVER write to the console by default: every line goes to
 * `.pantheon/logs/hooks.log` (project-local one-line append, ISO-stamped,
 * module-prefixed) and the console echo is OPT-IN via `PANTHEON_HOOKS_LOG=1`
 * (the same env var pantheon-hooks uses).
 *
 * Tests:
 *   1. default (env unset) → hooks.log written, console NEVER touched;
 *   2. PANTHEON_HOOKS_LOG=1 → file AND console (opt-in debug echo);
 *   3. log file appends across calls, every line ISO-stamped + module-prefixed;
 *   4. the process.env gate is read at creation time (per-instance);
 *   5. regression: src/plugin.ts has NO bare console.log/console.error/
 *      console.warn (all routed through the logger).
 *
 * Run: node --test tests/pantheon/logger.test.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const LOGGER_URL = new URL('../../src/pantheon/logger.ts', import.meta.url).href
const PLUGIN_URL = new URL('../../src/plugin.ts', import.meta.url).href
const { createPantheonLogger } = await import(LOGGER_URL)

/** Intercept console.* and record every call (restore() puts them back). */
function captureConsole() {
  const calls = []
  const orig = { log: console.log, error: console.error, warn: console.warn }
  console.log = (...a) => calls.push(['log', ...a])
  console.error = (...a) => calls.push(['error', ...a])
  console.warn = (...a) => calls.push(['warn', ...a])
  return {
    calls,
    restore() {
      console.log = orig.log
      console.error = orig.error
      console.warn = orig.warn
    },
  }
}

/**
 * Console calls produced by the logger itself (node's own warnings — e.g.
 * MODULE_TYPELESS_PACKAGE_JSON on the first .ts import — also hit stderr,
 * so filter by the module prefix like plugin-log-policy.test.mjs does).
 */
function loggerCalls(spy, prefix) {
  return spy.calls.filter((call) => String(call[1] ?? '').includes(prefix))
}

/** Poll until `predicate()` is true (the logger appends fire-and-forget). */
async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error('timed out waiting for condition')
}

function makeTmpDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix))
}

test('default (env unset): writes hooks.log, never touches console', async () => {
  const tmp = makeTmpDir('pantheon-log-silent-')
  const prevEnv = process.env.PANTHEON_HOOKS_LOG
  delete process.env.PANTHEON_HOOKS_LOG
  const spy = captureConsole()
  try {
    const log = createPantheonLogger({ module: 'pantheon-test', logDir: tmp })
    log.info('hello info')
    log.error('boom', new Error('kaboom'))
    const hooksLog = join(tmp, '.pantheon', 'logs', 'hooks.log')
    await waitFor(() => existsSync(hooksLog))

    const mine = loggerCalls(spy, '[pantheon-test]')
    assert.equal(
      mine.length,
      0,
      `console must stay silent by default, got: ${JSON.stringify(spy.calls)}`,
    )

    const content = readFileSync(hooksLog, 'utf8')
    assert.match(content, /\[pantheon-test\] hello info/)
    assert.match(content, /\[pantheon-test\] boom/)
    // Error args serialize to stack/message — never "[object Object]".
    assert.match(content, /kaboom/)
    assert.doesNotMatch(content, /\[object Object\]/)
    // Every line is ISO-stamped.
    for (const line of content.trim().split('\n')) {
      assert.match(line, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/)
    }
  } finally {
    spy.restore()
    if (prevEnv === undefined) delete process.env.PANTHEON_HOOKS_LOG
    else process.env.PANTHEON_HOOKS_LOG = prevEnv
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('PANTHEON_HOOKS_LOG=1: file AND console (opt-in debug echo)', async () => {
  const tmp = makeTmpDir('pantheon-log-echo-')
  const spy = captureConsole()
  try {
    const log = createPantheonLogger({ module: 'pantheon-test', env: '1', logDir: tmp })
    log.warn('hello warn')
    const hooksLog = join(tmp, '.pantheon', 'logs', 'hooks.log')
    await waitFor(() => loggerCalls(spy, '[pantheon-test]').length === 1 && existsSync(hooksLog))

    const mine = loggerCalls(spy, '[pantheon-test]')
    assert.equal(mine.length, 1, 'env gate must echo exactly once to console')
    assert.equal(mine[0][0], 'warn')
    assert.match(String(mine[0][1]), /\[pantheon-test\] hello warn/)

    const content = readFileSync(hooksLog, 'utf8')
    assert.match(content, /\[pantheon-test\] hello warn/)
  } finally {
    spy.restore()
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('log file appends across calls with ISO-stamped, module-prefixed lines', async () => {
  const tmp = makeTmpDir('pantheon-log-append-')
  try {
    const log = createPantheonLogger({ module: 'multi', logDir: tmp })
    log.info('first')
    log.warn('second line')
    const hooksLog = join(tmp, '.pantheon', 'logs', 'hooks.log')
    await waitFor(
      () => existsSync(hooksLog) && readFileSync(hooksLog, 'utf8').trim().split('\n').length >= 2,
    )

    const lines = readFileSync(hooksLog, 'utf8').trim().split('\n')
    assert.equal(lines.length, 2)
    for (const line of lines) {
      assert.match(line, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[multi\] /)
    }
    assert.match(lines[0], /\[multi\] first/)
    assert.match(lines[1], /\[multi\] second line/)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('process.env.PANTHEON_HOOKS_LOG gates the console echo at creation time', async () => {
  const tmp = makeTmpDir('pantheon-log-envgate-')
  const prevEnv = process.env.PANTHEON_HOOKS_LOG
  try {
    process.env.PANTHEON_HOOKS_LOG = '1'
    const spyOn = captureConsole()
    const on = createPantheonLogger({ module: 'env-on', logDir: tmp })
    on.info('echoed')
    await waitFor(() => loggerCalls(spyOn, '[env-on]').length === 1)
    assert.equal(loggerCalls(spyOn, '[env-on]').length, 1, 'gate ON must echo')
    spyOn.restore()

    delete process.env.PANTHEON_HOOKS_LOG
    const spyOff = captureConsole()
    const off = createPantheonLogger({ module: 'env-off', logDir: tmp })
    off.info('silent')
    await waitFor(() => existsSync(join(tmp, '.pantheon', 'logs', 'hooks.log')))
    assert.equal(loggerCalls(spyOff, '[env-off]').length, 0, 'gate OFF must stay silent')
    spyOff.restore()
  } finally {
    if (prevEnv === undefined) delete process.env.PANTHEON_HOOKS_LOG
    else process.env.PANTHEON_HOOKS_LOG = prevEnv
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('regression: src/plugin.ts has NO bare console.log/console.error/console.warn', () => {
  const src = readFileSync(new URL(PLUGIN_URL), 'utf8')
  const offenders = [...src.matchAll(/console\.(log|error|warn)\s*\(/g)].map((m) => m[0])
  assert.deepEqual(
    offenders,
    [],
    'plugin.ts must not write to the console directly (TUI pollution) — route through createPantheonLogger',
  )
})
