import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'

import { sanitizeNpmEnv } from '../scripts/sync-tui.mjs'

const ROOT = process.cwd()

/**
 * Fake npm that records the npm_config_* context it inherits, then exits 0
 * without touching the network. Mirrors the ECIGLOBAL regression: a nested
 * `npm ci` must never see npm_config_global / npm_config_prefix.
 */
function fakeEnvNpm(root) {
  const bin = join(root, 'bin')
  const log = join(root, 'npm-env.log')
  mkdirSync(bin)
  const npm = join(bin, 'npm')
  writeFileSync(
    npm,
    [
      '#!/usr/bin/env bash',
      'printf "args=%s\\n" "$*" >> "$FAKE_NPM_LOG"',
      'g=$(printenv npm_config_global) || g=unset',
      'printf "global=%s\\n" "$g" >> "$FAKE_NPM_LOG"',
      'p=$(printenv npm_config_prefix) || p=unset',
      'printf "prefix=%s\\n" "$p" >> "$FAKE_NPM_LOG"',
      'exit 0',
      '',
    ].join('\n'),
  )
  chmodSync(npm, 0o755)
  return { bin, log }
}

test('sanitizeNpmEnv strips global-context npm vars without mutating input', () => {
  const env = {
    PATH: '/bin',
    npm_config_cache: '/cache',
    npm_config_global: 'true',
    NPM_CONFIG_PREFIX: '/usr/local',
    npm_config_location: 'global',
  }

  const clean = sanitizeNpmEnv(env)

  assert.equal(clean.npm_config_global, undefined)
  assert.equal(clean.NPM_CONFIG_PREFIX, undefined)
  assert.equal(clean.npm_config_location, undefined)
  // Non-global config and unrelated vars must survive untouched.
  assert.equal(clean.PATH, '/bin')
  assert.equal(clean.npm_config_cache, '/cache')
  // Input env must not be mutated.
  assert.equal(env.npm_config_global, 'true')
  assert.equal(env.NPM_CONFIG_PREFIX, '/usr/local')
})

test('sanitizeNpmEnv is a no-op for local (non-global) context', () => {
  const env = { PATH: '/bin', npm_config_cache: '/cache', npm_config_registry: 'https://r' }
  const clean = sanitizeNpmEnv(env)
  assert.deepEqual(clean, env)
  assert.notEqual(clean, env)
})

test('sync-tui strips npm_config_global/prefix from nested npm ci env', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-sync-tui-env-'))
  const config = join(root, 'config', 'opencode')
  const plugin = join(config, 'plugins', 'pantheon-tui')
  mkdirSync(plugin, { recursive: true })
  writeFileSync(join(plugin, 'package.json'), '{"version":"0.0.0"}\n')
  const { bin, log } = fakeEnvNpm(root)
  try {
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-tui.mjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(root, 'config'),
        HOME: root,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        FAKE_NPM_LOG: log,
        npm_config_global: 'true',
        npm_config_prefix: '/usr/local',
      },
    })
    assert.equal(result.status, 0, result.stdout + result.stderr)
    const seen = readFileSync(log, 'utf8')
    assert.match(seen, /^args=ci /m)
    assert.match(seen, /^global=unset$/m, seen)
    assert.match(seen, /^prefix=unset$/m, seen)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
