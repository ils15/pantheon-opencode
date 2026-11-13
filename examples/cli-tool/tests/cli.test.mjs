import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkRepoHealth } from '../bin/repo-health.mjs'

test('repo health checker evaluation logic', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'pantheon-repo-health-'))

  t.after(() => {
    rmSync(temp, { recursive: true, force: true })
  })

  await t.test('evaluates incomplete directory with penalty', () => {
    const res = checkRepoHealth(temp)
    assert.ok(res.score < 100)
    assert.ok(res.issues.length > 0)
    assert.match(res.status, /REGULAR|CRÍTICO/)
  })

  await t.test('evaluates valid package.json and README', () => {
    writeFileSync(
      join(temp, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        description: 'Testing',
        scripts: { test: 'node --test' },
      }),
    )
    writeFileSync(join(temp, 'README.md'), '# Test App')
    const res = checkRepoHealth(temp)
    assert.ok(res.score >= 50)
  })
})
