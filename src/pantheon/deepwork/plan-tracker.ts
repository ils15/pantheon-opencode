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

/**
 * Read the canonical JSON plan. Returns null if absent or corrupt.
 */
export async function readPlan(cwd = process.cwd(), slug: string): Promise<DeepworkPlan | null> {
  const path = deepworkPlanJsonPath(cwd, slug)
  try {
    const raw = await readFile(path, 'utf8')
    const parsed = JSON.parse(raw)
    return DeepworkPlanSchema.parse(parsed)
  } catch {
    return null
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

  // Atomic write for plan.json
  const jsonPath = deepworkPlanJsonPath(cwd, plan.plan_id)
  const jsonTmp = `${jsonPath}.tmp`
  await writeFile(jsonTmp, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  await rename(jsonTmp, jsonPath)

  // Projection write for PLAN.md
  const mdPath = deepworkPlanMdPath(cwd, plan.plan_id)
  const mdContent = generateMarkdownDocument(normalized)
  await writeFile(mdPath, mdContent, 'utf8')
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
  const plan = await readPlan(cwd, slug)
  if (!plan) {
    throw new Error(`Deepwork plan "${slug}" not found`)
  }

  const taskIndex = plan.tasks.findIndex((t) => t.id === taskId)
  const existingTask = plan.tasks[taskIndex]
  if (taskIndex === -1 || !existingTask) {
    throw new Error(`Task "${taskId}" not found in plan "${slug}"`)
  }

  const updatedResult = result ? { ...(existingTask.result ?? {}), ...result } : existingTask.result

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
    status: 'resolved',
  }

  const nextPlan: DeepworkPlan = { ...plan, decisions_needed: updatedDecisions }
  await writePlan(cwd, nextPlan)

  await appendJournal(cwd, slug, {
    type: 'decision_resolved',
    timestamp: new Date().toISOString(),
    payload: { decisionId, chosen },
  })

  return (await readPlan(cwd, slug)) ?? nextPlan
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
