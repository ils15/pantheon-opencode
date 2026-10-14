/**
 * bench/lib/collector.mjs — READ-ONLY opencode.db metric extraction for the
 * beta-10 latency baseline harness (Phase 0).
 *
 * Same source of truth as `pantheon_cost` (src/pantheon/cost-command.ts):
 * the V2 ledger lives in `session_message` (assistant rows carry
 * `data.tokens`), the V1 ledger in `message` (`data.role = 'assistant'`).
 * This collector is V2-first because the bench host is a V2-generation
 * install; a V1 database is reported as an explicit per-metric
 * `unavailable`, never guessed at and never zero.
 *
 * Hard rules (locked by tests/bench-collector.test.mjs):
 *   - node:sqlite ONLY; unavailable → explicit thrown error, no fallback
 *   - the db is opened readOnly; a missing file is an error, never created
 *   - collection performs zero writes (no WAL/SHM side files, byte-identical
 *     file afterwards)
 *
 * @module bench/lib/collector
 */

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const TOKEN_TABLES = ['message', 'session_message']

/**
 * Open an existing opencode.db STRICTLY read-only.
 *
 * Throws (never creates, never falls back) when the file does not exist —
 * SQLite would otherwise silently create an empty database. node:sqlite is a
 * static import: a Node build without it fails at load time with an explicit
 * module error, which is the contract's "erro explícito, sem fallback".
 */
export function openReadOnly(dbPath) {
  let stat
  try {
    stat = statSync(dbPath)
  } catch {
    throw new Error(
      `bench: opencode.db not found at ${dbPath} — refusing to create it (read-only contract)`,
    )
  }
  if (!stat.isFile()) {
    throw new Error(`bench: ${dbPath} is not a regular file`)
  }
  return new DatabaseSync(dbPath, { readOnly: true })
}

/**
 * Detect which token-ledger table family the database carries — same rule as
 * cost-command.ts: presence of `message` (V1) and/or `session_message` (V2);
 * a migrated db carries both. Neither → 'unsupported'.
 */
export function detectSchema(db) {
  const placeholders = TOKEN_TABLES.map(() => '?').join(', ')
  const rows = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
    .all(...TOKEN_TABLES)
  const tables = rows.map((r) => r.name)
  const hasV2 = tables.includes('session_message')
  const hasV1 = tables.includes('message')
  const generation = hasV2 ? 'v2' : hasV1 ? 'v1' : 'unsupported'
  return { generation, tables }
}

/** Recursive children of `rootId` via session_v2.parent_id (V2 schema). */
function childSessionIds(db, rootId, table) {
  const ids = []
  const seen = new Set([rootId])
  let frontier = [rootId]
  const select = db.prepare(`SELECT id FROM ${table} WHERE parent_id = ?`)
  while (frontier.length > 0) {
    const next = []
    for (const parentId of frontier) {
      for (const row of select.all(parentId)) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        ids.push(row.id)
        next.push(row.id)
      }
    }
    frontier = next
  }
  return ids
}

/** All sessions in the root's tree: [root, ...descendants]. */
export function collectSessionTree(db, rootId) {
  const table = detectSchema(db).generation === 'v2' ? 'session_v2' : null
  if (table === null)
    return { status: 'unavailable', reason: 'no session_v2 table (V1/unsupported schema)' }
  const root = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(rootId)
  if (!root) {
    return { status: 'unavailable', reason: `root session ${rootId} not found in ${table}` }
  }
  const childIds = childSessionIds(db, rootId, table)
  const sessions = [root]
  const byIdSelect = db.prepare(`SELECT * FROM ${table} WHERE id = ?`)
  for (const id of childIds) sessions.push(byIdSelect.get(id))
  return { status: 'ok', sessions, childIds }
}

/**
 * Token totals over the tree, derived from per-assistant-message rows — the
 * same rows pantheon_cost reads. V1 ledgers are reported unavailable (the V2
 * bench never produces them).
 */
