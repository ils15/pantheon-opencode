/**
 * plugin.mjs — Plugin installation utilities for the OpenCode installer
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { ACTIONS, recordChange, recordRemovalTree, removeReviewedTree, snapshot } from './plan.mjs'
import { ROOT, writeIfChanged } from './shared.mjs'
import {
  assertNoSymlinkAncestors,
  assertPathWithin,
  assertSafeRemoval,
  verifyPathRemoved,
} from './verify.mjs'

/**
 * Copy a plugin's runtime payload (the root TUI loader, bundled dist/*,
 * package.json and package-lock.json) from source to destination. The raw TSX
 * implementation is never shipped to the destination; tui.ts only re-exports
 * the host-specific bundle so the local plugin stays hermetic.
 * @param {string} srcDir - Source plugin directory (e.g. ROOT/src/plugins/tui)
 * @param {string} dstDir - Destination plugin directory
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - If true, don't write files
 * @param {'v1'|'v2'} [options.version='v1'] - Host plugin generation
 * @param {(change: object) => void} [options.recorder] - optional change recorder for preview
 * @param {Set<string>|null} [options.reviewedRemovals] - paths approved by the current plan
 * @param {Map<string, object>|null} [options.reviewedSnapshots] - pre-apply path snapshots
 * @returns {{ created: number, skipped: number }}
 */
export function copyPluginFiles(
  srcDir,
  dstDir,
  {
    dryRun = false,
    version = 'v1',
    recorder = null,
    reviewedRemovals = null,
    reviewedSnapshots = null,
  } = {},
) {
  const result = { created: 0, skipped: 0 }
  const distDir = join(dstDir, 'dist')

  if (!dryRun) {
    assertNoSymlinkAncestors(dstDir)
    mkdirSync(dstDir, { recursive: true })
    assertNoSymlinkAncestors(dstDir)
    assertPathWithin(dstDir, distDir)
    assertNoSymlinkAncestors(distDir)
    mkdirSync(distDir, { recursive: true })
    assertNoSymlinkAncestors(distDir)
  }

  // Drop legacy raw copies from previous installs (root index.tsx + dist/tui.tsx).
  for (const legacyPath of [join(dstDir, 'index.tsx'), join(distDir, 'tui.tsx')]) {
    removeLegacyFile(legacyPath, dstDir, { dryRun, recorder, reviewedRemovals, reviewedSnapshots })
  }

  // Copy dist/* files
  const distSrc = join(srcDir, 'dist')
  if (existsSync(distSrc)) {
    for (const f of readdirSync(distSrc)) {
      const c = readFileSync(join(distSrc, f), 'utf8')
      const destination = join(distDir, f)
      assertPathWithin(dstDir, destination)
      const status = writeIfChanged(destination, c, dryRun, { recorder })
      if (status === 'created') result.created++
      else result.skipped++
    }
  }

  // Copy package.json
  const pkgSrc = join(srcDir, 'package.json')
  if (existsSync(pkgSrc)) {
    const packageJson = JSON.parse(readFileSync(pkgSrc, 'utf8'))
    if (version === 'v2' && packageJson.exports?.['./tui-v2']) {
      packageJson.exports['./tui'] = packageJson.exports['./tui-v2']
    }
    const pkgStatus = writeIfChanged(
      join(dstDir, 'package.json'),
      `${JSON.stringify(packageJson, null, 2)}\n`,
      dryRun,
      { recorder },
    )
    if (pkgStatus === 'created') result.created++
    else result.skipped++
  }

  // Each host generation receives its own root loader and compiled bundle.
  const tuiEntrySrc = join(srcDir, version === 'v2' ? 'tui-v2.ts' : 'tui.ts')
  if (existsSync(tuiEntrySrc)) {
    const entryStatus = writeIfChanged(
      join(dstDir, 'tui.ts'),
      readFileSync(tuiEntrySrc, 'utf8'),
      dryRun,
      { recorder },
    )
    if (entryStatus === 'created') result.created++
    else result.skipped++
  }

  const v2ServerEntry = join(srcDir, 'index-v2.ts')
  const v2ServerDestination = join(dstDir, 'index.ts')
  if (version === 'v2' && existsSync(v2ServerEntry)) {
    const entryStatus = writeIfChanged(
      v2ServerDestination,
      readFileSync(v2ServerEntry, 'utf8'),
      dryRun,
      { recorder },
    )
    if (entryStatus === 'created') result.created++
    else result.skipped++
  } else {
    removeLegacyFile(v2ServerDestination, dstDir, {
      dryRun,
      recorder,
      reviewedRemovals,
      reviewedSnapshots,
    })
  }

  // Copy the lockfile so dependency installation is reproducible. A missing
  // lockfile is intentionally not synthesized by the installer.
  const lockSrc = join(srcDir, 'package-lock.json')
  if (existsSync(lockSrc)) {
    const lockStatus = writeIfChanged(
      join(dstDir, 'package-lock.json'),
      readFileSync(lockSrc, 'utf8'),
      dryRun,
      { recorder },
    )
    if (lockStatus === 'created') result.created++
    else result.skipped++
  }

  return result
}

