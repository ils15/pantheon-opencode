/**
 * Cost Command — `pantheon_cost` structural tool: token AND money visibility
 * for delegation traffic, straight from opencode.db.
 *
 * Reads the opencode session database READ-ONLY (sum tokens by agent and
 * phase over the last N days → markdown table) and prices those tokens with
 * the models.dev catalog (see {@link module:model-pricing}), which is cached on
 * disk and never awaited by a tool call unless `refreshPricing` asks for it. A
 * session view attributes spend to a root session plus its descendant sessions
 * using the parent ids already in the database. Zero new dependencies:
 *   - only path: node:sqlite (DatabaseSync, readOnly) — node ≥ 22.5;
 *   - missing/unreadable db → a diagnostic contract status as TEXT.
 *
 * ## Host generations
 *
 * The V1/V2 distinction is the SCHEMA of opencode.db, never its filename: every
 * real installation writes `opencode.db`, and a migrated database carries BOTH
 * `message` (V1) and `session_message` (V2) tables at once. The two families are
 * detected by table presence and their `id` spaces are disjoint, so both are
 * read and merged rather than one being guessed at.
 *
 * The two discriminators are NOT interchangeable. V1 marks assistant turns with
 * `data.role = 'assistant'`; V2 has no `role` key at all (measured: absent from
 * 40052 of 40052 rows on the host 2.0.22 database) and marks them with the
 * `type = 'assistant'` COLUMN. Reusing the V1 predicate against V2 discards
 * every row, which is why an unreadable ledger is reported as UNSUPPORTED
 * instead of as a successful, empty report.
 *
 * dbPath resolution: explicit option > PANTHEON_COST_DB > OPENCODE_DB > the XDG
 * default `opencode.db`. OPENCODE_DB is what a SANDBOX uses to name its state
 * database `opencode-v2.db`, so it — not the host generation — is what selects
 * a non-default file. The tool is wired in plugin.ts alongside the delegation
 * toolset (usable by zeus and any agent with tool access — no routing change
 * needed).
 *
 * @module cost-command
 */
import { execFile } from 'node:child_process'
import { accessSync, constants, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import {
  computeModelCost,
  forceRefreshPricing,
  loadPricing,
  lookupModelPrice,
  type PricingOptions,
  type PricingSnapshot,
  type UnpricedReason,
} from './model-pricing.ts'
import type { NativeTaskStatus } from './native-task-status.ts'
import type { ToolContextLike } from './tool-context.ts'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** One aggregated token row (per agent and phase). */
export interface CostRow {
  agent: string
  phase: string
  tokensInput: number
  tokensOutput: number
  tokensTotal: number
  /** USD for this row; absent when any contributing model is unpriced. */
  costUsd?: number
}

/** One aggregated row per (agent, phase, provider, model). */
export interface CostModelRow {
  agent: string
  phase: string
  provider: string
  model: string
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  tokensCacheWrite: number
  tokensTotal: number
  costUsd?: number
  unpricedReason?: UnpricedReason
}

/** One aggregated row per session (a node of the session tree). */
export interface CostSessionRow {
  sessionId: string
  title?: string
  agents: string[]
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  tokensCacheWrite: number
  tokensTotal: number
  costUsd?: number
  unpricedReason?: UnpricedReason
}

/** The session subtree a report was scoped to, when `session` was requested. */
export interface CostSessionScope {
  rootId: string
  /** Root plus every descendant found in the session tables. */
  ids: string[]
  /** False when the root id has no row in the session tables. */
  rootKnown: boolean
  /** False when the database carries no session metadata table at all. */
  hierarchy: boolean
}

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

/** What the query actually found, so the report can describe its own coverage. */
export interface CostCoverage {
  /** Table families that contributed rows. */
  sources: CostSource[]
  /** Rows of ANY type inside the window. */
  scanned: number
  /** Rows that passed the schema-appropriate assistant discriminator. */
  assistantRows: number
  /** Earliest row in the WHOLE database (epoch ms) — the history the file holds. */
  databaseStart?: number
  /** Earliest row inside the requested window (epoch ms). */
  windowStart?: number
}

export interface CostQuery {
  rows: CostRow[]
  coverage: CostCoverage
  /** Per-model breakdown. Absent on the CLI-fallback path, which reports tokens only. */
  byModel?: CostModelRow[]
  /** Per-session breakdown. Absent on the CLI-fallback path. */
  bySession?: CostSessionRow[]
  /** Set when the report was scoped to one session tree. */
  sessionScope?: CostSessionScope
}

export interface CostCommandOptions {
  /** Explicit db path (testability / unusual installs). Default: resolved candidates. */
  dbPath?: string
  /** Injectable loader for tests; production always loads node:sqlite. */
  sqliteLoader?: () => Promise<SqliteModule>
  /** Injectable CLI-fallback process boundary (tests / unusual runtimes). */
  cliFallback?: CliFallbackDeps
  /** Pricing cache / fetch boundary (tests, air-gapped hosts). */
  pricing?: PricingOptions
}

export type OpenCodeVersion = 'v1' | 'v2'

interface SqliteDatabase {
  prepare(sql: string): { get(): unknown; all(...args: unknown[]): unknown[] }
  close(): void
}

export interface SqliteModule {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => SqliteDatabase
}

/** One cost tool: description + zod args shape + execute (delegation.ts shape). */
export interface CostTool<Args extends z.ZodRawShape = typeof costArgs> {
  description: string
  args: Args
  execute(args: z.infer<z.ZodObject<Args>>, ctx: ToolContextLike): Promise<string>
}

export interface CostCommand {
  pantheon_cost: CostTool
}

const costArgs = {
  days: z
    .number()
    .int()
    .min(1)
    .max(365)
    .optional()
    .describe('Number of rolling 24-hour days of history to include (default 7).'),
  session: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Session id to scope the report to: the root session plus every descendant session in its subtree.',
    ),
  refreshPricing: z
    .boolean()
    .optional()
    .describe(
      'Await a models.dev price refresh (bounded by a short timeout) instead of using the cached catalog. This is the only path that waits on the network.',
    ),
} satisfies z.ZodRawShape

/** Parsed arguments of the cost tool. */
type CostArgs = z.infer<z.ZodObject<typeof costArgs>>

/** The XDG state directory every real host installation writes its ledger to. */
function defaultDbPath(): string {
  const xdg = process.env.XDG_DATA_HOME
  const dataHome = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.local', 'share')
  return join(dataHome, 'opencode', 'opencode.db')
}

