/**
 * Test suite for scripts/install/venv.mjs — setupVenv
 *
 * Run: node tests/test_install_venv.mjs
 */

import { strict as assert } from 'node:assert'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

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

async function testAsync(name, fn) {
  try {
    await fn()
    results.push({ name, passed: true })
  } catch (e) {
    results.push({ name, passed: false, error: e.message })
  }
}

// ===================================================================
// TEST 1: function signature
// ===================================================================
test('setupVenv accepts force option', () => {
  assert.equal(typeof setupVenv, 'function')
  const src = setupVenv.toString()
  assert.ok(src.includes('force'), 'source should reference force')
  assert.ok(src.includes('rmSync'), 'source should use rmSync for force delete')
})

// ===================================================================
// TEST 2: PIP_USER=0
// ===================================================================
test('PIP_USER=0 set in pip env', () => {
  const src = setupVenv.toString()
  const pipEnvIdx = src.indexOf('pipEnv')
  assert.ok(pipEnvIdx >= 0, 'pipEnv variable should exist')
  const envSection = src.substring(pipEnvIdx, pipEnvIdx + 200)
  assert.ok(envSection.includes('PIP_USER'),
    `PIP_USER should be in pip env. Got: ${envSection.substring(0, 120)}`)
})

// ===================================================================
// TEST 3: error message uses absolute path (reqFile), not relative
// ===================================================================
test('error message uses reqFile (absolute path)', () => {
  const src = setupVenv.toString()
  const throwIdx = src.indexOf('throw new Error')
  assert.ok(throwIdx >= 0, 'should have throw statement')
  const errPart = src.substring(throwIdx, throwIdx + 300)
  assert.ok(errPart.includes('reqFile'),
    `Error should reference reqFile. Got: ${errPart.substring(0, 120)}`)
  assert.ok(!errPart.includes("'src/mcp/"),
    'Error should NOT contain hardcoded relative path')
})

// ===================================================================
// TEST 4: dry-run does not create files
// ===================================================================
await testAsync('dry-run does not create .venv', async () => {
  const tmpDir = join(tmpdir(), 'pantheon-dryrun-' + Date.now())
  try {
    await setupVenv(tmpDir, { dryRun: true, skipInstall: true })
  } catch (e) {
    // ignore — no real python may be available
  }
  assert.equal(existsSync(join(tmpDir, '.venv')), false,
    'dry-run should not create .venv')
  rmSync(tmpDir, { recursive: true, force: true })
})

// ===================================================================
// TEST 5: module exports
// ===================================================================
test('setupVenv is a function', () => {
  assert.equal(typeof setupVenv, 'function')
})

// ===================================================================
// Summary
// ===================================================================
const passed = results.filter(r => r.passed).length
const failed = results.filter(r => !r.passed)

console.log('')
for (const r of results) {
  console.log(`  ${r.passed ? '✅' : '❌'} ${r.name}${r.error ? ': ' + r.error : ''}`)
}
console.log(`\n📊 Results: ${passed} passed, ${failed.length} failed`)
process.exit(failed.length > 0 ? 1 : 0)
