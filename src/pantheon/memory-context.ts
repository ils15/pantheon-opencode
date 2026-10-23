/**
 * Ambient memory injection for the OpenCode V2 runtime.
 *
 * `pantheon-memory` is pull-only: an entry is recalled only when the agent
 * decides to call `memory_search`. V2 exposes a per-request `context` hook, so
 * the most relevant entries can be added to `system` once per session without
 * asking the model to look for them. This module owns everything except the
 * hook registration itself: config resolution, the read-only SQLite query, the
 * char-budgeted rendering, and the once-per-session cache.
 *
 * ## What it reads
 *
 * The memory store at `$PANTHEON_HOME/memory/memory.db` (path resolution
 * mirrors `src/mcp/_pantheon_paths.py`: `PANTHEON_HOME` →
 * `$XDG_CONFIG_HOME/opencode` → `~/.config/opencode`), opened with
 * `node:sqlite`'s `DatabaseSync` in `readOnly` mode — the same access path
 * `cost-command.ts` uses for `opencode.db`. This module never creates a
 * directory, never creates a database, never writes a pragma, never migrates a
 * schema, and never writes a row. (A read-only connection to a WAL database can
 * still make SQLite create its `-shm`/`-wal` index sidecars next to the file —
 * that is the WAL index, not a memory write, and it is the only filesystem
 * effect this module can have.) A missing file, an unreadable file, an
 * unexpected schema, or a runtime without `node:sqlite` all return "no
 * injection".
 *
 * ## What it injects
 *
 * Top-K (default 3) entries ranked by FTS5 BM25 for the session's FIRST user
 * message, capped at a total character budget (default 1200) with per-entry
 * truncation marked `…[truncated]`. Expired entries (`expires_at` non-null and
 * in the past) are excluded in SQL, exactly like `memory_search`.
 *
 * ## Query duplication (accepted, and pinned by a test)
 *
 * `buildFtsQuery` re-implements `_build_fts_query` from
 * `src/mcp/memory_mcp.py:314` (`_build_fts_query`) — the stopword list, the
 * 4-character prefix
 * threshold and the `"term"*` shape. The duplication is deliberate: the MCP
 * server is a separate Python process and this runs inside the plugin runtime,
 * and a subprocess per request would be worse than ~60 lines. Drift is caught
 * by `tests/pantheon/memory-context.test.ts`, which parses `_STOPWORDS` and
 * `_MIN_PREFIX_LEN` out of the Python source and asserts equality with
 * {@link MEMORY_STOPWORDS} / {@link MIN_PREFIX_LEN}.
 *
 * Terms are always quoted and their embedded quotes doubled, so user text can
 * never become FTS5 syntax and never reaches SQL as anything but a bound
 * parameter.
 *
 * ## Fail-open
 *
 * Every exported entry point returns a value; nothing throws to the host.
 * {@link buildMemoryInjection} reports `skip` and optional `detail` instead, so
 * the plugin decides what to log (once per session) and whether to touch
 * `system` at all.
 *
 * @module memory-context
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Stable marker carried by the injected system part; also the dedupe key. */
export const MEMORY_CONTEXT_MARKER = '<!-- pantheon-memory-context:v1 -->'

/** Config keys accepted under `options.memory_injection`. */
export const MEMORY_INJECTION_CONFIG_KEYS = [
  'enabled',
  'maxEntries',
  'maxChars',
  'namespace',
] as const

export interface MemoryInjectionConfig {
  /** Opt-in switch. Default `false`: the hook output stays byte-identical. */
  enabled: boolean
  /** Entries to inject (1–10). Default 3. */
  maxEntries: number
  /** Total character budget for the injected system part. Default 1200. */
  maxChars: number
  /**
   * Namespace filter. `null` (the default) means NO filter, which is what
   * `memory_search(query)` does when its optional `namespace` argument is
   * omitted (`memory_mcp.py`: `namespace: str | None = None`, documented at
   * `docs/MEMORY.md`: "searches without a namespace filter can return matches
   * from any namespace"). `default` is the STORAGE default of the column, not
   * the search default, so it is not used here.
   */
  namespace: string | null
}

