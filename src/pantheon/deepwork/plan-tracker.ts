/**
 * plan-tracker.ts — Storage and lifecycle tracking for Pantheon Deepwork.
 *
 * Persists canonical state in `.pantheon/deepwork/<slug>/plan.json`
 * with append-only event logging in `.pantheon/deepwork/<slug>/journal.ndjson`.
 * Synchronizes the Markdown projection in `.pantheon/deepwork/<slug>/PLAN.md`.
 */

import { existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { generateMarkdownDocument } from './plan-projection.ts'
import {
  type DeepworkPlan,
  DeepworkPlanSchema,
  type PlanAcceptanceCriterion,
  type PlanAcceptanceKind,
  type PlanDecision,
  type PlanMetadata,
  type PlanRisk,
  type PlanTask,
  type TaskState,
} from './plan-schema.ts'

export interface JournalEvent {
  type:
    | 'plan_created'
    | 'task_started'
    | 'task_finished'
    | 'task_failed'
    | 'task_state_changed'
    | 'decision_resolved'
    | 'acceptance_verified'
    | 'phase_completed'
  timestamp: string
  payload: Record<string, unknown>
}

export function deepworkRootDir(cwd = process.cwd()): string {
  return join(cwd, '.pantheon', 'deepwork')
}

export function deepworkPlanDir(cwd = process.cwd(), slug: string): string {
  return join(deepworkRootDir(cwd), slug)
}

export function deepworkPlanJsonPath(cwd = process.cwd(), slug: string): string {
  return join(deepworkPlanDir(cwd, slug), 'plan.json')
}

export function deepworkPlanMdPath(cwd = process.cwd(), slug: string): string {
  return join(deepworkPlanDir(cwd, slug), 'PLAN.md')
}

export function deepworkJournalPath(cwd = process.cwd(), slug: string): string {
  return join(deepworkPlanDir(cwd, slug), 'journal.ndjson')
}

/**
 * Recompute readiness of tasks according to dependency graph:
 * - A task with depends_on whose dependencies are ALL 'done' becomes 'ready' if it was 'pending' or 'blocked'.
 * - A task whose dependencies are NOT all 'done' becomes 'blocked' if it was 'pending' or 'ready'.
 */
export function computeTaskReadiness(plan: DeepworkPlan): DeepworkPlan {
  const doneIds = new Set(plan.tasks.filter((t) => t.state === 'done').map((t) => t.id))

  const updatedTasks: PlanTask[] = plan.tasks.map((task) => {
    if (task.state === 'done' || task.state === 'in_progress' || task.state === 'failed') {
      return task
    }

    if (task.depends_on.length === 0) {
      return task.state === 'blocked' ? { ...task, state: 'ready' } : task
    }

    const allDepsDone = task.depends_on.every((dep) => doneIds.has(dep))
    if (allDepsDone && (task.state === 'pending' || task.state === 'blocked')) {
      return { ...task, state: 'ready' }
    }
    if (!allDepsDone && (task.state === 'pending' || task.state === 'ready')) {
      return { ...task, state: 'blocked' }
    }
    return task
  })

  return { ...plan, tasks: updatedTasks }
}

export function inferAcceptanceKind(check: string): PlanAcceptanceKind {
  const lower = check.toLowerCase()
  if (lower.includes('test') || lower.includes('pytest') || lower.includes('assert')) return 'test'
  if (
    lower.includes('file') ||
    lower.includes('exist') ||
    lower.includes('criado') ||
    lower.includes('path')
  )
    return 'file'
  if (
    lower.startsWith('npm ') ||
    lower.startsWith('bash ') ||
    lower.startsWith('alembic ') ||
    lower.startsWith('git ') ||
    lower.includes(' && ') ||
    lower.includes(' || ')
  )
    return 'command'
  return 'manual'
}

/**
 * Normalizes unstructured or loosely structured plan input into a canonical DeepworkPlan.
 * Resilient to agent variations: owner vs agent, @-prefixes, array of strings for acceptance,
 * choices in decisions, and string phases.
 */
export function normalizePlanData(data: unknown, fallbackSlug = 'plan'): DeepworkPlan {
  const obj = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  const slug = String(obj.plan_id ?? obj.slug ?? fallbackSlug).trim() || fallbackSlug
  const title = String(obj.title ?? slug).trim() || slug
  const intent = String(obj.intent ?? '').trim() || 'Plano de deepwork estruturado.'
  const done_when = Array.isArray(obj.done_when)
    ? obj.done_when.map((s) => String(s).trim()).filter(Boolean)
    : []

  const rawDecisions = Array.isArray(obj.decisions_needed)
    ? obj.decisions_needed
    : Array.isArray(obj.decisions)
      ? obj.decisions
      : []

  const decisions_needed: PlanDecision[] = rawDecisions.map((d: unknown, idx: number) => {
    const dec = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>
    const id = String(dec.id ?? `D${String(idx + 1).padStart(2, '0')}`).trim()
    const question = String(dec.question ?? dec.title ?? 'Decisão necessária').trim()
    const rawOptions = Array.isArray(dec.options)
      ? dec.options
      : typeof dec.options === 'string'
        ? [dec.options]
        : []
    const options = rawOptions.map((opt) => String(opt).trim()).filter(Boolean)
    const chosenVal = dec.chosen ?? dec.choice
    const chosen = typeof chosenVal === 'string' ? chosenVal : undefined
    const statusVal = String(dec.status ?? '')
      .trim()
      .toLowerCase()
    const status: 'pending' | 'resolved' =
      statusVal === 'resolved' || chosen !== undefined ? 'resolved' : 'pending'
    return {
      id,
      question,
      options,
      chosen,
      choice: chosen,
      status,
      resolved_at: typeof dec.resolved_at === 'string' ? dec.resolved_at : undefined,
    }
  })

  const rawRisks = Array.isArray(obj.risks) ? obj.risks : []
  const risks: PlanRisk[] = rawRisks.map((r: unknown, idx: number) => {
    const risk = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
    return {
      id: String(risk.id ?? `R${String(idx + 1).padStart(2, '0')}`).trim(),
      description: String(risk.description ?? risk.risk ?? '').trim() || 'Risco não especificado',
      mitigation: typeof risk.mitigation === 'string' ? risk.mitigation : undefined,
    }
  })

  const out_of_scope = Array.isArray(obj.out_of_scope)
    ? obj.out_of_scope.map((s) => String(s).trim()).filter(Boolean)
    : []

  const rawTasks = Array.isArray(obj.tasks) ? obj.tasks : []
  const tasks: PlanTask[] = rawTasks.map((t: unknown, idx: number) => {
    const task = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>
    const id = String(task.id ?? `T${String(idx + 1).padStart(2, '0')}`).trim()
    const taskTitle = String(task.title ?? task.name ?? `Task ${idx + 1}`).trim()
    const description = typeof task.description === 'string' ? task.description : undefined
    const rawAgent = task.agent ?? task.owner ?? task.assignee
    const agent =
      typeof rawAgent === 'string' && rawAgent.trim().length > 0
        ? rawAgent.replace(/^@/, '').trim()
        : 'zeus'

    const rawPhase = task.phase
    let phase = 1
    if (typeof rawPhase === 'number' && Number.isFinite(rawPhase)) {
      phase = rawPhase
    } else if (typeof rawPhase === 'string') {
      const match = rawPhase.match(/\d+/)
      if (match) phase = Number.parseInt(match[0], 10)
    }

    const rawState = String(task.state ?? task.status ?? 'pending')
      .trim()
      .toLowerCase()
    const validStates: TaskState[] = [
      'pending',
      'ready',
      'in_progress',
      'done',
      'failed',
      'blocked',
    ]
    const state: TaskState = validStates.includes(rawState as TaskState)
      ? (rawState as TaskState)
      : 'pending'

    const depends_on = Array.isArray(task.depends_on)
      ? task.depends_on.map((dep) => String(dep).trim()).filter(Boolean)
      : []
    const parallel_safe = Boolean(task.parallel_safe ?? task.parallel)

    const rawAcceptance = Array.isArray(task.acceptance)
      ? task.acceptance
      : Array.isArray(task.acceptance_criteria)
        ? task.acceptance_criteria
        : Array.isArray(task.criteria)
          ? task.criteria
          : []

    const acceptance: PlanAcceptanceCriterion[] = rawAcceptance.map((a: unknown) => {
      if (typeof a === 'string') {
        const checkText = a.trim()
        return {
          kind: inferAcceptanceKind(checkText),
          check: checkText,
          fails_now: true,
          verified: false,
        }
      }
      const acc = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>
      const checkText = String(
        acc.check ?? acc.description ?? acc.title ?? acc.name ?? 'verify',
      ).trim()
      const rawKind = String(acc.kind ?? '')
        .trim()
        .toLowerCase()
      const validKinds = ['test', 'command', 'file', 'manual'] as const
      const kind = (
        validKinds.includes(rawKind as (typeof validKinds)[number])
          ? rawKind
          : inferAcceptanceKind(checkText)
      ) as PlanAcceptanceKind
      return {
        kind,
        check: checkText || 'verify',
        fails_now: typeof acc.fails_now === 'boolean' ? acc.fails_now : true,
        verified: Boolean(acc.verified),
        proof: typeof acc.proof === 'string' ? acc.proof : undefined,
      }
    })

    const rawResult =
      task.result && typeof task.result === 'object'
        ? (task.result as Record<string, unknown>)
        : undefined
    const result = rawResult
      ? {
          summary: typeof rawResult.summary === 'string' ? rawResult.summary : undefined,
          verified_at:
            typeof rawResult.verified_at === 'string' ? rawResult.verified_at : undefined,
          artifacts: Array.isArray(rawResult.artifacts)
            ? rawResult.artifacts.map((art) => String(art))
            : undefined,
        }
      : undefined

    return {
      id,
      title: taskTitle,
      description,
      agent,
      phase,
      state,
      depends_on,
      parallel_safe,
      acceptance,
      result,
    }
  })

  const rawMeta =
    obj.metadata && typeof obj.metadata === 'object'
      ? (obj.metadata as Record<string, unknown>)
      : {}
  const now = new Date().toISOString()
  const metadata: PlanMetadata = {
    created_at: typeof rawMeta.created_at === 'string' ? rawMeta.created_at : now,
    updated_at: typeof rawMeta.updated_at === 'string' ? rawMeta.updated_at : now,
    version: typeof rawMeta.version === 'number' ? rawMeta.version : 1,
  }

  return computeTaskReadiness({
    plan_id: slug,
    title,
    intent,
    done_when,
    decisions_needed,
    risks,
    out_of_scope,
    tasks,
    metadata,
  })
}

/**
 * Read the canonical JSON plan. Returns null if absent.
 * Automatically normalizes minor schema variations (single options, string criteria, owner aliases).
 */
export async function readPlan(cwd = process.cwd(), slug: string): Promise<DeepworkPlan | null> {
  const path = deepworkPlanJsonPath(cwd, slug)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw err
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err: unknown) {
    throw new Error(`Plano '${slug}' em ${path} contém JSON inválido: ${(err as Error).message}`)
  }

  const result = DeepworkPlanSchema.safeParse(parsed)
  if (result.success) {
    return result.data
  }

  try {
    const normalized = normalizePlanData(parsed, slug)
    const repairedResult = DeepworkPlanSchema.safeParse(normalized)
    if (repairedResult.success) {
      return repairedResult.data
    }
  } catch {
    // fall through to schema issue reporting
  }

  const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
  throw new Error(`Plano '${slug}' em ${path} falhou na validação de schema: ${issues}`)
}

