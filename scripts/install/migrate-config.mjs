#!/usr/bin/env node
/**
 * migrate-config.mjs — Standalone migration CLI with checkpoint crash recovery
 *
 * Runs configuration migrations with an atomic checkpoint system.
 * If the process crashes mid-migration, the checkpoint file persists
 * so that --resume picks up where it left off.
 *
 * Usage:
 *   node scripts/install/migrate-config.mjs --from=1.1.0 --to=1.1.1 --target=~/.config/opencode
 *   node scripts/install/migrate-config.mjs --resume --target=~/.config/opencode
 *   node scripts/install/migrate-config.mjs --list --target=~/.config/opencode
 *   node scripts/install/migrate-config.mjs --dry-run --from=1.1.0 --to=1.1.1
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  advanceCheckpoint,
  listAppliedMigrations,
  readCheckpoint,
  removeCheckpoint,
  resumePendingMigration,
  writeCheckpoint,
} from './migrate.mjs'
import {
  addMigrationRecord,
  createInitialState,
  readState,
  updateVersion,
  writeState,
} from './state.mjs'

// ---------------------------------------------------------------------------
// Migration step definitions
// Each step is an idempotent function(target, state, { dryRun }) => void
// ---------------------------------------------------------------------------

const MIGRATION_STEPS = {
  /**
   * migrate_state_v2: Upgrade install-state.json from schema v1 to v2.
   * Adds schema_version field, components tracking, and migration history.
   */
  migrate_state_v2: (target, state, { dryRun }) => {
    if (state.schema_version && state.schema_version >= 2) {
      return
    }
    if (!dryRun) {
      state.schema_version = 2
      state.components = state.components || {
        agents: { version: 1, status: 'pending' },
        skills: { version: 1, status: 'pending' },
        plugins: { version: 1, status: 'pending' },
        runtime: { version: 1, status: 'pending' },
      }
      state.applied_migrations = state.applied_migrations || []
      state.migration_checkpoint = null
    }
  },

  /**
   * update_schema: Ensure all v2 schema fields exist with defaults.
   */
  update_schema: (target, state, { dryRun }) => {
    if (!dryRun) {
      if (!state.components) {
        state.components = {
          agents: { version: 1, status: 'pending' },
          skills: { version: 1, status: 'pending' },
          plugins: { version: 1, status: 'pending' },
          runtime: { version: 1, status: 'pending' },
        }
      }
      for (const key of ['agents', 'skills', 'plugins', 'runtime']) {
        if (!state.components[key]) {
          state.components[key] = { version: 1, status: 'pending' }
        }
      }
      state.applied_migrations = state.applied_migrations || []
      if (state.migration_checkpoint === undefined) {
        state.migration_checkpoint = null
      }
    }
  },

  /**
   * migrate_plugins: Normalize plugin component tracking.
   */
  migrate_plugins: (target, state, { dryRun }) => {
    if (!dryRun) {
      if (!state.components) state.components = {}
      const p = state.components.plugins || { version: 1, status: 'pending' }
      p.version = Math.max(p.version || 0, 1)
      state.components.plugins = p
    }
  },
}

// ---------------------------------------------------------------------------
// Migration step ordering (a step runs ONLY after all predecessors complete)
// ---------------------------------------------------------------------------

const STEP_ORDER = Object.keys(MIGRATION_STEPS)

/**
 * Resolve which steps to run based on from/to version comparison.
 * For now, runs all steps. In the future this can be gated by version.
 * @param {string} fromVersion
 * @param {string} toVersion
 * @returns {string[]} Ordered list of step names
 */
function resolveSteps(fromVersion, toVersion) {
  return [...STEP_ORDER]
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2)
  const result = {
    from: null,
    to: null,
    target: process.cwd(),
    dryRun: false,
    resume: false,
    list: false,
    help: false,
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--dry-run') result.dryRun = true
    else if (arg === '--resume') result.resume = true
    else if (arg === '--list') result.list = true
    else if (arg === '--help' || arg === '-h') result.help = true
    else if (arg.startsWith('--from=')) result.from = arg.split('=', 2)[1]
    else if (arg.startsWith('--to=')) result.to = arg.split('=', 2)[1]
    else if (arg.startsWith('--target=')) result.target = arg.split('=', 2)[1]
    else if (arg === '--from') result.from = args[++i]
    else if (arg === '--to') result.to = args[++i]
    else if (arg === '--target') result.target = args[++i]
  }

  return result
}

