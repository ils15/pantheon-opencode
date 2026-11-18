/**
 * Native In-Process Memory & Persistence Tools for Pantheon OpenCode Plugin.
 *
 * Replaces external stdio MCP servers (`pantheon-memory`, `pantheon-persistence`)
 * with zero-overhead, in-process TypeScript tools backed by `node:sqlite` (with
 * FTS5 BM25 lexical search and TTL expiration) and confined JSON checkpoints/goals.
 *
 * @module pantheon/native-memory-tools
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ensureLegacyStoresMigratedOnce,
  resolveSafeGlobalConfigDir,
} from './legacy-store-migration.mjs'
import { resolveToolCwd } from './tool-context.ts'
import type { V2ToolDef, V2ToolResult } from './tools.ts'

const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._:-]{1,128}$/
const MAX_MEMORY_VALUE_BYTES = 65_536

function isSafeSegment(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    SAFE_SEGMENT_RE.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !value.includes('..') &&
    !value.includes('/') &&
    !value.includes('\\')
  )
}

function resolveConfinedPath(baseDir: string, ...segments: string[]): string {
  mkdirSync(baseDir, { recursive: true })
  const canonicalBase = realpathSync(baseDir)
  const candidate = resolve(canonicalBase, ...segments)
  const prefix = canonicalBase.endsWith(sep) ? canonicalBase : `${canonicalBase}${sep}`
  if (candidate !== canonicalBase && !candidate.startsWith(prefix)) {
    throw new Error('Path traversal denied: target escapes confined directory')
  }
  return candidate
}

const dbCache = new Map<string, DatabaseSync>()

function runAutoMigration(workspaceDir: string): void {
  try {
    const globalConfigDir = resolveSafeGlobalConfigDir()
    ensureLegacyStoresMigratedOnce(workspaceDir, globalConfigDir ? { globalConfigDir } : {})
  } catch {
    /* fail-open */
  }
}

