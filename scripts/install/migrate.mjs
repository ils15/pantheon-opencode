#!/usr/bin/env node
/**
 * migrate.mjs — Multi-version migration logic for Pantheon installations
 *
 * Usage:
 *   node scripts/install/migrate.mjs --target ~/.config/opencode
 *   node scripts/install/migrate.mjs --target ~/.config/opencode --dry-run
 *   node scripts/install/migrate.mjs --target ~/.config/opencode --force
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInitialState, readState, writeState } from './state.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')

// Package version from project root
const PANTHON_VERSION = readPackageVersion()

function readPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    return pkg.version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Read the installed version from the target's install state file.
 * @param {string} target
 * @returns {string|null} - version string or null for fresh install
 */
export function detectVersion(target) {
  const state = readState(target)
  if (state) return state.pantheon_version || state.version || 'unknown'
  return null
}

/**
 * Run version-specific migrations sequentially.
 *
 * @param {string} target - Installation directory
 * @param {string|null} currentVersion - Detected version (null = fresh install)
 * @param {{ dryRun?: boolean }} [options]
 * @returns {{ applied: number, messages: string[] }}
 */
export function runMigrations(target, currentVersion, { dryRun = false } = {}) {
  const applied = []
  const semver = parseSemver(currentVersion)

  // ── Migration: v3.10.0 → v3.18.0 ──────────────────────────────────
  // Fix dangling references, add Memory Protocol
  if (semver && lt(semver, [3, 18, 0])) {
    applied.push({
      from: formatSemver(semver),
      to: '3.18.0',
      description: 'Fix dangling references, add Memory Protocol',
    })
    semver[0] = 3
    semver[1] = 18
    semver[2] = 0
  }

  // ── Migration: v3.18.0 → v3.19.0 ──────────────────────────────────
  // Add runtime component, _pantheon_paths
  if (semver && lt(semver, [3, 19, 0])) {
    applied.push({
      from: formatSemver(semver),
      to: '3.19.0',
      description: 'Add runtime component, _pantheon_paths',
    })
    semver[0] = 3
    semver[1] = 19
    semver[2] = 0
  }

  // ── Migration: v3.19.0 → v3.19.1 ──────────────────────────────────
  // Add persistence MCP, fix 157 dangling refs
  if (semver && lt(semver, [3, 19, 1])) {
    applied.push({
      from: formatSemver(semver),
      to: '3.19.1',
      description: 'Add persistence MCP, fix dangling refs',
    })
    semver[0] = 3
    semver[1] = 19
    semver[2] = 1
  }

  // ── Migration: v3.19.1 → v3.19.2 ──────────────────────────────────
  // Upgrade state schema from v1 to v2
  if (semver && lt(semver, [3, 19, 2])) {
    applied.push({
      from: formatSemver(semver),
      to: '3.19.2',
      description: 'Upgrade install state schema to v2 with component tracking',
    })
    semver[0] = 3
    semver[1] = 19
    semver[2] = 2
  }

  // ── Write updated state ───────────────────────────────────────────
  if (applied.length > 0 && !dryRun) {
    const newVersion = formatSemver(semver)
    let state = readState(target)
    if (!state) state = createInitialState(newVersion)
    state.pantheon_version = newVersion
    for (const m of applied) {
      state.applied_migrations.push({
        from: m.from,
        to: m.to,
        applied_at: new Date().toISOString(),
        status: 'completed',
      })
    }
    if (!state.components) {
      state.components = {
        agents: { version: 1, status: 'installed' },
        skills: { version: 1, status: 'installed' },
        plugins: { version: 1, status: 'installed' },
        runtime: { version: 1, status: 'installed' },
      }
    }
    writeState(target, state)
  }

  return {
    applied: applied.length,
    messages: applied.map((m) => `${m.from} → ${m.to}: ${m.description}`),
  }
}

// ---------------------------------------------------------------------------
// Checkpoint system for crash recovery
// ---------------------------------------------------------------------------

