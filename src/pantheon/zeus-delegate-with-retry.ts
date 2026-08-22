/**
 * Zeus Delegate With Retry (Wave 4, empty-mode fix) — helper for Zeus waves.
 *
 * Opencode 1.18.x cannot intercept `task()` completion via hooks, so the
 * `dispatch-guard` lib is NOT wired in the plugin. Zeus waves MUST use this
 * helper manually: it encapsulates
 *
 *   delegate → waitForTerminal → classify via createDispatchGuard
 *            → maybeRetry 1x on empty-mode1/mode2 → escalate
 *
 * Retry cap is HARD at 1 (never 2x). The guard is stateful per helper
 * instance — one retry budget total. Fail-open on missing APIs is NOT
 * applicable here: a failed delegate throws/log+escalate so the wave can
 * decide (a) retry with different agent, (b) simplify, (c) manual.
 *
 * Two usage shapes:
 *   1. High-level: `zeusDelegateWithRetry({ board, client, sessionID, agent, prompt })`
 *      — creates child session, registers board, promptAsync, waitForTerminal,
 *        reads report, classifies, retries once if empty, escalates if still empty.
 *   2. Low-level: `createZeusRetryHelper()` — wraps a generic
 *      `() => Promise<DispatchResultLike>` pair via `executeWithRetry`.
 *
 * The high-level helper is the one Zeus waves should import:
 *
 * ```ts
 * import { zeusDelegateWithRetry } from './pantheon/zeus-delegate-with-retry.ts'
 * const { report, alias, taskID, retried, classification } =
 *   await zeusDelegateWithRetry({ board, client, sessionID, agent: 'apollo', prompt })
 * ```
 *
 * If the result is empty after one retry, the helper THROWS with an
 * `EscalationError` — the wave must catch and escalate to the user (see
 * `src/agents/zeus.md` "Waves with Retry").
 *
 * Pure TypeScript — no direct SDK import. Board/client are structural.
 *
 * @module zeus-delegate-with-retry
 */

import type { BackgroundJobBoard } from './background-job-board.ts'
import type { DelegationClient } from './delegation-finalize.ts'
import { DELEGATION_DEFAULTS, readDelegationReport } from './delegation-finalize.ts'
import {
  createDispatchGuard,
  type DispatchClassification,
  type DispatchGuard,
  type DispatchGuardOptions,
  type DispatchResultLike,
} from './dispatch-guard.ts'
import { createPantheonLogger } from './logger.ts'
import {
  type ProviderCooldownTracker,
  type RetryPolicy,
  RetryPolicyEngine,
} from './retry-policy.ts'
import { safeSessionPath } from './session-guard.ts'

const log = createPantheonLogger({ module: 'pantheon-zeus-retry' })

// ─── Types ───────────────────────────────────────────────────────────────

export interface ZeusDelegateWithRetryOptions {
  /** Board singleton (same instance the plugin uses). */
  board: BackgroundJobBoard
  /** Delegation client (adapted SDK client, e.g. adaptDelegationClient). */
  client: DelegationClient
  /** Parent session that delegates (must be a valid ses_ id). */
  sessionID: string
  /** Target agent (e.g. "apollo", "hermes"). */
  agent: string
  /** Task prompt delivered to the background agent. */
  prompt: string
  /** Human-readable description shown on the job board. */
  description?: string
  /** Explicit model for the child session (provider/model). */
  model?: { id: string; providerID: string }
  /** Timeout for board.waitForTerminal (ms). Default: DELEGATION_DEFAULTS.readTimeoutMs */
  readTimeoutMs?: number
  /** Retry on empty results. Default: true */
  retryOnEmpty?: boolean
  /** R1: per-error-type retry policy (routing.yml `retry_policy`). */
  retryPolicy?: RetryPolicy
  /** R1: provider cooldown tracker (routing.yml `cooldown`). */
  cooldown?: ProviderCooldownTracker
  /** R1: provider name for cooldown tracking (default "default"). */
  provider?: string
  /** Injectable logger. Default: file log (PANTHEON_HOOKS_LOG gate). */
  logger?: { warn: (message: string) => void; info?: (message: string) => void }
  /** Output dir for delegation reports. Default: DELEGATION_DEFAULTS.outputDir */
  outputDir?: string
}

export interface ZeusDelegateResult {
  /** Job alias (e.g. "apo-1"). */
  alias: string
  /** Child session id (= board task id). */
  taskID: string
  /** Report markdown (with Agent Activity section when sampled). */
  report: string
  /** Classification of the final result. */
  classification: DispatchClassification
  /** True when a retry was fired (cap 1). */
  retried: boolean
}

/**
 * Thrown when a delegate returns empty even after one retry — the wave must
 * escalate (try different agent, simplify scope, or manual intervention).
 */
export class ZeusEscalationError extends Error {
  constructor(
    public readonly agent: string,
    public readonly prompt: string,
    public readonly classification: DispatchClassification,
  ) {
    super(
      `Zeus delegate escalate: agent "${agent}" returned ${classification} even after retry (prompt: "${prompt.slice(0, 80)}") — escalate to user: (a) try different agent, (b) simplify scope, (c) manual`,
    )
    this.name = 'ZeusEscalationError'
  }
}

