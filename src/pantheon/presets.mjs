#!/usr/bin/env node
/**
 * presets.mjs — model routing presets for Pantheon OpenCode
 *
 * Pure resolver/validator module (NO writes). Provides:
 *  - capability table + normalizeCapability()  (model → variant/clamp)
 *  - hasVision()                               (model → image-input support)
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

/**
 * Capability table: reasoning-effort ceiling + image-input (vision) support.
 *
 * `vision` flags mark models that accept image input. Verified 2026-08-27:
 * deepseek-v4-pro high, deepseek-v4-flash medium text-only; mimo-v2.5 /
 * mimo-v2.5-free multimodal low; qwen3.6-plus-free / qwen3.8-max text-only;
 * glm-5.3-flash high text-only; kimi-k2.7-code high, kimi-k3 medium text-only;
 * nemotron-3-super-free high text-only; big-pickle medium text-only;
 * minimax-m3 multimodal high; gpt-5.6 family native image support.
 * Removed: minimax-m2.5, kimi-k2.5, glm-5.1/5.2, ox-alpha (deprecated 2026).
 */
export const CAPABILITY_TABLE = [
  { prefix: 'deepseek/deepseek-v4-pro', maxEffort: 'high', stripEffort: false, vision: false },
  // prefix also covers -free suffix (e.g. deepseek/deepseek-v4-flash-free)
  { prefix: 'deepseek/deepseek-v4-flash', maxEffort: 'medium', stripEffort: false, vision: false },
  { prefix: 'claude', maxEffort: null, stripEffort: true, vision: true },
  // gpt-5.6 family: longest-prefix match picks luna-fast over generic gpt-5.6
  { prefix: 'gpt-5.6-sol', maxEffort: 'high', stripEffort: false, vision: true },
  { prefix: 'gpt-5.6-terra', maxEffort: 'medium', stripEffort: false, vision: true },
  { prefix: 'gpt-5.6-luna-fast', maxEffort: 'low', stripEffort: false, vision: true },
  { prefix: 'gpt-5.6-luna', maxEffort: 'low', stripEffort: false, vision: true },
  { prefix: 'gpt-5.6', maxEffort: 'medium', stripEffort: false, vision: true },
  // o-series are multimodal (models.dev input: text+image+pdf)
  { prefix: 'o1', maxEffort: 'high', stripEffort: false, vision: true },
  { prefix: 'o3', maxEffort: 'high', stripEffort: false, vision: true },
  { prefix: 'o4', maxEffort: 'high', stripEffort: false, vision: true },
  { prefix: 'mimo/', maxEffort: 'low', stripEffort: false, vision: true },
  // opencode/mimo-v2.5 fallback (OpenCode Zen): bare segment — the 'mimo/'
  // entry above matches 'mimo/v2.5' (full-string) but NOT 'mimo-v2.5'
  // (segment 'mimo-v2.5' has no slash, so 'mimo/' prefix cannot match).
  { prefix: 'mimo-v2.5', maxEffort: 'low', stripEffort: false, vision: true },
  // mimo-v2.5-pro is text-only per models.dev api.json (2026-08-27).
  { prefix: 'mimo-v2.5-pro', maxEffort: 'low', stripEffort: false, vision: false },
  // Go subscription specific — bare segment prefixes so opencode-go/<model> IDs match
  { prefix: 'glm-5.3-flash', maxEffort: 'high', stripEffort: false, vision: false },
  { prefix: 'kimi-k2.7-code', maxEffort: 'high', stripEffort: false, vision: false },
  { prefix: 'kimi-k3', maxEffort: 'medium', stripEffort: false, vision: false },
  { prefix: 'qwen3.8-max', maxEffort: 'high', stripEffort: false, vision: false },
  { prefix: 'qwen3.6-plus-free', maxEffort: 'medium', stripEffort: false, vision: false },
  // Legacy qwen3.7 retained for capability checks (not used in new presets)
  { prefix: 'qwen3.7-max', maxEffort: 'high', stripEffort: false, vision: false },
  { prefix: 'qwen3.7-plus', maxEffort: 'medium', stripEffort: false, vision: true },
  { prefix: 'minimax-m2.7', maxEffort: 'medium', stripEffort: false, vision: false },
  { prefix: 'minimax-m3', maxEffort: 'high', stripEffort: false, vision: true },
  // BARE prefix — needed for opencode-go/deepseek-v4-flash (segment match);
  // provider-scoped deepseek/deepseek-v4-flash entry still wins by length
  // for deepseek/ models. Covers -free suffix too.
  { prefix: 'deepseek-v4-flash', maxEffort: 'medium', stripEffort: false, vision: false },
  // BARE prefix — needed for opencode-go/deepseek-v4-pro (segment match);
  // provider-scoped deepseek/deepseek-v4-pro entry still wins by length.
  { prefix: 'deepseek-v4-pro', maxEffort: 'high', stripEffort: false, vision: false },
  // opencode (Zen free tier) — bare segment prefixes for opencode/<model>.
  // big-pickle / nemotron-3-super-free / north-mini-code-free verified
  // text-only via models.dev (2026-08-27).
  { prefix: 'big-pickle', maxEffort: 'medium', stripEffort: false, vision: false },
  { prefix: 'nemotron-3-super-free', maxEffort: 'high', stripEffort: false, vision: false },
  { prefix: 'nemotron-3-ultra-free', maxEffort: 'high', stripEffort: false, vision: false },
  { prefix: 'north-mini-code-free', maxEffort: 'high', stripEffort: false, vision: false },
]

