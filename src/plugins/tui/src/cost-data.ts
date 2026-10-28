/**
 * Read-only cost and usage data shared by the CLI and the TUI package.
 *
 * This module lives inside the TUI package so its worker and bundled server do
 * not import source files outside the package boundary. The CLI imports these
 * same helpers, preserving a single implementation.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  computeModelCost,
  loadPricing,
  lookupModelPrice,
  type PricingOptions,
  type PricingSnapshot,
  type UnpricedReason,
} from './model-pricing.ts'

export interface SqliteDatabase {
  prepare(sql: string): {
    get(...args: unknown[]): unknown
    all(...args: unknown[]): unknown[]
  }
  close(): void
}

export interface SqliteModule {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => SqliteDatabase
}

export type OpenCodeVersion = 'v1' | 'v2'

/**
 * Host table families that can carry a token ledger. A migrated database
 * carries both at once.
 */
export type CostSource = 'message' | 'session_message'

const COST_SOURCES: readonly CostSource[] = ['message', 'session_message']

/**
 * Which table family each host generation stores its ledger in.
 *
 * Spelled out rather than comparing the literals: `'message' === 'v1'` is
 * false, so a filter written as `source === requested` narrows to nothing and
 * every version-pinned read fails.
 */
const VERSION_SOURCES: Record<OpenCodeVersion, CostSource> = {
  v1: 'message',
  v2: 'session_message',
}

/** The XDG state directory every real host installation writes its ledger to. */
function defaultDbPath(): string {
  const xdg = process.env.XDG_DATA_HOME
  const dataHome = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.local', 'share')
  return join(dataHome, 'opencode', 'opencode.db')
}

/** Read and validate the optional host-generation selector. */
export function requestedVersion(): OpenCodeVersion | undefined {
  const configured = process.env.PANTHEON_OPENCODE_VERSION
  if (configured === undefined) return undefined
  if (configured !== 'v1' && configured !== 'v2') {
    throw new Error(`invalid PANTHEON_OPENCODE_VERSION "${configured}"; expected "v1" or "v2"`)
  }
  return configured
}

/**
 * Resolve the database.
 *
 * Precedence: explicit option → PANTHEON_COST_DB → OPENCODE_DB → the XDG
 * default `opencode.db`. An invalid PANTHEON_OPENCODE_VERSION fails fast rather
 * than being silently ignored.
 *
 * There is deliberately NO per-version filename. Deriving one from the host
 * generation pointed the V2 report at `opencode-v2.db`, which exists only
 * because a sandbox sets OPENCODE_DB — hence OPENCODE_DB's place in this chain.
 */
export function resolveCostDbPath(options?: { dbPath?: string }): string {
  const explicit = options?.dbPath || process.env.PANTHEON_COST_DB || process.env.OPENCODE_DB
  if (explicit) return explicit
  requestedVersion()
  return defaultDbPath()
}

/**
 * Detect the ledger families by TABLE PRESENCE.
 *
 * Presence is the only reliable discriminator: a migrated database carries both
 * families, so pinning a schema-version constant would break whichever
 * population it excluded, and no manifest declares a supported host range.
 * PANTHEON_OPENCODE_VERSION only NARROWS an already-detected set — it never
 * chooses a file and never invents a family that is not there.
 */
export function resolveSources(
  db: SqliteDatabase,
  requested: OpenCodeVersion | undefined,
): CostSource[] {
  const present = new Set(
    (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'session_message')",
        )
        .all() as Array<{ name?: unknown }>
    ).map((row) => String(row.name)),
  )
  const detected = COST_SOURCES.filter((source) => present.has(source))
  if (detected.length === 0) {
    throw new Error(
      'incompatible opencode.db schema: neither the "message" nor the "session_message" table exists, so there is no token ledger to read',
    )
  }
  if (requested === undefined) return detected
  const wanted = VERSION_SOURCES[requested]
  const narrowed = detected.filter((source) => source === wanted)
  if (narrowed.length === 0) {
    throw new Error(
      `incompatible opencode.db schema: PANTHEON_OPENCODE_VERSION=${requested} selected no table family, but this database contains ${detected.join(' and ')}`,
    )
  }
  return narrowed
}

