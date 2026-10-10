import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const probe = fileURLToPath(new URL('../scripts/probe-pantheon-cost.mjs', import.meta.url))

for (const version of ['v1', 'v2']) {
  test(`${version} cost fixture runs outside node_modules and ignores inherited OPENCODE_DB`, () => {
    const result = spawnSync(
      process.execPath,
      [probe, '--version', version, '--fixture', '--json'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          OPENCODE_DB: '/tmp/pantheon-cost-probe-must-not-read.db',
          PANTHEON_COST_DB: '/tmp/pantheon-cost-probe-must-not-read.db',
        },
      },
    )

    assert.equal(result.status, 0, result.stderr)
    assert.notEqual(result.stdout, '', JSON.stringify(result))
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'PASS', report.detail)
    assert.equal(report.version, version)
    assert.equal(report.checks.length, 5)
    assert.match(report.detail, /no user database was read/)
  })
}
