import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const ROOT = process.cwd()
const RUNNER = join(ROOT, 'scripts', 'test-opencode-v2-sandbox.sh')
const CONTEXT_PROBE = join(ROOT, 'scripts', 'probe-context-rehydrate.mjs')

// Everything above the CLI dispatch is pure definition — globals, helpers and
// the generators. Sourcing that slice hands the test the real write_run_test_sh
// without running --prepare, which installs globals and packs a tarball.
// The REPO_DIR value is passed through the ENVIRONMENT, never interpolated
// into this script's own source, so the test cannot "fix" a value the
// generator would have mangled.
const RUNNER_SRC = readFileSync(RUNNER, 'utf8')
const CLI_MARKER = RUNNER_SRC.indexOf('# ── CLI ─')
const DEFINITIONS = CLI_MARKER > 0 ? RUNNER_SRC.slice(0, CLI_MARKER) : ''

/** Run the real write_run_test_sh for `repoDir`; returns the generated path. */
function generate(repoDir, sandboxRoot, defsFile) {
  writeFileSync(defsFile, DEFINITIONS)
  const res = spawnSync(
    'bash',
    [
      '-c',
      'set -euo pipefail\nsource "$RUNNER_DEFS"\nREPO_DIR="$INPUT_REPO"\nSANDBOX_ROOT="$INPUT_SANDBOX"\nmkdir -p "$SANDBOX_ROOT"\nwrite_run_test_sh',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNNER_DEFS: defsFile,
        INPUT_REPO: repoDir,
        INPUT_SANDBOX: sandboxRoot,
      },
    },
  )
  assert.equal(
    res.status,
    0,
    `write_run_test_sh failed for ${JSON.stringify(repoDir)}:\n${res.stderr}`,
  )
  return join(sandboxRoot, 'run-test.sh')
}

function withoutEnv(...names) {
  const env = { ...process.env }
  for (const name of names) delete env[name]
  return env
}

function loadDefinitions(defsFile) {
  writeFileSync(defsFile, DEFINITIONS)
  return defsFile
}

/** Execute the generated script and return its stdout. */
function runGenerated(generated, stubBin) {
  // The generated script's first real action is `npm pack` inside the repo. A
  // stub npm that exits 1 makes that fail at once, so this test asserts the
  // header — where `Repo:` is echoed — without invoking a real install.
  const res = spawnSync('bash', [generated], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${stubBin}:${process.env.PATH}` },
  })
  return res.stdout
}

test('runner script exists and is executable, with valid bash syntax', () => {
  assert.ok(existsSync(RUNNER), 'scripts/test-opencode-v2-sandbox.sh missing')
  assert.ok(statSync(RUNNER).mode & 0o111, 'runner script is not executable')
  const res = spawnSync('bash', ['-n', RUNNER], { encoding: 'utf8' })
  assert.equal(res.status, 0, `bash -n failed:\n${res.stderr}`)
})

test('runner is V2-only: no V1 leg, no sibling-repo inference', () => {
  const src = readFileSync(RUNNER, 'utf8')
  // The V1 install spec and binary are gone. `@opencode-ai/cli` was only ever
  // an install spec, never a dependency of this package.
  assert.doesNotMatch(
    src,
    /OPENCODE_V1_SPEC|opencode-ai@1\.18\.18/,
    'V1 install spec still present',
  )
  assert.doesNotMatch(src, /check_binary "V1/, 'generated script still probes a V1 binary')
  assert.doesNotMatch(src, /prepare_project v1/, 'still generates a project-v1')
  // `--run v1` must fail loudly rather than silently testing the wrong leg.
  assert.match(src, /the V1 leg was removed/, '--run v1 must be rejected explicitly')

  // REPO_DIR must come from the script's own location. Inferring it from a
  // sibling directory named "pantheon" resolved to a DIFFERENT checkout that
  // had unrelated uncommitted work, and --prepare packs a tarball inside it.
  assert.match(
    src,
    /SCRIPT_REPO_DIR="\$\(cd "\$SCRIPT_DIR\/\.\." && pwd -P\)"/,
    'REPO_DIR must be derived from SCRIPT_DIR',
  )
  assert.doesNotMatch(
    src,
    /SANDBOX_DIR\/\.\.\/pantheon/,
    'REPO_DIR must not be inferred from a sibling ../pantheon directory',
  )
})

test('the generated run-test.sh echoes the repo dir byte-for-byte (adversarial paths)', (t) => {
  // The generator used to bake REPO_DIR into the generated file as a
  // `__PANTHEON_REPO_DIR__` placeholder and substitute it with `sed`. That
  // required escaping for TWO languages at once: sed replacement text (only
  // `&` and `|` were escaped) AND the double-quoted shell context the value
  // landed in, where `"`, `$`, a backtick and `\` are also significant. A path
  // containing `$USER` was rewritten to the expanded value, a backslash was
  // swallowed, and a backtick EXECUTED. `bash -n` passes for all of them, so a
  // syntax check cannot catch it — only running the generated file can.
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-gen-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const defsFile = join(workDir, 'runner-definitions.sh')
  const stubBin = join(workDir, 'stub-bin')
  mkdirSync(stubBin, { recursive: true })
  writeFileSync(join(stubBin, 'npm'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })

  const cases = [
    ['ordinary path', 'pantheon'],
    ['$ expands', 'we$USER'],
    ['backtick executes', 'tick`id`'],
    ['backslash swallowed', 'back\\slash'],
    ['ampersand is a sed replacement', 'amp&ersand'],
    ['pipe is the sed delimiter', 'pi|pe'],
    ['double quote closes the context', 'dq"uote'],
    [
      'all of them at once',
      join('we$USER', 'tick`id`', 'back\\slash', 'amp&ersand', 'pi|pe', 'dq"uote'),
    ],
  ]

  for (const [label, segments] of cases) {
    const repoDir = join(workDir, label.replace(/\W+/g, '_'), segments)
    const sandboxRoot = join(workDir, `sandbox-${label.replace(/\W+/g, '_')}`)
    mkdirSync(repoDir, { recursive: true })
    writeFileSync(join(repoDir, 'package.json'), '{"name":"pantheon-opencode"}\n')
    mkdirSync(sandboxRoot, { recursive: true })

    const generated = generate(repoDir, sandboxRoot, defsFile)
    const syntax = spawnSync('bash', ['-n', generated], { encoding: 'utf8' })
    assert.equal(
      syntax.status,
      0,
      `[${label}] generated script is not valid bash:\n${syntax.stderr}`,
    )

    // The value travels in its own generated file, so the shell source contains
    // no copy of it that could be re-read, expanded or executed.
    assert.equal(
      readFileSync(join(sandboxRoot, '.repo-dir'), 'utf8'),
      `${repoDir}\n`,
      `[${label}] .repo-dir must hold the repo path verbatim`,
    )
    assert.ok(
      !readFileSync(generated, 'utf8').includes(repoDir),
      `[${label}] the repo path must not be baked into the generated script`,
    )

    const repoLine = runGenerated(generated, stubBin)
      .split('\n')
      .find((line) => line.startsWith('Repo:'))
    assert.equal(
      repoLine?.replace(/^Repo:[ \t]*/, ''),
      repoDir,
      `[${label}] generated script must echo the repo path unchanged`,
    )
  }
})

test('sandbox config and database ignore external path overrides and preserve sentinels', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-path-overrides-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const definitions = loadDefinitions(join(workDir, 'definitions.sh'))
  const sandboxRoot = join(workDir, 'sandbox')
  const externalConfig = join(workDir, 'outside-config.json')
  const externalConfigTemp = join(workDir, 'outside-config-temp.json')
  const externalDb = join(workDir, 'outside.db')
  const configSentinel = '{"external":"config sentinel"}\n'
  const dbSentinel = 'external database sentinel\n'
  const project = join(sandboxRoot, 'project-v2')
  const runtime = join(project, '.opencode')
  const python = join(project, '.venv', 'bin', 'python3')
  mkdirSync(join(runtime, 'scripts'), { recursive: true })
  mkdirSync(join(python, '..'), { recursive: true })
  writeFileSync(join(project, 'opencode.json'), '{}\n')
  writeFileSync(python, '#!/bin/sh\n', { mode: 0o755 })
  for (const script of [
    'code_mode.py',
    'memory_mcp.py',
    'mcp_persistence.py',
    'mcp_resources.py',
    'pantheon_vision.py',
  ]) {
    writeFileSync(join(runtime, 'scripts', script), '# fixture\n')
  }
  writeFileSync(externalConfig, configSentinel)
  writeFileSync(externalConfigTemp, 'external temp sentinel\n')
  writeFileSync(externalDb, dbSentinel)
  symlinkSync(externalConfigTemp, `${join(project, 'opencode.json')}.sandbox-tmp`)

  const result = spawnSync(
    'bash',
    [
      '-c',
      'set -euo pipefail; source "$RUNNER_DEFS"; printf "%s\\n%s\\n" "$V2_CONFIG" "$V2_DB"; rewrite_v2_mcp_config',
    ],
    {
      encoding: 'utf8',
      env: {
        ...withoutEnv(),
        HOME: join(workDir, 'home'),
        PANTHEON_SANDBOX_ROOT: sandboxRoot,
        PANTHEON_V2_CONFIG: externalConfig,
        PANTHEON_V2_DB: externalDb,
        RUNNER_DEFS: definitions,
      },
    },
  )

  assert.equal(result.status, 0, `sandbox config rewrite failed: ${result.stderr}`)
  assert.deepEqual(result.stdout.trim().split('\n'), [
    join(project, 'opencode.json'),
    join(sandboxRoot, 'opencode-v2.db'),
  ])
  assert.equal(readFileSync(externalConfig, 'utf8'), configSentinel)
  assert.equal(readFileSync(externalConfigTemp, 'utf8'), 'external temp sentinel\n')
  assert.equal(lstatSync(`${join(project, 'opencode.json')}.sandbox-tmp`).isSymbolicLink(), true)
  assert.equal(readFileSync(externalDb, 'utf8'), dbSentinel)
  assert.match(readFileSync(join(project, 'opencode.json'), 'utf8'), /pantheon-memory/)
})

