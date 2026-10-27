/**
 * config-migration.mjs — Bidirectional V1↔V2 config format migration
 *
 * Converts opencode.json between:
 * - V1 (object-based): `permission`, `agent`, `provider`, `mcp` with flat keys
 * - V2 (array-based): `permissions`, `agents`, `providers`, and
 *   `mcp.servers.<name>` server configuration.
 *
 * Rules:
 * 1. Deep clone before mutating — never modifies input
 * 2. Unknown fields pass through untouched
 * 3. console.warn for ambiguities
 * 4. Handles nested objects recursively
 *
 * @module config-migration
 */

import {
  assertMcpPermissionNamesUnambiguous,
  assertMcpPermissionScopesDoNotAliasConfiguredServers,
  assertMcpServerPermissionScopesUnambiguous,
  mcpServerPermissionActions,
} from './mcp-permissions.mjs'
import { opencodeWildcardPatternsOverlap } from './opencode-wildcard.mjs'

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

/**
 * Action name mapping for permissions (V1 key → V2 action), including
 * task → subagent.
 *
 * `write` is an alias of `edit`. Every V2 host measured for P0-5 (2.0.22,
 * 2.0.30, 2.1.0, 2.1.2) evaluates a `write` tool call under the action name
 * `edit`; rules are mapped to that action while their input order and distinct
 * entries are preserved because V2 permission evaluation is order-sensitive.
 *
 * Only mappings confirmed against a host belong here: `bash → shell`, `task →
 * subagent`, `read → read` and `write → edit` were observed on 2.0.22/2.0.30/
 * 2.1.0/2.1.2. Identity entries (`skill`, `websearch`, `edit`) and keys left out
 * of this table (`webfetch`, `mcp`, …) have no observed host action: they are
 * kept as passthrough rather than renamed by guess.
 */
const V1_PERMISSION_TO_ACTION = {
  bash: 'shell',
  task: 'subagent',
  skill: 'skill',
  // Listed before `write` so the reverse map resolves `edit` to the canonical
  // V1 key instead of to the alias.
  edit: 'edit',
  write: 'edit',
  websearch: 'websearch',
  // passthrough unknowns
}

/** Effect restrictiveness is used only when V2 rules must collapse into V1 keys. */
const EFFECT_RESTRICTIVENESS = { allow: 1, ask: 2, deny: 3 }

function isKnownEffect(effect) {
  return typeof effect === 'string' && Object.hasOwn(EFFECT_RESTRICTIVENESS, effect)
}

/** A structurally valid permission rule, used for redacted malformed-entry counts. */
function isValidPermissionEntry(entry) {
  return (
    isPlainObject(entry) && typeof entry.action === 'string' && typeof entry.resource === 'string'
  )
}

/**
 * Report malformed entries without echoing user-supplied config values.
 */
function warnInvalidPermissionEntries(entries) {
  const invalid = entries.filter((entry) => !isValidPermissionEntry(entry))
  if (invalid.length === 0) return
  console.warn(
    `[config-migration] ${invalid.length} malformed permission ${invalid.length === 1 ? 'entry was' : 'entries were'} preserved in order.`,
  )
}

/**
 * Resolve two effects proposed for the same action+resource.
 *
 * Security bias: `deny` always wins, including against an unrecognized effect,
 * and an unrecognized effect never silently replaces a known one. When both
 * effects are unrecognized they cannot be ranked, so the first is kept and the
 * warning says exactly that — it makes no restrictiveness claim.
 *
 * @returns {string} the effect to keep
 */
function resolveEffects(current, next) {
  if (current === next) return current

  const currentKnown = isKnownEffect(current)
  const nextKnown = isKnownEffect(next)

  if (!currentKnown && !nextKnown) {
    console.warn(
      '[config-migration] Unrecognized effects could not be ranked; keeping the first value.',
    )
    return current
  }
  if (currentKnown && !nextKnown) {
    console.warn('[config-migration] An unrecognized effect could not replace a known effect.')
    return current
  }
  if (!currentKnown && nextKnown) {
    console.warn('[config-migration] A known effect replaced an unrecognized effect.')
    return next
  }

  const winner = EFFECT_RESTRICTIVENESS[next] > EFFECT_RESTRICTIVENESS[current] ? next : current
  console.warn(
    '[config-migration] Conflicting effects were found; keeping the more restrictive value.',
  )
  return winner
}

