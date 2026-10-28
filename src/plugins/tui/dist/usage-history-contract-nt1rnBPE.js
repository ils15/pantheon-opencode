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
export { projectUsageHistoryResult as i, USAGE_HISTORY_PERIODS as n, isUsageHistoryPeriod as r, MAX_HISTORY_QUERY_MS as t };

//# sourceMappingURL=usage-history-contract-nt1rnBPE.js.map
