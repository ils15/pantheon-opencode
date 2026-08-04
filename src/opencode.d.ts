/**
 * Ambient type declarations for the `opencode` module.
 *
 * The `opencode` package is not published on npm (404), and the plugin SDK
 * (`@opencode-ai/plugin`) exports `Config` without `agentsPath`/`skillsPaths`.
 * This ambient declaration extends the SDK `Config` with the two legacy path
 * fields `src/plugin.ts` still mutates (no-ops in opencode 1.18.x, which loads
 * agents/skills by directory convention), keeping the `satisfies`/annotation
 * check type-clean. The import is `import type`, erased at compile time, so
 * this declaration has zero runtime impact.
 */

declare module 'opencode' {
  import type { Config } from '@opencode-ai/plugin'

  export type PluginConfig = Config & {
    agentsPath?: string[]
    skillsPaths?: string[]
  }
}
