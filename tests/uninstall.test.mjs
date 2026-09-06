import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  cleanOpenCodeConfig,
  isPantheonContent,
  parseArgs,
  resolveGlobalTarget,
  uninstallOpenCode,
} from '../scripts/uninstall.mjs'

const script = join(process.cwd(), 'scripts', 'uninstall.mjs')

function runUninstall(target, ...flags) {
  return spawnSync(process.execPath, [script, '--target', target, '--force', ...flags], {
    encoding: 'utf8',
  })
}

function runGlobalUninstall(env, cwd) {
  return spawnSync(process.execPath, [script, '--global', '--force'], {
    encoding: 'utf8',
    cwd,
    env: { ...process.env, ...env },
  })
}

test('parseArgs resolves targets and accepts help, dry-run, and force flags', () => {
  const args = parseArgs([
    'node',
    'uninstall.mjs',
    '--target',
    '.',
    '--dry-run',
    '--force',
    '--help',
  ])
  assert.equal(args.target, process.cwd())
  assert.equal(args.dryRun, true)
  assert.equal(args.force, true)
  assert.equal(args.help, true)
  assert.throws(() => parseArgs(['node', 'uninstall.mjs', '--unknown']), /Unknown option/)
})

test('global target follows isolated global configuration instead of cwd', () => {
  const env = {
    PANTHEON_HOME: join(tmpdir(), 'pantheon-home'),
    XDG_CONFIG_HOME: join(tmpdir(), 'xdg-config'),
  }
  assert.equal(resolveGlobalTarget(env), env.PANTHEON_HOME)
  assert.equal(
    resolveGlobalTarget({ XDG_CONFIG_HOME: env.XDG_CONFIG_HOME }),
    join(env.XDG_CONFIG_HOME, 'opencode'),
  )
})