test('sandbox_env overrides inherited XDG/OpenCode selectors before writes', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-xdg-isolation-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const definitions = loadDefinitions(join(workDir, 'definitions.sh'))
  const sandboxRoot = join(workDir, 'nested', '..', 'sandbox')
  const repo = join(workDir, 'repo')
  const externalConfig = join(workDir, 'external-config')
  const externalData = join(workDir, 'external-data')
  const externalState = join(workDir, 'external-state')
  const externalCache = join(workDir, 'external-cache')
  const externalConfigSentinel = join(externalConfig, 'opencode', 'keep')
  const externalDataSentinel = join(externalData, 'opencode', 'keep')
  const externalStateSentinel = join(externalState, 'opencode', 'keep')
  const externalCacheSentinel = join(externalCache, 'opencode', 'keep')
  mkdirSync(join(externalConfig, 'opencode'), { recursive: true })
  mkdirSync(join(externalData, 'opencode'), { recursive: true })
  mkdirSync(join(externalState, 'opencode'), { recursive: true })
  mkdirSync(join(externalCache, 'opencode'), { recursive: true })
  mkdirSync(repo, { recursive: true })
  writeFileSync(externalConfigSentinel, 'global config sentinel')
  writeFileSync(externalDataSentinel, 'global data sentinel')
  writeFileSync(externalStateSentinel, 'global state sentinel')
  writeFileSync(externalCacheSentinel, 'global cache sentinel')

  const result = spawnSync(
    'bash',
    [
      '-c',
      'set -euo pipefail; source "$RUNNER_DEFS"; REPO_DIR="$TEST_REPO"; sandbox_env; ! printenv OPENCODE_DATA_DIR >/dev/null; ! printenv OPENCODE_STATE_DIR >/dev/null; ! printenv OPENCODE_CACHE_DIR >/dev/null; ! printenv OPENCODE_STORAGE_PATH >/dev/null; for dir in "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME"; do mkdir -p "$dir/opencode"; printf isolated > "$dir/opencode/probe"; done; printf "%s\\n" "$SANDBOX_ROOT" "$XDG_CONFIG_HOME" "$XDG_CONFIG_DIRS" "$XDG_DATA_HOME" "$XDG_DATA_DIRS" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$npm_config_cache" "$OPENCODE_CONFIG_DIR" "$OPENCODE_DB"',
    ],
    {
      encoding: 'utf8',
      env: {
        ...withoutEnv('PANTHEON_REPO'),
        HOME: join(workDir, 'home'),
        PANTHEON_SANDBOX_ROOT: sandboxRoot,
        TEST_REPO: repo,
        XDG_CONFIG_HOME: externalConfig,
        XDG_CONFIG_DIRS: externalConfig,
        XDG_DATA_HOME: externalData,
        XDG_DATA_DIRS: externalData,
        XDG_STATE_HOME: externalState,
        XDG_CACHE_HOME: externalCache,
        OPENCODE_CONFIG_DIR: externalConfig,
        OPENCODE_DB: join(workDir, 'external.db'),
        OPENCODE_CONFIG: join(externalConfig, 'opencode.json'),
        OPENCODE_DATA_DIR: externalData,
        OPENCODE_STATE_DIR: externalState,
        OPENCODE_CACHE_DIR: externalCache,
        OPENCODE_STORAGE_PATH: join(workDir, 'external-storage'),
        RUNNER_DEFS: definitions,
      },
    },
  )

  assert.equal(result.status, 0, `sandbox_env failed: ${result.stderr}`)
  const [canonicalRoot, ...paths] = result.stdout.trim().split('\n')
  assert.equal(canonicalRoot, join(workDir, 'sandbox'))
  assert.deepEqual(paths, [
    join(canonicalRoot, 'home', '.config'),
    join(canonicalRoot, 'home', '.config', 'xdg'),
    join(canonicalRoot, 'home', '.local', 'share'),
    join(canonicalRoot, 'home', '.local', 'share', 'xdg'),
    join(canonicalRoot, 'home', '.local', 'state'),
    join(canonicalRoot, 'home', '.cache'),
    join(canonicalRoot, 'home', '.npm-cache'),
    join(canonicalRoot, 'project-v2'),
    join(canonicalRoot, 'opencode-v2.db'),
  ])
  assert.equal(readFileSync(externalConfigSentinel, 'utf8'), 'global config sentinel')
  assert.equal(readFileSync(externalDataSentinel, 'utf8'), 'global data sentinel')
  assert.equal(readFileSync(externalStateSentinel, 'utf8'), 'global state sentinel')
  assert.equal(readFileSync(externalCacheSentinel, 'utf8'), 'global cache sentinel')
  assert.equal(existsSync(join(externalConfig, 'opencode', 'probe')), false)
  assert.equal(existsSync(join(externalData, 'opencode', 'probe')), false)
  assert.equal(existsSync(join(externalState, 'opencode', 'probe')), false)
  assert.equal(existsSync(join(externalCache, 'opencode', 'probe')), false)
})

test('config, project, database, and missing-parent paths fail closed on escapes', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-containment-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const definitions = loadDefinitions(join(workDir, 'definitions.sh'))
  const externalDb = join(workDir, 'external.db')
  const repo = join(workDir, 'repo')
  const sentinelConfig = '{"external":"keep"}\n'
  const sentinelDb = 'external db sentinel\n'
  const makeProject = (root, configTarget = null) => {
    const project = join(root, 'project-v2')
    const runtime = join(project, '.opencode', 'scripts')
    const python = join(project, '.venv', 'bin', 'python3')
    mkdirSync(runtime, { recursive: true })
    mkdirSync(join(python, '..'), { recursive: true })
    if (configTarget) symlinkSync(configTarget, join(project, 'opencode.json'))
    else writeFileSync(join(project, 'opencode.json'), '{}\n')
    writeFileSync(python, '#!/bin/sh\n', { mode: 0o755 })
    for (const script of [
      'code_mode.py',
      'memory_mcp.py',
      'mcp_persistence.py',
      'mcp_resources.py',
      'pantheon_vision.py',
    ])
      writeFileSync(join(runtime, script), '# fixture\n')
  }
  writeFileSync(externalDb, sentinelDb)
  mkdirSync(repo, { recursive: true })
  const invoke = (sandboxRoot, command) =>
    spawnSync(
      'bash',
      ['-c', `set -euo pipefail; source "$RUNNER_DEFS"; REPO_DIR="$TEST_REPO"; ${command}`],
      {
        encoding: 'utf8',
        env: {
          ...withoutEnv('PANTHEON_REPO'),
          HOME: join(workDir, 'home'),
          PANTHEON_SANDBOX_ROOT: sandboxRoot,
          TEST_REPO: repo,
          RUNNER_DEFS: definitions,
        },
      },
    )

  const linkedProjectRoot = join(workDir, 'linked-project-sandbox')
  const externalProjectRoot = join(workDir, 'outside-project-root')
  mkdirSync(linkedProjectRoot, { recursive: true })
  makeProject(externalProjectRoot)
  writeFileSync(join(externalProjectRoot, 'project-v2', 'opencode.json'), sentinelConfig)
  symlinkSync(join(externalProjectRoot, 'project-v2'), join(linkedProjectRoot, 'project-v2'))
  const projectLink = invoke(linkedProjectRoot, 'rewrite_v2_mcp_config')
  assert.notEqual(projectLink.status, 0, 'symlinked project parent must be rejected')
  assert.equal(
    readFileSync(join(externalProjectRoot, 'project-v2', 'opencode.json'), 'utf8'),
    sentinelConfig,
  )

  const configLinkRoot = join(workDir, 'config-link-sandbox')
  const externalConfig = join(workDir, 'external-config.json')
  mkdirSync(configLinkRoot, { recursive: true })
  writeFileSync(externalConfig, sentinelConfig)
  makeProject(configLinkRoot, externalConfig)
  const configLink = invoke(configLinkRoot, 'rewrite_v2_mcp_config')
  assert.notEqual(configLink.status, 0, 'symlinked config leaf must be rejected')
  assert.equal(readFileSync(externalConfig, 'utf8'), sentinelConfig)

  const dbLinkRoot = join(workDir, 'db-link-sandbox')
  mkdirSync(dbLinkRoot, { recursive: true })
  symlinkSync(externalDb, join(dbLinkRoot, 'opencode-v2.db'))
  const dbLink = invoke(dbLinkRoot, 'sandbox_env')
  assert.notEqual(dbLink.status, 0, 'symlinked database leaf must be rejected')
  assert.equal(readFileSync(externalDb, 'utf8'), sentinelDb)

  const missingParentRoot = join(workDir, 'missing-parent-sandbox')
  mkdirSync(missingParentRoot, { recursive: true })
  const missingParent = invoke(missingParentRoot, 'rewrite_v2_mcp_config')
  assert.notEqual(missingParent.status, 0, 'missing project parent must fail closed')
  assert.equal(existsSync(join(missingParentRoot, 'project-v2')), false)
})

