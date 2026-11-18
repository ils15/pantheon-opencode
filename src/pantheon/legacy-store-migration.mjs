/**
 * Legacy Data Migration & Stale Artifact Purge Engine (`legacy-store-migration.mjs`).
 *
 * Plain ESM `.mjs` module (with `.d.mts` types) so it runs natively both inside
 * `node_modules/` during global `pantheon-opencode init` (where Node.js forbids
 * `.ts` type-stripping) and inside the bundled TypeScript plugin.
 *
 * @module pantheon/legacy-store-migration
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._:-]{1,128}$/

/**
 * Resolve the user's global OpenCode config directory safely.
 * Inside Node's test runner (`NODE_TEST_CONTEXT`), returns `undefined` unless
 * `PANTHEON_HOME` or `XDG_CONFIG_HOME` was explicitly redirected by the test.
 */
export function resolveSafeGlobalConfigDir(env = process.env) {
  if (env.PANTHEON_HOME?.trim()) {
    return resolve(env.PANTHEON_HOME.trim())
  }
  if (env.XDG_CONFIG_HOME?.trim()) {
    return join(resolve(env.XDG_CONFIG_HOME.trim()), 'opencode')
  }
  if (env.NODE_TEST_CONTEXT) {
    return undefined
  }
  const home = env.HOME?.trim()
  return home ? join(resolve(home), '.config', 'opencode') : undefined
}

function toSafeSegment(raw, fallback = 'default') {
  const str = String(raw ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, '_')
    .slice(0, 128)
  if (!str || str === '.' || str === '..' || !SAFE_SEGMENT_RE.test(str)) {
    return fallback
  }
  return str
}

function sameFileOrPath(a, b) {
  if (resolve(a) === resolve(b)) return true
  if (!existsSync(a) || !existsSync(b)) return false
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

function removeFileAndSqliteSidecars(filePath, deleted, dryRun = false) {
  const dir = dirname(filePath)
  const base = filePath.slice(dir.length + 1)
  const candidates = [
    filePath,
    `${filePath}-wal`,
    `${filePath}-shm`,
    `${filePath}-journal`,
    join(dir, `.${base}.init.lock`),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      if (!dryRun) {
        rmSync(candidate, { recursive: true, force: true })
      }
      deleted.push(candidate)
    }
  }
}

function removeEmptyDirIfPossible(dirPath, deleted, dryRun = false) {
  if (!existsSync(dirPath)) return
  try {
    const entries = readdirSync(dirPath)
    if (entries.length === 0) {
      if (!dryRun) {
        rmSync(dirPath, { recursive: true, force: true })
      }
      deleted.push(dirPath)
    }
  } catch {
    /* ignore */
  }
}

const migratedWorkspaces = new Set()

export function resetLegacyMigrationCacheForTests() {
  migratedWorkspaces.clear()
}

export function ensureLegacyStoresMigratedOnce(workspaceDir, options = {}) {
  if (!workspaceDir || typeof workspaceDir !== 'string') return null
  const key = resolve(workspaceDir)
  if (key === '/' || !existsSync(key)) return null
  const globalKey = options.globalConfigDir ? resolve(options.globalConfigDir) : ''
  const cacheKey = `${key}::${globalKey}`
  if (migratedWorkspaces.has(cacheKey)) return null
  migratedWorkspaces.add(cacheKey)
  return migrateLegacyStoresAndPurgeStale(key, options)
}

