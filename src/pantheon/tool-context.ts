/**
 * Tool Context — the structural view of the context opencode passes to a
 * tool's `execute()`.
 *
 * Extracted from `delegation.ts` (Fase 2 of the delegate removal) so the
 * surviving structural tools (cost-command, model-command, goal-loop) no
 * longer depend on the delegation module. Pure type — zero runtime code.
 *
 * @module tool-context
 */

/** Structural view of the tool context opencode passes to execute(). */
export interface ToolContextLike {
  sessionID: string
  directory?: string
  worktree?: string
  /**
   * The OpenCode SDK's ToolContext declares this as required. It remains
   * optional here because the structural test/embedding surface can be
   * supplied by older hosts; enforcement must skip when it is absent.
   */
  agent?: string
}

/**
 * Resolves the effective working directory for tool operations.
 *
 * Checks in order of precedence:
 * 1. ctx.directory (explicit workspace directory on tool context)
 * 2. ctx.worktree (worktree directory if isolated)
 * 3. fallbackDir (injected location directory from host at plugin setup)
 * 4. process.cwd() (fallback process directory)
 */
export function resolveToolCwd(context: unknown, fallbackDir?: string): string {
  const ctx = (context ?? {}) as Partial<ToolContextLike>
  if (typeof ctx.directory === 'string' && ctx.directory.trim().length > 0) {
    return ctx.directory
  }
  if (typeof ctx.worktree === 'string' && ctx.worktree.trim().length > 0) {
    return ctx.worktree
  }
  if (typeof fallbackDir === 'string' && fallbackDir.trim().length > 0) {
    return fallbackDir
  }
  return process.cwd()
}