test('sandbox generators replace symlink outputs without modifying external sentinels', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-output-links-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const definitions = loadDefinitions(join(workDir, 'definitions.sh'))
  const sandboxRoot = join(workDir, 'sandbox')
  const repo = join(workDir, 'repo')
  mkdirSync(sandboxRoot, { recursive: true })
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'package.json'), '{"name":"pantheon-opencode"}\n')

  const outputs = [
    ['run-test.sh', 'external-run-test.sh'],
    ['start-pantheon.sh', 'external-start-pantheon.sh'],
    ['README.md', 'external-README.md'],
    ['.prompt-extract-json.py', 'external-prompt-extractor.py'],
  ]
  const expected = new Map()
  for (const [output, target] of outputs) {
    const sentinelPath = join(workDir, target)
    const sentinel = `external sentinel for ${output}\n`
    writeFileSync(sentinelPath, sentinel)
    expected.set(output, { sentinelPath, sentinel })
    symlinkSync(sentinelPath, join(sandboxRoot, output))
  }

  const result = spawnSync(
    'bash',
    [
      '-c',
      'set -euo pipefail; source "$RUNNER_DEFS"; SANDBOX_ROOT="$TEST_SANDBOX"; REPO_DIR="$TEST_REPO"; EXTRACT_PY="$SANDBOX_ROOT/.prompt-extract-json.py"; write_run_test_sh; write_sandbox_entrypoints; write_extract_py',
    ],
    {
      encoding: 'utf8',
      env: {
        ...withoutEnv(),
        HOME: join(workDir, 'home'),
        RUNNER_DEFS: definitions,
        TEST_REPO: repo,
        TEST_SANDBOX: sandboxRoot,
      },
    },
  )

  assert.equal(result.status, 0, `sandbox output generation failed: ${result.stderr}`)
  for (const [output, { sentinelPath, sentinel }] of expected) {
    assert.equal(
      readFileSync(sentinelPath, 'utf8'),
      sentinel,
      `${output} changed its external target`,
    )
    assert.equal(
      lstatSync(join(sandboxRoot, output)).isSymbolicLink(),
      false,
      `${output} symlink was not replaced`,
    )
  }
  const generatedRun = readFileSync(join(sandboxRoot, 'run-test.sh'), 'utf8')
  const generatedLauncher = readFileSync(join(sandboxRoot, 'start-pantheon.sh'), 'utf8')
  assert.equal(statSync(join(sandboxRoot, 'run-test.sh')).mode & 0o777, 0o755)
  assert.equal(statSync(join(sandboxRoot, 'start-pantheon.sh')).mode & 0o777, 0o755)
  assert.equal(statSync(join(sandboxRoot, 'README.md')).mode & 0o777, 0o644)
  assert.equal(statSync(join(sandboxRoot, '.prompt-extract-json.py')).mode & 0o777, 0o644)
  assert.doesNotMatch(generatedRun, /\$\{PANTHEON_V2_DB/)
  assert.match(generatedRun, /V2_DB="\$SANDBOX_DIR\/opencode-v2\.db"/)
  assert.doesNotMatch(generatedLauncher, /\$\{PANTHEON_V2_DB/)
  assert.match(generatedLauncher, /OPENCODE_DB="\$SANDBOX_DIR\/opencode-v2\.db"/)
})

test('failed atomic sandbox output replacement removes its temporary file', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-atomic-failure-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const definitions = loadDefinitions(join(workDir, 'definitions.sh'))
  const sandboxRoot = join(workDir, 'sandbox')
  mkdirSync(sandboxRoot, { recursive: true })
  const result = spawnSync(
    'bash',
    [
      '-c',
      'set -euo pipefail; source "$RUNNER_DEFS"; temporary=$(mktemp "$TEST_SANDBOX/.failed-output.XXXXXX"); printf partial > "$temporary"; atomic_replace_file "$temporary" "$TEST_SANDBOX/missing/output" 0644',
    ],
    {
      encoding: 'utf8',
      env: { ...withoutEnv(), RUNNER_DEFS: definitions, TEST_SANDBOX: sandboxRoot },
    },
  )
  assert.notEqual(result.status, 0, 'replacement into a missing parent must fail')
  assert.deepEqual(readdirSync(sandboxRoot), [], 'failed output replacement leaked a temp file')
})

test('sandbox package installation packs to an isolated temp dir and preserves a checkout tarball', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-pack-isolated-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const definitions = loadDefinitions(join(workDir, 'definitions.sh'))
  const sandboxRoot = join(workDir, 'sandbox')
  const repo = join(workDir, 'repo')
  const stubBin = join(workDir, 'stub-bin')
  const packageVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const tarballName = `pantheon-opencode-${packageVersion}.tgz`
  const preexistingTarball = join(repo, tarballName)
  const sentinel = 'preexisting checkout tarball: keep bytes\n'
  mkdirSync(sandboxRoot, { recursive: true })
  mkdirSync(repo, { recursive: true })
  mkdirSync(stubBin, { recursive: true })
  writeFileSync(preexistingTarball, sentinel)
  writeFileSync(
    join(stubBin, 'npm'),
    `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  pack)
    destination=""
    expect_destination=0
    has_json=0
    for arg in "$@"; do
      if [ "$expect_destination" = 1 ]; then destination="$arg"; expect_destination=0; continue; fi
      [ "$arg" = --json ] && has_json=1 || true
      [ "$arg" = --pack-destination ] && expect_destination=1 || true
    done
    [ "$has_json" = 1 ] && [ -n "$destination" ] || exit 8
    mkdir -p "$destination"
    printf 'owned tarball\\n' > "$destination/${tarballName}"
    printf '[{"filename":"${tarballName}"}]\\n'
    ;;
  rm) ;;
  install) printf '%s\\n' "$*" >> "$NPM_CALL_LOG" ;;
  *) exit 9 ;;
esac
`,
    { mode: 0o755 },
  )
  const callLog = join(workDir, 'npm-calls.log')

  const result = spawnSync(
    'bash',
    [
      '-c',
      'set -euo pipefail; source "$RUNNER_DEFS"; SANDBOX_ROOT="$TEST_SANDBOX"; REPO_DIR="$TEST_REPO"; install_binaries',
    ],
    {
      encoding: 'utf8',
      env: {
        ...withoutEnv(),
        HOME: join(workDir, 'home'),
        NPM_CALL_LOG: callLog,
        PATH: `${stubBin}:${process.env.PATH}`,
        RUNNER_DEFS: definitions,
        TEST_REPO: repo,
        TEST_SANDBOX: sandboxRoot,
      },
    },
  )

  assert.equal(result.status, 0, `isolated package installation failed: ${result.stderr}`)
  assert.equal(readFileSync(preexistingTarball, 'utf8'), sentinel)
  const calls = readFileSync(callLog, 'utf8')
  const installLines = calls.split(/\r?\n/).filter((line) => line.startsWith('install '))
  const installTarget = installLines[0]?.split(' ')[2]
  assert.ok(installTarget?.startsWith(join(sandboxRoot, '.pantheon-npm-pack.')))
  assert.ok(installTarget?.endsWith(`/${tarballName}`))
  assert.notEqual(installTarget, preexistingTarball)
  assert.deepEqual(readdirSync(sandboxRoot), [], 'owned pack artifacts should be cleaned')
  assert.equal(
    installLines.length,
    2,
    'Pantheon tarball and OpenCode package should both be installed',
  )
})

test('generated run-test executes its isolated npm pack path and preserves a checkout tarball', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-generated-pack-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const sandboxRoot = join(workDir, 'sandbox')
  const repo = join(workDir, 'repo')
  const stubBin = join(workDir, 'stub-bin')
  const prefixBin = join(sandboxRoot, 'home', '.npm-global', 'bin')
  const packageVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const tarballName = `pantheon-opencode-${packageVersion}.tgz`
  const preexistingTarball = join(repo, tarballName)
  const sentinel = 'generated-runner checkout tarball sentinel\n'
  const calls = join(workDir, 'generated-npm-calls.log')
  const externalConfig = join(workDir, 'external-config')
  mkdirSync(repo, { recursive: true })
  mkdirSync(stubBin, { recursive: true })
  mkdirSync(prefixBin, { recursive: true })
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'pantheon-opencode', version: packageVersion }),
  )
  writeFileSync(preexistingTarball, sentinel)
  writeFileSync(join(prefixBin, 'opencode2'), '#!/usr/bin/env bash\necho "opencode2 fixture"\n', {
    mode: 0o755,
  })
  writeFileSync(join(prefixBin, 'pantheon-opencode'), '#!/usr/bin/env bash\nexit 42\n', {
    mode: 0o755,
  })
  writeFileSync(
    join(stubBin, 'npm'),
    `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  pack)
    destination=""
    expect_destination=0
    for arg in "$@"; do
      if [ "$expect_destination" = 1 ]; then destination="$arg"; expect_destination=0; continue; fi
      [ "$arg" = --pack-destination ] && expect_destination=1 || true
    done
    [ -n "$destination" ] || exit 8
    mkdir -p "$destination"
    printf 'owned generated tarball\\n' > "$destination/${tarballName}"
    printf '[{"filename":"${tarballName}"}]\\n'
    printf 'pack|%s|%s|%s|%s|%s|%s\\n' "$destination" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_STATE_HOME" "$XDG_CACHE_HOME" "$npm_config_cache" >> "$NPM_CALL_LOG"
    mkdir -p "$XDG_CONFIG_HOME/opencode"
    printf generated > "$XDG_CONFIG_HOME/opencode/generated-runner-probe"
    ;;
  rm) ;;
  install) printf 'install|%s\\n' "$3" >> "$NPM_CALL_LOG" ;;
  *) exit 9 ;;
esac
`,
    { mode: 0o755 },
  )

  const generated = generate(repo, sandboxRoot, join(workDir, 'definitions.sh'))
  const result = spawnSync('bash', [generated], {
    encoding: 'utf8',
    env: {
      ...withoutEnv(),
      HOME: join(workDir, 'host-home'),
      XDG_CONFIG_HOME: externalConfig,
      XDG_DATA_HOME: join(workDir, 'external-data'),
      XDG_STATE_HOME: join(workDir, 'external-state'),
      XDG_CACHE_HOME: join(workDir, 'external-cache'),
      OPENCODE_CONFIG_DIR: externalConfig,
      OPENCODE_DB: join(workDir, 'external.db'),
      PATH: `${stubBin}:${process.env.PATH}`,
      NPM_CALL_LOG: calls,
    },
    timeout: 15000,
  })

  assert.equal(
    result.status,
    42,
    `runner should stop at fixture init after installing: ${result.stderr}`,
  )
  assert.equal(readFileSync(preexistingTarball, 'utf8'), sentinel)
  const lines = readFileSync(calls, 'utf8').trim().split('\n')
  const pack = lines.find((line) => line.startsWith('pack|'))?.split('|')
  const installedTarball = lines
    .find((line) => line.startsWith('install|'))
    ?.slice('install|'.length)
  assert.ok(pack?.[1].startsWith(join(sandboxRoot, '.pantheon-npm-pack.')))
  assert.deepEqual(pack?.slice(2), [
    join(sandboxRoot, 'home', '.config'),
    join(sandboxRoot, 'home', '.local', 'share'),
    join(sandboxRoot, 'home', '.local', 'state'),
    join(sandboxRoot, 'home', '.cache'),
    join(sandboxRoot, 'home', '.npm-cache'),
  ])
  assert.equal(installedTarball, join(pack[1], tarballName))
  assert.notEqual(installedTarball, preexistingTarball)
  assert.equal(existsSync(join(externalConfig, 'opencode', 'generated-runner-probe')), false)
  assert.equal(
    existsSync(join(sandboxRoot, 'home', '.config', 'opencode', 'generated-runner-probe')),
    true,
  )
  assert.equal(
    readdirSync(sandboxRoot).some((name) => name.startsWith('.pantheon-npm-pack.')),
    false,
    'generated run-test leaked npm pack artifacts',
  )
})

