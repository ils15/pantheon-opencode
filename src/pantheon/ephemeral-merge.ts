/**
 * Protected ephemeral branch merge (`ephemeral-merge.ts`) — S3 of v2.3.5.
 *
 * Closes the loop after a `@themis` verdict on an ephemeral worker: a worker's
 * preserved branch (`pantheon/eph/<stepKey>`) may only land in the caller's
 * checkout when the base it was produced from is still `HEAD`, no other live
 * claim covers the files it touches, the merge is provably clean, and the caller
 * presents a **single-use, self-invalidating token** minted by a preview.
 *
 * Two invariants drive the whole design (S1 lessons, re-applied):
 *
 * 1. **A refusal is a no-op.** Every check runs before the first mutation, and a
 *    late failure is compensated *and reported truthfully* (`treeRestored` only
 *    when the pre-merge tree was verified byte-identical again).
 * 2. **Never leave a half-merged tree.** `git merge --squash` conflicts leave no
 *    `MERGE_HEAD` but do leave `MERGE_MSG`, unmerged index entries and conflict
 *    markers in the worktree, so recovery always runs: abort when `MERGE_HEAD`
 *    exists, `git reset --merge`, restore the pre-merge checkpoint when the tree
 *    still differs, then assert no `MERGE_HEAD`/`MERGE_MSG`.
 *
 * Mode contract:
 * - `preview` never mutates the checkout. It reports the merge result plus every
 *   reason an `apply` would be refused (`readyToApply`/`blockers`) and mints the
 *   token. It is allowed to succeed on a drifted/dirty tree *because* the token
 *   is bound to branch content — otherwise `discard` could never clean up a
 *   branch whose base has moved on.
 * - `apply` re-runs every check and refuses before touching anything.
 * - `discard` only needs a valid token: it deletes the branch and never touches
 *   the worktree, so local dirt cannot and must not block cleanup.
 *
 * Nothing here writes to the user's tree during a preview: `git merge-tree`
 * writes objects only, and the pre-2.38 fallback merges inside a disposable
 * worktree under `<project-parent>/.pantheon-worktrees/<repo>/`.
 *
 * @module pantheon/ephemeral-merge
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { appendBoardMessage } from './board-messages.ts'
import { getSharedBus } from './bus.ts'
import { type FileLeaseRecord, leaseClaimsPath, listActiveLeases } from './file-leases.ts'
import { captureGitCheckpoint, isGitWorkspace, restoreGitCheckpoint } from './git-checkpoint.ts'
import {
  describeLedgerError,
  type EphemeralStepMetadata,
  readStepLedger,
  StepLedgerLockError,
  updateStepLedger,
  withExclusiveLedgerLock,
} from './step-ledger.ts'
import { resolveSharedPantheonRoot } from './tool-context.ts'
import { resolvePantheonWorktreePath } from './worktree-orchestrator.ts'

const execFileAsync = promisify(execFile)

/** `MERGE-` + 12 hex chars of a sha256 over the merge fingerprint (D06). */
export const MERGE_TOKEN_PREFIX = 'MERGE-'
export const MERGE_TOKEN_TTL_MS = 10 * 60 * 1000
const MERGE_TOKEN_RE = /^MERGE-[0-9a-f]{12}$/
const EPH_BRANCH_PREFIX = 'pantheon/eph/'
/** A plain branch name only: no leading `-` (option injection), no `..`, no spaces. */
const SAFE_EPH_BRANCH_RE = /^[A-Za-z0-9._/-]+$/
const TOKEN_STORE_KEY = '__pantheonMergeTokens'
const MERGE_TREE_MIN_GIT: readonly [number, number] = [2, 38]
/**
 * One mutation window per checkout, kept beside (not inside) the ledger
 * directory: a broken `.pantheon/ledger/` must fail the ledger write without
 * also making the merge lock unreachable, so the two failures stay separable.
 */
const MERGE_LOCK_NAME = '.ephemeral-merge.lock'

/**
 * `.pantheon/` is live runtime state, never work-tree state (same predicate as
 * `git-checkpoint.ts`). The ledger/board/memory a tool writes must never make
 * its own checkout look dirty to this gate.
 */
function isPantheonRuntimePath(rel: string): boolean {
  return rel === '.pantheon' || rel.startsWith('.pantheon/')
}

export type MergeMode = 'preview' | 'apply' | 'discard'

/** Where the conflicting claim on a file comes from. */
export type MergeConflictSource = 'lease' | 'dirty' | 'branch'

export interface MergeLeaseConflict {
  readonly file: string
  readonly holder: string
  readonly source: MergeConflictSource
}

export interface MergeHeadDrift {
  readonly commits: number
  readonly files: readonly string[]
}

export interface MergeEphemeralInput {
  readonly cwd: string
  readonly stepKey: string
  readonly mode?: MergeMode
  readonly confirmToken?: string
  readonly allowDirty?: boolean
  readonly commit?: boolean
  readonly cascade?: boolean
  /** Caller session id; its own lease is not a conflict. */
  readonly sessionID?: string
  /** Clock seam for TTL tests. */
  readonly now?: number
  /** Diagnostic seam: exercise the pre-2.38 temp-worktree preview path. */
  readonly forceLegacyPreview?: boolean
  /**
   * Deterministic seam for the preview→merge interleaving: runs after the
   * pre-merge checkpoint and immediately before `git merge --squash`, so a test
   * (or a future hook) can land a conflicting change in the window a real
   * concurrent writer would occupy. Never called on a refusal.
   */
  readonly onBeforeMerge?: () => Promise<void> | void
  /**
   * Deterministic seam for the lock-wait window: runs immediately after the
   * merge lock is acquired and before the state is re-verified, so a test can
   * prove that a writer who moved HEAD while we queued is detected. Never called
   * on a refusal.
   */
  readonly onAfterLock?: () => Promise<void> | void
}

export interface MergeEphemeralResult {
  readonly ok: boolean
  readonly mode: MergeMode
  readonly stepKey: string
  readonly error?: string
  readonly message?: string
  readonly hint?: string
  readonly branch?: string
  readonly baseHead?: string
  readonly head?: string
  readonly commits?: number
  readonly changes?: readonly string[]
  readonly clean?: boolean
  readonly mergeTree?: string
  readonly previewVia?: 'merge-tree' | 'temp-worktree'
  readonly conflicts?: readonly string[]
  readonly headDrift?: MergeHeadDrift
  readonly leaseConflicts?: readonly MergeLeaseConflict[]
  /** Refusal codes an `apply` would produce right now (preview only). */
  readonly blockers?: readonly string[]
  readonly readyToApply?: boolean
  /** True when the presented token can no longer authorize a mutation. */
  readonly tokenValid?: boolean
  readonly token?: string
  readonly tokenExpiresAt?: string
  /** Preview guarantee: `git status` + `HEAD` are identical before and after. */
  readonly treeUntouched?: boolean
  /** Nothing was mutated by this call (refusals, previews, no-ops). */
  readonly noOp?: boolean
  readonly committed?: boolean
  readonly commitHash?: string
  readonly unstaged?: boolean
  readonly branchKept?: boolean
  readonly discarded?: boolean
  readonly mergedAt?: string
  readonly metadataRecorded?: boolean
  /** The merge landed but the ledger write failed; re-record, never re-merge. */
  readonly metadataError?: string
  readonly recovery?: MergeRecovery
  /** Verified pre-merge tree is back in place. */
  readonly treeRestored?: boolean
  readonly restoredTree?: string
  readonly restoreFailed?: { readonly reason: string; readonly checkpoint?: string }
  readonly warnings?: readonly string[]
  readonly step?: unknown
}

