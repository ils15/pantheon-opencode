#!/usr/bin/env node
/**
 * presets.mjs — model routing presets for Pantheon OpenCode
 *
 * Pure resolver/validator module (NO writes). Provides:
 *  - capability table + normalizeCapability()  (model → variant/clamp)
 *  - loadPresetDefs()                           (routing.yml presets: block)
 *  - resolveActivePreset()                      (env PANTHEON_MODEL_PRESET > file)
 *  - applyPreset()                              (mutate opencode config)
 *  - validatePresetDefs()                       (schema checks for CI)
 *
 * The active-preset.json file format (version 1):
 *   {
 *     "version": 1,
 *     "preset": "go-deepseek",
 *     "source": "cli",
 *     "updated_at": "2026-08-02T12:00:00.000Z",
 *     "overrides": {
 *       "agents":    { "hermes": { "model": "...", "variant": "high" } },
 *       "providers": { "deepseek": { "baseURL": "...", "apiKeyEnv": "..." } }
 *     }
 *   }
 * Override agent `variant` is mapped to `reasoning_effort` during merge.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

export const EFFORT_RANK = { low: 0, medium: 1, high: 2 }

export const CAPABILITY_TABLE = [
  { prefix: 'deepseek/deepseek-v4-pro', maxEffort: 'high', stripEffort: false },
  // prefix also covers -free suffix (e.g. deepseek/deepseek-v4-flash-free)
  { prefix: 'deepseek/deepseek-v4-flash', maxEffort: 'medium', stripEffort: false },
  { prefix: 'claude', maxEffort: null, stripEffort: true },
  { prefix: 'o1', maxEffort: 'high', stripEffort: false },
  { prefix: 'o3', maxEffort: 'high', stripEffort: false },
  { prefix: 'o4', maxEffort: 'high', stripEffort: false },
  { prefix: 'mimo/', maxEffort: 'low', stripEffort: false },
]

/**
 * Find the capability entry for a model ID.
 * Matches when the model starts with the prefix OR the segment after the
 * last '/' starts with the prefix. Longest matching prefix wins.
 *
 * @param {string} model model ID (e.g. "deepseek/deepseek-v4-flash")
 * @returns {{prefix: string, maxEffort: 'low'|'medium'|'high'|null, stripEffort: boolean}}
 */
export function capabilityEntry(model) {
  const matches = CAPABILITY_TABLE.filter((entry) => {
    if (model.startsWith(entry.prefix)) return true
    const segment = model.slice(model.lastIndexOf('/') + 1)
    return segment.startsWith(entry.prefix)
  })
  if (matches.length === 0) {
    throw new Error(`presets: no capability entry for model ${model}`)
  }
  matches.sort((a, b) => b.prefix.length - a.prefix.length)
  return matches[0]
}

/**
 * Normalize a requested reasoning effort to a model variant, clamping to the
 * model's capability ceiling.
 *
 * - stripEffort models (claude) → variant null (no variant key).
 * - undefined/null requested → entry maxEffort (or null when stripping).
 * - rank(requested) > rank(maxEffort) → clamp to maxEffort.
 *
 * @param {string} model
 * @param {'low'|'medium'|'high'|null|undefined} [requestedEffort]
 * @returns {{variant: 'low'|'medium'|'high'|null, clamped: boolean}}
 */
export function normalizeCapability(model, requestedEffort) {
  const entry = capabilityEntry(model)
  if (entry.stripEffort) {
    return { variant: null, clamped: requestedEffort != null }
  }
  const maxEffort = entry.maxEffort
  if (requestedEffort === undefined || requestedEffort === null) {
    return { variant: maxEffort, clamped: false }
  }
  if (EFFORT_RANK[requestedEffort] > EFFORT_RANK[maxEffort]) {
    return { variant: maxEffort, clamped: true }
  }
  return { variant: requestedEffort, clamped: false }
}

/**
 * Load preset definitions from routing.yml (top-level `presets:` key).
 *
 * @param {string} [routingPath] defaults to src/routing.yml
 * @returns {Record<string, object>} preset name → definition ({} when absent)
 */
