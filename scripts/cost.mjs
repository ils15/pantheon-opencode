#!/usr/bin/env node
/**
 * cost.mjs — read-only cost aggregation from opencode.db (Wave 4, PR #46).
 *
 * Fallback for the `pantheon_cost` tool when node:sqlite is unavailable in
 * the plugin process (node < 22.5). Uses node:sqlite itself and prints a
 * single JSON object to stdout:
 *   { ok: true,  days, rows: [{agent, costUsd, tokensInput, tokensOutput}] }
 *   { ok: false, error: "<message>" }          (exit code 1)
 *
 * NEVER writes to the database — opened read-only. Malformed rows are
 * skipped; assistant messages carry the authoritative cost + tokens.
 *
 * Usage: node scripts/cost.mjs <dbPath> <days>
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
  const [, , dbPath, daysArg] = process.argv
  const days = Number(daysArg ?? '7')

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
        const costUsd = Number(info.cost) || 0
        const tokensInput = Number(info.tokens?.input) || 0
        const tokensOutput = Number(info.tokens?.output) || 0
        const acc = byAgent.get(agent) ?? { agent, costUsd: 0, tokensInput: 0, tokensOutput: 0 }
        acc.costUsd += costUsd
        acc.tokensInput += tokensInput
        acc.tokensOutput += tokensOutput
        byAgent.set(agent, acc)
      } catch {
        // Skip malformed rows — a partial ledger never breaks the report.
      }
    }
    const result = [...byAgent.values()].sort((a, b) => b.costUsd - a.costUsd)
    process.stdout.write(JSON.stringify({ ok: true, days, rows: result }))
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err))
  }
}

main()
