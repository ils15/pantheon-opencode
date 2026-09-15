/**
 * Token Command — `pantheon_cost` structural tool: token visibility for
 * delegation traffic, straight from opencode.db.
 *
 * Reads the opencode session database READ-ONLY (sum tokens by agent and
 * phase over the last N days → markdown table). Zero new dependencies:
 *   - only path: node:sqlite (DatabaseSync, readOnly) — node ≥ 22.5;
 *   - missing/unreadable db → a diagnostic contract status as TEXT.
 *
 * dbPath resolution: explicit option > env PANTHEON_COST_DB > the version-aware
 * default selected by PANTHEON_OPENCODE_VERSION (v1 or v2). An unset version
 * deliberately preserves V1 behavior. The tool is wired in
 * plugin.ts alongside the delegation toolset (usable by zeus and any agent
 * with tool access — no routing change needed).
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

/** Return the safe, isolated state DB name for an OpenCode version. */
function defaultDbPath(version: OpenCodeVersion | undefined): string {
  const xdg = process.env.XDG_DATA_HOME
  const dataHome = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.local', 'share')
  const filename = version === 'v2' ? 'opencode-v2.db' : 'opencode.db'
  return join(dataHome, 'opencode', filename)
}

/**
 * Resolve the database without probing another version's database.
 *
 * Explicit paths always win. A version selector changes exactly one default
 * filename; it never falls back to V1, which prevents a V2 report from
 * silently reading V1 history (or vice versa).
 */
export function resolveCostDbPath(options?: CostCommandOptions): string {
  const explicit = options?.dbPath || process.env.PANTHEON_COST_DB
  if (explicit) return explicit

  const configuredVersion = process.env.PANTHEON_OPENCODE_VERSION
  if (configuredVersion !== undefined && configuredVersion !== 'v1' && configuredVersion !== 'v2') {
    throw new Error(
      `invalid PANTHEON_OPENCODE_VERSION "${configuredVersion}"; expected "v1" or "v2"`,
    )
  }
  return defaultDbPath(configuredVersion as OpenCodeVersion | undefined)
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

function assertCompatibleSchema(db: {
  prepare(sql: string): { get(): unknown; all(...args: unknown[]): unknown[] }
}): void {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message'")
    .get()
  if (row === undefined) {
    throw new Error('incompatible opencode.db schema: required "message" table is missing')
  }
  const columns = db.prepare('PRAGMA table_info(message)').all() as Array<{ name?: unknown }>
  const names = new Set(columns.map((column) => column.name))
  const missing = ['data', 'time_created'].filter((name) => !names.has(name))
  if (missing.length > 0) {
    throw new Error(
      `incompatible opencode.db schema: message table is missing ${missing.join(', ')}; select the matching V1/V2 database`,
    )
  }
}

/** Aggregate tokens by agent and phase via node:sqlite (read-only). */
async function queryWithNodeSqlite(
  dbPath: string,
  days: number,
  sqlite: SqliteModule,
): Promise<CostRow[]> {
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  try {
    assertCompatibleSchema(db)
    const since = Date.now() - days * 86_400_000
    const rows = db
      .prepare('SELECT data FROM message WHERE time_created >= ?')
      .all(since) as Array<{ data?: unknown }>
    // Rows without a data payload carry no cost info — skip them instead of
    // coercing null/undefined into "null"/"undefined" strings.
    return aggregateMessages(rows.flatMap((row) => (row?.data == null ? [] : [String(row.data)])))
  } finally {
    db.close()
  }
}

/** Parse message.data JSON rows and aggregate tokens by assistant agent/phase. */
function aggregateMessages(dataValues: readonly string[]): CostRow[] {
  const byAgentAndPhase = new Map<string, CostRow>()
  for (const value of dataValues) {
    try {
      const outer = JSON.parse(value) as Record<string, unknown>
      // The message row wraps the payload in a nested JSON string; when it
      // is not a string, the row IS the payload (either way: flat info).
      const info =
        typeof outer.data === 'string' ? (JSON.parse(outer.data) as Record<string, unknown>) : outer
      if (info.role !== 'assistant') continue
      const agent = typeof info.agent === 'string' && info.agent !== '' ? info.agent : null
      if (agent === null) continue
      const metadata = info.metadata as Record<string, unknown> | undefined
      const phase =
        (typeof info.phase === 'string' && info.phase) ||
        (typeof metadata?.phase === 'string' && metadata.phase) ||
        'unknown'
      const tokens = (info.tokens ?? {}) as Record<string, unknown>
      const tokensInput = Number(tokens.input) || 0
      const tokensOutput = Number(tokens.output) || 0
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
    } catch {
      // Skip malformed rows — a partial ledger never breaks the report.
    }
  }
  return [...byAgentAndPhase.values()].sort((a, b) => b.tokensTotal - a.tokensTotal)
}

/** Render the aggregate as a markdown table with a total row. */
function renderMarkdown(rows: readonly CostRow[], days: number): string {
  if (rows.length === 0) {
    return `## Token usage by agent and phase (last ${days} days)\n\nNo token records in the last ${days} days.`
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
    `## Token usage by agent and phase (last ${days} days)`,
    '',
    '| Agent | Phase | Tokens In | Tokens Out | Tokens Total |',
    '|-------|-------|----------:|-----------:|-------------:|',
    ...rows.map(
      (r) =>
        `| ${r.agent} | ${r.phase} | ${r.tokensInput} | ${r.tokensOutput} | ${r.tokensTotal} |`,
    ),
    `| **Total** | — | **${total.tokensInput}** | **${total.tokensOutput}** | **${total.tokensTotal}** |`,
    '',
    `Source: opencode.db (read-only)`,
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
    ? (env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter((ext) => ext !== '')
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
 * unavailable in the plugin process (e.g. Bun runtime). Returns CostRow[] by
 * parsing the JSON the script writes to stdout.
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
): Promise<CostRow[]> {
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
  const record = parsed as { ok?: unknown; rows?: unknown; error?: unknown }
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
  return record.rows as CostRow[]
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
      detail.includes('cannot find module')
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
            const rows = await queryWithCliFallback(dbPath, days, options?.cliFallback)
            return `status: OK\n${renderMarkdown(rows, days)}`
          } catch (cliErr: unknown) {
            return failure(statusForError(cliErr), diagnostic(cliErr))
          }
        }
        throw loadErr
      }
      const rows = await queryWithNodeSqlite(dbPath, days, sqlite)
      return `status: OK\n${renderMarkdown(rows, days)}`
    } catch (err: unknown) {
      return failure(statusForError(err), diagnostic(err))
    }
  }

  return {
    pantheon_cost: {
      description:
        'Report input, output, and total token usage by agent and phase over the last N days, read from opencode.db (read-only, no monetary values).',
      args: costArgs,
      execute,
    },
  }
}
