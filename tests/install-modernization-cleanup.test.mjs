/**
 * Regression tests for Pantheon 2.2.2 plugin-only architecture:
 *   1. Exact reproducer (`opencode.json` + `opencode.jsonc`): startup/boot migration
 *      automatically removes legacy Python MCPs (`pantheon-code-mode`, etc.), legacy
 *      plugins (`plugin` singular, `pantheon-hooks.*`, `src/plugin.ts`, dead `_npx`),
 *      copied old TUI (`plugins/pantheon-tui`, empty `tui.json`/`cli.json`), copied
 *      Pantheon `agents/`/`commands/`/`skills/`/`routing.yml`/`install-state.json`,
 *      config `.venv`, and `scripts/*.py` — while preserving comments, user MCPs
 *      (`context7`), user custom agents/skills, and project-root `.venv`/`scripts/`.
 *   2. `scripts/postinstall.mjs` runs legacy cleanup safely inside `XDG_CONFIG_HOME` /
 *      `PANTHEON_HOME` with zero file copies and zero `npx` hints.
 *   3. `purgeAllPantheonData` in both `legacy-store-migration.mjs` and TUI `legacy-audit.ts`
 *      cleanly removes `.pantheon/` stores and configs on user reset.
 *   4. `scripts/doctor.mjs` passes cleanly on native plugin-only installs and flags/fixes
 *      broken Python MCPs cleanly with `--fix`.
 */

import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  ensureLegacyStoresMigratedOnce,
  purgeAllPantheonData,
  resetLegacyMigrationCacheForTests,
} from '../src/pantheon/legacy-store-migration.mjs'
import {
  cleanLegacyArtifacts as tuiCleanLegacyArtifacts,
  purgeAllPantheonData as tuiPurgeAllPantheonData,
  scanLegacyArtifacts as tuiScanLegacyArtifacts,
} from '../src/plugins/tui/src/legacy-audit.ts'

const REPO_ROOT = process.cwd()

function seedFullLegacyTarget(configDir, workspaceDir) {
  mkdirSync(join(configDir, 'plugins', 'pantheon-tui', 'dist'), { recursive: true })
  mkdirSync(join(configDir, 'agents'), { recursive: true })
  mkdirSync(join(configDir, 'commands'), { recursive: true })
  mkdirSync(join(configDir, 'skills', 'memory-bank'), { recursive: true })
  mkdirSync(join(configDir, 'skills', 'my-custom-skill'), { recursive: true })
  mkdirSync(join(configDir, '.venv', 'bin'), { recursive: true })
  mkdirSync(join(configDir, 'scripts'), { recursive: true })
  mkdirSync(join(configDir, '.pantheon', 'code-mode'), { recursive: true })

  mkdirSync(join(workspaceDir, '.venv', 'bin'), { recursive: true })
  mkdirSync(join(workspaceDir, 'scripts'), { recursive: true })

  writeFileSync(join(configDir, 'plugins', 'pantheon-hooks.ts'), '// old hook\n')
  writeFileSync(join(configDir, 'plugins', 'pantheon-tui', 'dist', 'tui.js'), 'export default {}\n')
  writeFileSync(join(configDir, 'scripts', 'code_mode.py'), '# old script\n')
  writeFileSync(join(configDir, 'requirements-vision.txt'), 'pillow\n')
  writeFileSync(join(configDir, '.venv', 'bin', 'python3'), '#!/bin/sh\n')
  writeFileSync(join(configDir, 'agents', 'zeus.md'), '---\ntier: T1\n---\n# zeus pantheon\n')
  writeFileSync(join(configDir, 'agents', 'custom-agent.md'), '# custom user agent\n')
  writeFileSync(join(configDir, 'commands', 'pantheon.md'), '---\ndescription: pantheon\n---\n')
  writeFileSync(join(configDir, 'commands', 'custom-cmd.md'), '# user command\n')
  writeFileSync(join(configDir, 'skills', 'memory-bank', 'SKILL.md'), '# memory-bank\n')
  writeFileSync(join(configDir, 'skills', 'my-custom-skill', 'SKILL.md'), '# user skill\n')
  writeFileSync(join(configDir, 'routing.yml'), 'agents:\n  zeus:\n    tier: T1\n')
  writeFileSync(join(configDir, '.pantheon', 'install-state.json'), '{"schema_version":2}\n')
  writeFileSync(join(configDir, '.pantheon', 'code-mode', 'compress-inline.py'), '# py\n')
  writeFileSync(join(configDir, 'tui.json'), JSON.stringify({ plugin: ['plugins/pantheon-tui'] }))
  writeFileSync(join(configDir, 'cli.json'), JSON.stringify({ plugins: ['!plugins/pantheon-tui'] }))

  writeFileSync(join(workspaceDir, '.venv', 'bin', 'python3'), '# user project venv\n')
  writeFileSync(join(workspaceDir, 'scripts', 'app.py'), '# user project script\n')

  writeFileSync(
    join(configDir, 'opencode.json'),
    JSON.stringify(
      {
        plugin: ['pantheon-hooks.ts', 'other-v1-plugin'],
        plugins: [
          'pantheon-opencode',
          { package: '/tmp/dead/_npx/dead/node_modules/pantheon-opencode/src/plugin.ts' },
          { package: 'third-party-plugin' },
        ],
        mcp: {
          servers: {
            'pantheon-code-mode': {
              type: 'local',
              command: ['/home/admin/.config/opencode/.venv/bin/python3', 'scripts/code_mode.py'],
            },
            'pantheon-memory': {
              type: 'local',
              command: ['/home/admin/.config/opencode/.venv/bin/python3', 'scripts/memory_mcp.py'],
            },
            context7: { type: 'local', command: ['npx', '-y', '@upstash/context7-mcp'] },
          },
        },
      },
      null,
      2,
    ),
  )

  writeFileSync(
    join(configDir, 'opencode.jsonc'),
    `{
  // Keep this user comment
  "plugins": [
    "pantheon-opencode",
    "/home/admin/.config/opencode/plugins/pantheon-hooks.ts",
    "third-party-plugin"
  ],
  "mcp": {
    "servers": {
      "pantheon-code-mode": {
        "type": "local",
        "command": ["/home/admin/.config/opencode/.venv/bin/python3", "scripts/code_mode.py"]
      },
      "context7": {
        "type": "local",
        "command": ["npx", "-y", "@upstash/context7-mcp"]
      }
    }
  }
}
`,
  )
}

