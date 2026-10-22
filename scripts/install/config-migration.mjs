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

/**
 * Action name mapping for permissions (V1 key → V2 action), including
 * task → subagent.
 *
 * `write` is an alias of `edit`. Every V2 host measured for P0-5 (2.0.22,
 * 2.0.30, 2.1.0, 2.1.2) evaluates a `write` tool call under the action name
 * `edit`; a rule emitted as `write` is therefore never the rule that decides the
 * call, and `permission.write: deny` would not block a write. Both keys collapse
 * onto `edit`, and a collision is resolved by effect restrictiveness
 * (deny > ask > allow), never by iteration order — see `pushPermission`.
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

/**
 * Effect restrictiveness used when two V1 keys collapse onto one V2 action.
 * `deny` is the most restrictive, so a deny from either alias wins.
 */
const EFFECT_RESTRICTIVENESS = { allow: 1, ask: 2, deny: 3 }

/**
 * True only for effects this module understands. `Object.hasOwn` is required:
 * an inherited key (`constructor`, `toString`, `__proto__`) is not an effect,
 * and treating it as one would rank it above `deny`.
 */
function isKnownEffect(effect) {
  return typeof effect === 'string' && Object.hasOwn(EFFECT_RESTRICTIVENESS, effect)
}

/**
 * Emission order (not restrictiveness rank) for rules that share a specificity.
 * Unknown effects sit after the known non-deny effects and before `deny`, so at
 * equal specificity `deny` is the most restrictive rule and comes last.
 */
const UNKNOWN_EFFECT_EMISSION_ORDER = 2.5

/** Resource containing any glob metacharacter. */
const GLOB_PATTERN = /[*?[\]{}]/

function effectEmissionOrder(effect) {
  return isKnownEffect(effect) ? EFFECT_RESTRICTIVENESS[effect] : UNKNOWN_EFFECT_EMISSION_ORDER
}

/** 0 = `*`, 1 = glob, 2 = literal resource. */
function resourceSpecificity(resource) {
  if (resource === '*') return 0
  return GLOB_PATTERN.test(resource) ? 1 : 2
}

/**
 * Canonical order for emitted permission rules.
 *
 * Specificity decides between DIFFERENT resources: the host resolves overlaps
 * with `last-match-wins` (measured), so rules are emitted least specific first
 * (`*` → glob → literal) and the most specific matching rule wins. Only when
 * two rules share a specificity does restrictiveness break the tie
 * (`allow` → `ask` → unknown → `deny`), keeping the more restrictive rule last.
 *
 * Same action+resource is not decided here: `resolveEffects` has already
 * merged those with `deny > ask > allow` and the unknown-effect guard.
 *
 * Code-unit tie-breaks make the output independent of the V1 object's key
 * iteration order.
 */
function comparePermissions(a, b) {
  const actionA = String(a.action)
  const actionB = String(b.action)
  if (actionA !== actionB) return actionA < actionB ? -1 : 1
  const resourceA = String(a.resource)
  const resourceB = String(b.resource)
  const bySpecificity = resourceSpecificity(resourceA) - resourceSpecificity(resourceB)
  if (bySpecificity !== 0) return bySpecificity
  const byEffect = effectEmissionOrder(a.effect) - effectEmissionOrder(b.effect)
  if (byEffect !== 0) return byEffect
  if (resourceA === resourceB) return 0
  return resourceA < resourceB ? -1 : 1
}

/** A rule the converter can order: an object with string action+resource. */
function isValidPermissionEntry(entry) {
  return (
    isPlainObject(entry) && typeof entry.action === 'string' && typeof entry.resource === 'string'
  )
}

/**
 * Report entries that are not rule objects. They cannot be compared, so they
 * are preserved verbatim (never dropped) and excluded from ordering.
 */
function warnInvalidPermissionEntries(entries) {
  const invalid = entries.filter((entry) => !isValidPermissionEntry(entry))
  if (invalid.length === 0) return
  console.warn(
    `[config-migration] ${invalid.length} malformed permission ${invalid.length === 1 ? 'entry was' : 'entries were'} preserved without sorting: ${JSON.stringify(invalid)}`,
  )
}

function sortPermissions(entries) {
  const valid = entries.filter(isValidPermissionEntry)
  const invalid = entries.filter((entry) => !isValidPermissionEntry(entry))
  warnInvalidPermissionEntries(entries)
  // Malformed entries keep their relative order at the end; they must not crash
  // the comparator, and dropping them would hide a broken config.
  return [...valid.sort(comparePermissions), ...invalid]
}

/**
 * Conservative glob matcher for a literal resource. `**` crosses `/`, `*` and
 * `?` do not; character classes are treated literally, which can only miss a
 * warning — never invent one.
 */
