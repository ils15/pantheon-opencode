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
      [
        CLI,
        'init',
        '--project',
        '--headless',
        '--yes',
        '--no-mcp',
        '--components',
        'commands',
        '--opencode-version=v2',
      ],
      { cwd: target, encoding: 'utf8' },
    )
    assert.equal(result.status, 0, result.stderr)
    const installed = join(target, 'commands', 'pantheon-model.md')
    assert.equal(existsSync(installed), true)
    assert.equal(
      readFileSync(installed, 'utf8'),
      readFileSync(join(ROOT, 'commands', 'pantheon-model.md'), 'utf8'),
    )
    const focusCommand = join(target, 'commands', 'pantheon-focus.md')
    assert.equal(existsSync(focusCommand), true, '/pantheon-focus must be installed')
    assert.equal(
      readFileSync(focusCommand, 'utf8'),
      readFileSync(join(ROOT, 'commands', 'pantheon-focus.md'), 'utf8'),
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('/pantheon-consolidate runs as Mnemosyne, the memory owner', () => {
  const command = readFileSync(join(ROOT, 'commands', 'pantheon-consolidate.md'), 'utf8')
  assert.match(command, /^agent:\s*mnemosyne$/m)
  assert.match(command, /memory_forget/)
  assert.match(command, /memory_store/)
})

test('/pantheon-focus is packaged as a conversation-only goal command', () => {
  const command = readFileSync(join(ROOT, 'commands', 'pantheon-focus.md'), 'utf8')
  assert.match(command, /^description:.*working goal/m)
  assert.match(command, /conversation-only/)
  assert.match(command, /Do not call memory or persistence tools/)
  assert.match(command, /\/pantheon-deepwork/)
})