export interface MergeRecovery {
  readonly aborted: boolean
  readonly resetApplied: boolean
  /** The worktree content is byte-identical to the pre-merge checkpoint. */
  readonly treeRestored: boolean
  /** A checkpoint restore had to run (the tree was not already correct). */
  readonly compensated: boolean
  readonly restoredTree?: string
  readonly restoreFailed?: { readonly reason: string; readonly checkpoint?: string }
  /** `git status --porcelain -z` matches the pre-merge fingerprint exactly. */
  readonly statusRestored: boolean
  /** `MERGE_HEAD` or `MERGE_MSG` survived recovery (must never be true). */
  readonly mergeStatePresent: boolean
  /**
   * A merge that this call did not start was in progress. Nothing was touched:
   * destroying another writer's merge state is worse than leaving ours dirty.
   */
  readonly foreignMergeDetected?: boolean
  /**
   * Restores cover tracked content plus non-ignored untracked files (the
   * checkpoint uses `--exclude-standard`), so a `.gitignore`d file created by
   * the aborted merge is not removed. Stated, not hidden.
   */
  readonly restoreLimitation?: string
  readonly notes: readonly string[]
}

interface GitOutcome {
  readonly ok: boolean
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function git(cwd: string, args: readonly string[]): Promise<GitOutcome> {
  try {
    const { stdout, stderr } = await execFileAsync('git', [...args], {
      cwd,
      timeout: 30_000,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    })
    return { ok: true, code: 0, stdout, stderr }
  } catch (err: unknown) {
    const failure = err as { code?: unknown; stdout?: string; stderr?: string }
    return {
      ok: false,
      code: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? '',
    }
  }
}

function firstLine(text: string): string {
  return (
    text
      .trim()
      .split(/\r?\n/)
      .find((line) => line.length > 0) ?? ''
  )
}

function splitNul(text: string): string[] {
  return text.split('\0').filter((entry) => entry.length > 0)
}

interface StatusEntry {
  readonly index: string
  readonly worktree: string
  readonly paths: readonly string[]
}

/**
 * A read that could not be answered. Never substitute a plausible-looking empty
 * answer: "we could not look" and "there is nothing there" are different facts,
 * and the gate must fail closed on the first one (a corrupt index makes
 * `git status` exit 128 while `rev-list`/`diff`/`merge-tree` still succeed).
 */
interface Unavailable {
  readonly ok: false
  readonly reason: string
}

type ReadResult<T> = { readonly ok: true; readonly value: T } | Unavailable

function unavailableReason(what: string, res: GitOutcome): string {
  return `${what} failed (exit ${res.code}): ${firstLine(res.stderr) || firstLine(res.stdout) || 'no output'}`
}

/**
 * Parse `git status --porcelain=v1 -z`, skipping `.pantheon/` runtime state.
 * Renames/copies carry two NUL-separated paths (destination first).
 */
function parseStatus(raw: string): StatusEntry[] {
  const fields = splitNul(raw)
  const entries: StatusEntry[] = []
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] ?? ''
    if (field.length < 4) continue
    const index = field.slice(0, 1)
    const worktree = field.slice(1, 2)
    const paths = [field.slice(3)]
    if (index === 'R' || index === 'C') {
      const second = fields[i + 1]
      if (second !== undefined) {
        paths.push(second)
        i += 1
      }
    }
    if (paths.every((entry) => isPantheonRuntimePath(entry))) continue
    entries.push({ index, worktree, paths })
  }
  return entries
}

async function readStatus(root: string): Promise<ReadResult<StatusEntry[]>> {
  const res = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  if (!res.ok) {
    return { ok: false, reason: unavailableReason('git status', res) }
  }
  return { ok: true, value: parseStatus(res.stdout) }
}

function statusFingerprint(entries: readonly StatusEntry[]): string {
  return entries
    .map((entry) => `${entry.index}${entry.worktree} ${entry.paths.join('\0')}`)
    .sort()
    .join('\n')
}

function dirtyPaths(entries: readonly StatusEntry[]): string[] {
  return entries.flatMap((entry) => [...entry.paths])
}

function stagedPaths(entries: readonly StatusEntry[]): string[] {
  return entries
    .filter((entry) => entry.index !== ' ' && entry.index !== '?')
    .flatMap((entry) => [...entry.paths])
}

async function changedFiles(root: string, from: string, to: string): Promise<ReadResult<string[]>> {
  const res = await git(root, ['diff', '--name-only', '-z', from, to])
  if (!res.ok)
    return {
      ok: false,
      reason: unavailableReason(`git diff ${from.slice(0, 12)}..${to.slice(0, 12)}`, res),
    }
  return { ok: true, value: splitNul(res.stdout) }
}

async function commitCount(root: string, range: string): Promise<ReadResult<number>> {
  const res = await git(root, ['rev-list', '--count', range])
  if (!res.ok) return { ok: false, reason: unavailableReason(`git rev-list ${range}`, res) }
  const parsed = Number.parseInt(res.stdout.trim(), 10)
  if (!Number.isFinite(parsed)) {
    return { ok: false, reason: `git rev-list ${range} returned an unparsable count` }
  }
  return { ok: true, value: parsed }
}

async function resolveCommit(root: string, ref: string): Promise<string | undefined> {
  const res = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  if (!res.ok) return undefined
  const sha = res.stdout.trim()
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : undefined
}

async function gitVersion(root: string): Promise<[number, number]> {
  const res = await git(root, ['version'])
  const match = /(\d+)\.(\d+)/.exec(res.stdout)
  if (!match) return [0, 0]
  return [Number(match[1]), Number(match[2])]
}

function supportsMergeTree(version: readonly [number, number]): boolean {
  const [major, minor] = version
  if (major > MERGE_TREE_MIN_GIT[0]) return true
  if (major < MERGE_TREE_MIN_GIT[0]) return false
  return minor >= MERGE_TREE_MIN_GIT[1]
}

/** Stable digest of the branch's own change set (`base..branchRef`). */
async function diffDigest(
  root: string,
  base: string,
  branchRef: string,
): Promise<ReadResult<string>> {
  const res = await git(root, ['diff', '--binary', '--no-color', base, branchRef])
  if (!res.ok) return { ok: false, reason: unavailableReason('git diff --binary', res) }
  if (!res.stdout) {
    return { ok: false, reason: 'git diff --binary produced no output (contentless digest)' }
  }
  return { ok: true, value: createHash('sha256').update(res.stdout).digest('hex') }
}

// ---------------------------------------------------------------------------
// Merge preview (never the user's tree)
// ---------------------------------------------------------------------------

export interface MergePreview {
  readonly ok: boolean
  readonly clean: boolean
  readonly mergeTree?: string
  readonly conflicts: readonly string[]
  readonly via: 'merge-tree' | 'temp-worktree'
  readonly error?: string
}

/**
 * Parse `git merge-tree --write-tree --name-only` output: the tree oid is the
 * first line, conflicted paths follow until the blank separator.
 */
function parseMergeTreeOutput(stdout: string, code: number): MergePreview {
  const lines = stdout.split(/\r?\n/)
  const tree = (lines[0] ?? '').trim()
  if (!/^[0-9a-f]{40,64}$/.test(tree)) {
    return {
      ok: false,
      clean: false,
      conflicts: [],
      via: 'merge-tree',
      error: `git merge-tree produced no tree${code === 1 ? ' (conflict)' : ''}`,
    }
  }
  const conflicts: string[] = []
  for (const line of lines.slice(1)) {
    if (!line.trim()) break
    conflicts.push(line.trim())
  }
  return {
    ok: true,
    clean: code === 0 && conflicts.length === 0,
    mergeTree: tree,
    conflicts,
    via: 'merge-tree',
  }
}

/**
 * Merge trial inside a disposable worktree, for git < 2.38 (no
 * `merge-tree --write-tree`). Never touches the caller's checkout: the trial
 * tree lives at `<project-parent>/.pantheon-worktrees/<repo>/merge-preview-*`.
 *
 * A filesystem failure here is a *payload* (`preview_failed`), never an
 * exception: a preview that cannot run must still let `discard` clean up.
 */
