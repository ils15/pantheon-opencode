//#region src/server.ts
/**
* No-op server stub for the OpenCode V2 plugin loader.
*
* The OpenCode plugin host requires every plugin (TUI included) to expose a
* `server()` entry via `exports["./server"]` (or package.json `main`) — for the
* V2 copy this root `index-v2.ts` re-export resolves to this compiled entry —
* and it loads that server half only from a `config.plugins` entry (see
* `scripts/install/opencode.mjs`). When the entry is missing the host fails to
* attach the plugin's server half and the TUI runtime never wires the reactive
* channel — the initial JSX mounts but effects/refresh/events stay dead (the
* "mudo panel" symptom; same contract as the V1 `server.ts` stub).
*
* This stub satisfies the loader contract. Field report (beta.13): host 2.2.5
* validates the default export as a DEFINITION OBJECT — "Plugin must export a
* default definition with an id and an effect or setup function
* (SchemaError(Expected object at ["default"]))" — the bare `server()`
* function form failed that schema on every boot (~3.4k load failures in the
* host log). The native quota RPC that used to live here was removed in 1.6.2
* — provider quota/usage visibility is now the community plugin's job
* (`@slkiser/opencode-quota`, docs/tui-quota-providers.md) — and
* pantheon-tui has no other background server work of its own.
*/
var server_default = {
	id: "pantheon.tui.server",
	setup() {
		return {};
	}
};
//#endregion
export { server_default as default };

//# sourceMappingURL=server.js.map
