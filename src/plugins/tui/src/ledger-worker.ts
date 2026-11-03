import { parentPort, workerData } from 'node:worker_threads'
import { queryCostSummary, queryUsageHistory, resolveCostDbPath } from './cost-data'
import { projectCostSummaryResult } from './cost-summary-contract'
import { isUsageHistoryPeriod, projectUsageHistoryResult } from './usage-history-contract'

/**
 * One worker serving both read-only ledger queries (usage history charts and
 * the cost summary) so a heavy opencode.db never blocks the plugin server and
 * never outlives the shared query budget.
 */
export type LedgerWorkerTask = 'usage_history' | 'cost_summary'

interface LedgerWorkerInput {
  task?: LedgerWorkerTask
  period?: unknown
}

/** Closed, content-free failure kinds; error details never cross the worker. */
type LedgerFailureKind = 'ledger_corrupt' | 'ledger_unavailable'

/**
 * Classify a database failure without carrying its message: a sqlite error can
 * embed the local path, the SQL, or private ledger data.
 */
function classifyLedgerError(error: unknown): LedgerFailureKind {
  const message = error instanceof Error ? error.message : String(error)
  const corrupt = [
    'not a database',
    'malformed',
    'corrupt',
    'incompatible opencode.db schema',
  ].some((indicator) => message.includes(indicator))
  return corrupt ? 'ledger_corrupt' : 'ledger_unavailable'
}

const port = parentPort
if (port) {
  void (async () => {
    try {
      const input = workerData as LedgerWorkerInput
      if (!isUsageHistoryPeriod(input.period)) {
        port.postMessage({ ok: false, reason: 'invalid_period' })
        return
      }
      const dbPath = resolveCostDbPath()
      if (input.task === 'cost_summary') {
        const result = await queryCostSummary(dbPath, input.period)
        port.postMessage({ ok: true, result: projectCostSummaryResult(result) })
        return
      }
      const result = await queryUsageHistory(dbPath, input.period)
      port.postMessage({ ok: true, result: projectUsageHistoryResult(result) })
    } catch (error) {
      // Database errors may contain the local path, SQL, or private ledger data.
      port.postMessage({ ok: false, reason: classifyLedgerError(error) })
    }
  })()
}
