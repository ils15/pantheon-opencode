#!/usr/bin/env node
/**
 * state.mjs — State manifest for Pantheon installations (schema v2)
 *
 * Manages the install-state.json manifest with version tracking,
 * component state, and applied migration history.
 *
 * Schema v2:
 *   {
 *     "schema_version": 2,
 *     "pantheon_version": "1.1.1",
 *     "previous_version": "1.1.0",
 *     "updated_at": "2026-07-26T10:30:00Z",
 *     "migration_checkpoint": null,
 *     "applied_migrations": [
 *       { "from": "1.1.0", "to": "1.1.1", "applied_at": "2026-07-26T10:30:00Z", "status": "completed" }
 *     ],
 *     "components": {
 *       "agents": { "version": 1, "status": "installed" },
 *       "skills": { "version": 1, "status": "installed" },
 *       "plugins": { "version": 1, "status": "installed" },
 *       "runtime": { "version": 1, "status": "installed" }
 *     }
 *   }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const STATE_FILE = 'install-state.json'
const STATE_DIR = '.pantheon'

/**
 * Create a fresh v2 state object for a new install.
 * @param {string} version - Pantheon version string
 * @returns {object} v2 state
 */
export function createInitialState(version) {
  return {
    schema_version: 2,
    pantheon_version: version || '0.0.0',
    previous_version: null,
    updated_at: new Date().toISOString(),
    migration_checkpoint: null,
    applied_migrations: [],
    components: {
      agents: { version: 1, status: 'pending' },
      skills: { version: 1, status: 'pending' },
      plugins: { version: 1, status: 'pending' },
      runtime: { version: 1, status: 'pending' },
    },
  }
}

/**
 * Read install-state.json from a target directory.
 * Backward-compatible with v1 schema (auto-upgrades on read).
 * @param {string} target - Installation directory
 * @returns {object|null} v2 state object, or null if not found
 */
export function readState(target) {
  const stateFile = join(target, STATE_DIR, STATE_FILE)
  if (!existsSync(stateFile)) return null
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf8'))
    return normalizeState(raw)
  } catch {
    return null
  }
}

/**
 * Detect whether the raw state is v1 format (pre-schema_version).
 * v1 state has pantheon_version (or version) but no schema_version.
 * @param {object} state
 * @returns {boolean}
 */
export function isV1State(state) {
  if (!state || typeof state !== 'object') return false
  return !state.schema_version && (!!state.pantheon_version || !!state.version)
}

/**
 * Upgrade a v1 state to v2 schema.
 * Preserves all existing fields, adds defaults for new ones.
 * @param {object} state - v1 state object
 * @returns {object} v2 state object
 */
export function upgradeStateV1toV2(state) {
  const now = new Date().toISOString()
  return {
    schema_version: 2,
    pantheon_version: state.pantheon_version || state.version || 'unknown',
    previous_version: state.previous_version || null,
    updated_at: state.updated_at || now,
    migration_checkpoint: null,
    applied_migrations: Array.isArray(state.applied_migrations) ? state.applied_migrations : [],
    components: state.components && typeof state.components === 'object' ? state.components : {
      agents: { version: 1, status: 'installed' },
      skills: { version: 1, status: 'installed' },
      plugins: { version: 1, status: 'unknown' },
      runtime: { version: 1, status: 'unknown' },
    },
  }
}

/**
 * Normalize any state to v2 (handles v1 → v2 upgrade).
 * @param {object} state
 * @returns {object|null}
 */
function normalizeState(state) {
  if (!state || typeof state !== 'object') return null
  if (isV1State(state)) return upgradeStateV1toV2(state)
  if (!state.schema_version || state.schema_version < 2) return upgradeStateV1toV2(state)
  return state
}

/**
 * Write state to target's install-state.json (always v2 format).
 * @param {string} target - Installation directory
 * @param {object} state - v2 state object
 */
export function writeState(target, state) {
  const stateDir = join(target, STATE_DIR)
  if (!existsSync(stateDir)) {
    mkdirSync(stateDir, { recursive: true })
  }
  const stateFile = join(stateDir, STATE_FILE)
  state.updated_at = new Date().toISOString()
  state.schema_version = 2
  writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/**
 * Check whether install-state.json exists in target.
 * @param {string} target
 * @returns {boolean}
 */
export function hasState(target) {
  return existsSync(join(target, STATE_DIR, STATE_FILE))
}

/**
 * Add a migration record to the applied_migrations array.
 * @param {object} state
 * @param {string} fromVersion
 * @param {string} toVersion
 * @param {string} [status='completed']
 */
export function addMigrationRecord(state, fromVersion, toVersion, status = 'completed') {
  if (!Array.isArray(state.applied_migrations)) {
    state.applied_migrations = []
  }
  state.applied_migrations.push({
    from: fromVersion,
    to: toVersion,
    applied_at: new Date().toISOString(),
    status,
  })
}

/**
 * Update the pantheon_version and previous_version.
 * @param {object} state
 * @param {string} newVersion
 */
export function updateVersion(state, newVersion) {
  state.previous_version = state.pantheon_version || null
  state.pantheon_version = newVersion
}

/**
 * Get a component's state object.
 * @param {object} state
 * @param {string} component - Component name (agents, skills, plugins, runtime)
 * @returns {{ version: number, status: string }|null}
 */
export function getComponentState(state, component) {
  if (!state.components) return null
  return state.components[component] || null
}

/**
 * Set a component's version and status.
 * @param {object} state
 * @param {string} component
 * @param {number} version
 * @param {string} status
 */
export function setComponentState(state, component, version, status) {
  if (!state.components) state.components = {}
  state.components[component] = { version, status }
}