/** Defaults. `enabled:false` keeps ambient injection opt-in. */
export const DEFAULT_MEMORY_INJECTION_CONFIG: MemoryInjectionConfig = {
  enabled: false,
  maxEntries: 3,
  maxChars: 1200,
  namespace: null,
}

/** Hard bounds so a typo cannot inject a megabyte of memories. */
const MAX_ENTRIES_LIMIT = 10
const MAX_CHARS_LIMIT = 8000
/** Below this, the header plus one truncated entry cannot fit. */
const MIN_CHARS_LIMIT = 100

/** Minimum characters left for an entry body before it is dropped. */
const MIN_ENTRY_ROOM = 24

/** Suffix appended to a per-entry truncation. */
export const TRUNCATION_SUFFIX = '…[truncated]'

/** Search-text bounds: a huge prompt must not build a huge MATCH expression. */
const MAX_SEARCH_CHARS = 4000
const MAX_SEARCH_TERMS = 32

/**
 * Function words with no retrieval signal, copied verbatim from
 * `src/mcp/memory_mcp.py:229` (`_STOPWORDS`). Order and membership are pinned
 * by the drift test.
 */
export const MEMORY_STOPWORDS: ReadonlySet<string> = new Set([
  'a',
  'about',
  'above',
  'after',
  'again',
  'against',
  'all',
  'am',
  'an',
  'and',
  'any',
  'are',
  'as',
  'at',
  'be',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'but',
  'by',
  'can',
  'cannot',
  'could',
  'did',
  'do',
  'does',
  'doing',
  'done',
  'down',
  'during',
  'each',
  'few',
  'for',
  'from',
  'further',
  'had',
  'has',
  'have',
  'having',
  'he',
  'her',
  'here',
  'hers',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'itself',
  'just',
  'me',
  'more',
  'most',
  'my',
  'no',
  'nor',
  'not',
  'now',
  'of',
  'off',
  'on',
  'once',
  'only',
  'or',
  'other',
  'our',
  'ours',
  'out',
  'over',
  'own',
  'same',
  'she',
  'should',
  'so',
  'some',
  'such',
  'than',
  'that',
  'the',
  'their',
  'theirs',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'those',
  'through',
  'to',
  'too',
  'under',
  'until',
  'up',
  'very',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'whom',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your',
  'yours',
])

/** Shortest token still worth a prefix match (`memory_mcp.py:_MIN_PREFIX_LEN`). */
export const MIN_PREFIX_LEN = 4

// ─── Config ─────────────────────────────────────────────────────────────

/**
 * Read `options.memory_injection` (the V2 config copy, read like
 * `context_pruner`). Malformed input yields the defaults — config parsing must
 * never take the hook down.
 */
export function resolveMemoryInjectionConfig(options: unknown): MemoryInjectionConfig {
  const base = (): MemoryInjectionConfig => ({ ...DEFAULT_MEMORY_INJECTION_CONFIG })
  try {
    const raw = (options as { memory_injection?: unknown } | null | undefined)?.memory_injection
    if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
      return base()
    }
    const obj = raw as Record<string, unknown>
    const bounded = (value: unknown, fallback: number, min: number, max: number): number => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
      return Math.min(max, Math.max(min, Math.floor(value)))
    }
    let namespace: string | null = null
    if (typeof obj.namespace === 'string') {
      const trimmed = obj.namespace.trim()
      namespace = trimmed === '' ? null : trimmed
    }
    return {
      enabled: typeof obj.enabled === 'boolean' ? obj.enabled : false,
      maxEntries: bounded(
        obj.maxEntries,
        DEFAULT_MEMORY_INJECTION_CONFIG.maxEntries,
        1,
        MAX_ENTRIES_LIMIT,
      ),
      maxChars: bounded(
        obj.maxChars,
        DEFAULT_MEMORY_INJECTION_CONFIG.maxChars,
        MIN_CHARS_LIMIT,
        MAX_CHARS_LIMIT,
      ),
      namespace,
    }
  } catch {
    return base()
  }
}

/**
 * Describe why a `memory_injection` block would be partially ignored, without
 * changing the fail-open resolution. Empty means "absent or fully valid".
 * Unknown keys are reported because a silent typo (`maxEntry` instead of
 * `maxEntries`) is otherwise invisible.
 */
