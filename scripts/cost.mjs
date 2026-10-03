#!/usr/bin/env node
/**
 * cost.mjs — read-only token aggregation from opencode.db.
 *
 * CLI fallback for the `pantheon_cost` tool when node:sqlite is unavailable
 * in the plugin process. Prints a single JSON object to stdout:
 *   { ok: true, days, rows: [{agent, phase, tokensInput, tokensOutput, tokensTotal}], coverage }
 *   { ok: false, error: "<message>" }          (exit code 1)
 *
 * ## This file is a MIRROR of src/pantheon/cost-command.ts
 *
 * It cannot import that module — it exists precisely to run on a plain Node
 * where the plugin runtime cannot — so the two implementations duplicate the
 * same contract on purpose:
 *   - ledger families are detected by TABLE PRESENCE, never by filename and
 *     never by a pinned host generation;
 *   - PANTHEON_OPENCODE_VERSION only NARROWS an already-detected set;
 *   - V1 marks assistant turns with `data.role`, V2 with the `type` COLUMN
 *     (V2 payloads carry no `role` key at all);
 *   - the coverage counters mean the same thing in both, because the caller
 *     feeds them to the same diagnosis.
 *
 * Every one of those was a real divergence once: this script kept the V1
 * predicate and dropped 100% of a V2 ledger, while the caller reported a
 * successful, empty report. A change to one side that is not made on the other
 * is a regression, not a refactor.
 *
 * NEVER writes to the database — opened read-only. Malformed rows are skipped;
 * assistant messages carry the authoritative token usage.
 *
 * Usage: node scripts/cost.mjs --db-path <dbPath> --days <days>
 */
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

/** Ledger families a host database can carry; a migrated one carries both. */
const COST_SOURCES = ['message', 'session_message']

/** Which family each host generation stores its ledger in. */
const VERSION_SOURCES = { v1: 'message', v2: 'session_message' }

/**
 * Fail via exitCode + natural process exit (NEVER process.exit right after
 * stdout.write — the pipe is async and the write can be truncated).
 */
function fail(message) {
  process.stderr.write(`cost.mjs: ${message}\n`)
  process.stdout.write(JSON.stringify({ ok: false, error: message }))
  process.exitCode = 1
}

/** Read and validate the optional host-generation selector. */
function requestedVersion() {
  const configured = process.env.PANTHEON_OPENCODE_VERSION
  if (configured === undefined || configured === '') return undefined
  if (configured !== 'v1' && configured !== 'v2') {
    throw new Error(`invalid PANTHEON_OPENCODE_VERSION "${configured}"; expected "v1" or "v2"`)
  }
  return configured
}

/**
 * Detect the ledger families by TABLE PRESENCE, then narrow if asked.
 *
 * Presence is the only reliable discriminator: every real installation writes
 * `opencode.db`, and a migrated database carries BOTH families at once.
 */
function resolveSources(db) {
  const present = new Set(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'session_message')",
      )
      .all()
      .map((row) => String(row.name)),
  )
  const detected = COST_SOURCES.filter((source) => present.has(source))
  if (detected.length === 0) {
    throw new Error(
      'incompatible opencode.db schema: neither the "message" nor the "session_message" table exists, so there is no token ledger to read',
    )
  }
  const requested = requestedVersion()
  if (requested === undefined) return detected
  const narrowed = detected.filter((source) => source === VERSION_SOURCES[requested])
  if (narrowed.length === 0) {
    throw new Error(
      `incompatible opencode.db schema: PANTHEON_OPENCODE_VERSION=${requested} selected no table family, but this database contains ${detected.join(' and ')}`,
    )
  }
  return narrowed
}

/** The columns this reader needs from the family it is about to query. */
function assertColumns(db, source) {
  const names = new Set(
    db
      .prepare(`PRAGMA table_info(${source})`)
      .all()
      .map((column) => String(column.name)),
  )
  const required =
    source === 'session_message' ? ['data', 'time_created', 'type'] : ['data', 'time_created']
  const missing = required.filter((name) => !names.has(name))
  if (missing.length > 0) {
    throw new Error(
      `incompatible opencode.db schema: ${source} table is missing ${missing.join(', ')}; select a database whose token layout this build understands`,
    )
  }
}

/**
 * Parse one payload. Returns undefined for anything unparseable, which is how
 * both readers treat it: the V1 counter requires json_valid(data) and the V2
 * aggregate does too, so a malformed row contributes to nothing.
 *
 * Deliberately NOT unwrapping a nested `data` string: the in-process reader
 * extracts `$.role`/`$.agent` from the TOP level, so a wrapped payload yields
 * NULL there and is dropped. Unwrapping here would resurrect rows the primary
 * path cannot see, and the two readers would disagree on the same file.
 */
