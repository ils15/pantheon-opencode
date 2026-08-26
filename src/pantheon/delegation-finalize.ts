/**
 * Delegation finalize — PULL output from a child session and persist the
 * delegation report (markdown) + the terminal board transition.
 *
 * Completion is NOT pushed: the event hook observes `session.idle` on the
 * child session, then calls `finalizeDelegation()` which pulls the child's
 * messages via `client.session.messages()`, writes the report atomically
 * (tmp + rename) to `.pantheon/delegations/<rootSessionID>/<alias>.md`, and
 * moves the job to a terminal board state (persist-before-notify: the report
 * file exists before `board.updateStatus` resolves waiters).
 *
 * Pure TypeScript — zero runtime dependencies beyond Node.js builtins and the
 * BackgroundJobBoard. The client is a STRUCTURAL interface (fake-client
 * friendly) so this module is testable standalone, without the opencode SDK.
 *
 * @module delegation-finalize
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { BackgroundJobBoard, BackgroundJobRecord } from './background-job-board.ts'
import type { PermissionTaskConfig } from './permission-globs.ts'
import type { StepCapTracker } from './step-cap.ts'

// ─── Types ─────────────────────────────────────────────────────────────

/** A minimal structural view of one message bundle from session.messages(). */
export interface DelegationMessageBundle {
  info?: { role?: string; finish?: string; error?: unknown }
  parts?: Array<{
    type?: string
    text?: string
    /** Tool name on `tool` parts — used by the activity sampler. */
    tool?: string
    /** Tool input on `tool` parts (opencode SDK ToolPart.metadata). */
    metadata?: { input?: unknown }
  }>
}

/** Minimal structural view of the opencode SDK session client we use. */
export interface DelegationClientSession {
  create(input: {
    body: { parentID: string; title?: string; model?: { id: string; providerID: string } }
  }): Promise<{ id: string }>
  promptAsync(input: {
    path: { id: string }
    body: {
      agent: string
      model?: { id: string; providerID: string }
      parts: Array<{ type: 'text'; text: string }>
    }
    /** Request cancellation for hosts that support AbortSignal. */
    signal?: AbortSignal
  }): Promise<unknown>
  messages?(input: { path: { id: string } }): Promise<Array<DelegationMessageBundle>>
  /** Optional session metadata endpoint (older hosts do not expose it). */
  get?(input: { path: { id: string } }): Promise<unknown>
}

/** The client surface used by the delegation core. */
export interface DelegationClient {
  session: DelegationClientSession
}

