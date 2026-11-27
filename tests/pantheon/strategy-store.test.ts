/**
 * S4 — `strategy_success_rates` (v2.3.5 swarm hardening).
 *
 * Drives acceptance S4-1..S4-7 from `.pantheon/deepwork/v235-swarm-hardening/DESIGN.md`
 * (FTS5 BM25 only — no embeddings, no sqlite-vec, no Ollama, no network).
 * S4-8 is the `native-memory-tools.test.ts` guard, run separately and unchanged.
 *
 * Time is never slept on: every window-dependent assertion injects `now` or
 * seeds explicit `created_at`/`last_seen` fixtures.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createNativeMemoryAndPersistenceTools } from '../../src/pantheon/native-memory-tools.ts'
import { createReviewVerdictTool } from '../../src/pantheon/review-verdict.ts'
import { createStepLedgerTool, readStepLedger } from '../../src/pantheon/step-ledger.ts'
import {
  attachThemisVerdict,
  computeDecay,
  computeEffectiveStatus,
  deriveStrategyKey,
  ensureStrategySchema,
  openStrategyDb,
  pruneStrategyRuns,
  queryStrategies,
  recordStrategyRun,
  recordStrategyRunSafe,
  resolveRetentionPolicy,
  resolveStrategyPolicy,
  STRATEGY_SCHEMA_VERSION,
  strategyStats,
} from '../../src/pantheon/strategy-store.ts'
import { createStrategyTool } from '../../src/pantheon/strategy-tool.ts'
import type { PantheonToolDef, V2ToolDef } from '../../src/pantheon/tools.ts'

type Json = Record<string, unknown>

const DAY_MS = 86_400_000
const createdDirs: string[] = []

test.after(() => {
  for (const dir of createdDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* open handles on some platforms */
    }
  }
})

/** Fresh workspace with HOME/XDG confined to it (auto-migration must not touch the real HOME). */
function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pantheon-strategy-'))
  createdDirs.push(dir)
  process.env.HOME = dir
  process.env.XDG_CONFIG_HOME = join(dir, '.config')
  return dir
}

function withEnv<T>(patch: Record<string, string>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {}
  for (const key of Object.keys(patch)) previous[key] = process.env[key]
  Object.assign(process.env, patch)
  try {
    return fn()
  } finally {
    for (const key of Object.keys(patch)) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

function iso(date: Date): string {
  return date.toISOString()
}

function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA schema_version').get() as { schema_version?: number } | undefined
  return Number(row?.schema_version ?? -1)
}

function objectNames(db: DatabaseSync, type: string): string[] {
  const rows = db
    .prepare('SELECT name FROM sqlite_master WHERE type = ? ORDER BY name')
    .all(type) as Array<{ name: string }>
  return rows.map((row) => row.name)
}

async function callTool(
  tools: Map<string, V2ToolDef>,
  name: string,
  input: Json,
  ctx: unknown,
): Promise<Json> {
  const tool = tools.get(name)
  assert.ok(tool, `expected tool ${name} to be registered`)
  const res = await tool.execute(input, ctx)
  return JSON.parse(res.output) as Json
}

async function call(tool: PantheonToolDef, input: Json, ctx: unknown = {}): Promise<Json> {
  const res = await tool.execute(input, ctx)
  return JSON.parse(res.output) as Json
}

function initGitRepo(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@pantheon.dev'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Pantheon Test'], { cwd: dir })
  writeFileSync(join(dir, 'app.ts'), 'export const version = 1\n')
  execFileSync('git', ['add', 'app.ts'], { cwd: dir })
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir })
}

// ── S4-1: schema + idempotent open ────────────────────────────────────────

test('S4-1 strategy tables, view and indexes exist; re-open applies no DDL', () => {
  const dir = workspace()
  const db = openStrategyDb(dir)

  assert.deepEqual(
    objectNames(db, 'table')
      .filter((name) => name.startsWith('strategy_'))
      // FTS5 allocates its own shadow tables (…_fts_data/_idx/_docsize/_config).
      .filter((name) => !/^strategy_docs_fts_/.test(name)),
    [
      'strategy_docs',
      'strategy_docs_fts',
      'strategy_meta',
      'strategy_objections',
      'strategy_runs',
      'strategy_stats',
    ],
  )
  assert.ok(objectNames(db, 'view').includes('strategy_effective'))
  assert.deepEqual(
    objectNames(db, 'index').filter((name) => name.startsWith('idx_strategy_runs_')),
    ['idx_strategy_runs_created', 'idx_strategy_runs_step', 'idx_strategy_runs_strategy'],
  )
  assert.ok(objectNames(db, 'index').includes('idx_strategy_objections_created'))
  // `blocked_at` is the once-per-run objection marker (N4).
  assert.ok(
    (db.prepare('PRAGMA table_info(strategy_runs)').all() as Array<{ name: string }>).some(
      (column) => column.name === 'blocked_at',
    ),
  )

  const meta = db.prepare("SELECT value FROM strategy_meta WHERE key = 'schema_version'").get() as
    | { value?: string }
    | undefined
  assert.equal(meta?.value, STRATEGY_SCHEMA_VERSION)
  assert.equal(STRATEGY_SCHEMA_VERSION, '2')

  // The FTS mirror is wired exactly like memories_fts: external content + 3 triggers.
  const triggers = objectNames(db, 'trigger').filter((name) => name.startsWith('strategy_docs_'))
  assert.deepEqual(triggers, ['strategy_docs_ad', 'strategy_docs_ai', 'strategy_docs_au'])

  const before = schemaVersion(db)
  const reopened = openStrategyDb(dir)
  assert.equal(reopened, db, 'the shared per-path handle must be reused')
  assert.equal(schemaVersion(db), before)

  // A brand-new handle (fresh process equivalent) must skip DDL via strategy_meta.
  const raw = new DatabaseSync(join(dir, '.pantheon', 'memory', 'memory.db'))
  try {
    const report = ensureStrategySchema(raw)
    assert.equal(report.applied, false, 'schema_version=2 must short-circuit the migration')
    assert.equal(report.schemaVersion, STRATEGY_SCHEMA_VERSION)
    assert.equal(report.from, STRATEGY_SCHEMA_VERSION)
    assert.equal(schemaVersion(raw), before, 'no DDL means no schema_version bump')
    assert.equal(
      db.prepare('SELECT count(*) AS n FROM strategy_meta').get()?.n,
      1,
      'the guard row is never duplicated',
    )
  } finally {
    raw.close()
  }
})