/**
 * Define an own enumerable property. Plain assignment is not enough for
 * attacker-controlled keys: `obj['__proto__'] = value` mutates the prototype
 * (or is dropped), producing a config with no key at all.
 */
function setOwn(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  })
}

/**
 * Valid MCP server name. Mirrors the installer validation. The original spelling
 * preserves V1 compatibility; the shared permission helper also emits the V2
 * punctuation-normalized alias. Names outside this set cannot be mapped safely.
 */
const MCP_SERVER_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/

/**
 * Translate the V1 `permission.mcp` block.
 *
 * Measured on OpenCode 2.0.29–2.1.3 (P0-5 MCP gating): the host evaluates an
 * MCP tool call as `<server>_<tool>` with `resources: ["*"]`. The V1 key
 * `permission.mcp.<server>`, the action `mcp` and the `resource` field are all
 * inert — passing them through emitted a config that enforced nothing.
 *
 *   deny/allow → one rule for each V1/original and V2/normalized server alias,
 *                with action "<server-alias>_*" and resource "*".
 *   ask   → no rule + warning. `ask` on an action rule HIDES the tool instead of
 *           prompting, so translating it would silently remove the tool; that is
 *           not what the user asked for, and it must not be downgraded to deny
 *           or upgraded to allow without saying so.
 *
 * An invalid server name gets the same treatment as `ask`: no rule and a
 * warning, because an action the host never emits protects nothing.
 *
 * The glob gates every tool of the server and needs no `tools/list` discovery,
 * which is why it is preferred over per-tool `<server>_<tool>` rules.
 */
function convertMcpPermissions(value, result, provenance, configuredMcpServers) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    console.warn('[config-migration] permission.mcp is malformed; no MCP rules were emitted.')
    return
  }
  const validServers = Object.keys(value).filter((server) => MCP_SERVER_NAME_PATTERN.test(server))
  assertMcpPermissionNamesUnambiguous(validServers)
  assertMcpPermissionScopesDoNotAliasConfiguredServers(validServers, configuredMcpServers)
  assertMcpServerPermissionScopesUnambiguous(
    Object.entries(value)
      .filter(
        ([server, effect]) =>
          MCP_SERVER_NAME_PATTERN.test(server) && (effect === 'allow' || effect === 'deny'),
      )
      .map(([server, effect]) => ({ server, effect })),
  )
  for (const [server, effect] of Object.entries(value)) {
    if (!MCP_SERVER_NAME_PATTERN.test(server)) {
      console.warn(
        '[config-migration] An MCP permission has an invalid server name; no rule was emitted.',
      )
      continue
    }
    if (effect === 'deny' || effect === 'allow') {
      for (const action of mcpServerPermissionActions(server)) {
        const rule = { action, resource: '*', effect }
        result.push(rule)
        provenance.push({ rule, sourceAction: 'mcp', sourceKind: 'mcp', sourceName: server })
      }
      continue
    }
    if (effect === 'ask') {
      console.warn(
        '[config-migration] An MCP ask policy cannot be enforced in OpenCode V2; no rule was emitted. ' +
          'Use `npm run setup` to choose an explicit outcome.',
      )
      continue
    }
    console.warn(
      '[config-migration] An MCP permission has an unsupported effect; no rule was emitted.',
    )
  }
}

/**
 * Convert V1 permission object to V2 permissions array.
 *
 * Rules are emitted in source insertion order. V2 evaluates permission rules in
 * array order, so sorting or collapsing distinct rules can change the policy.
 *
 * V1 shape:
 *   { bash: { "git *": "allow" }, edit: "allow", skill: { "*": "allow" }, websearch: "deny" }
 *
 * V2 shape:
 *   [ { action: "shell", resource: "git *", effect: "allow" }, ... ]
 */