function globMatchesLiteral(pattern, literal) {
  if (pattern === '*') return true
  let source = '^'
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        source += '.*'
        i++
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
    }
  }
  return new RegExp(`${source}$`).test(literal)
}

/** Last matching rule for one action+resource, the way the host decides. */
function effectiveEffectAt(entries, action, resource) {
  let effect
  for (const entry of entries) {
    if (!isValidPermissionEntry(entry)) continue
    if (entry.action !== action) continue
    if (globMatchesLiteral(entry.resource, resource)) effect = entry.effect
  }
  return effect
}

/**
 * Warn when canonical ordering weakens an existing V2 decision.
 *
 * The V2 array is user state; sorting it is only done to make a V1+V2 merge
 * deterministic. If reordering alone turns a `deny` into anything weaker for a
 * resource named in that array, the user must hear about it — the config they
 * installed gated that path before the merge. The warning is informational
 * (the canonical order is still required for determinism), and only fires for
 * deny → non-deny; tightening (allow → deny) is not noise.
 */
function warnOrderingChangesEffectiveEffect(before, after) {
  // Probe each distinct resource string. A glob matches its own literal text
  // (`src/**` matches the probe `src/**`), so this covers every rule's scope
  // without inventing concrete paths.
  const probes = new Set()
  for (const entry of before) {
    if (isValidPermissionEntry(entry)) probes.add(`${entry.action}\u0000${entry.resource}`)
  }
  for (const key of probes) {
    const [action, resource] = key.split('\u0000')
    const beforeEffect = effectiveEffectAt(before, action, resource)
    const afterEffect = effectiveEffectAt(after, action, resource)
    if (beforeEffect === 'deny' && afterEffect !== 'deny') {
      console.warn(
        `[config-migration] reordering the existing V2 permissions changes ${action} "${resource}" from "deny" to "${afterEffect}" under last-match-wins; the canonical order is kept, but the deny no longer applies to that resource`,
      )
    }
  }
}

/**
 * Warn when a deny loses force under the canonical specificity order.
 *
 * A scoped allow inside a broader deny is also how the V1 format expresses an
 * intentional exception — `src/agents/mnemosyne.md` is the shipping example:
 * `"*": deny` plus `allow` in the memory bank. Warning on every such pair would
 * fire for the product's own templates and train users to ignore the warning,
 * so same-source scoping is treated as intentional and stays silent.
 *
 * The warning is reserved for overrides that cross a source boundary: a deny
 * already persisted in the V2 `permissions` array that an incoming V1 block
 * neutralises in a narrower scope, or the reverse. There the two rules were not
 * written together and the user may not realise the deny no longer applies.
 *
 * Two arbitrary globs share a specificity class, so the effect tie-break puts
 * `deny` last and they cannot relax a deny; no glob-subsumption guess is needed.
 */