export function describeMemoryInjectionConfigIssues(options: unknown): string[] {
  try {
    const raw = (options as { memory_injection?: unknown } | null | undefined)?.memory_injection
    if (raw === undefined || raw === null) return []
    if (typeof raw !== 'object' || Array.isArray(raw)) return ['memory_injection is not an object']
    const obj = raw as Record<string, unknown>
    const issues: string[] = []
    const accepted = MEMORY_INJECTION_CONFIG_KEYS as readonly string[]
    for (const key of Object.keys(obj)) {
      if (!accepted.includes(key)) issues.push(`unknown key "${key}"`)
    }
    if ('enabled' in obj && typeof obj.enabled !== 'boolean') {
      issues.push('"enabled" must be a boolean')
    }
    for (const [key, min, max] of [
      ['maxEntries', 1, MAX_ENTRIES_LIMIT],
      ['maxChars', MIN_CHARS_LIMIT, MAX_CHARS_LIMIT],
    ] as const) {
      if (!(key in obj)) continue
      const value = obj[key]
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        issues.push(`"${key}" must be a number`)
        continue
      }
      if (value < min) issues.push(`"${key}" must be >= ${min}`)
      if (value > max) issues.push(`"${key}" must be <= ${max}`)
    }
    if ('namespace' in obj && obj.namespace !== null && typeof obj.namespace !== 'string') {
      issues.push('"namespace" must be a string or null')
    }
    return issues
  } catch {
    return ['memory_injection could not be inspected']
  }
}

// ─── Path resolution ────────────────────────────────────────────────────

/**
 * Resolve the Pantheon config dir, mirroring `_pantheon_paths.py`
 * (`PANTHEON_HOME` → `$XDG_CONFIG_HOME/opencode` → `~/.config/opencode`).
 */
function resolvePantheonHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.PANTHEON_HOME?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const xdg = env.XDG_CONFIG_HOME?.trim()
  const base = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.config')
  return join(base, 'opencode')
}

/** `$PANTHEON_HOME/memory/memory.db`. */
export function resolveMemoryDbPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolvePantheonHome(env), 'memory', 'memory.db')
}

// ─── SQLite boundary ────────────────────────────────────────────────────

/** The subset of `node:sqlite` this module needs. */
export interface MemorySqliteStatement {
  all(...params: unknown[]): unknown[]
}

export interface MemorySqliteDatabase {
  prepare(sql: string): MemorySqliteStatement
  close(): void
}

export interface MemorySqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => MemorySqliteDatabase
}

let cachedSqlite: MemorySqliteModule | null | undefined

/**
 * Load `node:sqlite` synchronously, or return `null`.
 *
 * `process.getBuiltinModule` (Node ≥ 22.3) is used instead of a dynamic import
 * because the `context` hook is synchronous and the host will not await a
 * promise. `node:sqlite` (Node ≥ 22.5) therefore cannot exist on a runtime
 * where `getBuiltinModule` is missing, so a single path covers both. The
 * failure is cached: a runtime that lacks the module never pays for the probe
 * twice.
 */
function loadMemorySqlite(): MemorySqliteModule | null {
  if (cachedSqlite !== undefined) return cachedSqlite
  try {
    const getBuiltin = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule
    if (typeof getBuiltin !== 'function') {
      cachedSqlite = null
      return null
    }
    const mod = getBuiltin('node:sqlite') as MemorySqliteModule | undefined
    cachedSqlite = mod !== undefined && typeof mod?.DatabaseSync === 'function' ? mod : null
  } catch {
    cachedSqlite = null
  }
  return cachedSqlite
}

export type MemorySkipReason =
  | 'disabled'
  | 'no-sqlite'
  | 'no-db'
  | 'schema'
  | 'no-system'
  | 'no-message'
  | 'no-terms'
  | 'empty'
  | 'error'

export interface MemoryRow {
  namespace: string
  key: string | null
  value: string
  created_at: string
}

export interface MemoryInjectionResult {
  /** The system-part text, or `null` when nothing is injected. */
  text: string | null
  /** Entries actually rendered. */
  entries: number
  /** Characters in `text` (`0` when `text` is null). */
  chars: number
  /** Why nothing was injected; `null` on success. */
  skip: MemorySkipReason | null
  /** One-line diagnostic detail for the plugin log (never user content). */
  detail?: string
}

