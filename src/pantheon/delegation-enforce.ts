/**
 * Read-Only Enforcement (Phase 4) — deny mutating tools inside sessions that
 * were delegated as read-only (advisory `read_only: true` on the native
 * `task` delegate, or the agent ∈ `readOnlyAgents` from routing.yml).
 *
 * OpenCode hook: `tool.execute.before`. The hook shape is
 * `(input, output) => Promise<void>`; THROWING from the hook denies the tool
 * call and the caller (the subagent session) sees the thrown message. This
 * module never needs the opencode SDK — the handler is a structural closure
 * wired from plugin.ts.
 *
 * Blocked tools (edit, write, bash, task, hashline_edit):
 *   - edit/write/bash are the mutating surface — read-only agents (apollo,
 *     gaia) must stay investigation-only.
 *   - `hashline_edit` is the Wave 2 (PR #46) tag-anchored edit tool — it is a
 *     write surface too, so read-only agents must not bypass enforcement via
 *     it.
 *   - `task` is blocked too, which hard-enforces depth-2: a read-only agent
 *     cannot spawn its own subagents.
 *
 * Unknown sessions are allowed for ordinary tools. The runtime matrix is
 * fail-closed when wired: missing agent identity or
 * target metadata is denied rather than inferred.
 *
 * The registry is populated at delegate time: the CHILD
 * session is registered when the delegate call is read-only.
 *
 * @module delegation-enforce
 */

// ─── Types ─────────────────────────────────────────────────────────────

import { isAgentAllowed, type PermissionTaskConfig } from './permission-globs.ts'

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

/** The output object supplied alongside `tool.execute.before`. */
export interface ToolExecuteBeforeOutput {
  args?: unknown
}

/** The `tool.execute.before` handler shape (throw ⇒ deny). */
export type ToolExecuteBeforeHandler = (
  input: ToolExecuteBeforeInput,
  output?: ToolExecuteBeforeOutput,
) => Promise<void>

/** Runtime session hierarchy, populated only from SDK session metadata. */
export class SessionHierarchyRegistry {
  private readonly roots = new Set<string>()
  private readonly children = new Set<string>()
  private seedState: 'unseeded' | 'pending' | 'seeded' | 'failed' = 'unseeded'

  /** Mark the beginning of an authoritative session snapshot lookup. */
  beginSeed(): void {
    this.seedState = 'pending'
  }

  /** Complete the lookup and register the SDK's authoritative parentID data. */
  completeSeed(sessions: ReadonlyArray<{ id: string; parentID?: string }>): void {
    this.registerMany(sessions)
    this.seedState = 'seeded'
  }

  /** Record an unavailable snapshot without classifying unknown sessions as children. */
  failSeed(): void {
    this.seedState = 'failed'
  }

  /** Register a session using its SDK parentID (or lack of one). */
  register(session: { id: string; parentID?: string }): void {
    if (session.parentID !== undefined) {
      this.children.add(session.id)
      this.roots.delete(session.id)
      return
    }
    if (!this.children.has(session.id)) this.roots.add(session.id)
  }

  /** Register a snapshot returned by session.list(). */
  registerMany(sessions: ReadonlyArray<{ id: string; parentID?: string }>): void {
    for (const session of sessions) this.register(session)
  }

  /** Whether SDK metadata identified this session as a child. */
  isChild(sessionID: string): boolean {
    return this.children.has(sessionID)
  }

  /** Whether SDK metadata identified this session as a root. */
  isRoot(sessionID: string): boolean {
    if (this.children.has(sessionID)) return false
    if (this.roots.has(sessionID)) return true
    // Until the authoritative snapshot is available, an unknown session is
    // deliberately unclassified. A valid root resumed after restart must not
    // be denied merely because session.list() is slow or unavailable.
    return this.seedState !== 'seeded'
  }

  /** Snapshot of known root IDs. */
  rootIDs(): ReadonlySet<string> {
    return new Set(this.roots)
  }
}

/** Normalize an agent identity without guessing from prompts or tool names. */
export function normalizeDelegationAgent(agent: unknown): string | undefined {
  if (typeof agent !== 'string') return undefined
  const normalized = agent.trim().toLowerCase()
  return normalized === '' ? undefined : normalized
}

/**
 * Runtime delegation matrix from Fase B2, gated by the O5 permission.task
 * glob rules when provided. The glob rules run FIRST (last-match-wins; a
 * deny blocks the target regardless of the matrix), then the static matrix
 * (zeus → anyone; athena/hermes → apollo only).
 */
export function isDelegationAllowed(
  callerAgent: unknown,
  targetAgent: unknown,
  permissionTask?: PermissionTaskConfig,
): boolean {
  const caller = normalizeDelegationAgent(callerAgent)
  const target = normalizeDelegationAgent(targetAgent)
  if (caller === undefined || target === undefined) return false
  if (permissionTask !== undefined && !isAgentAllowed(permissionTask, target)) return false
  if (caller === 'zeus') return true
  return (caller === 'athena' || caller === 'hermes') && target === 'apollo'
}

function targetFromTool(tool: string, args: unknown): string | undefined {
  if (args === null || typeof args !== 'object') return undefined
  const record = args as Record<string, unknown>
  if (tool === 'task') {
    return normalizeDelegationAgent(record.subagent_type ?? record.subagentType)
  }
  return undefined
}

