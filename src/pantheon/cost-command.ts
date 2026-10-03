/**
 * Token Command — `pantheon_cost` structural tool: token visibility for
 * delegation traffic, straight from opencode.db.
 *
 * Reads the opencode session database READ-ONLY (sum tokens by agent and
 * phase over the last N days → markdown table). Zero new dependencies:
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
}

export interface CostCommandOptions {
  /** Explicit db path (testability / unusual installs). Default: resolved candidates. */
  dbPath?: string
  /** Injectable loader for tests; production always loads node:sqlite. */
  sqliteLoader?: () => Promise<SqliteModule>
  /** Injectable CLI-fallback process boundary (tests / unusual runtimes). */
  cliFallback?: CliFallbackDeps
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
    .describe('Number of days of delegation history to include (default 7).'),
} satisfies z.ZodRawShape

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
 * Per-family aggregation.
 *
 * Aggregating in SQL instead of pulling `data` blobs into JS is not a
 * micro-optimisation: the host's own 7-day window is 271 MB across 26410
 * assistant rows, and the equivalent SQL finishes in 0.9 s over the
 * time_created index.
 *
 * Two correctness details are load-bearing:
 *   - `json_valid(data)` gates every extraction, because `json_extract` and
 *     `->>` both RAISE on malformed JSON in node:sqlite's bundled SQLite. The
 *     inner CTE applies it before extracting anything, so the outer query can
 *     never see an unparseable payload whatever order SQLite evaluates terms in.
 *   - `COALESCE(SUM(...), 0)` — a group whose tokens are all NULL sums to NULL,
 *     and adding NULL into an accumulator would print NaN into the report.
 *
 * V1 marks assistant turns with `data.role`; V2 marks them with the `type`
 * COLUMN. V2 carries no `role` key, so the V1 predicate would match nothing.
 */
