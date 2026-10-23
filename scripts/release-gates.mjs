#!/usr/bin/env node
/**
 * release-gates.mjs — the six release gates, fail-closed.
 *
 * ADR-0014 requires every applicable gate to end in an explicit `PASS` on the
 * frozen candidate. This script turns each gate into a binary result and one
 * named evidence file:
 *
 *   tests      Python/Node/TypeScript suites, the mandatory heavy install tier,
 *              and the required coverage thresholds.
 *   host       The measured OpenCode host evidence, installed and exercised in
 *              an isolated sandbox. Support is family-level: a measured row
 *              must PASS, an unmeasured supported family is reported as such,
 *              and a known-broken host is a failure.
 *   install    The one immutable .tgz installed as a real user, initialized
 *              headlessly, driven through a live host, and compared file-by-file
 *              against the checkout.
 *   package    The same .tgz re-hashed and inspected. No second `npm pack`.
 *   changelog  The committed `[version]` section exists and is non-empty.
 *   metadata   Version manifests and the Node engine policy agree.
 *
 * Usage:
 *   node scripts/release-gates.mjs <gate> --evidence-dir <dir> [options]
 *
 * Options:
 *   --artifact-dir <dir>  Directory holding the single .tgz + metadata.json
 *                         (required by host/install/package).
 *   --version <x.y.z>     Candidate version (default: package.json version).
 *   --target-sha <sha>    Full 40-hex candidate SHA (default: TARGET_SHA).
 *   --channel stable|beta Release channel (default: RELEASE_CHANNEL|stable).
 *   --recovery            Recovery dispatch: changelog is the static note.
 *
 * Host evidence: PANTHEON_RELEASE_MATRIX overrides the built-in JSON array. The
 * override is still validated: rows must name a supported family and may not
 * name a known-broken host. A supported family with no row is reported as
 * "supported, unmeasured", not treated as a failure. A measured row that cannot
 * run is a FAIL — this script has no SKIP path on purpose.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  accessSync,
  existsSync,
  constants as fsConstants,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const GATE_NAMES = ['tests', 'host', 'install', 'package', 'changelog', 'metadata']

/** Support is family-level: these are the families this release supports. */
export const SUPPORTED_FAMILIES = Object.freeze(['1.19.x', '2.x'])

/** Known-broken hosts. Every other member of a supported family is supported. */
export const KNOWN_BROKEN_HOSTS = Object.freeze(['2.0.22'])
const UNSUPPORTED_HOSTS = new Set(KNOWN_BROKEN_HOSTS)

/**
 * The measured hosts at the time of freezing. Rows are evidence, not the
 * boundary of support: `PANTHEON_RELEASE_MATRIX` overrides them when a release
 * needs to exercise a different host.
 */
const DEFAULT_MATRIX = [
  { host: '1.19.4', line: '1.19.x', kind: 'v1-permission' },
  { host: '2.0.29', line: '2.x', kind: 'sandbox-v2' },
  { host: '2.0.30', line: '2.x', kind: 'sandbox-v2' },
  { host: '2.1.0', line: '2.x', kind: 'sandbox-v2' },
  { host: '2.1.3', line: '2.x', kind: 'sandbox-v2' },
]

const REQUIRED_TARBALL_PAYLOAD = [
  'package/package.json',
  'package/plugin.json',
  'package/pyproject.toml',
  'package/src/plugin.ts',
  'package/src/plugin-v2.ts',
  'package/src/plugins/tui/dist/tui.js',
  'package/src/plugins/tui/package.json',
  'package/src/plugins/tui/package-lock.json',
  'package/bin/pantheon-init.mjs',
  'package/scripts/doctor.mjs',
  'package/.pantheon/code-mode/compress-inline.py',
]

function usage(message) {
  console.error(`release-gates: ${message}`)
  console.error(
    'usage: node scripts/release-gates.mjs <gate> --evidence-dir <dir> [--artifact-dir <dir>] [--version <v>] [--target-sha <sha>] [--channel stable|beta] [--recovery]',
  )
  process.exit(2)
}