/**
 * UTC day + provider/model aggregation used by the TUI charts.
 *
 * The only interpolated fragments are fixed module constants (family table,
 * discriminator, and time predicates). JSON is validated in the CTE before
 * extraction, and all time bounds remain bound SQL parameters.
 */
function assistantLedgerPredicate(source: CostSource): string {
  return source === 'message'
    ? "CASE WHEN json_valid(data) THEN json_extract(data, '$.role') = 'assistant' ELSE 0 END"
    : "type = 'assistant'"
}

function usageHistorySql(source: CostSource, rolling: boolean): string {
  const table = source
  const assistantPredicate = assistantLedgerPredicate(source)
  const timeRange = rolling
    ? 'AND time_created >= ? AND time_created <= ?'
    : 'AND time_created <= ?'
  return `
    WITH valid AS (
      SELECT strftime('%Y-%m-%d', time_created / 1000, 'unixepoch') AS day,
             COALESCE(NULLIF(TRIM(json_extract(data, '$.model.providerID')), ''),
                      NULLIF(TRIM(json_extract(data, '$.providerID')), '')) AS provider,
             COALESCE(NULLIF(TRIM(json_extract(data, '$.model.id')), ''),
                      NULLIF(TRIM(json_extract(data, '$.modelID')), '')) AS model,
             CASE WHEN json_type(data, '$.agent') IS NULL
                        OR json_extract(data, '$.agent') IS NULL
                        OR TRIM(json_extract(data, '$.agent')) = ''
                  THEN 1 ELSE 0 END AS agentless,
             CASE WHEN json_type(data, '$.tokens.input') IN ('integer', 'real')
                        AND json_extract(data, '$.tokens.input') >= 0
                  THEN CAST(json_extract(data, '$.tokens.input') AS INTEGER) ELSE 0 END AS inTok,
             CASE WHEN json_type(data, '$.tokens.output') IN ('integer', 'real')
                        AND json_extract(data, '$.tokens.output') >= 0
                  THEN CAST(json_extract(data, '$.tokens.output') AS INTEGER) ELSE 0 END AS outTok,
             CASE WHEN json_type(data, '$.tokens.cache.read') IN ('integer', 'real')
                        AND json_extract(data, '$.tokens.cache.read') >= 0
                  THEN CAST(json_extract(data, '$.tokens.cache.read') AS INTEGER) ELSE 0 END AS cacheReadTok,
             CASE WHEN json_type(data, '$.tokens.cache.write') IN ('integer', 'real')
                        AND json_extract(data, '$.tokens.cache.write') >= 0
                  THEN CAST(json_extract(data, '$.tokens.cache.write') AS INTEGER) ELSE 0 END AS cacheWriteTok
      FROM ${table}
      WHERE json_valid(data) AND ${assistantPredicate} ${timeRange}
    )
    SELECT day,
           provider,
           model,
           COUNT(*) AS rows,
           SUM(agentless) AS agentlessRows,
           COALESCE(SUM(inTok), 0) AS tokensInput,
           COALESCE(SUM(outTok), 0) AS tokensOutput,
           COALESCE(SUM(cacheReadTok), 0) AS tokensCacheRead,
           COALESCE(SUM(cacheWriteTok), 0) AS tokensCacheWrite
    FROM valid
    GROUP BY day, provider, model
    ORDER BY day, provider, model`
}

function usageCoverageSql(source: CostSource): string {
  const table = source
  const assistantPredicate = assistantLedgerPredicate(source)
  return `SELECT MIN(time_created) AS coverageStartAt
          FROM ${table}
          WHERE json_valid(data) AND ${assistantPredicate} AND time_created <= ?`
}

export function numberOf(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** A ledger label the catalog cannot know; never an empty string. */
export function ledgerLabel(value: unknown): string {
  if (value === undefined || value === null) return 'unknown'
  const text = String(value).trim()
  return text === '' ? 'unknown' : text
}

/** Price one group, or explain why it cannot be priced. */
export function priceTokens(
  pricing: PricingSnapshot | undefined,
  provider: string,
  model: string,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
): { usd: number } | { reason: UnpricedReason } {
  if (pricing === undefined) return { reason: 'no-pricing' }
  const lookup = lookupModelPrice(pricing, provider, model)
  if (!lookup.ok) return { reason: lookup.reason }
  const cost = computeModelCost(lookup.price, tokens)
  if (!cost.ok) return { reason: cost.reason }
  return { usd: cost.usd }
}

/** Available chart windows. Rolling windows are exact 24-hour ranges ending now. */
export type UsageHistoryPeriod = '7d' | '15d' | '30d' | 'total'

/** Token quantities; `total` follows the cost report convention: input + output. */
export interface UsageTokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
}

