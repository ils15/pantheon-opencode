import { i as projectUsageHistoryResult, r as isUsageHistoryPeriod } from "./usage-history-contract-nt1rnBPE.js";
import { n as queryUsageHistory, r as resolveCostDbPath } from "./cost-data-CCZUs1aJ.js";
import { parentPort, workerData } from "node:worker_threads";
//#region src/usage-history-worker.ts
const port = parentPort;
if (port) (async () => {
	try {
		const input = workerData;
		if (!isUsageHistoryPeriod(input.period)) {
			port.postMessage({ ok: false });
			return;
		}
		const result = await queryUsageHistory(resolveCostDbPath(), input.period);
		port.postMessage({
			ok: true,
			result: projectUsageHistoryResult(result)
		});
	} catch {
		port.postMessage({ ok: false });
	}
})();
//#endregion
export {};

//# sourceMappingURL=usage-history-worker.js.map
