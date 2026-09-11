import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = process.cwd()
const RUNNER = join(ROOT, 'scripts', 'test-opencode-v1-v2-sandbox.sh')
const CONTEXT_PROBE = join(ROOT, 'scripts', 'probe-context-rehydrate.mjs')

test('runner script exists and is executable, with valid bash syntax', () => {
  assert.ok(existsSync(RUNNER), 'scripts/test-opencode-v1-v2-sandbox.sh missing')
  assert.ok(statSync(RUNNER).mode & 0o111, 'runner script is not executable')
  const res = spawnSync('bash', ['-n', RUNNER], { encoding: 'utf8' })
  assert.equal(res.status, 0, `bash -n failed:\n${res.stderr}`)
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