function warnSuppressedPermissions(entries, sourceByEntry) {
  for (let i = 0; i < entries.length; i++) {
    const earlier = entries[i]
    if (!isValidPermissionEntry(earlier) || earlier.effect !== 'deny') continue
    const earlierResource = String(earlier.resource)
    const earlierSpecificity = resourceSpecificity(earlierResource)
    for (let j = i + 1; j < entries.length; j++) {
      const later = entries[j]
      if (!isValidPermissionEntry(later)) continue
      if (later.action !== earlier.action || later.effect === 'deny') continue
      const laterResource = String(later.resource)
      if (resourceSpecificity(laterResource) <= earlierSpecificity) continue

      const earlierSource = sourceByEntry?.get(earlier)
      const laterSource = sourceByEntry?.get(later)
      if (sourceByEntry && earlierSource === laterSource) continue

      // `*` overlaps everything; a glob only overlaps a literal it matches.
      if (earlierResource !== '*' && !globMatchesLiteral(earlierResource, laterResource)) continue

      const earlierOrigin = earlierSource ? `, ${earlierSource}` : ''
      const laterOrigin = laterSource ? `, ${laterSource}` : ''
      console.warn(
        `[config-migration] permission rule ${earlier.action} "${earlierResource}" (${earlier.effect}${earlierOrigin}) is overridden for resources matching "${laterResource}" by the later ${later.action} "${laterResource}" (${later.effect}${laterOrigin}) under last-match-wins; the deny does not apply in that scope`,
      )
    }
  }
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
function resolveEffects(current, next, label) {
  if (current === next) return current

  const currentKnown = isKnownEffect(current)
  const nextKnown = isKnownEffect(next)

  if (!currentKnown && !nextKnown) {
    console.warn(
      `[config-migration] unrecognized effects for ${label}: "${current}" vs "${next}"; keeping the first "${current}"`,
    )
    return current
  }
  if (currentKnown && !nextKnown) {
    console.warn(
      `[config-migration] unrecognized effect "${next}" for ${label} cannot replace the known effect "${current}"; keeping "${current}"`,
    )
    return current
  }
  if (!currentKnown && nextKnown) {
    console.warn(
      `[config-migration] unrecognized effect "${current}" for ${label} was replaced by the known effect "${next}"; keeping "${next}"`,
    )
    return next
  }

  const winner = EFFECT_RESTRICTIVENESS[next] > EFFECT_RESTRICTIVENESS[current] ? next : current
  console.warn(
    `[config-migration] conflicting effects for ${label}: "${current}" vs "${next}"; keeping the more restrictive "${winner}"`,
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
 * Emit one permission entry, merging with an existing entry for the same
 * action+resource instead of appending a contradiction.
 *
 * `index` maps `action\0resource` → position in `result` and is owned by the
 * caller for the duration of one conversion.
 */
function pushPermission(result, index, action, resource, effect) {
  const key = `${action}\u0000${resource}`
  const existing = index.get(key)
  if (existing === undefined) {
    index.set(key, result.length)
    result.push({ action, resource, effect })
    return
  }
  const current = result[existing]
  if (current.effect === effect) return
  current.effect = resolveEffects(current.effect, effect, `${action} "${resource}"`)
}

/**
 * Valid MCP server name. Mirrors `deriveNativeMcpPermissions`
 * (install/opencode.mjs) so the `<server>_*` action emitted here is a name the
 * host can actually produce; `*`, spaces or any other character would create an
 * action no host evaluates — a gate that only looks enforced.
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
 *   deny  → { action: "<server>_*", resource: "*", effect: "deny" }
 *   allow → { action: "<server>_*", resource: "*", effect: "allow" }
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
function convertMcpPermissions(value, result, index, { suppressAskWarning = false } = {}) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    console.warn(
      `[config-migration] permission.mcp must be an object of server → effect; got ${JSON.stringify(value)}. No MCP rule was emitted.`,
    )
    return
  }
  for (const [server, effect] of Object.entries(value)) {
    if (!MCP_SERVER_NAME_PATTERN.test(server)) {
      console.warn(
        `[config-migration] permission.mcp."${server}" is an invalid MCP server name (expected ${MCP_SERVER_NAME_PATTERN}): no rule was emitted.`,
      )
      continue
    }
    if (effect === 'deny' || effect === 'allow') {
      pushPermission(result, index, `${server}_*`, '*', effect)
      continue
    }
    if (effect === 'ask') {
      if (!suppressAskWarning) {
        console.warn(
          `[config-migration] permission.mcp."${server}" is "ask", which is not expressible for MCP on OpenCode 2.x: no rule is emitted and the server's tools remain available. Use "deny" (action "${server}_*") to gate them, or disable the server in the host MCP config.`,
        )
      }
      continue
    }
    console.warn(
      `[config-migration] permission.mcp."${server}" has unsupported effect ${JSON.stringify(effect)}; no rule was emitted.`,
    )
  }
}

/**
 * Convert V1 permission object to V2 permissions array.
 *
 * Rules are emitted in the canonical order from `comparePermissions`, not in
 * the V1 object's key order, because the host is last-match-wins.
 *
 * V1 shape:
 *   { bash: { "git *": "allow" }, edit: "allow", skill: { "*": "allow" }, websearch: "deny" }
 *
 * V2 shape:
 *   [ { action: "shell", resource: "git *", effect: "allow" }, ... ]
 */
function convertPermissionsV1toV2(permObj, options = {}) {
  const result = []
  const index = new Map()
  for (const [key, value] of Object.entries(permObj)) {
    // `permission.mcp` is a server map, not an action name: it needs its own
    // translation (see convertMcpPermissions).
    if (key === 'mcp') {
      convertMcpPermissions(value, result, index, options)
      continue
    }
    const action = Object.hasOwn(V1_PERMISSION_TO_ACTION, key) ? V1_PERMISSION_TO_ACTION[key] : key
    if (typeof value === 'string') {
      // Simple: { edit: "allow" } → [{ action: "edit", resource: "*", effect: "allow" }]
      pushPermission(result, index, action, '*', value)
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Nested: { bash: { "git *": "allow" } } → [{ action: "shell", resource: "git *", effect: "allow" }]
      for (const [resource, effect] of Object.entries(value)) {
        pushPermission(result, index, action, resource, effect)
      }
    } else {
      console.warn(`[config-migration] Unexpected permission value for "${key}":`, value)
    }
  }
  return sortPermissions(result)
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
    const label = `permission "${v1Key}" resource "${resource}"`
    rules.set(
      resource,
      rules.has(resource) ? resolveEffects(rules.get(resource), effect, label) : effect,
    )
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

/**
 * Merge converted V1 rules into an existing V2 permissions array.
 *
 * The V2 array is the base and is never discarded. Incoming rules are appended
 * when their action+resource is new, and merged with `resolveEffects` when they
 * collide, so a deny already on disk cannot be downgraded by a later rule.
 *
 * Entries carry their source while merging so `warnSuppressedPermissions` can
 * distinguish an intentional same-block scope (silent) from a cross-source
 * override that neutralises a persisted deny (warned).
 */
function mergePermissionArrays(base, incoming) {
  // Ordering is necessary for determinism once V1 rules join the array. Check
  // whether that reorder alone weakens an existing V2 decision before applying
  // it, so the change is never silent (B6).
  const validBase = base.filter(isValidPermissionEntry)
  warnOrderingChangesEffectiveEffect(validBase, sortPermissions(validBase))

  const sources = new Map()
  const result = base.map((entry) => {
    const copy = isPlainObject(entry) ? { ...entry } : entry
    sources.set(copy, 'V2 permissions')
    return copy
  })
  const index = new Map()
  result.forEach((entry, position) => {
    if (
      isPlainObject(entry) &&
      typeof entry.action === 'string' &&
      typeof entry.resource === 'string'
    ) {
      index.set(`${entry.action}\u0000${entry.resource}`, position)
    }
  })

  for (const entry of incoming) {
    if (
      !isPlainObject(entry) ||
      typeof entry.action !== 'string' ||
      typeof entry.resource !== 'string'
    ) {
      // Preserve a shape we cannot merge rather than dropping the rule.
      result.push(entry)
      sources.set(entry, 'V1 permission')
      continue
    }
    const key = `${entry.action}\u0000${entry.resource}`
    const existing = index.get(key)
    if (existing === undefined) {
      const copy = { ...entry }
      index.set(key, result.length)
      result.push(copy)
      sources.set(copy, 'V1 permission')
      continue
    }
    result[existing].effect = resolveEffects(
      result[existing].effect,
      entry.effect,
      `${entry.action} "${entry.resource}"`,
    )
  }

  const sorted = sortPermissions(result)
  warnSuppressedPermissions(sorted, sources)
  return sorted
}

/**
 * Servers `applyMcpServerEntries` seeds on every install. Their presence in
 * `mcp` means the install path already ran and reported every `ask` entry via
 * `S.mcpAskNotEnforceable`, so the migration must not repeat it: one warning
 * per server. A standalone migration has no such markers and still warns here.
 */
const INSTALLER_MCP_SERVERS = Object.freeze([
  'pantheon-resources',
  'pantheon-code-mode',
  'pantheon-memory',
  'pantheon-persistence',
  'pantheon-vision',
])

function isInstallerPrepared(config) {
  if (!isPlainObject(config) || !isPlainObject(config.mcp)) return false
  return INSTALLER_MCP_SERVERS.every((server) => Object.hasOwn(config.mcp, server))
}

/**
 * Resolve top-level `permission` (V1) and `permissions` (V2) when both exist.
 *
 * Precedence is fixed and does NOT depend on the order the keys appear in the
 * object:
 *   1. the existing V2 `permissions` array is the base (it is the target
 *      format and may already carry rules a previous install wrote);
 *   2. the converted V1 `permission` rules are merged into it;
 *   3. same action+resource conflicts resolve by restrictiveness
 *      (`deny > ask > allow`), and an unrecognized effect never replaces a
 *      known one — see `resolveEffects`.
 *
 * A V2 array with no V1 block is returned VERBATIM: reordering user state can
 * turn a `deny` into an `allow` under last-match-wins (B6), so the pure V2 path
 * never sorts. Ordering is only introduced by the merge, where determinism
 * requires it, and a weakening reorder is reported.
 *
 * @param {object} config - deep-cloned input config
 * @returns {{present: boolean, value: any}}
 */
function resolveTopLevelPermissions(config) {
  const hasV1 = Object.hasOwn(config, 'permission')
  const hasV2 = Object.hasOwn(config, 'permissions')
  if (!hasV1 && !hasV2) return { present: false, value: undefined }

  const v1 = hasV1 ? config.permission : undefined
  const v2 = hasV2 ? config.permissions : undefined
  const v1IsObject = isPlainObject(v1)
  const convertOptions = { suppressAskWarning: isInstallerPrepared(config) }
  const convertedV1 = v1IsObject ? convertPermissionsV1toV2(v1, convertOptions) : undefined
  // A V1 block that converts to zero rules (`permission: {}`, or only entries
  // that are not rules) is not a block to merge. Treating it as one used to
  // reorder a pure V2 array, which can downgrade a deny under last-match-wins.
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
export function migrateV1toV2(config) {
  const c = deepClone(config)
  const result = {}
  const topLevelPermissions = resolveTopLevelPermissions(c)
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
