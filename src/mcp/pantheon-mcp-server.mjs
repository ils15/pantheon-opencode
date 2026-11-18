#!/usr/bin/env node
/**
 * pantheon-mcp-server.mjs — 100% Native Node.js MCP server for Pantheon.
 *
 * Replaces Python-based FastMCP servers with native ESM running on Node.js >= 26.
 * Zero Python dependencies, zero .venv required, 100% compatible with Windows Desktop,
 * macOS, and Linux. Speaks MCP JSON-RPC 2.0 over standard I/O.
 *
 * Usage:
 *   node src/mcp/pantheon-mcp-server.mjs --server pantheon-resources
 *   node src/mcp/pantheon-mcp-server.mjs --server pantheon-memory
 *   node src/mcp/pantheon-mcp-server.mjs --server pantheon-persistence
 *   node src/mcp/pantheon-mcp-server.mjs --server pantheon-code-mode
 *   node src/mcp/pantheon-mcp-server.mjs --server pantheon-vision
 *   node src/mcp/pantheon-mcp-server.mjs --server all
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..', '..')

// ── Security & Path Confinement Helpers ────────────────────────────────

const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._:-]{1,128}$/

function assertSafeSegment(value, label) {
  if (
    typeof value !== 'string' ||
    !SAFE_SEGMENT_RE.test(value) ||
    value === '.' ||
    value === '..' ||
    value.includes('..') ||
    value.includes('/') ||
    value.includes('\\')
  ) {
    throw new Error(`Invalid ${label}: must be a safe identifier without path traversal`)
  }
  return value
}

function resolveConfinedPath(baseDir, ...segments) {
  mkdirSync(baseDir, { recursive: true })
  const canonicalBase = realpathSync(baseDir)
  const candidate = resolve(canonicalBase, ...segments)
  const prefix = canonicalBase.endsWith(sep) ? canonicalBase : `${canonicalBase}${sep}`
  if (candidate !== canonicalBase && !candidate.startsWith(prefix)) {
    throw new Error('Path traversal denied: target escapes confined directory')
  }
  return candidate
}

const CODE_MODE_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TMPDIR',
  'TEMP',
  'TMP',
  'PANTHEON_PROJECT',
  'NODE_ENV',
]

function buildSandboxedEnv() {
  const env = {}
  for (const key of CODE_MODE_ENV_ALLOWLIST) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key]
    }
  }
  return env
}

// ── Argument Parsing ───────────────────────────────────────────────────

const args = process.argv.slice(2)
let serverType = 'all'
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--server' && args[i + 1]) {
    serverType = args[i + 1]
    i++
  }
}

// ── Path Helpers ───────────────────────────────────────────────────────

function getProjectRoot() {
  return process.env.PANTHEON_PROJECT || process.cwd()
}

// ── SQLite Memory Setup (with FTS5 + TTL support) ──────────────────────

let dbInstance = null
function getMemoryDb() {
  if (dbInstance) return dbInstance
  const memoryDir = join(getProjectRoot(), '.pantheon', 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const dbPath = join(memoryDir, 'memory.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
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
    /* FTS5 optional fallback if SQLite build omits fts5 */
  }
  dbInstance = db
  return db
}

// ── Tool Definitions ───────────────────────────────────────────────────

