/**
 * Test fixture for the S4 attach-race probe (N1).
 *
 * Acts as a *concurrent reviewer*: it acquires the write lock, applies the same
 * BLOCK a production attach applies, signals the parent, holds the lock for
 * `holdMs`, then commits. Used only by `strategy-store.test.ts`.
 *
 * The three statements are imported from `strategy-store.ts` (the exact SQL the
 * production attach runs) so this fixture cannot drift into testing a copy.
 */
import { writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  BLOCK_AGGREGATE_SQL,
  BLOCK_FLAG_SQL,
  BLOCK_VERDICT_SQL,
} from '../../../src/pantheon/strategy-store.ts'

const [dbPath, signalPath, runId, holdMsRaw] = process.argv.slice(2)
if (!dbPath || !signalPath || !runId) {
  throw new Error('usage: strategy-attach-race <db> <signal> <runId> [holdMs]')
}
const holdMs = Number(holdMsRaw ?? 1200)

const db = new DatabaseSync(dbPath)
db.exec('PRAGMA busy_timeout = 5000')
db.exec('BEGIN IMMEDIATE')
const target = db
  .prepare('SELECT id, strategy_id, agent, success FROM strategy_runs WHERE run_id = ?')
  .get(runId) as { id: number; strategy_id: string; agent: string; success: number } | undefined
if (!target) throw new Error(`no run ${runId}`)

const now = new Date().toISOString()
db.prepare(BLOCK_VERDICT_SQL).run('BLOCK', target.id)
db.prepare(BLOCK_FLAG_SQL).run(now, target.id)
db.prepare(BLOCK_AGGREGATE_SQL).run(
  Number(target.success) === 1 ? 1 : 0,
  1,
  target.strategy_id,
  target.agent,
)

// The lock is held and the writes are applied but uncommitted: from now on any
// other connection reads the pre-transaction state.
writeFileSync(signalPath, 'locked')
await sleep(holdMs)
db.exec('COMMIT')
db.close()
