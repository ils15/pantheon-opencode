/**
 * Ephemeral Operation Workers (`ephemeral-worker.ts`).
 *
 * Allows `@zeus` to spawn short-lived slice workers with:
 * - dynamic role slug or v2.3 archetype/retired-agent alias,
 * - canonical base agent (`hermes` default, `apollo` when `readOnly: true`,
 *   or resolved from `EPHEMERAL_ARCHETYPES` / `RETIRED_AGENT_ALIASES`),
 * - optional disposable sibling git worktree under `<project-parent>/.pantheon-worktrees/`,
 * - `#seq` claim + final `[done]`/`[blocker]` slots on `pantheon_board`,
 * - automatic sub-session and worktree cleanup in `finally`.
 *
 * @module pantheon/ephemeral-worker
 */

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { appendBoardMessage } from './board-messages.ts'
import { getSharedBus } from './bus.ts'
import { PANTHEON_AGENTS } from './delegation-policy.ts'
import { type KnownAgent, RETIRED_AGENT_ALIASES } from './model-agents.ts'
import {
  DEFAULT_WALL_CLOCK_MS,
  runAtomicStepSubSession,
  type StepHaltReason,
  type SubSessionDomainLike,
} from './step-runner.ts'
import { resolveSharedPantheonRoot } from './tool-context.ts'
import {
  createPantheonWorktreeDefinition,
  resolvePantheonWorktreePath,
} from './worktree-orchestrator.ts'

export interface EphemeralArchetypeSpec {
  readonly role: string
  readonly baseAgent: KnownAgent
  readonly readOnly: boolean
  readonly description: string
}

/** Canonical v2.3 ephemeral worker archetypes replacing the 6 retired fixed agents. */
export const EPHEMERAL_ARCHETYPES: Readonly<Record<string, EphemeralArchetypeSpec>> = Object.freeze(
  {
    hotfix: {
      role: 'hotfix',
      baseAgent: 'hermes',
      readOnly: false,
      description: 'Bounded hotfixes, typos, and surgical style fixes.',
    },
    'infra-ci': {
      role: 'infra-ci',
      baseAgent: 'hermes',
      readOnly: false,
      description: 'Docker, CI pipelines, deployment, and infra configuration.',
    },
    'ai-pipeline': {
      role: 'ai-pipeline',
      baseAgent: 'hermes',
      readOnly: false,
      description: 'AI pipelines, RAG, embeddings, and vector store integration.',
    },
    observability: {
      role: 'observability',
      baseAgent: 'hermes',
      readOnly: false,
      description: 'Tracing, telemetry, metrics, and cost/latency instrumentation.',
    },
    geospatial: {
      role: 'geospatial',
      baseAgent: 'apollo',
      readOnly: true,
      description: 'Read-only geospatial, satellite, and remote-sensing analysis.',
    },
    'memory-adr': {
      role: 'memory-adr',
      baseAgent: 'iris',
      readOnly: false,
      description: 'Memory-bank curation and Architecture Decision Record authoring.',
    },
    'memory-consolidate': {
      role: 'memory-consolidate',
      baseAgent: 'iris',
      readOnly: false,
      description: 'Memory-bank consolidation, deduplication, and archival.',
    },
  },
)

/** Resolve either a v2.3 archetype slug or a retired v2.2 agent name to its archetype spec. */
export function resolveEphemeralArchetype(roleOrAlias: string): EphemeralArchetypeSpec | undefined {
  const key = roleOrAlias.trim().replace(/^@/, '').toLowerCase()
  if (!key) return undefined
  if (Object.hasOwn(EPHEMERAL_ARCHETYPES, key)) {
    return EPHEMERAL_ARCHETYPES[key]
  }
  const alias = Object.hasOwn(RETIRED_AGENT_ALIASES, key) ? RETIRED_AGENT_ALIASES[key] : undefined
  if (alias) {
    return (
      EPHEMERAL_ARCHETYPES[alias.role] ?? {
        role: alias.role,
        baseAgent: alias.baseAgent,
        readOnly: alias.readOnly,
        description: `Ephemeral ${alias.role} worker`,
      }
    )
  }
  return undefined
}

