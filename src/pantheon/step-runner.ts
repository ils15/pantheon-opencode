/**
 * Autonomous Sub-Session Step Runner (`step-runner.ts`).
 *
 * Executes an atomic Step-Ledger task inside an isolated OpenCode 2.x sub-session
 * via `ctx.session.create` (or reuses a caller-owned session), supports bounded
 * multi-turn execution, schema-validated finish payloads, and deterministic
 * context forking (`session.fork` with bounded `create+prompt` fallback).
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
  fork?: (input: { sessionID: string; title?: string; agent?: string }) => Promise<{
    id?: string
  }>
  prompt?: (input: {
    sessionID: string
    text: string
    agents?: ReadonlyArray<{ readonly name: string }>
    resume?: boolean
  }) => Promise<unknown>
  wait?: (input: { readonly sessionID: string }) => Promise<unknown>
  messages?: (input: { readonly sessionID: string }) => Promise<unknown>
  remove?: (input: { readonly sessionID: string }) => Promise<unknown>
}

export interface StepFinishPayload {
  readonly status: 'complete' | 'partial' | 'failed'
  readonly summary: string
  readonly filesChanged?: readonly string[]
  readonly receiptId?: string
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
  readonly reuseSessionID?: string
  readonly maxTurns?: number
  readonly requireFinishPayload?: boolean
}

export interface AtomicStepRunResult {
  readonly ok: boolean
  readonly stepKey: string
  readonly sessionID?: string
  readonly stepState?: StepState
  readonly receiptId?: string
  readonly reusedSession?: boolean
  readonly turnsUsed?: number
  readonly finishPayload?: StepFinishPayload
  readonly error?: string
}

export interface ForkStepContextInput {
  readonly sourceSessionID: string
  readonly title?: string
  readonly agent?: string
  readonly fallbackSummary?: string
}

export interface ForkStepContextResult {
  readonly ok: boolean
  readonly sessionID?: string
  readonly forked: boolean
  readonly mode: 'native_fork' | 'fallback_seed'
  readonly error?: string
}

const VALID_FINISH_STATUS = new Set(['complete', 'partial', 'failed'])

/** Validate a structured step finish contract payload. */
export function validateStepFinishPayload(
  raw: unknown,
): { ok: true; value: StepFinishPayload } | { ok: false; errors: string[] } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['finish payload must be a plain object'] }
  }
  const rec = raw as Record<string, unknown>
  const errors: string[] = []

  if (typeof rec.status !== 'string' || !VALID_FINISH_STATUS.has(rec.status)) {
    errors.push('status must be one of "complete" | "partial" | "failed"')
  }
  if (typeof rec.summary !== 'string' || rec.summary.trim() === '') {
    errors.push('summary must be a non-empty string')
  }
  let filesChanged: string[] | undefined
  if (rec.filesChanged !== undefined) {
    if (
      !Array.isArray(rec.filesChanged) ||
      rec.filesChanged.some((entry) => typeof entry !== 'string')
    ) {
      errors.push('filesChanged must be an array of strings')
    } else {
      filesChanged = rec.filesChanged as string[]
    }
  }
  let receiptId: string | undefined
  if (rec.receiptId !== undefined) {
    if (typeof rec.receiptId !== 'string' || rec.receiptId.trim() === '') {
      errors.push('receiptId must be a non-empty string when provided')
    } else {
      receiptId = rec.receiptId.trim()
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    value: {
      status: rec.status as StepFinishPayload['status'],
      summary: (rec.summary as string).trim(),
      ...(filesChanged !== undefined ? { filesChanged } : {}),
      ...(receiptId !== undefined ? { receiptId } : {}),
    },
  }
}

function extractFinishPayloadFromMessages(rawMessages: unknown): StepFinishPayload | undefined {
  if (!Array.isArray(rawMessages) || rawMessages.length === 0) return undefined
  for (let i = rawMessages.length - 1; i >= 0; i -= 1) {
    const item = rawMessages[i]
    if (!item || typeof item !== 'object') continue
    const candidate = item as Record<string, unknown>
    const direct = validateStepFinishPayload(candidate)
    if (direct.ok) return direct.value

    const parts = Array.isArray(candidate.parts) ? candidate.parts : []
    for (let j = parts.length - 1; j >= 0; j -= 1) {
      const part = parts[j] as { text?: unknown } | null | undefined
      if (typeof part?.text !== 'string') continue
      const jsonMatch = /\{[\s\S]*"status"\s*:[\s\S]*\}/.exec(part.text)
      if (!jsonMatch) continue
      try {
        const parsed = JSON.parse(jsonMatch[0]) as unknown
        const validated = validateStepFinishPayload(parsed)
        if (validated.ok) return validated.value
      } catch {
        /* ignore non-JSON braces */
      }
    }
  }
  return undefined
}

/**
 * Fork a sub-session context using `sessionDomain.fork` when exposed by the host,
 * falling back deterministically to `sessionDomain.create` + bounded context seed.
 */
