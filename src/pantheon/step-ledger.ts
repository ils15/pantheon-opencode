/**
 * Step-Ledger Execution Mode & Mechanical Completion Gate (`step-ledger.ts`).
 *
 * Implements the Pantheon 2.2.0 Step-Ledger mechanical verification architecture:
 * 1. Workflows decompose into atomic steps identified by a `stepKey`.
 * 2. Every file mutation (`edit`, `write`, `hashline_edit`) bumps `lastMutationAt`
 *    and invalidates prior verification for active steps.
 * 3. A step may transition to `done` ONLY when a verification command exited `0`
 *    AFTER the latest file mutation (`lastVerifiedAt >= lastMutationAt`),
 *    minting a cryptographic Execution Proof Receipt (`execution-receipt.ts`).
 * 4. Failed verifications feed directly into `ThemisReflexController`
 *    (`themis-reflex.ts`) for bounded self-healing.
 *
 * @module pantheon/step-ledger
 */

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { getSharedBus } from './bus.ts'
import {
  deriveEphemeralRoleSlug,
  spawnEphemeralWorker,
  verifyEphemeralBranches,
} from './ephemeral-worker.ts'
import { createExecutionReceipt } from './execution-receipt.ts'
import {
  anchorCheckpointTree,
  captureGitCheckpoint,
  checkpointTreeExists,
  restoreGitCheckpoint,
  stripPantheonFromTree,
} from './git-checkpoint.ts'
import {
  buildDependencyGraph,
  cascadeBlock,
  type DependencyNode,
  type DependencyValidationResult,
  isReservedStepKey,
  normalizeDependencies,
  readyStepKeys,
  unmetDependencies,
  validateDependencies,
} from './step-dependencies.ts'
import { runAtomicStepSubSession, type SubSessionDomainLike } from './step-runner.ts'
import { ThemisReflexController } from './themis-reflex.ts'
import { resolveSharedPantheonRoot, resolveToolCwd } from './tool-context.ts'
import type { PantheonToolDef, PantheonToolResult } from './tools.ts'

export type StepState = 'pending' | 'in_progress' | 'done' | 'blocked' | 'rolled_back'
export type StepTaskType = 'feature' | 'bugfix' | 'refactor' | 'chore'

/**
 * Ephemeral worker metadata (D06: it lives on the ledger entry, never a sidecar).
 * S3 populates the merge fields; S1 only defines and round-trips the shape.
 */
export interface EphemeralStepMetadata {
  branch?: string
  baseHead?: string
  verdict?: string
  mergeTree?: string
  mergedAt?: string
  role?: string
  worktreeDir?: string
}

export interface StepLedgerEntry {
  stepKey: string
  objective: string
  agent: string
  state: StepState
  taskType?: StepTaskType
  baselineTree?: string
  /** Ref anchoring `baselineTree` (`refs/pantheon/step-baselines/<stepKey>`); keeps it GC-safe. */
  baselineRef?: string
  rolledBackAt?: string
  reproductionCommand?: string
  reproductionExitCode?: number
  reproductionRecordedAt?: number
  mutatedFiles: string[]
  lastMutationAt: number | null
  lastVerifiedAt: number | null
  verificationCommand?: string
  verificationExitCode?: number
  /** Number of `record_verification` calls (success and failure) for this step. */
  verificationAttempts?: number
  /**
   * Failed verification calls. `retries = verificationFailures`; a first-try
   * success has `attempts === 1 && failures === 0`.
   */
  verificationFailures?: number
  receiptId?: string
  /** Prerequisite step keys; independent steps of the same wave launch in parallel. */
  dependsOn?: string[]
  /** Immediate prerequisites that justify a mechanical `blocked` state. */
  blockedBy?: string[]
  /** Explicit, never-silent reason a cascade invalidation blocked this step. */
  cascadeReason?: string
  /** Owned file paths/globs (lease boundary + worker prompt contract). */
  ownedFiles?: string[]
  /** File paths/globs the worker must never modify. */
  forbiddenFiles?: string[]
  ephemeral?: EphemeralStepMetadata
  updatedAt: string
}

export interface StepLedgerStore {
  version: 1
  steps: Record<string, StepLedgerEntry>
}

const SAFE_STEP_KEY_RE = /^[a-zA-Z0-9._:-]{1,128}$/
const stepReflex = new ThemisReflexController({ maxRetries: 2 })

function assertSafeStepKey(stepKey: unknown): string {
  if (typeof stepKey !== 'string' || !SAFE_STEP_KEY_RE.test(stepKey) || stepKey.includes('..')) {
    throw new Error('stepKey must be a safe alphanumeric identifier (1..128 chars)')
  }
  // Security: a plain-object store would treat `__proto__` as a prototype
  // setter and silently drop the entry (prototype pollution).
  if (isReservedStepKey(stepKey)) {
    throw new Error(`stepKey "${stepKey}" is reserved and cannot be used as a step id`)
  }
  return stepKey
}

function resolveLedgerPath(workspaceDir: string): string {
  const sharedRoot = resolveSharedPantheonRoot(workspaceDir)
  const dir = join(sharedRoot, '.pantheon', 'ledger')
  mkdirSync(dir, { recursive: true })
  const canonicalDir = realpathSync(dir)
  const filePath = resolve(canonicalDir, 'step-ledger.json')
  const prefix = canonicalDir.endsWith(sep) ? canonicalDir : `${canonicalDir}${sep}`
  if (!filePath.startsWith(prefix)) {
    throw new Error('Path traversal denied for step-ledger.json')
  }
  return filePath
}

/**
 * Parse the on-disk store. A corrupt file is **quarantined**, never silently
 * replaced by an empty store: the next atomic write would otherwise cement the
 * loss of every step. Callers see a loud, actionable error.
 */
