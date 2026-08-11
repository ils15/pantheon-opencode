/**
 * Cost Command (Wave 4, PR #46) — `pantheon_cost` structural tool: cost +
 * token visibility for delegation traffic, straight from opencode.db.
 *
 * Reads the opencode session database READ-ONLY (sum cost + tokens by
 * agent over the last N days → markdown table). Zero new dependencies:
 *   - primary path: node:sqlite (DatabaseSync, readOnly) — node ≥ 22.5;
 *   - fallback: spawn scripts/cost.mjs (node:sqlite, prints JSON) when the
 *     direct import is unavailable;
 *   - missing/unreadable db → FRIENDLY error string, never a crash (tools
 *     return errors as TEXT).
 *
 * dbPath resolution: explicit option > env PANTHEON_COST_DB > XDG data
 * home > ~/.local/share/opencode/opencode.db. The tool is wired in
 * plugin.ts alongside the delegation toolset (usable by zeus and any agent
 * with tool access — no routing change needed).
 *
 * @module cost-command
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

import type { ToolContextLike } from './delegation.ts'

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

/** Resolve candidate db paths in priority order (env override first). */
function dbCandidates(): string[] {
  const candidates: string[] = []
  const env = process.env.PANTHEON_COST_DB
  if (env !== undefined && env !== '') candidates.push(env)
  const xdg = process.env.XDG_DATA_HOME
  const dataHome = xdg !== undefined && xdg !== '' ? xdg : join(homedir(), '.local', 'share')
  candidates.push(join(dataHome, 'opencode', 'opencode.db'))
  return candidates
}

/**
 * First existing db path, or undefined. An EXPLICIT override shadows the
 * candidate list entirely (testability: a fake path must not fall through
 * to the real opencode.db).
 */
function findExistingDb(override?: string): string | undefined {
  const candidates = override !== undefined && override !== '' ? [override] : dbCandidates()
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** Aggregate cost + tokens by agent via node:sqlite (read-only). */
async function queryWithNodeSqlite(dbPath: string, days: number): Promise<CostRow[]> {
  const sqlite = await import('node:sqlite')
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true })
  try {
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
        const expected =
          options?.dbPath ?? process.env.PANTHEON_COST_DB ?? '~/.local/share/opencode/opencode.db'
        return (
          `pantheon_cost failed: opencode.db not found (expected at ${expected}). ` +
          `No cost history is available until opencode has stored session data.`
        )
      }
      const rows = await queryWithNodeSqlite(dbPath, days).catch(async () =>
        queryWithScript(scriptPath, dbPath, days),
      )
      return renderMarkdown(rows, days)
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      return `pantheon_cost failed: ${reason}`
    }
  }

  return {
    pantheon_cost: {
      description:
        'Report delegation cost + token usage by agent over the last N days, read from opencode.db (read-only, no writes).',
      args: costArgs,
      execute,
    },
  }
}
