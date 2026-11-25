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

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { getSharedBus } from './bus.ts'
import { spawnEphemeralWorker } from './ephemeral-worker.ts'
import { createExecutionReceipt } from './execution-receipt.ts'
import { captureGitCheckpoint, restoreGitCheckpoint } from './git-checkpoint.ts'
import { runAtomicStepSubSession, type SubSessionDomainLike } from './step-runner.ts'
import { ThemisReflexController } from './themis-reflex.ts'
import { resolveToolCwd } from './tool-context.ts'
import type { PantheonToolDef, PantheonToolResult } from './tools.ts'

export type StepState = 'pending' | 'in_progress' | 'done' | 'blocked' | 'rolled_back'
export type StepTaskType = 'feature' | 'bugfix' | 'refactor' | 'chore'

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
  receiptId?: string
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
  const dir = join(workspaceDir, '.pantheon', 'ledger')
  mkdirSync(dir, { recursive: true })
  const canonicalDir = realpathSync(dir)
  const filePath = resolve(canonicalDir, 'step-ledger.json')
  const prefix = canonicalDir.endsWith(sep) ? canonicalDir : `${canonicalDir}${sep}`
  if (!filePath.startsWith(prefix)) {
    throw new Error('Path traversal denied for step-ledger.json')
  }
  return filePath
}

