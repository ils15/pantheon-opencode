/**
 * Todo Preserver (release-134 Phase 3) — post-compaction todo restore.
 *
 * WHY: opencode 1.18.11 exposes NO todo write API (SessionTodoData.body?:
 * never — the `/session/{id}/todo` route is GET-only), so a session's todo
 * list cannot be restored by a direct SDK call after compaction. The model's
 * `todowrite` tool performs a FULL replace server-side (todos.update
 * delete+insert), so a model that re-emits a partial list right after
 * compaction silently clobbers the pre-compaction list.
 *
 * HOW: three phases, all additive to the existing plugin hooks:
 *   1. CAPTURE — `experimental.session.compacting` calls `capture(sessionID)`
 *      (a GET of the todo list) alongside the existing context build.
 *   2. RESTORE — the `event` hook routes `session.compacted` to
 *      `onCompacted(sessionID)`, activating the pending snapshot. The FIRST
 *      `todowrite` of that session within `restoreWindowMs` has its
 *      `output.args.todos` rewritten with the EXACT captured list — no model
 *      cooperation, zero transcript noise. Subsequent writes inside the
 *      window are denied with a clear "retry in a moment" message so the
 *      restored list stays stable.
 *   3. GUARD — `beforeTodoWrite` chains with the read-only enforcement guard
 *      on `tool.execute.before` (enforcement first, restore second).
 *
 * FAIL-OPEN: every step is wrapped — a capture GET failure, a missing event,
 * a malformed hook output, or an expired snapshot degrades to a logged warn
 * and pass-through. The ONLY deliberate throw is the restore-window denial
 * (TodoRestoreInProgressError), and only for the exact session being
 * restored.
 *
 * STATE: transient in-memory Map<sessionID, {todos, capturedAt, restored}>
 * (no files, no KV). `snapshotTtlMs` (60s) bounds how old a snapshot may be;
 * `restoreWindowMs` (5s) bounds interception after capture. An empty captured
 * list stores nothing → no restore, zero noise. Snapshots are anchored on
 * `capturedAt`: capture and the compacted event are adjacent (the session is
 * paused mid-compaction), so one timestamp covers both the TTL and the
 * window — a second timestamp would be YAGNI.
 *
 * VERSION-SENSITIVE WRITE HOOK: `tryWriteApi` attempts a direct todo write
 * when an adapter is injected (options.tryWriteApi). SDK 1.18.11 ships no
 * adapter (the route is GET-only) → restore goes through interception. If a
 * future SDK exposes a write, inject an adapter built on a dynamic
 * `await import('@opencode-ai/sdk')` probe and the preserver prefers it: a
 * successful direct write drops the snapshot and skips interception entirely.
 *
 * Pure TypeScript — zero runtime deps beyond the structural client type.
 *
 * @module todo-preserve
 */

import { createPantheonLogger } from './logger.ts'
import { safeSessionPath } from './session-guard.ts'
import type { TodoLike } from './todo-enforcer.ts'

// Silence-by-default TUI policy (pantheon-hooks L42-58): console echo is
// opt-in via PANTHEON_HOOKS_LOG=1. `deps.logger` injection stays for tests.
const log = createPantheonLogger({ module: 'pantheon-todo-preserve' })

// ─── Constants ─────────────────────────────────────────────────────────

/** How long a captured snapshot stays valid (bounds staleness). */
export const SNAPSHOT_TTL_MS = 60_000

/** Interception window after capture: only the FIRST todowrite is restored. */
export const RESTORE_WINDOW_MS = 5_000

// ─── Types ─────────────────────────────────────────────────────────────

/**
 * Structural client surface — the subset of the SDK the preserver uses
 * (mirrors TodoEnforcerClient; only the GET is needed for capture).
 */
export interface TodoPreserverClient {
  session: {
    todo(input: { path: { id: string } }): Promise<TodoLike[]>
  }
}

