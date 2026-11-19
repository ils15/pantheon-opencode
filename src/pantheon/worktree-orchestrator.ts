/**
 * Native Worktree Orchestration (`worktree-orchestrator.ts`).
 *
 * Implements OpenCode 2.x `WorktreeDefinition` (`ctx.worktree.transform`)
 * enforcing Pantheon's invariant that linked git worktrees live strictly outside
 * the main repository under `<project-parent>/.pantheon-worktrees/<repo-basename>/<task>`
 * (never inside `.pantheon/` or inside the working tree).
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { resolveSharedPantheonRoot, resolveToolCwd } from './tool-context.ts'
import type { PantheonToolDef, PantheonToolResult } from './tools.ts'

const execFileAsync = promisify(execFile)
const SAFE_TASK_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

export interface HostWorktreeCreateInput {
  readonly sourceDirectory: string
  readonly directory: string
  readonly branch?: string
}

export interface HostWorktreeRemoveInput {
  readonly directory: string
  readonly force: boolean
}

export interface HostWorktreeEntry {
  readonly directory: string
  readonly type: 'root' | 'worktree'
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

function sanitizeTaskSlug(raw: string): string {
  const base = basename(raw.trim()).replace(/[^a-zA-Z0-9._-]/g, '-')
  if (!base || !SAFE_TASK_RE.test(base) || base.includes('..')) {
    return `wt-${Date.now()}`
  }
  return base
}

/**
 * Compute the canonical sibling worktree path:
 * `<project-parent>/.pantheon-worktrees/<repo-basename>/<task>`.
 */
export function resolvePantheonWorktreePath(sourceDirectory: string, taskName: string): string {
  const sourceReal = existsSync(sourceDirectory)
    ? realpathSync(resolve(sourceDirectory))
    : resolve(sourceDirectory)
  const parent = dirname(sourceReal)
  const repoName = basename(sourceReal) || 'workspace'
  const taskSlug = sanitizeTaskSlug(taskName)
  return join(parent, '.pantheon-worktrees', repoName, taskSlug)
}

function isInsideOrDotPantheon(sourceDirectory: string, candidate: string): boolean {
  const srcReal = existsSync(sourceDirectory)
    ? realpathSync(resolve(sourceDirectory))
    : resolve(sourceDirectory)
  const candResolved = resolve(candidate)
  return (
    candResolved === srcReal ||
    candResolved.startsWith(`${srcReal}/`) ||
    candResolved.includes('/.pantheon/') ||
    candResolved.includes('\\.pantheon\\')
  )
}

async function runGit(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) {
    const abortErr = new Error('Worktree operation aborted')
    abortErr.name = 'AbortError'
    throw abortErr
  }
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    signal,
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  return stdout
}