test('generated run-test executes the post-init V2 config rewrite with stubbed commands', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-generated-rewrite-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const sandboxRoot = join(workDir, 'sandbox')
  const project = join(sandboxRoot, 'project-v2')
  const repo = join(workDir, 'repo')
  const stubBin = join(workDir, 'stub-bin')
  const prefixBin = join(sandboxRoot, 'home', '.npm-global', 'bin')
  const packageVersion = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const tarballName = `pantheon-opencode-${packageVersion}.tgz`
  mkdirSync(repo, { recursive: true })
  mkdirSync(stubBin, { recursive: true })
  mkdirSync(prefixBin, { recursive: true })
  mkdirSync(project, { recursive: true })
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'pantheon-opencode', version: packageVersion }),
  )

  writeFileSync(
    join(stubBin, 'npm'),
    `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  pack)
    destination=""
    expect_destination=0
    for arg in "$@"; do
      if [ "$expect_destination" = 1 ]; then destination="$arg"; expect_destination=0; continue; fi
      [ "$arg" = --pack-destination ] && expect_destination=1 || true
    done
    [ -n "$destination" ] || exit 8
    mkdir -p "$destination"
    printf 'fixture tarball\\n' > "$destination/${tarballName}"
    printf '[{"filename":"${tarballName}"}]\\n'
    ;;
  rm|install) ;;
  *) exit 9 ;;
esac
`,
    { mode: 0o755 },
  )
  writeFileSync(
    join(prefixBin, 'pantheon-opencode'),
    `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  init)
    mkdir -p "$PWD/.opencode/scripts" "$PWD/.venv/bin"
    cat > "$PWD/opencode.json" <<'JSON'
{"mcp":{"pantheon-memory":{"disabled":true}}}
JSON
    chmod 0640 "$PWD/opencode.json"
    printf '#!/bin/sh\\nexit 0\\n' > "$PWD/.venv/bin/python3"
    chmod 0755 "$PWD/.venv/bin/python3"
    for script in code_mode.py memory_mcp.py mcp_persistence.py mcp_resources.py pantheon_vision.py; do
      printf '# fixture\\n' > "$PWD/.opencode/scripts/$script"
    done
    ;;
  doctor) exit 0 ;;
  *) exit 0 ;;
esac
`,
    { mode: 0o755 },
  )
  writeFileSync(
    join(prefixBin, 'opencode2'),
    `#!/usr/bin/env bash
case "\${1:-}" in
  --version) echo 'opencode2 fixture' ;;
  serve) exit 0 ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o755 },
  )

  const listener = createServer()
  await new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolve)
  })
  const address = listener.address()
  assert.ok(address && typeof address === 'object')
  const port = address.port
  await new Promise((resolve) => listener.close(resolve))

  const generated = generate(repo, sandboxRoot, join(workDir, 'definitions.sh'))
  const result = spawnSync('bash', [generated], {
    cwd: project,
    encoding: 'utf8',
    env: {
      ...withoutEnv(),
      HOME: join(workDir, 'host-home'),
      PATH: `${stubBin}:${process.env.PATH}`,
      PANTHEON_V2_HANDSHAKE_TIMEOUT: '1',
      PANTHEON_V2_PORT: String(port),
    },
    timeout: 15000,
  })

  assert.equal(
    result.status,
    1,
    `fixture runner should reach its intentionally failing MCP probe:\n${result.stdout}\n${result.stderr}`,
  )
  assert.match(result.stdout, /--- MCP Validation ---/, 'run-test must pass through config rewrite')
  assert.doesNotMatch(result.stderr, /NameError|tempfile|stat\.S_IMODE/)
  const configPath = join(project, 'opencode.json')
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const python = join(project, '.venv', 'bin', 'python3')
  const runtime = join(project, '.opencode')
  const expectedScripts = {
    'pantheon-code-mode': 'code_mode.py',
    'pantheon-memory': 'memory_mcp.py',
    'pantheon-persistence': 'mcp_persistence.py',
    'pantheon-resources': 'mcp_resources.py',
    'pantheon-vision': 'pantheon_vision.py',
  }
  for (const [name, script] of Object.entries(expectedScripts)) {
    assert.deepEqual(config.mcp[name], {
      type: 'local',
      cwd: runtime,
      command: [python, `scripts/${script}`],
      enabled: true,
    })
  }
  assert.equal(statSync(configPath).mode & 0o777, 0o640, 'rewrite should retain config mode')
  assert.deepEqual(
    readdirSync(project).filter((name) => name.startsWith('.opencode.json.')),
    [],
    'config rewrite must clean its temporary file',
  )
})

test('main and generated npm pack paths execute real npm pack without overwriting checkout tarballs', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-real-pack-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const realNpm = spawnSync('bash', ['-c', 'command -v npm'], { encoding: 'utf8' }).stdout.trim()
  assert.ok(realNpm, 'npm must be available to exercise its pack command')
  const definitions = loadDefinitions(join(workDir, 'definitions.sh'))
  const repo = join(workDir, 'repo')
  const stubBin = join(workDir, 'stub-bin')
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const tarballName = `pantheon-opencode-${version}.tgz`
  const checkoutTarball = join(repo, tarballName)
  const sentinel = 'do not replace this checkout tarball\n'
  const calls = join(workDir, 'npm-install-calls.log')
  mkdirSync(repo, { recursive: true })
  mkdirSync(stubBin, { recursive: true })
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({ name: 'pantheon-opencode', version, description: 'temporary pack fixture' }),
  )
  writeFileSync(checkoutTarball, sentinel)
  writeFileSync(
    join(stubBin, 'npm'),
    `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  pack) exec "$REAL_NPM" "$@" ;;
  rm) ;;
  install) printf '%s\\n' "$3" >> "$NPM_CALL_LOG" ;;
  *) exit 9 ;;