/** Tunables (all optional — see the constants). */
export interface TodoPreserverOptions {
  snapshotTtlMs?: number
  restoreWindowMs?: number
  /** Injectable clock (testable), defaults to `Date.now`. */
  now?: () => number
  /**
   * Version-sensitive direct-write adapter. SDK 1.18.11 exposes no todo
   * write (SessionTodoData.body?: never) — restore happens via
   * `tool.execute.before` interception (beforeTodoWrite). If a future SDK
   * adds a write endpoint, inject an adapter here (e.g. built on a dynamic
   * `await import('@opencode-ai/sdk')` probe) and the preserver prefers the
   * direct API restore: onCompacted calls this first and, when it resolves
   * true, drops the snapshot so interception is skipped entirely. Absence
   * or failure falls back to interception. Never throws (wrapped).
   */
  tryWriteApi?: (sessionID: string, todos: TodoLike[]) => Promise<boolean>
}

/** Dependencies threaded to the preserver. */
export interface TodoPreserverDeps {
  client: TodoPreserverClient
  options?: TodoPreserverOptions
  logger?: { warn: (message: string) => void }
}

/** Input the opencode `tool.execute.before` hook passes. */
export interface TodoWriteBeforeInput {
  tool: string
  sessionID: string
  callID: string
}

/** The `tool.execute.before` output — args mutated to restore the list. */
export interface TodoWriteBeforeOutput {
  args?: { todos?: unknown }
}

/** A captured (full) todo list awaiting post-compaction restore. */
interface SnapshotEntry {
  todos: TodoLike[]
  /** Epoch ms of the capture — anchor for both the TTL and the window. */
  capturedAt: number
  /** True once the FIRST todowrite was intercepted (rewrite done). */
  restored: boolean
}

/**
 * Thrown to deny a `todowrite` while the post-compaction restore is settling
 * (the list was just rewritten; a competing model write would clobber it).
 */
export class TodoRestoreInProgressError extends Error {
  constructor(sessionID: string) {
    super(`todo list being restored after compaction — retry in a moment (session ${sessionID})`)
    this.name = 'TodoRestoreInProgressError'
  }
}

/** Resolved tunables — tryWriteApi stays `| undefined` (optional adapter). */
interface ResolvedTodoPreserverOptions {
  snapshotTtlMs: number
  restoreWindowMs: number
  now: () => number
  tryWriteApi: TodoPreserverOptions['tryWriteApi']
}

// ─── TodoPreserver ─────────────────────────────────────────────────────

/**
 * Preserve a session's todo list across compaction by intercepting the first
 * post-compaction `todowrite`. All public methods are best-effort — the
 * hooks can never break the session; failures are logged and swallowed.
 */
export class TodoPreserver {
  private readonly client: TodoPreserverClient
  private readonly options: ResolvedTodoPreserverOptions
  private readonly warn: (message: string) => void
  private readonly snapshots = new Map<string, SnapshotEntry>()

  constructor(deps: TodoPreserverDeps) {
    this.client = deps.client
    const opts = deps.options ?? {}
    this.options = {
      snapshotTtlMs: opts.snapshotTtlMs ?? SNAPSHOT_TTL_MS,
      restoreWindowMs: opts.restoreWindowMs ?? RESTORE_WINDOW_MS,
      now: opts.now ?? Date.now,
      tryWriteApi: opts.tryWriteApi,
    }
    this.warn = deps.logger?.warn ?? ((message: string) => log.warn(message))
  }

  /**
   * CAPTURE (wired from `experimental.session.compacting`): GET the session's
   * full todo list and store it as the restore snapshot. An empty list
   * stores nothing (zero noise). Never throws — a GET failure is logged and
   * the session compacts normally.
   */
  async capture(sessionID: string): Promise<void> {
    this.pruneExpired()
    const path = safeSessionPath(sessionID)
    if (!path) {
      this.warn(`todo snapshot capture skipped: invalid sessionID "${sessionID}"`)
      return
    }
    try {
      const todos = await this.client.session.todo(path)
      if (todos.length === 0) {
        // Nothing to preserve → drop any stale entry so no restore happens.
        this.snapshots.delete(sessionID)
        return
      }
      this.snapshots.set(sessionID, {
        todos,
        capturedAt: this.now(),
        restored: false,
      })
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      this.warn(`todo snapshot capture failed for session ${sessionID}: ${reason}`)
    }
  }

