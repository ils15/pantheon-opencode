/**
 * Ambient type declarations for the `opencode` module.
 *
 * The `opencode` package is not published on npm (404), and the plugin SDK
 * (`@opencode-ai/plugin`) exports `Config` without `agentsPath`/`skillsPaths`.
 * This ambient declaration types only what `src/plugin.ts` actually uses — the
 * `PluginConfig` interface — so the existing `satisfies PluginConfig` check
 * type-checks. The import is `import type`, erased at compile time, so this
 * declaration has zero runtime impact.
 */

declare module 'opencode' {
  export interface PluginConfig {
    name: string
    version: string
    description?: string
    agentsPath?: string[]
    skillsPaths?: string[]
    hooks: {
      config?: (config: PluginConfig) => Promise<PluginConfig>
    }
  }
}
