#!/usr/bin/env node
/**
 * check-generated-hook.mjs — pre-commit gate for committed generated artifacts.
 *
 * Rebuilds `src/agents` (from roster.json) and `src/plugin` (esbuild), then
 * fails when the rebuilt output differs from the STAGED content. Both
 * generators always run, so one commit attempt reports every drift instead of
 * stopping at the first failing `&&` chain.
 *
 * Rebuilding normalizes the working tree. Before that happens, any unstaged or
 * untracked file under the generated trees is copied to a temp directory and
 * its location is printed, so a hand-edit cannot disappear silently.
 */

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const GENERATED_PATHS = ['src/agents', 'src/plugin']

function gitLines(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean)
}

// Unstaged edits and untracked files are about to be normalized away.
const dirty = new Set([
  ...gitLines(['diff', '--name-only', '--', ...GENERATED_PATHS]),
  ...gitLines(['ls-files', '--others', '--exclude-standard', '--', ...GENERATED_PATHS]),
])
if (dirty.size > 0) {
  const backupDir = mkdtempSync(join(tmpdir(), 'pantheon-generated-backup-'))
  for (const relPath of dirty) {
    const target = join(backupDir, relPath)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(root, relPath), target)
  }
  console.error(
    `[generated-artifacts] backed up ${dirty.size} unstaged generated file(s) to: ${backupDir}`,
  )
}

const steps = [
  { label: 'agent roster', script: 'scripts/build-roster.mjs', path: 'src/agents' },
  { label: 'plugin bundle', script: 'scripts/build-plugin.mjs', path: 'src/plugin' },
]

let failed = false
for (const step of steps) {
  console.error(`[generated-artifacts] checking ${step.label}`)
  try {
    execFileSync(process.execPath, [step.script], { cwd: root, stdio: 'inherit' })
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
