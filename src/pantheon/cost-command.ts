/**
 * Cost Command (Wave 4, PR #46) — `pantheon_cost` structural tool: cost +
 * token visibility by agent, straight from opencode.db.
 *
 * Reads the opencode session database READ-ONLY (sum cost + tokens by
 * agent over the last N days → markdown table). Zero new dependencies:
 *   - primary path: node:sqlite (DatabaseSync, readOnly) — node ≥ 22.5;
 *   - fallback: spawn scripts/cost.mjs (node:sqlite, prints JSON) when the
 *     direct import is unavailable;
 *   - missing/unreadable db → FRIENDLY error string, never a crash (tools
 *     return errors as TEXT).
 *
 * dbPath resolution: explicit option > env PANTHEON_COST_DB > the version-aware
 * default selected by PANTHEON_OPENCODE_VERSION (v1 or v2). An unset version
 * deliberately preserves V1 behavior. The tool is wired in
 * plugin.ts (usable by zeus and any agent with tool access — no routing change
 * needed).
 *
 * @module cost-command
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

import type { ToolContextLike } from './tool-context.ts'

const execFileAsync = promisify(execFile)

/** One aggregated cost row (per agent). */
export interface CostRow {
  agent: string
  costUsd: number
  tokensInput: number
  tokensOutput: number
}

export interface CostCommandOptions {
  /** Explicit db path (testability / unusual installs). Default: resolved candidates. */
  dbPath?: string
}

export type OpenCodeVersion = 'v1' | 'v2'

/** One cost tool: description + zod args shape + execute. */
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
    .describe('Number of days of cost history to include (default 7).'),
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

/** Aggregate cost + tokens by agent via node:sqlite (read-only). */
async function queryWithNodeSqlite(dbPath: string, days: number): Promise<CostRow[]> {
  const sqlite = await import('node:sqlite')
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  try {
    assertCompatibleSchema(db)
    const since = Date.now() - days * 86_400_000
    const rows = db.prepare('SELECT data FROM message WHERE time_created >= ?').all(since)
    return aggregateMessages(rows.map((row) => String(row.data)))
  } finally {
    db.close()
  }
}

/** Fallback: delegate the same aggregation to scripts/cost.mjs (node:sqlite). */
async function queryWithScript(
  scriptPath: string,
  dbPath: string,
  days: number,
): Promise<CostRow[]> {
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, dbPath, String(days)], {
    timeout: 15_000,
    encoding: 'utf8',
  })
  const parsed = JSON.parse(stdout) as { ok: boolean; rows?: CostRow[]; error?: string }
  if (!parsed.ok) throw new Error(parsed.error ?? 'cost.mjs failed')
  return parsed.rows ?? []
}

/** Parse message.data JSON rows and aggregate cost + tokens by assistant agent. */
function aggregateMessages(dataValues: readonly string[]): CostRow[] {
  const byAgent = new Map<string, CostRow>()
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
      const costUsd = Number(info.cost) || 0
      const tokens = (info.tokens ?? {}) as Record<string, unknown>
      const tokensInput = Number(tokens.input) || 0
      const tokensOutput = Number(tokens.output) || 0
      const acc = byAgent.get(agent) ?? { agent, costUsd: 0, tokensInput: 0, tokensOutput: 0 }
      acc.costUsd += costUsd
      acc.tokensInput += tokensInput
      acc.tokensOutput += tokensOutput
      byAgent.set(agent, acc)
    } catch {
      // Skip malformed rows — a partial ledger never breaks the report.
    }
  }
  return [...byAgent.values()].sort((a, b) => b.costUsd - a.costUsd)
}

/** Render the aggregate as a markdown table with a total row. */
function renderMarkdown(rows: readonly CostRow[], days: number): string {
  if (rows.length === 0) {
    return `## Cost by agent (last ${days} days)\n\nNo cost records in the last ${days} days.`
  }
  const total = rows.reduce(
    (acc, r) => {
      acc.costUsd += r.costUsd
      acc.tokensInput += r.tokensInput
      acc.tokensOutput += r.tokensOutput
      return acc
    },
    { costUsd: 0, tokensInput: 0, tokensOutput: 0 },
  )
  const lines = [
    `## Cost by agent (last ${days} days)`,
    '',
    '| Agent | Cost (USD) | Tokens In | Tokens Out |',
    '|-------|-----------:|----------:|-----------:|',
    ...rows.map(
      (r) => `| ${r.agent} | $${r.costUsd.toFixed(6)} | ${r.tokensInput} | ${r.tokensOutput} |`,
    ),
    `| **Total** | **$${total.costUsd.toFixed(6)}** | **${total.tokensInput}** | **${total.tokensOutput}** |`,
    '',
    `Source: opencode.db (read-only)`,
  ]
  return lines.join('\n')
}

export function createCostCommand(options?: CostCommandOptions): CostCommand {
  const scriptPath = new URL('../../scripts/cost.mjs', import.meta.url).pathname

  const execute = async (args: { days?: number }, _ctx: ToolContextLike): Promise<string> => {
    const days = args.days ?? 7
    try {
      const dbPath = findExistingDb(options?.dbPath)
      if (dbPath === undefined) {
        const expected = resolveCostDbPath(options)
        return (
          `pantheon_cost failed: opencode.db not found (expected at ${expected}). ` +
          `No cost history is available until opencode has stored session data.`
        )
      }
      const rows = await queryWithNodeSqlite(dbPath, days).catch(async (err: unknown) => {
        if (err instanceof Error && err.message.startsWith('incompatible opencode.db schema'))
          throw err
        return queryWithScript(scriptPath, dbPath, days)
      })
      return renderMarkdown(rows, days)
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      return `pantheon_cost failed: ${reason}`
    }
  }

  return {
    pantheon_cost: {
      description:
        'Report cost + token usage by agent over the last N days, read from opencode.db (read-only, no writes).',
      args: costArgs,
      execute,
    },
  }
}
