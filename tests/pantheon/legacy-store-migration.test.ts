import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import {
  migrateLegacyStoresAndPurgeStale,
  resetLegacyMigrationCacheForTests,
} from '../../src/pantheon/legacy-store-migration.mjs'
import { createNativeMemoryAndPersistenceTools } from '../../src/pantheon/native-memory-tools.ts'

test('migrates legacy memory.db, persistence global/project.db, checkpoints, and goals while deleting stale artifacts', async () => {
  const workDir = mkdtempSync(join(tmpdir(), 'pantheon-legacy-migrate-'))
  try {
    resetLegacyMigrationCacheForTests()
    const pantheonDir = join(workDir, '.pantheon')
    mkdirSync(pantheonDir, { recursive: true })

    // 1. Seed legacy flat .pantheon/memory.db with active + expired rows + legacy vector table
    const legacyMemDbPath = join(pantheonDir, 'memory.db')
    const memDb = new DatabaseSync(legacyMemDbPath)
    memDb.exec(`
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
    `)
    const futureIso = new Date(Date.now() + 3600_000).toISOString()
    const pastIso = new Date(Date.now() - 3600_000).toISOString()
    memDb
      .prepare(
        'INSERT INTO memories (namespace, key, value, metadata, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'architecture',
        'auth-adr',
        'Use PKCE OAuth2 flow with httpOnly session cookies',
        '{"author":"athena"}',
        '2026-05-01T00:00:00.000Z',
        '2026-05-01T00:00:00.000Z',
        futureIso,
      )
    memDb
      .prepare(
        'INSERT INTO memories (namespace, key, value, metadata, created_at, updated_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'architecture',
        'stale-key',
        'Obsolete expired fact that must be deleted',
        '{}',
        '2025-01-01T00:00:00.000Z',
        '2025-01-01T00:00:00.000Z',
        pastIso,
      )
    memDb.close()
    writeFileSync(join(pantheonDir, '.memory.db.init.lock'), '')

    // 2. Seed legacy SQLite persistence/project.db (kv_store + pantheon_goals)
    const legacyPersistenceDir = join(pantheonDir, 'persistence')
    mkdirSync(legacyPersistenceDir, { recursive: true })
    const projectDbPath = join(legacyPersistenceDir, 'project.db')
    const projDb = new DatabaseSync(projectDbPath)
    projDb.exec(`
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
    `)
    // Active checkpoint in 'context' namespace
    projDb
      .prepare(
        'INSERT INTO kv_store (namespace, key, value, expires_at, deleted_at, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
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
    projDb
      .prepare(
        'INSERT INTO kv_store (namespace, key, value, expires_at, deleted_at, created_at, updated_at, revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
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
    projDb
      .prepare(
        'INSERT INTO pantheon_goals (goal_id, session_id, title, status, criteria_json, notes_json, created_at, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
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
    projDb.close()
    writeFileSync(join(legacyPersistenceDir, '.project.db.init.lock'), '')

    // 3. Seed legacy .pantheon/goals.json and .pantheon/checkpoints/
    writeFileSync(
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
    mkdirSync(legacyCheckpointsDir, { recursive: true })
    writeFileSync(
      join(legacyCheckpointsDir, 'ses-legacy-file.json'),
      JSON.stringify({
        content: 'checkpoint-from-flat-dir',
        updated_at: '2026-05-01T00:00:00.000Z',
      }),
    )

    // 4. Seed stale obsolete artifacts (fastembed_cache, dead V1 pantheon-hooks.ts, tiers.json)
    mkdirSync(join(pantheonDir, 'fastembed_cache'), { recursive: true })
    writeFileSync(join(pantheonDir, 'fastembed_cache', 'model.onnx'), 'stale-weights')
    mkdirSync(join(workDir, 'plugins'), { recursive: true })
    writeFileSync(join(workDir, 'plugins', 'pantheon-hooks.ts'), '// obsolete v1 hook')
    writeFileSync(join(workDir, 'tiers.json'), '{}')

    // 5. Invoke native tools directly — auto-migration must fire transparently!
    const tools = createNativeMemoryAndPersistenceTools(workDir)
    const getTool = (name: string) => {
      const found = tools.find((t) => t.name === name)
      assert.ok(found, `Missing tool ${name}`)
      return found
    }

    // 5a. Verify migrated memory via memory_recall and FTS5 memory_search
    const recallRes = JSON.parse(
      (
        await getTool('memory_recall').execute(
          { namespace: 'architecture', key: 'auth-adr' },
          { directory: workDir },
        )
      ).output,
    )
    assert.equal(recallRes.value, 'Use PKCE OAuth2 flow with httpOnly session cookies')

    const expiredRecall = JSON.parse(
      (
        await getTool('memory_recall').execute(
          { namespace: 'architecture', key: 'stale-key' },
          { directory: workDir },
        )
      ).output,
    )
    assert.equal(expiredRecall.error, 'not_found')

    const searchRes = JSON.parse(
      (
        await getTool('memory_search').execute(
          { query: 'PKCE OAuth2', namespace: 'architecture' },
          { directory: workDir },
        )
      ).output,
    )
    assert.equal(searchRes.ok, true)
    assert.equal(searchRes.count, 1)
    assert.equal(searchRes.results[0].key, 'auth-adr')

    // 5b. Verify migrated context checkpoints from SQLite kv_store and flat checkpoints/
    const ctxSql = JSON.parse(
      (await getTool('context_get').execute({ session_id: 'ses-legacy-1' }, { directory: workDir }))
        .output,
    )
    assert.equal(ctxSql.content, '{"phase":"phase-2","completed":["db-schema"]}')

    const ctxDeleted = JSON.parse(
      (await getTool('context_get').execute({ session_id: 'ses-deleted' }, { directory: workDir }))
        .output,
    )
    assert.equal(ctxDeleted.error, 'not_found')

    const ctxFlat = JSON.parse(
      (
        await getTool('context_get').execute(
          { session_id: 'ses-legacy-file' },
          { directory: workDir },
        )
      ).output,
    )
    assert.equal(ctxFlat.content, 'checkpoint-from-flat-dir')

    // 5c. Verify migrated goals from SQLite pantheon_goals and goals.json
    const goalSql = JSON.parse(
      (await getTool('goal_get').execute({ id: 'goal-legacy-sql' }, { directory: workDir })).output,
    )
    assert.equal(goalSql.title, 'Complete native store migration')
    assert.deepEqual(goalSql.criteria, ['migrate memory.db', 'migrate project.db'])

    const goalJson = JSON.parse(
      (await getTool('goal_get').execute({ id: 'goal-legacy-json' }, { directory: workDir }))
        .output,
    )
    assert.equal(goalJson.title, 'Clean up stale vector cache')

    // 5d. Verify all obsolete/stale files & databases were deleted
    assert.equal(
      existsSync(legacyMemDbPath),
      false,
      'legacy flat .pantheon/memory.db must be deleted',
    )
    assert.equal(existsSync(join(pantheonDir, '.memory.db.init.lock')), false)
    assert.equal(existsSync(projectDbPath), false, 'legacy SQLite project.db must be deleted')
    assert.equal(existsSync(join(legacyPersistenceDir, '.project.db.init.lock')), false)
    assert.equal(
      existsSync(join(pantheonDir, 'goals.json')),
      false,
      'legacy goals.json must be deleted',
    )
    assert.equal(
      existsSync(legacyCheckpointsDir),
      false,
      'empty legacy checkpoints dir must be deleted',
    )
    assert.equal(
      existsSync(join(pantheonDir, 'fastembed_cache')),
      false,
      'fastembed_cache must be deleted',
    )
    assert.equal(existsSync(join(workDir, 'plugins', 'pantheon-hooks.ts')), false)
    assert.equal(existsSync(join(workDir, 'tiers.json')), false)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
})

test('migrateLegacyStoresAndPurgeStale migrates legacy memory/memory.db and purges stale files', () => {
  const targetDir = mkdtempSync(join(tmpdir(), 'pantheon-install-datamig-'))
  try {
    resetLegacyMigrationCacheForTests()

    // Seed legacy global memory/memory.db inside targetDir
    const legacyMemDir = join(targetDir, 'memory')
    mkdirSync(legacyMemDir, { recursive: true })
    const legacyDb = new DatabaseSync(join(legacyMemDir, 'memory.db'))
    legacyDb.exec(`
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `)
    legacyDb
      .prepare('INSERT INTO memories (namespace, key, value, created_at) VALUES (?, ?, ?, ?)')
      .run('global', 'pref-lang', 'pt-BR', '2026-05-01T00:00:00.000Z')
    legacyDb.close()

    const report = migrateLegacyStoresAndPurgeStale(targetDir, { dryRun: false })
    assert.equal(report.memoriesMigrated, 1)
    assert.equal(
      existsSync(join(legacyMemDir, 'memory.db')),
      false,
      'legacy memory/memory.db must be removed after migration to .pantheon/memory/memory.db',
    )
    assert.equal(existsSync(join(targetDir, '.pantheon', 'memory', 'memory.db')), true)
  } finally {
    rmSync(targetDir, { recursive: true, force: true })
  }
})
