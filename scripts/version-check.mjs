#!/usr/bin/env node
/** Fail-closed version and lockfile validation. */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  LOCK_INVENTORY,
  VERSION_MANIFEST_INVENTORY,
  validateInventory,
  writeInventoryVersion,
} from './manifest-inventory.mjs'

// Kept as a public compatibility API. New code must use MANIFEST_INVENTORY.
export const MANIFESTS = Object.freeze(
  ['pyproject.toml', 'plugin.json', 'src/plugins/tui/package.json'].map((file) => {
    const entry = VERSION_MANIFEST_INVENTORY.find((item) => item.file === file)
    return { name: file, file, kind: entry.kind }
  }),
)

function readLegacyVersion(root, manifest) {
  const path = join(root, manifest.file)
  const text = readFileSync(path, 'utf8')
  if (manifest.kind === 'toml') {
    const match = text.match(/^version\s*=\s*"([^"]+)"/m)
    if (!match) throw new Error(`${manifest.file} is missing version`)
    return match[1]
  }
  const data = JSON.parse(text)
  if (typeof data.version !== 'string') throw new Error(`${manifest.file} is missing version`)
  return data.version
}

function readSourceVersion(root) {
  const data = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  return typeof data.version === 'string' ? data.version : null
}

function readLockVersion(root, entry) {
  const data = JSON.parse(readFileSync(join(root, entry.file), 'utf8'))
  return typeof data.version === 'string' ? data.version : null
}

/**
 * Compare versions while retaining the historical MANIFESTS result shape.
 * Invalid/missing inventory entries are represented as null so callers can
 * display a useful table; all CLI mutation paths use validateInventory first.
 */
export function compareVersions(root) {
  let source = null
  const errors = []
  try {
    source = readSourceVersion(root)
  } catch (error) {
    errors.push(`package.json: ${error.message}`)
  }
  const manifests = MANIFESTS.map((manifest) => {
    let version = null
    try {
      version = readLegacyVersion(root, manifest)
    } catch (error) {
      errors.push(`${manifest.file}: ${error.message}`)
    }
    return { name: manifest.name, version, ok: version !== null && version === source }
  })
  const locks = LOCK_INVENTORY.map((entry) => {
    let version = null
    try {
      version = readLockVersion(root, entry)
    } catch (error) {
      errors.push(`${entry.file}: ${error.message}`)
    }
    return { name: entry.file, version, ok: version !== null && version === source }
  })
  try {
    validateInventory(root)
  } catch (error) {
    errors.push(error.message)
  }
  return {
    source,
    manifests,
    locks,
    errors: [...new Set(errors)],
    ok:
      source !== null &&
      manifests.every((item) => item.ok) &&
      locks.every((item) => item.ok) &&
      errors.length === 0,
  }
}

/**
 * Rewrite only version metadata after every inventory entry has passed the
 * structural preflight. A second validation is performed by the CLI.
 */
export function syncToSource(root) {
  const inventory = validateInventory(root, { allowVersionDivergence: true })
  const source = inventory.sourceVersion
  const changed = inventory.versions.filter(({ version }) => version !== source).length
  const lockChanged = inventory.documents.filter(
    ({ entry, data }) => entry.role === 'lock' && data.version !== source,
  ).length
  if (changed || lockChanged) writeInventoryVersion(inventory, source)
  return changed + lockChanged
}

function printDivergenceTable(result) {
  const rows = [
    ['manifest', 'version', 'status'],
    ...result.manifests.map((item) => [
      item.name,
      item.version ?? 'MISSING',
      item.ok ? 'ok' : 'DIVERGENT',
    ]),
    ...result.locks.map((item) => [
      item.name,
      item.version ?? 'MISSING',
      item.ok ? 'ok' : 'DIVERGENT',
    ]),
  ]
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => row[index].length)))
  console.log(`Source of truth: package.json → v${result.source ?? 'INVALID'}\n`)
  for (const row of rows)
    console.log(row.map((cell, index) => cell.padEnd(widths[index])).join('  '))
  for (const error of result.errors) console.error(`version-check: ${error}`)
  console.log('')
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  const root = process.cwd()
  const fix = process.argv.includes('--fix')
  const result = compareVersions(root)
  if (result.ok) {
    console.log(`✓ All manifests match package.json v${result.source}; locks are in sync`)
    process.exit(0)
  }
  printDivergenceTable(result)
  if (!fix) {
    console.error('version-check: inventory is invalid or out of sync')
    process.exit(1)
  }
  try {
    const changed = syncToSource(root)
    const after = compareVersions(root)
    if (!after.ok) throw new Error(after.errors.join('; ') || 'inventory remains divergent')
    console.log(`✓ Synced ${changed} metadata entries to v${after.source}`)
    process.exit(0)
  } catch (error) {
    console.error(`version-check: refusing to write: ${error.message}`)
    process.exit(1)
  }
}
