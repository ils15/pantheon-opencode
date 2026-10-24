import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  assertOpenCodeVersion,
  canarySandboxCleanup,
  createChildProcessStopper,
  parseOpenCodeVersion,
  redactDiagnosticSecret,
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

test('host diagnostics redact every occurrence of a generated password', () => {
  const password = randomBytes(24).toString('hex')
  const diagnostic = [
    `server password ${password}`,
    `authorization failed for ${password}`,
    `multiline value:\n${password}\nend`,
  ].join('\n')

  const sanitized = redactDiagnosticSecret(diagnostic, password)
  assert.equal(sanitized.includes(password), false)
  assert.match(sanitized, /server password \[REDACTED\]/)
  assert.match(sanitized, /authorization failed for \[REDACTED\]/)
  assert.match(sanitized, /multiline value:\n\[REDACTED\]\nend/)
})

test('host shutdown fails when its child remains alive after SIGKILL', async () => {
  const signals = []
  const child = {
    pid: 12345,
    exitCode: null,
    signalCode: null,
    kill(signal) {
      signals.push(signal)
      return true
    },
  }
  const stop = createChildProcessStopper(child, {
    timeoutMs: 7,
    waitForExit: async () => false,
  })

  await assert.rejects(stop(), /host pid 12345 remained alive after SIGKILL/)
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
  assert.equal(child.exitCode, null)
  assert.equal(child.signalCode, null)
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
