#!/usr/bin/env node
/**
 * restore.mjs — Pantheon exact-restore CLI (Beta 11 Setup, phase 2).
 *
 * Restores a backup set created by the installer back into the config dir,
 * reproducing each file byte-for-byte and re-applying its recorded mode. The
 * restore is itself reversible: the CURRENT state is backed up first.
 *
 * Safety contract:
 *   - the backup manifest is verified (hash of every backed-up file) before any
 *     restore; a tampered or incomplete set is refused outright;
 *   - the backup-vs-current diff is shown BY PATH ONLY (never file contents);
 *   - writing requires explicit authorization (`--yes`); a non-TTY run without
 *     `--yes` previews and exits without writing.
 *
 * Usage:
 *   pantheon-opencode restore [--project] [--from <dir>] [--dry-run] [--yes]
 *
 * Exit codes:
 *   0 = restored (or preview shown with --dry-run)
 *   1 = refused (missing/tampered backup, or no authorization)
 *   2 = usage error
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

import {
  backupRoot,
  createBackupSet,
  isBackupDirName,
  listBackupSets,
  planRestore,
  restoreBackupSet,
  verifyBackupSet,
} from './install/backup.mjs'

/**
 * Resolve the config dir whose `opencode.json` the installer manages.
 * `--project` targets the CWD; otherwise XDG / PANTHEON_HOME.
 * @param {{ project?: boolean }} opts
 * @returns {string}
 */
export function resolveConfigDir({ project = false } = {}) {
  if (project) return resolve(process.cwd())
  if (process.env.PANTHEON_HOME) return resolve(process.env.PANTHEON_HOME)
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'opencode')
}

export function parseArgs(argv) {
  const args = { project: false, from: null, dryRun: false, yes: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    switch (arg) {
      case '--project':
        args.project = true
        break
      case '--dry-run':
        args.dryRun = true
        break
      case '--yes':
      case '-y':
        args.yes = true
        break
      case '--from':
        args.from = argv[++i] ?? null
        break
      case '--help':
      case '-h':
        args.help = true
        break
      default:
        break
    }
  }
  return args
}

export function showHelp() {
  console.log(`
pantheon-opencode restore — restore an exact installer backup

Usage:
  pantheon-opencode restore                       restore newest backup (global config)
  pantheon-opencode restore --project             restore newest backup (project)
  pantheon-opencode restore --from <dir>          restore a specific backup set
  pantheon-opencode restore --dry-run             preview only (writes nothing)
  pantheon-opencode restore --yes                 authorize the write (non-interactive)

A backup set lives under <config-dir>/.pantheon/backups/<timestamp>/.
Restore reproduces each file byte-for-byte and re-applies its recorded mode.
File contents are never printed.
`)
}

/**
 * Choose the backup set to restore.
 * @param {string} configDir
 * @param {string|null} from
 * @returns {{ dir: string, name: string } | null}
 */
export function pickBackupSet(configDir, from) {
  if (from) {
    // Accept either a bare timestamp set name (resolved under the backups root)
    // or an explicit directory path.
    if (isBackupDirName(from)) {
      const dir = join(backupRoot(configDir), from)
      return existsSync(dir) ? { dir, name: from } : null
    }
    const dir = isAbsolute(from) ? from : resolve(process.cwd(), from)
    if (!existsSync(dir)) return null
    return { dir, name: dir.split(/[\\/]/).pop() }
  }
  return listBackupSets(configDir)[0] ?? null
}

/**
 * @param {object} opts
 * @param {string} opts.configDir
 * @param {string} opts.backupDir
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.yes]
 * @returns {Promise<{ ok: boolean, code: number, entries?: object[] }>}
 */
export async function runRestore({ configDir, backupDir, dryRun = false, yes = false }) {
  const verify = verifyBackupSet(backupDir)
  if (!verify.ok) {
    console.error(
      `❌ Refusing to restore: backup failed integrity verification (${verify.reason ?? 'hash mismatch'}).`,
    )
    return { ok: false, code: 1 }
  }

  const plan = planRestore(backupDir, configDir)
  if (plan.error) {
    console.error(`❌ Refusing to restore: ${plan.error}.`)
    return { ok: false, code: 1 }
  }

  const counts = { create: 0, update: 0, remove: 0, unchanged: 0 }
  for (const entry of plan.entries) counts[entry.action] += 1

  console.log('')
  console.log(`Restore plan — ${configDir}`)
  console.log(`  from   ${backupDir}`)
  for (const entry of plan.entries) {
    if (entry.action === 'unchanged') continue
    console.log(`  ${entry.action.padEnd(9)} ${entry.relativePath}`)
  }
  console.log(
    `  ${counts.create} create · ${counts.update} update · ${counts.remove} remove · ${counts.unchanged} unchanged`,
  )

  if (dryRun) {
    console.log('  (dry-run) No files were written.')
    return { ok: true, code: 0, entries: plan.entries }
  }

  if (!yes) {
    // Reuse the shared confirm semantics (default NO). An interactive TTY may
    // authorize without --yes; a non-TTY run must never proceed silently.
    const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY)
    if (!tty) {
      console.error('❌ Refusing to restore without authorization. Re-run with --yes.')
      return { ok: false, code: 1 }
    }
    const { promptReview } = await import('./install/interactive.mjs')
    const accepted = await promptReview('Restore these changes?', { default: false })
    if (!accepted) {
      console.log('  Nothing restored.')
      return { ok: true, code: 0, entries: plan.entries }
    }
  }

  // Reversible: snapshot the CURRENT state of exactly the affected paths first.
  // Retention is DISABLED here (`keep: 0`): a retention pass at this point could
  // delete the very set being restored once 5 older sets already exist (the new
  // snapshot would be the 6th, and pruning would drop the oldest two — including
  // the source). Apply still prunes; restore never deletes backups.
  const { dir: preDir } = createBackupSet({
    configDir,
    entries: plan.manifest.entries.map((e) => e.relativePath),
    packageVersion: plan.manifest.packageVersion,
    keep: 0,
  })
  console.log(`  pre-restore backup: ${preDir}`)

  restoreBackupSet(backupDir, configDir, { dryRun: false })
  console.log(`  ✅ Restored ${plan.entries.length} path(s).`)
  return { ok: true, code: 0, entries: plan.entries }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    showHelp()
    return
  }
  const configDir = resolveConfigDir({ project: args.project })
  const backup = pickBackupSet(configDir, args.from)
  if (!backup) {
    console.error(`❌ No backup set found under ${backupRoot(configDir)}`)
    process.exitCode = 1
    return
  }
  const result = await runRestore({
    configDir,
    backupDir: backup.dir,
    dryRun: args.dryRun,
    yes: args.yes,
  })
  if (!result.ok) process.exitCode = result.code
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`❌ Restore failed: ${err instanceof Error ? err.message : String(err)}`)
    process.exitCode = 1
  })
}
