#!/usr/bin/env node
/**
 * check-tui-dist.mjs — TUI bundle freshness gate (single source of truth).
 *
 * CI's `validate` job rebuilds `src/plugins/tui/dist` and fails when the
 * committed bundle differs from a fresh build. This script is the *only*
 * implementation of that check: `npm run check:tui-dist` and `.github/workflows/ci.yml`
 * both call it, so the two can never drift apart again.
 *
 * Behaviour:
 * - untracked files under `src/plugins/tui/dist` fail the check (they cannot be
 *   compared with a fresh build and are the same class of drift the
 *   `src/agents` / `src/plugin` gates reject);
 * - uncommitted local edits are backed up to a temp dir and announced before
 *   the rebuild overwrites them (never a silent revert);
 * - final newlines are normalized exactly like the pre-commit `end-of-file-fixer`
 *   convention before the diff;
 * - the rebuild is compared with the staged content (`git diff --exit-code`).
 *
 * Exit codes: 0 = fresh, 1 = drift/untracked (action required).
 */

import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = 'src/plugins/tui/dist'
const distPath = join(root, DIST)
const BACKUP_PREFIX = 'pantheon-tui-dist-backup-'
const BUILT = 'src/plugins/tui'

function gitResult(args) {
  try {
    return { status: 0, stdout: execFileSync('git', args, { cwd: root, encoding: 'utf8' }) }
  } catch (err) {
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: `${err.stdout ?? ''}`,
    }
  }
}

function lines(text) {
  return text.split('\n').filter(Boolean)
}

// 1) Untracked files cannot be compared with a fresh build — check before the
//    rebuild AND after it, because a new chunk/hashed asset emitted by the
//    build would otherwise slip past `git diff` (which ignores untracked paths).
function untrackedUnderDist() {
  return lines(gitResult(['ls-files', '--others', '--exclude-standard', '--', DIST]).stdout)
}

function rejectUntracked(files, when) {
  if (files.length === 0) return
  console.error(`[tui-dist] untracked file(s) under ${DIST} ${when}:`)
  for (const file of files) console.error(`[tui-dist]   - ${file}`)
  console.error('[tui-dist] stage them if intentional, otherwise remove them.')
  process.exit(1)
}

rejectUntracked(untrackedUnderDist(), 'before the rebuild')

// 2) Never silently destroy uncommitted local edits.
const dirty = lines(gitResult(['diff', '--name-only', '--', DIST]).stdout)
let backupDir
if (dirty.length > 0) {
  backupDir = mkdtempSync(join(tmpdir(), BACKUP_PREFIX))
  cpSync(distPath, join(backupDir, 'dist'), { recursive: true })
  console.error(`[tui-dist] WARNING: the rebuild overwrites uncommitted changes in ${DIST}:`)
  for (const file of dirty) console.error(`[tui-dist]   - ${file}`)
  console.error(`[tui-dist] original bytes backed up at: ${join(backupDir, 'dist')}`)
}

// 3) Rebuild.
execFileSync('npm', ['--silent', 'run', 'build', '--prefix', BUILT], {
  cwd: root,
  stdio: 'inherit',
})

// 4) Normalize final newlines (pre-commit end-of-file-fixer parity).
if (existsSync(distPath)) {
  for (const name of readdirSync(distPath)) {
    const file = join(distPath, name)
    if (!statSync(file).isFile()) continue
    const bytes = readFileSync(file)
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 10) appendFileSync(file, '\n')
  }
}

// 5) A fresh build may have emitted a new file; `git diff` ignores untracked
//    paths, so re-run the untracked guard before comparing.
rejectUntracked(untrackedUnderDist(), 'emitted by the rebuild')

// 6) Compare the rebuilt bundle with the staged content.
const diff = gitResult(['diff', '--exit-code', '--', DIST])
if (diff.status !== 0) {
  console.error('[tui-dist] rebuilt bundle differs from the staged content:')
  const stat = gitResult(['diff', '--stat', '--', DIST])
  console.error(stat.stdout.trimEnd())
  console.error(`[tui-dist] run \`npm run build --prefix ${BUILT}\` and commit ${DIST}.`)
  if (backupDir) {
    console.error(`[tui-dist] pre-rebuild bytes: ${join(backupDir, 'dist')}`)
    console.error(`[tui-dist] remove the backup once you no longer need it: rm -rf ${backupDir}`)
  }
  process.exit(1)
}

if (backupDir) rmSync(backupDir, { recursive: true, force: true })
console.log(`[tui-dist] OK — ${DIST} matches a fresh build.`)