test('S4-1b a v1 store upgrades in place to v2, then re-open is a no-op', () => {
  const dir = workspace()
  const db = openStrategyDb(dir)
  // Rewind to a v1-shaped store: no objection table, no blocked_at marker.
  db.exec('DROP TABLE strategy_objections')
  db.exec('ALTER TABLE strategy_runs DROP COLUMN blocked_at')
  db.prepare("UPDATE strategy_meta SET value = '1' WHERE key = 'schema_version'").run()

  const upgraded = ensureStrategySchema(db)
  assert.equal(upgraded.applied, true)
  assert.equal(upgraded.from, '1')
  assert.equal(upgraded.schemaVersion, STRATEGY_SCHEMA_VERSION)
  assert.ok(objectNames(db, 'table').includes('strategy_objections'))
  assert.ok(
    (db.prepare('PRAGMA table_info(strategy_runs)').all() as Array<{ name: string }>).some(
      (column) => column.name === 'blocked_at',
    ),
  )
  assert.equal(
    db.prepare("SELECT value FROM strategy_meta WHERE key = 'schema_version'").get()?.value,
    STRATEGY_SCHEMA_VERSION,
  )

  const again = ensureStrategySchema(db)
  assert.equal(again.applied, false)
  assert.equal(again.from, STRATEGY_SCHEMA_VERSION)
})

// ── S4-2: ladder ──────────────────────────────────────────────────────────

test('S4-2 three successes promote to proven, three failures above 0.6 become anti_pattern', () => {
  const dir = workspace()
  const now = new Date('2026-06-01T00:00:00.000Z')

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const rec = recordStrategyRun(dir, {
      strategyId: 'parallel-fanout',
      agent: 'hermes',
      success: true,
      stepKey: `wave-a-${attempt}`,
      attempt,
      createdAt: iso(now),
    })
    assert.equal(rec.recorded, true)
  }
  const proven = queryStrategies(dir, { strategyId: 'parallel-fanout', now })
  assert.equal(proven.count, 1)
  assert.equal(proven.results[0]?.attempts, 3)
  assert.equal(proven.results[0]?.success_rate, 1)
  assert.equal(proven.results[0]?.status, 'proven')

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    recordStrategyRun(dir, {
      strategyId: 'serial-retry',
      agent: 'hermes',
      success: false,
      stepKey: `serial-${attempt}`,
      attempt,
      errorClass: 'verification_failed',
      createdAt: iso(now),
    })
  }
  const anti = queryStrategies(dir, { strategyId: 'serial-retry', now })
  assert.equal(anti.results[0]?.failure_rate, 1)
  assert.equal(anti.results[0]?.status, 'anti_pattern')

  // Two attempts are never enough, whatever the rate.
  recordStrategyRun(dir, {
    strategyId: 'too-new',
    agent: 'themis',
    success: true,
    createdAt: iso(now),
  })
  recordStrategyRun(dir, {
    strategyId: 'too-new',
    agent: 'themis',
    success: true,
    createdAt: iso(now),
  })
  assert.equal(queryStrategies(dir, { strategyId: 'too-new', now }).results[0]?.status, 'candidate')

  // The promotion threshold is D02's 0.8 by default and configurable, but only
  // through a validated value; an unusable value falls back and says so.
  const boundary = 'edge-0.8'
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    recordStrategyRun(dir, {
      strategyId: boundary,
      agent: 'athena',
      success: attempt <= 4,
      createdAt: iso(now),
    })
  }
  withEnv({ PANTHEON_STRATEGY_PROMOTION_MIN: '0.81' }, () => {
    assert.equal(
      queryStrategies(dir, { strategyId: boundary, now }).results[0]?.status,
      'candidate',
    )
  })
  withEnv({ PANTHEON_STRATEGY_PROMOTION_MIN: '0.8' }, () => {
    assert.equal(queryStrategies(dir, { strategyId: boundary, now }).results[0]?.status, 'proven')
  })
  withEnv({ PANTHEON_STRATEGY_PROMOTION_MIN: 'not-a-number' }, () => {
    const policy = resolveStrategyPolicy()
    assert.equal(policy.promotionMin, 0.8)
    assert.equal(policy.promotionMinInvalid, true)
    assert.equal(policy.promotionMinSource, 'default')
  })

  // Failure == 0.6 exactly is NOT an anti-pattern (> 0.6 is the rule).
  const boundaryFailure = 'edge-failure-0.6'
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    recordStrategyRun(dir, {
      strategyId: boundaryFailure,
      agent: 'athena',
      success: attempt <= 2,
      createdAt: iso(now),
    })
  }
  assert.equal(
    queryStrategies(dir, { strategyId: boundaryFailure, now }).results[0]?.status,
    'candidate',
  )

  // Pure ladder: mutually exclusive by construction, candidate below 3 attempts.
  const policy = resolveStrategyPolicy({})
  assert.equal(computeEffectiveStatus(3, 3, policy), 'proven')
  assert.equal(computeEffectiveStatus(3, 0, policy), 'anti_pattern')
  assert.equal(computeEffectiveStatus(2, 2, policy), 'candidate')

  // Aggregate rows survive as one per (strategy_id, agent).
  const stats = strategyStats(dir, { now })
  assert.equal(stats.strategies, 5)
  assert.equal(stats.by_status.proven, 2)
  assert.equal(stats.by_status.anti_pattern, 1)
  assert.equal(stats.by_status.candidate, 2)
})

