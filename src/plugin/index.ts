/**
 * Pantheon V2 unified plugin entry point.
 *
 * When loaded in OpenCode TUI mode (where context.ui.slot exists),
 * it mounts the Pantheon TUI sidebar, status and dispatch views.
 * When loaded in OpenCode Server mode, it registers Pantheon tools,
 * hooks, and permissions.
 *
 * @module plugin/index
 */

import serverPlugin from '../plugin.ts'

export * from '../plugin.ts'

type MaybePlugin = {
  setup?: (context: unknown) => unknown
}

export async function setupUnified(context: unknown): Promise<unknown> {
  const ctx = context as Record<string, unknown> | undefined
  if (ctx?.ui && typeof (ctx.ui as { slot?: unknown }).slot === 'function') {
    try {
      const tuiPath = '../plugins/tui/dist/tui.js'
      const tuiMod = await import(tuiPath)
      const tui = (tuiMod.default || tuiMod) as MaybePlugin | ((c: unknown) => unknown)
      if (typeof tui === 'function') return tui(context)
      if (typeof tui?.setup === 'function') return tui.setup(context)
    } catch {
      /* TUI bundle unavailable or failed to load */
    }
  }
  const srv = serverPlugin as MaybePlugin | ((c: unknown) => unknown)
  if (typeof srv === 'function') return srv(context)
  if (typeof srv?.setup === 'function') {
    return srv.setup(context)
  }
  return undefined
}

export const unifiedPlugin = Object.assign(
  async function pantheonPlugin(context: unknown) {
    return setupUnified(context)
  },
  {
    id: 'pantheon-opencode',
    setup: setupUnified,
  },
)

export default unifiedPlugin
