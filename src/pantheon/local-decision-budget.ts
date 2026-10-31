import { randomUUID } from 'node:crypto'
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { DatabaseSync } from 'node:sqlite'
import {
  getVerifiedUsageEvidenceDetails,
  type VerifiedUsageEvidence,
} from './local-decision-usage-evidence.internal.ts'

export type BudgetProvider = 'openai-decisions' | 'typesafe-jev' | 'opencode-console' | 'jev-free'

/** Model and OpenCode Console variant keys must be configured before admission. */
export type BudgetModel = string

export interface BudgetCaps {
  /** Non-negative integer USD micros. Zero explicitly disables admission. */
  monthlyCapMicros: number
  /** Non-negative integer USD micros. Zero explicitly disables admission. */
  perDecisionCapMicros: number
}

export type ReservationResult =
  | {
      status: 'reserved'
      reservationId: string
      period: string
      reservedMicros: number
    }
  | {
      status: 'denied'
      reason:
        | 'invalid-provider'
        | 'invalid-model'
        | 'no-cap'
        | 'per-decision-cap'
        | 'monthly-cap'
        | 'frozen'
        | 'duplicate-reservation-id'
        | 'period-unconfirmed'
        | 'period-mismatch'
        | 'clock-untrusted'
    }

export type ReservationDenialReason = Extract<ReservationResult, { status: 'denied' }>['reason']
export type AdmissionCheckResult =
  | { status: 'eligible' }
  | { status: 'denied'; reason: ReservationDenialReason }

export type PeriodConfirmationResult =
  | { status: 'confirmed'; activePeriod: string }
  | {
      status: 'denied'
      reason:
        | 'invalid-period'
        | 'stale-current'
        | 'backwards'
        | 'not-next-month'
        | 'wall-clock-mismatch'
        | 'clock-untrusted'
    }

export type ReconciliationResult =
  | { status: 'reconciled'; actualCostMicros: number; frozen: boolean }
  | { status: 'unknown' | 'missing' | 'already-reconciled' | 'mismatch' }

export interface UncertainReservation {
  reservationId: string
  provider: BudgetProvider
  model: BudgetModel
  period: string
  reservedMicros: number
  state: 'pending' | 'uncertain'
  createdAtMs: number
  updatedAtMs: number
}

export interface LocalDecisionBudgetLedger {
  /** Admin/configuration API: writes policy to the local user-level DB. */
  configureUserCaps(caps: BudgetCaps): void
  /** Shared cap applies to every model/variant registered for this provider. */
  configureProviderCaps(provider: BudgetProvider, caps: BudgetCaps): void
  /** Each model/variant has an independent monthly and per-decision cap. */
  configureModelCaps(provider: BudgetProvider, model: BudgetModel, caps: BudgetCaps): void
  /** Explicitly initialize or advance the persisted UTC budget month one month only. */
  confirmBudgetPeriod(
    expectedCurrentPeriod: string | null,
    targetPeriod: string,
  ): PeriodConfirmationResult
  getActiveBudgetPeriod(): string | null
  /** Read-only, transactionally consistent check used to count Auto candidates. */
  canReserve(provider: BudgetProvider, model: BudgetModel): AdmissionCheckResult
  /**
   * Atomically reserves the model's configured per-decision maximum across the
   * user, provider, and model buckets. No cost or cap comes from the caller.
   */
  reserve(provider: BudgetProvider, model: BudgetModel): ReservationResult
  /** Accepts only an opaque capability minted by the internal usage verifier. */
  reconcileVerified(reservationId: string, evidence: VerifiedUsageEvidence): ReconciliationResult
  listUncertainReservations(): UncertainReservation[]
  /** Recovery only moves pending rows to uncertain; it never releases budget. */
  recoverPendingReservations(): number
  /** Prune resolved reservations from past UTC periods with no unresolved holds. */
  pruneCompletedPeriods(): number
  close(): void
}

export interface OpenLocalDecisionBudgetOptions {
  dbPath?: string
  /** Test seams; monotonic time detects regressions but never selects a budget period. */
  clock?: () => number
  monotonicClock?: () => number
  /** Test seam; duplicate generated IDs are denied without adding a reservation. */
  reservationIdFactory?: () => string
  /** SQLite lock wait; production defaults to five seconds, then errors fail closed. */
  busyTimeoutMs?: number
}

const SCHEMA_VERSION = 3
const VERSION_TWO = 2
const APPLICATION_ID = 0x50424c31
const DB_FILENAME = 'decision-budget.sqlite'
/** Accounting provider IDs accepted by the ledger. */
export const LOCAL_DECISION_BUDGET_PROVIDERS: readonly BudgetProvider[] = Object.freeze([
  'openai-decisions',
  'typesafe-jev',
  'opencode-console',
  'jev-free',
])
const ALLOWED_PROVIDERS = new Set<BudgetProvider>(LOCAL_DECISION_BUDGET_PROVIDERS)
const MODEL_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const RESERVATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CLOCK_ROLLBACK_TOLERANCE_MS = 60_000