// ─── Low-level helper — wraps any async delegate+read pair ───────────────

/**
 * Low-level retry helper. Zeus waves that already have a `delegate+read`
 * pair can use this directly without the board/client machinery:
 *
 * ```ts
 * const guard = createZeusRetryHelper({ logger })
 * const out = await guard.executeWithRetry(
 *   () => firstRead(),
 *   () => secondRead(),
 * )
 * if (out.escalate) throw new ZeusEscalationError(...)
 * ```
 */
export interface ZeusRetryHelper {
  guard: DispatchGuard
  /**
   * Classify `first` and, if empty and budget allows, run `redispatch` once.
   * Returns the final result plus escalation flag (true when still empty after
   * the one allowed retry).
   */
  executeWithRetry(
    first: DispatchResultLike,
    redispatch: () => Promise<DispatchResultLike>,
  ): Promise<{
    result: DispatchResultLike
    classification: DispatchClassification
    retried: boolean
    escalate: boolean
  }>
}

export interface ZeusRetryHelperOptions extends DispatchGuardOptions {
  /**
   * R1: per-error-type retry policy. When provided, error-type retries with
   * exponential backoff apply (auth → 0, rate_limit → N, ...); when absent
   * the legacy hard-cap-1 empty-result retry applies.
   */
  retryPolicy?: RetryPolicy
  /** R1: provider cooldown tracker (shared across helpers for global cooldown). */
  cooldown?: ProviderCooldownTracker
  /** R1: provider name for cooldown tracking (default "default"). */
  provider?: string
  /** R1: injectable sleep for tests (default: setTimeout promise). */
  sleep?: (ms: number) => Promise<void>
}

export function createZeusRetryHelper(options?: ZeusRetryHelperOptions): ZeusRetryHelper {
  const guard = createDispatchGuard(options)
  const engine =
    options?.retryPolicy !== undefined
      ? new RetryPolicyEngine(options.retryPolicy, options.cooldown)
      : undefined
  const provider = options?.provider ?? 'default'
  const sleep =
    options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  return {
    guard,
    async executeWithRetry(first, redispatch) {
      if (engine === undefined) {
        // Legacy path (unchanged): hard cap 1 on empty results.
        const out = await guard.maybeRetry(first, redispatch)
        const escalate = out.classification !== 'content'
        return {
          result: out.result,
          classification: out.classification,
          retried: out.retried,
          escalate,
        }
      }
      // R1 path: classify the failure, apply the per-error-type policy with
      // exponential backoff, and track provider cooldown. A content result
      // records success (resets the provider's failure counter); an
      // exhausted budget records failure (feeds the cooldown tracker).
      let result = first
      let attemptsUsed = 0
      let retried = false
      let classification = guard.classifyResult(result)
      let lastError: unknown =
        result.error ??
        (classification === 'content' ? undefined : new Error('empty dispatch result'))
      for (;;) {
        if (classification === 'content') {
          engine.recordSuccess(provider)
          return { result, classification, retried, escalate: false }
        }
        lastError = result.error ?? lastError
        const decision = engine.decide(provider, lastError, attemptsUsed)
        if (!decision.shouldRetry) {
          engine.recordFailure(provider, lastError)
          return { result, classification, retried, escalate: true }
        }
        retried = true
        attemptsUsed += 1
        await sleep(decision.delayMs)
        try {
          result = await redispatch()
          lastError = undefined
        } catch (err: unknown) {
          lastError = err
        }
        classification = guard.classifyResult(result)
      }
    },
  }
}

// ─── High-level helper — full delegate → wait → read → retry → escalate ───

/**
 * High-level helper Zeus waves MUST use (see `src/agents/zeus.md`).
 * Delegates a background agent as a child session, waits for terminal,
 * classifies via `createDispatchGuard`, retries ONCE on empty-mode1/mode2,
 * and escalates (throws `ZeusEscalationError`) if still empty.
 *
 * Not wired automatically in the plugin — opencode 1.18.x cannot intercept
 * task completion via hooks, so wiring is manual-orchestration only.
 */