/** Read and validate the optional host-generation selector. */
function requestedVersion(): OpenCodeVersion | undefined {
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
export function resolveCostDbPath(options?: CostCommandOptions): string {
  const explicit = options?.dbPath || process.env.PANTHEON_COST_DB || process.env.OPENCODE_DB
  if (explicit) return explicit
  requestedVersion()
  return defaultDbPath()
}

/**
 * First existing db path, or undefined. An EXPLICIT override shadows the
 * candidate list entirely (testability: a fake path must not fall through
 * to the real opencode.db).
 */
function findExistingDb(override?: string): string | undefined {
  const candidate =
    override === undefined ? resolveCostDbPath() : resolveCostDbPath({ dbPath: override })
  return existsSync(candidate) ? candidate : undefined
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
function resolveSources(db: SqliteDatabase, requested: OpenCodeVersion | undefined): CostSource[] {
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
 * Per-family aggregation, grouped finely enough to price and to attribute.
 *
 * Aggregating in SQL instead of pulling `data` blobs into JS is not a
 * micro-optimisation: the host's own 7-day window is 271 MB across 26410
 * assistant rows, and the equivalent SQL finishes in 0.9 s over the
 * time_created index.
 *
 * The grouping key is (agent, phase, provider, model, session): the first two
 * keep the historical by-agent table, the middle two are what a price can be
 * looked up for, and the last one is what a spend attribution needs. Cost is
 * computed in JS from these groups, so there is exactly ONE set of token sums
 * behind every table in the report.
 *
 * Three correctness details are load-bearing:
 *   - `json_valid(data)` gates every extraction, because `json_extract` and
 *     `->>` both RAISE on malformed JSON in node:sqlite's bundled SQLite. The
 *     inner CTE applies it before extracting anything, so the outer query can
 *     never see an unparseable payload whatever order SQLite evaluates terms in.
 *   - `COALESCE(SUM(...), 0)` — a group whose tokens are all NULL sums to NULL,
 *     and adding NULL into an accumulator would print NaN into the report.
 *   - `session_id` is read only when the LEDGER table carries it. A real V1 and
 *     V2 table both do, but a partial database (or a hand-built fixture) may
 *     not, and selecting a missing column would fail the whole report instead
 *     of dropping the session view.
 *
 * V1 marks assistant turns with `data.role`; V2 marks them with the `type`
 * COLUMN. V2 carries no `role` key, so the V1 predicate would match nothing.
 */
const COST_AGGREGATE_SQL: Record<CostSource, (sessionId: boolean) => string> = {
  message: (sessionId) => `
    WITH valid AS (
      SELECT json_extract(data, '$.role') AS role,
             json_extract(data, '$.agent') AS agent,
             COALESCE(NULLIF(json_extract(data, '$.phase'), ''),
                      NULLIF(json_extract(data, '$.metadata.phase'), ''),
                      'unknown') AS phase,
             COALESCE(json_extract(data, '$.model.providerID'),
                      json_extract(data, '$.providerID')) AS provider,
             COALESCE(json_extract(data, '$.model.id'),
                      json_extract(data, '$.modelID')) AS model,
             ${sessionId ? 'session_id' : 'NULL'} AS sessionId,
             CAST(json_extract(data, '$.tokens.input') AS INTEGER) AS inTok,
             CAST(json_extract(data, '$.tokens.output') AS INTEGER) AS outTok,
             CAST(json_extract(data, '$.tokens.cache.read') AS INTEGER) AS cacheReadTok,
             CAST(json_extract(data, '$.tokens.cache.write') AS INTEGER) AS cacheWriteTok
      FROM message
      WHERE time_created >= ? AND json_valid(data)
    )
    SELECT agent AS agent,
           phase AS phase,
           provider AS provider,
           model AS model,
           sessionId AS sessionId,
           COALESCE(SUM(inTok), 0) AS tokensInput,
           COALESCE(SUM(outTok), 0) AS tokensOutput,
           COALESCE(SUM(cacheReadTok), 0) AS tokensCacheRead,
           COALESCE(SUM(cacheWriteTok), 0) AS tokensCacheWrite
    FROM valid
    WHERE role = 'assistant'
    GROUP BY agent, phase, provider, model, sessionId
    HAVING agent IS NOT NULL AND agent != ''`,
  session_message: (sessionId) => `
    WITH valid AS (
      SELECT json_extract(data, '$.agent') AS agent,
             'unknown' AS phase,
             COALESCE(json_extract(data, '$.model.providerID'),
                      json_extract(data, '$.providerID')) AS provider,
             COALESCE(json_extract(data, '$.model.id'),
                      json_extract(data, '$.modelID')) AS model,
             ${sessionId ? 'session_id' : 'NULL'} AS sessionId,
             CAST(json_extract(data, '$.tokens.input') AS INTEGER) AS inTok,
             CAST(json_extract(data, '$.tokens.output') AS INTEGER) AS outTok,
             CAST(json_extract(data, '$.tokens.cache.read') AS INTEGER) AS cacheReadTok,
             CAST(json_extract(data, '$.tokens.cache.write') AS INTEGER) AS cacheWriteTok
      FROM session_message
      WHERE time_created >= ? AND type = 'assistant' AND json_valid(data)
    )
    SELECT agent AS agent,
           phase AS phase,
           provider AS provider,
           model AS model,
           sessionId AS sessionId,
           COALESCE(SUM(inTok), 0) AS tokensInput,
           COALESCE(SUM(outTok), 0) AS tokensOutput,
           COALESCE(SUM(cacheReadTok), 0) AS tokensCacheRead,
           COALESCE(SUM(cacheWriteTok), 0) AS tokensCacheWrite
    FROM valid
    GROUP BY agent, phase, provider, model, sessionId
    HAVING agent IS NOT NULL AND agent != ''`,
}

/** One row of the aggregated ledger query. */
interface LedgerGroup {
  agent?: unknown
  phase?: unknown
  provider?: unknown
  model?: unknown
  sessionId?: unknown
  tokensInput?: unknown
  tokensOutput?: unknown
  tokensCacheRead?: unknown
  tokensCacheWrite?: unknown
}

/** One session row from the metadata tables. */
interface CostSessionInfo {
  id: string
  parentId?: string
  title?: string
}

/** Session metadata of the whole database, plus the parent→children index. */
interface CostSessionIndex {
  nodes: Map<string, CostSessionInfo>
  children: Map<string, string[]>
  /** Metadata tables that were read. */
  tables: string[]
}

/** Table families that carry session ids and parent ids. */
const SESSION_TABLES: readonly string[] = ['session_v2', 'session']

/** Column names of one table; empty when the table does not exist. */
function tableColumns(db: SqliteDatabase, table: string): Set<string> {
  // Interpolated names come from the module's own constant list, never from a
  // caller or a payload, so no value can reach this string.
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>
    return new Set(rows.map((row) => String(row.name)))
  } catch {
    return new Set()
  }
}

/**
 * Read session metadata: ids, parent ids and titles.
 *
 * A migrated database carries BOTH families, and their id spaces are disjoint,
 * so both are read and merged. Fields a family does not have are simply absent
 * rather than fabricated.
 */
function readSessionIndex(db: SqliteDatabase): CostSessionIndex {
  const nodes = new Map<string, CostSessionInfo>()
  const children = new Map<string, string[]>()
  const tables: string[] = []
  for (const table of SESSION_TABLES) {
    const columns = tableColumns(db, table)
    if (columns.size === 0 || !columns.has('id')) continue
    tables.push(table)
    const parent = columns.has('parent_id') ? 'parent_id' : 'NULL'
    const title = columns.has('title') ? 'title' : 'NULL'
    const rows = db
      .prepare(`SELECT id, ${parent} AS parentId, ${title} AS title FROM ${table}`)
      .all() as Array<{
      id?: unknown
      parentId?: unknown
      title?: unknown
    }>
    for (const row of rows) {
      const id = String(row.id ?? '')
      if (id === '') continue
      const parentId =
        row.parentId === null || row.parentId === undefined ? undefined : String(row.parentId)
      const title = row.title === null || row.title === undefined ? undefined : String(row.title)
      nodes.set(id, {
        id,
        ...(parentId === undefined ? {} : { parentId }),
        ...(title === undefined ? {} : { title }),
      })
      if (parentId !== undefined) {
        const bucket = children.get(parentId) ?? []
        bucket.push(id)
        children.set(parentId, bucket)
      }
    }
  }
  return { nodes, children, tables }
}

/**
 * Root session plus every descendant, by parent id.
 *
 * A visited set bounds the walk: a database that (through a bug or a manual
 * edit) contains a parent cycle must not hang a tool call.
 */
function resolveSessionTree(
  index: CostSessionIndex,
  rootId: string,
): { ids: string[]; rootKnown: boolean } {
  const ids = new Set<string>([rootId])
  const queue: string[] = [rootId]
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor]
    if (current === undefined) continue
    for (const child of index.children.get(current) ?? []) {
      if (ids.has(child)) continue
      ids.add(child)
      queue.push(child)
    }
  }
  return { ids: [...ids], rootKnown: index.nodes.has(rootId) }
}

