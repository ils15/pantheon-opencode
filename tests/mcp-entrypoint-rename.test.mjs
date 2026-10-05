/**
 * mcp-entrypoint-rename.test.mjs — issue #198 regression gate.
 *
 * The five Python MCP entrypoints used to end in `*_server.py`, so a broad
 * `pkill -f server.py` matched the entire MCP fleet. They were renamed to
 * distinct tokens. A rename alone would BREAK every existing install, whose
 * `opencode.json` carries literal `scripts/<name>_server.py` paths that would
 * then resolve to nothing — the silent-failure class where every MCP server
 * fails to launch with no obvious cause.
 *
 * This gate proves the migration that makes the rename safe:
 *   1. `migrateMcpEntrypointPaths` rewrites stale paths in both the
 *      `command: [python, script]` shape (opencode.mjs) and the
 *      `args: [script]` shape (install-mcp.mjs), preserving directories.
 *   2. The real installer step `applyMcpServerEntries` heals an existing
 *      config on re-run, and every rewritten entry resolves to a file that
 *      exists in the installed layout.
 *
 * Run: node --test tests/mcp-entrypoint-rename.test.mjs
 */

import { strict as assert } from 'node:assert'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  MCP_ENTRYPOINT_RENAMES,
  migrateMcpEntrypointPaths,
} from '../scripts/install/config-migration.mjs'
import { applyMcpServerEntries } from '../scripts/install/opencode.mjs'
import { ROOT } from '../scripts/install/shared.mjs'

const OLD_TO_NEW = MCP_ENTRYPOINT_RENAMES
const OLD_NAMES = Object.keys(OLD_TO_NEW)
const NEW_NAMES = Object.values(OLD_TO_NEW)

// Canonical source for each installed runtime script, mirroring the installer.
const CANONICAL_SOURCES = {
  'mcp_resources.py': join(ROOT, 'src', 'mcp', 'mcp_resources.py'),
  'code_mode.py': join(ROOT, 'src', 'mcp', 'code_mode.py'),
  'memory_mcp.py': join(ROOT, 'src', 'mcp', 'memory_mcp.py'),
  'mcp_persistence.py': join(ROOT, 'src', 'mcp', 'mcp_persistence.py'),
  'pantheon_vision.py': join(ROOT, 'src', 'mcp', 'pantheon_vision.py'),
}

test('the rename map covers exactly the five collided entrypoints', () => {
  assert.deepEqual(
    [...OLD_NAMES].sort(),
    [
      'code_mode_server.py',
      'mcp_persistence_server.py',
      'mcp_resources_server.py',
      'memory_mcp_server.py',
      'pantheon_vision_server.py',
    ],
    'every pre-rename entrypoint is represented',
  )
  for (const name of NEW_NAMES) {
    assert.equal(name.includes('_server'), false, `${name} must not carry the server.py token`)
  }
})

test('migrateMcpEntrypointPaths heals command[] and args[] forms, preserving directories', () => {
  const mcp = {
    'pantheon-resources': {
      type: 'local',
      command: ['/opt/venv/bin/python3', 'scripts/mcp_resources_server.py'],
      enabled: true,
    },
    'pantheon-code-mode': {
      type: 'local',
      command: ['/opt/venv/bin/python3', './scripts/code_mode_server.py'],
      enabled: true,
    },
    // Standalone installer shape: script lives in args[].
    'hand-edited-key': {
      type: 'local',
      command: '/opt/venv/bin/python3',
      args: ['/home/me/.config/opencode/scripts/mcp_persistence_server.py'],
      enabled: true,
    },
    // Unrelated third-party server must be untouched.
    'my-own': { command: ['python', 'my_own.py'] },
  }

  const healed = migrateMcpEntrypointPaths(mcp)

  assert.equal(healed, 3, 'three stale path strings rewritten')
  assert.equal(mcp['pantheon-resources'].command[1], 'scripts/mcp_resources.py')
  assert.equal(mcp['pantheon-code-mode'].command[1], './scripts/code_mode.py')
  assert.equal(
    mcp['hand-edited-key'].args[0],
    '/home/me/.config/opencode/scripts/mcp_persistence.py',
    'absolute, hand-edited directory prefix is preserved',
  )
  assert.deepEqual(mcp['my-own'].command, ['python', 'my_own.py'])

  // Idempotent: a second pass finds nothing left to rewrite.
  assert.equal(migrateMcpEntrypointPaths(mcp), 0)
})

test('applyMcpServerEntries repairs an existing install whose paths resolve to files that exist', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-mcp-rename-'))
  try {
    // Simulate the installed runtime layout: the installer deploys each
    // entrypoint into <runtime>/scripts/.
    const runtimeTarget = join(target, '.opencode')
    const scriptsDir = join(runtimeTarget, 'scripts')
    mkdirSync(scriptsDir, { recursive: true })
    for (const [name, src] of Object.entries(CANONICAL_SOURCES)) {
      copyFileSync(src, join(scriptsDir, name))
    }

    // A config as left by a PREVIOUS install: every entry still points at the
    // old `*_server.py` filename.
    const config = {
      mcp: Object.fromEntries(
        OLD_NAMES.map((old, i) => [
          `pantheon-${i}`,
          {
            type: 'local',
            cwd: runtimeTarget,
            command: ['/tmp/venv/bin/python3', `scripts/${old}`],
            enabled: true,
          },
        ]),
      ),
    }

    const { healed } = applyMcpServerEntries(config, {
      runtimeTarget,
      venvPython: '/tmp/venv/bin/python3',
    })

    assert.equal(healed, 5, 'all five stale paths rewritten on install')

    const resolved = Object.values(config.mcp).map((entry) => entry.command[1])
    for (const rel of resolved) {
      assert.equal(rel.includes('_server.py'), false, `stale path survived: ${rel}`)
      assert.ok(
        existsSync(join(runtimeTarget, rel)),
        `migrated entry must resolve to an existing file: ${rel}`,
      )
    }

    // And the managed entries were created with the new names.
    assert.equal(config.mcp['pantheon-resources'].command[1], 'scripts/mcp_resources.py')
    assert.equal(config.mcp['pantheon-vision'].command[1], 'scripts/pantheon_vision.py')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('the shipped docs/tests no longer reference the shared server.py token in install configs', () => {
  // Guard against a partial rename: the installer source must not still write
  // an old path. (CHANGELOG/ROADMAP are historical and intentionally excluded.)
  const installer = readFileSync(join(ROOT, 'scripts', 'install', 'opencode.mjs'), 'utf8')
  for (const old of OLD_NAMES) {
    assert.equal(installer.includes(old), false, `installer still references ${old}`)
  }
})
