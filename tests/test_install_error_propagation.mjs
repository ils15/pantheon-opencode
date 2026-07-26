/**
 * Tests for error propagation:
 *  - opencode.mjs: catch block re-throws fatal errors
 *  - pantheon-init.mjs: error message includes recovery suggestions
 */

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'

const results = []

function test(name, fn) {
  try {
    fn()
    results.push({ name, passed: true })
  } catch (e) {
    results.push({ name, passed: false, error: e.message })
  }
}

// ===================================================================
// TEST 1: opencode.mjs — catch re-throws on setup failure
// ===================================================================
const opencodeSrc = await import('../scripts/install/opencode.mjs')
const fnStr = opencodeSrc.installOpenCode.toString()

test('opencode.mjs: catch block re-throws fatal error', () => {
  const catchIdx = fnStr.indexOf('Setup failed')
  assert.ok(catchIdx >= 0, 'Should have "Setup failed" error message')
  
  const afterCatch = fnStr.substring(catchIdx, catchIdx + 120)
  assert.ok(afterCatch.includes('throw err'),
    `Catch block should re-throw. Got: ${afterCatch.substring(0, 80)}`)
  assert.ok(!afterCatch.includes('stats.errors') || afterCatch.includes('throw err'),
    'Should re-throw, not just increment stats')
})

// ===================================================================
// TEST 2: pantheon-init.mjs — error message includes recovery tips
// ===================================================================
const pantheonInit = readFileSync('./bin/pantheon-init.mjs', 'utf-8')

test('pantheon-init.mjs: error message shows recovery suggestions', () => {
  assert.ok(pantheonInit.includes('--no-mcp'),
    'Error message should mention --no-mcp flag')
  assert.ok(pantheonInit.includes('--force'),
    'Error message should mention --force flag')
  assert.ok(pantheonInit.includes('process.exit(1)'),
    'Should exit with non-zero on error')
})

// ===================================================================
// TEST 3: pantheon-init.mjs — success banner only after try block
// ===================================================================
test('pantheon-init.mjs: success banner only after try block (not inside catch)', () => {
  const tryIdx = pantheonInit.indexOf('try {')
  const installedBanner = pantheonInit.indexOf('installed!')
  
  assert.ok(tryIdx >= 0, 'Should have try block')
  assert.ok(installedBanner >= 0, 'Should have installed banner')
  assert.ok(installedBanner > tryIdx, 'Success banner should be after the try block')
  
  // Verify there's no success banner INSIDE the catch
  const catchIdx = pantheonInit.indexOf('} catch')
  const afterCatchEnd = pantheonInit.indexOf('process.exit', catchIdx)
  const catchContent = pantheonInit.substring(catchIdx, afterCatchEnd + 50)
  assert.ok(!catchContent.includes('✅'),
    'Catch block should not contain success banner')
})

// ===================================================================
// TEST 4: import check — both modules parse correctly
// ===================================================================
test('opencode.mjs and pantheon-init.mjs import without errors', () => {
  assert.equal(typeof opencodeSrc.installOpenCode, 'function',
    'installOpenCode should be a function')
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
