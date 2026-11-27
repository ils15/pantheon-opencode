/**
 * Autonomous Sub-Session Step Runner (`step-runner.ts`).
 *
 * Executes an atomic Step-Ledger task inside an isolated OpenCode 2.x sub-session
 * via `ctx.session.create` (or reuses a caller-owned session), supports bounded
 * multi-turn execution, schema-validated finish payloads, and deterministic
 * context forking (`session.fork` with bounded `create+prompt` fallback).
 */

import { anchorCheckpointTree, captureGitCheckpoint } from './git-checkpoint.ts'
import {
  readStepLedger,
  type StepState,
  type StepTaskType,
  updateStepLedger,
} from './step-ledger.ts'
import { resolveSharedPantheonRoot } from './tool-context.ts'

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
  abort?: (input: { readonly sessionID: string }) => Promise<unknown>
  messages?: (input: { readonly sessionID: string }) => Promise<unknown>
  remove?: (input: { readonly sessionID: string }) => Promise<unknown>
}

export interface StepFinishPayload {
  readonly status: 'complete' | 'partial' | 'failed'
  readonly summary: string
  readonly filesChanged?: readonly string[]
  readonly receiptId?: string
}

export const DEFAULT_WALL_CLOCK_MS = 300_000

export type StepHaltReason = 'wall_clock_exceeded' | 'max_cost_exceeded'

