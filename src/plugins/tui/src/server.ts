/**
 * No-op server stub for the opencode plugin loader.
 *
 * The opencode plugin host requires every plugin (TUI included) to expose a
 * `server()` entry via `exports["./server"]` (or package.json `main`). When
 * that entry is missing the host fails to attach the plugin's server half and
 * the TUI runtime never wires the reactive channel — the initial JSX mounts
 * but effects/refresh/events stay dead (the "mudo panel" symptom).
 *
 * This stub satisfies the loader contract; pantheon-tui is TUI-only and has
 * no background server work of its own.
 */
export default function server() {
  return {}
}