function convertPermissionsV1toV2(permObj, configuredMcpServers = []) {
  const result = []
  const provenance = []
  for (const [key, value] of Object.entries(permObj)) {
    // `permission.mcp` is a server map, not an action name: it needs its own
    // translation (see convertMcpPermissions).
    if (key === 'mcp') {
      convertMcpPermissions(value, result, provenance, configuredMcpServers)
      continue
    }
    const action = Object.hasOwn(V1_PERMISSION_TO_ACTION, key) ? V1_PERMISSION_TO_ACTION[key] : key
    if (typeof value === 'string') {
      // Simple: { edit: "allow" } → [{ action: "edit", resource: "*", effect: "allow" }]
      const rule = { action, resource: '*', effect: value }
      result.push(rule)
      provenance.push({ rule, sourceAction: key, sourceKind: 'action', sourceName: key })
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Nested: { bash: { "git *": "allow" } } → [{ action: "shell", resource: "git *", effect: "allow" }]
      for (const [resource, effect] of Object.entries(value)) {
        const rule = { action, resource, effect }
        result.push(rule)
        provenance.push({ rule, sourceAction: key, sourceKind: 'action', sourceName: key })
      }
    } else {
      console.warn('[config-migration] An unexpected permission value was preserved by omission.')
    }
  }
  assertV1ActionNormalizationDoesNotCollapseSources(provenance)
  return result
}

/**
 * Preserve same-source V1 rule order, but reject only overlaps introduced by
 * converting distinct V1 action/server identities to intersecting V2 actions.
 * V1 and V2 both use last-match-wins, so a same-source deny followed by a more
 * specific allow is intentional and must not be reordered or rejected.
 */
function assertV1ActionNormalizationDoesNotCollapseSources(provenance) {
  const actionPolicies = new Map()
  for (const source of provenance) {
    if (source.sourceKind !== 'action') continue
    const policy = actionPolicies.get(source.sourceAction) ?? []
    policy.push({ resource: source.rule.resource, effect: source.rule.effect })
    actionPolicies.set(source.sourceAction, policy)
  }
  const identicalActionPolicies = (left, right) => {
    const leftPolicy = actionPolicies.get(left.sourceAction)
    const rightPolicy = actionPolicies.get(right.sourceAction)
    return (
      leftPolicy !== undefined &&
      rightPolicy !== undefined &&
      JSON.stringify(leftPolicy) === JSON.stringify(rightPolicy)
    )
  }

  for (let leftIndex = 0; leftIndex < provenance.length; leftIndex += 1) {
    const left = provenance[leftIndex]
    for (let rightIndex = leftIndex + 1; rightIndex < provenance.length; rightIndex += 1) {
      const right = provenance[rightIndex]
      const distinctMcpServers =
        left.sourceKind === 'mcp' &&
        right.sourceKind === 'mcp' &&
        left.sourceName !== right.sourceName
      const distinctActions =
        left.sourceKind === 'action' &&
        right.sourceKind === 'action' &&
        left.sourceAction !== right.sourceAction
      const actionAliasCollision =
        distinctActions &&
        !identicalActionPolicies(left, right) &&
        !opencodeWildcardPatternsOverlap(left.sourceAction, right.sourceAction) &&
        left.rule.effect !== right.rule.effect &&
        opencodeWildcardPatternsOverlap(left.rule.action, right.rule.action)
      const mcpAliasCollision =
        distinctMcpServers && opencodeWildcardPatternsOverlap(left.rule.action, right.rule.action)
      const crossKindAliasCollision =
        left.sourceKind !== right.sourceKind &&
        !opencodeWildcardPatternsOverlap(left.sourceAction, right.sourceAction) &&
        left.rule.effect !== right.rule.effect &&
        opencodeWildcardPatternsOverlap(left.rule.action, right.rule.action)

      if (
        (actionAliasCollision || mcpAliasCollision || crossKindAliasCollision) &&
        opencodeWildcardPatternsOverlap(left.rule.resource, right.rule.resource)
      ) {
        throw new TypeError(
          'Distinct V1 permission sources overlap after OpenCode V2 action normalization; migration stopped.',
        )
      }
    }
  }
}