export function readStepLedger(workspaceDir: string): StepLedgerStore {
  const filePath = resolveLedgerPath(workspaceDir)
  if (!existsSync(filePath)) {
    return { version: 1, steps: {} }
  }
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

export function writeStepLedger(workspaceDir: string, store: StepLedgerStore): void {
  const filePath = resolveLedgerPath(workspaceDir)
  writeFileSync(filePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
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
            'record_reproduction',
            'record_mutation',
            'record_verification',
            'complete_step',
            'rollback_step',
            'status',
          ],
          description:
            'Ledger operation (init_step | execute_step | spawn_ephemeral | record_reproduction | record_mutation | record_verification | complete_step | rollback_step | status)',
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
          maximum: 10,
          description: 'Max continuation turns for execute_step/spawn_ephemeral (default 1)',
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
      },
    },
    output: {},
    execute: async (input, context) => {
      try {
        const action = typeof input.action === 'string' ? input.action : 'status'
        const cwd = resolveToolCwd(context, fallbackDir)
        const store = readStepLedger(cwd)
        const now = Date.now()
        const nowIso = new Date(now).toISOString()

        if (action === 'status') {
          if (typeof input.stepKey === 'string' && input.stepKey.trim()) {
            const key = assertSafeStepKey(input.stepKey.trim())
            const step = store.steps[key]
            if (!step) return jsonResult({ ok: false, error: 'step_not_found', stepKey: key })
            return jsonResult({ ok: true, step, gate: canTransitionStepToDone(step) })
          }
          return jsonResult({ ok: true, steps: Object.values(store.steps) })
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
          const ckpt = await captureGitCheckpoint(cwd, key)
          const entry: StepLedgerEntry = {
            stepKey: key,
            objective,
            agent,
            state: 'in_progress',
            ...(taskType ? { taskType } : {}),
            ...(ckpt.ok && ckpt.treeHash ? { baselineTree: ckpt.treeHash } : {}),
            mutatedFiles: [],
            lastMutationAt: null,
            lastVerifiedAt: null,
            updatedAt: nowIso,
          }
          store.steps[key] = entry
          writeStepLedger(cwd, store)
          return jsonResult({ ok: true, step: entry })
        }

        if (action === 'execute_step') {
          if (!sessionDomain) {
            return jsonResult({ ok: false, error: 'host session domain unavailable' })
          }
          const objective =
            typeof input.objective === 'string' && input.objective.trim()
              ? input.objective.trim()
              : (store.steps[key]?.objective ?? '')
          if (!objective) return jsonResult({ ok: false, error: 'objective is required' })
          const agent =
            typeof input.agent === 'string' && input.agent.trim()
              ? input.agent.trim().replace(/^@/, '')
              : (store.steps[key]?.agent ?? 'hermes')
          const rawTaskType = input.taskType
          const taskType: StepTaskType | undefined =
            rawTaskType === 'feature' ||
            rawTaskType === 'bugfix' ||
            rawTaskType === 'refactor' ||
            rawTaskType === 'chore'
              ? rawTaskType
              : store.steps[key]?.taskType
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
          })
          return jsonResult(runOut)
        }

        if (action === 'spawn_ephemeral') {
          if (!sessionDomain) {
            return jsonResult({ ok: false, error: 'host session domain unavailable' })
          }
          const objective =
            typeof input.objective === 'string' && input.objective.trim()
              ? input.objective.trim()
              : (store.steps[key]?.objective ?? '')
          if (!objective) return jsonResult({ ok: false, error: 'objective is required' })
          const role =
            typeof input.role === 'string' && input.role.trim()
              ? input.role.trim()
              : `worker-${key}`
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
          })
          return jsonResult(ephOut)
        }

        const step = store.steps[key]
        if (!step) {
          return jsonResult({ ok: false, error: `Step "${key}" is not initialized` })
        }

        if (action === 'record_reproduction') {
          const command = typeof input.command === 'string' ? input.command.trim() : ''
          const exitCode = typeof input.exitCode === 'number' ? input.exitCode : 1
          if (!command) return jsonResult({ ok: false, error: 'command is required' })
          if (exitCode === 0) {
            return jsonResult({
              ok: false,
              error: 'Bugfix reproduction must demonstrate a failing test/probe (exitCode !== 0)',
              step,
            })
          }
          step.reproductionCommand = command
          step.reproductionExitCode = exitCode
          step.reproductionRecordedAt = now
          step.updatedAt = nowIso
          writeStepLedger(cwd, store)
          return jsonResult({ ok: true, reproduced: true, step })
        }

        if (action === 'rollback_step') {
          if (!step.baselineTree) {
            return jsonResult({ ok: false, error: `Step "${key}" has no Git baselineTree`, step })
          }
          const rb = await restoreGitCheckpoint(cwd, step.baselineTree)
          if (rb.ok) {
            step.state = 'rolled_back'
            step.rolledBackAt = nowIso
            step.updatedAt = nowIso
            writeStepLedger(cwd, store)
          }
          getSharedBus().emit('step:rollback', {
            stepKey: key,
            reason: 'manual_rollback_step',
            restoredTree: step.baselineTree,
            success: rb.ok,
            timestamp: Date.now(),
          })
          return jsonResult({ ok: rb.ok, restoredTree: step.baselineTree, error: rb.reason, step })
        }

        if (action === 'record_mutation') {
          const files = Array.isArray(input.files) ? input.files.map(String) : []
          const merged = Array.from(new Set([...step.mutatedFiles, ...files]))
          step.mutatedFiles = merged
          step.lastMutationAt = now
          if (step.state === 'done') step.state = 'in_progress'
          step.updatedAt = nowIso
          writeStepLedger(cwd, store)
          return jsonResult({ ok: true, step })
        }

        if (action === 'record_verification') {
          const command = typeof input.command === 'string' ? input.command.trim() : ''
          const exitCode = typeof input.exitCode === 'number' ? input.exitCode : 1
          const durationMs = typeof input.durationMs === 'number' ? input.durationMs : 0
          if (!command) return jsonResult({ ok: false, error: 'command is required' })

          step.verificationCommand = command
          step.verificationExitCode = exitCode
          step.lastVerifiedAt = now
          step.updatedAt = nowIso

          if (exitCode === 0) {
            stepReflex.evaluate(key, step.agent, [])
            const receipt = createExecutionReceipt({
              taskID: key,
              agent: step.agent,
              files: step.mutatedFiles.map((f) => ({ path: f, content: `${key}:${f}:${now}` })),
              testSlice: { command, exitCode: 0, durationMs },
            })
            step.receiptId = receipt.receiptId
            writeStepLedger(cwd, store)
            return jsonResult({ ok: true, verified: true, receiptId: receipt.receiptId, step })
          }

          const reflex = stepReflex.evaluate(key, step.agent, [
            {
              file: step.mutatedFiles[0] ?? key,
              error: `Verification command "${command}" failed with exit code ${exitCode}`,
            },
          ])
          let rollbackResult: { restoredTree?: string; ok?: boolean } | undefined
          if (reflex.action === 'escalate') {
            step.state = 'blocked'
            if (input.autoRollback !== false && step.baselineTree) {
              const rb = await restoreGitCheckpoint(cwd, step.baselineTree)
              rollbackResult = { restoredTree: step.baselineTree, ok: rb.ok }
              if (rb.ok) {
                step.state = 'rolled_back'
                step.rolledBackAt = nowIso
              }
              getSharedBus().emit('step:rollback', {
                stepKey: key,
                reason: reflex.reason,
                restoredTree: step.baselineTree,
                success: rb.ok,
                timestamp: Date.now(),
              })
            }
          }
          writeStepLedger(cwd, store)
          return jsonResult({
            ok: false,
            verified: false,
            reflex,
            ...(rollbackResult ? { rollback: rollbackResult } : {}),
            step,
          })
        }

        if (action === 'complete_step') {
          const gate = canTransitionStepToDone(step)
          if (!gate.allowed) {
            return jsonResult({ ok: false, error: gate.reason, step })
          }
          step.state = 'done'
          step.updatedAt = nowIso
          writeStepLedger(cwd, store)
          return jsonResult({ ok: true, status: 'done', receiptId: step.receiptId, step })
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