/**
 * Window counters — the evidence a diagnosis is built from. A report that
 * scanned rows but matched no assistant row must say so rather than render an
 * empty table under a success status.
 */
const COUNTER_SQL: Record<CostSource, string> = {
  message: `
    SELECT
      (SELECT COUNT(*) FROM message WHERE time_created >= ?) AS scanned,
      (SELECT MIN(time_created) FROM message WHERE time_created >= ?) AS windowStart,
      (SELECT COUNT(*) FROM (
         SELECT json_extract(data, '$.role') AS role
         FROM message WHERE time_created >= ? AND json_valid(data)
       ) WHERE role = 'assistant') AS assistantRows`,
  session_message: `
    SELECT
      (SELECT COUNT(*) FROM session_message WHERE time_created >= ?) AS scanned,
      (SELECT MIN(time_created) FROM session_message WHERE time_created >= ?) AS windowStart,
      (SELECT COUNT(*) FROM session_message WHERE time_created >= ? AND type = 'assistant') AS assistantRows`,
}

const DATABASE_START_SQL: Record<CostSource, string> = {
  message: 'SELECT MIN(time_created) AS databaseStart FROM message',
  session_message: 'SELECT MIN(time_created) AS databaseStart FROM session_message',
}

type Counters = { scanned?: unknown; windowStart?: unknown; assistantRows?: unknown }