/** Resolve an account-wide path, independent of project install state. */
export function resolveLocalDecisionBudgetDbPath(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const xdgStateHome = env.XDG_STATE_HOME
  const home = env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir()
  const base =
    xdgStateHome && isAbsolute(xdgStateHome) ? xdgStateHome : join(home, '.local', 'state')
  return resolve(base, 'pantheon', DB_FILENAME)
}

/**
 * Open Pantheon's separate user-scoped accounting DB. New DBs have no policy
 * and deny reservations. Schema upgrades are forward-only and preserve holds.
 */
export function openLocalDecisionBudgetLedger(
  options: OpenLocalDecisionBudgetOptions = {},
): LocalDecisionBudgetLedger {
  const dbPath = resolve(options.dbPath ?? resolveLocalDecisionBudgetDbPath())
  if (['opencode.db', 'install-state.json'].includes(basename(dbPath))) {
    throw new Error('The budget ledger must use its own SQLite database file')
  }
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 30_000) {
    throw new RangeError('Invalid SQLite busy timeout')
  }
  const wallClock = options.clock ?? Date.now
  const monotonicClock = options.monotonicClock ?? performance.now.bind(performance)
  const reservationIdFactory = options.reservationIdFactory ?? randomUUID

  const directoryPath = dirname(dbPath)
  ensureTrustedDirectoryChain(directoryPath)

  try {
    const file = openSync(dbPath, 'wx', 0o600)
    closeSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const fileStat = lstatSync(dbPath)
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.nlink !== 1) {
    throw new Error('Budget ledger path is not a private regular file')
  }
  if (typeof process.getuid !== 'function' || fileStat.uid !== process.getuid()) {
    throw new Error('Budget ledger file must be owned by the current user')
  }
  chmodSync(dbPath, 0o600)

  const db = new DatabaseSync(dbPath)
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}; PRAGMA foreign_keys = ON;`)
    ensureSchema(db)
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
    validateSchema(db)
  } catch (error) {
    db.close()
    throw error
  }

  let previousWallClock: number | undefined
  let previousMonotonicClock: number | undefined
  const now = (): number => {
    const wall = wallClock()
    const monotonic = monotonicClock()
    if (!Number.isSafeInteger(wall) || wall < 0 || !Number.isFinite(new Date(wall).getTime())) {
      throw new Error('Invalid ledger wall clock')
    }
    if (!Number.isFinite(monotonic) || monotonic < 0) {
      throw new Error('Invalid ledger monotonic clock')
    }
    if (previousWallClock !== undefined && previousMonotonicClock !== undefined) {
      const wallElapsed = wall - previousWallClock
      const monotonicElapsed = monotonic - previousMonotonicClock
      if (
        monotonicElapsed < 0 ||
        wallElapsed < -CLOCK_ROLLBACK_TOLERANCE_MS ||
        wallElapsed + CLOCK_ROLLBACK_TOLERANCE_MS < monotonicElapsed
      ) {
        throw new Error('Untrusted wall-clock movement')
      }
    }
    previousWallClock = wall
    previousMonotonicClock = monotonic
    return wall
  }

  function inImmediateTransaction<T>(operation: () => T): T {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = operation()
      db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // Preserve the original database failure. A failed transaction cannot admit.
      }
      throw error
    }
  }

  function configureUserCaps(capsInput: BudgetCaps): void {
    const caps = validateConfiguredCaps(capsInput)
    inImmediateTransaction(() => {
      const timestamp = now()
      db.prepare(
        `INSERT INTO user_caps (id, monthly_cap_micros, per_decision_cap_micros, updated_at_ms)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET monthly_cap_micros = excluded.monthly_cap_micros,
                                       per_decision_cap_micros = excluded.per_decision_cap_micros,
                                       updated_at_ms = excluded.updated_at_ms`,
      ).run(caps.monthlyCapMicros, caps.perDecisionCapMicros, timestamp)
    })
  }

  function configureProviderCaps(provider: BudgetProvider, capsInput: BudgetCaps): void {
    if (!isAllowedProvider(provider)) throw new TypeError('Invalid budget provider')
    const caps = validateConfiguredCaps(capsInput)
    inImmediateTransaction(() => {
      const timestamp = now()
      db.prepare(
        `INSERT INTO provider_caps (provider, monthly_cap_micros, per_decision_cap_micros, updated_at_ms)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET monthly_cap_micros = excluded.monthly_cap_micros,
                                             per_decision_cap_micros = excluded.per_decision_cap_micros,
                                             updated_at_ms = excluded.updated_at_ms`,
      ).run(provider, caps.monthlyCapMicros, caps.perDecisionCapMicros, timestamp)
    })
  }

  function configureModelCaps(
    provider: BudgetProvider,
    model: BudgetModel,
    capsInput: BudgetCaps,
  ): void {
    if (!isAllowedProvider(provider)) throw new TypeError('Invalid budget provider')
    if (!isAllowedModel(model)) throw new TypeError('Invalid budget model key')
    const caps = validateConfiguredCaps(capsInput)
    inImmediateTransaction(() => {
      const timestamp = now()
      db.prepare(
        `INSERT INTO model_caps
           (provider, model, monthly_cap_micros, per_decision_cap_micros, updated_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider, model) DO UPDATE SET
           monthly_cap_micros = excluded.monthly_cap_micros,
           per_decision_cap_micros = excluded.per_decision_cap_micros,
           updated_at_ms = excluded.updated_at_ms`,
      ).run(provider, model, caps.monthlyCapMicros, caps.perDecisionCapMicros, timestamp)
    })
  }

  function getActiveBudgetPeriod(): string | null {
    const row = db.prepare('SELECT active_period_utc FROM ledger_state WHERE id = 1').get() as
      | { active_period_utc: string | null }
      | undefined
    if (!row || row.active_period_utc === null) return null
    if (!isValidPeriod(row.active_period_utc))
      throw new Error('Invalid active period in budget ledger')
    return row.active_period_utc
  }

  function confirmBudgetPeriod(
    expectedCurrentPeriod: string | null,
    targetPeriod: string,
  ): PeriodConfirmationResult {
    if (
      (expectedCurrentPeriod !== null && !isValidPeriod(expectedCurrentPeriod)) ||
      !isValidPeriod(targetPeriod)
    ) {
      return { status: 'denied', reason: 'invalid-period' }
    }
    return inImmediateTransaction(() => {
      let wallPeriod: string
      try {
        wallPeriod = periodFor(now())
      } catch {
        return { status: 'denied', reason: 'clock-untrusted' }
      }
      const activePeriod = getActiveBudgetPeriod()
      if (activePeriod !== expectedCurrentPeriod) {
        return { status: 'denied', reason: 'stale-current' }
      }
      if (activePeriod === null) {
        if (targetPeriod !== wallPeriod) {
          return { status: 'denied', reason: 'wall-clock-mismatch' }
        }
        db.prepare(
          `INSERT INTO ledger_state (id, active_period_utc) VALUES (1, ?)
           ON CONFLICT(id) DO UPDATE SET active_period_utc = excluded.active_period_utc`,
        ).run(targetPeriod)
        return { status: 'confirmed', activePeriod: targetPeriod }
      }
      if (targetPeriod < activePeriod) return { status: 'denied', reason: 'backwards' }
      if (targetPeriod === activePeriod) return { status: 'denied', reason: 'not-next-month' }
      if (nextPeriod(activePeriod) !== targetPeriod) {
        return { status: 'denied', reason: 'not-next-month' }
      }
      if (wallPeriod !== targetPeriod) {
        return { status: 'denied', reason: 'wall-clock-mismatch' }
      }
      db.prepare('UPDATE ledger_state SET active_period_utc = ? WHERE id = 1').run(targetPeriod)
      return { status: 'confirmed', activePeriod: targetPeriod }
    })
  }

  function reserve(provider: BudgetProvider, model: BudgetModel): ReservationResult {
    if (!isAllowedProvider(provider)) return { status: 'denied', reason: 'invalid-provider' }
    if (!isAllowedModel(model)) return { status: 'denied', reason: 'invalid-model' }
    return inImmediateTransaction(() => {
      const admission = checkAdmission(provider, model)
      if (admission.status === 'denied') return admission

      const reservationId = reservationIdFactory()
      if (typeof reservationId !== 'string' || !RESERVATION_ID.test(reservationId)) {
        throw new Error('Invalid generated reservation identifier')
      }
      const duplicate = db
        .prepare('SELECT 1 AS found FROM reservations WHERE id = ?')
        .get(reservationId)
      if (duplicate) return { status: 'denied', reason: 'duplicate-reservation-id' }
      db.prepare(
        `INSERT INTO reservations
           (id, provider, model, period_utc, reserved_micros, actual_micros, state,
            created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, NULL, 'pending', ?, ?)`,
      ).run(
        reservationId,
        provider,
        model,
        admission.period,
        admission.reservedMicros,
        admission.timestamp,
        admission.timestamp,
      )
      return {
        status: 'reserved',
        reservationId,
        period: admission.period,
        reservedMicros: admission.reservedMicros,
      }
    })
  }

  function canReserve(provider: BudgetProvider, model: BudgetModel): AdmissionCheckResult {
    if (!isAllowedProvider(provider)) return { status: 'denied', reason: 'invalid-provider' }
    if (!isAllowedModel(model)) return { status: 'denied', reason: 'invalid-model' }
    return inImmediateTransaction(() => {
      const admission = checkAdmission(provider, model)
      return admission.status === 'denied' ? admission : { status: 'eligible' }
    })
  }

  function checkAdmission(
    provider: BudgetProvider,
    model: BudgetModel,
  ):
    | { status: 'eligible'; period: string; reservedMicros: number; timestamp: number }
    | { status: 'denied'; reason: ReservationDenialReason } {
    let timestamp: number
    let wallPeriod: string
    try {
      timestamp = now()
      wallPeriod = periodFor(timestamp)
    } catch {
      return { status: 'denied', reason: 'clock-untrusted' }
    }
    const userCaps = readUserCaps()
    const providerCaps = readProviderCaps(provider)
    const modelCaps = readModelCaps(provider, model)
    if (
      !hasPositiveCaps(userCaps) ||
      !hasPositiveCaps(providerCaps) ||
      !hasPositiveCaps(modelCaps)
    ) {
      return { status: 'denied', reason: 'no-cap' }
    }

    const period = getActiveBudgetPeriod()
    if (period === null) return { status: 'denied', reason: 'period-unconfirmed' }
    if (wallPeriod !== period) return { status: 'denied', reason: 'period-mismatch' }

    const reservedMicros = modelCaps.per_decision_cap_micros
    if (
      reservedMicros > userCaps.per_decision_cap_micros ||
      reservedMicros > providerCaps.per_decision_cap_micros
    ) {
      return { status: 'denied', reason: 'per-decision-cap' }
    }
    if (isFrozen(period, provider, model)) return { status: 'denied', reason: 'frozen' }

    if (
      wouldExceed(sumReservations(period), reservedMicros, userCaps.monthly_cap_micros) ||
      wouldExceed(
        sumReservations(period, provider),
        reservedMicros,
        providerCaps.monthly_cap_micros,
      ) ||
      wouldExceed(
        sumReservations(period, provider, model),
        reservedMicros,
        modelCaps.monthly_cap_micros,
      )
    ) {
      return { status: 'denied', reason: 'monthly-cap' }
    }
    return { status: 'eligible', period, reservedMicros, timestamp }
  }

  function reconcileVerified(
    reservationId: string,
    evidence: VerifiedUsageEvidence,
  ): ReconciliationResult {
    if (typeof reservationId !== 'string' || !RESERVATION_ID.test(reservationId)) {
      return { status: 'unknown' }
    }
    const verified = getVerifiedUsageEvidenceDetails(evidence)
    if (
      !verified ||
      !Number.isSafeInteger(verified.actualCostMicros) ||
      verified.actualCostMicros <= 0 ||
      !isAllowedProvider(verified.provider) ||
      !isAllowedModel(verified.model) ||
      !isValidPeriod(verified.period)
    ) {
      return { status: 'unknown' }
    }
    return inImmediateTransaction(() => {
      const row = db
        .prepare(
          `SELECT provider, model, period_utc, reserved_micros, state
           FROM reservations WHERE id = ?`,
        )
        .get(reservationId) as
        | {
            provider: BudgetProvider
            model: string
            period_utc: string
            reserved_micros: number
            state: string
          }
        | undefined
      if (!row) return { status: 'missing' }
      if (row.state === 'reconciled') return { status: 'already-reconciled' }
      if (row.state !== 'pending' && row.state !== 'uncertain') {
        throw new Error('Invalid reservation state')
      }
      if (
        verified.reservationId !== reservationId ||
        verified.provider !== row.provider ||
        verified.model !== row.model ||
        verified.period !== row.period_utc
      ) {
        return { status: 'mismatch' }
      }
      const timestamp = now()
      const update = db
        .prepare(
          `UPDATE reservations SET actual_micros = ?, state = 'reconciled', updated_at_ms = ?
           WHERE id = ? AND state IN ('pending', 'uncertain')`,
        )
        .run(verified.actualCostMicros, timestamp, reservationId)
      if (safeChangeCount(update.changes) !== 1) {
        throw new Error('Reservation state changed unexpectedly')
      }
      const frozen = verified.actualCostMicros > row.reserved_micros
      if (frozen) freezeBuckets(row.period_utc, row.provider, row.model, timestamp)
      return { status: 'reconciled', actualCostMicros: verified.actualCostMicros, frozen }
    })
  }

  function sumReservations(period: string, provider?: BudgetProvider, model?: string): number {
    // Future-dated v2 holds may have resulted from an untrusted clock jump.
    const where = ['period_utc >= ?']
    const params: Array<string> = [period]
    if (provider !== undefined) {
      where.push('provider = ?')
      params.push(provider)
    }
    if (model !== undefined) {
      where.push('model = ?')
      params.push(model)
    }
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN state = 'reconciled' THEN actual_micros ELSE reserved_micros END), 0) AS amount
         FROM reservations WHERE ${where.join(' AND ')}`,
      )
      .get(...params) as { amount: number | bigint }
    return safeMicrosTotal(row.amount)
  }

  function isFrozen(period: string, provider: BudgetProvider, model: string): boolean {
    return Boolean(
      db
        .prepare(
          `SELECT 1 AS found FROM budget_freezes
           WHERE period_utc >= ? AND (
             (scope = 'user' AND provider IS NULL AND model IS NULL) OR
             (scope = 'provider' AND provider = ? AND model IS NULL) OR
             (scope = 'model' AND provider = ? AND model = ?)
           ) LIMIT 1`,
        )
        .get(period, provider, provider, model),
    )
  }

  function freezeBuckets(
    period: string,
    provider: BudgetProvider,
    model: string,
    timestamp: number,
  ): void {
    const insertIfMissing = db.prepare(
      `INSERT INTO budget_freezes (scope, provider, model, period_utc, reason, created_at_ms)
       VALUES (?, ?, ?, ?, 'overrun', ?)
       ON CONFLICT DO NOTHING`,
    )
    insertIfMissing.run('user', null, null, period, timestamp)
    insertIfMissing.run('provider', provider, null, period, timestamp)
    insertIfMissing.run('model', provider, model, period, timestamp)
  }

  function listUncertainReservations(): UncertainReservation[] {
    const rows = db
      .prepare(
        `SELECT id, provider, model, period_utc, reserved_micros, state, created_at_ms, updated_at_ms
         FROM reservations WHERE state IN ('pending', 'uncertain') ORDER BY created_at_ms, id`,
      )
      .all() as Array<{
      id: string
      provider: BudgetProvider
      model: string
      period_utc: string
      reserved_micros: number
      state: 'pending' | 'uncertain'
      created_at_ms: number
      updated_at_ms: number
    }>
    return rows.map((row) => ({
      reservationId: row.id,
      provider: row.provider,
      model: row.model,
      period: row.period_utc,
      reservedMicros: row.reserved_micros,
      state: row.state,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    }))
  }

  function recoverPendingReservations(): number {
    return inImmediateTransaction(() => {
      const timestamp = now()
      const result = db
        .prepare(
          `UPDATE reservations SET state = 'uncertain', updated_at_ms = ? WHERE state = 'pending'`,
        )
        .run(timestamp)
      return safeChangeCount(result.changes)
    })
  }

  function pruneCompletedPeriods(): number {
    return inImmediateTransaction(() => {
      let currentPeriod: string
      try {
        currentPeriod = periodFor(now())
      } catch {
        return 0
      }
      const activePeriod = getActiveBudgetPeriod()
      if (activePeriod === null || currentPeriod !== activePeriod) return 0
      const result = db
        .prepare(
          `DELETE FROM reservations AS completed
           WHERE completed.period_utc < ? AND completed.state = 'reconciled'
             AND NOT EXISTS (
               SELECT 1 FROM reservations AS unresolved
               WHERE unresolved.period_utc = completed.period_utc
                 AND unresolved.state IN ('pending', 'uncertain')
             )`,
        )
        .run(activePeriod)
      db.prepare(
        `DELETE FROM budget_freezes
         WHERE period_utc < ? AND NOT EXISTS (
           SELECT 1 FROM reservations AS unresolved
           WHERE unresolved.period_utc = budget_freezes.period_utc
             AND unresolved.state IN ('pending', 'uncertain')
         )`,
      ).run(activePeriod)
      return safeChangeCount(result.changes)
    })
  }

  function readUserCaps(): StoredCaps | undefined {
    return db
      .prepare('SELECT monthly_cap_micros, per_decision_cap_micros FROM user_caps WHERE id = 1')
      .get() as StoredCaps | undefined
  }

  function readProviderCaps(provider: BudgetProvider): StoredCaps | undefined {
    return db
      .prepare(
        'SELECT monthly_cap_micros, per_decision_cap_micros FROM provider_caps WHERE provider = ?',
      )
      .get(provider) as StoredCaps | undefined
  }

  function readModelCaps(provider: BudgetProvider, model: string): StoredCaps | undefined {
    return db
      .prepare(
        `SELECT monthly_cap_micros, per_decision_cap_micros
         FROM model_caps WHERE provider = ? AND model = ?`,
      )
      .get(provider, model) as StoredCaps | undefined
  }

  return {
    configureUserCaps,
    configureProviderCaps,
    configureModelCaps,
    confirmBudgetPeriod,
    getActiveBudgetPeriod,
    canReserve,
    reserve,
    reconcileVerified,
    listUncertainReservations,
    recoverPendingReservations,
    pruneCompletedPeriods,
    close: () => db.close(),
  }
}