async function previewInTempWorktree(
  root: string,
  branchRef: string,
  stepKey: string,
): Promise<MergePreview> {
  const previewDir = resolvePantheonWorktreePath(root, `merge-preview-${stepKey}`)
  let added = false
  try {
    mkdirSync(join(previewDir, '..'), { recursive: true })
    rmSync(previewDir, { recursive: true, force: true })
    const add = await git(root, ['worktree', 'add', '--detach', previewDir, 'HEAD'])
    if (!add.ok) {
      return {
        ok: false,
        clean: false,
        conflicts: [],
        via: 'temp-worktree',
        error: `git worktree add failed: ${firstLine(add.stderr)}`,
      }
    }
    added = true
    const merge = await git(previewDir, ['merge', '--no-commit', '--no-ff', '--no-edit', branchRef])
    if (merge.ok) {
      const tree = await git(previewDir, ['write-tree'])
      const treeSha = tree.stdout.trim()
      return {
        ok: true,
        clean: true,
        via: 'temp-worktree',
        ...(tree.ok && /^[0-9a-f]{40,64}$/.test(treeSha) ? { mergeTree: treeSha } : {}),
        conflicts: [],
      }
    }
    const unmerged = await git(previewDir, ['diff', '--name-only', '-z', '--diff-filter=U'])
    const conflicts = splitNul(unmerged.stdout)
    await git(previewDir, ['merge', '--abort'])
    return {
      ok: conflicts.length > 0,
      clean: false,
      via: 'temp-worktree',
      conflicts,
      ...(conflicts.length === 0
        ? { error: `git merge failed: ${firstLine(merge.stderr) || firstLine(merge.stdout)}` }
        : {}),
    }
  } catch (err: unknown) {
    return {
      ok: false,
      clean: false,
      conflicts: [],
      via: 'temp-worktree',
      error: `temp-worktree preview failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  } finally {
    if (added) await git(root, ['worktree', 'remove', '--force', previewDir])
    rmSync(previewDir, { recursive: true, force: true })
  }
}

async function previewMerge(
  root: string,
  branchRef: string,
  stepKey: string,
  forceLegacy: boolean,
): Promise<MergePreview> {
  if (!forceLegacy && supportsMergeTree(await gitVersion(root))) {
    const res = await git(root, ['merge-tree', '--write-tree', '--name-only', 'HEAD', branchRef])
    if (res.code === 0 || res.code === 1) return parseMergeTreeOutput(res.stdout, res.code)
    return {
      ok: false,
      clean: false,
      conflicts: [],
      via: 'merge-tree',
      error: `git merge-tree failed: ${firstLine(res.stderr) || firstLine(res.stdout)}`,
    }
  }
  return previewInTempWorktree(root, branchRef, stepKey)
}

// ---------------------------------------------------------------------------
// Tokens (two-step, single-use, self-invalidating on drift)
// ---------------------------------------------------------------------------

export interface MergeTokenRecord {
  readonly token: string
  readonly fingerprint: string
  readonly stepKey: string
  readonly branch: string
  readonly expiresAt: number
  consumed: boolean
}

function tokenStore(): Map<string, MergeTokenRecord> {
  const host = globalThis as { [TOKEN_STORE_KEY]?: Map<string, MergeTokenRecord> }
  if (!(host[TOKEN_STORE_KEY] instanceof Map)) {
    host[TOKEN_STORE_KEY] = new Map<string, MergeTokenRecord>()
  }
  return host[TOKEN_STORE_KEY]
}

function tokenStoreKey(root: string, stepKey: string): string {
  return `${root}::${stepKey}`
}

/** Drop every issued token. Test seam; also useful after a manual branch reset. */
export function resetMergeTokens(): void {
  tokenStore().clear()
}

export interface MergeFingerprint {
  readonly stepKey: string
  readonly branch: string
  readonly baseHead: string
  readonly head: string
  readonly diffDigest: string
}

/**
 * The `git status` fingerprint the recovery post-condition compares against.
 * Exported so the half-merge test can capture the same value the apply path
 * records before the first mutation. Throws when status cannot be read — a
 * diagnostic accessor must not report "clean" for "unknown".
 */
export async function mergeStatusFingerprint(root: string): Promise<string> {
  const status = await readStatus(resolve(root))
  if (!status.ok) throw new Error(`mergeStatusFingerprint: ${status.reason}`)
  return statusFingerprint(status.value)
}

/** `MERGE-<sha256(stepKey|branch|baseHead|headNow|diffDigest)[:12]>` (D06). */
export function computeMergeToken(fingerprint: MergeFingerprint): string {
  const digest = createHash('sha256')
    .update(
      [
        fingerprint.stepKey,
        fingerprint.branch,
        fingerprint.baseHead,
        fingerprint.head,
        fingerprint.diffDigest,
      ].join('|'),
    )
    .digest('hex')
  return `${MERGE_TOKEN_PREFIX}${digest.slice(0, 12)}`
}

interface TokenVerdict {
  readonly ok: boolean
  readonly reason?: 'missing' | 'malformed' | 'not_issued' | 'already_used' | 'expired' | 'stale'
  readonly hint?: string
}

function validateToken(
  storeKey: string,
  presented: string | undefined,
  computed: string,
  now: number,
): TokenVerdict {
  const token = presented?.trim()
  if (!token) {
    return {
      ok: false,
      reason: 'missing',
      hint: 'Run mode:"preview" first and pass the returned token as confirmToken.',
    }
  }
  if (!MERGE_TOKEN_RE.test(token)) {
    return { ok: false, reason: 'malformed', hint: 'Tokens look like MERGE-<12 hex chars>.' }
  }
  const record = tokenStore().get(storeKey)
  if (!record) {
    return {
      ok: false,
      reason: 'not_issued',
      hint: 'No preview token is outstanding for this step in this process; run mode:"preview".',
    }
  }
  if (record.consumed) {
    return {
      ok: false,
      reason: 'already_used',
      hint: 'Merge tokens are single-use; run mode:"preview" again for a fresh one.',
    }
  }
  if (now > record.expiresAt) {
    return {
      ok: false,
      reason: 'expired',
      hint: 'Tokens live 10 minutes; run mode:"preview" again.',
    }
  }
  if (token !== computed || record.token !== computed) {
    return {
      ok: false,
      reason: 'stale',
      hint: 'HEAD or the branch diff changed since the preview; run mode:"preview" again.',
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Recovery — the "never half-merged" guarantee
// ---------------------------------------------------------------------------

async function mergeArtifactPath(root: string, name: string): Promise<string | undefined> {
  const res = await git(root, ['rev-parse', '--git-path', name])
  if (!res.ok) return undefined
  const raw = res.stdout.trim()
  if (!raw) return undefined
  return isAbsolute(raw) ? raw : join(root, raw)
}

async function inspectMergeState(root: string): Promise<{ mergeHead: boolean; mergeMsg: boolean }> {
  const headPath = await mergeArtifactPath(root, 'MERGE_HEAD')
  const msgPath = await mergeArtifactPath(root, 'MERGE_MSG')
  return {
    mergeHead: headPath ? existsSync(headPath) : false,
    mergeMsg: msgPath ? existsSync(msgPath) : false,
  }
}

/**
 * Remove leftover merge artifacts. Only ever called after the merge state is
 * resolved (`merge --abort` when needed, then `reset --merge`), plus on the
 * success path where a squash keeps `MERGE_MSG` for the follow-up commit.
 */
async function removeMergeArtifacts(root: string): Promise<void> {
  for (const name of ['MERGE_HEAD', 'MERGE_MSG']) {
    const artifact = await mergeArtifactPath(root, name)
    if (!artifact) continue
    try {
      if (existsSync(artifact)) unlinkSync(artifact)
    } catch {
      /* the caller's post-condition reports a survivor instead of throwing */
    }
  }
}

/**
 * Undo a merge failure and verify the tree is back.
 *
 * Ownership is explicit: a squash merge never creates `MERGE_HEAD`, so an
 * in-progress merge found here is **not ours** unless the caller says it is
 * (`ownedMergeState`). A foreign merge is left completely untouched and
 * reported — aborting or resetting it would destroy a user's work to clean up
 * our own failure.
 *
 * When owned: `git merge --abort` (only with `MERGE_HEAD`), then
 * `git reset --merge` to drop unmerged index entries and conflict markers, then
 * a content restore from the pre-merge checkpoint when the tree still differs.
 * `treeRestored` is only ever true after a *verified* comparison.
 *
 * Exported for the half-merge recovery tests; the apply path calls it on every
 * failure after the first mutation, always with `ownedMergeState: false`.
 */
export async function recoverFromFailedMerge(
  root: string,
  preMerge: { readonly treeHash?: string; readonly statusFingerprint: string },
  options: { readonly ownedMergeState?: boolean } = {},
): Promise<MergeRecovery> {
  const notes: string[] = []
  let aborted = false
  let resetApplied = false

  const stateBefore = await inspectMergeState(root)
  if (stateBefore.mergeHead && options.ownedMergeState !== true) {
    return {
      aborted: false,
      resetApplied: false,
      treeRestored: false,
      compensated: false,
      statusRestored: false,
      mergeStatePresent: true,
      foreignMergeDetected: true,
      notes: [
        'a merge this call did not start is in progress (MERGE_HEAD present); it was left untouched',
      ],
    }
  }

  if (stateBefore.mergeHead) {
    const abort = await git(root, ['merge', '--abort'])
    aborted = abort.ok
    if (!abort.ok) notes.push(`git merge --abort failed: ${firstLine(abort.stderr)}`)
  }

  const reset = await git(root, ['reset', '--merge'])
  resetApplied = reset.ok
  if (!reset.ok) notes.push(`git reset --merge failed: ${firstLine(reset.stderr)}`)

  // A squashed merge leaves MERGE_MSG behind even though MERGE_HEAD never
  // existed; drop it so a later `git merge`/`git commit` cannot adopt it.
  await removeMergeArtifacts(root)

  let compensated = false
  let restoredTree: string | undefined
  let restoreFailed: { reason: string; checkpoint?: string } | undefined
  let treeRestored = false

  if (preMerge.treeHash === undefined) {
    notes.push('no pre-merge checkpoint: the tree could not be verified')
    restoreFailed = { reason: 'pre_merge_checkpoint_unavailable' }
  } else {
    const observed = await captureGitCheckpoint(root, 'merge-recovery')
    if (observed.ok && observed.treeHash === preMerge.treeHash) {
      treeRestored = true
      restoredTree = preMerge.treeHash
    } else {
      compensated = true
      const restore = await restoreGitCheckpoint(root, preMerge.treeHash)
      const recheck = await captureGitCheckpoint(root, 'merge-recovery')
      if (restore.ok && recheck.ok && recheck.treeHash === preMerge.treeHash) {
        treeRestored = true
        restoredTree = preMerge.treeHash
      } else {
        restoreFailed = {
          reason: restore.reason ?? 'restore did not reproduce the pre-merge tree',
          checkpoint: preMerge.treeHash,
        }
      }
    }
  }

  // A compensated restore rewrites file content, not the staging area; the
  // pre-merge index was required to be clean, so the status fingerprint is
  // reproducible. Report the comparison instead of assuming it.
  const statusAfter = await readStatus(root)
  const statusRestored =
    statusAfter.ok && statusFingerprint(statusAfter.value) === preMerge.statusFingerprint
  if (!statusAfter.ok) notes.push(statusAfter.reason)
  else if (!statusRestored) notes.push('git status differs from the pre-merge fingerprint')

  const state = await inspectMergeState(root)
  const mergeStatePresent = state.mergeHead || state.mergeMsg

  return {
    aborted,
    resetApplied,
    treeRestored,
    compensated,
    ...(restoredTree !== undefined ? { restoredTree } : {}),
    ...(restoreFailed !== undefined ? { restoreFailed } : {}),
    statusRestored,
    mergeStatePresent,
    ...(compensated
      ? {
          restoreLimitation:
            "the checkpoint covers tracked files and non-ignored untracked files; a .gitignore'd file the merge created was not removed",
        }
      : {}),
    notes,
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function leaseConflictsFor(
  files: readonly string[],
  leases: readonly FileLeaseRecord[],
  callerSessionID: string | undefined,
): MergeLeaseConflict[] {
  const conflicts: MergeLeaseConflict[] = []
  for (const lease of leases) {
    if (callerSessionID && lease.sessionID === callerSessionID) continue
    for (const file of files) {
      if (!leaseClaimsPath(lease, file)) continue
      conflicts.push({ file, holder: lease.role || lease.sessionID, source: 'lease' })
    }
  }
  return conflicts
}

/** Other live `pantheon/eph/*` branches whose own diff overlaps `files`. */
async function branchConflictsFor(
  root: string,
  files: readonly string[],
  branch: string,
  stepKey: string,
  mergedSteps: ReadonlySet<string>,
  warnings: string[],
): Promise<MergeLeaseConflict[]> {
  const refs = await git(root, [
    'for-each-ref',
    '--format=%(refname:short)',
    `refs/heads/${EPH_BRANCH_PREFIX}`,
  ])
  if (!refs.ok) return []
  const others = refs.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== branch)
  const conflicts: MergeLeaseConflict[] = []
  for (const other of others) {
    const otherKey = other.slice(EPH_BRANCH_PREFIX.length)
    if (otherKey === stepKey) continue
    if (mergedSteps.has(otherKey)) continue
    const baseRes = await git(root, ['merge-base', 'HEAD', `refs/heads/${other}`])
    const baseSha = baseRes.stdout.trim()
    if (!baseRes.ok || !/^[0-9a-f]{40,64}$/.test(baseSha)) {
      warnings.push(`branch ${other} has no merge base with HEAD; overlap not assessed`)
      continue
    }
    const otherFiles = await changedFiles(root, baseSha, `refs/heads/${other}`)
    if (!otherFiles.ok) {
      warnings.push(`branch ${other} diff unavailable: ${otherFiles.reason}`)
      continue
    }
    for (const file of otherFiles.value.filter((entry) => files.includes(entry))) {
      conflicts.push({ file, holder: other, source: 'branch' })
    }
  }
  return conflicts
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

function refuse(
  base: Pick<MergeEphemeralResult, 'mode' | 'stepKey'>,
  error: string,
  extra: Partial<MergeEphemeralResult> = {},
): MergeEphemeralResult {
  return { ...base, ok: false, error, noOp: true, ...extra }
}

/**
 * Preview, apply, or discard the merge of `pantheon/eph/<stepKey>` into the
 * caller's checkout. See the module docs for the invariants.
 */
export async function mergeEphemeralStep(
  input: MergeEphemeralInput,
): Promise<MergeEphemeralResult> {
  const mode: MergeMode =
    input.mode === 'apply' || input.mode === 'discard' || input.mode === 'preview'
      ? input.mode
      : 'preview'
  const stepKey = input.stepKey
  const base = { mode, stepKey } as const
  const now = input.now ?? Date.now()

  if (input.mode !== undefined && input.mode !== mode) {
    return refuse(base, 'invalid_mode', {
      message: `mode must be one of preview|apply|discard (got "${String(input.mode)}")`,
    })
  }
  if (input.cascade === true) {
    return refuse(base, 'unsupported_option', {
      message:
        'cascade is a rollback_step option; merge_ephemeral refuses it instead of silently ignoring a flag you expected to change behaviour.',
    })
  }

  const root = resolve(input.cwd)
  const sharedRoot = resolveSharedPantheonRoot(root)
  const warnings: string[] = []

  if (!(await isGitWorkspace(root))) {
    return refuse(base, 'not_a_git_repository', {
      message: `${root} is not inside a git work tree`,
    })
  }

  const headNow = await resolveCommit(root, 'HEAD')
  if (!headNow) {
    return refuse(base, 'detached_head', { message: 'HEAD does not resolve to a commit' })
  }
  const symbolic = await git(root, ['symbolic-ref', '-q', 'HEAD'])
  if (!symbolic.ok) {
    return refuse(base, 'detached_head', {
      head: headNow,
      message: 'HEAD is detached; a squash merge here would strand the result.',
    })
  }
  const currentBranch = symbolic.stdout.trim()

  const store = readStepLedger(sharedRoot)
  const entry = store.steps[stepKey]
  if (!entry) {
    return refuse(base, 'step_not_found', {
      head: headNow,
      message: `Step "${stepKey}" is not initialized in ${sharedRoot}`,
    })
  }

  const branch = entry.ephemeral?.branch
  if (!branch) {
    return refuse(base, 'missing_branch', {
      head: headNow,
      hint: 'spawn_ephemeral records ephemeral.branch on the ledger entry after a preserve; re-run the worker or set it explicitly.',
    })
  }
  // The ledger is a user-editable file, so the branch is untrusted input to git.
  // Only a plain `pantheon/eph/*` ref is accepted: anything else could be read as
  // a git option or resolve outside the worker branch namespace.
  if (
    !branch.startsWith(EPH_BRANCH_PREFIX) ||
    !SAFE_EPH_BRANCH_RE.test(branch) ||
    branch.includes('..')
  ) {
    return refuse(base, 'invalid_branch', {
      branch,
      head: headNow,
      message: `ephemeral.branch must be a plain ${EPH_BRANCH_PREFIX}* branch name (got "${branch}")`,
      hint: 'A hand-edited ledger entry is refused before any git call; restore the worker branch name recorded by spawn_ephemeral.',
    })
  }
  if (branch === currentBranch) {
    return refuse(base, 'branch_is_head', {
      branch,
      head: headNow,
      message: 'The branch to merge is the checked-out branch.',
    })
  }

  // A short name is ambiguous: git resolves `pantheon/eph/x` as
  // `refs/<name>` → `refs/tags/<name>` → `refs/heads/<name>`, so a same-named
  // tag (or a `refs/pantheon/eph/...` ref) can shadow the worker branch. Every
  // git call below uses `branchRef`; this guard refuses when the short name does
  // not resolve to the branch either, so the ambiguity is never silent.
  const branchRef = `refs/heads/${branch}`
  const branchCommit = await resolveCommit(root, branchRef)
  if (!branchCommit) {
    return refuse(base, 'branch_missing', {
      branch,
      head: headNow,
      hint: 'The preserved branch no longer exists; there is nothing to merge or discard.',
    })
  }
  const branchSymbolic = await git(root, ['rev-parse', '--symbolic-full-name', branch])
  if (!branchSymbolic.ok || branchSymbolic.stdout.trim() !== branchRef) {
    return refuse(base, 'ambiguous_branch', {
      branch,
      head: headNow,
      message: `"${branch}" does not resolve unambiguously to ${branchRef} (a tag or another ref shadows it).`,
      hint: `Remove the shadowing ref (\`git tag -d ${branch}\`, or the refs/pantheon/... entry) and re-run; the reviewed content must be the branch, never a same-named ref.`,
    })
  }

  const recordedBase = entry.ephemeral?.baseHead
  if (!recordedBase) {
    return refuse(base, 'missing_base_head', {
      branch,
      head: headNow,
      hint: 'ephemeral.baseHead is required: without it the drift and content checks cannot be bound to the branch.',
    })
  }
  // Resolve once to a sha and use that sha in every comparison: `baseHead` can
  // be a sha, a ref, or an abbreviation, and pinning it removes the second
  // resolution (and the chance that it means something different by then).
  const baseHead = await resolveCommit(root, recordedBase)
  if (!baseHead) {
    return refuse(base, 'unknown_base_head', {
      branch,
      baseHead: recordedBase,
      head: headNow,
      hint: 'ephemeral.baseHead is not a commit in this repository (history rewritten or wrong checkout).',
    })
  }

  const digest = await diffDigest(root, baseHead, branchRef)
  if (!digest.ok) {
    return refuse(base, 'diff_unavailable', {
      branch,
      baseHead,
      head: headNow,
      message: digest.reason,
      hint: 'The branch diff could not be computed, so neither the drift check nor the token can be bound to content. Fix the repository state (corrupt object/index) and re-run.',
    })
  }
  const computedToken = computeMergeToken({
    stepKey,
    branch,
    baseHead,
    head: headNow,
    diffDigest: digest.value,
  })
  const storeKey = tokenStoreKey(root, stepKey)

  // ---- discard: branch deletion only, so local dirt must not block it -----
  if (mode === 'discard') {
    return discardEphemeralBranch({
      base,
      root,
      sharedRoot,
      stepKey,
      branch,
      baseHead,
      headNow,
      storeKey,
      computedToken,
      presented: input.confirmToken,
      now,
    })
  }

  const statusRead = await readStatus(root)
  if (!statusRead.ok) {
    return refuse(base, 'status_unavailable', {
      branch,
      baseHead,
      head: headNow,
      message: statusRead.reason,
      hint: 'git cannot report the working tree (corrupt index, unreadable repository), so "clean" would be a guess. Repair the index (`git reset`) and re-run.',
    })
  }
  const statusEntries = statusRead.value
  const statusPrint = statusFingerprint(statusEntries)
  const dirty = dirtyPaths(statusEntries)
  const staged = stagedPaths(statusEntries)

  const mergeFilesRead = await changedFiles(root, baseHead, branchRef)
  if (!mergeFilesRead.ok) {
    return refuse(base, 'diff_unavailable', {
      branch,
      baseHead,
      head: headNow,
      message: mergeFilesRead.reason,
      hint: 'The branch diff could not be computed, so the overlap checks would be a guess. Fix the repository state and re-run.',
    })
  }
  const mergeFiles = mergeFilesRead.value

  const driftRead = await commitCount(root, `${baseHead}..HEAD`)
  if (!driftRead.ok) {
    return refuse(base, 'drift_unavailable', {
      branch,
      baseHead,
      head: headNow,
      message: driftRead.reason,
      hint: 'HEAD drift could not be measured, so the merge is refused rather than assumed drift-free.',
    })
  }
  const driftCommits = driftRead.value
  let headDrift: MergeHeadDrift | undefined
  if (driftCommits > 0) {
    const driftFiles = await changedFiles(root, baseHead, 'HEAD')
    if (!driftFiles.ok) {
      return refuse(base, 'drift_unavailable', {
        branch,
        baseHead,
        head: headNow,
        message: driftFiles.reason,
      })
    }
    headDrift = { commits: driftCommits, files: driftFiles.value }
  }

  const dirtySet = new Set(dirty)
  const leaseConflicts: MergeLeaseConflict[] = mergeFiles
    .filter((file) => dirtySet.has(file))
    .map((file) => ({ file, holder: 'working-tree', source: 'dirty' as const }))
  leaseConflicts.push(
    ...leaseConflictsFor(mergeFiles, listActiveLeases({ rootDir: root }), input.sessionID),
  )
  const mergedSteps = new Set(
    Object.values(store.steps)
      .filter((step) => Boolean(step.ephemeral?.mergedAt))
      .map((step) => step.stepKey),
  )
  leaseConflicts.push(
    ...(await branchConflictsFor(root, mergeFiles, branch, stepKey, mergedSteps, warnings)),
  )

  // ---- A merge that is not ours -------------------------------------------
  // `git merge --squash` never creates MERGE_HEAD, so an in-progress merge here
  // belongs to the user (or a concurrent writer). A `--no-commit` merge whose
  // result is net-zero leaves a clean status, so the dirty gate cannot catch it:
  // this has to be asked explicitly, before anything is touched.
  const mergeStateBefore = await inspectMergeState(root)
  const mergeInProgress = mergeStateBefore.mergeHead || mergeStateBefore.mergeMsg

  // ---- Preview minting happens BEFORE the preview attempt ------------------
  // The token is a content binding, not an approval: a preview that cannot run
  // must still leave the caller able to `discard` the branch.
  if (mode === 'preview') {
    tokenStore().set(storeKey, {
      token: computedToken,
      fingerprint: `${stepKey}|${branch}|${baseHead}|${headNow}|${digest.value}`,
      stepKey,
      branch,
      expiresAt: now + MERGE_TOKEN_TTL_MS,
      consumed: false,
    })
  }

  // ---- Clean preview (never the user's tree) -----------------------------
  const preview = await previewMerge(root, branchRef, stepKey, input.forceLegacyPreview === true)
  if (!preview.ok) {
    return refuse(base, 'preview_failed', {
      branch,
      baseHead,
      head: headNow,
      changes: mergeFiles,
      previewVia: preview.via,
      ...(preview.error ? { message: preview.error } : {}),
      // The merge could not be rehearsed, so it cannot be authorised — but the
      // single-use token stays usable for `discard`, which needs only the branch.
      ...(mode === 'preview'
        ? {
            token: computedToken,
            tokenExpiresAt: new Date(now + MERGE_TOKEN_TTL_MS).toISOString(),
            tokenValid: true,
            hint: 'The merge preview failed, so apply is not authorised; the token is still usable for mode:"discard".',
          }
        : { tokenValid: false }),
    })
  }

  const blockers: string[] = []
  if (mergeInProgress) blockers.push('merge_in_progress')
  if (staged.length > 0) blockers.push('dirty_index')
  else if (input.allowDirty !== true && dirty.length > 0) blockers.push('worktree_dirty')
  if (headDrift) blockers.push('head_drift')
  if (leaseConflicts.length > 0) blockers.push('lease_conflict')
  if (mergeFiles.length === 0) blockers.push('nothing_to_merge')
  if (!preview.clean) blockers.push('merge_conflict')

  // ---- Preview: report ----------------------------------------------------
  if (mode === 'preview') {
    const statusAfterRead = await readStatus(root)
    const statusAfter = statusAfterRead.ok ? statusFingerprint(statusAfterRead.value) : undefined
    const headAfter = await resolveCommit(root, 'HEAD')
    const commitsRead = await commitCount(root, `${headNow}..${branchRef}`)
    const result: MergeEphemeralResult = {
      ok: true,
      ...base,
      branch,
      baseHead,
      head: headNow,
      ...(commitsRead.ok ? { commits: commitsRead.value } : {}),
      changes: mergeFiles,
      clean: preview.clean,
      ...(preview.mergeTree ? { mergeTree: preview.mergeTree } : {}),
      previewVia: preview.via,
      conflicts: preview.conflicts,
      ...(headDrift ? { headDrift } : {}),
      ...(leaseConflicts.length > 0 ? { leaseConflicts } : {}),
      blockers,
      readyToApply: blockers.length === 0,
      token: computedToken,
      tokenExpiresAt: new Date(now + MERGE_TOKEN_TTL_MS).toISOString(),
      tokenValid: true,
      treeUntouched: statusAfter === statusPrint && headAfter === headNow,
      noOp: true,
      ...(statusAfterRead.ok ? {} : { warnings: [...warnings, statusAfterRead.reason] }),
      ...(warnings.length > 0 ? { warnings } : {}),
    }
    return result
  }

  // ---- Apply: refuse before mutating -------------------------------------
  if (mergeInProgress) {
    return refuse(base, 'merge_in_progress', {
      branch,
      baseHead,
      head: headNow,
      changes: mergeFiles,
      message: `A merge is already in progress in this checkout (MERGE_HEAD${mergeStateBefore.mergeMsg ? ' + MERGE_MSG' : ''}); it was left untouched.`,
      hint: 'Finish or abort that merge first (`git merge --continue` / `git merge --abort`), then re-run. This gate never aborts a merge it did not start.',
    })
  }
  if (staged.length > 0) {
    // `git merge --squash` refuses with a dirty index, and `git reset --merge`
    // discards staged content irrecoverably — an index with staged entries can
    // never be restored exactly, so this is not an `allowDirty` case.
    return refuse(base, 'dirty_index', {
      branch,
      baseHead,
      head: headNow,
      changes: mergeFiles,
      message:
        'The index has staged changes; commit or stash them first (they cannot be restored after a merge attempt).',
    })
  }
  if (input.allowDirty !== true && dirty.length > 0) {
    return refuse(base, 'worktree_dirty', {
      branch,
      baseHead,
      head: headNow,
      changes: mergeFiles,
      message: `The working tree has ${dirty.length} local change(s); pass allowDirty:true to merge over them.`,
    })
  }
  if (headDrift) {
    return refuse(base, 'head_drift', {
      branch,
      baseHead,
      head: headNow,
      commits: headDrift.commits,
      changes: mergeFiles,
      headDrift,
      tokenValid: false,
      hint: 'HEAD moved past ephemeral.baseHead; the worker verdict no longer covers this tree. Re-verify against the new HEAD, then re-run preview.',
    })
  }
  if (leaseConflicts.length > 0) {
    return refuse(base, 'lease_conflict', {
      branch,
      baseHead,
      head: headNow,
      changes: mergeFiles,
      leaseConflicts,
      hint: 'Another claim covers these files (local edits, another session lease, or a second live ephemeral branch). Resolve it before merging.',
    })
  }
  if (mergeFiles.length === 0) {
    return refuse(base, 'nothing_to_merge', {
      branch,
      baseHead,
      head: headNow,
      hint: 'The branch has no changes against its recorded base; only discard can remove it.',
    })
  }

  const verdict = validateToken(storeKey, input.confirmToken, computedToken, now)
  if (!verdict.ok) {
    return refuse(base, 'confirm_token_required', {
      branch,
      baseHead,
      head: headNow,
      changes: mergeFiles,
      clean: preview.clean,
      ...(preview.mergeTree ? { mergeTree: preview.mergeTree } : {}),
      previewVia: preview.via,
      conflicts: preview.conflicts,
      tokenValid: false,
      message: `confirmToken rejected: ${verdict.reason ?? 'invalid'}`,
      ...(verdict.hint ? { hint: verdict.hint } : {}),
    })
  }
  if (!preview.clean) {
    return refuse(base, 'merge_conflict', {
      branch,
      baseHead,
      head: headNow,
      changes: mergeFiles,
      clean: false,
      conflicts: preview.conflicts,
      ...(preview.mergeTree ? { mergeTree: preview.mergeTree } : {}),
      previewVia: preview.via,
      tokenValid: true,
      hint: 'The preview found conflicts; nothing was touched. Resolve them on the branch and re-preview.',
    })
  }

  return applyMerge({
    base,
    root,
    sharedRoot,
    stepKey,
    branch,
    branchRef,
    baseHead,
    headNow,
    statusPrint,
    mergeFiles,
    preview,
    storeKey,
    currentBranch,
    warnings,
    input,
    now,
  })
}

interface MergeApplyContext {
  readonly base: Pick<MergeEphemeralResult, 'mode' | 'stepKey'>
  readonly root: string
  readonly sharedRoot: string
  readonly stepKey: string
  readonly branch: string
  readonly branchRef: string
  readonly baseHead: string
  readonly headNow: string
  readonly statusPrint: string
  readonly mergeFiles: readonly string[]
  readonly preview: MergePreview
  readonly storeKey: string
  readonly currentBranch: string
  readonly warnings: readonly string[]
  readonly input: MergeEphemeralInput
  readonly now: number
}

/**
 * The mutation window of `apply`. Everything from the checkpoint to the ledger
 * write runs under one lock so two applies can never interleave (the ledger's own
 * lock only protects the ledger file, not the worktree), and the state is
 * re-verified *inside* the lock because a writer queued behind us may have
 * changed HEAD while we waited.
 */
async function applyMerge(ctx: MergeApplyContext): Promise<MergeEphemeralResult> {
  const {
    base,
    root,
    sharedRoot,
    stepKey,
    branch,
    branchRef,
    baseHead,
    headNow,
    statusPrint,
    mergeFiles,
    preview,
    storeKey,
    input,
  } = ctx
  const lockPath = join(sharedRoot, '.pantheon', MERGE_LOCK_NAME)
  mkdirSync(dirname(lockPath), { recursive: true })
  let locked: { ok: true; value: MergeEphemeralResult } | { ok: false; error: unknown }
  try {
    const value = await withExclusiveLedgerLock(lockPath, async () => {
      // `preMerge` outlives a throw so an unexpected failure inside the window can
      // still be compensated against a real checkpoint.
      let preMerge: { ok: boolean; treeHash?: string } | undefined
      try {
        if (input.onAfterLock) await input.onAfterLock()

        // Burn the token before mutating: a failed attempt still requires a fresh
        // preview, because the tree may have been touched transiently (rerere,
        // index). Pre-flight refusals happen before this point, so they keep it.
        const record = tokenStore().get(storeKey)
        if (record) record.consumed = true

        const headSeen = await resolveCommit(root, 'HEAD')
        if (headSeen !== headNow) {
          return refuse(base, 'head_changed', {
            branch,
            baseHead,
            head: headSeen ?? headNow,
            changes: mergeFiles,
            tokenValid: false,
            message: `HEAD changed while this apply waited for the merge lock (${headNow.slice(0, 12)} -> ${(headSeen ?? 'unknown').slice(0, 12)}).`,
            hint: 'Nothing was merged. Re-run mode:"preview" against the new HEAD.',
          })
        }
        const statusRecheck = await readStatus(root)
        if (!statusRecheck.ok || statusFingerprint(statusRecheck.value) !== statusPrint) {
          return refuse(base, 'worktree_changed', {
            branch,
            baseHead,
            head: headNow,
            changes: mergeFiles,
            message: statusRecheck.ok
              ? 'The working tree changed while this apply waited for the merge lock.'
              : statusRecheck.reason,
            hint: 'Nothing was merged. Re-run mode:"preview" once the checkout is stable.',
          })
        }

        const preMergeSnapshot = await captureGitCheckpoint(root, `${stepKey}-pre-merge`)
        preMerge = preMergeSnapshot
        if (!preMergeSnapshot.ok || !preMergeSnapshot.treeHash) {
          return refuse(base, 'checkpoint_failed', {
            branch,
            baseHead,
            head: headNow,
            tokenValid: true,
            message: `Could not capture the pre-merge checkpoint: ${preMergeSnapshot.reason ?? 'unknown error'}`,
            hint: 'Refusing to merge without a restore point.',
          })
        }

        if (input.onBeforeMerge) await input.onBeforeMerge()

        const merge = await git(root, ['merge', '--squash', '--no-edit', branchRef])
        if (!merge.ok) {
          const unmerged = await git(root, ['diff', '--name-only', '-z', '--diff-filter=U'])
          const recovery = await recoverFromFailedMerge(root, {
            ...(preMergeSnapshot.treeHash ? { treeHash: preMergeSnapshot.treeHash } : {}),
            statusFingerprint: statusPrint,
          })
          return {
            ...base,
            ok: false,
            error: 'merge_conflict',
            branch,
            baseHead,
            head: headNow,
            changes: mergeFiles,
            clean: false,
            conflicts: splitNul(unmerged.stdout),
            previewVia: preview.via,
            ...(preview.mergeTree ? { mergeTree: preview.mergeTree } : {}),
            tokenValid: true,
            noOp: recovery.treeRestored && !recovery.mergeStatePresent,
            treeUntouched: false,
            recovery,
            treeRestored: recovery.treeRestored,
            ...(recovery.restoredTree ? { restoredTree: recovery.restoredTree } : {}),
            ...(recovery.restoreFailed ? { restoreFailed: recovery.restoreFailed } : {}),
            message: `git merge --squash failed: ${firstLine(merge.stderr) || firstLine(merge.stdout)}`,
            hint: recovery.foreignMergeDetected
              ? 'A merge started by someone else appeared mid-apply; it was left untouched. This call changed nothing further.'
              : recovery.treeRestored
                ? 'The worktree is back in its exact pre-merge state and no merge is in progress.'
                : 'The worktree could NOT be fully restored — recover it from recovery.restoreFailed.checkpoint.',
          }
        }

        return finishMerge(ctx, preMergeSnapshot)
      } catch (err: unknown) {
        // An unexpected failure inside the mutation window: compensate with the
        // checkpoint if we have one, and never pretend nothing happened.
        const recovery = preMerge?.treeHash
          ? await recoverFromFailedMerge(root, {
              treeHash: preMerge.treeHash,
              statusFingerprint: statusPrint,
            })
          : undefined
        return {
          ...base,
          ok: false,
          error: 'merge_failed',
          branch,
          baseHead,
          head: headNow,
          changes: mergeFiles,
          tokenValid: true,
          ...(recovery ? { recovery, treeRestored: recovery.treeRestored } : {}),
          ...(recovery?.restoredTree ? { restoredTree: recovery.restoredTree } : {}),
          ...(recovery?.restoreFailed ? { restoreFailed: recovery.restoreFailed } : {}),
          noOp: recovery ? recovery.treeRestored && !recovery.mergeStatePresent : false,
          treeUntouched: false,
          message: `unexpected failure inside the merge window: ${err instanceof Error ? err.message : String(err)}`,
          hint: recovery?.treeRestored
            ? 'The worktree was restored to its pre-merge state.'
            : 'The worktree state is unknown — inspect `git status` before retrying.',
        }
      }
    })
    locked = { ok: true, value }
  } catch (err: unknown) {
    locked = { ok: false, error: err }
  }
  if (locked.ok) return locked.value

  const detail = locked.error instanceof Error ? locked.error.message : String(locked.error)
  const isLockError = locked.error instanceof StepLedgerLockError
  return refuse(base, isLockError ? 'merge_busy' : 'merge_failed', {
    branch,
    baseHead,
    head: headNow,
    changes: mergeFiles,
    tokenValid: false,
    message: isLockError
      ? `another merge is in progress in this checkout: ${detail}`
      : `the merge lock could not be taken: ${detail}`,
    hint: isLockError
      ? 'Nothing was merged and the other merge was left alone. Retry once it finishes (the lock is released in its finally block), or remove a stale .ephemeral-merge.lock after confirming no merge is running.'
      : 'Nothing was merged. Check the checkout and ledger, then retry.',
    noOp: true,
    treeUntouched: true,
  })
}

async function finishMerge(
  ctx: MergeApplyContext,
  preMerge: { readonly ok: boolean; readonly treeHash?: string },
): Promise<MergeEphemeralResult> {
  const {
    base,
    root,
    sharedRoot,
    stepKey,
    branch,
    baseHead,
    headNow,
    statusPrint,
    mergeFiles,
    preview,
    currentBranch,
    warnings,
    input,
    now,
  } = ctx

  let committed = false
  let commitHash: string | undefined
  let commitError: string | undefined
  if (input.commit === true) {
    const message = `chore(pantheon): merge ${branch} for step ${stepKey}`
    let commit = await git(root, ['commit', '-m', message])
    if (!commit.ok) {
      // Honour user hooks on the first attempt; only the fallback identity is
      // imposed, never `--no-verify` (a rejected hook must be able to stop us).
      commit = await git(root, [
        '-c',
        'user.name=Pantheon',
        '-c',
        'user.email=pantheon@local',
        'commit',
        '-m',
        message,
      ])
    }
    if (commit.ok) {
      committed = true
      commitHash = await resolveCommit(root, 'HEAD')
    } else {
      commitError = firstLine(commit.stderr) || firstLine(commit.stdout) || 'git commit failed'
    }
  }

  if (input.commit === true && !committed) {
    // The caller asked for a commit and the commit did not happen (a user hook
    // rejected it, or the identity was unusable). Leaving the squash staged
    // would be a half-applied merge, so undo it and say so.
    const recovery = await recoverFromFailedMerge(root, {
      ...(preMerge.treeHash ? { treeHash: preMerge.treeHash } : {}),
      statusFingerprint: statusPrint,
    })
    return {
      ...base,
      ok: false,
      error: 'commit_failed',
      branch,
      baseHead,
      head: headNow,
      changes: mergeFiles,
      tokenValid: true,
      recovery,
      noOp: recovery.treeRestored && !recovery.mergeStatePresent,
      treeRestored: recovery.treeRestored,
      ...(recovery.restoredTree ? { restoredTree: recovery.restoredTree } : {}),
      ...(recovery.restoreFailed ? { restoreFailed: recovery.restoreFailed } : {}),
      message: `commit:true was requested but git commit failed: ${commitError ?? 'unknown error'}`,
      hint: recovery.treeRestored
        ? 'The squash was undone and the worktree is back in its exact pre-merge state.'
        : 'The worktree could NOT be fully restored — recover it from recovery.restoreFailed.checkpoint.',
    }
  }

  if (!committed) {
    // D05: review-first. `git reset` (mixed) keeps the merge content in the
    // worktree and makes the index match HEAD again.
    const unstaged = await git(root, ['reset'])
    if (!unstaged.ok) {
      const recovery = await recoverFromFailedMerge(root, {
        ...(preMerge.treeHash ? { treeHash: preMerge.treeHash } : {}),
        statusFingerprint: statusPrint,
      })
      return {
        ...base,
        ok: false,
        error: 'unstage_failed',
        branch,
        baseHead,
        head: headNow,
        changes: mergeFiles,
        tokenValid: true,
        recovery,
        // Post-mutation: the squash ran, so `noOp` is only true when the recovery
        // verified the tree is back.
        noOp: recovery.treeRestored && !recovery.mergeStatePresent,
        treeUntouched: false,
        treeRestored: recovery.treeRestored,
        ...(recovery.restoredTree ? { restoredTree: recovery.restoredTree } : {}),
        ...(recovery.restoreFailed ? { restoreFailed: recovery.restoreFailed } : {}),
        message: `git reset failed after the squash: ${firstLine(unstaged.stderr)}`,
        hint: recovery.treeRestored
          ? 'The squash was undone and the worktree is back in its exact pre-merge state.'
          : 'The worktree could NOT be fully restored — recover it from recovery.restoreFailed.checkpoint.',
      }
    }
  }

  // A squash merge never leaves MERGE_HEAD; make the absence a post-condition
  // rather than an assumption (and clear a stray MERGE_MSG if git wrote one).
  await removeMergeArtifacts(root)
  const finalState = await inspectMergeState(root)

  const mergedAt = new Date(now).toISOString()
  const mergeTree = preview.mergeTree ?? (await resolveCommit(root, 'HEAD^{tree}'))

  // The merge has landed. A ledger write failure must never be reported as a
  // failed merge: the caller would re-run the merge on an already-merged tree.
  let recorded: { recorded: boolean; step?: unknown } = { recorded: false }
  let metadataError: string | undefined
  try {
    recorded = updateStepLedger(sharedRoot, (ledger) => {
      const target = ledger.steps[stepKey]
      if (!target) return { recorded: false as const, error: 'step_not_found' }
      const ephemeral: EphemeralStepMetadata = {
        ...target.ephemeral,
        branch,
        baseHead,
        ...(mergeTree ? { mergeTree } : {}),
        mergedAt,
        role: target.ephemeral?.role ?? target.agent,
      }
      delete ephemeral.discardedAt
      target.ephemeral = ephemeral
      target.updatedAt = mergedAt
      return { recorded: true as const, step: target }
    })
  } catch (err: unknown) {
    const structured = describeLedgerError(err)
    metadataError = structured
      ? `${structured.error}: ${structured.detail}`
      : err instanceof Error
        ? err.message
        : String(err)
  }

  getSharedBus().emit('step:merge', {
    stepKey,
    branch,
    baseHead,
    head: headNow,
    mode: 'apply',
    ...(mergeTree ? { mergeTree } : {}),
    mergedAt,
    committed,
    ...(commitHash ? { commit: commitHash } : {}),
    timestamp: now,
  })

  const targetStep = recorded.step as
    | { ephemeral?: EphemeralStepMetadata; agent?: string }
    | undefined
  const workerRole = recorded.recorded
    ? (targetStep?.ephemeral?.role ?? targetStep?.agent ?? 'zeus')
    : 'zeus'
  try {
    await appendBoardMessage(sharedRoot, {
      channel: 'swarm',
      threadId: stepKey,
      stepKey,
      from: 'zeus',
      to: [workerRole],
      tag: 'done',
      body: committed
        ? `[done] @${workerRole} merged ${branch} into ${currentBranch} as commit ${commitHash?.slice(0, 12) ?? '(unknown)'}`
        : `[done] @${workerRole} merged ${branch} into ${currentBranch} (squash, changes left unstaged for review)`,
    })
  } catch {
    /* best-effort board post */
  }

  const result: MergeEphemeralResult = {
    ...base,
    ok: true,
    branch,
    baseHead,
    head: headNow,
    changes: mergeFiles,
    clean: true,
    ...(mergeTree ? { mergeTree } : {}),
    previewVia: preview.via,
    tokenValid: true,
    committed,
    ...(commitHash ? { commitHash } : {}),
    unstaged: !committed,
    branchKept: true,
    mergedAt,
    metadataRecorded: recorded.recorded,
    ...(metadataError ? { metadataError } : {}),
    ...(metadataError
      ? {
          hint: 'The merge landed in the working tree; only the ledger metadata is missing. Re-record it with pantheon_step_ledger(action:"merge_ephemeral", mode:"preview") + apply once the ledger lock clears — do NOT re-run the merge.',
        }
      : {}),
    noOp: false,
    treeUntouched: false,
    ...(recorded.recorded && recorded.step ? { step: recorded.step } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
  }
  if (finalState.mergeHead || finalState.mergeMsg) {
    return {
      ...result,
      ok: false,
      error: 'merge_state_left_behind',
      noOp: false,
      treeUntouched: false,
      message:
        'MERGE_HEAD/MERGE_MSG survived a successful squash; inspect the checkout before committing.',
      hint: 'The squash landed (see mergeTree/mergedAt/unstaged). Remove the stray .git/MERGE_HEAD or .git/MERGE_MSG only after confirming no merge is in progress.',
    }
  }
  return result
}

interface DiscardInput {
  readonly base: Pick<MergeEphemeralResult, 'mode' | 'stepKey'>
  readonly root: string
  readonly sharedRoot: string
  readonly stepKey: string
  readonly branch: string
  readonly baseHead: string
  readonly headNow: string
  readonly storeKey: string
  readonly computedToken: string
  readonly presented: string | undefined
  readonly now: number
}

async function discardEphemeralBranch(input: DiscardInput): Promise<MergeEphemeralResult> {
  const { base, root, sharedRoot, stepKey, branch, baseHead, headNow, storeKey, now } = input
  const verdict = validateToken(storeKey, input.presented, input.computedToken, now)
  if (!verdict.ok) {
    return refuse(base, 'confirm_token_required', {
      branch,
      baseHead,
      head: headNow,
      branchKept: true,
      tokenValid: false,
      message: `confirmToken rejected: ${verdict.reason ?? 'invalid'}`,
      ...(verdict.hint ? { hint: verdict.hint } : {}),
    })
  }

  const record = tokenStore().get(storeKey)
  if (record) record.consumed = true

  // `git branch -D` accepts only a branch name (a full ref errors), and it
  // resolves inside `refs/heads/` alone — it also refuses a branch checked out in
  // another worktree, which `update-ref -d` would not. The ambiguity guard above
  // already refused a short name that resolves to anything but the branch.
  const deleted = await git(root, ['branch', '-D', branch])
  if (!deleted.ok) {
    return refuse(base, 'discard_failed', {
      branch,
      baseHead,
      head: headNow,
      branchKept: true,
      tokenValid: true,
      message: `git branch -D failed: ${firstLine(deleted.stderr)}`,
    })
  }

  const discardedAt = new Date(now).toISOString()
  const recorded = updateStepLedger(sharedRoot, (ledger) => {
    const target = ledger.steps[stepKey]
    if (!target) return { recorded: false as const }
    target.ephemeral = { ...target.ephemeral, branch, baseHead, discardedAt }
    target.updatedAt = discardedAt
    return { recorded: true as const, step: target }
  })

  getSharedBus().emit('step:merge', {
    stepKey,
    branch,
    baseHead,
    head: headNow,
    mode: 'discard',
    discarded: true,
    timestamp: now,
  })

  return {
    ...base,
    ok: true,
    branch,
    baseHead,
    head: headNow,
    tokenValid: true,
    discarded: true,
    branchKept: false,
    noOp: false,
    metadataRecorded: recorded.recorded,
    ...(recorded.recorded && recorded.step ? { step: recorded.step } : {}),
  }
}