export interface MemoryInjectionDeps {
  /** Explicit database path (tests / unusual installs). */
  dbPath?: string
  /** Environment used for path resolution. Default: `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Injectable `node:sqlite` loader. Default: {@link loadMemorySqlite}. */
  sqliteLoader?: () => MemorySqliteModule | null
  /** Clock. Default: `Date.now`. */
  now?: () => number
}

const REQUIRED_TABLES = ['memories', 'memories_fts'] as const
const REQUIRED_COLUMNS = ['id', 'namespace', 'key', 'value', 'created_at'] as const

interface OpenFailure {
  skip: Extract<MemorySkipReason, 'no-sqlite' | 'no-db' | 'schema' | 'error'>
  detail: string
}

interface OpenSuccess {
  db: MemorySqliteDatabase
  /** Whether `memories.expires_at` exists (added by TTL support). */
  hasExpiry: boolean
}

function isFailure(value: OpenSuccess | OpenFailure): value is OpenFailure {
  return 'skip' in value
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Open the memory database read-only and validate the shape this module needs. */
function openMemoryDb(dbPath: string, sqlite: MemorySqliteModule): OpenSuccess | OpenFailure {
  if (!existsSync(dbPath)) {
    return { skip: 'no-db', detail: `memory database not found at ${dbPath}` }
  }
  let db: MemorySqliteDatabase
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    return {
      skip: 'no-db',
      detail: `memory database could not be opened read-only: ${errorMessage(error)}`,
    }
  }
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?)")
      .all(...REQUIRED_TABLES)
      .map((row) => (row as { name?: unknown }).name)
      .filter((name): name is string => typeof name === 'string')
    const missingTables = REQUIRED_TABLES.filter((name) => !tables.includes(name))
    if (missingTables.length > 0) {
      db.close()
      return { skip: 'schema', detail: `missing table(s) ${missingTables.join(', ')}` }
    }
    const columns = db
      .prepare('PRAGMA table_info(memories)')
      .all()
      .map((row) => (row as { name?: unknown }).name)
      .filter((name): name is string => typeof name === 'string')
    const missingColumns = REQUIRED_COLUMNS.filter((name) => !columns.includes(name))
    if (missingColumns.length > 0) {
      db.close()
      return { skip: 'schema', detail: `missing column(s) ${missingColumns.join(', ')}` }
    }
    return { db, hasExpiry: columns.includes('expires_at') }
  } catch (error) {
    try {
      db.close()
    } catch {
      // Best-effort close; the diagnostic below is what matters.
    }
    return { skip: 'schema', detail: `schema probe failed: ${errorMessage(error)}` }
  }
}

// ─── FTS query builder (mirror of memory_mcp.py:314) ────────────────────

/**
 * Build an FTS5 `MATCH` expression from free-text input.
 *
 * SOURCE OF TRUTH: `_build_fts_query` in `src/mcp/memory_mcp.py` (`:314` on the
 * tree this was ported from — the SYMBOL is the contract, the line number
 * drifts with any unrelated edit above it). Same stopword filter, same
 * 4-character prefix threshold, same `OR`-joined `"term"*` shape. Two
 * deliberate additions: embedded double quotes are doubled so a quote in user
 * text cannot break out of the quoted term, and the term count is capped at
 * {@link MAX_SEARCH_TERMS}.
 *
 * @returns The expression, or `''` when no searchable term survives.
 */
export function buildFtsQuery(query: string): string {
  if (typeof query !== 'string') return ''
  const words = query.split(/\s+/).filter((word) => word !== '')
  if (words.length === 0) return ''
  const content = words.filter((word) => !MEMORY_STOPWORDS.has(word.toLowerCase()))
  if (content.length === 0) return ''
  return content
    .slice(0, MAX_SEARCH_TERMS)
    .map((word) => {
      // A double quote inside an FTS5 string is escaped by doubling it.
      const escaped = word.replace(/"/g, '""')
      return escaped.length >= MIN_PREFIX_LEN ? `"${escaped}"*` : `"${escaped}"`
    })
    .join(' OR ')
}

// ─── Session message → search text ──────────────────────────────────────

/**
 * Extract the text of the session's FIRST user message.
 *
 * V2 message shape (measured on opencode v2.1.2, see the `context-pruner`
 * module docstring): `{ id?, role, content: [{ type: 'text', text }],
 * metadata? }`. A bare string `content` is also accepted. Returns `null` when
 * there is no non-empty user text.
 */
export function extractFirstUserText(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const candidate = message as { role?: unknown; content?: unknown }
    if (candidate.role !== 'user') continue
    const text = messageText(candidate.content)
    if (text !== null) return text.slice(0, MAX_SEARCH_CHARS)
  }
  return null
}