// ── S4-3: decay ───────────────────────────────────────────────────────────

test('S4-3 decay is ~0.5 at 45 days and 0 at 90+ days', () => {
  const now = new Date('2026-06-01T00:00:00.000Z')
  assert.equal(computeDecay(iso(new Date(now.getTime() - 45 * DAY_MS)), now), 0.5)
  assert.equal(computeDecay(iso(new Date(now.getTime() - 90 * DAY_MS)), now), 0)
  assert.equal(computeDecay(iso(new Date(now.getTime() - 400 * DAY_MS)), now), 0)
  assert.equal(computeDecay(iso(new Date(now.getTime() + 45 * DAY_MS)), now), 1, 'never > 1')
  assert.equal(computeDecay('not-a-date', now), 0, 'unparseable timestamps decay to zero')

  const dir = workspace()
  const realNow = new Date()
  recordStrategyRun(dir, {
    strategyId: 'aged',
    agent: 'hermes',
    success: true,
    createdAt: iso(new Date(realNow.getTime() - 45 * DAY_MS)),
  })
  const aged = queryStrategies(dir, { strategyId: 'aged', now: realNow }).results[0]
  assert.ok(aged, 'aged strategy must still be queryable')
  assert.ok(Math.abs(Number(aged.decay) - 0.5) < 1e-6, `decay=${String(aged.decay)}`)
  assert.ok(Math.abs(Number(aged.success_rate) - 1) < 1e-9)

  // The SQL view is the read model for non-tool consumers and must agree.
  const db = openStrategyDb(dir)
  const viewRow = db
    .prepare("SELECT decay, effective_status FROM strategy_effective WHERE strategy_id = 'aged'")
    .get() as { decay?: number; effective_status?: string } | undefined
  assert.ok(viewRow, 'strategy_effective must expose the aggregate')
  assert.ok(Math.abs(Number(viewRow.decay) - 0.5) < 1e-4, `view decay=${String(viewRow.decay)}`)
  assert.equal(viewRow.effective_status, 'candidate')

  // Ranking is success_rate * decay DESC, attempts DESC.
  const ranked = queryStrategies(dir, { now: realNow }).results
  assert.deepEqual(
    ranked.map((row) => row.strategy_id),
    ['aged'],
  )
})

// ── S4-4: retention ───────────────────────────────────────────────────────

test('S4-4 prune drops expired runs and enforces max-rows while keeping aggregates', () => {
  const dir = workspace()
  const now = new Date('2026-06-01T00:00:00.000Z')

  recordStrategyRun(dir, {
    strategyId: 'stale',
    agent: 'hermes',
    success: true,
    createdAt: iso(new Date(now.getTime() - 45 * DAY_MS)),
  })
  recordStrategyRun(dir, {
    strategyId: 'fresh',
    agent: 'hermes',
    success: false,
    createdAt: iso(now),
  })

  const pruned = pruneStrategyRuns(dir, { now })
  assert.equal(pruned.deletedByAge, 1)
  assert.equal(pruned.deletedByRows, 0)
  assert.equal(pruned.remainingRuns, 1)
  assert.equal(pruned.aggregateRows, 2, 'aggregates are never pruned')

  const stale = queryStrategies(dir, { strategyId: 'stale', now }).results[0]
  assert.equal(stale?.attempts, 1)
  assert.equal(stale?.successes, 1)

  // max-rows: 8 fresh runs, cap 5 → the 3 oldest rows go, all 8 aggregates stay.
  const capped = workspace()
  withEnv({ PANTHEON_STRATEGY_MAX_ROWS: '5' }, () => {
    for (let i = 0; i < 8; i += 1) {
      recordStrategyRun(capped, {
        strategyId: `cap-${i}`,
        agent: 'zeus',
        success: i % 2 === 0,
        createdAt: iso(new Date(now.getTime() + i * 1000)),
      })
    }
    const capPrune = pruneStrategyRuns(capped, { now: new Date(now.getTime() + 10_000) })
    assert.equal(capPrune.deletedByAge, 0)
    assert.equal(capPrune.deletedByRows, 3)
    assert.equal(capPrune.remainingRuns, 5)
    assert.equal(capPrune.aggregateRows, 8)
    const kept = openStrategyDb(capped)
      .prepare('SELECT strategy_id FROM strategy_runs ORDER BY id')
      .all() as Array<{ strategy_id: string }>
    assert.deepEqual(
      kept.map((row) => row.strategy_id),
      ['cap-3', 'cap-4', 'cap-5', 'cap-6', 'cap-7'],
      'the newest rows are the survivors',
    )
  })

  // Invalid retention config is not silently authoritative.
  withEnv({ PANTHEON_STRATEGY_MAX_AGE_DAYS: '-5', PANTHEON_STRATEGY_MAX_ROWS: '0' }, () => {
    const retention = resolveRetentionPolicy()
    assert.equal(retention.maxAgeDays, 30)
    assert.equal(retention.maxRows, 10_000)
    assert.equal(retention.maxAgeInvalid, true)
    assert.equal(retention.maxRowsInvalid, true)
  })
})

test('S4-4b every 50th insert prunes automatically and the payload reports it', () => {
  const dir = workspace()
  const now = new Date('2026-06-01T00:00:00.000Z')
  const old = iso(new Date(now.getTime() - 60 * DAY_MS))

  let last: Json | undefined
  for (let i = 0; i < 50; i += 1) {
    last = recordStrategyRun(dir, {
      strategyId: 'churn',
      agent: 'hermes',
      success: true,
      stepKey: `churn-${i}`,
      createdAt: old,
    }) as unknown as Json
    if (i < 49) assert.equal((last.prune as Json)?.applied, false)
  }
  assert.equal((last?.prune as Json)?.applied, true)
  assert.ok(Number((last?.prune as Json)?.deletedByAge) >= 49)

  const db = openStrategyDb(dir)
  const runs = db.prepare('SELECT count(*) AS n FROM strategy_runs').get() as { n: number }
  assert.ok(runs.n <= 1, `old runs must be gone, found ${String(runs.n)}`)
  const aggregate = db
    .prepare("SELECT attempts, successes FROM strategy_stats WHERE strategy_id = 'churn'")
    .get() as { attempts?: number; successes?: number } | undefined
  assert.equal(aggregate?.attempts, 50, 'aggregates keep every attempt, even pruned ones')
  assert.equal(aggregate?.successes, 50)
})

