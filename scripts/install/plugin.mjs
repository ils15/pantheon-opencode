/**
 * plugin.mjs — Plugin installation utilities for the OpenCode installer
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { warning } from './cli-ui.mjs'
import { writeIfChanged } from './shared.mjs'

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
 * Suffix patterns that identify a Pantheon TUI registration as STALE. Every
 * reference shape ever written by previous installers must be covered:
 *   - dist file refs (both the old in-package src/plugins/tui target and the
 *     copied plugins/pantheon-tui target, tsx and js eras)
 *   - the in-package source dir (src/plugins/tui) — a registration pointing
 *     into the installed package breaks on reinstall/upgrade (the dir is
 *     replaced under a live registration)
 *   - bare copied dirs (plugins/pantheon-tui) from any OLD install target —
 *     indistinguishable from the current copied dir without knowing the
 *     install target, so they are flagged too; syncTuiRegistration keeps the
 *     current ref via unregister-then-register
 *   - node_modules copies (npx cache installs of the vendored plugin)
 */
export const TUI_STALE_SUFFIXES = [
  '/src/plugins/tui/dist/tui.tsx',
  '/src/plugins/tui/dist/tui.js',
  '/src/plugins/tui',
  '/plugins/pantheon-tui/dist/tui.tsx',
  '/plugins/pantheon-tui/dist/tui.js',
  '/plugins/pantheon-tui',
  '/node_modules/pantheon-tui',
]

/**
 * Whether a single tui.json plugin entry is a stale Pantheon TUI reference.
 * @param {unknown} ref - tui.json plugin entry
 * @returns {boolean}
 */
export function isStaleTuiRef(ref) {
  if (typeof ref !== 'string') return false
  if (ref === 'plugins/pantheon-tui') return true
  const normalized = ref.replaceAll('\\', '/')
  // npx spec strings ("npx pantheon-tui", "npx -y pantheon-tui",
  // "npx:pantheon-tui") and npx cache paths end with /node_modules/pantheon-tui.
  if (/^npx[\s:]/i.test(normalized) && normalized.includes('pantheon-tui')) return true
  return TUI_STALE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
}

/**
 * Pure filter: return the plugin entries of a tui.json plugin array that are
 * stale Pantheon TUI references.
 * @param {unknown[]} pluginArray - tui.json plugin array
 * @returns {string[]}
 */
export function staleTuiRefs(pluginArray) {
  return (Array.isArray(pluginArray) ? pluginArray : []).filter(isStaleTuiRef)
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
  // spec → NpmInstallFailedError), old dist paths, in-package source dirs,
  // bare copy dirs from previous install targets, and npx cache copies.
  // Without removing the absolute paths, each init run accumulates another
  // TUI plugin and OpenCode loads stale copies.
  const exactStale = [pluginId, `${pluginId}/dist/tui.tsx`, `${pluginId}/dist/tui.js`]
  tuiConfig.plugin = tuiConfig.plugin.filter((ref) => {
    if (exactStale.includes(ref)) return false
    return !isStaleTuiRef(ref)
  })
  const tuiContent = `${JSON.stringify(tuiConfig, null, 2)}\n`
  return writeIfChanged(tuiJsonPath, tuiContent, dryRun)
}
