/**
 * V2 decision budget surface — three separate concerns, never one blob (D6).
 *
 * The defect this closes: CAP, PERIOD and LEDGER were coupled inside
 * `local-decision-budget.ts`, so a read of one concern went through the same
 * open path as the others and an administrative listing could create the
 * database or apply a forward-only migration. This module separates them:
 *
 *   - **cap**    — user / provider / model USD micros, and the per-decision
 *                  hierarchy between them;
 *   - **period** — the explicitly confirmed UTC accounting month and the wall
 *                  clock it must match;
 *   - **ledger** — committed spend, freeze state and whether the SQLite file is
 *                  even present.
 *
 * Each concern has its own gate and its own reason-code set, so a caller can
 * exercise one without the others, and each denial names the concern that
 * produced it. The gates are **diagnostic**: they explain why admission would
 * be refused. They never reserve, reconcile, prune or write; the accounting
 * authority remains the transactional ledger in `local-decision-budget.ts`.
 *
 * Reads are strictly read-only: `node:sqlite` is opened with `readOnly: true`,
 * which cannot create the file and cannot migrate it. A missing database is a
 * fact (`present: false`), not an error and not a reason to create one.
 */
import { lstatSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

/** The three decoupled concerns. */
export type DecisionBudgetConcern = 'cap' | 'period' | 'ledger'

export interface DecisionCaps {
  readonly monthlyCapMicros: number
  readonly perDecisionCapMicros: number
}

// ---------------------------------------------------------------------------
// CAP concern
// ---------------------------------------------------------------------------

export type CapGateDenial = 'no-cap' | 'per-decision-cap' | 'invalid-caps'

export type CapGateResult =
  | { concern: 'cap'; ok: true; reservedMicros: number }
  | { concern: 'cap'; ok: false; reason: CapGateDenial }

export interface CapGateInput {
  readonly user: DecisionCaps | undefined
  readonly provider: DecisionCaps | undefined
  readonly model: DecisionCaps | undefined
}

function isPositiveCaps(value: DecisionCaps | undefined): value is DecisionCaps {
  return (
    value !== undefined &&
    Number.isSafeInteger(value.monthlyCapMicros) &&
    Number.isSafeInteger(value.perDecisionCapMicros) &&
    value.monthlyCapMicros > 0 &&
    value.perDecisionCapMicros > 0
  )
}

/**
 * Decide only the CAP concern.
 *
 * The per-decision reservation is the model's configured maximum, and no wider
 * scope may admit more than its own per-decision cap — the same hierarchy the
 * ledger enforces. Zero and missing caps deny: there are no default caps.
 */
export function evaluateCapGate(input: CapGateInput): CapGateResult {
  const { user, provider, model } = input
  for (const caps of [user, provider, model]) {
    if (caps === undefined) continue
    if (
      !Number.isSafeInteger(caps.monthlyCapMicros) ||
      !Number.isSafeInteger(caps.perDecisionCapMicros) ||
      caps.monthlyCapMicros < 0 ||
      caps.perDecisionCapMicros < 0
    ) {
      return { concern: 'cap', ok: false, reason: 'invalid-caps' }
    }
  }
  if (!isPositiveCaps(user) || !isPositiveCaps(provider) || !isPositiveCaps(model)) {
    return { concern: 'cap', ok: false, reason: 'no-cap' }
  }
  const reservedMicros = model.perDecisionCapMicros
  if (
    reservedMicros > user.perDecisionCapMicros ||
    reservedMicros > provider.perDecisionCapMicros
  ) {
    return { concern: 'cap', ok: false, reason: 'per-decision-cap' }
  }
  return { concern: 'cap', ok: true, reservedMicros }
}

// ---------------------------------------------------------------------------
// PERIOD concern
// ---------------------------------------------------------------------------

export type PeriodGateDenial = 'invalid-period' | 'period-unconfirmed' | 'period-mismatch'

export type PeriodGateResult =
  | { concern: 'period'; ok: true; period: string }
  | { concern: 'period'; ok: false; reason: PeriodGateDenial }

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/

/** The UTC accounting month of an instant. No timezone is assumed. */
export function utcPeriodOf(instantMs: number): string | null {
  if (!Number.isSafeInteger(instantMs) || instantMs < 0) return null
  const period = new Date(instantMs).toISOString().slice(0, 7)
  return PERIOD_PATTERN.test(period) ? period : null
}

/**
 * Decide only the PERIOD concern.
 *
 * An unconfirmed period denies; a confirmed period must equal the current UTC
 * month. Crossing a calendar month never advances it automatically — that is
 * still an explicit `period confirm` action.
 */
export function evaluatePeriodGate(input: {
  readonly activePeriod: string | null
  readonly wallPeriod: string | null
}): PeriodGateResult {
  if (input.wallPeriod === null || !PERIOD_PATTERN.test(input.wallPeriod)) {
    return { concern: 'period', ok: false, reason: 'invalid-period' }
  }
  if (input.activePeriod === null) {
    return { concern: 'period', ok: false, reason: 'period-unconfirmed' }
  }
  if (!PERIOD_PATTERN.test(input.activePeriod)) {
    return { concern: 'period', ok: false, reason: 'invalid-period' }
  }
  if (input.activePeriod !== input.wallPeriod) {
    return { concern: 'period', ok: false, reason: 'period-mismatch' }
  }
  return { concern: 'period', ok: true, period: input.activePeriod }
}

// ---------------------------------------------------------------------------
// LEDGER concern
// ---------------------------------------------------------------------------

export type LedgerGateDenial = 'ledger-missing' | 'frozen' | 'monthly-cap'

export type LedgerGateResult =
  | { concern: 'ledger'; ok: true }
  | { concern: 'ledger'; ok: false; reason: LedgerGateDenial }

/**
 * Decide only the LEDGER concern: capacity against the three monthly buckets,
 * plus an explicit freeze. It receives amounts, never reads the database.
 */
export function evaluateLedgerGate(input: {
  readonly present: boolean
  readonly frozen: boolean
  readonly reservedMicros: number
  readonly userCommittedMicros: number
  readonly userMonthlyCapMicros: number
  readonly providerCommittedMicros: number
  readonly providerMonthlyCapMicros: number
  readonly modelCommittedMicros: number
  readonly modelMonthlyCapMicros: number
}): LedgerGateResult {
  if (!input.present) return { concern: 'ledger', ok: false, reason: 'ledger-missing' }
  if (input.frozen) return { concern: 'ledger', ok: false, reason: 'frozen' }
  const additional = input.reservedMicros
  const exceeds = (committed: number, cap: number): boolean =>
    committed > cap || additional > cap - committed
  if (
    exceeds(input.userCommittedMicros, input.userMonthlyCapMicros) ||
    exceeds(input.providerCommittedMicros, input.providerMonthlyCapMicros) ||
    exceeds(input.modelCommittedMicros, input.modelMonthlyCapMicros)
  ) {
    return { concern: 'ledger', ok: false, reason: 'monthly-cap' }
  }
  return { concern: 'ledger', ok: true }
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export type DecisionBudgetAdmission =
  | { admitted: true; period: string; reservedMicros: number }
  | {
      admitted: false
      concern: DecisionBudgetConcern
      reason: CapGateDenial | PeriodGateDenial | LedgerGateDenial
    }

/**
 * Compose the three gates in a fixed order — cap, period, ledger — so the same
 * input always reports the same concern. The order matters for explanation
 * only: every denial is a refusal either way.
 */
export function evaluateDecisionBudgetAdmission(input: {
  readonly caps: CapGateInput
  readonly period: { readonly activePeriod: string | null; readonly wallPeriod: string | null }
  readonly ledger: Omit<Parameters<typeof evaluateLedgerGate>[0], 'present' | 'reservedMicros'>
}): DecisionBudgetAdmission {
  const cap = evaluateCapGate(input.caps)
  if (!cap.ok) return { admitted: false, concern: cap.concern, reason: cap.reason }
  const period = evaluatePeriodGate(input.period)
  if (!period.ok) return { admitted: false, concern: period.concern, reason: period.reason }
  const ledger = evaluateLedgerGate({
    ...input.ledger,
    present: true,
    reservedMicros: cap.reservedMicros,
  })
  if (!ledger.ok) return { admitted: false, concern: ledger.concern, reason: ledger.reason }
  return { admitted: true, period: period.period, reservedMicros: cap.reservedMicros }
}

// ---------------------------------------------------------------------------
// Read-only inspection
// ---------------------------------------------------------------------------

export type DecisionBudgetLedgerFacts =
  | { present: false }
  | {
      present: true
      readable: true
      schemaVersion: number
      applicationId: number
      activePeriod: string | null
      reservations: number
      holds: number
      freezes: number
    }
  | { present: true; readable: false; reason: 'not-a-regular-file' | 'unsupported-schema' }

export interface DecisionCapFacts {
  readonly user: DecisionCaps | null
  readonly providers: Readonly<Record<string, DecisionCaps>>
  readonly models: Readonly<Record<string, DecisionCaps>>
}

const EXPECTED_APPLICATION_ID = 0x50424c31

type DbPathKind = 'missing' | 'regular' | 'unsafe'

function classifyDbPath(dbPath: string): DbPathKind {
  try {
    const stat = lstatSync(dbPath)
    return stat.isFile() && !stat.isSymbolicLink() ? 'regular' : 'unsafe'
  } catch {
    return 'missing'
  }
}

function readCapsRow(
  db: DatabaseSync,
  sql: string,
): { monthly: number; perDecision: number } | null {
  const row = db.prepare(sql).get() as
    | { monthly_cap_micros: number | bigint; per_decision_cap_micros: number | bigint }
    | undefined
  if (!row) return null
  return {
    monthly: Number(row.monthly_cap_micros),
    perDecision: Number(row.per_decision_cap_micros),
  }
}

/**
 * Read the LEDGER concern without creating or migrating anything.
 *
 * `present: false` is returned when the file is absent — the caller must not
 * conclude "no spend"; only "no ledger". A schema this module does not know is
 * reported as unreadable rather than opened for migration.
 */
export function readDecisionBudgetLedgerFacts(dbPath: string): DecisionBudgetLedgerFacts {
  const kind = classifyDbPath(dbPath)
  if (kind === 'missing') return { present: false }
  if (kind === 'unsafe') {
    return { present: true, readable: false, reason: 'not-a-regular-file' }
  }
  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return { present: true, readable: false, reason: 'unsupported-schema' }
  }
  try {
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version
    const applicationId = (db.prepare('PRAGMA application_id').get() as { application_id: number })
      .application_id
    if (applicationId !== EXPECTED_APPLICATION_ID || version !== 3) {
      return { present: true, readable: false, reason: 'unsupported-schema' }
    }
    const activeRow = db.prepare('SELECT active_period_utc FROM ledger_state WHERE id = 1').get() as
      | { active_period_utc: string | null }
      | undefined
    const counts = db
      .prepare(
        `SELECT
           COUNT(*) AS reservations,
           COALESCE(SUM(CASE WHEN state IN ('pending', 'uncertain') THEN 1 ELSE 0 END), 0) AS holds
         FROM reservations`,
      )
      .get() as { reservations: number | bigint; holds: number | bigint }
    const freezes = db.prepare('SELECT COUNT(*) AS total FROM budget_freezes').get() as {
      total: number | bigint
    }
    return {
      present: true,
      readable: true,
      schemaVersion: version,
      applicationId,
      activePeriod: activeRow?.active_period_utc ?? null,
      reservations: Number(counts.reservations),
      holds: Number(counts.holds),
      freezes: Number(freezes.total),
    }
  } catch {
    return { present: true, readable: false, reason: 'unsupported-schema' }
  } finally {
    db.close()
  }
}

/**
 * Read the CAP concern only. Returns `null` when the ledger does not exist, so
 * an absent database never looks like "caps configured to zero".
 */
export function readDecisionCapFacts(dbPath: string): DecisionCapFacts | null {
  if (classifyDbPath(dbPath) !== 'regular') return null
  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return null
  }
  try {
    const user = readCapsRow(
      db,
      'SELECT monthly_cap_micros, per_decision_cap_micros FROM user_caps WHERE id = 1',
    )
    const providers: Record<string, DecisionCaps> = {}
    for (const row of db
      .prepare('SELECT provider, monthly_cap_micros, per_decision_cap_micros FROM provider_caps')
      .all() as Array<{
      provider: string
      monthly_cap_micros: number | bigint
      per_decision_cap_micros: number | bigint
    }>) {
      providers[row.provider] = {
        monthlyCapMicros: Number(row.monthly_cap_micros),
        perDecisionCapMicros: Number(row.per_decision_cap_micros),
      }
    }
    const models: Record<string, DecisionCaps> = {}
    for (const row of db
      .prepare(
        'SELECT provider, model, monthly_cap_micros, per_decision_cap_micros FROM model_caps',
      )
      .all() as Array<{
      provider: string
      model: string
      monthly_cap_micros: number | bigint
      per_decision_cap_micros: number | bigint
    }>) {
      models[`${row.provider}/${row.model}`] = {
        monthlyCapMicros: Number(row.monthly_cap_micros),
        perDecisionCapMicros: Number(row.per_decision_cap_micros),
      }
    }
    return {
      user:
        user === null
          ? null
          : { monthlyCapMicros: user.monthly, perDecisionCapMicros: user.perDecision },
      providers,
      models,
    }
  } catch {
    return null
  } finally {
    db.close()
  }
}