// ── S4-5: isolation from memories ─────────────────────────────────────────

test('S4-5 a seeded memory is still returned by memory_search after the strategy DDL and writes', async () => {
  const dir = workspace()
  const tools = new Map(createNativeMemoryAndPersistenceTools(dir).map((tool) => [tool.name, tool]))
  const ctx = { directory: dir, sessionID: 'ses_s4_mem' }

  const stored = await callTool(
    tools,
    'memory_store',
    {
      namespace: 'auth',
      key: 'jwt-rotation',
      value: 'Use asymmetric RS256 refresh token rotation with strict 15m access TTL.',
    },
    ctx,
  )
  assert.equal(stored.ok, true)

  // Strategy DDL + aggregates land in the very same memory.db file.
  openStrategyDb(dir)
  for (let i = 0; i < 3; i += 1) {
    recordStrategyRun(dir, {
      strategyId: 'parallel-fanout',
      agent: 'hermes',
      success: true,
      summary: 'parallel fan-out over independent verification slices',
      createdAt: new Date().toISOString(),
    })
  }
  pruneStrategyRuns(dir, { now: new Date() })

  const search = await callTool(
    tools,
    'memory_search',
    { query: 'RS256 rotation', namespace: 'auth' },
    ctx,
  )
  assert.equal(search.ok, true)
  assert.equal(search.count, 1)
  const results = search.results as Array<Json>
  assert.equal(results[0]?.key, 'jwt-rotation')
  assert.match(String(results[0]?.value), /RS256/)

  const storedAfter = await callTool(
    tools,
    'memory_store',
    { namespace: 'auth', key: 'after-strategy', value: 'memory writes keep working' },
    ctx,
  )
  assert.equal(storedAfter.ok, true)
  const stats = await callTool(tools, 'memory_stats', {}, ctx)
  assert.equal(stats.ok, true)

  // Strategy tables are never federated nor smuggled into memory results.
  assert.ok(!JSON.stringify(search).includes('strategy_id'))
})

// ── S4-6: FTS query returns the ladder fields ──────────────────────────────

test('S4-6 an FTS5 BM25 query returns success_rate and decay', () => {
  const dir = workspace()
  const now = new Date('2026-06-01T00:00:00.000Z')

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    recordStrategyRun(dir, {
      strategyId: 'slice-verify',
      agent: 'hermes',
      success: attempt <= 3,
      summary: 'slice verification before fan-out with ordered waves',
      createdAt: iso(now),
    })
  }
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    recordStrategyRun(dir, {
      strategyId: 'single-shot',
      agent: 'themis',
      success: true,
      summary: 'single agent single pass review, no fan-out',
      createdAt: iso(now),
    })
  }

  const hit = queryStrategies(dir, { query: 'fan-out verification', now })
  assert.equal(hit.ok, true)
  assert.equal(hit.fts, true, 'the FTS5 index must answer this query')
  const ids = hit.results.map((row) => row.strategy_id)
  assert.ok(ids.includes('slice-verify'), `expected slice-verify in ${ids.join(',')}`)
  const row = hit.results.find((entry) => entry.strategy_id === 'slice-verify')
  assert.ok(row, 'matching strategy must be returned')
  assert.equal(row.attempts, 4)
  assert.equal(row.successes, 3)
  assert.ok(Math.abs(Number(row.success_rate) - 0.75) < 1e-9)
  assert.ok(Math.abs(Number(row.failure_rate) - 0.25) < 1e-9)
  assert.equal(row.decay, 1)
  assert.equal(row.status, 'candidate')
  assert.equal(typeof row.last_seen, 'string')

  const none = queryStrategies(dir, { query: 'quantum embeddings', now })
  assert.equal(none.count, 0)
})

// ── S4-7: Themis BLOCK forces success=0 ───────────────────────────────────

