/**
 * plugin.mjs — Plugin installation utilities for the OpenCode installer
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { warning } from './cli-ui.mjs'
import { ROOT, writeIfChanged } from './shared.mjs'

/**
 * Copy a plugin's runtime payload (src/index.tsx → index.tsx, dist/*,
 * package.json) from source to destination. Pure file copy — no npm install.
 * @param {string} srcDir - Source plugin directory (e.g. ROOT/src/plugins/tui)
 * @param {string} dstDir - Destination plugin directory
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - If true, don't write files
 * @returns {{ created: number, skipped: number }}
 */
export function copyPluginFiles(srcDir, dstDir, { dryRun = false } = {}) {
  const result = { created: 0, skipped: 0 }

  if (!dryRun) mkdirSync(dstDir, { recursive: true })
  if (!dryRun) mkdirSync(join(dstDir, 'dist'), { recursive: true })

  // Copy src/index.tsx -> index.tsx
  const srcIdx = join(srcDir, 'src', 'index.tsx')
  if (existsSync(srcIdx)) {
    const idxStatus = writeIfChanged(
      join(dstDir, 'index.tsx'),
      readFileSync(srcIdx, 'utf8'),
      dryRun,
    )
    if (idxStatus === 'created') result.created++
    else result.skipped++
  }

  // Copy dist/* files
  const distSrc = join(srcDir, 'dist')
  if (existsSync(distSrc)) {
    for (const f of readdirSync(distSrc)) {
      const c = readFileSync(join(distSrc, f), 'utf8')
      const status = writeIfChanged(join(dstDir, 'dist', f), c, dryRun)
      if (status === 'created') result.created++
      else result.skipped++
    }
  }

  // Copy package.json
  const pkgSrc = join(srcDir, 'package.json')
  if (existsSync(pkgSrc)) {
    const pkgStatus = writeIfChanged(
      join(dstDir, 'package.json'),
      readFileSync(pkgSrc, 'utf8'),
      dryRun,
    )
    if (pkgStatus === 'created') result.created++
    else result.skipped++
  }

  return result
}

/**
 * Install a plugin from source to destination.
 * @param {string} srcDir - Source plugin directory (e.g. ROOT/src/plugins/tui)
 * @param {string} dstDir - Destination plugin directory
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - If true, don't write files
 * @param {boolean} [options.clean=false] - If true, remove existing before install
 * @returns {{ created: number, skipped: number, errors: number }}
 */
export function installPlugin(srcDir, dstDir, { dryRun = false, clean = false } = {}) {
  const result = { created: 0, skipped: 0, errors: 0 }

  if (clean && existsSync(dstDir) && !dryRun) {
    rmSync(dstDir, { recursive: true, force: true })
  }

  const copyResult = copyPluginFiles(srcDir, dstDir, { dryRun })
  result.created += copyResult.created
  result.skipped += copyResult.skipped

  // Install plugin dependencies (@opentui/core, @opentui/solid, solid-js)
  if (!dryRun) {
    try {
      execSync('npm install --omit=dev --no-audit', { cwd: dstDir, stdio: 'pipe' })
    } catch (e) {
      warning(`Failed to install TUI plugin dependencies: ${e.message}`)
      result.errors++
    }
  }

  return result
}

/**
 * Install plugin dependencies via npm.
 * @param {string} pluginDir - Directory containing package.json
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - If true, skip npm install
 */
export function installPluginDependencies(pluginDir, { dryRun = false } = {}) {
  if (dryRun) return
  try {
    execSync('npm install --omit=dev --no-audit', { cwd: pluginDir, stdio: 'pipe' })
  } catch (e) {
    warning(`Failed to install plugin dependencies: ${e.message}`)
  }
}

/**
 * Register a plugin in tui.json.
 * @param {string} tuiJsonPath - Path to tui.json
 * @param {string} pluginId - Plugin identifier string
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]
 * @returns {'created'|'skipped'}
 */
export function registerPlugin(tuiJsonPath, pluginId, { dryRun = false } = {}) {
  let tuiConfig = { plugin: [] }
  if (existsSync(tuiJsonPath)) {
    try {
      tuiConfig = JSON.parse(readFileSync(tuiJsonPath, 'utf8'))
    } catch {
      /* use default */
    }
  }
  if (!Array.isArray(tuiConfig.plugin)) {
    tuiConfig.plugin = []
  }
  if (!tuiConfig.plugin.includes(pluginId)) {
    tuiConfig.plugin.push(pluginId)
  }
  const tuiContent = `${JSON.stringify(tuiConfig, null, 2)}\n`
  return writeIfChanged(tuiJsonPath, tuiContent, dryRun)
}

/**
 * Exact relative markers written by previous installers. These are intentionally
 * complete references, not suffixes: a user-owned path may contain
 * `pantheon-opencode` or end in the same filename without being ours.
 */
