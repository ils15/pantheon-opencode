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

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

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

/**
 * Resolve the shared repository root for `.pantheon/memory`, checkpoints, and
 * goals when operating inside a linked git worktree (`.git` is a pointer file
 * with `gitdir:` + `commondir`), falling back to `cwd` unchanged for regular
 * checkouts and non-git directories.
 */
export function resolveSharedPantheonRoot(cwd: string): string {
  if (process.env.PANTHEON_ISOLATE_WORKTREE_MEMORY === '1') return cwd
  try {
    let cur = resolve(cwd)
    for (let depth = 0; depth < 32; depth += 1) {
      const dotGit = join(cur, '.git')
      if (existsSync(dotGit)) {
        const st = statSync(dotGit)
        if (st.isDirectory()) return cwd
        if (st.isFile()) {
          const content = readFileSync(dotGit, 'utf8')
          const match = /^gitdir:\s*(.+)$/m.exec(content)
          if (!match?.[1]) return cwd
          const gitDir = resolve(cur, match[1].trim())
          const commonFile = join(gitDir, 'commondir')
          let commonGitDir: string | null = null
          if (existsSync(commonFile)) {
            commonGitDir = resolve(gitDir, readFileSync(commonFile, 'utf8').trim())
          } else if (basename(dirname(gitDir)) === 'worktrees') {
            commonGitDir = dirname(dirname(gitDir))
          }
          if (commonGitDir && basename(commonGitDir) === '.git') {
            const mainRoot = dirname(commonGitDir)
            if (existsSync(mainRoot)) return mainRoot
          }
          return cwd
        }
      }
      const parent = dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  } catch {
    /* fail-open: fall back to cwd */
  }
  return cwd
}

export function resolveMemoryStoreCwd(context: unknown, fallbackDir?: string): string {
  return resolveSharedPantheonRoot(resolveToolCwd(context, fallbackDir))
}