function getToolsForServer(type) {
  const tools = []

  if (type === 'all' || type === 'pantheon-memory') {
    tools.push(
      {
        name: 'memory_store',
        description:
          'Store a memory entry with namespace, key, value, and optional metadata string.',
        inputSchema: {
          type: 'object',
          properties: {
            namespace: { type: 'string' },
            key: { type: 'string' },
            value: { type: 'string' },
            metadata: { type: 'string' },
            expires_at: { type: 'string' },
          },
          required: ['namespace', 'key', 'value'],
        },
      },
      {
        name: 'memory_search',
        description: 'Search memories using FTS5 BM25 lexical matching (with keyword fallback).',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string' },
            namespace: { type: 'string' },
            top_k: { type: 'number' },
            limit: { type: 'number' },
          },
          required: ['query'],
        },
      },
      {
        name: 'memory_recall',
        description: 'Recall a specific memory entry by exact namespace and key.',
        inputSchema: {
          type: 'object',
          properties: {
            namespace: { type: 'string' },
            key: { type: 'string' },
          },
          required: ['namespace', 'key'],
        },
      },
      {
        name: 'memory_forget',
        description: 'Delete a memory entry by namespace and key.',
        inputSchema: {
          type: 'object',
          properties: {
            namespace: { type: 'string' },
            key: { type: 'string' },
          },
          required: ['namespace', 'key'],
        },
      },
      {
        name: 'memory_list',
        description: 'List active memory entries for a namespace.',
        inputSchema: {
          type: 'object',
          properties: {
            namespace: { type: 'string' },
            limit: { type: 'number' },
          },
        },
      },
      {
        name: 'memory_stats',
        description: 'Get memory storage statistics.',
        inputSchema: { type: 'object', properties: {} },
      },
    )
  }

  if (type === 'all' || type === 'pantheon-persistence') {
    tools.push(
      {
        name: 'context_save',
        description: 'Save a session checkpoint under a session_id key.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string' },
            content: { type: 'string' },
            namespace: { type: 'string' },
          },
          required: ['session_id', 'content'],
        },
      },
      {
        name: 'context_get',
        description: 'Retrieve a saved session checkpoint by session_id.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string' },
            namespace: { type: 'string' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'goal_create',
        description: 'Create a persistent session goal.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            title: { type: 'string' },
            criteria: { type: 'array', items: { type: 'string' } },
          },
          required: ['title'],
        },
      },
      {
        name: 'goal_get',
        description: 'Get active session goal by id or latest.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
          },
        },
      },
      {
        name: 'goal_update',
        description: 'Update progress on an active session goal.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            status: { type: 'string' },
            notes: { type: 'string' },
          },
          required: ['id'],
        },
      },
      {
        name: 'goal_done',
        description: 'Mark a session goal as completed.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            summary: { type: 'string' },
          },
          required: ['id'],
        },
      },
      {
        name: 'persistence_save',
        description: 'Save durable state JSON to .pantheon/persistence/<namespace>/<key>.json',
        inputSchema: {
          type: 'object',
          properties: {
            namespace: { type: 'string' },
            key: { type: 'string' },
            payload: { type: 'object' },
          },
          required: ['namespace', 'key', 'payload'],
        },
      },
      {
        name: 'persistence_load',
        description: 'Load durable state JSON from .pantheon/persistence/<namespace>/<key>.json',
        inputSchema: {
          type: 'object',
          properties: {
            namespace: { type: 'string' },
            key: { type: 'string' },
          },
          required: ['namespace', 'key'],
        },
      },
      {
        name: 'persistence_list',
        description: 'List durable state keys for a given namespace.',
        inputSchema: {
          type: 'object',
          properties: {
            namespace: { type: 'string' },
          },
          required: ['namespace'],
        },
      },
    )
  }

  if (type === 'all' || type === 'pantheon-code-mode') {
    tools.push(
      {
        name: 'execute_code_script',
        description:
          'Execute a manifest-verified orchestration script from .pantheon/code-mode/ directory.',
        inputSchema: {
          type: 'object',
          properties: {
            script: { type: 'string' },
            args: { type: 'array', items: { type: 'string' } },
          },
          required: ['script'],
        },
      },
      {
        name: 'approve_code_script',
        description: 'Record SHA-256 approval for a script in .pantheon/code-mode/manifest.json.',
        inputSchema: {
          type: 'object',
          properties: {
            script: { type: 'string' },
          },
          required: ['script'],
        },
      },
    )
  }

  if (type === 'all' || type === 'pantheon-vision') {
    tools.push({
      name: 'vision_describe',
      description:
        'Fallback MCP bridge: delegates image analysis to OpenCode native vision_describe tool.',
      inputSchema: {
        type: 'object',
        properties: {
          image_path: { type: 'string' },
          prompt: { type: 'string' },
        },
        required: ['image_path'],
      },
    })
  }

  return tools
}

// ── Resource Definitions ───────────────────────────────────────────────

