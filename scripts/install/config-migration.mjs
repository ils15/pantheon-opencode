/**
 * config-migration.mjs — Bidirectional V1↔V2 config format migration
 *
 * Converts opencode.json between:
 * - V1 (object-based): `permission`, `agent`, `provider`, `mcp` with flat keys
 * - V2 (array-based):  `permissions`, `agents`, `providers`; MCP remains the
 *   named top-level server map because OpenCode 1.18.x validates that shape for
 *   both the V1 and V2 installer paths.
 *
 * Rules:
 * 1. Deep clone before mutating — never modifies input
 * 2. Unknown fields pass through untouched
 * 3. console.warn for ambiguities
 * 4. Handles nested objects recursively
 *
 * @module config-migration
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deep clone a JSON-serializable value */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj))
}

// ---------------------------------------------------------------------------
// V1 → V2 helpers
// ---------------------------------------------------------------------------

/** Action name mapping for permissions (V1 key → V2 action) */
const V1_PERMISSION_TO_ACTION = {
  bash: 'shell',
  skill: 'skill',
  edit: 'edit',
  websearch: 'websearch',
  // passthrough unknowns
}

/**
 * Convert V1 permission object to V2 permissions array.
 *
 * V1 shape:
 *   { bash: { "git *": "allow" }, edit: "allow", skill: { "*": "allow" }, websearch: "deny" }
 *
 * V2 shape:
 *   [ { action: "shell", resource: "git *", effect: "allow" }, ... ]
 */
function convertPermissionsV1toV2(permObj) {
  const result = []
  for (const [key, value] of Object.entries(permObj)) {
    const action = V1_PERMISSION_TO_ACTION[key] || key
    if (typeof value === 'string') {
      // Simple: { edit: "allow" } → [{ action: "edit", resource: "*", effect: "allow" }]
      result.push({ action, resource: '*', effect: value })
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Nested: { bash: { "git *": "allow" } } → [{ action: "shell", resource: "git *", effect: "allow" }]
      for (const [resource, effect] of Object.entries(value)) {
        result.push({ action, resource, effect })
      }
    } else {
      console.warn(`[config-migration] Unexpected permission value for "${key}":`, value)
    }
  }
  return result
}

/**
 * Convert V2 permissions array back to V1 permission object.
 */
function convertPermissionsV2toV1(permArray) {
  const result = {}
  // Reverse action mapping: V2 action → V1 key
  const ACTION_TO_V1 = Object.fromEntries(
    Object.entries(V1_PERMISSION_TO_ACTION).map(([k, v]) => [v, k])
  )

  for (const { action, resource, effect } of permArray) {
    const v1Key = ACTION_TO_V1[action] || action
    if (resource === '*') {
      result[v1Key] = effect
    } else {
      if (!result[v1Key] || typeof result[v1Key] === 'string') {
        // Convert scalar to object
        if (typeof result[v1Key] === 'string') {
          const prevEffect = result[v1Key]
          result[v1Key] = { '*': prevEffect }
        } else {
          result[v1Key] = {}
        }
      }
      result[v1Key][resource] = effect
    }
  }
  return result
}

/** Provider name consolidation: V1 → V2 */
const PROVIDER_RENAME = {
  'azure-cognitive-services': 'azure',
  'google-vertex-anthropic': 'google-vertex',
}

/** Reverse: V2 → V1 */
const PROVIDER_RENAME_REVERSE = Object.fromEntries(
  Object.entries(PROVIDER_RENAME).map(([k, v]) => [v, k])
)

/**
 * Convert a single V1 provider config to V2.
 *
 * V1 shape:
 *   { npm: "ai-sdk-openai", api: "https://...", options: { apiKey: "..." }, models: { ... } }
 *
 * V2 shape:
 *   { package: "aisdk:ai-sdk-openai", settings: { baseURL: "...", apiKey: "..." }, models: { ... } }
 */
