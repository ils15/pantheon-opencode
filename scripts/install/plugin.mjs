/**
 * plugin.mjs — Plugin installation utilities for the OpenCode installer
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    const idxStatus = writeIfChanged(join(dstDir, 'index.tsx'), readFileSync(srcIdx, 'utf8'), dryRun)
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
    const pkgStatus = writeIfChanged(join(dstDir, 'package.json'), readFileSync(pkgSrc, 'utf8'), dryRun)
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
  // Remove stale plugin refs (old dist/tui.tsx path)
  const staleRefs = [`${pluginId}/dist/tui.tsx`, `${pluginId}/dist/tui.js`]
  for (const stale of staleRefs) {
    const idx = tuiConfig.plugin.indexOf(stale)
    if (idx !== -1) tuiConfig.plugin.splice(idx, 1)
  }
  const tuiContent = `${JSON.stringify(tuiConfig, null, 2)}\n`
  return writeIfChanged(tuiJsonPath, tuiContent, dryRun)
}
