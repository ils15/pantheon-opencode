import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const WORKFLOWS_DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url))

const workflow = readFileSync(
  fileURLToPath(new URL('../.github/workflows/ci.yml', import.meta.url)),
  'utf8',
)

const packageJson = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
)
const packageLock = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package-lock.json', import.meta.url)), 'utf8'),
)

const TUI_WORKSPACE = 'src/plugins/tui'

test('CI dependency installation and required gates are fail-closed', () => {
  assert.doesNotMatch(workflow, /npm ci[^\n]*\|\|[^\n]*npm install/)
  assert.doesNotMatch(workflow, /(?:pytest|npm audit)[^\n]*\|\|/)
  for (const command of [
    'npm run lint',
    'npm run typecheck',
    'npm test',
    'npm run doctor',
    'npm run audit',
    'npm run package:validate',
    'npm run package:evidence -- ',
    'python3 -m coverage report --fail-under=80',
  ]) {
    assert.ok(workflow.includes(command), `CI must run ${command}`)
  }
  // `npm test` delegates to `test:all`; the unified runner must still cover
  // pytest, node, and ts so the single CI step cannot silently drop a suite.
  const testAll = packageJson.scripts['test:all']
  for (const step of ['npm run test:ci', 'npm run test:node', 'npm run test:ts']) {
    assert.ok(testAll.includes(step), `test:all must include ${step}`)
  }
})

test('CI package validation and evidence preserve failures and remain blocking', () => {
  const validationMatch = workflow.match(/- name: Validate publishable package\n\s+run: ([^\n]+)/)
  assert.ok(validationMatch, 'CI must define a package validation step')
  assert.equal(validationMatch[1].trim(), 'npm run package:validate')

  const match = workflow.match(/- name: Verify tarball\/package evidence\n\s+run: ([^\n]+)/)
  assert.ok(match, 'CI must define a tarball/package evidence step')
  const command = match[1].trim()
  const packageStep = workflow.match(
    /- name: Verify tarball\/package evidence\n[\s\S]*?(?=\n {2}[a-z][a-z0-9-]*:|\n*$)/,
  )
  assert.ok(packageStep, 'CI package evidence step must be present in the validate job')
  assert.ok(
    workflow.indexOf('- name: Verify tarball/package evidence') > workflow.indexOf('validate:'),
    'CI package evidence step must live inside the validate job',
  )

  assert.match(command, /^npm run package:evidence -- /)
  assert.match(command, /--target-sha="\$\(git rev-parse HEAD\)"/)
  assert.doesNotMatch(
    command,
    /\|(?:\s|$)/,
    'package evidence must not be piped to a masking command',
  )
  assert.doesNotMatch(
    command,
    /\|\|/,
    'package evidence must not have a fallback that masks failure',
  )
  assert.doesNotMatch(packageStep[0], /continue-on-error:\s*true/)

  const binDir = mkdtempSync(join(tmpdir(), 'ci-pack-contract-'))
  const fakeNpm = join(binDir, 'npm')
  writeFileSync(fakeNpm, '#!/bin/sh\nexit 37\n')
  chmodSync(fakeNpm, 0o755)

  try {
    const result = spawnSync('bash', ['-c', command], {
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      encoding: 'utf8',
    })
    assert.equal(result.status, 37, 'package evidence failure must fail the workflow step')
  } finally {
    rmSync(binDir, { recursive: true, force: true })
  }
})