test('S4-7 a Themis BLOCK forces success=0 and increments objections exactly once', () => {
  const dir = workspace()
  const now = new Date('2026-06-01T00:00:00.000Z')

  const recorded = recordStrategyRun(dir, {
    strategyId: 'fast-merge',
    agent: 'hermes',
    success: true,
    stepKey: 'step-7',
    attempt: 1,
    createdAt: iso(now),
  })
  assert.equal(recorded.recorded, true)

  const blocked = attachThemisVerdict(dir, { verdict: 'BLOCK', stepKey: 'step-7', now })
  assert.equal(blocked.ok, true)
  assert.equal(blocked.attached, true)
  assert.equal(blocked.runId, 'step-7:1')
  assert.equal(blocked.forcedSuccessZero, true)
  assert.equal(blocked.objections, 1)

  const db = openStrategyDb(dir)
  const run = db
    .prepare("SELECT success, themis_verdict FROM strategy_runs WHERE run_id = 'step-7:1'")
    .get()
  assert.deepEqual({ ...run }, { success: 0, themis_verdict: 'BLOCK' })
  const hit = queryStrategies(dir, { strategyId: 'fast-merge', now }).results[0]
  assert.equal(hit?.successes, 0)
  assert.equal(hit?.objections, 1)
  assert.equal(hit?.success_rate, 0)

  // Idempotent: re-attaching the same BLOCK never double-counts the objection.
  const again = attachThemisVerdict(dir, { verdict: 'BLOCK', stepKey: 'step-7', now })
  assert.equal(again.attached, true)
  assert.equal(again.objections, 1)
  assert.equal(again.forcedSuccessZero, false)

  // BLOCK on record (no later attach) is applied immediately.
  const direct = recordStrategyRun(dir, {
    strategyId: 'fast-merge',
    agent: 'hermes',
    success: true,
    stepKey: 'step-7',
    attempt: 2,
    themisVerdict: 'BLOCK',
    createdAt: iso(now),
  })
  assert.equal(direct.success, false)
  assert.equal(direct.forcedSuccessZero, true)
  assert.equal(direct.objections, 2)
  assert.equal(queryStrategies(dir, { strategyId: 'fast-merge', now }).results[0]?.success_rate, 0)

  // No run to attach to is reported, never invented.
  const orphan = attachThemisVerdict(dir, { verdict: 'BLOCK', stepKey: 'never-ran', now })
  assert.equal(orphan.ok, true)
  assert.equal(orphan.attached, false)
  assert.equal(orphan.reason, 'no_run')

  // Review verdict value validation is the tool's job, but an unknown verdict
  // must not be able to touch aggregates.
  assert.equal(
    recordStrategyRunSafe(dir, { strategyId: '  ', agent: 'hermes', success: true }).ok,
    false,
  )
  const badVerdict = recordStrategyRunSafe(dir, {
    strategyId: 'fast-merge',
    agent: 'hermes',
    success: true,
    themisVerdict: 'MAYBE',
  })
  assert.equal(badVerdict.ok, false, 'an unparseable verdict is reported, never silently dropped')
  assert.match(String(badVerdict.error), /themisVerdict/)
})

// ── N2: a step-less BLOCK never demotes an unrelated strategy ─────────────

test('N2 a step-less BLOCK refuses to guess instead of demoting an unrelated strategy', () => {
  const dir = workspace()
  const now = new Date('2026-06-01T12:00:00.000Z')
  const minutesAgo = (minutes: number) => iso(new Date(now.getTime() - minutes * 60_000))

  // A proven strategy and a more recent, different strategy for the same agent.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    recordStrategyRun(dir, {
      strategyId: 'prod-merge',
      agent: 'hermes',
      success: true,
      stepKey: `pm-${attempt}`,
      attempt: 1,
      createdAt: minutesAgo(30),
    })
  }
  recordStrategyRun(dir, {
    strategyId: 'spike-docs',
    agent: 'hermes',
    success: true,
    stepKey: 'sd-1',
    attempt: 1,
    createdAt: minutesAgo(5),
  })

  const beforeHit = queryStrategies(dir, { strategyId: 'prod-merge', now }).results[0]
  assert.equal(beforeHit?.status, 'proven')

  const ambiguous = attachThemisVerdict(dir, { verdict: 'BLOCK', agent: 'hermes', now })
  assert.equal(ambiguous.ok, true)
  assert.equal(ambiguous.attached, false)
  assert.equal(ambiguous.reason, 'ambiguous_target')
  assert.ok((ambiguous.unattributedObjectionId ?? 0) > 0)
  const candidateStrategies = new Set((ambiguous.candidates ?? []).map((c) => c.strategyId))
  assert.deepEqual([...candidateStrategies].sort(), ['prod-merge', 'spike-docs'])
  assert.ok((ambiguous.candidates ?? []).length <= 5)

  // Nothing was demoted: the unrelated `proven` strategy keeps its sample.
  const afterHit = queryStrategies(dir, { strategyId: 'prod-merge', now }).results[0]
  assert.equal(afterHit?.status, 'proven')
  assert.equal(afterHit?.successes, 3)
  assert.equal(afterHit?.objections, 0)

  // An anchor attaches to exactly that run — no guessing involved.
  const anchored = attachThemisVerdict(dir, { verdict: 'BLOCK', stepKey: 'sd-1', now })
  assert.equal(anchored.attached, true)
  assert.equal(anchored.runId, 'sd-1:1')

  // One run inside the recency window is unambiguous and does attach.
  recordStrategyRun(dir, {
    strategyId: 'fresh-only',
    agent: 'themis',
    success: true,
    stepKey: 'fo-1',
    attempt: 1,
    createdAt: minutesAgo(2),
  })
  const single = attachThemisVerdict(dir, { verdict: 'BLOCK', agent: 'themis', now })
  assert.equal(single.attached, true)
  assert.equal(single.runId, 'fo-1:1')

  // A run outside the window is not a candidate: nothing is demoted, and the
  // BLOCK is still recorded as unattributed.
  recordStrategyRun(dir, {
    strategyId: 'stale-only',
    agent: 'iris',
    success: true,
    stepKey: 'st-1',
    attempt: 1,
    createdAt: minutesAgo(180),
  })
  const stale = attachThemisVerdict(dir, { verdict: 'BLOCK', agent: 'iris', now })
  assert.equal(stale.attached, false)
  assert.equal(stale.reason, 'no_run')
  assert.ok((stale.unattributedObjectionId ?? 0) > 0)
  assert.equal(queryStrategies(dir, { strategyId: 'stale-only', now }).results[0]?.objections, 0)

  // The window itself is policy, and it is reported.
  withEnv({ PANTHEON_STRATEGY_ATTACH_WINDOW_MINUTES: '240' }, () => {
    const policy = resolveStrategyPolicy()
    assert.equal(policy.attachWindowMinutes, 240)
    assert.equal(policy.attachWindowSource, 'env')
    const widened = attachThemisVerdict(dir, { verdict: 'BLOCK', agent: 'iris', now })
    assert.equal(widened.attached, true)
  })
  withEnv({ PANTHEON_STRATEGY_ATTACH_WINDOW_MINUTES: 'nope' }, () => {
    const policy = resolveStrategyPolicy()
    assert.equal(policy.attachWindowMinutes, 60)
    assert.equal(policy.attachWindowInvalid, true)
  })
})