function convertProviderV1toV2(name, config) {
  const result = { ...config }

  // npm → package (with aisdk: prefix)
  if (result.npm !== undefined) {
    const pkg = result.npm.startsWith('aisdk:') ? result.npm : `aisdk:${result.npm}`
    result.package = pkg
    delete result.npm
  }

  // api → settings.baseURL
  if (result.api !== undefined) {
    if (!result.settings) result.settings = {}
    result.settings.baseURL = result.api
    delete result.api
  }

  // options.apiKey → settings.apiKey
  if (result.options?.apiKey !== undefined) {
    if (!result.settings) result.settings = {}
    result.settings.apiKey = result.options.apiKey
    const { apiKey, ...restOptions } = result.options
    if (Object.keys(restOptions).length > 0) {
      result.options = restOptions
    } else {
      delete result.options
    }
  }

  // Model variant: { variant: "high" } → key suffix #high
  // Also rename model-level "attachment" → "media"
  if (result.models) {
    const newModels = {}
    for (const [modelKey, modelConfig] of Object.entries(result.models)) {
      const { variant, attachment, ...restConfig } = modelConfig || {}
      const finalConfig = { ...restConfig }
      if (attachment !== undefined) {
        finalConfig.media = attachment
      }
      if (variant) {
        const newKey = `${modelKey}#${variant}`
        newModels[newKey] = finalConfig
      } else {
        newModels[modelKey] = finalConfig
      }
    }
    result.models = newModels
  }

  return result
}

/**
 * Convert a single V2 provider config back to V1.
 */
function convertProviderV2toV1(name, config) {
  const result = { ...config }

  // package → npm (strip aisdk: prefix)
  if (result.package !== undefined) {
    result.npm = result.package.startsWith('aisdk:')
      ? result.package.slice(6)
      : result.package
    delete result.package
  }

  // settings.baseURL → api
  if (result.settings?.baseURL !== undefined) {
    result.api = result.settings.baseURL
    const { baseURL, ...restSettings } = result.settings
    if (Object.keys(restSettings).length > 0) {
      result.settings = restSettings
    } else {
      delete result.settings
    }
  }

  // settings.apiKey → options.apiKey
  if (result.settings?.apiKey !== undefined) {
    if (!result.options) result.options = {}
    result.options.apiKey = result.settings.apiKey
    const { apiKey, ...restSettings } = result.settings || {}
    if (Object.keys(restSettings).length > 0) {
      result.settings = restSettings
    } else {
      delete result.settings
    }
  }

  // Model key with #suffix → variant field
  // Also rename model-level "media" → "attachment"
  if (result.models) {
    const newModels = {}
    for (const [modelKey, modelConfig] of Object.entries(result.models)) {
      const { media, ...restConfig } = modelConfig || {}
      const finalConfig = { ...restConfig }
      if (media !== undefined) {
        finalConfig.attachment = media
      }
      if (modelKey.includes('#')) {
        const [baseName, variant] = modelKey.split('#', 2)
        newModels[baseName] = { ...finalConfig, variant }
      } else {
        newModels[modelKey] = finalConfig
      }
    }
    result.models = newModels
  }

  return result
}

/**
 * Convert V1 MCP config to V2.
 *
 * V1: { bifrost: { type: "remote", url: "...", enabled: true, timeout: 30000 } }
 * V2 installer output: { bifrost: { type: "remote", url: "...", enabled: true } }
 *
 * OpenCode 1.18.18 does not have an `mcp.servers` wrapper. It interprets
 * `servers` as the name of an MCP server and then rejects it with
 * `Missing key mcp.servers.enabled`. Keep MCP in the documented shape and
 * normalize old generated V2 entries back to it.
 */
function convertMcpV1toV2(mcpConfig) {
  if (!mcpConfig || typeof mcpConfig !== 'object') return mcpConfig

  const servers = {}
  const source =
    mcpConfig.servers && typeof mcpConfig.servers === 'object' && !Array.isArray(mcpConfig.servers)
      ? { ...mcpConfig, ...mcpConfig.servers }
      : mcpConfig

  for (const [name, serverConfig] of Object.entries(source)) {
    if (name === 'servers') continue
    // Installer versions that seeded the legacy wrapper also wrote a boolean
    // feature toggle (`servers: { enabled: true }`). After unwrapping, that
    // toggle surfaces as a non-object entry and is not a server; drop it.
    if (serverConfig === null || typeof serverConfig !== 'object') continue
    const srv = { ...serverConfig }

    // Normalize legacy V2's disabled flag to OpenCode 1.18.x's enabled flag.
    if ('disabled' in srv) {
      srv.enabled = !srv.disabled
      delete srv.disabled
    }

    // Normalize legacy V2's split timeout to the V1/V2-compatible number.
    if (srv.timeout !== undefined && srv.timeout !== null) {
      if (typeof srv.timeout === 'object') {
        srv.timeout = srv.timeout.execution || srv.timeout.catalog || 30000
      }
    }

    // A shorthand inherited-server override is valid only when named directly.
    // Runtime MCP entries always have a complete config, so leave other values
    // untouched and avoid dropping user-owned servers.
    servers[name] = srv
  }

  return servers
}

