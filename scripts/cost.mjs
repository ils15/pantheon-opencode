#!/usr/bin/env node
/**
 * cost.mjs — read-only token aggregation from opencode.db.
 *
 * CLI fallback for the `pantheon_cost` tool when node:sqlite is unavailable
 * in the plugin process. Uses node:sqlite itself and prints a single JSON
 * object to stdout:
 *   { ok: true, days, rows: [{agent, phase, tokensInput, tokensOutput, tokensTotal}] }
 *   { ok: false, error: "<message>" }          (exit code 1)
 *
 * NEVER writes to the database — opened read-only. Malformed rows are
 * skipped; assistant messages carry the authoritative token usage.
 *
 * Usage: node scripts/cost.mjs --db-path <dbPath> --days <days>
 */
import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

/**
 * Fail via exitCode + natural process exit (NEVER process.exit right after
 * stdout.write — the pipe is async and the write can be truncated).
 */
function fail(message) {
  process.stderr.write(`cost.mjs: ${message}\n`)
  process.stdout.write(JSON.stringify({ ok: false, error: message }))
  process.exitCode = 1
}

function assertCompatibleSchema(db) {
  const table = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message'")
    .get()
  if (!table)
    throw new Error('incompatible opencode.db schema: required "message" table is missing')
  const columns = db.prepare('PRAGMA table_info(message)').all()
  const names = new Set(columns.map((column) => column.name))
  const missing = ['data', 'time_created'].filter((name) => !names.has(name))
  if (missing.length > 0) {
    throw new Error(
      `incompatible opencode.db schema: message table is missing ${missing.join(', ')}; select the matching V1/V2 database`,
    )
  }
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
    assertCompatibleSchema(db)
    const since = Date.now() - days * 86_400_000
    const rows = db.prepare('SELECT data FROM message WHERE time_created >= ?').all(since)
    db.close()

    const byAgent = new Map()
    for (const row of rows) {
      try {
        const outer = JSON.parse(String(row.data))
        const info = typeof outer.data === 'string' ? JSON.parse(outer.data) : outer
        if (info.role !== 'assistant') continue
        const agent = typeof info.agent === 'string' && info.agent !== '' ? info.agent : null
        if (!agent) continue
        const metadata = info.metadata
        const phase =
          (typeof info.phase === 'string' && info.phase) ||
          (typeof metadata?.phase === 'string' && metadata.phase) ||
          'unknown'
        const tokensInput = Number(info.tokens?.input) || 0
        const tokensOutput = Number(info.tokens?.output) || 0
        const key = `${agent}\u0000${phase}`
        const acc = byAgent.get(key) ?? {
          agent,
          phase,
          tokensInput: 0,
          tokensOutput: 0,
          tokensTotal: 0,
        }
        acc.tokensInput += tokensInput
        acc.tokensOutput += tokensOutput
        acc.tokensTotal += tokensInput + tokensOutput
        byAgent.set(key, acc)
      } catch {
        // Skip malformed rows — a partial ledger never breaks the report.
      }
    }
    const result = [...byAgent.values()].sort((a, b) => b.tokensTotal - a.tokensTotal)
    process.stdout.write(JSON.stringify({ ok: true, days, rows: result }))
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
}

main()