esac
`,
    { mode: 0o755 },
  )
  const tempHome = join(workDir, 'npm-home')
  const cache = join(workDir, 'npm-cache')
  const mainSandbox = join(workDir, 'main-sandbox')
  mkdirSync(mainSandbox, { recursive: true })

  const main = spawnSync(
    'bash',
    [
      '-c',
      'set -euo pipefail; source "$RUNNER_DEFS"; REPO_DIR="$TEST_REPO"; SANDBOX_ROOT="$TEST_SANDBOX"; install_binaries',
    ],
    {
      encoding: 'utf8',
      env: {
        ...withoutEnv('PANTHEON_REPO'),
        HOME: tempHome,
        PATH: `${stubBin}:${process.env.PATH}`,
        REAL_NPM: realNpm,
        NPM_CALL_LOG: calls,
        npm_config_cache: cache,
        RUNNER_DEFS: definitions,
        TEST_REPO: repo,
        TEST_SANDBOX: mainSandbox,
      },
      timeout: 30000,
    },
  )
  assert.equal(main.status, 0, `main real npm pack path failed:\n${main.stdout}\n${main.stderr}`)
  assert.equal(readFileSync(checkoutTarball, 'utf8'), sentinel)
  const mainInstall = readFileSync(calls, 'utf8').trim().split('\n')[0]
  assert.ok(mainInstall.startsWith(join(mainSandbox, '.pantheon-npm-pack.')))
  assert.ok(mainInstall.endsWith(`/${tarballName}`))
  assert.deepEqual(readdirSync(mainSandbox), [], 'main pack temp artifacts should be removed')

  const generatedSandbox = join(workDir, 'generated-sandbox')
  const prefixBin = join(generatedSandbox, 'home', '.npm-global', 'bin')
  mkdirSync(prefixBin, { recursive: true })
  writeFileSync(join(prefixBin, 'opencode2'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(prefixBin, 'pantheon-opencode'), '#!/usr/bin/env bash\nexit 42\n', {
    mode: 0o755,
  })
  const generated = generate(repo, generatedSandbox, join(workDir, 'generated-definitions.sh'))
  const generatedResult = spawnSync('bash', [generated], {
    encoding: 'utf8',
    env: {
      ...withoutEnv('PANTHEON_REPO'),
      HOME: tempHome,
      PATH: `${stubBin}:${process.env.PATH}`,
      REAL_NPM: realNpm,
      NPM_CALL_LOG: calls,
      npm_config_cache: cache,
    },
    timeout: 30000,
  })
  assert.equal(
    generatedResult.status,
    42,
    `generated real npm pack path should reach fixture init:\n${generatedResult.stdout}\n${generatedResult.stderr}`,
  )
  assert.equal(readFileSync(checkoutTarball, 'utf8'), sentinel)
  const installs = readFileSync(calls, 'utf8').trim().split('\n')
  const generatedInstall = installs[2]
  assert.ok(generatedInstall.startsWith(join(generatedSandbox, '.pantheon-npm-pack.')))
  assert.ok(generatedInstall.endsWith(`/${tarballName}`))
  assert.deepEqual(
    readdirSync(generatedSandbox).filter((name) => name.startsWith('.pantheon-npm-pack.')),
    [],
    'generated pack temp artifacts should be removed',
  )
})

test('generated run-test rejects project/config/database symlinks before npm pack', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-generated-links-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const repo = join(workDir, 'repo')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'package.json'), '{"name":"pantheon-opencode"}\n')

  for (const kind of ['project', 'config', 'database']) {
    const sandboxRoot = join(workDir, `sandbox-${kind}`)
    mkdirSync(sandboxRoot, { recursive: true })
    const generated = generate(repo, sandboxRoot, join(workDir, `definitions-${kind}.sh`))
    const external = join(workDir, `external-${kind}`)
    let externalSentinel = external
    if (kind === 'project') {
      mkdirSync(external, { recursive: true })
      externalSentinel = join(external, 'opencode.json')
      writeFileSync(externalSentinel, `keep ${kind} sentinel\n`)
      symlinkSync(external, join(sandboxRoot, 'project-v2'))
    } else {
      writeFileSync(external, `keep ${kind} sentinel\n`)
      mkdirSync(join(sandboxRoot, 'project-v2'), { recursive: true })
      if (kind === 'config') {
        symlinkSync(external, join(sandboxRoot, 'project-v2', 'opencode.json'))
      } else {
        symlinkSync(external, join(sandboxRoot, 'opencode-v2.db'))
      }
    }

    const result = spawnSync('bash', [generated], {
      encoding: 'utf8',
      env: withoutEnv('PANTHEON_REPO'),
      timeout: 15000,
    })
    assert.notEqual(result.status, 0, `${kind} symlink must fail before package installation`)
    assert.match(result.stderr, /symlink/i)
    assert.equal(readFileSync(externalSentinel, 'utf8'), `keep ${kind} sentinel\n`)
  }
})

test('--reset refuses a sandbox root inside any repo it can act on', () => {
  const src = readFileSync(RUNNER, 'utf8')
  // The guard previously covered only the default REPO_DIR while the generated
  // script honoured PANTHEON_REPO, so an override could name a checkout and
  // have a tarball packed into it.
  assert.match(
    src,
    /for protected in "\$REPO_DIR" "\$\{PANTHEON_REPO:-\}"/,
    '--reset must guard both REPO_DIR and the PANTHEON_REPO override',
  )
})

function runReset(sandboxRoot, protectedRepo, extraEnv = {}) {
  mkdirSync(protectedRepo, { recursive: true })
  if (!existsSync(join(protectedRepo, 'package.json'))) {
    writeFileSync(join(protectedRepo, 'package.json'), '{"name":"pantheon-opencode"}\n')
  }
  return spawnSync('bash', [RUNNER, '--reset'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv,
      PANTHEON_SANDBOX_ROOT: sandboxRoot,
      PANTHEON_REPO: protectedRepo,
    },
    timeout: 15000,
  })
}

test('--reset refuses an ancestor of a protected repo before deleting its sentinel', (t) => {
  const sandboxParent = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-reset-ancestor-'))
  t.after(() => rmSync(sandboxParent, { recursive: true, force: true }))
  const syntheticRepo = join(sandboxParent, 'nested', 'synthetic-repo')
  mkdirSync(join(syntheticRepo, '.git'), { recursive: true })
  const sentinel = join(syntheticRepo, 'uncommitted-work-sentinel')
  writeFileSync(sentinel, 'keep')

  // This is an isolated temp directory, not /tmp or a shared repository path.
  // The actual runner is exercised, with the synthetic nested repo supplied as
  // its protected PANTHEON_REPO override.
  const result = runReset(sandboxParent, syntheticRepo)
  const checks = {
    nonzeroExit: result.status !== 0,
    sandboxRootSurvived: existsSync(sandboxParent),
    sentinelSurvived: existsSync(sentinel),
  }
  assert.deepEqual(
    checks,
    { nonzeroExit: true, sandboxRootSurvived: true, sentinelSurvived: true },
    `reset must reject the ancestor before deletion; got ${JSON.stringify(checks)}\n${result.stdout}\n${result.stderr}`,
  )
  assert.match(result.stderr, /refusing to reset unsafe sandbox root/i)
})

test('--reset refuses a sandbox root that is an ancestor of canonical HOME', (t) => {
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-reset-home-ancestor-'))
  t.after(() => rmSync(sandboxRoot, { recursive: true, force: true }))
  const syntheticHome = join(sandboxRoot, 'synthetic-home')
  mkdirSync(syntheticHome, { recursive: true })
  const sentinel = join(syntheticHome, 'keep-me')
  writeFileSync(sentinel, 'synthetic HOME sentinel')

  const result = spawnSync('bash', [RUNNER, '--reset'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PANTHEON_SANDBOX_ROOT: sandboxRoot,
      PANTHEON_REPO: '',
      HOME: syntheticHome,
    },
    timeout: 15000,
  })
  const checks = {
    nonzeroExit: result.status !== 0,
    sandboxRootSurvived: existsSync(sandboxRoot),
    sentinelSurvived: existsSync(sentinel),
  }
  assert.deepEqual(
    checks,
    { nonzeroExit: true, sandboxRootSurvived: true, sentinelSurvived: true },
    `reset must reject an ancestor of HOME before deletion; got ${JSON.stringify(checks)}\n${result.stdout}\n${result.stderr}`,
  )
  assert.match(result.stderr, /refusing to reset unsafe sandbox root/i)
})

test('--reset protects global OpenCode config/data paths and their ancestors', (t) => {
  const tempParent = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-reset-opencode-global-'))
  t.after(() => rmSync(tempParent, { recursive: true, force: true }))
  const home = join(tempParent, 'home')
  const xdgConfigHome = join(tempParent, 'xdg-config')
  const xdgDataHome = join(tempParent, 'xdg-data')
  const xdgStateHome = join(tempParent, 'xdg-state')
  const xdgCacheHome = join(tempParent, 'xdg-cache')
  const protectedRepo = join(tempParent, 'repo')
  mkdirSync(join(protectedRepo, '.git'), { recursive: true })
  const targets = [
    join(home, '.config', 'opencode'),
    join(home, '.config'),
    join(home, '.opencode'),
    join(xdgConfigHome, 'opencode'),
    xdgConfigHome,
    join(xdgDataHome, 'opencode'),
    xdgDataHome,
    join(xdgStateHome, 'opencode'),
    xdgStateHome,
    join(xdgCacheHome, 'opencode'),
    xdgCacheHome,
  ]

  for (const [index, sandboxRoot] of targets.entries()) {
    mkdirSync(sandboxRoot, { recursive: true })
    const sentinel = join(sandboxRoot, `global-sentinel-${index}`)
    writeFileSync(sentinel, 'keep global OpenCode state')
    const result = runReset(sandboxRoot, protectedRepo, {
      HOME: home,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_STATE_HOME: xdgStateHome,
      XDG_CACHE_HOME: xdgCacheHome,
    })
    assert.notEqual(
      result.status,
      0,
      `reset must reject protected global path ${sandboxRoot}:\n${result.stdout}\n${result.stderr}`,
    )
    assert.equal(existsSync(sentinel), true, `global sentinel was deleted under ${sandboxRoot}`)
  }
})

test('--reset rejects final OPENCODE_CONFIG and OPENCODE_DB symlinks before deleting targets', (t) => {
  const tempParent = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-reset-file-symlink-'))
  t.after(() => rmSync(tempParent, { recursive: true, force: true }))
  const sandboxRoot = join(tempParent, 'sandbox')
  const externalDir = join(tempParent, 'external')
  const protectedRepo = join(tempParent, 'repo')
  const home = join(tempParent, 'home')
  mkdirSync(sandboxRoot, { recursive: true })
  mkdirSync(externalDir, { recursive: true })
  mkdirSync(join(protectedRepo, '.git'), { recursive: true })

  const cases = [
    {
      name: 'absolute OPENCODE_CONFIG target inside sandbox',
      variable: 'OPENCODE_CONFIG',
      target: join(sandboxRoot, 'config-absolute-sentinel'),
      targetExists: true,
    },
    {
      name: 'relative OPENCODE_DB target with dot-dot inside sandbox',
      variable: 'OPENCODE_DB',
      target: '../sandbox/db-relative-sentinel',
      targetPath: join(sandboxRoot, 'db-relative-sentinel'),
      targetExists: true,
    },
    {
      name: 'dangling relative OPENCODE_CONFIG symlink',
      variable: 'OPENCODE_CONFIG',
      target: '../sandbox/missing-config-target',
      targetExists: false,
    },
    {
      name: 'dangling absolute OPENCODE_DB symlink',
      variable: 'OPENCODE_DB',
      target: join(sandboxRoot, 'missing-db-target'),
      targetExists: false,
    },
  ]

  for (const [index, scenario] of cases.entries()) {
    const targetPath = scenario.targetPath ?? scenario.target
    const linkPath = join(externalDir, `override-${index}`)
    const sandboxSentinel = join(sandboxRoot, `sandbox-sentinel-${index}`)
    const targetContents = `keep target for ${scenario.name}`
    writeFileSync(sandboxSentinel, `keep sandbox for ${scenario.name}`)
    if (scenario.targetExists) writeFileSync(targetPath, targetContents)
    symlinkSync(scenario.target, linkPath, 'file')

    const result = runReset(sandboxRoot, protectedRepo, {
      HOME: home,
      OPENCODE_CONFIG: scenario.variable === 'OPENCODE_CONFIG' ? linkPath : '',
      OPENCODE_DB: scenario.variable === 'OPENCODE_DB' ? linkPath : '',
    })

    assert.notEqual(
      result.status,
      0,
      `reset must reject ${scenario.name}:\n${result.stdout}\n${result.stderr}`,
    )
    assert.match(result.stderr, /symbolic link|symlink/i, `${scenario.name} should be identified`)
    assert.equal(existsSync(sandboxSentinel), true, `${scenario.name} deleted the sandbox`)
    assert.equal(
      readFileSync(sandboxSentinel, 'utf8'),
      `keep sandbox for ${scenario.name}`,
      `${scenario.name} changed the sandbox sentinel`,
    )
    if (scenario.targetExists) {
      assert.equal(
        readFileSync(targetPath, 'utf8'),
        targetContents,
        `${scenario.name} deleted or changed its canonical target`,
      )
    }
  }
})

test('--reset protects every colon-separated XDG config/data directory and opencode child', (t) => {
  const tempParent = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-reset-xdg-list-'))
  t.after(() => rmSync(tempParent, { recursive: true, force: true }))
  const protectedRepo = join(tempParent, 'protected-repo')
  const home = join(tempParent, 'synthetic-home')
  mkdirSync(join(protectedRepo, '.git'), { recursive: true })
  const cases = [
    {
      name: 'second config entry opencode child',
      variable: 'XDG_CONFIG_DIRS',
      entries: [join(tempParent, 'config-first'), join(tempParent, 'config-second')],
      sandboxRoot: join(tempParent, 'config-second', 'opencode'),
      sentinel: join(tempParent, 'config-second', 'opencode', 'keep'),
    },
    {
      name: 'data entry itself',
      variable: 'XDG_DATA_DIRS',
      entries: [join(tempParent, 'data-first'), join(tempParent, 'data-second')],
      sandboxRoot: join(tempParent, 'data-first'),
      sentinel: join(tempParent, 'data-first', 'keep'),
    },
    {
      name: 'config-list ancestor',
      variable: 'XDG_CONFIG_DIRS',
      entries: [join(tempParent, 'config-list-root', 'entry')],
      sandboxRoot: join(tempParent, 'config-list-root'),
      sentinel: join(tempParent, 'config-list-root', 'entry', 'opencode', 'keep'),
    },
    {
      name: 'data opencode descendant',
      variable: 'XDG_DATA_DIRS',
      entries: [join(tempParent, 'data-descendant-entry')],
      sandboxRoot: join(tempParent, 'data-descendant-entry', 'opencode', 'nested'),
      sentinel: join(tempParent, 'data-descendant-entry', 'opencode', 'nested', 'keep'),
    },
  ]

  for (const { name, variable, entries, sandboxRoot, sentinel } of cases) {
    mkdirSync(sandboxRoot, { recursive: true })
    mkdirSync(dirname(sentinel), { recursive: true })
    writeFileSync(sentinel, `external ${name} sentinel`)
    const pathList =
      variable === 'XDG_CONFIG_DIRS' ? `:${entries.join('::')}:` : `${entries.join(':')}:`
    const result = runReset(sandboxRoot, protectedRepo, {
      HOME: home,
      XDG_CONFIG_HOME: join(tempParent, 'separate-config-home'),
      XDG_DATA_HOME: join(tempParent, 'separate-data-home'),
      XDG_STATE_HOME: join(tempParent, 'separate-state-home'),
      XDG_CACHE_HOME: join(tempParent, 'separate-cache-home'),
      [variable]: pathList,
    })
    assert.notEqual(
      result.status,
      0,
      `reset must reject ${name}:\n${result.stdout}\n${result.stderr}`,
    )
    assert.equal(existsSync(sentinel), true, `${name} sentinel was deleted`)
  }
})

test('--reset cannot bypass repo protection with dot-dot path components', (t) => {
  const tempParent = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-reset-dotdot-'))
  t.after(() => rmSync(tempParent, { recursive: true, force: true }))
  const protectedRepo = join(tempParent, 'repo')
  mkdirSync(join(protectedRepo, '.git'), { recursive: true })
  const sentinel = join(protectedRepo, 'uncommitted-work-sentinel')
  writeFileSync(sentinel, 'keep')

  const result = runReset(join(protectedRepo, 'child', '..'), protectedRepo)
  assert.notEqual(result.status, 0, 'canonical repo path must still be protected')
  assert.equal(existsSync(sentinel), true, 'dot-dot reset attempt must preserve repo sentinel')
})

test('--reset permits the default sandbox root nested below HOME', (t) => {
  const tempParent = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-reset-home-child-'))
  t.after(() => rmSync(tempParent, { recursive: true, force: true }))
  const syntheticHome = join(tempParent, 'synthetic-home')
  const defaultSandboxRoot = join(syntheticHome, 'pantheon-sandbox')
  mkdirSync(defaultSandboxRoot, { recursive: true })
  const homeSentinel = join(syntheticHome, 'keep-me')
  const sandboxSentinel = join(defaultSandboxRoot, 'remove-me')
  writeFileSync(homeSentinel, 'synthetic HOME sentinel')
  writeFileSync(sandboxSentinel, 'sandbox content')

  const result = spawnSync('bash', [RUNNER, '--reset'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PANTHEON_SANDBOX_ROOT: '',
      PANTHEON_REPO: '',
      HOME: syntheticHome,
    },
    timeout: 15000,
  })

  assert.equal(
    result.status,
    0,
    `default sandbox reset failed:\n${result.stdout}\n${result.stderr}`,
  )
  assert.equal(existsSync(defaultSandboxRoot), false, 'default sandbox should be removed')
  assert.equal(existsSync(homeSentinel), true, 'synthetic HOME must remain intact')
  assert.equal(existsSync(sandboxSentinel), false, 'sandbox content should be removed')
})

test('--reset refuses a protected repo itself and sandbox roots inside it', (t) => {
  const tempParent = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-reset-contained-'))
  t.after(() => rmSync(tempParent, { recursive: true, force: true }))
  const protectedRepo = join(tempParent, 'synthetic-repo')
  mkdirSync(join(protectedRepo, '.git'), { recursive: true })
  const sentinel = join(protectedRepo, 'uncommitted-work-sentinel')
  writeFileSync(sentinel, 'keep')

  for (const sandboxRoot of [protectedRepo, join(protectedRepo, 'sandbox-child')]) {
    mkdirSync(sandboxRoot, { recursive: true })
    const result = runReset(sandboxRoot, protectedRepo)
    assert.notEqual(
      result.status,
      0,
      `reset must reject ${sandboxRoot}:\n${result.stdout}\n${result.stderr}`,
    )
    assert.equal(existsSync(sentinel), true, 'protected repo sentinel must survive')
  }
})

test('--reset still allows a safe sandbox root below its temporary parent', (t) => {
  const tempParent = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-reset-safe-'))
  t.after(() => rmSync(tempParent, { recursive: true, force: true }))
  const protectedRepo = join(tempParent, 'repos', 'synthetic-repo')
  const sandboxRoot = join(tempParent, 'sandboxes', 'pantheon-sandbox')
  mkdirSync(join(protectedRepo, '.git'), { recursive: true })
  mkdirSync(sandboxRoot, { recursive: true })
  const protectedSentinel = join(protectedRepo, 'keep')
  writeFileSync(protectedSentinel, 'keep')
  writeFileSync(join(sandboxRoot, 'remove-me'), 'reset this sandbox')

  const result = runReset(sandboxRoot, protectedRepo)
  assert.equal(result.status, 0, `safe reset failed:\n${result.stdout}\n${result.stderr}`)
  assert.equal(existsSync(sandboxRoot), false, 'safe sandbox root should be removed')
  assert.equal(existsSync(protectedSentinel), true, 'protected repo must remain untouched')
})

test('generated run-test defaults MCP list timeout to 15 with no inherited env', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-timeout-default-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const repoDir = join(workDir, 'repo')
  const sandboxRoot = join(workDir, 'sandbox')
  mkdirSync(repoDir, { recursive: true })
  writeFileSync(join(repoDir, 'package.json'), '{"name":"pantheon-opencode"}\n')
  mkdirSync(sandboxRoot, { recursive: true })
  const generated = generate(repoDir, sandboxRoot, join(workDir, 'definitions.sh'))
  const generatedSource = readFileSync(generated, 'utf8')
  assert.match(RUNNER_SRC, /V2_MCP_LIST_TIMEOUT="\$\{PANTHEON_V2_MCP_LIST_TIMEOUT:-15\}"/)
  const executionPrefix = generatedSource.slice(
    0,
    generatedSource.indexOf('echo "=== Pantheon Sandbox Test'),
  )
  assert.notEqual(executionPrefix.length, 0, 'generated run-test bootstrap is missing')
  const prefixFile = join(sandboxRoot, '.timeout-probe.sh')
  writeFileSync(prefixFile, `${executionPrefix}\nprintf "%s" "$V2_MCP_LIST_TIMEOUT"\n`, {
    mode: 0o755,
  })
  const env = withoutEnv('PANTHEON_V2_MCP_LIST_TIMEOUT', 'PANTHEON_V2_PORT', 'PORT')
  const result = spawnSync('bash', [prefixFile], { encoding: 'utf8', env })
  assert.equal(result.status, 0, `generated bootstrap failed under set -u: ${result.stderr}`)
  assert.equal(result.stdout, '15')

  const resetRoot = join(workDir, 'reset-root')
  mkdirSync(resetRoot)
  writeFileSync(join(resetRoot, 'sentinel'), 'preserve')
  const reset = spawnSync('bash', [RUNNER, '--reset'], {
    encoding: 'utf8',
    env: {
      ...withoutEnv('PANTHEON_V2_MCP_LIST_TIMEOUT', 'PANTHEON_REPO'),
      PANTHEON_SANDBOX_ROOT: resetRoot,
      HOME: join(workDir, 'synthetic-home'),
    },
  })
  assert.equal(reset.status, 0, `--reset should work without timeout env: ${reset.stderr}`)
  assert.equal(existsSync(resetRoot), false)
})

test('generated run-test rejects dangling .repo-dir and PANTHEON_REPO before packing', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-dangling-repo-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const repoDir = join(workDir, 'repo')
  const sandboxRoot = join(workDir, 'sandbox')
  mkdirSync(repoDir, { recursive: true })
  writeFileSync(join(repoDir, 'package.json'), '{"name":"pantheon-opencode"}\n')
  mkdirSync(sandboxRoot, { recursive: true })
  const generated = generate(repoDir, sandboxRoot, join(workDir, 'definitions.sh'))

  writeFileSync(join(sandboxRoot, '.repo-dir'), `${join(workDir, 'missing-default')}\n`)
  const danglingDefault = spawnSync('bash', [generated], {
    encoding: 'utf8',
    env: withoutEnv('PANTHEON_REPO'),
  })
  assert.notEqual(danglingDefault.status, 0)
  assert.match(
    danglingDefault.stderr,
    /repository path .*does not exist|cannot resolve.*repository/i,
  )

  writeFileSync(join(sandboxRoot, '.repo-dir'), `${repoDir}\n`)
  const danglingOverride = spawnSync('bash', [generated], {
    encoding: 'utf8',
    env: { ...withoutEnv(), PANTHEON_REPO: join(workDir, 'missing-override') },
  })
  assert.notEqual(danglingOverride.status, 0)
  assert.match(
    danglingOverride.stderr,
    /repository path .*does not exist|cannot resolve.*repository/i,
  )

  const relativeOverride = spawnSync('bash', [generated], {
    encoding: 'utf8',
    env: { ...withoutEnv(), PANTHEON_REPO: 'relative/checkout' },
  })
  assert.notEqual(relativeOverride.status, 0)
  assert.match(relativeOverride.stderr, /repository path must be absolute/i)

  const nestedSandbox = join(repoDir, 'generated-sandbox')
  mkdirSync(nestedSandbox, { recursive: true })
  const nestedRunner = generate(repoDir, nestedSandbox, join(workDir, 'nested-definitions.sh'))
  const overlap = spawnSync('bash', [nestedRunner], {
    encoding: 'utf8',
    env: withoutEnv('PANTHEON_REPO'),
  })
  assert.notEqual(overlap.status, 0)
  assert.match(overlap.stderr, /sandbox path overlaps the selected repository/i)
})

test('--reset refuses a dangling PANTHEON_REPO and preserves the sandbox', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-reset-dangling-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const sandboxRoot = join(workDir, 'sandbox')
  mkdirSync(sandboxRoot, { recursive: true })
  const sentinel = join(sandboxRoot, 'handoff.txt')
  writeFileSync(sentinel, 'keep')
  const result = spawnSync('bash', [RUNNER, '--reset'], {
    encoding: 'utf8',
    env: {
      ...withoutEnv('PANTHEON_V2_MCP_LIST_TIMEOUT'),
      PANTHEON_SANDBOX_ROOT: sandboxRoot,
      PANTHEON_REPO: join(workDir, 'missing-repo'),
      HOME: join(workDir, 'synthetic-home'),
    },
  })
  assert.notEqual(result.status, 0, `dangling repo override must fail closed: ${result.stdout}`)
  assert.equal(existsSync(sentinel), true, 'reset must leave the sandbox sentinel intact')
})

test('--prepare refuses to write the sandbox inside its protected checkout', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-prepare-guard-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const repoDir = join(workDir, 'repo')
  const sandboxRoot = join(repoDir, 'sandbox')
  mkdirSync(repoDir, { recursive: true })
  writeFileSync(join(repoDir, 'package.json'), '{"name":"pantheon-opencode"}\n')

  const result = spawnSync('bash', [RUNNER, '--prepare'], {
    encoding: 'utf8',
    env: {
      ...withoutEnv(),
      PANTHEON_REPO: repoDir,
      PANTHEON_SANDBOX_ROOT: sandboxRoot,
      HOME: join(workDir, 'synthetic-home'),
    },
    timeout: 15000,
  })
  assert.notEqual(
    result.status,
    0,
    `prepare must fail before writing into checkout: ${result.stdout}`,
  )
  assert.match(result.stderr, /refusing to use unsafe sandbox root/i)
  assert.equal(
    existsSync(sandboxRoot),
    false,
    'unsafe prepare must not create sandbox files in repo',
  )
})

test('V2 port validation rejects invalid ports and refuses conflicts without stopping services', async (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-port-guard-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const definitions = loadDefinitions(join(workDir, 'definitions.sh'))
  const repoDir = join(workDir, 'repo')
  const sandboxRoot = join(workDir, 'sandbox')
  mkdirSync(repoDir, { recursive: true })
  writeFileSync(join(repoDir, 'package.json'), '{"name":"pantheon-opencode"}\n')
  mkdirSync(sandboxRoot, { recursive: true })
  const generated = generate(repoDir, sandboxRoot, definitions)
  const generatedSource = readFileSync(generated, 'utf8')
  const bootstrap = generatedSource.slice(
    0,
    generatedSource.indexOf('echo "=== Pantheon Sandbox Test'),
  )
  const portProbe = join(sandboxRoot, '.port-guard-probe.sh')
  writeFileSync(portProbe, `${bootstrap}\nassert_v2_port_available\n`, { mode: 0o755 })

  const invalid = spawnSync(
    'bash',
    ['-c', 'set -euo pipefail; source "$RUNNER_DEFS"; V2_PORT=65536; validate_v2_port'],
    { encoding: 'utf8', env: { ...withoutEnv(), RUNNER_DEFS: definitions } },
  )
  assert.notEqual(invalid.status, 0, 'out-of-range ports must be rejected')
  assert.match(invalid.stderr, /PANTHEON_V2_PORT.*1.*65535/i)

  const nonLoopback = spawnSync(
    'bash',
    ['-c', 'set -euo pipefail; source "$RUNNER_DEFS"; assert_v2_port_available'],
    {
      encoding: 'utf8',
      env: {
        ...withoutEnv(),
        RUNNER_DEFS: definitions,
        PANTHEON_V2_HOST: '203.0.113.1',
        PANTHEON_V2_PORT: '49377',
      },
    },
  )
  assert.notEqual(nonLoopback.status, 0, 'non-loopback addresses must be rejected')
  assert.match(nonLoopback.stderr, /host must be an IPv4 loopback IP/i)

  const listener = createServer()
  await new Promise((resolve, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', resolve)
  })
  t.after(() => new Promise((resolve) => listener.close(resolve)))
  const { port } = listener.address()
  const conflict = spawnSync(
    'bash',
    ['-c', 'set -euo pipefail; source "$RUNNER_DEFS"; assert_v2_port_available'],
    {
      encoding: 'utf8',
      env: {
        ...withoutEnv('PANTHEON_V2_MCP_LIST_TIMEOUT'),
        RUNNER_DEFS: definitions,
        PANTHEON_V2_HOST: '127.0.0.1',
        PANTHEON_V2_PORT: String(port),
      },
    },
  )
  assert.notEqual(conflict.status, 0, 'an occupied port must be rejected')
  assert.match(conflict.stderr, /already in use/i)
  assert.equal(listener.listening, true, 'port guard must not stop the existing service')

  const generatedConflict = spawnSync('bash', [portProbe], {
    encoding: 'utf8',
    env: {
      ...withoutEnv('PANTHEON_V2_MCP_LIST_TIMEOUT'),
      PANTHEON_V2_HOST: '127.0.0.1',
      PANTHEON_V2_PORT: String(port),
    },
  })
  assert.notEqual(generatedConflict.status, 0, 'generated run-test must reject the occupied port')
  assert.match(generatedConflict.stderr, /already in use/i)
  assert.equal(listener.listening, true, 'generated port guard must not stop the existing service')
})

test('sandbox tmp TTL only prunes old Node compile-cache files, retaining handoffs', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-tmp-ttl-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const definitions = loadDefinitions(join(workDir, 'definitions.sh'))
  const sandboxRoot = join(workDir, 'sandbox')
  mkdirSync(sandboxRoot, { recursive: true })
  const cacheDir = join(sandboxRoot, 'tmp', 'node-compile-cache', 'v24')
  const oldCache = join(cacheDir, 'a1b2c3d4')
  const freshCache = join(cacheDir, 'fresh-cache-entry')
  const unknownCache = join(cacheDir, 'handoff.patch')
  const handoff = join(sandboxRoot, 'tmp', 'pr224-phase2-hermes.patch')
  const runtimeDir = join(sandboxRoot, 'tmp', 'opencode')
  mkdirSync(cacheDir, { recursive: true })
  mkdirSync(runtimeDir, { recursive: true })
  writeFileSync(oldCache, 'stale cache')
  writeFileSync(freshCache, 'fresh cache')
  writeFileSync(unknownCache, 'not a cache entry')
  writeFileSync(handoff, 'handoff evidence')
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000)
  utimesSync(oldCache, old, old)

  const result = spawnSync(
    'bash',
    [
      '-c',
      'set -euo pipefail; source "$RUNNER_DEFS"; SANDBOX_ROOT="$TEST_SANDBOX"; cleanup_sandbox_tmp',
    ],
    {
      encoding: 'utf8',
      env: { ...withoutEnv(), RUNNER_DEFS: definitions, TEST_SANDBOX: sandboxRoot },
    },
  )
  assert.equal(result.status, 0, `TTL cleanup failed: ${result.stderr}`)
  assert.equal(existsSync(oldCache), false, 'old generated compile cache should expire')
  assert.equal(existsSync(freshCache), true, 'fresh cache should remain')
  assert.equal(existsSync(unknownCache), true, 'unknown cache-dir files must remain')
  assert.equal(existsSync(handoff), true, 'unrecognized handoff evidence must remain')
  assert.equal(existsSync(runtimeDir), true, 'runtime scratch directory must remain')
})

test('prepare emits isolated TUI launcher and sandbox README with runtime overrides', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-entrypoints-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const definitions = loadDefinitions(join(workDir, 'definitions.sh'))
  const sandboxRoot = join(workDir, 'sandbox')
  mkdirSync(sandboxRoot, { recursive: true })
  const result = spawnSync(
    'bash',
    [
      '-c',
      'set -euo pipefail; source "$RUNNER_DEFS"; SANDBOX_ROOT="$TEST_SANDBOX"; write_sandbox_entrypoints',
    ],
    {
      encoding: 'utf8',
      env: { ...withoutEnv(), RUNNER_DEFS: definitions, TEST_SANDBOX: sandboxRoot },
    },
  )
  assert.equal(result.status, 0, `sandbox entrypoint generation failed: ${result.stderr}`)
  const launcher = join(sandboxRoot, 'start-pantheon.sh')
  const readme = join(sandboxRoot, 'README.md')
  assert.ok(existsSync(launcher), 'prepare must generate the launcher referenced by run-test')
  assert.ok(existsSync(readme), 'prepare must generate the sandbox README')
  assert.ok(statSync(launcher).mode & 0o111, 'sandbox launcher must be executable')
  const syntax = spawnSync('bash', ['-n', launcher], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, `generated launcher has invalid bash syntax: ${syntax.stderr}`)
  assert.match(readFileSync(launcher, 'utf8'), /PANTHEON_V2_PORT/)
  assert.match(readFileSync(readme, 'utf8'), /PANTHEON_V2_MCP_LIST_TIMEOUT.*15/s)
  assert.match(readFileSync(readme, 'utf8'), /PANTHEON_V2_PORT.*49376/s)
})

test('--reset canonicalizes a symlink alias before comparing protected repos', (t) => {
  const tempParent = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-reset-symlink-'))
  t.after(() => rmSync(tempParent, { recursive: true, force: true }))
  const protectedRepo = join(tempParent, 'synthetic-repo')
  const sandboxAlias = join(tempParent, 'sandbox-repo-alias')
  mkdirSync(join(protectedRepo, '.git'), { recursive: true })
  const sentinel = join(protectedRepo, 'uncommitted-work-sentinel')
  writeFileSync(sentinel, 'keep')
  symlinkSync(protectedRepo, sandboxAlias, 'dir')

  const result = runReset(sandboxAlias, protectedRepo)
  assert.notEqual(
    result.status,
    0,
    `symlink alias must be rejected:\n${result.stdout}\n${result.stderr}`,
  )
  assert.equal(existsSync(sandboxAlias), true, 'rejected sandbox symlink must remain intact')
  assert.equal(existsSync(sentinel), true, 'protected repo sentinel must survive')
})

test('--reset treats a path-prefix neighbor as separate from a protected repo', (t) => {
  const tempParent = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-reset-prefix-'))
  t.after(() => rmSync(tempParent, { recursive: true, force: true }))
  const sandboxRoot = join(tempParent, 'repo')
  const protectedRepo = join(tempParent, 'repo2')
  mkdirSync(sandboxRoot, { recursive: true })
  mkdirSync(join(protectedRepo, '.git'), { recursive: true })
  const sandboxSentinel = join(sandboxRoot, 'remove-me')
  const protectedSentinel = join(protectedRepo, 'keep')
  writeFileSync(sandboxSentinel, 'reset this sandbox')
  writeFileSync(protectedSentinel, 'keep')

  const result = runReset(sandboxRoot, protectedRepo)
  assert.equal(
    result.status,
    0,
    `prefix neighbor should be safe:\n${result.stdout}\n${result.stderr}`,
  )
  assert.equal(existsSync(sandboxSentinel), false, 'sandbox contents should be reset')
  assert.equal(existsSync(protectedSentinel), true, 'prefix-neighbor repo must remain untouched')
})

test('offline context probe fixture runs without OpenCode or LLM and stays fail-closed', () => {
  for (const version of ['v2']) {
    const result = spawnSync(process.execPath, [CONTEXT_PROBE, '--version', version, '--json'], {
      encoding: 'utf8',
      timeout: 35000,
    })
    assert.equal(result.status, 0, `probe process failed: ${result.stderr}`)
    const payload = JSON.parse(result.stdout)
    assert.equal(payload.status, 'PASS', `unexpected probe status: ${result.stdout}`)
    assert.ok(payload.checks.length >= 6, 'PASS requires all offline fixture checks')
  }
})

function prepareCombinedModeSandbox(sandboxRoot) {
  const sandboxHome = join(sandboxRoot, 'home')
  const prefixBin = join(sandboxHome, '.npm-global', 'bin')
  const packageRoot = join(sandboxRoot, 'installed-package')
  const modeLog = join(sandboxRoot, 'mode-calls.log')
  mkdirSync(prefixBin, { recursive: true })
  mkdirSync(join(packageRoot, 'bin'), { recursive: true })
  mkdirSync(join(packageRoot, 'scripts'), { recursive: true })
  const packageBinary = join(packageRoot, 'bin', 'pantheon-init.mjs')
  writeFileSync(packageBinary, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(
    join(packageRoot, 'scripts', 'probe-context-rehydrate.mjs'),
    '/* probe path used by the sandbox runner */\n',
  )
  writeFileSync(join(prefixBin, 'opencode2'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(
    join(prefixBin, 'node'),
    `#!/bin/sh
