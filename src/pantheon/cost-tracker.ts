/**
 * Cost Tracker (Wave 4, PR #46) — JSONL cost ledger for background
 * delegations. Every delegation that finishes (or times out) records one
 * line; the ledger lives at `.pantheon/costs/delegations.jsonl` and gives
 * Nyx / the /cost command a durable, human-readable cost history.
 *
 * record() APPENDS (appendFile + parent dir auto-create), never rewrites.
 * A missing ledger is an EMPTY ledger — list() → [], summary() → zeros,
 * no crash. Injectable clock not needed: timestamp is caller-provided
 * (ISO 8601), matching the delegation toolset's timestamping style.
 *
 * @module cost-tracker
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** One delegation cost event. */
export interface CostRecord {
  /** Board task ID (e.g. "ses_child_1" or the job alias "apo-1"). */
  taskId: string
  /** Session that owns the delegation — list(sessionID?) filters on this. */
  sessionID?: string
  /** Delegated agent name (e.g. "hermes"). */
  agent: string
  /** Model ID actually used (e.g. "opencode/deepseek-v4-flash"). */
  model: string
  tokensInput: number
  tokensOutput: number
  /** Cost in USD (already computed by the caller). */
  costUsd: number
  /** ISO 8601 timestamp of the record. */
  timestamp: string
}

/** Aggregate across the whole ledger. */
export interface CostSummary {
  count: number
  totalCostUsd: number
  totalTokensInput: number
  totalTokensOutput: number
}

export interface CostTrackerOptions {
  /** Ledger path. Default: ".pantheon/costs/delegations.jsonl". */
  filePath?: string
}

export interface CostTracker {
  /** Append one record to the ledger (creates the parent dir on first write). */
  record(entry: CostRecord): Promise<void>
  /** All records, optionally filtered by sessionID. Missing file → []. */
  list(sessionID?: string): Promise<CostRecord[]>
  /** Aggregate totals across the whole ledger. Missing file → zeros. */
  summary(): Promise<CostSummary>
}

/** Parse the ledger file; missing file → empty array (never throws). */
async function readLedger(filePath: string): Promise<CostRecord[]> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return []
  }
  const records: CostRecord[] = []
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    try {
      records.push(JSON.parse(line) as CostRecord)
    } catch {
      // Skip malformed lines — a partial ledger never breaks the reader.
    }
  }
  return records
}

export function createCostTracker(options?: CostTrackerOptions): CostTracker {
  const filePath = options?.filePath ?? '.pantheon/costs/delegations.jsonl'

  return {
    async record(entry: CostRecord): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true })
      await appendFile(filePath, `${JSON.stringify(entry)}\n`, 'utf8')
    },

    async list(sessionID?: string): Promise<CostRecord[]> {
      const records = await readLedger(filePath)
      if (sessionID === undefined) return records
      return records.filter((r) => r.sessionID === sessionID)
    },

    async summary(): Promise<CostSummary> {
      const records = await readLedger(filePath)
      const summary: CostSummary = {
        count: records.length,
        totalCostUsd: 0,
        totalTokensInput: 0,
        totalTokensOutput: 0,
      }
      for (const r of records) {
        summary.totalCostUsd += r.costUsd
        summary.totalTokensInput += r.tokensInput
        summary.totalTokensOutput += r.tokensOutput
      }
      return summary
    },
  }
}
