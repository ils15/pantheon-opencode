import assert from 'node:assert/strict'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  cleanLegacyArtifacts,
  ensureLegacyStoresMigratedOnce,
  migrateLegacyStoresAndPurgeStale,
  resetLegacyMigrationCacheForTests,
  scanLegacyArtifacts,
} from '../../src/pantheon/legacy-store-migration.mjs'
import { createNativeMemoryAndPersistenceTools } from '../../src/pantheon/native-memory-tools.ts'
import plugin from '../../src/plugin.ts'

async function withTempDirs<const T extends readonly string[]>(
  prefixes: T,
  fn: (dirs: { [K in keyof T]: string }) => Promise<void> | void,
): Promise<void> {
  const dirs = prefixes.map((prefix) => mkdtempSync(join(tmpdir(), prefix))) as unknown as {
    [K in keyof T]: string
  }
  try {
    await fn(dirs)
  } finally {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

async function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<void> | void,
): Promise<void> {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    await fn()
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

function writeFixtureFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content)
}

function seedSqliteDb(
  dbPath: string,
  schemaSql: string,
  populate?: (db: DatabaseSync) => void,
): void {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(schemaSql)
    populate?.(db)
  } finally {
    db.close()
  }
}

function createToolRunner(workDir: string) {
  const tools = createNativeMemoryAndPersistenceTools(workDir)
  return async (name: string, args: Record<string, unknown>) => {
    const found = tools.find((t) => t.name === name)
    assert.ok(found, `Missing tool ${name}`)
    const res = await found.execute(args, { directory: workDir })
    return JSON.parse(res.output)
  }
}

function assertPathsExist(
  entries: Array<[path: string, expected: boolean, message?: string]>,
): void {
  for (const [targetPath, expected, message] of entries) {
    if (message !== undefined) {
      assert.equal(existsSync(targetPath), expected, message)
    } else {
      assert.equal(existsSync(targetPath), expected)
    }
  }
}

async function runPluginSetup(directory: string): Promise<void> {
  const noopDraft = () => ({ list: () => [], update: () => {}, add: () => {}, default: () => {} })
  await plugin.setup({
    agent: { transform: (fn: (d: unknown) => void) => fn(noopDraft()) },
    command: { transform: (fn: (d: unknown) => void) => fn(noopDraft()) },
    reference: { transform: (fn: (d: unknown) => void) => fn(noopDraft()) },
    location: { directory },
  } as unknown as Parameters<typeof plugin.setup>[0])
}