export async function zeusDelegateWithRetry(
  opts: ZeusDelegateWithRetryOptions,
): Promise<ZeusDelegateResult> {
  const logger = opts.logger ?? log
  const warn = logger.warn.bind(logger)
  const board = opts.board
  const client = opts.client
  const sessionID = opts.sessionID

  const sessionPath = safeSessionPath(sessionID)
  if (!sessionPath) {
    warn(`zeusDelegateWithRetry: invalid sessionID "${sessionID}" — aborting`)
    throw new Error(`invalid sessionID: ${sessionID}`)
  }

  const readTimeoutMs = opts.readTimeoutMs ?? DELEGATION_DEFAULTS.readTimeoutMs
  const outputDir = opts.outputDir ?? DELEGATION_DEFAULTS.outputDir
  const retryHelper = createZeusRetryHelper({
    retryOnEmpty: opts.retryOnEmpty ?? true,
    logger,
    ...(opts.retryPolicy !== undefined ? { retryPolicy: opts.retryPolicy } : {}),
    ...(opts.cooldown !== undefined ? { cooldown: opts.cooldown } : {}),
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
  })

  // One delegate+read attempt. Factored so maybeRetry can invoke a second
  // attempt with a fresh child session + board job.
  async function runOnce(): Promise<{
    alias: string
    taskID: string
    report: string
    dispatchResult: DispatchResultLike
  }> {
    // 1. Create child session (parentID = caller). No model forwarding here —
    // delegation.ts resolves models via routing.yml; this helper uses the
    // bare SDK default unless opts.model is supplied (explicit caller intent).
    let childID: string
    try {
      const created = await client.session.create({
        body: {
          parentID: sessionID,
          title: opts.description ?? opts.prompt.slice(0, 80),
          ...(opts.model !== undefined ? { model: opts.model } : {}),
        },
      })
      childID = created.id
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      warn(`zeusDelegateWithRetry: session.create failed: ${reason}`)
      throw new Error(`delegate session.create failed: ${reason}`)
    }

    const childPath = safeSessionPath(childID)
    if (!childPath) {
      warn(`zeusDelegateWithRetry: child sessionID invalid "${childID}"`)
      throw new Error(`invalid child sessionID: ${childID}`)
    }

    // 2. Register on board (taskID == child session id)
    const job = await board.registerLaunch({
      taskID: childID,
      parentSessionID: sessionID,
      agent: opts.agent,
      description: opts.description ?? opts.prompt,
      objective: opts.prompt,
    })

    // 3. Fire-and-forget promptAsync on the child. Completion is observed via
    // board.waitForTerminal, not via noReply — the spike refuted noReply.
    // A promptAsync failure is logged but does not abort the wait — the board
    // timeout will finalize the job.
    void client.session
      .promptAsync({
        path: childPath.path,
        body: { agent: opts.agent, parts: [{ type: 'text', text: opts.prompt }] },
      })
      .catch((err: unknown) => {
        const reason = err instanceof Error ? err.message : String(err)
        warn(`zeusDelegateWithRetry: promptAsync failed for ${childID}: ${reason}`)
      })

    // 4. Wait for terminal state
    let terminal: Awaited<ReturnType<BackgroundJobBoard['waitForTerminal']>>
    try {
      terminal = await board.waitForTerminal(childID, readTimeoutMs)
    } catch {
      // Timed out waiting — treat as empty so the guard retries once
      return {
        alias: job.alias,
        taskID: childID,
        report: '',
        dispatchResult: { content: '' },
      }
    }

    // 5. Read report markdown
    const report = (await readDelegationReport(outputDir, terminal)) ?? ''

    // DispatchResultLike for classification: content = report markdown.
    // Tokens are unavailable from the board/report path → mode1 when empty.
    const dispatchResult: DispatchResultLike = { content: report }

    return { alias: job.alias, taskID: childID, report, dispatchResult }
  }

  // First attempt
  const first = await runOnce()

  // Classify + maybe retry once — capture second run's metadata via closure
  let secondRun: typeof first | undefined
  const out = await retryHelper.executeWithRetry(first.dispatchResult, async () => {
    const second = await runOnce()
    secondRun = second
    return second.dispatchResult
  })

  // When retried, return second run's report or escalate
  if (out.retried && secondRun !== undefined) {
    if (out.classification === 'content') {
      return {
        alias: secondRun.alias,
        taskID: secondRun.taskID,
        report: secondRun.report,
        classification: out.classification,
        retried: true,
      }
    }
    // Still empty after retry → escalate
    throw new ZeusEscalationError(opts.agent, opts.prompt, out.classification)
  }

  // No retry, or first was content
  if (out.classification !== 'content') {
    // Empty and retry budget exhausted (or retryOnEmpty:false) → escalate
    // But if we already retried and failed we threw above; this path is for
    // the case where maybeRetry did NOT retry (budget exhausted or disabled)
    // and the first result was empty. Per spec, one retry is allowed — if
    // maybeRetry didn't retry, we should NOT auto-escalate here unless the
    // guard's budget was used. Instead, treat as final empty that still
    // requires escalation when retried==false but classification empty and
    // retryOnEmpty was true but guard had no budget left? The guard already
    // enforces cap 1, so after one retry escalate is required. For the
    // first-attempt-empty with no retry (retryOnEmpty false), we still escalate
    // so the wave knows to handle it.
    if (out.retried) {
      throw new ZeusEscalationError(opts.agent, opts.prompt, out.classification)
    }
    // No retry happened — still empty. Escalate so the wave doesn't silently
    // use an empty report.
    throw new ZeusEscalationError(opts.agent, opts.prompt, out.classification)
  }

  return {
    alias: first.alias,
    taskID: first.taskID,
    report: first.report,
    classification: out.classification,
    retried: out.retried,
  }
}
