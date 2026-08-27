import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const ROOT = process.cwd()
const CLI = join(ROOT, 'bin', 'pantheon-init.mjs')

test('installer synchronizes the pantheon-model slash command', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-model-command-install-'))
  try {
    const result = spawnSync(
      process.execPath,
      [CLI, 'init', '--project', '--headless', '--yes', '--no-mcp', '--components', 'commands'],
      { cwd: target, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    const installed = join(target, '.opencode', 'commands', 'pantheon-model.md')
    assert.equal(existsSync(installed), true)
    assert.equal(
      readFileSync(installed, 'utf8'),
      readFileSync(join(ROOT, 'commands', 'pantheon-model.md'), 'utf8'),
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
