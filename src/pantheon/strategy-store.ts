/**
 * Strategy Success Rates — per-step outcome persistence for Pantheon (S4).
 *
 * Records every terminal step outcome (success or reflexive failure) as a run,
 * keeps per-`(strategy_id, agent)` aggregates, and exposes a lexical FTS5 BM25
 * read model so Zeus/Athena stop repeating decompositions that do not work.
 *
 * **No embeddings, no sqlite-vec, no Ollama, no network.** FTS5 BM25 only.
 *
 * ## Storage & isolation
 * The strategy tables live in the same `memory.db` file as `memories`, beside
 * them, never federated: `memory_store`/`memory_search` keep their exact SQL and
 * inputs and never see these tables, and `pantheon_strategy` is a separate tool
 * surface. The only shared piece is the database handle (`openMemoryDb`).
 *
 * ## Ladder (query time, D02)
 * - `proven`      : `attempts >= 3` and `success_rate >= PANTHEON_STRATEGY_PROMOTION_MIN` (0.8)
 * - `anti_pattern`: `attempts >= 3` and `failure_rate > 0.6`
 * - `candidate`   : everything else
 *
 * `decay = max(0, 1 - age_days/90)`; ranking is `success_rate * decay DESC, attempts DESC`.
 * A `themis_verdict = 'BLOCK'` forces `success = 0` and increments `objections`.
 *
 * ## Retention
 * `PANTHEON_STRATEGY_MAX_AGE_DAYS` (30) and `PANTHEON_STRATEGY_MAX_ROWS` (10000)
 * bound `strategy_runs` only, pruned every 50th insert and on `action='prune'`.
 * **Aggregates are never pruned** — they are the whole point of the store.
 * The insert counter is process-local (per open handle): a restart only delays
 * the next automatic pass, and `action='prune'` is always available.
 *
 * ## Failure policy
 * Recording is best-effort at the call sites: `recordStrategyRunSafe` never
 * throws and reports `{ ok: false, recorded: false, error }` so a broken
 * recorder can never fail a step or a review verdict.
 *
 * @module pantheon/strategy-store
 */

import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { openMemoryDb } from './native-memory-tools.ts'

export const STRATEGY_SCHEMA_VERSION = '1'
export const STRATEGY_DECAY_DAYS = 90
export const STRATEGY_MIN_ATTEMPTS = 3
export const DEFAULT_PROMOTION_MIN = 0.8
export const DEFAULT_ANTI_PATTERN_MAX = 0.6
export const DEFAULT_MAX_AGE_DAYS = 30
export const DEFAULT_MAX_ROWS = 10_000
/** Every Nth successful insert triggers a retention pass. */
export const STRATEGY_PRUNE_EVERY = 50

const DAY_MS = 86_400_000

export type StrategyStatus = 'candidate' | 'proven' | 'anti_pattern'

export interface StrategyPolicy {
  readonly minAttempts: number
  readonly promotionMin: number
  readonly antiPatternMax: number
  readonly promotionMinSource: 'default' | 'env'
  /** True when `PANTHEON_STRATEGY_PROMOTION_MIN` was present but unusable. */
  readonly promotionMinInvalid: boolean
}

export interface RetentionPolicy {
  readonly maxAgeDays: number
  readonly maxRows: number
  readonly maxAgeSource: 'default' | 'env'
  readonly maxRowsSource: 'default' | 'env'
  readonly maxAgeInvalid: boolean
  readonly maxRowsInvalid: boolean
}

export interface StrategyRunInput {
  readonly strategyId: string
  readonly agent: string
  readonly success: boolean
  readonly taskType?: string | null
  readonly stepKey?: string | null
  readonly attempt?: number | null
  readonly wave?: number | null
  readonly sliceCount?: number | null
  readonly parallel?: boolean | null
  readonly durationMs?: number | null
  readonly filesTouched?: number | null
  readonly themisVerdict?: string | null
  readonly retries?: number | null
  readonly errorClass?: string | null
  readonly summary?: string | null
  readonly createdAt?: string
  readonly runId?: string
  readonly env?: NodeJS.ProcessEnv
}

export interface StrategyPruneReport {
  readonly applied: boolean
  readonly deletedByAge: number
  readonly deletedByRows: number
  readonly error?: string
}

export interface StrategyRecordResult {
  readonly ok: boolean
  readonly recorded: boolean
  readonly runId?: string
  readonly strategyId?: string
  readonly agent?: string
  /** Effective stored success after any `themis_verdict='BLOCK'` override. */
  readonly success?: boolean
  readonly requestedSuccess?: boolean
  readonly forcedSuccessZero?: boolean
  readonly status?: StrategyStatus
  readonly attempts?: number
  readonly successes?: number
  readonly objections?: number
  readonly reason?: string
  readonly prune?: StrategyPruneReport
  readonly error?: string
}

export interface StrategyQueryOptions {
  readonly query?: string
  readonly strategyId?: string
  readonly agent?: string
  readonly status?: StrategyStatus | 'all'
  readonly limit?: number
  readonly now?: Date
  readonly env?: NodeJS.ProcessEnv
}

