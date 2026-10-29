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
import { ACTIONS, fingerprintOutput, recordChange } from './plan.mjs'
import { createInitialState, MIGRATION_SCHEMA_VERSION, readState, writeState } from './state.mjs'

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
 * @param {{ dryRun?: boolean, recorder?: (change: object) => void }} [options]
 * @returns {{ applied: number, messages: string[], plannedState: object|null, status?: 'invalid'|'unsupported', marker?: unknown, message?: string }}
 */
export function runMigrations(target, options = {}, legacyOptions = {}) {
  // Preserve the old `(target, version, options)` call shape for downstream
  // callers while making the persisted migration marker authoritative.
  const explicitVersion = typeof options === 'string' ? options : null
  const {
    dryRun = false,
    recorder = null,
    updatedAt = new Date().toISOString(),
  } = typeof options === 'object' && options !== null ? options : legacyOptions
  const state = readState(target)
  if (!state) return { applied: 0, messages: [], plannedState: null }

  const schemaMarker = state.migration_schema_version
  if (schemaMarker !== null && schemaMarker !== undefined) {
    const parsedMarker = parseSemver(schemaMarker)
    if (!parsedMarker) return blockedMigration('invalid', schemaMarker)
    if (compareSemver(parsedMarker, parseSemver(MIGRATION_SCHEMA_VERSION)) > 0) {
      return blockedMigration('unsupported', schemaMarker)
    }
  }

  const currentVersion =
    state.migration_schema_version ?? explicitVersion ?? state.pantheon_version ?? null
  const applied = []
  let cursor = parseSemver(currentVersion)

  // ── Migration: v3.10.0 → v3.18.0 ──────────────────────────────────
  // Fix dangling references, add Memory Protocol
  if (cursor && compareSemver(cursor, parseSemver('3.18.0')) < 0) {
    applied.push({
      from: formatSemver(cursor),
      to: '3.18.0',
      description: 'Fix dangling references, add Memory Protocol',
    })
    cursor = parseSemver('3.18.0')
  }

  // ── Migration: v3.18.0 → v3.19.0 ──────────────────────────────────
  // Add runtime component, _pantheon_paths
  if (cursor && compareSemver(cursor, parseSemver('3.19.0')) < 0) {
    applied.push({
      from: formatSemver(cursor),
      to: '3.19.0',
      description: 'Add runtime component, _pantheon_paths',
    })
    cursor = parseSemver('3.19.0')
  }

  // ── Migration: v3.19.0 → v3.19.1 ──────────────────────────────────
  // Add persistence MCP, fix 157 dangling refs
  if (cursor && compareSemver(cursor, parseSemver('3.19.1')) < 0) {
    applied.push({
      from: formatSemver(cursor),
      to: '3.19.1',
      description: 'Add persistence MCP, fix dangling refs',
    })
    cursor = parseSemver('3.19.1')
  }

  // ── Migration: v3.19.1 → v3.19.2 ──────────────────────────────────
  // Upgrade state schema from v1 to v2
  if (cursor && compareSemver(cursor, parseSemver(MIGRATION_SCHEMA_VERSION)) < 0) {
    applied.push({
      from: formatSemver(cursor),
      to: MIGRATION_SCHEMA_VERSION,
      description: 'Upgrade install state schema to v2 with component tracking',
    })
    cursor = parseSemver(MIGRATION_SCHEMA_VERSION)
  }

  // ── Write updated state ───────────────────────────────────────────
  const markerChanged = state.migration_schema_version !== MIGRATION_SCHEMA_VERSION
  if (applied.length > 0 || markerChanged) {
    const statePath = join(target, '.pantheon', 'install-state.json')
    const stateExisted = true
    state.applied_migrations ??= []
    for (const m of applied) {
      state.applied_migrations.push({
        from: m.from,
        to: m.to,
        applied_at: updatedAt,
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
    state.migration_schema_version = MIGRATION_SCHEMA_VERSION
    state.updated_at = updatedAt
    state.schema_version = 2
    const stateContent = `${JSON.stringify(state, null, 2)}\n`
    if (!dryRun) writeState(target, state, { updatedAt })
    recordChange(
      {
        path: statePath,
        action: stateExisted ? ACTIONS.UPDATE : ACTIONS.CREATE,
        bytes: Buffer.byteLength(stateContent, 'utf8'),
        outputFingerprint: fingerprintOutput(stateContent),
        scored: false,
      },
      recorder,
    )
    return {
      applied: applied.length,
      messages: applied.map((m) => `${m.from} → ${m.to}: ${m.description}`),
      plannedState: state,
    }
  }

  return {
    applied: 0,
    messages: applied.map((m) => `${m.from} → ${m.to}: ${m.description}`),
    plannedState: null,
  }
}

function blockedMigration(status, marker) {
  const message =
    status === 'unsupported'
      ? `Migration schema ${marker} is newer than supported ${MIGRATION_SCHEMA_VERSION}; refusing to downgrade or modify the installation.`
      : 'Invalid migration schema marker; refusing to modify the installation.'
  return { applied: 0, messages: [], plannedState: null, status, marker, message }
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
    console.log('  [WARN] No install state found — nothing to roll back')
    return { success: false, reason: 'No install state' }
  }

  const migrations = state.applied_migrations || []
  const targetMigration = migrations.find((m) => m.to === version && m.status === 'completed')
  if (!targetMigration) {
    console.log(`  [WARN] No completed migration found for version ${version}`)
    return { success: false, reason: 'Migration not found' }
  }

  console.log(`  Rolling back migration: ${targetMigration.from} -> ${targetMigration.to}`)

  targetMigration.status = 'rolled_back'
  state.migration_schema_version = targetMigration.from
  writeState(target, state)

  console.log(`  [OK] Rolled back to ${targetMigration.from}`)
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

/** Parse strict SemVer precedence, accepting an optional `v` and build metadata. */
export function parseSemver(value) {
  if (typeof value !== 'string') return null
  const match = value.match(
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
  )
  if (!match) return null
  const prerelease = match[4]
    ? match[4].split('.').map((identifier) => {
        if (!/^\d+$/.test(identifier)) return identifier
        if (identifier.length > 1 && identifier.startsWith('0')) return null
        return Number(identifier)
      })
    : []
  if (prerelease.includes(null)) return null

  const parsed = {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  }
  Object.defineProperty(parsed, 'compare', {
    enumerable: false,
    value: (other) => compareSemver(parsed, other),
  })
  return parsed
}

function compareSemver(left, right) {
  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1
  }
  const a = left.prerelease
  const b = right.prerelease
  if (a.length === 0 || b.length === 0) {
    if (a.length === b.length) return 0
    return a.length === 0 ? 1 : -1
  }
  const length = Math.min(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    if (a[index] === b[index]) continue
    if (typeof a[index] === 'number' && typeof b[index] === 'number') {
      return a[index] < b[index] ? -1 : 1
    }
    if (typeof a[index] === 'number') return -1
    if (typeof b[index] === 'number') return 1
    return a[index] < b[index] ? -1 : 1
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

function formatSemver(value) {
  const core = `${value.major}.${value.minor}.${value.patch}`
  return value.prerelease.length === 0 ? core : `${core}-${value.prerelease.join('.')}`
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
async function main() {
  const { configure: configureUi, tag } = await import('./cli-ui.mjs')
  const args = process.argv.slice(2)
  const targetIdx = args.indexOf('--target')
  const target = targetIdx !== -1 ? args[targetIdx + 1] : process.cwd()
  const dryRun = args.includes('--dry-run')
  const force = args.includes('--force')
  const list = args.includes('--list')
  // One dry-run marker for the whole CLI: cli-ui's tag(). This file used to
  // hardcode its own `[DRY-RUN]` prefix while other CLIs printed `[dry-run]`.
  configureUi({ dryRun })

  if (list) {
    const history = listAppliedMigrations(target)
    if (!history.currentVersion) {
      console.log(`  [INFO] No install state found in: ${target}`)
      return
    }
    console.log(`  Current version: ${history.currentVersion}`)
    console.log(`  Previous version: ${history.previousVersion || 'N/A'}`)
    console.log(`  Applied migrations: ${history.migrations.length}`)
    for (const m of history.migrations) {
      const status =
        m.status === 'completed' ? '[OK]' : m.status === 'rolled_back' ? '[ROLLED BACK]' : '[WARN]'
      console.log(`    ${status} ${m.from} -> ${m.to} [${m.status}] (${m.applied_at})`)
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
      console.log(`  [OK] Fresh install — state written (${PANTHON_VERSION})`)
    } else {
      console.log(`  ${tag(`Fresh install — would write state (${PANTHON_VERSION})`)}`)
    }
    return
  }

  console.log(`  Current version: ${currentVersion}`)

  const state = readState(target)
  if (
    !force &&
    currentVersion === PANTHON_VERSION &&
    state?.migration_schema_version === MIGRATION_SCHEMA_VERSION
  ) {
    console.log('  [OK] Already at latest version — no migrations needed')
    return
  }

  const migration = runMigrations(target, { dryRun })

  if (migration.status === 'unsupported' || migration.status === 'invalid') {
    throw new Error(migration.message)
  }

  if (migration.applied > 0) {
    console.log(`  [OK] Applied ${migration.applied} migration(s):`)
    for (const msg of migration.messages) {
      console.log(`     \u2022 ${msg}`)
    }
  } else {
    console.log('  [INFO] No applicable migrations')
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`  [ERROR] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