export function collectTokens(db, sessionIds) {
  const schema = detectSchema(db)
  if (schema.generation !== 'v2') {
    return {
      status: 'unavailable',
      reason: `token ledger is ${schema.generation}; the bench collector reads the V2 session_message ledger only`,
    }
  }
  const placeholders = sessionIds.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT data FROM session_message WHERE session_id IN (${placeholders}) AND type = 'assistant' AND json_valid(data)`,
    )
    .all(...sessionIds)
  const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
  let counted = 0
  for (const row of rows) {
    let data
    try {
      data = JSON.parse(row.data)
    } catch {
      continue
    }
    const t = data?.tokens
    if (!t || typeof t !== 'object') continue
    counted += 1
    if (typeof t.input === 'number') tokens.input += t.input
    if (typeof t.output === 'number') tokens.output += t.output
    if (typeof t.reasoning === 'number') tokens.reasoning += t.reasoning
    if (t.cache && typeof t.cache === 'object') {
      if (typeof t.cache.read === 'number') tokens.cacheRead += t.cache.read
      if (typeof t.cache.write === 'number') tokens.cacheWrite += t.cache.write
    }
  }
  if (counted === 0) {
    return { status: 'unavailable', reason: 'no assistant rows with a tokens object in the tree' }
  }
  return { status: 'ok', ...tokens, tokenMessages: counted }
}

/**
 * Tool calls per name across the tree. V2 assistant messages carry tool calls
 * as content parts `{type:'tool', name}`. Only names are read — never tool
 * inputs — so nothing from a tool payload can reach the report.
 */
export function collectToolCalls(db, sessionIds) {
  const schema = detectSchema(db)
  if (schema.generation !== 'v2') {
    return {
      status: 'unavailable',
      reason: `tool-call parts read from the V2 session_message ledger only (ledger is ${schema.generation})`,
    }
  }
  const placeholders = sessionIds.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT json_extract(p.value, '$.name') AS name, COUNT(*) AS n
         FROM session_message sm, json_each(json_extract(sm.data, '$.content')) p
        WHERE sm.session_id IN (${placeholders})
          AND sm.type = 'assistant'
          AND json_valid(sm.data)
          AND json_extract(p.value, '$.type') = 'tool'
        GROUP BY name ORDER BY n DESC, name`,
    )
    .all(...sessionIds)
  return { status: 'ok', calls: rows.map((r) => ({ name: r.name, count: r.n })) }
}

/**
 * Compose every per-run db metric for one root session.
 *
 * Each metric independently degrades to {status:'unavailable', reason}.
 */
export function collectRunMetrics(db, rootId) {
  const tree = collectSessionTree(db, rootId)
  if (tree.status !== 'ok') {
    return {
      root: { status: 'unavailable', reason: tree.reason },
      sessions: { status: 'unavailable', reason: tree.reason },
      childrenCount: null,
      tokens: { status: 'unavailable', reason: tree.reason },
      toolCalls: { status: 'unavailable', reason: tree.reason },
    }
  }
  const sessionIds = tree.sessions.map((s) => s.id)
  const root = tree.sessions[0]
  const toolCalls = collectToolCalls(db, sessionIds)
  return {
    root: {
      status: 'ok',
      id: root.id,
      idle_outcome: root.idle_outcome ?? null,
      model: root.model ?? null,
      agent: root.agent ?? null,
      title: root.title ?? null,
    },
    sessions: { status: 'ok', ids: sessionIds },
    childrenCount: tree.childIds.length,
    tokens: collectTokens(db, sessionIds),
    toolCalls,
  }
}

/**
 * Instruction provenance for one session — the D4 fidelity proof.
 *
 * Reads `instruction_state.current_values['core/instructions']` (a content
 * hash), resolves it through `instruction_blob`, and reports, per loaded
 * instruction file: its absolute path, byte length and SHA-256. The CONTENT
 * itself is never carried into the report — only identity and size — so the
 * redaction scan has nothing secret to find.
 *
 * This is what makes a claim auditable: the report can prove exactly which
 * global and project instruction files the measured session loaded, instead of
 * assuming the host injected them. A schema without the instruction tables, or
 * a session without state, is an explicit `unavailable`, never a guess.
 *
 * @param {import('node:sqlite').DatabaseSync} db read-only handle
 * @param {string} sessionId root session id
 */