export interface StrategyQueryHit {
  readonly strategy_id: string
  readonly agent: string
  readonly attempts: number
  readonly successes: number
  readonly objections: number
  readonly files_total: number
  readonly duration_ms_total: number
  readonly success_rate: number
  readonly failure_rate: number
  readonly decay: number
  readonly status: StrategyStatus
  /** Persisted default-ladder projection stored in `strategy_stats.status`. */
  readonly stored_status: string
  readonly first_seen: string
  readonly last_seen: string
  readonly summary: string | null
  readonly score?: number
}

export interface StrategyQueryResult {
  readonly ok: boolean
  readonly count: number
  /** False when the FTS5 index could not answer and the LIKE fallback ran. */
  readonly fts: boolean
  readonly policy: StrategyPolicy
  readonly results: StrategyQueryHit[]
  readonly error?: string
}

export interface StrategyStatsResult {
  readonly ok: boolean
  readonly schema_version: string
  readonly runs: number
  readonly strategies: number
  readonly by_status: Record<StrategyStatus, number>
  readonly policy: StrategyPolicy
  readonly retention: RetentionPolicy
  readonly oldest_run: string | null
  readonly newest_run: string | null
  readonly error?: string
}

export interface StrategyPruneResult {
  readonly ok: boolean
  readonly deletedByAge: number
  readonly deletedByRows: number
  readonly remainingRuns: number
  /** Proof the aggregate table was not touched by retention. */
  readonly aggregateRows: number
  readonly error?: string
}

export interface ThemisVerdictInput {
  readonly verdict: string
  readonly stepKey?: string
  readonly strategyId?: string
  readonly agent?: string
  readonly now?: Date
}

export interface ThemisVerdictResult {
  readonly ok: boolean
  readonly attached: boolean
  readonly runId?: string
  readonly strategyId?: string
  readonly agent?: string
  readonly forcedSuccessZero?: boolean
  readonly objections?: number
  readonly status?: StrategyStatus
  readonly reason?: 'no_run' | 'invalid_verdict'
  readonly error?: string
}

export interface StrategySchemaReport {
  readonly applied: boolean
  readonly schemaVersion: string
  readonly created: string[]
}

// ── Policy resolution ─────────────────────────────────────────────────────

function readUnitInterval(
  raw: string | undefined,
  fallback: number,
): { value: number; source: 'default' | 'env'; invalid: boolean } {
  if (raw === undefined || raw.trim() === '') {
    return { value: fallback, source: 'default', invalid: false }
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return { value: fallback, source: 'default', invalid: true }
  }
  return { value: parsed, source: 'env', invalid: false }
}

function readPositiveInt(
  raw: string | undefined,
  fallback: number,
): { value: number; source: 'default' | 'env'; invalid: boolean } {
  if (raw === undefined || raw.trim() === '') {
    return { value: fallback, source: 'default', invalid: false }
  }
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return { value: fallback, source: 'default', invalid: true }
  }
  return { value: parsed, source: 'env', invalid: false }
}

/**
 * Resolve D02's ladder. Only the promotion threshold is configurable; an
 * unusable value falls back to the documented default and is reported as
 * invalid instead of silently becoming policy.
 */
export function resolveStrategyPolicy(env: NodeJS.ProcessEnv = process.env): StrategyPolicy {
  const promotion = readUnitInterval(env.PANTHEON_STRATEGY_PROMOTION_MIN, DEFAULT_PROMOTION_MIN)
  return {
    minAttempts: STRATEGY_MIN_ATTEMPTS,
    promotionMin: promotion.value,
    antiPatternMax: DEFAULT_ANTI_PATTERN_MAX,
    promotionMinSource: promotion.source,
    promotionMinInvalid: promotion.invalid,
  }
}

export function resolveRetentionPolicy(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  const age = readPositiveInt(env.PANTHEON_STRATEGY_MAX_AGE_DAYS, DEFAULT_MAX_AGE_DAYS)
  const rows = readPositiveInt(env.PANTHEON_STRATEGY_MAX_ROWS, DEFAULT_MAX_ROWS)
  return {
    maxAgeDays: age.value,
    maxRows: rows.value,
    maxAgeSource: age.source,
    maxRowsSource: rows.source,
    maxAgeInvalid: age.invalid,
    maxRowsInvalid: rows.invalid,
  }
}

// ── Pure ladder & decay ───────────────────────────────────────────────────

export function computeDecay(lastSeenIso: string, now: Date): number {
  const lastSeen = Date.parse(lastSeenIso)
  if (!Number.isFinite(lastSeen)) return 0
  const ageDays = (now.getTime() - lastSeen) / DAY_MS
  if (!Number.isFinite(ageDays)) return 0
  return Math.max(0, Math.min(1, 1 - ageDays / STRATEGY_DECAY_DAYS))
}

export function computeEffectiveStatus(
  attempts: number,
  successes: number,
  policy: StrategyPolicy,
): StrategyStatus {
  if (!Number.isFinite(attempts) || attempts < policy.minAttempts || attempts <= 0) {
    return 'candidate'
  }
  const rate = Math.max(0, Math.min(1, successes / attempts))
  if (rate >= policy.promotionMin) return 'proven'
  if (1 - rate > policy.antiPatternMax) return 'anti_pattern'
  return 'candidate'
}