function parseArgs(argv) {
  const options = {
    evidenceDir: undefined,
    artifactDir: undefined,
    version: undefined,
    targetSha: process.env.TARGET_SHA,
    channel: process.env.RELEASE_CHANNEL ?? 'stable',
    recovery: false,
  }
  const positional = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--recovery') {
      options.recovery = true
      continue
    }
    if (
      ['--evidence-dir', '--artifact-dir', '--version', '--target-sha', '--channel'].includes(arg)
    ) {
      const value = argv[i + 1]
      if (value === undefined) usage(`${arg} requires a value`)
      const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
      options[key] = value
      i += 1
      continue
    }
    if (arg.startsWith('-')) usage(`unknown option ${arg}`)
    positional.push(arg)
  }
  if (positional.length !== 1) usage('exactly one gate name is required')
  options.gate = positional[0]
  if (!GATE_NAMES.includes(options.gate)) {
    usage(`unknown gate ${options.gate} (expected: ${GATE_NAMES.join(', ')})`)
  }
  options.evidenceDir = resolve(options.evidenceDir ?? join(runnerTemp(), 'release-gate-evidence'))
  if (options.artifactDir) options.artifactDir = resolve(options.artifactDir)
  if (options.targetSha) options.targetSha = String(options.targetSha).toLowerCase()
  options.version = options.version ?? readPackageVersion()
  return options
}

function readPackageVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
}

function runnerTemp() {
  return process.env.RUNNER_TEMP ?? tmpdir()
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function tail(text, limit = 4000) {
  const value = String(text ?? '')
  return value.length > limit ? value.slice(-limit) : value
}

/**
 * Run one command and fail on any non-zero exit. Output is echoed so the CI log
 * keeps the real failure; `echo: false` is for probes whose stdout is data.
 */
function run(name, command, args = [], options = {}) {
  const started = Date.now()
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
  })
  const durationMs = Date.now() - started
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  if (options.echo !== false && output) process.stdout.write(output)
  if (result.error) {
    throw new Error(`${name}: could not start ${command}: ${result.error.message}`)
  }
  if (result.signal) throw new Error(`${name}: ${command} was killed by ${result.signal}`)
  if (result.status !== 0) {
    throw new Error(`${name}: ${command} exited ${result.status}\n${tail(output)}`)
  }
  return {
    name,
    status: 'PASS',
    command: [command, ...args].join(' '),
    durationMs,
    output,
  }
}

function requireArtifactDir(options) {
  if (!options.artifactDir) throw new Error('--artifact-dir is required for this gate')
  if (!existsSync(options.artifactDir)) {
    throw new Error(`artifact directory does not exist: ${options.artifactDir}`)
  }
}

function singleTarball(options) {
  requireArtifactDir(options)
  const tarballs = readdirSync(options.artifactDir).filter((name) => name.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`artifact directory must hold exactly one .tgz, found ${tarballs.length}`)
  }
  const tarball = join(options.artifactDir, tarballs[0])
  if (!statSync(tarball).isFile()) throw new Error(`not a file: ${tarball}`)
  return tarball
}

function sandboxEnv(root, host, tarball, port) {
  return {
    PANTHEON_SANDBOX_ROOT: root,
    PANTHEON_SANDBOX_TARBALL: tarball,
    OPENCODE_V2_SPEC: `@opencode/cli@${host}`,
    OPENCODE_V2_BIN: 'opencode',
    PANTHEON_V2_PORT: String(port),
    PORT: String(port),
  }
}

function safeName(value) {
  return String(value).replace(/[^0-9A-Za-z.-]/g, '-')
}

