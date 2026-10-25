import assert from 'node:assert/strict'
import test from 'node:test'
import {
  opencodeWildcardMatch,
  opencodeWildcardPatternsOverlap,
} from '../scripts/install/opencode-wildcard.mjs'

test('OpenCode wildcard matching normalizes slashes and treats star/question literally as host wildcards', () => {
  assert.equal(opencodeWildcardMatch('foo/bar', 'foo\\bar'), true)
  assert.equal(opencodeWildcardMatch('foo/bar', 'foo*'), true)
  assert.equal(opencodeWildcardMatch('foo/bar', 'foo?bar'), true)
  assert.equal(opencodeWildcardMatch('pantheon_code_mode_tool', 'pantheon[._]code_mode_*'), false)
  assert.equal(opencodeWildcardMatch('*', '**'), true)
})

test('OpenCode wildcard matching supports its trailing-space star rewrite', () => {
  assert.equal(opencodeWildcardMatch('git', 'git *'), true)
  assert.equal(opencodeWildcardMatch('git status', 'git *'), true)
  assert.equal(opencodeWildcardMatch('git-status', 'git *'), false)
})

test('wildcard overlap uses exact regular-language intersection, not glob-prefix heuristics', () => {
  assert.equal(opencodeWildcardPatternsOverlap('foo/*', 'foo/bar'), true)
  assert.equal(opencodeWildcardPatternsOverlap('foo_*', 'foo_bar'), true)
  assert.equal(opencodeWildcardPatternsOverlap('foo/*', 'bar/*'), false)
  assert.equal(opencodeWildcardPatternsOverlap('foo_*', 'bar_*'), false)
  assert.equal(
    opencodeWildcardPatternsOverlap('pantheon[._]code_mode_*', 'pantheon_code_mode_*'),
    false,
  )
})

test('wildcard overlap models the trailing-space rewrite and slash normalization exactly', () => {
  assert.equal(opencodeWildcardPatternsOverlap('git *', 'git'), true)
  assert.equal(opencodeWildcardPatternsOverlap('foo\\bar', 'foo/bar'), true)
  assert.equal(opencodeWildcardPatternsOverlap('foo *', 'bar'), false)
})
