/**
 * File-based goal persistence for the full-auto Goal Loop (Wave 3, PR #46).
 *
 * One JSON file per session (`.pantheon/goals/<sessionID>.json`), written
 * atomically (tmp + rename) so a crash never leaves a partial goal. The
 * plugin layer cannot reach MCP KV servers, so goals live on disk.
 * Session IDs are sanitized before path construction (path-traversal guard,
 * same pattern as assertSafeParentSessionID).
 *
 * Pure TypeScript — zero runtime deps beyond node:fs.
 *
 * @module goal-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { assertSafeParentSessionID } from './tool-context.ts'

export type GoalStatus = 'pending' | 'in_progress' | 'done'

/** One goal persisted at `.pantheon/goals/<sessionID>.json`. */
export interface Goal {
  id: string
  sessionID: string
  objective: string
  status: GoalStatus
  createdAt: number
  updatedAt: number
  continuationCount: number
}

const DEFAULT_GOAL_DIR = '.pantheon/goals'

/**
 * File-based goal persistence. `save` writes atomically (tmp + rename);
 * `load` returns undefined when no goal exists yet.
 */
export class GoalStore {
  private readonly dir: string

  constructor(opts: { dir?: string } = {}) {
    this.dir = opts.dir ?? DEFAULT_GOAL_DIR
  }

  /**
   * Path-traversal guard for session IDs embedded in file paths (same
   * pattern as assertSafeParentSessionID). Throws on `..`, `/`, `\`.
   */
  sanitizeSessionID(sessionID: string): string {
    assertSafeParentSessionID(sessionID)
    return sessionID
  }

  private pathFor(sessionID: string): string {
    return join(this.dir, `${this.sanitizeSessionID(sessionID)}.json`)
  }

  /** Load the session's goal; undefined when none exists yet. */
  async load(sessionID: string): Promise<Goal | undefined> {
    const path = this.pathFor(sessionID)
    try {
      const content = await readFile(path, 'utf-8')
      return JSON.parse(content) as Goal
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        'code' in err &&
        (err as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        return undefined
      }
      throw err
    }
  }

  /** Persist a goal atomically (tmp + rename). */
  async save(goal: Goal): Promise<void> {
    const path = this.pathFor(goal.sessionID)
    const tmpPath = `${path}.tmp`
    await mkdir(this.dir, { recursive: true })
    await writeFile(tmpPath, JSON.stringify(goal, null, 2), 'utf-8')
    await rename(tmpPath, path)
  }

  /** True when the session has a goal that is not `done`. */
  async hasActive(sessionID: string): Promise<boolean> {
    const goal = await this.load(sessionID)
    return goal !== undefined && goal.status !== 'done'
  }

  /** List the session's goals — at most one (YAGNI: single active goal). */
  async list(sessionID: string): Promise<Goal[]> {
    const goal = await this.load(sessionID)
    return goal === undefined ? [] : [goal]
  }
}
