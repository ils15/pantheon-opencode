/**
 * Shared tool-context types and path guards used by the preserved tool
 * modules (cost-command, goal-loop, model-command, goal-store).
 *
 * These were previously exported from the removed delegation modules; they
 * are hoisted here so the surviving subsystems keep a single source of truth
 * without depending on the deleted delegate machinery.
 *
 * @module tool-context
 */

/**
 * The structural tool-execution context a tool's `execute` receives. Mirrors
 * the OpenCode SDK's ToolContext but keeps every field optional so the
 * structural test/embedding surface can be supplied by older hosts.
 */
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
 * Path-traversal guard for session IDs embedded in file paths. Throws on
 * `..`, `/`, `\`. Used by goal-store to keep goal files inside their dir.
 */
export function assertSafeParentSessionID(parentSessionID: string): void {
  if (
    parentSessionID.includes('..') ||
    parentSessionID.includes('/') ||
    parentSessionID.includes('\\')
  ) {
    throw new Error(`Invalid parentSessionID: ${parentSessionID}`)
  }
}
