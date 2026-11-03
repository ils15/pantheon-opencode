//#region src/cost-summary-contract.ts
/** Per-agent rows shown by the panel before the tail is summarised. */
const MAX_COST_AGENTS = 32;
const MAX_SAFE_INTEGER$1 = Number.MAX_SAFE_INTEGER;
const SAFE_LABEL$1 = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ISO_DATE$1 = /^\d{4}-\d{2}-\d{2}$/;
function isCostSummaryUnavailableReason(value) {
	return value === "invalid_period" || value === "ledger_unavailable" || value === "ledger_unsupported" || value === "ledger_corrupt" || value === "ledger_timeout";
}
function safeCount$1(value, markTruncated) {
	if (!Number.isFinite(value) || value < 0) {
		markTruncated();
		return 0;
	}
	if (!Number.isSafeInteger(value)) {
		markTruncated();
		return Math.min(Math.floor(value), MAX_SAFE_INTEGER$1);
	}
	return value;
}
function safeEstimate$1(value, markTruncated) {
	if (value === void 0) return void 0;
	if (!Number.isFinite(value) || value < 0) {
		markTruncated();
		return;
	}
	const rounded = Math.round(value * 1e8) / 1e8;
	if (!Number.isFinite(rounded)) {
		markTruncated();
		return;
	}
	return rounded;
}
/** Agent labels the ledger cannot vouch for read as `unknown`, never verbatim. */
function safeAgentLabel(value, markTruncated) {
	if (!SAFE_LABEL$1.test(value)) {
		markTruncated();
		return "unknown";
	}
	return value;
}
function projectTotals$1(value, markTruncated) {
	return {
		input: safeCount$1(value.input, markTruncated),
		output: safeCount$1(value.output, markTruncated),
		cacheRead: safeCount$1(value.cacheRead, markTruncated),
		cacheWrite: safeCount$1(value.cacheWrite, markTruncated),
		total: safeCount$1(value.total, markTruncated)
	};
}
/**
* Project the ledger read into the bounded, non-identifying panel contract.
*
* A ledger that was found but yields no attributable tokens is a diagnosis, not
* an empty report: rows scanned with no assistant match, or assistant rows
* whose aggregates carry no token at all, map to `ledger_unsupported` — the
* UNSUPPORTED analogue of the cost tool. Cache-only usage counts as usage, so
* the diagnosis fires only when every token column is zero.
*/
function projectCostSummaryResult(result) {
	const markUnsupported = () => ({
		status: "unavailable",
		reason: "ledger_unsupported"
	});
	if (result.scanned > 0) {
		if (result.assistantRows === 0) return markUnsupported();
		const totals = result.totals;
		if (totals.input === 0 && totals.output === 0 && totals.cacheRead === 0 && totals.cacheWrite === 0) return markUnsupported();
	}
	let unsafeOrTruncated = false;
	const markTruncated = () => {
		unsafeOrTruncated = true;
	};
	const sortedAgents = [...result.agents].sort((left, right) => right.tokensTotal - left.tokensTotal);
	if (sortedAgents.length > 32) markTruncated();
	const agents = sortedAgents.slice(0, 32).map((agent) => {
		const estimatedUsd = safeEstimate$1(agent.estimatedUsd, markTruncated);
		return {
			agent: safeAgentLabel(agent.agent, markTruncated),
			input: safeCount$1(agent.tokensInput, markTruncated),
			output: safeCount$1(agent.tokensOutput, markTruncated),
			cacheRead: safeCount$1(agent.tokensCacheRead, markTruncated),
			cacheWrite: safeCount$1(agent.tokensCacheWrite, markTruncated),
			total: safeCount$1(agent.tokensTotal, markTruncated),
			...estimatedUsd === void 0 ? {} : { estimatedUsd },
			pricingComplete: agent.pricingComplete === true
		};
	});
	let coverageStart = result.coverageStart;
	if (coverageStart !== null && !ISO_DATE$1.test(coverageStart)) {
		markTruncated();
		coverageStart = null;
	}
	const pricingEstimate = safeEstimate$1(result.pricing.estimatedUsd, markTruncated);
	const rows = safeCount$1(result.rows, markTruncated);
	const totals = projectTotals$1(result.totals, markTruncated);
	const unpricedModels = safeCount$1(result.pricing.unpricedModels, markTruncated);
	const truncated = unsafeOrTruncated;
	const empty = rows === 0;
	const pricingComplete = result.pricing.status === "complete";
	return {
		status: result.partial || truncated || !empty && !pricingComplete ? "partial" : "available",
		period: result.period,
		coverageStart,
		partial: result.partial === true,
		truncated,
		rows,
		totals,
		agents,
		pricing: {
			status: result.pricing.status,
			complete: pricingComplete,
			billed: false,
			...pricingEstimate === void 0 ? {} : { estimatedUsd: pricingEstimate },
			unpricedModels
		}
	};
}
const MAX_HISTORY_QUERY_MS = 5e3;
const USAGE_HISTORY_PERIODS = [
	"7d",
	"15d",
	"30d",
	"total"
];
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function safeCount(value, markTruncated) {
	if (!Number.isFinite(value) || value < 0) {
		markTruncated();
		return 0;
	}
	if (!Number.isSafeInteger(value)) {
		markTruncated();
		return Math.min(Math.floor(value), MAX_SAFE_INTEGER);
	}
	return value;
}
function safeEstimate(value, markTruncated) {
	if (value === void 0) return void 0;
	if (!Number.isFinite(value) || value < 0) {
		markTruncated();
		return;
	}
	const rounded = Math.round(value * 1e8) / 1e8;
	if (!Number.isFinite(rounded)) {
		markTruncated();
		return;
	}
	return rounded;
}
function safeLabel(value, markTruncated) {
	if (!SAFE_LABEL.test(value)) {
		markTruncated();
		return "unknown";
	}
	return value;
}
function projectTotals(value, markTruncated) {
	return {
		input: safeCount(value.input, markTruncated),
		output: safeCount(value.output, markTruncated),
		cacheRead: safeCount(value.cacheRead, markTruncated),
		cacheWrite: safeCount(value.cacheWrite, markTruncated),
		total: safeCount(value.total, markTruncated)
	};
}
/** Project cost-command output to a bounded, non-identifying TUI contract. */
function projectUsageHistoryResult(result) {
	let unsafeOrTruncated = false;
	const markTruncated = () => {
		unsafeOrTruncated = true;
	};
	const sourceBuckets = result.buckets;
	const sourceModels = result.models;
	if (sourceBuckets.length > 366 || sourceModels.length > 64) markTruncated();
	const buckets = sourceBuckets.slice(-366).flatMap((bucket) => {
		if (!ISO_DATE.test(bucket.date)) {
			markTruncated();
			return [];
		}
		const estimatedUsd = safeEstimate(bucket.estimatedUsd, markTruncated);
		return [{
			date: bucket.date,
			...projectTotals(bucket, markTruncated),
			...estimatedUsd === void 0 ? {} : { estimatedUsd },
			pricingComplete: bucket.pricingComplete === true
		}];
	});
	const models = sourceModels.slice(0, 64).map((model) => {
		const estimatedUsd = safeEstimate(model.estimatedUsd, markTruncated);
		return {
			providerID: safeLabel(model.providerID, markTruncated),
			modelID: safeLabel(model.modelID, markTruncated),
			totals: projectTotals(model.totals, markTruncated),
			...estimatedUsd === void 0 ? {} : { estimatedUsd },
			pricingComplete: model.pricingComplete === true
		};
	});
	let coverageStart = result.coverageStart;
	if (coverageStart !== null && !ISO_DATE.test(coverageStart)) {
		markTruncated();
		coverageStart = null;
	}
	const pricingEstimate = safeEstimate(result.pricing.estimatedUsd, markTruncated);
	const rows = safeCount(result.rows, markTruncated);
	const totals = projectTotals(result.totals, markTruncated);
	const unpricedModels = safeCount(result.pricing.unpricedModels, markTruncated);
	const truncated = unsafeOrTruncated;
	return {
		status: result.partial || truncated ? "partial" : "available",
		period: result.period,
		coverageStart,
		partial: result.partial,
		truncated,
		rows,
		buckets,
		totals,
		models,
		pricing: {
			status: result.pricing.status,
			complete: result.pricing.complete === true,
			billed: false,
			...pricingEstimate === void 0 ? {} : { estimatedUsd: pricingEstimate },
			unpricedModels
		}
	};
}
function isUsageHistoryPeriod(value) {
	return typeof value === "string" && USAGE_HISTORY_PERIODS.includes(value);
}
//#endregion
export { MAX_COST_AGENTS as a, projectUsageHistoryResult as i, USAGE_HISTORY_PERIODS as n, isCostSummaryUnavailableReason as o, isUsageHistoryPeriod as r, projectCostSummaryResult as s, MAX_HISTORY_QUERY_MS as t };

//# sourceMappingURL=usage-history-contract-CHXPIL9L.js.map
