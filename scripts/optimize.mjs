#!/usr/bin/env node
/**
 * optimize.mjs — Pantheon project and deepwork optimizer CLI
 *
 * Scans, cleans, and archives Pantheon workspace artifacts:
 * - Archives or cleans resolved/completed deepwork sessions in .pantheon/deepwork/
 * - Prunes stale backups in .pantheon/backups/ older than threshold
 * - Cleans old debug logs in .pantheon/logs/
 *
 * Usage:
 *   pantheon-opencode optimize              # dry-run preview (default)
 *   pantheon-opencode optimize --apply      # archive completed deepwork + clean logs
 *   pantheon-opencode optimize --clean      # permanently delete completed deepwork
 *   pantheon-opencode optimize --age <days> # custom age threshold (default: 7)
 *   pantheon-opencode optimize --target <d> # target workspace root
 */

import { execSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_DEEPWORK_AGE_DAYS = 7
const DEFAULT_BACKUP_AGE_DAYS = 14
const MS_PER_DAY = 86_400_000

export function scanDeepwork(targetDir, ageDays = DEFAULT_DEEPWORK_AGE_DAYS) {
  const deepworkDir = join(targetDir, '.pantheon', 'deepwork')
  if (!existsSync(deepworkDir)) return []

  const now = Date.now()
  const cutoff = now - ageDays * MS_PER_DAY
  const results = []

  let entries = []
  try {
    entries = readdirSync(deepworkDir, { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'archive') continue
    const slugDir = join(deepworkDir, entry.name)

    // Never clean up directories containing tracked git files
    try {
      const gitTracked = execSync(`git ls-files "${slugDir}"`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim()
      if (gitTracked.length > 0) continue
    } catch {}

    let isCompleted = false
    let reason = 'in-progress'
    const reviewPath = join(slugDir, 'REVIEW.md')
    const statusPath = join(slugDir, 'STATUS.md')

    if (existsSync(reviewPath)) {
      try {
        const reviewText = readFileSync(reviewPath, 'utf8')
        if (/APPROVED|PASS|COMPLETE/i.test(reviewText)) {
          isCompleted = true
          reason = 'reviewed and approved'
        }
      } catch {}
    }

    if (!isCompleted && existsSync(statusPath)) {
      try {
        const statusText = readFileSync(statusPath, 'utf8')
        if (/status:\s*(?:complete|finished|done)/i.test(statusText)) {
          isCompleted = true
          reason = 'status marked complete'
        }
      } catch {}
    }

    // Check directory modification age
    let mtime = 0
    try {
      mtime = statSync(slugDir).mtimeMs
    } catch {}

    if (!isCompleted && mtime > 0 && mtime < cutoff) {
      isCompleted = true
      reason = `inactive for >${ageDays} days`
    }

    results.push({
      slug: entry.name,
      path: slugDir,
      completed: isCompleted,
      reason,
      mtime,
    })
  }

  return results
}

export function scanBackups(targetDir, ageDays = DEFAULT_BACKUP_AGE_DAYS) {
  const backupsDir = join(targetDir, '.pantheon', 'backups')
  if (!existsSync(backupsDir)) return []

  const now = Date.now()
  const cutoff = now - ageDays * MS_PER_DAY
  const results = []

  let entries = []
  try {
    entries = readdirSync(backupsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const dirs = entries
    .filter((e) => e.isDirectory())
    .map((e) => {
      const p = join(backupsDir, e.name)
      let mtime = 0
      try {
        mtime = statSync(p).mtimeMs
      } catch {}
      return { name: e.name, path: p, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime) // newest first

  // Keep at least the latest 3 backups regardless of age
  for (let i = 3; i < dirs.length; i++) {
    const item = dirs[i]
    if (item.mtime > 0 && item.mtime < cutoff) {
      results.push(item)
    }
  }

  return results
}

export function scanLogs(targetDir, ageDays = 7) {
  const logsDir = join(targetDir, '.pantheon', 'logs')
  if (!existsSync(logsDir)) return []

  const now = Date.now()
  const cutoff = now - ageDays * MS_PER_DAY
  const results = []

  let entries = []
  try {
    entries = readdirSync(logsDir, { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue
    const p = join(logsDir, entry.name)
    let mtime = 0
    try {
      mtime = statSync(p).mtimeMs
    } catch {}
    if (mtime > 0 && mtime < cutoff) {
      results.push({ name: entry.name, path: p, mtime })
    }
  }

  return results
}

export function runOptimize(options = {}) {
  const targetDir = resolve(options.target || process.cwd())
  const apply = Boolean(options.apply || options.yes)
  const clean = Boolean(options.clean)
  const ageDays = options.age ? Number(options.age) : DEFAULT_DEEPWORK_AGE_DAYS

  console.log('Pantheon Optimizer — Workspace Inspection')
  console.log(`Target: ${targetDir}`)
  console.log(
    `Mode: ${apply ? (clean ? 'apply (clean/delete)' : 'apply (archive)') : 'dry-run (preview only)'}`,
  )
  console.log('────────────────────────────────────────────────────────────')

  const deepworks = scanDeepwork(targetDir, ageDays)
  const completedDeepworks = deepworks.filter((d) => d.completed)
  const activeDeepworks = deepworks.filter((d) => !d.completed)
  const staleBackups = scanBackups(targetDir)
  const staleLogs = scanLogs(targetDir)

  console.log(`Deepwork sessions: ${deepworks.length} total`)
  if (completedDeepworks.length > 0) {
    console.log(`  Resolvable candidates (${completedDeepworks.length}):`)
    for (const d of completedDeepworks) {
      console.log(`    - ${d.slug} (${d.reason})`)
    }
  }
  if (activeDeepworks.length > 0) {
    console.log(`  Active sessions kept (${activeDeepworks.length}):`)
    for (const d of activeDeepworks) {
      console.log(`    - ${d.slug} (in-progress)`)
    }
  }

  console.log(`Stale backups: ${staleBackups.length} candidates (>14 days, keeping 3 latest)`)
  console.log(`Stale logs: ${staleLogs.length} candidates (>7 days)`)

  if (!apply) {
    console.log('────────────────────────────────────────────────────────────')
    console.log('[DRY-RUN] No changes made.')
    console.log('To archive resolved deepworks: pantheon-opencode optimize --apply')
    console.log(
      'To permanently delete resolved deepworks: pantheon-opencode optimize --clean --apply',
    )
    return { ok: true, changed: false }
  }

  console.log('────────────────────────────────────────────────────────────')
  console.log('Applying optimization plan...')

  // 1. Deepwork
  if (completedDeepworks.length > 0) {
    if (clean) {
      for (const d of completedDeepworks) {
        try {
          rmSync(d.path, { recursive: true, force: true })
          console.log(`  [CLEAN] Removed ${d.slug}`)
        } catch (e) {
          console.error(`  [ERROR] Failed to remove ${d.slug}: ${e.message}`)
        }
      }
    } else {
      const archiveDir = join(targetDir, '.pantheon', 'deepwork', 'archive')
      mkdirSync(archiveDir, { recursive: true })
      for (const d of completedDeepworks) {
        try {
          const dest = join(archiveDir, d.slug)
          if (existsSync(dest)) {
            rmSync(dest, { recursive: true, force: true })
          }
          renameSync(d.path, dest)
          console.log(`  [ARCHIVE] Moved ${d.slug} -> archive/${d.slug}`)
        } catch (e) {
          console.error(`  [ERROR] Failed to archive ${d.slug}: ${e.message}`)
        }
      }
    }
  }

  // 2. Backups
  for (const b of staleBackups) {
    try {
      rmSync(b.path, { recursive: true, force: true })
      console.log(`  [CLEAN] Removed stale backup ${b.name}`)
    } catch (e) {
      console.error(`  [ERROR] Failed to remove backup ${b.name}: ${e.message}`)
    }
  }

  // 3. Logs
  for (const l of staleLogs) {
    try {
      rmSync(l.path, { force: true })
      console.log(`  [CLEAN] Removed stale log ${l.name}`)
    } catch (e) {
      console.error(`  [ERROR] Failed to remove log ${l.name}: ${e.message}`)
    }
  }

  console.log('────────────────────────────────────────────────────────────')
  console.log('[OK] Workspace optimization complete.')
  return { ok: true, changed: true }
}

function printUsage() {
  console.log('Usage: pantheon-opencode optimize [options]')
  console.log('')
  console.log('Options:')
  console.log('  --apply, --yes     Apply the changes (default: dry-run)')
  console.log('  --clean            Delete completed deepwork instead of archiving')
  console.log('  --age <days>       Inactivity threshold in days (default: 7)')
  console.log('  --target <dir>     Target workspace directory (default: cwd)')
  console.log('  --help             Show this help message')
}

// CLI entry point when run directly
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    printUsage()
    process.exit(0)
  }

  const options = {
    apply: args.includes('--apply') || args.includes('--yes') || args.includes('-y'),
    clean: args.includes('--clean'),
  }

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--age' && args[i + 1]) {
      options.age = Number(args[i + 1])
      i++
    } else if (args[i].startsWith('--age=')) {
      options.age = Number(args[i].split('=')[1])
    } else if (args[i] === '--target' && args[i + 1]) {
      options.target = args[i + 1]
      i++
    } else if (args[i].startsWith('--target=')) {
      options.target = args[i].split('=')[1]
    }
  }

  const result = runOptimize(options)
  process.exit(result.ok ? 0 : 1)
}