function readPayload(data) {
  try {
    const parsed = JSON.parse(String(data))
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/** CAST(json_extract(...) AS INTEGER) semantics: absent or non-numeric → 0. */
function toToken(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Map key for one aggregated row.
 *
 * NUL-separated: agent names cannot contain it, so an agent whose name ends
 * in the phase cannot collide with a phase-only row.
 */
function rowKey(agent, phase) {
  return `${agent}\u0000${phase}`
}

/** Read one family.
 *
 * `assistantRows` follows the per-generation discriminator exactly, including
 * the asymmetry that matters: V2 counts an assistant row by its COLUMN whether
 * or not the payload parses, because that counter SQL has no json_valid gate.
 */
function readSource(db, source, since) {
  const windowRow = db
    .prepare(
      `SELECT COUNT(*) AS scanned, MIN(time_created) AS windowStart FROM ${source} WHERE time_created >= ?`,
    )
    .get(since)
  const databaseRow = db.prepare(`SELECT MIN(time_created) AS databaseStart FROM ${source}`).get()
  const select = source === 'session_message' ? 'SELECT type, data' : 'SELECT data'
  const rows = db.prepare(`${select} FROM ${source} WHERE time_created >= ?`).all(since)

  const groups = new Map()
  let assistantRows = 0
  for (const row of rows) {
    const info = readPayload(row.data)
    if (source === 'session_message') {
      if (row.type !== 'assistant') continue
      assistantRows += 1
      if (info === undefined) continue
    } else {
      if (info === undefined || info.role !== 'assistant') continue
      assistantRows += 1
    }
    const rawAgent = info.agent
    const agent = rawAgent == null ? '' : typeof rawAgent === 'string' ? rawAgent : String(rawAgent)
    if (agent === '') continue
    // V2 has no phase anywhere: its SQL emits the literal, so the mirror does
    // too rather than inventing a column the reader never had.
    const metadata = info.metadata
    const phase =
      source === 'session_message'
        ? 'unknown'
        : (typeof info.phase === 'string' && info.phase) ||
          (typeof metadata?.phase === 'string' && metadata.phase) ||
          'unknown'
    const tokensInput = toToken(info.tokens?.input)
    const tokensOutput = toToken(info.tokens?.output)
    const key = rowKey(agent, phase)
    const acc = groups.get(key) ?? {
      agent,
      phase,
      tokensInput: 0,
      tokensOutput: 0,
      tokensTotal: 0,
    }
    acc.tokensInput += tokensInput
    acc.tokensOutput += tokensOutput
    acc.tokensTotal += tokensInput + tokensOutput
    groups.set(key, acc)
  }

  return {
    groups,
    scanned: Number(windowRow?.scanned ?? 0) || 0,
    windowStart: numberOrUndefined(windowRow?.windowStart),
    databaseStart: numberOrUndefined(databaseRow?.databaseStart),
    assistantRows,
  }
}

function numberOrUndefined(value) {
  if (value === null || value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * The same verdict the in-process reader reaches, with the same phrase: the
 * caller maps "no readable token source" to UNSUPPORTED, so emitting anything
 * softer here would resurrect the silent-empty-report failure this replaced.
 *
 * `scanned === 0` is NOT unreadable — an empty window is a real, reportable
 * answer, and only a ledger that was found and could not be read is a fault.
 */
function diagnoseUnreadableLedger(coverage, rows, days) {
  if (coverage.scanned === 0) return undefined
  const tables = coverage.sources.join(' and ')
  if (coverage.assistantRows === 0) {
    return (
      `no readable token source: ${coverage.scanned} row(s) were scanned in the last ${days} day(s) ` +
      `but none matched the assistant discriminator of ${tables}, so no usage can be attributed. ` +
      'This is an unrecognised ledger layout, not an empty one; point PANTHEON_COST_DB at a ' +
      'database whose token layout this build understands.'
    )
  }
  if (!rows.some((row) => row.tokensInput !== 0 || row.tokensOutput !== 0)) {
    return (
      `no readable token source: ${coverage.assistantRows} assistant row(s) were found in ${tables} ` +
      'but none carried both an attributable agent and a token payload, so no usage can be ' +
      'attributed. This is an unrecognised ledger layout, not an empty one.'
    )
  }
  return undefined
}

function main() {
  const argv = process.argv.slice(2)
  const valueFor = (name) => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const dbPath = valueFor('--db-path')
  const days = Number(valueFor('--days') ?? '7')

  if (!dbPath) return fail('missing <dbPath> argument')
  if (!existsSync(dbPath)) return fail(`database not found: ${dbPath}`)

  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const sources = resolveSources(db)
    for (const source of sources) assertColumns(db, source)
    const since = Date.now() - days * 86_400_000

    const byAgent = new Map()
    const coverage = { sources: [], scanned: 0, assistantRows: 0 }
    const note = (key, value) => {
      if (value === undefined) return
      const current = coverage[key]
      coverage[key] = current === undefined ? value : Math.min(current, value)
    }
    for (const source of sources) {
      const read = readSource(db, source, since)
      for (const row of read.groups.values()) {
        const key = rowKey(row.agent, row.phase)
        const acc = byAgent.get(key) ?? {
          agent: row.agent,
          phase: row.phase,
          tokensInput: 0,
          tokensOutput: 0,
          tokensTotal: 0,
        }
        acc.tokensInput += row.tokensInput
        acc.tokensOutput += row.tokensOutput
        acc.tokensTotal += row.tokensInput + row.tokensOutput
        byAgent.set(key, acc)
      }
      coverage.sources.push(source)
      coverage.scanned += read.scanned
      coverage.assistantRows += read.assistantRows
      note('windowStart', read.windowStart)
      note('databaseStart', read.databaseStart)
    }
    db.close()

    const result = [...byAgent.values()].sort((a, b) => b.tokensTotal - a.tokensTotal)
    const unreadable = diagnoseUnreadableLedger(coverage, result, days)
    if (unreadable !== undefined) return fail(unreadable)
    process.stdout.write(JSON.stringify({ ok: true, days, rows: result, coverage }))
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
}

main()
