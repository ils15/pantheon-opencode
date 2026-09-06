import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveMcpCwd, resolveMcpScriptPaths, resolveRuntimePython } from '../scripts/doctor.mjs'

test('doctor resolves project runtime venv beside the project, not under global config', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-project-'))
  try {
    mkdirSync(join(target, '.opencode', 'scripts'), { recursive: true })
    assert.equal(
      resolveRuntimePython({ target, profile: 'sandbox' }),
      join(target, '.venv', 'bin', 'python3'),
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('doctor resolves relative MCP scripts against the entry cwd in project layout', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-project-'))
  try {
    assert.deepEqual(
      resolveMcpScriptPaths({
        cwd: join(target, '.opencode'),
        command: ['/venv/python', 'scripts/server.py'],
      }),
      [join(target, '.opencode', 'scripts/server.py')],
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('doctor resolves a relative MCP cwd from the config file directory', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-project-'))
  try {
    assert.equal(
      resolveMcpCwd({ cwd: '.opencode' }, join(target, 'opencode.json')),
      join(target, '.opencode'),
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