/**
 * Find the capability entry for a model ID.
 * Matches when the model starts with the prefix OR the segment after the
 * last '/' starts with the prefix. Longest matching prefix wins.
 *
 * @param {string} model model ID (e.g. "deepseek/deepseek-v4-flash")
 * @returns {{prefix: string, maxEffort: 'low'|'medium'|'high'|null, stripEffort: boolean, vision: boolean}}
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
 * Whether a model accepts image input (vision) per CAPABILITY_TABLE.
 * Throws on models with no capability entry (same as normalizeCapability).
 *
 * @param {string} model
 * @returns {boolean}
 */
export function hasVision(model) {
  return capabilityEntry(model).vision
}

/**
 * Models that ARE vision-capable per models.dev but whose image turns FAIL
 * on the OpenCode Go gateway (HTTP 500 — opencode#33942 + opencode#29956).
 * Runtime image routing treats them as TEXT-ONLY so image turns are
 * intercepted and routed to the confirmed multimodal fallback (minimax-m3)
 * instead of being sent directly to the gateway. Keyed by the model segment
 * (after the last '/') so bare and provider-qualified IDs both match.
 */
export const GATEWAY_BROKEN_VISION_MODELS = new Set(['qwen3.7-plus'])

/**
 * Whether a model's image input is BROKEN on the given provider's runtime
 * gateway — vision per models.dev, but image turns fail. Provider-scoped:
 * only the OpenCode Go gateway (opencode-go) has a documented breakage; the
 * same model elsewhere (Zen free `opencode`, anthropic, openai) keeps its
 * native bypass.
 *
 * @param {string} model model ID (e.g. "opencode-go/qwen3.7-plus")
 * @param {string} providerID provider the model runs on
 * @returns {boolean}
 */
