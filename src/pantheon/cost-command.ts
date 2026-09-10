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
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import type { ToolContextLike } from './delegation.ts'
import type { NativeTaskStatus } from './native-task-status.ts'

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
      const sqlite = await loadSqlite()
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