export function loadPresetDefs(routingPath) {
  const path = routingPath ?? fileURLToPath(new URL('../routing.yml', import.meta.url))
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`presets: failed to load routing.yml: ${path} — ${err.message}`)
  }
  let routing
  try {
    routing = yaml.load(raw)
  } catch (err) {
    throw new Error(`presets: failed to load routing.yml: ${err.message}`)
  }
  return (routing && typeof routing === 'object' && routing.presets) || {}
}

/**
 * Resolve the active preset: env PANTHEON_MODEL_PRESET > first existing
 * candidate file > null. "none" disables. Unknown names warn and return null
 * WITHOUT falling through to lower-priority sources.
 *
 * @param {object} [opts]
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {string[]} [opts.candidates]
 * @param {string} [opts.routingPath]
 * @param {{warn?: Function, log?: Function, error?: Function}} [opts.logger]
 * @returns {{name: string, source: 'env'|'file', agents: object, providers: object, overrides: object|null}|null}
 */
export function resolveActivePreset({
  env = process.env,
  candidates = [join(process.cwd(), '.pantheon', 'active-preset.json')],
  routingPath,
  logger = console,
} = {}) {
  const defs = loadPresetDefs(routingPath)

  const envName = env.PANTHEON_MODEL_PRESET
  if (envName !== undefined && envName !== '') {
    if (envName === 'none') return null
    const def = defs[envName]
    if (!def) {
      logger.warn?.(
        `presets: unknown preset "${envName}" (PANTHEON_MODEL_PRESET). Available: ${Object.keys(defs).join(', ') || 'none'}`,
      )
      return null
    }
    return buildResolved(defs, envName, 'env', null)
  }

  for (const candidate of candidates) {
    if (!candidate) continue
    let exists
    try {
      exists = readFileSync(candidate)
    } catch {
      continue // candidate does not exist
    }
    let raw
    try {
      raw = JSON.parse(exists.toString('utf8'))
    } catch {
      logger.warn?.(`presets: malformed active preset file: ${candidate}`)
      return null
    }
    const name = raw && typeof raw === 'object' ? raw.preset : undefined
    if (!name || name === 'none') return null
    const def = defs[name]
    if (!def) {
      logger.warn?.(
        `presets: unknown preset "${name}" in ${candidate}. Available: ${Object.keys(defs).join(', ') || 'none'}`,
      )
      return null
    }
    return buildResolved(defs, name, 'file', raw)
  }

  return null
}

/**
 * Build the resolved preset by merging preset defs with file overrides.
 * Overrides win per-agent / per-provider; override `variant` → reasoning_effort.
 *
 * @param {Record<string, object>} defs
 * @param {string} name
 * @param {'env'|'file'} source
 * @param {object|null} rawFile
 */
function buildResolved(defs, name, source, rawFile) {
  const def = defs[name] || {}
  const overrides = rawFile && typeof rawFile === 'object' ? rawFile.overrides : null
  const agentOverrides = overrides?.agents ?? {}
  const providerOverrides = overrides?.providers ?? {}

  const agents = {}
  for (const [agent, spec] of Object.entries(def.agents ?? {})) {
    let merged = { ...spec }
    const override = agentOverrides[agent]
    if (override && typeof override === 'object') {
      merged = { ...merged, ...override }
      if (override.variant !== undefined) {
        merged.reasoning_effort = override.variant
      }
    }
    agents[agent] = merged
  }

  const providers = { ...(def.providers ?? {}) }
  for (const [id, provider] of Object.entries(providerOverrides)) {
    if (provider && typeof provider === 'object') {
      providers[id] = { ...(providers[id] ?? {}), ...provider }
    }
  }

  return { name, source, agents, providers, overrides }
}

/**
 * Apply a resolved preset to an opencode config object (mutates `config`).
 * - Providers: config.provider[id].options.baseURL + apiKey (env-gated).
 * - Agents:    config.agent[agent].model / .variant / .fallback_models.
 * Only agents listed in the preset are touched (partial semantics).
 *
 * @throws {Error} code=PANTHEON_MISSING_API_KEY, envVar set, when a provider
 *   key env var is unset/empty.
 */