const CHECKPOINT_FILE = '.migration-checkpoint'
const STATE_DIR = '.pantheon'

/**
 * Read the migration checkpoint file if it exists.
 * @param {string} target
 * @returns {object|null}
 */
export function readCheckpoint(target) {
  const cpFile = join(target, STATE_DIR, CHECKPOINT_FILE)
  if (!existsSync(cpFile)) return null
  try {
    return JSON.parse(readFileSync(cpFile, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Write a migration checkpoint before starting migrations.
 * @param {string} target
 * @param {string} fromVersion
 * @param {string} toVersion
 * @param {string[]} steps - Ordered list of step names
 * @returns {object} The checkpoint object
 */
export function writeCheckpoint(target, fromVersion, toVersion, steps) {
  const cpDir = join(target, STATE_DIR)
  if (!existsSync(cpDir)) mkdirSync(cpDir, { recursive: true })
  const cpFile = join(cpDir, CHECKPOINT_FILE)
  const checkpoint = {
    from: fromVersion,
    to: toVersion,
    started_at: new Date().toISOString(),
    steps_completed: [],
    steps_pending: [...steps],
  }
  writeFileSync(cpFile, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8')
  return checkpoint
}

/**
 * Advance the checkpoint: mark a step as completed and remove from pending.
 * @param {string} target
 * @param {string} stepName
 * @returns {object|null} Updated checkpoint, or null if none exists
 */
export function advanceCheckpoint(target, stepName) {
  const cp = readCheckpoint(target)
  if (!cp) return null
  cp.steps_completed.push(stepName)
  cp.steps_pending = cp.steps_pending.filter((s) => s !== stepName)
  const cpFile = join(target, STATE_DIR, CHECKPOINT_FILE)
  writeFileSync(cpFile, `${JSON.stringify(cp, null, 2)}\n`, 'utf8')
  return cp
}

/**
 * Remove the checkpoint file on successful completion.
 * @param {string} target
 */
export function removeCheckpoint(target) {
  const cpFile = join(target, STATE_DIR, CHECKPOINT_FILE)
  if (existsSync(cpFile)) {
    rmSync(cpFile, { force: true })
  }
}

/**
 * Resume from a pending checkpoint.
 * Reads the checkpoint and reports what steps remain.
 * @param {string} target
 * @returns {object|null} The checkpoint, or null if none pending
 */
export function resumePendingMigration(target) {
  const cp = readCheckpoint(target)
  if (!cp) return null
  console.log(`  \u{1F504} Resuming migration from checkpoint: ${cp.from} \u2192 ${cp.to}`)
  console.log(`     Completed: ${cp.steps_completed.join(', ') || 'none'}`)
  console.log(`     Pending: ${cp.steps_pending.join(', ') || 'none'}`)
  return cp
}

// ---------------------------------------------------------------------------
// Rollback support
// ---------------------------------------------------------------------------

/**
 * Roll back the last completed migration for a given version.
 * Each migration step should define a corresponding down-migration.
 * This is a stub — actual down-migration logic should be registered
 * in a DOWN_MIGRATIONS registry.
 *
 * @param {string} target
 * @param {string} version - The version to roll back from
 * @returns {{ success: boolean, reason?: string, migration?: object }}
 */
export function rollbackMigration(target, version) {
  const state = readState(target)
  if (!state) {
    console.log('  \u26A0\uFE0F  No install state found — nothing to roll back')
    return { success: false, reason: 'No install state' }
  }

  const migrations = state.applied_migrations || []
  const targetMigration = migrations.find((m) => m.to === version && m.status === 'completed')
  if (!targetMigration) {
    console.log(`  \u26A0\uFE0F  No completed migration found for version ${version}`)
    return { success: false, reason: 'Migration not found' }
  }

  console.log(
    `  \u{1F504} Rolling back migration: ${targetMigration.from} \u2192 ${targetMigration.to}`,
  )

  targetMigration.status = 'rolled_back'
  state.pantheon_version = targetMigration.from
  writeState(target, state)

  console.log(`  \u2705 Rolled back to ${targetMigration.from}`)
  return { success: true, migration: targetMigration }
}

/**
 * List all applied migrations from the install state.
 * @param {string} target
 * @returns {{ currentVersion: string|null, previousVersion: string|null, migrations: object[] }}
 */
export function listAppliedMigrations(target) {
  const state = readState(target)
  if (!state) {
    return { currentVersion: null, previousVersion: null, migrations: [] }
  }
  return {
    currentVersion: state.pantheon_version,
    previousVersion: state.previous_version,
    migrations: state.applied_migrations || [],
  }
}

// ---------------------------------------------------------------------------
// Minimal semver helpers (no external deps)
// ---------------------------------------------------------------------------

/**
 * Parse "x.y.z" → [major, minor, patch] or null.
 * @param {string|null} v
 * @returns {number[]|null}
 */
function parseSemver(v) {
  if (!v || typeof v !== 'string') return null
  const parts = v.split('.').map(Number)
  if (parts.length < 2 || parts.some(Number.isNaN)) return null
  return [parts[0], parts[1], parts[2] ?? 0]
}

/**
 * Format [major, minor, patch] → "x.y.z".
 * @param {number[]} v
 * @returns {string}
 */
function formatSemver(v) {
  return `${v[0]}.${v[1]}.${v[2]}`
}

/**
 * Compare two semver arrays: is a < b?
 * @param {number[]} a
 * @param {number[]} b
 * @returns {boolean}
 */
function lt(a, b) {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) {
      return (a[i] ?? 0) < (b[i] ?? 0)
    }
  }
  return false
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2)
  const targetIdx = args.indexOf('--target')
  const target = targetIdx !== -1 ? args[targetIdx + 1] : process.cwd()
  const dryRun = args.includes('--dry-run')
  const force = args.includes('--force')
  const list = args.includes('--list')

  if (list) {
    const history = listAppliedMigrations(target)
    if (!history.currentVersion) {
      console.log('  \u2139\uFE0F  No install state found in: ' + target)
      return
    }
    console.log(`  Current version: ${history.currentVersion}`)
    console.log(`  Previous version: ${history.previousVersion || 'N/A'}`)
    console.log(`  Applied migrations: ${history.migrations.length}`)
    for (const m of history.migrations) {
      const icon =
        m.status === 'completed'
          ? '\u2705'
          : m.status === 'rolled_back'
            ? '\u{1F504}'
            : '\u26A0\uFE0F'
      console.log(`    ${icon} ${m.from} \u2192 ${m.to} [${m.status}] (${m.applied_at})`)
    }
    return
  }

  const rollbackTo = args.find((a) => a.startsWith('--rollback='))?.split('=', 2)[1]
  if (rollbackTo) {
    rollbackMigration(target, rollbackTo)
    return
  }

  const currentVersion = detectVersion(target)
  if (!currentVersion) {
    if (!dryRun) {
      const state = createInitialState(PANTHON_VERSION)
      writeState(target, state)
      console.log(`  \u2705 Fresh install — state written (${PANTHON_VERSION})`)
    } else {
      console.log(`  \u2705 Fresh install — would write state (${PANTHON_VERSION})`)
    }
    return
  }

  console.log(`  Current version: ${currentVersion}`)

  if (!force && currentVersion === PANTHON_VERSION) {
    console.log('  \u23ED\uFE0F  Already at latest version — no migrations needed')
    return
  }

  const migration = runMigrations(target, currentVersion, { dryRun })

  if (migration.applied > 0) {
    console.log(`  \u2705 Applied ${migration.applied} migration(s):`)
    for (const msg of migration.messages) {
      console.log(`     \u2022 ${msg}`)
    }
  } else {
    console.log('  \u23ED\uFE0F  No applicable migrations')
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
}