export const TUI_STALE_SUFFIXES = [
  'plugins/pantheon-tui',
  'plugins/pantheon-tui/dist/tui.tsx',
  'plugins/pantheon-tui/dist/tui.js',
  'npx pantheon-tui',
  'npx -y pantheon-tui',
  'npx:pantheon-tui',
]

const PACKAGE_TUI_PATHS = [
  join(ROOT, 'src', 'plugins', 'tui'),
  join(ROOT, 'src', 'plugins', 'tui', 'dist', 'tui.tsx'),
  join(ROOT, 'src', 'plugins', 'tui', 'dist', 'tui.js'),
]

function normalizePluginPath(ref) {
  return ref.replaceAll('\\', '/')
}

function exactManagedPaths(knownPantheonPaths) {
  return new Set(
    [...PACKAGE_TUI_PATHS, ...knownPantheonPaths]
      .filter((path) => typeof path === 'string')
      .map((path) => normalizePluginPath(path)),
  )
}

function isExactNpxMarker(ref) {
  return (
    /^npx(?:\s+-y)?\s+pantheon-tui(?:@[A-Za-z0-9._-]+)?$/i.test(ref) ||
    /^npx:pantheon-tui(?:@[A-Za-z0-9._-]+)?$/i.test(ref) ||
    /(?:^|\/)\.npm\/_npx\/[^/]+\/node_modules\/pantheon-tui(?:\/|$)/i.test(ref)
  )
}

/**
 * Return whether a registration is unambiguously one of our old TUI refs.
 *
 * @param {unknown} ref - tui.json plugin entry
 * @param {string[]} [knownPantheonPaths=[]] - paths owned by this installer
 * @returns {boolean}
 */
export function isPantheonTuiRef(ref, knownPantheonPaths = []) {
  if (typeof ref !== 'string') return false
  const normalized = normalizePluginPath(ref)
  if (TUI_STALE_SUFFIXES.includes(normalized)) return true
  if (isExactNpxMarker(normalized)) return true

  const knownPaths = exactManagedPaths(knownPantheonPaths)
  if (knownPaths.has(normalized)) return true
  return isAbsolute(normalized) && knownPaths.has(normalizePluginPath(resolve(normalized)))
}

/**
 * Whether a single tui.json plugin entry is a stale Pantheon TUI reference.
 * @param {unknown} ref - tui.json plugin entry
 * @returns {boolean}
 */
export function isStaleTuiRef(ref, knownPantheonPaths = []) {
  return isPantheonTuiRef(ref, knownPantheonPaths)
}

/**
 * Pure filter: return the plugin entries of a tui.json plugin array that are
 * stale Pantheon TUI references.
 * @param {unknown[]} pluginArray - tui.json plugin array
 * @returns {string[]}
 */
export function staleTuiRefs(pluginArray, knownPantheonPaths = []) {
  return (Array.isArray(pluginArray) ? pluginArray : []).filter((ref) =>
    isStaleTuiRef(ref, knownPantheonPaths),
  )
}

/**
 * Unregister stale plugin references from tui.json.
 * @param {string} tuiJsonPath - Path to tui.json
 * @param {string} pluginId - Plugin to unregister
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]
 * @returns {'created'|'skipped'}
 */
export function unregisterPlugin(
  tuiJsonPath,
  pluginId,
  { dryRun = false, knownPantheonPaths = [] } = {},
) {
  if (!existsSync(tuiJsonPath)) {
    // Nothing to clean — and never create an empty tui.json in a location
    // OpenCode reads (the cross-location cleanup also touches global config
    // dirs that may not exist yet; writing there would ENOENT).
    return 'skipped'
  }
  let tuiConfig = { plugin: [] }
  try {
    tuiConfig = JSON.parse(readFileSync(tuiJsonPath, 'utf8'))
  } catch {
    /* use default */
  }
  if (!Array.isArray(tuiConfig.plugin)) {
    tuiConfig.plugin = []
  }
  // Remove stale refs: the bare relative id (openCode < 1.19 wrote
  // "plugins/pantheon-tui", which its tui loader misreads as an npm/github
  // spec → NpmInstallFailedError), old dist paths, in-package source dirs,
  // bare copy dirs from previous install targets, and npx cache copies.
  // Without removing the absolute paths, each init run accumulates another
  // TUI plugin and OpenCode loads stale copies.
  const exactStale = new Set(
    [pluginId, `${pluginId}/dist/tui.tsx`, `${pluginId}/dist/tui.js`].map(normalizePluginPath),
  )
  tuiConfig.plugin = tuiConfig.plugin.filter((ref) => {
    if (typeof ref === 'string' && exactStale.has(normalizePluginPath(ref))) return false
    return !isPantheonTuiRef(ref, knownPantheonPaths)
  })
  const tuiContent = `${JSON.stringify(tuiConfig, null, 2)}\n`
  return writeIfChanged(tuiJsonPath, tuiContent, dryRun)
}
