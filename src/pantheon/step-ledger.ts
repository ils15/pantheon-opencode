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

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { getSharedBus } from './bus.ts'
import {
  deriveEphemeralRoleSlug,
  spawnEphemeralWorker,
  verifyEphemeralBranches,
} from './ephemeral-worker.ts'
import { createExecutionReceipt } from './execution-receipt.ts'
import { captureGitCheckpoint, restoreGitCheckpoint } from './git-checkpoint.ts'
import {
  buildDependencyGraph,
  cascadeBlock,
  type DependencyNode,
  type DependencyValidationResult,
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

function readLedgerFileAtPath(filePath: string): StepLedgerStore {
  if (!existsSync(filePath)) return { version: 1, steps: {} }
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<StepLedgerStore>
    if (parsed && typeof parsed.steps === 'object' && parsed.steps !== null) {
      return { version: 1, steps: parsed.steps as Record<string, StepLedgerEntry> }
    }
  } catch {
    /* recover empty store on corrupt file */
  }
  return { version: 1, steps: {} }
}

export function readStepLedger(workspaceDir: string): StepLedgerStore {
  return readLedgerFileAtPath(resolveLedgerPath(workspaceDir))
}

/** Seconds a lock file may live before it is considered abandoned by a dead writer. */
const LOCK_STALE_MS = 10_000
const LOCK_RETRIES = 20
const LOCK_RETRY_MS = 25

const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))

function sleepMs(ms: number): void {
  Atomics.wait(sleepBuffer, 0, 0, ms)
}

function resolveLockPath(ledgerPath: string): string {
  return join(dirname(ledgerPath), '.step-ledger.lock')
}

/**
 * Acquire the ledger write lock (`open(..., 'wx')`). Bounded retry (20 x 25 ms)
 * with a stale-lock break when the holder died mid-write (mtime > 10 s).
 */
function acquireLedgerLock(lockPath: string): void {
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeSync(fd, `${process.pid}\n`)
      } finally {
        closeSync(fd)
      }
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code
      if (code !== 'EEXIST') throw err
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath)
          continue
        }
      } catch {
        /* lock vanished between open and stat — retry immediately */
        continue
      }
      if (attempt === LOCK_RETRIES) {
        throw new Error(`step-ledger lock timeout after ${LOCK_RETRIES * LOCK_RETRY_MS}ms`)
      }
      sleepMs(LOCK_RETRY_MS)
    }
  }
}