/** Shared identity for a step's strategy: the agent plus the task shape. */
export function deriveStrategyKey(agent: string, taskType?: string | null): string {
  const normalizedAgent = agent.trim() || 'unknown'
  const normalizedTask = (taskType ?? '').trim() || 'general'
  return `${normalizedAgent}:${normalizedTask}`
}

// ── Schema ────────────────────────────────────────────────────────────────

const STRATEGY_DDL = `
  CREATE TABLE IF NOT EXISTS strategy_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL UNIQUE,
    strategy_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    task_type TEXT,
    step_key TEXT,
    wave INTEGER,
    slice_count INTEGER,
    parallel INTEGER,
    duration_ms INTEGER,
    files_touched INTEGER,
    success INTEGER NOT NULL,
    themis_verdict TEXT,
    retries INTEGER,
    error_class TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_strategy_runs_strategy
    ON strategy_runs(strategy_id, agent, created_at);
  CREATE INDEX IF NOT EXISTS idx_strategy_runs_step
    ON strategy_runs(step_key, created_at);
  CREATE INDEX IF NOT EXISTS idx_strategy_runs_created
    ON strategy_runs(created_at);

  CREATE TABLE IF NOT EXISTS strategy_stats (
    strategy_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    successes INTEGER NOT NULL DEFAULT 0,
    objections INTEGER NOT NULL DEFAULT 0,
    files_total INTEGER NOT NULL DEFAULT 0,
    duration_ms_total INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'candidate',
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    PRIMARY KEY (strategy_id, agent)
  );

  CREATE TABLE IF NOT EXISTS strategy_docs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    strategy_id TEXT NOT NULL,
    agent TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(strategy_id, agent)
  );

  CREATE VIRTUAL TABLE IF NOT EXISTS strategy_docs_fts USING fts5(
    strategy_id,
    agent,
    summary,
    content='strategy_docs',
    content_rowid='id',
    tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS strategy_docs_ai AFTER INSERT ON strategy_docs BEGIN
    INSERT INTO strategy_docs_fts(rowid, strategy_id, agent, summary)
    VALUES (new.id, new.strategy_id, new.agent, new.summary);
  END;
  CREATE TRIGGER IF NOT EXISTS strategy_docs_ad AFTER DELETE ON strategy_docs BEGIN
    INSERT INTO strategy_docs_fts(strategy_docs_fts, rowid, strategy_id, agent, summary)
    VALUES ('delete', old.id, old.strategy_id, old.agent, old.summary);
  END;
  CREATE TRIGGER IF NOT EXISTS strategy_docs_au AFTER UPDATE ON strategy_docs BEGIN
    INSERT INTO strategy_docs_fts(strategy_docs_fts, rowid, strategy_id, agent, summary)
    VALUES ('delete', old.id, old.strategy_id, old.agent, old.summary);
    INSERT INTO strategy_docs_fts(rowid, strategy_id, agent, summary)
    VALUES (new.id, new.strategy_id, new.agent, new.summary);
  END;

  CREATE VIEW IF NOT EXISTS strategy_effective AS
  SELECT
    s.strategy_id,
    s.agent,
    s.attempts,
    s.successes,
    s.objections,
    s.files_total,
    s.duration_ms_total,
    s.status AS stored_status,
    s.first_seen,
    s.last_seen,
    CASE WHEN s.attempts > 0 THEN CAST(s.successes AS REAL) / s.attempts ELSE 0.0 END
      AS success_rate,
    CASE WHEN s.attempts > 0 THEN CAST(s.attempts - s.successes AS REAL) / s.attempts ELSE 0.0 END
      AS failure_rate,
    max(
      0.0,
      1.0 - (julianday('now') - julianday(s.last_seen)) / 90.0
    ) AS decay,
    CASE
      WHEN s.attempts >= 3
        AND CAST(s.successes AS REAL) / s.attempts >= 0.8 THEN 'proven'
      WHEN s.attempts >= 3
        AND CAST(s.attempts - s.successes AS REAL) / s.attempts > 0.6 THEN 'anti_pattern'
      ELSE 'candidate'
    END AS effective_status
  FROM strategy_stats s;

  CREATE TABLE IF NOT EXISTS strategy_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`

function readSchemaVersion(db: DatabaseSync): string | null {
  const table = db
    .prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'strategy_meta'",
    )
    .get() as { present?: number } | undefined
  if (!table) return null
  const row = db.prepare("SELECT value FROM strategy_meta WHERE key = 'schema_version'").get() as
    | { value?: string }
    | undefined
  return row?.value ?? null
}

function objectNames(db: DatabaseSync): Set<string> {
  const rows = db.prepare('SELECT name FROM sqlite_master').all() as Array<{ name: string }>
  return new Set(rows.map((row) => row.name))
}

/**
 * Additive, idempotent migration of the strategy surface.
 *
 * Guarded by `strategy_meta.schema_version = '1'`: a re-open (new process or
 * new handle) performs no DDL at all and leaves `PRAGMA schema_version`
 * untouched. DDL + the guard row commit in one transaction.
 */
