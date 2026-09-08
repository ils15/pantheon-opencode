import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = process.cwd()
const RUNNER = join(ROOT, 'scripts', 'test-opencode-v1-v2-sandbox.sh')
const COST_PROBE = join(ROOT, 'scripts', 'probe-pantheon-cost.mjs')
const CONTEXT_PROBE = join(ROOT, 'scripts', 'probe-context-rehydrate.mjs')
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
  for (const mode of ['--prepare', '--run', '--reset', '--prompts', '--cost', '--rehydrate']) {
    assert.ok(src.includes(mode), `runner missing mode ${mode}`)
  }
})

test('offline pantheon_cost probe is packaged and never passes when untested', () => {
  const src = readScript(RUNNER)
  const probe = readScript(COST_PROBE)
  assert.ok(src.includes('pantheon-cost-report.md'), 'cost probe report missing')
  assert.ok(src.includes('NOT_TESTED'), 'runner must preserve NOT_TESTED')
  assert.ok(probe.includes('PANTHEON_COST_DB'), 'probe must cover the env override')
  assert.ok(probe.includes('dbPath'), 'probe must cover explicit dbPath')
  assert.ok(
    probe.includes('incompatible opencode.db schema'),
    'probe must cover schema incompatibility',
  )
  assert.ok(probe.includes('tokens-only output'), 'probe must reject monetary output')
  assert.ok(probe.includes("status === 'FAIL'"), 'probe must not convert failures into PASS')
})

test('offline context probes use a real synthetic checkpoint and no LLM', () => {
  const src = readScript(RUNNER)
  const probe = readScript(CONTEXT_PROBE)
  const costProbe = readScript(COST_PROBE)
  assert.ok(src.includes('context-rehydrate-report.md'), 'context probe report missing')
  for (const tool of ['context_rehydrate', 'context_session_summary']) {
    assert.ok(probe.includes(tool), `probe must cover ${tool}`)
  }
  for (const field of ['latest', 'tail', 'goal', 'phase', 'delegations']) {
    assert.ok(
      probe.includes(`key: "${field}"`) || probe.includes(`"${field}"`),
      `checkpoint field ${field} missing`,
    )
  }
  for (const switchName of ['PANTHEON_COMPACTION', 'PANTHEON_SESSION_END_SUMMARY']) {
    assert.ok(probe.includes(switchName), `kill-switch ${switchName} missing`)
  }
  for (const status of ['NOT_TESTED', 'AMBIENTAL', 'PASS', 'FAIL']) {
    assert.ok(probe.includes(`'${status}'`), `context probe status ${status} missing`)
  }
  assert.ok(!probe.includes('opencode run'), 'context probe must not invoke an LLM')
  assert.ok(costProbe.includes('tokens-only output'), 'tokens-only cost probe must remain intact')
})

test('offline context probe fixture runs without OpenCode or LLM and stays fail-closed', () => {
  for (const version of ['v1', 'v2']) {
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
  assert.ok(
    src.includes(`\${TMPDIR:-/tmp}/pantheon-sandbox-probe-`),
    'battery must cover temp-dir write/read',
  )
  // tmp-write-read must instruct python3 -c (python3 is allowlisted in permission.bash)
  assert.ok(src.includes('python3 -c'), 'tmp-write-read prompt must use allowlisted python3 -c')
  // probe file verification: deterministic fallback when the model reply is chatty
  assert.ok(src.includes('PROMPT_VERIFY'), 'probe file verification array missing')
  assert.ok(src.includes('probe file verified'), 'probe file PASS path missing')
  // agent delegation
  assert.ok(src.includes('@talos'), 'battery must cover agent delegation')
  // mcp list as structural check
  assert.ok(src.includes('mcp list'), 'battery must cover opencode mcp list')
  const mcp = src.slice(src.indexOf('check_mcp_list()'), src.indexOf('check_doctor()'))
  assert.ok(
    mcp.includes('[ "$connected_count" -eq 5 ]'),
    'mcp list must require exactly 5 connected servers',
  )
})

test('prompts run via opencode run --format json', () => {
  const src = readScript(RUNNER)
  assert.ok(
    src.includes('run --auto --format json'),
    'prompts must run via opencode run --format json',
  )
})

test('runner writes prompts-report.md and only PASS can authorize evidence', () => {
  const src = readScript(RUNNER)
  assert.ok(src.includes('prompts-report.md'), 'report file missing')
  assert.match(src, /\[ "\$\{RESULTS\["\$v:\$id"\]:-\}" = "PASS" \] \|\| fail=/)
  assert.doesNotMatch(src, /no real failures \(NOT_TESTED\/AMBIENTAL is non-blocking\)/)
  assert.doesNotMatch(src, /AMBIENTAL is non-blocking|is non-blocking/)
})

test('timeout, auth, network, provider and missing prerequisites are blocking', () => {
  const src = readScript(RUNNER)
  const attempt = src.slice(src.indexOf('run_prompt_attempt()'), src.indexOf('check_mcp_list()'))
  assert.match(attempt, /\[ "\$rc" -eq 124 \][\s\S]*ATTEMPT_RESULT="FAIL"/)
  assert.doesNotMatch(attempt, /ATTEMPT_RESULT="AMBIENTAL"/)
  for (const check of [
    'binary not installed',
    'package is not installed',
    'node runtime is not available',
  ]) {
    const index = src.indexOf(check)
    assert.ok(index >= 0, `missing prerequisite check: ${check}`)
    assert.equal(src.slice(Math.max(0, index - 120), index).includes('"FAIL"'), true)
  }
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

test('run_prompt executes exactly once with no retry or cooldown', () => {
  const src = readScript(RUNNER)
  const wrapper = src.slice(src.indexOf('run_prompt()'), src.indexOf('check_mcp_list()'))
  assert.equal((wrapper.match(/run_prompt_attempt/g) ?? []).length, 1)
  assert.doesNotMatch(wrapper, /sleep|RETRY|retry/i)
  assert.doesNotMatch(src, /PANTHEON_RETRY_COOLDOWN/)
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