function numberOf(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function emptyCoverage(sources: CostSource[]): CostCoverage {
  return { sources, scanned: 0, assistantRows: 0 }
}

/** Options for one ledger read. */
export interface CostQueryOptions {
  /** Prices to apply. Absent ⇒ every cost is reported as unavailable. */
  pricing?: PricingSnapshot
  /** Session id to scope to: the root plus every descendant session. */
  sessionRoot?: string
}

/** One model group while a report is being assembled. */
interface ModelAccumulator {
  agent: string
  phase: string
  provider: string
  model: string
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  tokensCacheWrite: number
  usd: number | undefined
  unpriced: boolean
  reason: UnpricedReason | undefined
}

/** One session group while a report is being assembled. */
interface SessionAccumulator {
  sessionId: string
  agents: Set<string>
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  tokensCacheWrite: number
  usd: number | undefined
  unpriced: boolean
  reason: UnpricedReason | undefined
}

/** A ledger label the catalog cannot know; never an empty string. */
function ledgerLabel(value: unknown): string {
  if (value === undefined || value === null) return 'unknown'
  const text = String(value).trim()
  return text === '' ? 'unknown' : text
}

/** Price one group, or explain why it cannot be priced. */
function priceTokens(
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

/**
 * Read the token ledger of one database, read-only.
 *
 * Exported so the mirrored implementation in scripts/cost.mjs can be held to
 * the same answer in tests. The script cannot import this module: it runs on a
 * plain Node precisely because node:sqlite is missing from the plugin runtime.
 */
export async function queryCostRows(
  dbPath: string,
  days: number,
  options?: CostQueryOptions,
): Promise<CostQuery> {
  const sqlite = (await import('node:sqlite')) as SqliteModule
  return queryWithSqlite(dbPath, days, sqlite, options)
}

/** Shared aggregation path for the in-process reader and queryCostRows. */
function queryWithSqlite(
  dbPath: string,
  days: number,
  sqlite: SqliteModule,
  options?: CostQueryOptions,
): CostQuery {
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  try {
    const sources = resolveSources(db, requestedVersion())
    const since = Date.now() - days * 86_400_000
    const coverage = emptyCoverage([])
    const models = new Map<string, ModelAccumulator>()
    const sessions = new Map<string, SessionAccumulator>()

    const note = (key: 'windowStart' | 'databaseStart', value: number | undefined): void => {
      if (value === undefined) return
      const current = coverage[key]
      coverage[key] = current === undefined ? value : Math.min(current, value)
    }

    // Session metadata is read once: the tree is needed both to scope a report
    // and to label the rows of the session view.
    const sessionIndex = readSessionIndex(db)
    const sessionRoot = options?.sessionRoot
    let sessionScope: CostSessionScope | undefined
    let scopedIds: Set<string> | undefined
    if (sessionRoot !== undefined) {
      const tree = resolveSessionTree(sessionIndex, sessionRoot)
      scopedIds = new Set(tree.ids)
      sessionScope = {
        rootId: sessionRoot,
        ids: tree.ids,
        rootKnown: tree.rootKnown,
        hierarchy: sessionIndex.tables.length > 0,
      }
    }

    for (const source of sources) {
      const countersRow = (
        db.prepare(COUNTER_SQL[source]).all(since, since, since) as Array<Counters>
      )[0]
      coverage.sources.push(source)
      coverage.scanned += numberOf(countersRow?.scanned) ?? 0
      coverage.assistantRows += numberOf(countersRow?.assistantRows) ?? 0
      note('windowStart', numberOf(countersRow?.windowStart))
      note(
        'databaseStart',
        numberOf(
          (db.prepare(DATABASE_START_SQL[source]).get() as { databaseStart?: unknown })
            ?.databaseStart,
        ),
      )

      const hasSessionColumn = tableColumns(db, source).has('session_id')
      const groups = db
        .prepare(COST_AGGREGATE_SQL[source](hasSessionColumn))
        .all(since) as Array<LedgerGroup>

      for (const group of groups) {
        const agent = String(group.agent ?? '')
        if (agent === '') continue
        const phase = ledgerLabel(group.phase)
        const provider = ledgerLabel(group.provider)
        const model = ledgerLabel(group.model)
        const sessionId =
          group.sessionId === undefined || group.sessionId === null
            ? undefined
            : String(group.sessionId)
        // A scoped report keeps only rows inside the requested subtree. A row
        // with no session id cannot be proven to belong to it, so it is out.
        if (scopedIds !== undefined && (sessionId === undefined || !scopedIds.has(sessionId))) {
          continue
        }
        const tokens = {
          input: numberOf(group.tokensInput) ?? 0,
          output: numberOf(group.tokensOutput) ?? 0,
          cacheRead: numberOf(group.tokensCacheRead) ?? 0,
          cacheWrite: numberOf(group.tokensCacheWrite) ?? 0,
        }
        const priced = priceTokens(options?.pricing, provider, model, tokens)

        // Keyed on NUL separators: none of these labels can contain one, so no
        // label ending in another label's text can collide with it.
        const modelKey = `${agent}\u0000${phase}\u0000${provider}\u0000${model}`
        const modelAcc = models.get(modelKey) ?? {
          agent,
          phase,
          provider,
          model,
          tokensInput: 0,
          tokensOutput: 0,
          tokensCacheRead: 0,
          tokensCacheWrite: 0,
          usd: 0,
          unpriced: false,
          reason: undefined,
        }
        modelAcc.tokensInput += tokens.input
        modelAcc.tokensOutput += tokens.output
        modelAcc.tokensCacheRead += tokens.cacheRead
        modelAcc.tokensCacheWrite += tokens.cacheWrite
        if ('usd' in priced && modelAcc.usd !== undefined) {
          modelAcc.usd += priced.usd
        } else {
          modelAcc.unpriced = true
          modelAcc.usd = undefined
          modelAcc.reason = modelAcc.reason ?? ('reason' in priced ? priced.reason : undefined)
        }
        models.set(modelKey, modelAcc)

        if (sessionId === undefined) continue
        const sessionAcc = sessions.get(sessionId) ?? {
          sessionId,
          agents: new Set<string>(),
          tokensInput: 0,
          tokensOutput: 0,
          tokensCacheRead: 0,
          tokensCacheWrite: 0,
          usd: 0,
          unpriced: false,
          reason: undefined,
        }
        sessionAcc.agents.add(agent)
        sessionAcc.tokensInput += tokens.input
        sessionAcc.tokensOutput += tokens.output
        sessionAcc.tokensCacheRead += tokens.cacheRead
        sessionAcc.tokensCacheWrite += tokens.cacheWrite
        if ('usd' in priced && sessionAcc.usd !== undefined) {
          sessionAcc.usd += priced.usd
        } else {
          sessionAcc.unpriced = true
          sessionAcc.usd = undefined
          sessionAcc.reason = sessionAcc.reason ?? ('reason' in priced ? priced.reason : undefined)
        }
        sessions.set(sessionId, sessionAcc)
      }
    }

    // The by-agent table is derived from the model groups, so every table in
    // the report is backed by exactly one set of token sums. `costUsd` is the
    // only added field, and only when every contributing model was priced, so
    // the historical row shape keeps its old keys.
    const byAgentPhase = new Map<
      string,
      { row: CostRow; usd: number | undefined; unpriced: boolean }
    >()
    for (const acc of models.values()) {
      const key = `${acc.agent}\u0000${acc.phase}`
      const entry = byAgentPhase.get(key) ?? {
        row: {
          agent: acc.agent,
          phase: acc.phase,
          tokensInput: 0,
          tokensOutput: 0,
          tokensTotal: 0,
        },
        usd: 0,
        unpriced: false,
      }
      entry.row.tokensInput += acc.tokensInput
      entry.row.tokensOutput += acc.tokensOutput
      entry.row.tokensTotal += acc.tokensInput + acc.tokensOutput
      if (acc.unpriced || entry.usd === undefined) {
        entry.unpriced = true
        entry.usd = undefined
      } else if (acc.usd !== undefined) {
        entry.usd += acc.usd
      }
      byAgentPhase.set(key, entry)
    }

    const rows: CostRow[] = [...byAgentPhase.values()]
      .map((entry) =>
        entry.unpriced || entry.usd === undefined
          ? { ...entry.row }
          : { ...entry.row, costUsd: entry.usd },
      )
      .sort((a, b) => b.tokensTotal - a.tokensTotal)

    const byModel: CostModelRow[] = [...models.values()]
      .map((acc) => ({
        agent: acc.agent,
        phase: acc.phase,
        provider: acc.provider,
        model: acc.model,
        tokensInput: acc.tokensInput,
        tokensOutput: acc.tokensOutput,
        tokensCacheRead: acc.tokensCacheRead,
        tokensCacheWrite: acc.tokensCacheWrite,
        // "Total" means input+output everywhere in the report; cache tokens are
        // reported in their own columns rather than folded into this one, so two
        // tables cannot disagree about what a total counts.
        tokensTotal: acc.tokensInput + acc.tokensOutput,
        ...(acc.usd === undefined ? {} : { costUsd: acc.usd }),
        ...(acc.reason === undefined ? {} : { unpricedReason: acc.reason }),
      }))
      .sort((a, b) => b.tokensTotal - a.tokensTotal)

    const bySession: CostSessionRow[] = [...sessions.values()]
      .map((acc) => {
        const info = sessionIndex.nodes.get(acc.sessionId)
        return {
          sessionId: acc.sessionId,
          ...(info?.title === undefined ? {} : { title: info.title }),
          agents: [...acc.agents].sort(),
          tokensInput: acc.tokensInput,
          tokensOutput: acc.tokensOutput,
          tokensCacheRead: acc.tokensCacheRead,
          tokensCacheWrite: acc.tokensCacheWrite,
          tokensTotal: acc.tokensInput + acc.tokensOutput,
          ...(acc.usd === undefined ? {} : { costUsd: acc.usd }),
          ...(acc.reason === undefined ? {} : { unpricedReason: acc.reason }),
        }
      })
      .sort((a, b) => b.tokensTotal - a.tokensTotal)

    return {
      rows,
      coverage,
      byModel,
      bySession,
      ...(sessionScope === undefined ? {} : { sessionScope }),
    }
  } finally {
    db.close()
  }
}

/** ISO day (UTC) — the granularity a coverage claim can honestly carry. */
function isoDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10)
}

/**
 * Describe the window the numbers actually cover.
 *
 * A database created by a V2 host holds only the days since it was created, so
 * a 30-day request over 8 days of history must not read as a month of usage.
 */
function formatCoverage(coverage: CostCoverage, days: number): string {
  const databaseStart = coverage.databaseStart
  if (databaseStart === undefined) {
    return `Coverage: this database holds no message rows at all, so the ${days}-day window cannot be covered.`
  }
  const start = isoDay(databaseStart)
  const heldDays = Math.floor((Date.now() - databaseStart) / 86_400_000) + 1
  const head = `Coverage: this database holds ${heldDays} day${heldDays === 1 ? '' : 's'} of history, from ${start}`
  if (coverage.windowStart === undefined) {
    return `${head}, and no rows fall inside the requested ${days}-day window.`
  }
  if (heldDays < days) {
    return `${head}, so the requested ${days}-day window is only covered from ${isoDay(coverage.windowStart)}.`
  }
  return `${head} (requested window: ${days} days).`
}

