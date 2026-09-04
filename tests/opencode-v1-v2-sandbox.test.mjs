import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = process.cwd()
const RUNNER = join(ROOT, 'scripts', 'test-opencode-v1-v2-sandbox.sh')
const GATE_A_TEST = join(ROOT, 'tests', 'test_mcp_scripts_sync.py')
const DOCTOR = join(ROOT, 'scripts', 'doctor.mjs')

function readScript(path) {
  assert.ok(existsSync(path), `missing file: ${path}`)
  return readFileSync(path, 'utf8')
}

test('runner script exists and is executable', () => {
  assert.ok(existsSync(RUNNER), 'scripts/test-opencode-v1-v2-sandbox.sh missing')
  const mode = statSync(RUNNER).mode
  assert.ok(mode & 0o111, 'runner script is not executable')
})

test('runner script passes bash -n (syntax)', () => {
  const res = spawnSync('bash', ['-n', RUNNER], { encoding: 'utf8' })
  assert.equal(res.status, 0, `bash -n failed:\n${res.stderr}`)
})

test('runner uses strict mode', () => {
  const src = readScript(RUNNER)
  assert.ok(src.includes('set -euo pipefail'), 'runner must set -euo pipefail')
})

test('runner exposes all modes', () => {
  const src = readScript(RUNNER)
  for (const mode of ['--prepare', '--run', '--reset', '--prompts']) {
    assert.ok(src.includes(mode), `runner missing mode ${mode}`)
  }
})

test('runner honors PANTHEON_SANDBOX_ROOT and prompt timeout', () => {
  const src = readScript(RUNNER)
  assert.ok(src.includes('PANTHEON_SANDBOX_ROOT'), 'PANTHEON_SANDBOX_ROOT not honored')
  assert.ok(src.includes('PANTHEON_PROMPT_TIMEOUT'), 'PANTHEON_PROMPT_TIMEOUT not honored')
})

test('runner installs from repo tarball into sandbox prefix', () => {
  const src = readScript(RUNNER)
  assert.ok(src.includes('npm pack'), 'runner must npm pack')
  assert.ok(src.includes('npm install -g'), 'runner must npm install -g the tarball')
  assert.ok(src.includes('npm_config_prefix'), 'sandbox npm prefix isolation missing')
  assert.ok(src.includes('init --headless'), 'headless init missing')
})

test('runner regenerates config per version via init --project --version', () => {
  const src = readScript(RUNNER)
  assert.ok(
    src.includes('init --project --version "$v"'),
    'per-version config regeneration missing',
  )
  assert.ok(src.includes('opencode-ai@1.18.18'), 'V1 binary spec missing')
  assert.ok(src.includes('@opencode-ai/cli@beta'), 'V2 binary spec missing')
  assert.ok(src.includes('opencode-go/mimo-v2.5'), 'default sandbox model missing')
})

test('prompts battery covers all required capabilities', () => {
  const src = readScript(RUNNER)
  // pantheon://agents resource reading
  assert.ok(src.includes('pantheon://agents'), 'battery must cover pantheon://agents')
  // memory store + recall
  assert.ok(src.includes('memory_store'), 'battery must cover memory store')
  assert.ok(src.includes('memory_recall'), 'battery must cover memory recall')
  // /tmp write/read (path built from ${TMPDIR:-/tmp} — no literal tmp/ in file)
  assert.ok(src.includes('${TMPDIR:-/tmp}/pantheon-sandbox-probe-'), 'battery must cover temp-dir write/read')
  // tmp-write-read must instruct python3 -c (python3 is allowlisted in permission.bash)
  assert.ok(src.includes('python3 -c'), 'tmp-write-read prompt must use allowlisted python3 -c')
  // probe file verification: deterministic fallback when the model reply is chatty
  assert.ok(src.includes('PROMPT_VERIFY'), 'probe file verification array missing')
  assert.ok(src.includes('probe file verified'), 'probe file PASS path missing')
  // agent delegation
  assert.ok(src.includes('@talos'), 'battery must cover agent delegation')
  // mcp list as structural check
  assert.ok(src.includes('mcp list'), 'battery must cover opencode mcp list')
})

test('prompts run via opencode run --format json', () => {
  const src = readScript(RUNNER)
  assert.ok(
    src.includes('run --auto --format json'),
    'prompts must run via opencode run --format json',
  )
})

test('runner writes prompts-report.md with PASS/FAIL/AMBIENTAL classification', () => {
  const src = readScript(RUNNER)
  assert.ok(src.includes('prompts-report.md'), 'report file missing')
  assert.ok(src.includes('AMBIENTAL_RE'), 'ambiental signature list missing')
  for (const verdict of ['PASS', 'FAIL', 'AMBIENTAL']) {
    assert.ok(src.includes(`"${verdict}"`), `verdict ${verdict} missing`)
  }
})

