/**
 * install-progress-output.test.mjs — the installer must say what it is doing.
 *
 * Three long phases used to be completely silent (backup, config write /
 * migrations / state, TUI dependency install), `progress()` reported no
 * duration, and two of the three dry-run markers used a second spelling.
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
import { configure, step } from '../scripts/install/cli-ui.mjs'
import { installOpenCode } from '../scripts/install/opencode.mjs'
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

test('an apply reports the backup, config, migration and state phases', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-progress-apply-'))
  try {
    await withIsolatedHome(async () => {
      // First run creates the config + state; the second one is the run that
      // also has migrations to consider.
      await captureAsyncConsole(() =>
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
      const { output } = await captureAsyncConsole(() =>
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
      for (const phase of [
        'Creating exact backup set',
        'Writing opencode.json',
        'Running migrations',
        'Recording install state',
      ]) {
        assert.match(output, new RegExp(phase), `missing progress for: ${phase}\n${output}`)
      }
      assert.match(output, /complete in \d+\.\ds/, 'each phase reports its duration')
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
