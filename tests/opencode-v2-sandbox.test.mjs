import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function runReset(sandboxRoot, protectedRepo) {
  mkdirSync(protectedRepo, { recursive: true })
  if (!existsSync(join(protectedRepo, 'package.json'))) {
    writeFileSync(join(protectedRepo, 'package.json'), '{"name":"pantheon-opencode"}\n')
  }
  return spawnSync('bash', [RUNNER, '--reset'], {
    encoding: 'utf8',
    env: {
      ...process.env,
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
