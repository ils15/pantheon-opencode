/**
 * Pantheon V2 plugin — directory entry for the OpenCode V2 beta loader.
 *
 * Loader contract (proven by sandbox probes in ~/pantheon-sandbox/v2):
 * the beta only accepts `plugins` entries that are DIRECTORIES containing a
 * real index.js/index.ts — a file path warns "must be a directory" and a
 * symlink is ignored. The installer therefore registers this directory
 * (`<pkg>/src/plugin-v2`), never the `src/plugin-v2.ts` file directly.
 *
 * This index is a thin re-export shim over the real entry at
 * `src/plugin-v2.ts` (kept as the single source of truth so the
 * `./plugin-v2` package export, unit tests, and V1 tooling keep working
 * unchanged). The shim shape mirrors the verified probe:
 * `export { default } from '<installed>/src/plugin-v2.ts'` loads with zero
 * errors and exposes the full orchestration plugin (tools, events, hooks).
 *
 * @module plugin-v2/index
 */

export * from '../plugin-v2.ts'
export { default } from '../plugin-v2.ts'