/**
 * Diagnose a ledger that WAS found but could not be read.
 *
 * An empty table under a success status is a worse failure than the error it
 * replaces: it is indistinguishable from a quiet week. Every branch here is a
 * case where rows exist but no total could be attributed, so the tool must
 * diagnose it instead of printing an empty ledger.
 *
 * The last branch asks whether ANY row carries a token, not whether any row
 * exists: an aggregate can carry an agent and still sum to zero (no `tokens`
 * key), and rendering `| agent | unknown | 0 | 0 | 0 |` under `status: OK`
 * asserts a measurement that was never made.
 */
function diagnoseUnreadableLedger(query: CostQuery, days: number): string | undefined {
  const { scanned, assistantRows, sources } = query.coverage
  if (scanned === 0) return undefined
  const tables = sources.join(' and ')
  if (assistantRows === 0) {
    return (
      `no readable token source: ${scanned} row(s) were scanned in the last ${days} day(s) ` +
      `but none matched the assistant discriminator of ${tables}, so no usage can be attributed. ` +
      'This is an unrecognised ledger layout, not an empty one; point PANTHEON_COST_DB at a ' +
      'database whose token layout this build understands.'
    )
  }
  // A scoped report can legitimately be empty: the session filter, not the
  // ledger layout, removed every row. Diagnosing the user's database from a
  // filtered view reports a fault that does not exist, so the "no tokens"
  // branch is reserved for an UNSCOPED read.
  if (query.sessionScope !== undefined) return undefined
  if (
    !query.rows.some((row) => row.tokensInput !== 0 || row.tokensOutput !== 0) &&
    // Cache-only usage is still usage: a turn whose whole payload was served
    // from cache has zero input/output but a real cache-read count, and
    // calling that "unreadable" would hide spend that this report can price.
    !(query.byModel ?? []).some((row) => row.tokensCacheRead !== 0 || row.tokensCacheWrite !== 0)
  ) {
    return (
      `no readable token source: ${assistantRows} assistant row(s) were found in ${tables} ` +
      'but none carried both an attributable agent and a token payload, so no usage can be ' +
      'attributed. This is an unrecognised ledger layout, not an empty one.'
    )
  }
  return undefined
}

/** Smallest amount the four-decimal rendering can show without claiming zero. */
const MIN_DISPLAYABLE_USD = 0.0001

/**
 * Human money. `—` is "could not be priced", never "free".
 *
 * A real zero renders as `$0.00`, but a non-zero amount below the display
 * resolution renders as `< $0.0001`: rounding $0.00004 to `$0.0000` would show a
 * free model where the catalog charged for one, and this is the column a spend
 * decision is read from.
 */
function formatUsd(usd: number | undefined): string {
  if (usd === undefined) return '—'
  if (usd === 0) return '$0.00'
  if (usd < MIN_DISPLAYABLE_USD) return '< $0.0001'
  return usd < 1 ? `$${usd.toFixed(4)}` : `$${usd.toFixed(2)}`
}

/**
 * A total row's cost cell.
 *
 * With no priced row at all the cell is `—`, not `$0.00`: a report that could
 * not price anything has not measured zero spend, and this number is what a
 * tier decision would be made on.
 */
function totalCostCell(pricedUsd: number, pricedRows: number, unpricedRows: number): string {
  if (pricedRows === 0) return unpricedRows === 0 ? '**$0.00**' : '**—** (nothing priceable)'
  const cell = `**${formatUsd(pricedUsd)}**`
  return unpricedRows === 0 ? cell : `${cell} (partial)`
}

/** Session rows shown before the tail is summarised. */
const MAX_SESSION_ROWS = 20

/** Cut a session title to something that fits a markdown cell. */
function shortTitle(title: string | undefined): string {
  if (title === undefined) return '—'
  const flat = title.replaceAll('|', '/').replaceAll('\n', ' ').trim()
  return flat.length > 48 ? `${flat.slice(0, 47)}…` : flat === '' ? '—' : flat
}

/**
 * Where the prices came from and how stale they are.
 *
 * This is a claim the report makes about its own numbers, so it is stated even
 * when the answer is "no prices": a cost column full of `—` with no explanation
 * reads as zero spend.
 */
function pricingNote(pricing: PricingSnapshot | undefined): string[] {
  if (pricing === undefined) {
    return [
      'Pricing: unavailable for this run — every cost reads — and no model is treated as free.',
    ]
  }
  if (pricing.refused === true) {
    const detail = pricing.unavailableReason ?? 'a price refresh was refused'
    const suffix =
      pricing.index.size === 0
        ? 'every cost reads — and no model is treated as free.'
        : 'costs below use the cached catalog; nothing was fetched.'
    return [`Pricing: REFUSED — ${detail}; ${suffix}`]
  }
  if (pricing.index.size === 0) {
    const detail = pricing.unavailableReason ?? 'no cached catalog'
    return [
      `Pricing: unavailable (${detail}) — every cost reads — and unpriced models are EXCLUDED from totals, never priced at zero.`,
      // Never recommend a call the host has forbidden: an offline report that
      // says "run refreshPricing" is advice that cannot work.
      pricing.offline === true
        ? 'Pricing: this host is offline (PANTHEON_COST_OFFLINE=1); no catalog can be fetched until that is cleared.'
        : 'Pricing: run pantheon_cost({ refreshPricing: true }) to fetch the models.dev catalog; that is the only path that waits on the network, bounded by a 3 s timeout.',
    ]
  }
  const fetched = pricing.fetchedAt === undefined ? 'unknown date' : isoDay(pricing.fetchedAt)
  const head = `Pricing: models.dev catalog (USD per 1M tokens), cached ${fetched}`
  if (pricing.unavailableReason !== undefined) {
    return [
      `${head} — the requested refresh failed (${pricing.unavailableReason}); costs below use cached prices.`,
    ]
  }
  if (pricing.refreshing) {
    return [`${head} — stale, refreshing in the background; costs below use these cached prices.`]
  }
  if (pricing.stale) {
    const why =
      pricing.offline === true
        ? 'offline, so no background refresh was scheduled'
        : 'no background refresh was scheduled'
    return [`${head} — stale, and ${why}; costs below use cached prices.`]
  }
  return [`${head}.`]
}