function messageText(content: unknown): string | null {
  if (typeof content === 'string') {
    const trimmed = content.trim()
    return trimmed === '' ? null : trimmed
  }
  if (!Array.isArray(content)) return null
  const pieces: string[] = []
  for (const part of content) {
    if (part === null || typeof part !== 'object') continue
    const entry = part as { type?: unknown; text?: unknown }
    if (typeof entry.text !== 'string') continue
    if (entry.type !== undefined && entry.type !== 'text') continue
    if (entry.text.trim() === '') continue
    pieces.push(entry.text)
  }
  if (pieces.length === 0) return null
  return pieces.join(' ').trim()
}

// ─── Rendering ──────────────────────────────────────────────────────────

/** Collapse whitespace so one entry stays one readable line. */
function normalizeValue(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function entryLabel(row: MemoryRow): string {
  const namespace = typeof row.namespace === 'string' ? row.namespace.trim() : ''
  const key = typeof row.key === 'string' ? row.key.trim() : ''
  if (key !== '') return namespace === '' ? key : `${namespace}/${key}`
  return namespace === '' ? 'memory' : namespace
}

/** Header of the injected part; counts against the budget. */
function payloadHeader(): string {
  return (
    `${MEMORY_CONTEXT_MARKER}\n` +
    'Pantheon memory (auto-injected, read-only; call memory_search for more):'
  )
}

/**
 * Render rows into the budgeted system-part text.
 *
 * The whole payload — header and entries — is bounded by `maxChars`. The room
 * left after the header is split evenly between the rows that will be shown
 * (at most `maxEntries`), so one huge entry cannot consume the budget of the
 * others: an ambient block that recollects ONE memory is not the same feature
 * as one that recollects three. An entry that does not fit its share is
 * truncated with {@link TRUNCATION_SUFFIX}; an entry with less than
 * {@link MIN_ENTRY_ROOM} characters of room is dropped. Returns `null` when not
 * even one entry fits.
 */
export function renderMemoryContext(
  rows: readonly MemoryRow[],
  maxChars: number,
  maxEntries: number = Array.isArray(rows) ? rows.length : 0,
): { text: string; entries: number } | null {
  if (!Array.isArray(rows) || rows.length === 0) return null
  if (typeof maxChars !== 'number' || !Number.isFinite(maxChars)) return null
  const header = payloadHeader()
  if (header.length + TRUNCATION_SUFFIX.length + MIN_ENTRY_ROOM > maxChars) return null
  const slots = Math.max(1, Math.min(rows.length, Math.floor(maxEntries) || 1))
  const perEntryFloor = MIN_ENTRY_ROOM + TRUNCATION_SUFFIX.length
  const share = Math.max(perEntryFloor, Math.floor((maxChars - header.length) / slots))
  let text = header
  let entries = 0
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const value = normalizeValue(typeof row.value === 'string' ? row.value : '')
    if (value === '') continue
    const line = `\n- ${entryLabel(row)}: ${value}`
    const available = maxChars - text.length
    if (available <= 0) break
    // A per-entry share, never more than what is left in the total budget.
    const lineCap = Math.min(share, available)
    if (line.length <= lineCap) {
      text += line
      entries++
      continue
    }
    if (lineCap <= TRUNCATION_SUFFIX.length) break
    const room = lineCap - TRUNCATION_SUFFIX.length
    if (room < MIN_ENTRY_ROOM) break
    text += `${line.slice(0, room)}${TRUNCATION_SUFFIX}`
    entries++
  }
  if (entries === 0) return null
  return { text, entries }
}

// ─── Query + build ──────────────────────────────────────────────────────

