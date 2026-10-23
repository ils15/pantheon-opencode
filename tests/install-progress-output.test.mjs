/**
 * install-progress-output.test.mjs — progress, not a log.
 *
 * The installer used to scroll one line per step (and, in a dry run, one line
 * per FILE). It now draws a gauge: a single rewritten line on a TTY, one line
 * per completed phase on CI. The dry-run default is a summary; the per-file
 * list is opt-in via --verbose (--json stays structured and untouched).
 *
 * These tests pin both surfaces: the gauge contract itself, and the CLI's
 * default/verbose/JSON output. The non-TTY case asserts the line count equals
 * the NUMBER OF PHASES, never the number of planned files.
 *
 * Run: node --test tests/install-progress-output.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { configure, gauge, step } from '../scripts/install/cli-ui.mjs'
import { installOpenCode, planInstallPhases } from '../scripts/install/opencode.mjs'
import { installPlugin } from '../scripts/install/plugin.mjs'
import { ROOT } from '../scripts/install/shared.mjs'
import { setupVenv } from '../scripts/install/venv.mjs'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const BIN = join(REPO_ROOT, 'bin', 'pantheon-init.mjs')

process.env.LANG = 'C'
process.env.LC_ALL = 'C'

async function captureAsyncConsole(fn) {
  const original = { log: console.log, warn: console.warn, error: console.error }
  const lines = []
  console.log = (...values) => lines.push(values.join(' '))
  console.warn = (...values) => lines.push(values.join(' '))
  console.error = (...values) => lines.push(values.join(' '))
  try {
    return { result: await fn(), output: lines.join('\n') }
  } finally {
    Object.assign(console, original)
  }
}

/** Capture everything written to stdout (the gauge writes there directly). */
async function captureStdout(fn) {
  const originalWrite = process.stdout.write
  const chunks = []
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk))
    return true
  }
  try {
    return { result: await fn(), output: chunks.join('') }
  } finally {
    process.stdout.write = originalWrite
  }
}

/** Isolate HOME/XDG so no real user config is read or written. */
async function withIsolatedHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'pantheon-progress-home-'))
  const xdg = mkdtempSync(join(tmpdir(), 'pantheon-progress-xdg-'))
  const previous = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
  process.env.HOME = home
  process.env.XDG_CONFIG_HOME = xdg
  try {
    return await fn({ home, xdg })
  } finally {
    if (previous.HOME === undefined) delete process.env.HOME
    else process.env.HOME = previous.HOME
    if (previous.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = previous.XDG_CONFIG_HOME
  }
}

test('progress reports the elapsed time when it completes', () => {
  const originalNow = Date.now
  const originalTTY = process.stdout.isTTY
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  const originalLog = console.log
  const lines = []
  console.log = (...values) => lines.push(values.join(' '))
  try {
    const start = 1_000_000
    Date.now = () => start
    const done = step('Doing the thing')
    Date.now = () => start + 3_200
    done(true)
    const output = lines.join('\n')
    assert.match(output, /Doing the thing — complete in 3\.2s/, output)

    Date.now = () => start
    const failed = step('Failing the thing')
    Date.now = () => start + 500
    failed(false)
    assert.match(lines.join('\n'), /Failing the thing — failed in 0\.5s/)
  } finally {
    Date.now = originalNow
    console.log = originalLog
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: originalTTY,
    })
  }
})

