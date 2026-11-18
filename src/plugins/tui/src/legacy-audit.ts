/**
 * legacy-audit.ts — Self-contained Legacy & Drift Auditor for the TUI Settings panel.
 *
 * Scans global (~/.config/opencode) and workspace (<project>) scopes for:
 *   - Dead V1 hooks/files (pantheon-hooks.*, tiers.json, fastembed_cache, .migration-checkpoint)
 *   - Unmigrated legacy stores (memory.db, persistence/{global,project}.db, goals.json)
 *   - Redundant copied canonical Pantheon assets shadowed by native plugin transforms
 *   - Drifted copied TUI plugins (plugins/pantheon-tui version != running plugin version)
 *   - Old configuration backup sidecars (opencode.json.bak*, active-preset.json.bak*)
 *
 * Always migrates unmigrated legacy context/memory/goals BEFORE deleting obsolete stores,
 * and NEVER touches user-created custom agents or custom user skills.
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

export type LegacyScope = 'global' | 'project'
export type LegacyCategory =
  | 'legacyStore'
  | 'hooks'
  | 'v1Obsolete'
  | 'backup'
  | 'redundantAsset'
  | 'drift'

export interface LegacyAuditItem {
  readonly path: string
  readonly scope: LegacyScope
  readonly category: LegacyCategory
  readonly reason: string
  readonly bytes: number
}

export interface LegacyAuditSummary {
  readonly total: number
  readonly totalBytes: number
  readonly unmigratedStores: number
  readonly byScope: Record<LegacyScope, number>
  readonly byCategory: Record<string, number>
}

export interface LegacyAuditScan {
  readonly items: LegacyAuditItem[]
  readonly summary: LegacyAuditSummary
}

export interface LegacyCleanResult {
  readonly removed: string[]
  readonly reclaimedBytes: number
  readonly migratedRecords: number
  readonly errors: Array<{ readonly path: string; readonly reason: string }>
}

export interface LegacyAuditOptions {
  readonly workspaceDir?: string
  readonly globalConfigDir?: string
  readonly runningVersion?: string
  readonly includeRedundantCopiedAssets?: boolean
  readonly env?: Record<string, string | undefined>
}

const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._:-]{1,128}$/

const CANONICAL_AGENT_MD_FILES: readonly string[] = Object.freeze([
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

const CANONICAL_COMMAND_MD_FILES: readonly string[] = Object.freeze([
  'pantheon.md',
  'pantheon-audit.md',
  'pantheon-deepwork.md',
  'pantheon-focus.md',
  'pantheon-model.md',
  'pantheon-optimize.md',
  'pantheon-settings.md',
  'pantheon-vision.md',
])

const CANONICAL_SKILL_IDS: readonly string[] = Object.freeze([
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

const LEGACY_INSTRUCTION_FILES: readonly string[] = Object.freeze([
  'zeus-execution-rules.instructions.md',
  'zeus-orchestration.instructions.md',
  'zeus-workflow.instructions.md',
])

export function resolveAuditGlobalDir(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.PANTHEON_HOME?.trim()) return resolve(env.PANTHEON_HOME.trim())
  if (env.XDG_CONFIG_HOME?.trim()) return join(resolve(env.XDG_CONFIG_HOME.trim()), 'opencode')
  if (env.NODE_TEST_CONTEXT) return undefined
  const home = env.HOME?.trim()
  return home ? join(resolve(home), '.config', 'opencode') : undefined
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function toSafeSegment(raw: unknown, fallback = 'default'): string {
  const str = String(raw ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, '_')
    .slice(0, 128)
  if (!str || str === '.' || str === '..' || !SAFE_SEGMENT_RE.test(str)) return fallback
  return str
}

function measurePathBytes(targetPath: string, depth = 0): number {
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

function samePath(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true
  if (!existsSync(a) || !existsSync(b)) return false
  try {
    return realpathSync(a) === realpathSync(b)
  } catch {
    return false
  }
}

function isConfinedWithin(rootDir: string, targetPath: string): boolean {
  try {
    const realRoot = realpathSync(rootDir)
    const parentReal = realpathSync(dirname(targetPath))
    return parentReal === realRoot || parentReal.startsWith(`${realRoot}/`)
  } catch {
    return false
  }
}

function countTableRows(db: DatabaseSync, tableName: string): number {
  try {
    const row = db
      .prepare(`SELECT count(*) AS cnt FROM "${tableName.replace(/"/g, '""')}"`)
      .get() as { cnt?: number } | undefined
    return Number(row?.cnt ?? 0)
  } catch {
    return 0
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
      .get(name) as { name?: string } | undefined
    return Boolean(row?.name)
  } catch {
    return false
  }
}

function collectScopeAudit(
  scope: LegacyScope,
  baseRoot: string,
  configRoot: string,
  options: LegacyAuditOptions,
): { items: LegacyAuditItem[]; unmigratedStores: number } {
  const items: LegacyAuditItem[] = []
  const seen = new Set<string>()
  let unmigratedStores = 0

  const addItem = (filePath: string, category: LegacyCategory, reason: string) => {
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

  // 1. Dead V1 hooks & obsolete config files
  for (const hookName of ['pantheon-hooks.ts', 'pantheon-hooks.js', 'pantheon-hooks.mjs']) {
    addItem(join(configRoot, 'plugins', hookName), 'hooks', 'Obsolete OpenCode V1 hook plugin')
  }
  addItem(join(configRoot, 'tiers.json'), 'v1Obsolete', 'Obsolete V1 model tiers registry')
  addItem(join(baseRoot, 'tiers.json'), 'v1Obsolete', 'Obsolete V1 model tiers registry')

  const pantheonDir = join(baseRoot, '.pantheon')
  addItem(join(pantheonDir, 'fastembed_cache'), 'v1Obsolete', 'Unused legacy fastembed cache')
  addItem(join(pantheonDir, '.fastembed'), 'v1Obsolete', 'Unused legacy fastembed cache')
  addItem(join(baseRoot, 'fastembed_cache'), 'v1Obsolete', 'Unused legacy fastembed cache')
  addItem(
    join(pantheonDir, '.migration-checkpoint'),
    'v1Obsolete',
    'Stale migration checkpoint file',
  )

  for (const bakDir of [configRoot, pantheonDir]) {
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

  // 2. Unmigrated legacy stores
  const legacyFlatMemDb = join(pantheonDir, 'memory.db')
  if (existsSync(legacyFlatMemDb)) {
    unmigratedStores += 1
    addItem(legacyFlatMemDb, 'legacyStore', 'Unmigrated flat .pantheon/memory.db')
  }

  const canonicalMemDb = join(pantheonDir, 'memory', 'memory.db')
  if (existsSync(canonicalMemDb)) {
    try {
      const db = new DatabaseSync(canonicalMemDb, { readOnly: true })
      const legacyVecTables = [
        'memories_vec',
        'vec_memories',
        'memory_embeddings',
        'memory_vectors',
      ]
      const hasLegacyVec = legacyVecTables.some((t) => tableExists(db, t))
      db.close()
      if (hasLegacyVec) {
        unmigratedStores += 1
        items.push({
          path: `${canonicalMemDb}#legacy-vec`,
          scope,
          category: 'legacyStore',
          reason: 'Legacy vector tables pending cleanup in memory.db',
          bytes: 0,
        })
      }
    } catch {
      /* ignore */
    }
  }

  for (const dbName of ['global.db', 'project.db']) {
    const persDbPath = join(pantheonDir, 'persistence', dbName)
    if (existsSync(persDbPath)) {
      unmigratedStores += 1
      addItem(persDbPath, 'legacyStore', `Unmigrated persistence/${dbName}`)
    }
  }

  const legacyGoalsJson = join(pantheonDir, 'goals.json')
  if (existsSync(legacyGoalsJson)) {
    unmigratedStores += 1
    addItem(legacyGoalsJson, 'legacyStore', 'Unmigrated legacy goals.json')
  }

  // 3. Redundant copied Pantheon assets shadowed by native plugin transforms
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
        'Legacy singular agent copy shadowed by native plugin transform',
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
        'Legacy instruction file superseded by AGENTS.global.md',
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

  return { items, unmigratedStores }
}