  /**
   * RESTORE activation (wired from the `event` hook on `session.compacted`):
   * mark the captured snapshot as restore-pending. Without a fresh snapshot
   * (no capture, empty list, or expired TTL) this is a no-op — fail-open.
   * When a direct-write adapter is injected and succeeds, the snapshot is
   * dropped so interception never runs. Never throws.
   */
  async onCompacted(sessionID: string): Promise<void> {
    try {
      const entry = this.snapshots.get(sessionID)
      if (entry === undefined) return
      if (this.expired(entry)) {
        this.snapshots.delete(sessionID)
        return
      }
      if (await this.tryWriteApi(sessionID, entry.todos)) {
        this.snapshots.delete(sessionID)
      }
      // Otherwise the entry stays pending: the first todowrite within the
      // restore window is rewritten with the snapshot (beforeTodoWrite).
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      this.warn(`todo restore activation failed for session ${sessionID}: ${reason}`)
    }
  }

  /**
   * GUARD (wired on `tool.execute.before`, chained after the read-only
   * enforcement guard): intercept `todowrite` calls for a session whose
   * snapshot is pending. The FIRST call inside the restore window has
   * `output.args.todos` rewritten with the exact captured list; subsequent
   * calls inside the window throw TodoRestoreInProgressError; calls outside
   * the window, for other sessions, or for other tools pass through
   * untouched. Fail-open: the only throw is the intentional denial.
   */
  async beforeTodoWrite(input: TodoWriteBeforeInput, output: TodoWriteBeforeOutput): Promise<void> {
    if (input.tool !== 'todowrite') return
    const entry = this.snapshots.get(input.sessionID)
    if (entry === undefined) return
    try {
      const now = this.now()
      if (now - entry.capturedAt >= this.options.snapshotTtlMs) {
        this.snapshots.delete(input.sessionID)
        return
      }
      if (now - entry.capturedAt >= this.options.restoreWindowMs) {
        this.snapshots.delete(input.sessionID)
        return
      }
      if (entry.restored) {
        throw new TodoRestoreInProgressError(input.sessionID)
      }
      if (output.args === undefined) {
        this.warn(
          `todo restore: hook output.args missing for session ${input.sessionID} — passing through`,
        )
        return
      }
      output.args.todos = entry.todos
      entry.restored = true
    } catch (err: unknown) {
      // Rethrow ONLY the intentional denial; everything else is fail-open.
      if (err instanceof TodoRestoreInProgressError) throw err
      const reason = err instanceof Error ? err.message : String(err)
      this.warn(`todo restore interception failed for session ${input.sessionID}: ${reason}`)
    }
  }

  /**
   * Version-sensitive direct-write attempt. Returns false (fast) when no
   * adapter is injected — the SDK 1.18.11 reality — so restore proceeds via
   * interception. With an adapter, a resolved true means the list is already
   * restored server-side; a throw or false falls back to interception.
   * Never throws.
   */
  async tryWriteApi(sessionID: string, todos: TodoLike[]): Promise<boolean> {
    const write = this.options.tryWriteApi
    if (write === undefined) return false
    try {
      return await write(sessionID, todos)
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      this.warn(`todo write API attempt failed for session ${sessionID}: ${reason}`)
      return false
    }
  }

  private now(): number {
    return this.options.now()
  }

  private expired(entry: SnapshotEntry): boolean {
    return this.now() - entry.capturedAt >= this.options.snapshotTtlMs
  }

  /** Drop expired snapshots (bounded by capture frequency — no timers). */
  private pruneExpired(): void {
    for (const [sessionID, entry] of this.snapshots) {
      if (this.expired(entry)) this.snapshots.delete(sessionID)
    }
  }
}
