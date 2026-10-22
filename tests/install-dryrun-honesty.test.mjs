/**
 * install-dryrun-honesty.test.mjs — the preview must not contradict the apply.
 *
 * Three defects this locks down:
 *  1. `healthCheck(dryRun)` returned AFTER the existence probes, so a preview
 *     reported "NOT FOUND" for files that the apply is about to create — a
 *     statement about a state that does not exist yet.
 *  2. Those failures flipped `runtimeHealthy=false` in the PLAN pass, which
 *     skipped `applyMcpServerEntries`, so the plan omitted the MCP entries the
 *     real apply writes. Plan and apply disagreed.
 *  3. `doctor` previews the installer with `quiet: true`; `success()`,
 *     `warning()` and `error()` ignored `_quiet`, so internal preview noise
 *     (`[DRY-RUN] …`) leaked into the doctor's own report.
 *
 * Run: node --test tests/install-dryrun-honesty.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { bullet, configure, error, info, success, warning } from '../scripts/install/cli-ui.mjs'
import { healthCheck } from '../scripts/install/health-check.mjs'
import { installOpenCode } from '../scripts/install/opencode.mjs'
import { ROOT } from '../scripts/install/shared.mjs'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Run `fn` with console.log/warn/error captured instead of printed. */
function captureConsole(fn) {
  const original = { log: console.log, warn: console.warn, error: console.error }
  const lines = []
  console.log = (...values) => lines.push(values.join(' '))
  console.warn = (...values) => lines.push(values.join(' '))
  console.error = (...values) => lines.push(values.join(' '))
  try {
    return { result: fn(), output: lines.join('\n') }
  } finally {
    Object.assign(console, original)
  }
}

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

// ---------------------------------------------------------------------------
// 1. A dry run observes nothing, because nothing has been installed yet
// ---------------------------------------------------------------------------

test('healthCheck in dry-run mode inspects nothing and reports no failure', () => {
  // A target that does not exist is exactly the POST-install target of a fresh
  // preview: probing it says "NOT FOUND" about a directory the apply creates.
  const target = join(tmpdir(), 'pantheon-health-dryrun-does-not-exist')
  assert.deepEqual(healthCheck(target, { dryRun: true }), {
    passed: [],
    failed: [],
    warnings: [],
  })
})

// ---------------------------------------------------------------------------
// 2. The vision server is resolved against the PACKAGE root, not the target
// ---------------------------------------------------------------------------

test('vision server is resolved at the package root, not the install target', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-health-vision-'))
  try {
    // The target has no src/mcp (nothing is installed into it): the canonical
    // source lives in THIS package and is what the installer copies from.
    const results = healthCheck(target, { dryRun: false, pythonTarget: target })

    assert.equal(
      results.failed.some(({ check }) => check === 'src/mcp/pantheon_vision.py'),
      false,
    )
    const vision = results.passed.find(({ check }) => check === 'src/mcp/pantheon_vision.py')
    assert.ok(vision, `vision source must resolve at the package root: ${JSON.stringify(results)}`)
    assert.ok(existsSync(join(ROOT, 'src', 'mcp', 'pantheon_vision.py')))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('vision source drift is detected against the package copy', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-health-drift-'))
  try {
    mkdirSync(join(target, 'scripts'), { recursive: true })
    writeFileSync(
      join(target, 'scripts', 'pantheon_vision.py'),
      'def tool():\n    return "drifted"\n',
    )
    const results = healthCheck(target, { dryRun: false, pythonTarget: target })
    const drift = results.failed.find(({ check }) => check === 'pantheon-vision source drift')
    assert.ok(drift, 'a stale installed vision copy must fail the drift check')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. quiet mode is actually quiet (the doctor preview depends on it)
// ---------------------------------------------------------------------------

test('cli-ui markers are suppressed while quiet is configured', () => {
  configure({ quiet: true, dryRun: true })
  try {
    const { output } = captureConsole(() => {
      success('success line')
      warning('warning line')
      error('error line')
      info('info line')
      bullet('bullet line')
    })
    assert.equal(output, '', `quiet mode must print nothing, got:\n${output}`)
  } finally {
    configure({ quiet: false, dryRun: false })
  }
})

test('a quiet dry-run install preview prints no NOT FOUND and no dry-run noise', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-quiet-preview-'))
  try {
    configure({ quiet: true, dryRun: true })
    const captured = await captureAsyncConsole(() =>
      installOpenCode(target, true, false, ['agents', 'runtime'], {
        yes: true,
        headless: true,
        version: 'v1',
        quiet: true,
        quietPlan: true,
      }),
    )
    assert.equal(
      captured.output,
      '',
      `a quiet preview must print nothing, got:\n${captured.output}`,
    )
  } finally {
    configure({ quiet: false, dryRun: false })
    rmSync(target, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. The doctor preview does not leak installer output into its own report
// ---------------------------------------------------------------------------

test('doctor --json keeps its JSON intact and leaks no dry-run preview lines', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-doctor-quiet-'))
  try {
    // A real install gives doctor an install state, which is what makes it
    // preview the installer (checkInstallerFileInventory) at all.
    await installOpenCode(target, false, false, ['agents'], {
      yes: true,
      headless: true,
      version: 'v1',
      quiet: true,
    })

    const child = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'doctor.mjs'), '--json', '--target', target],
      { encoding: 'utf8', env: { ...process.env, LANG: 'C', LC_ALL: 'C' } },
    )

    assert.doesNotMatch(child.stderr, /\[DRY-RUN\]/, child.stderr)
    assert.doesNotMatch(
      child.stderr,
      /Dry-run skipped the OpenCode host version probe/,
      'the installer preview must be silent inside doctor',
    )
    assert.doesNotMatch(child.stdout, /\[DRY-RUN\]/, child.stdout)
    const report = JSON.parse(child.stdout)
    assert.equal(report.command, 'doctor')
    assert.equal(report.target, target)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. Plan and apply agree on the MCP entries
// ---------------------------------------------------------------------------

test('the previewed plan contains the same MCP entries the apply writes', async () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-plan-mcp-'))
  try {
    const plan = await installOpenCode(target, true, false, ['runtime'], {
      yes: true,
      headless: true,
      version: 'v1',
      quiet: true,
      quietPlan: true,
    })
    const configPath = join(target, 'opencode.json')
    const planned = plan.files.find((file) => file.path === configPath)
    assert.ok(planned, 'the plan must include opencode.json')

    await installOpenCode(target, false, false, ['runtime'], {
      yes: true,
      headless: true,
      version: 'v1',
      quiet: true,
      // Seams: no real venv/network in a unit test. The health check passes,
      // which is the state the preview promises.
      deps: {
        setupVenv: () => {},
        healthCheck: () => ({ passed: [], warnings: [], failed: [] }),
      },
    })

    const applied = readFileSync(configPath, 'utf8')
    const config = JSON.parse(applied)
    assert.equal(
      Object.keys(config.mcp ?? {}).length,
      5,
      `the apply must write the five MCP servers: ${JSON.stringify(config.mcp)}`,
    )
    assert.equal(
      planned.bytes,
      Buffer.byteLength(applied, 'utf8'),
      'the planned opencode.json must be byte-identical to the applied one — the preview ' +
        'omitted the MCP entries the apply writes',
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