function getResourcesForServer(type) {
  if (type !== 'all' && type !== 'pantheon-resources') return []
  return [
    {
      uri: 'pantheon://agents',
      name: 'Pantheon Agents',
      description: 'List of all Pantheon specialized agents and roles',
      mimeType: 'text/markdown',
    },
    {
      uri: 'pantheon://skills',
      name: 'Pantheon Skills',
      description: 'List of all Pantheon skills with descriptions',
      mimeType: 'text/markdown',
    },
    {
      uri: 'pantheon://routing',
      name: 'Pantheon Routing Rules',
      description: 'Canonical orchestration routing configuration',
      mimeType: 'text/yaml',
    },
  ]
}

// ── Tool Execution Handler ─────────────────────────────────────────────

function isNotExpiredSql() {
  return '(expires_at IS NULL OR expires_at > ?)'
}

async function handleToolCall(name, params = {}) {
  const nowIso = new Date().toISOString()

  switch (name) {
    case 'memory_store': {
      const db = getMemoryDb()
      const valueStr = String(params.value ?? '')
      if (Buffer.byteLength(valueStr, 'utf8') > 65536) {
        throw new Error('memory_store value exceeds maximum size of 64 KiB')
      }
      const stmt = db.prepare(`
        INSERT INTO memories (namespace, key, value, metadata, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(namespace, key) DO UPDATE SET
          value = excluded.value,
          metadata = excluded.metadata,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at
      `)
      stmt.run(
        String(params.namespace),
        String(params.key),
        valueStr,
        params.metadata ? String(params.metadata) : null,
        nowIso,
        params.expires_at ? String(params.expires_at) : null,
      )
      return { status: 'stored', namespace: params.namespace, key: params.key }
    }
    case 'memory_recall': {
      const db = getMemoryDb()
      const row = db
        .prepare(
          `SELECT namespace, key, value, metadata, created_at, expires_at
           FROM memories
           WHERE namespace = ? AND key = ? AND ${isNotExpiredSql()}`,
        )
        .get(String(params.namespace), String(params.key), nowIso)
      return row || { error: 'not_found' }
    }
    case 'memory_search': {
      const db = getMemoryDb()
      const limit = Number(params.top_k ?? params.limit ?? 10)
      const rawQuery = String(params.query ?? '').trim()
      if (!rawQuery) return { count: 0, results: [] }

      // Try FTS5 BM25 first, fallback to tokenized LIKE
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
          const ftsParams = [ftsExpr, nowIso]
          if (params.namespace) {
            ftsSql += ' AND m.namespace = ?'
            ftsParams.push(String(params.namespace))
          }
          ftsSql += ' ORDER BY score LIMIT ?'
          ftsParams.push(limit)
          const rows = db.prepare(ftsSql).all(...ftsParams)
          if (rows.length > 0) {
            return { count: rows.length, results: rows }
          }
        } catch {
          /* fallback to LIKE below */
        }
      }

      const escaped = rawQuery.replace(/[\\%_]/g, '\\$&')
      let query = `
        SELECT namespace, key, value, metadata, created_at
        FROM memories
        WHERE (value LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\')
          AND ${isNotExpiredSql()}
      `
      const queryParams = [`%${escaped}%`, `%${escaped}%`, nowIso]
      if (params.namespace) {
        query += ' AND namespace = ?'
        queryParams.push(String(params.namespace))
      }
      query += ' ORDER BY id DESC LIMIT ?'
      queryParams.push(limit)
      const rows = db.prepare(query).all(...queryParams)
      return { count: rows.length, results: rows }
    }
    case 'memory_forget': {
      const db = getMemoryDb()
      const info = db
        .prepare('DELETE FROM memories WHERE namespace = ? AND key = ?')
        .run(String(params.namespace), String(params.key))
      return { deleted: info.changes > 0, namespace: params.namespace, key: params.key }
    }
    case 'memory_list': {
      const db = getMemoryDb()
      const limit = Number(params.limit || 50)
      let query = `SELECT namespace, key, created_at FROM memories WHERE ${isNotExpiredSql()}`
      const queryParams = [nowIso]
      if (params.namespace) {
        query += ' AND namespace = ?'
        queryParams.push(String(params.namespace))
      }
      query += ' ORDER BY id DESC LIMIT ?'
      queryParams.push(limit)
      return db.prepare(query).all(...queryParams)
    }
    case 'memory_stats': {
      const db = getMemoryDb()
      const total = db
        .prepare(`SELECT count(*) as count FROM memories WHERE ${isNotExpiredSql()}`)
        .get(nowIso)
      const byNamespace = db
        .prepare(
          `SELECT namespace, count(*) as count FROM memories WHERE ${isNotExpiredSql()} GROUP BY namespace`,
        )
        .all(nowIso)
      return { total: total?.count || 0, byNamespace }
    }
    case 'context_save': {
      const ns = assertSafeSegment(params.namespace || 'checkpoints', 'namespace')
      const key = assertSafeSegment(params.session_id, 'session_id')
      const baseDir = join(getProjectRoot(), '.pantheon', 'persistence')
      const dir = resolveConfinedPath(baseDir, ns)
      mkdirSync(dir, { recursive: true })
      const filePath = resolveConfinedPath(dir, `${key}.json`)
      const record = {
        session_id: key,
        namespace: ns,
        content:
          typeof params.content === 'string' ? params.content : JSON.stringify(params.content),
        updated_at: nowIso,
      }
      writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf8')
      return { status: 'saved', session_id: key, updated_at: nowIso }
    }
    case 'context_get': {
      const ns = assertSafeSegment(params.namespace || 'checkpoints', 'namespace')
      const key = assertSafeSegment(params.session_id, 'session_id')
      const baseDir = join(getProjectRoot(), '.pantheon', 'persistence')
      const dir = resolveConfinedPath(baseDir, ns)
      const filePath = resolveConfinedPath(dir, `${key}.json`)
      if (!existsSync(filePath)) return { error: 'not_found', session_id: key }
      return JSON.parse(readFileSync(filePath, 'utf8'))
    }
    case 'goal_create': {
      const id = assertSafeSegment(params.id || `goal-${Date.now()}`, 'id')
      const goalsDir = join(getProjectRoot(), '.pantheon', 'goals')
      const filePath = resolveConfinedPath(goalsDir, `${id}.json`)
      const goal = {
        id,
        title: String(params.title ?? ''),
        criteria: Array.isArray(params.criteria) ? params.criteria.map(String) : [],
        status: 'active',
        created_at: nowIso,
        updated_at: nowIso,
      }
      writeFileSync(filePath, JSON.stringify(goal, null, 2), 'utf8')
      return goal
    }
    case 'goal_get': {
      const goalsDir = join(getProjectRoot(), '.pantheon', 'goals')
      mkdirSync(goalsDir, { recursive: true })
      if (params.id) {
        const id = assertSafeSegment(params.id, 'id')
        const filePath = resolveConfinedPath(goalsDir, `${id}.json`)
        if (!existsSync(filePath)) return { error: 'not_found', id }
        return JSON.parse(readFileSync(filePath, 'utf8'))
      }
      const files = readdirSync(goalsDir).filter((f) => f.endsWith('.json'))
      if (files.length === 0) return { error: 'no_active_goals' }
      const latest = files.sort().at(-1)
      return JSON.parse(readFileSync(resolveConfinedPath(goalsDir, latest), 'utf8'))
    }
    case 'goal_update':
    case 'goal_done': {
      const id = assertSafeSegment(params.id, 'id')
      const goalsDir = join(getProjectRoot(), '.pantheon', 'goals')
      const filePath = resolveConfinedPath(goalsDir, `${id}.json`)
      if (!existsSync(filePath)) return { error: 'not_found', id }
      const existing = JSON.parse(readFileSync(filePath, 'utf8'))
      const updated = {
        ...existing,
        status: name === 'goal_done' ? 'completed' : String(params.status ?? existing.status),
        notes: params.notes ?? params.summary ?? existing.notes,
        updated_at: nowIso,
      }
      writeFileSync(filePath, JSON.stringify(updated, null, 2), 'utf8')
      return updated
    }
    case 'persistence_save': {
      const ns = assertSafeSegment(params.namespace, 'namespace')
      const key = assertSafeSegment(params.key, 'key')
      const baseDir = join(getProjectRoot(), '.pantheon', 'persistence')
      const dir = resolveConfinedPath(baseDir, ns)
      mkdirSync(dir, { recursive: true })
      const filePath = resolveConfinedPath(dir, `${key}.json`)
      writeFileSync(filePath, JSON.stringify(params.payload, null, 2), 'utf8')
      return { status: 'saved', path: filePath }
    }
    case 'persistence_load': {
      const ns = assertSafeSegment(params.namespace, 'namespace')
      const key = assertSafeSegment(params.key, 'key')
      const baseDir = join(getProjectRoot(), '.pantheon', 'persistence')
      const dir = resolveConfinedPath(baseDir, ns)
      const filePath = resolveConfinedPath(dir, `${key}.json`)
      if (!existsSync(filePath)) return { error: 'not_found' }
      return JSON.parse(readFileSync(filePath, 'utf8'))
    }
    case 'persistence_list': {
      const ns = assertSafeSegment(params.namespace, 'namespace')
      const baseDir = join(getProjectRoot(), '.pantheon', 'persistence')
      const dir = resolveConfinedPath(baseDir, ns)
      if (!existsSync(dir)) return []
      return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => f.replace(/\.json$/, ''))
    }
    case 'approve_code_script': {
      const scriptName = assertSafeSegment(basename(String(params.script ?? '')), 'script')
      if (scriptName !== params.script) {
        throw new Error('Script must be a bare filename inside .pantheon/code-mode/')
      }
      const codeDir = join(getProjectRoot(), '.pantheon', 'code-mode')
      const scriptPath = resolveConfinedPath(codeDir, scriptName)
      if (!existsSync(scriptPath)) {
        throw new Error(`Script ${scriptName} not found in ${codeDir}`)
      }
      const sha256 = createHash('sha256').update(readFileSync(scriptPath)).digest('hex')
      const manifestPath = resolveConfinedPath(codeDir, 'manifest.json')
      let manifest = { scripts: {} }
      if (existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
          if (!manifest.scripts || typeof manifest.scripts !== 'object') manifest.scripts = {}
        } catch {
          manifest = { scripts: {} }
        }
      }
      manifest.scripts[scriptName] = { sha256, approved_at: nowIso }
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      return { status: 'approved', script: scriptName, sha256 }
    }
    case 'execute_code_script': {
      const scriptName = assertSafeSegment(basename(String(params.script ?? '')), 'script')
      if (scriptName !== params.script) {
        throw new Error('Script must be a bare filename inside .pantheon/code-mode/')
      }
      const codeDir = join(getProjectRoot(), '.pantheon', 'code-mode')
      const scriptPath = resolveConfinedPath(codeDir, scriptName)
      if (!existsSync(scriptPath)) {
        throw new Error(`Script ${scriptName} not found in ${codeDir}`)
      }

      // Verify SHA-256 against manifest.json if present
      const manifestPath = resolveConfinedPath(codeDir, 'manifest.json')
      if (existsSync(manifestPath)) {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        const expected =
          manifest?.scripts?.[scriptName]?.sha256 ??
          manifest?.[scriptName]?.sha256 ??
          manifest?.[scriptName]
        const actual = createHash('sha256').update(readFileSync(scriptPath)).digest('hex')
        if (typeof expected === 'string' && expected !== actual) {
          throw new Error(
            `Script ${scriptName} SHA-256 mismatch against manifest.json (run approve_code_script first)`,
          )
        }
      }

      const ext = extname(scriptName).toLowerCase()
      const interpreter = ext === '.py' ? 'python3' : ext === '.sh' ? '/bin/bash' : process.execPath
      const scriptArgs = Array.isArray(params.args) ? params.args.map(String) : []

      return new Promise((resolvePromise) => {
        execFile(
          interpreter,
          [scriptPath, ...scriptArgs],
          { timeout: 30000, cwd: getProjectRoot(), env: buildSandboxedEnv() },
          (err, stdout, stderr) => {
            if (err) resolvePromise({ exitCode: err.code || 1, stderr: stderr || err.message })
            else resolvePromise({ exitCode: 0, stdout })
          },
        )
      })
    }
    case 'vision_describe': {
      return {
        status: 'delegated_to_native',
        message:
          'Use the native OpenCode Pantheon plugin tool `vision_describe` directly in your session.',
      }
    }
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// ── Resource Read Handler ──────────────────────────────────────────────