/**
 * Convert V2 MCP config back to V1.
 */
function convertMcpV2toV1(mcpConfig) {
  if (!mcpConfig || typeof mcpConfig !== 'object') return mcpConfig

  return convertMcpV1toV2(mcpConfig)
}

// ---------------------------------------------------------------------------
// Top-level key mappings
// ---------------------------------------------------------------------------

const V1_TO_V2_RENAMES = {
  provider: 'providers',
  agent: 'agents',
  command: 'commands',
  reference: 'references',
  snapshot: 'snapshots',
  attachment: 'media',
  permission: 'permissions',
}

/** Build reverse map */
const V2_TO_V1_RENAMES = Object.fromEntries(
  Object.entries(V1_TO_V2_RENAMES).map(([k, v]) => [v, k])
)

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Migrate a V1 opencode.json config to V2 format.
 *
 * @param {object} config - V1 config object (not mutated)
 * @returns {object} V2 config object
 */
export function migrateV1toV2(config) {
  const c = deepClone(config)
  const result = {}

  for (const [key, value] of Object.entries(c)) {
    const v2Key = V1_TO_V2_RENAMES[key] || key

    if (key === 'permission' && typeof value === 'object' && value !== null) {
      result.permissions = convertPermissionsV1toV2(value)
    } else if (key === 'agent' && typeof value === 'object' && value !== null) {
      const agents = {}
      for (const [agentName, agentConfig] of Object.entries(value)) {
        const ac = { ...agentConfig }
        if (ac.permission && typeof ac.permission === 'object') {
          ac.permissions = convertPermissionsV1toV2(ac.permission)
          delete ac.permission
        }
        agents[agentName] = ac
      }
      result.agents = agents
    } else if (key === 'provider' && typeof value === 'object' && value !== null) {
      const providers = {}
      for (const [provName, provConfig] of Object.entries(value)) {
        const renamed = PROVIDER_RENAME[provName] || provName
        providers[renamed] = convertProviderV1toV2(provName, provConfig)
      }
      result.providers = providers
    } else if (key === 'mcp' && typeof value === 'object' && value !== null) {
      result.mcp = convertMcpV1toV2(value)
    } else if (v2Key !== key) {
      result[v2Key] = value
    } else {
      result[key] = value
    }
  }

  return result
}

/**
 * Migrate a V2 opencode.json config back to V1 format.
 *
 * @param {object} config - V2 config object (not mutated)
 * @returns {object} V1 config object
 */
export function migrateV2toV1(config) {
  const c = deepClone(config)
  const result = {}

  for (const [key, value] of Object.entries(c)) {
    const v1Key = V2_TO_V1_RENAMES[key] || key

    if (key === 'permissions' && Array.isArray(value)) {
      result.permission = convertPermissionsV2toV1(value)
    } else if (key === 'agents' && typeof value === 'object' && value !== null) {
      const agents = {}
      for (const [agentName, agentConfig] of Object.entries(value)) {
        const ac = { ...agentConfig }
        if (Array.isArray(ac.permissions)) {
          ac.permission = convertPermissionsV2toV1(ac.permissions)
          delete ac.permissions
        }
        agents[agentName] = ac
      }
      result.agent = agents
    } else if (key === 'providers' && typeof value === 'object' && value !== null) {
      const providers = {}
      for (const [provName, provConfig] of Object.entries(value)) {
        const renamed = PROVIDER_RENAME_REVERSE[provName] || provName
        providers[renamed] = convertProviderV2toV1(provName, provConfig)
      }
      result.provider = providers
    } else if (key === 'mcp' && typeof value === 'object' && value !== null) {
      result.mcp = convertMcpV2toV1(value)
    } else if (v1Key !== key) {
      result[v1Key] = value
    } else {
      result[key] = value
    }
  }

  return result
}
