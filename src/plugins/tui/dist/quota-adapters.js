import "./quota-rpc-BeoJ-2uD.js";
import { queryAlibabaTokenPlanUsage } from "./quota-cli.js";
import { randomUUID } from "node:crypto";
//#region src/quota-adapters.ts
const OPENAI_CODEX_OAUTH_METHOD_IDS = ["chatgpt-browser", "chatgpt-headless"];
function isOpenAICodexOAuthMethod(value) {
	return typeof value === "string" && OPENAI_CODEX_OAUTH_METHOD_IDS.includes(value);
}
const OPENCODE_CONSOLE_OAUTH_METHOD_IDS = ["device"];
function isOpenCodeConsoleOAuthMethod(value) {
	return typeof value === "string" && OPENCODE_CONSOLE_OAUTH_METHOD_IDS.includes(value);
}
const usBoth = ["us_personal", "us_business"];
const chinaPersonal = ["china_personal"];
const chinaBoth = ["china_personal", "china_business"];
const blocked = (provider, blockedReason) => ({
	...provider,
	blockedReason
});
/**
* Closed provider/integration/method allowlist. Only rows with a reviewed
* adapter may make a network request; remaining rows are explicitly blocked.
* Audience lists describe the approved matrix and do not claim that account
* type was inferred from credentials.
*/
const QUOTA_PROVIDER_CATALOG = {
	anthropic: {
		label: "Anthropic / Claude",
		integrationID: "anthropic",
		audiences: usBoth,
		scope: "account",
		methods: ["oauth"],
		adapter: "anthropic"
	},
	chutes: {
		label: "Chutes AI",
		integrationID: "chutes",
		audiences: usBoth,
		scope: "account",
		methods: ["key"],
		adapter: "chutes"
	},
	cursor: blocked({
		label: "Cursor",
		integrationID: "cursor",
		audiences: usBoth,
		scope: "account",
		methods: ["oauth", "key"]
	}, "runtime_accounting_unavailable"),
	"github-copilot": {
		label: "GitHub Copilot",
		integrationID: "github-copilot",
		audiences: ["us_personal"],
		scope: "account",
		methods: ["oauth"],
		adapter: "copilot"
	},
	"google-agy": {
		label: "Google AGY",
		integrationID: "google-agy",
		audiences: usBoth,
		scope: "account",
		methods: ["oauth"],
		adapter: "google-agy"
	},
	"kilo-gateway": {
		label: "Kilo Gateway",
		integrationID: "kilo-gateway",
		audiences: ["us_personal"],
		scope: "account",
		methods: ["key"],
		adapter: "kilo-gateway"
	},
	nanogpt: {
		label: "NanoGPT",
		integrationID: "nanogpt",
		audiences: usBoth,
		scope: "account",
		methods: ["key"],
		adapter: "nanogpt"
	},
	"ollama-cloud": {
		label: "Ollama Cloud",
		integrationID: "ollama-cloud",
		audiences: ["us_personal"],
		scope: "account",
		methods: ["key"],
		adapter: "ollama-cloud"
	},
	openai: {
		label: "OpenAI / Codex",
		integrationID: "openai",
		audiences: usBoth,
		scope: "account",
		methods: ["oauth"],
		adapter: "openai"
	},
	"opencode-go": {
		label: "OpenCode Go",
		integrationID: "opencode-go",
		fallbackIntegrationIDs: ["opencode"],
		audiences: ["us_personal"],
		scope: "account",
		methods: ["key", "oauth"],
		adapter: "opencode-go"
	},
	"opencode-zen": {
		label: "OpenCode Zen",
		integrationID: "opencode",
		audiences: usBoth,
		scope: "account",
		methods: ["oauth"],
		adapter: "opencode-zen"
	},
	openrouter: {
		label: "OpenRouter",
		integrationID: "openrouter",
		audiences: usBoth,
		scope: "selected_key",
		methods: ["key"],
		adapter: "openrouter"
	},
	synthetic: {
		label: "Synthetic",
		integrationID: "synthetic",
		audiences: usBoth,
		scope: "account",
		methods: ["key"],
		adapter: "synthetic"
	},
	"xai-supergrok": {
		label: "xAI SuperGrok",
		integrationID: "xai",
		audiences: usBoth,
		scope: "account",
		methods: ["oauth"],
		adapter: "xai-supergrok"
	},
	"gemini-cli": blocked({
		label: "Gemini CLI / Code Assist",
		integrationID: "google-gemini-cli",
		audiences: ["us_business"],
		scope: "team",
		methods: ["oauth"]
	}, "eligibility_unverified"),
	"alibaba-coding-plan": blocked({
		label: "Alibaba Coding Plan",
		integrationID: "alibaba-coding-plan",
		audiences: chinaPersonal,
		scope: "account",
		methods: ["key"]
	}, "runtime_accounting_unavailable"),
	"alibaba-token-plan": {
		label: "Alibaba Token Plan",
		integrationID: "alibaba-token-plan",
		audiences: chinaPersonal,
		scope: "account",
		methods: ["cli"],
		source: "local-cli",
		adapter: "alibaba-token-plan-cli"
	},
	deepseek: {
		label: "DeepSeek",
		integrationID: "deepseek",
		audiences: chinaPersonal,
		scope: "account",
		methods: ["key"],
		adapter: "deepseek"
	},
	"kimi-code-global": {
		label: "Kimi Code (Global)",
		integrationID: "kimi-code-global",
		audiences: chinaBoth,
		scope: "account",
		methods: ["key"],
		adapter: "kimi-global"
	},
	"kimi-code-cn": {
		label: "Kimi Code (China)",
		integrationID: "kimi-code-cn",
		audiences: chinaBoth,
		scope: "account",
		methods: ["key"],
		adapter: "kimi-cn"
	},
	"minimax-plan-global": {
		label: "MiniMax Token Plan (Global)",
		integrationID: "minimax-coding-plan",
		audiences: chinaBoth,
		scope: "account",
		methods: ["key"],
		adapter: "minimax-global"
	},
	"minimax-plan-cn": {
		label: "MiniMax Token Plan (China)",
		integrationID: "minimax-china-coding-plan",
		audiences: chinaBoth,
		scope: "account",
		methods: ["key"],
		adapter: "minimax-cn"
	},
	"xiaomi-mimo": blocked({
		label: "Xiaomi MiMo",
		integrationID: "xiaomi-mimo",
		audiences: chinaPersonal,
		scope: "account",
		methods: ["key"]
	}, "unsupported"),
	"zai-coding-plan": {
		label: "Z.ai Coding Plan",
		integrationID: "zai-coding-plan",
		audiences: chinaPersonal,
		scope: "account",
		methods: ["key"],
		adapter: "zai"
	},
	"zhipu-coding-plan": {
		label: "Zhipu Coding Plan",
		integrationID: "zhipu-coding-plan",
		audiences: chinaBoth,
		scope: "account",
		methods: ["key"],
		adapter: "zhipu"
	}
};
const MAX_RESPONSE_BYTES = 65536;
const REQUEST_TIMEOUT_MS = 5e3;
const MAX_AMOUNT = 0xe8d4a51000;
var SafeAdapterError = class extends Error {
	reason;
	retryAfterMs;
	constructor(reason, retryAfterMs) {
		super(reason);
		this.reason = reason;
		this.retryAfterMs = retryAfterMs;
	}
};
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function available(metrics) {
	if (metrics.length === 0 || metrics.length > 16) throw new SafeAdapterError("provider_error");
	return {
		state: "available",
		metrics
	};
}
function finiteAmount(value) {
	const amount = typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value;
	return typeof amount === "number" && Number.isFinite(amount) && amount >= 0 && amount <= MAX_AMOUNT ? amount : void 0;
}
function retryAfterMs(value, now = Date.now()) {
	if (!value) return void 0;
	const seconds = Number(value);
	const retryAt = Number.isFinite(seconds) && seconds >= 0 ? now + seconds * 1e3 : Date.parse(value);
	if (!Number.isFinite(retryAt)) return void 0;
	return Math.ceil(Math.min(36e5, Math.max(0, retryAt - now)));
}
async function readJson(response) {
	const announced = Number(response.headers.get("content-length"));
	if (Number.isFinite(announced) && announced > MAX_RESPONSE_BYTES) {
		await response.body?.cancel();
		throw new SafeAdapterError("invalid_response");
	}
	if (!response.body) throw new SafeAdapterError("invalid_response");
	const reader = response.body.getReader();
	const chunks = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > MAX_RESPONSE_BYTES) {
				await reader.cancel();
				throw new SafeAdapterError("invalid_response");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new SafeAdapterError("invalid_response");
	}
}
function transportFailure(error, timeoutSignal, shutdownSignal) {
	if (error instanceof SafeAdapterError) return error;
	if (shutdownSignal.aborted) return new SafeAdapterError("provider_error");
	const errorName = typeof error === "object" && error !== null && "name" in error ? error.name : void 0;
	return new SafeAdapterError(timeoutSignal.aborted || errorName === "TimeoutError" ? "timeout" : "network_error");
}
async function requestJson(url, secret, shutdownSignal, authStyle = "bearer", options = {}) {
	const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	const signal = AbortSignal.any([shutdownSignal, timeoutSignal]);
	let response;
	try {
		response = await fetch(url, {
			method: options.method ?? "GET",
			headers: {
				accept: "application/json",
				authorization: authStyle === "bearer" ? `Bearer ${secret}` : secret,
				...options.headers
			},
			...options.body === void 0 ? {} : { body: options.body },
			redirect: "error",
			signal
		});
	} catch (error) {
		throw transportFailure(error, timeoutSignal, shutdownSignal);
	}
	if (response.status === 401) {
		await response.body?.cancel();
		throw new SafeAdapterError("unauthorized");
	}
	if (response.status === 403) {
		await response.body?.cancel();
		throw new SafeAdapterError("forbidden");
	}
	if (response.status === 429) {
		await response.body?.cancel();
		throw new SafeAdapterError("rate_limited", retryAfterMs(response.headers.get("retry-after")) ?? 3e4);
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw new SafeAdapterError("provider_error");
	}
	try {
		return await readJson(response);
	} catch (error) {
		throw transportFailure(error, timeoutSignal, shutdownSignal);
	}
}
function deepseekMetrics(payload) {
	if (!isRecord(payload) || typeof payload.is_available !== "boolean" || !Array.isArray(payload.balance_infos)) throw new SafeAdapterError("provider_error");
	if (payload.balance_infos.length > 8) throw new SafeAdapterError("provider_error");
	const metrics = [{
		kind: "provider_status",
		status: payload.is_available ? "available" : "unavailable",
		label: "Service status"
	}];
	for (const value of payload.balance_infos) {
		if (!isRecord(value) || value.currency !== "USD" && value.currency !== "CNY") throw new SafeAdapterError("provider_error");
		const amount = finiteAmount(value.total_balance);
		if (amount === void 0) throw new SafeAdapterError("provider_error");
		metrics.push({
			kind: "balance",
			amount,
			currency: value.currency,
			label: "Total balance"
		});
	}
	return metrics;
}
function ollamaMetrics(payload) {
	if (!isRecord(payload) || !isRecord(payload.included) || !isRecord(payload.purchased)) throw new SafeAdapterError("provider_error");
	const metrics = [];
	const included = finiteAmount(payload.included.balance_usd);
	const purchased = finiteAmount(payload.purchased.balance_usd);
	if (included !== void 0) metrics.push({
		kind: "balance",
		amount: included,
		currency: "USD",
		label: "Included balance"
	});
	if (purchased !== void 0) metrics.push({
		kind: "balance",
		amount: purchased,
		currency: "USD",
		label: "Purchased balance"
	});
	for (const window of ["session", "weekly"]) {
		const item = payload.included[window];
		if (!isRecord(item)) continue;
		const remainingPercent = finiteAmount(item.remaining_percent);
		if (remainingPercent === void 0 || remainingPercent > 100) throw new SafeAdapterError("provider_error");
		metrics.push({
			kind: "provider_quota",
			used: 100 - remainingPercent,
			remaining: remainingPercent,
			unit: "%",
			label: window === "session" ? "Session quota" : "Weekly quota",
			period: window
		});
	}
	if (metrics.length === 0) throw new SafeAdapterError("provider_error");
	return metrics;
}
function openRouterMetrics(payload) {
	if (!isRecord(payload) || !isRecord(payload.data)) throw new SafeAdapterError("provider_error");
	const data = payload.data;
	const usage = finiteAmount(data.usage);
	if (usage === void 0) throw new SafeAdapterError("provider_error");
	const limit = data.limit === null || data.limit === void 0 ? void 0 : finiteAmount(data.limit);
	const remaining = data.limit_remaining === null || data.limit_remaining === void 0 ? void 0 : finiteAmount(data.limit_remaining);
	if (data.limit !== null && data.limit !== void 0 && limit === void 0) throw new SafeAdapterError("provider_error");
	if (data.limit_remaining !== null && data.limit_remaining !== void 0 && remaining === void 0) throw new SafeAdapterError("provider_error");
	if (limit !== void 0 && remaining !== void 0) {
		if (remaining > limit || usage > limit + .01) throw new SafeAdapterError("provider_error");
		return [{
			kind: "provider_quota",
			used: usage,
			remaining,
			unit: "USD",
			label: "Selected key budget"
		}];
	}
	return [{
		kind: "key_usage",
		amount: usage,
		currency: "USD",
		label: "Selected key spend",
		period: "reported"
	}];
}
function chutesMetrics(payload) {
	if (!isRecord(payload)) throw new SafeAdapterError("provider_error");
	const quota = finiteAmount(payload.quota);
	const used = finiteAmount(payload.used);
	if (quota === void 0 || used === void 0) throw new SafeAdapterError("provider_error");
	return [{
		kind: "provider_quota",
		used,
		remaining: Math.max(0, quota - used),
		unit: "units",
		label: "Daily quota"
	}];
}
function kimiMetrics(payload) {
	if (!isRecord(payload)) throw new SafeAdapterError("provider_error");
	const data = isRecord(payload.data) ? payload.data : payload;
	const rows = [];
	if (isRecord(data.usage)) rows.push(data.usage);
	if (Array.isArray(data.limits)) {
		if (data.limits.length > 12) throw new SafeAdapterError("provider_error");
		for (const item of data.limits) {
			if (!isRecord(item)) continue;
			rows.push(isRecord(item.detail) ? item.detail : item);
		}
	}
	const metrics = [];
	for (const row of rows) {
		const limit = finiteAmount(row.limit);
		let used = finiteAmount(row.used);
		const remaining = finiteAmount(row.remaining);
		if (used === void 0 && limit !== void 0 && remaining !== void 0 && remaining <= limit) used = limit - remaining;
		if (limit === void 0 || used === void 0 || limit <= 0) continue;
		metrics.push({
			kind: "provider_quota",
			used,
			remaining: Math.max(0, limit - used),
			unit: "units",
			label: "Provider-reported window"
		});
	}
	if (metrics.length === 0) throw new SafeAdapterError("provider_error");
	return metrics;
}
function minimaxMetrics(payload, endpoint) {
	if (!isRecord(payload) || !isRecord(payload.base_resp) || payload.base_resp.status_code !== 0 || !Array.isArray(payload.model_remains) || payload.model_remains.length > 64) throw new SafeAdapterError("provider_error");
	const candidates = payload.model_remains.filter((row) => isRecord(row) && typeof row.model_name === "string" && (/^minimax-m/i.test(row.model_name.trim()) || row.model_name.trim().toLowerCase() === "general"));
	candidates.sort((left, right) => {
		return (left.model_name === "minimax-m*" ? 0 : 1) - (right.model_name === "minimax-m*" ? 0 : 1);
	});
	const model = candidates[0];
	if (!model) throw new SafeAdapterError("provider_error");
	const specs = [{
		total: model.current_interval_total_count,
		count: model.current_interval_usage_count,
		percent: model.current_interval_remaining_percent,
		label: "5-hour token-plan quota"
	}, {
		total: model.current_weekly_total_count,
		count: model.current_weekly_usage_count,
		percent: model.current_weekly_remaining_percent,
		label: "Weekly token-plan quota"
	}];
	const metrics = [];
	for (const spec of specs) {
		const total = finiteAmount(spec.total);
		const count = finiteAmount(spec.count);
		const percent = finiteAmount(spec.percent);
		if (total !== void 0 && total > 0 && count !== void 0) {
			const used = endpoint === "cn" ? count : Math.max(0, total - Math.min(total, count));
			const remaining = endpoint === "cn" ? Math.max(0, total - count) : Math.min(total, count);
			metrics.push({
				kind: "provider_quota",
				used,
				remaining,
				unit: "requests",
				label: spec.label
			});
		} else if (percent !== void 0 && percent <= 100) metrics.push({
			kind: "provider_quota",
			used: 100 - percent,
			remaining: percent,
			unit: "%",
			label: spec.label
		});
	}
	if (metrics.length === 0) throw new SafeAdapterError("provider_error");
	return metrics;
}
function glmMetrics(payload, provider) {
	if (!isRecord(payload)) throw new SafeAdapterError("provider_error");
	const envelope = isRecord(payload.data) ? payload.data : provider === "zai" ? payload : void 0;
	if (!envelope || !Array.isArray(envelope.limits) || envelope.limits.length > 16) throw new SafeAdapterError("provider_error");
	const metrics = [];
	for (const limit of envelope.limits) {
		if (!isRecord(limit) || limit.type !== "TOKENS_LIMIT" && limit.type !== "CREDIT_LIMIT") continue;
		const percentage = finiteAmount(limit.percentage);
		if (percentage === void 0 || percentage > 100) continue;
		const label = limit.unit === 3 ? "5-hour coding-plan quota" : limit.unit === 6 ? "Weekly coding-plan quota" : "Coding-plan quota";
		metrics.push({
			kind: "provider_quota",
			used: percentage,
			remaining: 100 - percentage,
			unit: "%",
			label
		});
	}
	if (metrics.length === 0) throw new SafeAdapterError("provider_error");
	return metrics;
}
function kiloPassMetrics(payload) {
	const item = Array.isArray(payload) ? payload[0] : payload;
	if (!isRecord(item) || !isRecord(item.result) || !isRecord(item.result.data)) throw new SafeAdapterError("provider_error");
	const data = item.result.data;
	if ("json" in data && !isRecord(data.json)) throw new SafeAdapterError("provider_error");
	const root = isRecord(data.json) ? data.json : data;
	if (!("subscription" in root) || root.subscription === null) return null;
	if (!isRecord(root.subscription)) throw new SafeAdapterError("provider_error");
	const subscription = root.subscription;
	const base = finiteAmount(subscription.currentPeriodBaseCreditsUsd);
	const usage = finiteAmount(subscription.currentPeriodUsageUsd);
	const bonus = subscription.currentPeriodBonusCreditsUsd === void 0 || subscription.currentPeriodBonusCreditsUsd === null ? 0 : finiteAmount(subscription.currentPeriodBonusCreditsUsd);
	if (base === void 0 || usage === void 0 || bonus === void 0) throw new SafeAdapterError("provider_error");
	const total = base + bonus;
	if (total > MAX_AMOUNT) throw new SafeAdapterError("provider_error");
	return [{
		kind: "provider_quota",
		used: usage,
		remaining: Math.max(0, total - usage),
		unit: "USD",
		label: "Kilo Pass credits"
	}];
}
function kiloBalanceMetrics(payload) {
	if (!isRecord(payload)) throw new SafeAdapterError("provider_error");
	const balance = finiteAmount(payload.balance);
	if (balance === void 0) throw new SafeAdapterError("provider_error");
	return [{
		kind: "balance",
		amount: balance,
		currency: "USD",
		label: "Gateway balance"
	}];
}
async function nanoGptMetrics(secret, shutdownSignal) {
	const usagePayload = await requestJson("https://nano-gpt.com/api/subscription/v1/usage", secret, shutdownSignal);
	const balancePayload = await requestJson("https://nano-gpt.com/api/check-balance", secret, shutdownSignal);
	if (!isRecord(usagePayload) || !isRecord(balancePayload)) throw new SafeAdapterError("provider_error");
	const metrics = [];
	if (typeof usagePayload.active === "boolean") metrics.push({
		kind: "provider_status",
		status: usagePayload.active ? "active" : "inactive",
		label: "Subscription status"
	});
	const limits = isRecord(usagePayload.limits) ? usagePayload.limits : {};
	for (const window of ["daily", "monthly"]) {
		const details = isRecord(usagePayload[window]) ? usagePayload[window] : void 0;
		const limit = finiteAmount(limits[window]);
		if (!details || limit === void 0 || limit <= 0) continue;
		let used = finiteAmount(details.used);
		let remaining = finiteAmount(details.remaining);
		const percentUsed = finiteAmount(details.percentUsed);
		if (used === void 0 && remaining !== void 0 && remaining <= limit) used = limit - remaining;
		if (used === void 0 && percentUsed !== void 0 && percentUsed <= 1) used = limit * percentUsed;
		if (remaining === void 0 && used !== void 0 && used <= limit) remaining = limit - used;
		if (used === void 0 || remaining === void 0 || used > limit || remaining > limit) throw new SafeAdapterError("provider_error");
		metrics.push({
			kind: "provider_quota",
			used,
			remaining,
			unit: "units",
			label: window === "daily" ? "Daily subscription limit" : "Monthly subscription limit",
			period: window
		});
	}
	const usdBalance = finiteAmount(balancePayload.usd_balance);
	if (usdBalance !== void 0) metrics.push({
		kind: "balance",
		amount: usdBalance,
		currency: "USD",
		label: "Account balance"
	});
	if (metrics.length === 0) throw new SafeAdapterError("provider_error");
	return metrics;
}
function syntheticMetrics(payload) {
	if (!isRecord(payload) || !isRecord(payload.rollingFiveHourLimit) || !isRecord(payload.weeklyTokenLimit)) throw new SafeAdapterError("provider_error");
	const fiveHourLimit = finiteAmount(payload.rollingFiveHourLimit.max);
	const fiveHourRemaining = finiteAmount(payload.rollingFiveHourLimit.remaining);
	if (fiveHourLimit === void 0 || fiveHourLimit <= 0 || fiveHourRemaining === void 0 || fiveHourRemaining > fiveHourLimit) throw new SafeAdapterError("provider_error");
	const creditAmount = (value) => {
		if (typeof value !== "string") return void 0;
		const match = /^\$(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
		if (!match) return void 0;
		return finiteAmount(`${match[1]}.${(match[2] ?? "").padEnd(2, "0")}`);
	};
	const weeklyLimit = creditAmount(payload.weeklyTokenLimit.maxCredits);
	const weeklyRemaining = creditAmount(payload.weeklyTokenLimit.remainingCredits);
	if (weeklyLimit === void 0 || weeklyLimit <= 0 || weeklyRemaining === void 0 || weeklyRemaining > weeklyLimit) throw new SafeAdapterError("provider_error");
	return [{
		kind: "provider_quota",
		used: fiveHourLimit - fiveHourRemaining,
		remaining: fiveHourRemaining,
		unit: "units",
		label: "Rolling five-hour limit"
	}, {
		kind: "provider_quota",
		used: weeklyLimit - weeklyRemaining,
		remaining: weeklyRemaining,
		unit: "USD",
		label: "Weekly credit limit"
	}];
}
function percentage(value) {
	const parsed = finiteAmount(value);
	return parsed !== void 0 && parsed <= 100 ? parsed : void 0;
}
function anthropicMetrics(payload) {
	if (!isRecord(payload)) throw new SafeAdapterError("provider_error");
	const metrics = [];
	for (const window of [{
		key: "five_hour",
		label: "5-hour quota",
		period: "5h"
	}, {
		key: "seven_day",
		label: "Weekly quota",
		period: "week"
	}]) {
		const value = payload[window.key];
		if (value === void 0 || value === null) continue;
		if (!isRecord(value)) throw new SafeAdapterError("provider_error");
		const used = percentage(value.utilization ?? value.used_percentage ?? value.usedPercentage ?? value.used_percent ?? value.usedPercent ?? value.percent_used ?? value.percentUsed);
		if (used === void 0) throw new SafeAdapterError("provider_error");
		metrics.push({
			kind: "provider_quota",
			used,
			remaining: 100 - used,
			unit: "%",
			label: window.label,
			period: window.period
		});
	}
	const extra = payload.extra_usage;
	if (isRecord(extra) && extra.is_enabled === true) {
		const used = percentage(extra.utilization);
		if (used === void 0) throw new SafeAdapterError("provider_error");
		metrics.push({
			kind: "provider_quota",
			used,
			remaining: 100 - used,
			unit: "%",
			label: "Extra usage limit",
			period: "reported"
		});
	}
	return metrics;
}
function copilotMetrics(payload) {
	if (!isRecord(payload)) throw new SafeAdapterError("provider_error");
	const snapshots = isRecord(payload.quota_snapshots) ? payload.quota_snapshots : void 0;
	const quota = snapshots && isRecord(snapshots.premium_interactions) ? snapshots.premium_interactions : void 0;
	if (!quota) throw new SafeAdapterError("provider_error");
	if (quota.unlimited === true) return [{
		kind: "provider_status",
		status: "active",
		label: "Unlimited Copilot plan"
	}];
	const total = finiteAmount(quota.entitlement);
	const remaining = finiteAmount(quota.quota_remaining ?? quota.remaining);
	if (total !== void 0 && total > 0 && remaining !== void 0 && remaining <= total) return [{
		kind: "provider_quota",
		used: total - remaining,
		remaining,
		unit: "premium interactions",
		label: "Copilot user quota",
		period: "month"
	}];
	if (quota.percent_remaining !== void 0) {
		const percentRemaining = percentage(quota.percent_remaining);
		if (percentRemaining !== void 0) return [{
			kind: "provider_quota",
			used: 100 - percentRemaining,
			remaining: percentRemaining,
			unit: "%",
			label: "Copilot user quota",
			period: "month"
		}];
	}
	throw new SafeAdapterError("provider_error");
}
function googleAgyMetrics(payload) {
	if (!isRecord(payload)) throw new SafeAdapterError("provider_error");
	const rows = [];
	if (Array.isArray(payload.buckets)) {
		if (payload.buckets.length > 16) throw new SafeAdapterError("provider_error");
		for (const bucket of payload.buckets) if (isRecord(bucket)) rows.push(bucket);
	}
	if (Array.isArray(payload.groups)) {
		if (payload.groups.length > 16) throw new SafeAdapterError("provider_error");
		for (const group of payload.groups) {
			if (!isRecord(group) || !Array.isArray(group.buckets)) continue;
			if (group.buckets.length > 16) throw new SafeAdapterError("provider_error");
			for (const bucket of group.buckets) if (isRecord(bucket)) rows.push(bucket);
		}
	}
	if (rows.length > 16) throw new SafeAdapterError("provider_error");
	const metrics = [];
	for (const bucket of rows) {
		const remainingFraction = bucket.remainingFraction;
		if (typeof remainingFraction !== "number" || !Number.isFinite(remainingFraction) || remainingFraction < 0 || remainingFraction > 1) continue;
		const label = `AGY quota ${metrics.length + 1}`;
		const period = typeof bucket.window === "string" && [
			"weekly",
			"five_hour",
			"monthly",
			"daily"
		].includes(bucket.window.trim()) ? bucket.window.trim() : void 0;
		metrics.push({
			kind: "provider_quota",
			used: 100 - Math.round(remainingFraction * 100),
			remaining: Math.round(remainingFraction * 100),
			unit: "%",
			label,
			...period ? { period } : {}
		});
	}
	if (metrics.length === 0) throw new SafeAdapterError("provider_error");
	return metrics;
}
function openCodeGoMetrics(payload) {
	if (!isRecord(payload) || !isRecord(payload.usage)) throw new SafeAdapterError("invalid_response");
	const windows = [
		{
			key: "rolling",
			label: "5-hour quota"
		},
		{
			key: "weekly",
			label: "Weekly quota"
		},
		{
			key: "monthly",
			label: "Monthly quota"
		}
	];
	const metrics = [];
	for (const window of windows) {
		const value = payload.usage[window.key];
		if (!isRecord(value) || value.status !== "ok" && value.status !== "rate-limited") throw new SafeAdapterError("invalid_response");
		const used = percentage(value.percent);
		const resetsAt = value.resetsAt;
		if (used === void 0 || typeof resetsAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(resetsAt) || !Number.isFinite(Date.parse(resetsAt))) throw new SafeAdapterError("invalid_response");
		const normalizedUsed = value.status === "rate-limited" ? 100 : used;
		metrics.push({
			kind: "provider_quota",
			used: normalizedUsed,
			remaining: 100 - normalizedUsed,
			unit: "%",
			label: window.label,
			period: window.key
		});
	}
	return metrics;
}
const OPENCODE_GO_KEY_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const OPENCODE_GO_KEY_USAGE_HEADERS = {
	"x-opencode-session": "pantheon-quota",
	"user-agent": "Pantheon-Quota/1.0"
};
const OPENCODE_GO_CONSOLE_STATUS_URL = "https://opencode.ai/console/api/go/status";
const CONSOLE_RESET_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
function isValidConsoleResetDate(value) {
	const match = CONSOLE_RESET_DATE_PATTERN.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	const maxDay = [
		31,
		year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28,
		31,
		30,
		31,
		30,
		31,
		31,
		30,
		31,
		30,
		31
	][month - 1];
	return month >= 1 && month <= 12 && day >= 1 && maxDay !== void 0 && day <= maxDay && Number.isFinite(Date.parse(value));
}
function openCodeGoConsoleMetrics(payload) {
	if (!isRecord(payload) || !isRecord(payload.access) || !isRecord(payload.access.meters)) throw new SafeAdapterError("invalid_response");
	const meters = payload.access.meters;
	const fallbackResetsAt = payload.access.endsAt;
	const windows = [
		{
			key: "fiveHour",
			label: "5-hour quota",
			period: "rolling"
		},
		{
			key: "week",
			label: "Weekly quota",
			period: "weekly"
		},
		{
			key: "month",
			label: "Monthly quota",
			period: "monthly"
		}
	];
	const metrics = [];
	for (const window of windows) {
		const meter = meters[window.key];
		if (!isRecord(meter)) throw new SafeAdapterError("invalid_response");
		const limit = finiteAmount(meter.limitMicroCents);
		const used = finiteAmount(meter.usedMicroCents);
		if (limit === void 0 || used === void 0) throw new SafeAdapterError("invalid_response");
		const resetsAt = typeof meter.resetsAt === "string" && meter.resetsAt ? meter.resetsAt : fallbackResetsAt;
		if (typeof resetsAt !== "string" || !isValidConsoleResetDate(resetsAt)) throw new SafeAdapterError("invalid_response");
		const usedPercent = limit === 0 ? used > 0 ? 100 : 0 : Math.min(100, Math.max(0, Math.round(used / limit * 100)));
		metrics.push({
			kind: "provider_quota",
			used: usedPercent,
			remaining: 100 - usedPercent,
			unit: "%",
			label: window.label,
			period: window.period
		});
	}
	return metrics;
}
function openAIMetrics(payload) {
	if (!isRecord(payload) || !isRecord(payload.rate_limit)) throw new SafeAdapterError("invalid_response");
	const windows = [{
		key: "primary_window",
		fallback: "5-hour ChatGPT quota",
		period: "5h"
	}, {
		key: "secondary_window",
		fallback: "Weekly ChatGPT quota",
		period: "week"
	}];
	const metrics = [];
	for (const window of windows) {
		const value = payload.rate_limit[window.key];
		if (value === void 0 || value === null) continue;
		if (!isRecord(value)) throw new SafeAdapterError("invalid_response");
		const used = percentage(value.used_percent);
		if (used === void 0) continue;
		const period = value.limit_window_seconds === 18e3 ? "5h" : value.limit_window_seconds === 604800 ? "week" : value.limit_window_seconds === 2628e3 ? "month" : window.period;
		const label = period === "month" ? "Monthly ChatGPT quota" : period === "week" ? "Weekly ChatGPT quota" : window.fallback;
		metrics.push({
			kind: "provider_quota",
			used,
			remaining: 100 - used,
			unit: "%",
			label,
			period
		});
	}
	if (metrics.length === 0) throw new SafeAdapterError("invalid_response");
	return metrics;
}
const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/console/api";
const BILLING_UNITS_PER_DOLLAR = 1e8;
function parseConsoleBalance(payload) {
	if (!isRecord(payload)) throw new SafeAdapterError("provider_error");
	const value = finiteAmount(payload.balanceMicroCents);
	if (value === void 0) throw new SafeAdapterError("provider_error");
	return value / BILLING_UNITS_PER_DOLLAR;
}
function parseConsoleCreditLimit(payload) {
	if (!isRecord(payload)) throw new SafeAdapterError("provider_error");
	if (payload.creditLimitMicroCents === null) return void 0;
	const value = finiteAmount(payload.creditLimitMicroCents);
	if (value === void 0) throw new SafeAdapterError("provider_error");
	return value / BILLING_UNITS_PER_DOLLAR;
}
function parseConsoleMonthlyUsage(payload, now = /* @__PURE__ */ new Date()) {
	if (!Array.isArray(payload) || payload.length > 366) throw new SafeAdapterError("provider_error");
	const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
	let total = 0;
	for (const row of payload) {
		if (!isRecord(row) || typeof row.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) throw new SafeAdapterError("provider_error");
		const amount = finiteAmount(row.totalCostMicroCents);
		if (amount === void 0) throw new SafeAdapterError("provider_error");
		if (row.date.startsWith(month)) total += amount;
	}
	const amount = finiteAmount(total);
	if (amount === void 0) throw new SafeAdapterError("provider_error");
	return amount / BILLING_UNITS_PER_DOLLAR;
}
async function openCodeZenMetrics(secret, shutdownSignal, context) {
	const headers = context.orgId && /^[A-Za-z0-9_-]{1,128}$/.test(context.orgId) ? { "x-org-id": context.orgId } : {};
	const routes = await Promise.allSettled([
		requestJson(`${OPENCODE_ZEN_BASE_URL}/billing/status`, secret, shutdownSignal, "bearer", { headers }),
		requestJson(`${OPENCODE_ZEN_BASE_URL}/billing/account`, secret, shutdownSignal, "bearer", { headers }),
		requestJson(`${OPENCODE_ZEN_BASE_URL}/usage/cost-by-day`, secret, shutdownSignal, "bearer", { headers })
	]);
	const balance = routes[0];
	if (balance?.status !== "fulfilled") throw new SafeAdapterError("provider_error");
	const metrics = [{
		kind: "balance",
		amount: parseConsoleBalance(balance.value),
		currency: "USD",
		label: "Console balance"
	}];
	const account = routes[1];
	const usage = routes[2];
	if (account?.status === "fulfilled" && usage?.status === "fulfilled") {
		const limit = parseConsoleCreditLimit(account.value);
		if (limit !== void 0) {
			const spent = parseConsoleMonthlyUsage(usage.value);
			metrics.push({
				kind: "provider_quota",
				used: spent,
				remaining: Math.max(0, limit - spent),
				unit: "USD",
				label: "Monthly credit limit",
				period: "month"
			});
		}
	}
	return metrics;
}
const XAI_SUBSCRIPTIONS_URL = "https://grok.com/rest/subscriptions";
const XAI_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const XAI_HEADERS = {
	"user-agent": "OpenCode-Quota-Toast/1.0",
	"x-grok-client-surface": "grok-build",
	"x-grok-client-version": "1.0.0"
};
async function xaiSuperGrokMetrics(secret, shutdownSignal) {
	const subscriptionPayload = await requestJson(XAI_SUBSCRIPTIONS_URL, secret, shutdownSignal, "bearer", { headers: XAI_HEADERS });
	if (!isRecord(subscriptionPayload) || !Array.isArray(subscriptionPayload.subscriptions)) throw new SafeAdapterError("eligibility_unverified");
	if (!subscriptionPayload.subscriptions.some((subscription) => isRecord(subscription) && subscription.status === "SUBSCRIPTION_STATUS_ACTIVE" && typeof subscription.tier === "string" && /^SUBSCRIPTION_TIER_SUPER_GROK(?:_PRO|_LITE|_HEAVY)?$/.test(subscription.tier))) throw new SafeAdapterError("eligibility_unverified");
	const billingPayload = await requestJson(XAI_BILLING_URL, secret, shutdownSignal, "bearer", { headers: XAI_HEADERS });
	if (!isRecord(billingPayload) || !isRecord(billingPayload.config)) throw new SafeAdapterError("provider_error");
	const usage = billingPayload.config.creditUsagePercent;
	const used = usage === void 0 ? void 0 : percentage(usage);
	if (used === void 0) throw new SafeAdapterError("provider_error");
	return [{
		kind: "provider_quota",
		used,
		remaining: 100 - used,
		unit: "%",
		label: "SuperGrok billing period",
		period: "billing period"
	}];
}
async function runQuotaAdapter(provider, secret, shutdownSignal, queryCli = queryAlibabaTokenPlanUsage, adapterContext = {}) {
	const definition = QUOTA_PROVIDER_CATALOG[provider];
	if (!definition.adapter) return { reason: "provider_error" };
	if (definition.adapter === "openai" && !isOpenAICodexOAuthMethod(adapterContext?.methodID)) return { reason: "eligibility_unverified" };
	if (definition.adapter === "alibaba-token-plan-cli") {
		const result = await queryCli(shutdownSignal);
		if ("reason" in result) return result;
		return available([{
			kind: "provider_quota",
			used: result.percentage * 100,
			remaining: (1 - result.percentage) * 100,
			unit: "%",
			label: "Monthly token-plan quota",
			period: "month"
		}]);
	}
	if (!secret) return { reason: "provider_error" };
	try {
		if (definition.adapter === "anthropic") return available(anthropicMetrics(await requestJson("https://api.anthropic.com/api/oauth/usage", secret, shutdownSignal, "bearer", { headers: { "anthropic-beta": "oauth-2025-04-20" } })));
		if (definition.adapter === "copilot") return available(copilotMetrics(await requestJson("https://api.github.com/copilot_internal/user", secret, shutdownSignal, "bearer", { headers: {
			"x-github-api-version": "2026-03-10",
			"user-agent": "opencode-quota/copilot-billing"
		} })));
		if (definition.adapter === "google-agy") {
			if (!adapterContext.projectId || !/^[A-Za-z0-9._:-]{1,128}$/.test(adapterContext.projectId)) throw new SafeAdapterError("eligibility_unverified");
			return available(googleAgyMetrics(await requestJson("https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary", secret, shutdownSignal, "bearer", {
				method: "POST",
				body: JSON.stringify({ project: adapterContext.projectId }),
				headers: {
					"content-type": "application/json",
					"user-agent": "antigravity/cli/1.3.5",
					"x-activity-request-id": randomUUID()
				}
			})));
		}
		if (definition.adapter === "opencode-go") {
			if (adapterContext?.methodID !== void 0 && !isOpenCodeConsoleOAuthMethod(adapterContext.methodID)) throw new SafeAdapterError("eligibility_unverified");
			if (isOpenCodeConsoleOAuthMethod(adapterContext?.methodID)) {
				const headers = adapterContext.orgId ? { "x-org-id": adapterContext.orgId } : {};
				return available(openCodeGoConsoleMetrics(await requestJson(OPENCODE_GO_CONSOLE_STATUS_URL, secret, shutdownSignal, "bearer", { headers })));
			}
			return available(openCodeGoMetrics(await requestJson(OPENCODE_GO_KEY_USAGE_URL, secret, shutdownSignal, "bearer", { headers: OPENCODE_GO_KEY_USAGE_HEADERS })));
		}
		if (definition.adapter === "openai") return available(openAIMetrics(await requestJson("https://chatgpt.com/backend-api/wham/usage", secret, shutdownSignal, "bearer", { headers: { "user-agent": "OpenCode-Quota-Toast/1.0" } })));
		if (definition.adapter === "opencode-zen") return available(await openCodeZenMetrics(secret, shutdownSignal, adapterContext));
		if (definition.adapter === "xai-supergrok") return available(await xaiSuperGrokMetrics(secret, shutdownSignal));
	} catch (error) {
		if (error instanceof SafeAdapterError) return {
			reason: error.reason,
			...error.retryAfterMs === void 0 ? {} : { retryAfterMs: error.retryAfterMs }
		};
		return { reason: "provider_error" };
	}
	const url = {
		chutes: "https://api.chutes.ai/users/me/quota_usage/me",
		deepseek: "https://api.deepseek.com/user/balance",
		"kilo-gateway": "https://app.kilo.ai/api/trpc/kiloPass.getState?batch=1&input=%7B%220%22%3Anull%7D",
		"kimi-global": "https://api.kimi.ai/coding/v1/usages",
		"kimi-cn": "https://api.kimi.com/coding/v1/usages",
		"minimax-global": "https://api.minimax.io/v1/api/openplatform/coding_plan/remains",
		"minimax-cn": "https://api.minimaxi.com/v1/token_plan/remains",
		nanogpt: "https://nano-gpt.com/api/subscription/v1/usage",
		"ollama-cloud": "https://ollama.com/api/balance",
		openrouter: "https://openrouter.ai/api/v1/key",
		synthetic: "https://api.synthetic.new/v2/quotas",
		zai: "https://api.z.ai/api/monitor/usage/quota/limit",
		zhipu: "https://bigmodel.cn/api/monitor/usage/quota/limit"
	}[definition.adapter];
	try {
		if (definition.adapter === "kilo-gateway") {
			const passMetrics = kiloPassMetrics(await requestJson(url, secret, shutdownSignal));
			if (passMetrics) return available(passMetrics);
			return available(kiloBalanceMetrics(await requestJson("https://api.kilo.ai/api/profile/balance", secret, shutdownSignal)));
		}
		if (definition.adapter === "nanogpt") return available(await nanoGptMetrics(secret, shutdownSignal));
		const payload = await requestJson(url, secret, shutdownSignal, definition.adapter === "zai" || definition.adapter === "zhipu" ? "direct" : "bearer");
		return available({
			chutes: chutesMetrics,
			deepseek: deepseekMetrics,
			"kimi-global": kimiMetrics,
			"kimi-cn": kimiMetrics,
			"minimax-global": (value) => minimaxMetrics(value, "global"),
			"minimax-cn": (value) => minimaxMetrics(value, "cn"),
			"ollama-cloud": ollamaMetrics,
			openrouter: openRouterMetrics,
			synthetic: syntheticMetrics,
			zai: (value) => glmMetrics(value, "zai"),
			zhipu: (value) => glmMetrics(value, "zhipu")
		}[definition.adapter](payload));
	} catch (error) {
		if (error instanceof SafeAdapterError) return {
			reason: error.reason,
			...error.retryAfterMs === void 0 ? {} : { retryAfterMs: error.retryAfterMs }
		};
		return { reason: "provider_error" };
	}
}
//#endregion
export { OPENAI_CODEX_OAUTH_METHOD_IDS, OPENCODE_CONSOLE_OAUTH_METHOD_IDS, QUOTA_PROVIDER_CATALOG, isOpenAICodexOAuthMethod, isOpenCodeConsoleOAuthMethod, runQuotaAdapter };

//# sourceMappingURL=quota-adapters.js.map