function ensureCanonicalMemoryDb(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL DEFAULT 'default',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      UNIQUE(namespace, key)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      key, value, namespace,
      content='memories',
      content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, key, value, namespace) VALUES (new.id, new.key, new.value, new.namespace);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, key, value, namespace) VALUES('delete', old.id, old.key, old.value, old.namespace);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, key, value, namespace) VALUES('delete', old.id, old.key, old.value, old.namespace);
      INSERT INTO memories_fts(rowid, key, value, namespace) VALUES (new.id, new.key, new.value, new.namespace);
    END;
  `)
  return db
}

function migrateScopeBeforeDelete(baseRoot: string): number {
  const pantheonDir = join(baseRoot, '.pantheon')
  if (!existsSync(pantheonDir)) return 0
  let migrated = 0
  const nowIso = new Date().toISOString()

  // 1. Migrate flat .pantheon/memory.db -> .pantheon/memory/memory.db + drop legacy vector tables
  const flatMemDbPath = join(pantheonDir, 'memory.db')
  const canonicalMemPath = join(pantheonDir, 'memory', 'memory.db')
  if (existsSync(flatMemDbPath)) {
    try {
      const src = new DatabaseSync(flatMemDbPath, { readOnly: true })
      const dst = ensureCanonicalMemoryDb(canonicalMemPath)
      if (tableExists(src, 'memories')) {
        const rows = src
          .prepare('SELECT namespace, key, value, created_at FROM memories')
          .all() as Array<{
          namespace?: string
          key?: string
          value?: string
          created_at?: string
        }>
        const insert = dst.prepare(
          'INSERT OR IGNORE INTO memories (namespace, key, value, importance, created_at) VALUES (?, ?, ?, ?, ?)',
        )
        for (const r of rows) {
          insert.run(
            String(r.namespace ?? 'default'),
            String(r.key ?? ''),
            String(r.value ?? ''),
            0.5,
            String(r.created_at ?? nowIso),
          )
          migrated += 1
        }
      }
      src.close()
      dst.close()
    } catch {
      /* fail-open */
    }
  }

  if (existsSync(canonicalMemPath)) {
    try {
      const db = ensureCanonicalMemoryDb(canonicalMemPath)
      for (const trig of ['memories_vec_ai', 'memories_vec_ad', 'memories_vec_au']) {
        db.exec(`DROP TRIGGER IF EXISTS ${trig}`)
      }
      for (const tbl of ['memories_vec', 'vec_memories', 'memory_embeddings', 'memory_vectors']) {
        if (tableExists(db, tbl)) {
          db.exec(`DROP TABLE IF EXISTS ${tbl}`)
          migrated += 1
        }
      }
      db.close()
    } catch {
      /* fail-open */
    }
  }

  // 2. Migrate persistence/{global,project}.db -> persistence/<ns>/<key>.json
  const persDir = join(pantheonDir, 'persistence')
  for (const dbName of ['global.db', 'project.db']) {
    const dbPath = join(persDir, dbName)
    if (!existsSync(dbPath)) continue
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true })
      for (const tbl of ['kv', 'kv_store', 'context', 'checkpoints', 'sessions']) {
        if (!tableExists(db, tbl) || countTableRows(db, tbl) === 0) continue
        const cols = db.prepare(`PRAGMA table_info(${tbl})`).all() as Array<{ name: string }>
        const colNames = new Set(cols.map((c) => c.name))
        const keyCol = colNames.has('key')
          ? 'key'
          : colNames.has('id')
            ? 'id'
            : colNames.has('session_id')
              ? 'session_id'
              : null
        const valCol = colNames.has('value')
          ? 'value'
          : colNames.has('data')
            ? 'data'
            : colNames.has('content')
              ? 'content'
              : null
        if (!keyCol || !valCol) continue
        const nsSelect = colNames.has('namespace')
          ? 'namespace'
          : `'${tbl === 'checkpoints' || tbl === 'sessions' ? 'checkpoints' : 'default'}' AS namespace`
        const rows = db
          .prepare(`SELECT ${nsSelect}, ${keyCol} AS k, ${valCol} AS v FROM ${tbl}`)
          .all() as Array<{
          namespace?: string
          k?: string
          v?: unknown
        }>
        for (const r of rows) {
          const ns = toSafeSegment(r.namespace, 'default')
          const key = toSafeSegment(r.k, '')
          if (!key) continue
          const targetDir = join(persDir, ns)
          const targetFile = join(targetDir, `${key}.json`)
          if (!existsSync(targetFile)) {
            mkdirSync(targetDir, { recursive: true })
            writeFileSync(
              targetFile,
              JSON.stringify(
                { key, namespace: ns, value: String(r.v ?? ''), updated_at: nowIso },
                null,
                2,
              ),
              'utf8',
            )
            migrated += 1
          }
        }
      }
      db.close()
    } catch {
      /* fail-open */
    }
  }

  // 3. Migrate legacy goals.json -> .pantheon/goals/<id>.json
  const legacyGoalsPath = join(pantheonDir, 'goals.json')
  if (existsSync(legacyGoalsPath)) {
    try {
      const parsed = JSON.parse(readFileSync(legacyGoalsPath, 'utf8')) as unknown
      const list = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === 'object' &&
            Array.isArray((parsed as { goals?: unknown }).goals)
          ? ((parsed as { goals: unknown[] }).goals ?? [])
          : []
      const goalsDir = join(pantheonDir, 'goals')
      for (const item of list) {
        if (!item || typeof item !== 'object') continue
        const rec = item as Record<string, unknown>
        const safeId = toSafeSegment(rec.id ?? rec.goal_id, '')
        if (!safeId) continue
        const target = join(goalsDir, `${safeId}.json`)
        if (!existsSync(target)) {
          mkdirSync(goalsDir, { recursive: true })
          writeFileSync(
            target,
            JSON.stringify(
              {
                id: safeId,
                title: String(rec.title ?? rec.description ?? ''),
                criteria: Array.isArray(rec.criteria) ? rec.criteria.map(String) : [],
                status: String(rec.status ?? 'active'),
                created_at: typeof rec.created_at === 'string' ? rec.created_at : nowIso,
                updated_at: typeof rec.updated_at === 'string' ? rec.updated_at : nowIso,
              },
              null,
              2,
            ),
            'utf8',
          )
          migrated += 1
        }
      }
    } catch {
      /* fail-open */
    }
  }

  return migrated
}

export function scanLegacyArtifacts(options: LegacyAuditOptions = {}): LegacyAuditScan {
  const workspaceDir = options.workspaceDir ? resolve(options.workspaceDir) : undefined
  const globalConfigDir = options.globalConfigDir
    ? resolve(options.globalConfigDir)
    : resolveAuditGlobalDir(options.env)

  const items: LegacyAuditItem[] = []
  let unmigratedStores = 0

  if (globalConfigDir && existsSync(globalConfigDir) && globalConfigDir !== '/') {
    const res = collectScopeAudit('global', globalConfigDir, globalConfigDir, options)
    items.push(...res.items)
    unmigratedStores += res.unmigratedStores
  }

  if (
    workspaceDir &&
    existsSync(workspaceDir) &&
    workspaceDir !== '/' &&
    (!globalConfigDir || !samePath(workspaceDir, globalConfigDir))
  ) {
    const res = collectScopeAudit('project', workspaceDir, join(workspaceDir, '.opencode'), options)
    items.push(...res.items)
    unmigratedStores += res.unmigratedStores
  }

  const byScope: Record<LegacyScope, number> = { global: 0, project: 0 }
  const byCategory: Record<string, number> = {}
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

export function cleanLegacyArtifacts(
  options: LegacyAuditOptions & { readonly scope?: 'all' | LegacyScope } = {},
): LegacyCleanResult {
  const workspaceDir = options.workspaceDir ? resolve(options.workspaceDir) : undefined
  const globalConfigDir = options.globalConfigDir
    ? resolve(options.globalConfigDir)
    : resolveAuditGlobalDir(options.env)
  const scopeFilter = options.scope && options.scope !== 'all' ? options.scope : null

  const scan = scanLegacyArtifacts(options)
  let migratedRecords = 0

  if (
    scopeFilter !== 'project' &&
    globalConfigDir &&
    existsSync(globalConfigDir) &&
    globalConfigDir !== '/'
  ) {
    migratedRecords += migrateScopeBeforeDelete(globalConfigDir)
  }
  if (
    scopeFilter !== 'global' &&
    workspaceDir &&
    existsSync(workspaceDir) &&
    workspaceDir !== '/' &&
    (!globalConfigDir || !samePath(workspaceDir, globalConfigDir))
  ) {
    migratedRecords += migrateScopeBeforeDelete(workspaceDir)
  }

  const removed: string[] = []
  const errors: Array<{ readonly path: string; readonly reason: string }> = []
  let reclaimedBytes = 0

  for (const item of scan.items) {
    if (scopeFilter && item.scope !== scopeFilter) continue
    if (item.path.endsWith('#legacy-vec')) {
      removed.push(item.path)
      continue
    }
    const scopeRoot = item.scope === 'global' ? globalConfigDir : workspaceDir
    if (!scopeRoot || !isConfinedWithin(scopeRoot, item.path)) {
      errors.push({ path: item.path, reason: 'Path escapes target scope root' })
      continue
    }
    try {
      if (existsSync(item.path)) {
        rmSync(item.path, { recursive: true, force: true })
        removed.push(item.path)
        reclaimedBytes += item.bytes
      }
      if (item.path.endsWith('.db')) {
        for (const suffix of ['-wal', '-shm', '-journal']) {
          const sidecar = `${item.path}${suffix}`
          if (existsSync(sidecar) && isConfinedWithin(scopeRoot, sidecar)) {
            const sidecarBytes = measurePathBytes(sidecar)
            rmSync(sidecar, { force: true })
            removed.push(sidecar)
            reclaimedBytes += sidecarBytes
          }
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
    removed,
    reclaimedBytes,
    migratedRecords,
    errors,
  }
}
