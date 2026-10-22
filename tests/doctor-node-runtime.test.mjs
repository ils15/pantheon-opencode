import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { classifyNodePackageRuntime, classifyNodeSqliteProbe } from '../scripts/doctor.mjs'

const DOCTOR = fileURLToPath(new URL('../scripts/doctor.mjs', import.meta.url))

/**
 * Build a project whose opencode.json registers a V2 plugin pointing at a
 * fixture package with the given declared tool names. The fixture only needs
 * the surface file doctor reads — it is never imported or executed.
 *
 * `extraRefs` lets a test register additional (non-Pantheon) plugins alongside
 * the healthy one, which is the shape that produced the P0-3 false positive.
 */
function registeredToolFixture(names, extraRefs = []) {
  const root = mkdtempSync(join(tmpdir(), 'doctor-tool-registration-'))
  mkdirSync(join(root, 'src', 'pantheon'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'pantheon-opencode', version: '0.0.0' }),
  )
  writeFileSync(
    join(root, 'src', 'pantheon', 'v2-tools.ts'),
    `export function createV2ToolDefinitions() {\n  return [\n${names
      .map((name) => `    { name: '${name}' },`)
      .join('\n')}\n  ]\n}\n`,
  )
  const target = join(root, 'project')
  mkdirSync(target, { recursive: true })
  writeFileSync(
    join(target, 'opencode.json'),
    JSON.stringify({ plugins: [join(root, 'src', 'plugin-v2'), ...extraRefs] }),
  )
  return { root, target }
}

/** A plugin tree the Pantheon installer never wrote (its own package.json). */
function thirdPartyPluginFixture() {
  const root = mkdtempSync(join(tmpdir(), 'doctor-third-party-plugin-'))
  mkdirSync(join(root, 'dist'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'opencode-plugin-extra', version: '1.0.0' }),
  )
  writeFileSync(join(root, 'dist', 'index.js'), 'export const plugin = async () => ({})\n')
  return root
}

/**
 * The 1.5.0 layout: the V2 entry itself (`<root>/src/plugin-v2.ts`) declares
 * the tools in a `toolNames` array, and there is no `src/pantheon/v2-tools.ts`.
 */
