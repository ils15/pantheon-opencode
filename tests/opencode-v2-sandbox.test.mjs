import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
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
    /REPO_DIR="\$\(cd "\$SCRIPT_DIR\/\.\." && pwd\)"/,
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

test('offline context probe fixture runs without OpenCode or LLM and stays fail-closed', () => {
  for (const version of ['v2']) {
    const result = spawnSync(process.execPath, [CONTEXT_PROBE, '--version', version, '--json'], {
      encoding: 'utf8',
      timeout: 35000,
    })
    // Fail-closed contract: the probe may report honest FAIL (blocking) for
    // environmental or persistence issues, but never silently degrades.
    assert.ok(result.status === 0 || result.status === 1, `probe process failed: ${result.stderr}`)
    const payload = JSON.parse(result.stdout)
    assert.ok(
      ['PASS', 'FAIL'].includes(payload.status),
      `unexpected probe status: ${result.stdout}`,
    )
    if (payload.status === 'PASS') {
      assert.ok(payload.checks.length >= 6, 'PASS requires all offline fixture checks')
      assert.equal(result.status, 0, 'PASS must exit 0')
    } else {
      assert.notEqual(result.status, 0, 'FAIL must exit non-zero (blocking)')
      assert.ok(payload.detail && payload.detail.length > 0, 'FAIL must carry a detail')
    }
  }
})