/** One UTC calendar-day bucket, with catalog estimate omitted when unpriceable. */
export interface UsageHistoryBucket extends UsageTokenTotals {
  date: string
  estimatedUsd?: number
  pricingComplete: boolean
}

/** One provider/model's date series and totals. */
export interface UsageHistoryModel {
  providerID: string
  modelID: string
  rows: number
  agentlessRows: number
  buckets: UsageHistoryBucket[]
  totals: UsageTokenTotals
  estimatedUsd?: number
  pricingComplete: boolean
  unpricedReason?: UnpricedReason
}

export type UsagePricingStatus = 'empty' | 'unavailable' | 'partial' | 'complete'

/** Catalog-derived USD is an estimate, not a provider invoice. */
export interface UsageHistoryPricing {
  status: UsagePricingStatus
  complete: boolean
  estimatedUsd?: number
  unpricedModels: number
}

/** Read-only chart data for the rows present in the current opencode.db. */
export interface UsageHistoryResult {
  period: UsageHistoryPeriod
  /** Earliest ledger record actually present in the database, as UTC date. */
  coverageStart: string | null
  /** Exact epoch-ms start of the earliest ledger record. */
  coverageStartAt: number | null
  /** True only when a rolling window begins before this database's earliest ledger record. */
  partial: boolean
  rows: number
  buckets: UsageHistoryBucket[]
  totals: UsageTokenTotals
  models: UsageHistoryModel[]
  pricing: UsageHistoryPricing
}

export interface UsageHistoryOptions {
  /** Injectable clock for deterministic rolling-window boundaries. */
  now?: number
  /** Explicit price snapshot; otherwise only the on-disk cache is read. */
  pricing?: PricingSnapshot
  /** Cache path/environment injection; all network refreshes are disabled. */
  pricingOptions?: PricingOptions
}

/** Current context estimate input; cache metrics are intentionally not accepted. */
export interface ActiveContextCostInput {
  providerID: string | null
  modelID: string | null
  contextTokens: number | null
}

export interface ActiveContextCostEstimate {
  status: 'estimated' | 'unavailable'
  /** Catalog estimate from context tokens × input price; never a billed amount. */
  estimatedUsd?: number
  billed: false
  basis: 'pre-cache-context-tokens-times-input-price'
  cacheDiscountApplied: false
  reason?: 'invalid-context-token-count' | 'missing-model-identity' | UnpricedReason
}

interface UsageHistoryLedgerGroup {
  day?: unknown
  provider?: unknown
  model?: unknown
  rows?: unknown
  agentlessRows?: unknown
  tokensInput?: unknown
  tokensOutput?: unknown
  tokensCacheRead?: unknown
  tokensCacheWrite?: unknown
}

interface MutableUsageTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface MutableUsageDay {
  tokens: MutableUsageTokens
  rows: number
  agentlessRows: number
}

interface MutableUsageModel {
  providerID: string
  modelID: string
  tokens: MutableUsageTokens
  rows: number
  agentlessRows: number
  days: Map<string, MutableUsageDay>
}

function emptyUsageTokens(): MutableUsageTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

function addUsageTokens(target: MutableUsageTokens, source: MutableUsageTokens): void {
  target.input += source.input
  target.output += source.output
  target.cacheRead += source.cacheRead
  target.cacheWrite += source.cacheWrite
}

function toUsageTokenTotals(tokens: MutableUsageTokens): UsageTokenTotals {
  return {
    input: tokens.input,
    output: tokens.output,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    // Cache channels are shown independently and are not folded into total.
    total: tokens.input + tokens.output,
  }
}

function offlinePricing(options?: UsageHistoryOptions): PricingSnapshot {
  return options?.pricing ?? loadPricing({ ...options?.pricingOptions, offline: true }).snapshot
}