function installedVersion(root) {
  const manifest = join(
    root,
    'home',
    '.npm-global',
    'lib',
    'node_modules',
    'pantheon-opencode',
    'package.json',
  )
  if (!existsSync(manifest)) throw new Error(`installed package manifest is missing: ${manifest}`)
  return JSON.parse(readFileSync(manifest, 'utf8')).version
}

function assertCandidateSha(options) {
  const sha = String(options.targetSha ?? '').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error('--target-sha must be the full 40-character hexadecimal candidate SHA')
  }
  return sha
}

// ── Gate (a): tests ──────────────────────────────────────────────────────────

/**
 * The Python interpreter used by gate (a).
 *
 * The suite imports `fastmcp`/`mcp` at collection time, so it only means
 * anything when run against the exact pins in `src/mcp/requirements-mcp.txt`.
 * `PANTHEON_PYTHON` (the same variable `scripts/doctor.mjs` honours) points at
 * the isolated venv prepared from those pins. When it is set, a missing or
 * non-executable path is a hard failure: falling back to the ambient `python3`
 * is what produced environment-only collection errors instead of a real
 * verdict. Only an unset variable keeps the developer default.
 */
function gatePython() {
  const configured = String(process.env.PANTHEON_PYTHON ?? '').trim()
  if (!configured) return 'python3'
  const resolved = resolve(configured)
  if (!existsSync(resolved)) {
    throw new Error(`PANTHEON_PYTHON does not exist: ${resolved}`)
  }
  try {
    accessSync(resolved, fsConstants.X_OK)
  } catch {
    throw new Error(`PANTHEON_PYTHON is not executable: ${resolved}`)
  }
  return resolved
}

function testsGate() {
  const python = gatePython()
  const pythonVersion = run('python-version', python, ['--version'], { echo: false }).output.trim()
  const checks = [
    run('python-tests-coverage', python, [
      '-m',
      'coverage',
      'run',
      '--branch',
      '--source=src/mcp',
      '-m',
      'pytest',
      '-q',
      '--tb=short',
    ]),
    run('python-coverage-threshold', python, ['-m', 'coverage', 'report', '--fail-under=80']),
    run('node-tests', 'npm', ['run', 'test:node']),
    run('typescript-tests', 'npm', ['run', 'test:ts']),
    run('plugin-v2-line-coverage', 'npm', ['run', 'coverage:plugin-v2']),
    // Mandatory here and optional in the developer loop: the release gate may
    // not publish without the real-install tier.
    run('install-tier', 'npm', ['run', 'test:install'], {
      env: { PANTHEON_RUN_INSTALL_TESTS: '1' },
    }),
  ]
  return {
    checks,
    details: {
      pythonInterpreter: python,
      pythonVersion,
      pinnedRequirements: ['src/mcp/requirements-mcp.txt', 'src/mcp/requirements-vision.txt'],
      requiredCoverage: [
        'python: src/mcp branch coverage >= 80% (coverage report --fail-under=80)',
        'typescript: src/plugin-v2.ts line coverage (coverage:plugin-v2)',
      ],
      notPass: [
        'Node coverage (`npm run coverage`) is report-only and is NOT a PASS signal.',
        'TypeScript under src/ outside the plugin-v2 measurement is unmeasured, NOT PASS.',
      ],
    },
  }
}

// ── Gate (b): host compatibility ─────────────────────────────────────────────