// ── N1: the attach target is resolved inside the write transaction ─────────

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

test('N1 a concurrent BLOCK cannot be double-counted (target read inside the write lock)', async () => {
  const dir = workspace()
  recordStrategyRun(dir, {
    strategyId: 'race-strategy',
    agent: 'hermes',
    success: true,
    stepKey: 'race',
    attempt: 1,
    createdAt: iso(new Date()),
  })

  const dbPath = join(dir, '.pantheon', 'memory', 'memory.db')
  const signal = join(dir, '.child-locked')
  const fixture = fileURLToPath(new URL('./fixtures/strategy-attach-race.mts', import.meta.url))

  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fixture, dbPath, signal, 'race:1', 'race-strategy', 'hermes', '1200'],
    { stdio: 'pipe' },
  )
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const exited = new Promise<void>((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`race fixture exited ${String(code)}: ${stderr}`))
    })
  })

  try {
    // The fixture holds the write lock and has applied its BLOCK (uncommitted).
    await waitForFile(signal, 20_000)
    const res = attachThemisVerdict(dir, { verdict: 'BLOCK', stepKey: 'race', now: new Date() })
    assert.equal(res.ok, true)
    assert.equal(res.attached, true)
    assert.equal(
      res.forcedSuccessZero,
      false,
      'a stale target read would subtract a success the other writer already removed',
    )
    assert.equal(res.objections, 1, 'a stale target read would count a second objection')
  } finally {
    await exited.catch(() => {})
  }

  const hit = queryStrategies(dir, { strategyId: 'race-strategy' }).results[0]
  assert.equal(hit?.successes, 0)
  assert.equal(hit?.objections, 1)
  assert.equal(hit?.attempts, 1)
  assert.ok(Number(hit?.objections) <= Number(hit?.attempts), 'objections <= attempts always')
})

// ── N3: an unattributable BLOCK is durable, never a vanishing signal ───────

test('N3 an unattributable BLOCK is persisted and surfaced in stats', () => {
  const dir = workspace()
  const now = new Date('2026-06-01T12:00:00.000Z')

  const res = attachThemisVerdict(dir, { verdict: 'BLOCK', stepKey: 'ghost', now })
  assert.equal(res.attached, false)
  assert.equal(res.reason, 'no_run')
  assert.ok((res.unattributedObjectionId ?? 0) > 0)

  const db = openStrategyDb(dir)
  const row = db
    .prepare(
      'SELECT agent, step_key, strategy_id, reason, verdict FROM strategy_objections WHERE id = ?',
    )
    .get(res.unattributedObjectionId) as Json
  assert.deepEqual(
    { ...row },
    { agent: null, step_key: 'ghost', strategy_id: null, reason: 'no_run', verdict: 'BLOCK' },
  )

  const stats = strategyStats(dir, { now })
  assert.equal(stats.unattributed_objections, 1)
  assert.equal(typeof stats.last_unattributed_objection_at, 'string')

  // Retention never removes the objection trail.
  const pruned = pruneStrategyRuns(dir, { now: new Date(now.getTime() + 400 * DAY_MS) })
  assert.equal(pruned.ok, true)
  assert.equal(strategyStats(dir).unattributed_objections, 1)
})

// ── N4: objections count a blocked run once ────────────────────────────────

test('N4 objections count a blocked run once across verdict transitions', () => {
  const dir = workspace()
  const now = new Date('2026-06-01T12:00:00.000Z')

  recordStrategyRun(dir, {
    strategyId: 'transition',
    agent: 'hermes',
    success: true,
    stepKey: 'n4',
    attempt: 1,
    createdAt: iso(now),
  })

  const first = attachThemisVerdict(dir, { verdict: 'BLOCK', stepKey: 'n4', now })
  assert.equal(first.attached, true)
  assert.equal(first.forcedSuccessZero, true)
  assert.equal(first.objections, 1)

  const note = attachThemisVerdict(dir, { verdict: 'APPROVE_WITH_NOTES', stepKey: 'n4', now })
  assert.equal(note.attached, true)
  assert.equal(note.objections, 1, 'a later non-blocking verdict does not erase the objection')

  const second = attachThemisVerdict(dir, { verdict: 'BLOCK', stepKey: 'n4', now })
  assert.equal(second.objections, 1, 'BLOCK -> notes -> BLOCK must not count twice on one run')
  assert.equal(second.forcedSuccessZero, false)

  const hit = queryStrategies(dir, { strategyId: 'transition', now }).results[0]
  assert.equal(hit?.successes, 0, 're-approving a blocked run never restores its success')
  assert.equal(hit?.objections, 1)
  assert.ok(Number(hit?.objections) <= Number(hit?.attempts))

  // Another blocked run is a new objection.
  recordStrategyRun(dir, {
    strategyId: 'transition',
    agent: 'hermes',
    success: true,
    stepKey: 'n4b',
    attempt: 1,
    createdAt: iso(now),
  })
  const third = attachThemisVerdict(dir, { verdict: 'BLOCK', stepKey: 'n4b', now })
  assert.equal(third.objections, 2)
})

// ── N5: one promotion answer per hit ───────────────────────────────────────

test('N5 a hit reports exactly one promotion answer — the policy it applied', () => {
  const dir = workspace()
  const now = new Date('2026-06-01T12:00:00.000Z')
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    recordStrategyRun(dir, {
      strategyId: 'edge',
      agent: 'athena',
      success: attempt <= 4,
      createdAt: iso(now),
    })
  }

  withEnv({ PANTHEON_STRATEGY_PROMOTION_MIN: '0.9' }, () => {
    const query = queryStrategies(dir, { strategyId: 'edge', now })
    const hit = query.results[0]
    assert.equal(hit?.status, 'candidate')
    assert.equal(query.policy.promotionMin, 0.9)
    assert.equal(
      Object.keys(hit as object).includes('stored_status'),
      false,
      'a persisted default projection must never travel with the resolved status',
    )
  })
})