/** Options for createEnforcementGuard(). */
export interface EnforcementGuardOptions {
  /** Tools denied in read-only sessions (default: DEFAULT_BLOCKED_TOOLS). */
  blockedTools?: ReadonlySet<string>
  /** Prefix for the denial message. */
  messagePrefix?: string
  /** Current agent by session, populated by the SDK chat.params hook. */
  getSessionAgent?: (sessionID: string) => string | undefined
  /** SDK-backed root check used for the delegation matrix. */
  isRootSession?: (sessionID: string) => boolean
  /** SDK-backed child check used to prevent native task() depth escalation. */
  isChildSession?: (sessionID: string) => boolean
  /** O5 permission.task glob rules — deny removes the target entirely. */
  permissionTask?: PermissionTaskConfig
  /** Audit sink for denied runtime delegation attempts. */
  logger?: { warn?: (message: string) => void }
}

// ─── Defaults ──────────────────────────────────────────────────────────

/** Mutating tools denied in read-only sessions. `task` ⇒ depth-2 guard. */
export const DEFAULT_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  'edit',
  'write',
  'bash',
  'task',
  'hashline_edit',
])

// ─── Zeus Read Guard ──────────────────────────────────────────────────

/**
 * Path patterns that Zeus must NOT read directly. Zeus must delegate
 * codebase reads to @apollo to avoid context bloat and enforce separation
 * of concerns.
 */
export const ZEUS_READ_DENY_PATTERNS: ReadonlyArray<RegExp> = [/^src\//, /^tests?\//, /^scripts?\//]

/**
 * Path exceptions that Zeus MAY read even if they match a deny pattern.
 * Markdown files, .pantheon/ configs, and memories/ are operational context
 * that Zeus legitimately needs.
 */
export const ALLOWED_PATHS: ReadonlyArray<RegExp> = [/\.md$/, /\.pantheon\//, /memories\//]

/**
 * Zeus read guard. When the active agent is Zeus, deny read/glob/grep calls
 * that target source code, tests, or scripts — Zeus must delegate those to
 * @apollo. Allowed paths (markdown, .pantheon/, memories/) are exempt.
 *
 * Non-Zeus sessions are never affected.
 *
 * @throws {Error} when Zeus attempts a denied read
 */
export function zeusReadGuard(tool: string, args: unknown, agent: string | undefined): void {
  if (agent !== 'zeus') return
  if (tool !== 'read' && tool !== 'glob' && tool !== 'grep') return

  const record = args as Record<string, unknown> | undefined
  const filePath =
    typeof record?.filePath === 'string'
      ? record.filePath
      : typeof record?.pattern === 'string'
        ? record.pattern
        : undefined

  if (!filePath) return

  for (const pattern of ZEUS_READ_DENY_PATTERNS) {
    if (pattern.test(filePath)) {
      // Check allowed-path exceptions before denying
      for (const allowed of ALLOWED_PATHS) {
        if (allowed.test(filePath)) return
      }
      throw new Error(`Zeus cannot read ${filePath} — delegate to @apollo`)
    }
  }
}

// ─── Registry ──────────────────────────────────────────────────────────

/**
 * Read-only session registry. The plugin's delegate wiring registers child
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
  const prefix = input.options?.messagePrefix ?? 'delegation guard'

  return async (hook: ToolExecuteBeforeInput, output?: ToolExecuteBeforeOutput): Promise<void> => {
    const isDelegationTool = hook.tool === 'task'
    if (isDelegationTool && input.options?.isChildSession?.(hook.sessionID) === true) {
      throw new Error(
        `${prefix}: session ${hook.sessionID} is a child session — delegation tools are denied ` +
          'to prevent nested delegation',
      )
    }
    // The native task() delegate has the authoritative ToolContext.agent at
    // execution time, so its matrix check lives in dispatch-guard.ts. The hook
    // only has the session-scoped agent learned from chat.params.
    if (
      hook.tool === 'task' &&
      input.options?.isRootSession !== undefined &&
      input.options?.isChildSession?.(hook.sessionID) !== true
    ) {
      const caller = input.options.getSessionAgent?.(hook.sessionID)
      const target = targetFromTool(hook.tool, output?.args)
      if (!input.options.isRootSession(hook.sessionID)) {
        input.options.logger?.warn?.(
          `${prefix}: delegation denied for session ${hook.sessionID} — not an authorized root session`,
        )
        throw new Error(`${prefix}: session ${hook.sessionID} is not an authorized root session`)
      }
      if (!isDelegationAllowed(caller, target, input.options?.permissionTask)) {
        const reason =
          caller === undefined ? 'caller agent is unavailable' : 'agent/target is not allowed'
        input.options.logger?.warn?.(
          `${prefix}: delegation denied for session ${hook.sessionID} — ${reason}`,
        )
        throw new Error(
          `${prefix}: delegation denied — ${reason}; target must follow the runtime matrix`,
        )
      }
    }
    if (!blockedTools.has(hook.tool)) return
    if (!input.getReadOnlySessions().has(hook.sessionID)) return

    throw new Error(
      `${prefix}: session ${hook.sessionID} is READ-ONLY — tool "${hook.tool}" is denied. ` +
        `This session was delegated for investigation only (read-only agent); it cannot ` +
        `modify files, run commands, or spawn subagents. ` +
        `If a write result is needed, dispatch a write-capable agent ` +
        `(e.g. hermes, aphrodite) with the native task() tool instead.`,
    )
  }
}
