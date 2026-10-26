import { opencodeWildcardPatternsOverlap } from './opencode-wildcard.mjs'

/** Canonical OpenCode V2 MCP action-name normalization shared by all writers. */

export function normalizeMcpPermissionSegment(value) {
  return value.replace(/[^a-zA-Z0-9_]/g, '_')
}

/** V1 spellings support V1 hosts; normalized spellings are required by V2. */
export function mcpPermissionAliases(value) {
  return [...new Set([value, normalizeMcpPermissionSegment(value)])]
}

export function mcpServerPermissionActions(server) {
  return mcpPermissionAliases(server).map((alias) => `${alias}_*`)
}

/**
 * These generated action patterns are all fixed prefixes followed by `*`.
 * Their languages intersect exactly when one fixed prefix contains the other.
 */
export function mcpPermissionActionPatternsOverlap(left, right) {
  return opencodeWildcardPatternsOverlap(left, right)
}

export function mcpServerPermissionScopesOverlap(left, right) {
  return mcpServerPermissionActions(left).some((leftAction) =>
    mcpServerPermissionActions(right).some((rightAction) =>
      mcpPermissionActionPatternsOverlap(leftAction, rightAction),
    ),
  )
}

/** Refuse distinct V1 server names whose generated action globs overlap in V2. */
export function assertMcpServerPermissionScopesUnambiguous(rules) {
  for (let leftIndex = 0; leftIndex < rules.length; leftIndex += 1) {
    const left = rules[leftIndex]
    for (let rightIndex = leftIndex + 1; rightIndex < rules.length; rightIndex += 1) {
      const right = rules[rightIndex]
      if (
        left.server !== right.server &&
        mcpServerPermissionScopesOverlap(left.server, right.server)
      ) {
        throw new TypeError(
          'Distinct MCP permission server scopes overlap after OpenCode V2 action normalization.',
        )
      }
    }
  }
}

/** Refuse policy scopes that also match a distinct configured MCP server. */
export function assertMcpPermissionScopesDoNotAliasConfiguredServers(
  policyServers,
  configuredServers,
) {
  for (const policyServer of policyServers) {
    for (const configuredServer of configuredServers) {
      if (
        policyServer !== configuredServer &&
        mcpServerPermissionScopesOverlap(policyServer, configuredServer)
      ) {
        throw new TypeError(
          'An MCP permission scope overlaps a distinct configured server after OpenCode V2 action normalization.',
        )
      }
    }
  }
}

/**
 * Agent MCP metadata emits default server denies and then explicit grants.
 * Refuse grants that can also match a different server's denied action scope.
 */
export function assertMcpPermissionServerGrantsUnambiguous(servers) {
  const scopes = servers.map(({ server, tools }) => ({
    server,
    tools,
    effect: tools === 'all' ? 'allow' : 'deny',
  }))

  for (let leftIndex = 0; leftIndex < scopes.length; leftIndex += 1) {
    const left = scopes[leftIndex]
    for (let rightIndex = leftIndex + 1; rightIndex < scopes.length; rightIndex += 1) {
      const right = scopes[rightIndex]
      if (
        left.effect !== right.effect &&
        mcpServerPermissionScopesOverlap(left.server, right.server)
      ) {
        throw new TypeError('Overlapping MCP permission scopes have conflicting agent effects.')
      }
    }
  }

  for (const grant of scopes) {
    if (!Array.isArray(grant.tools)) continue
    const grantActions = grant.tools.flatMap((tool) =>
      mcpPermissionAliases(grant.server).flatMap((serverAlias) =>
        mcpPermissionAliases(tool).map((toolAlias) => `${serverAlias}_${toolAlias}`),
      ),
    )
    for (const deny of scopes) {
      if (grant.server === deny.server || deny.effect !== 'deny') continue
      if (
        grantActions.some((action) =>
          mcpServerPermissionActions(deny.server).some((scope) =>
            mcpPermissionActionPatternsOverlap(action, scope),
          ),
        )
      ) {
        throw new TypeError('An MCP tool grant overlaps a different server deny scope.')
      }
    }
  }
}

/** Refuse generated MCP allows that would replace an explicit agent deny/ask. */
export function assertMcpGeneratedPermissionsDoNotWeakenExplicitRules(explicit, generated) {
  if (explicit === undefined) return
  if (explicit === null || typeof explicit !== 'object' || Array.isArray(explicit)) {
    throw new TypeError(
      'Explicit agent permissions must be an object when combined with mcp_tools.',
    )
  }

  const grants = Object.entries(generated).filter(([, effect]) => effect === 'allow')
  if (grants.length === 0) return

  for (const [action, rule] of Object.entries(explicit)) {
    if (!grants.some(([grantAction]) => opencodeWildcardPatternsOverlap(action, grantAction))) {
      continue
    }
    const isResourceMap = rule !== null && typeof rule === 'object' && !Array.isArray(rule)
    if (typeof rule !== 'string' && !isResourceMap) {
      throw new TypeError(
        'An overlapping explicit agent permission cannot be safely combined with mcp_tools.',
      )
    }
    const effects = typeof rule === 'string' ? [rule] : isResourceMap ? Object.values(rule) : []
    if (effects.some((effect) => !['allow', 'ask', 'deny'].includes(effect))) {
      throw new TypeError(
        'An overlapping explicit agent permission cannot be safely combined with mcp_tools.',
      )
    }
    if (effects.some((effect) => effect === 'deny' || effect === 'ask')) {
      throw new TypeError(
        'A generated MCP grant overlaps an explicit agent deny or ask permission.',
      )
    }
  }
}

/** Refuse names whose V2-normalized action cannot distinguish their source. */
export function assertMcpPermissionNamesUnambiguous(names) {
  const normalizedOwners = new Map()
  for (const name of names) {
    const normalized = normalizeMcpPermissionSegment(name)
    const owner = normalizedOwners.get(normalized)
    if (owner !== undefined && owner !== name) {
      throw new TypeError('MCP names collide after OpenCode V2 permission normalization.')
    }
    normalizedOwners.set(normalized, name)
  }
}
