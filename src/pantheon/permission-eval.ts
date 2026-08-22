/**
 * S1 — Deny-first permission evaluation + PreToolUse-style hooks.
 *
 * Deny rules checked BEFORE allow rules. User-level denies cannot be
 * overridden by project config. Hook exit-code semantics:
 *   exit 0 → allow, exit 2 → hard deny, missing/throw → fail-open.
 *
 * @module permission-eval
 */

// ─── Types ─────────────────────────────────────────────────────────────

/** Result of a permission evaluation. */
export interface PermissionResult {
  allowed: boolean
  reason: 'allow' | 'deny' | 'hook_deny' | 'no_match'
  message?: string
}

/** Hook script result (mirrors hook-runner.ts HookResult). */
export interface HookResult {
  code: number
  stdout: string
  stderr: string
  /** When true, the hook script was not found — treat as fail-open. */
  missing?: boolean
}

/**
 * PreToolUse hook function signature.
 * exit 0 → allow, exit 2 → hard deny, exit 1 → soft deny.
 * Throw = fail-open.
 */
export type PreToolUseHook = (
  tool: string,
  args: unknown,
) => Promise<HookResult> | HookResult

/** Permission configuration. */
export interface PermissionConfig {
  /** Deny rules — evaluated first. User-level denies override project allows. */
  deny: readonly string[]
  /** Allow rules — evaluated after deny. */
  allow: readonly string[]
  /** Optional hooks configuration. */
  hooks?: {
    /** PreToolUse hook function (in-process, not script path). */
    preToolUse?: PreToolUseHook
  }
}

// ─── Pattern matching ──────────────────────────────────────────────────

/**
 * Parse a permission rule pattern into { tool, argPattern }.
 *
 * Supported formats:
 *   - "tool"             → tool="tool", argPattern="*"
 *   - "tool:*"           → tool="tool", argPattern="*"
 *   - "tool:subcommand"  → tool="tool", argPattern="subcommand"
 *   - "tool(pattern)"    → tool="tool", argPattern="pattern" (full match)
 *   - "*:*"              → tool="*", argPattern="*"
 *   - "git push:*"       → tool="git push", argPattern="*" (subcommand prefix)
 */
function parsePattern(pattern: string): { tool: string; argPattern: string } {
  // Handle "tool(pattern)" format — the content inside parens is the full
  // arg pattern. Colons inside parens are literal, not separators.
  const parenMatch = /^([^(]+)\(([^)]+)\)$/.exec(pattern)
  if (parenMatch) {
    const tool = parenMatch[1] ?? ''
    const argPattern = parenMatch[2] ?? ''
    return { tool, argPattern }
  }

  // Handle "tool:argPattern" or just "tool"
  const colonIdx = pattern.indexOf(':')
  if (colonIdx === -1) {
    return { tool: pattern, argPattern: '*' }
  }
  const argPattern = pattern.slice(colonIdx + 1)
  return {
    tool: pattern.slice(0, colonIdx),
    // Empty argPattern after colon = wildcard (e.g. "*:" matches any args)
    argPattern: argPattern === '' ? '*' : argPattern,
  }
}

/**
 * Convert a glob-like pattern to a regex. `*` matches any sequence.
 * Anchored to full match.
 */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

/** Extract a string representation from tool args for pattern matching. */
function argsToString(args: unknown): string {
  if (args === null || args === undefined) return ''
  if (typeof args === 'string') return args
  if (typeof args === 'object') {
    const record = args as Record<string, unknown>
    // Try common field names
    for (const key of ['command', 'cmd', 'query', 'pattern', 'filePath', 'path', 'url']) {
      if (typeof record[key] === 'string') return record[key]
    }
    return JSON.stringify(args)
  }
  return String(args)
}

/**
 * Build a combined string for matching: "toolName argString".
 * This allows patterns like "git push:*" to match tool="git" with args
 * containing "push".
 */
function combinedString(tool: string, args: unknown): string {
  const argsStr = argsToString(args)
  return argsStr !== '' ? `${tool} ${argsStr}` : tool
}

/**
 * Check if a tool+args matches a permission rule pattern.
 * Returns true when the pattern matches.
 *
 * Matching strategy:
 *   1. Wildcard tool ("*") → match any tool with argPattern
 *   2. Direct tool match → check argPattern against args
 *   3. Combined match (for "git push:*" style patterns) → prefix match
 */