/**
 * Read daily token history for the Usage charts.
 *
 * Rolling periods are exact N×24-hour windows ending at `now`; daily buckets
 * are UTC dates. Future-dated rows are excluded from every period, including
 * `total`, while `total` has no lower age cap. Both V1 and V2 tables are read
 * when a migrated database contains both. The database is opened read-only and
 * model pricing comes only from a cached snapshot: this path never fetches pricing.
 */
export async function queryUsageHistory(
  dbPath: string,
  period: UsageHistoryPeriod,
  options?: UsageHistoryOptions,
): Promise<UsageHistoryResult> {
  const dayCounts: Record<Exclude<UsageHistoryPeriod, 'total'>, number> = {
    '7d': 7,
    '15d': 15,
    '30d': 30,
  }
  if (period !== 'total' && !Object.hasOwn(dayCounts, period)) {
    throw new Error(`unsupported usage history period: ${String(period)}`)
  }
  const now = options?.now ?? Date.now()
  if (!Number.isFinite(now)) throw new Error('usage history clock must be finite')
  const rolling = period !== 'total'
  const since = rolling ? now - dayCounts[period] * 86_400_000 : undefined
  const sqlite = (await import('node:sqlite')) as SqliteModule
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  try {
    // Historical charts always mean all known ledger families in this file.
    // The host-version override is a diagnostic narrowing for pantheon_cost,
    // not a reason to hide rows from a database-wide history view.
    const sources = resolveSources(db, undefined)
    const models = new Map<string, MutableUsageModel>()
    let rows = 0
    let coverageStartAt: number | null = null

    for (const source of sources) {
      const coverage = db.prepare(usageCoverageSql(source)).get(now) as {
        coverageStartAt?: unknown
      }
      const sourceStart = numberOf(coverage?.coverageStartAt)
      if (sourceStart !== undefined) {
        coverageStartAt =
          coverageStartAt === null ? sourceStart : Math.min(coverageStartAt, sourceStart)
      }

      const groups = db
        .prepare(usageHistorySql(source, rolling))
        .all(...(since === undefined ? [now] : [since, now])) as UsageHistoryLedgerGroup[]
      for (const group of groups) {
        if (typeof group.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(group.day)) continue
        const providerID = ledgerLabel(group.provider)
        const modelID = ledgerLabel(group.model)
        const key = `${providerID}\u0000${modelID}`
        const model = models.get(key) ?? {
          providerID,
          modelID,
          tokens: emptyUsageTokens(),
          rows: 0,
          agentlessRows: 0,
          days: new Map<string, MutableUsageDay>(),
        }
        const tokens: MutableUsageTokens = {
          input: numberOf(group.tokensInput) ?? 0,
          output: numberOf(group.tokensOutput) ?? 0,
          cacheRead: numberOf(group.tokensCacheRead) ?? 0,
          cacheWrite: numberOf(group.tokensCacheWrite) ?? 0,
        }
        const groupRows = numberOf(group.rows) ?? 0
        const agentlessRows = numberOf(group.agentlessRows) ?? 0
        rows += groupRows
        addUsageTokens(model.tokens, tokens)
        model.rows += groupRows
        model.agentlessRows += agentlessRows
        const day = model.days.get(group.day) ?? {
          tokens: emptyUsageTokens(),
          rows: 0,
          agentlessRows: 0,
        }
        addUsageTokens(day.tokens, tokens)
        day.rows += groupRows
        day.agentlessRows += agentlessRows
        model.days.set(group.day, day)
        models.set(key, model)
      }
    }

    const priceSnapshot = offlinePricing(options)
    const daily = new Map<
      string,
      { tokens: MutableUsageTokens; usd: number; pricedModels: number; unpricedModels: number }
    >()
    let pricedModels = 0
    let unpricedModels = 0
    let estimatedUsd = 0
    const modelRows: UsageHistoryModel[] = []

    for (const model of models.values()) {
      const totalsPrice = priceTokens(priceSnapshot, model.providerID, model.modelID, {
        input: model.tokens.input,
        output: model.tokens.output,
        cacheRead: model.tokens.cacheRead,
        cacheWrite: model.tokens.cacheWrite,
      })
      const modelPriced = 'usd' in totalsPrice
      if ('usd' in totalsPrice) {
        pricedModels += 1
        estimatedUsd += totalsPrice.usd
      } else {
        unpricedModels += 1
      }

      const buckets: UsageHistoryBucket[] = [...model.days.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, value]) => {
          const bucketPrice = priceTokens(priceSnapshot, model.providerID, model.modelID, {
            input: value.tokens.input,
            output: value.tokens.output,
            cacheRead: value.tokens.cacheRead,
            cacheWrite: value.tokens.cacheWrite,
          })
          const dailyTotal = daily.get(date) ?? {
            tokens: emptyUsageTokens(),
            usd: 0,
            pricedModels: 0,
            unpricedModels: 0,
          }
          addUsageTokens(dailyTotal.tokens, value.tokens)
          if ('usd' in bucketPrice) {
            dailyTotal.usd += bucketPrice.usd
            dailyTotal.pricedModels += 1
          } else {
            dailyTotal.unpricedModels += 1
          }
          daily.set(date, dailyTotal)
          return {
            date,
            ...toUsageTokenTotals(value.tokens),
            ...('usd' in bucketPrice ? { estimatedUsd: bucketPrice.usd } : {}),
            pricingComplete: 'usd' in bucketPrice,
          }
        })

      modelRows.push({
        providerID: model.providerID,
        modelID: model.modelID,
        rows: model.rows,
        agentlessRows: model.agentlessRows,
        buckets,
        totals: toUsageTokenTotals(model.tokens),
        ...('usd' in totalsPrice ? { estimatedUsd: totalsPrice.usd } : {}),
        pricingComplete: modelPriced,
        ...(!modelPriced && 'reason' in totalsPrice ? { unpricedReason: totalsPrice.reason } : {}),
      })
    }

    modelRows.sort(
      (left, right) =>
        left.providerID.localeCompare(right.providerID) ||
        left.modelID.localeCompare(right.modelID),
    )
    const buckets: UsageHistoryBucket[] = [...daily.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([date, value]) => ({
        date,
        ...toUsageTokenTotals(value.tokens),
        ...(value.pricedModels > 0 ? { estimatedUsd: value.usd } : {}),
        pricingComplete: value.unpricedModels === 0,
      }))

    const empty = rows === 0
    const pricingStatus: UsagePricingStatus = empty
      ? 'empty'
      : pricedModels === 0
        ? 'unavailable'
        : unpricedModels > 0
          ? 'partial'
          : 'complete'
    const totals = emptyUsageTokens()
    for (const model of models.values()) addUsageTokens(totals, model.tokens)
    const requestedStart = since
    return {
      period,
      coverageStart:
        coverageStartAt === null ? null : new Date(coverageStartAt).toISOString().slice(0, 10),
      coverageStartAt,
      partial:
        requestedStart !== undefined &&
        coverageStartAt !== null &&
        coverageStartAt > requestedStart,
      rows,
      buckets,
      totals: toUsageTokenTotals(totals),
      models: modelRows,
      pricing: {
        status: pricingStatus,
        complete: pricingStatus === 'complete',
        ...(pricedModels > 0 ? { estimatedUsd } : {}),
        unpricedModels,
      },
    }
  } finally {
    db.close()
  }
}

