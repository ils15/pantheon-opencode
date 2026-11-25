/**
 * Install-shape guard (`install-guard.mjs`).
 *
 * Plain ESM `.mjs` module (with `.d.mts` types) so it runs natively inside
 * `node_modules/` where Node.js forbids `.ts` type-stripping, and so the load
 * path of the shipped plugin (`src/plugin/index.js`, built from
 * `src/plugin.ts`) can call it without adding a build step.
 *
 * ## What it can and cannot see
 *
 * The guard inspects the package it is CURRENTLY EXECUTING. If OpenCode loads
 * the V1-era 1.5.x package instead of this one, that package's own code runs and
 * none of this module executes — the exact `Session.AgentNotFoundError` incident
 * cannot be caught retroactively from inside a package that was never loaded.
 * What it does catch is the reachable half: a cache/prefix whose `package.json`
 * version is below the floor, and a partially updated or V1-shaped tree that
 * carries this code but not the `./tui` export or the V2 agent roster. Both
 * would otherwise surface as a missing TUI panel and `AgentNotFoundError`, far
 * from the cause.
 *
 * The check is read-only, runs once per `setup()`, and is silent on the happy
 * path: three `existsSync` calls plus one `package.json` read.
 *
 * @module pantheon/install-guard
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * First package version that ships the V2-only shape this plugin needs: the
 * `./tui` export (the TUI moved INTO the package in 2.3.0), the V2 agent
 * roster, and the `src/plugin` entry the OpenCode 2.x loader registers.
 * Shared with `legacy-store-migration.mjs`, which removes npx installs below it.
 */
export const MIN_SUPPORTED_PANTHEON_VERSION = '2.3.0'

/** First OpenCode host version that supports Pantheon V2.3+. */
export const MIN_SUPPORTED_HOST_VERSION = '2.0.0'

/** Package name this guard can identify. */
export const PANTHEON_PACKAGE_NAME = 'pantheon-opencode'

/** V2-only files, relative to the package root. */
const V2_TUI_EXPORT_TARGET = join('src', 'plugins', 'tui', 'dist', 'tui.js')
const V2_AGENT_ROSTER = join('src', 'agents', 'roster.json')
const V2_AGENT_FALLBACK = join('src', 'agents', 'zeus.md')

/**
 * Parse the numeric triple of a semver string.
 *
 * Prerelease and build suffixes are ignored on purpose: this is a SHAPE floor,
 * not a release-channel gate, so `2.3.0-beta.N` (a development build of the
 * first V2.3 package) is not treated as older than `2.3.0`.
 *
 * @param {unknown} raw
 * @returns {[number, number, number] | null}
 */
function parseVersion(raw) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(raw ?? '').trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * True when `version` is a parseable version below
 * {@link MIN_SUPPORTED_PANTHEON_VERSION}. An unparseable version returns
 * `false`: an unreadable manifest is not evidence of a legacy install, and a
 * deletion decided on a guess is worse than a leftover directory.
 *
 * @param {unknown} version
 * @returns {boolean}
 */
export function isBelowSupportedPantheonVersion(
  version,
  minimumVersion = MIN_SUPPORTED_PANTHEON_VERSION,
) {
  const parsed = parseVersion(version)
  const minimum = parseVersion(minimumVersion)
  if (!parsed || !minimum) return false
  for (let index = 0; index < 3; index += 1) {
    if (parsed[index] !== minimum[index]) return parsed[index] < minimum[index]
  }
  return false
}

/**
 * @param {string} filePath
 * @returns {Record<string, unknown> | null}
 */
function readJson(filePath) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Walk up from this module looking for the package that owns it.
 *
 * Bundled (`src/plugin/index.js`) and unbundled (`src/pantheon/…`) both land two
 * directories below the package root, but the walk does not depend on that: the
 * first ancestor whose `package.json` names this package wins.
 *
 * @returns {{ root: string | undefined, manifest: Record<string, unknown> | null }}
 */
function defaultPackageRoot() {
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let depth = 0; depth < 6; depth += 1) {
      const manifestPath = join(dir, 'package.json')
      const manifest = existsSync(manifestPath) ? readJson(manifestPath) : null
      if (manifest?.name === PANTHEON_PACKAGE_NAME) return { root: dir, manifest }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    /* fall through: no package root is not a failure */
  }
  return { root: undefined, manifest: null }
}

/**
 * @param {unknown} value
 * @param {string[]} [out]
 * @returns {string[]}
 */
function collectExportTargets(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) collectExportTargets(nested, out)
  }
  return out
}

/**
 * True when the package declares a `./tui` export that resolves to a real file,
 * or ships the TUI bundle the export would point at.
 *
 * @param {string} root
 * @param {Record<string, unknown> | null} manifest
 * @returns {boolean}
 */
function hasV2TuiExport(root, manifest) {
  const exportsField = manifest?.exports
  if (exportsField && typeof exportsField === 'object') {
    const declared = /** @type {Record<string, unknown>} */ (exportsField)['./tui']
    for (const target of collectExportTargets(declared)) {
      const resolved = isAbsolute(target) ? target : resolve(root, target)
      if (existsSync(resolved)) return true
    }
  }
  return existsSync(join(root, V2_TUI_EXPORT_TARGET))
}