export function applyPreset(config, resolved, { env = process.env } = {}) {
  if (!resolved) return config

  for (const [id, provider] of Object.entries(resolved.providers ?? {})) {
    const apiKey = env[provider.apiKeyEnv]
    if (!apiKey) {
      const err = new Error(`presets: provider "${id}" requires env var ${provider.apiKeyEnv}`)
      err.code = 'PANTHEON_MISSING_API_KEY'
      err.envVar = provider.apiKeyEnv
      throw err
    }
    config.provider ??= {}
    config.provider[id] ??= {}
    config.provider[id].options ??= {}
    config.provider[id].options.baseURL = provider.baseURL
    config.provider[id].options.apiKey = apiKey
  }

  for (const [agent, spec] of Object.entries(resolved.agents ?? {})) {
    config.agent ??= {}
    config.agent[agent] ??= {}
    config.agent[agent].model = spec.model
    const { variant } = normalizeCapability(spec.model, spec.reasoning_effort)
    if (variant === null) {
      delete config.agent[agent].variant
    } else {
      config.agent[agent].variant = variant
    }
    if (spec.fallback_models !== undefined) {
      config.agent[agent].fallback_models = [...spec.fallback_models]
    }
  }

  return config
}

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/.+$/

/**
 * Validate preset definitions against the schema.
 *
 * @param {Record<string, object>} presets
 * @param {{agents?: string[]}} [opts] known agent names (routing minus legacy)
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validatePresetDefs(presets, { agents } = {}) {
  const errors = []
  const warnings = []
  const knownAgents = agents ? new Set(agents) : null

  for (const [name, def] of Object.entries(presets)) {
    if (name === 'none') {
      errors.push(`preset "${name}": name "none" is reserved`)
      continue
    }
    if (!def || typeof def !== 'object' || Array.isArray(def)) {
      errors.push(`preset "${name}": definition must be a plain object`)
      continue
    }

    if (typeof def.description === 'string' && !/\b(19|20)\d{2}\b/.test(def.description)) {
      warnings.push(`preset "${name}": description missing a 4-digit year`)
    }

    for (const [id, provider] of Object.entries(def.providers ?? {})) {
      if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
        errors.push(`preset "${name}": provider "${id}" must be an object`)
        continue
      }
      if (!provider.baseURL) {
        errors.push(`preset "${name}": provider "${id}" missing baseURL`)
      } else if (!/^https?:\/\//.test(provider.baseURL)) {
        errors.push(`preset "${name}": provider "${id}" baseURL must start with http(s)://`)
      }
      if (typeof provider.apiKeyEnv !== 'string' || provider.apiKeyEnv.length === 0) {
        errors.push(`preset "${name}": provider "${id}" apiKeyEnv must be a non-empty string`)
      } else if (!provider.apiKeyEnv.startsWith('PANTHEON_')) {
        warnings.push(`preset "${name}": provider "${id}" apiKeyEnv should start with PANTHEON_`)
      }
    }

    for (const [agent, spec] of Object.entries(def.agents ?? {})) {
      if (knownAgents && !knownAgents.has(agent)) {
        errors.push(`preset "${name}": unknown agent "${agent}"`)
      }
      if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
        errors.push(`preset "${name}": agent "${agent}" spec must be an object`)
        continue
      }
      if (typeof spec.model !== 'string' || !MODEL_RE.test(spec.model)) {
        errors.push(
          `preset "${name}": agent "${agent}" model must match provider/model (got "${spec.model}")`,
        )
      } else {
        try {
          capabilityEntry(spec.model)
        } catch (err) {
          errors.push(`preset "${name}": agent "${agent}" ${err.message}`)
        }
      }
      if (
        spec.reasoning_effort !== undefined &&
        !Object.hasOwn(EFFORT_RANK, spec.reasoning_effort)
      ) {
        errors.push(
          `preset "${name}": agent "${agent}" reasoning_effort must be one of low, medium, high`,
        )
      }
      if (spec.fallback_models !== undefined) {
        if (
          !Array.isArray(spec.fallback_models) ||
          spec.fallback_models.some((m) => typeof m !== 'string')
        ) {
          errors.push(
            `preset "${name}": agent "${agent}" fallback_models must be an array of strings`,
          )
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}
