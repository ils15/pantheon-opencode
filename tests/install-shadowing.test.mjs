import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkPathShadowing } from '../scripts/doctor.mjs'
import { resolveStablePantheonRoot } from '../scripts/install/opencode.mjs'
import { sanitizeNpmEnv } from '../scripts/sync-tui.mjs'

test('sanitizeNpmEnv removes allow-scripts and global config keys', () => {
  const dirty = {
    PATH: '/usr/bin',
    NODE_ENV: 'production',
    npm_config_global: 'true',
    npm_config_prefix: '/usr/local',
    npm_config_allow_scripts: 'pantheon-opencode',
    npm_config_approve_scripts: 'true',
  }
  const clean = sanitizeNpmEnv(dirty)
  assert.equal(clean.PATH, '/usr/bin')
  assert.equal(clean.NODE_ENV, 'production')
  assert.equal(clean.npm_config_global, undefined)
  assert.equal(clean.npm_config_prefix, undefined)
  assert.equal(clean.npm_config_allow_scripts, undefined)
  assert.equal(clean.npm_config_approve_scripts, undefined)
})

test('resolveStablePantheonRoot rejects stale globalCandidate with version skew', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'npx-skew-test-'))
  try {
    const runningRoot = join(tmp, '_npx', 'hash123', 'node_modules', 'pantheon-opencode')
    mkdirSync(runningRoot, { recursive: true })
    writeFileSync(
      join(runningRoot, 'package.json'),
      JSON.stringify({ name: 'pantheon-opencode', version: '2.1.4' }),
    )

    // Running from npx without global candidate -> returns runningRoot, volatile: true
    const resNoGlobal = resolveStablePantheonRoot(runningRoot)
    assert.equal(resNoGlobal.root, runningRoot)
    assert.equal(resNoGlobal.volatile, true)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('checkPathShadowing handles multiple binaries across prefixes and dangling symlinks', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'shadowing-test-'))
  try {
    const bin1 = join(tmp, 'bin1')
    const bin2 = join(tmp, 'bin2')
    mkdirSync(bin1, { recursive: true })
    mkdirSync(bin2, { recursive: true })

    // Create binary 1
    const script1 = join(bin1, 'pantheon-opencode')
    writeFileSync(script1, '#!/usr/bin/env node\n', { mode: 0o755 })
    writeFileSync(
      join(bin1, 'package.json'),
      JSON.stringify({ name: 'pantheon-opencode', version: '2.0.3' }),
    )

    // Create binary 2
    const script2 = join(bin2, 'pantheon-opencode')
    writeFileSync(script2, '#!/usr/bin/env node\n', { mode: 0o755 })
    writeFileSync(
      join(bin2, 'package.json'),
      JSON.stringify({ name: 'pantheon-opencode', version: '2.1.4' }),
    )

    // PATH pointing to bin1:bin2 before system PATH
    const env = { ...process.env, PATH: `${bin1}:${bin2}:${process.env.PATH || ''}` }
    const result = checkPathShadowing({ env })
    assert.equal(result, 'shadowing')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})