function pluginV2SurfaceFixture(names) {
  const root = mkdtempSync(join(tmpdir(), 'doctor-tool-surface-15-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'pantheon-opencode', version: '1.5.0' }),
  )
  writeFileSync(
    join(root, 'src', 'plugin-v2.ts'),
    `export function define() {}\n\nfunction createV2ToolDefinitionsFromContext() {\n  const toolNames = [\n${names
      .map((name) => `    '${name}',`)
      .join('\n')}\n  ]\n  return toolNames.map((name) => ({ name }))\n}\n`,
  )
  const target = join(root, 'project')
  mkdirSync(target, { recursive: true })
  writeFileSync(
    join(target, 'opencode.json'),
    JSON.stringify({ plugins: [join(root, 'src', 'plugin-v2.ts')] }),
  )
  return { root, target }
}

/** A project registering the package by npm spec instead of by path. */
function packageSpecFixture(spec) {
  const root = mkdtempSync(join(tmpdir(), 'doctor-tool-spec-'))
  const target = join(root, 'project')
  mkdirSync(target, { recursive: true })
  writeFileSync(join(target, 'opencode.json'), JSON.stringify({ plugins: [spec] }))
  return { root, target }
}

/** Run doctor against a fixture, keeping the exit code next to the report. */
function runDoctor(target) {
  const run = spawnSync(
    process.execPath,
    [DOCTOR, '--json', '--target', target, '--profile', 'global'],
    {
      encoding: 'utf8',
      // Isolate the user-config lookup; PANTHEON_HOME wins over HOME.
      env: { ...process.env, PANTHEON_HOME: target },
    },
  )
  assert.ok(run.stdout, run.stderr)
  return { exitCode: run.status, report: JSON.parse(run.stdout) }
}

test('doctor distinguishes the package floor from the node:sqlite capability threshold', () => {
  const unsupportedPackage = classifyNodePackageRuntime('26.3.99')
  assert.equal(unsupportedPackage.status, 'unsupported')
  assert.match(unsupportedPackage.message, /requires Node\.js >= 26\.4\.0/)

  const sqliteCapability = classifyNodeSqliteProbe({ available: false, version: 'v22.4.0' })
  assert.equal(sqliteCapability.status, 'unsupported')
  assert.match(sqliteCapability.message, /node:sqlite requires Node >= 22\.5/)
  assert.doesNotMatch(sqliteCapability.message, /Pantheon requires Node/)
})

test('doctor reports separate Node policy and SQLite capability findings in text and JSON', () => {
  const target = mkdtempSync(join(tmpdir(), 'doctor-node-runtime-'))
  try {
    const json = spawnSync(
      process.execPath,
      [DOCTOR, '--json', '--target', target, '--profile', 'lite'],
      { encoding: 'utf8' },
    )
    assert.ok(json.stdout, json.stderr)
    const report = JSON.parse(json.stdout)
    const packageFinding = report.findings.find(({ code }) => code === 'node_version_supported')
    const sqliteFinding = report.findings.find(({ code }) => code === 'node_sqlite_supported')
    assert.equal(packageFinding?.classification, 'runtime')
    assert.equal(sqliteFinding?.classification, 'capability')

    const text = spawnSync(
      process.execPath,
      [DOCTOR, '--target', target, '--profile', 'lite', '--verbose'],
      { encoding: 'utf8' },
    )
    assert.match(text.stdout, /meets Pantheon's package requirement \(>= 26\.4\.0\)/)
    assert.match(text.stdout, /node:sqlite available/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('an available node:sqlite backend does not turn an unregistered tool into PASS', () => {
  // The backend works in this runtime, so an absent registration is the ONLY
  // failing fact — exactly the false green P0-3 describes.
  const absent = registeredToolFixture(['hashline_edit', 'pantheon_model'])
  const present = registeredToolFixture(['hashline_edit', 'pantheon_cost', 'pantheon_model'])
  try {
    const missingRun = runDoctor(absent.target)
    assert.equal(
      missingRun.report.findings.find(({ code }) => code === 'node_sqlite_supported')?.category,
      'pass',
      'backend capability passes, so the failure below is attributable to registration alone',
    )
    const missing = missingRun.report.findings.find(
      ({ code }) => code === 'tool_registration_missing',
    )
    assert.equal(
      missing?.category,
      'error',
      'an unregistered pantheon_cost is a blocking error, not a warning or a pass',
    )
    // The finding must actually reach the report verdict and the exit code: a
    // blocking error that leaves status/exit untouched is the P0-3 false green.
    assert.equal(
      missingRun.report.status,
      'error',
      'a missing registration fails the report status',
    )
    assert.equal(missingRun.exitCode, 2, 'a missing registration makes doctor exit non-zero')

    const registeredRun = runDoctor(present.target)
    assert.equal(
      registeredRun.report.findings.find(({ code }) => code === 'tool_registration_present')
        ?.category,
      'pass',
      'backend + registration present is the healthy case',
    )
    assert.equal(
      registeredRun.report.findings.some(({ code }) => code === 'tool_registration_missing'),
      false,
      'a registered pantheon_cost is not reported missing',
    )
  } finally {
    rmSync(absent.root, { recursive: true, force: true })
    rmSync(present.root, { recursive: true, force: true })
  }
})

test('a third-party plugin registration is never a failing Pantheon tool surface', () => {
  // P0-3 false positive: the registration check iterated EVERY ref under
  // `plugins`, and any directory with a package.json counted as a V2 surface.
  // A third-party plugin therefore looked like a Pantheon tree whose
  // `src/pantheon/v2-tools.ts` was missing, blocking a healthy installation.
  const thirdParty = thirdPartyPluginFixture()
  const healthy = registeredToolFixture(['hashline_edit', 'pantheon_cost', 'pantheon_model'])
  const withThirdParty = registeredToolFixture(
    ['hashline_edit', 'pantheon_cost', 'pantheon_model'],
    [thirdParty],
  )
  try {
    const control = runDoctor(healthy.target)
    const subject = runDoctor(withThirdParty.target)

    assert.equal(
      subject.report.findings.find(({ code }) => code === 'tool_registration_present')?.category,
      'pass',
      'the Pantheon registration still passes with a third-party plugin alongside it',
    )
    assert.equal(
      subject.report.findings.some(
        ({ code }) =>
          code === 'tool_registration_missing' || code === 'tool_registration_pantheon_missing',
      ),
      false,
      'a third-party ref is not this check\u2019s subject, so it must never be reported missing',
    )
    assert.equal(
      subject.exitCode,
      control.exitCode,
      'adding a third-party plugin must not change the exit code',
    )
    assert.equal(
      subject.report.status,
      control.report.status,
      'adding a third-party plugin must not change the report status',
    )
    assert.doesNotMatch(
      subject.report.findings.map(({ message }) => message).join('\n'),
      /third-party-plugin-[^/]+\/src\/pantheon/,
      'the third-party tree is never inspected as a Pantheon surface',
    )
  } finally {
    rmSync(thirdParty, { recursive: true, force: true })
    rmSync(healthy.root, { recursive: true, force: true })
    rmSync(withThirdParty.root, { recursive: true, force: true })
  }
})

test('the 1.5.0 V2 entry counts as the registered tool surface', () => {
  // 1.5.0 ships `src/plugin-v2.ts` as the V2 surface; `src/pantheon/v2-tools.ts`
  // only exists from beta.3 of the following line. Reading just the latter made
  // a healthy 1.5 tree report a blocking "pantheon_cost is NOT declared".
  const fixture = pluginV2SurfaceFixture(['hashline_edit', 'pantheon_cost', 'pantheon_model'])
  try {
    const { report } = runDoctor(fixture.target)
    const finding = report.findings.find(({ code }) => code === 'tool_registration_present')
    assert.equal(finding?.category, 'pass', 'the 1.5.0 entry declares pantheon_cost')
    assert.match(finding?.message ?? '', /plugin-v2\.ts/, 'the finding names the inspected surface')
    assert.equal(
      report.findings.some(({ code }) => code === 'tool_registration_missing'),
      false,
      'a tool declared by the 1.5.0 surface is never reported missing',
    )
    assert.doesNotMatch(
      report.findings.map(({ message }) => message).join('\n'),
      /is NOT declared/,
      'no false "is NOT declared" message on a healthy 1.5 tree',
    )
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('an npm spec registration is reported as unverifiable, never as a registration pass', () => {
  // The host resolves `pantheon-opencode` through its own module graph. The
  // running package (the tree this doctor ships in) is NOT necessarily that
  // package, so validating the spec against it could claim a registration the
  // host never loads.
  const fixture = packageSpecFixture('pantheon-opencode')
  try {
    const { report } = runDoctor(fixture.target)
    assert.equal(
      report.findings.some(({ code }) => code === 'tool_registration_present'),
      false,
      'a spec is not a verified registration and must not PASS',
    )
    assert.equal(
      report.findings.some(
        ({ code, category }) =>
          category === 'error' &&
          (code === 'tool_registration_missing' || code === 'tool_registration_pantheon_missing'),
      ),
      false,
      'an unverifiable spec is not a blocking error either',
    )
    const finding = report.findings.find(({ code }) => code === 'tool_registration_unverifiable')
    assert.equal(finding?.category, 'info', 'the spec produces an explicit informative finding')
    assert.match(
      finding?.message ?? '',
      /npm specifier/,
      'the finding says why it cannot be verified',
    )
  } finally {
    rmSync(fixture.root, { recursive: true, force: true })
  }
})
