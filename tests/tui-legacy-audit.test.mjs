import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, it } from 'node:test'
import {
  cleanLegacyArtifacts,
  formatBytes,
  scanLegacyArtifacts,
} from '../src/plugins/tui/src/legacy-audit.ts'

describe('tui legacy-audit scanner & cleaner', () => {
  it('formats human-readable byte sizes', () => {
    assert.equal(formatBytes(512), '512 B')
    assert.equal(formatBytes(2048), '2.0 KB')
    assert.equal(formatBytes(2 * 1024 * 1024), '2.00 MB')
  })

  it('scans global and project scopes, migrates stores before cleaning, and preserves custom files', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pantheon-tui-legacy-'))
    try {
      const globalDir = join(tmp, 'global-opencode')
      const projectDir = join(tmp, 'project-ws')

      mkdirSync(join(globalDir, 'plugins', 'pantheon-tui'), { recursive: true })
      mkdirSync(join(globalDir, '.pantheon'), { recursive: true })
      mkdirSync(join(globalDir, 'skills', 'session-goal'), { recursive: true })
      mkdirSync(join(globalDir, 'skills', 'council-agora'), { recursive: true })
      mkdirSync(join(globalDir, 'skills', 'user-only-skill'), { recursive: true })
      mkdirSync(join(projectDir, '.opencode', 'agents'), { recursive: true })
      mkdirSync(join(projectDir, '.pantheon'), { recursive: true })

      writeFileSync(
        join(globalDir, 'plugins', 'pantheon-tui', 'package.json'),
        JSON.stringify({ name: 'pantheon-tui', version: '2.1.6' }),
      )
      writeFileSync(join(globalDir, 'plugins', 'pantheon-hooks.ts'), '// dead v1 hook')
      writeFileSync(join(globalDir, 'skills', 'session-goal', 'SKILL.md'), '# bundled copy')
      writeFileSync(join(globalDir, 'skills', 'council-agora', 'SKILL.md'), '# bundled copy')
      writeFileSync(join(globalDir, 'skills', 'user-only-skill', 'SKILL.md'), '# keep me')
      writeFileSync(join(projectDir, '.opencode', 'agents', 'hermes.md'), '# canonical copy')
      writeFileSync(join(projectDir, '.opencode', 'agents', 'talos.md'), '# retired canonical copy')
      writeFileSync(join(projectDir, '.opencode', 'agents', 'custom-ml.md'), '# forged agent')

      // Unmigrated flat memory.db in globalDir
      const db = new DatabaseSync(join(globalDir, '.pantheon', 'memory.db'))
      db.exec(
        'CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT, key TEXT, value TEXT, created_at TEXT);',
      )
      db.prepare(
        'INSERT INTO memories (namespace, key, value, created_at) VALUES (?, ?, ?, ?)',
      ).run('default', 'rule-1', 'Always verify first', '2026-06-01T00:00:00.000Z')
      db.close()

      const scan = scanLegacyArtifacts({
        workspaceDir: projectDir,
        globalConfigDir: globalDir,
        runningVersion: '2.2.0-beta.4',
      })
      assert.ok(scan.summary.total >= 5)
      assert.ok(scan.summary.unmigratedStores >= 1)
      assert.equal(scan.summary.byCategory.drift, 1)
      assert.equal(scan.summary.byCategory.hooks, 1)
      assert.equal(
        scan.items.some(
          (i) => i.path.includes('custom-ml.md') || i.path.includes('user-only-skill'),
        ),
        false,
      )

      const cleaned = cleanLegacyArtifacts({
        workspaceDir: projectDir,
        globalConfigDir: globalDir,
        runningVersion: '2.2.0-beta.4',
      })
      assert.equal(cleaned.errors.length, 0)
      assert.ok(cleaned.migratedRecords >= 1)
      assert.ok(cleaned.removed.length >= 5)

      // Migrated global memory DB must exist and contain rule-1
      const canonicalDbPath = join(globalDir, '.pantheon', 'memory', 'memory.db')
      assert.equal(existsSync(canonicalDbPath), true)
      const dst = new DatabaseSync(canonicalDbPath, { readOnly: true })
      const row = dst.prepare('SELECT value FROM memories WHERE key = ?').get('rule-1')
      dst.close()
      assert.equal(row?.value, 'Always verify first')

      // Obsolete files removed
      assert.equal(existsSync(join(globalDir, '.pantheon', 'memory.db')), false)
      assert.equal(existsSync(join(globalDir, 'plugins', 'pantheon-tui')), false)
      assert.equal(existsSync(join(globalDir, 'plugins', 'pantheon-hooks.ts')), false)
      assert.equal(existsSync(join(globalDir, 'skills', 'session-goal')), false)
      assert.equal(existsSync(join(globalDir, 'skills', 'council-agora')), false)
      assert.equal(existsSync(join(projectDir, '.opencode', 'agents', 'hermes.md')), false)
      assert.equal(existsSync(join(projectDir, '.opencode', 'agents', 'talos.md')), false)

      // Custom user files untouched
      assert.equal(existsSync(join(globalDir, 'skills', 'user-only-skill', 'SKILL.md')), true)
      assert.equal(existsSync(join(projectDir, '.opencode', 'agents', 'custom-ml.md')), true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('detects and cleans stale coexisting OpenCode plugin caches while keeping the active bundle', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'pantheon-tui-cache-'))
    try {
      const globalDir = join(tmp, 'global-opencode')
      const cacheNpmDir = join(tmp, 'cache', 'opencode', 'npm')
      const oldRev = join(cacheNpmDir, 'pantheon-opencode', '1000000')
      const activeRev = join(cacheNpmDir, 'pantheon-opencode', '2000000')
      const betaCache = join(cacheNpmDir, 'pantheon-opencode@beta', '1500000')

      mkdirSync(globalDir, { recursive: true })
      mkdirSync(join(oldRev, 'node_modules', 'pantheon-opencode'), { recursive: true })
      mkdirSync(
        join(activeRev, 'node_modules', 'pantheon-opencode', 'src', 'plugins', 'tui', 'dist'),
        {
          recursive: true,
        },
      )
      mkdirSync(join(betaCache, 'node_modules', 'pantheon-opencode'), { recursive: true })

      writeFileSync(
        join(oldRev, 'node_modules', 'pantheon-opencode', 'package.json'),
        JSON.stringify({ name: 'pantheon-opencode', version: '2.1.6' }),
      )
      writeFileSync(
        join(activeRev, 'node_modules', 'pantheon-opencode', 'package.json'),
        JSON.stringify({ name: 'pantheon-opencode', version: '2.2.0' }),
      )
      writeFileSync(
        join(betaCache, 'node_modules', 'pantheon-opencode', 'package.json'),
        JSON.stringify({ name: 'pantheon-opencode', version: '2.2.0-beta.11' }),
      )
      const activeBundlePath = join(
        activeRev,
        'node_modules',
        'pantheon-opencode',
        'src',
        'plugins',
        'tui',
        'dist',
        'tui.js',
      )
      writeFileSync(activeBundlePath, '// active tui bundle')

      utimesSync(oldRev, new Date(1000), new Date(1000))
      utimesSync(activeRev, new Date(2000), new Date(2000))

      const scan = scanLegacyArtifacts({
        globalConfigDir: globalDir,
        cacheDir: cacheNpmDir,
        runningVersion: '2.2.0',
        activeBundlePath,
      })
      assert.equal(scan.summary.total, 2)
      assert.equal(scan.summary.byCategory.drift, 2)
      assert.equal(
        scan.items.some((item) => item.path === activeRev),
        false,
        'active running cache revision must never be flagged',
      )

      const cleaned = cleanLegacyArtifacts({
        globalConfigDir: globalDir,
        cacheDir: cacheNpmDir,
        runningVersion: '2.2.0',
        activeBundlePath,
      })
      assert.equal(cleaned.errors.length, 0)
      assert.equal(existsSync(oldRev), false)
      assert.equal(existsSync(join(cacheNpmDir, 'pantheon-opencode@beta')), false)
      assert.equal(existsSync(activeBundlePath), true)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
