/**
 * Type declarations for presets.mjs (model routing presets).
 * Consumed by src/plugin.ts via `import ... from './pantheon/presets.mjs'`.
 */

export type Effort = 'low' | 'medium' | 'high'

export declare const EFFORT_RANK: Record<Effort, number>

export interface CapabilityEntry {
  prefix: string
  maxEffort: Effort | null
  stripEffort: boolean
  vision: boolean
}

export declare const CAPABILITY_TABLE: CapabilityEntry[]

export interface PresetAgentSpec {
  model: string
  reasoning_effort?: Effort
  fallback_models?: string[]
  [key: string]: unknown
}

export interface PresetProviderDef {
  baseURL: string
  apiKeyEnv: string
  [key: string]: unknown
}

export interface PresetDef {
  description?: string
  providers?: Record<string, PresetProviderDef>
  agents?: Record<string, PresetAgentSpec>
  [key: string]: unknown
}

export interface ResolvedPreset {
  name: string
  source: 'env' | 'file'
  agents: Record<string, PresetAgentSpec>
  providers: Record<string, PresetProviderDef>
  overrides: unknown
  vision: { model: string; reasoning_effort?: string } | null
}

export interface PresetFileOverrides {
  agents?: Record<string, PresetAgentSpec & { variant?: Effort }>
  providers?: Record<string, PresetProviderDef>
}

export interface ActivePresetFile {
  version: number
  preset: string
  source: string
  updated_at: string
  overrides?: PresetFileOverrides
}

export interface ResolveOptions {
  env?: Record<string, string | undefined>
  candidates?: Array<string | null | undefined>
  routingPath?: string
  logger?: {
    warn?: (msg: string) => void
    log?: (msg: string) => void
    error?: (msg: string) => void
  }
}

export declare function capabilityEntry(model: string): CapabilityEntry

export declare function normalizeCapability(
  model: string,
  requestedEffort?: Effort | null,
): { variant: Effort | null; clamped: boolean }

export declare function hasVision(model: string): boolean

export declare const GATEWAY_BROKEN_VISION_MODELS: Set<string>

export declare function visionBrokenOnGateway(model: string, providerID: string): boolean

export declare function loadPresetDefs(routingPath?: string): Record<string, PresetDef>

export declare function resolveActivePreset(options?: ResolveOptions): ResolvedPreset | null

export declare function applyActivePresetToConfig<C extends object>(
  config: C,
  options?: ResolveOptions & { env?: Record<string, string | undefined> },
): ResolvedPreset | null

export interface ProviderKeyOptions {
  env?: Record<string, string | undefined>
  routingPath?: string
}

/** Name of the env var whose value is missing for a provider, or undefined when usable. */
export declare function missingProviderKeyEnv(
  providerID: string,
  options?: ProviderKeyOptions,
): string | undefined

/** Whether the provider's API key is configured (apiKeyEnv set + non-empty, or no gate). */
export declare function providerKeyConfigured(
  providerID: string,
  options?: ProviderKeyOptions,
): boolean

export interface MissingApiKeyError extends Error {
  code: 'PANTHEON_MISSING_API_KEY'
  envVar: string
}

export declare function applyPreset<C extends object>(
  config: C,
  resolved: ResolvedPreset | null,
  options?: { env?: Record<string, string | undefined> },
): C

export declare function validatePresetDefs(
  presets: Record<string, PresetDef>,
  options?: { agents?: string[] },
): { ok: boolean; errors: string[]; warnings: string[] }