const AGGREGATE_SQL: Record<CostSource, string> = {
  message: `
    WITH valid AS (
      SELECT json_extract(data, '$.role') AS role,
             json_extract(data, '$.agent') AS agent,
             json_extract(data, '$.phase') AS phase,
             json_extract(data, '$.metadata.phase') AS metadataPhase,
             CAST(json_extract(data, '$.tokens.input') AS INTEGER) AS inTok,
             CAST(json_extract(data, '$.tokens.output') AS INTEGER) AS outTok
      FROM message
      WHERE time_created >= ? AND json_valid(data)
    )
    SELECT agent AS agent,
           COALESCE(NULLIF(phase, ''), NULLIF(metadataPhase, ''), 'unknown') AS phase,
           COALESCE(SUM(inTok), 0) AS tokensInput,
           COALESCE(SUM(outTok), 0) AS tokensOutput,
           COUNT(*) AS rows
    FROM valid
    WHERE role = 'assistant'
    GROUP BY 1, 2
    HAVING agent IS NOT NULL AND agent != ''`,
  session_message: `
    WITH valid AS (
      SELECT json_extract(data, '$.agent') AS agent,
             CAST(json_extract(data, '$.tokens.input') AS INTEGER) AS inTok,
             CAST(json_extract(data, '$.tokens.output') AS INTEGER) AS outTok
      FROM session_message
      WHERE time_created >= ? AND type = 'assistant' AND json_valid(data)
    )
    SELECT agent AS agent,
           'unknown' AS phase,
           COALESCE(SUM(inTok), 0) AS tokensInput,
           COALESCE(SUM(outTok), 0) AS tokensOutput,
           COUNT(*) AS rows
    FROM valid
    GROUP BY 1
    HAVING agent IS NOT NULL AND agent != ''`,
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

/**
 * Read the token ledger of one database, read-only.
 *
 * Exported so the mirrored implementation in scripts/cost.mjs can be held to
 * the same answer in tests. The script cannot import this module: it runs on a
 * plain Node precisely because node:sqlite is missing from the plugin runtime.
 */
export async function queryCostRows(dbPath: string, days: number): Promise<CostQuery> {
  const sqlite = (await import('node:sqlite')) as SqliteModule
  return queryWithSqlite(dbPath, days, sqlite)
}

/** Shared aggregation path for the in-process reader and queryCostRows. */
function queryWithSqlite(dbPath: string, days: number, sqlite: SqliteModule): CostQuery {
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  try {
    const sources = resolveSources(db, requestedVersion())
    const since = Date.now() - days * 86_400_000
    const byAgentAndPhase = new Map<string, CostRow>()
    const coverage = emptyCoverage([])

    const note = (key: 'windowStart' | 'databaseStart', value: number | undefined): void => {
      if (value === undefined) return
      const current = coverage[key]
      coverage[key] = current === undefined ? value : Math.min(current, value)
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

      const groups = db.prepare(AGGREGATE_SQL[source]).all(since) as Array<{
        agent?: unknown
        phase?: unknown
        tokensInput?: unknown
        tokensOutput?: unknown
      }>
      for (const group of groups) {
        const agent = String(group.agent ?? '')
        if (agent === '') continue
        const phase =
          group.phase === undefined || group.phase === null ? 'unknown' : String(group.phase)
        const tokensInput = numberOf(group.tokensInput) ?? 0
        const tokensOutput = numberOf(group.tokensOutput) ?? 0
        // Keyed on a NUL separator: agent names cannot contain it, so an agent
        // whose name ends in the phase cannot collide with a phase-only row.
        const key = `${agent}\u0000${phase}`
        const acc = byAgentAndPhase.get(key) ?? {
          agent,
          phase,
          tokensInput: 0,
          tokensOutput: 0,
          tokensTotal: 0,
        }
        acc.tokensInput += tokensInput
        acc.tokensOutput += tokensOutput
        acc.tokensTotal += tokensInput + tokensOutput
        byAgentAndPhase.set(key, acc)
      }
    }

    const rows = [...byAgentAndPhase.values()].sort((a, b) => b.tokensTotal - a.tokensTotal)
    return { rows, coverage }
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
  if (!query.rows.some((row) => row.tokensInput !== 0 || row.tokensOutput !== 0)) {
    return (
      `no readable token source: ${assistantRows} assistant row(s) were found in ${tables} ` +
      'but none carried both an attributable agent and a token payload, so no usage can be ' +
      'attributed. This is an unrecognised ledger layout, not an empty one.'
    )
  }
  return undefined
}

/** Render the aggregate as a markdown table with a total row. */
function renderMarkdown(query: CostQuery, days: number): string {
  const { rows, coverage } = query
  const header = `## Token usage by agent and phase (last ${days} days)`
  const footer = [
    formatCoverage(coverage, days),
    `Source: opencode.db (read-only) — table families: ${coverage.sources.join(' + ')} — ${coverage.assistantRows} assistant row(s) scanned`,
  ].join('\n')
  if (rows.length === 0) {
    return `${header}\n\nNo token records in the last ${days} days.\n\n${footer}`
  }
  const total = rows.reduce(
    (acc, r) => {
      acc.tokensInput += r.tokensInput
      acc.tokensOutput += r.tokensOutput
      acc.tokensTotal += r.tokensTotal
      return acc
    },
    { tokensInput: 0, tokensOutput: 0, tokensTotal: 0 },
  )
  const lines = [
    header,
    '',
    '| Agent | Phase | Tokens In | Tokens Out | Tokens Total |',
    '|-------|-------|----------:|-----------:|-------------:|',
    ...rows.map(
      (r) =>
        `| ${r.agent} | ${r.phase} | ${r.tokensInput} | ${r.tokensOutput} | ${r.tokensTotal} |`,
    ),
    `| **Total** | — | **${total.tokensInput}** | **${total.tokensOutput}** | **${total.tokensTotal}** |`,
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
  const render = (query: CostQuery, days: number): string => {
    const unreadable = diagnoseUnreadableLedger(query, days)
    if (unreadable !== undefined) return failure('UNSUPPORTED', unreadable)
    return `status: OK\n${renderMarkdown(query, days)}`
  }

  const execute = async (args: { days?: number }, _ctx: ToolContextLike): Promise<string> => {
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
      let sqlite: SqliteModule | undefined
      try {
        sqlite = await loadSqlite()
      } catch (loadErr: unknown) {
        // node:sqlite unavailable (e.g. Bun runtime) — fall back to CLI.
        const status = statusForError(loadErr)
        if (status === 'UNSUPPORTED') {
          try {
            return render(await queryWithCliFallback(dbPath, days, options?.cliFallback), days)
          } catch (cliErr: unknown) {
            return failure(statusForError(cliErr), diagnostic(cliErr))
          }
        }
        throw loadErr
      }
      return render(queryWithSqlite(dbPath, days, sqlite), days)
    } catch (err: unknown) {
      return failure(statusForError(err), diagnostic(err))
    }
  }

  return {
    pantheon_cost: {
      description:
        'Report input, output, and total token usage by agent and phase over the last N days, read from opencode.db (read-only, no monetary values). The report states the coverage window it actually covers.',
      args: costArgs,
      execute,
    },
  }
}
