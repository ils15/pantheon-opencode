/**
 * Tests for the Comment Checker — detects trivial/auto-generated comments
 * that make code look machine-produced rather than human-written.
 *
 * Run with: npx tsx tests/pantheon/comment-checker.test.ts
 */
import { strict as assert } from 'node:assert'

import { checkCommentDensity, TRIVIAL_PATTERNS } from '../../src/pantheon/comment-checker.ts'

// ─── Harness ───────────────────────────────────────────────────────────

const results: { name: string; passed: boolean; error?: string }[] = []

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    results.push({ name, passed: true })
    console.log(`  ✓ ${name}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    results.push({ name, passed: false, error: msg })
    console.log(`  ✗ ${name}`)
    console.log(`    ${msg}`)
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────

async function main() {
  await test('exports TRIVIAL_PATTERNS array', async () => {
    assert.ok(Array.isArray(TRIVIAL_PATTERNS), 'TRIVIAL_PATTERNS should be an array')
    assert.ok(TRIVIAL_PATTERNS.length >= 5, 'should have at least 5 patterns')
  })

  await test('returns score 0 and empty flags for clean source', async () => {
    const source = `function greet(name: string): string {
  return \`Hello, \${name}\`
}`
    const result = checkCommentDensity(source)
    assert.equal(result.score, 0)
    assert.deepEqual(result.flags, [])
  })

  await test('flags trivial increment comment', async () => {
    const source = `# increment counter
counter += 1`
    const result = checkCommentDensity(source)
    assert.ok(result.flags.length > 0, 'should flag the trivial comment')
    assert.ok(
      result.flags.some((f) => f.includes('increment')),
      'should mention increment',
    )
  })

  await test('flags trivial decrement comment', async () => {
    const source = `# decrement retries
retries -= 1`
    const result = checkCommentDensity(source)
    assert.ok(result.flags.length > 0, 'should flag the trivial comment')
    assert.ok(
      result.flags.some((f) => f.includes('decrement')),
      'should mention decrement',
    )
  })

  await test('flags trivial set comment', async () => {
    const source = `# set timeout
timeout = 30`
    const result = checkCommentDensity(source)
    assert.ok(result.flags.length > 0, 'should flag the trivial comment')
    assert.ok(
      result.flags.some((f) => f.includes('set ')),
      'should mention set',
    )
  })

  await test('flags trivial loop over comment', async () => {
    const source = `# loop over items
for item in items:
    process(item)`
    const result = checkCommentDensity(source)
    assert.ok(result.flags.length > 0, 'should flag the trivial comment')
    assert.ok(
      result.flags.some((f) => f.includes('loop over')),
      'should mention loop over',
    )
  })

  await test('flags trivial initialize comment', async () => {
    const source = `# initialize connection
conn = create_connection()`
    const result = checkCommentDensity(source)
    assert.ok(result.flags.length > 0, 'should flag the trivial comment')
    assert.ok(
      result.flags.some((f) => f.includes('initialize') || f.includes('init')),
      'should mention initialize/init',
    )
  })

  await test('flags trivial init comment', async () => {
    const source = `# init buffer
buf = bytearray()`
    const result = checkCommentDensity(source)
    assert.ok(result.flags.length > 0, 'should flag the trivial comment')
  })

  await test('flags trivial return comment', async () => {
    const source = `# return result
return value`
    const result = checkCommentDensity(source)
    assert.ok(result.flags.length > 0, 'should flag the trivial comment')
    assert.ok(
      result.flags.some((f) => f.includes('return')),
      'should mention return',
    )
  })

  await test('flags trivial yield comment', async () => {
    const source = `# yield items
yield item`
    const result = checkCommentDensity(source)
    assert.ok(result.flags.length > 0, 'should flag the trivial comment')
    assert.ok(
      result.flags.some((f) => f.includes('yield')),
      'should mention yield',
    )
  })

  await test('does NOT flag meaningful comments', async () => {
    const source = `# TODO: refactor to use connection pool
# FIXME: race condition on concurrent access
# See ADR-003 for why we use mutex here
counter += 1`
    const result = checkCommentDensity(source)
    assert.equal(result.flags.length, 0, 'meaningful comments should not be flagged')
  })

  await test('does NOT flag triple-slash doc comments', async () => {
    const source = `/// Increment the retry counter with exponential backoff
retries -= 1`
    const result = checkCommentDensity(source)
    assert.equal(result.flags.length, 0)
  })

  await test('score scales with number of trivial comments', async () => {
    const source = `# increment x
x += 1
# set y
y = 0
# loop over data
for d in data:
    pass`
    const result = checkCommentDensity(source)
    assert.ok(result.score > 0, 'score should be > 0 with multiple trivial comments')
    assert.ok(result.flags.length >= 3, 'should flag at least 3 comments')
  })

  await test('handles empty source', async () => {
    const result = checkCommentDensity('')
    assert.equal(result.score, 0)
    assert.deepEqual(result.flags, [])
  })

  await test('handles source with no comments', async () => {
    const source = `function add(a: number, b: number): number {
  return a + b
}`
    const result = checkCommentDensity(source)
    assert.equal(result.score, 0)
    assert.deepEqual(result.flags, [])
  })

  await test('flags multiple trivial patterns in one file', async () => {
    const source = `# increment counter
counter += 1
# set timeout
timeout = 30
# return value
return timeout`
    const result = checkCommentDensity(source)
    assert.ok(result.flags.length >= 3, 'should flag all three trivial patterns')
    assert.ok(result.score > 0, 'score should reflect multiple flags')
  })

  // ─── Summary ───────────────────────────────────────────────────────

  console.log('\n' + '='.repeat(60))
  const passed = results.filter((r) => r.passed).length
  const failed = results.filter((r) => !r.passed).length
  console.log(`Results: ${passed} passed, ${failed} failed, ${results.length} total`)
  if (failed > 0) {
    console.log('\nFailed tests:')
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ✗ ${r.name}: ${r.error}`)
    }
    process.exit(1)
  }
  console.log('All tests passed! ✅')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