function readLedgerFileAtPath(filePath: string): StepLedgerStore {
  if (!existsSync(filePath)) return { version: 1, steps: {} }
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (err) {
    throw new Error(
      `step-ledger cannot be read at ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const quarantine = `${filePath}.corrupt.${Date.now()}`
    try {
      renameSync(filePath, quarantine)
    } catch {
      /* keep the original in place if the rename fails */
    }
    throw new Error(
      `step-ledger is corrupt and was moved aside to ${quarantine} (${err instanceof Error ? err.message : String(err)}). Inspect it and restore a valid ledger before retrying — refusing to overwrite it with an empty store.`,
    )
  }
  const candidate = parsed as Partial<StepLedgerStore> | null
  if (!candidate || typeof candidate.steps !== 'object' || candidate.steps === null) {
    const quarantine = `${filePath}.corrupt.${Date.now()}`
    try {
      renameSync(filePath, quarantine)
    } catch {
      /* keep the original in place if the rename fails */
    }
    throw new Error(
      `step-ledger at ${filePath} has no "steps" object and was moved aside to ${quarantine}. Refusing to overwrite it with an empty store.`,
    )
  }
  return { version: 1, steps: candidate.steps as Record<string, StepLedgerEntry> }
}

export function readStepLedger(workspaceDir: string): StepLedgerStore {
  return readLedgerFileAtPath(resolveLedgerPath(workspaceDir))
}

/** How long a lock may live before it is treated as abandoned by a dead writer. */
const LOCK_STALE_MS = 2_000
/** Total time a writer waits for a live holder before failing with guidance. */
const LOCK_WAIT_BUDGET_MS = 4_000
const LOCK_RETRY_MS = 25
/** Orphan `*.tmp.<pid>` files older than this are garbage-collected. */
const TMP_SWEEP_AGE_MS = 60_000

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))

function sleepMs(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms)
}

function resolveLockPath(ledgerPath: string): string {
  return join(dirname(ledgerPath), '.step-ledger.lock')
}

function createLockToken(): string {
  return `${process.pid}:${randomUUID()}`
}

function lockOwnerPid(token: string): number | undefined {
  const [pid] = token.trim().split(':')
  const parsed = Number(pid)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
}

function readLockToken(lockPath: string): string | undefined {
  try {
    return readFileSync(lockPath, 'utf8').trim()
  } catch {
    return undefined
  }
}

/**
 * Remove orphan temp files left by a writer killed between tmp-write and
 * rename. Only files older than `TMP_SWEEP_AGE_MS` are touched so a live
 * writer's in-flight temp file is never deleted.
 */
function sweepOrphanTempFiles(filePath: string): void {
  const dir = dirname(filePath)
  const prefix = `${basename(filePath)}.tmp.`
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue
    const candidate = join(dir, entry)
    try {
      if (now - statSync(candidate).mtimeMs > TMP_SWEEP_AGE_MS) unlinkSync(candidate)
    } catch {
      /* raced with its owner or already gone */
    }
  }
}

/**
 * Break a lock judged stale without ever deleting a lock someone else acquired
 * in the meantime.
 *
 * The stale file is atomically renamed to a unique quarantine path. If the
 * quarantined token is the one we judged stale, we broke the right lock and the
 * quarantine is discarded. If it is not, another writer replaced the lock
 * between our stat and the rename: the quarantined inode is linked back to the
 * lock path (which fails harmlessly with EEXIST if a third writer already holds
 * it), so no writer can ever delete another writer's lock.
 */
function breakStaleLock(lockPath: string, observedToken: string): void {
  const quarantine = `${lockPath}.stale.${process.pid}.${Date.now()}`
  try {
    renameSync(lockPath, quarantine)
  } catch {
    return
  }
  const token = readLockToken(quarantine)
  if (token !== observedToken) {
    // We raced a live writer: put its lock back if the slot is still free.
    try {
      linkSync(quarantine, lockPath)
    } catch {
      /* a newer lock already occupies the path — leave it alone */
    }
    try {
      unlinkSync(quarantine)
    } catch {
      /* best effort */
    }
    return
  }
  try {
    unlinkSync(quarantine)
  } catch {
    /* best effort */
  }
}

/**
 * Acquire the ledger write lock.
 *
 * - `open(..., 'wx')` is the atomic claim; the holder writes a unique
 *   `<pid>:<uuid>` token that release and stale-breaking verify.
 * - A lock older than `LOCK_STALE_MS` is broken via rename-to-quarantine (see
 *   `breakStaleLock`), never by a blind unlink.
 * - A lock owned by *this* process means re-entrant mutation (a listener that
 *   writes the ledger from inside a mutator) — fail fast instead of burning the
 *   whole wait budget.
 */
function acquireLedgerLock(lockPath: string): string {
  const token = createLockToken()
  const deadline = Date.now() + LOCK_WAIT_BUDGET_MS

  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(fd, `${token}\n`)
      } finally {
        closeSync(fd)
      }
      return token
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (code !== 'EEXIST') throw err
    }

    const observedToken = readLockToken(lockPath)
    if (observedToken !== undefined && lockOwnerPid(observedToken) === process.pid) {
      throw new StepLedgerLockError(
        'lock_reentrant',
        `step-ledger lock ${lockPath} is held by this process: re-entrant updateStepLedger is not supported. Move the nested write outside the mutator.`,
      )
    }

    let age = Number.POSITIVE_INFINITY
    try {
      age = Date.now() - statSync(lockPath).mtimeMs
    } catch {
      continue // lock vanished — retry immediately
    }
    if (age > LOCK_STALE_MS && observedToken !== undefined) {
      breakStaleLock(lockPath, observedToken)
      continue
    }

    if (Date.now() >= deadline) {
      throw new StepLedgerLockError(
        'lock_timeout',
        `step-ledger lock timeout after ${LOCK_WAIT_BUDGET_MS}ms waiting on ${lockPath} (held by pid ${observedToken ?? 'unknown'}). If that writer crashed, remove the file: rm -f ${lockPath}`,
      )
    }
    sleepMs(LOCK_RETRY_MS)
  }
}

/** Release only a lock this caller still owns (token match), never a successor's. */
function releaseLedgerLock(lockPath: string, token: string): void {
  if (readLockToken(lockPath) !== token) return
  try {
    unlinkSync(lockPath)
  } catch {
    /* already released */
  }
}

/**
 * Typed lock failure so the tool surface can answer with a structured result
 * (and a recovery hint) instead of a raw exception.
 */
export class StepLedgerLockError extends Error {
  readonly code: 'lock_lost' | 'lock_timeout' | 'lock_reentrant'

  constructor(code: 'lock_lost' | 'lock_timeout' | 'lock_reentrant', message: string) {
    super(message)
    this.name = 'StepLedgerLockError'
    this.code = code
  }
}

/**
 * Re-verify ownership immediately before the write-and-rename commit.
 *
 * A stale-break can evict a live lock (rename + link-back): the path then
 * belongs to a third writer while the original writer still holds its token in
 * memory. Committing anyway would produce two concurrent writers, so a writer
 * that lost its lock aborts instead of overwriting the successor's state.
 */
function assertLockStillOwned(lockPath: string, token: string): void {
  if (readLockToken(lockPath) === token) return
  throw new StepLedgerLockError(
    'lock_lost',
    `step-ledger lock ${lockPath} is no longer owned by this writer (token mismatch): another writer took over mid-mutation. Aborting before commit; re-run the action.`,
  )
}

/** Write the store via a per-process temp file + `renameSync` (atomic on POSIX). */
function writeLedgerFileAtomic(filePath: string, store: StepLedgerStore): void {
  const tmpPath = `${filePath}.tmp.${process.pid}`
  try {
    writeFileSync(tmpPath, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath)
    } catch {
      /* best-effort cleanup */
    }
    throw err
  }
}

/**
 * Read → mutate → write the ledger under an exclusive lock.
 *
 * Every mutating action (and `step-runner.ts`'s auto-create path) must go
 * through this helper: parallel waves otherwise race with last-writer-wins and
 * silently drop step entries. Keep the mutator synchronous — it runs while the
 * lock is held, and a nested call fails fast (re-entrancy is a bug, not a wait).
 */
export function updateStepLedger<T>(
  workspaceDir: string,
  mutator: (store: StepLedgerStore) => T,
): T {
  const filePath = resolveLedgerPath(workspaceDir)
  const lockPath = resolveLockPath(filePath)
  const token = acquireLedgerLock(lockPath)
  try {
    sweepOrphanTempFiles(filePath)
    const store = readLedgerFileAtPath(filePath)
    const result = mutator(store)
    store.version = 1
    // The mutation is computed; only now is it safe to commit — and only if we
    // still own the lock.
    assertLockStillOwned(lockPath, token)
    writeLedgerFileAtomic(filePath, store)
    return result
  } finally {
    releaseLedgerLock(lockPath, token)
  }
}

/**
 * @deprecated Route writes through `updateStepLedger` (read-modify-write). This
 * compatibility export now delegates to it, so it shares the lock/atomic-write
 * path instead of clobbering the store with a stale snapshot under a second
 * acquisition.
 */
export function writeStepLedger(workspaceDir: string, store: StepLedgerStore): void {
  updateStepLedger(workspaceDir, (target) => {
    target.steps = { ...store.steps }
  })
}

/**
 * Hard mechanical invariant: a step can transition to `done` if and only if
 * a verification command exited 0 at or after the last file mutation.
 */
export function canTransitionStepToDone(step: StepLedgerEntry): {
  allowed: boolean
  reason?: string
} {
  if (step.verificationExitCode !== 0 || step.lastVerifiedAt === null) {
    return {
      allowed: false,
      reason: `Step "${step.stepKey}" cannot transition to done: no passing verification command (exitCode === 0) has been recorded.`,
    }
  }
  if (step.lastMutationAt !== null && step.lastVerifiedAt < step.lastMutationAt) {
    return {
      allowed: false,
      reason: `Step "${step.stepKey}" cannot transition to done: files were mutated after the last verification run. Re-run the verification slice first.`,
    }
  }
  return { allowed: true }
}

function jsonResult(payload: unknown): PantheonToolResult {
  return { output: JSON.stringify(payload) }
}

type LaunchGate =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly error: 'step_blocked'
      readonly blockedBy: string[]
      readonly cascadeReason?: string
    }
  | { readonly ok: false; readonly error: 'dependencies_unmet'; readonly unmet: string[] }

/**
 * Mechanical launch gate for `execute_step` / `spawn_ephemeral`.
 *
 * Only a **cascade-invalidated** step (`cascadeReason` set) is hard-blocked:
 * `blocked` is also the reflex-escalation state, and those steps must remain
 * retryable (pre-`dependsOn` behaviour). Every other refusal is dependency
 * based, so a stuck step always reports its unmet prerequisites.
 */
function evaluateLaunchGate(
  entry: StepLedgerEntry | undefined,
  store: StepLedgerStore,
): LaunchGate {
  if (!entry) return { ok: true }
  if (entry.state === 'blocked' && entry.cascadeReason) {
    return {
      ok: false,
      error: 'step_blocked',
      blockedBy: [...(entry.blockedBy ?? [])],
      cascadeReason: entry.cascadeReason,
    }
  }
  const unmet = (entry.dependsOn ?? []).filter((dep) => store.steps[dep]?.state !== 'done')
  if (unmet.length > 0) return { ok: false, error: 'dependencies_unmet', unmet }
  return { ok: true }
}

/**
 * Authoritative launch transition: re-evaluates the gate and flips the state
 * **inside one lock acquisition**, so a cascade that lands between the caller's
 * gate check and the state flip cannot slip through (A1). Returns the gate when
 * the launch must abort.
 */
function claimStepForLaunch(
  cwd: string,
  stepKey: string,
  nowIso: string,
): { ok: true; resumed: boolean } | { ok: false; gate: LaunchGate } {
  return updateStepLedger(cwd, (ledger) => {
    const entry = ledger.steps[stepKey]
    // No entry yet: the runner auto-creates it, and a step without a ledger
    // row cannot declare dependencies.
    if (!entry) return { ok: true as const, resumed: false }
    const gate = evaluateLaunchGate(entry, ledger)
    if (!gate.ok) return { ok: false as const, gate }
    const resumed = entry.state === 'blocked'
    if (entry.state === 'pending' || entry.state === 'blocked') {
      entry.state = 'in_progress'
      entry.updatedAt = nowIso
      delete entry.blockedBy
      delete entry.cascadeReason
    }
    return { ok: true as const, resumed }
  })
}

function dependencyFailurePayload(
  stepKey: string,
  result: DependencyValidationResult,
): Record<string, unknown> {
  const issue = result.issues[0]
  const error = issue?.code ?? 'dependency_not_found'
  return {
    ok: false,
    stepKey,
    error,
    message: issue?.message ?? `Invalid dependencies for "${stepKey}"`,
    ...(error === 'dependency_not_found' ? { dependencies: result.unknown } : {}),
    ...(error === 'self_dependency' ? { dependencies: [stepKey] } : {}),
    ...(error === 'cycle_detected' ? { cycles: result.cycles, path: result.cycles[0] } : {}),
    issues: result.issues,
  }
}

export interface CheckpointScrubOutcome {
  readonly ok: boolean
  readonly dryRun: boolean
  /** Ledger entries that carry a `baselineTree`. */
  readonly scanned: number
  /** Checkpoints rewritten without `.pantheon/` (old -> new tree SHA). */
  readonly rewritten: Array<{ stepKey: string; from: string; to: string }>
  /** Checkpoints that were already clean. */
  readonly clean: number
  /** Entries whose baseline was anchored under a ref (migrates legacy entries). */
  readonly anchored: Array<{ stepKey: string; ref: string; tree: string }>
  /** Trees no longer referenced by any ref or the ledger; normal Git GC reclaims them. */
  readonly orphanedTrees: string[]
  /** Checkpoints that STILL contain `.pantheon/` (must be empty after a scrub). */
  readonly remaining: Array<{ stepKey: string; treeHash: string; reason: string }>
}

/**
 * Retroactive scrub (L3): remove `.pantheon/` from every checkpoint the ledger
 * still references.
 *
 * Checkpoints are anchored under `refs/pantheon/step-baselines/<stepKey>`, so
 * the tree is reachable and Git GC cannot prune it. Legacy entries (created
 * before anchoring) are anchored here as a side effect, which is also their
 * migration path. The old tree becomes unreachable and normal `git gc` reclaims
 * it — no aggressive prune is needed or advised, because that would also delete
 * any baseline that has not been anchored yet.
 *
 * Checkpoints whose ledger entry was already deleted are unreachable from the
 * ledger (nothing can restore them) and are likewise left to Git GC.
 */
export async function scrubCheckpointHistory(
  cwd: string,
  options: { dryRun?: boolean } = {},
): Promise<CheckpointScrubOutcome> {
  const dryRun = options.dryRun === true
  const store = readStepLedger(cwd)
  const targets = Object.values(store.steps).filter(
    (entry): entry is StepLedgerEntry & { baselineTree: string } =>
      typeof entry.baselineTree === 'string' && entry.baselineTree.length > 0,
  )

  const rewritten: Array<{ stepKey: string; from: string; to: string }> = []
  const anchored: Array<{ stepKey: string; ref: string; tree: string }> = []
  const remaining: Array<{ stepKey: string; treeHash: string; reason: string }> = []
  const updates = new Map<string, { baselineTree: string; baselineRef?: string }>()
  let clean = 0

  for (const entry of targets) {
    const stripped = await stripPantheonFromTree(cwd, entry.baselineTree)
    if (!stripped.ok || !stripped.treeHash) {
      remaining.push({
        stepKey: entry.stepKey,
        treeHash: entry.baselineTree,
        reason: stripped.reason ?? 'strip_failed',
      })
      continue
    }
    const tree = stripped.treeHash
    const anchor = await anchorCheckpointTree(cwd, tree, entry.stepKey)
    if (!anchor.ok || !anchor.ref) {
      remaining.push({
        stepKey: entry.stepKey,
        treeHash: tree,
        reason: anchor.reason ?? 'anchor_failed',
      })
      continue
    }
    const needsUpdate = anchor.ref !== entry.baselineRef || tree !== entry.baselineTree
    if (needsUpdate) {
      updates.set(entry.stepKey, { baselineTree: tree, baselineRef: anchor.ref })
      if (!entry.baselineRef) anchored.push({ stepKey: entry.stepKey, ref: anchor.ref, tree })
    }
    if (stripped.changed) {
      rewritten.push({ stepKey: entry.stepKey, from: entry.baselineTree, to: tree })
    } else {
      clean += 1
    }
  }

  if (!dryRun && updates.size > 0) {
    const nowIso = new Date().toISOString()
    updateStepLedger(cwd, (ledger) => {
      for (const [stepKey, next] of updates) {
        const entry = ledger.steps[stepKey]
        if (!entry) continue
        entry.baselineTree = next.baselineTree
        if (next.baselineRef) entry.baselineRef = next.baselineRef
        entry.updatedAt = nowIso
      }
    })
  }

  return {
    ok: remaining.length === 0,
    dryRun,
    scanned: targets.length,
    rewritten,
    clean,
    anchored,
    orphanedTrees: rewritten.map((item) => item.from),
    remaining,
  }
}

/** Apply a rollback cascade, stamping every invalidated dependent with its reason. */ function applyCascade(
  store: StepLedgerStore,
  rootStepKey: string,
  reason: string,
  nowIso: string,
): Array<{ stepKey: string; receiptId?: string; previousState?: StepState }> {
  const targets = cascadeBlock(Object.values(store.steps), rootStepKey, reason)
  const invalidated: Array<{ stepKey: string; receiptId?: string; previousState?: StepState }> = []
  for (const target of targets) {
    const entry = store.steps[target.stepKey]
    if (!entry) continue
    invalidated.push({
      stepKey: target.stepKey,
      ...(entry.receiptId ? { receiptId: entry.receiptId } : {}),
      ...(entry.state ? { previousState: entry.state } : {}),
    })
    entry.state = 'blocked'
    entry.blockedBy = [...target.blockedBy]
    entry.cascadeReason = target.cascadeReason
    entry.updatedAt = nowIso
  }
  return invalidated
}

interface RollbackCompensation {
  readonly restored: boolean
  readonly restoredTree?: string
  readonly restoreFailed?: { checkpoint?: string; reason: string }
}

/**
 * Compensating restore for a rollback that must be undone (a late refusal, or
 * a step entry that vanished mid-flight). The result is **verified**, never
 * assumed: a failed compensation is reported with the checkpoint hash so the
 * caller can recover the tree manually.
 */
async function compensateRollbackTree(
  cwd: string,
  preRollback: { ok: boolean; treeHash?: string; reason?: string },
): Promise<RollbackCompensation> {
  if (!preRollback.ok || !preRollback.treeHash) {
    return {
      restored: false,
      restoreFailed: { reason: preRollback.reason ?? 'pre-rollback checkpoint unavailable' },
    }
  }
  const restore = await restoreGitCheckpoint(cwd, preRollback.treeHash)
  if (restore.ok) return { restored: true, restoredTree: preRollback.treeHash }
  return {
    restored: false,
    restoreFailed: {
      checkpoint: preRollback.treeHash,
      reason: restore.reason ?? 'restore failed',
    },
  }
}

function compensationPayload(compensation: RollbackCompensation): Record<string, unknown> {
  return {
    treeRestored: compensation.restored,
    ...(compensation.restoredTree ? { restoredTree: compensation.restoredTree } : {}),
    ...(compensation.restoreFailed ? { restoreFailed: compensation.restoreFailed } : {}),
  }
}

/**
 * Merge a ledger snapshot back under the lock, through the atomic write path.
 *
 * Used only by restore-protection: entries the restore deleted are re-added
 * from the snapshot while the on-disk store wins for keys it still has, so a
 * writer that committed during the restore's git operations is not clobbered.
 * The write is token-checked and lands via `writeLedgerFileAtomic`.
 */
function restoreLedgerSnapshotUnderLock(workspaceDir: string, snapshot: StepLedgerStore): void {
  const filePath = resolveLedgerPath(workspaceDir)
  const lockPath = resolveLockPath(filePath)
  const token = acquireLedgerLock(lockPath)
  try {
    let current: StepLedgerStore = { version: 1, steps: {} }
    try {
      current = readLedgerFileAtPath(filePath)
    } catch {
      /* an unreadable (restored) file: the snapshot wins */
    }
    assertLockStillOwned(lockPath, token)
    writeLedgerFileAtomic(filePath, {
      version: 1,
      steps: { ...snapshot.steps, ...current.steps },
    })
  } finally {
    releaseLedgerLock(lockPath, token)
  }
}

/**
 * Translate a lock failure into a structured tool result (D3): a raw exception
 * would leak internals and give the caller no recovery path.
 */
export function describeLedgerError(
  err: unknown,
): { ok: false; error: string; hint: string; detail: string } | undefined {
  if (!(err instanceof StepLedgerLockError)) return undefined
  const hints: Record<StepLedgerLockError['code'], string> = {
    lock_lost:
      'Re-run the action; another writer took over the ledger lock mid-mutation and nothing was committed.',
    lock_timeout:
      'Another writer is holding the ledger lock. Retry once it finishes, or free a crashed lock with `rm -f .pantheon/ledger/.step-ledger.lock`.',
    lock_reentrant:
      'Move the nested ledger write outside the current mutator — updateStepLedger must not be called from inside another one.',
  }
  const error =
    err.code === 'lock_lost'
      ? 'lock lost mid-mutation'
      : err.code === 'lock_timeout'
        ? 'ledger_lock_timeout'
        : 'reentrant_ledger_write'
  return { ok: false, error, hint: hints[err.code], detail: err.message }
}

/**
 * Run an async tree restoration and guarantee it cannot roll the ledger back.
 *
 * `captureGitCheckpoint` no longer captures `.pantheon/` (source fix), so in the
 * normal case the ledger is untouched and this is a no-op. It stays as the
 * second layer for checkpoints captured by older versions, where restoring a
 * tree would otherwise overwrite the live ledger with a stale snapshot — which
 * silently deletes every step created after that checkpoint.
 *
 * Exported for the restore-protection test; call it only from the rollback path.
 */
export async function preserveLedgerBytes<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const filePath = resolveLedgerPath(cwd)
  const beforeText = existsSync(filePath) ? readFileSync(filePath, 'utf8') : undefined
  let snapshot: StepLedgerStore | undefined
  if (beforeText !== undefined) {
    try {
      const parsed = JSON.parse(beforeText) as Partial<StepLedgerStore>
      if (parsed && typeof parsed.steps === 'object' && parsed.steps !== null) {
        snapshot = { version: 1, steps: parsed.steps as Record<string, StepLedgerEntry> }
      }
    } catch {
      snapshot = undefined
    }
  }
  const result = await fn()
  if (!snapshot) return result
  const afterText = existsSync(filePath) ? readFileSync(filePath, 'utf8') : undefined
  if (afterText === beforeText) return result
  restoreLedgerSnapshotUnderLock(cwd, snapshot)
  return result
}

function emitBlocked(stepKey: string, entry: StepLedgerEntry | undefined): void {
  if (!entry) return
  getSharedBus().emit('step:blocked', {
    stepKey,
    blockedBy: [...(entry.blockedBy ?? [])],
    reason: entry.cascadeReason ?? 'blocked',
    ...(entry.cascadeReason ? { cascadeReason: entry.cascadeReason } : {}),
    timestamp: Date.now(),
  })
}

export function createStepLedgerTool(
  fallbackDir?: string,
  sessionDomain?: SubSessionDomainLike,
): PantheonToolDef {
  return {
    name: 'pantheon_step_ledger',
    description:
      'Manage atomic Step-Ledger execution contracts with hard verification gates, Git checkpoints, bugfix reproduction tracking, and isolated sub-session step runner. ' +
      'Lifecycle: init_step | execute_step -> [record_reproduction] -> record_mutation -> record_verification -> complete_step | rollback_step | unblock_step | status.',
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: {
          type: 'string',
          enum: [
            'init_step',
            'execute_step',
            'spawn_ephemeral',
            'verify_ephemeral',
            'record_reproduction',
            'record_mutation',
            'record_verification',
            'complete_step',
            'rollback_step',
            'unblock_step',
            'scrub_checkpoints',
            'status',
          ],
          description:
            'Ledger operation (init_step | execute_step | spawn_ephemeral | verify_ephemeral | record_reproduction | record_mutation | record_verification | complete_step | rollback_step | unblock_step | scrub_checkpoints | status)',
        },
        stepKey: {
          type: 'string',
          description:
            'Unique atomic step id matching ^[a-zA-Z0-9._:-]{1,128}$ (no spaces or "..")',
        },
        objective: { type: 'string', description: 'Bounded step objective' },
        agent: { type: 'string', description: 'Assigned specialist agent' },
        role: {
          type: 'string',
          description: 'Dynamic ephemeral worker role slug (for spawn_ephemeral)',
        },
        baseAgent: {
          type: 'string',
          description:
            'Canonical base agent for spawn_ephemeral (default hermes, or apollo when readOnly)',
        },
        readOnly: {
          type: 'boolean',
          description: 'When true on spawn_ephemeral, defaults baseAgent to apollo',
        },
        isolateWorktree: {
          type: 'boolean',
          description: 'Create disposable sibling git worktree for spawn_ephemeral (default true)',
        },
        keepWorktree: {
          type: 'boolean',
          description: 'Retain disposable worktree after spawn_ephemeral finishes (default false)',
        },
        reuseSessionID: {
          type: 'string',
          description: 'Existing caller-owned session ID to reuse on execute_step',
        },
        maxTurns: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description:
            'Max continuation turns for execute_step/spawn_ephemeral (default 1 for execute_step, 8 for spawn_ephemeral)',
        },
        wallClockMs: {
          type: 'number',
          minimum: 0,
          description:
            'Per-worker wall-clock timeout in ms for execute_step/spawn_ephemeral (default 300000)',
        },
        maxCostUsd: {
          type: 'number',
          minimum: 0,
          description: 'Optional cumulative USD cost ceiling per worker sub-session',
        },
        ownedFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Owned file paths/globs for worker lease boundary and prompt contract',
        },
        forbiddenFiles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Forbidden file paths/globs that the worker must never modify',
        },
        autoVerify: {
          type: 'boolean',
          description:
            'When true on spawn_ephemeral, automatically run verifier diff review on preserved pantheon/eph/<stepKey> branch',
        },
        verifierAgent: {
          type: 'string',
          description: 'Verifier agent for autoVerify / verify_ephemeral (default "themis")',
        },
        branches: {
          type: 'array',
          items: { type: 'string' },
          description: 'Ephemeral worker branches (pantheon/eph/<stepKey>) for verify_ephemeral',
        },
        to: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional recipient handles for spawn_ephemeral final [done]/[blocker] handoff (default ["zeus"], e.g. ["themis"])',
        },
        extraContext: {
          type: 'string',
          description: 'Optional bounded context for isolated execute_step sub-session',
        },
        cleanupSession: {
          type: 'boolean',
          description: 'Remove ephemeral sub-session after execute_step (default: true)',
        },
        taskType: {
          type: 'string',
          enum: ['feature', 'bugfix', 'refactor', 'chore'],
          description: 'Task classification (bugfix enforces reproduction RED before edits)',
        },
        autoRollback: {
          type: 'boolean',
          description:
            'Auto-restore baselineTree when verification exhausts reflex retries (default: true)',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Mutated file paths for record_mutation',
        },
        command: { type: 'string', description: 'Executed verification or reproduction command' },
        exitCode: { type: 'number', description: 'Exit code of the command' },
        durationMs: { type: 'number', description: 'Duration of verification command in ms' },
        dependsOn: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Prerequisite step keys for init_step. Unknown, self, or cyclic dependencies are rejected.',
        },
        cascade: {
          type: 'boolean',
          description:
            'rollback_step: also invalidate transitive dependents (blocked with blockedBy + cascadeReason)',
        },
        dryRun: {
          type: 'boolean',
          description: 'scrub_checkpoints: report what would be rewritten without persisting',
        },
      },
    },
    output: {},
    execute: async (input, context) => {
      try {
        const action = typeof input.action === 'string' ? input.action : 'status'
        const cwd = resolveToolCwd(context, fallbackDir)
        const now = Date.now()
        const nowIso = new Date(now).toISOString()

        if (action === 'status') {
          const store = readStepLedger(cwd)
          const nodes = Object.values(store.steps) as DependencyNode[]
          if (typeof input.stepKey === 'string' && input.stepKey.trim()) {
            const key = assertSafeStepKey(input.stepKey.trim())
            const step = store.steps[key]
            if (!step) return jsonResult({ ok: false, error: 'step_not_found', stepKey: key })
            return jsonResult({
              ok: true,
              step,
              gate: canTransitionStepToDone(step),
              ready: readyStepKeys(nodes).includes(key),
              unmet: unmetDependencies(nodes)[key] ?? [],
            })
          }
          return jsonResult({
            ok: true,
            steps: nodes,
            graph: buildDependencyGraph(nodes),
          })
        }

        if (action === 'verify_ephemeral') {
          const branches = Array.isArray(input.branches)
            ? input.branches.filter(
                (b): b is string => typeof b === 'string' && b.trim().length > 0,
              )
            : []
          if (branches.length === 0) {
            return jsonResult({
              ok: false,
              error: 'branches array is required for verify_ephemeral',
            })
          }
          const parentSid =
            typeof (context as { sessionID?: unknown } | undefined)?.sessionID === 'string'
              ? ((context as { sessionID?: string }).sessionID ?? undefined)
              : undefined
          const verifyOut = await verifyEphemeralBranches({
            branches,
            sharedRoot: resolveSharedPantheonRoot(cwd),
            ...(typeof input.verifierAgent === 'string' && input.verifierAgent.trim()
              ? { verifierAgent: input.verifierAgent.trim() }
              : {}),
            ...(sessionDomain ? { sessionDomain } : {}),
            ...(parentSid ? { parentSessionID: parentSid } : {}),
          })
          return jsonResult(verifyOut)
        }

        if (action === 'scrub_checkpoints') {
          const outcome = await scrubCheckpointHistory(cwd, { dryRun: input.dryRun === true })
          return jsonResult(outcome)
        }

        const key = assertSafeStepKey(input.stepKey)

        if (action === 'init_step') {
          const objective = typeof input.objective === 'string' ? input.objective.trim() : ''
          if (!objective) return jsonResult({ ok: false, error: 'objective is required' })
          const agent =
            typeof input.agent === 'string' && input.agent.trim()
              ? input.agent.trim()
              : 'specialist'
          const rawTaskType = input.taskType
          const taskType: StepTaskType | undefined =
            rawTaskType === 'feature' ||
            rawTaskType === 'bugfix' ||
            rawTaskType === 'refactor' ||
            rawTaskType === 'chore'
              ? rawTaskType
              : undefined
          const requestedDeps = normalizeDependencies(input.dependsOn)
          const ownedFiles = Array.isArray(input.ownedFiles)
            ? input.ownedFiles.filter(
                (f): f is string => typeof f === 'string' && f.trim().length > 0,
              )
            : []
          const forbiddenFiles = Array.isArray(input.forbiddenFiles)
            ? input.forbiddenFiles.filter(
                (f): f is string => typeof f === 'string' && f.trim().length > 0,
              )
            : []

          // Fast reject before touching git; re-validated under the ledger lock.
          const precheck = validateDependencies(
            key,
            requestedDeps,
            Object.values(readStepLedger(cwd).steps) as DependencyNode[],
          )
          if (!precheck.ok) return jsonResult(dependencyFailurePayload(key, precheck))

          const ckpt = await captureGitCheckpoint(cwd, key)
          // Anchor the baseline under a ref so Git GC cannot prune it; the
          // checkpoint stays restorable for as long as the step exists.
          const anchor =
            ckpt.ok && ckpt.treeHash
              ? await anchorCheckpointTree(cwd, ckpt.treeHash, key)
              : undefined
          const outcome = updateStepLedger(cwd, (ledger) => {
            const validation = validateDependencies(
              key,
              requestedDeps,
              Object.values(ledger.steps) as DependencyNode[],
            )
            if (!validation.ok) {
              return { ok: false as const, failure: dependencyFailurePayload(key, validation) }
            }
            const deps = validation.dependencies
            const unmetDeps = deps.filter((dep) => ledger.steps[dep]?.state !== 'done')
            const state: StepState =
              deps.length > 0 && unmetDeps.length > 0 ? 'pending' : 'in_progress'
            const entry: StepLedgerEntry = {
              stepKey: key,
              objective,
              agent,
              state,
              ...(taskType ? { taskType } : {}),
              ...(ckpt.ok && ckpt.treeHash ? { baselineTree: ckpt.treeHash } : {}),
              ...(anchor?.ok && anchor.ref ? { baselineRef: anchor.ref } : {}),
              ...(deps.length > 0 ? { dependsOn: deps } : {}),
              ...(ownedFiles.length > 0 ? { ownedFiles } : {}),
              ...(forbiddenFiles.length > 0 ? { forbiddenFiles } : {}),
              mutatedFiles: [],
              lastMutationAt: null,
              lastVerifiedAt: null,
              updatedAt: nowIso,
            }
            ledger.steps[key] = entry
            return { ok: true as const, entry, unmetDeps }
          })
          if (!outcome.ok) return jsonResult(outcome.failure)

          const callerSid =
            typeof (context as { sessionID?: unknown } | undefined)?.sessionID === 'string'
              ? (context as { sessionID: string }).sessionID
              : undefined
          const leaseHook = (
            globalThis as {
              __pantheonFileLeases?: {
                acquireFileLease?: (opts: {
                  sessionID: string
                  holder: string
                  ownedFiles?: readonly string[]
                  forbiddenFiles?: readonly string[]
                  cwd?: string
                }) => Promise<void> | void
              }
            }
          ).__pantheonFileLeases
          if (
            callerSid &&
            leaseHook?.acquireFileLease &&
            (ownedFiles.length > 0 || forbiddenFiles.length > 0)
          ) {
            await leaseHook.acquireFileLease({
              sessionID: callerSid,
              holder: agent,
              ownedFiles,
              forbiddenFiles,
              cwd,
            })
          }
          return jsonResult({
            ok: true,
            step: outcome.entry,
            ...(outcome.entry.state === 'pending' ? { unmet: outcome.unmetDeps } : {}),
          })
        }

        if (action === 'execute_step') {
          if (!sessionDomain) {
            return jsonResult({ ok: false, error: 'host session domain unavailable' })
          }
          const launchStore = readStepLedger(cwd)
          const launchGate = evaluateLaunchGate(launchStore.steps[key], launchStore)
          if (!launchGate.ok) return jsonResult({ ...launchGate, stepKey: key })
          const objective =
            typeof input.objective === 'string' && input.objective.trim()
              ? input.objective.trim()
              : (launchStore.steps[key]?.objective ?? '')
          if (!objective) return jsonResult({ ok: false, error: 'objective is required' })
          const claim = claimStepForLaunch(cwd, key, nowIso)
          if (!claim.ok) return jsonResult({ ...claim.gate, stepKey: key })
          const agent =
            typeof input.agent === 'string' && input.agent.trim()
              ? input.agent.trim().replace(/^@/, '')
              : (launchStore.steps[key]?.agent ?? 'hermes')
          const rawTaskType = input.taskType
          const taskType: StepTaskType | undefined =
            rawTaskType === 'feature' ||
            rawTaskType === 'bugfix' ||
            rawTaskType === 'refactor' ||
            rawTaskType === 'chore'
              ? rawTaskType
              : launchStore.steps[key]?.taskType
          const parentSid =
            typeof (context as { sessionID?: unknown } | undefined)?.sessionID === 'string'
              ? ((context as { sessionID?: string }).sessionID ?? undefined)
              : undefined
          const runOut = await runAtomicStepSubSession({
            sessionDomain,
            cwd,
            stepKey: key,
            objective,
            agent,
            ...(taskType ? { taskType } : {}),
            ...(parentSid ? { parentSessionID: parentSid } : {}),
            ...(typeof input.extraContext === 'string' ? { extraContext: input.extraContext } : {}),
            ...(typeof input.cleanupSession === 'boolean'
              ? { cleanupSession: input.cleanupSession }
              : {}),
            ...(typeof input.reuseSessionID === 'string' && input.reuseSessionID.trim()
              ? { reuseSessionID: input.reuseSessionID.trim() }
              : {}),
            ...(typeof input.maxTurns === 'number' && Number.isInteger(input.maxTurns)
              ? { maxTurns: input.maxTurns }
              : {}),
            ...(typeof input.wallClockMs === 'number' && Number.isFinite(input.wallClockMs)
              ? { wallClockMs: input.wallClockMs }
              : {}),
            ...(typeof input.maxCostUsd === 'number' && Number.isFinite(input.maxCostUsd)
              ? { maxCostUsd: input.maxCostUsd }
              : {}),
            ...(Array.isArray(input.ownedFiles)
              ? {
                  ownedFiles: input.ownedFiles.filter(
                    (entry): entry is string => typeof entry === 'string',
                  ),
                }
              : {}),
            ...(Array.isArray(input.forbiddenFiles)
              ? {
                  forbiddenFiles: input.forbiddenFiles.filter(
                    (entry): entry is string => typeof entry === 'string',
                  ),
                }
              : {}),
            ...(Array.isArray(input.to)
              ? { to: input.to.filter((entry): entry is string => typeof entry === 'string') }
              : {}),
          })
          return jsonResult(runOut)
        }

        if (action === 'spawn_ephemeral') {
          if (!sessionDomain) {
            return jsonResult({ ok: false, error: 'host session domain unavailable' })
          }
          const launchStore = readStepLedger(cwd)
          const launchGate = evaluateLaunchGate(launchStore.steps[key], launchStore)
          if (!launchGate.ok) return jsonResult({ ...launchGate, stepKey: key })
          const objective =
            typeof input.objective === 'string' && input.objective.trim()
              ? input.objective.trim()
              : (launchStore.steps[key]?.objective ?? '')
          if (!objective) return jsonResult({ ok: false, error: 'objective is required' })
          const claim = claimStepForLaunch(cwd, key, nowIso)
          if (!claim.ok) return jsonResult({ ...claim.gate, stepKey: key })
          const role =
            typeof input.role === 'string' && input.role.trim()
              ? input.role.trim()
              : deriveEphemeralRoleSlug(`worker-${key}`)
          const parentSid =
            typeof (context as { sessionID?: unknown } | undefined)?.sessionID === 'string'
              ? ((context as { sessionID?: string }).sessionID ?? undefined)
              : undefined
          const ephOut = await spawnEphemeralWorker({
            sessionDomain,
            cwd,
            stepKey: key,
            role,
            objective,
            ...(typeof input.baseAgent === 'string' && input.baseAgent.trim()
              ? { baseAgent: input.baseAgent.trim() }
              : {}),
            ...(typeof input.readOnly === 'boolean' ? { readOnly: input.readOnly } : {}),
            ...(typeof input.isolateWorktree === 'boolean'
              ? { isolateWorktree: input.isolateWorktree }
              : {}),
            ...(typeof input.keepWorktree === 'boolean'
              ? { keepWorktree: input.keepWorktree }
              : {}),
            ...(parentSid ? { parentSessionID: parentSid } : {}),
            ...(typeof input.extraContext === 'string' ? { extraContext: input.extraContext } : {}),
            ...(typeof input.maxTurns === 'number' && Number.isInteger(input.maxTurns)
              ? { maxTurns: input.maxTurns }
              : {}),
            ...(typeof input.wallClockMs === 'number' && Number.isFinite(input.wallClockMs)
              ? { wallClockMs: input.wallClockMs }
              : {}),
            ...(typeof input.maxCostUsd === 'number' && Number.isFinite(input.maxCostUsd)
              ? { maxCostUsd: input.maxCostUsd }
              : {}),
            ...(Array.isArray(input.ownedFiles)
              ? {
                  ownedFiles: input.ownedFiles.filter(
                    (entry): entry is string => typeof entry === 'string',
                  ),
                }
              : {}),
            ...(Array.isArray(input.forbiddenFiles)
              ? {
                  forbiddenFiles: input.forbiddenFiles.filter(
                    (entry): entry is string => typeof entry === 'string',
                  ),
                }
              : {}),
            ...(typeof input.autoVerify === 'boolean' ? { autoVerify: input.autoVerify } : {}),
            ...(typeof input.verifierAgent === 'string' && input.verifierAgent.trim()
              ? { verifierAgent: input.verifierAgent.trim() }
              : {}),
            ...(Array.isArray(input.to)
              ? { to: input.to.filter((entry): entry is string => typeof entry === 'string') }
              : {}),
          })
          return jsonResult(ephOut)
        }

        if (action === 'record_reproduction') {
          const command = typeof input.command === 'string' ? input.command.trim() : ''
          const exitCode = typeof input.exitCode === 'number' ? input.exitCode : 1
          if (!command) return jsonResult({ ok: false, error: 'command is required' })
          if (exitCode === 0) {
            return jsonResult({
              ok: false,
              error: 'Bugfix reproduction must demonstrate a failing test/probe (exitCode !== 0)',
            })
          }
          const outcome = updateStepLedger(cwd, (ledger) => {
            const entry = ledger.steps[key]
            if (!entry) return { kind: 'missing' as const }
            entry.reproductionCommand = command
            entry.reproductionExitCode = exitCode
            entry.reproductionRecordedAt = now
            entry.updatedAt = nowIso
            return { kind: 'ok' as const, step: entry }
          })
          if (outcome.kind === 'missing') {
            return jsonResult({ ok: false, error: `Step "${key}" is not initialized` })
          }
          return jsonResult({ ok: true, reproduced: true, step: outcome.step })
        }

        if (action === 'rollback_step') {
          const preStore = readStepLedger(cwd)
          const step = preStore.steps[key]
          if (!step) {
            return jsonResult({ ok: false, error: `Step "${key}" is not initialized` })
          }
          if (!step.baselineTree) {
            return jsonResult({ ok: false, error: `Step "${key}" has no Git baselineTree`, step })
          }
          const cascade = input.cascade === true
          const doneDependentKeys = (store: StepLedgerStore): string[] =>
            cascadeBlock(
              Object.values(store.steps) as DependencyNode[],
              key,
              'manual_rollback_step',
            )
              .filter((target) => store.steps[target.stepKey]?.state === 'done')
              .map((target) => target.stepKey)

          // Fast refusal before the lock (cheap, no tree touched).
          const preflightDone = doneDependentKeys(preStore)
          if (preflightDone.length > 0 && !cascade) {
            return jsonResult({
              ok: false,
              error: 'dependents_done',
              dependents: preflightDone,
              treeUntouched: true,
              hint: 'Re-run rollback_step with cascade:true to invalidate dependents explicitly.',
              step,
            })
          }

          // Authoritative decision **under the lock and before any restore**: a
          // refusal must be a no-op, never a tree rollback followed by an error.
          const decision = updateStepLedger(cwd, (ledger) => {
            const current = ledger.steps[key]
            if (!current) return { kind: 'missing' as const }
            const lateDone = doneDependentKeys(ledger)
            if (lateDone.length > 0 && !cascade) {
              return { kind: 'refused' as const, dependents: lateDone }
            }
            return { kind: 'proceed' as const }
          })
          if (decision.kind === 'missing') {
            return jsonResult({ ok: false, error: `Step "${key}" is not initialized` })
          }
          if (decision.kind === 'refused') {
            return jsonResult({
              ok: false,
              error: 'dependents_done',
              dependents: decision.dependents,
              treeUntouched: true,
              step,
            })
          }

          // A pruned baseline (GC, manual object cleanup) must fail loudly and
          // leave everything untouched — never "succeed" by restoring nothing.
          // Checked after the refusal decision: a refusal must win without
          // touching the object database, and this stays before any mutation.
          if (!(await checkpointTreeExists(cwd, step.baselineTree))) {
            return jsonResult({
              ok: false,
              error: 'baseline_missing',
              baselineTree: step.baselineTree,
              ...(step.baselineRef ? { baselineRef: step.baselineRef } : {}),
              treeUntouched: true,
              hint: 'The checkpoint tree no longer exists (pruned by Git or by a manual object cleanup). Re-initialize the step to capture a fresh baseline, or restore the recorded tree from a backup.',
              step,
            })
          }

          // Snapshot the pre-rollback tree so a late refusal can be undone and
          // the caller always has a recovery handle.
          const preRollback = await captureGitCheckpoint(cwd, `${key}-pre-rollback`)
          // The primary restore is protected too: a checkpoint captured before
          // `.pantheon/` was excluded would otherwise roll the live ledger back.
          const baselineTree = step.baselineTree
          const rb = await preserveLedgerBytes(cwd, () => restoreGitCheckpoint(cwd, baselineTree))
          const cascadeReason = `Step "${key}" was rolled back; dependent invalidated by cascade`
          const outcome = updateStepLedger(cwd, (ledger) => {
            const entry = ledger.steps[key]
            if (!entry) return { kind: 'missing' as const }
            // A dependent can only complete after our restore, inside this window.
            const lateDone = doneDependentKeys(ledger)
            if (lateDone.length > 0 && !cascade) {
              return { kind: 'late_refusal' as const, dependents: lateDone }
            }
            if (rb.ok) {
              entry.state = 'rolled_back'
              entry.rolledBackAt = nowIso
            } else {
              entry.state = 'blocked'
            }
            delete entry.blockedBy
            delete entry.cascadeReason
            entry.updatedAt = nowIso
            const invalidated = cascade ? applyCascade(ledger, key, cascadeReason, nowIso) : []
            return {
              kind: 'rolled' as const,
              step: entry,
              invalidated,
              blocked: invalidated.map((item) => item.stepKey),
            }
          })
          if (outcome.kind === 'missing') {
            // The entry vanished between the decision and the commit: the tree
            // is already restored, so compensate and report the real state —
            // never leave the caller with a destroyed tree and a bare error.
            const compensation = await preserveLedgerBytes(cwd, () =>
              compensateRollbackTree(cwd, preRollback),
            )
            return jsonResult({
              ok: false,
              error: `Step "${key}" is not initialized`,
              ...compensationPayload(compensation),
              hint: compensation.restored
                ? 'The step entry disappeared during the rollback; the pre-rollback tree was restored.'
                : 'The step entry disappeared during the rollback and the tree could not be restored — recover it from restoreFailed.checkpoint.',
            })
          }
          if (outcome.kind === 'late_refusal') {
            // Undo our restore so the refusal stays a no-op. `restoredTree` is
            // only reported when the compensation actually succeeded.
            const compensation = await preserveLedgerBytes(cwd, () =>
              compensateRollbackTree(cwd, preRollback),
            )
            return jsonResult({
              ok: false,
              error: 'dependents_done',
              dependents: outcome.dependents,
              ...compensationPayload(compensation),
              hint: compensation.restored
                ? 'A dependent completed during the rollback; the pre-rollback tree was restored and nothing changed.'
                : 'A dependent completed during the rollback and the tree could not be restored — recover it from restoreFailed.checkpoint.',
              step,
            })
          }

          const callerSidRb =
            typeof (context as { sessionID?: unknown } | undefined)?.sessionID === 'string'
              ? (context as { sessionID: string }).sessionID
              : undefined
          const releaseHookRb = (
            globalThis as {
              __pantheonFileLeases?: {
                releaseFileLease?: (opts: {
                  sessionID: string
                  holder: string
                }) => Promise<void> | void
              }
            }
          ).__pantheonFileLeases?.releaseFileLease
          if (callerSidRb && releaseHookRb) {
            await releaseHookRb({ sessionID: callerSidRb, holder: step.agent })
          }
          getSharedBus().emit('step:rollback', {
            stepKey: key,
            reason: 'manual_rollback_step',
            restoredTree: step.baselineTree,
            success: rb.ok,
            timestamp: Date.now(),
          })
          const latest = readStepLedger(cwd)
          for (const blockedKey of outcome.blocked)
            emitBlocked(blockedKey, latest.steps[blockedKey])
          return jsonResult({
            ok: rb.ok,
            // Distinct from `restoredTree` (which only ever reports a verified
            // compensating restore): this is the tree the rollback moved to.
            rolledBackToTree: step.baselineTree,
            ...(preRollback.treeHash ? { preRollbackTree: preRollback.treeHash } : {}),
            error: rb.reason,
            step: outcome.step,
            ...(cascade ? { invalidated: outcome.invalidated } : {}),
          })
        }

        if (action === 'record_mutation') {
          const files = Array.isArray(input.files) ? input.files.map(String) : []
          const outcome = updateStepLedger(cwd, (ledger) => {
            const entry = ledger.steps[key]
            if (!entry) return { kind: 'missing' as const }
            entry.mutatedFiles = Array.from(new Set([...entry.mutatedFiles, ...files]))
            entry.lastMutationAt = now
            if (entry.state === 'done') entry.state = 'in_progress'
            entry.updatedAt = nowIso
            return { kind: 'ok' as const, step: entry }
          })
          if (outcome.kind === 'missing') {
            return jsonResult({ ok: false, error: `Step "${key}" is not initialized` })
          }
          return jsonResult({ ok: true, step: outcome.step })
        }

        if (action === 'record_verification') {
          const command = typeof input.command === 'string' ? input.command.trim() : ''
          const exitCode = typeof input.exitCode === 'number' ? input.exitCode : 1
          const durationMs = typeof input.durationMs === 'number' ? input.durationMs : 0
          if (!command) return jsonResult({ ok: false, error: 'command is required' })

          const outcome = updateStepLedger(cwd, (ledger) => {
            const entry = ledger.steps[key]
            if (!entry) return { kind: 'missing' as const }
            entry.verificationCommand = command
            entry.verificationExitCode = exitCode
            entry.lastVerifiedAt = now
            entry.verificationAttempts = (entry.verificationAttempts ?? 0) + 1
            if (exitCode !== 0) {
              entry.verificationFailures = (entry.verificationFailures ?? 0) + 1
            }
            entry.updatedAt = nowIso

            if (exitCode === 0) {
              stepReflex.evaluate(key, entry.agent, [])
              const receipt = createExecutionReceipt({
                taskID: key,
                agent: entry.agent,
                files: entry.mutatedFiles.map((f) => ({ path: f, content: `${key}:${f}:${now}` })),
                testSlice: { command, exitCode: 0, durationMs },
              })
              entry.receiptId = receipt.receiptId
              // A cascade block is only lifted by `unblock_step` (or by being
              // re-initialized). A passing verification never unblocks: that
              // would let a dependent complete while its prerequisite is
              // rolled_back.
              return { kind: 'verified' as const, receiptId: receipt.receiptId, step: entry }
            }

            const reflex = stepReflex.evaluate(key, entry.agent, [
              {
                file: entry.mutatedFiles[0] ?? key,
                error: `Verification command "${command}" failed with exit code ${exitCode}`,
              },
            ])
            if (reflex.action === 'escalate') {
              entry.state = 'blocked'
              return {
                kind: 'escalate' as const,
                reflex,
                step: entry,
                baselineTree: entry.baselineTree,
              }
            }
            return { kind: 'failed' as const, reflex, step: entry }
          })
          if (outcome.kind === 'missing') {
            return jsonResult({ ok: false, error: `Step "${key}" is not initialized` })
          }
          if (outcome.kind === 'verified') {
            return jsonResult({
              ok: true,
              verified: true,
              receiptId: outcome.receiptId,
              step: outcome.step,
            })
          }
          if (outcome.kind === 'failed') {
            return jsonResult({
              ok: false,
              verified: false,
              reflex: outcome.reflex,
              step: outcome.step,
            })
          }

          // Reflex escalation: bounded retries are exhausted. Cascade the
          // invalidation like an explicit rollback so dependents never keep a
          // stale "ready" state.
          const cascadeReason = `Step "${key}" exhausted reflexive retries; dependent invalidated by cascade`
          let rollbackResult: { rolledBackToTree?: string; ok?: boolean } | undefined
          let blocked: string[] = []
          if (input.autoRollback !== false && outcome.baselineTree) {
            const rb = await restoreGitCheckpoint(cwd, outcome.baselineTree)
            rollbackResult = { rolledBackToTree: outcome.baselineTree, ok: rb.ok }
            const patched = updateStepLedger(cwd, (ledger) => {
              const entry = ledger.steps[key]
              if (!entry) return { step: undefined, blocked: [] as string[] }
              if (rb.ok) {
                entry.state = 'rolled_back'
                entry.rolledBackAt = nowIso
              } else {
                entry.state = 'blocked'
              }
              entry.updatedAt = nowIso
              const invalidated = applyCascade(ledger, key, cascadeReason, nowIso)
              return { step: entry, blocked: invalidated.map((item) => item.stepKey) }
            })
            blocked = patched.blocked
            getSharedBus().emit('step:rollback', {
              stepKey: key,
              reason: outcome.reflex.reason,
              restoredTree: outcome.baselineTree,
              success: rb.ok,
              timestamp: Date.now(),
            })
            const latest = readStepLedger(cwd)
            for (const blockedKey of blocked) emitBlocked(blockedKey, latest.steps[blockedKey])
            return jsonResult({
              ok: false,
              verified: false,
              reflex: outcome.reflex,
              ...(rollbackResult ? { rollback: rollbackResult } : {}),
              step: patched.step ?? outcome.step,
              ...(blocked.length > 0 ? { blocked } : {}),
            })
          }

          const patched = updateStepLedger(cwd, (ledger) => {
            const entry = ledger.steps[key]
            if (!entry) return { step: undefined, blocked: [] as string[] }
            entry.state = 'blocked'
            entry.updatedAt = nowIso
            const invalidated = applyCascade(ledger, key, cascadeReason, nowIso)
            return { step: entry, blocked: invalidated.map((item) => item.stepKey) }
          })
          const latest = readStepLedger(cwd)
          for (const blockedKey of patched.blocked) {
            emitBlocked(blockedKey, latest.steps[blockedKey])
          }
          return jsonResult({
            ok: false,
            verified: false,
            reflex: outcome.reflex,
            step: patched.step ?? outcome.step,
            ...(patched.blocked.length > 0 ? { blocked: patched.blocked } : {}),
          })
        }

        if (action === 'unblock_step') {
          const outcome = updateStepLedger(cwd, (ledger) => {
            const entry = ledger.steps[key]
            if (!entry) return { kind: 'missing' as const }
            if (entry.state !== 'blocked') {
              return { kind: 'not_blocked' as const, state: entry.state, step: entry }
            }
            const unmet = (entry.dependsOn ?? []).filter(
              (dep) => ledger.steps[dep]?.state !== 'done',
            )
            if (unmet.length > 0) return { kind: 'unmet' as const, unmet, step: entry }
            entry.state = 'in_progress'
            entry.updatedAt = nowIso
            delete entry.blockedBy
            delete entry.cascadeReason
            return { kind: 'unblocked' as const, step: entry }
          })
          if (outcome.kind === 'missing') {
            return jsonResult({ ok: false, error: `Step "${key}" is not initialized` })
          }
          if (outcome.kind === 'unmet') {
            return jsonResult({
              ok: false,
              error: 'dependencies_unmet',
              unmet: outcome.unmet,
              step: outcome.step,
            })
          }
          if (outcome.kind === 'not_blocked') {
            return jsonResult({
              ok: false,
              error: 'not_blocked',
              state: outcome.state,
              step: outcome.step,
            })
          }
          return jsonResult({ ok: true, status: 'in_progress', step: outcome.step })
        }

        if (action === 'complete_step') {
          const outcome = updateStepLedger(cwd, (ledger) => {
            const entry = ledger.steps[key]
            if (!entry) return { kind: 'missing' as const }
            // A cascade-blocked dependent must never become `done` while its
            // prerequisite is rolled_back: dependencies gate completion too.
            const unmet = (entry.dependsOn ?? []).filter(
              (dep) => ledger.steps[dep]?.state !== 'done',
            )
            if (unmet.length > 0) {
              return { kind: 'unmet' as const, unmet, step: entry }
            }
            const gate = canTransitionStepToDone(entry)
            if (!gate.allowed) return { kind: 'refused' as const, reason: gate.reason, step: entry }
            const readyBefore = new Set(
              readyStepKeys(Object.values(ledger.steps) as DependencyNode[]),
            )
            entry.state = 'done'
            entry.updatedAt = nowIso
            delete entry.blockedBy
            delete entry.cascadeReason
            const readyAfter = readyStepKeys(Object.values(ledger.steps) as DependencyNode[])
            const unlocked = readyAfter.filter((dep) => dep !== key && !readyBefore.has(dep))
            return { kind: 'done' as const, step: entry, unlocked }
          })
          if (outcome.kind === 'missing') {
            return jsonResult({ ok: false, error: `Step "${key}" is not initialized` })
          }
          if (outcome.kind === 'unmet') {
            return jsonResult({
              ok: false,
              error: 'dependencies_unmet',
              unmet: outcome.unmet,
              step: outcome.step,
            })
          }
          if (outcome.kind === 'refused') {
            return jsonResult({ ok: false, error: outcome.reason, step: outcome.step })
          }

          const callerSidDone =
            typeof (context as { sessionID?: unknown } | undefined)?.sessionID === 'string'
              ? (context as { sessionID: string }).sessionID
              : undefined
          const releaseHookDone = (
            globalThis as {
              __pantheonFileLeases?: {
                releaseFileLease?: (opts: {
                  sessionID: string
                  holder: string
                }) => Promise<void> | void
              }
            }
          ).__pantheonFileLeases?.releaseFileLease
          if (callerSidDone && releaseHookDone) {
            await releaseHookDone({ sessionID: callerSidDone, holder: outcome.step.agent })
          }
          const latest = readStepLedger(cwd)
          for (const dependent of outcome.unlocked) {
            const dependentEntry = latest.steps[dependent]
            if (!dependentEntry) continue
            getSharedBus().emit('step:unlocked', {
              stepKey: dependent,
              unlockedBy: key,
              dependsOn: [...(dependentEntry.dependsOn ?? [])],
              timestamp: Date.now(),
            })
          }
          return jsonResult({
            ok: true,
            status: 'done',
            receiptId: outcome.step.receiptId,
            step: outcome.step,
            ...(outcome.unlocked.length > 0 ? { unlocked: outcome.unlocked } : {}),
          })
        }

        return jsonResult({ ok: false, error: `Unsupported action: ${action}` })
      } catch (err) {
        const structured = describeLedgerError(err)
        if (structured) return jsonResult(structured)
        return jsonResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
}
