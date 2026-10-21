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
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = process.cwd()
const RUNNER = join(ROOT, 'scripts', 'test-opencode-v2-sandbox.sh')

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
  // The V1 install spec and binary are gone. `@opencode/cli` is only an
  // install spec, never a dependency of this package.
  assert.doesNotMatch(
    src,
    /OPENCODE_V1_SPEC|opencode-ai@1\.18\.18/,
    'V1 install spec still present',
  )
  assert.doesNotMatch(src, /check_binary "V1/, 'generated script still probes a V1 binary')
  assert.doesNotMatch(src, /prepare_project v1/, 'still generates a project-v1')
  assert.match(
    src,
    /OPENCODE_V2_SPEC="\$\{OPENCODE_V2_SPEC:-@opencode\/cli@latest\}"/,
    'sandbox should default to the current stable OpenCode CLI package',
  )
  // `--run v1` must fail loudly rather than silently testing the wrong leg.
  assert.match(src, /the V1 leg was removed/, '--run v1 must be rejected explicitly')

  // REPO_DIR must come from the script's own location. Inferring it from a
  // sibling directory named "pantheon" resolved to a DIFFERENT checkout that
  // had unrelated uncommitted work, and --prepare packs a tarball inside it.
  assert.match(
    src,
    /REPO_DIR="\$\(cd "\$SCRIPT_DIR\/\.\." && pwd\)"/,
    'REPO_DIR must be derived from SCRIPT_DIR',
  )
  assert.doesNotMatch(
    src,
    /SANDBOX_DIR\/\.\.\/pantheon/,
    'REPO_DIR must not be inferred from a sibling ../pantheon directory',
  )
})

test('MCP startup failures retain and print the mcp-list diagnostic output', () => {
  const src = readFileSync(RUNNER, 'utf8')
  assert.equal(
    (src.match(/mcp list output \(preserved at \$list_file\)/g) ?? []).length,
    2,
    'both MCP registration and handshake failures must print captured output',
  )
  assert.equal(
    (src.match(/cat "\$list_file" >&2 \|\| true/g) ?? []).length,
    2,
    'both failure paths must include the original mcp list response',
  )
})

test('generated run-test.sh defines its mcp-list timeout under nounset', () => {
  const src = readFileSync(RUNNER, 'utf8')
  assert.match(
    src,
    /V2_MCP_LIST_TIMEOUT="\$\{PANTHEON_V2_MCP_LIST_TIMEOUT:-15\}"/,
    'the generated script must define the timeout consumed by `timeout`',
  )
})

test('prepare generates an interactive launcher isolated to the sandbox beta', (t) => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-sandbox-launcher-'))
  t.after(() => rmSync(workDir, { recursive: true, force: true }))
  const repoDir = join(workDir, 'repo')
  const sandboxRoot = join(workDir, 'sandbox')
  mkdirSync(repoDir, { recursive: true })

  generate(repoDir, sandboxRoot, join(workDir, 'runner-definitions.sh'))
  const launcher = join(sandboxRoot, 'start-pantheon.sh')
  assert.ok(existsSync(launcher), 'prepare must create the launcher it advertises')
  assert.ok(statSync(launcher).mode & 0o111, 'launcher must be executable')
  const syntax = spawnSync('bash', ['-n', launcher], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, `launcher has invalid bash syntax:\n${syntax.stderr}`)

  const src = readFileSync(launcher, 'utf8')
  assert.match(src, /export HOME="\$SANDBOX_HOME"/)
  assert.match(src, /export XDG_CONFIG_HOME="\$SANDBOX_HOME\/\.config"/)
  assert.match(src, /export XDG_DATA_HOME="\$SANDBOX_HOME\/\.local\/share"/)
  assert.match(src, /export OPENCODE_CONFIG_DIR="\$SANDBOX_DIR\/project-v2"/)
  assert.match(src, /service set port "\$V2_PORT"/)
  assert.match(src, /PANTHEON_V2_PORT:-49376/)
  assert.match(src, /probe\.setsockopt\(socket\.SOL_SOCKET, socket\.SO_REUSEADDR, 1\)/)
  assert.match(src, /Reusing the existing beta sandbox OpenCode service/)
  assert.match(src, /dedicated V2 port .* occupied by a different or unverifiable service/)
  assert.match(src, /"@opencode", "cli"/)
  assert.match(src, /opencode-v2\.db/)
  assert.ok(
    src.indexOf('service set port') < src.indexOf('exec "$NPM_PREFIX/bin/opencode2"'),
    'the managed service port must be isolated before the TUI starts',
  )
  assert.match(src, /exec "\$NPM_PREFIX\/bin\/opencode2" "\$@"/)
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

// The context_rehydrate/context_session_summary sandbox probe is intentionally
// removed: neither operation is registered in the Persistence MCP surface.