interface StoredCaps {
  monthly_cap_micros: number
  per_decision_cap_micros: number
}

function ensureSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version
    const applicationId = (db.prepare('PRAGMA application_id').get() as { application_id: number })
      .application_id
    if (version === 0) {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
      if (applicationId !== 0 || tables.length !== 0) {
        throw new Error('Refusing to initialize an unrecognized SQLite database')
      }
      createSchemaV3(db)
    } else if (version === 1 && applicationId === APPLICATION_ID) {
      migrateVersionOne(db)
      migrateVersionTwoToThree(db)
    } else if (version === VERSION_TWO && applicationId === APPLICATION_ID) {
      migrateVersionTwoToThree(db)
    } else if (version !== SCHEMA_VERSION || applicationId !== APPLICATION_ID) {
      throw new Error('Unsupported or incompatible local decision budget database schema')
    }
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // Preserve schema/migration error.
    }
    throw error
  }
}

function createSchemaV3(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE user_caps (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      monthly_cap_micros INTEGER NOT NULL CHECK (monthly_cap_micros >= 0),
      per_decision_cap_micros INTEGER NOT NULL CHECK (per_decision_cap_micros >= 0),
      updated_at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE provider_caps (
      provider TEXT PRIMARY KEY NOT NULL,
      monthly_cap_micros INTEGER NOT NULL CHECK (monthly_cap_micros >= 0),
      per_decision_cap_micros INTEGER NOT NULL CHECK (per_decision_cap_micros >= 0),
      updated_at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE model_caps (
      provider TEXT NOT NULL,
      model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
      monthly_cap_micros INTEGER NOT NULL CHECK (monthly_cap_micros >= 0),
      per_decision_cap_micros INTEGER NOT NULL CHECK (per_decision_cap_micros >= 0),
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (provider, model)
    ) STRICT;
    CREATE TABLE reservations (
      id TEXT PRIMARY KEY NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
      period_utc TEXT NOT NULL CHECK (length(period_utc) = 7),
      reserved_micros INTEGER NOT NULL CHECK (reserved_micros > 0),
      actual_micros INTEGER CHECK (actual_micros IS NULL OR actual_micros >= 0),
      state TEXT NOT NULL CHECK (state IN ('pending', 'uncertain', 'reconciled')),
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      CHECK ((state = 'reconciled' AND actual_micros IS NOT NULL) OR
             (state IN ('pending', 'uncertain') AND actual_micros IS NULL))
    ) STRICT;
    CREATE INDEX reservations_provider_period_idx ON reservations (provider, period_utc, state);
    CREATE INDEX reservations_model_period_idx
      ON reservations (provider, model, period_utc, state);
    CREATE INDEX reservations_period_state_idx ON reservations (period_utc, state);
    CREATE INDEX reservations_state_created_idx ON reservations (state, created_at_ms, id);
    CREATE TABLE ledger_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active_period_utc TEXT CHECK (active_period_utc IS NULL OR length(active_period_utc) = 7)
    ) STRICT;
    CREATE TABLE budget_freezes (
      id INTEGER PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('user', 'provider', 'model')),
      provider TEXT,
      model TEXT,
      period_utc TEXT NOT NULL CHECK (length(period_utc) = 7),
      reason TEXT NOT NULL CHECK (reason = 'overrun'),
      created_at_ms INTEGER NOT NULL,
      CHECK ((scope = 'user' AND provider IS NULL AND model IS NULL) OR
             (scope = 'provider' AND provider IS NOT NULL AND model IS NULL) OR
             (scope = 'model' AND provider IS NOT NULL AND model IS NOT NULL))
    ) STRICT;
    CREATE UNIQUE INDEX budget_freezes_unique_idx
      ON budget_freezes (scope, ifnull(provider, ''), ifnull(model, ''), period_utc);
    CREATE INDEX budget_freezes_period_scope_idx
      ON budget_freezes (period_utc, scope, provider, model);
    PRAGMA application_id = ${APPLICATION_ID};
    PRAGMA user_version = ${SCHEMA_VERSION};
  `)
}

function migrateVersionTwoToThree(db: DatabaseSync): void {
  validateVersionTwoSchema(db)
  db.exec(`
    UPDATE reservations SET
      reserved_micros = CASE
        WHEN actual_micros > reserved_micros THEN actual_micros
        ELSE reserved_micros
      END,
      state = 'uncertain', actual_micros = NULL
      WHERE state = 'reconciled';
    ALTER TABLE ledger_state RENAME TO ledger_state_v2;
    CREATE TABLE ledger_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      active_period_utc TEXT CHECK (active_period_utc IS NULL OR length(active_period_utc) = 7)
    ) STRICT;
    INSERT INTO ledger_state (id, active_period_utc)
      SELECT id, NULL FROM ledger_state_v2;
    DROP TABLE ledger_state_v2;
    PRAGMA user_version = ${SCHEMA_VERSION};
  `)
}

function migrateVersionOne(db: DatabaseSync): void {
  validateVersionOneSchema(db)
  const providers = db
    .prepare('SELECT DISTINCT provider FROM reservations UNION SELECT provider FROM provider_caps')
    .all() as Array<{ provider: string }>
  if (providers.some(({ provider }) => provider !== 'openai-decisions' && provider !== 'jev')) {
    throw new Error('Refusing to migrate an unsupported version-one provider')
  }
  db.exec(`
    ALTER TABLE reservations
      ADD COLUMN model TEXT NOT NULL DEFAULT 'legacy-unknown'
      CHECK (length(model) BETWEEN 1 AND 128);
    UPDATE reservations SET model = 'gpt-6-luna' WHERE provider = 'openai-decisions';
    UPDATE reservations SET provider = 'typesafe-jev', model = 'jev-1.14.0' WHERE provider = 'jev';
    UPDATE provider_caps SET provider = 'typesafe-jev' WHERE provider = 'jev';
    CREATE TABLE user_caps (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      monthly_cap_micros INTEGER NOT NULL CHECK (monthly_cap_micros >= 0),
      per_decision_cap_micros INTEGER NOT NULL CHECK (per_decision_cap_micros >= 0),
      updated_at_ms INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE model_caps (
      provider TEXT NOT NULL,
      model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 128),
      monthly_cap_micros INTEGER NOT NULL CHECK (monthly_cap_micros >= 0),
      per_decision_cap_micros INTEGER NOT NULL CHECK (per_decision_cap_micros >= 0),
      updated_at_ms INTEGER NOT NULL,
      PRIMARY KEY (provider, model)
    ) STRICT;
    CREATE INDEX reservations_model_period_idx
      ON reservations (provider, model, period_utc, state);
    CREATE INDEX reservations_state_created_idx ON reservations (state, created_at_ms, id);
    CREATE TABLE budget_freezes (
      id INTEGER PRIMARY KEY,
      scope TEXT NOT NULL CHECK (scope IN ('user', 'provider', 'model')),
      provider TEXT,
      model TEXT,
      period_utc TEXT NOT NULL CHECK (length(period_utc) = 7),
      reason TEXT NOT NULL CHECK (reason = 'overrun'),
      created_at_ms INTEGER NOT NULL,
      CHECK ((scope = 'user' AND provider IS NULL AND model IS NULL) OR
             (scope = 'provider' AND provider IS NOT NULL AND model IS NULL) OR
             (scope = 'model' AND provider IS NOT NULL AND model IS NOT NULL))
    ) STRICT;
    CREATE UNIQUE INDEX budget_freezes_unique_idx
      ON budget_freezes (scope, ifnull(provider, ''), ifnull(model, ''), period_utc);
    CREATE INDEX budget_freezes_period_scope_idx
      ON budget_freezes (period_utc, scope, provider, model);
    PRAGMA user_version = ${VERSION_TWO};
  `)
}

function validateVersionOneSchema(db: DatabaseSync): void {
  db.prepare(
    `SELECT provider, monthly_cap_micros, per_decision_cap_micros, updated_at_ms
     FROM provider_caps LIMIT 0`,
  )
  db.prepare(
    `SELECT id, provider, period_utc, reserved_micros, actual_micros, state,
            created_at_ms, updated_at_ms FROM reservations LIMIT 0`,
  )
  db.prepare('SELECT id, highest_period_utc, last_seen_ms FROM ledger_state LIMIT 0')
}

function validateVersionTwoSchema(db: DatabaseSync): void {
  db.prepare(
    'SELECT id, monthly_cap_micros, per_decision_cap_micros, updated_at_ms FROM user_caps LIMIT 0',
  )
  db.prepare(
    'SELECT provider, monthly_cap_micros, per_decision_cap_micros, updated_at_ms FROM provider_caps LIMIT 0',
  )
  db.prepare(
    'SELECT provider, model, monthly_cap_micros, per_decision_cap_micros, updated_at_ms FROM model_caps LIMIT 0',
  )
  db.prepare(
    `SELECT id, provider, model, period_utc, reserved_micros, actual_micros, state,
            created_at_ms, updated_at_ms FROM reservations LIMIT 0`,
  )
  db.prepare('SELECT id, highest_period_utc, last_seen_ms FROM ledger_state LIMIT 0')
  db.prepare(
    'SELECT id, scope, provider, model, period_utc, reason, created_at_ms FROM budget_freezes LIMIT 0',
  )
}

function validateSchema(db: DatabaseSync): void {
  db.prepare(
    `SELECT id, monthly_cap_micros, per_decision_cap_micros, updated_at_ms FROM user_caps LIMIT 0`,
  )
  db.prepare(
    `SELECT provider, monthly_cap_micros, per_decision_cap_micros, updated_at_ms
     FROM provider_caps LIMIT 0`,
  )
  db.prepare(
    `SELECT provider, model, monthly_cap_micros, per_decision_cap_micros, updated_at_ms
     FROM model_caps LIMIT 0`,
  )
  db.prepare(
    `SELECT id, provider, model, period_utc, reserved_micros, actual_micros, state,
            created_at_ms, updated_at_ms FROM reservations LIMIT 0`,
  )
  db.prepare('SELECT id, active_period_utc FROM ledger_state LIMIT 0')
  db.prepare(
    `SELECT id, scope, provider, model, period_utc, reason, created_at_ms
     FROM budget_freezes LIMIT 0`,
  )
}

function validateConfiguredCaps(value: unknown): BudgetCaps {
  if (!isPlainRecord(value)) throw new TypeError('Caps must be an object')
  const keys = Object.keys(value).sort()
  if (keys.join(',') !== 'monthlyCapMicros,perDecisionCapMicros') {
    throw new TypeError('Caps must contain only monthly and per-decision values')
  }
  if (!isValidCap(value.monthlyCapMicros) || !isValidCap(value.perDecisionCapMicros)) {
    throw new TypeError('Caps must be non-negative safe integer USD micros')
  }
  return {
    monthlyCapMicros: value.monthlyCapMicros,
    perDecisionCapMicros: value.perDecisionCapMicros,
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  try {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value))
  } catch {
    return false
  }
}

function isAllowedProvider(provider: unknown): provider is BudgetProvider {
  return typeof provider === 'string' && ALLOWED_PROVIDERS.has(provider as BudgetProvider)
}

function isAllowedModel(model: unknown): model is BudgetModel {
  return typeof model === 'string' && MODEL_KEY.test(model)
}

function isValidCap(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function hasPositiveCaps(value: StoredCaps | undefined): value is StoredCaps {
  return Boolean(
    value &&
      isValidCap(value.monthly_cap_micros) &&
      value.monthly_cap_micros > 0 &&
      isValidCap(value.per_decision_cap_micros) &&
      value.per_decision_cap_micros > 0,
  )
}

function wouldExceed(current: number, additional: number, cap: number): boolean {
  return current > cap || additional > cap - current
}

function safeMicrosTotal(value: number | bigint): number {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) {
      throw new Error('Invalid spend total in budget ledger')
    }
    return Number(value)
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid spend total in budget ledger')
  }
  return value
}

function periodFor(timestamp: number): string {
  const period = new Date(timestamp).toISOString().slice(0, 7)
  if (!isValidPeriod(period)) throw new Error('Invalid UTC accounting period')
  return period
}

function isValidPeriod(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
}

function nextPeriod(period: string): string | null {
  if (!isValidPeriod(period)) return null
  let year = Number(period.slice(0, 4))
  let month = Number(period.slice(5, 7)) + 1
  if (month === 13) {
    year += 1
    month = 1
  }
  if (year > 9999) return null
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
}

function safeChangeCount(value: number | bigint): number {
  const count = Number(value)
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid SQLite change count')
  return count
}

function ensureTrustedDirectoryChain(directoryPath: string): void {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    throw new Error('Secure budget-ledger path validation is unavailable on this platform')
  }
  const uid = process.getuid()
  const absolute = resolve(directoryPath)
  const root = parse(absolute).root
  let current = root
  validateDirectoryTrust(lstatSync(current), uid, current === absolute)

  for (const component of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component)
    try {
      lstatSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        mkdirSync(current, { mode: 0o700 })
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError
      }
    }
    const stat = lstatSync(current)
    const isFinalDirectory = current === absolute
    validateDirectoryTrust(stat, uid, isFinalDirectory)
    if (isFinalDirectory) {
      chmodSync(current, 0o700)
      validateDirectoryTrust(lstatSync(current), uid, true)
    }
  }
}

function validateDirectoryTrust(stat: Stats, uid: number, isFinalDirectory: boolean): void {
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('Budget ledger path contains a non-directory or symlink ancestor')
  }
  if (stat.uid !== uid && stat.uid !== 0) {
    throw new Error('Budget ledger path contains an untrusted owner')
  }
  if (isFinalDirectory && stat.uid !== uid) {
    throw new Error('Budget ledger directory must be owned by the current user')
  }
  const mode = stat.mode & 0o7777
  const writableByOthers = (mode & 0o022) !== 0
  const rootStickyDirectory = stat.uid === 0 && (mode & 0o1000) !== 0
  if (writableByOthers && !rootStickyDirectory) {
    throw new Error('Budget ledger path contains a group/other-writable directory')
  }
}