/** Model rows collapsed across agents: one line per provider/model pair. */
function modelTotals(byModel: readonly CostModelRow[]): Array<{
  provider: string
  model: string
  tokensInput: number
  tokensOutput: number
  tokensCacheRead: number
  tokensCacheWrite: number
  tokensTotal: number
  costUsd: number | undefined
}> {
  const groups = new Map<
    string,
    {
      provider: string
      model: string
      tokensInput: number
      tokensOutput: number
      tokensCacheRead: number
      tokensCacheWrite: number
      tokensTotal: number
      usd: number | undefined
      unpriced: boolean
    }
  >()
  for (const row of byModel) {
    const key = `${row.provider}\u0000${row.model}`
    const acc = groups.get(key) ?? {
      provider: row.provider,
      model: row.model,
      tokensInput: 0,
      tokensOutput: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
      tokensTotal: 0,
      usd: 0,
      unpriced: false,
    }
    acc.tokensInput += row.tokensInput
    acc.tokensOutput += row.tokensOutput
    acc.tokensCacheRead += row.tokensCacheRead
    acc.tokensCacheWrite += row.tokensCacheWrite
    acc.tokensTotal += row.tokensTotal
    if (row.costUsd === undefined || acc.usd === undefined) {
      acc.unpriced = true
      acc.usd = undefined
    } else {
      acc.usd += row.costUsd
    }
    groups.set(key, acc)
  }
  return [...groups.values()]
    .map((acc) => ({
      provider: acc.provider,
      model: acc.model,
      tokensInput: acc.tokensInput,
      tokensOutput: acc.tokensOutput,
      tokensCacheRead: acc.tokensCacheRead,
      tokensCacheWrite: acc.tokensCacheWrite,
      tokensTotal: acc.tokensTotal,
      costUsd: acc.unpriced ? undefined : acc.usd,
    }))
    .sort((a, b) => b.tokensTotal - a.tokensTotal)
}

/** The `## Cost by model` section. */
function renderModelSection(byModel: readonly CostModelRow[] | undefined, days: number): string[] {
  const header = `## Cost by model (last ${days} days)`
  if (byModel === undefined) {
    return [header, '', 'Unavailable: this run reports tokens only (CLI fallback path).']
  }
  if (byModel.length === 0) return [header, '', 'No model rows in this window.']
  const totals = modelTotals(byModel)
  const pricedUsd = totals.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)
  const priced = totals.filter((row) => row.costUsd !== undefined).length
  const unpriced = totals.length - priced
  const totalCell = totalCostCell(pricedUsd, priced, unpriced)
  return [
    header,
    '',
    '| Provider | Model | Tokens In | Tokens Out | Cache Read | Cache Write | Cost (USD) |',
    '|----------|-------|----------:|-----------:|-----------:|------------:|-----------:|',
    ...totals.map(
      (row) =>
        `| ${row.provider} | ${row.model} | ${row.tokensInput} | ${row.tokensOutput} | ${row.tokensCacheRead} | ${row.tokensCacheWrite} | ${formatUsd(row.costUsd)} |`,
    ),
    `| **Total** | — | **${totals.reduce((sum, row) => sum + row.tokensInput, 0)}** | **${totals.reduce((sum, row) => sum + row.tokensOutput, 0)}** | **${totals.reduce((sum, row) => sum + row.tokensCacheRead, 0)}** | **${totals.reduce((sum, row) => sum + row.tokensCacheWrite, 0)}** | ${totalCell} |`,
  ]
}

/** The `## Cost by session` section, scoped or global. */
function renderSessionSection(query: CostQuery, days: number): string[] {
  const scope = query.sessionScope
  const header =
    scope === undefined
      ? `## Cost by session (last ${days} days)`
      : `## Cost by session tree (last ${days} days) — root ${scope.rootId}`
  if (query.bySession === undefined) {
    return [header, '', 'Unavailable: this run reports tokens only (CLI fallback path).']
  }
  const lines = [header, '']
  if (scope !== undefined) {
    if (!scope.hierarchy) {
      lines.push(
        'Session hierarchy unavailable: this database has no session metadata table, so only rows whose session_id equals the root are counted.',
        '',
      )
    } else if (!scope.rootKnown) {
      lines.push(
        'Root session not found in this database: only rows whose session_id equals it are counted, and no descendants can be resolved.',
        '',
      )
    } else {
      lines.push(`Scope: the root session plus ${scope.ids.length - 1} descendant session(s).`, '')
    }
  }
  if (query.bySession.length === 0) {
    lines.push('No session rows in this window.')
    return lines
  }
  const shown = query.bySession.slice(0, MAX_SESSION_ROWS)
  const hidden = query.bySession.length - shown.length
  const pricedUsd = query.bySession.reduce((sum, row) => sum + (row.costUsd ?? 0), 0)
  const priced = query.bySession.filter((row) => row.costUsd !== undefined).length
  const unpriced = query.bySession.length - priced
  const totalCell = totalCostCell(pricedUsd, priced, unpriced)
  lines.push(
    '| Session | Title | Agent | Tokens In | Tokens Out | Cache Read | Cache Write | Tokens Total | Cost (USD) |',
    '|---------|-------|-------|----------:|-----------:|-----------:|------------:|-------------:|-----------:|',
    ...shown.map(
      (row) =>
        `| ${row.sessionId} | ${shortTitle(row.title)} | ${row.agents.join(', ') || '—'} | ${row.tokensInput} | ${row.tokensOutput} | ${row.tokensCacheRead} | ${row.tokensCacheWrite} | ${row.tokensTotal} | ${formatUsd(row.costUsd)} |`,
    ),
    `| **${scope === undefined ? 'Total' : 'Root + descendants'}** | — | — | **${query.bySession.reduce((sum, row) => sum + row.tokensInput, 0)}** | **${query.bySession.reduce((sum, row) => sum + row.tokensOutput, 0)}** | **${query.bySession.reduce((sum, row) => sum + row.tokensCacheRead, 0)}** | **${query.bySession.reduce((sum, row) => sum + row.tokensCacheWrite, 0)}** | **${query.bySession.reduce((sum, row) => sum + row.tokensTotal, 0)}** | ${totalCell} |`,
  )
  if (hidden > 0) {
    lines.push('', `_+${hidden} more session(s) not listed; the totals include them._`)
  }
  return lines
}

/** Render the aggregate as markdown tables with total rows. */
function renderMarkdown(
  query: CostQuery,
  days: number,
  pricing: PricingSnapshot | undefined,
): string {
  const { rows, coverage } = query
  const header = `## Token and cost usage by agent and phase (last ${days} days)`
  const footer = [
    formatCoverage(coverage, days),
    'Window: rolling 24-hour days from query time (not calendar days or session boundaries).',
    'Aggregation: per agent and phase (phase may be unknown on V2), per model, and per session.',
    'Attribution: a session row covers that session alone; passing session:<id> sums the root session and its descendant sessions.',
    'Limits: costs are catalog list prices (USD per 1M tokens), not a provider invoice; a row mixing a priced and an unpriced model reads — and is excluded from the totals, because an unknown model is never priced at zero.',
    ...pricingNote(pricing),
    `Source: opencode.db (read-only) — table families: ${coverage.sources.join(' + ')} — ${coverage.assistantRows} assistant row(s) scanned`,
  ].join('\n')
  if (rows.length === 0) {
    // The scope sentence lives in the session section, so an empty report must
    // still render that section — otherwise a valid empty subtree looks
    // indistinguishable from a database that holds nothing.
    const scope = query.sessionScope
    const empty =
      scope === undefined
        ? `No token records in the last ${days} days.`
        : `No token records in the last ${days} days for ${scope.rootId} or its descendant sessions.`
    return [
      header,
      '',
      empty,
      '',
      ...renderModelSection(query.byModel, days),
      '',
      ...renderSessionSection(query, days),
      '',
      footer,
    ].join('\n')
  }
  const total = rows.reduce(
    (acc, r) => {
      acc.tokensInput += r.tokensInput
      acc.tokensOutput += r.tokensOutput
      acc.tokensTotal += r.tokensTotal
      if (r.costUsd === undefined) acc.unpriced += 1
      else {
        acc.usd += r.costUsd
        acc.priced += 1
      }
      return acc
    },
    { tokensInput: 0, tokensOutput: 0, tokensTotal: 0, usd: 0, unpriced: 0, priced: 0 },
  )
  const totalCost = totalCostCell(total.usd, total.priced, total.unpriced)
  const lines = [
    header,
    '',
    '| Agent | Phase | Tokens In | Tokens Out | Tokens Total | Cost (USD) |',
    '|-------|-------|----------:|-----------:|-------------:|-----------:|',
    ...rows.map(
      (r) =>
        `| ${r.agent} | ${r.phase} | ${r.tokensInput} | ${r.tokensOutput} | ${r.tokensTotal} | ${formatUsd(r.costUsd)} |`,
    ),
    `| **Total** | — | **${total.tokensInput}** | **${total.tokensOutput}** | **${total.tokensTotal}** | ${totalCost} |`,
    '',
    ...renderModelSection(query.byModel, days),
    '',
    ...renderSessionSection(query, days),
    '',
    footer,
  ]
  return lines.join('\n')
}

