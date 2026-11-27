let solid_js_web = require("solid-js/web");
let node_child_process = require("node:child_process");
let node_fs = require("node:fs");
let node_os = require("node:os");
let node_path = require("node:path");
let _opencode_plugin_gui = require("@opencode/plugin/gui");
let effect = require("effect");
let solid_js = require("solid-js");
let node_module = require("node:module");
let node_fs_promises = require("node:fs/promises");
let node_url = require("node:url");
//#region src/autonomy-state.ts
const DEFAULT_GOAL_LOOP_PREFS = {
	enabled: false,
	cooldownMs: 5e3,
	maxContinuations: 25
};
Object.freeze(["enabled", "disabled"]);
const MAX_CONTINUATIONS_CYCLE = Object.freeze([
	"10",
	"25",
	"50",
	"100",
	"200"
]);
const COOLDOWN_MS_CYCLE = Object.freeze([
	"1000",
	"2000",
	"5000",
	"10000"
]);
const DEFAULT_DECISION_BUDGETS = {
	monthlyUsd: 5,
	perDecisionUsd: .1
};
/** Format USD compactly for a cycler cell ("$5", "$0.10"). */
function formatUsd(value) {
	return `$${value < 1 ? value.toFixed(2) : String(Math.round(value))}`;
}
/** Build the USD step ladder used by the budget cyclers. */
const MONTHLY_USD_CYCLE = Object.freeze([
	1,
	2,
	5,
	10,
	20,
	50,
	100
].map((value) => formatUsd(value)));
const PER_DECISION_USD_CYCLE = Object.freeze([
	.01,
	.025,
	.05,
	.1,
	.25,
	.5,
	1
].map((value) => formatUsd(value)));
/** Parse a staged USD cell back to a number; junk keeps the input. */
function parseUsd(cell) {
	const value = Number(cell.replace("$", ""));
	return Number.isFinite(value) && value > 0 ? value : null;
}
//#endregion
//#region src/model-pricing.ts
/**
* Model pricing — money for `pantheon_cost`.
*
* Prices come from the public catalog the OpenCode ecosystem already uses,
* `https://models.dev/api.json` (USD per 1M tokens). The rule that shapes this
* module is that a tool call must NEVER block on the network:
*
*   - every call reads a normalized on-disk cache synchronously;
*   - an explicit `refreshPricing` is the only AWAITED fetch (bounded timeout);
*   - a missing or stale cache is refreshed in the BACKGROUND, with a short
*     timeout, so the next call benefits without this one waiting;
*   - every network/parse failure degrades to "pricing unavailable" and the
*     token report keeps working.
*
* An unknown model is never priced at zero. `0` is a real catalog price (a free
* model), and conflating it with "no price" would report free usage for every
* model the catalog has never heard of — which is precisely the number a tier
* decision would be made on.
*
* Cache location follows the repository's existing config-dir convention
* (`PANTHEON_HOME` → `$XDG_CONFIG_HOME/opencode` → `~/.config/opencode`), so no
* new root is invented: `<configDir>/cache/models-dev.json`.
*
* @module model-pricing
*/
/** The catalog URL every OpenCode-adjacent tool prices against. */
const MODELS_DEV_URL = "https://models.dev/api.json";
/** Cache payload version; a mismatch is treated as "no cache". */
const PRICING_CACHE_VERSION = 1;
/** Cached prices are considered fresh for one day. */
const PRICING_TTL_MS = 864e5;
/** Upper bound for any catalog fetch, so no request can outlive a tool call. */
const PRICING_TIMEOUT_MS = 3e3;
/** Resolve the OpenCode config dir, mirroring `_pantheon_paths.py`. */
function resolvePricingCacheDir(env = process.env) {
	const explicit = env.PANTHEON_HOME?.trim();
	if (explicit !== void 0 && explicit !== "") return explicit;
	const xdg = env.XDG_CONFIG_HOME?.trim();
	const base = xdg !== void 0 && xdg !== "" ? xdg : (0, node_path.join)((0, node_os.homedir)(), ".config");
	return (0, node_path.join)(base, "opencode");
}
/** Cache file for the normalized catalog. */
function resolvePricingCachePath(env = process.env) {
	return (0, node_path.join)(resolvePricingCacheDir(env), "cache", "models-dev.json");
}
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
/** Reject nonsense prices rather than reporting a $2B session. */
const MAX_SANE_PER_MTOK = 1e5;
function nonNegativePrice(value) {
	const parsed = finiteNumber(value);
	if (parsed === void 0 || parsed < 0 || parsed > MAX_SANE_PER_MTOK) return void 0;
	return parsed;
}
/** Validate one already-normalized price from the cache file. */
function buildPrice(input, output, cacheRead, cacheWrite) {
	if (input === void 0 || output === void 0) return void 0;
	return {
		inputPerMTok: input,
		outputPerMTok: output,
		...cacheRead === void 0 ? {} : { cacheReadPerMTok: cacheRead },
		...cacheWrite === void 0 ? {} : { cacheWritePerMTok: cacheWrite }
	};
}
function parseNormalizedPrice(value) {
	if (!isRecord(value)) return void 0;
	return buildPrice(nonNegativePrice(value.inputPerMTok), nonNegativePrice(value.outputPerMTok), nonNegativePrice(value.cacheReadPerMTok), nonNegativePrice(value.cacheWritePerMTok));
}
/**
* Validate the normalized `provider → model → price` shape.
*
* The cache stores the RESULT of {@link parseCatalogPayload}, not the raw
* models.dev payload, so it must not be re-parsed as one: a normalized entry has
* no `models` key, and treating it as a payload would silently read a valid
* cache as empty.
*/
function parseNormalizedProviders(value) {
	if (!isRecord(value)) return void 0;
	const providers = {};
	for (const [providerId, models] of Object.entries(value)) {
		if (!isRecord(models)) continue;
		const priced = {};
		for (const [modelId, price] of Object.entries(models)) {
			const parsed = parseNormalizedPrice(price);
			if (parsed !== void 0) priced[modelId.toLowerCase()] = parsed;
		}
		if (Object.keys(priced).length > 0) providers[providerId.toLowerCase()] = priced;
	}
	return Object.keys(providers).length === 0 ? void 0 : providers;
}
/** Parse one catalog model entry. Missing input/output cost ⇒ unpriced. */
function parseModelPrice(model) {
	if (!isRecord(model)) return void 0;
	const cost = model.cost;
	if (!isRecord(cost)) return void 0;
	return buildPrice(nonNegativePrice(cost.input), nonNegativePrice(cost.output), nonNegativePrice(cost.cache_read), nonNegativePrice(cost.cache_write));
}
/**
* Normalize a models.dev payload into `provider → model → price`.
*
* Provider and model ids are lowercased because the ledger stores whatever the
* host wrote (`opencode-go`) and the catalog keys are not case-normalized.
*/
function parseCatalogPayload(payload) {
	if (!isRecord(payload)) return void 0;
	const providers = {};
	for (const [providerId, provider] of Object.entries(payload)) {
		if (!isRecord(provider)) continue;
		const models = provider.models;
		if (!isRecord(models)) continue;
		const priced = {};
		for (const [modelId, model] of Object.entries(models)) {
			const price = parseModelPrice(model);
			if (price !== void 0) priced[modelId.toLowerCase()] = price;
		}
		if (Object.keys(priced).length > 0) providers[providerId.toLowerCase()] = priced;
	}
	return Object.keys(providers).length === 0 ? void 0 : providers;
}
function priceKey(price) {
	return [
		price.inputPerMTok,
		price.outputPerMTok,
		price.cacheReadPerMTok ?? "-",
		price.cacheWritePerMTok ?? "-"
	].join("/");
}
function indexCatalog(providers) {
	const index = /* @__PURE__ */ new Map();
	const modelIndex = /* @__PURE__ */ new Map();
	const seen = /* @__PURE__ */ new Map();
	for (const [providerId, models] of Object.entries(providers)) for (const [modelId, price] of Object.entries(models)) {
		index.set(`${providerId}/${modelId}`, price);
		const bucket = modelIndex.get(modelId) ?? [];
		const keys = seen.get(modelId) ?? /* @__PURE__ */ new Set();
		const key = priceKey(price);
		if (!keys.has(key)) {
			keys.add(key);
			bucket.push(price);
			seen.set(modelId, keys);
			modelIndex.set(modelId, bucket);
		}
	}
	return {
		index,
		modelIndex
	};
}
function snapshotFromCatalog(catalog, now, ttlMs, refreshing) {
	const { index, modelIndex } = indexCatalog(catalog.providers);
	return {
		index,
		modelIndex,
		fetchedAt: catalog.fetchedAt,
		stale: Math.max(0, now - catalog.fetchedAt) > ttlMs,
		refreshing
	};
}
function unavailableSnapshot(reason) {
	return {
		index: /* @__PURE__ */ new Map(),
		modelIndex: /* @__PURE__ */ new Map(),
		stale: false,
		refreshing: false,
		unavailableReason: reason
	};
}
function parseCachedCatalog(raw) {
	if (!isRecord(raw)) return void 0;
	if (raw.version !== PRICING_CACHE_VERSION) return void 0;
	const fetchedAt = finiteNumber(raw.fetchedAt);
	if (fetchedAt === void 0) return void 0;
	const providers = parseNormalizedProviders(raw.providers);
	if (providers === void 0) return void 0;
	return {
		version: PRICING_CACHE_VERSION,
		fetchedAt,
		providers
	};
}
/** Read the normalized cache. Any problem reads as "no cache", never as zero. */
function readPricingCache(cachePath) {
	try {
		if (!(0, node_fs.existsSync)(cachePath)) return void 0;
		return parseCachedCatalog(JSON.parse((0, node_fs.readFileSync)(cachePath, "utf8")));
	} catch {
		return;
	}
}
/** Write atomically; a cache that cannot be written must not break a report. */
function writePricingCache(cachePath, catalog) {
	const temp = `${cachePath}.tmp-${process.pid}`;
	try {
		(0, node_fs.mkdirSync)((0, node_path.dirname)(cachePath), { recursive: true });
		(0, node_fs.writeFileSync)(temp, `${JSON.stringify(catalog)}\n`, "utf8");
		(0, node_fs.renameSync)(temp, cachePath);
		return true;
	} catch {
		return false;
	}
}
const inFlight = /* @__PURE__ */ new Map();
/**
* Offline is a HOST-wide guarantee, not a hint.
*
* Both switches are honoured on every path that could open a socket, so the
* env var cannot be defeated by a caller that passes `refreshPricing` (or by a
* future code path that forgets to check). The reason names both switches,
* because a user reading the report needs to know which one to change.
*/
const OFFLINE_REFUSAL = "refreshPricing cannot run: PANTHEON_COST_OFFLINE=1 (or the offline option) forbids every network request";
function isPricingOffline(options) {
	const env = options?.env ?? process.env;
	return options?.offline === true || env.PANTHEON_COST_OFFLINE === "1";
}
/**
* Fetch the catalog once per cache path at a time, bounded by a timeout.
*
* Failures are values, not throws: the caller reports "pricing unavailable" and
* keeps the token ledger it already read.
*/
function refreshPricingCatalog(options) {
	if (isPricingOffline(options)) return Promise.resolve({
		...unavailableSnapshot(OFFLINE_REFUSAL),
		refused: true,
		offline: true
	});
	const env = options?.env ?? process.env;
	const cachePath = options?.cachePath ?? resolvePricingCachePath(env);
	const existing = inFlight.get(cachePath);
	if (existing !== void 0) return existing;
	const now = (options?.now ?? Date.now)();
	const ttlMs = options?.ttlMs ?? PRICING_TTL_MS;
	const doFetch = options?.fetchImpl ?? ((url, init) => fetch(url, {
		...init.signal === void 0 ? {} : { signal: init.signal },
		...init.headers === void 0 ? {} : { headers: init.headers }
	}));
	const task = (async () => {
		try {
			const response = await doFetch(MODELS_DEV_URL, {
				signal: AbortSignal.timeout(PRICING_TIMEOUT_MS),
				headers: { accept: "application/json" }
			});
			if (!response.ok) return unavailableSnapshot(`models.dev returned HTTP ${response.status}`);
			const providers = parseCatalogPayload(await response.json());
			if (providers === void 0) return unavailableSnapshot("models.dev payload carried no usable prices");
			const catalog = {
				version: PRICING_CACHE_VERSION,
				fetchedAt: now,
				providers
			};
			const cached = writePricingCache(cachePath, catalog);
			const snapshot = snapshotFromCatalog(catalog, now, ttlMs, false);
			return cached ? snapshot : {
				...snapshot,
				unavailableReason: "price cache is not writable"
			};
		} catch (error) {
			return unavailableSnapshot(`models.dev fetch failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			inFlight.delete(cachePath);
		}
	})();
	inFlight.set(cachePath, task);
	return task;
}
/**
* Load prices without blocking on the network.
*
* A stale cache is served immediately and refreshed in the background; with no
* cache there is nothing to serve, so the snapshot is explicitly unavailable
* and `pending` carries the opportunistic refresh for callers that want it.
*/
function loadPricing(options) {
	const env = options?.env ?? process.env;
	const cachePath = options?.cachePath ?? resolvePricingCachePath(env);
	const now = (options?.now ?? Date.now)();
	const ttlMs = options?.ttlMs ?? PRICING_TTL_MS;
	const catalog = readPricingCache(cachePath);
	const offline = isPricingOffline(options);
	if (catalog === void 0) {
		if (offline) return { snapshot: {
			...unavailableSnapshot("no price cache, and pricing is offline (PANTHEON_COST_OFFLINE=1 or the offline option)"),
			offline: true
		} };
		const pending = refreshPricingCatalog(options);
		return {
			snapshot: unavailableSnapshot("no cached models.dev catalog yet; fetching one in the background"),
			pending: pending.then(() => void 0)
		};
	}
	const snapshot = snapshotFromCatalog(catalog, now, ttlMs, false);
	if (!snapshot.stale || offline) return { snapshot: offline ? {
		...snapshot,
		offline: true
	} : snapshot };
	const pending = refreshPricingCatalog(options);
	return {
		snapshot: {
			...snapshot,
			refreshing: true
		},
		pending: pending.then(() => void 0)
	};
}
/**
* Resolve a price for one ledger model.
*
* Exact `provider/model` wins. A model that exists under exactly one provider
* price is accepted when the ledger's provider id is unknown to the catalog
* (real hosts name their own gateways, e.g. `opencode-go` serving a model the
* catalog lists under `opencode`). Two DIFFERENT prices for the same model id
* are ambiguous and stay unpriced rather than guessing a provider.
*/
function lookupModelPrice(snapshot, providerId, modelId) {
	if (snapshot.index.size === 0) return {
		ok: false,
		reason: "no-pricing"
	};
	const model = (modelId ?? "").trim().toLowerCase();
	if (model === "") return {
		ok: false,
		reason: "unknown-model"
	};
	const provider = (providerId ?? "").trim().toLowerCase();
	if (provider !== "") {
		const exact = snapshot.index.get(`${provider}/${model}`);
		if (exact !== void 0) return {
			ok: true,
			price: exact
		};
	}
	const candidates = snapshot.modelIndex.get(model) ?? [];
	const only = candidates.length === 1 ? candidates[0] : void 0;
	if (only !== void 0) return {
		ok: true,
		price: only
	};
	if (candidates.length === 0) return {
		ok: false,
		reason: "unknown-model"
	};
	return {
		ok: false,
		reason: "ambiguous-model"
	};
}
/**
* Cost of one model's token counts.
*
* Cache tokens are billed at their own rate; when the catalog has no cache rate
* the row is unpriced instead of being charged at the input rate or at zero.
*/
function computeModelCost(price, tokens) {
	let usd = (tokens.input * price.inputPerMTok + tokens.output * price.outputPerMTok) / 1e6;
	if (tokens.cacheRead > 0) {
		const rate = price.cacheReadPerMTok;
		if (rate === void 0) return {
			ok: false,
			reason: "missing-cache-price"
		};
		usd += tokens.cacheRead * rate / 1e6;
	}
	if (tokens.cacheWrite > 0) {
		const rate = price.cacheWritePerMTok;
		if (rate === void 0) return {
			ok: false,
			reason: "missing-cache-price"
		};
		usd += tokens.cacheWrite * rate / 1e6;
	}
	return {
		ok: true,
		usd
	};
}
//#endregion
//#region src/cost-data.ts
/**
* Read-only cost and usage data shared by the CLI and the TUI package.
*
* This module lives inside the TUI package so its worker and bundled server do
* not import source files outside the package boundary. The CLI imports these
* same helpers, preserving a single implementation.
*/
const COST_SOURCES = ["message", "session_message"];
/**
* Which table family each host generation stores its ledger in.
*
* Spelled out rather than comparing the literals: `'message' === 'v1'` is
* false, so a filter written as `source === requested` narrows to nothing and
* every version-pinned read fails.
*/
const VERSION_SOURCES = {
	v1: "message",
	v2: "session_message"
};
/**
* Detect the ledger families by TABLE PRESENCE.
*
* Presence is the only reliable discriminator: a migrated database carries both
* families, so pinning a schema-version constant would break whichever
* population it excluded, and no manifest declares a supported host range.
* PANTHEON_OPENCODE_VERSION only NARROWS an already-detected set — it never
* chooses a file and never invents a family that is not there.
*/
function resolveSources(db, requested) {
	const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'session_message')").all().map((row) => String(row.name)));
	const detected = COST_SOURCES.filter((source) => present.has(source));
	if (detected.length === 0) throw new Error("incompatible opencode.db schema: neither the \"message\" nor the \"session_message\" table exists, so there is no token ledger to read");
	if (requested === void 0) return detected;
	const wanted = VERSION_SOURCES[requested];
	const narrowed = detected.filter((source) => source === wanted);
	if (narrowed.length === 0) throw new Error(`incompatible opencode.db schema: PANTHEON_OPENCODE_VERSION=${requested} selected no table family, but this database contains ${detected.join(" and ")}`);
	return narrowed;
}
/**
* UTC day + provider/model aggregation used by the TUI charts.
*
* The only interpolated fragments are fixed module constants (family table,
* discriminator, and time predicates). JSON is validated in the CTE before
* extraction, and all time bounds remain bound SQL parameters.
*/
function assistantLedgerPredicate(source) {
	return source === "message" ? "CASE WHEN json_valid(data) THEN json_extract(data, '$.role') = 'assistant' ELSE 0 END" : "type = 'assistant'";
}
function usageHistorySql(source, rolling) {
	return `
    WITH valid AS (
      SELECT strftime('%Y-%m-%d', time_created / 1000, 'unixepoch') AS day,
             COALESCE(NULLIF(TRIM(json_extract(data, '$.model.providerID')), ''),
                      NULLIF(TRIM(json_extract(data, '$.providerID')), '')) AS provider,
             COALESCE(NULLIF(TRIM(json_extract(data, '$.model.id')), ''),
                      NULLIF(TRIM(json_extract(data, '$.modelID')), '')) AS model,
             CASE WHEN json_type(data, '$.agent') IS NULL
                        OR json_extract(data, '$.agent') IS NULL
                        OR TRIM(json_extract(data, '$.agent')) = ''
                  THEN 1 ELSE 0 END AS agentless,
             CASE WHEN json_type(data, '$.tokens.input') IN ('integer', 'real')
                        AND json_extract(data, '$.tokens.input') >= 0
                  THEN CAST(json_extract(data, '$.tokens.input') AS INTEGER) ELSE 0 END AS inTok,
             CASE WHEN json_type(data, '$.tokens.output') IN ('integer', 'real')
                        AND json_extract(data, '$.tokens.output') >= 0
                  THEN CAST(json_extract(data, '$.tokens.output') AS INTEGER) ELSE 0 END AS outTok,
             CASE WHEN json_type(data, '$.tokens.cache.read') IN ('integer', 'real')
                        AND json_extract(data, '$.tokens.cache.read') >= 0
                  THEN CAST(json_extract(data, '$.tokens.cache.read') AS INTEGER) ELSE 0 END AS cacheReadTok,
             CASE WHEN json_type(data, '$.tokens.cache.write') IN ('integer', 'real')
                        AND json_extract(data, '$.tokens.cache.write') >= 0
                  THEN CAST(json_extract(data, '$.tokens.cache.write') AS INTEGER) ELSE 0 END AS cacheWriteTok
      FROM ${source}
      WHERE json_valid(data) AND ${assistantLedgerPredicate(source)} ${rolling ? "AND time_created >= ? AND time_created <= ?" : "AND time_created <= ?"}
    )
    SELECT day,
           provider,
           model,
           COUNT(*) AS rows,
           SUM(agentless) AS agentlessRows,
           COALESCE(SUM(inTok), 0) AS tokensInput,
           COALESCE(SUM(outTok), 0) AS tokensOutput,
           COALESCE(SUM(cacheReadTok), 0) AS tokensCacheRead,
           COALESCE(SUM(cacheWriteTok), 0) AS tokensCacheWrite
    FROM valid
    GROUP BY day, provider, model
    ORDER BY day, provider, model`;
}
function usageCoverageSql(source) {
	return `SELECT MIN(time_created) AS coverageStartAt
          FROM ${source}
          WHERE json_valid(data) AND ${assistantLedgerPredicate(source)} AND time_created <= ?`;
}
function numberOf(value) {
	if (value === null || value === void 0) return void 0;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
/** A ledger label the catalog cannot know; never an empty string. */
function ledgerLabel(value) {
	if (value === void 0 || value === null) return "unknown";
	const text = String(value).trim();
	return text === "" ? "unknown" : text;
}
/** Price one group, or explain why it cannot be priced. */
function priceTokens(pricing, provider, model, tokens) {
	if (pricing === void 0) return { reason: "no-pricing" };
	const lookup = lookupModelPrice(pricing, provider, model);
	if (!lookup.ok) return { reason: lookup.reason };
	const cost = computeModelCost(lookup.price, tokens);
	if (!cost.ok) return { reason: cost.reason };
	return { usd: cost.usd };
}
function emptyUsageTokens() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0
	};
}
function addUsageTokens(target, source) {
	target.input += source.input;
	target.output += source.output;
	target.cacheRead += source.cacheRead;
	target.cacheWrite += source.cacheWrite;
}
function toUsageTokenTotals(tokens) {
	return {
		input: tokens.input,
		output: tokens.output,
		cacheRead: tokens.cacheRead,
		cacheWrite: tokens.cacheWrite,
		total: tokens.input + tokens.output
	};
}
function offlinePricing(options) {
	return options?.pricing ?? loadPricing({
		...options?.pricingOptions,
		offline: true
	}).snapshot;
}
/**
* Read daily token history for the Usage charts.
*
* Rolling periods are exact N×24-hour windows ending at `now`; daily buckets
* are UTC dates. Future-dated rows are excluded from every period, including
* `total`, while `total` has no lower age cap. Both V1 and V2 tables are read
* when a migrated database contains both. The database is opened read-only and
* model pricing comes only from a cached snapshot: this path never fetches pricing.
*/
async function queryUsageHistory(dbPath, period, options) {
	const dayCounts = {
		"7d": 7,
		"15d": 15,
		"30d": 30
	};
	if (period !== "total" && !Object.hasOwn(dayCounts, period)) throw new Error(`unsupported usage history period: ${String(period)}`);
	const now = options?.now ?? Date.now();
	if (!Number.isFinite(now)) throw new Error("usage history clock must be finite");
	const rolling = period !== "total";
	const since = rolling ? now - dayCounts[period] * 864e5 : void 0;
	const db = new (await (import("node:sqlite"))).DatabaseSync(dbPath, { readOnly: true });
	try {
		const sources = resolveSources(db, void 0);
		const models = /* @__PURE__ */ new Map();
		let rows = 0;
		let coverageStartAt = null;
		for (const source of sources) {
			const sourceStart = numberOf(db.prepare(usageCoverageSql(source)).get(now)?.coverageStartAt);
			if (sourceStart !== void 0) coverageStartAt = coverageStartAt === null ? sourceStart : Math.min(coverageStartAt, sourceStart);
			const groups = db.prepare(usageHistorySql(source, rolling)).all(...since === void 0 ? [now] : [since, now]);
			for (const group of groups) {
				if (typeof group.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(group.day)) continue;
				const providerID = ledgerLabel(group.provider);
				const modelID = ledgerLabel(group.model);
				const key = `${providerID}\u0000${modelID}`;
				const model = models.get(key) ?? {
					providerID,
					modelID,
					tokens: emptyUsageTokens(),
					rows: 0,
					agentlessRows: 0,
					days: /* @__PURE__ */ new Map()
				};
				const tokens = {
					input: numberOf(group.tokensInput) ?? 0,
					output: numberOf(group.tokensOutput) ?? 0,
					cacheRead: numberOf(group.tokensCacheRead) ?? 0,
					cacheWrite: numberOf(group.tokensCacheWrite) ?? 0
				};
				const groupRows = numberOf(group.rows) ?? 0;
				const agentlessRows = numberOf(group.agentlessRows) ?? 0;
				rows += groupRows;
				addUsageTokens(model.tokens, tokens);
				model.rows += groupRows;
				model.agentlessRows += agentlessRows;
				const day = model.days.get(group.day) ?? {
					tokens: emptyUsageTokens(),
					rows: 0,
					agentlessRows: 0
				};
				addUsageTokens(day.tokens, tokens);
				day.rows += groupRows;
				day.agentlessRows += agentlessRows;
				model.days.set(group.day, day);
				models.set(key, model);
			}
		}
		const priceSnapshot = offlinePricing(options);
		const daily = /* @__PURE__ */ new Map();
		let pricedModels = 0;
		let unpricedModels = 0;
		let estimatedUsd = 0;
		const modelRows = [];
		for (const model of models.values()) {
			const totalsPrice = priceTokens(priceSnapshot, model.providerID, model.modelID, {
				input: model.tokens.input,
				output: model.tokens.output,
				cacheRead: model.tokens.cacheRead,
				cacheWrite: model.tokens.cacheWrite
			});
			const modelPriced = "usd" in totalsPrice;
			if ("usd" in totalsPrice) {
				pricedModels += 1;
				estimatedUsd += totalsPrice.usd;
			} else unpricedModels += 1;
			const buckets = [...model.days.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, value]) => {
				const bucketPrice = priceTokens(priceSnapshot, model.providerID, model.modelID, {
					input: value.tokens.input,
					output: value.tokens.output,
					cacheRead: value.tokens.cacheRead,
					cacheWrite: value.tokens.cacheWrite
				});
				const dailyTotal = daily.get(date) ?? {
					tokens: emptyUsageTokens(),
					usd: 0,
					pricedModels: 0,
					unpricedModels: 0
				};
				addUsageTokens(dailyTotal.tokens, value.tokens);
				if ("usd" in bucketPrice) {
					dailyTotal.usd += bucketPrice.usd;
					dailyTotal.pricedModels += 1;
				} else dailyTotal.unpricedModels += 1;
				daily.set(date, dailyTotal);
				return {
					date,
					...toUsageTokenTotals(value.tokens),
					..."usd" in bucketPrice ? { estimatedUsd: bucketPrice.usd } : {},
					pricingComplete: "usd" in bucketPrice
				};
			});
			modelRows.push({
				providerID: model.providerID,
				modelID: model.modelID,
				rows: model.rows,
				agentlessRows: model.agentlessRows,
				buckets,
				totals: toUsageTokenTotals(model.tokens),
				..."usd" in totalsPrice ? { estimatedUsd: totalsPrice.usd } : {},
				pricingComplete: modelPriced,
				...!modelPriced && "reason" in totalsPrice ? { unpricedReason: totalsPrice.reason } : {}
			});
		}
		modelRows.sort((left, right) => left.providerID.localeCompare(right.providerID) || left.modelID.localeCompare(right.modelID));
		const buckets = [...daily.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, value]) => ({
			date,
			...toUsageTokenTotals(value.tokens),
			...value.pricedModels > 0 ? { estimatedUsd: value.usd } : {},
			pricingComplete: value.unpricedModels === 0
		}));
		const pricingStatus = rows === 0 ? "empty" : pricedModels === 0 ? "unavailable" : unpricedModels > 0 ? "partial" : "complete";
		const totals = emptyUsageTokens();
		for (const model of models.values()) addUsageTokens(totals, model.tokens);
		const requestedStart = since;
		return {
			period,
			coverageStart: coverageStartAt === null ? null : new Date(coverageStartAt).toISOString().slice(0, 10),
			coverageStartAt,
			partial: requestedStart !== void 0 && coverageStartAt !== null && coverageStartAt > requestedStart,
			rows,
			buckets,
			totals: toUsageTokenTotals(totals),
			models: modelRows,
			pricing: {
				status: pricingStatus,
				complete: pricingStatus === "complete",
				...pricedModels > 0 ? { estimatedUsd } : {},
				unpricedModels
			}
		};
	} finally {
		db.close();
	}
}
Object.freeze(["enabled", "disabled"]);
/** Exact top-level key set — anything else fail-closes the runtime. */
const DECISION_CONFIG_KEYS = Object.freeze([
	"egress_consent",
	"enabled",
	"enabled_candidates",
	"schema_version",
	"selection"
]);
const DEFAULT_DECISION_CONFIG = Object.freeze({
	schema_version: 2,
	enabled: false,
	selection: Object.freeze({ mode: "local" }),
	egress_consent: false,
	enabled_candidates: Object.freeze([])
});
/** The runtime's provider→model matrix (drift-pinned against the installer source). */
const DECISION_KNOWN_PROVIDERS = Object.freeze([
	"openai-decisions",
	"typesafe-jev",
	"opencode-console-jev",
	"openrouter-jev",
	"vercel-gateway-jev",
	"cloudflare-workers-jev"
]);
Object.freeze(["not granted", "granted"]);
/** provider → model, straight from the runtime matrix (drift-pinned in tests). */
const DECISION_KNOWN_MODELS = Object.freeze({
	"openai-decisions": "gpt-6-luna",
	"typesafe-jev": "jev-1.14.0",
	"opencode-console-jev": "jev-1.13",
	"openrouter-jev": "typesafe/jev-1.13",
	"vercel-gateway-jev": "typesafe-ai/jev",
	"cloudflare-workers-jev": "clef"
});
/**
* Credential surface per provider: the ENV VAR the host provider entry reads
* (`{env:VAR}` indirection — the window NEVER holds key values) plus the setup
* note. Drift-pinned against the installer/runtime sources in tests.
*/
const DECISION_PROVIDER_CREDENTIALS = Object.freeze({
	"openai-decisions": {
		note: "host-configured model — provision via `decision-router setup-model openai-decisions`",
		notePt: "modelo do host — configure via `decision-router setup-model openai-decisions`"
	},
	"typesafe-jev": {
		env: "TYPESAFE_API_KEY",
		note: "export TYPESAFE_API_KEY=… then restart",
		notePt: "export TYPESAFE_API_KEY=… e depois reinicie"
	},
	"opencode-console-jev": {
		note: "rides your OpenCode login — no separate key",
		notePt: "utiliza login do OpenCode — sem chave separada"
	},
	"openrouter-jev": {
		env: "OPENROUTER_API_KEY",
		note: "export OPENROUTER_API_KEY=… then restart",
		notePt: "export OPENROUTER_API_KEY=… e depois reinicie"
	},
	"vercel-gateway-jev": {
		env: "AI_GATEWAY_API_KEY",
		note: "export AI_GATEWAY_API_KEY=… then restart",
		notePt: "export AI_GATEWAY_API_KEY=… e depois reinicie"
	},
	"cloudflare-workers-jev": {
		env: "CLOUDFLARE_API_TOKEN",
		note: "needs accountId (setup-model --account-id=…) + CLOUDFLARE_API_TOKEN",
		notePt: "requer accountId (setup-model --account-id=…) + CLOUDFLARE_API_TOKEN"
	}
});
const DECISION_TARGET_CYCLE = Object.freeze(DECISION_KNOWN_PROVIDERS.map((provider) => `${provider}/${DECISION_KNOWN_MODELS[provider]}`));
function decisionRouterConfigPath(env = process.env) {
	const xdg = env.XDG_CONFIG_HOME;
	const home = env.HOME ?? "";
	const root = xdg ?? (0, node_path.join)(home, ".config");
	return (0, node_path.join)(root, "pantheon", "decision-router.json");
}
/** Fail-open read: a missing file is the default; an invalid one is reported, not guessed. */
function readDecisionRouterConfig(env = process.env) {
	let raw;
	try {
		raw = JSON.parse((0, node_fs.readFileSync)(decisionRouterConfigPath(env), "utf8"));
	} catch (error) {
		if (error?.code === "ENOENT") return {
			config: cloneDefault(),
			corrupt: false
		};
		return {
			config: cloneDefault(),
			corrupt: true
		};
	}
	if (isValidDecisionConfig(raw)) return {
		config: raw,
		corrupt: false
	};
	return {
		config: cloneDefault(),
		corrupt: true
	};
}
function cloneDefault() {
	return {
		schema_version: DEFAULT_DECISION_CONFIG.schema_version,
		enabled: DEFAULT_DECISION_CONFIG.enabled,
		selection: { ...DEFAULT_DECISION_CONFIG.selection },
		egress_consent: DEFAULT_DECISION_CONFIG.egress_consent,
		enabled_candidates: [...DEFAULT_DECISION_CONFIG.enabled_candidates]
	};
}
/** The exact-key, exact-shape validation the runtime applies (fail-closed otherwise). */
function isValidDecisionConfig(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value;
	const keys = Object.keys(record).sort();
	if (keys.length !== DECISION_CONFIG_KEYS.length) return false;
	for (const key of DECISION_CONFIG_KEYS) if (!keys.includes(key)) return false;
	if (record.schema_version !== 2) return false;
	if (typeof record.enabled !== "boolean") return false;
	if (typeof record.egress_consent !== "boolean") return false;
	if (!isValidSelection(record.selection)) return false;
	if (!Array.isArray(record.enabled_candidates)) return false;
	for (const candidate of record.enabled_candidates) {
		if (typeof candidate !== "object" || candidate === null) return false;
		const entry = candidate;
		if (typeof entry.provider !== "string" || typeof entry.model !== "string") return false;
		if (Object.keys(entry).length !== 2) return false;
	}
	return true;
}
function isValidSelection(value) {
	if (typeof value !== "object" || value === null) return false;
	const selection = value;
	if (selection.mode !== "local" && selection.mode !== "auto" && selection.mode !== "explicit") return false;
	const keys = Object.keys(selection).sort();
	for (const key of keys) if (key !== "mode" && key !== "provider" && key !== "model") return false;
	if (selection.provider !== void 0 && typeof selection.provider !== "string") return false;
	if (selection.model !== void 0 && typeof selection.model !== "string") return false;
	return true;
}
/** Stable serializer: exact keys in sorted order, 2-space, trailing newline. */
function serializeDecisionConfig(config) {
	const ordered = {
		egress_consent: config.egress_consent,
		enabled: config.enabled,
		enabled_candidates: config.enabled_candidates.map((candidate) => ({
			model: candidate.model,
			provider: candidate.provider
		})),
		schema_version: config.schema_version,
		selection: {
			mode: config.selection.mode,
			...config.selection.model !== void 0 ? { model: config.selection.model } : {},
			...config.selection.provider !== void 0 ? { provider: config.selection.provider } : {}
		}
	};
	return `${JSON.stringify(ordered, null, 2)}\n`;
}
/**
* Enable/disable the router in a config copy. The guard mirrors the runtime's
* fail-close: with remote candidates and no egress consent, an enabled flag
* would be a lie — enabling requires consent, or a local-only selection.
* Never touches `egress_consent` (CLI-owned).
*/
function setDecisionEnabled(config, enabled) {
	if (enabled) {
		if (!(config.selection.mode === "local" || config.enabled_candidates.length === 0) && !config.egress_consent) return {
			ok: false,
			reason: "remote candidates need egress consent — toggle Egress consent in this tab, then enable"
		};
	}
	return {
		ok: true,
		config: {
			...config,
			enabled
		}
	};
}
/** Atomic-ish write mirroring the canonical writer's privacy posture (0600). */
function writeDecisionRouterConfig(config, env = process.env) {
	if (!isValidDecisionConfig(config)) throw new TypeError("Refusing to persist an invalid decision-router configuration");
	const path = decisionRouterConfigPath(env);
	(0, node_fs.mkdirSync)((0, node_path.dirname)(path), {
		recursive: true,
		mode: 448
	});
	const temp = `${path}.tui.tmp`;
	(0, node_fs.writeFileSync)(temp, serializeDecisionConfig(config), { mode: 384 });
	(0, node_fs.renameSync)(temp, path);
	(0, node_fs.chmodSync)(path, 384);
}
const DECISION_SELECTION_CYCLE = Object.freeze([
	"local",
	"auto",
	"explicit"
]);
/** Stage a selection/consent row into a config copy; unknown rows are no-ops. */
function applyDecisionRow(config, id, value) {
	const next = {
		...config,
		selection: { ...config.selection },
		enabled_candidates: [...config.enabled_candidates]
	};
	switch (id) {
		case "decision.selection.mode": {
			const mode = value;
			if (mode !== "local" && mode !== "auto" && mode !== "explicit") return config;
			next.selection.mode = mode;
			if (mode === "local") next.enabled_candidates = [];
			return next;
		}
		case "decision.selection.target": {
			const separator = value.indexOf("/");
			if (separator <= 0) return config;
			const provider = value.slice(0, separator);
			const model = value.slice(separator + 1);
			if (!DECISION_KNOWN_PROVIDERS.includes(provider)) return config;
			if (DECISION_KNOWN_MODELS[provider] !== model) return config;
			next.selection = {
				mode: "explicit",
				provider,
				model
			};
			next.enabled_candidates = [{
				provider,
				model
			}];
			return next;
		}
		case "decision.consent":
			next.egress_consent = value === "granted";
			return next;
		default: return config;
	}
}
/** Provider ids as they appear in the host auth store / config providers. */
const PROVIDER_AUTH_NAMES = Object.freeze({
	"openai-decisions": Object.freeze(["openai"]),
	"typesafe-jev": Object.freeze(["typesafe-ai"]),
	"opencode-console-jev": Object.freeze([]),
	"openrouter-jev": Object.freeze(["openrouter"]),
	"vercel-gateway-jev": Object.freeze(["vercel-ai-gateway", "vercel"]),
	"cloudflare-workers-jev": Object.freeze(["cloudflare-workers-ai"])
});
/**
* TWO recognition forms (field feedback beta.6: keys registered via
* `opencode auth login` showed MISSING because only env vars were checked):
* env var set → 'env'; provider present in the host auth store → 'auth
* store'; provider entry in opencode.json providers → 'config'. Values are
* NEVER read — existence only.
*/
function credentialStatus(provider, env, authProviders, configProviders) {
	const credential = DECISION_PROVIDER_CREDENTIALS[provider];
	if (credential?.env !== void 0 && env[credential.env]) return "env";
	for (const name of PROVIDER_AUTH_NAMES[provider] ?? []) if (authProviders.has(name)) return "auth store";
	for (const name of PROVIDER_AUTH_NAMES[provider] ?? []) if (configProviders.has(name)) return "config";
	if (provider === "opencode-console-jev") return "auth store";
	return "missing";
}
//#endregion
//#region src/pantheon-settings-state.ts
/** Mirrors routing.yml `behaviors:` — drift-pinned by the registry test. */
const SETTINGS_BEHAVIORS = Object.freeze([
	{
		id: "skill-auto-continue",
		kind: "install",
		title: "Auto-continue skill",
		description: "Continue multi-step todos while keeping safety gates."
	},
	{
		id: "skill-tdd-with-agents",
		kind: "install",
		title: "TDD with agents skill",
		description: "RED, GREEN, REFACTOR test-driven implementation."
	},
	{
		id: "skill-code-review-checklist",
		kind: "install",
		title: "Code review checklist skill",
		description: "Systematic code review and quality gates."
	},
	{
		id: "skill-prompt-refinery",
		kind: "install",
		title: "Prompt refinery skill",
		description: "Vague requests refined — silent adjust, >> full contract."
	},
	{
		id: "gate-idle-todo-enforcer",
		kind: "runtime",
		title: "Idle todo enforcer",
		description: "Continues pending todos when a session goes idle."
	},
	{
		id: "gate-context-pruner",
		kind: "runtime",
		title: "Context pruner",
		description: "Prunes repeated tool output before summarization."
	},
	{
		id: "gate-j1-risk-gate",
		kind: "runtime",
		title: "J1 risk gate",
		description: "High-risk tool calls demand explicit human approval."
	}
]);
new Set(SETTINGS_BEHAVIORS.map((b) => b.id));
function isBehaviorDisabled(effective, id) {
	return effective[id]?.action === "disable";
}
const TOGGLE_REASON = "toggled in /pantheon-settings";
/**
* Toggle (a targeted write keeps the toggle semantics: a `replace` entry is
* never destroyed — disabling keeps its `content`, re-enabling restores the
* replace; a settings-written disable is removed outright, no toggle noise).
*/
function toggledOverrides(effective, id, reason = TOGGLE_REASON) {
	const next = { ...effective };
	const entry = next[id];
	if (entry?.action === "disable") {
		if (entry.content !== void 0) next[id] = entry.reason === reason ? {
			action: "replace",
			content: entry.content
		} : {
			action: "replace",
			content: entry.content,
			...entry.reason !== void 0 ? { reason: entry.reason } : {}
		};
		else delete next[id];
	} else next[id] = entry?.content !== void 0 ? {
		action: "disable",
		reason,
		content: entry.content
	} : {
		action: "disable",
		reason
	};
	return next;
}
/** Set an explicit on/off target (the cycler's save path) via the toggle semantics. */
function setOverrideState(effective, id, target, reason = TOGGLE_REASON) {
	const disabled = isBehaviorDisabled(effective, id);
	if (target === "disabled" === disabled) return effective;
	return toggledOverrides(effective, id, reason);
}
function serializeOverrides(effective) {
	const ordered = {};
	for (const id of Object.keys(effective).sort()) ordered[id] = effective[id];
	return `${JSON.stringify(ordered, null, 2)}\n`;
}
/** Merge for DISPLAY only, mirroring the runtime precedence: project wins per id. */
function mergedOverrides(load) {
	return {
		...load.global,
		...load.project
	};
}
function canWriteOverrides(load) {
	return !load.corruptGlobal;
}
Object.freeze(["enabled", "disabled"]);
Object.freeze(["global", "project"]);
function buildAboutTab(version, extra) {
	const isPt = extra?.languagePref === "pt-BR";
	const sysRows = [{
		id: "about.version",
		name: isPt ? "Versão" : "Version",
		value: `v${version}`,
		note: isPt ? "OpenCode 2.x nativo — contrato V1 descontinuado" : "OpenCode 2.x only — the V1 contract is removed"
	}, {
		id: "about.behaviors",
		name: isPt ? "Comportamentos" : "Behaviors",
		value: String(SETTINGS_BEHAVIORS.length),
		note: isPt ? "portões e skills de governança registradas" : "registered governance gates and skills"
	}];
	if (extra?.nodeVersion) sysRows.push({
		id: "about.runtime",
		name: "Runtime Node.js",
		value: `v${extra.nodeVersion}`,
		note: extra.platform ? `${isPt ? "plataforma" : "platform"}: ${extra.platform}` : ""
	});
	const govRows = [
		{
			id: "about.preset",
			name: isPt ? "Predefinição" : "Active Preset",
			value: extra?.preset ?? "none",
			note: isPt ? "modelo global ativo do Pantheon" : "global model preset active in Pantheon"
		},
		{
			id: "about.decision",
			name: isPt ? "Assistente Jev" : "Decision Router",
			value: extra?.decisionEnabled ? isPt ? "ativado" : "enabled" : isPt ? "desativado" : "disabled",
			note: isPt ? "arbitragem de modelos e candidatos" : "model and candidate arbitration"
		},
		{
			id: "about.j1",
			name: isPt ? "Portão J1" : "J1 Risk Gate",
			value: extra?.j1Mode ?? "shadow",
			note: isPt ? "portão de risco de segurança operacional" : "operational safety risk score gate"
		}
	];
	const refRows = [{
		id: "about.license",
		name: isPt ? "Licença" : "License",
		value: "MIT",
		note: "Open source · Pantheon Project"
	}, {
		id: "about.repo",
		name: isPt ? "Repositório" : "Repository",
		value: "ils15/pantheon-opencode",
		note: "github.com/ils15/pantheon-opencode"
	}];
	const toolRows = [
		{
			id: "about.tools.memory",
			name: isPt ? "Memória FTS5" : "FTS5 Memory",
			value: isPt ? "ativo · 6 tools" : "active · 6 tools",
			note: "memory_store, memory_recall, memory_search, memory_forget, memory_list, memory_stats"
		},
		{
			id: "about.tools.persistence",
			name: isPt ? "Checkpoints & Metas" : "Checkpoints & Goals",
			value: isPt ? "ativo · 6 tools" : "active · 6 tools",
			note: "context_save, context_get, goal_create, goal_get, goal_update, goal_done"
		},
		{
			id: "about.tools.codemap",
			name: isPt ? "Codemap & AST" : "Codemap & AST",
			value: isPt ? "ativo · 5 tools" : "active · 5 tools",
			note: "code_index, code_query, code_neighbors, ast_search, ast_rewrite"
		},
		{
			id: "about.tools.edit",
			name: isPt ? "Edição & Execução" : "Edit & Execution",
			value: isPt ? "ativo · 4 tools" : "active · 4 tools",
			note: "hashline_edit, shell, todowrite, todoread"
		},
		{
			id: "about.tools.governance",
			name: isPt ? "Orquestração & Custos" : "Orchestration & Cost",
			value: isPt ? "ativo · 9 tools" : "active · 9 tools",
			note: "pantheon_cost, pantheon_model, pantheon_skill_search, pantheon_deepwork, pantheon_step_ledger, pantheon_agent_forge, pantheon_local_decision, pantheon_review_verdict, pantheon_worktree"
		}
	];
	const groups = [{
		title: isPt ? "Sistema & Plataforma" : "System & Platform",
		rows: sysRows
	}];
	if (extra?.preset !== void 0 || extra?.decisionEnabled !== void 0) groups.push({
		title: isPt ? "Governança & Roteamento" : "Governance & Routing",
		rows: govRows
	});
	groups.push({
		title: isPt ? "Projeto & Referências" : "Project & References",
		rows: refRows
	});
	groups.push({
		title: isPt ? "Ferramentas Nativas (30)" : "Native Tools (30)",
		rows: toolRows
	});
	return {
		id: "about",
		title: isPt ? "Sobre" : "About",
		groups
	};
}
//#endregion
//#region src/update-notice.ts
const isBetaOrRc = (version) => /-(?:beta|rc)\.\d+$/.test(String(version).trim());
/** True when `latestVersion` is strictly newer and compatible with `currentVersion` channel. */
function isNewerUpdateAvailable(currentVersion, latestVersion) {
	const current = String(currentVersion).trim();
	const latest = String(latestVersion).trim();
	if (!current || !latest) return false;
	if (!isBetaOrRc(current) && isBetaOrRc(latest)) return false;
	return comparePantheonVersions(latest, current) > 0;
}
/** Stamp `lastKnownLatestVersion` onto an `UpdateCheckState` without altering TTL/notice fields. */
function withKnownLatest(state, latestVersion) {
	if (!latestVersion) return state;
	return {
		...state,
		lastKnownLatestVersion: latestVersion
	};
}
/** Semver-ish compare for X.Y.Z[-(beta|rc).N]; prereleases sort before their release. */
function comparePantheonVersions(left, right) {
	const parse = (version) => {
		const match = String(version).trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-(beta|rc)\.(\d+))?$/);
		if (!match) return null;
		const [, major = "", minor = "", patch = "", stage = "", stageNum = ""] = match;
		const stageRank = stage === "beta" ? 1 : stage === "rc" ? 2 : 3;
		return {
			core: [
				+major,
				+minor,
				+patch
			],
			stageRank,
			stageNum: stage !== "" ? +stageNum : Number.POSITIVE_INFINITY
		};
	};
	const a = parse(left);
	const b = parse(right);
	if (!a || !b) return 0;
	const [aMajor, aMinor, aPatch] = a.core;
	const [bMajor, bMinor, bPatch] = b.core;
	if (aMajor !== bMajor) return aMajor - bMajor;
	if (aMinor !== bMinor) return aMinor - bMinor;
	if (aPatch !== bPatch) return aPatch - bPatch;
	if (a.stageRank !== b.stageRank) return a.stageRank - b.stageRank;
	return a.stageNum - b.stageNum;
}
/** The state to persist after a check (notified or not) for the TTL. */
function nextCheckState(previous, notice, nowMs) {
	const lastNotifiedVersion = notice?.version ?? previous.lastNotifiedVersion;
	return {
		lastCheckMs: nowMs,
		...lastNotifiedVersion !== void 0 ? { lastNotifiedVersion } : {}
	};
}
//#endregion
//#region src/doctor-state.ts
/**
* doctor-state.ts — the Doctor section of the settings window (read-only).
*
* TUI-local replica (the bundle must stay self-contained — the installed copy
* physically lacks the repo tree, so doctor.mjs itself is unreachable). Only
* the FILE-DERIVABLE checks are mirrored here; everything that spawns
* processes, reads the network, or writes (MCP smoke, python validators, git,
* venv pins, --fix quarantines) stays in the CLI and the section says so.
*
* The install-state path mirrors doctor's checkInstallVersionDrift
* (`<config>/opencode/.pantheon/install-state.json`); the Node floor is
* drift-pinned against scripts/node-engine-policy.mjs by
* tests/tui-doctor-state.test.mjs.
*/
/** Drift-pinned against scripts/node-engine-policy.mjs MIN_SUPPORTED_NODE_VERSION. */
const MIN_SUPPORTED_NODE_VERSION = "26.3.0";
function opencodePantheonDir(env = process.env) {
	const xdg = env.XDG_CONFIG_HOME;
	const home = env.HOME ?? "";
	const root = xdg ?? (0, node_path.join)(home, ".config");
	return (0, node_path.join)(root, "opencode", ".pantheon");
}
/**
* H2: the installed package version (install-state) vs the running one.
* Fail-open: a missing/unreadable state file means "unknown", not a failure —
* pre-2.0 installs may not have one.
*/
function classifyInstallVersion(runningVersion, env = process.env) {
	let installed = null;
	try {
		const path = (0, node_path.join)(opencodePantheonDir(env), "install-state.json");
		const raw = JSON.parse((0, node_fs.readFileSync)(path, "utf8"));
		if (typeof raw?.pantheon_version === "string" && raw.pantheon_version !== "") installed = raw.pantheon_version;
	} catch {
		installed = null;
	}
	if (installed === null) return {
		status: "unknown",
		installed: null
	};
	const compared = comparePantheonVersions(installed, runningVersion);
	if (compared === 0) return {
		status: "ok",
		installed
	};
	return {
		status: compared < 0 ? "older" : "newer",
		installed
	};
}
function isSupportedNodeFloor(version) {
	const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([^+]+))?(?:\+([\w.-]+))?$/.exec(String(version));
	const minimum = /^v?(\d+)\.(\d+)\.(\d+)/.exec(MIN_SUPPORTED_NODE_VERSION);
	if (!match || !minimum) return false;
	const [, major = "", minor = "", patch = "", prerelease = ""] = match;
	if (prerelease !== "") return false;
	const [, minMajor = "0", minMinor = "0", minPatch = "0"] = minimum;
	const currentParts = [
		+major,
		+minor,
		+patch
	];
	const minimumParts = [
		+minMajor,
		+minMinor,
		+minPatch
	];
	for (let index = 0; index < 3; index += 1) {
		const currentPart = currentParts[index] ?? 0;
		const minimumPart = minimumParts[index] ?? 0;
		if (currentPart !== minimumPart) return currentPart > minimumPart;
	}
	return true;
}
/** K: validate both overrides files against the window's registry. */
function classifyOverridesHealth(load) {
	if (load.corruptGlobal) return {
		status: "corrupt",
		unknownIds: []
	};
	const known = new Set(SETTINGS_BEHAVIORS.map((behavior) => behavior.id));
	const unknownIds = Object.keys({
		...load.global,
		...load.project
	}).filter((id) => !known.has(id));
	return {
		status: unknownIds.length > 0 ? "unknown-ids" : "clean",
		unknownIds
	};
}
function classifyDecisionConfigHealth(env = process.env) {
	if (!(0, node_fs.existsSync)((0, node_path.join)(env.XDG_CONFIG_HOME ?? (0, node_path.join)(env.HOME ?? "", ".config"), "pantheon", "decision-router.json"))) return { status: "absent" };
	return readDecisionRouterConfig(env).corrupt ? { status: "corrupt" } : { status: "ok" };
}
Object.freeze([
	"auto",
	"pt-BR",
	"en"
]);
//#endregion
//#region src/j1-gate-status.ts
const J1_FLAG_ENV = "PANTHEON_J1_RISK_SCORE";
const J1_THRESHOLD_ENV = "PANTHEON_J1_ENFORCE_THRESHOLD";
const J1_THRESHOLD_DEFAULT = .8;
/** `1`/`on`/`true` map to `shadow` for back-compatibility with the shipped setup. */
const FLAG_ON = /* @__PURE__ */ new Set([
	"1",
	"on",
	"true",
	"shadow"
]);
function j1ModeFromEnv(env = process.env) {
	const raw = (env["PANTHEON_J1_RISK_SCORE"] ?? "").trim().toLowerCase();
	if (raw === "enforce") return "enforce";
	if (raw === "warn") return "warn";
	return FLAG_ON.has(raw) ? "shadow" : "off";
}
/** Invalid or out-of-range values fall back to the default — a typo must not disable the gate. */
function j1ThresholdFromEnv(env = process.env) {
	const text = (env["PANTHEON_J1_ENFORCE_THRESHOLD"] ?? "").trim();
	if (text === "") return J1_THRESHOLD_DEFAULT;
	const raw = Number(text);
	if (!Number.isFinite(raw) || raw < 0 || raw > 1) return J1_THRESHOLD_DEFAULT;
	return raw;
}
//#endregion
//#region src/legacy-audit.ts
/**
* legacy-audit.ts — Self-contained Legacy & Drift Auditor for the TUI Settings panel.
*
* Scans global (~/.config/opencode) and workspace (<project>) scopes for:
*   - Dead V1 hooks/files (pantheon-hooks.*, tiers.json, fastembed_cache, .migration-checkpoint)
*   - Unmigrated legacy stores (memory.db, persistence/{global,project}.db, goals.json)
*   - Redundant copied canonical Pantheon assets shadowed by native plugin transforms
*   - Drifted copied TUI plugins (plugins/pantheon-tui version != running plugin version)
*   - Old configuration backup sidecars (opencode.json.bak*, active-preset.json.bak*)
*
* Always migrates unmigrated legacy context/memory/goals BEFORE deleting obsolete stores,
* and NEVER touches user-created custom agents or custom user skills.
*/
function createSqliteDb(dbPath, options) {
	const { DatabaseSync } = (typeof require === "function" ? require : (0, node_module.createRequire)(require("url").pathToFileURL(__filename).href))("node:sqlite");
	return options ? new DatabaseSync(dbPath, options) : new DatabaseSync(dbPath);
}
const SAFE_SEGMENT_RE = /^[a-zA-Z0-9._:-]{1,128}$/;
const CANONICAL_AGENT_MD_FILES = Object.freeze([
	"aphrodite.md",
	"apollo.md",
	"athena.md",
	"demeter.md",
	"hermes.md",
	"iris.md",
	"themis.md",
	"zeus.md"
]);
const OBSOLETE_AGENT_MD_FILES = Object.freeze([
	"artemis.md",
	"gaia.md",
	"hephaestus.md",
	"mnemosyne.md",
	"nyx.md",
	"prometheus.md",
	"talos.md"
]);
const CANONICAL_COMMAND_MD_FILES = Object.freeze([
	"pantheon.md",
	"pantheon-audit.md",
	"pantheon-consolidate.md",
	"pantheon-deepwork.md",
	"pantheon-focus.md",
	"pantheon-forge.md",
	"pantheon-model.md",
	"pantheon-optimize.md",
	"pantheon-vision.md"
]);
const OBSOLETE_COMMAND_MD_FILES = Object.freeze(["pantheon-settings.md"]);
const CANONICAL_SKILL_IDS = Object.freeze([
	"agent-coordination",
	"agent-forge",
	"artifact-management",
	"auto-continue",
	"clonedeps",
	"code-review-checklist",
	"codemap",
	"context-compression",
	"council-agora",
	"fast-path-execution",
	"git-workflow-and-versioning",
	"incremental-implementation",
	"instruction-forge",
	"loop-engineering",
	"memory-bank",
	"prompt-refinery",
	"reflect",
	"security-hardening",
	"session-goal",
	"simplify",
	"spec-driven-development",
	"tdd-with-agents",
	"test-slicing",
	"verification-planning",
	"visual-review-pipeline",
	"worktrees"
]);
const LEGACY_INSTRUCTION_FILES = Object.freeze([
	"zeus-execution-rules.instructions.md",
	"zeus-orchestration.instructions.md",
	"zeus-workflow.instructions.md"
]);
const PANTHEON_LEGACY_MCP_NAMES = /* @__PURE__ */ new Set([
	"pantheon-resources",
	"pantheon-code-mode",
	"pantheon-memory",
	"pantheon-persistence",
	"pantheon-vision"
]);
const LEGACY_PYTHON_MCP_SCRIPTS = /* @__PURE__ */ new Set([
	"mcp_resources.py",
	"mcp_resources_server.py",
	"code_mode.py",
	"code_mode_server.py",
	"memory_mcp.py",
	"memory_mcp_server.py",
	"mcp_persistence.py",
	"mcp_persistence_server.py",
	"pantheon_vision.py",
	"pantheon_vision_server.py"
]);
const LEGACY_PYTHON_RUNTIME_SCRIPTS = Object.freeze([
	...LEGACY_PYTHON_MCP_SCRIPTS,
	"_pantheon_paths.py",
	"eval_store.py",
	"mcp_codemap_module.py",
	"themis_heuristic_scan.py",
	"scrub-secrets.py"
]);
function isPlainRecord(value) {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function stripJsonCommentsAndTrailingCommas(raw) {
	let out = "";
	let inString = false;
	let escaped = false;
	for (let i = 0; i < raw.length; i += 1) {
		const ch = raw[i];
		if (inString) {
			out += ch;
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === "\"") inString = false;
			continue;
		}
		if (ch === "\"") {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === "/" && raw[i + 1] === "/") {
			while (i < raw.length && raw[i] !== "\n") i += 1;
			if (i < raw.length) out += "\n";
			continue;
		}
		if (ch === "/" && raw[i + 1] === "*") {
			i += 2;
			while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i += 1;
			i += 1;
			continue;
		}
		out += ch;
	}
	return out.replace(/,\s*([}\]])/g, "$1");
}
function isPantheonMcpServer(name, entry) {
	if (PANTHEON_LEGACY_MCP_NAMES.has(name)) return true;
	if (!isPlainRecord(entry)) return false;
	return [
		"managed-by",
		"managedBy",
		"owner"
	].some((k) => typeof entry[k] === "string" && /^pantheon(?:-|$)/i.test(String(entry[k])));
}
function isLegacyOrBrokenPantheonMcp(name, entry, configDir) {
	if (!isPantheonMcpServer(name, entry) || !isPlainRecord(entry)) return {
		remove: false,
		isPython: false
	};
	const cmdList = Array.isArray(entry.command) ? entry.command.filter((x) => typeof x === "string") : typeof entry.command === "string" ? [entry.command] : [];
	const argList = Array.isArray(entry.args) ? entry.args.filter((x) => typeof x === "string") : [];
	const parts = [...cmdList, ...argList];
	const isPythonScript = parts.some((p) => LEGACY_PYTHON_MCP_SCRIPTS.has((0, node_path.basename)(p.replaceAll("\\", "/"))));
	const exe = parts[0];
	const isPythonBin = typeof exe === "string" && /(?:^|[\\/])python(?:\d+(?:\.\d+)*)?(?:\.exe)?$/i.test(exe);
	const isVenvPath = parts.some((p) => /(?:^|[\\/])\.venv(?:[\\/]|$)/.test(p));
	const isPython = isPythonScript || isPythonBin || isVenvPath;
	const cwd = typeof entry.cwd === "string" && entry.cwd.trim() !== "" ? (0, node_path.resolve)(configDir, entry.cwd) : configDir;
	const hasMissingExe = typeof exe === "string" && (exe.includes("/") || exe.includes("\\")) && !(0, node_fs.existsSync)((0, node_path.isAbsolute)(exe) ? exe : (0, node_path.resolve)(cwd, exe));
	const hasMissingScript = parts.slice(1).some((p) => {
		if (!/\.(?:py|mjs|js|ts)$/i.test(p) || p.startsWith("-")) return false;
		return !(0, node_fs.existsSync)((0, node_path.isAbsolute)(p) ? p : (0, node_path.resolve)(cwd, p));
	});
	const isBrokenLocal = (entry.type === "local" || entry.type === "stdio" || entry.type === void 0) && (hasMissingExe || hasMissingScript);
	return {
		remove: isPython || isBrokenLocal,
		isPython
	};
}
const MIN_SUPPORTED_AUDIT_VERSION = [
	2,
	3,
	0
];
function isBelowMinAuditVersion(spec) {
	const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(spec ?? "").trim());
	if (!match) return false;
	const parts = [
		Number(match[1]),
		Number(match[2]),
		Number(match[3])
	];
	for (let i = 0; i < 3; i += 1) {
		const a = parts[i] ?? 0;
		const b = MIN_SUPPORTED_AUDIT_VERSION[i] ?? 0;
		if (a !== b) return a < b;
	}
	return false;
}
function stripAuditNegation(ref) {
	return ref.startsWith("!") ? ref.slice(1).trim() : ref.trim();
}
function parseAuditPantheonSpec(ref) {
	const norm = stripAuditNegation(ref).replaceAll("\\", "/");
	const pkgMatch = /^(pantheon-opencode(?:\/(plugin|tui))?)(?:@([^\s/]+))?$/i.exec(norm);
	if (pkgMatch) return {
		kind: "package",
		base: (pkgMatch[1] ?? "").toLowerCase(),
		spec: pkgMatch[3] ?? null
	};
	const tuiMatch = /^(pantheon-tui)(?:@([^\s/]+))?$/i.exec(norm);
	if (tuiMatch) return {
		kind: "legacy-tui",
		base: "pantheon-tui",
		spec: tuiMatch[2] ?? null
	};
	if (/^npx(?:\s+-y)?\s+pantheon-(?:tui|opencode)(?:@\S+)?$/i.test(norm) || /^npx:pantheon-(?:tui|opencode)(?:@\S+)?$/i.test(norm) || /(?:^|\/)\.npm\/_npx\/[^/]+\/node_modules\/pantheon-(?:tui|opencode)(?:\/|$)/i.test(norm)) return {
		kind: "npx",
		base: norm,
		spec: null
	};
	if (/^plugins\/pantheon-tui(?:\/.*)?$/i.test(norm) || /(?:^|\/)plugins\/pantheon-tui(?:\/dist\/tui\.(?:js|tsx))?$/i.test(norm)) return {
		kind: "copied-tui",
		base: norm,
		spec: null
	};
	return null;
}
function isStaleAuditSpec(spec) {
	if (!spec) return false;
	const normalized = spec.trim().toLowerCase();
	return normalized === "next" || isBelowMinAuditVersion(normalized);
}
function getAuditPluginRef(entry) {
	if (typeof entry === "string") return entry;
	if (isPlainRecord(entry) && typeof entry.package === "string") return entry.package;
	return null;
}
function isAuditPantheonPluginRef(ref) {
	if (!ref) return false;
	if (parseAuditPantheonSpec(ref)) return true;
	const norm = stripAuditNegation(ref).replaceAll("\\", "/");
	return /pantheon-hooks(?:\.(?:ts|js|mjs))?$/i.test(norm) || /(?:^|\/)src\/plugin\.ts$/i.test(norm) || /(?:^|\/)pantheon-opencode\/src\/plugin$/i.test(norm);
}
function classifyAuditPluginEntry(entry, configDir, singularKey, hasNpmNativePlugin, unpinnedBases, plannedReplacements) {
	const ref = getAuditPluginRef(entry);
	if (!ref || !isAuditPantheonPluginRef(ref)) return null;
	if (singularKey) return { action: "remove" };
	const norm = stripAuditNegation(ref).replaceAll("\\", "/");
	if (/pantheon-hooks(?:\.(?:ts|js|mjs))?$/i.test(norm)) return { action: "remove" };
	if (/(?:^|\/)src\/plugin\.ts$/i.test(norm)) return { action: "remove" };
	const parsed = parseAuditPantheonSpec(ref);
	if (parsed?.kind === "npx" || parsed?.kind === "legacy-tui" || parsed?.kind === "copied-tui") return { action: "remove" };
	if (parsed?.kind === "package") {
		if (isStaleAuditSpec(parsed.spec)) {
			const targetBase = parsed.base === "pantheon-opencode/tui" ? "pantheon-opencode/tui" : "pantheon-opencode";
			if (unpinnedBases.has(targetBase) || targetBase === "pantheon-opencode" && unpinnedBases.has("pantheon-opencode/plugin") || plannedReplacements.has(targetBase)) return { action: "remove" };
			plannedReplacements.add(targetBase);
			return {
				action: "replace",
				replacement: targetBase
			};
		}
		return null;
	}
	if (norm.startsWith("/") || norm.startsWith(".") || norm.includes("/")) {
		const targetPath = (0, node_path.isAbsolute)(ref) ? ref : (0, node_path.resolve)(configDir, ref);
		if (!(0, node_fs.existsSync)(targetPath)) return { action: "remove" };
		if (norm.includes("/_npx/")) {
			if (hasNpmNativePlugin || unpinnedBases.has("pantheon-opencode") || unpinnedBases.has("pantheon-opencode/plugin") || plannedReplacements.has("pantheon-opencode")) return { action: "remove" };
			plannedReplacements.add("pantheon-opencode");
			return {
				action: "replace",
				replacement: "pantheon-opencode"
			};
		}
		if ((hasNpmNativePlugin || plannedReplacements.has("pantheon-opencode")) && norm.endsWith("/src/plugin")) return { action: "remove" };
	}
	return null;
}
function inspectAuditConfigFile(filePath, configDir) {
	if (!(0, node_fs.existsSync)(filePath)) return null;
	try {
		const st = (0, node_fs.lstatSync)(filePath);
		if (st.isSymbolicLink() || !st.isFile()) return null;
		const raw = (0, node_fs.readFileSync)(filePath, "utf8");
		const parsed = JSON.parse(filePath.endsWith(".jsonc") ? stripJsonCommentsAndTrailingCommas(raw) : raw);
		if (!isPlainRecord(parsed)) return null;
		const legacyMcps = [];
		if ((0, node_path.basename)(filePath) !== "tui.json" && isPlainRecord(parsed.mcp)) {
			const servers = isPlainRecord(parsed.mcp.servers) ? parsed.mcp.servers : null;
			if (servers) {
				for (const [name, entry] of Object.entries(servers)) if (isLegacyOrBrokenPantheonMcp(name, entry, configDir).remove) legacyMcps.push({
					layout: "v2",
					name
				});
			}
			for (const [name, entry] of Object.entries(parsed.mcp)) {
				if (servers && name === "servers") continue;
				if (isLegacyOrBrokenPantheonMcp(name, entry, configDir).remove) legacyMcps.push({
					layout: "v1",
					name
				});
			}
		}
		const plural = Array.isArray(parsed.plugins) ? parsed.plugins : [];
		const unpinnedBases = /* @__PURE__ */ new Set();
		for (const entry of plural) {
			const parsedRef = parseAuditPantheonSpec(getAuditPluginRef(entry) ?? "");
			if (parsedRef?.kind === "package" && !isStaleAuditSpec(parsedRef.spec)) unpinnedBases.add(parsedRef.base);
		}
		const hasNpmNativePlugin = unpinnedBases.has("pantheon-opencode") || unpinnedBases.has("pantheon-opencode/plugin");
		const isTuiCfg = (0, node_path.basename)(filePath) === "tui.json" || (0, node_path.basename)(filePath) === "cli.json";
		const legacyPlugins = [];
		const plannedReplacements = /* @__PURE__ */ new Set();
		const classifyTui = (entry) => {
			const ref = getAuditPluginRef(entry);
			if (!ref) return null;
			const cleanRef = stripAuditNegation(ref);
			if (!isAuditPantheonPluginRef(cleanRef)) return null;
			const parsedRef = parseAuditPantheonSpec(cleanRef);
			if (parsedRef?.kind === "copied-tui" || parsedRef?.kind === "legacy-tui" || parsedRef?.kind === "npx") return { action: "remove" };
			if (parsedRef?.kind === "package" && isStaleAuditSpec(parsedRef.spec)) {
				if (hasNpmNativePlugin || unpinnedBases.has("pantheon-opencode/tui")) return { action: "remove" };
				return {
					action: "replace",
					replacement: "pantheon-opencode/tui"
				};
			}
			if (hasNpmNativePlugin || ref.startsWith("!") || !(0, node_fs.existsSync)((0, node_path.resolve)(configDir, cleanRef))) return { action: "remove" };
			return null;
		};
		if (Array.isArray(parsed.plugin)) parsed.plugin.forEach((entry, index) => {
			const verdict = isTuiCfg ? classifyTui(entry) : classifyAuditPluginEntry(entry, configDir, true, hasNpmNativePlugin, unpinnedBases, plannedReplacements);
			if (verdict) legacyPlugins.push({
				key: "plugin",
				index,
				...verdict
			});
		});
		if (Array.isArray(parsed.plugins)) parsed.plugins.forEach((entry, index) => {
			const verdict = isTuiCfg ? classifyTui(entry) : classifyAuditPluginEntry(entry, configDir, false, hasNpmNativePlugin, unpinnedBases, plannedReplacements);
			if (verdict) legacyPlugins.push({
				key: "plugins",
				index,
				...verdict
			});
		});
		return {
			filePath,
			raw,
			parsed,
			legacyMcps,
			legacyPlugins
		};
	} catch {
		return null;
	}
}
function cleanAuditConfigFile(filePath, configDir, backupScopeRoot) {
	const inspected = inspectAuditConfigFile(filePath, configDir);
	if (!inspected || inspected.legacyMcps.length === 0 && inspected.legacyPlugins.length === 0) return;
	const cfg = structuredClone(inspected.parsed);
	if (isPlainRecord(cfg.mcp)) {
		const mcpObj = cfg.mcp;
		for (const item of inspected.legacyMcps) if (item.layout === "v2" && isPlainRecord(mcpObj.servers)) delete mcpObj.servers[item.name];
		else if (item.layout === "v1") delete mcpObj[item.name];
		if (isPlainRecord(mcpObj.servers) && Object.keys(mcpObj.servers).length === 0) delete mcpObj.servers;
		if (Object.keys(mcpObj).length === 0) delete cfg.mcp;
	}
	for (const key of ["plugin", "plugins"]) {
		if (!Array.isArray(cfg[key])) continue;
		const actions = new Map(inspected.legacyPlugins.filter((p) => p.key === key).map((p) => [p.index, p]));
		if (actions.size === 0) continue;
		const updated = [];
		cfg[key].forEach((entry, i) => {
			const verdict = actions.get(i);
			if (!verdict) {
				updated.push(entry);
				return;
			}
			if (verdict.action === "replace" && verdict.replacement) updated.push(isPlainRecord(entry) ? {
				...entry,
				package: verdict.replacement
			} : verdict.replacement);
		});
		cfg[key] = updated;
		if (cfg[key].length === 0 && (key === "plugin" || (0, node_path.basename)(filePath) === "tui.json" || (0, node_path.basename)(filePath) === "cli.json")) delete cfg[key];
	}
	const next = `${JSON.stringify(cfg, null, 2)}\n`;
	if (next === inspected.raw) return;
	try {
		const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
		const bdir = (0, node_path.join)(backupScopeRoot, ".pantheon", "backups", `legacy-migration-${stamp}`);
		(0, node_fs.mkdirSync)(bdir, {
			recursive: true,
			mode: 448
		});
		(0, node_fs.chmodSync)(bdir, 448);
		const bfile = (0, node_path.join)(bdir, (0, node_path.basename)(filePath));
		(0, node_fs.writeFileSync)(bfile, inspected.raw, {
			encoding: "utf8",
			mode: 384
		});
		(0, node_fs.chmodSync)(bfile, 384);
	} catch {}
	if (((0, node_path.basename)(filePath) === "tui.json" || (0, node_path.basename)(filePath) === "cli.json") && Object.keys(cfg).length === 0) {
		(0, node_fs.rmSync)(filePath, { force: true });
		return;
	}
	const st = (0, node_fs.lstatSync)(filePath);
	const tmpPath = `${filePath}.tmp-${process.pid}`;
	(0, node_fs.writeFileSync)(tmpPath, next, {
		encoding: "utf8",
		mode: st.mode & 511
	});
	(0, node_fs.renameSync)(tmpPath, filePath);
}
function resolveAuditCacheDir(env = process.env) {
	if (env.NODE_TEST_CONTEXT) return void 0;
	if (env.XDG_CACHE_HOME?.trim()) return (0, node_path.join)((0, node_path.resolve)(env.XDG_CACHE_HOME.trim()), "opencode", "npm");
	const home = env.HOME?.trim();
	return home ? (0, node_path.join)((0, node_path.resolve)(home), ".cache", "opencode", "npm") : void 0;
}
function readCachedPackageVersion(candidateDir) {
	for (const manifest of [(0, node_path.join)(candidateDir, "node_modules", "pantheon-opencode", "package.json"), (0, node_path.join)(candidateDir, "package.json")]) try {
		if (!(0, node_fs.existsSync)(manifest)) continue;
		const parsed = JSON.parse((0, node_fs.readFileSync)(manifest, "utf8"));
		if (typeof parsed.version === "string" && parsed.version.trim() !== "") return parsed.version.trim();
	} catch {}
	return null;
}
function isUnderPath(parentDir, targetPath) {
	try {
		const parentReal = (0, node_fs.realpathSync)(parentDir);
		const targetReal = (0, node_fs.realpathSync)(targetPath);
		return targetReal === parentReal || targetReal.startsWith(`${parentReal}/`);
	} catch {
		return false;
	}
}
function collectCacheAudit(cacheNpmDir, options) {
	const items = [];
	if (!(0, node_fs.existsSync)(cacheNpmDir) || cacheNpmDir === "/") return items;
	const activeBundlePath = options.activeBundlePath ?? "";
	const runningVersion = options.runningVersion ? String(options.runningVersion).trim() : "";
	const runningIsStable = runningVersion !== "" && !/-(?:beta|rc)\./i.test(runningVersion);
	const seen = /* @__PURE__ */ new Set();
	const pushCacheItem = (targetPath, reason) => {
		const resolved = (0, node_path.resolve)(targetPath);
		if (seen.has(resolved) || !(0, node_fs.existsSync)(resolved)) return;
		if (activeBundlePath && isUnderPath(resolved, activeBundlePath)) return;
		seen.add(resolved);
		items.push({
			path: resolved,
			scope: "global",
			category: "drift",
			reason,
			bytes: measurePathBytes(resolved)
		});
	};
	let channelEntries = [];
	try {
		channelEntries = (0, node_fs.readdirSync)(cacheNpmDir, { withFileTypes: true });
	} catch {
		return items;
	}
	for (const entry of channelEntries) {
		if (!entry.isDirectory()) continue;
		if (entry.name !== "pantheon-opencode" && !entry.name.startsWith("pantheon-opencode@")) continue;
		const channelDir = (0, node_path.join)(cacheNpmDir, entry.name);
		if (runningIsStable && entry.name === "pantheon-opencode@beta") {
			pushCacheItem(channelDir, "Stale @beta plugin cache coexisting with stable install");
			continue;
		}
		if (entry.name.startsWith("pantheon-opencode@")) {
			const spec = entry.name.slice(18).trim().toLowerCase();
			if (spec === "next" || isBelowMinAuditVersion(spec)) {
				pushCacheItem(channelDir, `Stale legacy plugin cache (${entry.name})`);
				continue;
			}
		}
		try {
			const revisions = (0, node_fs.readdirSync)(channelDir, { withFileTypes: true }).filter((sub) => sub.isDirectory() && sub.name !== "node_modules" && !sub.name.startsWith(".")).map((sub) => {
				const full = (0, node_path.join)(channelDir, sub.name);
				let mtime = 0;
				try {
					mtime = (0, node_fs.statSync)(full).mtimeMs;
				} catch {}
				return {
					path: full,
					mtime,
					active: Boolean(activeBundlePath && isUnderPath(full, activeBundlePath))
				};
			});
			if (revisions.length > 1) {
				revisions.sort((a, b) => Number(b.active) - Number(a.active) || b.mtime - a.mtime);
				for (const stale of revisions.slice(1)) {
					const ver = readCachedPackageVersion(stale.path);
					pushCacheItem(stale.path, ver ? `Stale cached Pantheon plugin revision (v${ver})` : "Stale cached Pantheon plugin revision");
				}
			}
		} catch {}
	}
	return items;
}
function resolveAuditGlobalDir(env = process.env) {
	if (env.PANTHEON_HOME?.trim()) return (0, node_path.resolve)(env.PANTHEON_HOME.trim());
	if (env.XDG_CONFIG_HOME?.trim()) return (0, node_path.join)((0, node_path.resolve)(env.XDG_CONFIG_HOME.trim()), "opencode");
	if (env.NODE_TEST_CONTEXT) return void 0;
	const home = env.HOME?.trim();
	return home ? (0, node_path.join)((0, node_path.resolve)(home), ".config", "opencode") : void 0;
}
function formatBytes(bytes) {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1048576).toFixed(2)} MB`;
}
function toSafeSegment(raw, fallback = "default") {
	const str = String(raw ?? "").trim().replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 128);
	if (!str || str === "." || str === ".." || !SAFE_SEGMENT_RE.test(str)) return fallback;
	return str;
}
function measurePathBytes(targetPath, depth = 0) {
	if (depth > 8) return 0;
	try {
		const st = (0, node_fs.statSync)(targetPath);
		if (st.isFile()) return st.size;
		if (!st.isDirectory()) return 0;
		let total = 0;
		for (const entry of (0, node_fs.readdirSync)(targetPath, { withFileTypes: true })) total += measurePathBytes((0, node_path.join)(targetPath, entry.name), depth + 1);
		return total;
	} catch {
		return 0;
	}
}
function samePath(a, b) {
	if ((0, node_path.resolve)(a) === (0, node_path.resolve)(b)) return true;
	if (!(0, node_fs.existsSync)(a) || !(0, node_fs.existsSync)(b)) return false;
	try {
		return (0, node_fs.realpathSync)(a) === (0, node_fs.realpathSync)(b);
	} catch {
		return false;
	}
}
function isConfinedWithin(rootDir, targetPath) {
	try {
		const realRoot = (0, node_fs.realpathSync)(rootDir);
		const parentReal = (0, node_fs.realpathSync)((0, node_path.dirname)(targetPath));
		return parentReal === realRoot || parentReal.startsWith(`${realRoot}/`);
	} catch {
		return false;
	}
}
function countTableRows(db, tableName) {
	try {
		const row = db.prepare(`SELECT count(*) AS cnt FROM "${tableName.replace(/"/g, "\"\"")}"`).get();
		return Number(row?.cnt ?? 0);
	} catch {
		return 0;
	}
}
function tableExists(db, name) {
	try {
		const row = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name);
		return Boolean(row?.name);
	} catch {
		return false;
	}
}
function collectScopeAudit(scope, baseRoot, configRoot, options) {
	const items = [];
	const seen = /* @__PURE__ */ new Set();
	let unmigratedStores = 0;
	const addItem = (filePath, category, reason) => {
		const resolved = (0, node_path.resolve)(filePath);
		if (seen.has(resolved) || !(0, node_fs.existsSync)(resolved)) return;
		seen.add(resolved);
		items.push({
			path: resolved,
			scope,
			category,
			reason,
			bytes: measurePathBytes(resolved)
		});
	};
	for (const hookName of [
		"pantheon-hooks.ts",
		"pantheon-hooks.js",
		"pantheon-hooks.mjs"
	]) addItem((0, node_path.join)(configRoot, "plugins", hookName), "hooks", "Obsolete OpenCode V1 hook plugin");
	addItem((0, node_path.join)(configRoot, "tiers.json"), "v1Obsolete", "Obsolete V1 model tiers registry");
	addItem((0, node_path.join)(baseRoot, "tiers.json"), "v1Obsolete", "Obsolete V1 model tiers registry");
	const configCandidates = /* @__PURE__ */ new Set();
	for (const dir of [baseRoot, configRoot]) for (const fileName of [
		"opencode.json",
		"opencode.jsonc",
		"tui.json"
	]) configCandidates.add((0, node_path.resolve)((0, node_path.join)(dir, fileName)));
	let removedPythonMcpInConfig = false;
	for (const cfgPath of configCandidates) {
		const inspected = inspectAuditConfigFile(cfgPath, (0, node_path.dirname)(cfgPath));
		if (!inspected) continue;
		for (const mcp of inspected.legacyMcps) {
			removedPythonMcpInConfig = true;
			items.push({
				path: `${cfgPath}#legacy-mcp:${mcp.name}`,
				scope,
				category: "v1Obsolete",
				reason: `Legacy or broken MCP entry (${mcp.name}) in ${(0, node_path.basename)(cfgPath)}`,
				bytes: 0
			});
		}
		if (inspected.legacyPlugins.length > 0) items.push({
			path: `${cfgPath}#legacy-plugin`,
			scope,
			category: "hooks",
			reason: `Legacy or broken Pantheon plugin entry in ${(0, node_path.basename)(cfgPath)}`,
			bytes: 0
		});
	}
	if (!((0, node_fs.existsSync)((0, node_path.join)(configRoot, "src", "mcp", "code_mode.py")) && (0, node_fs.existsSync)((0, node_path.join)(configRoot, "package.json"))) && (0, node_fs.existsSync)(configRoot)) {
		const scriptsDir = (0, node_path.join)(configRoot, "scripts");
		const hasPyScripts = (0, node_fs.existsSync)(scriptsDir) && LEGACY_PYTHON_RUNTIME_SCRIPTS.some((name) => (0, node_fs.existsSync)((0, node_path.join)(scriptsDir, name)));
		if ((0, node_fs.existsSync)(scriptsDir)) for (const name of LEGACY_PYTHON_RUNTIME_SCRIPTS) addItem((0, node_path.join)(scriptsDir, name), "v1Obsolete", "Obsolete legacy Python MCP script (replaced by native tools / Node MCP)");
		const reqVision = (0, node_path.join)(configRoot, "requirements-vision.txt");
		addItem(reqVision, "v1Obsolete", "Obsolete Python vision requirements file");
		const configVenv = (0, node_path.join)(configRoot, ".venv");
		if ((0, node_fs.existsSync)(configVenv) && (hasPyScripts || (0, node_fs.existsSync)(reqVision) || removedPythonMcpInConfig)) addItem(configVenv, "v1Obsolete", "Obsolete Python virtual environment for legacy MCPs");
	}
	const pantheonDir = (0, node_path.join)(baseRoot, ".pantheon");
	addItem((0, node_path.join)(pantheonDir, "fastembed_cache"), "v1Obsolete", "Unused legacy fastembed cache");
	addItem((0, node_path.join)(pantheonDir, ".fastembed"), "v1Obsolete", "Unused legacy fastembed cache");
	addItem((0, node_path.join)(baseRoot, "fastembed_cache"), "v1Obsolete", "Unused legacy fastembed cache");
	addItem((0, node_path.join)(pantheonDir, ".migration-checkpoint"), "v1Obsolete", "Stale migration checkpoint file");
	for (const bakDir of [configRoot, pantheonDir]) {
		if (!(0, node_fs.existsSync)(bakDir)) continue;
		try {
			for (const name of (0, node_fs.readdirSync)(bakDir)) if (name.startsWith("opencode.json.bak") || name.startsWith("active-preset.json.bak")) addItem((0, node_path.join)(bakDir, name), "backup", "Old configuration backup sidecar");
		} catch {}
	}
	const legacyFlatMemDb = (0, node_path.join)(pantheonDir, "memory.db");
	if ((0, node_fs.existsSync)(legacyFlatMemDb)) {
		unmigratedStores += 1;
		addItem(legacyFlatMemDb, "legacyStore", "Unmigrated flat .pantheon/memory.db");
	}
	const canonicalMemDb = (0, node_path.join)(pantheonDir, "memory", "memory.db");
	if ((0, node_fs.existsSync)(canonicalMemDb)) try {
		const db = createSqliteDb(canonicalMemDb, { readOnly: true });
		const hasLegacyVec = [
			"memories_vec",
			"vec_memories",
			"memory_embeddings",
			"memory_vectors"
		].some((t) => tableExists(db, t));
		db.close();
		if (hasLegacyVec) {
			unmigratedStores += 1;
			items.push({
				path: `${canonicalMemDb}#legacy-vec`,
				scope,
				category: "legacyStore",
				reason: "Legacy vector tables pending cleanup in memory.db",
				bytes: 0
			});
		}
	} catch {}
	for (const dbName of ["global.db", "project.db"]) {
		const persDbPath = (0, node_path.join)(pantheonDir, "persistence", dbName);
		if ((0, node_fs.existsSync)(persDbPath)) {
			unmigratedStores += 1;
			addItem(persDbPath, "legacyStore", `Unmigrated persistence/${dbName}`);
		}
	}
	const legacyGoalsJson = (0, node_path.join)(pantheonDir, "goals.json");
	if ((0, node_fs.existsSync)(legacyGoalsJson)) {
		unmigratedStores += 1;
		addItem(legacyGoalsJson, "legacyStore", "Unmigrated legacy goals.json");
	}
	if (options.includeRedundantCopiedAssets !== false) {
		for (const agentFile of CANONICAL_AGENT_MD_FILES) {
			addItem((0, node_path.join)(configRoot, "agents", agentFile), "redundantAsset", "Canonical Pantheon agent copy shadowed by native plugin transform");
			addItem((0, node_path.join)(configRoot, "agent", agentFile), "redundantAsset", "Legacy singular agent copy shadowed by native plugin transform");
			addItem((0, node_path.join)(configRoot, "prompts", agentFile), "redundantAsset", "Legacy prompt template copy provided in package");
		}
		for (const agentFile of OBSOLETE_AGENT_MD_FILES) {
			addItem((0, node_path.join)(configRoot, "agents", agentFile), "v1Obsolete", "V1-only Pantheon agent removed from the roster");
			addItem((0, node_path.join)(configRoot, "agent", agentFile), "v1Obsolete", "V1-only Pantheon agent removed from the roster");
			addItem((0, node_path.join)(configRoot, "prompts", agentFile), "v1Obsolete", "V1-only Pantheon agent prompt removed from the roster");
		}
		for (const cmdFile of CANONICAL_COMMAND_MD_FILES) {
			addItem((0, node_path.join)(configRoot, "commands", cmdFile), "redundantAsset", "Canonical Pantheon command copy shadowed by native plugin transform");
			addItem((0, node_path.join)(configRoot, "command", cmdFile), "redundantAsset", "Legacy singular command directory copy");
		}
		for (const cmdFile of OBSOLETE_COMMAND_MD_FILES) {
			addItem((0, node_path.join)(configRoot, "commands", cmdFile), "v1Obsolete", "Legacy Pantheon command removed from the server transform");
			addItem((0, node_path.join)(configRoot, "command", cmdFile), "v1Obsolete", "Legacy Pantheon command removed from the server transform");
		}
		for (const instr of LEGACY_INSTRUCTION_FILES) addItem((0, node_path.join)(configRoot, "instructions", instr), "redundantAsset", "Legacy instruction file superseded by AGENTS.global.md");
		if (!((0, node_fs.existsSync)((0, node_path.join)(configRoot, "src", "mcp", "code_mode.py")) && (0, node_fs.existsSync)((0, node_path.join)(configRoot, "package.json")))) {
			const globalAgentsCopy = (0, node_path.join)(configRoot, "AGENTS.global.md");
			if ((0, node_fs.existsSync)(globalAgentsCopy)) try {
				const st = (0, node_fs.lstatSync)(globalAgentsCopy);
				if (!st.isSymbolicLink() && st.isFile() && /<!--\s*pantheon:generated:begin|Pantheon Agent System/i.test((0, node_fs.readFileSync)(globalAgentsCopy, "utf8"))) addItem(globalAgentsCopy, "redundantAsset", "Copied AGENTS.global.md superseded by native reference transform");
			} catch {}
			const agentsCopy = (0, node_path.join)(configRoot, "AGENTS.md");
			if ((0, node_fs.existsSync)(agentsCopy)) try {
				const st = (0, node_fs.lstatSync)(agentsCopy);
				if (!st.isSymbolicLink() && st.isFile()) {
					const content = (0, node_fs.readFileSync)(agentsCopy, "utf8");
					if (/<!--\s*pantheon:generated:begin/i.test(content)) {
						const stripped = content.replace(/<!--\s*pantheon:generated:begin[\s\S]*?<!--\s*pantheon:generated:end[^\n]*-->\r?\n?/gi, "").trim();
						if (stripped === "") addItem(agentsCopy, "redundantAsset", "Copied global AGENTS.md superseded by native reference transform");
						else if (stripped !== content.trim()) items.push({
							path: `${agentsCopy}#pantheon-managed`,
							scope,
							category: "redundantAsset",
							reason: "Stale Pantheon managed region inside AGENTS.md",
							bytes: 0
						});
					}
				}
			} catch {}
		}
		for (const skillId of CANONICAL_SKILL_IDS) addItem((0, node_path.join)(configRoot, "skills", skillId), "redundantAsset", "Bundled Pantheon skill directory provided natively by plugin");
		const tuiCopyDir = (0, node_path.join)(configRoot, "plugins", "pantheon-tui");
		if ((0, node_fs.existsSync)(tuiCopyDir)) {
			let copiedVersion = "";
			try {
				copiedVersion = String(JSON.parse((0, node_fs.readFileSync)((0, node_path.join)(tuiCopyDir, "package.json"), "utf8")).version ?? "");
			} catch {
				copiedVersion = "";
			}
			const runningVersion = options.runningVersion ? String(options.runningVersion) : "";
			const drifted = Boolean(runningVersion && copiedVersion && copiedVersion !== runningVersion);
			addItem(tuiCopyDir, drifted ? "drift" : "redundantAsset", drifted ? `Copied TUI plugin v${copiedVersion} drifts from v${runningVersion}` : "Copied TUI directory superseded by npm package export");
		}
		const routingPath = (0, node_path.join)(configRoot, "routing.yml");
		if ((0, node_fs.existsSync)(routingPath)) try {
			if (/pantheon|zeus:|athena:|apollo:/i.test((0, node_fs.readFileSync)(routingPath, "utf8"))) addItem(routingPath, "redundantAsset", "Copied routing.yml superseded by bundled roster");
		} catch {}
		const isRepoRoot = (0, node_fs.existsSync)((0, node_path.join)(baseRoot, "package.json")) && (0, node_fs.existsSync)((0, node_path.join)(baseRoot, "src", "plugin.ts")) && (0, node_fs.existsSync)((0, node_path.join)(baseRoot, "src", "agents", "roster.json"));
		const statePaths = [(0, node_path.join)(configRoot, ".pantheon", "install-state.json")];
		if (!isRepoRoot) statePaths.push((0, node_path.join)(pantheonDir, "install-state.json"));
		for (const statePath of statePaths) addItem(statePath, "redundantAsset", "Legacy CLI installer manifest");
		const codeModeDirs = [(0, node_path.join)(configRoot, ".pantheon", "code-mode")];
		if (!isRepoRoot && (0, node_path.join)(pantheonDir, "code-mode") !== codeModeDirs[0]) codeModeDirs.push((0, node_path.join)(pantheonDir, "code-mode"));
		for (const cmDir of codeModeDirs) {
			if (!(0, node_fs.existsSync)(cmDir)) continue;
			try {
				for (const entry of (0, node_fs.readdirSync)(cmDir)) if (entry.endsWith(".py") || entry.endsWith(".sh") || entry === "manifest.json") addItem((0, node_path.join)(cmDir, entry), "v1Obsolete", "Obsolete Python code-mode script (replaced by native tools)");
			} catch {}
		}
	}
	return {
		items,
		unmigratedStores
	};
}
function ensureCanonicalMemoryDb(dbPath) {
	(0, node_fs.mkdirSync)((0, node_path.dirname)(dbPath), { recursive: true });
	const db = createSqliteDb(dbPath);
	db.exec(`
    PRAGMA busy_timeout = 3000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      namespace TEXT NOT NULL DEFAULT 'default',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      UNIQUE(namespace, key)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      key, value, namespace,
      content='memories',
      content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, key, value, namespace) VALUES (new.id, new.key, new.value, new.namespace);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, key, value, namespace) VALUES('delete', old.id, old.key, old.value, old.namespace);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, key, value, namespace) VALUES('delete', old.id, old.key, old.value, old.namespace);
      INSERT INTO memories_fts(rowid, key, value, namespace) VALUES (new.id, new.key, new.value, new.namespace);
    END;
  `);
	return db;
}
function migrateScopeBeforeDelete(baseRoot) {
	const pantheonDir = (0, node_path.join)(baseRoot, ".pantheon");
	if (!(0, node_fs.existsSync)(pantheonDir)) return 0;
	let migrated = 0;
	const nowIso = (/* @__PURE__ */ new Date()).toISOString();
	const flatMemDbPath = (0, node_path.join)(pantheonDir, "memory.db");
	const canonicalMemPath = (0, node_path.join)(pantheonDir, "memory", "memory.db");
	if ((0, node_fs.existsSync)(flatMemDbPath)) try {
		const src = createSqliteDb(flatMemDbPath, { readOnly: true });
		const dst = ensureCanonicalMemoryDb(canonicalMemPath);
		if (tableExists(src, "memories")) {
			const rows = src.prepare("SELECT namespace, key, value, created_at FROM memories").all();
			const insert = dst.prepare("INSERT OR IGNORE INTO memories (namespace, key, value, importance, created_at) VALUES (?, ?, ?, ?, ?)");
			dst.exec("BEGIN IMMEDIATE");
			try {
				for (const r of rows) {
					insert.run(String(r.namespace ?? "default"), String(r.key ?? ""), String(r.value ?? ""), .5, String(r.created_at ?? nowIso));
					migrated += 1;
				}
				dst.exec("COMMIT");
			} catch (txErr) {
				try {
					dst.exec("ROLLBACK");
				} catch {}
				throw txErr;
			}
		}
		src.close();
		dst.close();
	} catch {}
	if ((0, node_fs.existsSync)(canonicalMemPath)) try {
		const db = ensureCanonicalMemoryDb(canonicalMemPath);
		for (const trig of [
			"memories_vec_ai",
			"memories_vec_ad",
			"memories_vec_au"
		]) db.exec(`DROP TRIGGER IF EXISTS ${trig}`);
		for (const tbl of [
			"memories_vec",
			"vec_memories",
			"memory_embeddings",
			"memory_vectors"
		]) if (tableExists(db, tbl)) {
			db.exec(`DROP TABLE IF EXISTS ${tbl}`);
			migrated += 1;
		}
		db.close();
	} catch {}
	const persDir = (0, node_path.join)(pantheonDir, "persistence");
	for (const dbName of ["global.db", "project.db"]) {
		const dbPath = (0, node_path.join)(persDir, dbName);
		if (!(0, node_fs.existsSync)(dbPath)) continue;
		try {
			const db = createSqliteDb(dbPath, { readOnly: true });
			for (const tbl of [
				"kv",
				"kv_store",
				"context",
				"checkpoints",
				"sessions"
			]) {
				if (!tableExists(db, tbl) || countTableRows(db, tbl) === 0) continue;
				const cols = db.prepare(`PRAGMA table_info(${tbl})`).all();
				const colNames = new Set(cols.map((c) => c.name));
				const keyCol = colNames.has("key") ? "key" : colNames.has("id") ? "id" : colNames.has("session_id") ? "session_id" : null;
				const valCol = colNames.has("value") ? "value" : colNames.has("data") ? "data" : colNames.has("content") ? "content" : null;
				if (!keyCol || !valCol) continue;
				const nsSelect = colNames.has("namespace") ? "namespace" : `'${tbl === "checkpoints" || tbl === "sessions" ? "checkpoints" : "default"}' AS namespace`;
				const rows = db.prepare(`SELECT ${nsSelect}, ${keyCol} AS k, ${valCol} AS v FROM ${tbl}`).all();
				for (const r of rows) {
					const ns = toSafeSegment(r.namespace, "default");
					const key = toSafeSegment(r.k, "");
					if (!key) continue;
					const targetDir = (0, node_path.join)(persDir, ns);
					const targetFile = (0, node_path.join)(targetDir, `${key}.json`);
					if (!(0, node_fs.existsSync)(targetFile)) {
						(0, node_fs.mkdirSync)(targetDir, { recursive: true });
						(0, node_fs.writeFileSync)(targetFile, JSON.stringify({
							key,
							namespace: ns,
							value: String(r.v ?? ""),
							updated_at: nowIso
						}, null, 2), "utf8");
						migrated += 1;
					}
				}
			}
			db.close();
		} catch {}
	}
	const legacyGoalsPath = (0, node_path.join)(pantheonDir, "goals.json");
	if ((0, node_fs.existsSync)(legacyGoalsPath)) try {
		const parsed = JSON.parse((0, node_fs.readFileSync)(legacyGoalsPath, "utf8"));
		const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" && Array.isArray(parsed.goals) ? parsed.goals ?? [] : [];
		const goalsDir = (0, node_path.join)(pantheonDir, "goals");
		for (const item of list) {
			if (!item || typeof item !== "object") continue;
			const rec = item;
			const safeId = toSafeSegment(rec.id ?? rec.goal_id, "");
			if (!safeId) continue;
			const target = (0, node_path.join)(goalsDir, `${safeId}.json`);
			if (!(0, node_fs.existsSync)(target)) {
				(0, node_fs.mkdirSync)(goalsDir, { recursive: true });
				(0, node_fs.writeFileSync)(target, JSON.stringify({
					id: safeId,
					title: String(rec.title ?? rec.description ?? ""),
					criteria: Array.isArray(rec.criteria) ? rec.criteria.map(String) : [],
					status: String(rec.status ?? "active"),
					created_at: typeof rec.created_at === "string" ? rec.created_at : nowIso,
					updated_at: typeof rec.updated_at === "string" ? rec.updated_at : nowIso
				}, null, 2), "utf8");
				migrated += 1;
			}
		}
	} catch {}
	return migrated;
}
function scanLegacyArtifacts(options = {}) {
	const workspaceDir = options.workspaceDir ? (0, node_path.resolve)(options.workspaceDir) : void 0;
	const globalConfigDir = options.globalConfigDir ? (0, node_path.resolve)(options.globalConfigDir) : resolveAuditGlobalDir(options.env);
	const cacheNpmDir = options.cacheDir ? (0, node_path.resolve)(options.cacheDir) : resolveAuditCacheDir(options.env);
	const items = [];
	let unmigratedStores = 0;
	if (globalConfigDir && (0, node_fs.existsSync)(globalConfigDir) && globalConfigDir !== "/") {
		const res = collectScopeAudit("global", globalConfigDir, globalConfigDir, options);
		items.push(...res.items);
		unmigratedStores += res.unmigratedStores;
	}
	if (cacheNpmDir && (0, node_fs.existsSync)(cacheNpmDir) && cacheNpmDir !== "/") items.push(...collectCacheAudit(cacheNpmDir, options));
	if (workspaceDir && (0, node_fs.existsSync)(workspaceDir) && workspaceDir !== "/" && (!globalConfigDir || !samePath(workspaceDir, globalConfigDir))) {
		const res = collectScopeAudit("project", workspaceDir, (0, node_path.join)(workspaceDir, ".opencode"), options);
		items.push(...res.items);
		unmigratedStores += res.unmigratedStores;
	}
	const byScope = {
		global: 0,
		project: 0
	};
	const byCategory = {};
	let totalBytes = 0;
	for (const item of items) {
		byScope[item.scope] = (byScope[item.scope] ?? 0) + 1;
		byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;
		totalBytes += item.bytes;
	}
	return {
		items,
		summary: {
			total: items.length,
			totalBytes,
			unmigratedStores,
			byScope,
			byCategory
		}
	};
}
function cleanLegacyArtifacts(options = {}) {
	const workspaceDir = options.workspaceDir ? (0, node_path.resolve)(options.workspaceDir) : void 0;
	const globalConfigDir = options.globalConfigDir ? (0, node_path.resolve)(options.globalConfigDir) : resolveAuditGlobalDir(options.env);
	const cacheNpmDir = options.cacheDir ? (0, node_path.resolve)(options.cacheDir) : resolveAuditCacheDir(options.env);
	const scopeFilter = options.scope && options.scope !== "all" ? options.scope : null;
	const scan = scanLegacyArtifacts(options);
	let migratedRecords = 0;
	if (scopeFilter !== "project" && globalConfigDir && (0, node_fs.existsSync)(globalConfigDir) && globalConfigDir !== "/") migratedRecords += migrateScopeBeforeDelete(globalConfigDir);
	if (scopeFilter !== "global" && workspaceDir && (0, node_fs.existsSync)(workspaceDir) && workspaceDir !== "/" && (!globalConfigDir || !samePath(workspaceDir, globalConfigDir))) migratedRecords += migrateScopeBeforeDelete(workspaceDir);
	const removed = [];
	const errors = [];
	let reclaimedBytes = 0;
	const cleanedConfigs = /* @__PURE__ */ new Set();
	for (const item of scan.items) {
		if (scopeFilter && item.scope !== scopeFilter) continue;
		if (item.path.endsWith("#legacy-vec")) {
			removed.push(item.path);
			continue;
		}
		if (item.path.endsWith("#pantheon-managed")) {
			const agentsPath = item.path.slice(0, -17);
			const scopeRoot = item.scope === "global" ? globalConfigDir : workspaceDir;
			if (!agentsPath || !scopeRoot || !isConfinedWithin(scopeRoot, agentsPath)) {
				errors.push({
					path: item.path,
					reason: "Path escapes target scope root"
				});
				continue;
			}
			try {
				if ((0, node_fs.existsSync)(agentsPath)) {
					const stripped = (0, node_fs.readFileSync)(agentsPath, "utf8").replace(/<!--\s*pantheon:generated:begin[\s\S]*?<!--\s*pantheon:generated:end[^\n]*-->\r?\n?/gi, "").trim();
					const st = (0, node_fs.lstatSync)(agentsPath);
					const tmp = `${agentsPath}.tmp-${process.pid}`;
					(0, node_fs.writeFileSync)(tmp, stripped === "" ? "" : `${stripped}\n`, {
						encoding: "utf8",
						mode: st.mode & 511
					});
					(0, node_fs.renameSync)(tmp, agentsPath);
				}
				removed.push(item.path);
			} catch (err) {
				errors.push({
					path: item.path,
					reason: err instanceof Error ? err.message : String(err)
				});
			}
			continue;
		}
		if (item.path.includes("#legacy-mcp:") || item.path.endsWith("#legacy-plugin")) {
			const cfgPath = item.path.split("#")[0] ?? "";
			const scopeRoot = item.scope === "global" ? globalConfigDir : workspaceDir;
			if (!cfgPath || !scopeRoot || !isConfinedWithin(scopeRoot, cfgPath)) {
				errors.push({
					path: item.path,
					reason: "Path escapes target scope root"
				});
				continue;
			}
			try {
				if (!cleanedConfigs.has(cfgPath)) {
					cleanedConfigs.add(cfgPath);
					cleanAuditConfigFile(cfgPath, (0, node_path.dirname)(cfgPath), scopeRoot);
				}
				removed.push(item.path);
			} catch (err) {
				errors.push({
					path: item.path,
					reason: err instanceof Error ? err.message : String(err)
				});
			}
			continue;
		}
		const scopeRoot = item.scope === "global" ? globalConfigDir : workspaceDir;
		const confineRoot = item.scope === "global" && cacheNpmDir && isConfinedWithin(cacheNpmDir, item.path) ? cacheNpmDir : scopeRoot;
		if (!confineRoot || !isConfinedWithin(confineRoot, item.path)) {
			errors.push({
				path: item.path,
				reason: "Path escapes target scope root"
			});
			continue;
		}
		try {
			if ((0, node_fs.existsSync)(item.path)) {
				(0, node_fs.rmSync)(item.path, {
					recursive: true,
					force: true
				});
				removed.push(item.path);
				reclaimedBytes += item.bytes;
			}
			if (item.path.endsWith(".db")) for (const suffix of [
				"-wal",
				"-shm",
				"-journal"
			]) {
				const sidecar = `${item.path}${suffix}`;
				if ((0, node_fs.existsSync)(sidecar) && isConfinedWithin(confineRoot, sidecar)) {
					const sidecarBytes = measurePathBytes(sidecar);
					(0, node_fs.rmSync)(sidecar, { force: true });
					removed.push(sidecar);
					reclaimedBytes += sidecarBytes;
				}
			}
		} catch (err) {
			errors.push({
				path: item.path,
				reason: err instanceof Error ? err.message : String(err)
			});
		}
	}
	return {
		removed,
		reclaimedBytes,
		migratedRecords,
		errors
	};
}
function purgeAllPantheonData(options = {}) {
	const dryRun = options.dryRun === true;
	const workspaceDir = options.workspaceDir ? (0, node_path.resolve)(options.workspaceDir) : void 0;
	const globalConfigDir = options.globalConfigDir ? (0, node_path.resolve)(options.globalConfigDir) : resolveAuditGlobalDir(options.env);
	const scopeFilter = options.scope && options.scope !== "all" ? options.scope : null;
	const scan = scanLegacyArtifacts({
		...options,
		includeRedundantCopiedAssets: true
	});
	const removed = [];
	const errors = [];
	let reclaimedBytes = 0;
	if (!dryRun) {
		const cleanRes = cleanLegacyArtifacts({
			...options,
			includeRedundantCopiedAssets: true
		});
		removed.push(...cleanRes.removed);
		reclaimedBytes += cleanRes.reclaimedBytes;
		errors.push(...cleanRes.errors);
	}
	const purgeRoot = (rootDir, configRoot) => {
		if (!rootDir || rootDir === "/" || !(0, node_fs.existsSync)(rootDir)) return;
		if ((0, node_fs.existsSync)((0, node_path.join)(rootDir, "src", "mcp", "code_mode.py")) && (0, node_fs.existsSync)((0, node_path.join)(rootDir, "package.json"))) return;
		for (const store of [(0, node_path.join)(rootDir, ".pantheon"), (0, node_path.join)(configRoot, ".pantheon")]) {
			if (!(0, node_fs.existsSync)(store) || !isConfinedWithin(rootDir, store)) continue;
			const bytes = measurePathBytes(store);
			try {
				if (!dryRun) (0, node_fs.rmSync)(store, {
					recursive: true,
					force: true
				});
				removed.push(store);
				reclaimedBytes += bytes;
			} catch (err) {
				errors.push({
					path: store,
					reason: err instanceof Error ? err.message : String(err)
				});
			}
		}
	};
	if (scopeFilter !== "project" && globalConfigDir) purgeRoot(globalConfigDir, globalConfigDir);
	if (scopeFilter !== "global" && workspaceDir && (!globalConfigDir || !samePath(workspaceDir, globalConfigDir))) purgeRoot(workspaceDir, (0, node_path.join)(workspaceDir, ".opencode"));
	if (dryRun) {
		for (const item of scan.items) removed.push(item.path);
		reclaimedBytes += scan.summary.totalBytes;
	}
	return {
		removed: [...new Set(removed)],
		reclaimedBytes,
		migratedRecords: 0,
		errors
	};
}
//#endregion
//#region src/preset-state.ts
/**
* preset-state.ts — the Model Preset section of the settings window.
*
* TUI-local replica (the bundle must stay self-contained). The preset NAMES
* mirror routing.yml's `presets:` and are drift-pinned by
* tests/tui-preset-state.test.mjs against `loadPresetDefs()`. The marker file
* shape mirrors scripts/install/model-picker.mjs's `buildActivePresetFile`
* (version 1), and the readers (`resolveActivePreset`, vision.ts candidates)
* only consult `.preset`, so the window writes `source: 'tui-settings'`.
*
* Scope note: the window writes the GLOBAL marker only
* (`<config-dir>/opencode/.pantheon/active-preset.json`). A project marker
* wins (it precedes the global path in every runtime candidate list), so it
* is displayed read-only. `none` DELETES the marker with a .bak backup — the
* same contract as the CLI's `set-tier none`.
*/
/** Mirrors routing.yml `presets:` — drift-pinned against loadPresetDefs(). */
const PRESET_NAMES = Object.freeze([
	"go-free",
	"go-fast",
	"go-premium",
	"go-hybrid",
	"anthropic",
	"openai"
]);
function globalActivePresetPath(env = process.env) {
	const xdg = env.XDG_CONFIG_HOME;
	const home = env.HOME ?? "";
	const root = xdg ?? (0, node_path.join)(home, ".config");
	return (0, node_path.join)(root, "opencode", ".pantheon", "active-preset.json");
}
/** Fail-open read: missing/corrupt marker = no active preset. */
function readActivePresetMarker(path) {
	try {
		const raw = JSON.parse((0, node_fs.readFileSync)(path, "utf8"));
		if (typeof raw?.preset !== "string" || raw.preset === "" || raw.preset === "none") return null;
		return {
			name: raw.preset,
			updatedAt: typeof raw.updated_at === "string" ? raw.updated_at : ""
		};
	} catch {
		return null;
	}
}
function writeMarkerAtomically(path, content) {
	(0, node_fs.mkdirSync)((0, node_path.dirname)(path), { recursive: true });
	const temp = `${path}.tui.tmp`;
	(0, node_fs.writeFileSync)(temp, content);
	(0, node_fs.renameSync)(temp, path);
}
/** Select a preset globally: .bak backup, atomic write, version-1 marker. */
function writeActivePreset(path, name, nowIso = (/* @__PURE__ */ new Date()).toISOString()) {
	if (!PRESET_NAMES.includes(name)) throw new TypeError(`Refusing to persist unknown preset "${name}"`);
	backupMarker(path);
	writeMarkerAtomically(path, `${JSON.stringify({
		version: 1,
		preset: name,
		source: "tui-settings",
		updated_at: nowIso
	}, null, 2)}\n`);
}
/** Clear the global marker (the `none` contract): .bak backup, then remove. */
function clearActivePreset(path) {
	backupMarker(path);
	(0, node_fs.rmSync)(path, { force: true });
}
function backupMarker(path) {
	if (!(0, node_fs.existsSync)(path)) return;
	(0, node_fs.mkdirSync)((0, node_path.dirname)(path), { recursive: true });
	(0, node_fs.copyFileSync)(path, `${path}.bak`);
}
const VISION_MODEL_OPTIONS = Object.freeze([
	"auto",
	"opencode-go/mimo-v2.6-flash",
	"google/gemini-2.5-flash",
	"openai/gpt-5-mini",
	"anthropic/claude-3-5-haiku",
	"opencode-go/mimo-v2.5"
]);
function visionConfigPaths(cwd = process.cwd(), env = process.env) {
	const home = env.HOME ?? "";
	const xdg = env.XDG_CONFIG_HOME ?? (0, node_path.join)(home, ".config");
	return [(0, node_path.join)(cwd, ".opencode", "opencode-vision.json"), (0, node_path.join)(xdg, "opencode", "opencode-vision.json")];
}
function readConfiguredVisionModel(cwd = process.cwd(), env = process.env) {
	for (const path of visionConfigPaths(cwd, env)) try {
		if ((0, node_fs.existsSync)(path)) {
			const parsed = JSON.parse((0, node_fs.readFileSync)(path, "utf8"));
			if (typeof parsed?.visionModel === "string" && parsed.visionModel.trim()) return parsed.visionModel.trim();
		}
	} catch {}
	return "auto";
}
function writeConfiguredVisionModel(model, cwd = process.cwd(), env = process.env) {
	const home = env.HOME ?? "";
	const xdg = env.XDG_CONFIG_HOME ?? (0, node_path.join)(home, ".config");
	const projectDir = (0, node_path.join)(cwd, ".opencode");
	const targetPath = (0, node_fs.existsSync)(projectDir) ? (0, node_path.join)(projectDir, "opencode-vision.json") : (0, node_path.join)(xdg, "opencode", "opencode-vision.json");
	let current = {};
	try {
		if ((0, node_fs.existsSync)(targetPath)) current = JSON.parse((0, node_fs.readFileSync)(targetPath, "utf8"));
	} catch {
		current = {};
	}
	if (model === "auto" || !model.trim()) delete current.visionModel;
	else current.visionModel = model.trim();
	(0, node_fs.mkdirSync)((0, node_path.dirname)(targetPath), { recursive: true });
	const temp = `${targetPath}.tui.tmp`;
	(0, node_fs.writeFileSync)(temp, `${JSON.stringify(current, null, 2)}\n`, "utf8");
	(0, node_fs.renameSync)(temp, targetPath);
}
/** The staged value 'none' means: delete the global marker (the CLI contract). */
const PRESET_NONE = "none";
Object.freeze([PRESET_NONE, ...PRESET_NAMES]);
//#endregion
//#region src/tui-prefs.ts
const GAUGE_STYLES = Object.freeze([
	"both",
	"bar",
	"percent",
	"off"
]);
Object.freeze(["enabled", "disabled"]);
const BAR_SHAPES_CYCLE = Object.freeze([
	"smooth",
	"line",
	"block",
	"ascii",
	"dots",
	"braille"
]);
const BAR_WIDTHS_CYCLE = Object.freeze([
	"standard",
	"compact",
	"wide",
	"full"
]);
const LAYOUT_PRESETS_CYCLE = Object.freeze(["comfortable", "compact"]);
const SEPARATOR_STYLES_CYCLE = Object.freeze([
	"spaces",
	"pipes",
	"dots",
	"slashes"
]);
const SETTINGS_VIEW_MODES = Object.freeze([
	"docked",
	"fullscreen",
	"dialog"
]);
const LANGUAGE_CYCLE = Object.freeze([
	"auto",
	"pt-BR",
	"en"
]);
const THEME_MODES_CYCLE = Object.freeze([
	"auto",
	"dark",
	"light"
]);
const ACCENT_COLORS_CYCLE = Object.freeze([
	"host",
	"pantheon",
	"emerald",
	"cyan",
	"amber",
	"purple",
	"rose"
]);
const DEFAULT_TUI_PREFS = {
	version: 1,
	layout: {
		preset: "comfortable",
		separator: "spaces",
		settingsView: "docked",
		language: "auto"
	},
	theme: {
		mode: "auto",
		accent: "host"
	},
	sidebar: {
		header: {
			version: true,
			preset: true,
			session: true
		},
		pinnedSessions: [],
		blocks: {
			context: true,
			git: true,
			todo: true,
			dispatch: true
		},
		context: {
			gauge: "both",
			barShape: "smooth",
			barWidth: "standard",
			evenMark: false,
			tokens: true,
			spent: true,
			modelUsage: true,
			performance: true,
			localSpend: true,
			turnCost: true,
			tokenAnatomy: true
		}
	},
	footer: {
		prompt: true,
		home: true
	}
};
function asBool(value, fallback) {
	return typeof value === "boolean" ? value : fallback;
}
/** Deep-merge stored JSON over the defaults; unknown keys and junk are ignored. */
function normalizeTuiPrefs(raw) {
	const stored = typeof raw === "object" && raw !== null ? raw : {};
	const layout = typeof stored.layout === "object" && stored.layout !== null ? stored.layout : {};
	const sidebar = typeof stored.sidebar === "object" && stored.sidebar !== null ? stored.sidebar : {};
	const header = typeof sidebar.header === "object" && sidebar.header !== null ? sidebar.header : {};
	const blocks = typeof sidebar.blocks === "object" && sidebar.blocks !== null ? sidebar.blocks : {};
	const context = typeof sidebar.context === "object" && sidebar.context !== null ? sidebar.context : {};
	const footer = typeof stored.footer === "object" && stored.footer !== null ? stored.footer : {};
	const rawTheme = typeof stored.theme === "object" && stored.theme !== null ? stored.theme : {};
	const themeMode = THEME_MODES_CYCLE.includes(rawTheme.mode) ? rawTheme.mode : DEFAULT_TUI_PREFS.theme?.mode ?? "auto";
	const themeAccent = ACCENT_COLORS_CYCLE.includes(rawTheme.accent) ? rawTheme.accent : DEFAULT_TUI_PREFS.theme?.accent ?? "host";
	const preset = LAYOUT_PRESETS_CYCLE.includes(layout.preset) ? layout.preset : DEFAULT_TUI_PREFS.layout.preset;
	const separator = SEPARATOR_STYLES_CYCLE.includes(layout.separator) ? layout.separator : DEFAULT_TUI_PREFS.layout.separator;
	const settingsView = SETTINGS_VIEW_MODES.includes(layout.settingsView) ? layout.settingsView : DEFAULT_TUI_PREFS.layout.settingsView;
	const language = LANGUAGE_CYCLE.includes(layout.language) ? layout.language : DEFAULT_TUI_PREFS.layout.language;
	const gauge = GAUGE_STYLES.includes(context.gauge) ? context.gauge : DEFAULT_TUI_PREFS.sidebar.context.gauge;
	const barShape = BAR_SHAPES_CYCLE.includes(context.barShape) ? context.barShape : DEFAULT_TUI_PREFS.sidebar.context.barShape;
	const barWidth = BAR_WIDTHS_CYCLE.includes(context.barWidth) ? context.barWidth : DEFAULT_TUI_PREFS.sidebar.context.barWidth;
	const evenMark = asBool(context.evenMark, DEFAULT_TUI_PREFS.sidebar.context.evenMark);
	return {
		version: 1,
		layout: {
			preset,
			separator,
			settingsView,
			language
		},
		theme: {
			mode: themeMode,
			accent: themeAccent
		},
		sidebar: {
			header: {
				version: asBool(header.version, true),
				preset: asBool(header.preset, true),
				session: asBool(header.session, true)
			},
			pinnedSessions: Array.isArray(sidebar.pinnedSessions) ? sidebar.pinnedSessions.filter((s) => typeof s === "string") : [],
			blocks: {
				context: asBool(blocks.context, true),
				git: asBool(blocks.git, true),
				todo: asBool(blocks.todo, true),
				dispatch: asBool(blocks.dispatch, true)
			},
			context: {
				gauge,
				barShape,
				barWidth,
				evenMark,
				tokens: asBool(context.tokens, true),
				spent: asBool(context.spent, true),
				modelUsage: asBool(context.modelUsage, true),
				performance: asBool(context.performance, true),
				localSpend: asBool(context.localSpend, true),
				turnCost: asBool(context.turnCost, true),
				tokenAnatomy: asBool(context.tokenAnatomy, true)
			}
		},
		footer: {
			prompt: asBool(footer.prompt, true),
			home: asBool(footer.home, true)
		}
	};
}
/**
* Apply one staged row INTO a prefs draft (in place — the storage mutate
* callback hands an immer-style draft). Unknown ids or junk values are no-ops.
*/
function applyTuiRow(draft, id, value) {
	const enabled = value === "enabled";
	switch (id) {
		case "tui.layout.preset":
			if (LAYOUT_PRESETS_CYCLE.includes(value)) {
				if (!draft.layout) draft.layout = { ...DEFAULT_TUI_PREFS.layout };
				draft.layout.preset = value;
			}
			return;
		case "tui.layout.separator":
			if (SEPARATOR_STYLES_CYCLE.includes(value)) {
				if (!draft.layout) draft.layout = { ...DEFAULT_TUI_PREFS.layout };
				draft.layout.separator = value;
			}
			return;
		case "tui.layout.settingsView":
			if (SETTINGS_VIEW_MODES.includes(value)) {
				if (!draft.layout) draft.layout = { ...DEFAULT_TUI_PREFS.layout };
				draft.layout.settingsView = value;
			}
			return;
		case "tui.layout.language":
			if (LANGUAGE_CYCLE.includes(value)) {
				if (!draft.layout) draft.layout = { ...DEFAULT_TUI_PREFS.layout };
				draft.layout.language = value;
			}
			return;
		case "tui.theme.mode":
			if (THEME_MODES_CYCLE.includes(value)) {
				if (!draft.theme) draft.theme = { ...DEFAULT_TUI_PREFS.theme };
				draft.theme.mode = value;
			}
			return;
		case "tui.theme.accent":
			if (ACCENT_COLORS_CYCLE.includes(value)) {
				if (!draft.theme) draft.theme = { ...DEFAULT_TUI_PREFS.theme };
				draft.theme.accent = value;
			}
			return;
		case "tui.sidebar.context.barShape":
			if (BAR_SHAPES_CYCLE.includes(value)) draft.sidebar.context.barShape = value;
			return;
		case "tui.sidebar.context.barWidth":
			if (BAR_WIDTHS_CYCLE.includes(value)) draft.sidebar.context.barWidth = value;
			return;
		case "tui.sidebar.context.evenMark":
			draft.sidebar.context.evenMark = enabled;
			return;
		case "tui.sidebar.header.version":
			draft.sidebar.header.version = enabled;
			return;
		case "tui.sidebar.header.preset":
			draft.sidebar.header.preset = enabled;
			return;
		case "tui.sidebar.header.session":
			draft.sidebar.header.session = enabled;
			return;
		case "tui.sidebar.block.context":
			draft.sidebar.blocks.context = enabled;
			return;
		case "tui.sidebar.block.git":
			draft.sidebar.blocks.git = enabled;
			return;
		case "tui.sidebar.block.todo":
			draft.sidebar.blocks.todo = enabled;
			return;
		case "tui.sidebar.block.dispatch":
			draft.sidebar.blocks.dispatch = enabled;
			return;
		case "tui.sidebar.context.gauge":
			if (GAUGE_STYLES.includes(value)) draft.sidebar.context.gauge = value;
			return;
		case "tui.sidebar.context.tokens":
			draft.sidebar.context.tokens = enabled;
			return;
		case "tui.sidebar.context.spent":
			draft.sidebar.context.spent = enabled;
			return;
		case "tui.sidebar.context.modelUsage":
			draft.sidebar.context.modelUsage = enabled;
			return;
		case "tui.sidebar.context.performance":
			draft.sidebar.context.performance = enabled;
			return;
		case "tui.sidebar.context.localSpend":
			draft.sidebar.context.localSpend = enabled;
			return;
		case "tui.sidebar.context.turnCost":
			draft.sidebar.context.turnCost = enabled;
			return;
		case "tui.sidebar.context.tokenAnatomy":
			draft.sidebar.context.tokenAnatomy = enabled;
			return;
		case "tui.footer.prompt":
			draft.footer.prompt = enabled;
			return;
		case "tui.footer.home":
			draft.footer.home = enabled;
			return;
		default: return;
	}
}
//#endregion
//#region src/update-status.ts
/** The running version's channel: a `-beta.N` suffix rides the beta dist-tag. */
function updateChannelFor(version) {
	return /-beta\.\d+$/.test(version) ? "beta" : "stable";
}
/** The npm dist-tag the registry check should query for the channel. */
function registryTagForChannel(channel) {
	return channel === "beta" ? "beta" : "latest";
}
function registryUrlForChannel(channel) {
	return `https://registry.npmjs.org/pantheon-opencode/${registryTagForChannel(channel)}`;
}
const EMPTY_HIGHLIGHTS = {
	version: null,
	found: false,
	groups: [],
	totalItems: 0,
	truncated: false
};
/** Escape regex metacharacters so a version like 1.0.0 matches literally. */
function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
* Extract the body of a version section from changelog text — inline replica
* of scripts/changelog-extract.mjs `extractSection` (see that file for the
* full contract: `## [<version>] - YYYY-MM-DD`, leading `v` and the date
* optional, `## [Unreleased]` never matched).
*/
function extractSection(changelogText, version) {
	const normalized = String(version).trim().replace(/^v/i, "");
	if (!normalized || /^unreleased$/i.test(normalized)) return {
		found: false,
		body: null
	};
	const escaped = escapeRegExp(normalized);
	const match = new RegExp(`^##[ \\t]+\\[v?${escaped}\\](?:[ \\t]*-[ \\t]*\\d{4}-\\d{2}-\\d{2})?(?=[ \\t]|$)`, "m").exec(changelogText);
	if (!match) return {
		found: false,
		body: null
	};
	const newline = changelogText.indexOf("\n", match.index);
	const start = newline === -1 ? changelogText.length : newline + 1;
	const nextHeading = /^##[ \t]+\[/m.exec(changelogText.slice(start));
	const end = nextHeading ? start + nextHeading.index : changelogText.length;
	return {
		found: true,
		body: changelogText.slice(start, end).trim()
	};
}
/**
* Reduce one markdown line to plain text: links keep their label, emphasis
* and inline-code markers are dropped, HTML comment fragments are removed,
* and whitespace collapses. Deliberately simple — the input is our own
* CHANGELOG (lint-capped at 200 chars per bullet), not hostile input.
*/
function stripMarkdown(text) {
	return text.replace(/<!--[\s\S]*?-->/g, " ").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/(\*\*|__)/g, "").replace(/`/g, "").replace(/\s+/g, " ").trim();
}
/** Strip the leading H3 marker (`### Added` → `Added`). */
function stripHeading(text) {
	return text.replace(/^#{1,6}[ \t]+/, "").trim();
}
/**
* Extract the curated summary block (`### 🆕 What's New` or `## 🆕 What's New`)
* from a section body: its bullets only, each truncated to
* WHATS_NEW_ITEM_MAX_CHARS, capped to WHATS_NEW_SUMMARY_MAX_ITEMS. Null when
* the section carries no summary block (the full-section fallback applies).
*/
function extractWhatsNewSummary(body) {
	const lines = body.split("\n");
	const start = lines.findIndex((line) => /^#{2,3}[ \t]+.*What'?s New/i.test(line.trim()));
	if (start === -1) return null;
	const items = [];
	for (const rawLine of lines.slice(start + 1)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("<!--")) continue;
		if (/^#{1,6}[ \t]/.test(line)) break;
		if (!/^[-*][ \t]/.test(line)) continue;
		if (items.length >= 6) break;
		const content = stripMarkdown(line.replace(/^[-*][ \t]+/, ""));
		if (content === "") continue;
		items.push(content.length > 140 ? `${content.slice(0, 139)}…` : content);
	}
	return items.length > 0 ? items : null;
}
/**
* Extract the release highlights for `version`. When the section carries a
* curated `🆕 What's New` summary block, THE WINDOW SHOWS ONLY THAT (the
* full Added/Changed/Fixed walls are for the CHANGELOG readers, not the
* dialog); otherwise it falls back to the H3-group extraction bounded to
* WHATS_NEW_MAX_ITEMS bullets. A missing section, a bullet-less section or a
* blank changelog all return EMPTY_HIGHLIGHTS (no window).
*/
function extractHighlights(changelogText, version) {
	const { found, body } = extractSection(changelogText ?? "", version ?? "");
	if (!found || !body) return { ...EMPTY_HIGHLIGHTS };
	const summary = extractWhatsNewSummary(body);
	if (summary !== null) return {
		version: String(version).trim().replace(/^v/i, ""),
		found: true,
		groups: [{
			heading: null,
			items: summary
		}],
		totalItems: summary.length,
		truncated: false
	};
	const groups = [];
	let totalItems = 0;
	let truncated = false;
	for (const rawLine of body.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("<!--")) continue;
		if (/^#{1,6}[ \t]/.test(line)) {
			const heading = stripMarkdown(stripHeading(line));
			if (heading === "") continue;
			if (groups.at(-1)?.items.length === 0) groups.pop();
			groups.push({
				heading,
				items: []
			});
			continue;
		}
		if (totalItems >= 12) {
			if (/^[-*][ \t]/.test(line)) totalItems += 1;
			continue;
		}
		const isBullet = /^[-*][ \t]/.test(line);
		const continuation = (groups.at(-1)?.items.length ?? 0) > 0;
		if (!isBullet && !continuation) continue;
		const content = stripMarkdown(isBullet ? line.replace(/^[-*][ \t]+/, "") : line);
		if (content === "") continue;
		const bounded = content.length > 140 ? `${content.slice(0, 139)}…` : content;
		const group = groups.at(-1);
		if (group === void 0) groups.push({
			heading: null,
			items: [bounded]
		});
		else if (isBullet || group.items.length === 0) group.items.push(bounded);
		else group.items[group.items.length - 1] = `${group.items.at(-1)} ${bounded}`.trim();
		if (isBullet) totalItems += 1;
	}
	const kept = groups.filter((group) => group.items.length > 0);
	truncated = totalItems > 12;
	return {
		version: found ? String(version).trim().replace(/^v/i, "") : null,
		found,
		groups: kept,
		totalItems,
		truncated
	};
}
/**
* Candidate CHANGELOG.md locations for a bundle, first readable wins:
*   1. the plugin copy root (`<configDir>/plugins/pantheon-tui/CHANGELOG.md`,
*      shipped by both installers next to package.json);
*   2. the package root (dev checkout; also an npm-package install when the
*      bundle runs from `<pkg>/src/plugins/tui/dist/`).
*/
function changelogCandidates(bundlePath) {
	const dist = (0, node_path.dirname)(bundlePath);
	const copyRoot = (0, node_path.dirname)(dist);
	const packageRoot = (0, node_path.dirname)((0, node_path.dirname)((0, node_path.dirname)(copyRoot)));
	return [(0, node_path.join)(copyRoot, "CHANGELOG.md"), (0, node_path.join)(packageRoot, "CHANGELOG.md")];
}
/** Read the first existing candidate; null when none is readable (no window). */
async function readChangelogForBundle(bundleUrl) {
	try {
		const bundlePath = (0, node_url.fileURLToPath)(bundleUrl);
		for (const candidate of changelogCandidates(bundlePath)) try {
			return await (0, node_fs_promises.readFile)(candidate, "utf8");
		} catch {}
		return null;
	} catch {
		return null;
	}
}
//#endregion
//#region src/gui.tsx
/** @jsxImportSource solid-js */
/**
* gui.tsx — Native OpenCode Desktop GUI plugin (`./gui-experimental`).
*
* Provides:
* - Side Panel (`Pantheon Cockpit`) with Olympus Topology (DAG + Timeline/Gantt
*   + replay scrubber), interactive Agora Board (`#seq` stream + post), Ephemeral
*   & Bots (`state.json` + `board-signals/*.signal.json`), and Settings/Cost.
* - `ComposerPill` (`pantheon.status`) showing live bots & quick actions.
* - Interactive `SettingsPage` (`Pantheon`) in Desktop Settings reading/writing
*   overrides via Electron `main(ctx)` IPC + host `tui-prefs` storage.
* - Slash commands `/pantheon-cockpit` and `/pantheon-settings`.
*/
var _tmpl$ = /*#__PURE__*/ (0, solid_js_web.template)(`<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border-radius:4px;border:1px solid #ef4444;color:#fca5a5"><span></span><button type=button style=border:none;background:transparent;color:inherit;cursor:pointer>✕`);
var _tmpl$2 = /*#__PURE__*/ (0, solid_js_web.template)(`<svg viewBox="0 0 640 200"style=width:100%;height:200px><title>Olympus Topology DAG</title><rect x=245 y=10 width=150 height=36 rx=6 fill=none stroke=#fba970 stroke-width=2></rect><text x=320 y=32 text-anchor=middle fill=currentColor font-size=12 font-weight=600>zeus (root)`);
var _tmpl$3 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:10px><div style=display:flex;justify-content:space-between;align-items:center><div style=display:flex;align-items:center;gap:8px><input type=range min=0><span style=opacity:0.75></span></div><div style=display:flex;gap:6px><button type=button style="padding:2px 8px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);cursor:pointer">DAG Pillars</button><button type=button style="padding:2px 8px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);cursor:pointer">Timeline`);
var _tmpl$4 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:8px><div style=display:flex;gap:6px><input type=text placeholder=Channel style="width:90px;padding:4px 6px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);background:transparent;color:inherit"><input type=text placeholder="Post message to Agora Board (@agent)..."style="flex:1;padding:4px 8px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);background:transparent;color:inherit"><button type=button style="padding:4px 10px;border-radius:4px;border:none;background:#fba970;color:#111;font-weight:600;cursor:pointer">Send`);
var _tmpl$5 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:8px>`);
var _tmpl$6 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:10px;padding:12px;font-size:12px;height:100%;overflow:auto><div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border-weak-base, #2e2e32);padding-bottom:8px"><div style=display:flex;align-items:center;gap:8px><span style=font-weight:600>Pantheon Cockpit</span><span style=opacity:0.7></span></div><div style=display:flex;align-items:center;gap:10px><span style=opacity:0.8></span><button type=button style="padding:2px 8px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);background:transparent;color:inherit;cursor:pointer">Refresh</button></div></div><div style="display:flex;gap:12px;border-bottom:1px solid var(--border-weak-base, #2e2e32)">`);
var _tmpl$7 = /*#__PURE__*/ (0, solid_js_web.template)(`<button type=button style="padding:4px 2px 8px;border:none;background:transparent;color:inherit;cursor:pointer">`);
var _tmpl$8 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:6px>`);
var _tmpl$9 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;align-items:center;gap:8px><span style=width:96px;font-family:monospace></span><div style=flex:1;height:10px;background:rgba(128,128,128,0.18);border-radius:4px;overflow:hidden><div style=height:100%>`);
var _tmpl$0 = /*#__PURE__*/ (0, solid_js_web.template)(`<svg><g><path fill=none stroke=#38bdf8 stroke-width=1.5></path><rect y=104 width=110 height=40 rx=6 fill=none stroke=#38bdf8 stroke-width=1.4></rect><text y=128 text-anchor=middle fill=currentColor font-size=11></svg>`, false, true, false);
var _tmpl$1 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=opacity:0.6>No board messages recorded yet.`);
var _tmpl$10 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style="padding:8px;border-radius:6px;border:1px solid var(--border-weak-base, #2e2e32)"><div style=display:flex;justify-content:space-between;opacity:0.75><span></span><span></span></div><div style=margin-top:4px>`);
var _tmpl$11 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=opacity:0.6>No active background jobs or subagent runs.`);
var _tmpl$12 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style="display:flex;justify-content:space-between;padding:8px;border-radius:6px;border:1px solid var(--border-weak-base, #2e2e32)"><span></span><span>`);
var _tmpl$13 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=opacity:0.8>`);
var _tmpl$14 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style="display:flex;justify-content:space-between;padding:6px 8px;border-radius:6px;border:1px solid var(--border-weak-base, #2e2e32);opacity:0.85"><span></span><span style=opacity:0.75>`);
var _tmpl$15 = /*#__PURE__*/ (0, solid_js_web.template)(`<span style=opacity:0.65;font-size:10px>`);
var _tmpl$16 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div style=display:flex;flex-direction:column><span style=font-size:12px></span></div><button type=button>`);
var _tmpl$17 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:4px><div><span style=font-size:12px></span><span style=opacity:0.7;font-family:monospace;font-size:11px></span></div><div style=display:flex;flex-wrap:wrap;gap:4px>`);
var _tmpl$18 = /*#__PURE__*/ (0, solid_js_web.template)(`<button type=button>`);
var _tmpl$19 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;border-radius:4px;border:1px solid #fba970;color:#fdba74;font-size:11px"><span></span><button type=button style=border:none;background:transparent;color:inherit;cursor:pointer>✕`);
var _tmpl$20 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style="display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--border-weak-base, #2e2e32);padding-top:6px"><span style=opacity:0.75;font-size:11px>30d Model Breakdown`);
var _tmpl$21 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div style=font-weight:600>OpenCode Spend (Today / 30d)</div><div><span>Total Cost</span><span style=font-family:monospace;font-weight:600>`);
var _tmpl$22 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div><span>Auto-Permissions Gate</span><div style=display:flex;gap:4px></div></div><div><span>Cockpit Auto-Open</span><button type=button></button></div><div><span>Show Todo Block in Cockpit</span><button type=button>`);
var _tmpl$23 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=opacity:0.75;font-size:11px>`);
var _tmpl$24 = /*#__PURE__*/ (0, solid_js_web.template)(`<span style=color:#fca5a5;font-size:11px>Global overrides file is unreadable — repair with \`doctor --fix\` before editing.`);
var _tmpl$25 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div><span style=font-weight:600>Overrides Scope</span><div style=display:flex;gap:4px>`);
var _tmpl$26 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div><span style=font-weight:600>Model Preset (Global)</span><span style=opacity:0.7;font-family:monospace;font-size:11px></span></div><div style=display:flex;flex-wrap:wrap;gap:4px>`);
var _tmpl$27 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div><span style=font-weight:600>Vision Model (vision_describe)</span><span style=opacity:0.7;font-family:monospace;font-size:11px></span></div><div style=display:flex;flex-wrap:wrap;gap:4px>`);
var _tmpl$28 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div style=font-weight:600>Per-Agent Model Overrides (.pantheon/active-preset.json)`);
var _tmpl$29 = /*#__PURE__*/ (0, solid_js_web.template)(`<span style=color:#fca5a5;font-size:11px>decision-router.json is corrupt — repair via \`decision-router setup-model\`.`);
var _tmpl$30 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=opacity:0.75;font-size:11px;font-family:monospace>`);
var _tmpl$31 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div style=font-weight:600>Decision Assistant (Jev)</div><div><span>Jev Assistant</span><button type=button></button></div><div><span>Operation Mode</span><div style=display:flex;gap:4px></div></div><div style=display:flex;flex-direction:column;gap:4px><div><span>Decision Model Target</span><span style=opacity:0.7;font-family:monospace;font-size:11px></span></div><div style=display:flex;flex-wrap:wrap;gap:4px></div></div><div><span>Cloud API Egress Consent</span><button type=button>`);
var _tmpl$32 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div style=font-weight:600>Provider Credentials (Status Only)`);
var _tmpl$33 = /*#__PURE__*/ (0, solid_js_web.template)(`<span style=color:#f59e0b;font-size:11px>Restart OpenCode to apply`);
var _tmpl$34 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div><span style=font-weight:600>Auto-Continue Loop (goal_loop)</span></div><div><span>Enabled</span><button type=button></button></div><div><span>Max Continuations</span><div style=display:flex;gap:4px></div></div><div><span>Cooldown (ms)</span><div style=display:flex;gap:4px>`);
var _tmpl$35 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div style=font-weight:600>Decision Budgets (Jev)</div><div><span>Monthly Cap (USD)</span><div style=display:flex;flex-wrap:wrap;gap:4px></div></div><div><span>Per-Decision Cap</span><div style=display:flex;flex-wrap:wrap;gap:4px>`);
var _tmpl$36 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div style=font-weight:600>J1 Safety Risk Gate (Startup Env)</div><div><span>Operation Mode</span><span style=font-family:monospace></span></div><div><span>Enforce Threshold</span><span style=font-family:monospace></span></div><div><span>Gate Status</span><span style=font-family:monospace></span></div><span style=opacity:0.65;font-size:10px>`);
var _tmpl$37 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div style=font-weight:600>Preset & Layout`);
var _tmpl$38 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div style=font-weight:600>Colors & Theme`);
var _tmpl$39 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div style=font-weight:600>Bars & Gauges`);
var _tmpl$40 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div style=font-weight:600>Sidebar Header, Blocks & Footers`);
var _tmpl$41 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div style=font-weight:600>Plugin Updates</div><div><span>Channel</span><div style=display:flex;gap:4px></div></div><div><span>Latest Registry Version</span><span style=font-family:monospace></span></div><div style=display:flex;gap:6px;flex-wrap:wrap><button type=button></button><button type=button>`);
var _tmpl$42 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div style=font-weight:600>Legacy, Drift & Cleanup</div><div><span>Audit Status</span><span style=font-family:monospace></span></div><div style=display:flex;gap:6px;flex-wrap:wrap><button type=button></button><button type=button></button><button type=button style="border:1px solid #ef4444">`);
var _tmpl$43 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div style=font-weight:600>Doctor Health (File-Derived)</div><div><span>Install Version</span><span style=font-family:monospace></span></div><div><span></span><span style=font-family:monospace></span></div><div><span>Overrides Health</span><span style=font-family:monospace></span></div><div><span>Decision Config</span><span style=font-family:monospace>`);
var _tmpl$44 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div style=font-weight:600>`);
var _tmpl$45 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div style=font-weight:600>Native Tools (30)`);
var _tmpl$46 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:10px><div style=display:flex;flex-wrap:wrap;gap:4px>`);
var _tmpl$47 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=font-size:11px;font-family:monospace><span style=opacity:0.9></span><span style=opacity:0.75>`);
var _tmpl$48 = /*#__PURE__*/ (0, solid_js_web.template)(`<span style=opacity:0.65;font-size:10px> (project)`);
var _tmpl$49 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div style=display:flex;flex-direction:column><span></span><span style=opacity:0.65;font-size:10px></span></div><button type=button>`);
var _tmpl$50 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;gap:6px;align-items:center><input type=text placeholder="provider/model-id (empty = clear)"style="flex:1;padding:3px 6px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);background:transparent;color:inherit;font-family:monospace;font-size:11px"><select style="padding:3px 6px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);background:#18181b;color:inherit;font-size:11px"><option value=default>default</option><option value=low>low</option><option value=medium>medium</option><option value=high>high</option></select><button type=button>Save`);
var _tmpl$51 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:4px><div><span style=font-family:monospace;font-weight:600></span><div style=display:flex;align-items:center;gap:6px><span style=opacity:0.8;font-family:monospace;font-size:11px></span><button type=button>`);
var _tmpl$52 = /*#__PURE__*/ (0, solid_js_web.template)(`<div><div style=display:flex;flex-direction:column><span style=font-family:monospace;font-size:11px></span><span style=opacity:0.65;font-size:10px></span></div><span style=font-family:monospace;font-size:11px>`);
var _tmpl$53 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=font-size:11px><strong></strong><span style=opacity:0.75>`);
var _tmpl$54 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=display:flex;flex-direction:column;gap:2px><div><span style=font-size:11px;font-weight:600></span><span style=font-family:monospace;font-size:10px;opacity:0.8></span></div><span style=opacity:0.65;font-size:10px;font-family:monospace>`);
var _tmpl$55 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style="padding:6px 8px;border-radius:4px;border:1px solid #ef4444;color:#fca5a5;font-size:12px">`);
var _tmpl$56 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=padding:16px;display:flex;flex-direction:column;gap:12px><div style=display:flex;justify-content:space-between;align-items:center><h2 style=font-size:16px;font-weight:600></h2><button type=button style="padding:2px 8px;border-radius:4px;border:1px solid var(--border-weak-base, #3f3f46);background:transparent;color:inherit;cursor:pointer">Refresh</button></div><p style=font-size:12px;opacity:0.7>Olympus Topology, interactive Agora Board, and Ephemeral Worker telemetry are active in the Pantheon side panel.`);
var _tmpl$57 = /*#__PURE__*/ (0, solid_js_web.template)(`<div style=padding:12px><div style=display:flex;justify-content:space-between;margin-bottom:8px><strong>Pantheon Cockpit</strong><button type=button>Close`);
const KNOWN_AGENTS = [
	"zeus",
	"athena",
	"apollo",
	"hermes",
	"aphrodite",
	"demeter",
	"themis",
	"iris"
];
function resolveRunningVersion() {
	return "2.3.4-beta.1";
}
const PantheonBridge = _opencode_plugin_gui.Ipc.define({
	id: "pantheon-opencode.bridge",
	methods: {
		snapshot: {
			input: effect.Schema.String,
			output: effect.Schema.String
		},
		postBoardMessage: {
			input: effect.Schema.String,
			output: effect.Schema.String
		},
		saveSettings: {
			input: effect.Schema.String,
			output: effect.Schema.String
		},
		runAction: {
			input: effect.Schema.String,
			output: effect.Schema.String
		}
	}
});
function readNdjsonLines(filePath, limit = 80) {
	if (!(0, node_fs.existsSync)(filePath)) return [];
	try {
		const slice = (0, node_fs.readFileSync)(filePath, "utf8").trim().split("\n").filter(Boolean).slice(-limit);
		const parsed = [];
		for (const line of slice) try {
			parsed.push(JSON.parse(line));
		} catch {}
		return parsed;
	} catch {
		return [];
	}
}
function resolveOpenCodeDbPaths() {
	const candidates = [
		process.env.PANTHEON_COST_DB,
		process.env.OPENCODE_DB,
		process.env.XDG_DATA_HOME ? (0, node_path.join)(process.env.XDG_DATA_HOME, "opencode", "opencode.db") : "",
		process.env.LOCALAPPDATA ? (0, node_path.join)(process.env.LOCALAPPDATA, "opencode", "opencode.db") : "",
		process.env.APPDATA ? (0, node_path.join)(process.env.APPDATA, "opencode", "opencode.db") : "",
		(0, node_path.join)((0, node_os.homedir)(), ".local", "share", "opencode", "opencode.db")
	];
	const seen = /* @__PURE__ */ new Set();
	const existing = [];
	for (const raw of candidates) {
		const candidate = raw?.trim();
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		if ((0, node_fs.existsSync)(candidate)) existing.push(candidate);
	}
	return existing;
}
async function openSqliteReadOnly(dbPath) {
	try {
		return new (await (import("node:sqlite"))).DatabaseSync(dbPath, { readOnly: true });
	} catch {
		return null;
	}
}
async function readOpenCodeCosts() {
	const dbPaths = resolveOpenCodeDbPaths();
	if (dbPaths.length === 0) return {
		todayCostUSD: 0,
		monthCostUSD: 0,
		modelSpend: []
	};
	const now = Date.now();
	const startOfDay = /* @__PURE__ */ new Date();
	startOfDay.setHours(0, 0, 0, 0);
	const dayMs = startOfDay.getTime();
	const monthMs = now - 2592e6;
	for (const dbPath of dbPaths) {
		const db = await openSqliteReadOnly(dbPath);
		if (!db) continue;
		try {
			const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('message', 'session_message')").all().map((r) => String(r.name)));
			if (tables.size === 0) continue;
			let todayCostUSD = 0;
			let monthCostUSD = 0;
			for (const table of ["message", "session_message"]) {
				if (!tables.has(table)) continue;
				const row = db.prepare(`SELECT
              COALESCE(SUM(CASE WHEN time_created >= ? THEN CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.cost'), 0) ELSE 0 END ELSE 0 END), 0) AS today_cost,
              COALESCE(SUM(CASE WHEN time_created >= ? THEN CASE WHEN json_valid(data) THEN COALESCE(json_extract(data, '$.cost'), 0) ELSE 0 END ELSE 0 END), 0) AS month_cost
            FROM ${table}`).get(dayMs, monthMs);
				todayCostUSD += Number(row?.today_cost ?? 0) || 0;
				monthCostUSD += Number(row?.month_cost ?? 0) || 0;
			}
			let modelSpend = [];
			try {
				modelSpend = (await queryUsageHistory(dbPath, "30d", { now })).models.map((m) => ({
					providerID: m.providerID,
					modelID: m.modelID,
					tokens: m.totals.total,
					...m.estimatedUsd !== void 0 ? { estimatedUsd: m.estimatedUsd } : {},
					rows: m.rows
				})).sort((a, b) => (b.estimatedUsd ?? 0) - (a.estimatedUsd ?? 0) || b.tokens - a.tokens).slice(0, 8);
			} catch {
				modelSpend = [];
			}
			return {
				todayCostUSD,
				monthCostUSD,
				modelSpend
			};
		} catch {} finally {
			try {
				db.close();
			} catch {}
		}
	}
	return {
		todayCostUSD: 0,
		monthCostUSD: 0,
		modelSpend: []
	};
}
function normalizeDirForCompare(dir) {
	return dir.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
function extractAgentFromSessionTitle(title) {
	if (typeof title !== "string" || !title.trim()) return "subagent";
	const mentionMatch = title.match(/@([a-zA-Z0-9_-]+)/);
	if (mentionMatch?.[1]) return mentionMatch[1].toLowerCase();
	const prefixMatch = title.match(/^([a-zA-Z0-9_-]+)\s*:/);
	if (prefixMatch?.[1]) return prefixMatch[1].toLowerCase();
	const known = [
		"apollo",
		"hermes",
		"themis",
		"athena",
		"zeus",
		"artemis",
		"hephaestus",
		"atlas"
	];
	const lower = title.toLowerCase();
	return known.find((name) => lower.includes(name)) ?? "subagent";
}
async function readOpenCodeChildSessions(rootDirectory) {
	const dbPaths = resolveOpenCodeDbPaths();
	if (dbPaths.length === 0) return [];
	const normalizedRoot = normalizeDirForCompare(rootDirectory);
	for (const dbPath of dbPaths) {
		const db = await openSqliteReadOnly(dbPath);
		if (!db) continue;
		try {
			const existingTables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_v2', 'session')").all().map((r) => String(r.name)));
			const collected = [];
			const seenIds = /* @__PURE__ */ new Set();
			const now = Date.now();
			for (const table of ["session_v2", "session"]) {
				if (!existingTables.has(table)) continue;
				const cols = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => String(c.name)));
				if (!cols.has("id") || !cols.has("parent_id")) continue;
				const timeCol = cols.has("time_updated") ? "time_updated" : cols.has("time_created") ? "time_created" : null;
				const selectCols = [
					"id",
					"parent_id",
					cols.has("agent") ? "agent" : "NULL AS agent",
					cols.has("title") ? "title" : "'' AS title",
					cols.has("directory") ? "directory" : "'' AS directory",
					timeCol ? `${timeCol} AS time_updated` : "0 AS time_updated",
					cols.has("time_archived") ? "time_archived" : "NULL AS time_archived"
				].join(", ");
				const orderClause = timeCol ? `ORDER BY ${timeCol} DESC` : "ORDER BY rowid DESC";
				const rows = db.prepare(`SELECT ${selectCols} FROM ${table}
             WHERE parent_id IS NOT NULL AND parent_id != ''
             ${orderClause} LIMIT 30`).all();
				const filtered = normalizedRoot && cols.has("directory") ? rows.filter((r) => {
					const dir = typeof r.directory === "string" ? normalizeDirForCompare(r.directory) : "";
					return !dir || dir === normalizedRoot;
				}) : rows;
				for (const r of filtered) {
					if (typeof r.id !== "string" || !r.id || seenIds.has(r.id)) continue;
					seenIds.add(r.id);
					const updated = Number(r.time_updated ?? 0);
					const isRecentActive = !(r.time_archived !== null && r.time_archived !== void 0) && Number.isFinite(updated) && now - updated < 3e4;
					const explicitAgent = typeof r.agent === "string" && r.agent.trim() ? r.agent.trim().toLowerCase() : "";
					collected.push({
						id: r.id,
						agent: explicitAgent || extractAgentFromSessionTitle(r.title),
						status: isRecentActive ? "running" : "completed",
						cost: 0
					});
				}
			}
			if (collected.length > 0) return collected;
		} catch {} finally {
			try {
				db.close();
			} catch {}
		}
	}
	return [];
}
function atomicWriteFile(filePath, content, mode) {
	(0, node_fs.mkdirSync)((0, node_path.dirname)(filePath), { recursive: true });
	const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	(0, node_fs.writeFileSync)(tmpPath, content, mode !== void 0 ? {
		encoding: "utf8",
		mode
	} : "utf8");
	(0, node_fs.renameSync)(tmpPath, filePath);
}
function xdgConfigRoot() {
	return process.env.XDG_CONFIG_HOME ?? (0, node_path.join)(process.env.HOME ?? (0, node_os.homedir)(), ".config");
}
function globalOverridesPath() {
	return (0, node_path.join)(xdgConfigRoot(), "opencode", "pantheon-overrides.json");
}
function projectOverridesPath(workspaceDir) {
	return (0, node_path.join)(workspaceDir, ".pantheon", "overrides.json");
}
function readOneOverrides(filePath) {
	try {
		const parsed = JSON.parse((0, node_fs.readFileSync)(filePath, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {
			value: {},
			corrupt: true
		};
		return {
			value: parsed,
			corrupt: false
		};
	} catch (error) {
		return {
			value: {},
			corrupt: error?.code !== "ENOENT"
		};
	}
}
function readOverridesLoad(workspaceDir) {
	const globalRead = readOneOverrides(globalOverridesPath());
	const projectRead = readOneOverrides(projectOverridesPath(workspaceDir));
	return {
		global: globalRead.value,
		project: projectRead.value,
		corruptGlobal: globalRead.corrupt
	};
}
function userOpenCodeConfigPath() {
	return (0, node_path.join)(xdgConfigRoot(), "opencode", "opencode.json");
}
function readGoalLoopPrefs() {
	const fallback = { ...DEFAULT_GOAL_LOOP_PREFS };
	try {
		const raw = JSON.parse((0, node_fs.readFileSync)(userOpenCodeConfigPath(), "utf8"))?.options?.goal_loop;
		if (raw && typeof raw === "object") return {
			enabled: typeof raw.enabled === "boolean" ? raw.enabled : fallback.enabled,
			cooldownMs: typeof raw.cooldownMs === "number" && raw.cooldownMs >= 1e3 ? Math.floor(raw.cooldownMs) : fallback.cooldownMs,
			maxContinuations: typeof raw.maxContinuations === "number" && raw.maxContinuations >= 1 ? Math.min(200, Math.floor(raw.maxContinuations)) : fallback.maxContinuations
		};
	} catch {}
	return fallback;
}
function writeUserOption(key, value) {
	const filePath = userOpenCodeConfigPath();
	let doc = {};
	try {
		const parsed = JSON.parse((0, node_fs.readFileSync)(filePath, "utf8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) doc = parsed;
	} catch {}
	const options = typeof doc.options === "object" && doc.options !== null && !Array.isArray(doc.options) ? { ...doc.options } : {};
	options[key] = value;
	doc.options = options;
	atomicWriteFile(filePath, `${JSON.stringify(doc, null, 2)}\n`);
}
function decisionRouterPath() {
	return (0, node_path.join)(xdgConfigRoot(), "pantheon", "decision-router.json");
}
function readDecisionBudgets() {
	const fallback = { ...DEFAULT_DECISION_BUDGETS };
	try {
		const raw = JSON.parse((0, node_fs.readFileSync)(decisionRouterPath(), "utf8"))?.budget;
		if (raw && typeof raw === "object") return {
			monthlyUsd: typeof raw.monthlyUsd === "number" && raw.monthlyUsd > 0 ? raw.monthlyUsd : fallback.monthlyUsd,
			perDecisionUsd: typeof raw.perDecisionUsd === "number" && raw.perDecisionUsd > 0 ? raw.perDecisionUsd : fallback.perDecisionUsd
		};
	} catch {}
	return fallback;
}
function writeDecisionBudget(budgets) {
	const filePath = decisionRouterPath();
	let doc = {};
	try {
		const parsed = JSON.parse((0, node_fs.readFileSync)(filePath, "utf8"));
		if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) doc = parsed;
	} catch {
		throw new Error("decision-router.json unreadable — repair via `decision-router setup-model`");
	}
	doc.budget = { ...budgets };
	atomicWriteFile(filePath, `${JSON.stringify(doc, null, 2)}\n`, 384);
}
function readAuthProviders() {
	const names = /* @__PURE__ */ new Set();
	try {
		const xdgData = process.env.XDG_DATA_HOME ?? (0, node_path.join)(process.env.HOME ?? (0, node_os.homedir)(), ".local", "share");
		const parsed = JSON.parse((0, node_fs.readFileSync)((0, node_path.join)(xdgData, "opencode", "auth.json"), "utf8"));
		for (const key of Object.keys(parsed)) names.add(key);
	} catch {}
	return names;
}
function readConfigProviders() {
	const names = /* @__PURE__ */ new Set();
	try {
		const parsed = JSON.parse((0, node_fs.readFileSync)(userOpenCodeConfigPath(), "utf8"));
		for (const key of Object.keys(parsed?.providers ?? {})) names.add(key);
	} catch {}
	return names;
}
function guiTuiPrefsPath() {
	return (0, node_path.join)(xdgConfigRoot(), "opencode", ".pantheon", "tui-prefs.json");
}
function readTuiPrefsFromDisk() {
	try {
		return normalizeTuiPrefs(JSON.parse((0, node_fs.readFileSync)(guiTuiPrefsPath(), "utf8")));
	} catch {
		return DEFAULT_TUI_PREFS;
	}
}
function writeTuiPrefsToDisk(prefs) {
	atomicWriteFile(guiTuiPrefsPath(), `${JSON.stringify(prefs, null, 2)}\n`);
}
function readAgentModelsFromDisk(workspaceDir) {
	const candidates = [(0, node_path.join)(workspaceDir, ".pantheon", "active-preset.json"), globalActivePresetPath()];
	const agentsMap = {};
	for (const candidate of candidates) {
		if (!(0, node_fs.existsSync)(candidate)) continue;
		try {
			const agents = JSON.parse((0, node_fs.readFileSync)(candidate, "utf8"))?.overrides?.agents;
			if (agents && typeof agents === "object" && !Array.isArray(agents)) {
				for (const [k, v] of Object.entries(agents)) if (!agentsMap[k] && v && typeof v === "object") agentsMap[k] = v;
			}
		} catch {}
	}
	return KNOWN_AGENTS.map((agent) => {
		const entry = agentsMap[agent];
		return {
			agent,
			model: typeof entry?.model === "string" ? entry.model : "",
			variant: typeof entry?.variant === "string" ? entry.variant : typeof entry?.reasoning_effort === "string" ? entry.reasoning_effort : "default"
		};
	});
}
function writeAgentModelToDisk(workspaceDir, agent, model, variant) {
	if (!KNOWN_AGENTS.includes(agent)) throw new Error(`Unknown canonical agent "${agent}"`);
	const targetPath = (0, node_path.join)(workspaceDir, ".pantheon", "active-preset.json");
	let doc = {
		version: 1,
		preset: PRESET_NONE,
		source: "gui-settings"
	};
	if ((0, node_fs.existsSync)(targetPath)) try {
		const parsed = JSON.parse((0, node_fs.readFileSync)(targetPath, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) doc = parsed;
	} catch {}
	const overrides = doc.overrides && typeof doc.overrides === "object" && !Array.isArray(doc.overrides) ? { ...doc.overrides } : {};
	const agents = overrides.agents && typeof overrides.agents === "object" && !Array.isArray(overrides.agents) ? { ...overrides.agents } : {};
	const trimmedModel = model.trim();
	if (!trimmedModel) delete agents[agent];
	else {
		const entry = { model: trimmedModel };
		if (variant === "low" || variant === "medium" || variant === "high") entry.variant = variant;
		agents[agent] = entry;
	}
	overrides.agents = agents;
	doc.overrides = overrides;
	doc.updated_at = (/* @__PURE__ */ new Date()).toISOString();
	atomicWriteFile(targetPath, `${JSON.stringify(doc, null, 2)}\n`);
}
function updateCheckStatePath() {
	const stateDir = process.env.XDG_STATE_HOME ?? (0, node_path.join)(process.env.HOME ?? (0, node_os.homedir)(), ".local", "state");
	return (0, node_path.join)(stateDir, "pantheon", "update-check.json");
}
function readUpdateCheckState() {
	try {
		return JSON.parse((0, node_fs.readFileSync)(updateCheckStatePath(), "utf8"));
	} catch {
		return {};
	}
}
function persistUpdateCheckState(previous, latest) {
	try {
		const next = withKnownLatest(nextCheckState(previous, latest ? {
			version: latest,
			message: ""
		} : null, Date.now()), latest);
		atomicWriteFile(updateCheckStatePath(), `${JSON.stringify(next, null, 2)}\n`);
	} catch {}
}
let guiGoalLoopRestartPending = false;
let guiSelectedUpdateChannel = null;
let guiCachedLegacyAudit = null;
let guiCachedChangelog = null;
async function readSnapshotFromDisk(directory) {
	const root = directory.trim() || process.cwd();
	const runningVersion = resolveRunningVersion();
	const messages = readNdjsonLines((0, node_path.join)(root, ".pantheon", "board", "messages.ndjson"), 80);
	const events = readNdjsonLines((0, node_path.join)(root, ".pantheon", "telemetry", "cockpit-events.ndjson"), 100);
	const activeJobs = [];
	const seenJobIds = /* @__PURE__ */ new Set();
	const statePath = (0, node_path.join)(root, ".pantheon", "board", "state.json");
	if ((0, node_fs.existsSync)(statePath)) try {
		const state = JSON.parse((0, node_fs.readFileSync)(statePath, "utf8"));
		if (Array.isArray(state)) for (const job of state) {
			if (!job || typeof job !== "object") continue;
			const rec = job;
			const id = typeof rec.taskID === "string" ? rec.taskID : typeof rec.id === "string" ? rec.id : "";
			if (!id || seenJobIds.has(id)) continue;
			seenJobIds.add(id);
			activeJobs.push({
				id,
				agent: typeof rec.agent === "string" && rec.agent ? rec.agent : "specialist",
				status: typeof rec.state === "string" ? rec.state : typeof rec.status === "string" ? rec.status : "unknown",
				cost: typeof rec.cost === "number" ? rec.cost : 0
			});
		}
		else if (state && typeof state === "object") {
			const legacy = state.jobs;
			if (legacy && typeof legacy === "object") for (const [id, job] of Object.entries(legacy)) {
				if (seenJobIds.has(id)) continue;
				seenJobIds.add(id);
				activeJobs.push({
					id,
					agent: job.agent ?? "specialist",
					status: job.status ?? "unknown",
					cost: typeof job.cost === "number" ? job.cost : 0
				});
			}
		}
	} catch {}
	const signalsDir = (0, node_path.join)(root, ".pantheon", "deepwork", "board-signals");
	if ((0, node_fs.existsSync)(signalsDir)) try {
		for (const file of (0, node_fs.readdirSync)(signalsDir)) {
			if (!file.endsWith(".signal.json")) continue;
			try {
				const sig = JSON.parse((0, node_fs.readFileSync)((0, node_path.join)(signalsDir, file), "utf8"));
				const id = sig.jobId ?? file.replace(".signal.json", "");
				if (seenJobIds.has(id)) continue;
				seenJobIds.add(id);
				activeJobs.push({
					id,
					agent: sig.agent ?? "specialist",
					status: sig.status ?? "completed",
					cost: typeof sig.cost === "number" ? sig.cost : 0
				});
			} catch {}
		}
	} catch {}
	const childSessions = await readOpenCodeChildSessions(root);
	for (const child of childSessions) {
		if (seenJobIds.has(child.id)) continue;
		seenJobIds.add(child.id);
		activeJobs.push(child);
	}
	const eventJobIndex = /* @__PURE__ */ new Map();
	for (const ev of events) {
		const kind = ev.kind ?? ev.type ?? "";
		if (kind !== "subagent:start" && kind !== "subagent:stop" && kind !== "ephemeral:worker") continue;
		const agent = typeof ev.agent === "string" && ev.agent ? ev.agent : "subagent";
		const key = ev.stepKey || ev.threadId || `${agent}:${ev.timestamp}`;
		if (seenJobIds.has(key)) continue;
		const status = kind === "subagent:start" ? "running" : ev.severity === "error" ? "error" : "completed";
		const existingIdx = eventJobIndex.get(key);
		if (existingIdx !== void 0) {
			const existing = activeJobs[existingIdx];
			if (existing) existing.status = status;
		} else {
			eventJobIndex.set(key, activeJobs.length);
			activeJobs.push({
				id: key,
				agent,
				status,
				cost: 0
			});
		}
	}
	const load = readOverridesLoad(root);
	const merged = mergedOverrides(load);
	const overridesCount = Object.keys(merged).length;
	const behaviorsGlobal = SETTINGS_BEHAVIORS.map((b) => ({
		id: b.id,
		title: b.title,
		description: b.description,
		kind: b.kind,
		enabled: !isBehaviorDisabled(load.global, b.id),
		projectOverride: load.project[b.id] !== void 0
	}));
	const behaviorsProject = SETTINGS_BEHAVIORS.map((b) => ({
		id: b.id,
		title: b.title,
		description: b.description,
		kind: b.kind,
		enabled: !isBehaviorDisabled(merged, b.id),
		projectOverride: load.project[b.id] !== void 0
	}));
	let gateMode = "shadow";
	let cockpitAutoOpen = false;
	let cockpitShowTodo = true;
	const settingsPath = (0, node_path.join)(root, ".pantheon", "cockpit-settings.json");
	if ((0, node_fs.existsSync)(settingsPath)) try {
		const cfg = JSON.parse((0, node_fs.readFileSync)(settingsPath, "utf8"));
		if (typeof cfg.gateMode === "string" && cfg.gateMode) gateMode = cfg.gateMode;
		if (typeof cfg.autoOpen === "boolean") cockpitAutoOpen = cfg.autoOpen;
		if (typeof cfg.showTodo === "boolean") cockpitShowTodo = cfg.showTodo;
	} catch {}
	const globalPreset = readActivePresetMarker(globalActivePresetPath());
	const projectPreset = readActivePresetMarker((0, node_path.join)(root, ".pantheon", "active-preset.json"));
	const activePreset = globalPreset?.name ?? "none";
	const presetProjectOverride = projectPreset?.name ?? null;
	const visionModel = readConfiguredVisionModel(root);
	const agentModels = readAgentModelsFromDisk(root);
	const decisionRead = readDecisionRouterConfig();
	const dec = decisionRead.config;
	const decisionTarget = dec.selection.provider ? `${dec.selection.provider}/${dec.selection.model ?? ""}` : DECISION_TARGET_CYCLE[0] ?? "openai-decisions/gpt-6-luna";
	const authProviders = readAuthProviders();
	const configProviders = readConfigProviders();
	const credentials = DECISION_KNOWN_PROVIDERS.map((provider) => {
		const status = credentialStatus(provider, process.env, authProviders, configProviders);
		const cred = DECISION_PROVIDER_CREDENTIALS[provider] ?? { note: "" };
		return {
			provider,
			status: status === "missing" ? "MISSING" : status,
			note: cred.note
		};
	});
	const goalLoop = readGoalLoopPrefs();
	const budgets = readDecisionBudgets();
	const j1Mode = j1ModeFromEnv(process.env);
	const j1Threshold = j1ThresholdFromEnv(process.env);
	const j1DisabledByOverride = isBehaviorDisabled(merged, "gate-j1-risk-gate");
	const tuiPrefs = readTuiPrefsFromDisk();
	const updateState = readUpdateCheckState();
	const updateChannel = guiSelectedUpdateChannel ?? updateChannelFor(runningVersion);
	if (guiCachedLegacyAudit === null) try {
		guiCachedLegacyAudit = scanLegacyArtifacts({
			workspaceDir: root,
			runningVersion
		}).summary;
	} catch {
		guiCachedLegacyAudit = null;
	}
	if (guiCachedChangelog === null) try {
		const md = await readChangelogForBundle(require("url").pathToFileURL(__filename).href ? require("url").pathToFileURL(__filename).href : root);
		if (md) {
			const hl = extractHighlights(md, runningVersion);
			if (hl.found) {
				const items = [];
				for (const group of hl.groups) for (const item of group.items) {
					const colon = item.indexOf(": ");
					const emdash = item.indexOf("—");
					const sep = colon !== -1 ? colon : emdash;
					const title = sep !== -1 ? item.slice(0, sep).trim() : item.slice(0, 26);
					const detail = sep !== -1 ? item.slice(sep + (colon !== -1 ? 2 : 1)).trim() : item;
					items.push({
						title,
						detail,
						group: group.heading ?? void 0
					});
				}
				guiCachedChangelog = items;
			} else guiCachedChangelog = [];
		} else guiCachedChangelog = [];
	} catch {
		guiCachedChangelog = [];
	}
	const installHealth = classifyInstallVersion(runningVersion);
	const overridesHealth = classifyOverridesHealth(load);
	const decisionHealth = classifyDecisionConfigHealth();
	const doctor = {
		installVersion: installHealth.installed ?? "unknown",
		installStatus: installHealth.status,
		nodeVersion: process.versions.node,
		nodeSupported: isSupportedNodeFloor(process.versions.node),
		overridesStatus: overridesHealth.status,
		overridesUnknownCount: overridesHealth.unknownIds.length,
		decisionStatus: decisionHealth.status
	};
	const aboutToolGroups = (buildAboutTab(runningVersion, {
		nodeVersion: process.versions.node,
		platform: process.platform,
		preset: projectPreset?.name ?? globalPreset?.name ?? null,
		decisionEnabled: dec.enabled,
		j1Mode
	}).groups.find((g) => g.title?.includes("Native Tools"))?.rows ?? []).map((r) => ({
		name: r.name,
		value: r.value,
		note: r.note ?? ""
	}));
	let artifactsCount = 0;
	const plansDir = (0, node_path.join)(root, ".pantheon", "plans");
	if ((0, node_fs.existsSync)(plansDir)) try {
		artifactsCount = (0, node_fs.readdirSync)(plansDir).filter((f) => f.endsWith(".md")).length;
	} catch {}
	const { todayCostUSD, monthCostUSD, modelSpend } = await readOpenCodeCosts();
	return {
		messages,
		events,
		activeJobs,
		todayCostUSD,
		monthCostUSD,
		modelSpend,
		overridesCount,
		corruptGlobalOverrides: load.corruptGlobal,
		gateMode,
		cockpitAutoOpen,
		cockpitShowTodo,
		artifactsCount,
		activePreset,
		presetProjectOverride,
		visionModel,
		agentModels,
		decisionEnabled: dec.enabled,
		decisionMode: dec.selection.mode,
		decisionTarget,
		decisionConsent: dec.egress_consent,
		decisionCorrupt: decisionRead.corrupt,
		decisionCandidates: [...dec.enabled_candidates],
		credentials,
		goalLoop,
		goalLoopRestartPending: guiGoalLoopRestartPending,
		budgets,
		j1Mode,
		j1Threshold,
		j1DisabledByOverride,
		tuiPrefs,
		updateChannel,
		lastUpdateCheckMs: updateState.lastCheckMs ?? null,
		latestVersion: updateState.lastNotifiedVersion ?? null,
		legacyAudit: guiCachedLegacyAudit,
		doctor,
		changelogHighlights: guiCachedChangelog ?? [],
		aboutToolGroups,
		behaviorsGlobal,
		behaviorsProject
	};
}
function appendBoardMessageToDisk(payloadRaw) {
	try {
		const payload = JSON.parse(payloadRaw);
		const root = payload.directory?.trim() || process.cwd();
		const body = String(payload.body ?? "").trim();
		if (!body) return JSON.stringify({
			ok: false,
			error: "Empty message"
		});
		const boardDir = (0, node_path.join)(root, ".pantheon", "board");
		(0, node_fs.mkdirSync)(boardDir, { recursive: true });
		const msgPath = (0, node_path.join)(boardDir, "messages.ndjson");
		const existing = readNdjsonLines(msgPath, 500);
		const nextSeq = existing.length > 0 ? (existing[existing.length - 1]?.seq ?? 0) + 1 : 1;
		const mentions = [...body.matchAll(/@([a-zA-Z0-9_-]+)/g)].map((m) => `@${m[1]}`);
		const record = {
			seq: nextSeq,
			timestamp: Date.now(),
			channel: payload.channel?.trim() || "default",
			from: "user",
			mentions,
			tag: "note",
			body
		};
		(0, node_fs.appendFileSync)(msgPath, `${JSON.stringify(record)}\n`, "utf8");
		return JSON.stringify({
			ok: true,
			seq: nextSeq
		});
	} catch (err) {
		return JSON.stringify({
			ok: false,
			error: err instanceof Error ? err.message : "Failed to post board message"
		});
	}
}
function saveSettingsToDisk(payloadRaw) {
	try {
		const payload = JSON.parse(payloadRaw);
		const root = payload.directory?.trim() || process.cwd();
		const pantheonDir = (0, node_path.join)(root, ".pantheon");
		(0, node_fs.mkdirSync)(pantheonDir, { recursive: true });
		if (typeof payload.gateMode === "string" || typeof payload.cockpitAutoOpen === "boolean" || typeof payload.cockpitShowTodo === "boolean") {
			const settingsPath = (0, node_path.join)(pantheonDir, "cockpit-settings.json");
			let current = {};
			if ((0, node_fs.existsSync)(settingsPath)) try {
				const parsed = JSON.parse((0, node_fs.readFileSync)(settingsPath, "utf8"));
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
			} catch {
				current = {};
			}
			if (typeof payload.gateMode === "string") current.gateMode = payload.gateMode;
			if (typeof payload.cockpitAutoOpen === "boolean") current.autoOpen = payload.cockpitAutoOpen;
			if (typeof payload.cockpitShowTodo === "boolean") current.showTodo = payload.cockpitShowTodo;
			atomicWriteFile(settingsPath, `${JSON.stringify(current, null, 2)}\n`);
		}
		if (typeof payload.preset === "string") {
			const globalPath = globalActivePresetPath();
			if (payload.preset === "none") clearActivePreset(globalPath);
			else writeActivePreset(globalPath, payload.preset);
		}
		if (typeof payload.visionModel === "string") writeConfiguredVisionModel(payload.visionModel, root);
		if (payload.agentModel) writeAgentModelToDisk(root, payload.agentModel.agent, payload.agentModel.model, payload.agentModel.variant);
		if (payload.overrideToggle) {
			const { id, scope, enabled } = payload.overrideToggle;
			const load = readOverridesLoad(root);
			const target = enabled ? "enabled" : "disabled";
			if (scope === "project") {
				const nextProject = setOverrideState(load.project, id, target, "toggled in Pantheon GUI");
				atomicWriteFile(projectOverridesPath(root), serializeOverrides(nextProject));
			} else {
				if (!canWriteOverrides(load)) return JSON.stringify({
					ok: false,
					error: "Global overrides file unreadable — repair with `doctor --fix`"
				});
				const nextGlobal = setOverrideState(load.global, id, target, "toggled in Pantheon GUI");
				atomicWriteFile(globalOverridesPath(), serializeOverrides(nextGlobal));
			}
		}
		if (typeof payload.decisionEnabled === "boolean" || typeof payload.decisionMode === "string" || typeof payload.decisionTarget === "string" || typeof payload.decisionConsent === "boolean") {
			const read = readDecisionRouterConfig();
			if (read.corrupt) return JSON.stringify({
				ok: false,
				error: "Decision router config is corrupt; refusing to overwrite"
			});
			let nextCfg = read.config;
			if (typeof payload.decisionConsent === "boolean") nextCfg = applyDecisionRow(nextCfg, "decision.consent", payload.decisionConsent ? "granted" : "not granted");
			if (typeof payload.decisionMode === "string") nextCfg = applyDecisionRow(nextCfg, "decision.selection.mode", payload.decisionMode);
			if (typeof payload.decisionTarget === "string") nextCfg = applyDecisionRow(nextCfg, "decision.selection.target", payload.decisionTarget);
			if (typeof payload.decisionEnabled === "boolean") {
				const guarded = setDecisionEnabled(nextCfg, payload.decisionEnabled);
				if (!guarded.ok) return JSON.stringify({
					ok: false,
					error: guarded.reason
				});
				nextCfg = guarded.config;
			}
			writeDecisionRouterConfig(nextCfg);
		}
		if (payload.goalLoop) {
			const current = readGoalLoopPrefs();
			writeUserOption("goal_loop", {
				enabled: typeof payload.goalLoop.enabled === "boolean" ? payload.goalLoop.enabled : current.enabled,
				maxContinuations: typeof payload.goalLoop.maxContinuations === "number" && payload.goalLoop.maxContinuations >= 1 && payload.goalLoop.maxContinuations <= 200 ? Math.floor(payload.goalLoop.maxContinuations) : current.maxContinuations,
				cooldownMs: typeof payload.goalLoop.cooldownMs === "number" && payload.goalLoop.cooldownMs >= 1e3 ? Math.floor(payload.goalLoop.cooldownMs) : current.cooldownMs
			});
			guiGoalLoopRestartPending = true;
		}
		if (typeof payload.budgetMonthly === "string" || typeof payload.budgetPerDecision === "string") {
			const current = readDecisionBudgets();
			const monthly = typeof payload.budgetMonthly === "string" ? parseUsd(payload.budgetMonthly) : current.monthlyUsd;
			const perDecision = typeof payload.budgetPerDecision === "string" ? parseUsd(payload.budgetPerDecision) : current.perDecisionUsd;
			if (monthly === null || perDecision === null) return JSON.stringify({
				ok: false,
				error: "Invalid USD budget value"
			});
			writeDecisionBudget({
				monthlyUsd: monthly,
				perDecisionUsd: perDecision
			});
		}
		if (payload.tuiPref) {
			const current = readTuiPrefsFromDisk();
			const copy = JSON.parse(JSON.stringify(current));
			applyTuiRow(copy, payload.tuiPref.id, payload.tuiPref.value);
			writeTuiPrefsToDisk(copy);
		}
		if (payload.updateChannel === "stable" || payload.updateChannel === "beta") guiSelectedUpdateChannel = payload.updateChannel;
		return JSON.stringify({ ok: true });
	} catch (err) {
		return JSON.stringify({
			ok: false,
			error: err instanceof Error ? err.message : "Failed to save Pantheon settings"
		});
	}
}
async function runActionOnDisk(payloadRaw) {
	try {
		const payload = JSON.parse(payloadRaw);
		const root = payload.directory?.trim() || process.cwd();
		const runningVersion = resolveRunningVersion();
		const channel = payload.channel ?? guiSelectedUpdateChannel ?? updateChannelFor(runningVersion);
		if (payload.action === "update-check") {
			const prev = readUpdateCheckState();
			let latest = null;
			try {
				const json = await (await fetch(registryUrlForChannel(channel), { signal: AbortSignal.timeout(5e3) })).json();
				latest = typeof json?.version === "string" && json.version ? json.version : null;
			} catch {
				latest = null;
			}
			persistUpdateCheckState(prev, latest);
			const isNewer = latest ? isNewerUpdateAvailable(runningVersion, latest) : false;
			return JSON.stringify({
				ok: true,
				message: latest ? isNewer ? `Update available: v${latest} (channel: ${channel})` : `Up to date on v${runningVersion} (latest: v${latest})` : "Could not reach npm registry (offline or timeout)"
			});
		}
		if (payload.action === "update-run") {
			const pkgSpec = channel === "beta" ? "pantheon-opencode@beta" : "pantheon-opencode";
			const runCmd = (cmd, args) => new Promise((resolve) => {
				(0, node_child_process.execFile)(cmd, args, {
					cwd: root,
					timeout: 6e4
				}, (err) => resolve(err ?? null));
			});
			let err = await runCmd("opencode", [
				"plugin",
				"update",
				pkgSpec
			]);
			if (err) err = await runCmd("opencode", [
				"plugin",
				"add",
				pkgSpec
			]);
			if (err) err = await runCmd("npm", [
				"install",
				"-g",
				pkgSpec
			]);
			if (err) return JSON.stringify({
				ok: false,
				error: `Run in terminal: opencode plugin update ${pkgSpec}`
			});
			return JSON.stringify({
				ok: true,
				message: `Updated ${pkgSpec} — restart OpenCode to reload`
			});
		}
		if (payload.action === "legacy-scan") {
			const scan = scanLegacyArtifacts({
				workspaceDir: root,
				runningVersion
			});
			guiCachedLegacyAudit = scan.summary;
			return JSON.stringify({
				ok: true,
				message: scan.summary.total === 0 ? "No legacy or obsolete files detected" : `Found ${scan.summary.total} item(s) (${formatBytes(scan.summary.totalBytes)})`
			});
		}
		if (payload.action === "legacy-clean") {
			const res = cleanLegacyArtifacts({
				workspaceDir: root,
				runningVersion
			});
			guiCachedLegacyAudit = scanLegacyArtifacts({
				workspaceDir: root,
				runningVersion
			}).summary;
			return JSON.stringify({
				ok: true,
				message: `Removed ${res.removed.length} item(s) (${formatBytes(res.reclaimedBytes)}), ${res.migratedRecords} record(s) migrated`
			});
		}
		if (payload.action === "legacy-purge") {
			const res = purgeAllPantheonData({
				workspaceDir: root,
				runningVersion
			});
			guiCachedLegacyAudit = scanLegacyArtifacts({
				workspaceDir: root,
				runningVersion
			}).summary;
			return JSON.stringify({
				ok: true,
				message: `Purged ${res.removed.length} item(s) (${formatBytes(res.reclaimedBytes)})`
			});
		}
		return JSON.stringify({
			ok: false,
			error: `Unknown action "${payload.action ?? ""}"`
		});
	} catch (err) {
		return JSON.stringify({
			ok: false,
			error: err instanceof Error ? err.message : "Action failed"
		});
	}
}
const [sharedSnapshot, setSharedSnapshot] = (0, solid_js.createSignal)({
	messages: [],
	events: [],
	activeJobs: [],
	todayCostUSD: 0,
	monthCostUSD: 0,
	modelSpend: [],
	overridesCount: 0,
	corruptGlobalOverrides: false,
	gateMode: "shadow",
	cockpitAutoOpen: false,
	cockpitShowTodo: true,
	artifactsCount: 0,
	activePreset: PRESET_NONE,
	presetProjectOverride: null,
	visionModel: "auto",
	agentModels: KNOWN_AGENTS.map((agent) => ({
		agent,
		model: "",
		variant: "default"
	})),
	decisionEnabled: false,
	decisionMode: "local",
	decisionTarget: DECISION_TARGET_CYCLE[0] ?? "openai-decisions/gpt-6-luna",
	decisionConsent: false,
	decisionCorrupt: false,
	decisionCandidates: [],
	credentials: DECISION_KNOWN_PROVIDERS.map((provider) => ({
		provider,
		status: "MISSING",
		note: DECISION_PROVIDER_CREDENTIALS[provider]?.note ?? ""
	})),
	goalLoop: { ...DEFAULT_GOAL_LOOP_PREFS },
	goalLoopRestartPending: false,
	budgets: { ...DEFAULT_DECISION_BUDGETS },
	j1Mode: "shadow",
	j1Threshold: .8,
	j1DisabledByOverride: false,
	tuiPrefs: DEFAULT_TUI_PREFS,
	updateChannel: "stable",
	lastUpdateCheckMs: null,
	latestVersion: null,
	legacyAudit: null,
	doctor: {
		installVersion: "unknown",
		installStatus: "unknown",
		nodeVersion: "26.x",
		nodeSupported: true,
		overridesStatus: "clean",
		overridesUnknownCount: 0,
		decisionStatus: "absent"
	},
	changelogHighlights: [],
	aboutToolGroups: [],
	behaviorsGlobal: SETTINGS_BEHAVIORS.map((b) => ({
		id: b.id,
		title: b.title,
		description: b.description,
		kind: b.kind,
		enabled: true,
		projectOverride: false
	})),
	behaviorsProject: SETTINGS_BEHAVIORS.map((b) => ({
		id: b.id,
		title: b.title,
		description: b.description,
		kind: b.kind,
		enabled: true,
		projectOverride: false
	}))
});
const [activeDirectory, setActiveDirectory] = (0, solid_js.createSignal)("");
const [uiError, setUiError] = (0, solid_js.createSignal)(null);
const [uiNotice, setUiNotice] = (0, solid_js.createSignal)(null);
function resolveActiveDirectory(ctx, explicit) {
	const direct = explicit?.().trim();
	if (direct) return direct;
	const session = ctx.sessions.current();
	const sessionDir = session?.directory?.trim() || session?.location?.directory?.trim() || "";
	if (sessionDir) return sessionDir;
	return activeDirectory().trim();
}
function PantheonCockpitView(props) {
	const [subTab, setSubTab] = (0, solid_js.createSignal)("topology");
	const [topoView, setTopoView] = (0, solid_js.createSignal)("dag");
	const [scrubberSeq, setScrubberSeq] = (0, solid_js.createSignal)(null);
	const [draftMsg, setDraftMsg] = (0, solid_js.createSignal)("");
	const [draftChannel, setDraftChannel] = (0, solid_js.createSignal)("default");
	const effectiveDirectory = () => resolveActiveDirectory(props.ctx, props.directory);
	const refresh = async () => {
		try {
			const dir = effectiveDirectory();
			if (dir) setActiveDirectory(dir);
			const raw = await props.ctx.main(PantheonBridge).snapshot(dir);
			setSharedSnapshot(JSON.parse(raw));
		} catch {}
	};
	const sendBoardMsg = async () => {
		const body = draftMsg().trim();
		if (!body) return;
		try {
			const raw = await props.ctx.main(PantheonBridge).postBoardMessage(JSON.stringify({
				directory: effectiveDirectory(),
				channel: draftChannel(),
				body
			}));
			const res = JSON.parse(raw);
			if (res.ok === false) {
				setUiError(res.error ?? "Failed to post board message");
				return;
			}
			setUiError(null);
			setDraftMsg("");
			await refresh();
		} catch (err) {
			setUiError(err instanceof Error ? err.message : "Board IPC unavailable");
		}
	};
	(0, solid_js.createEffect)(() => {
		const dir = effectiveDirectory();
		if (dir) setActiveDirectory(dir);
		refresh();
		const timer = setInterval(() => void refresh(), 3e3);
		(0, solid_js.onCleanup)(() => clearInterval(timer));
	});
	const maxSeq = (0, solid_js.createMemo)(() => {
		const msgs = sharedSnapshot().messages;
		return msgs.length > 0 ? msgs[msgs.length - 1]?.seq ?? 0 : 0;
	});
	const visibleMessages = (0, solid_js.createMemo)(() => {
		const cap = scrubberSeq();
		const msgs = sharedSnapshot().messages;
		return cap === null ? msgs : msgs.filter((m) => m.seq <= cap);
	});
	const ephemeralWorkers = (0, solid_js.createMemo)(() => visibleMessages().filter((m) => m.ephemeral !== void 0));
	const subagentEvents = (0, solid_js.createMemo)(() => sharedSnapshot().events.filter((ev) => {
		const kind = ev.kind ?? ev.type ?? "";
		return kind === "subagent:start" || kind === "subagent:stop" || kind === "ephemeral:worker" || kind === "review:verdict" || kind === "agent:execution:receipt";
	}));
	const uniqueAgents = (0, solid_js.createMemo)(() => {
		const set = /* @__PURE__ */ new Set(["zeus"]);
		for (const m of visibleMessages()) if (m.from && m.from !== "user") set.add(m.from);
		for (const j of sharedSnapshot().activeJobs) if (j.agent) set.add(j.agent);
		for (const ev of sharedSnapshot().events) {
			const agent = ev.agent?.trim();
			if (agent && agent !== "pantheon" && agent !== "ledger" && agent !== "user") set.add(agent);
		}
		return [...set].slice(0, 10);
	});
	const totalCost = (0, solid_js.createMemo)(() => sharedSnapshot().activeJobs.reduce((sum, j) => sum + (Number.isFinite(j.cost) ? j.cost : 0), 0));
	return (() => {
		var _el$ = _tmpl$6(), _el$2 = _el$.firstChild, _el$3 = _el$2.firstChild, _el$5 = _el$3.firstChild.nextSibling, _el$7 = _el$3.nextSibling.firstChild, _el$8 = _el$7.nextSibling, _el$10 = _el$2.nextSibling;
		(0, solid_js_web.insert)(_el$5, () => `v${resolveRunningVersion()}`);
		(0, solid_js_web.insert)(_el$7, () => `${sharedSnapshot().activeJobs.filter((j) => j.status === "running").length} active · $${totalCost().toFixed(2)}`);
		_el$8.$$click = () => void refresh();
		(0, solid_js_web.insert)(_el$, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return uiError() !== null;
			},
			get children() {
				var _el$9 = _tmpl$(), _el$0 = _el$9.firstChild, _el$1 = _el$0.nextSibling;
				(0, solid_js_web.insert)(_el$0, uiError);
				_el$1.$$click = () => setUiError(null);
				return _el$9;
			}
		}), _el$10);
		(0, solid_js_web.insert)(_el$10, () => [
			["topology", "Topology & Timeline"],
			["board", `Agora Board (${sharedSnapshot().messages.length})`],
			["ephemeral", `Ephemeral & Bots (${sharedSnapshot().activeJobs.length})`],
			["settings", "Settings & Cost"]
		].map(([id, label]) => (() => {
			var _el$29 = _tmpl$7();
			_el$29.$$click = () => setSubTab(id);
			(0, solid_js_web.insert)(_el$29, label);
			(0, solid_js_web.effect)((_p$) => {
				var _v$6 = subTab() === id ? "2px solid #fba970" : "2px solid transparent", _v$7 = subTab() === id ? 1 : .65, _v$8 = subTab() === id ? 600 : 400;
				_v$6 !== _p$.e && (0, solid_js_web.setStyleProperty)(_el$29, "border-bottom", _p$.e = _v$6);
				_v$7 !== _p$.t && (0, solid_js_web.setStyleProperty)(_el$29, "opacity", _p$.t = _v$7);
				_v$8 !== _p$.a && (0, solid_js_web.setStyleProperty)(_el$29, "font-weight", _p$.a = _v$8);
				return _p$;
			}, {
				e: void 0,
				t: void 0,
				a: void 0
			});
			return _el$29;
		})()));
		(0, solid_js_web.insert)(_el$, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return subTab() === "topology";
			},
			get children() {
				var _el$11 = _tmpl$3(), _el$13 = _el$11.firstChild.firstChild, _el$14 = _el$13.firstChild, _el$15 = _el$14.nextSibling, _el$17 = _el$13.nextSibling.firstChild, _el$18 = _el$17.nextSibling;
				_el$14.$$input = (e) => {
					const val = Number(e.currentTarget.value);
					setScrubberSeq(val >= maxSeq() ? null : val);
				};
				(0, solid_js_web.insert)(_el$15, (() => {
					var _c$ = (0, solid_js_web.memo)(() => scrubberSeq() === null);
					return () => _c$() ? `#${maxSeq()} · Live` : `#${scrubberSeq()} / ${maxSeq()} · Replay`;
				})());
				_el$17.$$click = () => setTopoView("dag");
				_el$18.$$click = () => setTopoView("gantt");
				(0, solid_js_web.insert)(_el$11, (0, solid_js_web.createComponent)(solid_js.Show, {
					get when() {
						return topoView() === "dag";
					},
					get fallback() {
						return (() => {
							var _el$30 = _tmpl$8();
							(0, solid_js_web.insert)(_el$30, (0, solid_js_web.createComponent)(solid_js.For, {
								get each() {
									return uniqueAgents();
								},
								children: (agent, idx) => (() => {
									var _el$31 = _tmpl$9(), _el$32 = _el$31.firstChild, _el$34 = _el$32.nextSibling.firstChild;
									(0, solid_js_web.insert)(_el$32, agent);
									(0, solid_js_web.setStyleProperty)(_el$34, "background", agent === "zeus" ? "#fba970" : "#38bdf8");
									(0, solid_js_web.effect)((_$p) => (0, solid_js_web.setStyleProperty)(_el$34, "width", `${Math.max(20, 95 - idx() * 15)}%`));
									return _el$31;
								})()
							}));
							return _el$30;
						})();
					},
					get children() {
						var _el$19 = _tmpl$2();
						_el$19.firstChild.nextSibling.nextSibling;
						(0, solid_js_web.insert)(_el$19, (0, solid_js_web.createComponent)(solid_js.For, {
							get each() {
								return uniqueAgents().filter((a) => a !== "zeus");
							},
							children: (agent, idx) => {
								const count = Math.max(1, uniqueAgents().length - 1);
								const x = 20 + idx() * 600 / count;
								const cx = x + 55;
								return (() => {
									var _el$35 = _tmpl$0(), _el$36 = _el$35.firstChild, _el$37 = _el$36.nextSibling, _el$38 = _el$37.nextSibling;
									(0, solid_js_web.setAttribute)(_el$36, "d", `M 320 46 C 320 78, ${cx} 72, ${cx} 104`);
									(0, solid_js_web.setAttribute)(_el$37, "x", x);
									(0, solid_js_web.setAttribute)(_el$38, "x", cx);
									(0, solid_js_web.insert)(_el$38, agent);
									return _el$35;
								})();
							}
						}), null);
						return _el$19;
					}
				}), null);
				(0, solid_js_web.effect)((_p$) => {
					var _v$ = Math.max(1, maxSeq()), _v$2 = topoView() === "dag" ? "#fba970" : "transparent", _v$3 = topoView() === "dag" ? "#111" : "inherit", _v$4 = topoView() === "gantt" ? "#fba970" : "transparent", _v$5 = topoView() === "gantt" ? "#111" : "inherit";
					_v$ !== _p$.e && (0, solid_js_web.setAttribute)(_el$14, "max", _p$.e = _v$);
					_v$2 !== _p$.t && (0, solid_js_web.setStyleProperty)(_el$17, "background", _p$.t = _v$2);
					_v$3 !== _p$.a && (0, solid_js_web.setStyleProperty)(_el$17, "color", _p$.a = _v$3);
					_v$4 !== _p$.o && (0, solid_js_web.setStyleProperty)(_el$18, "background", _p$.o = _v$4);
					_v$5 !== _p$.i && (0, solid_js_web.setStyleProperty)(_el$18, "color", _p$.i = _v$5);
					return _p$;
				}, {
					e: void 0,
					t: void 0,
					a: void 0,
					o: void 0,
					i: void 0
				});
				(0, solid_js_web.effect)(() => _el$14.value = scrubberSeq() ?? maxSeq());
				return _el$11;
			}
		}), null);
		(0, solid_js_web.insert)(_el$, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return subTab() === "board";
			},
			get children() {
				var _el$23 = _tmpl$4(), _el$25 = _el$23.firstChild.firstChild, _el$26 = _el$25.nextSibling, _el$27 = _el$26.nextSibling;
				_el$25.$$input = (e) => setDraftChannel(e.currentTarget.value);
				_el$26.$$keydown = (e) => {
					if (e.key === "Enter") sendBoardMsg();
				};
				_el$26.$$input = (e) => setDraftMsg(e.currentTarget.value);
				_el$27.$$click = () => void sendBoardMsg();
				(0, solid_js_web.insert)(_el$23, (0, solid_js_web.createComponent)(solid_js.For, {
					get each() {
						return [...visibleMessages()].reverse().slice(0, 20);
					},
					get fallback() {
						return _tmpl$1();
					},
					children: (msg) => (() => {
						var _el$40 = _tmpl$10(), _el$41 = _el$40.firstChild, _el$42 = _el$41.firstChild, _el$43 = _el$42.nextSibling, _el$44 = _el$41.nextSibling;
						(0, solid_js_web.insert)(_el$42, () => `#${msg.seq} ${msg.from}${msg.mentions.length ? ` → ${msg.mentions.join(", ")}` : ""}`);
						(0, solid_js_web.insert)(_el$43, () => msg.tag ?? "");
						(0, solid_js_web.insert)(_el$44, () => msg.body);
						return _el$40;
					})()
				}), null);
				(0, solid_js_web.effect)(() => _el$25.value = draftChannel());
				(0, solid_js_web.effect)(() => _el$26.value = draftMsg());
				return _el$23;
			}
		}), null);
		(0, solid_js_web.insert)(_el$, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return subTab() === "ephemeral";
			},
			get children() {
				var _el$28 = _tmpl$5();
				(0, solid_js_web.insert)(_el$28, (0, solid_js_web.createComponent)(solid_js.For, {
					get each() {
						return sharedSnapshot().activeJobs;
					},
					get fallback() {
						return (0, solid_js_web.createComponent)(solid_js.Show, {
							get when() {
								return subagentEvents().length === 0;
							},
							get children() {
								return _tmpl$11();
							}
						});
					},
					children: (job) => (() => {
						var _el$46 = _tmpl$12(), _el$47 = _el$46.firstChild, _el$48 = _el$47.nextSibling;
						(0, solid_js_web.insert)(_el$47, () => `${job.agent} (${job.id.slice(0, 8)})`);
						(0, solid_js_web.insert)(_el$48, () => `${job.status} · $${job.cost.toFixed(3)}`);
						return _el$46;
					})()
				}), null);
				(0, solid_js_web.insert)(_el$28, (0, solid_js_web.createComponent)(solid_js.For, {
					get each() {
						return ephemeralWorkers().slice(-6);
					},
					children: (msg) => (() => {
						var _el$49 = _tmpl$13();
						(0, solid_js_web.insert)(_el$49, () => `◈ ${msg.ephemeral?.role ?? msg.from} [${msg.ephemeral?.status ?? "active"}]`);
						return _el$49;
					})()
				}), null);
				(0, solid_js_web.insert)(_el$28, (0, solid_js_web.createComponent)(solid_js.For, {
					get each() {
						return [...subagentEvents()].reverse().slice(0, 10);
					},
					children: (ev) => (() => {
						var _el$50 = _tmpl$14(), _el$51 = _el$50.firstChild, _el$52 = _el$51.nextSibling;
						(0, solid_js_web.insert)(_el$51, () => `${ev.agent ?? "subagent"} · ${ev.kind ?? ev.type ?? "event"}`);
						(0, solid_js_web.insert)(_el$52, () => ev.detail ?? "");
						return _el$50;
					})()
				}), null);
				return _el$28;
			}
		}), null);
		(0, solid_js_web.insert)(_el$, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return subTab() === "settings";
			},
			get children() {
				return (0, solid_js_web.createComponent)(PantheonSettingsControls, {
					get ctx() {
						return props.ctx;
					},
					directory: effectiveDirectory,
					onSaved: refresh
				});
			}
		}), null);
		return _el$;
	})();
}
const cardStyle = {
	display: "flex",
	"flex-direction": "column",
	gap: "8px",
	padding: "10px",
	"border-radius": "6px",
	border: "1px solid var(--border-weak-base, #2e2e32)"
};
const rowStyle = {
	display: "flex",
	"justify-content": "space-between",
	"align-items": "center",
	gap: "8px"
};
function pillButtonStyle(active) {
	return {
		padding: "2px 8px",
		"border-radius": "4px",
		border: "1px solid var(--border-weak-base, #3f3f46)",
		background: active ? "#fba970" : "transparent",
		color: active ? "#111" : "inherit",
		"font-family": "monospace",
		"font-size": "11px",
		"font-weight": active ? 600 : 400,
		cursor: "pointer"
	};
}
function PantheonSettingsControls(props) {
	const [section, setSection] = (0, solid_js.createSignal)("overview");
	const [gateScope, setGateScope] = (0, solid_js.createSignal)("project");
	const [editingAgent, setEditingAgent] = (0, solid_js.createSignal)(null);
	const [agentModelInput, setAgentModelInput] = (0, solid_js.createSignal)("");
	const [agentVariantInput, setAgentVariantInput] = (0, solid_js.createSignal)("default");
	const [busyAction, setBusyAction] = (0, solid_js.createSignal)(null);
	const [confirmPurge, setConfirmPurge] = (0, solid_js.createSignal)(false);
	const savePatch = async (patch, notice) => {
		try {
			const raw = await props.ctx.main(PantheonBridge).saveSettings(JSON.stringify({
				directory: props.directory(),
				...patch
			}));
			const res = JSON.parse(raw);
			if (res.ok === false) {
				setUiError(res.error ?? "Failed to save settings");
				return;
			}
			setUiError(null);
			if (notice) setUiNotice(notice);
			await props.onSaved();
		} catch (err) {
			setUiError(err instanceof Error ? err.message : "Settings IPC unavailable");
		}
	};
	const triggerAction = async (action) => {
		if (busyAction()) return;
		if (action === "legacy-purge" && !confirmPurge()) {
			setConfirmPurge(true);
			setUiNotice("Armed: click \"Confirm Purge\" again to erase local .pantheon stores");
			return;
		}
		setConfirmPurge(false);
		setBusyAction(action);
		try {
			const raw = await props.ctx.main(PantheonBridge).runAction(JSON.stringify({
				directory: props.directory(),
				action,
				channel: sharedSnapshot().updateChannel
			}));
			const res = JSON.parse(raw);
			if (res.ok === false) setUiError(res.error ?? "Action failed");
			else {
				setUiError(null);
				if (res.message) setUiNotice(res.message);
			}
			await props.onSaved();
		} catch (err) {
			setUiError(err instanceof Error ? err.message : "Action IPC unavailable");
		} finally {
			setBusyAction(null);
		}
	};
	const scopedBehaviors = () => gateScope() === "project" ? sharedSnapshot().behaviorsProject : sharedSnapshot().behaviorsGlobal;
	const tui = () => sharedSnapshot().tuiPrefs;
	const renderTuiToggle = (id, label, current, note) => (() => {
		var _el$53 = _tmpl$16(), _el$54 = _el$53.firstChild, _el$55 = _el$54.firstChild, _el$57 = _el$54.nextSibling;
		(0, solid_js_web.insert)(_el$55, label);
		(0, solid_js_web.insert)(_el$54, (0, solid_js_web.createComponent)(solid_js.Show, {
			when: note,
			get children() {
				var _el$56 = _tmpl$15();
				(0, solid_js_web.insert)(_el$56, note);
				return _el$56;
			}
		}), null);
		_el$57.$$click = () => void savePatch({ tuiPref: {
			id,
			value: current ? "disabled" : "enabled"
		} });
		(0, solid_js_web.insert)(_el$57, current ? "enabled" : "disabled");
		(0, solid_js_web.effect)((_p$) => {
			var _v$9 = rowStyle, _v$0 = {
				...pillButtonStyle(false),
				color: current ? "#4ade80" : "#f87171"
			};
			_p$.e = (0, solid_js_web.style)(_el$53, _v$9, _p$.e);
			_p$.t = (0, solid_js_web.style)(_el$57, _v$0, _p$.t);
			return _p$;
		}, {
			e: void 0,
			t: void 0
		});
		return _el$53;
	})();
	const renderTuiCycle = (id, label, current, options) => (() => {
		var _el$58 = _tmpl$17(), _el$59 = _el$58.firstChild, _el$60 = _el$59.firstChild, _el$61 = _el$60.nextSibling, _el$62 = _el$59.nextSibling;
		(0, solid_js_web.insert)(_el$60, label);
		(0, solid_js_web.insert)(_el$61, current);
		(0, solid_js_web.insert)(_el$62, () => options.map((opt) => (() => {
			var _el$63 = _tmpl$18();
			_el$63.$$click = () => void savePatch({ tuiPref: {
				id,
				value: opt
			} });
			(0, solid_js_web.insert)(_el$63, opt);
			(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$63, pillButtonStyle(current === opt), _$p));
			return _el$63;
		})()));
		(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$59, rowStyle, _$p));
		return _el$58;
	})();
	return (() => {
		var _el$64 = _tmpl$46(), _el$68 = _el$64.firstChild;
		(0, solid_js_web.insert)(_el$64, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return uiNotice() !== null;
			},
			get children() {
				var _el$65 = _tmpl$19(), _el$66 = _el$65.firstChild, _el$67 = _el$66.nextSibling;
				(0, solid_js_web.insert)(_el$66, uiNotice);
				_el$67.$$click = () => setUiNotice(null);
				return _el$65;
			}
		}), _el$68);
		(0, solid_js_web.insert)(_el$68, () => [
			["overview", "Overview & Cost"],
			["gates", "Gates"],
			["preset", "Presets & Models"],
			["decision", "Decision (Jev)"],
			["autonomy", "Autonomy & J1"],
			["tui", "TUI & Layout"],
			["updates", "Updates & Cleanup"],
			["doctor", "Doctor & About"]
		].map(([id, label]) => (() => {
			var _el$203 = _tmpl$18();
			_el$203.$$click = () => {
				setConfirmPurge(false);
				setSection(id);
			};
			(0, solid_js_web.insert)(_el$203, label);
			(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$203, pillButtonStyle(section() === id), _$p));
			return _el$203;
		})()));
		(0, solid_js_web.insert)(_el$64, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return section() === "overview";
			},
			get children() {
				return [
					(() => {
						var _el$69 = _tmpl$21(), _el$71 = _el$69.firstChild.nextSibling, _el$73 = _el$71.firstChild.nextSibling;
						(0, solid_js_web.insert)(_el$73, () => `$${sharedSnapshot().todayCostUSD.toFixed(2)} / $${sharedSnapshot().monthCostUSD.toFixed(2)}`);
						(0, solid_js_web.insert)(_el$69, (0, solid_js_web.createComponent)(solid_js.Show, {
							get when() {
								return sharedSnapshot().modelSpend.length > 0;
							},
							get children() {
								var _el$74 = _tmpl$20();
								_el$74.firstChild;
								(0, solid_js_web.insert)(_el$74, (0, solid_js_web.createComponent)(solid_js.For, {
									get each() {
										return sharedSnapshot().modelSpend;
									},
									children: (m) => (() => {
										var _el$204 = _tmpl$47(), _el$205 = _el$204.firstChild, _el$206 = _el$205.nextSibling;
										(0, solid_js_web.insert)(_el$205, () => `${m.providerID}/${m.modelID}`);
										(0, solid_js_web.insert)(_el$206, () => `${(m.tokens / 1e3).toFixed(1)}k tok · ${m.estimatedUsd !== void 0 ? `$${m.estimatedUsd.toFixed(2)}` : "unpriced"}`);
										(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$204, { ...rowStyle }, _$p));
										return _el$204;
									})()
								}), null);
								return _el$74;
							}
						}), null);
						(0, solid_js_web.effect)((_p$) => {
							var _v$1 = cardStyle, _v$10 = rowStyle;
							_p$.e = (0, solid_js_web.style)(_el$69, _v$1, _p$.e);
							_p$.t = (0, solid_js_web.style)(_el$71, _v$10, _p$.t);
							return _p$;
						}, {
							e: void 0,
							t: void 0
						});
						return _el$69;
					})(),
					(() => {
						var _el$76 = _tmpl$22(), _el$77 = _el$76.firstChild, _el$79 = _el$77.firstChild.nextSibling, _el$80 = _el$77.nextSibling, _el$82 = _el$80.firstChild.nextSibling, _el$83 = _el$80.nextSibling, _el$85 = _el$83.firstChild.nextSibling;
						(0, solid_js_web.insert)(_el$79, () => [
							"shadow",
							"enforce",
							"off"
						].map((mode) => (() => {
							var _el$207 = _tmpl$18();
							_el$207.$$click = () => void savePatch({ gateMode: mode });
							(0, solid_js_web.insert)(_el$207, mode);
							(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$207, pillButtonStyle(sharedSnapshot().gateMode === mode), _$p));
							return _el$207;
						})()));
						_el$82.$$click = () => void savePatch({ cockpitAutoOpen: !sharedSnapshot().cockpitAutoOpen });
						(0, solid_js_web.insert)(_el$82, () => sharedSnapshot().cockpitAutoOpen ? "enabled" : "disabled");
						_el$85.$$click = () => void savePatch({ cockpitShowTodo: !sharedSnapshot().cockpitShowTodo });
						(0, solid_js_web.insert)(_el$85, () => sharedSnapshot().cockpitShowTodo ? "enabled" : "disabled");
						(0, solid_js_web.effect)((_p$) => {
							var _v$11 = cardStyle, _v$12 = rowStyle, _v$13 = rowStyle, _v$14 = {
								...pillButtonStyle(false),
								color: sharedSnapshot().cockpitAutoOpen ? "#4ade80" : "#f87171"
							}, _v$15 = rowStyle, _v$16 = {
								...pillButtonStyle(false),
								color: sharedSnapshot().cockpitShowTodo ? "#4ade80" : "#f87171"
							};
							_p$.e = (0, solid_js_web.style)(_el$76, _v$11, _p$.e);
							_p$.t = (0, solid_js_web.style)(_el$77, _v$12, _p$.t);
							_p$.a = (0, solid_js_web.style)(_el$80, _v$13, _p$.a);
							_p$.o = (0, solid_js_web.style)(_el$82, _v$14, _p$.o);
							_p$.i = (0, solid_js_web.style)(_el$83, _v$15, _p$.i);
							_p$.n = (0, solid_js_web.style)(_el$85, _v$16, _p$.n);
							return _p$;
						}, {
							e: void 0,
							t: void 0,
							a: void 0,
							o: void 0,
							i: void 0,
							n: void 0
						});
						return _el$76;
					})(),
					(() => {
						var _el$86 = _tmpl$23();
						(0, solid_js_web.insert)(_el$86, () => `Preset: ${sharedSnapshot().presetProjectOverride ?? sharedSnapshot().activePreset} · Decision: ${sharedSnapshot().decisionEnabled ? sharedSnapshot().decisionMode : "off"} · Overrides: ${sharedSnapshot().overridesCount} · Plans: ${sharedSnapshot().artifactsCount} · Jobs: ${sharedSnapshot().activeJobs.length}`);
						return _el$86;
					})()
				];
			}
		}), null);
		(0, solid_js_web.insert)(_el$64, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return section() === "gates";
			},
			get children() {
				return [(() => {
					var _el$87 = _tmpl$25(), _el$88 = _el$87.firstChild, _el$90 = _el$88.firstChild.nextSibling;
					(0, solid_js_web.insert)(_el$90, () => ["project", "global"].map((sc) => (() => {
						var _el$208 = _tmpl$18();
						_el$208.$$click = () => setGateScope(sc);
						(0, solid_js_web.insert)(_el$208, sc === "project" ? "project (.pantheon)" : "global (~/.config)");
						(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$208, pillButtonStyle(gateScope() === sc), _$p));
						return _el$208;
					})()));
					(0, solid_js_web.insert)(_el$87, (0, solid_js_web.createComponent)(solid_js.Show, {
						get when() {
							return (0, solid_js_web.memo)(() => gateScope() === "global")() && sharedSnapshot().corruptGlobalOverrides;
						},
						get children() {
							return _tmpl$24();
						}
					}), null);
					(0, solid_js_web.effect)((_p$) => {
						var _v$17 = cardStyle, _v$18 = rowStyle;
						_p$.e = (0, solid_js_web.style)(_el$87, _v$17, _p$.e);
						_p$.t = (0, solid_js_web.style)(_el$88, _v$18, _p$.t);
						return _p$;
					}, {
						e: void 0,
						t: void 0
					});
					return _el$87;
				})(), (0, solid_js_web.memo)(() => ["install", "runtime"].map((kind) => (() => {
					var _el$209 = _tmpl$44(), _el$210 = _el$209.firstChild;
					(0, solid_js_web.insert)(_el$210, kind === "install" ? "Install Skills" : "Runtime Gates");
					(0, solid_js_web.insert)(_el$209, (0, solid_js_web.createComponent)(solid_js.For, {
						get each() {
							return scopedBehaviors().filter((b) => b.kind === kind);
						},
						children: (beh) => {
							const blockedByProject = () => gateScope() === "global" && beh.projectOverride;
							return (() => {
								var _el$211 = _tmpl$49(), _el$212 = _el$211.firstChild, _el$213 = _el$212.firstChild, _el$215 = _el$213.nextSibling, _el$216 = _el$212.nextSibling;
								(0, solid_js_web.insert)(_el$213, () => beh.title, null);
								(0, solid_js_web.insert)(_el$213, (0, solid_js_web.createComponent)(solid_js.Show, {
									get when() {
										return beh.projectOverride;
									},
									get children() {
										return _tmpl$48();
									}
								}), null);
								(0, solid_js_web.insert)(_el$215, () => beh.description);
								_el$216.$$click = () => void savePatch({ overrideToggle: {
									id: beh.id,
									scope: gateScope(),
									enabled: !beh.enabled
								} });
								(0, solid_js_web.insert)(_el$216, () => beh.enabled ? "enabled" : "disabled");
								(0, solid_js_web.effect)((_p$) => {
									var _v$64 = rowStyle, _v$65 = blockedByProject(), _v$66 = {
										...pillButtonStyle(false),
										opacity: blockedByProject() ? .45 : 1,
										cursor: blockedByProject() ? "not-allowed" : "pointer",
										color: beh.enabled ? "#4ade80" : "#f87171"
									};
									_p$.e = (0, solid_js_web.style)(_el$211, _v$64, _p$.e);
									_v$65 !== _p$.t && (_el$216.disabled = _p$.t = _v$65);
									_p$.a = (0, solid_js_web.style)(_el$216, _v$66, _p$.a);
									return _p$;
								}, {
									e: void 0,
									t: void 0,
									a: void 0
								});
								return _el$211;
							})();
						}
					}), null);
					(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$209, cardStyle, _$p));
					return _el$209;
				})()))];
			}
		}), null);
		(0, solid_js_web.insert)(_el$64, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return section() === "preset";
			},
			get children() {
				return [
					(() => {
						var _el$92 = _tmpl$26(), _el$93 = _el$92.firstChild, _el$95 = _el$93.firstChild.nextSibling, _el$96 = _el$93.nextSibling;
						(0, solid_js_web.insert)(_el$95, (() => {
							var _c$2 = (0, solid_js_web.memo)(() => !!sharedSnapshot().presetProjectOverride);
							return () => _c$2() ? `project wins: ${sharedSnapshot().presetProjectOverride}` : sharedSnapshot().activePreset;
						})());
						(0, solid_js_web.insert)(_el$96, () => [PRESET_NONE, ...PRESET_NAMES].map((preset) => (() => {
							var _el$217 = _tmpl$18();
							_el$217.$$click = () => void savePatch({ preset }, `Global preset set to ${preset}`);
							(0, solid_js_web.insert)(_el$217, preset);
							(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$217, pillButtonStyle(sharedSnapshot().activePreset === preset), _$p));
							return _el$217;
						})()));
						(0, solid_js_web.effect)((_p$) => {
							var _v$19 = cardStyle, _v$20 = rowStyle;
							_p$.e = (0, solid_js_web.style)(_el$92, _v$19, _p$.e);
							_p$.t = (0, solid_js_web.style)(_el$93, _v$20, _p$.t);
							return _p$;
						}, {
							e: void 0,
							t: void 0
						});
						return _el$92;
					})(),
					(() => {
						var _el$97 = _tmpl$27(), _el$98 = _el$97.firstChild, _el$100 = _el$98.firstChild.nextSibling, _el$101 = _el$98.nextSibling;
						(0, solid_js_web.insert)(_el$100, () => sharedSnapshot().visionModel);
						(0, solid_js_web.insert)(_el$101, () => VISION_MODEL_OPTIONS.map((vm) => (() => {
							var _el$218 = _tmpl$18();
							_el$218.$$click = () => void savePatch({ visionModel: vm }, `Vision model set to ${vm}`);
							(0, solid_js_web.insert)(_el$218, vm);
							(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$218, pillButtonStyle(sharedSnapshot().visionModel === vm), _$p));
							return _el$218;
						})()));
						(0, solid_js_web.effect)((_p$) => {
							var _v$21 = cardStyle, _v$22 = rowStyle;
							_p$.e = (0, solid_js_web.style)(_el$97, _v$21, _p$.e);
							_p$.t = (0, solid_js_web.style)(_el$98, _v$22, _p$.t);
							return _p$;
						}, {
							e: void 0,
							t: void 0
						});
						return _el$97;
					})(),
					(() => {
						var _el$102 = _tmpl$28();
						_el$102.firstChild;
						(0, solid_js_web.insert)(_el$102, (0, solid_js_web.createComponent)(solid_js.For, {
							get each() {
								return sharedSnapshot().agentModels;
							},
							children: (item) => (() => {
								var _el$219 = _tmpl$51(), _el$220 = _el$219.firstChild, _el$221 = _el$220.firstChild, _el$223 = _el$221.nextSibling.firstChild, _el$224 = _el$223.nextSibling;
								(0, solid_js_web.insert)(_el$221, () => item.agent);
								(0, solid_js_web.insert)(_el$223, (() => {
									var _c$8 = (0, solid_js_web.memo)(() => !!item.model);
									return () => _c$8() ? `${item.model} (${item.variant})` : "preset default";
								})());
								_el$224.$$click = () => {
									if (editingAgent() === item.agent) setEditingAgent(null);
									else {
										setEditingAgent(item.agent);
										setAgentModelInput(item.model);
										setAgentVariantInput(item.variant || "default");
									}
								};
								(0, solid_js_web.insert)(_el$224, () => editingAgent() === item.agent ? "Cancel" : "Edit");
								(0, solid_js_web.insert)(_el$219, (0, solid_js_web.createComponent)(solid_js.Show, {
									get when() {
										return editingAgent() === item.agent;
									},
									get children() {
										var _el$225 = _tmpl$50(), _el$226 = _el$225.firstChild, _el$227 = _el$226.nextSibling, _el$228 = _el$227.nextSibling;
										_el$226.$$input = (e) => setAgentModelInput(e.currentTarget.value);
										_el$227.addEventListener("change", (e) => setAgentVariantInput(e.currentTarget.value));
										_el$228.$$click = () => {
											const agent = item.agent;
											const model = agentModelInput();
											const variant = agentVariantInput();
											setEditingAgent(null);
											savePatch({ agentModel: {
												agent,
												model,
												variant
											} }, `Updated ${agent} model override`);
										};
										(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$228, pillButtonStyle(true), _$p));
										(0, solid_js_web.effect)(() => _el$226.value = agentModelInput());
										(0, solid_js_web.effect)(() => _el$227.value = agentVariantInput());
										return _el$225;
									}
								}), null);
								(0, solid_js_web.effect)((_p$) => {
									var _v$67 = rowStyle, _v$68 = pillButtonStyle(editingAgent() === item.agent);
									_p$.e = (0, solid_js_web.style)(_el$220, _v$67, _p$.e);
									_p$.t = (0, solid_js_web.style)(_el$224, _v$68, _p$.t);
									return _p$;
								}, {
									e: void 0,
									t: void 0
								});
								return _el$219;
							})()
						}), null);
						(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$102, cardStyle, _$p));
						return _el$102;
					})()
				];
			}
		}), null);
		(0, solid_js_web.insert)(_el$64, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return section() === "decision";
			},
			get children() {
				return [(() => {
					var _el$104 = _tmpl$31(), _el$107 = _el$104.firstChild.nextSibling, _el$109 = _el$107.firstChild.nextSibling, _el$110 = _el$107.nextSibling, _el$112 = _el$110.firstChild.nextSibling, _el$113 = _el$110.nextSibling, _el$114 = _el$113.firstChild, _el$116 = _el$114.firstChild.nextSibling, _el$117 = _el$114.nextSibling, _el$118 = _el$113.nextSibling, _el$120 = _el$118.firstChild.nextSibling;
					(0, solid_js_web.insert)(_el$104, (0, solid_js_web.createComponent)(solid_js.Show, {
						get when() {
							return sharedSnapshot().decisionCorrupt;
						},
						get children() {
							return _tmpl$29();
						}
					}), _el$107);
					_el$109.$$click = () => void savePatch({ decisionEnabled: !sharedSnapshot().decisionEnabled });
					(0, solid_js_web.insert)(_el$109, () => sharedSnapshot().decisionEnabled ? "enabled" : "disabled");
					(0, solid_js_web.insert)(_el$112, () => DECISION_SELECTION_CYCLE.map((mode) => (() => {
						var _el$229 = _tmpl$18();
						_el$229.$$click = () => void savePatch({ decisionMode: mode });
						(0, solid_js_web.insert)(_el$229, mode);
						(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$229, pillButtonStyle(sharedSnapshot().decisionMode === mode), _$p));
						return _el$229;
					})()));
					(0, solid_js_web.insert)(_el$116, (() => {
						var _c$3 = (0, solid_js_web.memo)(() => sharedSnapshot().decisionMode === "local");
						return () => _c$3() ? "local (on-device)" : sharedSnapshot().decisionTarget;
					})());
					(0, solid_js_web.insert)(_el$117, () => DECISION_TARGET_CYCLE.map((target) => (() => {
						var _el$230 = _tmpl$18();
						_el$230.$$click = () => void savePatch({ decisionTarget: target });
						(0, solid_js_web.insert)(_el$230, target);
						(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$230, pillButtonStyle(sharedSnapshot().decisionTarget === target), _$p));
						return _el$230;
					})()));
					_el$120.$$click = () => void savePatch({ decisionConsent: !sharedSnapshot().decisionConsent });
					(0, solid_js_web.insert)(_el$120, () => sharedSnapshot().decisionConsent ? "granted" : "not granted");
					(0, solid_js_web.insert)(_el$104, (0, solid_js_web.createComponent)(solid_js.Show, {
						get when() {
							return sharedSnapshot().decisionCandidates.length > 0;
						},
						get children() {
							var _el$121 = _tmpl$30();
							(0, solid_js_web.insert)(_el$121, () => `Candidates: ${sharedSnapshot().decisionCandidates.map((c) => `${c.provider}/${c.model}`).join(", ")}`);
							return _el$121;
						}
					}), null);
					(0, solid_js_web.effect)((_p$) => {
						var _v$23 = cardStyle, _v$24 = rowStyle, _v$25 = {
							...pillButtonStyle(sharedSnapshot().decisionEnabled),
							color: sharedSnapshot().decisionEnabled ? "#111" : "inherit"
						}, _v$26 = rowStyle, _v$27 = rowStyle, _v$28 = rowStyle, _v$29 = {
							...pillButtonStyle(false),
							color: sharedSnapshot().decisionConsent ? "#4ade80" : "#f87171"
						};
						_p$.e = (0, solid_js_web.style)(_el$104, _v$23, _p$.e);
						_p$.t = (0, solid_js_web.style)(_el$107, _v$24, _p$.t);
						_p$.a = (0, solid_js_web.style)(_el$109, _v$25, _p$.a);
						_p$.o = (0, solid_js_web.style)(_el$110, _v$26, _p$.o);
						_p$.i = (0, solid_js_web.style)(_el$114, _v$27, _p$.i);
						_p$.n = (0, solid_js_web.style)(_el$118, _v$28, _p$.n);
						_p$.s = (0, solid_js_web.style)(_el$120, _v$29, _p$.s);
						return _p$;
					}, {
						e: void 0,
						t: void 0,
						a: void 0,
						o: void 0,
						i: void 0,
						n: void 0,
						s: void 0
					});
					return _el$104;
				})(), (() => {
					var _el$122 = _tmpl$32();
					_el$122.firstChild;
					(0, solid_js_web.insert)(_el$122, (0, solid_js_web.createComponent)(solid_js.For, {
						get each() {
							return sharedSnapshot().credentials;
						},
						children: (cred) => (() => {
							var _el$231 = _tmpl$52(), _el$232 = _el$231.firstChild, _el$233 = _el$232.firstChild, _el$234 = _el$233.nextSibling, _el$235 = _el$232.nextSibling;
							(0, solid_js_web.insert)(_el$233, () => cred.provider);
							(0, solid_js_web.insert)(_el$234, () => cred.note);
							(0, solid_js_web.insert)(_el$235, () => cred.status);
							(0, solid_js_web.effect)((_p$) => {
								var _v$69 = rowStyle, _v$70 = cred.status === "MISSING" ? "#f87171" : "#4ade80";
								_p$.e = (0, solid_js_web.style)(_el$231, _v$69, _p$.e);
								_v$70 !== _p$.t && (0, solid_js_web.setStyleProperty)(_el$235, "color", _p$.t = _v$70);
								return _p$;
							}, {
								e: void 0,
								t: void 0
							});
							return _el$231;
						})()
					}), null);
					(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$122, cardStyle, _$p));
					return _el$122;
				})()];
			}
		}), null);
		(0, solid_js_web.insert)(_el$64, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return section() === "autonomy";
			},
			get children() {
				return [
					(() => {
						var _el$124 = _tmpl$34(), _el$125 = _el$124.firstChild;
						_el$125.firstChild;
						var _el$128 = _el$125.nextSibling, _el$130 = _el$128.firstChild.nextSibling, _el$131 = _el$128.nextSibling, _el$133 = _el$131.firstChild.nextSibling, _el$134 = _el$131.nextSibling, _el$136 = _el$134.firstChild.nextSibling;
						(0, solid_js_web.insert)(_el$125, (0, solid_js_web.createComponent)(solid_js.Show, {
							get when() {
								return sharedSnapshot().goalLoopRestartPending;
							},
							get children() {
								return _tmpl$33();
							}
						}), null);
						_el$130.$$click = () => void savePatch({ goalLoop: { enabled: !sharedSnapshot().goalLoop.enabled } });
						(0, solid_js_web.insert)(_el$130, () => sharedSnapshot().goalLoop.enabled ? "enabled" : "disabled");
						(0, solid_js_web.insert)(_el$133, () => MAX_CONTINUATIONS_CYCLE.map((val) => (() => {
							var _el$236 = _tmpl$18();
							_el$236.$$click = () => void savePatch({ goalLoop: { maxContinuations: Number(val) } });
							(0, solid_js_web.insert)(_el$236, val);
							(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$236, pillButtonStyle(String(sharedSnapshot().goalLoop.maxContinuations) === val), _$p));
							return _el$236;
						})()));
						(0, solid_js_web.insert)(_el$136, () => COOLDOWN_MS_CYCLE.map((val) => (() => {
							var _el$237 = _tmpl$18();
							_el$237.$$click = () => void savePatch({ goalLoop: { cooldownMs: Number(val) } });
							(0, solid_js_web.insert)(_el$237, val);
							(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$237, pillButtonStyle(String(sharedSnapshot().goalLoop.cooldownMs) === val), _$p));
							return _el$237;
						})()));
						(0, solid_js_web.effect)((_p$) => {
							var _v$30 = cardStyle, _v$31 = rowStyle, _v$32 = rowStyle, _v$33 = {
								...pillButtonStyle(false),
								color: sharedSnapshot().goalLoop.enabled ? "#4ade80" : "#f87171"
							}, _v$34 = rowStyle, _v$35 = rowStyle;
							_p$.e = (0, solid_js_web.style)(_el$124, _v$30, _p$.e);
							_p$.t = (0, solid_js_web.style)(_el$125, _v$31, _p$.t);
							_p$.a = (0, solid_js_web.style)(_el$128, _v$32, _p$.a);
							_p$.o = (0, solid_js_web.style)(_el$130, _v$33, _p$.o);
							_p$.i = (0, solid_js_web.style)(_el$131, _v$34, _p$.i);
							_p$.n = (0, solid_js_web.style)(_el$134, _v$35, _p$.n);
							return _p$;
						}, {
							e: void 0,
							t: void 0,
							a: void 0,
							o: void 0,
							i: void 0,
							n: void 0
						});
						return _el$124;
					})(),
					(() => {
						var _el$137 = _tmpl$35(), _el$139 = _el$137.firstChild.nextSibling, _el$141 = _el$139.firstChild.nextSibling, _el$142 = _el$139.nextSibling, _el$144 = _el$142.firstChild.nextSibling;
						(0, solid_js_web.insert)(_el$141, () => MONTHLY_USD_CYCLE.map((val) => (() => {
							var _el$238 = _tmpl$18();
							_el$238.$$click = () => void savePatch({ budgetMonthly: val });
							(0, solid_js_web.insert)(_el$238, val);
							(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$238, pillButtonStyle(formatUsd(sharedSnapshot().budgets.monthlyUsd) === val), _$p));
							return _el$238;
						})()));
						(0, solid_js_web.insert)(_el$144, () => PER_DECISION_USD_CYCLE.map((val) => (() => {
							var _el$239 = _tmpl$18();
							_el$239.$$click = () => void savePatch({ budgetPerDecision: val });
							(0, solid_js_web.insert)(_el$239, val);
							(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$239, pillButtonStyle(formatUsd(sharedSnapshot().budgets.perDecisionUsd) === val), _$p));
							return _el$239;
						})()));
						(0, solid_js_web.effect)((_p$) => {
							var _v$36 = cardStyle, _v$37 = rowStyle, _v$38 = rowStyle;
							_p$.e = (0, solid_js_web.style)(_el$137, _v$36, _p$.e);
							_p$.t = (0, solid_js_web.style)(_el$139, _v$37, _p$.t);
							_p$.a = (0, solid_js_web.style)(_el$142, _v$38, _p$.a);
							return _p$;
						}, {
							e: void 0,
							t: void 0,
							a: void 0
						});
						return _el$137;
					})(),
					(() => {
						var _el$145 = _tmpl$36(), _el$147 = _el$145.firstChild.nextSibling, _el$149 = _el$147.firstChild.nextSibling, _el$150 = _el$147.nextSibling, _el$152 = _el$150.firstChild.nextSibling, _el$153 = _el$150.nextSibling, _el$155 = _el$153.firstChild.nextSibling, _el$156 = _el$153.nextSibling;
						(0, solid_js_web.insert)(_el$149, () => sharedSnapshot().j1Mode);
						(0, solid_js_web.insert)(_el$152, () => sharedSnapshot().j1Threshold);
						(0, solid_js_web.insert)(_el$155, (() => {
							var _c$4 = (0, solid_js_web.memo)(() => !!sharedSnapshot().j1DisabledByOverride);
							return () => _c$4() ? "disabled via overrides" : sharedSnapshot().j1Mode === "off" ? "off (env unset)" : "active";
						})());
						(0, solid_js_web.insert)(_el$156, `${J1_FLAG_ENV} / ${J1_THRESHOLD_ENV} · read once at startup`);
						(0, solid_js_web.effect)((_p$) => {
							var _v$39 = cardStyle, _v$40 = rowStyle, _v$41 = rowStyle, _v$42 = rowStyle;
							_p$.e = (0, solid_js_web.style)(_el$145, _v$39, _p$.e);
							_p$.t = (0, solid_js_web.style)(_el$147, _v$40, _p$.t);
							_p$.a = (0, solid_js_web.style)(_el$150, _v$41, _p$.a);
							_p$.o = (0, solid_js_web.style)(_el$153, _v$42, _p$.o);
							return _p$;
						}, {
							e: void 0,
							t: void 0,
							a: void 0,
							o: void 0
						});
						return _el$145;
					})()
				];
			}
		}), null);
		(0, solid_js_web.insert)(_el$64, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return section() === "tui";
			},
			get children() {
				return [
					(() => {
						var _el$157 = _tmpl$37();
						_el$157.firstChild;
						(0, solid_js_web.insert)(_el$157, () => renderTuiCycle("tui.layout.preset", "Layout Preset", tui().layout.preset, LAYOUT_PRESETS_CYCLE), null);
						(0, solid_js_web.insert)(_el$157, () => renderTuiCycle("tui.layout.separator", "Separator", tui().layout.separator, SEPARATOR_STYLES_CYCLE), null);
						(0, solid_js_web.insert)(_el$157, () => renderTuiCycle("tui.layout.settingsView", "Settings Surface", tui().layout.settingsView ?? "docked", SETTINGS_VIEW_MODES), null);
						(0, solid_js_web.insert)(_el$157, () => renderTuiCycle("tui.layout.language", "Language / Idioma", tui().layout.language ?? "auto", LANGUAGE_CYCLE), null);
						(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$157, cardStyle, _$p));
						return _el$157;
					})(),
					(() => {
						var _el$159 = _tmpl$38();
						_el$159.firstChild;
						(0, solid_js_web.insert)(_el$159, () => renderTuiCycle("tui.theme.mode", "Theme Mode", tui().theme?.mode ?? "auto", THEME_MODES_CYCLE), null);
						(0, solid_js_web.insert)(_el$159, () => renderTuiCycle("tui.theme.accent", "Accent Color", tui().theme?.accent ?? "host", ACCENT_COLORS_CYCLE), null);
						(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$159, cardStyle, _$p));
						return _el$159;
					})(),
					(() => {
						var _el$161 = _tmpl$39();
						_el$161.firstChild;
						(0, solid_js_web.insert)(_el$161, () => renderTuiCycle("tui.sidebar.context.barShape", "Bar Shape", tui().sidebar.context.barShape, BAR_SHAPES_CYCLE), null);
						(0, solid_js_web.insert)(_el$161, () => renderTuiCycle("tui.sidebar.context.barWidth", "Bar Width", tui().sidebar.context.barWidth, BAR_WIDTHS_CYCLE), null);
						(0, solid_js_web.insert)(_el$161, () => renderTuiCycle("tui.sidebar.context.gauge", "Gauge Style", tui().sidebar.context.gauge, GAUGE_STYLES), null);
						(0, solid_js_web.insert)(_el$161, () => renderTuiToggle("tui.sidebar.context.evenMark", "Even-Use Mark (50%)", tui().sidebar.context.evenMark), null);
						(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$161, cardStyle, _$p));
						return _el$161;
					})(),
					(() => {
						var _el$163 = _tmpl$40();
						_el$163.firstChild;
						(0, solid_js_web.insert)(_el$163, () => renderTuiToggle("tui.sidebar.header.version", "Header: Version", tui().sidebar.header.version), null);
						(0, solid_js_web.insert)(_el$163, () => renderTuiToggle("tui.sidebar.header.preset", "Header: Preset", tui().sidebar.header.preset), null);
						(0, solid_js_web.insert)(_el$163, () => renderTuiToggle("tui.sidebar.header.session", "Header: Session", tui().sidebar.header.session), null);
						(0, solid_js_web.insert)(_el$163, () => renderTuiToggle("tui.sidebar.block.context", "Block: Context", tui().sidebar.blocks.context), null);
						(0, solid_js_web.insert)(_el$163, () => renderTuiToggle("tui.sidebar.block.git", "Block: Git", tui().sidebar.blocks.git), null);
						(0, solid_js_web.insert)(_el$163, () => renderTuiToggle("tui.sidebar.block.todo", "Block: Todo", tui().sidebar.blocks.todo ?? true), null);
						(0, solid_js_web.insert)(_el$163, () => renderTuiToggle("tui.sidebar.block.dispatch", "Block: Dispatch", tui().sidebar.blocks.dispatch), null);
						(0, solid_js_web.insert)(_el$163, () => renderTuiToggle("tui.sidebar.context.tokens", "Context: Tokens Row", tui().sidebar.context.tokens), null);
						(0, solid_js_web.insert)(_el$163, () => renderTuiToggle("tui.sidebar.context.spent", "Context: Spent Row", tui().sidebar.context.spent), null);
						(0, solid_js_web.insert)(_el$163, () => renderTuiToggle("tui.sidebar.context.modelUsage", "Context: Model Usage", tui().sidebar.context.modelUsage), null);
						(0, solid_js_web.insert)(_el$163, () => renderTuiToggle("tui.sidebar.context.performance", "Context: Performance", tui().sidebar.context.performance), null);
						(0, solid_js_web.insert)(_el$163, () => renderTuiToggle("tui.sidebar.context.turnCost", "Context: Turn Cost", tui().sidebar.context.turnCost), null);
						(0, solid_js_web.insert)(_el$163, () => renderTuiToggle("tui.sidebar.context.tokenAnatomy", "Context: Token Anatomy", tui().sidebar.context.tokenAnatomy), null);
						(0, solid_js_web.insert)(_el$163, () => renderTuiToggle("tui.sidebar.context.localSpend", "Context: Local Spend", tui().sidebar.context.localSpend), null);
						(0, solid_js_web.insert)(_el$163, () => renderTuiToggle("tui.footer.prompt", "Footer: Prompt", tui().footer.prompt), null);
						(0, solid_js_web.insert)(_el$163, () => renderTuiToggle("tui.footer.home", "Footer: Home Status", tui().footer.home), null);
						(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$163, cardStyle, _$p));
						return _el$163;
					})()
				];
			}
		}), null);
		(0, solid_js_web.insert)(_el$64, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return section() === "updates";
			},
			get children() {
				return [(() => {
					var _el$165 = _tmpl$41(), _el$167 = _el$165.firstChild.nextSibling, _el$169 = _el$167.firstChild.nextSibling, _el$170 = _el$167.nextSibling, _el$172 = _el$170.firstChild.nextSibling, _el$174 = _el$170.nextSibling.firstChild, _el$175 = _el$174.nextSibling;
					(0, solid_js_web.insert)(_el$169, () => ["stable", "beta"].map((ch) => (() => {
						var _el$240 = _tmpl$18();
						_el$240.$$click = () => void savePatch({ updateChannel: ch });
						(0, solid_js_web.insert)(_el$240, ch);
						(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$240, pillButtonStyle(sharedSnapshot().updateChannel === ch), _$p));
						return _el$240;
					})()));
					(0, solid_js_web.insert)(_el$172, (() => {
						var _c$5 = (0, solid_js_web.memo)(() => !!sharedSnapshot().latestVersion);
						return () => _c$5() ? `v${sharedSnapshot().latestVersion}` : "not checked";
					})());
					_el$174.$$click = () => void triggerAction("update-check");
					(0, solid_js_web.insert)(_el$174, () => busyAction() === "update-check" ? "Checking…" : "Check Now");
					_el$175.$$click = () => void triggerAction("update-run");
					(0, solid_js_web.insert)(_el$175, () => busyAction() === "update-run" ? "Updating…" : "Update / Refresh Plugin");
					(0, solid_js_web.effect)((_p$) => {
						var _v$43 = cardStyle, _v$44 = rowStyle, _v$45 = rowStyle, _v$46 = busyAction() !== null, _v$47 = pillButtonStyle(false), _v$48 = busyAction() !== null, _v$49 = pillButtonStyle(true);
						_p$.e = (0, solid_js_web.style)(_el$165, _v$43, _p$.e);
						_p$.t = (0, solid_js_web.style)(_el$167, _v$44, _p$.t);
						_p$.a = (0, solid_js_web.style)(_el$170, _v$45, _p$.a);
						_v$46 !== _p$.o && (_el$174.disabled = _p$.o = _v$46);
						_p$.i = (0, solid_js_web.style)(_el$174, _v$47, _p$.i);
						_v$48 !== _p$.n && (_el$175.disabled = _p$.n = _v$48);
						_p$.s = (0, solid_js_web.style)(_el$175, _v$49, _p$.s);
						return _p$;
					}, {
						e: void 0,
						t: void 0,
						a: void 0,
						o: void 0,
						i: void 0,
						n: void 0,
						s: void 0
					});
					return _el$165;
				})(), (() => {
					var _el$176 = _tmpl$42(), _el$178 = _el$176.firstChild.nextSibling, _el$180 = _el$178.firstChild.nextSibling, _el$182 = _el$178.nextSibling.firstChild, _el$183 = _el$182.nextSibling, _el$184 = _el$183.nextSibling;
					(0, solid_js_web.insert)(_el$180, (() => {
						var _c$6 = (0, solid_js_web.memo)(() => !!sharedSnapshot().legacyAudit);
						return () => _c$6() ? (0, solid_js_web.memo)(() => sharedSnapshot().legacyAudit?.total === 0)() ? "clean (0 obsolete)" : `${sharedSnapshot().legacyAudit?.total ?? 0} item(s) (${formatBytes(sharedSnapshot().legacyAudit?.totalBytes ?? 0)})` : "not scanned";
					})());
					_el$182.$$click = () => void triggerAction("legacy-scan");
					(0, solid_js_web.insert)(_el$182, () => busyAction() === "legacy-scan" ? "Scanning…" : "Scan Legacy & Drift");
					_el$183.$$click = () => void triggerAction("legacy-clean");
					(0, solid_js_web.insert)(_el$183, () => busyAction() === "legacy-clean" ? "Cleaning…" : "Migrate & Clean Obsolete");
					_el$184.$$click = () => void triggerAction("legacy-purge");
					(0, solid_js_web.insert)(_el$184, (() => {
						var _c$7 = (0, solid_js_web.memo)(() => busyAction() === "legacy-purge");
						return () => _c$7() ? "Purging…" : confirmPurge() ? "Confirm Purge (.pantheon)" : "Purge Pantheon Data";
					})());
					(0, solid_js_web.effect)((_p$) => {
						var _v$50 = cardStyle, _v$51 = rowStyle, _v$52 = busyAction() !== null, _v$53 = pillButtonStyle(false), _v$54 = busyAction() !== null, _v$55 = pillButtonStyle(false), _v$56 = busyAction() !== null, _v$57 = {
							...pillButtonStyle(confirmPurge()),
							color: confirmPurge() ? "#111" : "#fca5a5",
							background: confirmPurge() ? "#ef4444" : "transparent"
						};
						_p$.e = (0, solid_js_web.style)(_el$176, _v$50, _p$.e);
						_p$.t = (0, solid_js_web.style)(_el$178, _v$51, _p$.t);
						_v$52 !== _p$.a && (_el$182.disabled = _p$.a = _v$52);
						_p$.o = (0, solid_js_web.style)(_el$182, _v$53, _p$.o);
						_v$54 !== _p$.i && (_el$183.disabled = _p$.i = _v$54);
						_p$.n = (0, solid_js_web.style)(_el$183, _v$55, _p$.n);
						_v$56 !== _p$.s && (_el$184.disabled = _p$.s = _v$56);
						_p$.h = (0, solid_js_web.style)(_el$184, _v$57, _p$.h);
						return _p$;
					}, {
						e: void 0,
						t: void 0,
						a: void 0,
						o: void 0,
						i: void 0,
						n: void 0,
						s: void 0,
						h: void 0
					});
					return _el$176;
				})()];
			}
		}), null);
		(0, solid_js_web.insert)(_el$64, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return section() === "doctor";
			},
			get children() {
				return [
					(() => {
						var _el$185 = _tmpl$43(), _el$187 = _el$185.firstChild.nextSibling, _el$189 = _el$187.firstChild.nextSibling, _el$190 = _el$187.nextSibling, _el$191 = _el$190.firstChild, _el$192 = _el$191.nextSibling, _el$193 = _el$190.nextSibling, _el$195 = _el$193.firstChild.nextSibling, _el$196 = _el$193.nextSibling, _el$198 = _el$196.firstChild.nextSibling;
						(0, solid_js_web.insert)(_el$189, () => `${sharedSnapshot().doctor.installVersion} (${sharedSnapshot().doctor.installStatus})`);
						(0, solid_js_web.insert)(_el$191, `Node Runtime (>= ${MIN_SUPPORTED_NODE_VERSION})`);
						(0, solid_js_web.insert)(_el$192, () => `v${sharedSnapshot().doctor.nodeVersion}`);
						(0, solid_js_web.insert)(_el$195, () => sharedSnapshot().doctor.overridesStatus);
						(0, solid_js_web.insert)(_el$198, () => sharedSnapshot().doctor.decisionStatus);
						(0, solid_js_web.effect)((_p$) => {
							var _v$58 = cardStyle, _v$59 = rowStyle, _v$60 = rowStyle, _v$61 = sharedSnapshot().doctor.nodeSupported ? "#4ade80" : "#f87171", _v$62 = rowStyle, _v$63 = rowStyle;
							_p$.e = (0, solid_js_web.style)(_el$185, _v$58, _p$.e);
							_p$.t = (0, solid_js_web.style)(_el$187, _v$59, _p$.t);
							_p$.a = (0, solid_js_web.style)(_el$190, _v$60, _p$.a);
							_v$61 !== _p$.o && (0, solid_js_web.setStyleProperty)(_el$192, "color", _p$.o = _v$61);
							_p$.i = (0, solid_js_web.style)(_el$193, _v$62, _p$.i);
							_p$.n = (0, solid_js_web.style)(_el$196, _v$63, _p$.n);
							return _p$;
						}, {
							e: void 0,
							t: void 0,
							a: void 0,
							o: void 0,
							i: void 0,
							n: void 0
						});
						return _el$185;
					})(),
					(0, solid_js_web.createComponent)(solid_js.Show, {
						get when() {
							return sharedSnapshot().changelogHighlights.length > 0;
						},
						get children() {
							var _el$199 = _tmpl$44(), _el$200 = _el$199.firstChild;
							(0, solid_js_web.insert)(_el$200, () => `What's New in v${resolveRunningVersion()}`);
							(0, solid_js_web.insert)(_el$199, (0, solid_js_web.createComponent)(solid_js.For, {
								get each() {
									return sharedSnapshot().changelogHighlights.slice(0, 8);
								},
								children: (hl) => (() => {
									var _el$241 = _tmpl$53(), _el$242 = _el$241.firstChild, _el$243 = _el$242.nextSibling;
									(0, solid_js_web.insert)(_el$242, () => hl.title);
									(0, solid_js_web.insert)(_el$243, () => `: ${hl.detail}`);
									return _el$241;
								})()
							}), null);
							(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$199, cardStyle, _$p));
							return _el$199;
						}
					}),
					(() => {
						var _el$201 = _tmpl$45();
						_el$201.firstChild;
						(0, solid_js_web.insert)(_el$201, (0, solid_js_web.createComponent)(solid_js.For, {
							get each() {
								return sharedSnapshot().aboutToolGroups;
							},
							children: (grp) => (() => {
								var _el$244 = _tmpl$54(), _el$245 = _el$244.firstChild, _el$246 = _el$245.firstChild, _el$247 = _el$246.nextSibling, _el$248 = _el$245.nextSibling;
								(0, solid_js_web.insert)(_el$246, () => grp.name);
								(0, solid_js_web.insert)(_el$247, () => grp.value);
								(0, solid_js_web.insert)(_el$248, () => grp.note);
								(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$245, rowStyle, _$p));
								return _el$244;
							})()
						}), null);
						(0, solid_js_web.effect)((_$p) => (0, solid_js_web.style)(_el$201, cardStyle, _$p));
						return _el$201;
					})()
				];
			}
		}), null);
		return _el$64;
	})();
}
function PantheonSettingsView(props) {
	const effectiveDirectory = () => resolveActiveDirectory(props.ctx);
	const refresh = async () => {
		try {
			const dir = effectiveDirectory();
			if (dir) setActiveDirectory(dir);
			const raw = await props.ctx.main(PantheonBridge).snapshot(dir);
			setSharedSnapshot(JSON.parse(raw));
		} catch (err) {
			setUiError(err instanceof Error ? err.message : "Settings IPC unavailable");
		}
	};
	(0, solid_js.createEffect)(() => {
		effectiveDirectory();
		refresh();
	});
	return (() => {
		var _el$249 = _tmpl$56(), _el$250 = _el$249.firstChild, _el$251 = _el$250.firstChild, _el$252 = _el$251.nextSibling, _el$254 = _el$250.nextSibling;
		(0, solid_js_web.insert)(_el$251, () => `Pantheon v${resolveRunningVersion()}`);
		_el$252.$$click = () => void refresh();
		(0, solid_js_web.insert)(_el$249, (0, solid_js_web.createComponent)(solid_js.Show, {
			get when() {
				return uiError() !== null;
			},
			get children() {
				var _el$253 = _tmpl$55();
				(0, solid_js_web.insert)(_el$253, uiError);
				return _el$253;
			}
		}), _el$254);
		(0, solid_js_web.insert)(_el$249, (0, solid_js_web.createComponent)(PantheonSettingsControls, {
			get ctx() {
				return props.ctx;
			},
			directory: effectiveDirectory,
			onSaved: refresh
		}), _el$254);
		return _el$249;
	})();
}
var gui_default = _opencode_plugin_gui.Plugin.define({
	main(ctx) {
		ctx.provide(PantheonBridge, {
			snapshot: async (directory) => JSON.stringify(await readSnapshotFromDisk(directory)),
			postBoardMessage: (payload) => appendBoardMessageToDisk(payload),
			saveSettings: (payload) => saveSettingsToDisk(payload),
			runAction: async (payload) => await runActionOnDisk(payload)
		});
	},
	setup(ctx) {
		const cockpitTab = {
			id: "pantheon-cockpit",
			title: "Pantheon",
			pinned: true
		};
		const openCockpit = () => {
			const session = ctx.sessions.current();
			if (session) ctx.layout.open(`${ctx.id}:pantheon-cockpit`, session, { tab: "open" });
			else ctx.dialogs.open((dialog) => (() => {
				var _el$255 = _tmpl$57(), _el$258 = _el$255.firstChild.firstChild.nextSibling;
				_el$258.$$click = () => dialog.close();
				(0, solid_js_web.insert)(_el$255, (0, solid_js_web.createComponent)(PantheonCockpitView, {
					ctx,
					directory: () => resolveActiveDirectory(ctx)
				}), null);
				return _el$255;
			})());
		};
		ctx.add(_opencode_plugin_gui.Panel, () => ({
			id: "cockpit",
			region: "side",
			wide: true,
			list: () => [cockpitTab],
			render: (props) => (0, solid_js_web.createComponent)(PantheonCockpitView, {
				ctx,
				directory: () => props.session?.directory ?? props.session?.location?.directory ?? ""
			})
		}));
		ctx.add(_opencode_plugin_gui.ComposerPill, () => ({
			id: "pantheon.status",
			show: () => {
				const running = sharedSnapshot().activeJobs.filter((j) => j.status === "running").length;
				return {
					label: running > 0 ? `Pantheon · ${running} active` : "Pantheon · ready",
					tone: running > 0 ? "success" : void 0,
					rows: [{
						id: "open-cockpit",
						label: "Open Pantheon Cockpit",
						detail: `${sharedSnapshot().messages.length} msgs`,
						run: openCockpit
					}, {
						id: "open-settings",
						label: "Open Pantheon Settings",
						detail: sharedSnapshot().gateMode,
						run: () => ctx.layout.settings("pantheon")
					}]
				};
			}
		}));
		ctx.add(_opencode_plugin_gui.SettingsPage, () => ({
			id: "pantheon",
			title: "Pantheon",
			entries: [{
				id: "pantheon.overview",
				title: "Pantheon Orchestration",
				description: "Multi-agent Olympus Topology, Ephemeral Workers, and Cockpit Settings",
				keywords: "pantheon cockpit swarm ephemeral todo"
			}],
			render: () => (0, solid_js_web.createComponent)(PantheonSettingsView, { ctx })
		}));
		ctx.add(_opencode_plugin_gui.Command, () => ({
			id: "cockpit",
			title: "Open Pantheon Cockpit",
			description: "Open Olympus Topology, Agora Board, and Ephemeral Workers",
			slash: { name: "pantheon-cockpit" },
			run: openCockpit
		}));
		ctx.add(_opencode_plugin_gui.Command, () => ({
			id: "settings",
			title: "Open Pantheon Settings",
			description: "Open Pantheon Desktop Settings page",
			slash: { name: "pantheon-settings" },
			run: () => {
				ctx.layout.settings("pantheon");
			}
		}));
	}
});
(0, solid_js_web.delegateEvents)([
	"click",
	"input",
	"keydown"
]);
//#endregion
module.exports = gui_default;