/** Tunables for the delegation core (all optional — see DELEGATION_DEFAULTS). */
export interface DelegationOptions {
  /** Job timeout before the delegation is finalized as error/timedOut. */
  timeoutMs?: number
  /** Caller-side cap for pantheon_delegation_read's waitForTerminal. */
  readTimeoutMs?: number
  /** Base directory for delegation reports (default `.pantheon/delegations`). */
  outputDir?: string
  /** Explicit root-session allowlist for the depth guard. */
  rootSessions?: ReadonlySet<string>
  /** Custom depth-guard predicate — overrides rootSessions and the default. */
  isRootSession?: (sessionID: string) => boolean
  /** SDK-backed child predicate; authoritative when supplied by the plugin. */
  isChildSession?: (sessionID: string) => boolean
  /**
   * Enforce the runtime B2 delegation matrix; createDelegationTools defaults
   * this to true. Set false only for an explicitly legacy host that cannot
   * provide ToolContext.agent.
   */
  enforceRuntimeMatrix?: boolean
  /** Record a child returned by the SDK session.create call. */
  registerChildSession?: (sessionID: string, parentID: string) => void
  /**
   * Agents whose delegated child sessions are registered as read-only
   * (Phase 4 enforcement). Mirrors routing.yml
   * background_delegation.read_only_agents. Matching is case-insensitive.
   */
  readOnlyAgents?: ReadonlySet<string>
  /**
   * Per-agent model overrides for delegated child sessions, keyed by agent
   * name (lowercase, e.g. `apollo`). Values are opencode model IDs in
   * `provider/model` form (e.g. `opencode/deepseek-v4-flash-free`), sourced
   * from routing.yml agent entries. Higher priority than the active preset.
   */
  agentModels?: Readonly<Record<string, string>>
  /**
   * Fase B3: Per-exception delegation budgets. Keys use
   * `<parent-agent>-><target-agent>` (for example `athena->apollo`). The
   * count is tracked per parent session for this process. It is intentionally
   * not persisted across restart because this layer has no reliable store.
   * An absent key has no budget limit.
   */
  delegationBudgets?: ReadonlyMap<string, number>
  /**
   * Fase B3: Wall-clock timeout (ms) for individual delegation sessions.
   * The plugin resolves `PANTHEON_DELEGATION_TIMEOUT_MS` into this option;
   * direct callers may provide it here instead.
   */
  wallClockTimeoutMs?: number
  /**
   * Env override for the active-preset resolution (see resolveActivePreset).
   * Defaults to process.env. Primarily for tests.
   */
  presetEnv?: Record<string, string | undefined>
  /** Warning sink for the no-model fallback (defaults to console). */
  logger?: { warn?: (msg: string) => void }
  /**
   * R4: per-agent step-cap tracker (routing.yml `agents.<name>.max_steps`).
   * When an agent reaches max_steps the delegation is forced to
   * summarize-and-stop: skipped with a capped summary when already at the
   * cap, or the prompt is appended with a stop instruction when the cap is
   * hit by this dispatch.
   */
  stepCapTracker?: StepCapTracker
  /**
   * O5: permission.task glob rules controlling which subagents may be
   * invoked. Denied agents are removed from the delegate tool description
   * entirely (not just blocked at call time).
   */
  permissionTask?: PermissionTaskConfig
  /**
   * O5: candidate agent names for the delegate tool description. Defaults
   * to the canonical 14-agent roster.
   */
  agentNames?: readonly string[]
  /** Bounded post-prompt bootstrap watchdog window. */
  bootstrapTimeoutMs?: number
  /** Timeout for the promptAsync request itself (including AbortSignal). */
  promptTimeoutMs?: number
  /** Poll interval used by the bootstrap watchdog. */
  bootstrapPollIntervalMs?: number
  /** Injectable clock/sleeper for deterministic watchdog tests. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/** Dependencies threaded to the finalize path. */
export interface DelegationDeps {
  board: BackgroundJobBoard
  client: DelegationClient
  options: DelegationOptions
}

/** Terminal transition requested by the finalize path. */
export interface FinalizeInput {
  state: 'completed' | 'error' | 'startup_failed' | 'startup_unknown' | 'cancelled'
  error?: string
  timedOut?: boolean
}

/** Defaults matching routing.yml background_delegation (timeout_ms 900000). */
export const DELEGATION_DEFAULTS = {
  timeoutMs: 900_000,
  readTimeoutMs: 900_000,
  outputDir: '.pantheon/delegations',
} as const

// ─── Output pulling ────────────────────────────────────────────────────

interface PulledOutput {
  text: string
  /** True only when the child produced an assistant message or tool activity. */
  hasWork: boolean
}

/** Pull visible text and structurally identify real child work. */
async function pullOutput(client: DelegationClient, childSessionID: string): Promise<PulledOutput> {
  if (typeof client.session.messages !== 'function')
    return { text: '(child session messages API unavailable)', hasWork: false }
  try {
    const bundles = await client.session.messages({ path: { id: childSessionID } })
    const lines: string[] = []
    let hasWork = false
    for (const bundle of bundles) {
      const hasToolPart = (bundle.parts ?? []).some((part) => part.type === 'tool')
      const hasTextPart = (bundle.parts ?? []).some(
        (part) => part.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '',
      )
      if (
        bundle.info?.role === 'assistant' &&
        bundle.info.error === undefined &&
        (hasToolPart || hasTextPart)
      ) {
        hasWork = true
      }
      for (const part of bundle.parts ?? []) {
        if (
          part.type === 'tool' &&
          bundle.info?.role === 'assistant' &&
          bundle.info.error === undefined
        )
          hasWork = true
        if (part.type === 'text' && typeof part.text === 'string' && part.text.trim() !== '') {
          lines.push(part.text)
        }
      }
    }
    return { text: lines.join('\n\n'), hasWork }
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    return { text: `(failed to pull child session output: ${reason})`, hasWork: false }
  }
}

// ─── Markdown rendering ────────────────────────────────────────────────

/** Render the delegation report body. Public for tests/Phase 3 reuse. */
export function renderDelegationMarkdown(
  job: BackgroundJobRecord,
  output: string,
  opts: FinalizeInput & { at?: number },
): string {
  const at = opts.at ?? Date.now()
  const lines = [
    `# Delegation Report — ${job.alias}`,
    '',
    `- **Task ID**: \`${job.taskID}\``,
    `- **Agent**: ${job.agent}`,
    `- **Description**: ${job.description}`,
    `- **State**: ${opts.state}`,
    `- **Timed out**: ${opts.timedOut === true ? 'true' : 'false'}`,
    `- **Started**: ${new Date(job.launchedAt).toISOString()}`,
    `- **Finalized**: ${new Date(at).toISOString()}`,
    '',
    '## Output',
    '',
    output.trim() !== '' ? output : '_No output captured._',
  ]
  if (opts.error !== undefined) {
    lines.push('', `**Error**: ${opts.error}`)
  }
  if (opts.timedOut === true) {
    lines.push('', '[TIMEOUT REACHED]')
  }
  return `${lines.join('\n')}\n`
}

/** One-line result summary from the pulled output (for the board record). */
function summarizeOutput(output: string): string {
  const firstLine = output
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '')
  if (firstLine === undefined) return 'No output captured'
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine
}

