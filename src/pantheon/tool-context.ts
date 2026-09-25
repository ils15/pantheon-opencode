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