test('exact reproducer: boot migration cleans Python MCPs, old TUI, and copied assets while preserving user custom files and project .venv', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-repro-222-'))
  try {
    resetLegacyMigrationCacheForTests()
    const xdg = join(root, 'xdg')
    const configDir = join(xdg, 'opencode')
    const workspaceDir = join(root, 'my-python-project')
    seedFullLegacyTarget(configDir, workspaceDir)

    ensureLegacyStoresMigratedOnce(workspaceDir, {
      env: { ...process.env, HOME: root, XDG_CONFIG_HOME: xdg, PANTHEON_HOME: configDir },
      cleanCopiedInstallArtifacts: true,
    })

    const cleanedJson = JSON.parse(readFileSync(join(configDir, 'opencode.json'), 'utf8'))
    assert.equal(cleanedJson.mcp.servers['pantheon-code-mode'], undefined)
    assert.equal(cleanedJson.mcp.servers['pantheon-memory'], undefined)
    assert.ok(cleanedJson.mcp.servers.context7, 'user MCP context7 preserved')
    assert.deepEqual(cleanedJson.plugin, ['other-v1-plugin'])
    assert.deepEqual(cleanedJson.plugins, ['pantheon-opencode', { package: 'third-party-plugin' }])

    const cleanedJsonc = readFileSync(join(configDir, 'opencode.jsonc'), 'utf8')
    assert.match(cleanedJsonc, /\/\/ Keep this user comment/)
    assert.doesNotMatch(cleanedJsonc, /pantheon-code-mode/)
    assert.doesNotMatch(cleanedJsonc, /pantheon-hooks\.ts/)
    assert.match(cleanedJsonc, /"context7"/)

    // Old TUI & CLI-copied artifacts removed
    assert.equal(existsSync(join(configDir, 'plugins', 'pantheon-tui')), false)
    assert.equal(existsSync(join(configDir, 'plugins', 'pantheon-hooks.ts')), false)
    assert.equal(existsSync(join(configDir, 'tui.json')), false)
    assert.equal(existsSync(join(configDir, 'cli.json')), false)
    assert.equal(existsSync(join(configDir, 'scripts', 'code_mode.py')), false)
    assert.equal(existsSync(join(configDir, 'requirements-vision.txt')), false)
    assert.equal(existsSync(join(configDir, '.venv')), false)
    assert.equal(existsSync(join(configDir, 'agents', 'zeus.md')), false)
    assert.equal(existsSync(join(configDir, 'commands', 'pantheon.md')), false)
    assert.equal(existsSync(join(configDir, 'skills', 'memory-bank')), false)
    assert.equal(existsSync(join(configDir, 'routing.yml')), false)
    assert.equal(existsSync(join(configDir, '.pantheon', 'install-state.json')), false)
    assert.equal(existsSync(join(configDir, '.pantheon', 'code-mode', 'compress-inline.py')), false)

    // User custom assets and project files untouched
    assert.equal(existsSync(join(configDir, 'agents', 'custom-agent.md')), true)
    assert.equal(existsSync(join(configDir, 'commands', 'custom-cmd.md')), true)
    assert.equal(existsSync(join(configDir, 'skills', 'my-custom-skill', 'SKILL.md')), true)
    assert.equal(existsSync(join(workspaceDir, '.venv', 'bin', 'python3')), true)
    assert.equal(existsSync(join(workspaceDir, 'scripts', 'app.py')), true)
  } finally {
    resetLegacyMigrationCacheForTests()
    rmSync(root, { recursive: true, force: true })
  }
})