export function createPantheonWorktreeDefinition(): {
  readonly id: string
  readonly create: (
    input: HostWorktreeCreateInput,
    context: { readonly signal: AbortSignal },
  ) => Promise<{ readonly directory: string }>
  readonly remove: (
    input: HostWorktreeRemoveInput,
    context: { readonly signal: AbortSignal },
  ) => Promise<void>
  readonly list: (
    sourceDirectory: string,
    context: { readonly signal: AbortSignal },
  ) => Promise<readonly HostWorktreeEntry[]>
} {
  return {
    id: 'pantheon-worktree',
    create: async (input, context) => {
      const source = resolve(input.sourceDirectory)
      const requestedDir = input.directory ? resolve(input.directory) : ''
      const targetDir =
        !requestedDir || isInsideOrDotPantheon(source, requestedDir)
          ? resolvePantheonWorktreePath(source, basename(requestedDir) || `wt-${Date.now()}`)
          : requestedDir

      if (input.branch && (!SAFE_TASK_RE.test(input.branch) || input.branch.startsWith('-'))) {
        throw new Error(`Unsafe git ref "${input.branch}" for worktree creation`)
      }

      mkdirSync(dirname(targetDir), { recursive: true })
      const args = ['worktree', 'add', '--detach', targetDir]
      if (input.branch) args.push(input.branch)
      await runGit(source, args, context.signal)
      return { directory: existsSync(targetDir) ? realpathSync(targetDir) : targetDir }
    },
    remove: async (input, context) => {
      const dir = resolve(input.directory)
      const parent = dirname(dir)
      const args = ['worktree', 'remove']
      if (input.force) args.push('--force')
      args.push(dir)
      try {
        await runGit(existsSync(dir) ? dir : parent, args, context.signal)
      } catch (err: unknown) {
        if (isAbortError(err)) throw err
        throw err
      }
    },
    list: async (sourceDirectory, context) => {
      const source = resolve(sourceDirectory)
      const raw = await runGit(source, ['worktree', 'list', '--porcelain'], context.signal)
      const entries: HostWorktreeEntry[] = []
      const srcReal = existsSync(source) ? realpathSync(source) : source
      for (const line of raw.split(/\r?\n/)) {
        if (!line.startsWith('worktree ')) continue
        const wtPath = line.slice('worktree '.length).trim()
        if (!wtPath) continue
        const wtReal = existsSync(wtPath) ? realpathSync(wtPath) : wtPath
        entries.push({
          directory: wtReal,
          type: wtReal === srcReal ? 'root' : 'worktree',
        })
      }
      return entries
    },
  }
}

function jsonResult(payload: unknown): PantheonToolResult {
  return { output: JSON.stringify(payload) }
}

/** Expose native worktree isolation (`create`, `list`, `remove`) directly as an agent tool. */
export function createWorktreeTool(fallbackDir?: string): PantheonToolDef {
  const driver = createPantheonWorktreeDefinition()
  return {
    name: 'pantheon_worktree',
    description:
      'Manage isolated git worktrees strictly outside the main repository under ' +
      '<project-parent>/.pantheon-worktrees/<repo>/<task> (actions: create | list | remove).',
    input: {
      type: 'object',
      additionalProperties: false,
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'remove'] },
        task: { type: 'string', description: 'Short task slug for sibling worktree folder' },
        branch: { type: 'string', description: 'Optional existing git branch/ref to check out' },
        directory: { type: 'string', description: 'Target worktree directory (for remove)' },
        force: { type: 'boolean', description: 'Force worktree removal even with dirty files' },
      },
    },
    output: {},
    execute: async (input, context) => {
      try {
        const action = typeof input.action === 'string' ? input.action : 'list'
        const workspaceDir = resolveSharedPantheonRoot(resolveToolCwd(context, fallbackDir))
        const ac = new AbortController()
        if (action === 'list') {
          const entries = await driver.list(workspaceDir, { signal: ac.signal })
          return jsonResult({ ok: true, entries })
        }
        if (action === 'create') {
          const task =
            typeof input.task === 'string' && input.task.trim()
              ? input.task.trim()
              : `wt-${Date.now()}`
          const targetDir = resolvePantheonWorktreePath(workspaceDir, task)
          const res = await driver.create(
            {
              sourceDirectory: workspaceDir,
              directory: targetDir,
              ...(typeof input.branch === 'string' && input.branch.trim()
                ? { branch: input.branch.trim() }
                : {}),
            },
            { signal: ac.signal },
          )
          return jsonResult({ ok: true, action: 'create', directory: res.directory })
        }
        if (action === 'remove') {
          const target =
            typeof input.directory === 'string' && input.directory.trim()
              ? input.directory.trim()
              : typeof input.task === 'string' && input.task.trim()
                ? resolvePantheonWorktreePath(workspaceDir, input.task.trim())
                : ''
          if (!target) return jsonResult({ ok: false, error: 'directory or task is required' })
          await driver.remove(
            { directory: target, force: input.force === true },
            { signal: ac.signal },
          )
          return jsonResult({ ok: true, action: 'remove', directory: target })
        }
        return jsonResult({ ok: false, error: `Unsupported action: ${action}` })
      } catch (err: unknown) {
        return jsonResult({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    },
  }
}