printf "%s\\n" "$*" >> "$MODE_LOG"
case "$1" in
  --test) echo "stub hook canary invoked" ;;
  *probe-context-rehydrate.mjs*)
    if [ "$REHYDRATE_FAIL" = 1 ]; then
      echo '{"status":"FAIL","detail":"fixture probe failure"}'
      exit 1
    fi
    echo '{"status":"PASS","checks":[{"id":"fixture"}]}' ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  )
  // Resolve the package from the sandbox-prefix binary exactly as the real
  // runner does; the test does not install or mutate npm dependencies.
  symlinkSync(packageBinary, join(prefixBin, 'pantheon-opencode'))
  return { modeLog }
}

function assertRehydrateHooksOutcome({
  sandboxRoot,
  modeLog,
  result,
  rehydrateFails,
  hooksRequested,
}) {
  const expectedStatus = rehydrateFails ? 1 : 0
  assert.equal(
    result.status,
    expectedStatus,
    `runner returned an unexpected status:\n${result.stdout}\n${result.stderr}`,
  )

  const calls = readFileSync(modeLog, 'utf8').split(/\r?\n/).filter(Boolean)
  const probeCalls = calls.filter((call) => /probe-context-rehydrate\.mjs/.test(call))
  const hookCalls = calls.filter((call) => /--test\s+.*plugin-v2-hook-canary\.test\.mjs/.test(call))
  assert.equal(probeCalls.length, 1, 'context probe must be called exactly once')
  assert.equal(
    hookCalls.length,
    hooksRequested ? 1 : 0,
    `hook runner call count should be ${hooksRequested ? 1 : 0}`,
  )

  const reportPath = join(sandboxRoot, 'context-rehydrate-report.md')
  const report = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : '(report missing)'
  const expectedVerdict = rehydrateFails ? 'FAIL' : 'PASS'
  assert.match(
    report,
    new RegExp(
      `\\| v2 \\| context_rehydrate \\+ context_session_summary \\| ${expectedVerdict} \\|`,
    ),
    'report row must match the probe outcome',
  )
  assert.match(report, new RegExp(`\\*\\*Verdict: ${expectedVerdict}\\*\\*`))

  if (hooksRequested) {
    assert.match(result.stdout, /Hook canary: PASS\./)
  } else {
    assert.doesNotMatch(result.stdout, /Hook canary:/)
  }
}

