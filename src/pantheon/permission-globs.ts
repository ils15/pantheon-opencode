/**
 * O5 — Permission globs for delegation (permission.task model).
 *
 * Pure library. Glob patterns control which subagents an agent may invoke
 * (routing.yml `permission.task`, e.g. `"*": "deny", "orchestrator-*":
 * "allow"`). Last matching rule wins; a deny removes the agent from the
 * delegate tool description entirely (not just blocks the call) — this
 * prevents circular delegation at the permission layer.
 *
 * @module permission-globs
 */

// ─── Types ─────────────────────────────────────────────────────────────

export type PermissionAction = 'allow' | 'deny'

/** Glob pattern → action map (insertion order = rule order). */
export type PermissionTaskConfig = Readonly<Record<string, PermissionAction>>

// ─── Glob matching ─────────────────────────────────────────────────────

/**
 * Convert a glob pattern to an anchored RegExp. `*` matches any sequence
 * (including empty), `?` matches exactly one character; everything else is
 * literal. The pattern must match the WHOLE agent name.
 */
export function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

/**
 * Evaluate a permission.task config against an agent name. Iterates rules
 * in insertion order and keeps the LAST match — last matching rule wins.
 * Returns undefined when no rule matches.
 */
export function matchPermissionRule(
  rules: PermissionTaskConfig,
  agentName: string,
): PermissionAction | undefined {
  let matched: PermissionAction | undefined
  for (const [pattern, action] of Object.entries(rules)) {
    if (globToRegExp(pattern).test(agentName)) matched = action
  }
  return matched
}

/**
 * Whether an agent may be invoked as a subagent. No rules (or empty) →
 * allowed (the existing runtime matrix still applies). Otherwise the last
 * matching rule decides; only an explicit 'allow' permits the agent.
 */
export function isAgentAllowed(
  rules: PermissionTaskConfig | undefined,
  agentName: string,
): boolean {
  if (rules === undefined || Object.keys(rules).length === 0) return true
  return matchPermissionRule(rules, agentName) === 'allow'
}

/**
 * The allowed subset of a candidate agent list — denied agents are removed
 * entirely (they never appear in the delegate tool description).
 */
export function filterAllowedAgents(
  rules: PermissionTaskConfig | undefined,
  agentNames: readonly string[],
): string[] {
  return agentNames.filter((name) => isAgentAllowed(rules, name))
}

/**
 * Render the delegate tool description's allowed-agent list. Denied agents
 * are removed entirely (not just blocked at call time).
 */
export function buildAgentListDescription(
  rules: PermissionTaskConfig | undefined,
  agentNames: readonly string[],
): string {
  const allowed = filterAllowedAgents(rules, agentNames)
  if (allowed.length === 0) return 'no subagents available (all denied by permission.task)'
  return allowed.join(', ')
}
