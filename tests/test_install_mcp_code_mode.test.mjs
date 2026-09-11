import test from 'node:test'
import assert from 'node:assert/strict'
import { MCPS } from '../scripts/install-mcp.mjs'

const codeMode = MCPS['pantheon-code-mode']

test('code-mode config sets workspace cwd', () => {
  assert.equal(codeMode.platforms.opencode.cwd, '.')
})

test('code-mode config preserves global install fallback', () => {
  assert.ok(codeMode.platforms.opencode.args.length > 0)
})

test('code-mode config does not introduce environment', () => {
  assert.deepEqual(codeMode.env, [])
  assert.equal('environment' in codeMode.platforms.opencode, false)
})
