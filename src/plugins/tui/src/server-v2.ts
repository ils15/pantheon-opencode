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
 * This stub satisfies the loader contract. The native quota RPC that used to
 * live here was removed in 1.6.2 — provider quota/usage visibility is now the
 * community plugin's job (`@slkiser/opencode-quota`,
 * docs/tui-v2-quota-providers.md) — and pantheon-tui has no other background
 * server work of its own.
 */
export default function server() {
  return {}
}