async function handleResourceRead(uri) {
  if (uri === 'pantheon://agents') {
    const agentsDir = join(ROOT, 'src', 'agents')
    if (existsSync(agentsDir)) {
      const files = readdirSync(agentsDir).filter((f) => f.endsWith('.md') && f !== 'README.md')
      const content = files
        .map((f) => `### ${f.replace('.md', '')}\n\n${readFileSync(join(agentsDir, f), 'utf8')}`)
        .join('\n\n---\n\n')
      return [{ uri, mimeType: 'text/markdown', text: content }]
    }
    return [{ uri, mimeType: 'text/markdown', text: '# Agents not found' }]
  }
  if (uri === 'pantheon://skills') {
    const skillsLock = join(ROOT, 'skills-lock.json')
    if (existsSync(skillsLock)) {
      return [{ uri, mimeType: 'application/json', text: readFileSync(skillsLock, 'utf8') }]
    }
    return [{ uri, mimeType: 'text/markdown', text: '# Skills lock not found' }]
  }
  if (uri === 'pantheon://routing') {
    const routingFile = join(ROOT, 'src', 'routing.yml')
    if (existsSync(routingFile)) {
      return [{ uri, mimeType: 'text/yaml', text: readFileSync(routingFile, 'utf8') }]
    }
    return [{ uri, mimeType: 'text/yaml', text: '# Routing file not found' }]
  }
  throw new Error(`Resource not found: ${uri}`)
}

