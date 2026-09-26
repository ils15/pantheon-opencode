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
 * The `execute.before` callback also throws `CANARY_BLOCKED_READ` for the
 * `read` tool. That is a mutation with a visible consequence: a real prompt
 * that reads a file must fail with that error. A silent no-op would let the
 * read succeed, so the test is green/red with no log inspection.
 */

import { appendFileSync } from 'node:fs'
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
      const tool = (event as { tool?: string }).tool
      mark('tool.hook:execute.before', tool)
      if (tool === 'read') throw new Error(CANARY_BLOCKED_READ)
    })

    await ctx.tool.hook('execute.after', (event: unknown) =>
      mark('tool.hook:execute.after', (event as { tool?: string }).tool),
    )

    await ctx.permission.hook('evaluate', (event: unknown) =>
      mark('permission.hook:evaluate', (event as { action?: string }).action),
    )

    await ctx.session.hook('compaction', () => mark('session.hook:compaction'))

    // NEGATIVE CONTROL — never fires on 2.0.16. If this line ever appears in
    // the proof file, the negative control is broken and the test must fail.
    await ctx.session.hook(CANARY_NEGATIVE_HOOK, () => mark('session.hook:compacting'))

    return () => mark('cleanup')
  },
}
