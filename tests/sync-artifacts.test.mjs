/**
 * sync-artifacts.test.mjs — postinstall freshness guarantee (beta.5).
 *
 * Proves syncCopyArtifacts refreshes copy-only artifacts (agents, routing,
 * skills, AGENTS.md, commands, MCP scripts, code-mode payload) into a config
 * dir, is byte-compare idempotent, and never touches config merge concerns.
 *
 * Run: node --test tests/sync-artifacts.test.mjs
 */
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { syncCopyArtifacts } from '../scripts/sync-artifacts.mjs'

const ROOT = process.cwd()

test('syncs copy-only artifacts into a config dir and is idempotent', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'pantheon-syncart-'))
  try {
    const first = syncCopyArtifacts(configDir)

    // Agents, skills, AGENTS.md, commands, MCP scripts, code-mode, tiers.
    assert.ok(first.created > 0, `first pass must copy files, got ${first.created}`)
    assert.equal(first.errors.length, 0, `no errors expected: ${first.errors.join('; ')}`)
    assert.ok(existsSync(join(configDir, 'agents', 'zeus.md')), 'agent copied')
    assert.ok(existsSync(join(configDir, 'routing.yml')), 'routing.yml copied')
    assert.ok(existsSync(join(configDir, 'AGENTS.md')), 'AGENTS.md copied')
    assert.ok(existsSync(join(configDir, 'skills')), 'skills dir populated')
    assert.ok(existsSync(join(configDir, 'commands', 'pantheon-model.md')), 'command copied')
    assert.ok(existsSync(join(configDir, 'scripts', 'code_mode_server.py')), 'MCP script copied')
    assert.ok(
      existsSync(join(configDir, '.pantheon', 'code-mode', 'manifest.json')),
      'code-mode payload (with manifest) copied',
    )

    // Byte-compare idempotency: second pass skips everything.
    const second = syncCopyArtifacts(configDir)
    assert.equal(second.created, 0, `second pass must skip all, updated ${second.created}`)
    assert.equal(second.errors.length, 0)

    // Content parity with the package source.
    assert.equal(
      readFileSync(join(configDir, 'AGENTS.md'), 'utf8'),
      readFileSync(join(ROOT, 'AGENTS.md'), 'utf8'),
    )
    assert.equal(
      readFileSync(join(configDir, 'scripts', 'code_mode_server.py'), 'utf8'),
      readFileSync(join(ROOT, 'src', 'mcp', 'code_mode_server.py'), 'utf8'),
    )
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})

test('sync never writes config merge artifacts (opencode.json, tui.json, venv)', () => {
  const configDir = mkdtempSync(join(tmpdir(), 'pantheon-syncart2-'))
  try {
    syncCopyArtifacts(configDir)
    assert.equal(existsSync(join(configDir, 'opencode.json')), false, 'no config merge')
    assert.equal(existsSync(join(configDir, 'tui.json')), false, 'no tui registration')
    assert.equal(existsSync(join(configDir, '.venv')), false, 'no venv setup')
    assert.equal(existsSync(join(configDir, '.pantheon', 'install-state.json')), false,
      'version marker is written by the postinstall, not by the artifact sync')
  } finally {
    rmSync(configDir, { recursive: true, force: true })
  }
})
