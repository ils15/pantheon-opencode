/**
 * plugin.mjs — Plugin installation utilities for the OpenCode installer
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { warning } from './cli-ui.mjs'
import { writeIfChanged } from './shared.mjs'

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

  if (!dryRun) mkdirSync(dstDir, { recursive: true })
  if (clean && existsSync(dstDir) && !dryRun) {
    rmSync(dstDir, { recursive: true, force: true })
    mkdirSync(dstDir, { recursive: true })
  }
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
      writeIfChanged(join(dstDir, 'dist', f), c, dryRun)
      result.created++
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

  // Install plugin dependencies (@opentui/core, @opentui/solid, solid-js)
  if (!dryRun) {
    try {
      execSync('npm install --omit=dev --no-audit', { cwd: dstDir, stdio: 'pipe' })
    } catch (e) {
      warning('Failed to install TUI plugin dependencies: ' + e.message)
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
    warning('Failed to install plugin dependencies: ' + e.message)
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
 * Unregister stale plugin references from tui.json.
 * @param {string} tuiJsonPath - Path to tui.json
 * @param {string} pluginId - Plugin to unregister
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]
 * @returns {'created'|'skipped'}
 */
export function unregisterPlugin(tuiJsonPath, pluginId, { dryRun = false } = {}) {
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
  // spec → NpmInstallFailedError), old dist paths, and absolute paths from
  // previous package/npx installs. Without removing the absolute paths, each
  // init run accumulates another TUI plugin and OpenCode loads stale copies.
  const staleRefs = [pluginId, `${pluginId}/dist/tui.tsx`, `${pluginId}/dist/tui.js`]
  const staleSuffixes = [
    '/src/plugins/tui/dist/tui.tsx',
    '/src/plugins/tui/dist/tui.js',
    '/plugins/pantheon-tui/dist/tui.tsx',
    '/plugins/pantheon-tui/dist/tui.js',
    // The bare copy directory itself (installPlugin legacy target) — a
    // registration pointing at it is stale once the package dir is used.
    '/plugins/pantheon-tui',
  ]
  tuiConfig.plugin = tuiConfig.plugin.filter((ref) => {
    if (staleRefs.includes(ref)) return false
    const normalized = typeof ref === 'string' ? ref.replaceAll('\\', '/') : ''
    return !staleSuffixes.some((suffix) => normalized.endsWith(suffix))
  })
  const tuiContent = `${JSON.stringify(tuiConfig, null, 2)}\n`
  return writeIfChanged(tuiJsonPath, tuiContent, dryRun)
}
