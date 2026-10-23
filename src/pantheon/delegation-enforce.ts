/**
 * Read-Only Enforcement (Phase 4) — deny mutating tools inside sessions that
 * were delegated as read-only (an explicit read-only flag, or the agent ∈
 * `readOnlyAgents` from routing.yml).
 *
 * OpenCode hook: `tool.execute.before`. The hook shape is
 * `(input, output) => Promise<void>`; THROWING from the hook denies the tool
 * call and the caller (the subagent session) sees the thrown message. This
 * module never needs the opencode SDK — the handler is a structural closure
 * wired from plugin.ts.
 *
 * Blocked tools (edit, write, bash, task, hashline_edit, pantheon_model):
 *   - edit/write/bash are the mutating surface — read-only agents (apollo,
 *     gaia) must stay investigation-only.
 *   - `hashline_edit` is the Wave 2 (PR #46) tag-anchored edit tool — it is a
 *     write surface too, so read-only agents must not bypass enforcement via
 *     it.
 *   - `pantheon_model` writes active-preset.json in project and global scope —
 *     a config write a read-only session must not perform.
 *   - `task` is blocked too, which hard-enforces depth-2: a read-only agent
 *     cannot spawn its own subagents.
 *
 * Unknown sessions are allowed for ordinary tools. Delegation tools are
 * fail-closed when the runtime matrix is wired: missing agent identity or
 * target metadata is denied rather than inferred.
 *
 * The registry is populated by the plugin's `chat.params` hook — the only
 * place the SDK exposes the active agent: when the session's agent is
 * read-only (apollo, gaia — routing.yml `background_delegation.read_only_agents`),
 * the session is registered; `session.deleted` unregisters it.
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
  // `pantheon_model` writes active-preset.json in BOTH the project and the
  // global scope, so it is a write surface with the same blast radius as
  // `write`. Read-only agents have no reason to change agent models, and a
  // global override from an investigation-only session is unrecoverable from
  // inside that session. `pantheon_cost` is deliberately absent: it only reads
  // opencode.db.
  'pantheon_model',
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
 * Normalize a tool-supplied path before it meets the deny patterns.
 *
 * The patterns are anchored on `/`, so two spellings of the same source path
 * used to pass: Windows separators (`src\\file.ts`) and a redundant dot prefix
 * (`./src/file.ts`). Normalizing both is a TIGHTENING — it can only turn a
 * previously allowed spelling into a denied one, never the reverse.
 */
function normalizeGuardPath(value: string): string {
  let normalized = value.replace(/\\/g, '/')
  while (normalized.startsWith('./')) normalized = normalized.slice(2)
  return normalized
}

/** One path-bearing argument, and whether it names a target or a query. */
interface GuardCandidate {
  value: string
  /** `filePath`/`path` name the read target; `pattern` may be a grep query. */
  target: boolean
}

/**
 * Path-bearing arguments of a read/glob/grep call.
 *
 * EVERY one is returned, not just the first: a `grep` call carries its
 * directory in `path` and its query in `pattern`, so inspecting only `pattern`
 * left `path: 'src'` unchecked. `pattern` is a TARGET for `glob` (it is the
 * path pattern) but a QUERY for `grep` (it is the text to search for), so a
 * bare `src` query is not a source read.
 */
function guardPathCandidates(tool: string, args: unknown): GuardCandidate[] {
  if (args === null || typeof args !== 'object') return []
  const record = args as Record<string, unknown>
  const candidates: GuardCandidate[] = []
  for (const key of ['filePath', 'path', 'pattern']) {
    const value = record[key]
    if (typeof value !== 'string' || value.trim() === '') continue
    candidates.push({ value, target: key !== 'pattern' || tool === 'glob' })
  }
  return candidates
}

/**
 * Whether a normalized path points AT or INTO a denied code root.
 *
 * A TARGET spelled without a trailing slash (`path: 'src'`) is a directory
 * reference, so the slash form is tested too — `^src\\/` alone would miss it.
 * A query (`pattern`) is only denied when it is path-shaped, so grepping for
 * the literal word `src` stays allowed while `src/**` does not. Absolute paths
 * are matched on every segment-boundary suffix, so `/abs/src/x` is the same
 * source tree as `src/x`.
 */
