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
 */
function registeredToolFixture(names) {
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
    JSON.stringify({ plugins: [join(root, 'src', 'plugin-v2')] }),
  )
  return { root, target }
}

function runDoctorJson(target) {
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
  return JSON.parse(run.stdout)
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
    const missingReport = runDoctorJson(absent.target)
    assert.equal(
      missingReport.findings.find(({ code }) => code === 'node_sqlite_supported')?.category,
      'pass',
      'backend capability passes, so the failure below is attributable to registration alone',
    )
    const missing = missingReport.findings.find(({ code }) => code === 'tool_registration_missing')
    assert.equal(
      missing?.category,
      'error',
      'an unregistered pantheon_cost is a blocking error, not a warning or a pass',
    )

    const registeredReport = runDoctorJson(present.target)
    assert.equal(
      registeredReport.findings.find(({ code }) => code === 'tool_registration_present')?.category,
      'pass',
      'backend + registration present is the healthy case',
    )
    assert.equal(
      registeredReport.findings.some(({ code }) => code === 'tool_registration_missing'),
      false,
      'a registered pantheon_cost is not reported missing',
    )
  } finally {
    rmSync(absent.root, { recursive: true, force: true })
    rmSync(present.root, { recursive: true, force: true })
  }
})