test('an apply reports every phase through the gauge', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-progress-apply-'))
  try {
    await withIsolatedHome(async () => {
      // First run creates the config + state; the second one is the run that
      // also has migrations to consider.
      await captureStdout(() =>
        installOpenCode(target, false, false, ['agents', 'runtime'], {
          yes: true,
          headless: true,
          version: 'v1',
          quiet: true,
          deps: {
            setupVenv: () => {},
            healthCheck: () => ({ passed: [], warnings: [], failed: [] }),
          },
        }),
      )
      const { output } = await captureStdout(() =>
        installOpenCode(target, false, false, ['agents', 'runtime'], {
          yes: true,
          headless: true,
          version: 'v1',
          deps: {
            setupVenv: () => {},
            healthCheck: () => ({ passed: [], warnings: [], failed: [] }),
          },
        }),
      )
      const expected = planInstallPhases({
        components: new Set(['agents', 'runtime']),
        dryRun: false,
      })
      const lines = output.split('\n').filter((line) => /^\[\d+\/\d+\] /.test(line))
      assert.equal(
        lines.length,
        expected.length,
        `one gauge line per phase (expected ${expected.length}):\n${output}`,
      )
      for (const phase of [
        'Creating exact backup set',
        'Installing agents',
        'Installing runtime',
        'Setting up Python virtual environment',
        'Running health checks',
        'Writing configuration',
        'Running migrations',
        'Recording install state',
      ]) {
        assert.match(output, new RegExp(phase), `missing progress for: ${phase}\n${output}`)
      }
      assert.match(output, /^\[\d+\/9\] .+ — \d+\.\ds$/m, 'each phase reports its duration')
      assert.doesNotMatch(output, /complete in \d+\.\ds/, 'the old per-step format is gone')
      assert.doesNotMatch(output, /agents\/zeus\.md/, 'the gauge never prints per-file lines')
    })
  } finally {
    configure({ quiet: false, dryRun: false })
    rmSync(target, { recursive: true, force: true })
  }
})