/**
 * Convert V2 permissions array back to V1 permission object.
 *
 * Rules that land on the same V1 key+resource are merged with the same
 * restrictiveness policy as the forward map (`deny > ask > allow`, `deny`
 * always wins, an unrecognized effect never replaces a known one). "Last wins"
 * would let `[{edit,*,deny},{edit,*,allow}]` downgrade a deny to allow, which
 * is the opposite of what the forward direction guarantees.
 */
function convertPermissionsV2toV1(permArray) {
  // Reverse action mapping: V2 action → V1 key. Aliases collapse onto one action
  // (`write` and `edit` both → `edit`), so the FIRST key wins — the canonical
  // V1 spelling — instead of the alias that happens to be listed last.
  // Null prototype + hasOwn: actions named like Object.prototype members
  // (`__proto__`, `constructor`, `toString`) must pass through literally.
  const ACTION_TO_V1 = Object.create(null)
  for (const [v1Key, action] of Object.entries(V1_PERMISSION_TO_ACTION)) {
    if (!Object.hasOwn(ACTION_TO_V1, action)) ACTION_TO_V1[action] = v1Key
  }

  // Group by V1 key first, resolving collisions per resource, so the output
  // shape (scalar for a lone "*" rule, object otherwise) does not depend on
  // array order.
  const byKey = new Map()
  for (const { action, resource, effect } of permArray) {
    const v1Key = Object.hasOwn(ACTION_TO_V1, action) ? ACTION_TO_V1[action] : action
    let rules = byKey.get(v1Key)
    if (rules === undefined) {
      rules = new Map()
      byKey.set(v1Key, rules)
    }
    rules.set(resource, rules.has(resource) ? resolveEffects(rules.get(resource), effect) : effect)
  }

  const result = {}
  for (const [v1Key, rules] of byKey) {
    if (rules.size === 1 && rules.has('*')) {
      setOwn(result, v1Key, rules.get('*'))
      continue
    }
    const group = {}
    for (const [resource, effect] of rules) setOwn(group, resource, effect)
    setOwn(result, v1Key, group)
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
 * Validate the MCP source shape before any installer seeding can normalize it.
 * Returns the shape decision consumed by the converter so both paths apply
 * exactly the same nested-map and legacy-toggle rules.
 *
 * @param {unknown} mcpConfig
 * @returns {{ hasV2ServersMap: boolean, legacyServersToggle: boolean }}
 */
export function validateMcpV1toV2Source(mcpConfig) {
  if (Array.isArray(mcpConfig)) {
    throw new Error(
      'Malformed MCP configuration: top-level mcp must be an object map, not an array.',
    )
  }
  if (!isPlainObject(mcpConfig)) {
    throw new Error('Malformed MCP configuration: top-level mcp must be an object map.')
  }

  const wrappedServers = mcpConfig.servers
  if (Array.isArray(wrappedServers)) {
    throw new Error('Malformed MCP configuration: mcp.servers must be an object map, not an array.')
  }
  const legacyServersToggle =
    isPlainObject(wrappedServers) &&
    Object.keys(wrappedServers).length === 1 &&
    typeof wrappedServers.enabled === 'boolean'
  const looksLikeServerConfig = (value) =>
    isPlainObject(value) &&
    (typeof value.type === 'string' ||
      typeof value.url === 'string' ||
      typeof value.cwd === 'string' ||
      Array.isArray(value.command))
  const nestedServerMap =
    isPlainObject(wrappedServers) &&
    (Object.keys(wrappedServers).length === 0 ||
      Object.values(wrappedServers).every(looksLikeServerConfig))
  const flatServerNamedServers = looksLikeServerConfig(wrappedServers)

  if (!legacyServersToggle && nestedServerMap && flatServerNamedServers) {
    throw new Error('Ambiguous mcp.servers value could be a flat server or a nested server map.')
  }

  const malformedNestedMap =
    isPlainObject(wrappedServers) &&
    !legacyServersToggle &&
    !nestedServerMap &&
    !flatServerNamedServers

  if (malformedNestedMap) {
    throw new Error('Malformed or ambiguous nested MCP server map cannot be migrated safely.')
  }

  const hasV2ServersMap =
    isPlainObject(wrappedServers) &&
    !legacyServersToggle &&
    nestedServerMap &&
    !flatServerNamedServers

  for (const [name, value] of Object.entries(mcpConfig)) {
    if (
      name === 'servers' &&
      (legacyServersToggle || hasV2ServersMap || looksLikeServerConfig(value))
    ) {
      continue
    }
    if (!isPlainObject(value)) {
      throw new Error(
        'Malformed MCP server entry: every flat server configuration must be an object.',
      )
    }
  }

  return { hasV2ServersMap, legacyServersToggle }
}

/**
 * Convert V1 MCP config to V2.
 *
 * The server names are arbitrary — a user calls theirs whatever they like, and
 * which MCP servers exist is entirely their configuration, never ours.
 *
 * V1: { myserver: { type: "remote", url: "...", enabled: true } }
 * V2: { servers: { myserver: { type: "remote", url: "...", disabled: false } } }
 *
 * V2's MCP schema stores named servers under `mcp.servers`; V1's flat map is
 * wrapped during migration. A pre-existing V2 wrapper is retained in place,
 * and distinct flat siblings are included rather than silently discarded. A
 * duplicate name across the two shapes is ambiguous and fails closed.
 */
function convertMcpV1toV2(mcpConfig) {
  const { hasV2ServersMap, legacyServersToggle } = validateMcpV1toV2Source(mcpConfig)
  const servers = {}
  // Expand a nested map exactly where its `servers` property occurred. This
  // retains the source order relative to flat siblings while still detecting
  // duplicate names across both shapes below.
  const source = Object.entries(mcpConfig).flatMap(([name, config]) =>
    hasV2ServersMap && name === 'servers' ? Object.entries(config) : [[name, config]],
  )

  for (const [name, serverConfig] of source) {
    if (!hasV2ServersMap && name === 'servers' && legacyServersToggle) {
      // Older installers used mcp.servers.enabled as a feature toggle beside
      // flat server entries. It is not a named server configuration.
      continue
    }
    if (!isPlainObject(serverConfig)) {
      throw new Error(
        'Malformed MCP server entry: every flat server configuration must be an object.',
      )
    }
    if (Object.hasOwn(servers, name)) {
      throw new Error('Conflicting flat and nested MCP server entries cannot be merged safely.')
    }
    const srv = normalizeMcpServerFlags(serverConfig, 'v2')

    // Normalize legacy V2's split timeout to the V1/V2-compatible number.
    if (srv.timeout !== undefined && srv.timeout !== null) {
      if (typeof srv.timeout === 'object') {
        srv.timeout = srv.timeout.execution || srv.timeout.catalog || 30000
      }
    }

    // A shorthand inherited-server override is valid only when named directly.
    // Runtime MCP entries always have a complete config, so leave other values
    // untouched and avoid dropping user-owned servers.
    setOwn(servers, name, srv)
  }

  return { servers }
}

/**
 * Normalize the V1 `enabled` and V2 `disabled` spellings without guessing
 * when both are present. OpenCode V2 connects configured servers by default;
 * `disabled: true` is the native opt-out.
 *
 * @param {object} serverConfig
 * @param {'v1' | 'v2'} targetVersion
 * @returns {object}
 */
function normalizeMcpServerFlags(serverConfig, targetVersion) {
  const srv = { ...serverConfig }
  const hasEnabled = Object.hasOwn(srv, 'enabled')
  const hasDisabled = Object.hasOwn(srv, 'disabled')
  if (hasEnabled && typeof srv.enabled !== 'boolean') {
    throw new TypeError('MCP server enabled must be a boolean.')
  }
  if (hasDisabled && typeof srv.disabled !== 'boolean') {
    throw new TypeError('MCP server disabled must be a boolean.')
  }
  if (hasEnabled && hasDisabled && srv.enabled === srv.disabled) {
    throw new TypeError('Conflicting MCP enabled and disabled flags.')
  }

  if (targetVersion === 'v2') {
    if (hasEnabled) {
      srv.disabled = !srv.enabled
      delete srv.enabled
    }
  } else if (hasDisabled) {
    srv.enabled = !srv.disabled
    delete srv.disabled
  }
  return srv
}

/**
 * Convert V2 MCP config back to V1.
 */
function convertMcpV2toV1(mcpConfig) {
  if (!mcpConfig || typeof mcpConfig !== 'object') return mcpConfig
  const v2Servers = convertMcpV1toV2(mcpConfig)?.servers
  if (!isPlainObject(v2Servers)) return mcpConfig
  const servers = {}
  for (const [name, config] of Object.entries(v2Servers)) {
    setOwn(servers, name, normalizeMcpServerFlags(config, 'v1'))
  }
  return servers
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

/** Exact server-to-entrypoint identities written by the installer. */
export const PANTHEON_MCP_ENTRYPOINTS = Object.freeze({
  'pantheon-resources': 'mcp_resources.py',
  'pantheon-code-mode': 'code_mode.py',
  'pantheon-memory': 'memory_mcp.py',
  'pantheon-persistence': 'mcp_persistence.py',
  'pantheon-vision': 'pantheon_vision.py',
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
 * Heal only exact Pantheon MCP server/entrypoint pairs in a flat map, in place.
 * A matching script basename alone is not ownership evidence. Both `command`
 * and `args` forms are supported, while other servers and custom entrypoints
 * remain untouched.
 *
 * @param {object} mcp - the `mcp` map from a config (mutated in place)
 * @returns {number} count of rewritten strings (0 = already current)
 */
export function migrateMcpEntrypointPaths(mcp) {
  if (!mcp || typeof mcp !== 'object' || Array.isArray(mcp)) return 0

  let changed = 0
  for (const [name, server] of Object.entries(mcp)) {
    if (!server || typeof server !== 'object') continue
    const currentEntrypoint = PANTHEON_MCP_ENTRYPOINTS[name]
    if (!currentEntrypoint) continue
    const staleEntrypoint = Object.keys(MCP_ENTRYPOINT_RENAMES).find(
      (oldName) => MCP_ENTRYPOINT_RENAMES[oldName] === currentEntrypoint,
    )
    if (!staleEntrypoint) continue
    for (const field of ['command', 'args']) {
      const list = server[field]
      if (!Array.isArray(list)) continue
      for (let i = 0; i < list.length; i++) {
        const value = list[i]
        if (typeof value !== 'string') continue
        const slash = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
        if (value.slice(slash + 1) !== staleEntrypoint) continue
        const next = renameMcpEntrypointPath(value)
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
// context_sandbox: V1 top-level block → V2 plugin options
// ---------------------------------------------------------------------------
//
// `context_sandbox` is a Pantheon-owned, V1 top-level setting (src/plugin.ts
// reads `config.context_sandbox`). OpenCode V2 no longer carries custom
// top-level keys: a sandbox probe against V2.0.25 showed `context_sandbox`
// exits 0 but is SILENTLY DROPPED — identical to an arbitrary unknown key and
// with no warning — while a value nested under a plugin entry's `options`
// survives verbatim (plugin options are not schema-validated). The V2 adapter
// reads the setting as `ctx.options.context_sandbox`.
//
// So the migration DUPLICATES the V1 top-level block into the exact Pantheon V2
// plugin entry's options. The top-level block is deliberately LEFT IN PLACE so
// a user who downgrades to V1 keeps the setting. Precedence per leaf:
//   explicit V2 plugin option  >  legacy top-level fill  >  runtime defaults
// (defaults are never written by the installer — the adapter resolves them).
//
// A null or type-invalid known field is not silently coerced: the merge throws
// BEFORE the config is written, so a malformed block aborts the install instead
// of persisting a value that changes runtime behaviour.

/** Tool-keyed leaf fields of `context_sandbox.limits`. */
export const CONTEXT_SANDBOX_LIMIT_FIELDS = Object.freeze({
  read: Object.freeze(['maxLines', 'keepHead', 'keepTail']),
  grep: Object.freeze(['maxResults', 'keepTop']),
  glob: Object.freeze(['maxFiles', 'keepTop']),
  webfetch: Object.freeze(['maxChars', 'keepHead']),
})

/** @returns {boolean} true for a plain name→value map (not null/array) */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Validate one `context_sandbox` block (top-level legacy or V2 plugin option).
 *
 * `undefined` (key absent) is valid. Anything else must be a plain object with
 * an optional boolean `enabled` and an optional `limits` object whose known
 * tool groups are plain objects carrying only non-negative finite numbers.
 * Unknown keys are ignored (the runtime resolver does the same).
 *
 * @param {unknown} block
 * @param {string} label - human-readable origin, used in the thrown message
 * @throws {Error} on a null or type-invalid known field
 */
function assertSandboxBlock(block, label) {
  if (block === undefined) return
  if (!isPlainObject(block)) {
    throw new Error(`${label} must be an object when present`)
  }
  if ('enabled' in block && typeof block.enabled !== 'boolean') {
    throw new Error(`${label}.enabled must be a boolean`)
  }
  if ('limits' in block) {
    if (!isPlainObject(block.limits)) {
      throw new Error(`${label}.limits must be an object`)
    }
    for (const [tool, fields] of Object.entries(CONTEXT_SANDBOX_LIMIT_FIELDS)) {
      const group = block.limits[tool]
      if (group === undefined) continue
      if (!isPlainObject(group)) {
        throw new Error(`${label}.limits.${tool} must be an object`)
      }
      for (const field of fields) {
        if (!(field in group)) continue
        const value = group[field]
        if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
          throw new Error(`${label}.limits.${tool}.${field} must be a non-negative number`)
        }
      }
    }
  }
}

/**
 * Merge a legacy (V1 top-level) context_sandbox block into an optional explicit
 * V2 block. Values are compared per leaf, so `enabled: false` and a numeric `0`
 * are preserved (not mistaken for "unset").
 *
 * @param {object|undefined} v2Explicit - existing `plugins[...].options.context_sandbox`
 * @param {object|undefined} legacy - top-level `context_sandbox`
 * @returns {object} merged block (only keys that were actually set)
 * @throws {Error} when either block is null/type-invalid
 */
export function mergeContextSandboxBlocks(v2Explicit, legacy) {
  assertSandboxBlock(v2Explicit, 'plugins[...].options.context_sandbox')
  assertSandboxBlock(legacy, 'context_sandbox')

  const explicit = isPlainObject(v2Explicit) ? v2Explicit : {}
  const base = isPlainObject(legacy) ? legacy : {}
  const merged = {}

  if ('enabled' in explicit) merged.enabled = explicit.enabled
  else if ('enabled' in base) merged.enabled = base.enabled

  const mergedLimits = {}
  for (const [tool, fields] of Object.entries(CONTEXT_SANDBOX_LIMIT_FIELDS)) {
    const explicitGroup = isPlainObject(explicit.limits?.[tool]) ? explicit.limits[tool] : null
    const baseGroup = isPlainObject(base.limits?.[tool]) ? base.limits[tool] : null
    const group = {}
    for (const field of fields) {
      if (explicitGroup && field in explicitGroup) group[field] = explicitGroup[field]
      else if (baseGroup && field in baseGroup) group[field] = baseGroup[field]
    }
    if (Object.keys(group).length > 0) mergedLimits[tool] = group
  }
  if (Object.keys(mergedLimits).length > 0) merged.limits = mergedLimits

  return merged
}

// ---------------------------------------------------------------------------
// Top-level permissions: V1 `permission` + V2 `permissions` coexistence
// ---------------------------------------------------------------------------

/** Append converted V1 entries after existing V2 entries without reordering or deduplication. */
function mergePermissionArrays(base, incoming) {
  warnInvalidPermissionEntries(base)
  return [...base, ...incoming]
}

function assertNoConflictingV1AndV2PermissionRules(v2, convertedV1) {
  const conflicts = convertedV1.some(
    (legacy) =>
      isValidPermissionEntry(legacy) &&
      v2.some(
        (native) =>
          isValidPermissionEntry(native) &&
          legacy.effect !== native.effect &&
          opencodeWildcardPatternsOverlap(native.action, legacy.action) &&
          opencodeWildcardPatternsOverlap(native.resource, legacy.resource),
      ),
  )
  if (conflicts) {
    throw new Error(
      'Conflicting V1 and native V2 permission rules require an explicit policy choice; migration stopped.',
    )
  }
}

/**
 * Resolve top-level `permission` (V1) and `permissions` (V2) when both exist.
 *
 * When both shapes exist, the existing V2 array remains first and converted V1
 * rules are appended in source order. No rule is sorted, deduplicated, or
 * resolved by an invented restrictiveness policy.
 *
 * @param {object} config - deep-cloned input config
 * @returns {{present: boolean, value: any}}
 */
function resolveTopLevelPermissions(config, configuredMcpServers = []) {
  const hasV1 = Object.hasOwn(config, 'permission')
  const hasV2 = Object.hasOwn(config, 'permissions')
  if (!hasV1 && !hasV2) return { present: false, value: undefined }

  const v1 = hasV1 ? config.permission : undefined
  const v2 = hasV2 ? config.permissions : undefined
  const v1IsObject = isPlainObject(v1)
  const convertedV1 = v1IsObject ? convertPermissionsV1toV2(v1, configuredMcpServers) : undefined
  // An empty V1 block adds nothing to an existing V2 array.
  const hasV1Rules = Array.isArray(convertedV1) && convertedV1.length > 0

  if (!hasV2) {
    return { present: true, value: v1IsObject ? convertedV1 : v1 }
  }
  if (!Array.isArray(v2)) {
    if (v1IsObject) {
      console.warn(
        '[config-migration] "permissions" is not an array; keeping the rules converted from the V1 "permission" block instead',
      )
      return { present: true, value: convertedV1 }
    }
    return { present: true, value: v2 }
  }
  if (!hasV1) {
    warnInvalidPermissionEntries(v2)
    return { present: true, value: v2 }
  }
  if (!v1IsObject) {
    console.warn(
      '[config-migration] both "permission" and "permissions" are present; the V1 "permission" value is not an object and was ignored, keeping the V2 "permissions" array',
    )
    return { present: true, value: v2 }
  }
  if (!hasV1Rules) return { present: true, value: v2 }

  assertNoConflictingV1AndV2PermissionRules(v2, convertedV1)

  console.warn(
    '[config-migration] both "permission" (V1) and "permissions" (V2) are present; merging the V1 rules into the existing V2 array',
  )
  return { present: true, value: mergePermissionArrays(v2, convertedV1) }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Migrate a V1 opencode.json config to V2 format.
 *
 * When top-level `permission` (V1) and `permissions` (V2) coexist, the V2 array
 * is the base and the V1 rules are merged into it — see
 * `resolveTopLevelPermissions`.
 *
 * @param {object} config - V1 config object (not mutated)
 * @returns {object} V2 config object
 */
function configuredMcpServerNames(mcpConfig) {
  if (!isPlainObject(mcpConfig)) return []
  const { hasV2ServersMap, legacyServersToggle } = validateMcpV1toV2Source(mcpConfig)
  return Object.entries(mcpConfig).flatMap(([name, value]) => {
    if (hasV2ServersMap && name === 'servers') return Object.keys(value)
    if (legacyServersToggle && name === 'servers') return []
    return [name]
  })
}

export function migrateV1toV2(config, { mcpServerNames = [] } = {}) {
  const c = deepClone(config)
  // JSON cloning omits own properties whose value is undefined. Keep a present
  // MCP field visible to validation so it cannot be mistaken for absence.
  if (Object.hasOwn(config, 'mcp') && config.mcp === undefined) c.mcp = undefined
  const result = {}
  const allMcpServerNames = [...new Set([...configuredMcpServerNames(c.mcp), ...mcpServerNames])]
  const topLevelPermissions = resolveTopLevelPermissions(c, allMcpServerNames)
  let permissionsEmitted = false

  for (const [key, value] of Object.entries(c)) {
    const v2Key = V1_TO_V2_RENAMES[key] || key

    if (key === 'permission' || key === 'permissions') {
      if (topLevelPermissions.present && !permissionsEmitted) {
        result.permissions = topLevelPermissions.value
        permissionsEmitted = true
      }
    } else if (key === 'agent' && typeof value === 'object' && value !== null) {
      const agents = {}
      for (const [agentName, agentConfig] of Object.entries(value)) {
        const ac = { ...agentConfig }
        if (ac.permission && typeof ac.permission === 'object') {
          ac.permissions = convertPermissionsV1toV2(ac.permission, allMcpServerNames)
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
    } else if (key === 'mcp') {
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
