/**
 * Autonomous Sub-Session Step Runner (`step-runner.ts`).
 *
 * Executes an atomic Step-Ledger task inside an isolated OpenCode 2.x sub-session
 * via `ctx.session.create`, seeding only the bounded objective, `stepKey`, and
 * verification contract so multi-step executions avoid context blowup.
 */

import { captureGitCheckpoint } from './git-checkpoint.ts'
import {
  readStepLedger,
  type StepState,
  type StepTaskType,
  writeStepLedger,
} from './step-ledger.ts'

/** Structural subset of OpenCode 2.x `ctx.session` (`SessionDomain`) aligned with `@opencode/client`. */
export interface SubSessionDomainLike {
  create?: (input?: { title?: string; agent?: string; parentID?: string }) => Promise<{
    id?: string
  }>
  prompt?: (input: {
    sessionID: string
    text: string
    agents?: ReadonlyArray<{ readonly name: string }>
    resume?: boolean
  }) => Promise<unknown>
  wait?: (input: { readonly sessionID: string }) => Promise<unknown>
  remove?: (input: { readonly sessionID: string }) => Promise<unknown>
}

export interface AtomicStepRunInput {
  readonly sessionDomain: SubSessionDomainLike
  readonly cwd: string
  readonly stepKey: string
  readonly objective: string
  readonly agent: string
  readonly taskType?: StepTaskType
  readonly parentSessionID?: string
  readonly extraContext?: string
  readonly cleanupSession?: boolean
}

export interface AtomicStepRunResult {
  readonly ok: boolean
  readonly stepKey: string
  readonly sessionID?: string
  readonly stepState?: StepState
  readonly receiptId?: string
  readonly error?: string
}

/** Build the strict single-step contract prompt (objective + ledger key only). */
export function buildAtomicStepPrompt(input: {
  readonly stepKey: string
  readonly objective: string
  readonly agent: string
  readonly extraContext?: string
}): string {
  const lines = [
    `[ATOMIC STEP CONTRACT]`,
    `stepKey: ${input.stepKey}`,
    `agent: ${input.agent}`,
    `objective: ${input.objective}`,
    '',
    'Rules:',
    `1. Operate strictly on the objective above; report mutations with pantheon_step_ledger(action="record_mutation", stepKey="${input.stepKey}", files=[...]).`,
    `2. Run targeted verification and record via pantheon_step_ledger(action="record_verification", stepKey="${input.stepKey}", command="...", exitCode=0).`,
    `3. Finish by calling pantheon_step_ledger(action="complete_step", stepKey="${input.stepKey}").`,
  ]
  if (input.extraContext?.trim()) {
    lines.push('', 'Bounded context:', input.extraContext.trim())
  }
  return lines.join('\n')
}

/**
 * Initialize a ledger step (with Git checkpoint baseline), spawn an isolated
 * sub-session via `ctx.session.create`, dispatch the bounded step contract,
 * and clean up the ephemeral session once completed.
 */
export async function runAtomicStepSubSession(
  input: AtomicStepRunInput,
): Promise<AtomicStepRunResult> {
  const { sessionDomain, cwd, stepKey, objective, agent } = input
  if (typeof sessionDomain?.create !== 'function' || typeof sessionDomain?.prompt !== 'function') {
    return { ok: false, stepKey, error: 'host session.create/prompt domain unavailable' }
  }

  // Ensure ledger entry + Git checkpoint baseline exist cleanly before sub-session starts
  const store = readStepLedger(cwd)
  if (!store.steps[stepKey]) {
    const ckpt = await captureGitCheckpoint(cwd, stepKey)
    store.steps[stepKey] = {
      stepKey,
      objective,
      agent,
      state: 'in_progress',
      ...(input.taskType ? { taskType: input.taskType } : {}),
      ...(ckpt.ok && ckpt.treeHash ? { baselineTree: ckpt.treeHash } : {}),
      mutatedFiles: [],
      lastMutationAt: null,
      lastVerifiedAt: null,
      updatedAt: new Date().toISOString(),
    }
    writeStepLedger(cwd, store)
  }

  let createdId: string | undefined
  try {
    const created = await sessionDomain.create({
      title: `Step ${stepKey}: ${objective.slice(0, 60)}`,
      agent,
      ...(input.parentSessionID ? { parentID: input.parentSessionID } : {}),
    })
    createdId = typeof created?.id === 'string' ? created.id : undefined
    if (!createdId) {
      return { ok: false, stepKey, error: 'ctx.session.create returned no session id' }
    }

    const text = buildAtomicStepPrompt({
      stepKey,
      objective,
      agent,
      ...(input.extraContext !== undefined ? { extraContext: input.extraContext } : {}),
    })
    await sessionDomain.prompt({
      sessionID: createdId,
      text,
      agents: [{ name: agent }],
      resume: true,
    })
    if (typeof sessionDomain.wait === 'function') {
      await sessionDomain.wait({ sessionID: createdId })
    }

    const latest = readStepLedger(cwd).steps[stepKey]
    return {
      ok: latest?.state === 'done',
      stepKey,
      sessionID: createdId,
      ...(latest?.state !== undefined ? { stepState: latest.state } : {}),
      ...(latest?.receiptId !== undefined ? { receiptId: latest.receiptId } : {}),
    }
  } catch (err: unknown) {
    return {
      ok: false,
      stepKey,
      ...(createdId !== undefined ? { sessionID: createdId } : {}),
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    if (createdId && input.cleanupSession !== false && typeof sessionDomain.remove === 'function') {
      try {
        await sessionDomain.remove({ sessionID: createdId })
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}
