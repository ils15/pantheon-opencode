/**
 * npx-cache-sweep.mjs — stale pantheon-opencode copy detection and removal.
 *
 * `npx pantheon-opencode` materializes a full package copy under
 * `<npm-cache>/_npx/<hash>/node_modules/pantheon-opencode` and reuses it per
 * spec+version. Old copies accumulate across versions (field evidence: a
 * 1.6.1 copy next to the registered 1.6.2-beta.12 made `npx
 * pantheon-opencode doctor` report the registered plugin as outdated), and
 * nothing in npm removes them. This module finds and removes those copies —
 * ONLY the `pantheon-opencode` subtree, never a whole `_npx/<hash>` entry,
 * which may hold unrelated packages.
 *
 * After a successful init the registration in the user's opencode config
 * points at the freshly installed copy, so every other copy is unreferenced:
 * removing it only costs a re-download if that exact spec is invoked again.
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const PACKAGE_DIR_NAME = 'pantheon-opencode'

/**
 * Resolve the npm cache root that holds `_npx/`. Injection first (tests),
 * then `npm config get cache` (portable across Linux/macOS/Windows), then the
 * POSIX default. A resolvable cache root is never guaranteed: callers must
 * treat a missing `_npx` as "nothing to do".
 * @param {{ npmCache?: string }} [options]
 * @returns {Promise<string>}
 */
export async function resolveNpxCacheRoot({ npmCache } = {}) {
  if (npmCache) return resolve(npmCache)
  try {
    const { stdout } = await execFileAsync('npm', ['config', 'get', 'cache'], { timeout: 15000 })
    const value = String(stdout).trim()
    if (value) return resolve(value)
  } catch {
    // npm missing or slow — the POSIX default covers the common case.
  }
  return join(homedir(), '.npm')
}

/** True when the directory looks like an installed pantheon-opencode copy. */
function isPantheonCopy(dir) {
  return existsSync(join(dir, 'package.json'))
}

/**
 * List every installed pantheon-opencode copy under the npm cache's `_npx/`.
 * @param {{ cacheRoot?: string }} [options]
 * @returns {Promise<Array<{ dir: string, version: string | null }>>}
 */
export async function findPantheonNpxCacheCopies({ cacheRoot } = {}) {
  const root = cacheRoot ?? (await resolveNpxCacheRoot())
  const npxDir = join(root, '_npx')
  if (!existsSync(npxDir)) return []
  const copies = []
  for (const entry of readdirSync(npxDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = resolve(join(npxDir, entry.name, 'node_modules', PACKAGE_DIR_NAME))
    if (!isPantheonCopy(dir)) continue
    let version = null
    try {
      version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? null
    } catch {
      // An unreadable package.json still marks a sweepable copy.
      version = null
    }
    copies.push({ dir, version })
  }
  return copies
}

/**
 * Remove every installed pantheon-opencode copy under `_npx/` except `keep`.
 * `keep: null` is the defensive no-op: without an explicit survivor, nothing
 * is removed.
 * @param {{ keep?: string | null, cacheRoot?: string }} options
 * @returns {Promise<{ removed: string[] }>}
 */
export async function sweepStalePantheonNpxCaches({ keep = null, cacheRoot } = {}) {
  const keepResolved = keep ? resolve(keep) : null
  if (keepResolved === null) return { removed: [] }
  const copies = await findPantheonNpxCacheCopies({ cacheRoot })
  const removed = []
  for (const copy of copies) {
    if (copy.dir === keepResolved) continue
    try {
      rmSync(copy.dir, { recursive: true, force: true })
    } catch {
      // A copy that cannot be removed (locked by a running host) is left in
      // place; the next init retries. Never rethrow into the install flow.
      continue
    }
    if (!existsSync(copy.dir)) removed.push(copy.dir)
  }
  return { removed }
}
