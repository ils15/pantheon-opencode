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
    Object.entries(V1_PERMISSION_TO_ACTION).map(([k, v]) => [v, k]),
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
  Object.entries(PROVIDER_RENAME).map(([k, v]) => [v, k]),
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
function convertProviderV1toV2(_name, config) {
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
function convertProviderV2toV1(_name, config) {
  const result = { ...config }

  // package → npm (strip aisdk: prefix)
  if (result.package !== undefined) {
    result.npm = result.package.startsWith('aisdk:') ? result.package.slice(6) : result.package
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
 * The server names are arbitrary — a user calls theirs whatever they like, and
 * which MCP servers exist is entirely their configuration, never ours.
 *
 * V1: { myserver: { type: "remote", url: "...", enabled: true, timeout: 30000 } }
 * V2 installer output: { myserver: { type: "remote", url: "...", enabled: true } }
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
// MCP entrypoint path migration
// ---------------------------------------------------------------------------

/**
 * Entrypoint filename renames: every historical Python MCP entrypoint shared
 * the `server.py` token, so a broad `pkill -f server.py` (a common idiom in
 * agent and scratch tooling) matched the entire fleet and killed it as
 * collateral. The five entrypoints now carry distinct tokens.
 *
 * The rename alone is a BREAKING change for existing installs: their
 * `opencode.json` carries literal paths like `scripts/memory_mcp_server.py`,
 * and a path that no longer resolves fails every MCP server silently (the
 * same class of failure as the dead plugin surface). This map is the single
 * source of truth for the stale → current basename rewrite that repairs them.
 */
export const MCP_ENTRYPOINT_RENAMES = Object.freeze({
  'mcp_resources_server.py': 'mcp_resources.py',
  'code_mode_server.py': 'code_mode.py',
  'memory_mcp_server.py': 'memory_mcp.py',
  'mcp_persistence_server.py': 'mcp_persistence.py',
  'pantheon_vision_server.py': 'pantheon_vision.py',
})

/**
 * Rewrite a single path/argument string when its basename is a renamed MCP
 * entrypoint. The directory prefix is preserved verbatim, so both relative
 * (`scripts/memory_mcp_server.py`) and absolute/hand-edited paths heal without
 * discarding a user's chosen location. Non-matching values pass through.
 *
 * @param {string} value
 * @returns {string}
 */
function renameMcpEntrypointPath(value) {
  if (typeof value !== 'string') return value
  const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  const base = value.slice(slash + 1)
  const renamed = MCP_ENTRYPOINT_RENAMES[base]
  if (!renamed) return value
  return value.slice(0, value.length - base.length) + renamed
}

/**
 * Heal stale MCP entrypoint paths in a flat named-server map, in place.
 *
 * Scans every server — not only the `pantheon-*` keys — because a user who
 * hand-edited their config may have renamed the key while keeping the
 * Pantheon path. Both `command` (installer writes `[python, script]`) and
 * `args` (the standalone installer writes `[script]`) are covered, since
 * which array carries the script differs between installers.
 *
 * @param {object} mcp - the `mcp` map from a config (mutated in place)
 * @returns {number} count of rewritten strings (0 = already current)
 */
export function migrateMcpEntrypointPaths(mcp) {
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) return 0

  let changed = 0
  for (const server of Object.values(mcp)) {
    if (!server || typeof server !== 'object') continue
    for (const field of ['command', 'args']) {
      const list = server[field]
      if (!Array.isArray(list)) continue
      for (let i = 0; i < list.length; i++) {
        const next = renameMcpEntrypointPath(list[i])
        if (next !== list[i]) {
          list[i] = next
          changed++
        }
      }
    }
  }
  return changed
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
  Object.entries(V1_TO_V2_RENAMES).map(([k, v]) => [v, k]),
)

/**
 * Agent fields owned by the framework. Mirrors the exported MANAGED_FIELDS in
 * install/opencode.mjs plus `source`, which the installer writes next to them.
 * The migration runs before that merge, so it has to apply the same precedence
 * itself when both `agent` and `agents` coexist: these come from the V1 block,
 * every other field stays the user's.
 *
 * `permissions` is the V2 name — the converter renames the V1 `permission`
 * block before the merge runs.
 *
 * `description` is deliberately absent, and this list is deliberately narrower
 * than what the installer writes. The installer writes a description only when
 * it creates an agent (install/opencode.mjs, the new-agent branch); on an agent
 * that already exists it leaves the value alone, under its own comment "Existing
 * agent fields belong to the user". So a description is framework-owned for a
 * NEW agent and user-owned for an EXISTING one. Listing it here would make the
 * migration stricter than the installer and would overwrite a description the
 * installer deliberately preserves. mergeManagedAgents carries the value across
 * instead, so it survives the merge without being treated as framework-owned.
 *
 * KNOWN DEBT: the installer still writes the V1 spelling `permission`, while V2
 * reads `permissions`. An agent that goes through this merge can therefore end
 * up carrying both keys, with `permission` left as dead weight that nothing
 * reads. Tracked for the next slice; not fixed here, because picking a winner
 * changes what an install writes.
 */
export const MANAGED_AGENT_FIELDS = Object.freeze([
  'source',
  'temperature',
  'color',
  'permissions',
  'mode',
  'hidden',
  'disable_model_invocation',
])

/**
 * Compare this module's managed-agent list against the installer's.
 *
 * The two merge paths have to agree: the migration reimplements the installer's
 * merge because it runs before it. A field present on only one side is silent
 * divergence — either the migration overwrites a field the installer leaves
 * alone, or it stops mirroring one the installer now writes. Both directions
 * matter, so the result is reported as a pair of differences rather than a
 * boolean.
 *
 * Names are compared after the converter's renames, because that is the
 * spelling the merge actually sees.
 *
 * @param {string[]} installerFields - MANAGED_FIELDS as exported by install/opencode.mjs
 * @returns {{ onlyInMigration: string[], onlyInInstaller: string[] }}
 */
export function managedAgentFieldDrift(installerFields) {
  const toV2Name = (field) => V1_TO_V2_RENAMES[field] ?? field
  const migration = new Set(MANAGED_AGENT_FIELDS.map(toV2Name))
  const installer = new Set(installerFields.map(toV2Name))
  return {
    onlyInMigration: [...migration].filter((f) => !installer.has(f)).sort(),
    onlyInInstaller: [...installer].filter((f) => !migration.has(f)).sort(),
  }
}

/** @returns {boolean} true for a plain name→config map (not null/array) */
function isAgentMap(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Merge the converted V1 `agent` block into an existing V2 `agents` base.
 *
 * Agents present in both are merged field by field: the base is kept, keys the
 * base does not have are filled in from the V1 block, and MANAGED_AGENT_FIELDS
 * are overwritten by the V1 values. Agents present in only one block are taken
 * as they are — a union, not a replacement.
 *
 * Filling the gaps matters, and it is not description-specific: any key present
 * only in the V1 block used to vanish here — `model`, `provider` and `mcp` too.
 * `description` is the visible case, because the installer never writes one for
 * an existing agent, so the V1 block is the only place that value can come from
 * and the agent lost it on every install, permanently. Filling gaps can never
 * destroy a base value; on conflict the base still wins, as before.
 *
 * @param {object} base - existing V2 `agents` map
 * @param {object} managed - converted V1 `agent` map
 * @returns {object} merged map
 */
function mergeManagedAgents(base, managed) {
  const merged = { ...base }

  for (const [name, agentConfig] of Object.entries(managed)) {
    const existing = merged[name]
    if (!isAgentMap(existing) || !isAgentMap(agentConfig)) {
      merged[name] = agentConfig
      continue
    }
    const entry = { ...existing }
    for (const [field, value] of Object.entries(agentConfig)) {
      if (!(field in entry)) entry[field] = value
    }
    for (const field of MANAGED_AGENT_FIELDS) {
      if (field in agentConfig) entry[field] = agentConfig[field]
    }
    merged[name] = entry
  }

  return merged
}

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
      // An `agents` (V2) block may already exist — the installed opencode.json
      // carries both, in either key order. Renaming onto it with a plain
      // replace dropped the whole managed merge, so merge instead.
      const base = result.agents
      result.agents = isAgentMap(base) ? mergeManagedAgents(base, agents) : agents
    } else if (key === 'agents') {
      // V2 block: it is the base. The singular `agent` key may already have
      // been converted above, in which case merge the two.
      const managed = result.agents
      if (isAgentMap(value)) {
        result.agents = isAgentMap(managed) ? mergeManagedAgents(value, managed) : value
      } else if (!isAgentMap(managed)) {
        result.agents = value
      }
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
