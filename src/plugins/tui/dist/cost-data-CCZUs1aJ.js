import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
	const base = xdg !== void 0 && xdg !== "" ? xdg : join(homedir(), ".config");
	return join(base, "opencode");
}
/** Cache file for the normalized catalog. */
function resolvePricingCachePath(env = process.env) {
	return join(resolvePricingCacheDir(env), "cache", "models-dev.json");
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
		if (!existsSync(cachePath)) return void 0;
		return parseCachedCatalog(JSON.parse(readFileSync(cachePath, "utf8")));
	} catch {
		return;
	}
}
/** Write atomically; a cache that cannot be written must not break a report. */
function writePricingCache(cachePath, catalog) {
	const temp = `${cachePath}.tmp-${process.pid}`;
	try {
		mkdirSync(dirname(cachePath), { recursive: true });
		writeFileSync(temp, `${JSON.stringify(catalog)}\n`, "utf8");
		renameSync(temp, cachePath);
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
/** The XDG state directory every real host installation writes its ledger to. */
function defaultDbPath() {
	const xdg = process.env.XDG_DATA_HOME;
	const dataHome = xdg !== void 0 && xdg !== "" ? xdg : join(homedir(), ".local", "share");
	return join(dataHome, "opencode", "opencode.db");
}
/** Read and validate the optional host-generation selector. */
function requestedVersion() {
	const configured = process.env.PANTHEON_OPENCODE_VERSION;
	if (configured === void 0) return void 0;
	if (configured !== "v1" && configured !== "v2") throw new Error(`invalid PANTHEON_OPENCODE_VERSION "${configured}"; expected "v1" or "v2"`);
	return configured;
}
/**
* Resolve the database.
*
* Precedence: explicit option → PANTHEON_COST_DB → OPENCODE_DB → the XDG
* default `opencode.db`. An invalid PANTHEON_OPENCODE_VERSION fails fast rather
* than being silently ignored.
*
* There is deliberately NO per-version filename. Deriving one from the host
* generation pointed the V2 report at `opencode-v2.db`, which exists only
* because a sandbox sets OPENCODE_DB — hence OPENCODE_DB's place in this chain.
*/
function resolveCostDbPath(options) {
	const explicit = options?.dbPath || process.env.PANTHEON_COST_DB || process.env.OPENCODE_DB;
	if (explicit) return explicit;
	requestedVersion();
	return defaultDbPath();
}
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
/**
* Estimate current context cost using only its token count and cached input rate.
* This is a pre-cache estimate, applies no cache discount, and is not billed or
* used to alter host-reported session spend.
*/
function estimateActiveContextCost(input, options) {
	const metadata = {
		billed: false,
		basis: "pre-cache-context-tokens-times-input-price",
		cacheDiscountApplied: false
	};
	if (typeof input.contextTokens !== "number" || !Number.isSafeInteger(input.contextTokens) || input.contextTokens < 0) return {
		status: "unavailable",
		...metadata,
		reason: "invalid-context-token-count"
	};
	if (!input.providerID?.trim() || !input.modelID?.trim()) return {
		status: "unavailable",
		...metadata,
		reason: "missing-model-identity"
	};
	const lookup = lookupModelPrice(offlinePricing(options), input.providerID, input.modelID);
	if (!lookup.ok) return {
		status: "unavailable",
		...metadata,
		reason: lookup.reason
	};
	return {
		status: "estimated",
		...metadata,
		estimatedUsd: input.contextTokens / 1e6 * lookup.price.inputPerMTok
	};
}
//#endregion
export { queryUsageHistory as n, resolveCostDbPath as r, estimateActiveContextCost as t };

//# sourceMappingURL=cost-data-CCZUs1aJ.js.map
