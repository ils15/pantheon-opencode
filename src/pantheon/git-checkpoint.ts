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

/**
 * Runtime state paths that a work-tree checkpoint must never capture.
 *
 * `.pantheon/` holds live subsystem state (step ledger, board, deepwork plans,
 * memory DB, reports). Capturing it means a rollback restores a *stale* ledger
 * and silently deletes steps created after the checkpoint — and the same
 * hazard applies to every other `.pantheon/` artifact. The ledger is owned by
 * the lock protocol, not by the Git tree, so it is excluded at the source:
 * dropped from the temporary index after both `read-tree` and `add -A`, which
 * also neutralizes checkpoints captured by older versions.
 *
 * The only non-ledger `.pantheon/` content with rollback value is a deepwork
 * plan/report, and those are append-only artifacts the user reviews in place —
 * rolling them back would lose the record of the step being rolled back.
 */
const PANTHEON_RUNTIME_PATHS = ['.pantheon'] as const

/** Drop `.pantheon/` entries from the isolated index before writing/checking out a tree. */
async function dropPantheonRuntimeState(root: string, tmpIndex: string): Promise<void> {
  await runGit(
    root,
    // `-f` is required when an entry's staged content diverges from both the
    // work tree and HEAD (exactly the stale-checkpoint case). It only affects
    // the isolated temporary index, never the repository's real staging area.
    ['rm', '-r', '-f', '-q', '--cached', '--ignore-unmatch', '--', ...PANTHEON_RUNTIME_PATHS],
    { GIT_INDEX_FILE: tmpIndex },
  )
}

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
    // `.pantheon/` is runtime state, never work-tree state: a checkpoint must
    // not capture the ledger (or board/memory/deepwork) it would later restore.
    await dropPantheonRuntimeState(root, tmpIndex)
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

/** True when the tree contains at least one `.pantheon/` entry. */
async function treeContainsPantheon(root: string, treeHash: string): Promise<boolean> {
  const listing = await runGit(root, [
    'ls-tree',
    '-r',
    '--name-only',
    treeHash,
    '--',
    ...PANTHEON_RUNTIME_PATHS,
  ])
  return listing.length > 0
}

export interface TreeStripResult {
  readonly ok: boolean
  readonly treeHash?: string
  /** True when the tree contained `.pantheon/` and was rewritten. */
  readonly changed?: boolean
  readonly reason?: string
}

/**
 * Rewrite an existing checkpoint tree without any `.pantheon/` entry (L3).
 *
 * Checkpoints are dangling tree objects — no commit and no ref — so removing a
 * path means writing a *new* tree; the caller must persist the returned SHA
 * (the ledger's `baselineTree`). Returns `changed: false` when the tree is
 * already clean, so the scrub is idempotent.
 */
export async function stripPantheonFromTree(
  cwd: string,
  treeHash: string,
): Promise<TreeStripResult> {
  const root = resolve(cwd)
  if (!SAFE_TREE_RE.test(treeHash)) return { ok: false, reason: 'invalid_tree_hash' }
  if (!(await isGitWorkspace(root))) return { ok: false, reason: 'not_a_git_repository' }

  const tmpIndex = join(tmpdir(), `pantheon-scrub-${process.pid}-${Date.now()}`)
  try {
    if (!(await treeContainsPantheon(root, treeHash))) {
      return { ok: true, treeHash, changed: false }
    }
    await runGit(root, ['read-tree', treeHash], { GIT_INDEX_FILE: tmpIndex })
    await dropPantheonRuntimeState(root, tmpIndex)
    const stripped = await runGit(root, ['write-tree'], { GIT_INDEX_FILE: tmpIndex })
    if (!SAFE_TREE_RE.test(stripped)) return { ok: false, reason: 'invalid_tree_hash' }
    return { ok: true, treeHash: stripped, changed: stripped !== treeHash }
  } catch (err: unknown) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
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

    // 2. Restore all files recorded in `treeHash` via isolated temporary index.
    //    `.pantheon/` is dropped from the index first: a checkpoint captured by
    //    an older version may still contain `.pantheon/`, and checking it out
    //    would roll the live ledger (and every other runtime artifact) back.
    await runGit(root, ['read-tree', treeHash], { GIT_INDEX_FILE: tmpIndex })
    await dropPantheonRuntimeState(root, tmpIndex)
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