test('--rehydrate without --hooks preserves PASS and does not invoke hook runner', (t) => {
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-rehydrate-pass-'))
  t.after(() => rmSync(sandboxRoot, { recursive: true, force: true }))
  const { modeLog } = prepareCombinedModeSandbox(sandboxRoot)

  const result = spawnSync('bash', [RUNNER, '--rehydrate'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PANTHEON_SANDBOX_ROOT: sandboxRoot,
      OPENCODE_V2_BIN: 'opencode2',
      PANTHEON_SANDBOX_MODEL: 'test/provider',
      MODE_LOG: modeLog,
      REHYDRATE_FAIL: '0',
    },
    timeout: 15000,
  })

  assertRehydrateHooksOutcome({
    sandboxRoot,
    modeLog,
    result,
    rehydrateFails: false,
    hooksRequested: false,
  })
})

test('--rehydrate without --hooks preserves FAIL and does not invoke hook runner', (t) => {
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-rehydrate-fail-'))
  t.after(() => rmSync(sandboxRoot, { recursive: true, force: true }))
  const { modeLog } = prepareCombinedModeSandbox(sandboxRoot)

  const result = spawnSync('bash', [RUNNER, '--rehydrate'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PANTHEON_SANDBOX_ROOT: sandboxRoot,
      OPENCODE_V2_BIN: 'opencode2',
      PANTHEON_SANDBOX_MODEL: 'test/provider',
      MODE_LOG: modeLog,
      REHYDRATE_FAIL: '1',
    },
    timeout: 15000,
  })

  assertRehydrateHooksOutcome({
    sandboxRoot,
    modeLog,
    result,
    rehydrateFails: true,
    hooksRequested: false,
  })
})

test('--rehydrate --hooks runs both modes, even if rehydrate fails', (t) => {
  for (const rehydrateFails of [false, true]) {
    const sandboxRoot = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-modes-'))
    t.after(() => rmSync(sandboxRoot, { recursive: true, force: true }))
    const { modeLog } = prepareCombinedModeSandbox(sandboxRoot)

    const result = spawnSync('bash', [RUNNER, '--rehydrate', '--hooks'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PANTHEON_SANDBOX_ROOT: sandboxRoot,
        OPENCODE_V2_BIN: 'opencode2',
        PANTHEON_SANDBOX_MODEL: 'test/provider',
        MODE_LOG: modeLog,
        REHYDRATE_FAIL: rehydrateFails ? '1' : '0',
      },
      timeout: 15000,
    })

    assertRehydrateHooksOutcome({
      sandboxRoot,
      modeLog,
      result,
      rehydrateFails,
      hooksRequested: true,
    })
  }
})