function getMemoryDb(workspaceDir: string): DatabaseSync {
  runAutoMigration(workspaceDir)
  const memoryDir = join(workspaceDir, '.pantheon', 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const dbPath = resolveConfinedPath(memoryDir, 'memory.db')
  const cached = dbCache.get(dbPath)
  if (cached) return cached

  const db = new DatabaseSync(dbPath)
  db.exec(`
    PRAGMA busy_timeout = 3000;
    PRAGMA journal_mode = WAL;
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
  try {
    db.exec(`
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
    `)
  } catch {
    /* FTS5 optional fallback */
  }
  dbCache.set(dbPath, db)
  return db
}

function jsonResult(payload: unknown): V2ToolResult {
  return { output: JSON.stringify(payload) }
}

const NOT_EXPIRED_SQL = '(expires_at IS NULL OR expires_at > ?)'

export function createNativeMemoryAndPersistenceTools(fallbackDir?: string): V2ToolDef[] {
  return [
    {
      name: 'memory_store',
      description:
        'Store a durable memory entry in .pantheon/memory/memory.db with FTS5 indexing and optional TTL.',
      input: {
        type: 'object',
        additionalProperties: false,
        required: ['namespace', 'key', 'value'],
        properties: {
          namespace: { type: 'string', description: 'Project or domain namespace' },
          key: { type: 'string', description: 'Unique key within the namespace' },
          value: { type: 'string', description: 'Durable fact, ADR, or convention text (<=64KiB)' },
          metadata: { type: 'string', description: 'Optional JSON metadata string' },
          expires_at: { type: 'string', description: 'Optional ISO-8601 expiration timestamp' },
        },
      },
      output: {},
      execute: async (input, context) => {
        try {
          const ns = input.namespace
          const key = input.key
          const value = input.value
          if (typeof ns !== 'string' || !ns.trim() || typeof key !== 'string' || !key.trim()) {
            return jsonResult({
              ok: false,
              error: 'namespace and key are required non-empty strings',
            })
          }
          if (typeof value !== 'string' || !value.trim()) {
            return jsonResult({
              ok: false,
              error: 'value is required and must be a non-empty string',
            })
          }
          if (Buffer.byteLength(value, 'utf8') > MAX_MEMORY_VALUE_BYTES) {
            return jsonResult({ ok: false, error: 'value exceeds maximum size of 64 KiB' })
          }
          const cwd = resolveToolCwd(context, fallbackDir)
          const db = getMemoryDb(cwd)
          const nowIso = new Date().toISOString()
          db.prepare(
            `INSERT INTO memories (namespace, key, value, metadata, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(namespace, key) DO UPDATE SET
               value = excluded.value,
               metadata = excluded.metadata,
               created_at = excluded.created_at,
               expires_at = excluded.expires_at`,
          ).run(
            ns.trim(),
            key.trim(),
            value,
            typeof input.metadata === 'string' ? input.metadata : null,
            nowIso,
            typeof input.expires_at === 'string' ? input.expires_at : null,
          )
          return jsonResult({ ok: true, status: 'stored', namespace: ns.trim(), key: key.trim() })
        } catch (err) {
          return jsonResult({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    },
    {
      name: 'memory_recall',
      description: 'Recall a specific memory entry by exact namespace and key.',
      input: {
        type: 'object',
        additionalProperties: false,
        required: ['namespace', 'key'],
        properties: {
          namespace: { type: 'string', description: 'Memory namespace' },
          key: { type: 'string', description: 'Memory key' },
        },
      },
      output: {},
      execute: async (input, context) => {
        try {
          const ns = input.namespace
          const key = input.key
          if (typeof ns !== 'string' || !ns.trim() || typeof key !== 'string' || !key.trim()) {
            return jsonResult({ ok: false, error: 'namespace and key are required' })
          }
          const cwd = resolveToolCwd(context, fallbackDir)
          const db = getMemoryDb(cwd)
          const nowIso = new Date().toISOString()
          const row = db
            .prepare(
              `SELECT namespace, key, value, metadata, created_at, expires_at
               FROM memories
               WHERE namespace = ? AND key = ? AND ${NOT_EXPIRED_SQL}`,
            )
            .get(ns.trim(), key.trim(), nowIso)
          return jsonResult(row ?? { ok: false, error: 'not_found' })
        } catch (err) {
          return jsonResult({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    },
    {
      name: 'memory_search',
      description: 'Search durable memories using SQLite FTS5 BM25 ranking with lexical fallback.',
      input: {
        type: 'object',
        additionalProperties: false,
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search query terms' },
          namespace: { type: 'string', description: 'Optional namespace filter' },
          top_k: { type: 'number', description: 'Maximum results to return (default 10)' },
        },
      },
      output: {},
      execute: async (input, context) => {
        try {
          const rawQuery = typeof input.query === 'string' ? input.query.trim() : ''
          if (!rawQuery) {
            return jsonResult({ ok: false, error: 'query is required', count: 0, results: [] })
          }
          const limit =
            typeof input.top_k === 'number' && Number.isFinite(input.top_k) && input.top_k > 0
              ? Math.min(Math.floor(input.top_k), 100)
              : 10
          const ns =
            typeof input.namespace === 'string' && input.namespace.trim()
              ? input.namespace.trim()
              : undefined
          const cwd = resolveToolCwd(context, fallbackDir)
          const db = getMemoryDb(cwd)
          const nowIso = new Date().toISOString()

          const tokens = rawQuery
            .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
            .trim()
            .split(/\s+/)
            .filter((t) => t.length >= 2)

          if (tokens.length > 0) {
            try {
              const ftsExpr = tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' OR ')
              let ftsSql = `
                SELECT m.namespace, m.key, m.value, m.metadata, m.created_at, bm25(memories_fts) AS score
                FROM memories_fts
                JOIN memories m ON m.id = memories_fts.rowid
                WHERE memories_fts MATCH ? AND (m.expires_at IS NULL OR m.expires_at > ?)
              `
              const ftsParams: Array<string | number> = [ftsExpr, nowIso]
              if (ns) {
                ftsSql += ' AND m.namespace = ?'
                ftsParams.push(ns)
              }
              ftsSql += ' ORDER BY score LIMIT ?'
              ftsParams.push(limit)
              const rows = db.prepare(ftsSql).all(...ftsParams)
              if (rows.length > 0) {
                return jsonResult({ ok: true, count: rows.length, results: rows })
              }
            } catch {
              /* fallback to LIKE */
            }
          }

          const escaped = rawQuery.replace(/[\\%_]/g, '\\$&')
          let sql = `
            SELECT namespace, key, value, metadata, created_at
            FROM memories
            WHERE (value LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\')
              AND ${NOT_EXPIRED_SQL}
          `
          const params: Array<string | number> = [`%${escaped}%`, `%${escaped}%`, nowIso]
          if (ns) {
            sql += ' AND namespace = ?'
            params.push(ns)
          }
          sql += ' ORDER BY id DESC LIMIT ?'
          params.push(limit)
          const rows = db.prepare(sql).all(...params)
          return jsonResult({ ok: true, count: rows.length, results: rows })
        } catch (err) {
          return jsonResult({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    },
    {
      name: 'memory_forget',
      description: 'Delete a durable memory entry by namespace and key.',
      input: {
        type: 'object',
        additionalProperties: false,
        required: ['namespace', 'key'],
        properties: {
          namespace: { type: 'string', description: 'Memory namespace' },
          key: { type: 'string', description: 'Memory key to delete' },
        },
      },
      output: {},
      execute: async (input, context) => {
        try {
          const ns = input.namespace
          const key = input.key
          if (typeof ns !== 'string' || !ns.trim() || typeof key !== 'string' || !key.trim()) {
            return jsonResult({ ok: false, error: 'namespace and key are required' })
          }
          const cwd = resolveToolCwd(context, fallbackDir)
          const db = getMemoryDb(cwd)
          const info = db
            .prepare('DELETE FROM memories WHERE namespace = ? AND key = ?')
            .run(ns.trim(), key.trim())
          return jsonResult({
            ok: true,
            deleted: info.changes > 0,
            namespace: ns.trim(),
            key: key.trim(),
          })
        } catch (err) {
          return jsonResult({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    },
    {
      name: 'memory_list',
      description: 'List active memory keys in a namespace.',
      input: {
        type: 'object',
        additionalProperties: false,
        properties: {
          namespace: { type: 'string', description: 'Optional namespace filter' },
          limit: { type: 'number', description: 'Maximum entries to list (default 50)' },
        },
      },
      output: {},
      execute: async (input, context) => {
        try {
          const cwd = resolveToolCwd(context, fallbackDir)
          const db = getMemoryDb(cwd)
          const nowIso = new Date().toISOString()
          const limit =
            typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0
              ? Math.min(Math.floor(input.limit), 200)
              : 50
          let sql = `SELECT namespace, key, created_at FROM memories WHERE ${NOT_EXPIRED_SQL}`
          const params: Array<string | number> = [nowIso]
          if (typeof input.namespace === 'string' && input.namespace.trim()) {
            sql += ' AND namespace = ?'
            params.push(input.namespace.trim())
          }
          sql += ' ORDER BY id DESC LIMIT ?'
          params.push(limit)
          const rows = db.prepare(sql).all(...params)
          return jsonResult({ ok: true, count: rows.length, entries: rows })
        } catch (err) {
          return jsonResult({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    },
    {
      name: 'memory_stats',
      description: 'Get counts of active durable memory entries by namespace.',
      input: {
        type: 'object',
        additionalProperties: false,
        properties: {
          namespace: { type: 'string', description: 'Optional namespace filter' },
        },
      },
      output: {},
      execute: async (_input, context) => {
        try {
          const cwd = resolveToolCwd(context, fallbackDir)
          const db = getMemoryDb(cwd)
          const nowIso = new Date().toISOString()
          const total = db
            .prepare(`SELECT count(*) as count FROM memories WHERE ${NOT_EXPIRED_SQL}`)
            .get(nowIso) as { count?: number } | undefined
          const byNamespace = db
            .prepare(
              `SELECT namespace, count(*) as count FROM memories WHERE ${NOT_EXPIRED_SQL} GROUP BY namespace`,
            )
            .all(nowIso)
          return jsonResult({ ok: true, total: total?.count ?? 0, byNamespace })
        } catch (err) {
          return jsonResult({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    },
    {
      name: 'context_save',
      description: 'Save a milestone session checkpoint under .pantheon/persistence.',
      input: {
        type: 'object',
        additionalProperties: false,
        required: ['session_id', 'content'],
        properties: {
          session_id: { type: 'string', description: 'Session identifier' },
          content: { type: 'string', description: 'Serialized JSON state object' },
          namespace: { type: 'string', description: 'Optional checkpoint namespace' },
        },
      },
      output: {},
      execute: async (input, context) => {
        try {
          const sessionId = input.session_id
          const ns = input.namespace ?? 'checkpoints'
          if (!isSafeSegment(sessionId) || !isSafeSegment(ns)) {
            return jsonResult({
              ok: false,
              error: 'session_id and namespace must be safe identifiers without path traversal',
            })
          }
          if (typeof input.content !== 'string' || !input.content.trim()) {
            return jsonResult({ ok: false, error: 'content must be a non-empty string' })
          }
          const cwd = resolveToolCwd(context, fallbackDir)
          runAutoMigration(cwd)
          const baseDir = join(cwd, '.pantheon', 'persistence')
          const dir = resolveConfinedPath(baseDir, ns)
          mkdirSync(dir, { recursive: true })
          const filePath = resolveConfinedPath(dir, `${sessionId}.json`)
          const nowIso = new Date().toISOString()
          writeFileSync(
            filePath,
            JSON.stringify(
              {
                session_id: sessionId,
                namespace: ns,
                content: input.content,
                updated_at: nowIso,
              },
              null,
              2,
            ),
            'utf8',
          )
          return jsonResult({
            ok: true,
            status: 'saved',
            session_id: sessionId,
            updated_at: nowIso,
          })
        } catch (err) {
          return jsonResult({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    },
    {
      name: 'context_get',
      description: 'Retrieve a saved session checkpoint by session_id.',
      input: {
        type: 'object',
        additionalProperties: false,
        required: ['session_id'],
        properties: {
          session_id: { type: 'string', description: 'Session identifier' },
          namespace: { type: 'string', description: 'Optional checkpoint namespace' },
        },
      },
      output: {},
      execute: async (input, context) => {
        try {
          const sessionId = input.session_id
          const ns = input.namespace ?? 'checkpoints'
          if (!isSafeSegment(sessionId) || !isSafeSegment(ns)) {
            return jsonResult({
              ok: false,
              error: 'session_id and namespace must be safe identifiers without path traversal',
            })
          }
          const cwd = resolveToolCwd(context, fallbackDir)
          runAutoMigration(cwd)
          const baseDir = join(cwd, '.pantheon', 'persistence')
          const dir = resolveConfinedPath(baseDir, ns)
          const filePath = resolveConfinedPath(dir, `${sessionId}.json`)
          if (!existsSync(filePath)) {
            const globalDir = resolveSafeGlobalConfigDir()
            if (globalDir) {
              const globalNsDir = join(globalDir, '.pantheon', 'persistence', ns)
              if (existsSync(join(globalNsDir, `${sessionId}.json`))) {
                const globalFile = resolveConfinedPath(globalNsDir, `${sessionId}.json`)
                if (existsSync(globalFile)) {
                  return jsonResult(JSON.parse(readFileSync(globalFile, 'utf8')))
                }
              }
            }
            return jsonResult({ ok: false, error: 'not_found', session_id: sessionId })
          }
          return jsonResult(JSON.parse(readFileSync(filePath, 'utf8')))
        } catch (err) {
          return jsonResult({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    },
    {
      name: 'goal_create',
      description:
        'Create a persistent session goal in .pantheon/goals (read by compaction hooks).',
      input: {
        type: 'object',
        additionalProperties: false,
        required: ['title'],
        properties: {
          id: { type: 'string', description: 'Optional goal identifier' },
          title: { type: 'string', description: 'Concise goal statement' },
          criteria: {
            type: 'array',
            items: { type: 'string' },
            description: 'Completion criteria checklist',
          },
        },
      },
      output: {},
      execute: async (input, context) => {
        try {
          const title = typeof input.title === 'string' ? input.title.trim() : ''
          if (!title) return jsonResult({ ok: false, error: 'title is required' })
          const rawId =
            typeof input.id === 'string' && input.id.trim() ? input.id.trim() : `goal-${Date.now()}`
          if (!isSafeSegment(rawId)) {
            return jsonResult({ ok: false, error: 'id must be a safe identifier' })
          }
          const cwd = resolveToolCwd(context, fallbackDir)
          runAutoMigration(cwd)
          const goalsDir = join(cwd, '.pantheon', 'goals')
          const filePath = resolveConfinedPath(goalsDir, `${rawId}.json`)
          const nowIso = new Date().toISOString()
          const goal = {
            id: rawId,
            title,
            criteria: Array.isArray(input.criteria) ? input.criteria.map(String) : [],
            status: 'active',
            created_at: nowIso,
            updated_at: nowIso,
          }
          writeFileSync(filePath, JSON.stringify(goal, null, 2), 'utf8')
          return jsonResult({ ok: true, goal })
        } catch (err) {
          return jsonResult({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    },
    {
      name: 'goal_get',
      description: 'Retrieve an active session goal by id or latest.',
      input: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Optional goal id (defaults to latest)' },
        },
      },
      output: {},
      execute: async (input, context) => {
        try {
          const cwd = resolveToolCwd(context, fallbackDir)
          runAutoMigration(cwd)
          const goalsDir = join(cwd, '.pantheon', 'goals')
          mkdirSync(goalsDir, { recursive: true })
          if (typeof input.id === 'string' && input.id.trim()) {
            const id = input.id.trim()
            if (!isSafeSegment(id)) {
              return jsonResult({ ok: false, error: 'id must be a safe identifier' })
            }
            const filePath = resolveConfinedPath(goalsDir, `${id}.json`)
            if (!existsSync(filePath)) return jsonResult({ ok: false, error: 'not_found', id })
            return jsonResult(JSON.parse(readFileSync(filePath, 'utf8')))
          }
          const files = readdirSync(goalsDir)
            .filter((f) => f.endsWith('.json'))
            .sort()
          const latest = files.at(-1)
          if (!latest) return jsonResult({ ok: false, error: 'no_active_goals' })
          return jsonResult(JSON.parse(readFileSync(resolveConfinedPath(goalsDir, latest), 'utf8')))
        } catch (err) {
          return jsonResult({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    },
    {
      name: 'goal_update',
      description: 'Update progress or status on an active session goal.',
      input: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Goal identifier' },
          status: { type: 'string', description: 'Updated status (active, paused, completed)' },
          notes: { type: 'string', description: 'Progress notes' },
        },
      },
      output: {},
      execute: async (input, context) => {
        try {
          const id = typeof input.id === 'string' ? input.id.trim() : ''
          if (!isSafeSegment(id)) {
            return jsonResult({ ok: false, error: 'valid goal id is required' })
          }
          const cwd = resolveToolCwd(context, fallbackDir)
          runAutoMigration(cwd)
          const goalsDir = join(cwd, '.pantheon', 'goals')
          const filePath = resolveConfinedPath(goalsDir, `${id}.json`)
          if (!existsSync(filePath)) return jsonResult({ ok: false, error: 'not_found', id })
          const existing = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
          const updated = {
            ...existing,
            status: typeof input.status === 'string' ? input.status : existing.status,
            ...(typeof input.notes === 'string' ? { notes: input.notes } : {}),
            updated_at: new Date().toISOString(),
          }
          writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf8')
          return jsonResult({ ok: true, goal: updated })
        } catch (err) {
          return jsonResult({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    },
    {
      name: 'goal_done',
      description: 'Mark a session goal as completed.',
      input: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Goal identifier' },
          summary: { type: 'string', description: 'Completion summary' },
        },
      },
      output: {},
      execute: async (input, context) => {
        try {
          const id = typeof input.id === 'string' ? input.id.trim() : ''
          if (!isSafeSegment(id)) {
            return jsonResult({ ok: false, error: 'valid goal id is required' })
          }
          const cwd = resolveToolCwd(context, fallbackDir)
          runAutoMigration(cwd)
          const goalsDir = join(cwd, '.pantheon', 'goals')
          const filePath = resolveConfinedPath(goalsDir, `${id}.json`)
          if (!existsSync(filePath)) return jsonResult({ ok: false, error: 'not_found', id })
          const existing = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
          const updated = {
            ...existing,
            status: 'completed',
            ...(typeof input.summary === 'string' ? { summary: input.summary } : {}),
            updated_at: new Date().toISOString(),
          }
          writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf8')
          return jsonResult({ ok: true, goal: updated })
        } catch (err) {
          return jsonResult({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          })
        }
      },
    },
  ]
}
