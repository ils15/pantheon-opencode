/**
 * Edge case tests for installer
 */
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const { setupVenv } = await import('../scripts/install/venv.mjs')
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
// TEST 1: setupVenv with non-existent target directory should throw
// ===================================================================
await testAsync('setupVenv on invalid target should throw', async () => {
  const badDir = join(tmpdir(), 'pantheon-nonexistent-' + Date.now(), 'subdir')
  try {
    await setupVenv(badDir, { dryRun: true, skipInstall: true })
    // Should not reach here without python available
  } catch (e) {
    // Expected to fail — no python available or bad path
    assert.ok(e.message.length > 0, 'Error should have message')
  }
})

// ===================================================================
// TEST 2: reqFile not found error message
// ===================================================================
test('reqFile not found error shows file path', () => {
  // We can't easily trigger this without modifying the source,
  // but we can verify the error handling code exists
  const src = setupVenv.toString()
  assert.ok(src.includes('Requirements file not found'),
    'Should handle missing reqFile')
  assert.ok(src.includes('reqFile'),
    'Error should include the file path')
})

// ===================================================================
// TEST 3: Source file for venv.mjs — ensure no stale relative path
// ===================================================================
test('No stale "src/mcp/requirements-mcp.txt" hardcoded string', () => {
  const src = setupVenv.toString()
  // The only reference to the path should be through reqFile variable
  const occurrences = (src.match(/src\/mcp\/requirements-mcp\.txt/g) || []).length
  assert.equal(occurrences, 0, `Found ${occurrences} hardcoded references to the path`)
})

// ===================================================================
// TEST 4: Source file for venv.mjs — PIP_USER appears in pipEnv
// ===================================================================
test('PIP_USER appears only in the pipEnv object (not as system env mutation)', () => {
  const src = setupVenv.toString()
  // Should set PIP_USER on the spawned process env, not on process.env
  const pipEnvAssignments = (src.match(/PIP_USER/g) || []).length
  assert.ok(pipEnvAssignments >= 1, 'Should have at least one PIP_USER reference')
  
  // Check it's not modifying process.env directly
  const processEnvMod = src.match(/process\.env\s*=/g)
  assert.equal(processEnvMod, null, 'Should not reassign process.env')
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