// ── JSON-RPC 2.0 STDIO Loop ────────────────────────────────────────────

function sendResponse(id, result) {
  const payload = JSON.stringify({ jsonrpc: '2.0', id, result })
  process.stdout.write(`${payload}\n`)
}

function sendError(id, code, message, data) {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data ? { data } : {}) },
  })
  process.stdout.write(`${payload}\n`)
}

const rl = createInterface({
  input: process.stdin,
  terminal: false,
})

rl.on('line', async (line) => {
  const trimmed = line.trim()
  if (!trimmed) return

  let msg
  try {
    msg = JSON.parse(trimmed)
  } catch {
    return
  }

  const { id, method, params } = msg

  // Notifications have no id
  if (id === undefined || id === null) {
    return
  }

  try {
    switch (method) {
      case 'initialize': {
        sendResponse(id, {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: {
            tools: {},
            resources: {},
          },
          serverInfo: {
            name: serverType === 'all' ? 'pantheon-mcp-native' : serverType,
            version: '2.2.0',
          },
        })
        break
      }
      case 'ping': {
        sendResponse(id, {})
        break
      }
      case 'tools/list': {
        sendResponse(id, {
          tools: getToolsForServer(serverType),
        })
        break
      }
      case 'tools/call': {
        const toolName = params?.name
        const toolArgs = params?.arguments || {}
        const output = await handleToolCall(toolName, toolArgs)
        sendResponse(id, {
          content: [
            {
              type: 'text',
              text: typeof output === 'string' ? output : JSON.stringify(output, null, 2),
            },
          ],
        })
        break
      }
      case 'resources/list': {
        sendResponse(id, {
          resources: getResourcesForServer(serverType),
        })
        break
      }
      case 'resources/read': {
        const contents = await handleResourceRead(params?.uri)
        sendResponse(id, { contents })
        break
      }
      case 'resources/templates/list': {
        sendResponse(id, { resourceTemplates: [] })
        break
      }
      case 'prompts/list': {
        sendResponse(id, { prompts: [] })
        break
      }
      default: {
        sendError(id, -32601, `Method not found: ${method}`)
      }
    }
  } catch (err) {
    sendError(id, -32603, err?.message || 'Internal error')
  }
})