function isDeniedReadPath(candidate: string, target: boolean): boolean {
  const matches = (value: string): boolean =>
    ZEUS_READ_DENY_PATTERNS.some((pattern) => pattern.test(value))
  const test = (value: string): boolean => {
    if (matches(value)) return true
    return target && !value.endsWith('/') && matches(`${value}/`)
  }
  if (test(candidate)) return true
  if (!candidate.startsWith('/')) return false
  const segments = candidate.split('/').filter((segment) => segment !== '')
  for (let index = 0; index < segments.length; index++) {
    if (test(segments.slice(index).join('/'))) return true
  }
  return false
}

/**
 * Zeus read guard. When the active agent is Zeus, deny read/glob/grep calls
 * that target source code, tests, or scripts — Zeus must delegate those to
 * @apollo. Allowed paths (markdown, .pantheon/, memories/) are exempt.
 *
 * Every path-bearing argument is checked, and path spellings are normalized
 * first. Both are tightenings: a call Zeus could make before with a
 * `path: 'src'` directory plus a harmless `pattern`, or with `./src/x` /
 * `src\\x`, is now denied. Symlink resolution is deliberately NOT attempted:
 * this predicate is pure and synchronous, and resolving links would require
 * filesystem I/O on every tool call.
 *
 * Non-Zeus sessions are never affected.
 *
 * @throws {Error} when Zeus attempts a denied read
 */
export function zeusReadGuard(tool: string, args: unknown, agent: string | undefined): void {
  if (agent !== 'zeus') return
  if (tool !== 'read' && tool !== 'glob' && tool !== 'grep') return

  for (const candidate of guardPathCandidates(tool, args)) {
    const normalized = normalizeGuardPath(candidate.value)
    if (normalized === '') continue
    if (!isDeniedReadPath(normalized, candidate.target)) continue
    if (ALLOWED_PATHS.some((allowed) => allowed.test(normalized))) continue
    throw new Error(`Zeus cannot read ${candidate.value} — delegate to @apollo`)
  }
}

// ─── Registry ──────────────────────────────────────────────────────────

/**
 * Read-only session registry. The plugin's `chat.params` hook registers
 * sessions whose active agent is read-only (see {@link syncReadOnlySession});
 * the `tool.execute.before` guard consults it. Process-wide singleton for
 * plugin wiring + factory for test isolation.
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

// ─── Read-Only Agent Policy ────────────────────────────────────────────

/**
 * Agents that must stay investigation-only. Mirrors
 * `background_delegation.read_only_agents` in routing.yml — the parity is
 * enforced by tests/pantheon/delegation-enforce.test.ts so the two cannot
 * drift silently.
 */
export const READ_ONLY_AGENTS: ReadonlySet<string> = new Set(['apollo', 'gaia'])

/**
 * Whether an agent identity belongs to the read-only set. Identity is never
 * inferred from prompts or tool names — only the normalized agent name counts.
 */
export function isReadOnlyAgent(
  agent: unknown,
  readOnlyAgents: ReadonlySet<string> = READ_ONLY_AGENTS,
): boolean {
  const normalized = normalizeDelegationAgent(agent)
  return normalized !== undefined && readOnlyAgents.has(normalized)
}

/**
 * Sync the read-only registry with a session's active agent. Called from the
 * plugin's `chat.params` hook: a read-only agent registers the session;
 * anything else (unknown/absent/non-read-only) unregisters it, which also
 * covers an in-session agent switch. Returns whether the session is now
 * registered.
 */
export function syncReadOnlySession(
  registry: ReadOnlySessionRegistry,
  sessionID: string,
  agent: unknown,
  readOnlyAgents: ReadonlySet<string> = READ_ONLY_AGENTS,
): boolean {
  const normalized = normalizeDelegationAgent(agent)
  if (normalized === undefined || !readOnlyAgents.has(normalized)) {
    registry.unregister(sessionID)
    return false
  }
  registry.register(sessionID, { agent: normalized })
  return true
}

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
  const prefix = input.options?.messagePrefix ?? 'pantheon delegation guard'

  return async (hook: ToolExecuteBeforeInput, output?: ToolExecuteBeforeOutput): Promise<void> => {
    const isDelegationTool = hook.tool === 'task'
    if (isDelegationTool && input.options?.isChildSession?.(hook.sessionID) === true) {
      throw new Error(
        `${prefix}: session ${hook.sessionID} is a child session — delegation tools are denied ` +
          'to prevent nested delegation',
      )
    }
    // The hook only has the session-scoped agent learned from chat.params,
    // so the runtime matrix check for native task() lives here.
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
        `(e.g. hermes, aphrodite) with native task() instead.`,
    )
  }
}
