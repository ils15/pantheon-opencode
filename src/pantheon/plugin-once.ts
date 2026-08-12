/**
 * Runtime double-registration guard for the Pantheon opencode plugins.
 *
 * PROBLEM (2026-08-12, live logs — duplicate toasts + duplicate task_ids in
 * ONE process): opencode MERGES the global `~/.config/opencode/opencode.json`
 * (which points at the INSTALLED npm package's plugin paths) with the project
 * `opencode.json` (which points at the REPO source paths). Both list the SAME
 * two plugins — `src/plugin.ts` and `src/plugins/pantheon-hooks.ts` — so each
 * module is LOADED TWICE from two different filesystem paths in the same
 * process. Each load is a separate module instance with its own module scope;
 * the plugin factory then runs twice, registering every hook twice (duplicate
 * toasts, duplicate delegation correlation, duplicated tool registrations).
 *
 * FIX: claim a stable per-plugin key on a process-global Set
 * (`globalThis.__pantheonPluginsLoaded`). The second factory invocation sees
 * its key already claimed and returns an empty hooks object — a no-op — so
 * hooks register exactly once. The guard is PROCESS-global BY DESIGN: only a
 * shared global can dedupe two separate module instances.
 *
 * Fail-safe: access to globalThis is wrapped — if the runtime ever lacks it
 * (never in bun/node), the helper returns false and the plugin always runs
 * (double registration returns, but the plugin never breaks startup).
 *
 * TEST ESCAPE HATCH: set PANTHEON_PLUGIN_ONCE=off to disable the guard. The
 * multi-phase regression suites (pantheon-hooks-chat.test.mjs,
 * plugin-log-policy.test.mjs) deliberately invoke the hooks factory once per
 * phase in the SAME process via cache-busted imports, and the process-global
 * guard would turn every phase after the first into a no-op. Production
 * never sets this — the guard stays active and dedupes the npm-package +
 * repo double load.
 *
 * USAGE — at the TOP of the plugin factory:
 *
 *   const plugin: Plugin = async (input: PluginInput) => {
 *     if (pantheonPluginOnce('pantheon:plugin')) return {}
 *     ... // full factory body — runs exactly once per process
 *   }
 *
 * NOTE: this module is imported (never re-exported) by the plugin modules —
 * the opencode legacy loader invokes every FUNCTION-valued export of a plugin
 * module as a plugin factory, so helpers must live in a separate module.
 */
const GLOBAL_KEY = '__pantheonPluginsLoaded'

/** Read (or lazily create) the shared guard Set. Null on any failure. */
function guardSet(): Set<string> | null {
  try {
    const g = globalThis as Record<string, unknown>
    if (g[GLOBAL_KEY] === undefined) {
      g[GLOBAL_KEY] = new Set<string>()
    }
    const set = g[GLOBAL_KEY]
    return set instanceof Set ? (set as Set<string>) : null
  } catch {
    return null // fail-open: no globalThis support — see header
  }
}

/**
 * Claim `key` for this process. Returns TRUE when the key was ALREADY claimed
 * by another module instance — the caller MUST become a no-op (return an
 * empty hooks object). Returns FALSE on the FIRST claim — the caller runs its
 * full factory body. Fail-open: without globalThis support every call returns
 * false, so the plugin always runs (never breaks startup).
 */
export function pantheonPluginOnce(key: string): boolean {
  // Test escape hatch (see header): the multi-phase regression suites invoke
  // the factory once per phase in one process — the dedup must not apply.
  // Production never sets it, so the npm+repo double load stays deduped.
  if (process.env.PANTHEON_PLUGIN_ONCE === 'off') return false
  const set = guardSet()
  if (set === null) return false
  if (set.has(key)) return true
  set.add(key)
  return false
}