// ─── Report persistence ────────────────────────────────────────────────

/**
 * Reject session IDs that could escape the delegation output directory.
 * `parentSessionID` is embedded in the report path
 * `<outputDir>/<parentSessionID>/<alias>.md` — `path.join` does NOT strip
 * `..`, so a traversing ID would write outside the sandbox. Called BEFORE any
 * path construction (F1 — path traversal hardening).
 *
 * @throws {Error} When the ID contains `..`, `/`, or `\`.
 */
export function assertSafeParentSessionID(parentSessionID: string): void {
  if (
    parentSessionID.includes('..') ||
    parentSessionID.includes('/') ||
    parentSessionID.includes('\\')
  ) {
    throw new Error(`Invalid parentSessionID: ${parentSessionID}`)
  }
}

/** Atomic write (tmp + rename) of the report under <outputDir>/<parent>/<alias>.md. */
async function writeDelegationReport(
  outputDir: string,
  job: BackgroundJobRecord,
  md: string,
): Promise<string> {
  assertSafeParentSessionID(job.parentSessionID)
  const dir = join(outputDir, job.parentSessionID)
  const filePath = join(dir, `${job.alias}.md`)
  const tmpPath = join(dir, `${job.alias}.md.tmp`)
  await mkdir(dir, { recursive: true })
  await writeFile(tmpPath, md, 'utf-8')
  await rename(tmpPath, filePath)
  return filePath
}

/** Read a previously written report; undefined when the file does not exist. */
export async function readDelegationReport(
  outputDir: string,
  job: BackgroundJobRecord,
): Promise<string | undefined> {
  assertSafeParentSessionID(job.parentSessionID)
  const filePath = join(outputDir, job.parentSessionID, `${job.alias}.md`)
  try {
    return await readFile(filePath, 'utf-8')
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined
    }
    throw err
  }
}

// ─── Finalize ──────────────────────────────────────────────────────────

/**
 * Finalize a delegation for a child session: pull output, write the report
 * atomically, then move the board job to the requested terminal state.
 *
 * The board transition is guarded: only `running` → terminal, or an
 * idempotent same-terminal re-notify, are applied. A finalize that races a
 * timeout (already `error`) never overwrites the terminal state — the report
 * file is still (re)written, so the marker reflects the latest observation.
 *
 * @returns The updated job record, or undefined when the session is unknown.
 */
export async function finalizeDelegation(
  deps: DelegationDeps,
  childSessionID: string,
  opts: FinalizeInput,
): Promise<BackgroundJobRecord | undefined> {
  const job = deps.board.get(childSessionID)
  if (!job) return undefined

  const pulled = await pullOutput(deps.client, childSessionID)
  const output = pulled.text
  const effectiveOpts: FinalizeInput =
    opts.state === 'completed' && !pulled.hasWork
      ? {
          state: 'error',
          error: opts.error ?? 'Child session produced no assistant or tool output',
          ...(opts.timedOut !== undefined ? { timedOut: opts.timedOut } : {}),
        }
      : opts
  const outputDir = deps.options.outputDir ?? DELEGATION_DEFAULTS.outputDir
  await writeDelegationReport(outputDir, job, renderDelegationMarkdown(job, output, effectiveOpts))

  const status: {
    taskID: string
    state: 'completed' | 'error' | 'startup_failed' | 'startup_unknown' | 'cancelled'
    error?: string
    timedOut?: boolean
    resultSummary?: string
  } = {
    taskID: childSessionID,
    state: effectiveOpts.state,
    resultSummary: summarizeOutput(output),
  }
  if (effectiveOpts.error !== undefined) status.error = effectiveOpts.error
  if (effectiveOpts.timedOut !== undefined) status.timedOut = effectiveOpts.timedOut

  const current = deps.board.get(childSessionID)
  if (current !== undefined) {
    if (current.state === 'running' || current.state === effectiveOpts.state) {
      await deps.board.updateStatus(status)
    }
    // Terminal in a DIFFERENT state (e.g. timeout already recorded) — the
    // report above still captures this finalize; the board state stands.
  }
  return deps.board.get(childSessionID) ?? job
}
