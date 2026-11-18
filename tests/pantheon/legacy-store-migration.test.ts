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
import plugin from '../../src/plugin.ts'

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

test('plugin.setup migrates global and workspace legacy stores without CLI init and preserves global data across workspaces', async () => {
  const xdgConfig = mkdtempSync(join(tmpdir(), 'pantheon-plugin-xdg-'))
  const globalDir = join(xdgConfig, 'opencode')
  const workspaceA = mkdtempSync(join(tmpdir(), 'pantheon-plugin-ws-a-'))
  const workspaceB = mkdtempSync(join(tmpdir(), 'pantheon-plugin-ws-b-'))
  const prevXdg = process.env.XDG_CONFIG_HOME
  const prevHome = process.env.PANTHEON_HOME
  try {
    resetLegacyMigrationCacheForTests()
    delete process.env.PANTHEON_HOME
    process.env.XDG_CONFIG_HOME = xdgConfig
    mkdirSync(globalDir, { recursive: true })

    // Seed global legacy memory/memory.db and persistence/global.db
    const globalMemDir = join(globalDir, 'memory')
    mkdirSync(globalMemDir, { recursive: true })
    const gMem = new DatabaseSync(join(globalMemDir, 'memory.db'))
    gMem.exec(
      'CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL);',
    )
    gMem
      .prepare('INSERT INTO memories (namespace, key, value, created_at) VALUES (?, ?, ?, ?)')
      .run('default', 'global-convention', 'Always use native SQLite', '2026-05-01T00:00:00.000Z')
    gMem.close()

    const globalPersDir = join(globalDir, 'persistence')
    mkdirSync(globalPersDir, { recursive: true })
    const gPers = new DatabaseSync(join(globalPersDir, 'global.db'))
    gPers.exec(
      'CREATE TABLE kv_store (id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);',
    )
    gPers
      .prepare(
        'INSERT INTO kv_store (namespace, key, value, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(
        'checkpoints',
        'global-ses-1',
        '{"step":"global-checkpoint"}',
        '2026-05-01T00:00:00.000Z',
        '2026-05-01T00:00:00.000Z',
      )
    gPers.close()

    // Seed stale V1 hook + 35-day-old opencode.json.bak in globalDir
    mkdirSync(join(globalDir, 'plugins'), { recursive: true })
    writeFileSync(join(globalDir, 'plugins', 'pantheon-hooks.ts'), '// stale hook')

    // Seed workspaceA legacy flat .pantheon/memory.db
    mkdirSync(join(workspaceA, '.pantheon'), { recursive: true })
    const wsMem = new DatabaseSync(join(workspaceA, '.pantheon', 'memory.db'))
    wsMem.exec(
      'CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, created_at TEXT NOT NULL);',
    )
    wsMem
      .prepare('INSERT INTO memories (namespace, key, value, created_at) VALUES (?, ?, ?, ?)')
      .run('default', 'ws-a-fact', 'Workspace A local memory', '2026-05-01T00:00:00.000Z')
    wsMem.close()

    // Simulate pure OpenCode plugin boot on workspaceA (no CLI init)
    const noopDraft = () => ({ list: () => [], update: () => {}, add: () => {}, default: () => {} })
    await plugin.setup({
      agent: { transform: (fn: (d: unknown) => void) => fn(noopDraft()) },
      command: { transform: (fn: (d: unknown) => void) => fn(noopDraft()) },
      reference: { transform: (fn: (d: unknown) => void) => fn(noopDraft()) },
      location: { directory: workspaceA },
    } as unknown as Parameters<typeof plugin.setup>[0])

    // Legacy files in both globalDir and workspaceA must be purged
    assert.equal(existsSync(join(globalMemDir, 'memory.db')), false)
    assert.equal(existsSync(join(globalPersDir, 'global.db')), false)
    assert.equal(existsSync(join(globalDir, 'plugins', 'pantheon-hooks.ts')), false)
    assert.equal(existsSync(join(workspaceA, '.pantheon', 'memory.db')), false)

    // Canonical global store must persist for future workspaces
    assert.equal(existsSync(join(globalDir, '.pantheon', 'memory', 'memory.db')), true)
    assert.equal(
      existsSync(join(globalDir, '.pantheon', 'persistence', 'checkpoints', 'global-ses-1.json')),
      true,
    )

    // Simulate opening a brand-new workspaceB via plugin later — it still gets global data!
    await plugin.setup({
      agent: { transform: (fn: (d: unknown) => void) => fn(noopDraft()) },
      command: { transform: (fn: (d: unknown) => void) => fn(noopDraft()) },
      reference: { transform: (fn: (d: unknown) => void) => fn(noopDraft()) },
      location: { directory: workspaceB },
    } as unknown as Parameters<typeof plugin.setup>[0])

    const toolsB = createNativeMemoryAndPersistenceTools(workspaceB)
    const recallB = toolsB.find((t) => t.name === 'memory_recall')
    const ctxGetB = toolsB.find((t) => t.name === 'context_get')
    assert.ok(recallB && ctxGetB, 'native memory_recall and context_get tools must exist')

    const globalMemInB = JSON.parse(
      (
        await recallB.execute(
          { namespace: 'default', key: 'global-convention' },
          { directory: workspaceB },
        )
      ).output,
    )
    assert.equal(globalMemInB.value, 'Always use native SQLite')

    const globalCtxInB = JSON.parse(
      (await ctxGetB.execute({ session_id: 'global-ses-1' }, { directory: workspaceB })).output,
    )
    assert.equal(globalCtxInB.content, '{"step":"global-checkpoint"}')
  } finally {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME
    else process.env.XDG_CONFIG_HOME = prevXdg
    if (prevHome === undefined) delete process.env.PANTHEON_HOME
    else process.env.PANTHEON_HOME = prevHome
    rmSync(xdgConfig, { recursive: true, force: true })
    rmSync(workspaceA, { recursive: true, force: true })
    rmSync(workspaceB, { recursive: true, force: true })
  }
})