test('CI validates YAML and installs locked dependencies only', () => {
  assert.match(workflow, /python3 scripts\/ci-validate-yaml\.py/)
  assert.match(workflow, /npm ci --ignore-scripts/)
  // The TUI plugin used to need its own `npm ci --prefix src/plugins/tui`
  // step. It is removed because it is now REDUNDANT, not because `--prefix`
  // is invalid — that step does operate in the given directory. Under
  // `workspaces` the single root `npm ci` above already installs the TUI from
  // the committed root lockfile.
  //
  // That step was, however, an accidental validator: `npm ci` refuses to run
  // when a manifest and lock disagree, so it would have caught drift in the
  // nested TUI lock. That role is now filled explicitly by
  // tests/tui-workspace-lock.test.mjs, which compares
  // src/plugins/tui/package.json against
  // src/plugins/tui/package-lock.json's packages[""] — the lock users
  // actually install from, which no npm command validates under a workspace
  // parent. What must stay locked is that the root lock actually resolves the
  // workspace; otherwise a root-only install would silently leave solid-js
  // unresolvable and test:ts would fail late.
  assert.ok(
    packageJson.workspaces?.includes(TUI_WORKSPACE),
    `package.json must declare the TUI plugin as a workspace (${TUI_WORKSPACE}) so a single root npm ci installs it`,
  )
  assert.equal(
    packageLock.packages?.['node_modules/pantheon-tui']?.link,
    true,
    'root package-lock.json must link node_modules/pantheon-tui to the TUI workspace',
  )
  assert.equal(
    packageLock.packages?.[TUI_WORKSPACE]?.name,
    'pantheon-tui',
    'root package-lock.json must carry a package entry for the TUI workspace itself',
  )
  assert.match(
    workflow,
    /pip install[^\n]*pytest-asyncio==\d+\.\d+\.\d+/,
    'CI must install locked pytest-asyncio before pytest so asyncio_mode=auto resolves async tests',
  )
  assert.match(
    workflow,
    /pip install[^\n]*-r src\/mcp\/requirements-mcp\.txt/,
    'CI must install the locked MCP deps before pytest',
  )
  // The memory server's vector pipeline (sqlite-vec + fastembed) was removed
  // outright — no flag, no fallback. memory_mcp_server is stdlib + FTS5 now,
  // so CI must install NEITHER backend. These guards are inverted from the
  // original pair, which asserted sqlite-vec was installed and fastembed was
  // not: they now keep the removal fail-closed, so reintroducing either wheel
  // into the install step fails here instead of silently restoring ~50MB of
  // deps and the RSS the deletion was meant to reclaim.
  assert.doesNotMatch(
    workflow,
    /pip install[^\n]*sqlite-vec/,
    'CI must not install sqlite-vec: the memory vector pipeline was removed and the server is FTS5-only',
  )
  assert.doesNotMatch(
    workflow,
    /pip install[^\n]*fastembed/,
    'CI must not install fastembed: the memory vector pipeline was removed and the server is FTS5-only',
  )
  assert.doesNotMatch(workflow, /pip install[^\n]*\|\|/)
  const testGate = workflow.indexOf('npm test')
  assert.ok(testGate >= 0, 'CI must run the unified test gate (npm test)')
  assert.ok(
    workflow.indexOf('pytest-asyncio==') < testGate,
    'Locked pytest-asyncio pip install must run BEFORE the pytest gate',
  )
  assert.ok(
    workflow.indexOf('requirements-vision.txt') < testGate,
    'Locked vision pip install must run BEFORE the pytest gate',
  )
  assert.doesNotMatch(workflow, /npm install(?!.*--dry-run)/)
  assert.doesNotMatch(workflow, /\|\| true/)
  assert.doesNotMatch(workflow, /echo ["']?(?:test|audit) warnings/i)
  assert.match(workflow, /PANTHEON_PYTHON: python3/)
})

test('root workspace lock provides TUI test dependencies without vector packages', () => {
  assert.deepEqual(packageJson.workspaces, ['src/plugins/tui'])
  assert.ok(packageLock.packages['src/plugins/tui'], 'TUI must be represented in the root lockfile')
  assert.ok(
    packageLock.packages['node_modules/solid-js'],
    'root npm ci must make solid-js available to test:ts',
  )
  const lockedNames = Object.keys(packageLock.packages).join('\n').toLowerCase()
  assert.doesNotMatch(lockedNames, /sqlite[-_]vec|fastembed|vector_memory/)
})

test('CI wires explicit coverage and V2 isolation gates', () => {
  assert.match(
    workflow,
    /python3 -m coverage run --branch --source=src\/mcp -m pytest/,
    'CI coverage must execute the Python suite rather than inspect a stale artifact',
  )
  assert.match(workflow, /python3 -m coverage report --fail-under=80/)

  const sandboxStep = workflow.match(
    /- name: V2 sandbox \(isolated database and dedicated port\)\n[\s\S]*?(?=\n {2}[a-z][a-z0-9-]*:|\n*$)/,
  )
  assert.ok(sandboxStep, 'CI must define an explicit V2 sandbox gate')
  assert.match(
    sandboxStep[0],
    /PANTHEON_SANDBOX_ROOT:\s+\$\{\{\s*runner\.temp\s*\}\}\/pantheon-sandbox-v2/,
  )
  assert.match(
    sandboxStep[0],
    /OPENCODE_DB:\s+\$\{\{\s*runner\.temp\s*\}\}\/pantheon-sandbox-v2\/opencode-v2\.db/,
  )
  assert.doesNotMatch(
    sandboxStep[0],
    /OPENCODE_CONFIG:\s+/,
    'the workflow must not select a V2 config file through the legacy variable',
  )
  assert.match(sandboxStep[0], /PANTHEON_V2_PORT:\s+'49376'/)
  assert.match(sandboxStep[0], /PORT:\s+'49376'/)
  assert.match(sandboxStep[0], /bash scripts\/test-opencode-v2-sandbox\.sh --prepare --run v2/)
  assert.doesNotMatch(
    sandboxStep[0],
    /serve --hostname 127\.0\.0\.1/,
    'the harness owns the dedicated service lifecycle and handshake wait',
  )
  assert.doesNotMatch(sandboxStep[0], /continue-on-error:\s*true/)
})

test('V2 harness isolates config, database, port, and waits for five MCP handshakes', () => {
  const harness = readFileSync(
    fileURLToPath(new URL('../scripts/test-opencode-v2-sandbox.sh', import.meta.url)),
    'utf8',
  )
  const configDirExport = 'export OPENCODE_CONFIG_DIR="$(dirname "$V2_CONFIG")"'
  assert.equal(
    harness.split(configDirExport).length - 1,
    2,
    'sandbox_env and the generated runner must both use OpenCode 2 config-directory selection',
  )
  assert.doesNotMatch(
    harness,
    /export OPENCODE_CONFIG="\$V2_CONFIG"/,
    'the legacy file-valued OPENCODE_CONFIG selector must not be used',
  )
  assert.equal(
    (
      harness.match(
        /unset OPENCODE_CONFIG OPENCODE_CONFIG_CONTENT OPENCODE_CONFIG_PROJECT_DISABLE/g,
      ) ?? []
    ).length,
    2,
    'both environments must clear inherited OPENCODE_CONFIG contamination',
  )
  assert.doesNotMatch(
    harness,
    /unset OPENCODE_CONFIG_CONTENT OPENCODE_CONFIG_DIR OPENCODE_CONFIG_PROJECT_DISABLE/,
    'the selected config directory must not be unset after it is established',
  )
  assert.match(harness, /export OPENCODE_DB="\$V2_DB"/)
  assert.match(harness, /export PORT="\$V2_PORT"/)
  assert.match(harness, /export XDG_STATE_HOME="\$SANDBOX_HOME\/\.local\/state"/)
  assert.match(
    harness,
    /V2_SERVICE_STATE="\$SANDBOX_HOME\/\.local\/state\/opencode\/service\.json"/,
  )
  assert.match(harness, /message=\\"mcp connected\\"/)
  assert.match(harness, /expected exactly 5 connected MCPs/)
  assert.match(harness, /refusing to reuse an unrelated service/)
})

test('V2 loader order starts mcp list before waiting for handshakes', () => {
  const harness = readFileSync(
    fileURLToPath(new URL('../scripts/test-opencode-v2-sandbox.sh', import.meta.url)),
    'utf8',
  )
  const serviceBody = harness.match(/start_v2_service\(\) \{[\s\S]*?\n\}/)?.[0]
  assert.ok(serviceBody, 'V2 service helper must be present')
  assert.match(serviceBody, /global\/health/)
  assert.match(
    serviceBody,
    /wait_for_v2_service_registration/,
    'healthcheck helper must wait for the dedicated service registration before mcp list',
  )
  assert.doesNotMatch(
    serviceBody,
    /wait_for_v2_handshakes/,
    'healthcheck helper must not wait for MCPs before mcp list triggers loading',
  )

  for (const [name, launch] of [
    [
      'generated runner',
      '(cd "$project" && timeout --foreground "$V2_MCP_LIST_TIMEOUT" "$bin" mcp list)',
    ],
    [
      'main runner',
      '(cd "$(project_dir)" && timeout --foreground "$V2_MCP_LIST_TIMEOUT" "$bin" mcp list)',
    ],
  ]) {
    const launchIndex = harness.indexOf(`${launch} \\`)
    const waitIndex = harness.indexOf('if wait_for_v2_handshakes; then', launchIndex)
    assert.ok(launchIndex >= 0, `${name} must launch mcp list asynchronously`)
    assert.ok(waitIndex > launchIndex, `${name} must wait for handshakes after mcp list starts`)
  }
  assert.match(
    harness,
    /connected_count.*-eq 5/s,
    'the output gate must remain fail-closed at exactly five connected MCPs',
  )
  assert.match(harness, /V2_LOOPBACK_HOST=\"\$\{PANTHEON_V2_HOST:-127\.0\.0\.1\}\"/)
  assert.match(harness, /registration_url.*http:\/\/\$V2_LOOPBACK_HOST:\$V2_PORT/)
  assert.match(harness, /registration_pid.*\$V2_SERVER_PID/)
})

test('V2 config merge rewrites stale MCP paths to the active sandbox', (t) => {
  const harness = readFileSync(
    fileURLToPath(new URL('../scripts/test-opencode-v2-sandbox.sh', import.meta.url)),
    'utf8',
  )
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'pantheon-v2-config-contract-'))
  t.after(() => rmSync(sandboxRoot, { recursive: true, force: true }))
  const project = join(sandboxRoot, 'project-v2')
  const runtime = join(project, '.opencode')
  const managed = [
    ['pantheon-code-mode', 'code_mode_server.py'],
    ['pantheon-memory', 'memory_mcp_server.py'],
    ['pantheon-persistence', 'mcp_persistence_server.py'],
    ['pantheon-resources', 'mcp_resources_server.py'],
    ['pantheon-vision', 'pantheon_vision_server.py'],
  ]
  const scripts = managed.map(([, script]) => script)
  mkdirSync(join(runtime, 'scripts'), { recursive: true })
  mkdirSync(join(project, '.venv', 'bin'), { recursive: true })
  const python = join(project, '.venv', 'bin', 'python3')
  writeFileSync(python, '#!/bin/sh\n', { mode: 0o755 })
  for (const script of scripts) writeFileSync(join(runtime, 'scripts', script), '')

  const config = join(project, 'opencode.json')
  const names = managed.map(([name]) => name)
  writeFileSync(
    config,
    JSON.stringify({
      mcp: Object.fromEntries(
        names.map((name) => [
          name,
          {
            type: 'local',
            cwd: '/old-sandbox/project-v2/.opencode',
            command: ['/old-sandbox/project-v2/.venv/bin/python3', 'scripts/stale.py'],
            enabled: true,
          },
        ]),
      ),
    }),
  )

  const defsFile = join(sandboxRoot, 'runner-definitions.sh')
  const cliMarker = harness.indexOf('# ── CLI ─')
  assert.ok(cliMarker > 0, 'runner CLI marker must be present')
  writeFileSync(defsFile, harness.slice(0, cliMarker))
  const result = spawnSync(
    'bash',
    [
      '-c',
      'set -euo pipefail; source "$DEFS"; SANDBOX_ROOT="$ROOT"; TARGET_VERSION=v2; V2_CONFIG="$CONFIG"; rewrite_v2_mcp_config',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEFS: defsFile,
        ROOT: sandboxRoot,
        CONFIG: config,
      },
    },
  )
  assert.equal(result.status, 0, `config rewrite failed:\n${result.stdout}\n${result.stderr}`)

  const rewritten = JSON.parse(readFileSync(config, 'utf8'))
  for (const [name, script] of managed) {
    const entry = rewritten.mcp[name]
    assert.equal(entry.cwd, runtime)
    assert.deepEqual(entry.command, [python, `scripts/${script}`])
    assert.equal(entry.enabled, true)
    assert.doesNotMatch(JSON.stringify(entry), /old-sandbox/)
  }
})

