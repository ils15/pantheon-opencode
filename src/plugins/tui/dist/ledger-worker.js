import { i as projectUsageHistoryResult, r as isUsageHistoryPeriod, s as projectCostSummaryResult } from "./usage-history-contract-CHXPIL9L.js";
import { i as resolveCostDbPath, n as queryCostSummary, r as queryUsageHistory } from "./cost-data-Dwuv_Azo.js";
import { parentPort, workerData } from "node:worker_threads";
//#region src/ledger-worker.ts
/**
* Classify a database failure without carrying its message: a sqlite error can
* embed the local path, the SQL, or private ledger data.
*/
function classifyLedgerError(error) {
	const message = error instanceof Error ? error.message : String(error);
	return [
		"not a database",
		"malformed",
		"corrupt",
		"incompatible opencode.db schema"
	].some((indicator) => message.includes(indicator)) ? "ledger_corrupt" : "ledger_unavailable";
}
const port = parentPort;
if (port) (async () => {
	try {
		const input = workerData;
		if (!isUsageHistoryPeriod(input.period)) {
			port.postMessage({
				ok: false,
				reason: "invalid_period"
			});
			return;
		}
		const dbPath = resolveCostDbPath();
		if (input.task === "cost_summary") {
			const result = await queryCostSummary(dbPath, input.period);
			port.postMessage({
				ok: true,
				result: projectCostSummaryResult(result)
			});
			return;
		}
		const result = await queryUsageHistory(dbPath, input.period);
		port.postMessage({
			ok: true,
			result: projectUsageHistoryResult(result)
		});
	} catch (error) {
		port.postMessage({
			ok: false,
			reason: classifyLedgerError(error)
		});
	}
})();
//#endregion
export {};

//# sourceMappingURL=ledger-worker.js.map
