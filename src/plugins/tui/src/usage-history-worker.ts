import { parentPort, workerData } from 'node:worker_threads'
import { queryUsageHistory, resolveCostDbPath } from './cost-data'
import { isUsageHistoryPeriod, projectUsageHistoryResult } from './usage-history-contract'

interface UsageHistoryWorkerInput {
  period?: unknown
}

const port = parentPort
if (port) {
  void (async () => {
    try {
      const input = workerData as UsageHistoryWorkerInput
      if (!isUsageHistoryPeriod(input.period)) {
        port.postMessage({ ok: false })
        return
      }
      const result = await queryUsageHistory(resolveCostDbPath(), input.period)
      port.postMessage({ ok: true, result: projectUsageHistoryResult(result) })
    } catch {
      // Database errors may contain the local path, SQL, or private ledger data.
      port.postMessage({ ok: false })
    }
  })()
}
