import { Plugin } from "@opencode/plugin";
import { Rpc } from "@opencode/plugin/promise/index";
//#region src/server-v2.ts
const CREDENTIAL_CACHE_TTL_MS = 3e4;
/** Closed integration allowlist. Add integrations only alongside a reviewed adapter. */
const QUOTA_INTEGRATIONS = {
	anthropic: "anthropic",
	openai: "openai"
};
const PROVIDER_IDS = Object.keys(QUOTA_INTEGRATIONS);
const statusSchema = {
	type: "object",
	properties: {
		provider: {
			type: "string",
			enum: PROVIDER_IDS
		},
		authentication: {
			type: "string",
			enum: [
				"connected",
				"not_connected",
				"unavailable"
			]
		},
		quota: {
			type: "string",
			enum: ["not_implemented"]
		}
	},
	required: [
		"provider",
		"authentication",
		"quota"
	],
	additionalProperties: false
};
const quotaRpc = Rpc.define({
	id: "pantheon.quota",
	methods: { status: {
		input: {
			type: "object",
			properties: {},
			additionalProperties: false
		},
		output: {
			type: "object",
			properties: { providers: {
				type: "array",
				items: statusSchema
			} },
			required: ["providers"],
			additionalProperties: false
		}
	} },
	events: {}
});
/**
* Resolve only an active, allowlisted credential connection. Cache only the
* minimal token material in memory for at most 30 seconds. Credential and
* integration events clear the cache; plugin teardown drops all references.
*/
function createCredentialResolver(context) {
	const cache = /* @__PURE__ */ new Map();
	const pending = /* @__PURE__ */ new Map();
	let generation = 0;
	let disposed = false;
	function clearCache() {
		for (const cached of cache.values()) clearTimeout(cached.expiryTimer);
		cache.clear();
	}
	async function load(provider) {
		const integrationID = QUOTA_INTEGRATIONS[provider];
		try {
			const integration = (await context.integration.list()).data.find((candidate) => candidate.id === integrationID);
			if (!integration) return void 0;
			const active = await context.integration.connection.active(integrationID);
			if (active?.type !== "credential" || active.status?.status === "needs_auth") return;
			if (active.method !== "oauth" && active.method !== "key") return void 0;
			if (!integration.connections.some((connection) => connection.type === "credential" && connection.id === active.id && connection.method === active.method)) return void 0;
			const resolved = await context.integration.connection.resolve(active);
			if (!resolved) return void 0;
			if (active.method === "oauth" && resolved.type === "oauth" && resolved.access.length > 0) return {
				type: "oauth",
				secret: resolved.access
			};
			if (active.method === "key" && resolved.type === "key" && resolved.key.length > 0) return {
				type: "key",
				secret: resolved.key
			};
			return;
		} catch {
			throw new Error("Credential resolution failed");
		}
	}
	return {
		async resolve(provider) {
			if (disposed) return void 0;
			const now = Date.now();
			const cached = cache.get(provider);
			if (cached && cached.expiresAt > now) return cached.credential;
			if (cached) {
				clearTimeout(cached.expiryTimer);
				cache.delete(provider);
			}
			const existing = pending.get(provider);
			if (existing) return existing;
			const startedAtGeneration = generation;
			let resolution;
			resolution = load(provider).then((credential) => {
				if (disposed || generation !== startedAtGeneration) return void 0;
				if (credential) {
					const expiresAt = Date.now() + CREDENTIAL_CACHE_TTL_MS;
					const expiryTimer = setTimeout(() => {
						if (cache.get(provider)?.expiryTimer === expiryTimer) cache.delete(provider);
					}, CREDENTIAL_CACHE_TTL_MS);
					expiryTimer.unref();
					cache.set(provider, {
						credential,
						expiresAt,
						expiryTimer
					});
				}
				return credential;
			}).finally(() => {
				if (pending.get(provider) === resolution) pending.delete(provider);
			});
			pending.set(provider, resolution);
			return resolution;
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
async function getProviderStatus(resolver) {
	return { providers: await Promise.all(PROVIDER_IDS.map(async (provider) => {
		try {
			return {
				provider,
				authentication: await resolver.resolve(provider) ? "connected" : "not_connected",
				quota: "not_implemented"
			};
		} catch {
			return {
				provider,
				authentication: "unavailable",
				quota: "not_implemented"
			};
		}
	})) };
}
var server_v2_default = Plugin.define({
	id: "pantheon.tui.server",
	async setup(context) {
		const resolver = createCredentialResolver(context);
		const eventController = new AbortController();
		const eventTask = (async () => {
			try {
				for await (const event of context.event.subscribe({ signal: eventController.signal })) if (isCredentialInvalidationEvent(event.type)) resolver.invalidate();
			} catch {
				if (!eventController.signal.aborted) resolver.invalidate();
			}
		})();
		let registration;
		try {
			registration = await context.rpc.register(quotaRpc, { status: async () => getProviderStatus(resolver) });
		} catch (error) {
			eventController.abort();
			resolver.dispose();
			await eventTask;
			throw error;
		}
		return async () => {
			eventController.abort();
			resolver.dispose();
			await eventTask;
			await registration.dispose();
		};
	}
});
//#endregion
export { server_v2_default as default };

//# sourceMappingURL=server-v2.js.map
