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

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { appendBoardMessage } from './board-messages.ts'
import { getSharedBus } from './bus.ts'
import { PANTHEON_AGENTS } from './delegation-policy.ts'
import { type KnownAgent, RETIRED_AGENT_ALIASES } from './model-agents.ts'
import { runAtomicStepSubSession, type SubSessionDomainLike } from './step-runner.ts'
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
  readonly claimSeq?: number
  readonly finalSeq?: number
  readonly error?: string
}

const SAFE_EPHEMERAL_ROLE_RE = /^[a-z0-9][a-z0-9-]{0,31}$/

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

  const worktreeDriver = createPantheonWorktreeDefinition()
  let worktreeDir: string | undefined
  let worktreeCreated = false
  let worktreeCleaned = false
  let claimSeq: number | undefined
  let finalSeq: number | undefined
  let runOk = false
  let sessionID: string | undefined
  let runError: string | undefined

  try {
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
      stepKey: input.stepKey,
      objective: input.objective,
      agent: baseAgent,
      cleanupSession: true,
      extraContext: contextLines.join('\n'),
      ...(input.parentSessionID !== undefined ? { parentSessionID: input.parentSessionID } : {}),
      ...(input.maxTurns !== undefined ? { maxTurns: input.maxTurns } : {}),
    })

    sessionID = runRes.sessionID
    runOk = runRes.ok
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
    if (worktreeCreated && worktreeDir && input.keepWorktree !== true) {
      try {
        const ac = new AbortController()
        await worktreeDriver.remove({ directory: worktreeDir, force: true }, { signal: ac.signal })
        worktreeCleaned = true
      } catch {
        worktreeCleaned = false
      }
    }

    const finalStatus: 'completed' | 'failed' | 'cleaned' = worktreeCleaned
      ? 'cleaned'
      : runOk
        ? 'completed'
        : 'failed'
    try {
      const finalMsg = await appendBoardMessage(sharedRoot, {
        channel: 'swarm',
        threadId,
        ...(input.goal !== undefined ? { goal: input.goal } : {}),
        ...(input.workstream !== undefined ? { workstream: input.workstream } : {}),
        stepKey: input.stepKey,
        from: role,
        to: ['zeus'],
        ...(claimSeq !== undefined ? { replyToSeq: claimSeq } : {}),
        tag: runOk ? 'done' : 'blocker',
        body: runOk
          ? `[done] @zeus Ephemeral worker (${role}) finished step ${input.stepKey}${worktreeCleaned ? ' and cleaned worktree' : ''}`
          : `[blocker] @zeus Ephemeral worker (${role}) failed step ${input.stepKey}: ${runError ?? 'step not marked done'}`,
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
    ...(claimSeq !== undefined ? { claimSeq } : {}),
    ...(finalSeq !== undefined ? { finalSeq } : {}),
    ...(runError !== undefined ? { error: runError } : {}),
  }
}