test('known ambiental failures are classified, not fatal', () => {
  const src = readScript(RUNNER)
  // edgesOut npm TUI, bifrost/auth, missing Docker
  for (const signature of ['bifrost', 'edgesout', 'docker']) {
    assert.ok(
      src.toLowerCase().includes(signature),
      `ambiental signature "${signature}" not classified`,
    )
  }
  // AMBIENTAL never increments the real-failure counter; FAIL does
  assert.ok(src.includes('Verdict: FAIL'), 'report must state FAIL verdict')
  assert.ok(src.includes('Verdict: PASS'), 'report must state PASS verdict')
})

test('runner embeds gate (b): pantheon://agents content check in run-test.sh', () => {
  const src = readScript(RUNNER)
  assert.ok(src.includes('mcp_resources_server.py'), 'resources server invocation missing')
  const gate = src.slice(src.indexOf('write_run_test_sh'))
  assert.ok(
    gate.includes('pantheon://agents content includes zeus and hermes'),
    'run-test.sh must validate pantheon://agents CONTENT (zeus/hermes)',
  )
})

test('runner refuses unsafe --reset targets', () => {
  const src = readScript(RUNNER)
  assert.ok(src.includes('refusing to reset unsafe'), 'reset safety guard missing')
})

test('gate (a): filecmp sync test exists and covers both pairs', () => {
  const src = readScript(GATE_A_TEST)
  assert.ok(src.includes('import filecmp'), 'gate (a) must use filecmp')
  for (const pair of [
    'scripts/_pantheon_paths.py',
    'src/mcp/_pantheon_paths.py',
    'scripts/mcp_resources_server.py',
    'src/mcp/mcp_resources_server.py',
  ]) {
    assert.ok(src.includes(pair), `gate (a) must compare ${pair}`)
  }
})

test('gate (b): doctor validates pantheon://agents content, not just presence', () => {
  const src = readScript(DOCTOR)
  assert.ok(
    src.includes("const missingCanonical = ['zeus', 'hermes']"),
    'doctor must check zeus/hermes agent content',
  )
  assert.ok(
    src.includes('pantheon://agents content validated'),
    'doctor must report content validation',
  )
})

test('run_base resolves the version binary strictly in the sandbox prefix', () => {
  const src = readScript(RUNNER)
  const base = src.slice(src.indexOf('run_base()'))
  assert.ok(base.includes('sandbox_bin_v "$v"'), 'run_base must resolve via sandbox_bin_v')
  assert.ok(
    !base.includes('command -v "$bin"'),
    'run_base must not use raw command -v (host PATH leak)',
  )
  assert.ok(base.includes('exit 3'), 'run_base must exit 3 when sandbox is not prepared')
})

test('run_prompt retries once on real FAIL with cooldown; AMBIENTAL never retried', () => {
  const src = readScript(RUNNER)
  const attempt = src.slice(src.indexOf('run_prompt_attempt()'))
  const wrapper = attempt.slice(attempt.indexOf('run_prompt()'))
  assert.ok(
    attempt.includes('ATTEMPT_RESULT') && attempt.includes('ATTEMPT_DETAIL'),
    'attempt must expose result/detail for the retry wrapper',
  )
  assert.ok(
    wrapper.includes('[ "$ATTEMPT_RESULT" = "FAIL" ]'),
    'retry must trigger only on real FAIL',
  )
  assert.ok(wrapper.includes('sleep "$RETRY_COOLDOWN"'), 'retry cooldown missing')
  assert.ok(
    wrapper.includes('RETRIES_USED=$((RETRIES_USED + 1))'),
    'retry usage must be counted for the report',
  )
  assert.ok(
    wrapper.includes('retry used'),
    'report detail must record when retry was used',
  )
  assert.ok(
    src.includes('PANTHEON_RETRY_COOLDOWN'),
    'retry cooldown must be env-overridable',
  )
})

test('prepare resolves pantheon-opencode via sandbox prefix after install', () => {
  const src = readScript(RUNNER)
  const prep = src.slice(src.indexOf('cmd_prepare()'))
  const installIdx = prep.indexOf('install_binaries')
  const initIdx = prep.indexOf('init --headless')
  assert.ok(
    installIdx > -1 && initIdx > installIdx,
    'prepare must install the tarball before headless init',
  )
  assert.ok(
    prep.includes('sandbox_bin_for "pantheon-opencode"'),
    'prepare must resolve pantheon-opencode via sandbox_bin_for',
  )
})
