/**
 * doctor-section-summary.test.mjs — every doctor section accounts for itself.
 *
 * Passing checks are suppressed unless --verbose, which used to leave whole
 * sections printing a header and nothing else: indistinguishable from a check
 * that never ran. Each section must at least report how many checks passed.
 *
 * Target: these assertions describe doctor's OUTPUT, so they run against a
 * repository this test provisions (a tracked-file copy of this checkout,
 * committed in a throwaway repo) instead of the ambient one. Two ambient facts
 * are legitimate and used to turn this file red for the wrong reason:
 * `npm ci --ignore-scripts` in CI never runs `prepare`, so that clone has no
 * hooks; and a developer running two sessions can have two worktrees on one
 * branch, which the shared-checkout guardrail must fail. `--profile lite` is
 * the policy doctor already applies to a checkout (a project is not a managed
 * install), stated explicitly because auto-detection grants it only when
 * `--target` IS the checkout doctor runs from. The ambient run survives as a
 * diagnostic that reports state and cannot fail.
 *
 * Hermeticity: doctor also inspects the *effective user config* it resolves from
 * HOME (H3 plugin drift, B MCP). Inheriting the developer's HOME made this
 * section-accounting test fail on any machine whose global install had real
 * drift — a registration left pointing at a pruned npx path exits 2 — which is
 * machine state, not the repo target this test asserts. The run therefore uses
 * an empty user config, while PANTHEON_PYTHON pins the interpreter doctor would
 * otherwise have resolved so the pinned-dependency check still validates the
 * same runtime.
 *
 * Run: node --test tests/doctor-section-summary.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { resolveRuntimePython } from '../scripts/doctor.mjs'
import { provisionCheckout } from './helpers/provisioned-checkout.mjs'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Empty user-config root: no user plugin registration, no user MCP registry. */
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'pantheon-doctor-summary-'))
/** The interpreter doctor resolves without isolation, so check F is unchanged. */
const RUNTIME_PYTHON = resolveRuntimePython({ target: REPO_ROOT, env: process.env })
/** The repository under test: same tracked content, nobody else's session in it. */
const PROVISIONED = provisionCheckout(REPO_ROOT)

after(() => {
  PROVISIONED.cleanup()
  rmSync(ISOLATED_HOME, { recursive: true, force: true })
})

function doctorArgs(extraArgs, ambient) {
  if (ambient) return [join(REPO_ROOT, 'scripts', 'doctor.mjs'), ...extraArgs]
  return [
    join(REPO_ROOT, 'scripts', 'doctor.mjs'),
    '--profile',
    'lite',
    '--target',
    PROVISIONED.root,
    ...extraArgs,
  ]
}

function runDoctor(extraArgs = [], { ambient = false } = {}) {
  return spawnSync(process.execPath, doctorArgs(extraArgs, ambient), {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      LANG: 'C',
      LC_ALL: 'C',
      PANTHEON_HOME: ISOLATED_HOME,
      PANTHEON_PYTHON: RUNTIME_PYTHON,
    },
    timeout: 300_000,
  })
}

/** Split doctor output into `{title, body}` per section banner. */
function sections(stdout) {
  return stdout.split(/^={60}$/m).reduce((acc, chunk, index, all) => {
    if (index % 2 === 1) {
      const title = chunk.trim()
      const body = (all[index + 1] ?? '').split(/^={60}$/m)[0]
      acc.push({ title, body })
    }
    return acc
  }, [])
}

test('without --verbose every section reports how many checks passed', () => {
  const child = runDoctor()
  // Meaningful, not ambient: the provisioned checkout is clean, single-worktree,
  // hook-reachable and has no active locks, so a blocking finding would be a
  // real doctor regression.
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)

  const all = sections(child.stdout)
  const agentSection = all.find((section) => section.title.startsWith('A. Agent Files'))
  assert.ok(agentSection, 'the Agent Files section must be present')
  assert.match(agentSection.body, /\d+ checks? passed/, agentSection.body)

  const tally = child.stdout.match(/\d+ check(s)? passed/g) ?? []
  assert.ok(tally.length >= 2, `at least two sections report a tally, got ${tally.length}`)
})

test('--verbose still lists the individual passing checks', () => {
  const child = runDoctor(['--verbose'])
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`)
  const agentSection = sections(child.stdout).find((section) =>
    section.title.startsWith('A. Agent Files'),
  )
  assert.ok(agentSection, 'the Agent Files section must be present')
  assert.match(agentSection.body, /\u2705 8 canonical agents found/i, agentSection.body)
  assert.doesNotMatch(
    agentSection.body,
    /\d+ checks? passed/,
    'the tally exists only where individual lines are suppressed',
  )
})

test('the ambient checkout is reported as a diagnostic, never asserted', (t) => {
  // Deliberately non-failing. This checkout may legitimately carry no hooks (CI
  // installs with `npm ci --ignore-scripts`) or two worktrees on one branch (a
  // developer running two sessions), and both are states the guardrails are
  // SUPPOSED to report. Only the report's shape is asserted here; the exit-code
  // contract lives on the provisioned target above.
  const child = runDoctor(['--json'], { ambient: true })
  const report = JSON.parse(child.stdout)
  const blocking = report.findings
    .filter((item) => item.category === 'error')
    .map((item) => item.code ?? item.check ?? 'unnamed')
  t.diagnostic(
    `ambient doctor: status=${report.status} exit=${child.status} ` +
      `blocking=${blocking.length > 0 ? blocking.join(', ') : 'none'}`,
  )
  assert.equal(typeof report.schema_version, 'number', 'doctor --json must be a versioned report')
  assert.ok(Array.isArray(report.findings) && report.findings.length > 0)
})