function releaseLedgerLock(lockPath: string): void {
  try {
    unlinkSync(lockPath)
  } catch {
    /* already released or never created */
  }
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
 * lock is held.
 */
export function updateStepLedger<T>(
  workspaceDir: string,
  mutator: (store: StepLedgerStore) => T,
): T {
  const filePath = resolveLedgerPath(workspaceDir)
  const lockPath = resolveLockPath(filePath)
  acquireLedgerLock(lockPath)
  try {
    const store = readLedgerFileAtPath(filePath)
    const result = mutator(store)
    store.version = 1
    writeLedgerFileAtomic(filePath, store)
    return result
  } finally {
    releaseLedgerLock(lockPath)
  }
}

/**
 * Compatibility export. Route writes through `updateStepLedger` when you need a
 * read-modify-write; this is locked and atomic but still overwrites the whole
 * store with the caller's snapshot.
 */
export function writeStepLedger(workspaceDir: string, store: StepLedgerStore): void {
  const filePath = resolveLedgerPath(workspaceDir)
  const lockPath = resolveLockPath(filePath)
  acquireLedgerLock(lockPath)
  try {
    writeLedgerFileAtomic(filePath, { version: 1, steps: store.steps })
  } finally {
    releaseLedgerLock(lockPath)
  }
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
 * A blocked step wins over a merely unmet one: the caller must see why it was
 * invalidated rather than a generic dependency message.
 */
function evaluateLaunchGate(
  entry: StepLedgerEntry | undefined,
  store: StepLedgerStore,
): LaunchGate {
  if (!entry) return { ok: true }
  if (entry.state === 'blocked') {
    return {
      ok: false,
      error: 'step_blocked',
      blockedBy: [...(entry.blockedBy ?? [])],
      ...(entry.cascadeReason ? { cascadeReason: entry.cascadeReason } : {}),
    }
  }
  const unmet = (entry.dependsOn ?? []).filter((dep) => store.steps[dep]?.state !== 'done')
  if (unmet.length > 0) return { ok: false, error: 'dependencies_unmet', unmet }
  return { ok: true }
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

/** Apply a rollback cascade, stamping every invalidated dependent with its reason. */
function applyCascade(
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

/** A ready `pending` step becomes `in_progress` the moment it is launched. */
function markStepInProgress(cwd: string, stepKey: string, nowIso: string): void {
  updateStepLedger(cwd, (ledger) => {
    const entry = ledger.steps[stepKey]
    if (entry?.state !== 'pending') return
    entry.state = 'in_progress'
    entry.updatedAt = nowIso
    delete entry.blockedBy
    delete entry.cascadeReason
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
      'Lifecycle: init_step | execute_step -> [record_reproduction] -> record_mutation -> record_verification -> complete_step | rollback_step | status.',
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
            'status',
          ],
          description:
            'Ledger operation (init_step | execute_step | spawn_ephemeral | verify_ephemeral | record_reproduction | record_mutation | record_verification | complete_step | rollback_step | status)',
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
          markStepInProgress(cwd, key, nowIso)
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
          markStepInProgress(cwd, key, nowIso)
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
          const doneDependents = cascadeBlock(
            Object.values(preStore.steps) as DependencyNode[],
            key,
            'manual_rollback_step',
          ).filter((target) => preStore.steps[target.stepKey]?.state === 'done')
          if (doneDependents.length > 0 && !cascade) {
            return jsonResult({
              ok: false,
              error: 'dependents_done',
              dependents: doneDependents.map((target) => target.stepKey),
              hint: 'Re-run rollback_step with cascade:true to invalidate dependents explicitly.',
              step,
            })
          }

          const rb = await restoreGitCheckpoint(cwd, step.baselineTree)
          const cascadeReason = `Step "${key}" was rolled back; dependent invalidated by cascade`
          const outcome = updateStepLedger(cwd, (ledger) => {
            const entry = ledger.steps[key]
            if (!entry) return { kind: 'missing' as const }
            // Defensive re-check under the lock: a dependent could have completed
            // between the pre-read and the restore above.
            const lateDone = cascadeBlock(
              Object.values(ledger.steps) as DependencyNode[],
              key,
              'manual_rollback_step',
            )
              .filter((target) => ledger.steps[target.stepKey]?.state === 'done')
              .map((target) => target.stepKey)
            if (lateDone.length > 0 && !cascade) {
              return { kind: 'dependents_done' as const, dependents: lateDone }
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
            return jsonResult({ ok: false, error: `Step "${key}" is not initialized` })
          }
          if (outcome.kind === 'dependents_done') {
            return jsonResult({
              ok: false,
              error: 'dependents_done',
              dependents: outcome.dependents,
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
            restoredTree: step.baselineTree,
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
              delete entry.blockedBy
              delete entry.cascadeReason
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
          let rollbackResult: { restoredTree?: string; ok?: boolean } | undefined
          let blocked: string[] = []
          if (input.autoRollback !== false && outcome.baselineTree) {
            const rb = await restoreGitCheckpoint(cwd, outcome.baselineTree)
            rollbackResult = { restoredTree: outcome.baselineTree, ok: rb.ok }
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

        if (action === 'complete_step') {
          const outcome = updateStepLedger(cwd, (ledger) => {
            const entry = ledger.steps[key]
            if (!entry) return { kind: 'missing' as const }
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
        return jsonResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
}
