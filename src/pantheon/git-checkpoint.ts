/**
 * Atomic Git Checkpointing (`git-checkpoint.ts`).
 *
 * Captures working-tree snapshots as Git tree objects using a temporary
 * `GIT_INDEX_FILE` (never mutating the repository's real `.git/index` or
 * commits) and rolls back cleanly when `themis:reflex:escalated` fires or when
 * `pantheon_step_ledger(action="rollback_step")` is invoked.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const SAFE_TREE_RE = /^[0-9a-f]{40}$/

export interface GitCheckpointResult {
  readonly ok: boolean
  readonly treeHash?: string
  readonly reason?: string
}

async function runGit(
  cwd: string,
  args: readonly string[],
  envExtra?: Record<string, string>,
): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 10000,
    env: envExtra ? { ...process.env, ...envExtra } : process.env,
  })
  return stdout.trim()
}

export async function isGitWorkspace(cwd: string): Promise<boolean> {
  try {
    const out = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
    return out === 'true'
  } catch {
    return false
  }
}

/**
 * Snapshot the working tree (tracked + non-ignored untracked files) to a Git
 * tree object SHA without touching the repository's staging index or HEAD.
 */
export async function captureGitCheckpoint(
  cwd: string,
  stepKey = 'step',
): Promise<GitCheckpointResult> {
  const root = resolve(cwd)
  if (!(await isGitWorkspace(root))) {
    return { ok: false, reason: 'not_a_git_repository' }
  }
  const safeTag = stepKey.replace(/[^a-zA-Z0-9._-]/g, '_')
  const tmpIndex = join(tmpdir(), `pantheon-idx-${process.pid}-${safeTag}-${Date.now()}`)
  try {
    try {
      await runGit(root, ['read-tree', 'HEAD'], { GIT_INDEX_FILE: tmpIndex })
    } catch {
      await runGit(root, ['read-tree', '--empty'], { GIT_INDEX_FILE: tmpIndex })
    }
    await runGit(root, ['add', '-A'], { GIT_INDEX_FILE: tmpIndex })
    const treeHash = await runGit(root, ['write-tree'], { GIT_INDEX_FILE: tmpIndex })
    if (!SAFE_TREE_RE.test(treeHash)) {
      return { ok: false, reason: 'invalid_tree_hash' }
    }
    return { ok: true, treeHash }
  } catch (err: unknown) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  } finally {
    try {
      if (existsSync(tmpIndex)) unlinkSync(tmpIndex)
    } catch {
      /* best-effort cleanup */
    }
  }
}

/**
 * Restore the workspace directory to a previously captured Git tree SHA.
 * Removes files added after the snapshot and restores tracked modifications.
 */
export async function restoreGitCheckpoint(
  cwd: string,
  treeHash: string,
): Promise<GitCheckpointResult> {
  const root = resolve(cwd)
  if (!SAFE_TREE_RE.test(treeHash)) {
    return { ok: false, reason: 'invalid_tree_hash' }
  }
  if (!(await isGitWorkspace(root))) {
    return { ok: false, reason: 'not_a_git_repository' }
  }

  const tmpIndex = join(tmpdir(), `pantheon-rb-${process.pid}-${Date.now()}`)
  try {
    // 1. Identify files currently present in workspace (not ignored) that were NOT in treeHash
    const treeListing = await runGit(root, ['ls-tree', '-r', '--name-only', treeHash])
    const baselineFiles = new Set(treeListing.split(/\r?\n/).filter(Boolean))

    const currentOthers = await runGit(root, ['ls-files', '--others', '--exclude-standard'])
    for (const rel of currentOthers.split(/\r?\n/).filter(Boolean)) {
      if (rel.startsWith('.pantheon/')) continue
      if (!baselineFiles.has(rel)) {
        const target = join(root, rel)
        try {
          rmSync(target, { recursive: true, force: true })
        } catch {
          /* ignore */
        }
      }
    }

    // 2. Restore all files recorded in `treeHash` via isolated temporary index
    await runGit(root, ['read-tree', treeHash], { GIT_INDEX_FILE: tmpIndex })
    await runGit(root, ['checkout-index', '--all', '--force'], { GIT_INDEX_FILE: tmpIndex })

    // Ensure `.pantheon/ledger` remains intact even if baseline didn't contain it
    mkdirSync(join(root, '.pantheon', 'ledger'), { recursive: true })
    return { ok: true, treeHash }
  } catch (err: unknown) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  } finally {
    try {
      if (existsSync(tmpIndex)) unlinkSync(tmpIndex)
    } catch {
      /* best-effort cleanup */
    }
  }
}
