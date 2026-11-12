import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildPrefixCachedPrompt,
  DEFAULT_CACHE_MIN_TOKENS,
} from '../../src/pantheon/prompt-cache-order.ts'

test('buildPrefixCachedPrompt structures prompt with invariant prefix first', () => {
  const result = buildPrefixCachedPrompt({
    identity: '# Agent Identity: Hermes',
    tools: ['tool: git_diff', 'tool: run_test'],
    conventions: ['Rule: Always run test slice', 'Rule: Follow TDD'],
    history: ['Turn 1: user hello', 'Turn 2: assistant ready'],
    currentTurn: 'Implement authentication endpoint',
  })

  assert.ok(result.prefixBoundaryIndex > 0)
  assert.ok(result.prompt.startsWith('# Agent Identity: Hermes'))
  assert.ok(result.prompt.includes('## Tool Specifications'))
  assert.ok(result.prompt.includes('## Project Standards & Gates'))
  assert.ok(result.prompt.includes('## Conversation History'))
  assert.ok(result.prompt.endsWith('Implement authentication endpoint'))

  // Verify prefix is strictly invariant before boundary
  const prefix = result.prompt.slice(0, result.prefixBoundaryIndex)
  assert.ok(!prefix.includes('Conversation History'))
  assert.ok(!prefix.includes('Implement authentication endpoint'))
})

test('buildPrefixCachedPrompt accurately identifies cache eligibility', () => {
  const small = buildPrefixCachedPrompt({
    identity: 'Short prompt',
    currentTurn: 'Turn',
  })
  assert.equal(small.cacheEligible, false)

  const largeIdentity = 'A'.repeat(DEFAULT_CACHE_MIN_TOKENS * 5)
  const large = buildPrefixCachedPrompt({
    identity: largeIdentity,
    currentTurn: 'Turn',
  })
  assert.equal(large.cacheEligible, true)
})