test('no workflow installs the TUI plugin separately from the root lockfile', () => {
  const files = readdirSync(WORKFLOWS_DIR).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
  assert.ok(files.length > 0, 'expected at least one workflow to scan')

  const offenders = []
  for (const f of files) {
    const src = readFileSync(join(WORKFLOWS_DIR, f), 'utf8')
    for (const [i, line] of src.split('\n').entries()) {
      // Install verbs only. `npm run build --prefix src/plugins/tui` is the
      // TUI dist-freshness gate and legitimately stays prefix-scoped — a
      // blanket "no --prefix" rule would be wrong and would delete that gate.
      if (!/\bnpm\s+(?:ci|install)\b/.test(line)) continue
      if (!line.includes(TUI_WORKSPACE)) continue
      offenders.push(`${f}:${i + 1}: ${line.trim()}`)
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'The TUI plugin is a root workspace (package.json "workspaces" + a linked\n' +
      'entry in the root lockfile), so the root `npm ci` already installs its\n' +
      'dependencies from the committed root lock. A second, prefix-scoped\n' +
      'install would bypass that single source of truth and re-introduce the\n' +
      'dual-lock drift the workspace move removed. Offending lines:\n  - ' +
      offenders.join('\n  - '),
  )

  // Guard the other direction: the dist-freshness build is NOT an install and
  // must survive, or the "stale TUI bundle" check would silently disappear.
  assert.match(
    workflow,
    /npm run build --prefix src\/plugins\/tui/,
    'the TUI dist-freshness build step must remain; it is a build, not an install',
  )
})