export interface FileLeaseHook {
  readonly acquireFileLease?: (input: {
    readonly sharedRoot: string
    readonly stepKey: string
    readonly holder: string
    readonly ownedFiles: readonly string[]
    readonly forbiddenFiles?: readonly string[]
  }) =>
    | Promise<{
        readonly ok: boolean
        readonly error?: string
        readonly conflicts?: readonly string[]
      }>
    | { readonly ok: boolean; readonly error?: string; readonly conflicts?: readonly string[] }
  readonly releaseFileLease?: (input: {
    readonly sharedRoot: string
    readonly stepKey: string
    readonly holder: string
  }) => Promise<void> | void
}

function resolveFileLeaseHook(input: SpawnEphemeralWorkerInput): FileLeaseHook | undefined {
  const globalHook = (globalThis as { __pantheonFileLeases?: FileLeaseHook }).__pantheonFileLeases
  const acquireFileLease = input.acquireFileLease ?? globalHook?.acquireFileLease
  const releaseFileLease = input.releaseFileLease ?? globalHook?.releaseFileLease
  if (!acquireFileLease && !releaseFileLease) return undefined
  return {
    ...(acquireFileLease ? { acquireFileLease } : {}),
    ...(releaseFileLease ? { releaseFileLease } : {}),
  }
}

export interface SpawnEphemeralWorkerInput {
  readonly sessionDomain: SubSessionDomainLike
  readonly cwd: string
  readonly stepKey: string
  readonly role: string
  readonly objective: string
  readonly baseAgent?: string
  readonly readOnly?: boolean
  readonly isolateWorktree?: boolean
  readonly keepWorktree?: boolean
  readonly parentSessionID?: string
  readonly extraContext?: string
  readonly threadId?: string
  readonly goal?: string
  readonly workstream?: string
  readonly maxTurns?: number
  readonly wallClockMs?: number
  readonly maxCostUsd?: number
  readonly ownedFiles?: readonly string[]
  readonly forbiddenFiles?: readonly string[]
  readonly autoVerify?: boolean
  readonly verifierAgent?: string
  readonly getSessionCostUsd?: (
    sessionID: string,
  ) => Promise<number | undefined> | number | undefined
  readonly acquireFileLease?: FileLeaseHook['acquireFileLease']
  readonly releaseFileLease?: FileLeaseHook['releaseFileLease']
  readonly to?: readonly string[]
}

export interface SpawnEphemeralWorkerResult {
  readonly ok: boolean
  readonly workerId: string
  readonly role: string
  readonly baseAgent: string
  readonly stepKey: string
  readonly sessionID?: string
  readonly worktreeDir?: string
  readonly worktreeCleaned: boolean
  readonly branch?: string
  readonly diffSummary?: string
  readonly claimSeq?: number
  readonly finalSeq?: number
  readonly haltedReason?: StepHaltReason
  readonly elapsedMs?: number
  readonly costUsd?: number
  readonly verification?: VerifyEphemeralBranchesResult
  readonly error?: string
}

export interface EphemeralBranchReviewTarget {
  readonly branch: string
  readonly stepKey?: string
  readonly workerRole?: string
}

export interface VerifyEphemeralBranchesInput {
  readonly branches: ReadonlyArray<string | EphemeralBranchReviewTarget>
  readonly sharedRoot: string
  readonly verifierAgent?: string
  readonly sessionDomain?: SubSessionDomainLike
  readonly parentSessionID?: string
  readonly threadId?: string
  readonly baseRef?: string
}

export interface VerifyEphemeralBranchItemResult {
  readonly branch: string
  readonly stepKey: string
  readonly workerRole: string
  readonly verdict: 'APPROVE' | 'BLOCK'
  readonly diffSummary?: string
  readonly boardSeq?: number
  readonly error?: string
}

export interface VerifyEphemeralBranchesResult {
  readonly ok: boolean
  readonly verifierAgent: string
  readonly verifiersSpawned: number
  readonly results: readonly VerifyEphemeralBranchItemResult[]
}