function showHelp() {
  console.log(`
migrate-config.mjs — Pantheon configuration migration CLI

Usage:
  node scripts/install/migrate-config.mjs --from=1.1.0 --to=1.1.1 --target=~/.config/opencode
  node scripts/install/migrate-config.mjs --resume --target=~/.config/opencode
  node scripts/install/migrate-config.mjs --list --target=~/.config/opencode
  node scripts/install/migrate-config.mjs --dry-run --from=1.1.0 --to=1.1.1
  node scripts/install/migrate-config.mjs --help

Options:
  --from=<version>  Source version (required for new migrations)
  --to=<version>    Target version (required for new migrations)
  --target=<path>   Installation directory (default: cwd)
  --dry-run         Preview without writing
  --resume          Resume from pending checkpoint (crash recovery)
  --list            Show applied migration history
  --help            Show this help

Crash Recovery:
  If the process is interrupted mid-migration, a checkpoint file is left
  at .pantheon/.migration-checkpoint. Run with --resume to continue.
`)
}

function main() {
  const config = parseArgs()

  if (config.help) {
    showHelp()
    return
  }

  // ── List mode ──
  if (config.list) {
    const history = listAppliedMigrations(config.target)
    if (!history.currentVersion) {
      console.log('  \u2139\uFE0F  No install state found in: ' + config.target)
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

  // ── Resume mode ──
  if (config.resume) {
    const cp = resumePendingMigration(config.target)
    if (!cp) {
      console.log('  \u23ED\uFE0F  No pending checkpoint found — nothing to resume')
      return
    }
    config.from = cp.from
    config.to = cp.to
  } else {
    if (!config.from || !config.to) {
      console.error('\u274C --from and --to are required (or use --resume)')
      showHelp()
      process.exit(1)
    }
  }

  // ── Read state ──
  let state = readState(config.target)
  if (!state) {
    state = createInitialState(config.from)
    console.log(`  \u{1F4DD} Creating new install state (v${state.schema_version})`)
    if (!config.dryRun) writeState(config.target, state)
  } else {
    console.log(
      `  \u{1F4CB} Current state: v${state.schema_version}, version ${state.pantheon_version}`,
    )
  }

  // ── Resolve checkpoint ──
  let cp = readCheckpoint(config.target)

  if (!cp) {
    const steps = resolveSteps(config.from, config.to)
    cp = writeCheckpoint(config.target, config.from, config.to, steps)
    console.log(`  \u{1F4DD} Checkpoint written: ${config.from} \u2192 ${config.to}`)
  } else {
    console.log(
      `  \u{1F504} Resuming from checkpoint (${cp.steps_completed.length} steps done, ${cp.steps_pending.length} remaining)`,
    )
  }

  // ── Run pending steps ──
  const stepsToRun = [...cp.steps_pending]
  let failed = false

  for (const step of stepsToRun) {
    const stepFn = MIGRATION_STEPS[step]
    if (!stepFn) {
      console.warn(`  \u26A0\uFE0F  Unknown migration step: ${step} — skipping`)
      if (!config.dryRun) {
        advanceCheckpoint(config.target, step)
      }
      continue
    }

    console.log(`  \u25B6\uFE0F  Running: ${step}`)
    try {
      stepFn(config.target, state, { dryRun: config.dryRun })

      if (!config.dryRun) {
        advanceCheckpoint(config.target, step)
        writeState(config.target, state)
        console.log(`  \u2705 ${step} completed`)
      } else {
        console.log(`  \u2705 ${step} would complete (dry-run)`)
      }
    } catch (err) {
      console.error(`  \u274C ${step} failed: ${err.message}`)
      failed = true
      break
    }
  }

  // ── Finalize ──
  if (failed) {
    console.error(`\n  \u274C Migration failed at checkpoint.`)
    console.error(
      `     Resume with: node scripts/install/migrate-config.mjs --resume --target=${config.target}`,
    )
    process.exit(1)
  }

  if (!config.dryRun) {
    updateVersion(state, config.to)
    addMigrationRecord(state, config.from, config.to, 'completed')
    removeCheckpoint(config.target)
    writeState(config.target, state)
    console.log(`\n  \u2705 Migration complete: ${config.from} \u2192 ${config.to}`)
    console.log(`     State written to: ${join(config.target, '.pantheon', 'install-state.json')}`)
  } else {
    console.log(`\n  \u2705 Migration would complete (dry-run): ${config.from} \u2192 ${config.to}`)
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main()
}