/** ISO-8601 UTC with second precision, matching `_now_iso` in `memory_mcp.py`. */
function nowIso(now: () => number): string {
  return new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Read the top-K matching rows. All caller-supplied values are bound
 * parameters; the only text this function concatenates is its own SQL.
 */
function queryMemoryRows(
  db: MemorySqliteDatabase,
  ftsQuery: string,
  config: MemoryInjectionConfig,
  hasExpiry: boolean,
  referenceTime: string,
): MemoryRow[] {
  const params: unknown[] = [ftsQuery]
  let filters = ''
  if (hasExpiry) {
    // Lexicographic comparison of stored ISO-8601 UTC strings is
    // chronological, so no date parsing is needed in SQL. Rows written before
    // TTL support have expires_at NULL and stay visible.
    filters += ' AND (memories.expires_at IS NULL OR memories.expires_at > ?)'
    params.push(referenceTime)
  }
  if (config.namespace !== null) {
    filters += ' AND memories.namespace = ?'
    params.push(config.namespace)
  }
  params.push(config.maxEntries)
  const rows = db
    .prepare(
      `SELECT memories.namespace AS namespace, memories.key AS key,
              memories.value AS value, memories.created_at AS created_at
       FROM memories_fts
       JOIN memories ON memories.id = memories_fts.rowid
       WHERE memories_fts MATCH ?${filters}
       ORDER BY rank LIMIT ?`,
    )
    .all(...params)
  return rows as MemoryRow[]
}

const SKIP: MemorySkipReason[] = [
  'disabled',
  'no-sqlite',
  'no-db',
  'schema',
  'no-system',
  'no-message',
  'no-terms',
  'empty',
  'error',
]

/**
 * Environment variable that adds the raw error message to an `error` skip.
 * OFF by default: that message can contain SQL and the FTS `MATCH` expression,
 * which is built from the session's first user message.
 */
export const MEMORY_INJECTION_DEBUG_ENV = 'PANTHEON_MEMORY_INJECTION_DEBUG'

/**
 * A STABLE classification for an unexpected failure — never the message body.
 *
 * An SQLite/FTS error message echoes the failing statement, and that statement
 * carries the `MATCH` expression built from the user's first message, so a raw
 * message would copy user content into `hooks.log`. Node's sqlite errors carry
 * a stable `code` (`ERR_SQLITE_ERROR`, `ERR_INVALID_STATE`, …) and a `name`;
 * either identifies the failure class without the body. Anything that does not
 * look like an enum falls back to `unknown`.
 */
export function classifyMemoryError(error: unknown): string {
  const stable = (value: unknown): string | null =>
    typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(value) ? value : null
  try {
    if (error === null || typeof error !== 'object') return 'unknown'
    const code = stable((error as { code?: unknown }).code)
    if (code !== null) return code
    const name = stable((error as { name?: unknown }).name)
    if (name !== null && name !== 'Error') return name
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * The `detail` attached to an `error` skip: the classification only, unless
 * {@link MEMORY_INJECTION_DEBUG_ENV} is `1`. The debug form is deliberately not
 * the default — with it on, `hooks.log` can contain memory text and prompt
 * fragments.
 */
export function errorDetail(error: unknown): string {
  const classification = `code=${classifyMemoryError(error)}`
  if (process.env[MEMORY_INJECTION_DEBUG_ENV] !== '1') return classification
  return `${classification} message=${errorMessage(error)}`
}

function fail(skip: MemorySkipReason, detail?: string): MemoryInjectionResult {
  return {
    text: null,
    entries: 0,
    chars: 0,
    skip: SKIP.includes(skip) ? skip : 'error',
    ...(detail === undefined ? {} : { detail }),
  }
}

/**
 * Build the injection payload for one session's first request.
 *
 * Never throws. Returns `{ text: null, skip }` for every failure — a disabled
 * config, a runtime without `node:sqlite`, a missing/unreadable/mismatched
 * database, a message with no searchable terms, or an empty result set.
 */
export function buildMemoryInjection(
  messages: unknown,
  config: MemoryInjectionConfig,
  deps: MemoryInjectionDeps = {},
): MemoryInjectionResult {
  try {
    if (config === null || typeof config !== 'object' || !config.enabled) {
      return fail('disabled')
    }
    const searchText = extractFirstUserText(messages)
    if (searchText === null) return fail('no-message')
    const ftsQuery = buildFtsQuery(searchText)
    if (ftsQuery === '') return fail('no-terms')
    const sqlite = (deps.sqliteLoader ?? loadMemorySqlite)()
    if (sqlite === null) {
      return fail('no-sqlite', 'node:sqlite is unavailable in this runtime')
    }
    const dbPath = deps.dbPath ?? resolveMemoryDbPath(deps.env)
    const opened = openMemoryDb(dbPath, sqlite)
    if (isFailure(opened)) return fail(opened.skip, opened.detail)
    let rows: MemoryRow[]
    try {
      rows = queryMemoryRows(
        opened.db,
        ftsQuery,
        config,
        opened.hasExpiry,
        nowIso(deps.now ?? Date.now),
      )
    } finally {
      try {
        opened.db.close()
      } catch {
        // A close failure must not mask the query result.
      }
    }
    if (rows.length === 0) return fail('empty')
    const rendered = renderMemoryContext(rows, config.maxChars, config.maxEntries)
    if (rendered === null) return fail('empty', 'no entry fit the character budget')
    return {
      text: rendered.text,
      entries: rendered.entries,
      chars: rendered.text.length,
      skip: null,
    }
  } catch (error) {
    return fail('error', errorDetail(error))
  }
}

// ─── Once-per-session cache ─────────────────────────────────────────────

/** Sessions whose payload is memoized before the oldest is evicted. */
export const MEMORY_CACHE_MAX_SESSIONS = 64

/**
 * Bounded, insertion-ordered memo of one payload per session id.
 *
 * The payload is computed on the session's first request and replayed on every
 * later one, so a session never re-queries the store per request. A `null` text
 * is cached too: a disabled/missing store must not be re-probed per request
 * either. Sessions without a usable id are never cached (nothing to key on).
 */
export class MemoryInjectionCache {
  private readonly entries = new Map<string, MemoryInjectionResult>()

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }

  /** Forget one session (used when the host deletes it). */
  delete(sessionID: unknown): void {
    if (typeof sessionID !== 'string') return
    this.entries.delete(sessionID)
  }

  /** Return the memoized payload, computing and storing it on a miss. */
  resolve(sessionID: unknown, compute: () => MemoryInjectionResult): MemoryInjectionResult {
    const key = typeof sessionID === 'string' && sessionID.trim() !== '' ? sessionID : null
    if (key === null) return compute()
    const cached = this.entries.get(key)
    if (cached !== undefined) return cached
    const value = compute()
    if (this.entries.size >= MEMORY_CACHE_MAX_SESSIONS) {
      const oldest = this.entries.keys().next()
      if (!oldest.done) this.entries.delete(oldest.value)
    }
    this.entries.set(key, value)
    return value
  }
}

// ─── Hook application ───────────────────────────────────────────────────

/** How many session ids the one-line-per-session log keeps before it resets. */
export const MEMORY_INJECTION_LOG_MAX_SESSIONS = 512

/** Session ids already reported (one line per session, success or failure). */
const loggedSessions = new Set<string>()

/** Test seam: forget which sessions were already reported. */
export function resetMemoryInjectionLogState(): void {
  loggedSessions.clear()
}

let configWarned = false

/** Test seam: forget that an invalid config was reported. */
export function resetMemoryInjectionConfigWarned(): void {
  configWarned = false
}

/** Skips that are ordinary conditions rather than faults, so they stay silent. */
const SILENT_SKIPS: ReadonlySet<MemorySkipReason> = new Set<MemorySkipReason>([
  'disabled',
  'no-message',
  'no-terms',
  'empty',
])

/**
 * Whether a `system` part array already carries the injected marker.
 *
 * Accepts the measured part shape (`{ type: 'text', text }`) and a bare string,
 * and never throws, so it is safe to call on host input of unknown shape.
 */
export function hasMemoryContextMarker(system: unknown): boolean {
  if (!Array.isArray(system)) return false
  try {
    return system.some((entry) => {
      if (typeof entry === 'string') return entry.includes(MEMORY_CONTEXT_MARKER)
      if (entry === null || typeof entry !== 'object') return false
      const text = (entry as { text?: unknown }).text
      return typeof text === 'string' && text.includes(MEMORY_CONTEXT_MARKER)
    })
  } catch {
    return false
  }
}

/**
 * Report an invalid `memory_injection` block ONCE per process, naming the
 * ignored keys and the accepted ones, while resolution still falls back to the
 * defaults. Without this a typo (`maxEntry`) is invisible: the engine keeps its
 * default and the operator believes the setting took effect.
 */
export function warnInvalidMemoryInjectionConfig(
  options: unknown,
  log: (line: string) => void,
): void {
  if (configWarned) return
  try {
    const issues = describeMemoryInjectionConfigIssues(options)
    if (issues.length === 0) return
    configWarned = true
    log(
      `[memory-context] ignored invalid memory_injection config: ${issues.join('; ')}; ` +
        `accepted keys: ${MEMORY_INJECTION_CONFIG_KEYS.join(', ')}`,
    )
  } catch {
    // A validator must never break setup; silence is the only safe fallback.
    configWarned = true
  }
}

/**
 * The one-line log entry for a session, or `null` when nothing should be
 * written.
 *
 * ONCE PER SESSION, failures included: the hook runs on every model step, so
 * without the dedupe a successful injection would log on each request and a
 * broken store would log until the session ends. A skip that only means "there
 * was nothing to recall" (`no-message`, `no-terms`, `empty`, `disabled`) is not
 * a fault and writes nothing; `no-sqlite`, `no-db`, `schema` and `error` do,
 * because they mean this feature is inert and only a log line can say so.
 */
export function formatMemoryInjectionLogLine(
  sessionID: unknown,
  result: MemoryInjectionResult,
  seen: Set<string> = loggedSessions,
): string | null {
  if (result.text === null && (result.skip === null || SILENT_SKIPS.has(result.skip))) return null
  const key = typeof sessionID === 'string' && sessionID !== '' ? sessionID : 'unknown'
  if (seen.has(key)) return null
  if (seen.size >= MEMORY_INJECTION_LOG_MAX_SESSIONS) seen.clear()
  seen.add(key)
  if (result.text !== null) {
    return `[memory-context] injected entries=${result.entries} chars=${result.chars} session=${key}`
  }
  return (
    `[memory-context] no injection session=${key} skip=${result.skip}` +
    (result.detail === undefined ? '' : `: ${result.detail}`)
  )
}

/**
 * The whole memory step of the `context` hook: append the session's payload to
 * a normalized `system` part array, once.
 *
 * `system` is accepted as `unknown` on purpose: the caller passes whatever the
 * host sent, and only an `Array` is ever touched. When it IS an array it must
 * already be `Array<{ type: 'text', text }>` — the host rejects any other shape
 * — and this function only ever PUSHES one such part. It returns silently when
 * injection is disabled, when the marker is already present (a later request of
 * the same session, or a retry), or when the store yields nothing. Never throws:
 * an ambient feature must not be able to break the request it decorates.
 *
 * ENABLED BUT UNUSABLE IS OBSERVABLE: with `enabled: true` and no usable
 * `system` array there is nothing to push into, so the feature cannot work —
 * and that is reported once per session as `skip=no-system` instead of
 * vanishing. A feature that is switched on and silently does nothing is worse
 * than one that is switched off, because the operator has no signal at all.
 */
export function applyMemoryInjection(
  system: unknown,
  messages: unknown,
  sessionID: unknown,
  config: MemoryInjectionConfig,
  cache: MemoryInjectionCache,
  log?: (line: string) => void,
): void {
  try {
    if (config === null || typeof config !== 'object' || !config.enabled) return
    if (!Array.isArray(system)) {
      const line = formatMemoryInjectionLogLine(sessionID, {
        text: null,
        entries: 0,
        chars: 0,
        skip: 'no-system',
        detail:
          system === undefined || system === null ? 'system absent' : 'system is not an array',
      })
      if (line !== null) log?.(line)
      return
    }
    if (hasMemoryContextMarker(system)) return
    const result = cache.resolve(sessionID, () => buildMemoryInjection(messages, config))
    if (result.text !== null) system.push({ type: 'text', text: result.text })
    const line = formatMemoryInjectionLogLine(sessionID, result)
    if (line !== null) log?.(line)
  } catch {
    // Fail-open by contract.
  }
}