export function migrateLegacyStoresAndPurgeStale(workspaceDir, options = {}) {
  const root = resolve(workspaceDir)
  const dryRun = options.dryRun === true
  const nowIso = new Date().toISOString()

  let memoriesMigrated = 0
  let memoriesExpiredPurged = 0
  let vectorTablesDropped = 0
  let contextsMigrated = 0
  let goalsMigrated = 0
  const staleFilesDeleted = []

  if (root === '/' || !existsSync(root)) {
    return {
      memoriesMigrated,
      memoriesExpiredPurged,
      vectorTablesDropped,
      contextsMigrated,
      goalsMigrated,
      staleFilesDeleted,
    }
  }

  // Migrate and clean up global OpenCode config dir first (preserving its canonical .pantheon stores)
  let globalCanonicalMemDb = null
  if (options.globalConfigDir) {
    const globalRoot = resolve(options.globalConfigDir)
    if (globalRoot !== '/' && globalRoot !== root && existsSync(globalRoot)) {
      const globalReport = migrateLegacyStoresAndPurgeStale(globalRoot, { dryRun })
      memoriesMigrated += globalReport.memoriesMigrated
      memoriesExpiredPurged += globalReport.memoriesExpiredPurged
      vectorTablesDropped += globalReport.vectorTablesDropped
      contextsMigrated += globalReport.contextsMigrated
      goalsMigrated += globalReport.goalsMigrated
      staleFilesDeleted.push(...globalReport.staleFilesDeleted)
      globalCanonicalMemDb = join(globalRoot, '.pantheon', 'memory', 'memory.db')
    }
  }

  const pantheonDir = join(root, '.pantheon')
  const canonicalMemoryDir = join(pantheonDir, 'memory')
  const canonicalMemoryDbPath = join(canonicalMemoryDir, 'memory.db')
  const canonicalPersistenceDir = join(pantheonDir, 'persistence')
  const canonicalGoalsDir = join(pantheonDir, 'goals')

  // ── 1. Collect legacy memory SQLite DB candidates ────────────────────────
  const legacyMemoryCandidates = [
    { path: join(pantheonDir, 'memory.db'), deleteAfter: true },
    { path: join(root, 'memory', 'memory.db'), deleteAfter: true },
  ]
  if (globalCanonicalMemDb) {
    // Non-destructively inherit global canonical memories into the workspace store
    legacyMemoryCandidates.push({ path: globalCanonicalMemDb, deleteAfter: false })
  }

  const existingLegacyMemDbs = legacyMemoryCandidates.filter(
    (c) => existsSync(c.path) && !sameFileOrPath(c.path, canonicalMemoryDbPath),
  )

  if (existingLegacyMemDbs.length > 0 || existsSync(canonicalMemoryDbPath)) {
    if (!dryRun) {
      mkdirSync(canonicalMemoryDir, { recursive: true })
    }
    let targetDb = null
    try {
      if (!dryRun) {
        targetDb = new DatabaseSync(canonicalMemoryDbPath)
        targetDb.exec(`
          CREATE TABLE IF NOT EXISTS memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            namespace TEXT NOT NULL,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            metadata TEXT,
            created_at TEXT NOT NULL,
            expires_at TEXT,
            UNIQUE(namespace, key)
          );
          CREATE INDEX IF NOT EXISTS idx_memories_ns_key ON memories(namespace, key);
        `)
      }

      for (const candidate of existingLegacyMemDbs) {
        let srcDb = null
        try {
          srcDb = new DatabaseSync(candidate.path, { readOnly: true })
          const hasTable = srcDb
            .prepare(
              "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memories' LIMIT 1",
            )
            .get()
          if (hasTable) {
            const cols = srcDb.prepare('PRAGMA table_info(memories)').all()
            const colNames = new Set(cols.map((c) => String(c.name ?? '')))
            const hasExpires = colNames.has('expires_at')
            const hasMeta = colNames.has('metadata')
            const hasCreated = colNames.has('created_at')

            const selectSql = `
              SELECT
                namespace,
                key,
                value,
                ${hasMeta ? 'metadata' : 'NULL AS metadata'},
                ${hasCreated ? 'created_at' : `'${nowIso}' AS created_at`},
                ${hasExpires ? 'expires_at' : 'NULL AS expires_at'}
              FROM memories
              WHERE key IS NOT NULL AND trim(key) != ''
            `
            const rows = srcDb.prepare(selectSql).all()

            for (const row of rows) {
              const exp = typeof row.expires_at === 'string' ? row.expires_at : null
              if (exp && exp <= nowIso) {
                memoriesExpiredPurged += 1
                continue
              }
              const ns = String(row.namespace ?? 'default').trim() || 'default'
              const key = String(row.key ?? '').trim()
              const val = String(row.value ?? '')
              if (!key || !val) continue
              if (!dryRun && targetDb) {
                const res = targetDb
                  .prepare(
                    `INSERT OR IGNORE INTO memories (namespace, key, value, metadata, created_at, expires_at)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                  )
                  .run(
                    ns,
                    key,
                    val,
                    typeof row.metadata === 'string' ? row.metadata : null,
                    typeof row.created_at === 'string' ? row.created_at : nowIso,
                    exp,
                  )
                if (res.changes > 0) memoriesMigrated += 1
              } else {
                memoriesMigrated += 1
              }
            }
          }
        } catch {
          /* corrupted legacy db — will still be cleaned up below */
        } finally {
          try {
            srcDb?.close()
          } catch {
            /* ignore */
          }
        }

        if (candidate.deleteAfter) {
          removeFileAndSqliteSidecars(candidate.path, staleFilesDeleted, dryRun)
          removeEmptyDirIfPossible(dirname(candidate.path), staleFilesDeleted, dryRun)
        }
      }

      // Clean up canonical memory.db: purge expired rows, drop legacy vector tables, rebuild FTS5
      if (!dryRun && targetDb) {
        try {
          const del = targetDb
            .prepare('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?')
            .run(nowIso)
          memoriesExpiredPurged += Number(del.changes ?? 0)
        } catch {
          /* ignore */
        }

        const legacyVectorObjects = [
          { type: 'trigger', name: 'memories_vec_ai' },
          { type: 'trigger', name: 'memories_vec_ad' },
          { type: 'trigger', name: 'memories_vec_au' },
          { type: 'table', name: 'memories_vec' },
          { type: 'table', name: 'vec_memories' },
          { type: 'table', name: 'memory_embeddings' },
          { type: 'table', name: 'memory_vectors' },
        ]
        for (const obj of legacyVectorObjects) {
          try {
            const exists = targetDb
              .prepare('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ? LIMIT 1')
              .get(obj.type, obj.name)
            if (exists) {
              targetDb.exec(
                `DROP ${obj.type === 'trigger' ? 'TRIGGER' : 'TABLE'} IF EXISTS ${obj.name}`,
              )
              vectorTablesDropped += 1
            }
          } catch {
            /* virtual table extension may not be loaded; ignore */
          }
        }

        try {
          targetDb.exec(`
            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
              namespace,
              key,
              value,
              content='memories',
              content_rowid='id',
              tokenize='porter unicode61'
            );
            CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
              INSERT INTO memories_fts(rowid, namespace, key, value)
              VALUES (new.id, new.namespace, new.key, new.value);
            END;
            CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
              INSERT INTO memories_fts(memories_fts, rowid, namespace, key, value)
              VALUES ('delete', old.id, old.namespace, old.key, old.value);
            END;
            CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
              INSERT INTO memories_fts(memories_fts, rowid, namespace, key, value)
              VALUES ('delete', old.id, old.namespace, old.key, old.value);
              INSERT INTO memories_fts(rowid, namespace, key, value)
              VALUES (new.id, new.namespace, new.key, new.value);
            END;
            INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
          `)
        } catch {
          /* FTS5 optional */
        }
      }
    } finally {
      try {
        targetDb?.close()
      } catch {
        /* ignore */
      }
    }
  }

  // ── 2. Migrate legacy Persistence SQLite DBs (global.db & project.db) ────
  const legacyPersistenceDbs = [
    join(pantheonDir, 'persistence', 'project.db'),
    join(pantheonDir, 'persistence', 'global.db'),
    join(root, 'persistence', 'project.db'),
    join(root, 'persistence', 'global.db'),
  ]
  if (options.globalConfigDir) {
    const globalRoot = resolve(options.globalConfigDir)
    if (globalRoot !== root) {
      legacyPersistenceDbs.push(
        join(globalRoot, 'persistence', 'global.db'),
        join(globalRoot, 'persistence', 'project.db'),
        join(globalRoot, '.pantheon', 'persistence', 'global.db'),
        join(globalRoot, '.pantheon', 'persistence', 'project.db'),
      )
    }
  }

  const seenPersistenceDbs = new Set()
  for (const dbPath of legacyPersistenceDbs) {
    if (!existsSync(dbPath)) continue
    const real = (() => {
      try {
        return realpathSync(dbPath)
      } catch {
        return resolve(dbPath)
      }
    })()
    if (seenPersistenceDbs.has(real)) continue
    seenPersistenceDbs.add(real)

    let pDb = null
    try {
      pDb = new DatabaseSync(dbPath, { readOnly: true })

      // 2a. Migrate kv_store rows (context_save / persistence checkpoints)
      const hasKvStore = pDb
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv_store' LIMIT 1")
        .get()
      if (hasKvStore) {
        const cols = pDb.prepare('PRAGMA table_info(kv_store)').all()
        const colNames = new Set(cols.map((c) => String(c.name ?? '')))
        const hasDeleted = colNames.has('deleted_at')
        const hasExpires = colNames.has('expires_at')
        const hasUpdated = colNames.has('updated_at')
        const hasCreated = colNames.has('created_at')
        const hasRevision = colNames.has('revision')

        const rows = pDb
          .prepare(
            `SELECT
               namespace,
               key,
               value,
               ${hasExpires ? 'expires_at' : 'NULL AS expires_at'},
               ${hasDeleted ? 'deleted_at' : 'NULL AS deleted_at'},
               ${hasCreated ? 'created_at' : `'${nowIso}' AS created_at`},
               ${hasUpdated ? 'updated_at' : `'${nowIso}' AS updated_at`},
               ${hasRevision ? 'revision' : 'NULL AS revision'}
             FROM kv_store`,
          )
          .all()

        for (const row of rows) {
          if (row.deleted_at != null) continue
          const exp = typeof row.expires_at === 'string' ? row.expires_at : null
          if (exp && exp <= nowIso) continue

          const rawNs = String(row.namespace ?? 'checkpoints').trim() || 'checkpoints'
          const safeNs = toSafeSegment(rawNs, 'checkpoints')
          const safeKey = toSafeSegment(row.key, '')
          if (!safeKey) continue

          const valueStr = String(row.value ?? '')
          const record = {
            session_id: safeKey,
            key: safeKey,
            namespace: safeNs,
            content: valueStr,
            value: valueStr,
            created_at: typeof row.created_at === 'string' ? row.created_at : nowIso,
            updated_at: typeof row.updated_at === 'string' ? row.updated_at : nowIso,
            ...(exp ? { expires_at: exp } : {}),
            ...(typeof row.revision === 'number' ? { revision: row.revision } : {}),
          }

          const targetNamespaces = safeNs === 'context' ? ['context', 'checkpoints'] : [safeNs]
          let wroteAny = false
          for (const targetNs of targetNamespaces) {
            const nsDir = join(canonicalPersistenceDir, targetNs)
            const outFile = join(nsDir, `${safeKey}.json`)
            if (!existsSync(outFile)) {
              if (!dryRun) {
                mkdirSync(nsDir, { recursive: true })
                writeFileSync(
                  outFile,
                  JSON.stringify({ ...record, namespace: targetNs }, null, 2),
                  'utf8',
                )
              }
              wroteAny = true
            }
          }
          if (wroteAny) contextsMigrated += 1
        }
      }

      // 2b. Migrate pantheon_goals rows from project.db
      const hasGoals = pDb
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pantheon_goals' LIMIT 1",
        )
        .get()
      if (hasGoals) {
        const goalRows = pDb.prepare('SELECT * FROM pantheon_goals').all()
        for (const row of goalRows) {
          const rawId = String(row.goal_id ?? row.id ?? '').trim()
          const safeId = toSafeSegment(rawId, '')
          if (!safeId) continue
          const outFile = join(canonicalGoalsDir, `${safeId}.json`)
          if (!existsSync(outFile)) {
            let criteria = []
            if (typeof row.criteria_json === 'string') {
              try {
                const parsed = JSON.parse(row.criteria_json)
                if (Array.isArray(parsed)) criteria = parsed.map(String)
              } catch {
                /* ignore */
              }
            }
            let notes
            if (typeof row.notes_json === 'string') {
              try {
                notes = JSON.parse(row.notes_json)
              } catch {
                notes = row.notes_json
              }
            }
            const goalRecord = {
              id: safeId,
              ...(typeof row.session_id === 'string' ? { session_id: row.session_id } : {}),
              title: String(row.title ?? ''),
              criteria,
              status: String(row.status ?? 'active'),
              ...(notes !== undefined ? { notes } : {}),
              created_at: typeof row.created_at === 'string' ? row.created_at : nowIso,
              updated_at: typeof row.updated_at === 'string' ? row.updated_at : nowIso,
              ...(typeof row.completed_at === 'string' ? { completed_at: row.completed_at } : {}),
            }
            if (!dryRun) {
              mkdirSync(canonicalGoalsDir, { recursive: true })
              writeFileSync(outFile, JSON.stringify(goalRecord, null, 2), 'utf8')
            }
            goalsMigrated += 1
          }
        }
      }
    } catch {
      /* unreadable legacy SQLite persistence db — remove below */
    } finally {
      try {
        pDb?.close()
      } catch {
        /* ignore */
      }
    }

    removeFileAndSqliteSidecars(dbPath, staleFilesDeleted, dryRun)
    const parentDir = dirname(dbPath)
    if (parentDir !== canonicalPersistenceDir) {
      removeEmptyDirIfPossible(parentDir, staleFilesDeleted, dryRun)
    }
  }

  // ── 3. Migrate legacy flat checkpoint/context directories & goals.json ───
  for (const legacyCheckpointDir of [
    join(pantheonDir, 'checkpoints'),
    join(pantheonDir, 'context'),
  ]) {
    if (!existsSync(legacyCheckpointDir)) continue
    try {
      for (const entry of readdirSync(legacyCheckpointDir)) {
        const fullPath = join(legacyCheckpointDir, entry)
        if (!entry.endsWith('.json') || !statSync(fullPath).isFile()) continue
        const rawKey = entry.slice(0, -5)
        const safeKey = toSafeSegment(rawKey, '')
        if (!safeKey) continue
        const targetDir = join(canonicalPersistenceDir, 'checkpoints')
        const targetFile = join(targetDir, `${safeKey}.json`)
        if (!existsSync(targetFile)) {
          try {
            const parsed = JSON.parse(readFileSync(fullPath, 'utf8'))
            const normalized = {
              session_id: safeKey,
              namespace: 'checkpoints',
              content:
                typeof parsed.content === 'string'
                  ? parsed.content
                  : JSON.stringify(parsed.content ?? parsed),
              updated_at: typeof parsed.updated_at === 'string' ? parsed.updated_at : nowIso,
            }
            if (!dryRun) {
              mkdirSync(targetDir, { recursive: true })
              writeFileSync(targetFile, JSON.stringify(normalized, null, 2), 'utf8')
            }
            contextsMigrated += 1
          } catch {
            /* corrupted checkpoint file */
          }
        }
        if (!dryRun) rmSync(fullPath, { force: true })
        staleFilesDeleted.push(fullPath)
      }
      removeEmptyDirIfPossible(legacyCheckpointDir, staleFilesDeleted, dryRun)
    } catch {
      /* ignore */
    }
  }

  // Migrate .pantheon/persistence/goals/*.json -> .pantheon/goals/*.json
  const legacyPersistenceGoalsDir = join(canonicalPersistenceDir, 'goals')
  if (existsSync(legacyPersistenceGoalsDir)) {
    try {
      for (const entry of readdirSync(legacyPersistenceGoalsDir)) {
        const fullPath = join(legacyPersistenceGoalsDir, entry)
        if (!entry.endsWith('.json') || !statSync(fullPath).isFile()) continue
        const safeId = toSafeSegment(entry.slice(0, -5), '')
        if (safeId) {
          const targetFile = join(canonicalGoalsDir, `${safeId}.json`)
          if (!existsSync(targetFile)) {
            if (!dryRun) {
              mkdirSync(canonicalGoalsDir, { recursive: true })
              writeFileSync(targetFile, readFileSync(fullPath, 'utf8'), 'utf8')
            }
            goalsMigrated += 1
          }
        }
        if (!dryRun) rmSync(fullPath, { force: true })
        staleFilesDeleted.push(fullPath)
      }
      removeEmptyDirIfPossible(legacyPersistenceGoalsDir, staleFilesDeleted, dryRun)
    } catch {
      /* ignore */
    }
  }

  // Migrate legacy .pantheon/goals.json file -> .pantheon/goals/<id>.json
  const legacyGoalsJsonPath = join(pantheonDir, 'goals.json')
  if (existsSync(legacyGoalsJsonPath)) {
    try {
      const parsed = JSON.parse(readFileSync(legacyGoalsJsonPath, 'utf8'))
      const list = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray(parsed.goals)
          ? (parsed.goals ?? [])
          : []
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const safeId = toSafeSegment(item.id ?? item.goal_id, '')
        if (!safeId) continue
        const targetFile = join(canonicalGoalsDir, `${safeId}.json`)
        if (!existsSync(targetFile)) {
          if (!dryRun) {
            mkdirSync(canonicalGoalsDir, { recursive: true })
            writeFileSync(
              targetFile,
              JSON.stringify(
                {
                  id: safeId,
                  title: String(item.title ?? item.description ?? ''),
                  criteria: Array.isArray(item.criteria) ? item.criteria.map(String) : [],
                  status: String(item.status ?? 'active'),
                  created_at: typeof item.created_at === 'string' ? item.created_at : nowIso,
                  updated_at: typeof item.updated_at === 'string' ? item.updated_at : nowIso,
                },
                null,
                2,
              ),
              'utf8',
            )
          }
          goalsMigrated += 1
        }
      }
    } catch {
      /* ignore corrupted goals.json */
    }
    if (!dryRun) rmSync(legacyGoalsJsonPath, { force: true })
    staleFilesDeleted.push(legacyGoalsJsonPath)
  }

  // ── 4. Purge expired persistence JSON files & stale artifacts ────────────
  if (existsSync(canonicalPersistenceDir)) {
    try {
      for (const nsEntry of readdirSync(canonicalPersistenceDir, { withFileTypes: true })) {
        if (!nsEntry.isDirectory()) continue
        const nsDir = join(canonicalPersistenceDir, nsEntry.name)
        for (const fileEntry of readdirSync(nsDir)) {
          if (!fileEntry.endsWith('.json')) continue
          const filePath = join(nsDir, fileEntry)
          try {
            const data = JSON.parse(readFileSync(filePath, 'utf8'))
            if (typeof data.expires_at === 'string' && data.expires_at <= nowIso) {
              if (!dryRun) rmSync(filePath, { force: true })
              staleFilesDeleted.push(filePath)
            }
          } catch {
            /* ignore */
          }
        }
      }
    } catch {
      /* ignore */
    }
  }

  const obsoleteTargets = [
    join(canonicalMemoryDir, '.memory.db.init.lock'),
    join(pantheonDir, '.memory.db.init.lock'),
    join(canonicalPersistenceDir, '.global.db.init.lock'),
    join(canonicalPersistenceDir, '.project.db.init.lock'),
    join(pantheonDir, 'fastembed_cache'),
    join(pantheonDir, '.fastembed'),
    join(root, 'fastembed_cache'),
    join(root, 'plugins', 'pantheon-hooks.ts'),
    join(root, 'plugins', 'pantheon-hooks.js'),
    join(root, '.opencode', 'plugins', 'pantheon-hooks.ts'),
    join(root, '.opencode', 'plugins', 'pantheon-hooks.js'),
    join(root, 'tiers.json'),
    join(root, '.opencode', 'tiers.json'),
  ]
  for (const target of obsoleteTargets) {
    if (existsSync(target)) {
      if (!dryRun) rmSync(target, { recursive: true, force: true })
      staleFilesDeleted.push(target)
    }
  }

  // Purge stale opencode.json.bak* sidecars older than 30 days in config roots
  const backupCutoffMs = Date.now() - 30 * 86_400_000
  for (const cfgDir of [root, join(root, '.opencode')]) {
    if (!existsSync(cfgDir)) continue
    try {
      for (const name of readdirSync(cfgDir)) {
        if (!name.startsWith('opencode.json.bak')) continue
        const full = join(cfgDir, name)
        try {
          const st = statSync(full)
          if (st.mtimeMs < backupCutoffMs) {
            if (!dryRun) rmSync(full, { recursive: true, force: true })
            staleFilesDeleted.push(full)
          }
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  }

  // Purge abandoned migration checkpoints older than 24 hours
  const migrationCp = join(pantheonDir, '.migration-checkpoint')
  if (existsSync(migrationCp)) {
    try {
      const st = statSync(migrationCp)
      if (st.mtimeMs < Date.now() - 86_400_000) {
        if (!dryRun) rmSync(migrationCp, { force: true })
        staleFilesDeleted.push(migrationCp)
      }
    } catch {
      /* ignore */
    }
  }

  return {
    memoriesMigrated,
    memoriesExpiredPurged,
    vectorTablesDropped,
    contextsMigrated,
    goalsMigrated,
    staleFilesDeleted,
  }
}

const CANONICAL_AGENT_MD_FILES = Object.freeze([
  'aphrodite.md',
  'apollo.md',
  'artemis.md',
  'athena.md',
  'demeter.md',
  'gaia.md',
  'hephaestus.md',
  'hermes.md',
  'iris.md',
  'mnemosyne.md',
  'nyx.md',
  'prometheus.md',
  'talos.md',
  'themis.md',
  'zeus.md',
])

const CANONICAL_COMMAND_MD_FILES = Object.freeze([
  'pantheon.md',
  'pantheon-audit.md',
  'pantheon-deepwork.md',
  'pantheon-focus.md',
  'pantheon-model.md',
  'pantheon-optimize.md',
  'pantheon-settings.md',
  'pantheon-vision.md',
])

const CANONICAL_SKILL_IDS = Object.freeze([
  'agent-coordination',
  'agent-forge',
  'artifact-management',
  'auto-continue',
  'clonedeps',
  'code-review-checklist',
  'codemap',
  'context-compression',
  'fast-path-execution',
  'git-workflow-and-versioning',
  'incremental-implementation',
  'instruction-forge',
  'loop-engineering',
  'memory-bank',
  'prompt-refinery',
  'reflect',
  'security-hardening',
  'session-goal',
  'simplify',
  'spec-driven-development',
  'tdd-with-agents',
  'test-slicing',
  'verification-planning',
  'visual-review-pipeline',
  'worktrees',
])

const LEGACY_INSTRUCTION_FILES = Object.freeze([
  'zeus-execution-rules.instructions.md',
  'zeus-orchestration.instructions.md',
  'zeus-workflow.instructions.md',
])

function measurePathBytes(targetPath, depth = 0) {
  if (depth > 8) return 0
  try {
    const st = statSync(targetPath)
    if (st.isFile()) return st.size
    if (!st.isDirectory()) return 0
    let total = 0
    for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
      total += measurePathBytes(join(targetPath, entry.name), depth + 1)
    }
    return total
  } catch {
    return 0
  }
}

function isConfinedWithin(rootDir, targetPath) {
  try {
    const realRoot = realpathSync(rootDir)
    const parentReal = realpathSync(dirname(targetPath))
    return parentReal === realRoot || parentReal.startsWith(`${realRoot}/`)
  } catch {
    return false
  }
}

function collectScopeArtifacts(scope, baseRoot, configRoot, options = {}) {
  const items = []
  const seen = new Set()
  const addItem = (filePath, category, reason) => {
    const resolved = resolve(filePath)
    if (seen.has(resolved) || !existsSync(resolved)) return
    seen.add(resolved)
    items.push({
      path: resolved,
      scope,
      category,
      reason,
      bytes: measurePathBytes(resolved),
    })
  }

  // 1. Dead V1 hooks & backup sidecars (most specific categories first)
  for (const hookName of ['pantheon-hooks.ts', 'pantheon-hooks.js', 'pantheon-hooks.mjs']) {
    addItem(join(configRoot, 'plugins', hookName), 'hooks', 'Obsolete OpenCode V1 hook plugin')
  }
  addItem(join(configRoot, 'tiers.json'), 'v1Obsolete', 'Obsolete V1 model tiers registry')
  addItem(join(baseRoot, 'tiers.json'), 'v1Obsolete', 'Obsolete V1 model tiers registry')

  for (const bakDir of [configRoot, join(baseRoot, '.pantheon')]) {
    if (!existsSync(bakDir)) continue
    try {
      for (const name of readdirSync(bakDir)) {
        if (name.startsWith('opencode.json.bak') || name.startsWith('active-preset.json.bak')) {
          addItem(join(bakDir, name), 'backup', 'Old configuration backup sidecar')
        }
      }
    } catch {
      /* ignore */
    }
  }

  // 2. Dry-run migration findings (unmigrated DBs, expired persistence, stale caches/locks)
  const dryMigration = migrateLegacyStoresAndPurgeStale(baseRoot, { dryRun: true })
  for (const stale of dryMigration.staleFilesDeleted) {
    addItem(stale, 'legacyStore', 'Obsolete or migrated legacy store artifact')
  }

  // 3. Redundant copied Pantheon assets that native plugin transforms provide in-memory
  if (options.includeRedundantCopiedAssets !== false) {
    for (const agentFile of CANONICAL_AGENT_MD_FILES) {
      addItem(
        join(configRoot, 'agents', agentFile),
        'redundantAsset',
        'Canonical Pantheon agent copy shadowed by native plugin transform',
      )
      addItem(
        join(configRoot, 'agent', agentFile),
        'redundantAsset',
        'Legacy singular agent directory copy shadowed by native plugin transform',
      )
      addItem(
        join(configRoot, 'prompts', agentFile),
        'redundantAsset',
        'Legacy prompt template copy provided in package',
      )
    }

    for (const cmdFile of CANONICAL_COMMAND_MD_FILES) {
      addItem(
        join(configRoot, 'commands', cmdFile),
        'redundantAsset',
        'Canonical Pantheon command copy shadowed by native plugin transform',
      )
      addItem(
        join(configRoot, 'command', cmdFile),
        'redundantAsset',
        'Legacy singular command directory copy',
      )
    }

    for (const instr of LEGACY_INSTRUCTION_FILES) {
      addItem(
        join(configRoot, 'instructions', instr),
        'redundantAsset',
        'Legacy instruction file superseded by AGENTS.global.md reference transform',
      )
    }

    for (const skillId of CANONICAL_SKILL_IDS) {
      addItem(
        join(configRoot, 'skills', skillId),
        'redundantAsset',
        'Bundled Pantheon skill directory provided natively by plugin',
      )
    }

    const tuiCopyDir = join(configRoot, 'plugins', 'pantheon-tui')
    if (existsSync(tuiCopyDir)) {
      let copiedVersion = ''
      try {
        copiedVersion = String(
          JSON.parse(readFileSync(join(tuiCopyDir, 'package.json'), 'utf8')).version ?? '',
        )
      } catch {
        copiedVersion = ''
      }
      const runningVersion = options.runningVersion ? String(options.runningVersion) : ''
      const drifted = Boolean(runningVersion && copiedVersion && copiedVersion !== runningVersion)
      addItem(
        tuiCopyDir,
        drifted ? 'drift' : 'redundantAsset',
        drifted
          ? `Copied TUI plugin v${copiedVersion} drifts from v${runningVersion}`
          : 'Copied TUI directory superseded by npm package export',
      )
    }
  }

  return { items, dryMigration }
}

export function scanLegacyArtifacts(options = {}) {
  const workspaceDir = options.workspaceDir ? resolve(options.workspaceDir) : undefined
  const globalConfigDir = options.globalConfigDir
    ? resolve(options.globalConfigDir)
    : resolveSafeGlobalConfigDir()

  const items = []
  let unmigratedStores = 0

  if (globalConfigDir && existsSync(globalConfigDir) && globalConfigDir !== '/') {
    const res = collectScopeArtifacts('global', globalConfigDir, globalConfigDir, options)
    items.push(...res.items)
    unmigratedStores +=
      res.dryMigration.memoriesMigrated +
      res.dryMigration.contextsMigrated +
      res.dryMigration.goalsMigrated +
      res.dryMigration.vectorTablesDropped
  }

  if (
    workspaceDir &&
    existsSync(workspaceDir) &&
    workspaceDir !== '/' &&
    (!globalConfigDir || !sameFileOrPath(workspaceDir, globalConfigDir))
  ) {
    const res = collectScopeArtifacts(
      'project',
      workspaceDir,
      join(workspaceDir, '.opencode'),
      options,
    )
    items.push(...res.items)
    unmigratedStores +=
      res.dryMigration.memoriesMigrated +
      res.dryMigration.contextsMigrated +
      res.dryMigration.goalsMigrated +
      res.dryMigration.vectorTablesDropped
  }

  const byScope = { global: 0, project: 0 }
  const byCategory = {}
  let totalBytes = 0
  for (const item of items) {
    byScope[item.scope] = (byScope[item.scope] ?? 0) + 1
    byCategory[item.category] = (byCategory[item.category] ?? 0) + 1
    totalBytes += item.bytes
  }

  return {
    items,
    summary: {
      total: items.length,
      totalBytes,
      unmigratedStores,
      byScope,
      byCategory,
    },
  }
}

export function cleanLegacyArtifacts(options = {}) {
  const workspaceDir = options.workspaceDir ? resolve(options.workspaceDir) : undefined
  const globalConfigDir = options.globalConfigDir
    ? resolve(options.globalConfigDir)
    : resolveSafeGlobalConfigDir()

  const preScan = scanLegacyArtifacts(options)
  const categoryFilter = Array.isArray(options.categories) ? new Set(options.categories) : null
  const scopeFilter = options.scope && options.scope !== 'all' ? options.scope : null
  const bytesByPath = new Map(preScan.items.map((item) => [item.path, item.bytes]))

  // Always run data migration BEFORE removing any legacy/obsolete files.
  let migrated = null
  if (
    scopeFilter !== 'global' &&
    workspaceDir &&
    existsSync(workspaceDir) &&
    workspaceDir !== '/'
  ) {
    migrated = migrateLegacyStoresAndPurgeStale(
      workspaceDir,
      scopeFilter !== 'project' && globalConfigDir ? { globalConfigDir } : {},
    )
  } else if (
    scopeFilter !== 'project' &&
    globalConfigDir &&
    existsSync(globalConfigDir) &&
    globalConfigDir !== '/'
  ) {
    migrated = migrateLegacyStoresAndPurgeStale(globalConfigDir)
  }

  const removedSet = new Set()
  const errors = []
  let reclaimedBytes = 0

  for (const purgedPath of migrated?.staleFilesDeleted ?? []) {
    const resolved = resolve(purgedPath)
    if (!existsSync(resolved) && !removedSet.has(resolved)) {
      removedSet.add(resolved)
      reclaimedBytes += bytesByPath.get(resolved) ?? 0
    }
  }

  for (const item of preScan.items) {
    if (categoryFilter && !categoryFilter.has(item.category)) continue
    if (scopeFilter && item.scope !== scopeFilter) continue
    const scopeRoot = item.scope === 'global' ? globalConfigDir : workspaceDir
    if (!scopeRoot || !isConfinedWithin(scopeRoot, item.path)) {
      errors.push({ path: item.path, reason: 'Path escapes target scope root' })
      continue
    }
    try {
      if (existsSync(item.path)) {
        rmSync(item.path, { recursive: true, force: true })
        if (!removedSet.has(item.path)) {
          removedSet.add(item.path)
          reclaimedBytes += item.bytes
        }
      }
    } catch (err) {
      errors.push({
        path: item.path,
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    removed: [...removedSet],
    reclaimedBytes,
    errors,
    migrated,
  }
}