const planLocks = new Map<string, Promise<unknown>>()

/**
 * Execute an async operation with serialized exclusivity per plan slug.
 * Prevents concurrent read-modify-write race conditions and clashing tempfiles.
 */
export async function withPlanLock<T>(cwd: string, slug: string, fn: () => Promise<T>): Promise<T> {
  const key = `${cwd}::${slug}`
  const prev = planLocks.get(key) ?? Promise.resolve()
  let resolveCurrent: (() => void) | undefined
  const current = new Promise<void>((resolve) => {
    resolveCurrent = resolve
  })
  planLocks.set(key, current)
  try {
    await prev
    return await fn()
  } finally {
    resolveCurrent?.()
    if (planLocks.get(key) === current) {
      planLocks.delete(key)
    }
  }
}

/**
 * Write the canonical JSON plan atomically and update PLAN.md projection.
 */
export async function writePlan(cwd = process.cwd(), plan: DeepworkPlan): Promise<void> {
  const dir = deepworkPlanDir(cwd, plan.plan_id)
  await mkdir(dir, { recursive: true })

  const normalized = computeTaskReadiness({
    ...plan,
    metadata: {
      ...plan.metadata,
      updated_at: new Date().toISOString(),
      version: (plan.metadata.version || 1) + 1,
    },
  })

  const randomSuffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`

  // Atomic write for plan.json
  const jsonPath = deepworkPlanJsonPath(cwd, plan.plan_id)
  const jsonTmp = `${jsonPath}.tmp.${randomSuffix}`
  await writeFile(jsonTmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  await rename(jsonTmp, jsonPath)

  // Projection write for PLAN.md
  const mdPath = deepworkPlanMdPath(cwd, plan.plan_id)
  const mdTmp = `${mdPath}.tmp.${randomSuffix}`
  const mdContent = generateMarkdownDocument(normalized)
  await writeFile(mdTmp, mdContent, 'utf8')
  await rename(mdTmp, mdPath)
}

/**
 * Append an entry to the journal event log.
 */
export async function appendJournal(
  cwd = process.cwd(),
  slug: string,
  event: JournalEvent,
): Promise<void> {
  const dir = deepworkPlanDir(cwd, slug)
  await mkdir(dir, { recursive: true })
  const journalPath = deepworkJournalPath(cwd, slug)
  const line = `${JSON.stringify(event)}\n`
  await appendFile(journalPath, line, 'utf8')
}

/**
 * Read all events from the journal log.
 */
export async function readJournal(cwd = process.cwd(), slug: string): Promise<JournalEvent[]> {
  const journalPath = deepworkJournalPath(cwd, slug)
  try {
    const raw = await readFile(journalPath, 'utf8')
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as JournalEvent)
  } catch {
    return []
  }
}

/**
 * Update the state of a specific task and persist both plan and journal.
 */
export async function updateTaskState(
  cwd = process.cwd(),
  slug: string,
  taskId: string,
  state: TaskState,
  result?: { summary?: string; verified_at?: string; artifacts?: string[] },
): Promise<DeepworkPlan> {
  return withPlanLock(cwd, slug, async () => {
    const plan = await readPlan(cwd, slug)
    if (!plan) {
      throw new Error(`Deepwork plan "${slug}" not found`)
    }

    const taskIndex = plan.tasks.findIndex((t) => t.id === taskId)
    const existingTask = plan.tasks[taskIndex]
    if (taskIndex === -1 || !existingTask) {
      throw new Error(`Task "${taskId}" not found in plan "${slug}"`)
    }

    const updatedResult = result
      ? { ...(existingTask.result ?? {}), ...result }
      : existingTask.result

    const updatedTask: PlanTask = {
      ...existingTask,
      state,
      ...(updatedResult !== undefined ? { result: updatedResult } : {}),
    }

    const updatedTasks = [...plan.tasks]
    updatedTasks[taskIndex] = updatedTask

    const nextPlan: DeepworkPlan = { ...plan, tasks: updatedTasks }
    await writePlan(cwd, nextPlan)

    await appendJournal(cwd, slug, {
      type: 'task_state_changed',
      timestamp: new Date().toISOString(),
      payload: { taskId, state, result },
    })

    return (await readPlan(cwd, slug)) ?? nextPlan
  })
}

/**
 * Record verification of an acceptance criterion.
 */
export async function verifyTaskAcceptance(
  cwd = process.cwd(),
  slug: string,
  taskId: string,
  checkIndex: number,
  verified: boolean,
  proof?: string,
): Promise<DeepworkPlan> {
  return withPlanLock(cwd, slug, async () => {
    const plan = await readPlan(cwd, slug)
    if (!plan) {
      throw new Error(`Deepwork plan "${slug}" not found`)
    }

    const taskIndex = plan.tasks.findIndex((t) => t.id === taskId)
    const task = plan.tasks[taskIndex]
    if (taskIndex === -1 || !task) {
      throw new Error(`Task "${taskId}" not found in plan "${slug}"`)
    }

    const currentAcc = task.acceptance[checkIndex]
    if (!currentAcc) {
      throw new Error(`Acceptance criterion index ${checkIndex} not found in task "${taskId}"`)
    }

    const updatedAcceptance = [...task.acceptance]
    const resolvedProof = proof ?? currentAcc.proof
    updatedAcceptance[checkIndex] = {
      ...currentAcc,
      verified,
      ...(resolvedProof !== undefined ? { proof: resolvedProof } : {}),
    }

    const allVerified = updatedAcceptance.every((acc) => acc.verified)

    const updatedTasks = [...plan.tasks]
    updatedTasks[taskIndex] = {
      ...task,
      acceptance: updatedAcceptance,
      state: allVerified ? 'done' : task.state,
    }

    const nextPlan: DeepworkPlan = { ...plan, tasks: updatedTasks }
    await writePlan(cwd, nextPlan)

    await appendJournal(cwd, slug, {
      type: 'acceptance_verified',
      timestamp: new Date().toISOString(),
      payload: { taskId, checkIndex, verified, proof, allVerified },
    })

    return (await readPlan(cwd, slug)) ?? nextPlan
  })
}

/**
 * Resolve a decision in the plan.
 */
export async function resolvePlanDecision(
  cwd = process.cwd(),
  slug: string,
  decisionId: string,
  chosen: string,
): Promise<DeepworkPlan> {
  return withPlanLock(cwd, slug, async () => {
    const plan = await readPlan(cwd, slug)
    if (!plan) {
      throw new Error(`Deepwork plan "${slug}" not found`)
    }

    const decIndex = plan.decisions_needed.findIndex((d) => d.id === decisionId)
    const existingDec = plan.decisions_needed[decIndex]
    if (decIndex === -1 || !existingDec) {
      throw new Error(`Decision "${decisionId}" not found in plan "${slug}"`)
    }

    const updatedDecisions = [...plan.decisions_needed]
    updatedDecisions[decIndex] = {
      ...existingDec,
      chosen,
      choice: chosen,
      status: 'resolved',
      resolved_at: new Date().toISOString(),
    }

    const nextPlan: DeepworkPlan = { ...plan, decisions_needed: updatedDecisions }
    await writePlan(cwd, nextPlan)

    await appendJournal(cwd, slug, {
      type: 'decision_resolved',
      timestamp: new Date().toISOString(),
      payload: { decisionId, chosen },
    })

    return (await readPlan(cwd, slug)) ?? nextPlan
  })
}

/**
 * List all available deepwork plans in the workspace.
 */
export async function listPlans(cwd = process.cwd()): Promise<
  Array<{
    slug: string
    title: string
    tasks_count: number
    done_count: number
    updated_at: string
  }>
> {
  const root = deepworkRootDir(cwd)
  if (!existsSync(root)) return []

  const entries = await readdir(root, { withFileTypes: true })
  const result: Array<{
    slug: string
    title: string
    tasks_count: number
    done_count: number
    updated_at: string
  }> = []

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const plan = await readPlan(cwd, entry.name)
      if (plan) {
        result.push({
          slug: plan.plan_id,
          title: plan.title,
          tasks_count: plan.tasks.length,
          done_count: plan.tasks.filter((t) => t.state === 'done').length,
          updated_at: plan.metadata.updated_at,
        })
      }
    }
  }

  return result
}