function matchesRule(
  pattern: string,
  tool: string,
  args: unknown,
): boolean {
  const { tool: patternTool, argPattern } = parsePattern(pattern)

  // Wildcard tool: match any tool
  if (patternTool === '*') {
    if (argPattern === '*') return true
    const argsStr = argsToString(args)
    return globToRegex(argPattern).test(argsStr)
  }

  // Check direct tool match
  if (globToRegex(patternTool).test(tool)) {
    if (argPattern === '*') return true
    const argsStr = argsToString(args)
    return globToRegex(argPattern).test(argsStr)
  }

  // Combined match for patterns with spaces (e.g. "git push:*")
  // The pattern tool includes a subcommand that appears in args.
  // Use prefix matching: "git push" matches "git push origin main"
  if (patternTool.includes(' ')) {
    const combined = combinedString(tool, args)
    // Prefix match: combined starts with pattern tool
    if (combined.startsWith(patternTool)) {
      return true
    }
  }

  return false
}

// ─── Evaluation ────────────────────────────────────────────────────────

/**
 * Evaluate a permission config against a tool+args invocation.
 *
 * Evaluation order:
 *   1. Check deny rules (user-level first, then project-level)
 *   2. If no deny matched, run the PreToolUse hook
 *   3. If hook exits 0 (or missing), check allow rules
 *   4. If no allow matched → deny (implicit deny)
 *
 * User-level denies override project-level allows: a deny in the user config
 * cannot be cancelled by an allow in the project config.
 */
export function evaluatePermission(
  config: PermissionConfig,
  invocation: { tool: string; args?: unknown },
): PermissionResult {
  const { tool, args } = invocation

  // ── Step 1: Deny-first check ────────────────────────────────────────
  for (const pattern of config.deny) {
    if (matchesRule(pattern, tool, args)) {
      return { allowed: false, reason: 'deny', message: `denied by rule: ${pattern}` }
    }
  }

  // ── Step 2: PreToolUse hook ─────────────────────────────────────────
  if (config.hooks?.preToolUse !== undefined) {
    try {
      const hookResult = config.hooks.preToolUse(tool, args)
      // Support both sync and async hooks
      // For sync hooks (non-Promise), check immediately
      if (!(hookResult instanceof Promise)) {
        // missing flag: hook script not found → fail-open
        if (hookResult.missing === true) {
          // Fall through to config evaluation (fail-open)
        } else if (hookResult.code === 2) {
          return {
            allowed: false,
            reason: 'hook_deny',
            message: `hook hard deny (exit 2): ${hookResult.stderr}`,
          }
        } else if (hookResult.code !== 0) {
          return {
            allowed: false,
            reason: 'hook_deny',
            message: `hook deny (exit ${hookResult.code}): ${hookResult.stderr}`,
          }
        }
        // Hook exited 0 (or missing) → fall through to allow check
      }
      // For async hooks, we cannot await in a sync function.
      // Use evaluatePermissionAsync for async hooks.
    } catch {
      // Hook throw → fail-open: fall through to config evaluation
    }
  }

  // ── Step 3: Allow check ─────────────────────────────────────────────
  for (const pattern of config.allow) {
    if (matchesRule(pattern, tool, args)) {
      return { allowed: true, reason: 'allow', message: `allowed by rule: ${pattern}` }
    }
  }

  // ── Step 4: No match → implicit deny ────────────────────────────────
  return { allowed: false, reason: 'no_match', message: 'no matching allow rule' }
}

/**
 * Async version of evaluatePermission that properly awaits hooks.
 * Use this when hooks may be async (e.g., shell scripts).
 */
export async function evaluatePermissionAsync(
  config: PermissionConfig,
  invocation: { tool: string; args?: unknown },
): Promise<PermissionResult> {
  const { tool, args } = invocation

  // ── Step 1: Deny-first check ────────────────────────────────────────
  for (const pattern of config.deny) {
    if (matchesRule(pattern, tool, args)) {
      return { allowed: false, reason: 'deny', message: `denied by rule: ${pattern}` }
    }
  }

  // ── Step 2: PreToolUse hook ─────────────────────────────────────────
  if (config.hooks?.preToolUse !== undefined) {
    try {
      const hookResult = await config.hooks.preToolUse(tool, args)
      // missing flag: hook script not found → fail-open
      if (hookResult.missing === true) {
        // Fall through to config evaluation (fail-open)
      } else if (hookResult.code === 2) {
        return {
          allowed: false,
          reason: 'hook_deny',
          message: `hook hard deny (exit 2): ${hookResult.stderr}`,
        }
      } else if (hookResult.code !== 0) {
        return {
          allowed: false,
          reason: 'hook_deny',
          message: `hook deny (exit ${hookResult.code}): ${hookResult.stderr}`,
        }
      }
      // Hook exited 0 (or missing) → fall through to allow check
    } catch {
      // Hook throw → fail-open: fall through to config evaluation
    }
  }

  // ── Step 3: Allow check ─────────────────────────────────────────────
  for (const pattern of config.allow) {
    if (matchesRule(pattern, tool, args)) {
      return { allowed: true, reason: 'allow', message: `allowed by rule: ${pattern}` }
    }
  }

  // ── Step 4: No match → implicit deny ────────────────────────────────
  return { allowed: false, reason: 'no_match', message: 'no matching allow rule' }
}