export async function forkStepContext(
  sessionDomain: SubSessionDomainLike,
  input: ForkStepContextInput,
): Promise<ForkStepContextResult> {
  if (typeof sessionDomain?.fork === 'function') {
    try {
      const forked = await sessionDomain.fork({
        sessionID: input.sourceSessionID,
        ...(input.title ? { title: input.title } : {}),
        ...(input.agent ? { agent: input.agent } : {}),
      })
      const id = typeof forked?.id === 'string' && forked.id.trim() ? forked.id.trim() : undefined
      if (id) {
        return { ok: true, sessionID: id, forked: true, mode: 'native_fork' }
      }
    } catch {
      /* fall through to deterministic fallback */
    }
  }

  if (typeof sessionDomain?.create !== 'function') {
    return {
      ok: false,
      forked: false,
      mode: 'fallback_seed',
      error: 'host session.fork/create domain unavailable',
    }
  }

  try {
    const created = await sessionDomain.create({
      ...(input.title ? { title: input.title } : {}),
      ...(input.agent ? { agent: input.agent } : {}),
      parentID: input.sourceSessionID,
    })
    const createdId =
      typeof created?.id === 'string' && created.id.trim() ? created.id.trim() : undefined
    if (!createdId) {
      return {
        ok: false,
        forked: false,
        mode: 'fallback_seed',
        error: 'ctx.session.create returned no session id',
      }
    }
    if (input.fallbackSummary?.trim() && typeof sessionDomain.prompt === 'function') {
      await sessionDomain.prompt({
        sessionID: createdId,
        text: `[CONTEXT SEED from ${input.sourceSessionID}]\n${input.fallbackSummary.trim()}`,
        ...(input.agent ? { agents: [{ name: input.agent }] } : {}),
      })
    }
    return { ok: true, sessionID: createdId, forked: false, mode: 'fallback_seed' }
  } catch (err: unknown) {
    return {
      ok: false,
      forked: false,
      mode: 'fallback_seed',
      error: err instanceof Error ? err.message : String(err),
    }
  }
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
 * sub-session via `ctx.session.create` (or reuse `reuseSessionID`), dispatch the
 * bounded step contract for up to `maxTurns` turns, and clean up ephemeral
 * sessions when completed.
 */
export async function runAtomicStepSubSession(
  input: AtomicStepRunInput,
): Promise<AtomicStepRunResult> {
  const { sessionDomain, cwd, stepKey, objective, agent } = input
  const reuseId =
    typeof input.reuseSessionID === 'string' && input.reuseSessionID.trim() !== ''
      ? input.reuseSessionID.trim()
      : undefined
  const reusedSession = reuseId !== undefined

  if (
    typeof sessionDomain?.prompt !== 'function' ||
    (!reusedSession && typeof sessionDomain?.create !== 'function')
  ) {
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

  const maxTurns =
    typeof input.maxTurns === 'number' && Number.isInteger(input.maxTurns)
      ? Math.max(1, Math.min(10, input.maxTurns))
      : 1

  let createdId: string | undefined = reuseId
  let turnsUsed = 0
  try {
    if (!reusedSession) {
      // biome-ignore lint/style/noNonNullAssertion: guarded above when !reusedSession
      const created = await sessionDomain.create!({
        title: `Step ${stepKey}: ${objective.slice(0, 60)}`,
        agent,
        ...(input.parentSessionID ? { parentID: input.parentSessionID } : {}),
      })
      createdId = typeof created?.id === 'string' ? created.id : undefined
      if (!createdId) {
        return { ok: false, stepKey, error: 'ctx.session.create returned no session id' }
      }
    }

    const activeSessionId = createdId as string
    for (let turn = 1; turn <= maxTurns; turn += 1) {
      turnsUsed = turn
      const text =
        turn === 1
          ? buildAtomicStepPrompt({
              stepKey,
              objective,
              agent,
              ...(input.extraContext !== undefined ? { extraContext: input.extraContext } : {}),
            })
          : [
              `[ATOMIC STEP CONTINUATION turn ${turn}/${maxTurns}]`,
              `stepKey: ${stepKey}`,
              `objective: ${objective}`,
              `Finish verification via pantheon_step_ledger(action="record_verification") and complete via pantheon_step_ledger(action="complete_step", stepKey="${stepKey}").`,
            ].join('\n')

      await sessionDomain.prompt({
        sessionID: activeSessionId,
        text,
        agents: [{ name: agent }],
        resume: true,
      })
      if (typeof sessionDomain.wait === 'function') {
        await sessionDomain.wait({ sessionID: activeSessionId })
      }
      const snapshot = readStepLedger(cwd).steps[stepKey]
      if (
        snapshot?.state === 'done' ||
        snapshot?.state === 'blocked' ||
        snapshot?.state === 'rolled_back'
      ) {
        break
      }
    }

    let finishPayload: StepFinishPayload | undefined
    if (typeof sessionDomain.messages === 'function') {
      try {
        const msgs = await sessionDomain.messages({ sessionID: activeSessionId })
        finishPayload = extractFinishPayloadFromMessages(msgs)
      } catch {
        /* best-effort finish payload inspection */
      }
    }

    const latest = readStepLedger(cwd).steps[stepKey]
    const payloadMissingError =
      input.requireFinishPayload === true && finishPayload === undefined
        ? 'missing valid step finish payload'
        : undefined
    const ok = latest?.state === 'done' && payloadMissingError === undefined
    return {
      ok,
      stepKey,
      sessionID: activeSessionId,
      reusedSession,
      turnsUsed,
      ...(latest?.state !== undefined ? { stepState: latest.state } : {}),
      ...(latest?.receiptId !== undefined ? { receiptId: latest.receiptId } : {}),
      ...(finishPayload !== undefined ? { finishPayload } : {}),
      ...(payloadMissingError !== undefined ? { error: payloadMissingError } : {}),
    }
  } catch (err: unknown) {
    return {
      ok: false,
      stepKey,
      ...(createdId !== undefined ? { sessionID: createdId } : {}),
      reusedSession,
      ...(turnsUsed > 0 ? { turnsUsed } : {}),
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    if (
      !reusedSession &&
      createdId &&
      input.cleanupSession !== false &&
      typeof sessionDomain.remove === 'function'
    ) {
      try {
        await sessionDomain.remove({ sessionID: createdId })
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}