// ── N6: summary is bounded ─────────────────────────────────────────────────

test('N6 a summary is capped at 4 KiB and reports that it was truncated', () => {
  const dir = workspace()
  const now = new Date('2026-06-01T12:00:00.000Z')
  const db = openStrategyDb(dir)
  const readSummary = (strategyId: string): string =>
    (
      db.prepare('SELECT summary FROM strategy_docs WHERE strategy_id = ?').get(strategyId) as {
        summary: string
      }
    ).summary

  const long = recordStrategyRun(dir, {
    strategyId: 'long-summary',
    agent: 'hermes',
    success: true,
    summary: 'x'.repeat(10_000),
    createdAt: iso(now),
  })
  assert.equal(long.summaryTruncated, true)
  assert.ok(Buffer.byteLength(readSummary('long-summary'), 'utf8') <= 4096)

  // Multibyte input is cut on a code-point boundary, never mid-character.
  const multibyte = recordStrategyRun(dir, {
    strategyId: 'multibyte-summary',
    agent: 'hermes',
    success: true,
    summary: 'é'.repeat(4000),
    createdAt: iso(now),
  })
  assert.equal(multibyte.summaryTruncated, true)
  const stored = readSummary('multibyte-summary')
  assert.equal(stored.includes('\uFFFD'), false)
  assert.ok(Buffer.byteLength(stored, 'utf8') <= 4096)

  const short = recordStrategyRun(dir, {
    strategyId: 'short-summary',
    agent: 'hermes',
    success: true,
    summary: 'small',
    createdAt: iso(now),
  })
  assert.equal(short.summaryTruncated, undefined)
  assert.equal(readSummary('short-summary'), 'small')
})

// ── N7: a failed migration rolls back and is reported loudly ───────────────

test('N7 a failed migration rolls back the whole batch and the recorder reports it', () => {
  const dir = workspace()
  const memoryDir = join(dir, '.pantheon', 'memory')
  mkdirSync(memoryDir, { recursive: true })
  const dbPath = join(memoryDir, 'memory.db')

  const raw = new DatabaseSync(dbPath)
  try {
    // Inject a guard table that rejects the new version: the INSERT inside the
    // migration fails after the DDL already ran.
    raw.exec(
      `CREATE TABLE strategy_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL,
        CHECK (value <> '${STRATEGY_SCHEMA_VERSION}'))`,
    )
    assert.throws(() => ensureStrategySchema(raw), /CHECK|constraint/i)
    const surviving = (
      raw.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'strategy_%'").all() as Array<{
        name: string
      }>
    ).map((row) => row.name)
    assert.deepEqual(surviving, ['strategy_meta'], 'the whole batch must roll back')
    assert.equal(
      (raw.prepare('SELECT count(*) AS n FROM strategy_meta').get() as { n: number }).n,
      0,
      'no guard row survives a failed migration',
    )
  } finally {
    raw.close()
  }

  const recorded = recordStrategyRunSafe(dir, {
    strategyId: 'after-failed-migration',
    agent: 'hermes',
    success: true,
  })
  assert.equal(recorded.ok, false)
  assert.equal(recorded.recorded, false)
  assert.match(String(recorded.error), /CHECK|constraint/i)
})

// ── Recorder safety: a broken recorder never fails a step ─────────────────

test('recordStrategyRunSafe reports a failed write instead of throwing', () => {
  const dir = workspace()
  mkdirSync(join(dir, '.pantheon'), { recursive: true })
  writeFileSync(join(dir, '.pantheon', 'memory'), 'not-a-directory')

  const result = recordStrategyRunSafe(dir, {
    strategyId: 'unwritable',
    agent: 'hermes',
    success: true,
  })
  assert.equal(result.ok, false)
  assert.equal(result.recorded, false)
  assert.ok(result.error, 'the failure is reported, not swallowed silently')
})

// ── Ledger + verdict wiring ───────────────────────────────────────────────