export const DEFAULT_EPHEMERAL_MAX_TURNS = 8
export const DEFAULT_VERIFIER_AGENT = 'themis'
const execFileAsync = promisify(execFile)

async function runGit(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
}

function sanitizeEphemeralBranchStep(stepKey: string): string {
  const cleaned = stepKey
    .replace(/[^a-zA-Z0-9._/-]/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '')
  return cleaned || `step-${Date.now()}`
}

async function preserveWorktreeChanges(
  worktreeDir: string,
  stepKey: string,
  role: string,
  baseHead: string | undefined,
): Promise<{ preserved: boolean; branch?: string; diffSummary?: string; error?: string }> {
  try {
    const status = (await runGit(worktreeDir, ['status', '--porcelain'])).trim()
    if (status.length > 0) {
      await runGit(worktreeDir, ['add', '-A'])
      const commitMsg = `chore(pantheon): ephemeral worker ${role} step ${stepKey}`
      try {
        await runGit(worktreeDir, ['commit', '-m', commitMsg, '--no-verify'])
      } catch {
        await runGit(worktreeDir, [
          '-c',
          'user.name=Pantheon',
          '-c',
          'user.email=pantheon@local',
          'commit',
          '-m',
          commitMsg,
          '--no-verify',
        ])
      }
    }

    const currentHead = (await runGit(worktreeDir, ['rev-parse', 'HEAD'])).trim()
    if (baseHead && currentHead !== baseHead) {
      const branch = `pantheon/eph/${sanitizeEphemeralBranchStep(stepKey)}`
      await runGit(worktreeDir, ['branch', '-f', branch, 'HEAD'])
      const diffRaw = (
        await runGit(worktreeDir, ['diff', '--stat', `${baseHead}..${currentHead}`])
      ).trim()
      const diffSummary = diffRaw
        ? diffRaw
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .join(' | ')
        : undefined
      return {
        preserved: true,
        branch,
        ...(diffSummary !== undefined ? { diffSummary } : {}),
      }
    }
    return { preserved: false }
  } catch (err: unknown) {
    return {
      preserved: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

const SAFE_EPHEMERAL_ROLE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const EPHEMERAL_ROLE_MAX_LENGTH = 32
const FALLBACK_EPHEMERAL_ROLE = 'worker'

/**
 * Derive a validator-safe role slug (see `SAFE_EPHEMERAL_ROLE_RE`) from an
 * arbitrary label such as a step key. Lowercases, maps every character outside
 * `[a-z0-9-]` to `-`, collapses repeated separators, trims edge separators,
 * truncates to 32 chars, and guarantees a non-empty alnum-leading result.
 */
export function deriveEphemeralRoleSlug(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, EPHEMERAL_ROLE_MAX_LENGTH)
    .replace(/-+$/, '')
  return SAFE_EPHEMERAL_ROLE_RE.test(slug) ? slug : FALLBACK_EPHEMERAL_ROLE
}

export async function spawnEphemeralWorker(
  input: SpawnEphemeralWorkerInput,
): Promise<SpawnEphemeralWorkerResult> {
  const rawRole = typeof input.role === 'string' ? input.role.trim().toLowerCase() : ''
  if (!SAFE_EPHEMERAL_ROLE_RE.test(rawRole)) {
    return {
      ok: false,
      workerId: `eph-${input.stepKey}`,
      role: rawRole,
      baseAgent: input.readOnly === true ? 'apollo' : 'hermes',
      stepKey: input.stepKey,
      worktreeCleaned: false,
      error: 'role must match ^[a-z0-9][a-z0-9-]{0,31}$',
    }
  }

  const archetype = resolveEphemeralArchetype(rawRole)
  const role = archetype?.role ?? rawRole
  const effectiveReadOnly = input.readOnly ?? archetype?.readOnly ?? false
  const defaultBase =
    input.readOnly !== undefined
      ? input.readOnly
        ? 'apollo'
        : 'hermes'
      : (archetype?.baseAgent ?? (effectiveReadOnly ? 'apollo' : 'hermes'))
  const baseAgent =
    typeof input.baseAgent === 'string' && input.baseAgent.trim()
      ? input.baseAgent.trim().replace(/^@/, '').toLowerCase()
      : defaultBase
  if (!PANTHEON_AGENTS.has(baseAgent)) {
    return {
      ok: false,
      workerId: `eph-${input.stepKey}`,
      role,
      baseAgent,
      stepKey: input.stepKey,
      worktreeCleaned: false,
      error: `baseAgent "${baseAgent}" is not a canonical Pantheon agent`,
    }
  }

  const sharedRoot = resolveSharedPantheonRoot(input.cwd)
  const workerId = `eph-${role}-${Date.now()}`
  const threadId = input.threadId?.trim() || input.stepKey
  const bus = getSharedBus()
  const rawRecipients = Array.isArray(input.to)
    ? input.to.map((entry) => entry.trim().replace(/^@/, '').toLowerCase()).filter(Boolean)
    : []
  const recipients = rawRecipients.length > 0 ? Array.from(new Set(rawRecipients)) : ['zeus']

  const worktreeDriver = createPantheonWorktreeDefinition()
  const leaseHook = resolveFileLeaseHook(input)
  let leaseAcquired = false
  let worktreeDir: string | undefined
  let worktreeCreated = false
  let worktreeCleaned = false
  let baseHead: string | undefined
  let preservedBranch: string | undefined
  let diffSummary: string | undefined
  let preserveError: string | undefined
  let claimSeq: number | undefined
  let finalSeq: number | undefined
  let runOk = false
  let sessionID: string | undefined
  let haltedReason: StepHaltReason | undefined
  let elapsedMs: number | undefined
  let costUsd: number | undefined
  let verification: VerifyEphemeralBranchesResult | undefined
  let runError: string | undefined

  try {
    if (input.ownedFiles && input.ownedFiles.length > 0 && leaseHook?.acquireFileLease) {
      const leaseRes = await leaseHook.acquireFileLease({
        sharedRoot,
        stepKey: input.stepKey,
        holder: role,
        ownedFiles: input.ownedFiles,
        ...(input.forbiddenFiles !== undefined ? { forbiddenFiles: input.forbiddenFiles } : {}),
      })
      if (!leaseRes.ok) {
        return {
          ok: false,
          workerId,
          role,
          baseAgent,
          stepKey: input.stepKey,
          worktreeCleaned: false,
          error:
            leaseRes.error ??
            `file lease conflict${leaseRes.conflicts?.length ? `: ${leaseRes.conflicts.join(', ')}` : ''}`,
        }
      }
      leaseAcquired = true
    }

    if (input.isolateWorktree !== false && existsSync(join(sharedRoot, '.git'))) {
      const candidateDir = resolvePantheonWorktreePath(
        sharedRoot,
        `eph-${input.stepKey}-${Date.now()}`,
      )
      const ac = new AbortController()
      const created = await worktreeDriver.create(
        { sourceDirectory: sharedRoot, directory: candidateDir },
        { signal: ac.signal },
      )
      worktreeDir = created.directory
      worktreeCreated = true
      try {
        baseHead = (await runGit(worktreeDir, ['rev-parse', 'HEAD'])).trim()
      } catch {
        baseHead = undefined
      }
    }

    const claimMsg = await appendBoardMessage(sharedRoot, {
      channel: 'swarm',
      threadId,
      ...(input.goal !== undefined ? { goal: input.goal } : {}),
      ...(input.workstream !== undefined ? { workstream: input.workstream } : {}),
      stepKey: input.stepKey,
      from: role,
      to: ['zeus'],
      tag: 'claim',
      body: `[claim] Ephemeral worker (${role} on @${baseAgent}) starting step ${input.stepKey}: ${input.objective}`,
      ephemeral: {
        role,
        baseAgent,
        ...(worktreeDir !== undefined ? { worktreeDir } : {}),
        status: 'running',
      },
    })
    claimSeq = claimMsg.seq

    bus.emit('ephemeral:worker', {
      workerId,
      role,
      baseAgent,
      stepKey: input.stepKey,
      action: 'spawned',
      ...(worktreeDir !== undefined ? { worktreeDir } : {}),
      seq: claimSeq,
      timestamp: Date.now(),
    })

    const effectiveCwd = worktreeDir ?? input.cwd
    const contextLines = [
      `[EPHEMERAL OPERATION WORKER]`,
      `role: ${role}`,
      `baseAgent: ${baseAgent}`,
      `readOnly: ${effectiveReadOnly}`,
      `worktree: ${effectiveCwd}`,
      `boardSeq: #${claimSeq}`,
      ...(archetype ? [`archetype: ${archetype.description}`] : []),
      ...(input.extraContext?.trim() ? ['', input.extraContext.trim()] : []),
    ]

    const runRes = await runAtomicStepSubSession({
      sessionDomain: input.sessionDomain,
      cwd: effectiveCwd,
      ledgerRoot: sharedRoot,
      stepKey: input.stepKey,
      objective: input.objective,
      agent: baseAgent,
      cleanupSession: true,
      extraContext: contextLines.join('\n'),
      ...(input.parentSessionID !== undefined ? { parentSessionID: input.parentSessionID } : {}),
      maxTurns: input.maxTurns ?? DEFAULT_EPHEMERAL_MAX_TURNS,
      wallClockMs: input.wallClockMs ?? DEFAULT_WALL_CLOCK_MS,
      ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}),
      ...(input.ownedFiles !== undefined ? { ownedFiles: input.ownedFiles } : {}),
      ...(input.forbiddenFiles !== undefined ? { forbiddenFiles: input.forbiddenFiles } : {}),
      ...(input.getSessionCostUsd !== undefined
        ? { getSessionCostUsd: input.getSessionCostUsd }
        : {}),
    })

    sessionID = runRes.sessionID
    runOk = runRes.ok
    haltedReason = runRes.haltedReason
    elapsedMs = runRes.elapsedMs
    costUsd = runRes.costUsd
    if (!runRes.ok && runRes.error) {
      runError = runRes.error
    }

    bus.emit('ephemeral:worker', {
      workerId,
      role,
      baseAgent,
      stepKey: input.stepKey,
      action: runOk ? 'completed' : 'failed',
      ...(sessionID !== undefined ? { sessionID } : {}),
      ...(worktreeDir !== undefined ? { worktreeDir } : {}),
      seq: claimSeq,
      timestamp: Date.now(),
    })
  } catch (err: unknown) {
    runOk = false
    runError = err instanceof Error ? err.message : String(err)
    bus.emit('ephemeral:worker', {
      workerId,
      role,
      baseAgent,
      stepKey: input.stepKey,
      action: 'failed',
      ...(worktreeDir !== undefined ? { worktreeDir } : {}),
      ...(claimSeq !== undefined ? { seq: claimSeq } : {}),
      timestamp: Date.now(),
    })
  } finally {
    if (worktreeCreated && worktreeDir) {
      const preserved = await preserveWorktreeChanges(worktreeDir, input.stepKey, role, baseHead)
      preservedBranch = preserved.branch
      diffSummary = preserved.diffSummary
      preserveError = preserved.error
      if (input.keepWorktree !== true && !preserveError) {
        try {
          const ac = new AbortController()
          await worktreeDriver.remove(
            { directory: worktreeDir, force: true },
            { signal: ac.signal },
          )
          worktreeCleaned = true
        } catch {
          worktreeCleaned = false
        }
      }
    }

    const finalStatus: 'completed' | 'failed' | 'cleaned' = worktreeCleaned
      ? 'cleaned'
      : runOk
        ? 'completed'
        : 'failed'
    const mentionText = recipients.map((r) => `@${r}`).join(' ')
    const branchNote = preservedBranch
      ? ` (branch: ${preservedBranch}${diffSummary ? `; diff: ${diffSummary}` : ''})`
      : preserveError
        ? ` (worktree kept due to preserve error: ${preserveError})`
        : ''
    try {
      const finalMsg = await appendBoardMessage(sharedRoot, {
        channel: 'swarm',
        threadId,
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
        ...(input.workstream !== undefined ? { workstream: input.workstream } : {}),
        stepKey: input.stepKey,
        from: role,
        to: recipients,
        ...(claimSeq !== undefined ? { replyToSeq: claimSeq } : {}),
        tag: runOk ? 'done' : 'blocker',
        body: runOk
          ? `[done] ${mentionText} Ephemeral worker (${role}) finished step ${input.stepKey}${worktreeCleaned ? ' and cleaned worktree' : ''}${branchNote}`
          : `[blocker] ${mentionText} Ephemeral worker (${role}) failed step ${input.stepKey}: ${runError ?? 'step not marked done'}${branchNote}`,
        ephemeral: {
          role,
          baseAgent,
          ...(sessionID !== undefined ? { sessionID } : {}),
          ...(worktreeDir !== undefined ? { worktreeDir } : {}),
          status: finalStatus,
        },
      })
      finalSeq = finalMsg.seq
    } catch {
      /* best-effort board finalization */
    }

    if (leaseAcquired && leaseHook?.releaseFileLease) {
      try {
        await leaseHook.releaseFileLease({
          sharedRoot,
          stepKey: input.stepKey,
          holder: role,
        })
      } catch {
        /* best-effort lease release */
      }
    }

    if (worktreeCleaned) {
      bus.emit('ephemeral:worker', {
        workerId,
        role,
        baseAgent,
        stepKey: input.stepKey,
        action: 'cleaned',
        ...(sessionID !== undefined ? { sessionID } : {}),
        ...(worktreeDir !== undefined ? { worktreeDir } : {}),
        ...(finalSeq !== undefined ? { seq: finalSeq } : {}),
        timestamp: Date.now(),
      })
    }

    if (input.autoVerify === true && runOk && preservedBranch) {
      verification = await verifyEphemeralBranches({
        sessionDomain: input.sessionDomain,
        branches: [{ branch: preservedBranch, stepKey: input.stepKey, workerRole: role }],
        sharedRoot,
        verifierAgent: input.verifierAgent ?? DEFAULT_VERIFIER_AGENT,
        ...(input.parentSessionID !== undefined ? { parentSessionID: input.parentSessionID } : {}),
        threadId,
      })
    }
  }

  return {
    ok: runOk,
    workerId,
    role,
    baseAgent,
    stepKey: input.stepKey,
    ...(sessionID !== undefined ? { sessionID } : {}),
    ...(worktreeDir !== undefined ? { worktreeDir } : {}),
    worktreeCleaned,
    ...(preservedBranch !== undefined ? { branch: preservedBranch } : {}),
    ...(diffSummary !== undefined ? { diffSummary } : {}),
    ...(claimSeq !== undefined ? { claimSeq } : {}),
    ...(finalSeq !== undefined ? { finalSeq } : {}),
    ...(haltedReason !== undefined ? { haltedReason } : {}),
    ...(elapsedMs !== undefined ? { elapsedMs } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(verification !== undefined ? { verification } : {}),
    ...(runError !== undefined ? { error: runError } : {}),
  }
}

function normalizeBranchTarget(entry: string | EphemeralBranchReviewTarget): {
  readonly branch: string
  readonly stepKey: string
  readonly workerRole: string
} {
  const branch = (typeof entry === 'string' ? entry : entry.branch).trim()
  const rawStep =
    typeof entry !== 'string' && entry.stepKey?.trim()
      ? entry.stepKey.trim()
      : branch.startsWith('pantheon/eph/')
        ? branch.slice('pantheon/eph/'.length)
        : branch
  const stepKey = rawStep || 'unknown-step'
  const workerRole =
    typeof entry !== 'string' && entry.workerRole?.trim()
      ? entry.workerRole.trim().replace(/^@/, '').toLowerCase()
      : deriveEphemeralRoleSlug(stepKey)
  return { branch, stepKey, workerRole }
}

/**
 * Partition worker branches across verifiers at a 1:2–4 ratio
 * (1 verifier per 2–4 branches; a single branch still gets 1 verifier).
 */
export function partitionBranchesForVerifiers<T>(items: readonly T[]): T[][] {
  const n = items.length
  if (n === 0) return []
  if (n === 1) return [[...items]]
  const numVerifiers = Math.ceil(n / 4)
  const baseSize = Math.floor(n / numVerifiers)
  const remainder = n % numVerifiers
  const batches: T[][] = []
  let offset = 0
  for (let i = 0; i < numVerifiers; i += 1) {
    const size = baseSize + (i < remainder ? 1 : 0)
    batches.push(items.slice(offset, offset + size))
    offset += size
  }
  return batches
}

function parseVerifierVerdictFromMessages(
  rawMessages: unknown,
  stepKey: string,
  branch: string,
): 'APPROVE' | 'BLOCK' {
  if (!Array.isArray(rawMessages)) return 'APPROVE'
  let globalBlock = false
  for (let i = rawMessages.length - 1; i >= 0; i -= 1) {
    const item = rawMessages[i]
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    const texts: string[] = []
    if (typeof rec.text === 'string') texts.push(rec.text)
    if (Array.isArray(rec.parts)) {
      for (const part of rec.parts) {
        if (
          part &&
          typeof part === 'object' &&
          typeof (part as { text?: unknown }).text === 'string'
        ) {
          texts.push((part as { text: string }).text)
        }
      }
    }
    const combined = texts.join('\n')
    if (!combined) continue
    // Check per-branch line/verdict if present
    for (const line of combined.split('\n')) {
      if (
        (line.includes(stepKey) || line.includes(branch)) &&
        /\b(BLOCK|BLOCK_INTENT)\b|\[blocker\]/i.test(line)
      ) {
        return 'BLOCK'
      }
      if (
        (line.includes(stepKey) || line.includes(branch)) &&
        /\b(APPROVE|PASS|PASS_WITH_NOTES)\b|\[done\]/i.test(line)
      ) {
        return 'APPROVE'
      }
    }
    if (/\b(BLOCK|BLOCK_INTENT)\b|\[blocker\]/.test(combined)) {
      globalBlock = true
    }
  }
  return globalBlock ? 'BLOCK' : 'APPROVE'
}

/**
 * Allocate 1 verifier (`themis` by default) per 2–4 `pantheon/eph/<stepKey>`
 * worker branches, collect `git diff` patches, optionally run verifier
 * sub-sessions, and post `[done]` / `[blocker]` back to `@<workerRole>`.
 */
export async function verifyEphemeralBranches(
  input: VerifyEphemeralBranchesInput,
): Promise<VerifyEphemeralBranchesResult> {
  const sharedRoot = resolveSharedPantheonRoot(input.sharedRoot)
  const verifierAgent =
    typeof input.verifierAgent === 'string' && input.verifierAgent.trim()
      ? input.verifierAgent.trim().replace(/^@/, '').toLowerCase()
      : DEFAULT_VERIFIER_AGENT
  const baseRef = input.baseRef?.trim() || 'HEAD'

  const targets = input.branches.map(normalizeBranchTarget).filter((t) => t.branch.length > 0)

  if (targets.length === 0) {
    return { ok: true, verifierAgent, verifiersSpawned: 0, results: [] }
  }

  const batches = partitionBranchesForVerifiers(targets)
  const results: VerifyEphemeralBranchItemResult[] = []

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx += 1) {
    const batch = batches[batchIdx]
    if (!batch) continue
    const diffs: Array<{
      target: (typeof targets)[number]
      diffSummary?: string
      patch: string
      gitError?: string
    }> = []

    for (const target of batch) {
      try {
        const stat = (
          await runGit(sharedRoot, ['diff', '--stat', `${baseRef}..${target.branch}`])
        ).trim()
        const patch = (await runGit(sharedRoot, ['diff', `${baseRef}..${target.branch}`])).slice(
          0,
          12_000,
        )
        diffs.push({
          target,
          ...(stat
            ? {
                diffSummary: stat
                  .split('\n')
                  .map((l) => l.trim())
                  .join(' | '),
              }
            : {}),
          patch,
        })
      } catch (err: unknown) {
        diffs.push({
          target,
          patch: '',
          gitError: err instanceof Error ? err.message : String(err),
        })
      }
    }

    let rawMessages: unknown
    let batchError: string | undefined

    if (
      typeof input.sessionDomain?.create === 'function' &&
      typeof input.sessionDomain?.prompt === 'function'
    ) {
      let verifierSessionId: string | undefined
      try {
        const created = await input.sessionDomain.create({
          title: `Verify ephemeral batch ${batchIdx + 1}/${batches.length} (${batch.length} branches)`,
          agent: verifierAgent,
          ...(input.parentSessionID ? { parentID: input.parentSessionID } : {}),
        })
        verifierSessionId = typeof created?.id === 'string' ? created.id : undefined
        if (verifierSessionId) {
          const promptSections = [
            `[EPHEMERAL BRANCH DIFF REVIEW — BATCH ${batchIdx + 1}/${batches.length}]`,
            `verifierAgent: ${verifierAgent}`,
            `branches: ${batch.map((b) => `${b.branch} (@${b.workerRole})`).join(', ')}`,
            '',
            'Review each branch diff below. For each branch, emit a verdict line:',
            '<branch>: APPROVE | BLOCK <reason>',
            '',
            ...diffs.map(
              (d) =>
                `--- ${d.target.branch} (step: ${d.target.stepKey}, worker: @${d.target.workerRole}) ---\n` +
                (d.gitError
                  ? `GIT_DIFF_ERROR: ${d.gitError}`
                  : `${d.diffSummary ?? 'no stat'}\n${d.patch || '(empty diff)'}`),
            ),
          ]
          await input.sessionDomain.prompt({
            sessionID: verifierSessionId,
            text: promptSections.join('\n'),
            agents: [{ name: verifierAgent }],
            resume: true,
          })
          if (typeof input.sessionDomain.wait === 'function') {
            await input.sessionDomain.wait({ sessionID: verifierSessionId })
          }
          if (typeof input.sessionDomain.messages === 'function') {
            rawMessages = await input.sessionDomain.messages({ sessionID: verifierSessionId })
          }
        } else {
          batchError = 'verifier session.create returned no session id'
        }
      } catch (err: unknown) {
        batchError = err instanceof Error ? err.message : String(err)
      } finally {
        if (verifierSessionId && typeof input.sessionDomain.remove === 'function') {
          try {
            await input.sessionDomain.remove({ sessionID: verifierSessionId })
          } catch {
            /* best-effort cleanup */
          }
        }
      }
    }

    for (const item of diffs) {
      const { target, diffSummary: itemDiffSummary, gitError } = item
      const itemError = gitError ?? batchError
      const verdict: 'APPROVE' | 'BLOCK' = itemError
        ? 'BLOCK'
        : parseVerifierVerdictFromMessages(rawMessages, target.stepKey, target.branch)

      let boardSeq: number | undefined
      try {
        const msg = await appendBoardMessage(sharedRoot, {
          channel: 'swarm',
          threadId: input.threadId?.trim() || target.stepKey,
          stepKey: target.stepKey,
          from: verifierAgent,
          to: [target.workerRole],
          tag: verdict === 'APPROVE' ? 'done' : 'blocker',
          body:
            verdict === 'APPROVE'
              ? `[done] @${target.workerRole} Verified ${target.branch} (${verifierAgent}): APPROVE${itemDiffSummary ? ` (${itemDiffSummary})` : ''}`
              : `[blocker] @${target.workerRole} Verification failed for ${target.branch} (${verifierAgent}): ${itemError ?? 'BLOCK'}`,
        })
        boardSeq = msg.seq
      } catch {
        /* best-effort board post */
      }

      results.push({
        branch: target.branch,
        stepKey: target.stepKey,
        workerRole: target.workerRole,
        verdict,
        ...(itemDiffSummary !== undefined ? { diffSummary: itemDiffSummary } : {}),
        ...(boardSeq !== undefined ? { boardSeq } : {}),
        ...(itemError !== undefined ? { error: itemError } : {}),
      })
    }
  }

  return {
    ok: results.every((r) => r.verdict === 'APPROVE'),
    verifierAgent,
    verifiersSpawned: batches.length,
    results,
  }
}
