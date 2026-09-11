/**
 * Behavioral tests for scripts/install/venv.mjs — setupVenv
 *
 * Run: node tests/test_install_venv.mjs
 */

import { strict as assert } from 'node:assert'
import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ORIG = await import('../scripts/install/venv.mjs')
const { setupVenv } = ORIG

const results = []

function test(name, fn) {
  try {
    fn()
    results.push({ name, passed: true })
  } catch (e) {
    results.push({ name, passed: false, error: e.message })
  }
}

test('dry-run does not create .venv', async () => {
  const tmpDir = join(tmpdir(), 'pantheon-dryrun-' + Date.now())
  try {
    await setupVenv(tmpDir, { dryRun: true, skipInstall: true })
  } catch {
    // ignore — no real python may be available
  }
  assert.equal(existsSync(join(tmpDir, '.venv')), false, 'dry-run should not create .venv')
  rmSync(tmpDir, { recursive: true, force: true })
})

// Project installs keep the venv at <target>/.venv — NOT <target>/.opencode/.venv —
// so MCP commands derived from venvPythonPath(target) always point at an
// executable that exists (P1-3).
test('venvPythonPath points at the real venv under target/.venv', () => {
  const { venvPythonPath } = ORIG
  const p = venvPythonPath('/proj')
  assert.ok(p.startsWith('/proj/.venv/'), `venv lives under target/.venv: ${p}`)
  assert.ok(
    p.endsWith(process.platform === 'win32' ? 'python.exe' : 'python3'),
    `python binary name: ${p}`,
  )
  assert.ok(!p.includes('/.opencode/'), 'venv is NOT nested under .opencode (runtimeTarget)')
  assert.equal(venvPythonPath('/proj'), venvPythonPath('/proj'), 'deterministic per target')
})

const passed = results.filter((r) => r.passed).length
const failed = results.filter((r) => !r.passed)

console.log('')
for (const r of results) {
  console.log(`  ${r.passed ? '✅' : '❌'} ${r.name}${r.error ? ': ' + r.error : ''}`)
}
console.log(`\n📊 Results: ${passed} passed, ${failed.length} failed`)
process.exit(failed.length > 0 ? 1 : 0)