test('the TUI dependency install is reported, not silent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-progress-tui-'))
  const bin = join(root, 'bin')
  mkdirSync(bin)
  const npm = join(bin, 'npm')
  writeFileSync(npm, '#!/bin/sh\nexit 0\n')
  chmodSync(npm, 0o755)
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}${delimiter}${previousPath}`
  try {
    const dst = join(root, 'plugin')
    const { output } = await captureAsyncConsole(async () =>
      installPlugin(join(ROOT, 'src', 'plugins', 'tui'), dst, { version: 'v1' }),
    )
    assert.match(output, /Installing TUI dependencies/, output)
    assert.match(output, /Installing TUI dependencies — complete in \d+\.\ds/, output)
  } finally {
    process.env.PATH = previousPath
    rmSync(root, { recursive: true, force: true })
  }
})

test('a dry-run venv setup never claims the venv was created', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-progress-venv-'))
  try {
    const { output } = await captureAsyncConsole(async () => {
      configure({ dryRun: true })
      setupVenv(target, { dryRun: true, skipInstall: true })
    })
    assert.match(output, /would be created/, output)
    assert.doesNotMatch(output, /\.venv created/, output)
    assert.doesNotMatch(output, /Creating \.venv/, output)
  } finally {
    configure({ dryRun: false })
    rmSync(target, { recursive: true, force: true })
  }
})

test('set-tier --dry-run uses the single [DRY-RUN] marker', () => {
  const child = spawnSync(process.execPath, [BIN, 'set-tier', 'none', '--dry-run'], {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', XDG_CONFIG_HOME: tmpdir() },
  })
  assert.equal(child.status, 0, child.stderr)
  assert.match(child.stdout, /\[DRY-RUN\] Would clear model preset/)
  assert.doesNotMatch(child.stdout, /\[dry-run\]/)
})

test('migrate --dry-run uses the single [DRY-RUN] marker', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-progress-migrate-'))
  try {
    const child = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'install', 'migrate.mjs'), '--target', target, '--dry-run'],
      { encoding: 'utf8', env: { ...process.env, LANG: 'C', LC_ALL: 'C' } },
    )
    assert.equal(child.status, 0, child.stderr)
    assert.match(child.stdout, /\[DRY-RUN\] Fresh install — would write state/)
    assert.doesNotMatch(child.stdout, /\[dry-run\]/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('init --doctor reports the health check result, duration and exit code', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-progress-doctor-'))
  try {
    const child = await withIsolatedHome(async ({ home, xdg }) =>
      spawnSync(
        process.execPath,
        [
          BIN,
          'init',
          '--yes',
          '--headless',
          '--components',
          'agents',
          '--doctor',
          '--version',
          'v1',
        ],
        {
          cwd: target,
          encoding: 'utf8',
          timeout: 300_000,
          env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, LANG: 'C', LC_ALL: 'C' },
        },
      ),
    )
    const output = `${child.stdout}\n${child.stderr}`
    assert.match(output, /Running health check\.\.\./)

    // The install ALWAYS reports completion and duration now. The exit code is
    // the child's, so a failing doctor fails the whole command instead of being
    // swallowed by an install that "succeeded".
    const finished = output.match(/Health check finished in (\d+\.\d)s/)
    assert.ok(finished, `the --doctor run must report its duration:\n${output}`)
    if (child.status === 0) {
      assert.match(output, /\(exit 0\)/)
    } else {
      assert.match(
        output,
        new RegExp(`reported problems \\(exit ${child.status}\\)`),
        `the doctor exit code must be propagated (child status ${child.status}):\n${output}`,
      )
    }
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Gauge: progress, not a log
// ---------------------------------------------------------------------------

test('gauge: a TTY rewrites ONE line per update and never prints per file', () => {
  const originalTTY = process.stdout.isTTY
  const originalColumns = process.stdout.columns
  const originalWrite = process.stdout.write
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 120 })
  const writes = []
  process.stdout.write = (chunk) => {
    writes.push(String(chunk))
    return true
  }
  try {
    const progress = gauge({ total: 3 })
    progress.advance(1, 'Installing agents')
    progress.advance(1, 'Installing skills')
    progress.advance(1, 'Installing TUI dependencies')
    progress.done()

    assert.equal(writes.length, 4, 'one write per update, plus the final line')
    for (const chunk of writes.slice(0, 3)) {
      assert.ok(chunk.startsWith('\r\u001b[2K'), 'each update rewrites the same line')
      assert.match(chunk, /\d+% \d+\/3\b/, 'the line reports percent and x/y')
      assert.equal(chunk.includes('\n'), false, 'an update never starts a new log line')
      assert.doesNotMatch(chunk, /agents\/zeus\.md/, 'no per-file output')
    }
    assert.ok(writes[3].startsWith('\r\u001b[2K\u2714 3/3 em '))
    assert.ok(writes[3].endsWith('s\n'), 'the final line ends the gauge line')
    assert.doesNotMatch(writes.join(''), /zeus\.md/)
  } finally {
    process.stdout.write = originalWrite
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalTTY })
    Object.defineProperty(process.stdout, 'columns', {
      configurable: true,
      value: originalColumns,
    })
  }
})

test('gauge: non-TTY prints exactly one line per phase, never per file', () => {
  const originalTTY = process.stdout.isTTY
  const originalWrite = process.stdout.write
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  const chunks = []
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk))
    return true
  }
  try {
    const progress = gauge({ total: 4 })
    progress.advance(1, 'Planning backup set')
    progress.advance(1, 'Installing agents')
    progress.advance(1, 'Installing skills')
    progress.advance(1, 'Writing configuration')
    progress.done()
    const lines = chunks.join('').split('\n').filter(Boolean)
    assert.equal(lines.length, 4, 'line count tracks phases, not files')
    for (const line of lines) {
      assert.match(line, /^\[\d+\/4\] .+ — \d+\.\ds$/)
      assert.doesNotMatch(line, /\.md\b/, 'no individual file paths')
    }
  } finally {
    process.stdout.write = originalWrite
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalTTY })
  }
})

test('gauge: quiet mode is completely silent', async () => {
  const originalTTY = process.stdout.isTTY
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true })
  configure({ quiet: true })
  try {
    const { output } = await captureStdout(() => {
      const progress = gauge({ total: 2 })
      progress.advance(1, 'Installing agents')
      progress.advance(1, 'Installing skills')
      progress.done()
      progress.fail('ignored')
    })
    assert.equal(output, '')
  } finally {
    configure({ quiet: false })
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalTTY })
  }
})

test('gauge: fail leaves a ✖ line naming the reason', () => {
  const originalTTY = process.stdout.isTTY
  const originalWrite = process.stdout.write
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false })
  const chunks = []
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk))
    return true
  }
  try {
    const progress = gauge({ total: 5 })
    progress.advance(1, 'Installing plugins')
    progress.fail('npm ci exited 1')
    const output = chunks.join('')
    assert.match(output, /✖ 1\/5 Installing plugins — npm ci exited 1/)
  } finally {
    process.stdout.write = originalWrite
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalTTY })
  }
})

// ---------------------------------------------------------------------------
// CLI surface: dry-run summary by default, per-file detail behind --verbose
// ---------------------------------------------------------------------------

function runInit(cwd, args) {
  const home = mkdtempSync(join(tmpdir(), 'pantheon-progress-cli-home-'))
  const xdg = mkdtempSync(join(tmpdir(), 'pantheon-progress-cli-xdg-'))
  try {
    return spawnSync(process.execPath, [BIN, 'init', ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, LANG: 'C', LC_ALL: 'C' },
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(xdg, { recursive: true, force: true })
  }
}

const DRY_ARGS = ['--project', '--dry-run', '--yes', '--headless', '--version', 'v1']

test('--dry-run default is a summary: no per-file paths, MCP list, nothing written', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-progress-dry-'))
  try {
    const result = runInit(target, [...DRY_ARGS, '--components', 'agents,runtime'])
    const output = `${result.stdout}\n${result.stderr}`
    assert.equal(result.status, 0, output)

    // One gauge line per executed phase, and NOT one per planned file.
    const phases = planInstallPhases({ components: new Set(['agents', 'runtime']), dryRun: true })
    const gaugeLines = result.stdout.split('\n').filter((line) => /^\[\d+\/\d+\] /.test(line))
    assert.equal(
      gaugeLines.length,
      phases.length,
      `expected ${phases.length} phase lines:\n${output}`,
    )

    // The summary replaces the per-file list.
    assert.match(output, /\d+ create · \d+ update · \d+ remove · \d+ conflict/)
    assert.match(output, /MCP servers \(5\): pantheon-resources, pantheon-code-mode/)
    assert.match(output, /No files were written\./)
    assert.match(output, /\[DRY-RUN\]/)
    assert.doesNotMatch(output, /agents\/zeus\.md/, 'no individual file paths by default')
    assert.doesNotMatch(output, /create\s+\.opencode\//, 'no per-file action lines')
    assert.doesNotMatch(output, /Installing agents — complete in/, 'no legacy step lines')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('--dry-run --verbose restores the per-file change list', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-progress-dry-verbose-'))
  try {
    const result = runInit(target, [...DRY_ARGS, '--components', 'agents,skills', '--verbose'])
    const output = `${result.stdout}\n${result.stderr}`
    assert.equal(result.status, 0, output)
    assert.match(output, /create\s+\.opencode\/agents\/zeus\.md/)
    assert.match(output, /create\s+\.opencode\/skills\//)
    assert.match(output, /No files were written\./)
    // Verbose shows per-step detail instead of drawing the gauge.
    assert.doesNotMatch(output, /^\[\d+\/\d+\] /m, 'the gauge stays out of --verbose output')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('--dry-run --json stays parseable and free of carriage returns', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-progress-json-'))
  try {
    const result = runInit(target, [...DRY_ARGS, '--components', 'agents', '--json'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.includes('\r'), false, 'no gauge bytes may reach JSON')
    const report = JSON.parse(result.stdout)
    assert.equal(report.command, 'init')
    assert.equal(report.mode, 'dry-run')
    assert.equal(report.status, 'planned')
    assert.ok(Array.isArray(report.files) && report.files.length > 0)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