test('complete_step records a success run; the verification failure branch records an anti_pattern', async () => {
  const dir = workspace()
  initGitRepo(dir)
  const tool = createStepLedgerTool(dir)
  const ctx = { directory: dir, sessionID: 'ses_s4_ledger' }

  await call(
    tool,
    {
      action: 'init_step',
      stepKey: 's4-ok',
      objective: 'ship it',
      agent: 'hermes',
      taskType: 'feature',
    },
    ctx,
  )
  await call(tool, { action: 'record_mutation', stepKey: 's4-ok', files: ['app.ts'] }, ctx)
  await call(
    tool,
    { action: 'record_verification', stepKey: 's4-ok', command: 'npx tsx probe.ts', exitCode: 1 },
    ctx,
  )
  await call(
    tool,
    { action: 'record_verification', stepKey: 's4-ok', command: 'npx tsx probe.ts', exitCode: 0 },
    ctx,
  )
  const done = await call(tool, { action: 'complete_step', stepKey: 's4-ok' }, ctx)
  assert.equal(done.ok, true)
  const strategy = done.strategy as Json
  assert.equal(strategy.recorded, true)
  assert.equal(strategy.strategyId, deriveStrategyKey('hermes', 'feature'))
  assert.equal(strategy.runId, 's4-ok:1')

  const okHit = queryStrategies(dir, { strategyId: deriveStrategyKey('hermes', 'feature') })
  assert.equal(okHit.results[0]?.attempts, 1)
  assert.equal(okHit.results[0]?.successes, 1)

  // A repeat completion is not a new outcome: the sample must not inflate.
  const repeat = await call(tool, { action: 'complete_step', stepKey: 's4-ok' }, ctx)
  assert.equal(repeat.ok, true)
  assert.equal((repeat.strategy as Json).recorded, false)
  assert.equal((repeat.strategy as Json).reason, 'already_done')
  assert.equal(
    queryStrategies(dir, { strategyId: deriveStrategyKey('hermes', 'feature') }).results[0]
      ?.attempts,
    1,
  )

  // Rollback-eligible verification failures park the step in `blocked`.
  await call(
    tool,
    {
      action: 'init_step',
      stepKey: 's4-bad',
      objective: 'break it',
      agent: 'hermes',
      taskType: 'bugfix',
    },
    ctx,
  )
  await call(tool, { action: 'record_mutation', stepKey: 's4-bad', files: ['app.ts'] }, ctx)
  let last: Json = {}
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await call(
      tool,
      {
        action: 'record_verification',
        stepKey: 's4-bad',
        command: 'npx tsx probe.ts',
        exitCode: 1,
        autoRollback: false,
      },
      ctx,
    )
  }
  assert.equal(last.ok, false)
  assert.equal(last.verified, false)
  assert.equal(readStepLedger(dir).steps['s4-bad']?.state, 'blocked')
  const failureRun = last.strategy as Json
  assert.equal(failureRun.recorded, true)
  assert.equal(failureRun.success, false)

  // Two more terminal failures of the same task shape promote the ladder.
  for (const stepKey of ['s4-bad-2', 's4-bad-3']) {
    await call(
      tool,
      {
        action: 'init_step',
        stepKey,
        objective: 'break it again',
        agent: 'hermes',
        taskType: 'bugfix',
      },
      ctx,
    )
    await call(tool, { action: 'record_mutation', stepKey, files: ['app.ts'] }, ctx)
    let failed: Json = {}
    for (let attempt = 0; attempt < 3; attempt += 1) {
      failed = await call(
        tool,
        {
          action: 'record_verification',
          stepKey,
          command: 'npx tsx probe.ts',
          exitCode: 1,
          autoRollback: false,
        },
        ctx,
      )
    }
    assert.equal(failed.ok, false)
  }

  const badHit = queryStrategies(dir, { strategyId: deriveStrategyKey('hermes', 'bugfix') })
  assert.equal(badHit.results[0]?.attempts, 3, 'one run per terminal failure, not per attempt')
  assert.equal(badHit.results[0]?.successes, 0)
  assert.equal(badHit.results[0]?.status, 'anti_pattern')
})

test('a Themis BLOCK verdict attaches to the latest run through the review tool', async () => {
  const dir = workspace()
  recordStrategyRun(dir, {
    strategyId: deriveStrategyKey('hermes', 'feature'),
    agent: 'hermes',
    success: true,
    stepKey: 'step-review',
    attempt: 1,
    createdAt: new Date().toISOString(),
  })

  const tool = createReviewVerdictTool()
  const ctx = { directory: dir, sessionID: 'ses_s4_review' }
  const res = JSON.parse(
    (await tool.execute({ verdict: 'BLOCK', summary: 'unsafe merge', stepKey: 'step-review' }, ctx))
      .output,
  ) as Json
  assert.equal(res.ok, true)
  assert.equal(res.verdict, 'BLOCK')
  const strategy = res.strategy as Json
  assert.equal(strategy.attached, true)
  assert.equal(strategy.runId, 'step-review:1')
  assert.equal(strategy.forcedSuccessZero, true)
  assert.equal(strategy.objections, 1)

  const hit = queryStrategies(dir, { strategyId: deriveStrategyKey('hermes', 'feature') })
    .results[0]
  assert.equal(hit?.successes, 0)
  assert.equal(hit?.objections, 1)

  // A non-BLOCK verdict never writes to the strategy store.
  const approve = JSON.parse(
    (await tool.execute({ verdict: 'APPROVE', summary: 'fine' }, ctx)).output,
  ) as Json
  assert.equal(approve.strategy, undefined)

  // Without a step key the BLOCK still lands on the reviewed agent's latest run.
  recordStrategyRun(dir, {
    strategyId: deriveStrategyKey('aphrodite', 'feature'),
    agent: 'aphrodite',
    success: true,
    stepKey: 'step-ui',
    attempt: 1,
    createdAt: new Date(Date.now() + 1000).toISOString(),
  })
  const agentScoped = JSON.parse(
    (
      await tool.execute(
        { verdict: 'BLOCK', summary: 'a11y failure', targetAgent: 'aphrodite' },
        ctx,
      )
    ).output,
  ) as Json
  const agentStrategy = agentScoped.strategy as Json
  assert.equal(agentStrategy.attached, true)
  assert.equal(agentStrategy.runId, 'step-ui:1')
  assert.equal(
    queryStrategies(dir, { strategyId: deriveStrategyKey('aphrodite', 'feature') }).results[0]
      ?.successes,
    0,
  )
})

test('pantheon_strategy exposes record | query | stats | prune', async () => {
  const dir = workspace()
  const tool = createStrategyTool(dir)
  const ctx = { directory: dir, sessionID: 'ses_s4_tool' }

  const recorded = await call(
    tool,
    {
      action: 'record',
      strategyId: 'tool-path',
      agent: 'athena',
      success: true,
      summary: 'tool surface check',
    },
    ctx,
  )
  assert.equal(recorded.ok, true)
  assert.equal(recorded.recorded, true)

  const queried = await call(tool, { action: 'query', query: 'surface' }, ctx)
  assert.equal(queried.ok, true)
  assert.ok((queried.results as Json[]).some((row) => row.strategy_id === 'tool-path'))

  const stats = await call(tool, { action: 'stats' }, ctx)
  assert.equal(stats.ok, true)
  assert.equal(stats.runs, 1)

  const pruned = await call(tool, { action: 'prune' }, ctx)
  assert.equal(pruned.ok, true)
  assert.equal(pruned.remainingRuns, 1)

  const unknown = await call(tool, { action: 'bogus' }, ctx)
  assert.equal(unknown.ok, false)

  const missing = await call(tool, { action: 'record', agent: 'athena', success: true }, ctx)
  assert.equal(missing.ok, false)
})