export interface AtomicStepRunInput {
  readonly sessionDomain: SubSessionDomainLike
  readonly cwd: string
  readonly ledgerRoot?: string
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
  readonly wallClockMs?: number
  readonly maxCostUsd?: number
  readonly ownedFiles?: readonly string[]
  readonly forbiddenFiles?: readonly string[]
  readonly getSessionCostUsd?: (
    sessionID: string,
  ) => Promise<number | undefined> | number | undefined
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
  readonly haltedReason?: StepHaltReason
  readonly elapsedMs?: number
  readonly costUsd?: number
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

function extractMessageCostUsd(msg: unknown): number | undefined {
  if (!msg || typeof msg !== 'object') return undefined
  const rec = msg as Record<string, unknown>
  const direct =
    typeof rec.costUsd === 'number'
      ? rec.costUsd
      : typeof rec.cost === 'number'
        ? rec.cost
        : undefined
  if (direct !== undefined && Number.isFinite(direct) && direct >= 0) return direct

  const info = rec.info as Record<string, unknown> | undefined
  if (info && typeof info === 'object') {
    const infoCost =
      typeof info.costUsd === 'number'
        ? info.costUsd
        : typeof info.cost === 'number'
          ? info.cost
          : undefined
    if (infoCost !== undefined && Number.isFinite(infoCost) && infoCost >= 0) return infoCost
  }

  const usage = rec.usage as Record<string, unknown> | undefined
  if (usage && typeof usage === 'object') {
    const usageCost =
      typeof usage.costUsd === 'number'
        ? usage.costUsd
        : typeof usage.cost === 'number'
          ? usage.cost
          : undefined
    if (usageCost !== undefined && Number.isFinite(usageCost) && usageCost >= 0) return usageCost
  }
  return undefined
}

async function resolveCumulativeCostUsd(
  input: AtomicStepRunInput,
  sessionID: string,
): Promise<number | undefined> {
  if (typeof input.getSessionCostUsd === 'function') {
    const custom = await input.getSessionCostUsd(sessionID)
    if (typeof custom === 'number' && Number.isFinite(custom) && custom >= 0) {
      return custom
    }
  }
  if (typeof input.sessionDomain.messages !== 'function') return undefined
  try {
    const raw = await input.sessionDomain.messages({ sessionID })
    const list = Array.isArray(raw)
      ? raw
      : raw && typeof raw === 'object' && Array.isArray((raw as { data?: unknown }).data)
        ? (raw as { data: unknown[] }).data
        : []
    let total = 0
    let found = false
    for (const item of list) {
      const c = extractMessageCostUsd(item)
      if (c !== undefined) {
        total += c
        found = true
      }
    }
    return found ? total : undefined
  } catch {
    return undefined
  }
}

/** Build the strict single-step contract prompt (objective + ledger key only). */
export function buildAtomicStepPrompt(input: {
  readonly stepKey: string
  readonly objective: string
  readonly agent: string
  readonly extraContext?: string
  readonly ownedFiles?: readonly string[]
  readonly forbiddenFiles?: readonly string[]
}): string {
  const owned = input.ownedFiles?.map((f) => f.trim()).filter(Boolean) ?? []
  const forbidden = input.forbiddenFiles?.map((f) => f.trim()).filter(Boolean) ?? []
  const lines = [
    `[ATOMIC STEP CONTRACT]`,
    `stepKey: ${input.stepKey}`,
    `agent: ${input.agent}`,
    `objective: ${input.objective}`,
    ...(owned.length > 0 ? [`ownedFiles: ${owned.join(', ')}`] : []),
    ...(forbidden.length > 0 ? [`forbiddenFiles: ${forbidden.join(', ')}`] : []),
    '',
    'Rules:',
    `1. Operate strictly on the objective above; report mutations with pantheon_step_ledger(action="record_mutation", stepKey="${input.stepKey}", files=[...]).`,
    `2. Run targeted verification and record via pantheon_step_ledger(action="record_verification", stepKey="${input.stepKey}", command="...", exitCode=0).`,
    `3. Finish by calling pantheon_step_ledger(action="complete_step", stepKey="${input.stepKey}").`,
  ]
  if (owned.length > 0) {
    lines.push(
      `4. File ownership boundary: ONLY mutate files within ownedFiles (${owned.join(', ')}).`,
    )
  }
  if (forbidden.length > 0) {
    lines.push(
      `${owned.length > 0 ? '5' : '4'}. Forbidden files: NEVER modify or touch forbiddenFiles (${forbidden.join(', ')}).`,
    )
  }
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
  const ledgerRoot = input.ledgerRoot?.trim() ? input.ledgerRoot : resolveSharedPantheonRoot(cwd)
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
  if (!readStepLedger(ledgerRoot).steps[stepKey]) {
    const ckpt = await captureGitCheckpoint(cwd, stepKey)
    const anchor =
      ckpt.ok && ckpt.treeHash ? await anchorCheckpointTree(cwd, ckpt.treeHash, stepKey) : undefined
    updateStepLedger(ledgerRoot, (store) => {
      // Re-check under the lock: a concurrent writer may have created it already.
      if (store.steps[stepKey]) return
      store.steps[stepKey] = {
        stepKey,
        objective,
        agent,
        state: 'in_progress',
        ...(input.taskType ? { taskType: input.taskType } : {}),
        ...(ckpt.ok && ckpt.treeHash ? { baselineTree: ckpt.treeHash } : {}),
        ...(anchor?.ok && anchor.ref ? { baselineRef: anchor.ref } : {}),
        mutatedFiles: [],
        lastMutationAt: null,
        lastVerifiedAt: null,
        updatedAt: new Date().toISOString(),
      }
    })
  }

  const maxTurns =
    typeof input.maxTurns === 'number' && Number.isInteger(input.maxTurns)
      ? Math.max(1, Math.min(20, input.maxTurns))
      : 1
  const wallClockMs =
    typeof input.wallClockMs === 'number' && Number.isFinite(input.wallClockMs)
      ? Math.max(0, input.wallClockMs)
      : DEFAULT_WALL_CLOCK_MS
  const maxCostUsd =
    typeof input.maxCostUsd === 'number' &&
    Number.isFinite(input.maxCostUsd) &&
    input.maxCostUsd >= 0
      ? input.maxCostUsd
      : undefined

  const startedAt = Date.now()
  let createdId: string | undefined = reuseId
  let turnsUsed = 0
  let haltedReason: StepHaltReason | undefined
  let haltError: string | undefined
  let lastCostUsd: number | undefined
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
      const preTurnElapsed = Date.now() - startedAt
      if (preTurnElapsed > wallClockMs || (wallClockMs === 0 && turn >= 1)) {
        haltedReason = 'wall_clock_exceeded'
        haltError = `wall-clock timeout exceeded (${preTurnElapsed}ms > ${wallClockMs}ms)`
        break
      }

      turnsUsed = turn
      const text =
        turn === 1
          ? buildAtomicStepPrompt({
              stepKey,
              objective,
              agent,
              ...(input.extraContext !== undefined ? { extraContext: input.extraContext } : {}),
              ...(input.ownedFiles !== undefined ? { ownedFiles: input.ownedFiles } : {}),
              ...(input.forbiddenFiles !== undefined
                ? { forbiddenFiles: input.forbiddenFiles }
                : {}),
            })
          : [
              `[ATOMIC STEP CONTINUATION turn ${turn}/${maxTurns}]`,
              `stepKey: ${stepKey}`,
              `objective: ${objective}`,
              `Finish verification via pantheon_step_ledger(action="record_verification") and complete via pantheon_step_ledger(action="complete_step", stepKey="${stepKey}").`,
            ].join('\n')

      const remainingMs = Math.max(1, wallClockMs - (Date.now() - startedAt))
      const runTurn = async (): Promise<'ok'> => {
        await sessionDomain.prompt?.({
          sessionID: activeSessionId,
          text,
          agents: [{ name: agent }],
          resume: true,
        })
        if (typeof sessionDomain.wait === 'function') {
          await sessionDomain.wait({ sessionID: activeSessionId })
        }
        return 'ok'
      }
      let timerId: ReturnType<typeof setTimeout> | undefined
      const turnOutcome = await Promise.race([
        runTurn(),
        new Promise<'timeout'>((resolve) => {
          timerId = setTimeout(() => resolve('timeout'), remainingMs)
          if (typeof timerId === 'object' && 'unref' in timerId) timerId.unref()
        }),
      ]).finally(() => {
        if (timerId !== undefined) clearTimeout(timerId)
      })
      if (turnOutcome === 'timeout') {
        await sessionDomain.abort?.({ sessionID: activeSessionId }).catch(() => {})
        haltedReason = 'wall_clock_exceeded'
        haltError = `wall-clock timeout exceeded (${Date.now() - startedAt}ms >= ${wallClockMs}ms)`
        break
      }

      const snapshot = readStepLedger(ledgerRoot).steps[stepKey]
      const isTerminal =
        snapshot?.state === 'done' ||
        snapshot?.state === 'blocked' ||
        snapshot?.state === 'rolled_back'

      if (maxCostUsd !== undefined) {
        lastCostUsd = await resolveCumulativeCostUsd(input, activeSessionId)
        if (lastCostUsd !== undefined && lastCostUsd > maxCostUsd) {
          haltedReason = 'max_cost_exceeded'
          haltError = `max cost exceeded ($${lastCostUsd.toFixed(4)} > $${maxCostUsd.toFixed(4)})`
          break
        }
      }

      if (isTerminal) {
        break
      }

      const postTurnElapsed = Date.now() - startedAt
      if (postTurnElapsed > wallClockMs) {
        haltedReason = 'wall_clock_exceeded'
        haltError = `wall-clock timeout exceeded (${postTurnElapsed}ms > ${wallClockMs}ms)`
        break
      }
    }

    const elapsedMs = Date.now() - startedAt
    if (haltedReason !== undefined) {
      const latest = readStepLedger(ledgerRoot).steps[stepKey]
      return {
        ok: false,
        stepKey,
        sessionID: activeSessionId,
        reusedSession,
        turnsUsed,
        haltedReason,
        elapsedMs,
        ...(lastCostUsd !== undefined ? { costUsd: lastCostUsd } : {}),
        ...(latest?.state !== undefined ? { stepState: latest.state } : {}),
        ...(haltError !== undefined ? { error: haltError } : {}),
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

    const latest = readStepLedger(ledgerRoot).steps[stepKey]
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
      elapsedMs,
      ...(lastCostUsd !== undefined ? { costUsd: lastCostUsd } : {}),
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
