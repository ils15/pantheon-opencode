/**
 * File-based persistence adapter for the BackgroundJobBoard.
 *
 * Stores all jobs in a single `state.json` file. Writes are crash-safe:
 * the payload is written to a UNIQUE temp file, fsynced, then renamed over
 * the destination. Writes to the same path are serialized through an
 * in-process queue so two logical writers (plugin × native) cannot
 * interleave and corrupt the JSON or race the rename.
 *
 * Reads are corruption-tolerant: a malformed `state.json` is moved aside to
 * `<state>.corrupt-<ts>`, a clear log is emitted, and whatever complete
 * records can be salvaged from the array are returned — never a throw, so
 * callers (delete/prune/recover) cannot get stuck in a retry loop.
 *
 * @module file-persistence
 */

import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

import type { BackgroundJobRecord, PersistenceAdapter } from './background-job-board.ts'
import { salvageRecords } from './file-persistence-salvage.ts'
import { createPantheonLogger } from './logger.ts'

export { salvageRecords } from './file-persistence-salvage.ts'

const log = createPantheonLogger({ module: 'FilePersistence' })

/** Default path for the state file. */
const DEFAULT_STATE_PATH = '.pantheon/board/state.json'

/** Max rename attempts after an ENOENT before giving up (dir/tmp recreated each try). */
const RENAME_MAX_ATTEMPTS = 3