export function collectInstructionState(db, sessionId) {
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('instruction_state', 'instruction_blob')",
    )
    .all()
    .map((r) => r.name)
  for (const table of ['instruction_state', 'instruction_blob']) {
    if (!names.includes(table)) {
      return { status: 'unavailable', reason: `${table} table not present in this database` }
    }
  }

  const state = db
    .prepare('SELECT current_values FROM instruction_state WHERE session_id = ?')
    .get(sessionId)
  if (!state) {
    return { status: 'unavailable', reason: `no instruction_state row for session ${sessionId}` }
  }
  let values
  try {
    values = JSON.parse(state.current_values)
  } catch {
    return { status: 'unavailable', reason: 'instruction_state.current_values is not valid JSON' }
  }
  const hash = values?.['core/instructions']
  if (typeof hash !== 'string' || hash === '') {
    return {
      status: 'unavailable',
      reason: 'core/instructions hash missing from instruction_state',
    }
  }

  const blob = db.prepare('SELECT value FROM instruction_blob WHERE hash = ?').get(hash)
  if (!blob) {
    return { status: 'unavailable', reason: `instruction_blob ${hash} not found` }
  }
  let entries
  try {
    entries = JSON.parse(blob.value)
  } catch {
    return { status: 'unavailable', reason: 'instruction_blob value is not valid JSON' }
  }
  if (!Array.isArray(entries)) {
    return { status: 'unavailable', reason: 'instruction_blob value is not an array' }
  }

  const items = entries.map((entry) => {
    const content = entry?.content
    const hasContent = typeof content === 'string'
    return {
      path: typeof entry?.path === 'string' ? entry.path : null,
      bytes: hasContent ? Buffer.byteLength(content) : null,
      sha256: hasContent ? createHash('sha256').update(content).digest('hex') : null,
    }
  })
  return {
    status: 'ok',
    hash,
    entryCount: items.length,
    totalBytes: items.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
    entries: items,
  }
}

/**
 * First-request proxy for one session — the metric that isolates the injected
 * instruction payload.
 *
 * The tree-total `tokens.input` sums every assistant turn, so it is dominated
 * by session-length variance; the instruction payload only lands on the FIRST
 * request. The first assistant message's prompt tokens are therefore the
 * closest available proxy for the payload's cost:
 *
 *   contextTokens = tokens.input + tokens.cache.read
 *
 * (`input` excludes the cached prefix; the cached read is part of the same
 * prompt.) V1/unsupported ledgers or a session with no assistant row come back
 * as an explicit `unavailable`, never zero.
 *
 * @param {import('node:sqlite').DatabaseSync} db read-only handle
 * @param {string} sessionId root session id
 */
export function collectFirstRequest(db, sessionId) {
  if (detectSchema(db).generation !== 'v2') {
    return {
      status: 'unavailable',
      reason: 'first-request proxy reads the V2 session_message ledger only',
    }
  }
  const row = db
    .prepare(
      `SELECT data FROM session_message
        WHERE session_id = ? AND type = 'assistant' AND json_valid(data)
        ORDER BY seq LIMIT 1`,
    )
    .get(sessionId)
  if (!row) {
    return { status: 'unavailable', reason: `no assistant row for session ${sessionId}` }
  }
  let data
  try {
    data = JSON.parse(row.data)
  } catch {
    return { status: 'unavailable', reason: 'first assistant row is not valid JSON' }
  }
  const tokens = data?.tokens
  if (!tokens || typeof tokens !== 'object') {
    return { status: 'unavailable', reason: 'first assistant row carries no tokens object' }
  }
  if (typeof tokens.input !== 'number') {
    return { status: 'unavailable', reason: 'first assistant row carries no input token count' }
  }
  if (typeof tokens.cache?.read !== 'number') {
    return {
      status: 'unavailable',
      reason: 'first assistant row carries no cache read token count',
    }
  }
  const input = tokens.input
  const cacheRead = tokens.cache.read
  return { status: 'ok', input, cacheRead, contextTokens: input + cacheRead }
}