// ─── CLI fallback: resolve a REAL Node, not the plugin runtime ──────────
//
// Under Bun (the runtime that motivates this fallback), process.execPath IS
// the Bun binary, which has no node:sqlite — so spawning it could never work.
// Resolve a genuine Node instead: PANTHEON_NODE → `node` on PATH → clear error.

/** First Node release exposing the built-in `node:sqlite` module. */
const NODE_SQLITE_MIN_VERSION = '22.5'

/** Minimal injectable child-process boundary (tests / unusual runtimes). */
export type ExecFileLike = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr?: string }>

/** Injectables so the fallback never depends on the real machine in tests. */
export interface CliFallbackDeps {
  /** Environment for PANTHEON_NODE / PATH lookup. Default: process.env. */
  env?: NodeJS.ProcessEnv
  /** Child-process boundary. Default: node:child_process.execFile. */
  execFile?: ExecFileLike
  /** Executable predicate used by the PANTHEON_NODE / PATH lookups. */
  isExecutable?: (path: string) => boolean
}

/** A real Node executable located for the CLI fallback. */
export interface ResolvedNode {
  path: string
  source: 'env' | 'path'
}

type ExecFailure = Error & { stdout?: string; stderr?: string }

function defaultIsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function defaultExecFile(
  file: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        // execFile's callback error does not always carry the captured output;
        // attach it so callers can surface cost.mjs's structured {ok:false}.
        const failure = error as ExecFailure
        if (typeof failure.stdout !== 'string') failure.stdout = stdout
        if (typeof failure.stderr !== 'string') failure.stderr = stderr
        reject(failure)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

/** Scan PATH (no shell) for a `node` executable. */
export function resolveNodeFromPath(
  env: NodeJS.ProcessEnv,
  isExecutable: (path: string) => boolean = defaultIsExecutable,
): string | undefined {
  const pathValue = env.PATH ?? env.Path ?? ''
  if (pathValue === '') return undefined
  const isWindows = process.platform === 'win32'
  const extensions = isWindows
    ? (env.PATHEXT ?? '.EXE;.BAT;.CMD;.COM').split(';').filter((ext) => ext !== '')
    : ['']
  for (const dir of pathValue.split(delimiter)) {
    if (dir === '') continue
    for (const ext of extensions) {
      const candidate = join(dir, `node${ext}`)
      if (isExecutable(candidate)) return candidate
    }
  }
  return undefined
}

/**
 * Resolve a REAL Node.js binary for the CLI fallback.
 *
 * Order: PANTHEON_NODE (must exist and be executable — an explicit override
 * that is unusable fails fast instead of being silently ignored) → `node`
 * from PATH. Returns undefined only when neither source is available.
 */
export function resolveNodeExecutable(
  env: NodeJS.ProcessEnv = process.env,
  isExecutable: (path: string) => boolean = defaultIsExecutable,
): ResolvedNode | undefined {
  const explicit = env.PANTHEON_NODE
  if (explicit !== undefined && explicit.trim() !== '') {
    if (isExecutable(explicit)) return { path: explicit, source: 'env' }
    throw new Error(
      `PANTHEON_NODE is set to "${explicit}" but that is not an existing executable file`,
    )
  }
  const fromPath = resolveNodeFromPath(env, isExecutable)
  return fromPath === undefined ? undefined : { path: fromPath, source: 'path' }
}

function execErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    const failure = err as ExecFailure
    const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : ''
    if (stderr !== '') return stderr
    return failure.message
  }
  return String(err)
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function truncateForError(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed
}

/** Probe the resolved binary for built-in node:sqlite support. */
async function assertNodeSqliteSupport(
  nodePath: string,
  execFileAsync: ExecFileLike,
): Promise<void> {
  try {
    await execFileAsync(nodePath, ['-e', "require('node:sqlite')"])
  } catch (err: unknown) {
    throw new Error(
      `resolved Node binary "${nodePath}" does not support node:sqlite (Node.js >= ${NODE_SQLITE_MIN_VERSION} required): ${execErrorMessage(err)}`,
    )
  }
}

/** Pull the structured failure message cost.mjs prints to stdout (exit 1). */
function extractScriptFailure(err: unknown): string {
  const failure = err as { stdout?: unknown; stderr?: unknown }
  const stdout = typeof failure.stdout === 'string' ? failure.stdout : ''
  const parsed = tryParseJson(stdout)
  if (parsed !== null && typeof parsed === 'object') {
    const record = parsed as { ok?: unknown; error?: unknown }
    if (record.ok === false && typeof record.error === 'string' && record.error !== '') {
      return record.error
    }
  }
  const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : ''
  if (stderr !== '') return stderr
  return execErrorMessage(err)
}

/**
 * Spawn `node scripts/cost.mjs` as a CLI fallback when node:sqlite is
 * unavailable in the plugin process (e.g. Bun runtime). Returns the same
 * CostQuery the in-process reader produces by parsing the JSON the script
 * writes to stdout.
 *
 * Resolves a REAL Node binary (PANTHEON_NODE → PATH): process.execPath under
 * Bun is the Bun binary, which cannot run node:sqlite. The resolved binary is
 * probed for node:sqlite support and the script is always run read-only with
 * an argument array (never a shell).
 */
