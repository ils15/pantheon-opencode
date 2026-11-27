/**
 * Test fixture for the S4 attach-race probe (N1).
 *
 * Acts as a *concurrent reviewer*: it acquires the write lock, applies the same
 * writes a legitimate BLOCK attach would, signals the parent, holds the lock for
 * `holdMs`, then commits. Used only by `strategy-store.test.ts`.
 */
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'

const [dbPath, signalPath, runId, strategyId, agent, holdMsRaw] = process.argv.slice(2)
if (!dbPath || !signalPath || !runId || !strategyId || !agent) {
  throw new Error('usage: strategy-attach-race <db> <signal> <runId> <strategyId> <agent> [holdMs]')
}
const holdMs = Number(holdMsRaw ?? 1200)

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA busy_timeout = 5000')
db.exec('BEGIN IMMEDIATE')
const now = new Date().toISOString()
db.prepare(
  `UPDATE strategy_runs
      SET themis_verdict = 'BLOCK', success = 0, blocked_at = COALESCE(blocked_at, ?)
    WHERE run_id = ?`,
).run(now, runId)
db.prepare(
  `UPDATE strategy_stats
      SET successes = max(0, successes - 1), objections = objections + 1
    WHERE strategy_id = ? AND agent = ?`,
).run(strategyId, agent)

// The lock is held and the writes are applied but uncommitted: from now on any
// other connection reads the pre-transaction state.
writeFileSync(signalPath, 'locked')
await sleep(holdMs)
db.exec('COMMIT')
db.close()