function removeLegacyFile(
  filePath,
  rootDir,
  { dryRun, recorder, reviewedRemovals, reviewedSnapshots },
) {
  assertSafeRemoval(rootDir, filePath)
  const present = existsSync(filePath)
  if (dryRun) {
    recordChange(
      {
        path: filePath,
        action: present ? ACTIONS.REMOVE : ACTIONS.UNCHANGED,
        bytes: 0,
        scored: false,
      },
      recorder,
    )
    return
  }
  if (!present) return

  const normalizedPath = resolve(filePath)
  if (reviewedRemovals && !reviewedRemovals.has(normalizedPath)) {
    throw new Error(`Refusing unreviewed plugin removal: ${filePath}`)
  }
  const expected = reviewedSnapshots?.get(normalizedPath)
  if (reviewedSnapshots && (!expected || !sameSnapshot(snapshot(filePath), expected))) {
    throw new Error(`Plugin removal target drifted after review: ${filePath}`)
  }
  rmSync(filePath, { force: true })
  verifyPathRemoved(filePath)
  recordChange({ path: filePath, action: ACTIONS.REMOVE, bytes: 0, scored: false }, recorder)
}

function sameSnapshot(left, right) {
  return (
    left.exists === right.exists &&
    left.sha256 === right.sha256 &&
    left.size === right.size &&
    left.mode === right.mode
  )
}

/**
 * Install a plugin from source to destination.
 * @param {string} srcDir - Source plugin directory (e.g. ROOT/src/plugins/tui)
 * @param {string} dstDir - Destination plugin directory
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false] - If true, don't write files
 * @param {boolean} [options.clean=false] - If true, remove existing before install
 * @param {(change: object) => void} [options.recorder] - optional change recorder for preview
 * @returns {{ created: number, skipped: number, errors: number }}
 */
export function installPlugin(
  srcDir,
  dstDir,
  {
    dryRun = false,
    clean = false,
    version = 'v1',
    recorder = null,
    reviewedRemovals = null,
    reviewedSnapshots = null,
  } = {},
) {
  const result = { created: 0, skipped: 0, errors: 0 }
  const cleanTargetExisted = clean && existsSync(dstDir)

  assertNoSymlinkAncestors(dstDir)
  if (cleanTargetExisted) {
    assertSafeRemoval(dirname(dstDir), dstDir)
    if (dryRun) {
      recordRemovalTree(dstDir, recorder)
    } else {
      removeReviewedTree(dstDir, reviewedRemovals, reviewedSnapshots)
    }
  }

  const copyResult = copyPluginFiles(srcDir, dstDir, {
    dryRun,
    version,
    recorder,
    reviewedRemovals,
    reviewedSnapshots,
  })
  result.created += copyResult.created
  result.skipped += copyResult.skipped
  if (cleanTargetExisted) {
    // The clean pass removes these directories before rebuilding their files;
    // keep the net plan truthful while the separate removal review still lists
    // every path actually cleared.
    recordChange({ path: dstDir, action: ACTIONS.UNCHANGED, bytes: 0, scored: false }, recorder)
    if (existsSync(join(srcDir, 'dist'))) {
      recordChange(
        { path: join(dstDir, 'dist'), action: ACTIONS.UNCHANGED, bytes: 0, scored: false },
        recorder,
      )
    }
  }

  // Install plugin dependencies (@opentui/core, @opentui/solid, solid-js).
  // Lockfile installation is the only accepted dependency path.
  if (!dryRun) {
    execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: dstDir, stdio: 'pipe' })
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
  execSync('npm ci --omit=dev --no-audit --no-fund', { cwd: pluginDir, stdio: 'pipe' })
}

/**
 * Register a plugin in tui.json.
 * @param {string} tuiJsonPath - Path to tui.json
 * @param {string} pluginId - Plugin identifier string
 * @param {object} [options]
 * @param {boolean} [options.dryRun=false]
 * @param {(change: object) => void} [options.recorder] - optional change recorder for preview
 * @returns {'created'|'skipped'}
 */
export function registerPlugin(tuiJsonPath, pluginId, { dryRun = false, recorder = null } = {}) {
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
  return writeIfChanged(tuiJsonPath, tuiContent, dryRun, { recorder })
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
 * @param {string[]} [options.knownPantheonPaths=[]]
 * @param {(change: object) => void} [options.recorder] - optional change recorder for preview
 * @returns {'created'|'skipped'}
 */
export function unregisterPlugin(
  tuiJsonPath,
  pluginId,
  { dryRun = false, knownPantheonPaths = [], recorder = null } = {},
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
  // Stale-ref cleanup is not part of the install summary, so record it unscored.
  return writeIfChanged(tuiJsonPath, tuiContent, dryRun, { recorder, scored: false })
}
