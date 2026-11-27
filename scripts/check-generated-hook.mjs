#!/usr/bin/env node
/**
 * check-generated-hook.mjs — pre-commit gate for committed generated artifacts.
 *
 * Rebuilds `src/agents` (from roster.json) and `src/plugin` (esbuild), then
 * fails when the rebuilt output differs from the STAGED content. Both
 * generators always run, so one commit attempt reports every drift instead of
 * stopping at the first failing `&&` chain.
 *
 * Rebuilding normalizes the working tree. Before that happens, any unstaged
 * file under the generated trees is copied to a temp directory and the path is
 * printed; old backups are pruned after 7 days. Untracked strays and deleted
 * generated files fail the hook with an explicit list.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const GENERATED_PATHS = ['src/agents', 'src/plugin', 'src/plugins/tui/dist']
const BACKUP_PREFIX = 'pantheon-generated-backup-'
const BACKUP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

function gitLines(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
}

function pruneBackups() {
  const now = Date.now()
  for (const entry of readdirSync(tmpdir())) {
    if (!entry.startsWith(BACKUP_PREFIX)) continue
    const backupPath = join(tmpdir(), entry)
    try {
      if (now - statSync(backupPath).mtimeMs > BACKUP_MAX_AGE_MS) {
        rmSync(backupPath, { recursive: true, force: true })
      }
    } catch {
      // Best-effort: a concurrent run may have pruned it already.
    }
  }
}

pruneBackups()

const modified = gitLines(['diff', '--name-only', '--', ...GENERATED_PATHS])
const untracked = gitLines(['ls-files', '--others', '--exclude-standard', '--', ...GENERATED_PATHS])
const dirty = [...new Set([...modified, ...untracked])]

let failed = untracked.length > 0
if (untracked.length > 0) {
  console.error(
    `[generated-artifacts] unexpected untracked file(s) under ${GENERATED_PATHS.join(', ')}: ${untracked.join(', ')} — stage them if intentional, otherwise remove them`,
  )
}

if (dirty.length > 0) {
  const backupDir = mkdtempSync(join(tmpdir(), BACKUP_PREFIX))
  const missing = []
  let backedUp = 0

  for (const relPath of dirty) {
    const source = join(root, relPath)
    if (!existsSync(source)) {
      missing.push(relPath)
      continue
    }
    const target = join(backupDir, relPath)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(source, target)
    backedUp += 1
  }

  if (missing.length > 0) {
    failed = true
    console.error(
      `[generated-artifacts] generated file(s) missing/deleted: ${missing.join(', ')} — restore them with the generator, or commit the removal together with its source`,
    )
  }

  if (backedUp > 0) {
    console.error(
      '[generated-artifacts] WARNING: the working tree was rewritten to canonical generated output.',
    )
    console.error(
      `[generated-artifacts] Original bytes of ${backedUp} file(s) saved at: ${backupDir} (delete it once you no longer need them)`,
    )
  } else {
    rmSync(backupDir, { recursive: true, force: true })
  }
}

const steps = [
  {
    label: 'agent roster',
    command: process.execPath,
    args: ['scripts/build-roster.mjs'],
    path: 'src/agents',
  },
  {
    label: 'plugin bundle',
    command: process.execPath,
    args: ['scripts/build-plugin.mjs'],
    path: 'src/plugin',
  },
  {
    // The TUI bundle is a committed artifact too (CI's `validate` rebuilds it
    // and fails on drift); gate it here so the class cannot recur.
    label: 'TUI bundle',
    command: 'npm',
    args: ['--silent', 'run', 'build', '--prefix', 'src/plugins/tui'],
    path: 'src/plugins/tui/dist',
  },
]

for (const step of steps) {
  console.error(`[generated-artifacts] checking ${step.label}`)
  try {
    execFileSync(step.command, step.args, { cwd: root, stdio: 'inherit' })
  } catch {
    failed = true
    console.error(`[generated-artifacts] ${step.label}: generator failed`)
    continue
  }
  try {
    execFileSync('git', ['diff', '--exit-code', '--', step.path], { cwd: root, stdio: 'inherit' })
  } catch {
    failed = true
    console.error(
      `[generated-artifacts] ${step.label}: rebuilt output differs from the staged content — run the generator, stage it, and commit again`,
    )
  }
}

process.exit(failed ? 1 : 0)
