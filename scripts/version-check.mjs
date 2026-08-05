#!/usr/bin/env node
/**
 * version-check.mjs — Single source of truth enforcement
 *
 * package.json is the SOURCE OF TRUTH for the Pantheon version.
 * Every other manifest (pyproject.toml, plugin.json, src/plugins/tui/package.json)
 * MUST carry the same version. This script:
 *
 *   - compares every manifest against package.json and prints a divergence
 *     table when they differ (exit code 1),
 *   - with --fix, rewrites each divergent manifest to the package.json version.
 *
 * Mirrors the MANIFEST_FILES list in scripts/versioning.mjs so `apply`
 * and `check` can never drift apart.
 *
 * Usage:
 *   node scripts/version-check.mjs          # verify (exit 0 = in sync)
 *   node scripts/version-check.mjs --fix    # sync all manifests
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Same set of manifests as versioning.mjs (minus package.json itself). */
export const MANIFESTS = [
  { name: 'pyproject.toml', file: 'pyproject.toml', kind: 'toml' },
  { name: 'plugin.json', file: 'plugin.json', kind: 'json' },
  { name: 'src/plugins/tui/package.json', file: join('src', 'plugins', 'tui', 'package.json'), kind: 'json' },
]

function readTomlVersion(filePath) {
  const text = readFileSync(filePath, 'utf-8')
  const match = text.match(/^version\s*=\s*"([^"]+)"/m)
  if (!match) throw new Error(`no version field in ${filePath}`)
  return match[1]
}

function readJsonVersion(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8')).version
}

function readManifestVersion(filePath, kind) {
  try {
    return kind === 'toml' ? readTomlVersion(filePath) : readJsonVersion(filePath)
  } catch {
    return null
  }
}

function writeManifestVersion(filePath, kind, version) {
  if (kind === 'toml') {
    const text = readFileSync(filePath, 'utf-8')
    const updated = text.replace(/^(version\s*=\s*")[^"]+(")/m, `$1${version}$2`)
    writeFileSync(filePath, updated)
  } else {
    const content = JSON.parse(readFileSync(filePath, 'utf-8'))
    content.version = version
    writeFileSync(filePath, `${JSON.stringify(content, null, 2)}\n`)
  }
}

/**
 * Compare every manifest version against package.json (source of truth).
 *
 * @param {string} root - repository root containing package.json + manifests
 * @returns {{source: string, manifests: Array<{name: string, version: string|null, ok: boolean}>, ok: boolean}}
 *   - source: version read from package.json
 *   - manifests: per-manifest {name, version (null when unreadable), ok}
 *   - ok: true when every manifest matches the source version
 */
export function compareVersions(root) {
  const source = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')).version
  const manifests = MANIFESTS.map(({ name, file, kind }) => {
    const version = readManifestVersion(join(root, file), kind)
    return { name, version, ok: version === source }
  })
  return { source, manifests, ok: manifests.every((m) => m.ok) }
}

/**
 * Rewrite every divergent manifest to the package.json version.
 *
 * @param {string} root - repository root
 * @returns {number} count of manifests rewritten
 */
export function syncToSource(root) {
  const { source, manifests } = compareVersions(root)
  let changed = 0
  for (const manifest of manifests) {
    if (manifest.ok) continue
    const def = MANIFESTS.find((m) => m.name === manifest.name)
    writeManifestVersion(join(root, def.file), def.kind, source)
    changed += 1
  }
  return changed
}

function printDivergenceTable(result) {
  const rows = [
    ['manifest', 'version', 'status'],
    ...result.manifests.map((m) => [m.name, m.version ?? 'MISSING', m.ok ? 'ok' : 'DIVERGENT']),
  ]
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)))
  console.log(`Source of truth: package.json → v${result.source}\n`)
  for (const row of rows) {
    console.log(row.map((cell, i) => cell.padEnd(widths[i])).join('  '))
  }
  console.log('')
}

const isDirectRun =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  // npm scripts run from the package root, so the working directory is the
  // repository root to check. Explicit cwd keeps the CLI testable.
  const root = process.cwd()
  const fix = process.argv.includes('--fix')
  let result
  try {
    result = compareVersions(root)
  } catch (error) {
    console.error(`version-check: cannot read package.json — ${error.message}`)
    process.exit(1)
  }

  if (result.ok) {
    console.log(`✓ All manifests match package.json v${result.source}`)
    process.exit(0)
  }

  printDivergenceTable(result)
  if (fix) {
    const changed = syncToSource(root)
    const after = compareVersions(root)
    if (after.ok) {
      console.log(`✓ Synced ${changed} manifest(s) to v${after.source}`)
      process.exit(0)
    }
    console.error(`version-check: sync incomplete — ${after.manifests.filter((m) => !m.ok).length} manifest(s) still divergent`)
    process.exit(1)
  }
  console.error('version-check: manifests out of sync (run with --fix to sync)')
  process.exit(1)
}
