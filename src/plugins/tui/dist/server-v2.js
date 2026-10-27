import { n as quotaRpc, t as QUOTA_PROVIDER_IDS } from "./quota-rpc-UL2HuFRJ.js";
import { queryAlibabaTokenPlanUsage } from "./quota-cli.js";
import { QUOTA_PROVIDER_CATALOG, isOpenAICodexOAuthMethod, isOpenCodeConsoleOAuthMethod, runQuotaAdapter } from "./quota-adapters.js";
import { Plugin } from "@opencode/plugin";
//#region src/go-key-diagnostic.ts
/** Parse at most 4 KiB; inspect only own top-level error presence, never its value. */
async function errorStructure(body, signal) {
	if (!body) return "unavailable";
	let reader;
	let abort = () => {};
	let complete = false;
	try {
		reader = body.getReader();
		const aborted = new Promise((_, reject) => {
			abort = () => reject(/* @__PURE__ */ new Error("aborted"));
			signal.addEventListener("abort", abort, { once: true });
		});
		const bytes = /* @__PURE__ */ new Uint8Array(4096);
		let length = 0;
		while (true) {
			signal.throwIfAborted();
			const { done, value } = await Promise.race([reader.read(), aborted]);
			if (done) {
				complete = true;
				break;
			}
			if (value.byteLength > bytes.length - length) return "unavailable";
			bytes.set(value, length);
			length += value.byteLength;
		}
		const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unavailable";
		return Object.hasOwn(parsed, "error") ? "present" : "absent";
	} catch {
		return "unavailable";
	} finally {
		signal.removeEventListener("abort", abort);
		if (!complete) (reader ? reader.cancel() : body.cancel()).catch(() => {});
		reader?.releaseLock();
	}
}
/** One explicit invocation per plugin runtime, including failed/no-credential attempts. */
function createGoKeyDiagnostic() {
	let attempted = false;
	return async (resolveKey, signal) => {
		if (attempted) return { category: "already_used" };
		attempted = true;
		let key;
		try {
			key = await resolveKey();
		} catch {
			return { category: "not_run" };
		}
		if (!key || signal.aborted) return { category: "not_run" };
		const timeout = AbortSignal.timeout(5e3);
		const requestSignal = AbortSignal.any([signal, timeout]);
		try {
			const response = await fetch("https://opencode.ai/zen/go/v1/usage", {
				method: "GET",
				headers: {
					Authorization: `Bearer ${key}`,
					"x-opencode-session": "pantheon-quota",
					"user-agent": "Pantheon-Quota/1.0"
				},
				redirect: "manual",
				signal: requestSignal
			});
			const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
			const contentType = !mediaType ? "missing" : mediaType === "application/json" || mediaType === "text/plain" || mediaType === "text/html" ? mediaType : "other";
			let structure;
			if (response.status === 401 && contentType === "application/json") structure = await errorStructure(response.body, requestSignal);
			else {
				response.body?.cancel().catch(() => {});
				if (response.status === 401) structure = "unavailable";
			}
			return {
				category: response.status === 401 ? "unauthorized" : response.status >= 300 && response.status < 400 ? "redirect" : response.ok ? "success" : "http_error",
				status: response.status,
				content_type: contentType,
				...structure ? { error_structure: structure } : {}
			};
		} catch {
			return { category: timeout.aborted ? "timeout" : "network_error" };
		}
	};
}
//#endregion
//#region src/server-v2.ts
const CREDENTIAL_CACHE_TTL_MS = 3e4;
const ADAPTER_CACHE_TTL_MS = 2e4;
const PROVIDER_IDS = QUOTA_PROVIDER_IDS;
function safeMetadataValue(metadata, names) {
	if (!metadata) return void 0;
	for (const name of names) {
		const value = metadata[name];
		if (typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value)) return value;
	}
}
function projectAdapterContext(provider, metadata, methodID) {
	if (provider === "openai") {
		if (isOpenAICodexOAuthMethod(methodID)) return { methodID };
		return;
	}
	if (provider === "opencode-go") {
		if (!isOpenCodeConsoleOAuthMethod(methodID)) return void 0;
		if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return { methodID };
		const record = metadata;
		if (record.orgID === void 0 || record.orgID === null) return { methodID };
		if (typeof record.orgID !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(record.orgID)) return;
		return {
			methodID,
			orgId: record.orgID
		};
	}
	if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return void 0;
	const record = metadata;
	const projectId = safeMetadataValue(record, [
		"projectID",
		"projectId",
		"quotaProjectId"
	]);
	const accountId = safeMetadataValue(record, ["accountID", "accountId"]);
	const orgId = safeMetadataValue(record, ["orgID", "orgId"]);
	if (!projectId && !accountId && !orgId) return void 0;
	return {
		...projectId ? { projectId } : {},
		...accountId ? { accountId } : {},
		...orgId ? { orgId } : {}
	};
}
/**
* Accept only the official OpenCode Console default and its retired alias.
* The selected Console token is never sent to a credential-supplied host.
*/
function isApprovedOpenCodeConsoleServer(metadata) {
	if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) return true;
	const record = metadata;
	if (!Object.hasOwn(record, "server")) return true;
	const server = record.server;
	if (typeof server !== "string" || server.length === 0 || server.length > 2048) return false;
	if (server.trim() !== server) return false;
	let url;
	try {
		url = new URL(server);
	} catch {
		return false;
	}
	if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "" || url.search !== "" || url.hash !== "") return false;
	const path = url.pathname.replace(/\/$/, "");
	if (url.hostname === "opencode.ai") return path === "/console";
	return url.hostname === "console.opencode.ai" && (path === "" || path === "/console");
}
function routeKindField(provider, credential, effectiveRouteKind) {
	return provider === "opencode-go" ? { route_kind: effectiveRouteKind ?? credential?.routeKind ?? "none" } : {};
}
/**
* Resolve only listed, selected credential connections in the closed provider
* catalog. Only the minimum access-token/key field is retained in memory.
*/
function createCredentialResolver(context) {
	const cache = /* @__PURE__ */ new Map();
	const pending = /* @__PURE__ */ new Map();
	let integrations;
	let integrationListPending;
	let generation = 0;
	let disposed = false;
	function clearCache() {
		for (const cached of cache.values()) clearTimeout(cached.expiryTimer);
		cache.clear();
		integrations = void 0;
		integrationListPending = void 0;
	}
	async function listCredentialConnections() {
		if (integrations) return integrations;
		if (integrationListPending) return integrationListPending;
		const startedAtGeneration = generation;
		let request;
		request = context.integration.list().then((value) => {
			const connectionsByIntegration = /* @__PURE__ */ new Map();
			for (const integration of value.data) {
				const connections = /* @__PURE__ */ new Set();
				if (Array.isArray(integration.connections)) {
					for (const connection of integration.connections) if (connection.type === "credential") connections.add(`${connection.id}\0${connection.method}`);
				}
				connectionsByIntegration.set(integration.id, connections);
			}
			if (!disposed && generation === startedAtGeneration) integrations = connectionsByIntegration;
			return connectionsByIntegration;
		}).finally(() => {
			if (integrationListPending === request) integrationListPending = void 0;
		});
		integrationListPending = request;
		return request;
	}
	async function load(provider, goKeyOnly = false) {
		const definition = QUOTA_PROVIDER_CATALOG[provider];
		if (definition.source === "local-cli") return {};
		try {
			const listedConnections = await listCredentialConnections();
			if (provider === "opencode-go") {
				const activeListed = async (integrationID) => {
					const connections = listedConnections.get(integrationID);
					if (!connections || connections.size === 0) return void 0;
					const active = await context.integration.connection.active(integrationID);
					if (active?.type !== "credential" || !connections.has(`${active.id}\0${active.method}`)) return;
					return active;
				};
				let consoleCredential;
				let unsupportedConsoleLogin = false;
				if (!goKeyOnly) {
					let activeConsole;
					try {
						activeConsole = await activeListed("opencode");
					} catch {}
					if (activeConsole?.method === "oauth" && activeConsole.status?.status !== "needs_auth") try {
						const resolved = await context.integration.connection.resolve(activeConsole);
						if (resolved?.type === "oauth" && resolved.access.trim().length > 0 && isOpenCodeConsoleOAuthMethod(resolved.methodID) && isApprovedOpenCodeConsoleServer(resolved.metadata)) {
							const adapterContext = projectAdapterContext(provider, resolved.metadata, resolved.methodID);
							if (adapterContext) consoleCredential = {
								method: "oauth",
								secret: resolved.access.trim(),
								routeKind: "console_oauth",
								adapterContext
							};
							else unsupportedConsoleLogin = true;
						} else if (resolved?.type === "oauth") unsupportedConsoleLogin = true;
					} catch {}
					else if (activeConsole?.method === "oauth") unsupportedConsoleLogin = activeConsole.status?.status !== "needs_auth";
				}
				let activePrimary;
				try {
					activePrimary = await activeListed("opencode-go");
				} catch {}
				const unsupportedPrimaryLogin = activePrimary !== void 0 && activePrimary.method !== "key";
				let apiKey;
				for (const integrationID of ["opencode-go", "opencode"]) {
					let active;
					try {
						active = integrationID === "opencode-go" ? activePrimary : await activeListed(integrationID);
					} catch {
						continue;
					}
					if (!active) continue;
					if (goKeyOnly && active.method !== "key") return {};
					if (active.method !== "key" || active.status?.status === "needs_auth") continue;
					try {
						const resolved = await context.integration.connection.resolve(active);
						if (resolved?.type === "key" && resolved.key.trim().length > 0) {
							apiKey = resolved.key.trim();
							break;
						}
					} catch {}
				}
				if (consoleCredential) return {
					...consoleCredential,
					...apiKey ? { fallbackSecret: apiKey } : {}
				};
				if (apiKey) return {
					method: "key",
					secret: apiKey,
					routeKind: "api_key"
				};
				if (unsupportedConsoleLogin || unsupportedPrimaryLogin) return {
					method: "unsupported",
					routeKind: "unsupported"
				};
				return {};
			}
			const integrationIDs = [definition.integrationID, ...definition.fallbackIntegrationIDs ?? []];
			for (const integrationID of integrationIDs) {
				const integrationConnections = listedConnections.get(integrationID);
				if (!integrationConnections || integrationConnections.size === 0) continue;
				const active = await context.integration.connection.active(integrationID);
				if (active?.type !== "credential") continue;
				if (!integrationConnections.has(`${active.id}\0${active.method}`)) continue;
				if (goKeyOnly && active.method !== "key") return {};
				if (active.status?.status === "needs_auth") continue;
				if (active.method !== "oauth" && active.method !== "key") continue;
				if (!definition.methods.includes(active.method)) continue;
				const resolved = await context.integration.connection.resolve(active);
				if (active.method === "oauth" && resolved?.type === "oauth" && resolved.access.trim().length > 0) {
					const accessToken = resolved.access;
					if (!accessToken) return {};
					if (provider === "opencode-zen" && !isApprovedOpenCodeConsoleServer(resolved.metadata)) return { method: "unsupported" };
					const adapterContext = projectAdapterContext(provider, resolved.metadata, resolved.methodID);
					return {
						method: "oauth",
						...definition.adapter ? { secret: accessToken } : {},
						...adapterContext ? { adapterContext } : {}
					};
				}
				if (active.method === "key" && resolved?.type === "key") {
					if (resolved.key.trim().length === 0) return {};
					if (!definition.adapter) return { method: "key" };
					if (resolved.key.length > 0) return {
						method: "key",
						secret: resolved.key
					};
				}
				return {};
			}
			return {};
		} catch {
			throw new Error("Credential resolution failed");
		}
	}
	return {
		async resolveActiveGoKey() {
			if (disposed) return void 0;
			const startedAtGeneration = generation;
			const credential = await load("opencode-go", true);
			if (disposed || generation !== startedAtGeneration) return void 0;
			return credential.method === "key" && credential.routeKind === "api_key" ? credential.secret : void 0;
		},
		async resolve(provider) {
			if (disposed) return {};
			const now = Date.now();
			const cached = cache.get(provider);
			if (cached && cached.expiresAt > now) return cached.result;
			if (cached) {
				clearTimeout(cached.expiryTimer);
				cache.delete(provider);
			}
			const existing = pending.get(provider);
			if (existing) return existing;
			const startedAtGeneration = generation;
			let resolution;
			resolution = load(provider).then((result) => {
				if (disposed || generation !== startedAtGeneration) return {};
				const expiresAt = Date.now() + CREDENTIAL_CACHE_TTL_MS;
				const expiryTimer = setTimeout(() => {
					if (cache.get(provider)?.expiryTimer === expiryTimer) cache.delete(provider);
				}, CREDENTIAL_CACHE_TTL_MS);
				expiryTimer.unref();
				cache.set(provider, {
					result,
					expiresAt,
					expiryTimer
				});
				return result;
			}).finally(() => {
				if (pending.get(provider) === resolution) pending.delete(provider);
			});
			pending.set(provider, resolution);
			return resolution;
		},
		currentGeneration() {
			return generation;
		},
		isCurrent(version) {
			return !disposed && generation === version;
		},
		invalidate() {
			generation += 1;
			clearCache();
			pending.clear();
		},
		dispose() {
			disposed = true;
			generation += 1;
			clearCache();
			pending.clear();
		}
	};
}
function isCredentialInvalidationEvent(type) {
	return type === "credential.updated" || type === "credential.switched" || type === "integration.updated";
}
function createAdapterExecutor(shutdownSignal, queryCli) {
	const MAX_CONCURRENCY = 3;
	const cache = /* @__PURE__ */ new Map();
	const pending = /* @__PURE__ */ new Map();
	const cooldown = /* @__PURE__ */ new Map();
	let activeRequests = 0;
	let generation = 0;
	const waiters = [];
	let invalidationController = new AbortController();
	function releaseRequest() {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			while (waiters.length > 0) {
				const waiter = waiters.shift();
				if (!waiter) break;
				waiter.signal.removeEventListener("abort", waiter.onAbort);
				if (waiter.signal.aborted) {
					waiter.resolve(void 0);
					continue;
				}
				waiter.resolve(releaseRequest());
				return;
			}
			activeRequests -= 1;
		};
	}
	function acquireRequest(signal) {
		if (signal.aborted) return Promise.resolve(void 0);
		if (activeRequests < MAX_CONCURRENCY) {
			activeRequests += 1;
			return Promise.resolve(releaseRequest());
		}
		return new Promise((resolve) => {
			const waiter = {
				signal,
				resolve,
				onAbort: () => {
					const index = waiters.indexOf(waiter);
					if (index >= 0) waiters.splice(index, 1);
					resolve(void 0);
				}
			};
			waiters.push(waiter);
			signal.addEventListener("abort", waiter.onAbort, { once: true });
		});
	}
	function subscribe(entry, requestSignal) {
		requestSignal.throwIfAborted();
		const caller = Symbol();
		entry.callers.add(caller);
		return new Promise((resolve, reject) => {
			let detached = false;
			const detach = () => {
				if (detached) return;
				detached = true;
				requestSignal.removeEventListener("abort", onAbort);
				entry.callers.delete(caller);
				if (!entry.settled && entry.callers.size === 0) entry.controller.abort();
			};
			const onAbort = () => {
				detach();
				reject(requestSignal.reason);
			};
			requestSignal.addEventListener("abort", onAbort, { once: true });
			if (requestSignal.aborted) {
				onAbort();
				return;
			}
			entry.promise.then((result) => {
				detach();
				resolve(result);
			}, (error) => {
				detach();
				reject(error);
			});
		});
	}
	return {
		async run(provider, secret, requestSignal, adapterContext, fallbackSecret) {
			requestSignal.throwIfAborted();
			const now = Date.now();
			const until = cooldown.get(provider);
			if (until !== void 0 && until > now) return {
				reason: "rate_limited",
				retryAfterMs: until - now
			};
			const cached = cache.get(provider);
			if (cached && cached.expiresAt > now) return cached.result;
			const existing = pending.get(provider);
			if (existing && !existing.controller.signal.aborted) return subscribe(existing, requestSignal);
			if (existing) pending.delete(provider);
			const startedAtGeneration = generation;
			const controller = new AbortController();
			const signal = AbortSignal.any([
				shutdownSignal,
				invalidationController.signal,
				controller.signal
			]);
			const entry = {
				controller,
				callers: /* @__PURE__ */ new Set(),
				settled: false,
				promise: Promise.resolve({ reason: "provider_error" })
			};
			pending.set(provider, entry);
			entry.promise = acquireRequest(signal).then(async (release) => {
				if (!release) return { reason: "provider_error" };
				try {
					return await runQuotaAdapter(provider, secret, signal, queryCli, adapterContext, fallbackSecret);
				} finally {
					release();
				}
			}).then((result) => {
				if (generation === startedAtGeneration && !signal.aborted && "state" in result) cache.set(provider, {
					expiresAt: Date.now() + ADAPTER_CACHE_TTL_MS,
					result
				});
				else if (generation === startedAtGeneration && "reason" in result && result.reason === "rate_limited" && result.retryAfterMs !== void 0) cooldown.set(provider, Date.now() + result.retryAfterMs);
				return result;
			}).finally(() => {
				entry.settled = true;
				if (pending.get(provider) === entry) pending.delete(provider);
			});
			return subscribe(entry, requestSignal);
		},
		invalidate() {
			generation += 1;
			invalidationController.abort();
			invalidationController = new AbortController();
			cache.clear();
			pending.clear();
			cooldown.clear();
		}
	};
}
async function getProviderStatus(resolver, adapters, requestSignal) {
	requestSignal.throwIfAborted();
	let credentialResolutionFailed = false;
	return {
		providers: (await Promise.all(PROVIDER_IDS.map(async (provider) => {
			const definition = QUOTA_PROVIDER_CATALOG[provider];
			try {
				requestSignal.throwIfAborted();
				const credentialGeneration = resolver.currentGeneration();
				let credential;
				try {
					credential = await resolver.resolve(provider);
				} catch {
					requestSignal.throwIfAborted();
					credentialResolutionFailed = true;
					return;
				}
				requestSignal.throwIfAborted();
				if (!credential.method) return void 0;
				if (!resolver.isCurrent(credentialGeneration)) return {
					provider,
					label: definition.label,
					scope: definition.scope,
					authentication: "unavailable",
					state: "unavailable",
					reason: "provider_error",
					...routeKindField(provider, credential),
					metrics: []
				};
				if (credential.method === "unsupported" || !definition.methods.includes(credential.method)) return {
					provider,
					label: definition.label,
					scope: definition.scope,
					authentication: "connected",
					state: "unavailable",
					reason: "unsupported_credential_method",
					...routeKindField(provider, credential),
					metrics: []
				};
				if (!definition.adapter) return {
					provider,
					label: definition.label,
					scope: definition.scope,
					authentication: "connected",
					state: "unavailable",
					reason: definition.blockedReason ?? "unsupported",
					...routeKindField(provider, credential),
					metrics: []
				};
				if (!credential.secret) return {
					provider,
					label: definition.label,
					scope: definition.scope,
					authentication: "unavailable",
					state: "unavailable",
					reason: "provider_error",
					...routeKindField(provider, credential),
					metrics: []
				};
				const result = await adapters.run(provider, credential.secret, requestSignal, credential.adapterContext, credential.fallbackSecret);
				requestSignal.throwIfAborted();
				if (!resolver.isCurrent(credentialGeneration)) return {
					provider,
					label: definition.label,
					scope: definition.scope,
					authentication: "unavailable",
					state: "unavailable",
					reason: "provider_error",
					...routeKindField(provider, credential),
					metrics: []
				};
				if ("state" in result) return {
					provider,
					label: definition.label,
					scope: definition.scope,
					authentication: "connected",
					state: "available",
					reason: "none",
					...routeKindField(provider, credential, result.routeKind),
					metrics: result.metrics
				};
				return {
					provider,
					label: definition.label,
					scope: definition.scope,
					authentication: "connected",
					state: "unavailable",
					reason: result.reason,
					...routeKindField(provider, credential, result.routeKind),
					...result.retryAfterMs === void 0 ? {} : { retry_after_ms: Math.ceil(result.retryAfterMs) },
					metrics: []
				};
			} catch {
				requestSignal.throwIfAborted();
				return {
					provider,
					label: definition.label,
					scope: definition.scope,
					authentication: "unavailable",
					state: "unavailable",
					reason: "provider_error",
					...routeKindField(provider),
					metrics: []
				};
			}
		}))).filter((provider) => provider !== void 0),
		...credentialResolutionFailed ? { credential_resolution_failed: true } : {}
	};
}
function createQuotaPlugin(queryCli = queryAlibabaTokenPlanUsage) {
	const goKeyDiagnostic = createGoKeyDiagnostic();
	return Plugin.define({
		id: "pantheon.tui.server",
		async setup(context) {
			const resolver = createCredentialResolver(context);
			const shutdownController = new AbortController();
			const adapters = createAdapterExecutor(shutdownController.signal, queryCli);
			const eventController = new AbortController();
			let registration;
			const eventTask = (async () => {
				try {
					for await (const event of context.event.subscribe({ signal: eventController.signal })) if (isCredentialInvalidationEvent(event.type)) {
						resolver.invalidate();
						adapters.invalidate();
						if (registration) try {
							await registration.events.emit("credentials_changed", {});
						} catch {
							console.warn("Quota credential-change notification failed; periodic refresh remains active");
						}
					}
				} catch {
					if (!eventController.signal.aborted) {
						resolver.invalidate();
						adapters.invalidate();
					}
				}
			})();
			try {
				registration = await context.rpc.register(quotaRpc, {
					go_key_diagnostic: async (_input, callContext) => goKeyDiagnostic(() => resolver.resolveActiveGoKey(), AbortSignal.any([callContext.signal, shutdownController.signal])),
					status: async (_input, callContext) => getProviderStatus(resolver, adapters, callContext.signal)
				});
			} catch (error) {
				eventController.abort();
				shutdownController.abort();
				resolver.dispose();
				adapters.invalidate();
				await eventTask;
				throw error;
			}
			return async () => {
				eventController.abort();
				shutdownController.abort();
				resolver.dispose();
				adapters.invalidate();
				await eventTask;
				await registration?.dispose();
			};
		}
	});
}
var server_v2_default = createQuotaPlugin();
//#endregion
export { createQuotaPlugin, server_v2_default as default };

//# sourceMappingURL=server-v2.js.map