export async function queryWithCliFallback(
  dbPath: string,
  days: number,
  deps?: CliFallbackDeps,
): Promise<CostQuery> {
  const env = deps?.env ?? process.env
  const execFileAsync = deps?.execFile ?? defaultExecFile
  const isExecutable = deps?.isExecutable ?? defaultIsExecutable

  const costScript = join(__dirname, '..', '..', 'scripts', 'cost.mjs')
  if (!existsSync(costScript)) {
    throw new Error(`CLI fallback script not found: ${costScript}`)
  }

  const node = resolveNodeExecutable(env, isExecutable)
  if (node === undefined) {
    throw new Error(
      `no Node.js executable found for the node:sqlite CLI fallback: set PANTHEON_NODE to a Node.js >= ${NODE_SQLITE_MIN_VERSION} binary or put "node" on PATH`,
    )
  }

  await assertNodeSqliteSupport(node.path, execFileAsync)

  let stdout: string
  try {
    ;({ stdout } = await execFileAsync(node.path, [
      costScript,
      '--db-path',
      dbPath,
      '--days',
      String(days),
    ]))
  } catch (err: unknown) {
    // cost.mjs sets exitCode=1 (execFile rejects) and writes {ok:false,error}
    // to stdout before exiting — surface that structured failure.
    throw new Error(`CLI fallback failed: ${extractScriptFailure(err)}`)
  }

  const parsed = tryParseJson(stdout)
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`CLI fallback returned non-JSON output: ${truncateForError(stdout)}`)
  }
  const record = parsed as { ok?: unknown; rows?: unknown; coverage?: unknown; error?: unknown }
  if (record.ok !== true) {
    const detail =
      typeof record.error === 'string' && record.error !== ''
        ? record.error
        : 'unexpected response shape from scripts/cost.mjs'
    throw new Error(`CLI fallback failed: ${detail}`)
  }
  if (!Array.isArray(record.rows)) {
    throw new Error('CLI fallback failed: scripts/cost.mjs response is missing the rows array')
  }
  const coverage = record.coverage
  if (coverage === null || typeof coverage !== 'object') {
    throw new Error(
      'CLI fallback failed: scripts/cost.mjs response is missing the coverage object; the mirror must report what it scanned',
    )
  }
  const mirror = coverage as {
    sources?: unknown
    scanned?: unknown
    assistantRows?: unknown
    databaseStart?: unknown
    windowStart?: unknown
  }
  return {
    rows: record.rows as CostRow[],
    coverage: {
      sources: Array.isArray(mirror.sources) ? (mirror.sources as CostSource[]) : [],
      scanned: numberOf(mirror.scanned) ?? 0,
      assistantRows: numberOf(mirror.assistantRows) ?? 0,
      ...(numberOf(mirror.databaseStart) === undefined
        ? {}
        : { databaseStart: numberOf(mirror.databaseStart) as number }),
      ...(numberOf(mirror.windowStart) === undefined
        ? {}
        : { windowStart: numberOf(mirror.windowStart) as number }),
    },
  }
}

export function createCostCommand(options?: CostCommandOptions): CostCommand {
  const loadSqlite =
    options?.sqliteLoader ?? (async () => (await import('node:sqlite')) as SqliteModule)

  const failure = (status: NativeTaskStatus, detail: string): string =>
    `status: ${status}\npantheon_cost failed: ${detail}`

  const diagnostic = (err: unknown): string => {
    if (err instanceof Error) {
      const stderr = (err as Error & { stderr?: unknown }).stderr
      const suffix =
        typeof stderr === 'string' && stderr.trim() !== '' ? `; stderr: ${stderr.trim()}` : ''
      return `${err.message}${suffix}`
    }
    return String(err)
  }

  const statusForError = (err: unknown): NativeTaskStatus => {
    const detail = diagnostic(err).toLowerCase()
    if (
      detail.includes('not found') ||
      detail.includes('unknown builtin') ||
      detail.includes('no such built-in') ||
      detail.includes('cannot find module') ||
      // The mirror's own "found a ledger but could not read tokens" verdict.
      // Must stay in step with scripts/cost.mjs, which emits this exact phrase.
      detail.includes('no readable token source')
    ) {
      return 'UNSUPPORTED'
    }
    if (
      detail.includes('not a database') ||
      detail.includes('malformed') ||
      detail.includes('corrupt') ||
      detail.includes('incompatible opencode.db schema')
    ) {
      return 'CORRUPT_DATA'
    }
    return 'UNAVAILABLE'
  }

  /** Run a query and turn its coverage into either a report or a diagnosis. */
  const render = (query: CostQuery, days: number, pricing?: PricingSnapshot): string => {
    const unreadable = diagnoseUnreadableLedger(query, days)
    if (unreadable !== undefined) return failure('UNSUPPORTED', unreadable)
    return `status: OK\n${renderMarkdown(query, days, pricing)}`
  }

  const execute = async (args: CostArgs, _ctx: ToolContextLike): Promise<string> => {
    const days = args?.days ?? 7
    try {
      const dbPath = findExistingDb(options?.dbPath)
      if (dbPath === undefined) {
        const expected = resolveCostDbPath(options)
        return failure(
          'UNAVAILABLE',
          `opencode.db not found (expected at ${expected}). No token history is available until opencode has stored session data.`,
        )
      }
      // Pricing never blocks a default call: `refreshPricing` is the only path
      // that awaits the catalog, and it is bounded by a short timeout.
      const pricing =
        args?.refreshPricing === true
          ? await forceRefreshPricing(options?.pricing)
          : loadPricing(options?.pricing).snapshot
      const queryOptions: CostQueryOptions = {
        pricing,
        ...(args?.session === undefined ? {} : { sessionRoot: args.session }),
      }
      let sqlite: SqliteModule | undefined
      try {
        sqlite = await loadSqlite()
      } catch (loadErr: unknown) {
        // node:sqlite unavailable (e.g. Bun runtime) — fall back to CLI.
        const status = statusForError(loadErr)
        if (status === 'UNSUPPORTED') {
          // The mirror reports tokens only and carries no session ids, so it
          // cannot answer a scoped question. Rendering an unscoped total under a
          // scoped question is exactly the plausible-but-wrong number this
          // report exists to prevent, so the request is refused instead.
          if (args?.session !== undefined) {
            return failure(
              'UNSUPPORTED',
              `session scoping requires the node:sqlite backend, which this runtime does not provide (${diagnostic(loadErr)}). The CLI fallback reports tokens only and cannot resolve a session tree; re-run on Node.js >= ${NODE_SQLITE_MIN_VERSION} or drop "session".`,
            )
          }
          try {
            return render(
              await queryWithCliFallback(dbPath, days, options?.cliFallback),
              days,
              pricing,
            )
          } catch (cliErr: unknown) {
            return failure(statusForError(cliErr), diagnostic(cliErr))
          }
        }
        throw loadErr
      }
      return render(queryWithSqlite(dbPath, days, sqlite, queryOptions), days, pricing)
    } catch (err: unknown) {
      return failure(statusForError(err), diagnostic(err))
    }
  }

  return {
    pantheon_cost: {
      description:
        'Report input, output, cache and total token usage together with USD cost, by agent and phase, by model, and by session, in a rolling N × 24-hour window from query time (read-only). Costs come from the models.dev catalog, cached on disk; a tool call reads the cache and never waits on the network unless refreshPricing is set. An unknown or unpriced model reads — and is excluded from the totals, never priced at zero, and the total says it is partial. Pass session:<id> to aggregate that root session plus its descendant sessions. Phase may be unknown on V2. Costs are catalog list prices, not an invoice. The report states the coverage window it actually covers and whether its prices are stale.',
      args: costArgs,
      execute,
    },
  }
}