/** Minimal file handle surface used to fsync the temp file before rename. */
export interface PersistenceFileHandle {
  writeFile(data: string, encoding: 'utf-8'): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

/**
 * Filesystem operations used by the adapter. Injectable so tests can fault
 * inject a failing `rename` (ENOENT) deterministically.
 */
export interface PersistenceFsOps {
  mkdir(dir: string): Promise<void>
  readFile(path: string, encoding: 'utf-8'): Promise<string>
  rename(from: string, to: string): Promise<void>
  openForWrite(path: string): Promise<PersistenceFileHandle>
  unlink(path: string): Promise<void>
}

/** Real Node.js filesystem implementation (the default). */
const defaultFsOps: PersistenceFsOps = {
  mkdir: async (dir) => {
    await mkdir(dir, { recursive: true })
  },
  readFile: (path, encoding) => readFile(path, encoding),
  rename: (from, to) => rename(from, to),
  openForWrite: (path) => open(path, 'w'),
  unlink: (path) => unlink(path),
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * In-process write queues keyed by absolute state path. Shared across
 * adapter INSTANCES so a plugin adapter and a native adapter pointing at the
 * same file serialize their read-modify-write cycles.
 */
const writeQueues = new Map<string, Promise<unknown>>()

function enqueueWrite<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(key) ?? Promise.resolve()
  const run = previous.then(task, task)
  writeQueues.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

/**
 * File-based persistence adapter.
 *
 * All jobs are stored in a single JSON array in `statePath`. Writes are
 * atomic and serialized (unique tmp + fsync + rename, with ENOENT retry).
 * Corrupt state is backed up and salvaged instead of throwing.
 */
export class FilePersistenceAdapter implements PersistenceAdapter {
  private readonly statePath: string
  private readonly dir: string
  private readonly ops: PersistenceFsOps
  private readonly lockKey: string
  private tmpCounter = 0

  /**
   * @param statePath  Path to the state JSON file (default: `.pantheon/board/state.json`)
   * @param ops        Filesystem operations (defaults to real Node.js fs; injectable for tests)
   */
  constructor(statePath?: string, ops: PersistenceFsOps = defaultFsOps) {
    this.statePath = statePath ?? DEFAULT_STATE_PATH
    this.dir = dirname(this.statePath)
    this.ops = ops
    this.lockKey = resolve(this.statePath)
  }

  /** Ensure the parent directory exists. */
  private async ensureDir(): Promise<void> {
    await this.ops.mkdir(this.dir)
  }

  /** Unique temp path per write — prevents two writers racing the same tmp. */
  private makeTmpPath(): string {
    this.tmpCounter += 1
    const unique = `${process.pid}.${this.tmpCounter}.${Math.random().toString(36).slice(2, 8)}`
    return `${this.statePath}.${unique}.tmp`
  }

  /**
   * Read all jobs from the state file.
   *
   * Return contract distinguishes three failure modes:
   * - absent file (ENOENT) → `[]` (first run / no jobs yet);
   * - corrupt content → quarantine + `salvageRecords()` (best-effort recovery);
   * - non-ENOENT IO error (e.g. EIO) → `null`, signalling the read failed.
   *
   * Callers doing read-modify-write MUST abort on `null` so a failed read
   * cannot overwrite the on-disk state with a partial snapshot.
   */
  private async readState(): Promise<BackgroundJobRecord[] | null> {
    let content: string
    try {
      content = await this.ops.readFile(this.statePath, 'utf-8')
    } catch (err: unknown) {
      if (isEnoent(err)) return []
      log.error(`[FilePersistence] Failed to read ${this.statePath}:`, err)
      return null
    }

    try {
      const parsed: unknown = JSON.parse(content)
      if (!Array.isArray(parsed)) {
        throw new Error('state.json is not a JSON array')
      }
      return parsed as BackgroundJobRecord[]
    } catch (err: unknown) {
      await this.quarantineCorrupt(err)
      const salvaged = salvageRecords(content)
      log.warn(
        `[FilePersistence] Corrupt ${this.statePath} — recovered ${salvaged.length} record(s)`,
      )
      return salvaged
    }
  }

  /** Move a corrupt state.json aside so the next write starts from a clean file. */
  private async quarantineCorrupt(cause: unknown): Promise<void> {
    const backupPath = `${this.statePath}.corrupt-${Date.now()}`
    try {
      await this.ops.rename(this.statePath, backupPath)
      log.error(`[FilePersistence] Corrupt ${this.statePath} backed up to ${backupPath}:`, cause)
    } catch (err: unknown) {
      log.error(
        `[FilePersistence] Could not back up corrupt ${this.statePath} — continuing with salvaged state:`,
        err,
      )
    }
  }

  /** Write the full state array: unique tmp + fsync + rename (with ENOENT retry). */
  private async writeState(records: BackgroundJobRecord[]): Promise<void> {
    const content = JSON.stringify(records, null, 2)
    const tmpPath = this.makeTmpPath()
    let lastError: unknown

    for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
      try {
        await this.ensureDir()
        const handle = await this.ops.openForWrite(tmpPath)
        try {
          await handle.writeFile(content, 'utf-8')
          await handle.sync()
        } finally {
          await handle.close()
        }
        await this.ops.rename(tmpPath, this.statePath)
        return
      } catch (err: unknown) {
        lastError = err
        if (!isEnoent(err)) break
        log.warn(
          `[FilePersistence] rename ENOENT for ${this.statePath} ` +
            `(attempt ${attempt}/${RENAME_MAX_ATTEMPTS}) — recreating dir and retrying`,
        )
        await this.safeUnlink(tmpPath)
      }
    }

    await this.safeUnlink(tmpPath)
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  private async safeUnlink(path: string): Promise<void> {
    try {
      await this.ops.unlink(path)
    } catch {
      // Best-effort temp cleanup — absent file is fine.
    }
  }

  async saveJob(record: BackgroundJobRecord): Promise<void> {
    await enqueueWrite(this.lockKey, async () => {
      const records = await this.readState()
      if (records === null) {
        log.error(
          `[FilePersistence] Aborting saveJob(${record.taskID}): could not read ` +
            `${this.statePath} — refusing to overwrite state with a partial snapshot`,
        )
        return
      }
      const idx = records.findIndex((r) => r.taskID === record.taskID)
      if (idx >= 0) {
        records[idx] = record
      } else {
        records.push(record)
      }
      await this.writeState(records)
    })
  }

  async loadAllJobs(): Promise<BackgroundJobRecord[]> {
    return (await this.readState()) ?? []
  }

  async deleteJob(taskID: string): Promise<void> {
    await enqueueWrite(this.lockKey, async () => {
      const records = await this.readState()
      if (!records) return
      const idx = records.findIndex((r) => r.taskID === taskID)
      if (idx < 0) return
      records.splice(idx, 1)
      await this.writeState(records)
    })
  }
}