/**
 * Estimate current context cost using only its token count and cached input rate.
 * This is a pre-cache estimate, applies no cache discount, and is not billed or
 * used to alter host-reported session spend.
 */
export function estimateActiveContextCost(
  input: ActiveContextCostInput,
  options?: UsageHistoryOptions,
): ActiveContextCostEstimate {
  const metadata = {
    billed: false as const,
    basis: 'pre-cache-context-tokens-times-input-price' as const,
    cacheDiscountApplied: false as const,
  }
  if (
    typeof input.contextTokens !== 'number' ||
    !Number.isSafeInteger(input.contextTokens) ||
    input.contextTokens < 0
  ) {
    return { status: 'unavailable', ...metadata, reason: 'invalid-context-token-count' }
  }
  if (!input.providerID?.trim() || !input.modelID?.trim()) {
    return { status: 'unavailable', ...metadata, reason: 'missing-model-identity' }
  }
  const pricing = offlinePricing(options)
  const lookup = lookupModelPrice(pricing, input.providerID, input.modelID)
  if (!lookup.ok) {
    return { status: 'unavailable', ...metadata, reason: lookup.reason }
  }
  return {
    status: 'estimated',
    ...metadata,
    estimatedUsd: (input.contextTokens / 1_000_000) * lookup.price.inputPerMTok,
  }
}