test('migrates legacy memory.db, persistence global/project.db, checkpoints, and goals while deleting stale artifacts', async () => {
  await withTempDirs(['pantheon-legacy-migrate-'], async ([workDir]) => {
    resetLegacyMigrationCacheForTests()
    const pantheonDir = join(workDir, '.pantheon')
    const futureIso = new Date(Date.now() + 3600_000).toISOString()
    const pastIso = new Date(Date.now() - 3600_000).toISOString()

    // 1. Seed legacy flat .pantheon/memory.db with active + expired rows + legacy vector table
    const legacyMemDbPath = join(pantheonDir, 'memory.db')
    seedSqliteDb(
      legacyMemDbPath,
      `
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          namespace TEXT NOT NULL DEFAULT 'default',
          key TEXT,
          value TEXT NOT NULL,
          metadata TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          expires_at TEXT
        );
        CREATE TABLE memories_vec (id INTEGER PRIMARY KEY, embedding BLOB);
      `,
      (db) => {
        const insert = db.prepare(
          'INSERT INTO memories (namespace, key, value, metadata, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        insert.run(
          'architecture',
          'auth-adr',
          'Use PKCE OAuth2 flow with httpOnly session cookies',
          '{"author":"athena"}',
          '2026-05-01T00:00:00.000Z',
          '2026-05-01T00:00:00.000Z',
          futureIso,
        )
        insert.run(
          'architecture',
          'stale-key',
          'Obsolete expired fact that must be deleted',
          '{}',
          '2025-01-01T00:00:00.000Z',
          '2025-01-01T00:00:00.000Z',
          pastIso,
        )
      },
    )
    writeFixtureFile(join(pantheonDir, '.memory.db.init.lock'), '')

    // 2. Seed legacy SQLite persistence/project.db (kv_store + pantheon_goals)
    const legacyPersistenceDir = join(pantheonDir, 'persistence')
    const projectDbPath = join(legacyPersistenceDir, 'project.db')
    seedSqliteDb(
      projectDbPath,
      `
        CREATE TABLE kv_store (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          namespace TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          expires_at TEXT,
          deleted_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          revision INTEGER
        );
        CREATE TABLE pantheon_goals (
          goal_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL,
          criteria_json TEXT NOT NULL,
          notes_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT
        );
      `,
      (db) => {
        const insertKv = db.prepare(
          'INSERT INTO kv_store (namespace, key, value, expires_at, deleted_at, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        // Active checkpoint in 'context' namespace
        insertKv.run(
          'context',
          'ses-legacy-1',
          '{"phase":"phase-2","completed":["db-schema"]}',
          futureIso,
          null,
          '2026-05-01T00:00:00.000Z',
          '2026-05-01T01:00:00.000Z',
          3,
        )
        // Soft-deleted checkpoint (must NOT be migrated)
        insertKv.run(
          'context',
          'ses-deleted',
          '{"phase":"dead"}',
          null,
          '2026-05-02T00:00:00.000Z',
          '2026-05-01T00:00:00.000Z',
          '2026-05-02T00:00:00.000Z',
          1,
        )
        // Active goal in pantheon_goals
        db.prepare(
          'INSERT INTO pantheon_goals (goal_id, session_id, title, status, criteria_json, notes_json, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(
          'goal-legacy-sql',
          'ses-legacy-1',
          'Complete native store migration',
          'active',
          JSON.stringify(['migrate memory.db', 'migrate project.db']),
          JSON.stringify('In progress'),
          '2026-05-01T00:00:00.000Z',
          '2026-05-01T01:00:00.000Z',
          null,
        )
      },
    )
    writeFixtureFile(join(legacyPersistenceDir, '.project.db.init.lock'), '')

    // 3. Seed legacy .pantheon/goals.json and .pantheon/checkpoints/
    writeFixtureFile(
      join(pantheonDir, 'goals.json'),
      JSON.stringify([
        {
          id: 'goal-legacy-json',
          title: 'Clean up stale vector cache',
          criteria: ['remove fastembed_cache'],
          status: 'active',
        },
      ]),
    )
    const legacyCheckpointsDir = join(pantheonDir, 'checkpoints')
    writeFixtureFile(
      join(legacyCheckpointsDir, 'ses-legacy-file.json'),
      JSON.stringify({
        content: 'checkpoint-from-flat-dir',
        updated_at: '2026-05-01T00:00:00.000Z',
      }),
    )

    // 4. Seed stale obsolete artifacts (fastembed_cache, dead V1 pantheon-hooks.ts, tiers.json)
    writeFixtureFile(join(pantheonDir, 'fastembed_cache', 'model.onnx'), 'stale-weights')
    writeFixtureFile(join(workDir, 'plugins', 'pantheon-hooks.ts'), '// obsolete v1 hook')
    writeFixtureFile(join(workDir, 'tiers.json'), '{}')

    // 5. Invoke native tools directly — auto-migration must fire transparently!
    const runTool = createToolRunner(workDir)

    // 5a. Verify migrated memory via memory_recall and FTS5 memory_search
    const recallRes = await runTool('memory_recall', {
      namespace: 'architecture',
      key: 'auth-adr',
    })
    assert.equal(recallRes.value, 'Use PKCE OAuth2 flow with httpOnly session cookies')

    const expiredRecall = await runTool('memory_recall', {
      namespace: 'architecture',
      key: 'stale-key',
    })
    assert.equal(expiredRecall.error, 'not_found')

    const searchRes = await runTool('memory_search', {
      query: 'PKCE OAuth2',
      namespace: 'architecture',
    })
    assert.equal(searchRes.ok, true)
    assert.equal(searchRes.count, 1)
    assert.equal(searchRes.results[0].key, 'auth-adr')

    // 5b. Verify migrated context checkpoints from SQLite kv_store and flat checkpoints/
    const ctxSql = await runTool('context_get', { session_id: 'ses-legacy-1' })
    assert.equal(ctxSql.content, '{"phase":"phase-2","completed":["db-schema"]}')

    const ctxDeleted = await runTool('context_get', { session_id: 'ses-deleted' })
    assert.equal(ctxDeleted.error, 'not_found')

    const ctxFlat = await runTool('context_get', { session_id: 'ses-legacy-file' })
    assert.equal(ctxFlat.content, 'checkpoint-from-flat-dir')

    // 5c. Verify migrated goals from SQLite pantheon_goals and goals.json
    const goalSql = await runTool('goal_get', { id: 'goal-legacy-sql' })
    assert.equal(goalSql.title, 'Complete native store migration')
    assert.deepEqual(goalSql.criteria, ['migrate memory.db', 'migrate project.db'])

    const goalJson = await runTool('goal_get', { id: 'goal-legacy-json' })
    assert.equal(goalJson.title, 'Clean up stale vector cache')

    // 5d. Verify all obsolete/stale files & databases were deleted
    assertPathsExist([
      [legacyMemDbPath, false, 'legacy flat .pantheon/memory.db must be deleted'],
      [join(pantheonDir, '.memory.db.init.lock'), false],
      [projectDbPath, false, 'legacy SQLite project.db must be deleted'],
      [join(legacyPersistenceDir, '.project.db.init.lock'), false],
      [join(pantheonDir, 'goals.json'), false, 'legacy goals.json must be deleted'],
      [legacyCheckpointsDir, false, 'empty legacy checkpoints dir must be deleted'],
      [join(pantheonDir, 'fastembed_cache'), false, 'fastembed_cache must be deleted'],
      [join(workDir, 'plugins', 'pantheon-hooks.ts'), false],
      [join(workDir, 'tiers.json'), false],
    ])
  })
})

test('migrateLegacyStoresAndPurgeStale migrates legacy memory/memory.db and purges stale files', async () => {
  await withTempDirs(['pantheon-install-datamig-'], ([targetDir]) => {
    resetLegacyMigrationCacheForTests()

    // Seed legacy global memory/memory.db inside targetDir
    const legacyMemDbPath = join(targetDir, 'memory', 'memory.db')
    seedSqliteDb(
      legacyMemDbPath,
      'CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL);',
      (db) => {
        db.prepare(
          'INSERT INTO memories (namespace, key, value, created_at) VALUES (?, ?, ?, ?)',
        ).run('global', 'pref-lang', 'pt-BR', '2026-05-01T00:00:00.000Z')
      },
    )

    const report = migrateLegacyStoresAndPurgeStale(targetDir, { dryRun: false })
    assert.equal(report.memoriesMigrated, 1)
    assertPathsExist([
      [
        legacyMemDbPath,
        false,
        'legacy memory/memory.db must be removed after migration to .pantheon/memory/memory.db',
      ],
      [join(targetDir, '.pantheon', 'memory', 'memory.db'), true],
    ])
  })
})

test('plugin.setup migrates global and workspace legacy stores without CLI init and preserves global data across workspaces', async () => {
  await withTempDirs(
    ['pantheon-plugin-xdg-', 'pantheon-plugin-ws-a-', 'pantheon-plugin-ws-b-'],
    async ([xdgConfig, workspaceA, workspaceB]) => {
      await withEnv({ XDG_CONFIG_HOME: xdgConfig, PANTHEON_HOME: undefined }, async () => {
        resetLegacyMigrationCacheForTests()
        const globalDir = join(xdgConfig, 'opencode')

        // Seed global legacy memory/memory.db and persistence/global.db
        const globalMemDbPath = join(globalDir, 'memory', 'memory.db')
        seedSqliteDb(
          globalMemDbPath,
          'CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL);',
          (db) => {
            db.prepare(
              'INSERT INTO memories (namespace, key, value, created_at) VALUES (?, ?, ?, ?)',
            ).run(
              'default',
              'global-convention',
              'Always use native SQLite',
              '2026-05-01T00:00:00.000Z',
            )
          },
        )

        const globalPersDbPath = join(globalDir, 'persistence', 'global.db')
        seedSqliteDb(
          globalPersDbPath,
          'CREATE TABLE kv_store (id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
          (db) => {
            db.prepare(
              'INSERT INTO kv_store (namespace, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            ).run(
              'checkpoints',
              'global-ses-1',
              '{"step":"global-checkpoint"}',
              '2026-05-01T00:00:00.000Z',
              '2026-05-01T00:00:00.000Z',
            )
          },
        )

        // Seed stale V1 hook in globalDir
        writeFixtureFile(join(globalDir, 'plugins', 'pantheon-hooks.ts'), '// stale hook')

        // Seed workspaceA legacy flat .pantheon/memory.db
        const wsMemDbPath = join(workspaceA, '.pantheon', 'memory.db')
        seedSqliteDb(
          wsMemDbPath,
          'CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL);',
          (db) => {
            db.prepare(
              'INSERT INTO memories (namespace, key, value, created_at) VALUES (?, ?, ?, ?)',
            ).run('default', 'ws-a-fact', 'Workspace A local memory', '2026-05-01T00:00:00.000Z')
          },
        )

        // Simulate pure OpenCode plugin boot on workspaceA (no CLI init)
        await runPluginSetup(workspaceA)

        // Legacy files in both globalDir and workspaceA must be purged; canonical global store must persist
        assertPathsExist([
          [globalMemDbPath, false],
          [globalPersDbPath, false],
          [join(globalDir, 'plugins', 'pantheon-hooks.ts'), false],
          [wsMemDbPath, false],
          [join(globalDir, '.pantheon', 'memory', 'memory.db'), true],
          [join(globalDir, '.pantheon', 'persistence', 'checkpoints', 'global-ses-1.json'), true],
        ])

        // Simulate opening a brand-new workspaceB via plugin later — it still gets global data!
        await runPluginSetup(workspaceB)

        const runToolB = createToolRunner(workspaceB)
        const globalMemInB = await runToolB('memory_recall', {
          namespace: 'default',
          key: 'global-convention',
        })
        assert.equal(globalMemInB.value, 'Always use native SQLite')

        const globalCtxInB = await runToolB('context_get', { session_id: 'global-ses-1' })
        assert.equal(globalCtxInB.content, '{"step":"global-checkpoint"}')
      })
    },
  )
})

test('scanLegacyArtifacts and cleanLegacyArtifacts migrate stores first and preserve custom user agents/skills', async () => {
  await withTempDirs(['pantheon-legacy-audit-'], ([tmp]) => {
    const globalDir = join(tmp, 'global-opencode')
    const projectDir = join(tmp, 'project-ws')

    // Seed global TUI drift copy + V1 hook + canonical skill + custom user skill
    writeFixtureFile(
      join(globalDir, 'plugins', 'pantheon-tui', 'package.json'),
      JSON.stringify({ name: 'pantheon-tui', version: '2.1.6' }),
    )
    writeFixtureFile(join(globalDir, 'plugins', 'pantheon-hooks.ts'), '// obsolete v1')
    writeFixtureFile(join(globalDir, 'agents', 'zeus.md'), '# legacy zeus copy')
    writeFixtureFile(join(globalDir, 'agents', 'gaia.md'), '# legacy pantheon gaia copy')
    writeFixtureFile(join(globalDir, 'skills', 'tdd-with-agents', 'SKILL.md'), '# canonical copy')
    writeFixtureFile(
      join(globalDir, 'skills', 'my-custom-skill', 'SKILL.md'),
      '# user custom skill',
    )
    writeFixtureFile(join(globalDir, 'opencode.json.bak.1'), '{}')

    // Seed project unmigrated goals.json + canonical command + custom user forged agent
    writeFixtureFile(
      join(projectDir, '.pantheon', 'goals.json'),
      JSON.stringify([{ id: 'goal-keep', title: 'Preserve goal before cleanup' }]),
    )
    writeFixtureFile(
      join(projectDir, '.opencode', 'commands', 'pantheon-deepwork.md'),
      '# cmd copy',
    )
    writeFixtureFile(
      join(projectDir, '.opencode', 'commands', 'pantheon-settings.md'),
      '# legacy pantheon settings copy',
    )
    writeFixtureFile(
      join(projectDir, '.opencode', 'agents', 'custom-geo.md'),
      '# user forged agent',
    )

    const scan = scanLegacyArtifacts({
      workspaceDir: projectDir,
      globalConfigDir: globalDir,
      runningVersion: '2.2.0-beta.4',
    })
    assert.ok(scan.summary.total >= 6)
    assert.ok(scan.summary.totalBytes > 0)
    assert.ok(scan.items.some((i) => i.category === 'drift' && i.path.includes('pantheon-tui')))
    assert.ok(scan.items.some((i) => i.category === 'hooks'))
    assert.ok(scan.items.some((i) => i.category === 'redundantAsset'))
    // Custom user files must NEVER appear in legacy scan
    assert.equal(
      scan.items.some(
        (i) => i.path.includes('custom-geo.md') || i.path.includes('my-custom-skill'),
      ),
      false,
    )

    const result = cleanLegacyArtifacts({
      workspaceDir: projectDir,
      globalConfigDir: globalDir,
      runningVersion: '2.2.0-beta.4',
    })
    assert.equal(result.errors.length, 0)
    assert.ok(result.removed.length >= 6)
    assert.ok(result.reclaimedBytes > 0)

    assertPathsExist([
      // Goal must have been migrated to canonical .pantheon/goals/<id>.json BEFORE deletion
      [join(projectDir, '.pantheon', 'goals', 'goal-keep.json'), true],
      [join(projectDir, '.pantheon', 'goals.json'), false],
      // Obsolete/redundant files deleted
      [join(globalDir, 'plugins', 'pantheon-hooks.ts'), false],
      [join(globalDir, 'plugins', 'pantheon-tui'), false],
      [join(globalDir, 'agents', 'zeus.md'), false],
      [join(globalDir, 'agents', 'gaia.md'), false],
      [join(projectDir, '.opencode', 'commands', 'pantheon-settings.md'), false],
      [join(globalDir, 'agents', 'zeus.md'), false],
      [join(globalDir, 'skills', 'tdd-with-agents'), false],
      [join(projectDir, '.opencode', 'commands', 'pantheon-deepwork.md'), false],
      // User custom files preserved untouched
      [join(globalDir, 'skills', 'my-custom-skill', 'SKILL.md'), true],
      [join(projectDir, '.opencode', 'agents', 'custom-geo.md'), true],
    ])
  })
})

test('ensureLegacyStoresMigratedOnce batches 4000 global rows, writes stamp fast-path, and resyncs on global mtime change', async () => {
  await withTempDirs(['pantheon-batch-stamp-'], ([tmp]) => {
    resetLegacyMigrationCacheForTests()
    const globalDir = join(tmp, 'global-opencode')
    const projectDir = join(tmp, 'project')
    mkdirSync(projectDir, { recursive: true })

    const globalDbPath = join(globalDir, '.pantheon', 'memory', 'memory.db')
    const now = new Date().toISOString()
    seedSqliteDb(
      globalDbPath,
      `
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          namespace TEXT NOT NULL,
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          metadata TEXT,
          created_at TEXT NOT NULL,
          expires_at TEXT,
          UNIQUE(namespace, key)
        );
        BEGIN IMMEDIATE;
      `,
      (db) => {
        const ins = db.prepare(
          'INSERT INTO memories (namespace, key, value, metadata, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        for (let i = 0; i < 4000; i += 1) {
          ins.run('batch', `k-${i}`, `val-${i}`, '{}', now)
        }
        db.exec('COMMIT;')
      },
    )

    const t0 = performance.now()
    const first = ensureLegacyStoresMigratedOnce(projectDir, { globalConfigDir: globalDir })
    const elapsedFirstMs = performance.now() - t0
    assert.ok(first !== null)
    assert.equal(first.memoriesMigrated, 4000)
    assert.ok(elapsedFirstMs < 2000, `expected batched migration < 2000ms, got ${elapsedFirstMs}ms`)

    const stampPath = join(projectDir, '.pantheon', '.migration-v2.json')
    assert.equal(existsSync(stampPath), true)
    const stamp = JSON.parse(readFileSync(stampPath, 'utf8'))
    assert.equal(stamp.version, 2)
    assert.ok(typeof stamp.globalMtimeMs === 'number' && stamp.globalMtimeMs > 0)

    // Cold startup (cleared in-memory cache) hits .migration-v2.json fast-path without copying
    resetLegacyMigrationCacheForTests()
    const t1 = performance.now()
    const second = ensureLegacyStoresMigratedOnce(projectDir, { globalConfigDir: globalDir })
    const elapsedSecondMs = performance.now() - t1
    assert.equal(second, null)
    assert.ok(elapsedSecondMs < 50, `expected stamp fast-path < 50ms, got ${elapsedSecondMs}ms`)

    // New row in global memory DB bumps mtime -> stamp invalidates and syncs delta cleanly
    const gDb2 = new DatabaseSync(globalDbPath)
    gDb2
      .prepare(
        'INSERT INTO memories (namespace, key, value, metadata, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run('batch', 'k-extra', 'val-extra', '{}', now)
    gDb2.exec('PRAGMA wal_checkpoint(TRUNCATE);')
    gDb2.close()
    const bumpedTime = new Date(Date.now() + 5000)
    utimesSync(globalDbPath, bumpedTime, bumpedTime)

    resetLegacyMigrationCacheForTests()
    const third = ensureLegacyStoresMigratedOnce(projectDir, { globalConfigDir: globalDir })
    assert.ok(third !== null)
    assert.equal(third.memoriesMigrated, 1)

    const pDb = new DatabaseSync(join(projectDir, '.pantheon', 'memory', 'memory.db'), {
      readOnly: true,
    })
    const countRow = pDb.prepare('SELECT COUNT(*) AS cnt FROM memories').get() as { cnt: number }
    const extraRow = pDb
      .prepare("SELECT value FROM memories WHERE namespace = 'batch' AND key = 'k-extra'")
      .get() as { value: string } | undefined
    pDb.close()
    assert.equal(countRow.cnt, 4001)
    assert.equal(extraRow?.value, 'val-extra')
  })
})