/** Convenience: the three concerns read through one call, each still separate. */
export function inspectDecisionBudget(dbPath: string): {
  ledger: DecisionBudgetLedgerFacts
  caps: DecisionCapFacts | null
  period: { activePeriod: string | null }
} {
  const ledger = readDecisionBudgetLedgerFacts(dbPath)
  const caps = readDecisionCapFacts(dbPath)
  const activePeriod = ledger.present && ledger.readable ? ledger.activePeriod : null
  return { ledger, caps, period: { activePeriod } }
}

export interface DecisionHoldRow {
  readonly reservationId: string
  readonly provider: string
  readonly model: string
  readonly period: string
  readonly reservedMicros: number
  readonly state: 'pending' | 'uncertain'
}

/**
 * List unresolved holds read-only.
 *
 * The previous listing opened the ledger for write, so a read could create the
 * database or apply a forward-only migration (D8). This one cannot: the
 * connection is read-only, and a missing or unknown-schema ledger returns
 * `null` instead of being created or migrated.
 */
export function listDecisionHoldsReadOnly(dbPath: string): DecisionHoldRow[] | null {
  if (classifyDbPath(dbPath) !== 'regular') return null
  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return null
  }
  try {
    const applicationId = (db.prepare('PRAGMA application_id').get() as { application_id: number })
      .application_id
    const version = (db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version
    if (applicationId !== EXPECTED_APPLICATION_ID || version !== 3) return null
    const rows = db
      .prepare(
        `SELECT id, provider, model, period_utc, reserved_micros, state
         FROM reservations WHERE state IN ('pending', 'uncertain')
         ORDER BY created_at_ms, id`,
      )
      .all() as Array<{
      id: string
      provider: string
      model: string
      period_utc: string
      reserved_micros: number | bigint
      state: 'pending' | 'uncertain'
    }>
    return rows.map((row) => ({
      reservationId: row.id,
      provider: row.provider,
      model: row.model,
      period: row.period_utc,
      reservedMicros: Number(row.reserved_micros),
      state: row.state,
    }))
  } catch {
    return null
  } finally {
    db.close()
  }
}