export function ensureStrategySchema(db: DatabaseSync): StrategySchemaReport {
  const existing = readSchemaVersion(db)
  if (existing === STRATEGY_SCHEMA_VERSION) {
    return { applied: false, schemaVersion: existing, created: [] }
  }
  if (existing !== null && Number(existing) > Number(STRATEGY_SCHEMA_VERSION)) {
    throw new Error(
      `strategy schema_version "${existing}" is newer than supported "${STRATEGY_SCHEMA_VERSION}"; refusing to write`,
    )
  }

  const before = objectNames(db)
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(STRATEGY_DDL)
    db.prepare(
      `INSERT INTO strategy_meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(STRATEGY_SCHEMA_VERSION)
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* the transaction may already be gone */
    }
    throw err
  }
  const after = objectNames(db)
  return {
    applied: true,
    schemaVersion: STRATEGY_SCHEMA_VERSION,
    created: [...after].filter((name) => !before.has(name)).sort(),
  }
}

const ensuredHandles = new WeakMap<DatabaseSync, StrategySchemaReport>()

/**
 * Open the shared memory database and guarantee the strategy surface exists.
 * Reuses the exact cached handle `memory_*` tools use (no second connection).
 */
export function openStrategyDb(workspaceDir: string): DatabaseSync {
  const db = openMemoryDb(workspaceDir)
  if (!ensuredHandles.has(db)) ensuredHandles.set(db, ensureStrategySchema(db))
  return db
}

// ── Write path ────────────────────────────────────────────────────────────

const insertCounters = new WeakMap<DatabaseSync, number>()

interface AggregateRow {
  strategy_id: string
  agent: string
  attempts: number
  successes: number
  objections: number
  files_total: number
  duration_ms_total: number
  status: string
  first_seen: string
  last_seen: string
}

function normalizeVerdict(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toUpperCase()
  return value === 'BLOCK' || value === 'APPROVE' || value === 'APPROVE_WITH_NOTES' ? value : null
}

function normalizeTimestamp(raw: string | null | undefined, field: string): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  const parsed = Date.parse(raw)
  if (!Number.isFinite(parsed)) throw new Error(`${field} must be an ISO-8601 timestamp`)
  return new Date(parsed).toISOString()
}

function readAggregate(db: DatabaseSync, strategyId: string, agent: string): AggregateRow | null {
  const row = db
    .prepare(
      `SELECT strategy_id, agent, attempts, successes, objections, files_total,
              duration_ms_total, status, first_seen, last_seen
         FROM strategy_stats WHERE strategy_id = ? AND agent = ?`,
    )
    .get(strategyId, agent) as AggregateRow | undefined
  return row ?? null
}

/** Aggregate fields for a record payload; omitted entirely when unreadable. */
function aggregateFields(
  aggregate: AggregateRow | null,
  policy: StrategyPolicy,
): Pick<StrategyRecordResult, 'attempts' | 'successes' | 'objections' | 'status'> {
  if (!aggregate) return {}
  return {
    attempts: aggregate.attempts,
    successes: aggregate.successes,
    objections: aggregate.objections,
    status: computeEffectiveStatus(aggregate.attempts, aggregate.successes, policy),
  }
}

/**
 * Re-project the persisted `status` column with the **default** ladder.
 * The env override is a query-time concern (`resolveStrategyPolicy`), so the
 * column stays a stable, documented projection rather than config-derived state.
 */
function recomputeStoredStatus(db: DatabaseSync, strategyId: string, agent: string): void {
  db.prepare(
    `UPDATE strategy_stats SET status = CASE
        WHEN attempts >= 3 AND CAST(successes AS REAL) / attempts >= 0.8 THEN 'proven'
        WHEN attempts >= 3 AND CAST(attempts - successes AS REAL) / attempts > 0.6
          THEN 'anti_pattern'
        ELSE 'candidate'
      END
      WHERE strategy_id = ? AND agent = ?`,
  ).run(strategyId, agent)
}

function nextAttemptForStep(db: DatabaseSync, stepKey: string): number {
  const row = db
    .prepare('SELECT count(*) AS n FROM strategy_runs WHERE step_key = ?')
    .get(stepKey) as { n?: number } | undefined
  return Number(row?.n ?? 0) + 1
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(min, Math.min(max, Math.floor(value)))
}

/**
 * Persist one terminal step outcome and fold it into the aggregates.
 *
 * Idempotent on `run_id` (`<stepKey>:<attempt>`): a duplicate insert records
 * nothing, keeps the aggregates untouched and says so (`recorded: false`).
 */
export function recordStrategyRun(
  workspaceDir: string,
  input: StrategyRunInput,
): StrategyRecordResult {
  const strategyId = typeof input.strategyId === 'string' ? input.strategyId.trim() : ''
  const agent = typeof input.agent === 'string' ? input.agent.trim() : ''
  if (!strategyId) throw new Error('strategyId is required')
  if (!agent) throw new Error('agent is required')
  if (typeof input.success !== 'boolean') throw new Error('success must be a boolean')

  const db = openStrategyDb(workspaceDir)
  const env = input.env ?? process.env
  const policy = resolveStrategyPolicy(env)
  const createdAt = normalizeTimestamp(input.createdAt, 'createdAt') ?? new Date().toISOString()
  const verdict = normalizeVerdict(input.themisVerdict)
  const rawVerdict = typeof input.themisVerdict === 'string' ? input.themisVerdict.trim() : ''
  if (rawVerdict && !verdict) {
    throw new Error('themisVerdict must be APPROVE, APPROVE_WITH_NOTES or BLOCK')
  }
  const stepKey =
    typeof input.stepKey === 'string' && input.stepKey.trim() ? input.stepKey.trim() : null
  const attempt =
    typeof input.attempt === 'number' && Number.isFinite(input.attempt)
      ? Math.trunc(input.attempt)
      : null
  const runId =
    typeof input.runId === 'string' && input.runId.trim()
      ? input.runId.trim()
      : stepKey
        ? `${stepKey}:${attempt ?? nextAttemptForStep(db, stepKey)}`
        : newRunId()

  const requestedSuccess = input.success
  // D02: a Themis BLOCK is a failed strategy, whichever way the step ended.
  const success = requestedSuccess && verdict !== 'BLOCK'
  const forcedSuccessZero = requestedSuccess && verdict === 'BLOCK'
  const objections = verdict === 'BLOCK' ? 1 : 0
  const filesTouched = Math.max(0, Math.trunc(input.filesTouched ?? 0))
  const durationMs = Math.max(0, Math.trunc(input.durationMs ?? 0))
  const retries = Math.max(0, Math.trunc(input.retries ?? 0))

  let inserted = false
  db.exec('BEGIN IMMEDIATE')
  try {
    const insert = db
      .prepare(
        `INSERT INTO strategy_runs (
           run_id, strategy_id, agent, task_type, step_key, wave, slice_count, parallel,
           duration_ms, files_touched, success, themis_verdict, retries, error_class, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(run_id) DO NOTHING`,
      )
      .run(
        runId,
        strategyId,
        agent,
        typeof input.taskType === 'string' && input.taskType.trim() ? input.taskType.trim() : null,
        stepKey,
        typeof input.wave === 'number' && Number.isFinite(input.wave)
          ? Math.trunc(input.wave)
          : null,
        typeof input.sliceCount === 'number' && Number.isFinite(input.sliceCount)
          ? Math.trunc(input.sliceCount)
          : null,
        typeof input.parallel === 'boolean' ? (input.parallel ? 1 : 0) : null,
        durationMs,
        filesTouched,
        success ? 1 : 0,
        verdict,
        retries,
        typeof input.errorClass === 'string' && input.errorClass.trim()
          ? input.errorClass.trim()
          : null,
        createdAt,
      )
    inserted = Number(insert.changes ?? 0) > 0

    if (inserted) {
      db.prepare(
        `INSERT INTO strategy_stats (
           strategy_id, agent, attempts, successes, objections, files_total,
           duration_ms_total, status, first_seen, last_seen
         ) VALUES (?, ?, 1, ?, ?, ?, ?, 'candidate', ?, ?)
         ON CONFLICT(strategy_id, agent) DO UPDATE SET
           attempts = attempts + 1,
           successes = successes + excluded.successes,
           objections = objections + excluded.objections,
           files_total = files_total + excluded.files_total,
           duration_ms_total = duration_ms_total + excluded.duration_ms_total,
           last_seen = CASE
             WHEN excluded.last_seen > strategy_stats.last_seen THEN excluded.last_seen
             ELSE strategy_stats.last_seen
           END,
           first_seen = CASE
             WHEN excluded.first_seen < strategy_stats.first_seen THEN excluded.first_seen
             ELSE strategy_stats.first_seen
           END`,
      ).run(
        strategyId,
        agent,
        success ? 1 : 0,
        objections,
        filesTouched,
        durationMs,
        createdAt,
        createdAt,
      )
      recomputeStoredStatus(db, strategyId, agent)

      const summary = typeof input.summary === 'string' ? input.summary.trim() : ''
      if (summary) {
        db.prepare(
          `INSERT INTO strategy_docs (strategy_id, agent, summary, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(strategy_id, agent) DO UPDATE SET
             summary = excluded.summary,
             updated_at = excluded.updated_at`,
        ).run(strategyId, agent, summary, createdAt, createdAt)
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* the transaction may already be gone */
    }
    throw err
  }

  const aggregate = readAggregate(db, strategyId, agent)

  if (!inserted) {
    const stored = db
      .prepare('SELECT success, themis_verdict AS verdict FROM strategy_runs WHERE run_id = ?')
      .get(runId) as { success?: number; verdict?: string | null } | undefined
    return {
      ok: true,
      recorded: false,
      reason: 'duplicate_run_id',
      runId,
      strategyId,
      agent,
      success: Number(stored?.success ?? 0) === 1,
      requestedSuccess,
      ...aggregateFields(aggregate, policy),
      prune: { applied: false, deletedByAge: 0, deletedByRows: 0 },
    }
  }

  // Retention runs on every Nth insert. A prune failure never fails the write,
  // and the payload reports it instead of pretending the pass happened.
  const counter = (insertCounters.get(db) ?? 0) + 1
  insertCounters.set(db, counter)
  let prune: StrategyPruneReport = { applied: false, deletedByAge: 0, deletedByRows: 0 }
  if (counter % STRATEGY_PRUNE_EVERY === 0) {
    const pass = pruneStrategyRuns(workspaceDir, { env })
    prune = {
      applied: pass.ok,
      deletedByAge: pass.deletedByAge,
      deletedByRows: pass.deletedByRows,
      ...(pass.error ? { error: pass.error } : {}),
    }
  }

  return {
    ok: true,
    recorded: true,
    runId,
    strategyId,
    agent,
    success,
    requestedSuccess,
    forcedSuccessZero,
    ...aggregateFields(aggregate, policy),
    prune,
  }
}

// ── Retention ─────────────────────────────────────────────────────────────

/**
 * Delete `strategy_runs` older than the age window and beyond the row cap.
 * `strategy_stats` and `strategy_docs` are never touched: the aggregates are
 * the durable knowledge, the runs are the raw sample.
 */
export function pruneStrategyRuns(
  workspaceDir: string,
  options: { now?: Date; env?: NodeJS.ProcessEnv } = {},
): StrategyPruneResult {
  const empty = { deletedByAge: 0, deletedByRows: 0 }
  try {
    const db = openStrategyDb(workspaceDir)
    const retention = resolveRetentionPolicy(options.env ?? process.env)
    const now = options.now ?? new Date()
    const cutoff = new Date(now.getTime() - retention.maxAgeDays * DAY_MS).toISOString()

    db.exec('BEGIN IMMEDIATE')
    try {
      // `created_at` is always canonical ISO-8601 UTC (normalized on write), so a
      // lexicographic comparison is order-equivalent to the julian day and lets
      // idx_strategy_runs_created answer the age window instead of scanning.
      const byAge = db.prepare('DELETE FROM strategy_runs WHERE created_at < ?').run(cutoff)
      const remainingAfterAge = Number(
        (db.prepare('SELECT count(*) AS n FROM strategy_runs').get() as { n?: number })?.n ?? 0,
      )
      const excess = Math.max(0, remainingAfterAge - retention.maxRows)
      const byRows =
        excess > 0
          ? db
              .prepare(
                `DELETE FROM strategy_runs WHERE id IN (
                   SELECT id FROM strategy_runs ORDER BY created_at ASC, id ASC LIMIT ?
                 )`,
              )
              .run(excess)
          : { changes: 0 }
      const remainingRuns = Number(
        (db.prepare('SELECT count(*) AS n FROM strategy_runs').get() as { n?: number })?.n ?? 0,
      )
      const aggregateRows = Number(
        (db.prepare('SELECT count(*) AS n FROM strategy_stats').get() as { n?: number })?.n ?? 0,
      )
      db.exec('COMMIT')
      return {
        ok: true,
        deletedByAge: Number(byAge.changes ?? 0),
        deletedByRows: Number(byRows.changes ?? 0),
        remainingRuns,
        aggregateRows,
      }
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* the transaction may already be gone */
      }
      throw err
    }
  } catch (err) {
    return {
      ok: false,
      ...empty,
      remainingRuns: -1,
      aggregateRows: -1,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ── Read path ─────────────────────────────────────────────────────────────

function tokenize(rawQuery: string): string[] {
  return rawQuery
    .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length >= 2)
}

interface RawHitRow {
  strategy_id?: string | null
  agent?: string | null
  attempts?: number | null
  successes?: number | null
  objections?: number | null
  files_total?: number | null
  duration_ms_total?: number | null
  stored_status?: string | null
  first_seen?: string | null
  last_seen?: string | null
  summary?: string | null
  score?: number | null
}

const HIT_COLUMNS = `s.strategy_id AS strategy_id, s.agent AS agent, s.attempts AS attempts,
  s.successes AS successes, s.objections AS objections, s.files_total AS files_total,
  s.duration_ms_total AS duration_ms_total, s.status AS stored_status,
  s.first_seen AS first_seen, s.last_seen AS last_seen`

function toHit(row: RawHitRow, now: Date, policy: StrategyPolicy): StrategyQueryHit | null {
  if (!row.strategy_id || !row.agent) return null
  const attempts = Number(row.attempts ?? 0)
  const successes = Number(row.successes ?? 0)
  const lastSeen = String(row.last_seen ?? '')
  const successRate = attempts > 0 ? successes / attempts : 0
  return {
    strategy_id: row.strategy_id,
    agent: row.agent,
    attempts,
    successes,
    objections: Number(row.objections ?? 0),
    files_total: Number(row.files_total ?? 0),
    duration_ms_total: Number(row.duration_ms_total ?? 0),
    success_rate: successRate,
    failure_rate: attempts > 0 ? (attempts - successes) / attempts : 0,
    decay: computeDecay(lastSeen, now),
    status: computeEffectiveStatus(attempts, successes, policy),
    stored_status: String(row.stored_status ?? 'candidate'),
    first_seen: String(row.first_seen ?? ''),
    last_seen: lastSeen,
    summary: row.summary ?? null,
    ...(typeof row.score === 'number' ? { score: row.score } : {}),
  }
}

function rankHits(hits: StrategyQueryHit[]): StrategyQueryHit[] {
  return hits.sort((a, b) => {
    const left = a.success_rate * a.decay
    const right = b.success_rate * b.decay
    if (right !== left) return right - left
    if (b.attempts !== a.attempts) return b.attempts - a.attempts
    if (a.score !== undefined && b.score !== undefined && a.score !== b.score) {
      return a.score - b.score
    }
    return a.strategy_id.localeCompare(b.strategy_id)
  })
}

/**
 * Ladder-ranked strategies. With `query`, the FTS5 BM25 index answers first
 * (external-content `strategy_docs_fts`); a broken index degrades to a LIKE
 * scan and reports `fts: false` instead of claiming a BM25 result.
 */
export function queryStrategies(
  workspaceDir: string,
  options: StrategyQueryOptions = {},
): StrategyQueryResult {
  const env = options.env ?? process.env
  const policy = resolveStrategyPolicy(env)
  const now = options.now ?? new Date()
  const limit = clampInt(options.limit, 10, 1, 100)
  const strategyId = options.strategyId?.trim() || null
  const agent = options.agent?.trim() || null
  const statusFilter = options.status && options.status !== 'all' ? options.status : null

  try {
    const db = openStrategyDb(workspaceDir)
    const rawQuery = options.query?.trim() ?? ''
    const tokens = tokenize(rawQuery)
    let rows: RawHitRow[] = []
    let fts = false

    if (tokens.length > 0) {
      try {
        const expression = tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' OR ')
        rows = db
          .prepare(
            `SELECT ${HIT_COLUMNS}, d.summary AS summary,
                    bm25(strategy_docs_fts) AS score
               FROM strategy_docs_fts
               JOIN strategy_docs d ON d.id = strategy_docs_fts.rowid
               JOIN strategy_stats s
                 ON s.strategy_id = d.strategy_id AND s.agent = d.agent
              WHERE strategy_docs_fts MATCH ?
              ORDER BY score
              LIMIT 500`,
          )
          .all(expression) as RawHitRow[]
        fts = true
      } catch {
        fts = false
      }
      if (!fts) {
        const escaped = rawQuery.replace(/[\\%_]/g, '\\$&')
        rows = db
          .prepare(
            `SELECT ${HIT_COLUMNS}, d.summary AS summary
               FROM strategy_docs d
               JOIN strategy_stats s
                 ON s.strategy_id = d.strategy_id AND s.agent = d.agent
              WHERE d.summary LIKE ? ESCAPE '\\'
              ORDER BY s.attempts DESC
              LIMIT 500`,
          )
          .all(`%${escaped}%`) as RawHitRow[]
      }
    } else {
      rows = db
        .prepare(
          `SELECT ${HIT_COLUMNS}, d.summary AS summary
             FROM strategy_stats s
             LEFT JOIN strategy_docs d
               ON d.strategy_id = s.strategy_id AND d.agent = s.agent
            LIMIT 500`,
        )
        .all() as RawHitRow[]
    }

    const hits = rows
      .map((row) => toHit(row, now, policy))
      .filter((hit): hit is StrategyQueryHit => hit !== null)
      .filter((hit) => (strategyId ? hit.strategy_id === strategyId : true))
      .filter((hit) => (agent ? hit.agent === agent : true))
      .filter((hit) => (statusFilter ? hit.status === statusFilter : true))

    const results = rankHits(hits).slice(0, limit)
    return { ok: true, count: results.length, fts, policy, results }
  } catch (err) {
    return {
      ok: false,
      count: 0,
      fts: false,
      policy,
      results: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

export function strategyStats(
  workspaceDir: string,
  options: { now?: Date; env?: NodeJS.ProcessEnv } = {},
): StrategyStatsResult {
  const env = options.env ?? process.env
  const policy = resolveStrategyPolicy(env)
  const retention = resolveRetentionPolicy(env)
  try {
    const db = openStrategyDb(workspaceDir)
    const rows = db
      .prepare('SELECT strategy_id, agent, attempts, successes FROM strategy_stats')
      .all() as Array<{ attempts?: number; successes?: number }>
    const by_status: Record<StrategyStatus, number> = {
      candidate: 0,
      proven: 0,
      anti_pattern: 0,
    }
    for (const row of rows) {
      by_status[
        computeEffectiveStatus(Number(row.attempts ?? 0), Number(row.successes ?? 0), policy)
      ] += 1
    }
    const runs = db.prepare('SELECT count(*) AS n FROM strategy_runs').get() as
      | { n?: number }
      | undefined
    const bounds = db
      .prepare('SELECT min(created_at) AS oldest, max(created_at) AS newest FROM strategy_runs')
      .get() as { oldest?: string | null; newest?: string | null } | undefined
    const meta = db.prepare("SELECT value FROM strategy_meta WHERE key = 'schema_version'").get() as
      | { value?: string }
      | undefined

    return {
      ok: true,
      schema_version: String(meta?.value ?? 'unknown'),
      runs: Number(runs?.n ?? 0),
      strategies: rows.length,
      by_status,
      policy,
      retention,
      oldest_run: bounds?.oldest ?? null,
      newest_run: bounds?.newest ?? null,
    }
  } catch (err) {
    return {
      ok: false,
      schema_version: 'unknown',
      runs: 0,
      strategies: 0,
      by_status: { candidate: 0, proven: 0, anti_pattern: 0 },
      policy,
      retention,
      oldest_run: null,
      newest_run: null,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ── Themis verdict attachment ─────────────────────────────────────────────

interface TargetRunRow {
  id: number
  run_id: string
  strategy_id: string
  agent: string
  success: number
  themis_verdict: string | null
}

/**
 * Attach a Themis verdict to the **latest** run (by step key, else strategy,
 * else the newest run overall). A `BLOCK` forces `success = 0` and increments
 * `objections`; re-attaching the same `BLOCK` never double-counts.
 */
export function attachThemisVerdict(
  workspaceDir: string,
  input: ThemisVerdictInput,
): ThemisVerdictResult {
  const verdict = normalizeVerdict(input.verdict)
  if (!verdict) {
    return {
      ok: false,
      attached: false,
      reason: 'invalid_verdict',
      error: `invalid verdict "${String(input.verdict)}"`,
    }
  }
  const policy = resolveStrategyPolicy()
  const stepKey = input.stepKey?.trim() || null
  const strategyId = input.strategyId?.trim() || null
  const agent = input.agent?.trim() || null

  try {
    const db = openStrategyDb(workspaceDir)
    let target: TargetRunRow | undefined
    if (stepKey) {
      target = db
        .prepare(
          `SELECT id, run_id, strategy_id, agent, success, themis_verdict
             FROM strategy_runs WHERE step_key = ?
            ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(stepKey) as TargetRunRow | undefined
    } else if (strategyId) {
      target = db
        .prepare(
          `SELECT id, run_id, strategy_id, agent, success, themis_verdict
             FROM strategy_runs
            WHERE strategy_id = ? AND (? IS NULL OR agent = ?)
            ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(strategyId, agent, agent) as TargetRunRow | undefined
    } else {
      target = db
        .prepare(
          `SELECT id, run_id, strategy_id, agent, success, themis_verdict
             FROM strategy_runs WHERE (? IS NULL OR agent = ?)
            ORDER BY created_at DESC, id DESC LIMIT 1`,
        )
        .get(agent, agent) as TargetRunRow | undefined
    }

    if (!target) {
      return { ok: true, attached: false, reason: 'no_run' }
    }

    const alreadyBlocked = target.themis_verdict === 'BLOCK' && verdict === 'BLOCK'
    const forcedSuccessZero = verdict === 'BLOCK' && Number(target.success) === 1
    const objectionDelta = verdict === 'BLOCK' && !alreadyBlocked ? 1 : 0

    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare('UPDATE strategy_runs SET themis_verdict = ? WHERE id = ?').run(verdict, target.id)
      if (forcedSuccessZero) {
        db.prepare('UPDATE strategy_runs SET success = 0 WHERE id = ?').run(target.id)
      }
      if (forcedSuccessZero || objectionDelta > 0) {
        db.prepare(
          `UPDATE strategy_stats SET
             successes = max(0, successes - ?),
             objections = objections + ?
           WHERE strategy_id = ? AND agent = ?`,
        ).run(forcedSuccessZero ? 1 : 0, objectionDelta, target.strategy_id, target.agent)
        recomputeStoredStatus(db, target.strategy_id, target.agent)
      }
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* the transaction may already be gone */
      }
      throw err
    }

    const aggregate = readAggregate(db, target.strategy_id, target.agent)
    return {
      ok: true,
      attached: true,
      runId: target.run_id,
      strategyId: target.strategy_id,
      agent: target.agent,
      forcedSuccessZero,
      objections: aggregate?.objections ?? 0,
      status: aggregate
        ? computeEffectiveStatus(aggregate.attempts, aggregate.successes, policy)
        : 'candidate',
    }
  } catch (err) {
    return {
      ok: false,
      attached: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Never throws — see module docs (failure policy). */
export function recordStrategyRunSafe(
  workspaceDir: string,
  input: StrategyRunInput,
): StrategyRecordResult {
  try {
    return recordStrategyRun(workspaceDir, input)
  } catch (err) {
    return {
      ok: false,
      recorded: false,
      error: err instanceof Error ? err.message : String(err),
      ...(input.strategyId ? { strategyId: input.strategyId } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
    }
  }
}

export function attachThemisVerdictSafe(
  workspaceDir: string,
  input: ThemisVerdictInput,
): ThemisVerdictResult {
  try {
    return attachThemisVerdict(workspaceDir, input)
  } catch (err) {
    return {
      ok: false,
      attached: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** Stable suffix for run ids that have no step key. */
export function newRunId(): string {
  return `run-${randomUUID()}`
}
