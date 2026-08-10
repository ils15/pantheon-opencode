/**
 * File-based persistence adapter for the BackgroundJobBoard.
 *
 * Stores all jobs in a single `state.json` file using atomic writes
 * (write to `state.json.tmp` then rename) to prevent partial writes
 * from crashes.
 *
 * @module file-persistence
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { BackgroundJobRecord, PersistenceAdapter } from './background-job-board.ts'

/** Default path for the state file. */
const DEFAULT_STATE_PATH = '.pantheon/board/state.json'

/**
 * File-based persistence adapter.
 *
 * All jobs are stored in a single JSON array in `statePath`.
 * Writes are atomic: content is written to a `.tmp` file, then renamed.
 *
 * The board's in-memory `this.jobs` Map is the source of truth —
 * this file is a crash-recovery snapshot. `deleteJob()` removes the
 * record from the snapshot so pruned/reconciled jobs don't resurface
 * after a restart.
 */
export class FilePersistenceAdapter implements PersistenceAdapter {
  private readonly statePath: string
  private readonly dir: string

  /**
   * @param statePath  Path to the state JSON file (default: `.pantheon/board/state.json`)
   */
  constructor(statePath?: string) {
    this.statePath = statePath ?? DEFAULT_STATE_PATH
    this.dir = dirname(this.statePath)
  }

  /** Ensure the parent directory exists. */
  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
  }

  /** Path to the atomic-write temp file. */
  private get tmpPath(): string {
    return this.statePath + '.tmp'
  }

  /**
   * Read all jobs from the state file.
   * Returns `null` if the file doesn't exist (first run / no jobs yet).
   */
  private async readState(): Promise<BackgroundJobRecord[] | null> {
    try {
      const content = await readFile(this.statePath, 'utf-8')
      return JSON.parse(content) as BackgroundJobRecord[]
    } catch (err: unknown) {
      if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        return null
      }
      throw err
    }
  }

  /** Write the full state array atomically (tmp + rename). */
  private async writeState(records: BackgroundJobRecord[]): Promise<void> {
    await this.ensureDir()
    const content = JSON.stringify(records, null, 2)
    await writeFile(this.tmpPath, content, 'utf-8')
    await rename(this.tmpPath, this.statePath)
  }

  async saveJob(record: BackgroundJobRecord): Promise<void> {
    const records = (await this.readState()) ?? []
    const idx = records.findIndex(r => r.taskID === record.taskID)
    if (idx >= 0) {
      records[idx] = record
    } else {
      records.push(record)
    }
    await this.writeState(records)
  }

  async loadAllJobs(): Promise<BackgroundJobRecord[]> {
    return (await this.readState()) ?? []
  }

  async deleteJob(taskID: string): Promise<void> {
    const records = await this.readState()
    if (!records) return
    const idx = records.findIndex(r => r.taskID === taskID)
    if (idx < 0) return
    records.splice(idx, 1)
    await this.writeState(records)
  }
}
