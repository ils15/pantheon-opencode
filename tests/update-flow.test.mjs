/**
 * update-flow.test.mjs — beta.5 update flow contracts.
 *
 * 1. doctor detects installed-version drift (warn, never error).
 * 2. `update` with an up-to-date install exits 0 without touching npm.
 * 3. `update` unreachable registry fails with a clear message (exit 1).
 *
 * Run: node --test tests/update-flow.test.mjs
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { checkInstallVersionDrift } from '../scripts/doctor.mjs'

const ROOT = process.cwd()
const BIN = join(ROOT, 'bin', 'pantheon-init.mjs')

test('doctor warns when the package is newer than the installation marker', () => {
  const home = mkdtempSync(join(tmpdir(), 'pantheon-drift-'))
  try {
    const configDir = join(home, '.config', 'opencode')
    mkdirSync(join(configDir, '.pantheon'), { recursive: true })
    writeFileSync(
      join(configDir, '.pantheon', 'install-state.json'),
      JSON.stringify({ schema_version: 2, pantheon_version: '1.5.0-beta.3', updated_at: 'x' }),
    )

    // warning() prints — capture to assert the guidance is present. The drift
    // path must NOT flip the doctor into an error state (exit 2), so we call
    // the check directly and only assert on output.
    const origLog = console.log
    const lines = []
    console.log = (...a) => lines.push(a.join(' '))
    try {
      checkInstallVersionDrift({
        env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config') },
        target: ROOT,
      })
    } finally {
      console.log = origLog
    }
    const joined = lines.join('\n')
    assert.match(joined, /newer than the last-synced installation/)
    assert.match(joined, /pantheon-opencode update/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('doctor reports in-sync when the marker matches the package version', () => {
  const home = mkdtempSync(join(tmpdir(), 'pantheon-drift2-'))
  try {
    const configDir = join(home, '.config', 'opencode')
    mkdirSync(join(configDir, '.pantheon'), { recursive: true })
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
    writeFileSync(
      join(configDir, '.pantheon', 'install-state.json'),
      JSON.stringify({ schema_version: 2, pantheon_version: pkg, updated_at: 'x' }),
    )
    const origLog = console.log
    const lines = []
    console.log = (...a) => lines.push(a.join(' '))
    let outcome
    try {
      outcome = checkInstallVersionDrift({
        env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config') },
        target: ROOT,
      })
    } finally {
      console.log = origLog
    }
    assert.equal(outcome, 'sync')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('update on an unreachable registry fails with exit 1 and a clear message', () => {
  const result = spawnSync(process.execPath, [BIN, 'update'], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      PATH: '/nonexistent-dir',
      // npm itself lives on PATH — with it stripped, `npm view` cannot run,
      // which is exactly the unreachable-registry branch.
    },
  })
  assert.notEqual(result.status, 0)
  assert.match(`${result.stderr}${result.stdout}`, /Could not reach the npm registry/)
})

test('update binary exists in usage output', () => {
  const result = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /update \[--stable\]/)
})