test('postinstall cleans legacy installs cleanly inside sandbox XDG without npx hints or copied files', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-postinstall-222-'))
  try {
    const xdg = join(root, 'xdg')
    const configDir = join(xdg, 'opencode')
    const workspaceDir = join(root, 'project')
    seedFullLegacyTarget(configDir, workspaceDir)

    const result = spawnSync(process.execPath, [join(REPO_ROOT, 'scripts', 'postinstall.mjs')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, HOME: root, XDG_CONFIG_HOME: xdg, PANTHEON_HOME: configDir },
    })
    assert.equal(result.status, 0, `postinstall failed: ${result.stderr}`)
    assert.doesNotMatch(result.stdout, /npx pantheon-opencode/)
    assert.match(result.stdout, /opencode plugin add pantheon-opencode/)

    const cleanedJson = JSON.parse(readFileSync(join(configDir, 'opencode.json'), 'utf8'))
    assert.equal(cleanedJson.mcp.servers['pantheon-code-mode'], undefined)
    assert.equal(existsSync(join(configDir, 'plugins', 'pantheon-tui')), false)
    assert.equal(existsSync(join(configDir, '.venv')), false)
    assert.equal(existsSync(join(configDir, 'agents', 'zeus.md')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('purgeAllPantheonData (runtime & TUI) cleans stores and legacy files while leaving user workspace safe', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-purge-222-'))
  try {
    const xdg = join(root, 'xdg')
    const configDir = join(xdg, 'opencode')
    const workspaceDir = join(root, 'proj')
    seedFullLegacyTarget(configDir, workspaceDir)
    mkdirSync(join(configDir, '.pantheon', 'memory'), { recursive: true })
    writeFileSync(join(configDir, '.pantheon', 'memory', 'memory.db'), 'db-bytes')
    mkdirSync(join(workspaceDir, '.pantheon', 'goals'), { recursive: true })
    writeFileSync(join(workspaceDir, '.pantheon', 'goals', 'g1.json'), '{}')

    const scan = tuiScanLegacyArtifacts({ workspaceDir, globalConfigDir: configDir })
    assert.ok(scan.summary.total > 0)
    tuiCleanLegacyArtifacts({ workspaceDir, globalConfigDir: configDir })
    assert.equal(existsSync(join(configDir, '.pantheon', 'memory', 'memory.db')), true)

    const tuiPurge = tuiPurgeAllPantheonData({ workspaceDir, globalConfigDir: configDir })
    assert.ok(tuiPurge.removed.length > 0)
    assert.equal(existsSync(join(configDir, '.pantheon')), false)
    assert.equal(existsSync(join(workspaceDir, '.pantheon')), false)

    // Also verify runtime purgeAllPantheonData dry-run and real cleanup
    mkdirSync(join(configDir, '.pantheon', 'memory'), { recursive: true })
    writeFileSync(join(configDir, '.pantheon', 'memory', 'memory.db'), 'db-bytes')
    const dry = purgeAllPantheonData({
      workspaceDir,
      globalConfigDir: configDir,
      dryRun: true,
    })
    assert.ok(dry.removed.length > 0)
    assert.equal(existsSync(join(configDir, '.pantheon', 'memory', 'memory.db')), true)
    purgeAllPantheonData({ workspaceDir, globalConfigDir: configDir })
    assert.equal(existsSync(join(configDir, '.pantheon')), false)
    assert.equal(existsSync(join(workspaceDir, '.venv', 'bin', 'python3')), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('doctor passes cleanly on pure native plugin setup and auto-cleans broken Python MCP on --fix', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-doctor-222-'))
  try {
    const xdg = join(root, 'xdg')
    const configDir = join(xdg, 'opencode')
    const projectDir = join(root, 'project')
    mkdirSync(configDir, { recursive: true })
    mkdirSync(projectDir, { recursive: true })

    const configPath = join(configDir, 'opencode.json')
    writeFileSync(
      configPath,
      JSON.stringify(
        {
          plugins: ['pantheon-opencode'],
          mcp: {
            servers: {
              'pantheon-code-mode': {
                type: 'local',
                command: ['/home/admin/.config/opencode/.venv/bin/python3', 'scripts/code_mode.py'],
              },
            },
          },
        },
        null,
        2,
      ),
    )

    const env = { ...process.env, HOME: root, XDG_CONFIG_HOME: xdg, PANTHEON_HOME: configDir }
    const beforeFix = spawnSync(
      process.execPath,
      [join(REPO_ROOT, 'scripts', 'doctor.mjs'), '--target', projectDir, '--profile', 'global'],
      { cwd: REPO_ROOT, encoding: 'utf8', env },
    )
    assert.equal(beforeFix.status, 2, 'broken Python MCP executable must fail before --fix')

    const withFix = spawnSync(
      process.execPath,
      [
        join(REPO_ROOT, 'scripts', 'doctor.mjs'),
        '--target',
        projectDir,
        '--profile',
        'global',
        '--fix',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', env },
    )
    assert.equal(withFix.status, 0, `doctor --fix should pass:\n${withFix.stdout}`)
    const cleaned = JSON.parse(readFileSync(configPath, 'utf8'))
    assert.equal(cleaned.mcp?.servers?.['pantheon-code-mode'], undefined)
    assert.deepEqual(cleaned.plugins, ['pantheon-opencode'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cleanCopiedInstallArtifacts never deletes tracked .pantheon/code-mode inside the repo source root', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-repo-guard-222-'))
  try {
    const repoDir = join(root, 'pantheon-repo')
    const globalCfg = join(root, 'xdg', 'opencode')
    mkdirSync(join(repoDir, '.pantheon', 'code-mode'), { recursive: true })
    mkdirSync(join(repoDir, 'src', 'mcp'), { recursive: true })
    mkdirSync(join(repoDir, 'src', 'agents'), { recursive: true })
    mkdirSync(globalCfg, { recursive: true })
    writeFileSync(join(repoDir, 'package.json'), '{"name":"pantheon-opencode"}\n')
    writeFileSync(join(repoDir, 'src', 'plugin.ts'), 'export default {}\n')
    writeFileSync(join(repoDir, 'src', 'mcp', 'code_mode.py'), '# mcp\n')
    writeFileSync(join(repoDir, 'src', 'agents', 'roster.json'), '{}\n')
    writeFileSync(join(repoDir, '.pantheon', 'code-mode', 'compress-inline.py'), '# tracked\n')
    writeFileSync(join(globalCfg, 'opencode.json'), '{"plugins":["pantheon-opencode"]}\n')

    ensureLegacyStoresMigratedOnce(repoDir, {
      globalConfigDir: globalCfg,
      cleanCopiedInstallArtifacts: true,
    })
    const tuiScan = tuiScanLegacyArtifacts({ workspaceDir: repoDir, globalConfigDir: globalCfg })
    assert.equal(existsSync(join(repoDir, '.pantheon', 'code-mode', 'compress-inline.py')), true)
    assert.equal(
      tuiScan.items.some((item) => item.path.endsWith('compress-inline.py')),
      false,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cleanCopiedInstallArtifacts preserves an active standalone /src/plugin path entry when no npm package entry is present', () => {
  const root = mkdtempSync(join(tmpdir(), 'pantheon-standalone-plugin-entry-'))
  try {
    resetLegacyMigrationCacheForTests()
    const workspaceDir = join(root, 'project')
    const pluginDir = join(root, 'installed', 'pantheon-opencode', 'src', 'plugin')
    mkdirSync(workspaceDir, { recursive: true })
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'index.ts'), 'export * from "../plugin.ts"\n')

    const projectConfig = join(workspaceDir, 'opencode.json')
    writeFileSync(
      projectConfig,
      `${JSON.stringify({ plugins: [{ package: pluginDir, options: {} }] }, null, 2)}\n`,
    )

    ensureLegacyStoresMigratedOnce(workspaceDir, {
      cleanCopiedInstallArtifacts: true,
    })

    const after = JSON.parse(readFileSync(projectConfig, 'utf8'))
    assert.deepEqual(after.plugins, [{ package: pluginDir, options: {} }])
  } finally {
    resetLegacyMigrationCacheForTests()
    rmSync(root, { recursive: true, force: true })
  }
})