test('CLI global uninstall uses PANTHEON_HOME from an unrelated cwd', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-global-cli-'))
  const cwd = mkdtempSync(join(tmpdir(), 'pantheon-unrelated-cwd-'))
  try {
    mkdirSync(join(target, 'agents'), { recursive: true })
    writeFileSync(join(target, 'agents', 'zeus.md'), '<!-- managed-by: pantheon-opencode -->\n')
    writeFileSync(join(target, 'routing.yml'), '# managed-by: pantheon-opencode\n')
    writeFileSync(join(target, 'user-routing.yml'), '# user-owned\n')
    const result = runGlobalUninstall({ PANTHEON_HOME: target }, cwd)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(existsSync(join(target, 'agents', 'zeus.md')), false)
    assert.equal(existsSync(join(target, 'routing.yml')), false)
    assert.equal(readFileSync(join(target, 'user-routing.yml'), 'utf8'), '# user-owned\n')
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('ownership detection requires a non-symlink file and handles unreadable or missing paths', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-ownership-'))
  try {
    const owned = join(target, 'owned.md')
    const user = join(target, 'user.md')
    writeFileSync(owned, '<!-- managed-by: pantheon -->\n')
    writeFileSync(user, '# Pantheon is mentioned, but this is user content\n')
    assert.equal(isPantheonContent(owned), true)
    assert.equal(isPantheonContent(user), false)
    assert.equal(isPantheonContent(join(target, 'missing.md')), false)
    assert.equal(isPantheonContent(target), false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('config cleanup tolerates absent and malformed configs without creating files', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-config-'))
  try {
    cleanOpenCodeConfig(target, false)
    writeFileSync(join(target, 'opencode.json'), '{not json')
    cleanOpenCodeConfig(target, false)
    assert.equal(readFileSync(join(target, 'opencode.json'), 'utf8'), '{not json')
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('config cleanup removes owned object records and deletes empty sections', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-config-owned-'))
  try {
    writeFileSync(join(target, 'AGENTS.md'), '<!-- managed-by: pantheon-opencode -->\n')
    writeFileSync(
      join(target, 'opencode.json'),
      JSON.stringify({
        agent: { zeus: { source: 'AGENTS.md' } },
        instructions: ['AGENTS.md'],
        plugin: { tui: { owner: 'pantheon-plugin' } },
        plugins: { hooks: { managedBy: 'pantheon-hooks' } },
        mcp: { runtime: { owner: 'pantheon-runtime' } },
      }),
    )
    cleanOpenCodeConfig(target, false)
    assert.deepEqual(JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8')), {})
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('direct global cleanup removes owned files and empty directories only', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-direct-global-'))
  try {
    mkdirSync(join(target, 'agents'), { recursive: true })
    writeFileSync(join(target, 'agents', 'zeus.md'), '<!-- managed-by: pantheon-opencode -->\n')
    writeFileSync(join(target, 'routing.yml'), '# pantheon-opencode\n')
    writeFileSync(join(target, 'user.txt'), 'keep\n')
    uninstallOpenCode(target, false)
    assert.equal(readFileSync(join(target, 'user.txt'), 'utf8'), 'keep\n')
    assert.equal(existsSync(join(target, 'agents')), false)
    assert.equal(existsSync(join(target, 'routing.yml')), false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('global cleanup preserves user-owned routing and removes explicit Pantheon marker', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-routing-'))
  try {
    mkdirSync(join(target, 'agents'), { recursive: true })
    writeFileSync(join(target, 'routing.yml'), 'version: 1\n# user routing mentioning Pantheon\n')
    uninstallOpenCode(target, false)
    assert.equal(existsSync(join(target, 'routing.yml')), true)
    mkdirSync(join(target, 'agents'), { recursive: true })
    writeFileSync(join(target, 'routing.yml'), '# managed-by: pantheon-opencode\nversion: 1\n')
    uninstallOpenCode(target, false)
    assert.equal(existsSync(join(target, 'routing.yml')), false)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('uninstall removes Pantheon OpenCode artifacts only', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-uninstall-'))
  try {
    mkdirSync(join(target, '.opencode', 'agents'), { recursive: true })
    mkdirSync(join(target, '.opencode', 'skills', 'sample'), { recursive: true })
    mkdirSync(join(target, '.claude'), { recursive: true })
    writeFileSync(join(target, '.opencode', 'agents', 'zeus.md'), '# Pantheon Agent System\n')
    writeFileSync(join(target, 'AGENTS.md'), '# Pantheon Agent System\n')
    writeFileSync(join(target, '.opencode', 'agents', 'my-agent.md'), '# Personal OpenCode agent\n')
    writeFileSync(
      join(target, '.opencode', 'skills', 'sample', 'SKILL.md'),
      '# Pantheon multi-agent framework\n',
    )
    writeFileSync(join(target, '.claude', 'CLAUDE.md'), '# Keep this other-platform file\n')
    writeFileSync(
      join(target, 'opencode.json'),
      JSON.stringify({
        agent: {
          zeus: { source: '.opencode/agents/zeus.md' },
          personal: { source: 'personal.md' },
        },
        instructions: ['AGENTS.md', 'user.md'],
        default_agent: 'zeus',
      }),
    )

    const result = runUninstall(target)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(
      readFileSync(join(target, '.opencode', 'agents', 'my-agent.md'), 'utf8'),
      '# Personal OpenCode agent\n',
    )
    assert.equal(
      readFileSync(join(target, '.claude', 'CLAUDE.md'), 'utf8'),
      '# Keep this other-platform file\n',
    )
    const config = JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8'))
    assert.deepEqual(config.agent, { personal: { source: 'personal.md' } })
    assert.deepEqual(config.instructions, ['user.md'])
    assert.equal(config.default_agent, undefined)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('platform selector is rejected instead of touching another platform', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-uninstall-'))
  try {
    const result = runUninstall(target, '--platforms', 'claude')
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /--platforms was removed/)
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('dry-run reports OpenCode-only behavior without deleting files', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-uninstall-'))
  try {
    mkdirSync(join(target, '.opencode', 'agents'), { recursive: true })
    writeFileSync(join(target, '.opencode', 'agents', 'zeus.md'), '# Pantheon Agent System\n')
    const result = runUninstall(target, '--dry-run')
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /OpenCode\/Pantheon only/)
    assert.match(result.stdout, /Would remove/)
    assert.equal(
      readFileSync(join(target, '.opencode', 'agents', 'zeus.md'), 'utf8'),
      '# Pantheon Agent System\n',
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('rejects symlinked entries without touching the link target', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-uninstall-'))
  const outside = mkdtempSync(join(tmpdir(), 'pantheon-outside-'))
  try {
    mkdirSync(join(target, '.opencode', 'agents'), { recursive: true })
    writeFileSync(join(outside, 'zeus.md'), '# Pantheon Agent System\n')
    symlinkSync(join(outside, 'zeus.md'), join(target, '.opencode', 'agents', 'zeus.md'))
    const result = runUninstall(target)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(outside, 'zeus.md'), 'utf8'), '# Pantheon Agent System\n')
    assert.equal(
      readFileSync(join(target, '.opencode', 'agents', 'zeus.md'), 'utf8'),
      '# Pantheon Agent System\n',
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('supports a flat global OpenCode directory and preserves unmarked user files', () => {
  const target = mkdtempSync(join(tmpdir(), 'opencode-'))
  try {
    mkdirSync(join(target, 'agents'), { recursive: true })
    mkdirSync(join(target, 'plugins', 'user-plugin'), { recursive: true })
    writeFileSync(join(target, 'agents', 'zeus.md'), '<!-- managed-by: pantheon-opencode -->\n')
    writeFileSync(join(target, 'agents', 'zeus-user.md'), '# User agent\n')
    writeFileSync(
      join(target, 'plugins', 'user-plugin', 'package.json'),
      '{"name":"user-plugin"}\n',
    )
    writeFileSync(
      join(target, 'tui.json'),
      JSON.stringify({ plugin: ['plugins/user-plugin', 'user-plugin'] }),
    )
    writeFileSync(
      join(target, 'opencode.json'),
      JSON.stringify({
        plugin: ['user-plugin'],
        mcp: { user: { command: 'user-mcp' } },
        default_agent: 'zeus',
      }),
    )
    const result = runUninstall(target)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(readFileSync(join(target, 'agents', 'zeus-user.md'), 'utf8'), '# User agent\n')
    assert.equal(
      readFileSync(join(target, 'plugins', 'user-plugin', 'package.json'), 'utf8'),
      '{"name":"user-plugin"}\n',
    )
    assert.deepEqual(JSON.parse(readFileSync(join(target, 'tui.json'), 'utf8')).plugin, [
      'plugins/user-plugin',
      'user-plugin',
    ])
    assert.deepEqual(JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8')), {
      plugin: ['user-plugin'],
      mcp: { user: { command: 'user-mcp' } },
      default_agent: 'zeus',
    })
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('removes only explicitly Pantheon-owned MCP, plugin, TUI, and agent records', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-uninstall-'))
  try {
    mkdirSync(join(target, '.opencode', 'agents'), { recursive: true })
    writeFileSync(
      join(target, '.opencode', 'agents', 'zeus.md'),
      '<!-- managed-by: pantheon-opencode -->\n',
    )
    writeFileSync(join(target, 'AGENTS.md'), '<!-- managed-by: pantheon-opencode -->\n')
    writeFileSync(
      join(target, 'opencode.json'),
      JSON.stringify({
        agent: { zeus: { source: '.opencode/agents/zeus.md' }, user: { source: 'user.md' } },
        mcp: { pantheon: { command: 'pantheon-mcp' }, user: { command: 'my-mcp' } },
        plugin: ['pantheon-hooks', 'my-plugin'],
        instructions: ['AGENTS.md', 'user.md'],
        default_agent: 'zeus',
      }),
    )
    writeFileSync(
      join(target, '.opencode', 'tui.json'),
      JSON.stringify({ plugin: ['plugins/pantheon-tui', 'user-tui'] }),
    )
    const result = runUninstall(target)
    assert.equal(result.status, 0, result.stderr)
    const config = JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8'))
    assert.deepEqual(config.agent, { user: { source: 'user.md' } })
    assert.deepEqual(config.mcp, { user: { command: 'my-mcp' } })
    assert.deepEqual(config.plugin, ['my-plugin'])
    assert.deepEqual(config.instructions, ['user.md'])
    assert.equal(config.default_agent, undefined)
    assert.deepEqual(
      JSON.parse(readFileSync(join(target, '.opencode', 'tui.json'), 'utf8')).plugin,
      ['user-tui'],
    )
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('preserves user MCPs whose command or metadata merely mentions Pantheon', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-uninstall-'))
  try {
    writeFileSync(
      join(target, 'opencode.json'),
      JSON.stringify({
        mcp: {
          'pantheon-memory': { command: ['python', 'server.py'] },
          docs: { command: ['python', 'pantheon-docs-server.py'], note: 'Pantheon docs' },
          user: { command: ['my-mcp'], description: 'Integrates with pantheon-* projects' },
        },
      }),
    )
    const result = runUninstall(target)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8')).mcp, {
      docs: { command: ['python', 'pantheon-docs-server.py'], note: 'Pantheon docs' },
      user: { command: ['my-mcp'], description: 'Integrates with pantheon-* projects' },
    })
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('uninstall V2 removes owned config.plugins entries and preserves user plugins', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-uninstall-v2-'))
  try {
    writeFileSync(
      join(target, 'opencode.json'),
      JSON.stringify({
        plugins: [
          '/installed/pantheon/src/plugin.ts',
          '/installed/pantheon/src/plugins/pantheon-hooks.ts',
          'npm:my-pantheon-plugin',
          'npm:my-user-plugin',
        ],
      }),
    )
    const result = runUninstall(target)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(readFileSync(join(target, 'opencode.json'), 'utf8')).plugins, [
      'npm:my-pantheon-plugin',
      'npm:my-user-plugin',
    ])
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})
