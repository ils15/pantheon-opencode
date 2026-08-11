/**
 * Read-Only Enforcement (Phase 4) — deny mutating tools inside sessions that
 * were delegated as read-only (advisory `read_only: true` on
 * pantheon_delegate, or the agent ∈ `readOnlyAgents` from routing.yml).
 *
 * OpenCode hook: `tool.execute.before`. The hook shape is
 * `(input, output) => Promise<void>`; THROWING from the hook denies the tool
 * call and the caller (the subagent session) sees the thrown message. This
 * module never needs the opencode SDK — the handler is a structural closure
 * wired from plugin.ts.
 *
 * Blocked tools (edit, write, bash, task):
 *   - edit/write/bash are the mutating surface — read-only agents (apollo,
 *     gaia) must stay investigation-only.
 *   - `task` is blocked too, which hard-enforces depth-2: a read-only agent
 *     cannot spawn its own subagents.
 *
 * Unknown sessions are ALLOWED by default — the guard only denies sessions
 * that are explicitly registered, so normal (non-delegated) agent work is
 * never blocked.
 *
 * The registry is populated by delegation.ts at delegate time: the CHILD
 * session is registered when the delegate call is read-only.
 *
 * @module delegation-enforce
 */

// ─── Types ─────────────────────────────────────────────────────────────

/** Why a session is read-only. */
export interface ReadOnlyEntry {
  /** Agent name the session was delegated to (e.g. "apollo"). */
  agent: string
  /** Whether read_only was set explicitly on the delegate call. */
  readOnlyFlag?: boolean
  /** Epoch ms when the session was registered. */
  registeredAt: number
}

/** Input the opencode `tool.execute.before` hook passes. */
export interface ToolExecuteBeforeInput {
  tool: string
  sessionID: string
  callID: string
}

/** The `tool.execute.before` handler shape (throw ⇒ deny). */
export type ToolExecuteBeforeHandler = (input: ToolExecuteBeforeInput) => Promise<void>

/** Options for createEnforcementGuard(). */
export interface EnforcementGuardOptions {
  /** Tools denied in read-only sessions (default: DEFAULT_BLOCKED_TOOLS). */
  blockedTools?: ReadonlySet<string>
  /** Prefix for the denial message. */
  messagePrefix?: string
}

// ─── Defaults ──────────────────────────────────────────────────────────

/** Mutating tools denied in read-only sessions. `task` ⇒ depth-2 guard. */
export const DEFAULT_BLOCKED_TOOLS: ReadonlySet<string> = new Set(['edit', 'write', 'bash', 'task'])

// ─── Registry ──────────────────────────────────────────────────────────

/**
 * Read-only session registry. `createDelegationTools` registers child
 * sessions here; the plugin's `tool.execute.before` guard consults it.
 * Process-wide singleton for plugin wiring + factory for test isolation.
 */
export class ReadOnlySessionRegistry {
  private readonly sessions = new Map<string, ReadOnlyEntry>()

  /** Register a session as read-only. Idempotent (re-registration updates). */
  register(sessionID: string, entry: { agent: string; readOnlyFlag?: boolean }): void {
    const record: ReadOnlyEntry = { agent: entry.agent, registeredAt: Date.now() }
    if (entry.readOnlyFlag !== undefined) record.readOnlyFlag = entry.readOnlyFlag
    this.sessions.set(sessionID, record)
  }

  /** Remove a session from the read-only set (dynamic revocation). */
  unregister(sessionID: string): void {
    this.sessions.delete(sessionID)
  }

  /** Whether the session is registered as read-only. */
  has(sessionID: string): boolean {
    return this.sessions.has(sessionID)
  }

  /** Snapshot of the registered entry, or undefined. */
  get(sessionID: string): ReadOnlyEntry | undefined {
    return this.sessions.get(sessionID)
  }

  /** Snapshot of all read-only session IDs (guards read a stable copy). */
  sessionIDs(): ReadonlySet<string> {
    return new Set(this.sessions.keys())
  }

  /** Remove every registration (test hygiene / plugin teardown). */
  clear(): void {
    this.sessions.clear()
  }
}

/** Process-wide registry wired into the plugin. */
export const readOnlyRegistry = new ReadOnlySessionRegistry()

// ─── Guard ─────────────────────────────────────────────────────────────

/**
 * Build the `tool.execute.before` handler. Throws with an actionable message
 * when a blocked tool is invoked from a registered read-only session; any
 * other session (or tool) passes through untouched.
 */
export function createEnforcementGuard(input: {
  getReadOnlySessions: () => ReadonlySet<string>
  options?: EnforcementGuardOptions
}): ToolExecuteBeforeHandler {
  const blockedTools = input.options?.blockedTools ?? DEFAULT_BLOCKED_TOOLS
  const prefix = input.options?.messagePrefix ?? 'pantheon_delegate guard'

  return async (hook: ToolExecuteBeforeInput): Promise<void> => {
    if (!blockedTools.has(hook.tool)) return
    if (!input.getReadOnlySessions().has(hook.sessionID)) return

    throw new Error(
      `${prefix}: session ${hook.sessionID} is READ-ONLY — tool "${hook.tool}" is denied. ` +
        `This session was delegated for investigation only (read-only agent); it cannot ` +
        `modify files, run commands, or spawn subagents. ` +
        `If a write result is needed, dispatch a write-capable agent ` +
        `(e.g. hermes, aphrodite) with pantheon_delegate instead.`,
    )
  }
}