export function visionBrokenOnGateway(model, providerID) {
  if (!/^opencode-go$/.test(providerID ?? '')) return false
  const segment = model.slice(model.lastIndexOf('/') + 1)
  return GATEWAY_BROKEN_VISION_MODELS.has(segment)
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
 * Load and parse the full routing.yml document (fail-open helper for the
 * R1/R4/O5 config loaders below).
 *
 * @param {string} [routingPath] defaults to src/routing.yml
 * @returns {object|null} parsed routing.yml, or null when unreadable
 */
function loadRoutingYaml(routingPath) {
  const path = routingPath ?? fileURLToPath(new URL('../routing.yml', import.meta.url))
  const raw = readFileSync(path, 'utf8')
  const routing = yaml.load(raw)
  return routing && typeof routing === 'object' ? routing : null
}

const RETRY_ERROR_TYPES = new Set(['auth', 'rate_limit', 'timeout', 'other'])

/**
 * Load the R1 per-error-type retry policy from routing.yml (`retry_policy:`).
 * Fail-open: missing/unparseable config yields null (the caller falls back
 * to DEFAULT_RETRY_POLICY) and warns via the optional logger.
 *
 * @param {object} [opts]
 * @param {string} [opts.routingPath]
 * @param {{warn?: Function}} [opts.logger]
 * @returns {Record<string, number>|null} error-type → max retries
 */
export function loadRoutingRetryPolicy({ routingPath, logger = console } = {}) {
  try {
    const routing = loadRoutingYaml(routingPath)
    const policy = routing?.retry_policy
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return null
    const out = {}
    for (const [type, max] of Object.entries(policy)) {
      if (RETRY_ERROR_TYPES.has(type) && Number.isSafeInteger(max) && max >= 0) {
        out[type] = max
      }
    }
    return Object.keys(out).length > 0 ? out : null
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    logger.warn?.(`presets: routing.yml retry_policy unavailable (${reason})`)
    return null
  }
}

/**
 * Load the R1 provider cooldown config from routing.yml (`cooldown:`).
 * Fail-open: missing/unparseable config yields null (caller falls back to
 * DEFAULT_COOLDOWN).
 *
 * @param {object} [opts]
 * @param {string} [opts.routingPath]
 * @param {{warn?: Function}} [opts.logger]
 * @returns {{allowed_fails: number, cooldown_time_seconds: number}|null}
 */
export function loadRoutingCooldown({ routingPath, logger = console } = {}) {
  try {
    const routing = loadRoutingYaml(routingPath)
    const cooldown = routing?.cooldown
    if (!cooldown || typeof cooldown !== 'object' || Array.isArray(cooldown)) return null
    const allowedFails = cooldown.allowed_fails
    const cooldownTimeSeconds = cooldown.cooldown_time_seconds
    if (
      !Number.isSafeInteger(allowedFails) ||
      allowedFails < 1 ||
      !Number.isSafeInteger(cooldownTimeSeconds) ||
      cooldownTimeSeconds < 1
    ) {
      return null
    }
    return { allowed_fails: allowedFails, cooldown_time_seconds: cooldownTimeSeconds }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    logger.warn?.(`presets: routing.yml cooldown unavailable (${reason})`)
    return null
  }
}

/**
 * Load the R4 per-agent step caps from routing.yml
 * (`agents.<name>.max_steps`). Fail-open: missing config yields {}.
 *
 * @param {object} [opts]
 * @param {string} [opts.routingPath]
 * @param {{warn?: Function}} [opts.logger]
 * @returns {Record<string, number>} lowercase agent → max_steps
 */
export function loadRoutingMaxSteps({ routingPath, logger = console } = {}) {
  try {
    const routing = loadRoutingYaml(routingPath)
    const agents = routing?.agents
    if (!agents || typeof agents !== 'object') return {}
    const out = {}
    for (const [agent, spec] of Object.entries(agents)) {
      const maxSteps = spec && typeof spec === 'object' ? spec.max_steps : undefined
      if (Number.isSafeInteger(maxSteps) && maxSteps > 0) {
        out[agent.toLowerCase()] = maxSteps
      }
    }
    return out
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    logger.warn?.(`presets: routing.yml max_steps unavailable (${reason})`)
    return {}
  }
}

/**
 * Load the O5 permission.task glob rules from routing.yml
 * (`permission.task:`). Fail-open: missing config yields null (caller keeps
 * the existing runtime matrix, everything allowed).
 *
 * @param {object} [opts]
 * @param {string} [opts.routingPath]
 * @param {{warn?: Function}} [opts.logger]
 * @returns {Record<string, 'allow'|'deny'>|null} glob pattern → action
 */
export function loadRoutingPermissionTask({ routingPath, logger = console } = {}) {
  try {
    const routing = loadRoutingYaml(routingPath)
    const task = routing?.permission?.task
    if (!task || typeof task !== 'object' || Array.isArray(task)) return null
    const out = {}
    for (const [pattern, action] of Object.entries(task)) {
      if (action === 'allow' || action === 'deny') out[pattern] = action
    }
    return Object.keys(out).length > 0 ? out : null
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    logger.warn?.(`presets: routing.yml permission.task unavailable (${reason})`)
    return null
  }
}

/**
 * Load the active routing profile's agent → model mapping for the delegation
 * toolset (Fase 6 — wiring agentModels).
 *
 * routing.yml keeps per-agent models ONLY inside presets
 * (`presets.<name>.agents.<agent>.model`) — the top-level `agents:` section
 * carries no model field. No profile means an empty mapping; there is no
 * implicit first/default preset or fallback model.
 *
 * Fail-open: a missing or unparseable routing.yml yields {} and warns via the
 * optional logger; it NEVER throws at startup.
 *
 * @param {object} [opts]
 * @param {string} [opts.routingPath]
 * @param {string[]} [opts.candidates]
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {{warn?: Function}} [opts.logger]
 * @returns {Record<string, string>} lowercase agent → "provider/model"
 */
export function loadRoutingAgentModels({ routingPath, candidates, env, logger = console } = {}) {
  try {
    const active = resolveActivePreset({ routingPath, candidates, env, logger })
    if (active === null) return {}
    const models = {}
    for (const [agent, spec] of Object.entries(active.agents ?? {})) {
      if (spec && typeof spec === 'object' && typeof spec.model === 'string' && spec.model !== '') {
        models[agent.toLowerCase()] = spec.model
      }
    }
    return models
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    logger.warn?.(
      `presets: routing.yml active profile models unavailable (${reason}) — child model omitted`,
    )
    return {}
  }
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
 * @returns {{name: string, source: 'env'|'file', agents: object, providers: object, overrides: object|null, vision: {model: string, reasoning_effort?: 'low'|'medium'|'high'}|null}}
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
 * `vision` comes from the preset def, overridable via `overrides.vision`
 * (an explicit null in the file clears the fallback).
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
  // Vision override shallow-merges with the preset def (a partial
  // `{model}` keeps the preset's reasoning_effort) — mirrors how agent
  // overrides merge. An explicit `overrides.vision: null` clears the
  // fallback; a truthy non-object override is ignored like agents do.
  let vision = def.vision ?? null
  if (overrides && Object.hasOwn(overrides, 'vision')) {
    const override = overrides.vision
    if (override === null) {
      vision = null
    } else if (override && typeof override === 'object') {
      vision = { ...(def.vision ?? {}), ...override }
    }
  }

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

  return { name, source, agents, providers, overrides, vision }
}

/**
 * Whether a single provider DEF has its API key configured: no apiKeyEnv
 * (native provider, no external key gate) → always configured; otherwise the
 * env var must be set and non-empty. Shared by applyPreset (startup config
 * path) and providerKeyConfigured / missingProviderKeyEnv (delegate dispatch).
 *
 * @param {object|null|undefined} provider provider def ({baseURL, apiKeyEnv})
 * @param {Record<string, string|undefined>} env
 * @returns {boolean}
 */
function providerDefKeyConfigured(provider, env) {
  if (!provider || typeof provider !== 'object') return true
  const envVar = provider.apiKeyEnv
  if (typeof envVar !== 'string' || envVar === '') return true
  const candidates =
    envVar === 'PANTHEON_OPENCODE_API_KEY' ? [envVar, 'OPENCODE_GO_API_KEY'] : [envVar]
  for (const candidate of candidates) {
    const key = env[candidate]
    if (typeof key === 'string' && key.trim() !== '') return true
  }
  return false
}

/**
 * Name of the env var whose value is missing for a provider, or undefined
 * when the provider is usable. A provider is usable when it declares no
 * apiKeyEnv (native providers like opencode Zen) or its apiKeyEnv env var is
 * set and non-empty. Provider defs come from routing.yml preset definitions —
 * the SAME source applyPreset enforces at startup, so the delegate dispatch
 * path and the config path can never disagree.
 *
 * @param {string} providerID e.g. 'openai' | 'opencode' | 'opencode-go'
 * @param {object} [opts]
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {string} [opts.routingPath]
 * @returns {string|undefined} missing env var name, or undefined when usable
 */
export function missingProviderKeyEnv(providerID, { env = process.env, routingPath } = {}) {
  const defs = loadPresetDefs(routingPath)
  for (const def of Object.values(defs)) {
    const provider = def?.providers?.[providerID]
    if (provider === undefined) continue
    if (providerDefKeyConfigured(provider, env)) return undefined
    return provider.apiKeyEnv
  }
  // Provider not declared in any preset → no external key gate (opencode
  // manages its own auth) → usable.
  return undefined
}

/**
 * Whether the given provider's API key is configured (see
 * missingProviderKeyEnv). Convenience boolean for callers that only need the
 * yes/no answer.
 *
 * @param {string} providerID
 * @param {object} [opts]
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {string} [opts.routingPath]
 * @returns {boolean}
 */
export function providerKeyConfigured(providerID, opts) {
  return missingProviderKeyEnv(providerID, opts) === undefined
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
    if (!providerDefKeyConfigured(provider, env)) {
      const err = new Error(`presets: provider "${id}" requires env var ${provider.apiKeyEnv}`)
      err.code = 'PANTHEON_MISSING_API_KEY'
      err.envVar = provider.apiKeyEnv
      throw err
    }
    config.provider ??= {}
    config.provider[id] ??= {}
    config.provider[id].options ??= {}
    config.provider[id].options.baseURL = provider.baseURL
    const apiKey =
      provider.apiKeyEnv === 'PANTHEON_OPENCODE_API_KEY'
        ? (env[provider.apiKeyEnv] ?? env.OPENCODE_GO_API_KEY)
        : env[provider.apiKeyEnv]
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

/**
 * Resolve the active preset and apply it to an opencode config in ONE call —
 * the entry point used by the plugin `config` hook (P1-1) and CLI flows.
 *
 * Fail-safe: without an active preset (env unset, no candidate file,
 * "none") the config is returned UNMUTATED and null is returned. When a
 * preset resolves but its provider key env var is missing, `applyPreset`
 * throws PANTHEON_MISSING_API_KEY — the hook catches and skips.
 *
 * Default candidates mirror the plugin hook (project .pantheon file); the
 * plugin passes the full project/XDG/HOME list via `activePresetCandidates`
 * (vision.ts) for exact agreement with the native vision model resolution.
 *
 * @param {object} config opencode config object (mutated on success)
 * @param {object} [opts]
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {Array<string|null|undefined>} [opts.candidates]
 * @param {string} [opts.routingPath]
 * @param {{warn?: Function, log?: Function, error?: Function}} [opts.logger]
 * @returns {ResolvedPreset|null}
 */
export function applyActivePresetToConfig(
  config,
  { env = process.env, candidates, routingPath, logger } = {},
) {
  const resolved = resolveActivePreset({
    env,
    candidates: candidates ?? [join(process.cwd(), '.pantheon', 'active-preset.json')],
    routingPath,
    logger,
  })
  if (!resolved) return null
  applyPreset(config, resolved, { env })
  return resolved
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

    // Optional top-level vision fallback (routes image turns to a
    // vision-capable model when the agent models are text-only).
    if (def.vision !== undefined) {
      const v = def.vision
      if (!v || typeof v !== 'object' || Array.isArray(v)) {
        errors.push(
          `preset "${name}": vision must be an object with model (+ optional reasoning_effort)`,
        )
      } else {
        if (typeof v.model !== 'string' || !MODEL_RE.test(v.model)) {
          errors.push(`preset "${name}": vision.model must match provider/model (got "${v.model}")`)
        } else {
          try {
            const entry = capabilityEntry(v.model)
            if (!entry.vision) {
              errors.push(`preset "${name}": vision model "${v.model}" is not vision-capable`)
            }
          } catch (err) {
            errors.push(`preset "${name}": vision ${err.message}`)
          }
          // The vision model's provider (segment before the first '/') MUST
          // be declared in the preset's providers block (council 2026-08-02):
          // a vision fallback is unusable if applyPreset never injects the
          // provider config for it.
          const provider = v.model.slice(0, v.model.indexOf('/'))
          const declared = Object.keys(def.providers ?? {})
          if (!declared.includes(provider)) {
            errors.push(
              `preset "${name}": vision model ${v.model} uses provider ${provider} not declared in providers`,
            )
          }
        }
        if (v.reasoning_effort !== undefined && !Object.hasOwn(EFFORT_RANK, v.reasoning_effort)) {
          errors.push(`preset "${name}": vision reasoning_effort must be one of low, medium, high`)
        }
      }
    } else {
      // No vision fallback declared: warn when every primary agent model is
      // text-only — image turns would have no vision-capable route.
      const agentModels = Object.values(def.agents ?? {})
        .map((s) => (s && typeof s === 'object' ? s.model : undefined))
        .filter((m) => typeof m === 'string')
      if (
        agentModels.length > 0 &&
        agentModels.every((m) => {
          try {
            return !hasVision(m)
          } catch {
            return true
          }
        })
      ) {
        warnings.push(
          `preset "${name}": all primary agent models are text-only — consider adding a vision fallback`,
        )
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings }
}
