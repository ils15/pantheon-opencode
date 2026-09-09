import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'

const ROOT = process.cwd()

function fakeNpm(root) {
  const bin = join(root, 'bin')
  const log = join(root, 'npm.log')
  mkdirSync(bin)
  const npm = join(bin, 'npm')
  writeFileSync(npm, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$FAKE_NPM_LOG"\nexit 23\n`)
  chmodSync(npm, 0o755)
  return { bin, log }
}

test('sync-tui propagates npm ci failure and never invokes npm install', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-sync-tui-'))
  const config = join(root, 'config', 'opencode')
  const plugin = join(config, 'plugins', 'pantheon-tui')
  mkdirSync(plugin, { recursive: true })
  writeFileSync(join(plugin, 'package.json'), '{"version":"0.0.0"}\n')
  const { bin, log } = fakeNpm(root)
  try {
    const result = spawnSync(process.execPath, [join(ROOT, 'scripts', 'sync-tui.mjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(root, 'config'),
        HOME: root,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        FAKE_NPM_LOG: log,
        PANTHEON_ALLOW_NPM_INSTALL_FALLBACK: '1',
      },
    })
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    const calls = readFileSync(log, 'utf8').trim().split('\n')
    assert.equal(calls.length, 1)
    assert.match(calls[0], /^ci /)
    assert.doesNotMatch(calls[0], /install/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
