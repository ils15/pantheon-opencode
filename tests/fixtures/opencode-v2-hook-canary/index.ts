/**
 * pantheon-hook-canary — an observable-proof V2 plugin for hook dispatch.
 *
 * WHY THIS EXISTS
 * ---------------
 * The V2 hook registry accepts ANY string as a hook name: `register(domain,
 * name, cb)` keys on `${domain}.${String(name)}` and never validates it. A
 * wrong name is therefore a silent no-op — no error, no warning, no log. The
 * shipped `src/plugin-v2.ts` registers `session.hook('compacting', ...)` while
 * the real 2.0.16 name is `'compaction'`, and nothing in the repo caught it,
 * because every existing test hand-builds a mock context and never dispatches
 * a real hook.
 *
 * This plugin turns "did the callback fire?" into an external artifact. Each
 * callback appends a line to a proof file (env `PANTHEON_HOOK_CANARY_PROOF`,
 * else `canary-proof.log` beside this module). A test that reads the proof file
 * therefore proves three things a shape/mock test cannot:
 *   1. the name was accepted into the registry,
 *   2. the registry dispatches on that exact name,
 *   3. the host actually fired it.
 *
 * COVERAGE
 * --------
 *   correct  session.hook('prompt')          — message admission
 *   correct  session.hook('context')         — system-context injection
 *   correct  session.hook('compaction')      — compaction
 *   correct  tool.hook('execute.before')     — pre-execution guard
 *   correct  tool.hook('execute.after')      — post-execution augment
 *   correct  permission.hook('evaluate')     — permission decision
 *   NEGATIVE session.hook('compacting')      — the exact wrong string that
 *                                              ships today; MUST NEVER fire.
 *
 * The `execute.before` callback throws `CANARY_BLOCKED_READ` only when the
 * `read` tool targets `PANTHEON_HOOK_CANARY_BLOCKED_READ_PATH`; other read
 * targets remain allowed so the test can prove a successful tool lifecycle.
 * This synthetic fixture guard proves host hook dispatch only; it does not
 * prove Pantheon's execute.before security enforcement.
 */

import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HOOK_CANARY_ID = 'pantheon-hook-canary'

/** Error thrown by `execute.before` when the `read` tool is attempted. */
export const CANARY_BLOCKED_READ = 'CANARY_BLOCKED_READ'

/** The wrong hook name the shipped plugin uses (real name: `compaction`). */
export const CANARY_NEGATIVE_HOOK = 'compacting'

const proofPath =
  process.env.PANTHEON_HOOK_CANARY_PROOF ??
  fileURLToPath(new URL('./canary-proof.log', import.meta.url))

/** Append one observable proof line. Never throws into the host. */
function mark(label: string, detail?: string): void {
  try {
    appendFileSync(proofPath, `${label}${detail === undefined ? '' : ` ${detail}`}\n`)
  } catch {
    // Proof is best-effort: never let instrumentation crash the host.
  }
}

function markToolHook(label: string, event: unknown): void {
  const hook = event as {
    tool?: unknown
    id?: unknown
    callID?: unknown
    toolCallID?: unknown
    sessionID?: unknown
    messageID?: unknown
    status?: unknown
    input?: unknown
  }
  // OpenCode v2.0.18's ToolHooks call ID field is `id`; serialize it as
  // `callID` to correlate with the session's completed tool-call part.
  const callID = hook.id ?? hook.callID ?? hook.toolCallID
  const input = hook.input as
    | { filePath?: unknown; filepath?: unknown; path?: unknown; file?: unknown }
    | undefined
  const filePath = input?.filePath ?? input?.filepath ?? input?.path ?? input?.file
  mark(
    label,
    JSON.stringify({
      tool: hook.tool,
      ...(callID === undefined ? {} : { callID }),
      ...(typeof filePath === 'string' ? { filePath } : {}),
      sessionID: hook.sessionID,
      messageID: hook.messageID,
      status: hook.status,
    }),
  )
}

function markPermissionHook(event: unknown): void {
  // PermissionEvaluation exposes action/sessionID, but no tool-call ID.
  const hook = event as { action?: unknown; sessionID?: unknown }
  mark('permission.hook:evaluate', JSON.stringify({ action: hook.action, sessionID: hook.sessionID }))
}

interface CanaryContext {
  session: { hook: (name: string, cb: (event: unknown) => void | Promise<void>) => Promise<unknown> }
  tool: { hook: (name: string, cb: (event: unknown) => void | Promise<void>) => Promise<unknown> }
  permission: {
    hook: (name: string, cb: (event: unknown) => void | Promise<void>) => Promise<unknown>
  }
}

export default {
  id: HOOK_CANARY_ID,
  async setup(ctx: CanaryContext) {
    mark('setup')

    await ctx.session.hook('prompt', () => mark('session.hook:prompt'))

    await ctx.session.hook('context', (event: unknown) => {
      mark('session.hook:context')
      // In-place mutation is the V2 contract; the payload is `{ system: SystemPart[] }`.
      const system = (event as { system?: Array<{ type: string; text: string }> }).system
      if (Array.isArray(system)) system.push({ type: 'text', text: 'CANARY-CONTEXT' })
    })

    await ctx.tool.hook('execute.before', (event: unknown) => {
      const hook = event as { tool?: string; input?: unknown }
      const tool = hook.tool
      markToolHook('tool.hook:execute.before', event)
      const input = hook.input as
        | { filePath?: unknown; filepath?: unknown; path?: unknown; file?: unknown }
        | undefined
      const requestedPath = input?.filePath ?? input?.filepath ?? input?.path ?? input?.file
      const blockedPath = process.env.PANTHEON_HOOK_CANARY_BLOCKED_READ_PATH
      if (
        tool === 'read' &&
        blockedPath &&
        typeof requestedPath === 'string' &&
        resolve(process.cwd(), requestedPath) === resolve(blockedPath)
      ) {
        throw new Error(CANARY_BLOCKED_READ)
      }
    })

    await ctx.tool.hook('execute.after', (event: unknown) =>
      markToolHook('tool.hook:execute.after', event),
    )

    await ctx.permission.hook('evaluate', (event: unknown) => markPermissionHook(event))

    await ctx.session.hook('compaction', () => mark('session.hook:compaction'))

    // NEGATIVE CONTROL — never fires on 2.0.16. If this line ever appears in
    // the proof file, the negative control is broken and the test must fail.
    await ctx.session.hook(CANARY_NEGATIVE_HOOK, () => mark('session.hook:compacting'))

    return () => mark('cleanup')
  },
}