/**
 * True when the package carries the V2 agent roster (or at least one canonical
 * V2 agent file as a fallback for a tree built without the roster).
 *
 * @param {string} root
 * @returns {boolean}
 */
function hasV2Agents(root) {
  const roster = readJson(join(root, V2_AGENT_ROSTER))
  const agents = roster?.agents
  if (agents && typeof agents === 'object' && Object.keys(agents).length > 0) return true
  return existsSync(join(root, V2_AGENT_FALLBACK))
}

/**
 * Inspect the Pantheon package that is currently executing.
 *
 * @param {{ packageRoot?: string }} [options]
 * @returns {{
 *   ok: boolean,
 *   packageRoot: string | undefined,
 *   version: string | undefined,
 *   reasons: string[],
 * }}
 */
export function inspectPantheonInstall(options = {}) {
  const explicitRoot =
    typeof options.packageRoot === 'string' && options.packageRoot.trim()
      ? resolve(options.packageRoot)
      : undefined
  const located = explicitRoot ? null : defaultPackageRoot()
  const packageRoot = explicitRoot ?? located?.root
  const hostVersion =
    typeof options.hostVersion === 'string' && options.hostVersion.trim()
      ? options.hostVersion.trim()
      : undefined
  const hostUnsupported =
    hostVersion !== undefined &&
    isBelowSupportedPantheonVersion(hostVersion, MIN_SUPPORTED_HOST_VERSION)

  if (!packageRoot) {
    return {
      ok: !hostUnsupported,
      packageRoot: undefined,
      version: undefined,
      reasons: hostUnsupported ? ['host-version'] : [],
    }
  }

  const manifest = located?.manifest ?? readJson(join(packageRoot, 'package.json'))
  if (!manifest || manifest.name !== PANTHEON_PACKAGE_NAME) {
    // An explicit path that is not a Pantheon package (or a tree whose manifest
    // cannot be read) is not evidence of a legacy install. Never fail a load on
    // a guess, though an explicitly unsupported OpenCode host still fails loud.
    return {
      ok: !hostUnsupported,
      packageRoot,
      version: undefined,
      reasons: hostUnsupported ? ['host-version'] : [],
    }
  }
  const version =
    typeof manifest?.version === 'string' && manifest.version.trim()
      ? manifest.version.trim()
      : undefined

  const reasons = []
  if (hostUnsupported) reasons.push('host-version')
  if (version && isBelowSupportedPantheonVersion(version)) reasons.push('version')
  if (!hasV2TuiExport(packageRoot, manifest)) reasons.push('tui-export')
  if (!hasV2Agents(packageRoot)) reasons.push('v2-agents')

  return { ok: reasons.length === 0, packageRoot, version, reasons }
}

/**
 * Build the actionable failure text.
 *
 * @param {ReturnType<typeof inspectPantheonInstall>} detection
 * @param {{ hostVersion?: string }} [context]
 * @returns {string}
 */
export function pantheonInstallGuardMessage(detection, context = {}) {
  if (detection.reasons.includes('host-version') && detection.reasons.length === 1) {
    const hostVersion = String(context.hostVersion ?? '').trim() || 'unknown'
    return (
      `OpenCode >= ${MIN_SUPPORTED_HOST_VERSION} required (loaded: opencode ${hostVersion}). ` +
      `Upgrade OpenCode to ${MIN_SUPPORTED_HOST_VERSION}+ and reinstall "${PANTHEON_PACKAGE_NAME}".`
    )
  }
  const detected = detection.version
    ? `${PANTHEON_PACKAGE_NAME}@${detection.version}`
    : 'a package without the V2 shape'
  const parts = [
    `Pantheon 2.3.x required but ${detected} is loaded.`,
    `Fix: pin "${PANTHEON_PACKAGE_NAME}@${MIN_SUPPORTED_PANTHEON_VERSION}" (explicit version, not @latest) in ~/.config/opencode/opencode.json, remove ~/.cache/opencode/npm/pantheon-opencode@* and restart OpenCode.`,
  ]
  const missing = []
  if (detection.reasons.includes('tui-export')) missing.push('the ./tui export')
  if (detection.reasons.includes('v2-agents')) missing.push('the V2 agent roster')
  if (missing.length > 0) parts.push(`Missing: ${missing.join(' and ')}.`)
  const hostVersion = String(context.hostVersion ?? '').trim()
  if (hostVersion) parts.push(`Loaded host: opencode ${hostVersion}.`)
  return parts.join(' ')
}

/**
 * Throw the actionable message when the executing package is not the V2.3+
 * shape. Returns the inspection result so callers can log it without
 * re-reading the package.
 *
 * @param {{ packageRoot?: string, hostVersion?: string }} [options]
 * @returns {ReturnType<typeof inspectPantheonInstall>}
 */
export function assertSupportedPantheonInstall(options = {}) {
  const detection = inspectPantheonInstall({
    packageRoot: options.packageRoot,
    hostVersion: options.hostVersion,
  })
  if (detection.ok) return detection
  throw new Error(pantheonInstallGuardMessage(detection, { hostVersion: options.hostVersion }))
}