function matrixFromEnv() {
  const raw = process.env.PANTHEON_RELEASE_MATRIX
  if (!raw) return DEFAULT_MATRIX
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`PANTHEON_RELEASE_MATRIX is not valid JSON: ${error.message}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error('PANTHEON_RELEASE_MATRIX must be a JSON array')
  }
  return parsed
}

export function validateMatrix(matrix) {
  if (!Array.isArray(matrix)) throw new Error('host evidence must be an array')
  for (const row of matrix) {
    if (!row || typeof row !== 'object') throw new Error('matrix rows must be objects')
    if (!/^\d+\.\d+\.\d+$/.test(String(row.host ?? ''))) {
      throw new Error(`matrix row has an invalid host: ${JSON.stringify(row.host)}`)
    }
    if (UNSUPPORTED_HOSTS.has(row.host)) {
      throw new Error(`host ${row.host} is known broken and may not be measured as supported`)
    }
    if (!SUPPORTED_FAMILIES.includes(row.line)) {
      throw new Error(
        `matrix row ${row.host} has an undeclared family: ${JSON.stringify(row.line)}`,
      )
    }
    if (row.line === '1.19.x' && !row.host.startsWith('1.19.')) {
      throw new Error(`host ${row.host} does not belong to the 1.19.x family`)
    }
    if (row.line === '2.x' && !row.host.startsWith('2.')) {
      throw new Error(`host ${row.host} does not belong to the 2.x family`)
    }
    if (row.line === '1.19.x' && row.kind !== 'v1-permission') {
      throw new Error(`kind ${row.kind} cannot run on the 1.19.x family`)
    }
    if (row.line === '2.x' && row.kind !== 'sandbox-v2') {
      throw new Error(`kind ${row.kind} cannot run on the 2.x family`)
    }
    if (!['sandbox-v2', 'v1-permission'].includes(row.kind)) {
      throw new Error(`matrix row ${row.host} has an unknown kind: ${JSON.stringify(row.kind)}`)
    }
  }
}

export function hostEvidenceWarning(checks) {
  return checks.length === 0
    ? 'no measured hosts; supported families are reported as unmeasured'
    : null
}

function v1Proof(root, row) {
  rmSync(root, { recursive: true, force: true })
  const prefix = join(root, 'prefix')
  const home = join(root, 'home')
  mkdirSync(prefix, { recursive: true })
  mkdirSync(home, { recursive: true })
  run(
    `host-${row.host}-install`,
    'npm',
    ['install', '--global', '--prefix', prefix, `opencode-ai@${row.host}`],
    {
      env: { HOME: home, npm_config_cache: join(root, 'npm-cache') },
    },
  )
  const binary = join(prefix, 'bin', 'opencode')
  return run(`host-${row.host}`, 'bash', ['tests/canary/run-v1-permission-proof.sh'], {
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(root, 'config'),
      XDG_DATA_HOME: join(root, 'data'),
      XDG_STATE_HOME: join(root, 'state'),
      XDG_CACHE_HOME: join(root, 'cache'),
      PATH: `${join(prefix, 'bin')}:${process.env.PATH ?? ''}`,
      PANTHEON_V1_CANARY_BIN: binary,
    },
  })
}

function hostGate(options) {
  const tarball = singleTarball(options)
  const matrix = matrixFromEnv()
  validateMatrix(matrix)
  const checks = []
  matrix.forEach((row, index) => {
    const root = join(runnerTemp(), `pantheon-release-host-${safeName(row.host)}`)
    if (row.kind === 'sandbox-v2') {
      rmSync(root, { recursive: true, force: true })
      checks.push(
        run(
          `host-${row.host}`,
          'bash',
          ['scripts/test-opencode-v2-sandbox.sh', '--prepare', '--run', 'v2'],
          {
            env: sandboxEnv(root, row.host, tarball, 49380 + index),
          },
        ),
      )
      return
    }
    checks.push(v1Proof(root, row))
  })
  const measuredFamilies = [...new Set(matrix.map((row) => row.line))]
  const unmeasuredFamilies = SUPPORTED_FAMILIES.filter(
    (family) => !measuredFamilies.includes(family),
  )
  return {
    checks,
    details: {
      supportLevel: 'family',
      supportedFamilies: [...SUPPORTED_FAMILIES],
      measuredFamilies,
      unmeasuredFamilies,
      matrix: matrix.map((row) => ({
        host: row.host,
        line: row.line,
        kind: row.kind,
        status: 'PASS',
      })),
      unsupportedExcluded: [...UNSUPPORTED_HOSTS],
    },
  }
}

// ── Gate (c): install ────────────────────────────────────────────────────────

function installGate(options) {
  const tarball = singleTarball(options)
  const host = process.env.PANTHEON_RELEASE_INSTALL_HOST ?? '2.0.30'
  const root = join(runnerTemp(), `pantheon-release-install-${safeName(host)}`)
  const port = Number(process.env.PANTHEON_RELEASE_INSTALL_PORT ?? 49390)
  rmSync(root, { recursive: true, force: true })

  const sandbox = run(
    'sandbox-install',
    'bash',
    ['scripts/test-opencode-v2-sandbox.sh', '--prepare', '--run', 'v2'],
    { env: sandboxEnv(root, host, tarball, port) },
  )
  const version = installedVersion(root)
  if (version !== options.version) {
    throw new Error(
      `installed package version ${version} does not match candidate ${options.version}`,
    )
  }

  const binary = join(root, 'home', '.npm-global', 'bin', 'opencode')
  const canary = run('tool-canary', 'npm', ['run', 'test:tool-canary'], {
    env: { PANTHEON_TOOL_CANARY_BIN: binary },
  })
  // The canary itself skips when no binary is found. In release context that
  // skip is not a PASS, so a skip marker fails the gate.
  if (/\(skipped\)/.test(canary.output)) {
    throw new Error('host-backed tool canary was skipped; release context requires a real host')
  }
  writeFileSync(join(options.evidenceDir, 'install-canary.log'), canary.output)

  return {
    checks: [sandbox, canary],
    details: {
      host,
      version,
      tarball: basename(tarball),
      tarballSha256: sha256(readFileSync(tarball)),
    },
  }
}

// ── Gate (d): package ────────────────────────────────────────────────────────

function packageGate(options) {
  const tarball = singleTarball(options)
  const metadataPath = join(options.artifactDir, 'metadata.json')
  if (!existsSync(metadataPath)) throw new Error(`artifact metadata is missing: ${metadataPath}`)
  const metadata = JSON.parse(readFileSync(metadataPath, 'utf8'))
  const actualSha = sha256(readFileSync(tarball))

  if (metadata.targetSha !== options.targetSha) {
    throw new Error('artifact metadata target SHA does not match --target-sha')
  }
  if (metadata.version !== options.version) {
    throw new Error('artifact metadata version does not match --version')
  }
  if (metadata.tarball !== basename(tarball)) {
    throw new Error('artifact metadata does not name the sole .tgz')
  }
  if (metadata.tarballSha256 !== actualSha) {
    throw new Error('artifact SHA-256 does not match metadata')
  }
  const expectedName = `pantheon-opencode-${options.version}.tgz`
  if (basename(tarball) !== expectedName) {
    throw new Error(`artifact must be named ${expectedName}, found ${basename(tarball)}`)
  }

  const listing = run('tarball-contents', 'tar', ['-tzf', tarball], { echo: false }).output
  const entries = new Set(
    listing
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  )
  const missing = REQUIRED_TARBALL_PAYLOAD.filter((entry) => !entries.has(entry))
  if (missing.length > 0) {
    throw new Error(`tarball is missing required payload: ${missing.join(', ')}`)
  }

  const validate = run('package-validate', 'npm', ['run', 'package:validate'])
  return {
    checks: [validate],
    details: {
      tarball: basename(tarball),
      tarballSha256: actualSha,
      targetSha: options.targetSha,
      payloadEntries: entries.size,
    },
  }
}

// ── Gate (e): changelog ──────────────────────────────────────────────────────

function changelogGate(options) {
  if (options.recovery) {
    const tag = run('recovery-tag', 'git', ['tag', '-l', `v${options.version}`], { echo: false })
    if (tag.output.trim() !== `v${options.version}`) {
      throw new Error(`recovery tag v${options.version} does not exist on this checkout`)
    }
    return {
      checks: [
        { name: 'recovery-tag', status: 'PASS', command: 'git tag -l', durationMs: tag.durationMs },
      ],
      details: { mode: 'recovery-static', version: options.version },
    }
  }
  const extraction = run(
    'changelog-section',
    'node',
    ['scripts/changelog-extract.mjs', options.version],
    {
      echo: false,
    },
  )
  if (!extraction.output.trim()) {
    throw new Error(`CHANGELOG.md has no non-empty [${options.version}] section`)
  }
  writeFileSync(join(options.evidenceDir, 'changelog.md'), extraction.output)
  return {
    checks: [{ ...extraction, output: undefined, sha256: sha256(extraction.output) }],
    details: {
      mode: 'committed-section',
      version: options.version,
      bytes: extraction.output.length,
    },
  }
}

// ── Gate (f): metadata ───────────────────────────────────────────────────────

function metadataGate(options) {
  const targetSha = assertCandidateSha(options)
  if (options.version !== readPackageVersion()) {
    throw new Error(`--version ${options.version} does not match package.json`)
  }
  const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
  const beta = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.[1-9]\d*$/
  if (!['stable', 'beta'].includes(options.channel)) {
    throw new Error(`unknown channel ${options.channel}`)
  }
  if (options.channel === 'stable' && !stable.test(options.version)) {
    throw new Error(`stable channel requires X.Y.Z, found ${options.version}`)
  }
  if (options.channel === 'beta' && !beta.test(options.version)) {
    throw new Error(`beta channel requires X.Y.Z-beta.N, found ${options.version}`)
  }
  const checks = [
    run('version-manifests', 'node', ['scripts/version-check.mjs']),
    run('node-engine-policy', 'node', ['scripts/validate-node-engine-policy.mjs']),
  ]
  return {
    checks,
    details: {
      version: options.version,
      channel: options.channel,
      targetSha,
      recovery: options.recovery,
    },
  }
}

const GATES = {
  tests: testsGate,
  host: hostGate,
  install: installGate,
  package: packageGate,
  changelog: changelogGate,
  metadata: metadataGate,
}

function evidenceCheck(check) {
  const { output, ...rest } = check
  if (typeof output === 'string') {
    rest.outputBytes = Buffer.byteLength(output)
    rest.outputSha256 = sha256(output)
  }
  return rest
}

function writeEvidence(options, record) {
  mkdirSync(options.evidenceDir, { recursive: true })
  const path = join(options.evidenceDir, `${options.gate}.json`)
  const serializable = { ...record, checks: record.checks.map(evidenceCheck) }
  writeFileSync(path, `${JSON.stringify(serializable, null, 2)}\n`)
  return path
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  mkdirSync(options.evidenceDir, { recursive: true })
  const record = {
    gate: options.gate,
    status: 'PASS',
    version: options.version,
    targetSha: options.targetSha,
    channel: options.channel,
    recovery: options.recovery,
    generatedAt: new Date().toISOString(),
    checks: [],
    details: {},
  }

  try {
    const result = GATES[options.gate](options)
    record.checks = result.checks ?? []
    record.details = result.details ?? {}
    const warning = options.gate === 'host' ? hostEvidenceWarning(record.checks) : null
    if (warning) {
      record.details.hostEvidenceWarning = warning
      console.warn(`GATE host: WARNING — ${warning}`)
    }
  } catch (error) {
    record.status = 'FAIL'
    record.error = error.message
    const path = writeEvidence(options, record)
    console.error(`GATE ${options.gate}: FAIL — ${error.message}`)
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.error(`::error title=Gate ${options.gate}::FAIL — ${tail(error.message, 500)}`)
    }
    console.error(`evidence: ${path}`)
    process.exit(1)
  }

  const path = writeEvidence(options, record)
  console.log(`GATE ${options.gate}: PASS`)
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log(`::notice title=Gate ${options.gate}::PASS`)
  }
  console.log(`evidence: ${path}`)
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) main()
