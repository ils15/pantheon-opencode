import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  assertOpenCodeVersion,
  canarySandboxCleanup,
  parseOpenCodeVersion,
} from './tool-canary-support.mjs'

test('OpenCode version check accepts exact normalized versions only', () => {
  assert.equal(
    assertOpenCodeVersion({ output: 'opencode 2.0.30\n', expected: '2.0.30', status: 0 }),
    '2.0.30',
  )
  assert.equal(parseOpenCodeVersion('OpenCode v2.0.30-beta.1+build.7'), '2.0.30-beta.1+build.7')
  assert.equal(
    assertOpenCodeVersion({
      output: 'OpenCode v2.0.30-beta.1+build.7',
      expected: '2.0.30-beta.1+build.7',
      status: 0,
    }),
    '2.0.30-beta.1+build.7',
  )
  assert.throws(
    () => assertOpenCodeVersion({ output: 'opencode 2.0.300', expected: '2.0.30', status: 0 }),
    /expected OpenCode 2\.0\.30/,
  )
  assert.throws(
    () => assertOpenCodeVersion({ output: 'opencode 2.0.31', expected: '2.0.30', status: 0 }),
    /parsed=2\.0\.31/,
  )
  assert.throws(
    () => assertOpenCodeVersion({ output: 'opencode 2.0.30.1', expected: '2.0.30', status: 0 }),
    /could not parse one valid OpenCode version/,
  )
  assert.throws(
    () => assertOpenCodeVersion({ output: 'opencode 2.0.30', expected: '2.0.30.1', status: 0 }),
    /expected OpenCode version is not a valid semantic version/,
  )
})

test('test teardown removes canary projects after model, host, or prompt failures', async (t) => {
  const roots = []
  t.after(() => {
    canarySandboxCleanup.cleanup()
    for (const root of roots) assert.equal(existsSync(root), false)
  })

  for (const phase of ['model startup', 'host startup', 'prompt']) {
    const root = mkdtempSync(join(tmpdir(), 'pantheon-tool-canary-cleanup-'))
    canarySandboxCleanup.register(root)
    roots.push(root)
    await assert.rejects(
      async () => {
        throw new Error(`${phase} failed`)
      },
      new RegExp(`${phase} failed`),
    )
  }
})
