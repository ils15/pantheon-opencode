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
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { checkInstallVersionDrift } from '../scripts/doctor.mjs'
import { runUpdate } from '../scripts/update.mjs'

const ROOT = process.cwd()
const BIN = join(ROOT, 'bin', 'pantheon-init.mjs')
const DOCTOR = join(ROOT, 'scripts', 'doctor.mjs')

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

test('doctor --json emits versioned JSON and classifies version drift as advisory', () => {
  const home = mkdtempSync(join(tmpdir(), 'pantheon-doctor-json-'))
  const configDir = join(home, '.config', 'opencode')
  try {
    mkdirSync(join(configDir, '.pantheon'), { recursive: true })
    writeFileSync(
      join(configDir, '.pantheon', 'install-state.json'),
      JSON.stringify({ schema_version: 2, pantheon_version: '1.0.0', components: {} }),
    )
    const result = spawnSync(
      process.execPath,
      [DOCTOR, '--json', '--target', ROOT, '--profile', 'lite'],
      {
        encoding: 'utf8',
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') },
      },
    )
    const report = JSON.parse(result.stdout)
    assert.equal(report.schema_version, 1)
    assert.equal(report.command, 'doctor')
    assert.ok(
      report.findings.some(
        (finding) =>
          finding.code === 'install_version_drift' && finding.classification === 'advisory',
      ),
    )
    assert.equal(readdirSync(home).includes('.cache'), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('doctor --json --fix is rejected before performing checks or writes', () => {
  const home = mkdtempSync(join(tmpdir(), 'pantheon-doctor-json-fix-'))
  try {
    const before = readdirSync(home)
    const result = spawnSync(process.execPath, [DOCTOR, '--json', '--fix', '--target', home], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config') },
    })
    assert.notEqual(result.status, 0)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, 'error')
    assert.ok(report.findings.some((finding) => finding.code === 'json_fix_unsupported'))
    assert.deepEqual(readdirSync(home), before)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('update refuses a local checkout before registry access', () => {
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
  assert.match(`${result.stderr}${result.stdout}`, /only from the global Pantheon installation/)
  assert.doesNotMatch(`${result.stderr}${result.stdout}`, /Could not reach the npm registry/)
})

test('authorized global update verifies the refreshed version before config refresh', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-update-global-'))
  const globalRoot = join(root, 'npm-global')
  const packageRoot = join(globalRoot, 'pantheon-opencode')
  const script = join(packageRoot, 'bin', 'pantheon-init.mjs')
  try {
    mkdirSync(join(packageRoot, 'bin'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ version: '1.6.0-beta.11' }))
    writeFileSync(script, '#!/usr/bin/env node\n')
    let refreshes = 0
    const spawnSyncImpl = (_command, args) => {
      if (args[0] === 'root') return { status: 0, stdout: `${globalRoot}\n`, stderr: '' }
      if (args[0] === 'view') return { status: 0, stdout: '1.6.0-beta.12\n', stderr: '' }
      if (args[0] === 'install') {
        writeFileSync(
          join(packageRoot, 'package.json'),
          JSON.stringify({ version: '1.6.0-beta.12' }),
        )
        return { status: 0, stdout: '', stderr: '' }
      }
      throw new Error(`Unexpected command: ${args.join(' ')}`)
    }
    const status = await runUpdate([], {
      root: packageRoot,
      currentVersion: '1.6.0-beta.11',
      runningScript: script,
      spawnSync: spawnSyncImpl,
      refresh: () => {
        refreshes += 1
        return { status: 0 }
      },
    })
    assert.equal(status, 0)
    assert.equal(refreshes, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('update refuses a global package symlink into a workspace before registry access', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-update-global-symlink-'))
  const globalRoot = join(root, 'npm-global')
  const workspaceRoot = join(root, 'workspace', 'pantheon-opencode')
  const script = join(workspaceRoot, 'bin', 'pantheon-init.mjs')
  const globalEntry = join(globalRoot, 'pantheon-opencode')
  try {
    mkdirSync(join(workspaceRoot, 'bin'), { recursive: true })
    mkdirSync(globalRoot)
    writeFileSync(join(workspaceRoot, 'package.json'), JSON.stringify({ version: '1.6.0-beta.11' }))
    writeFileSync(script, '#!/usr/bin/env node\n')
    symlinkSync(workspaceRoot, globalEntry, 'dir')

    const calls = []
    const originalError = console.error
    console.error = () => {}
    let status
    try {
      status = await runUpdate([], {
        root: workspaceRoot,
        currentVersion: '1.6.0-beta.11',
        runningScript: script,
        spawnSync: (_command, args) => {
          calls.push(args[0])
          if (args[0] === 'root') return { status: 0, stdout: `${globalRoot}\n`, stderr: '' }
          throw new Error(`Unexpected command: ${args.join(' ')}`)
        },
      })
    } finally {
      console.error = originalError
    }

    assert.equal(status, 1)
    assert.deepEqual(calls, ['root'], 'must refuse before npm registry access or install')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('update refuses a symlinked npm global-root ancestor before registry or refresh', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-update-global-ancestor-link-'))
  const actualParent = join(root, 'actual-parent')
  const actualGlobalRoot = join(actualParent, 'npm-global')
  const linkedParent = join(root, 'linked-parent')
  const packageRoot = join(actualGlobalRoot, 'pantheon-opencode')
  const script = join(packageRoot, 'bin', 'pantheon-init.mjs')
  try {
    mkdirSync(join(packageRoot, 'bin'), { recursive: true })
    symlinkSync(actualParent, linkedParent, 'dir')
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ version: '1.6.0-beta.11' }))
    writeFileSync(script, '#!/usr/bin/env node\n')

    const calls = []
    let refreshes = 0
    const originalError = console.error
    console.error = () => {}
    let status
    try {
      status = await runUpdate([], {
        root: packageRoot,
        currentVersion: '1.6.0-beta.11',
        runningScript: script,
        spawnSync: (_command, args) => {
          calls.push(args[0])
          if (args[0] === 'root') {
            return { status: 0, stdout: `${join(linkedParent, 'npm-global')}\n`, stderr: '' }
          }
          throw new Error(`Unexpected command: ${args.join(' ')}`)
        },
        refresh: () => {
          refreshes += 1
          return { status: 0 }
        },
      })
    } finally {
      console.error = originalError
    }

    assert.equal(status, 1)
    assert.deepEqual(calls, ['root'], 'must refuse before npm view/install')
    assert.equal(refreshes, 0, 'must not refresh config after a linked global root')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('global update suppresses config refresh when refreshed package version mismatches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-update-mismatch-'))
  const globalRoot = join(root, 'npm-global')
  const packageRoot = join(globalRoot, 'pantheon-opencode')
  const script = join(packageRoot, 'bin', 'pantheon-init.mjs')
  try {
    mkdirSync(join(packageRoot, 'bin'), { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ version: '1.6.0-beta.11' }))
    writeFileSync(script, '#!/usr/bin/env node\n')
    let refreshes = 0
    const spawnSyncImpl = (_command, args) => {
      if (args[0] === 'root') return { status: 0, stdout: `${globalRoot}\n`, stderr: '' }
      if (args[0] === 'view') return { status: 0, stdout: '1.6.0-beta.12\n', stderr: '' }
      if (args[0] === 'install') return { status: 0, stdout: '', stderr: '' }
      throw new Error(`Unexpected command: ${args.join(' ')}`)
    }
    const status = await runUpdate([], {
      root: packageRoot,
      currentVersion: '1.6.0-beta.11',
      runningScript: script,
      spawnSync: spawnSyncImpl,
      refresh: () => {
        refreshes += 1
        return { status: 0 }
      },
    })
    assert.equal(status, 1)
    assert.equal(refreshes, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('update binary exists in usage output', () => {
  const result = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8', timeout: 30_000 })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /update \[--stable\]/)
})
