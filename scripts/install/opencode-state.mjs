/**
 * opencode-state.mjs — where an OpenCode host keeps its state, resolved once.
 *
 * WHY THIS MODULE EXISTS: the installer used to PRINT a hardcoded claim about
 * state isolation (`~/.local/share/opencode/opencode-v2.db`, "open service port
 * 49375"). Nothing in this package ever set `OPENCODE_DB`, no installer created
 * that file, and no code bound that port — it was a sentence about a
 * configuration that never existed outside a sandbox. A notice is a statement
 * about the user's machine, so it has to be produced by the same rule the host
 * and Pantheon's own database consumers use, not by a literal.
 *
 * THE RULE (mirrored from `resolveCostDbPath` in src/pantheon/cost-command.ts
 * and from the credential-store lookup in scripts/vision-status.mjs):
 *
 *   1. `OPENCODE_DB` — an explicit file override (what a SANDBOX uses; it is
 *      also the only reason an `opencode-v2.db` name ever appears anywhere);
 *   2. otherwise the XDG default `<data dir>/opencode.db`, where `<data dir>` is
 *      `$XDG_DATA_HOME/opencode` when `XDG_DATA_HOME` is set, else
 *      `~/.local/share/opencode`.
 *
 * There is deliberately NO per-generation filename and no per-generation port:
 * both host generations read the same store, and the schema — not the filename
 * — is what distinguishes their ledgers. `PANTHEON_COST_DB` is NOT part of this
 * rule: it redirects the cost REPORT only, never the host's store.
 *
 * Plain Node ESM on purpose: this is consumed by the installer (no TypeScript)
 * and by tests, and the equivalent TypeScript resolver is not importable there.
 *
 * @module opencode-state
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

/** The one filename every real installation writes. */
export const OPENCODE_DB_FILENAME = 'opencode.db'

/** Directory name under the XDG data root. */
export const OPENCODE_DATA_DIR_NAME = 'opencode'

/**
 * OpenCode data directory: `$XDG_DATA_HOME/opencode` when set, else
 * `~/.local/share/opencode`.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function openCodeDataDir(env = process.env, home = homedir()) {
  const configured = typeof env.XDG_DATA_HOME === 'string' ? env.XDG_DATA_HOME.trim() : ''
  const dataHome = configured !== '' ? configured : join(home, '.local', 'share')
  return join(dataHome, OPENCODE_DATA_DIR_NAME)
}

/**
 * Resolve the host's state database the way the host does.
 *
 * Returns the path AND its source, because the two produce different honest
 * wording: an `OPENCODE_DB` override is the user's own choice, while the XDG
 * path is only this platform's documented default.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {{ path: string, source: 'OPENCODE_DB' | 'default' }}
 */
export function resolveOpenCodeStatePath(env = process.env, home = homedir()) {
  const override = typeof env.OPENCODE_DB === 'string' ? env.OPENCODE_DB.trim() : ''
  if (override !== '') return { path: override, source: 'OPENCODE_DB' }
  return { path: join(openCodeDataDir(env, home), OPENCODE_DB_FILENAME), source: 'default' }
}

/**
 * One honest sentence about state sharing for the generation being installed.
 *
 * Both generations read one store, so "isolated" is never the right word. The
 * sentence names the resolved path, says where that path came from, and states
 * that Pantheon binds no service port (there is nothing to name).
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function describeSharedState(env = process.env, home = homedir()) {
  const { path: dbPath, source } = resolveOpenCodeStatePath(env, home)
  const origin = source === 'OPENCODE_DB' ? 'set by OPENCODE_DB' : 'the host default'
  return (
    `State is shared, not isolated per generation: OpenCode V1 and V2 read the same ` +
    `store (${dbPath}; ${origin}). Pantheon configures no separate database and binds ` +
    'no service port.'
  )
}
