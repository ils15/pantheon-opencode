/**
 * Auto-Permissions Engine — Intelligent Scope Governance.
 *
 * Intercepts OpenCode V2 permission evaluation events. When an action lands in
 * `ask` status (permission prompt fatigue), it evaluates whether the requested
 * tool or shell command is a safe, routine development action within the
 * workspace.
 *
 * Rules:
 * 1. Hard deny preservation: explicit host `deny` is NEVER overridden.
 * 2. Catastrophic command rejection: dangerous operations (`rm -rf /`, `sudo`,
 *    arbitrary remote execution `curl | sh`, system path alteration) are strictly denied.
 * 3. Read-only role isolation: read-only agents (`zeus`, `athena`, `apollo`, `gaia`)
 *    are never permitted to execute mutating tools or arbitrary shell commands.
 * 4. Safe dev tool grant: routine developer commands (`node`, `python3`, `npm`,
 *    `git`, `mkdir`, `cat`, `ls`, local test scripts, etc.) and Pantheon native
 *    tools (`todowrite`, `pantheon_*`) are auto-approved without prompting.
 * 5. Kill-switch: `PANTHEON_AUTO_PERMISSIONS=off` leaves `ask` untouched.
 *
 * @module auto-permissions
 */

export interface AutoPermissionEvent {
  action?: unknown
  resources?: unknown
  agent?: unknown
  sessionID?: unknown
  effect?: unknown
  message?: unknown
}

export interface AutoPermissionOptions {
  cwd?: string
  env?: Record<string, string | undefined>
}

export interface AutoPermissionResult {
  decision:
    | 'allow'
    | 'deny'
    | 'preserve-deny'
    | 'preserve-allow'
    | 'passthrough'
    | 'disabled'
    | 'unconstrained-suite'
  reason?: string
}

/** Agents strictly forbidden from mutating workspace files or executing arbitrary shell commands. */
const READ_ONLY_AGENTS: ReadonlySet<string> = new Set(['zeus', 'athena', 'apollo', 'gaia'])

/** Allowed binary names for routine workspace development. */
const SAFE_DEV_BINARIES: ReadonlySet<string> = new Set([
  'git',
  'npm',
  'npx',
  'node',
  'python',
  'python3',
  'pytest',
  'ruff',
  'cat',
  'ls',
  'mkdir',
  'cp',
  'mv',
  'touch',
  'grep',
  'find',
  'head',
  'tail',
  'diff',
  'echo',
  'which',
  'tar',
  'zip',
  'unzip',
  'curl',
  'jq',
  'sed',
  'awk',
  'biome',
  'tsc',
  'pnpm',
  'yarn',
  'bun',
  'cargo',
  'go',
  'sh',
  'bash',
])

/** Check if auto-permissions engine is enabled in environment. */
export function autoPermissionsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const val = (env.PANTHEON_AUTO_PERMISSIONS ?? '').trim().toLowerCase()
  return val !== 'off' && val !== '0' && val !== 'false'
}

/** Check if a command matches high-risk destructive or privilege escalation patterns. */
export function isDangerousCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false

  // Privilege escalation
  if (/\bsudo\b/.test(trimmed)) return true

  // Destructive recursive deletion targeting root, all root items, or user home
  if (
    /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r|--force)\s+(\/\s*$|\/\*\s*$|~\/?\s*$|\$HOME)/.test(
      trimmed,
    )
  )
    return true

  // Remote execution via piping to shell
  if (/(curl|wget)\b.*\|\s*(ba)?sh\b/.test(trimmed)) return true

  // Raw disk formatting or writing
  if (/\bmkfs(\.[a-z0-9]+)?\b/.test(trimmed)) return true
  if (/\bdd\s+if=/.test(trimmed)) return true

  // Global permissions tampering
  if (/\bchmod\s+(-[a-zA-Z]*R[a-zA-Z]*\s+)?777\s+\//.test(trimmed)) return true

  // Sensitive system directory writes
  if (/\b(>\s*|\bcp\b.*|\bmv\b.*)\s+\/(etc|boot|sys|proc|root|usr)(\/|$)/.test(trimmed)) return true

  return false
}

/** Check if a command is a standard dev command within workspace. */
export function isSafeDevCommand(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false
  if (isDangerousCommand(trimmed)) return false

  // Extract the primary command tokens (before flags/arguments, handling simple env prefixes)
  const segments = trimmed.split(/[|&;]/)
  for (const rawSeg of segments) {
    const seg = rawSeg.trim()
    if (!seg) continue

    const tokens = seg.split(/\s+/).filter(Boolean)
    let binary = tokens[0] ?? ''

    // Skip environment assignments like FOO=bar node ...
    let tokenIdx = 0
    while (binary.includes('=') && tokenIdx < tokens.length - 1) {
      tokenIdx += 1
      binary = tokens[tokenIdx] ?? ''
    }

    const cleanBinary = binary.replace(/^.*\//, '')
    if (!SAFE_DEV_BINARIES.has(cleanBinary)) {
      return false
    }
  }

  return true
}

/**
 * Detect unconstrained repository-wide test suite invocations.
 *
 * During active dev/fix/implementation loops, unconstrained test suites cause
 * massive latency, timeouts, and token waste (Issue #437). Auto-permissions
 * holds these in 'ask' so agents cannot silently burn minutes running hundreds
 * of unrelated tests without explicit user intent or visible scope justification.
 */
export function isUnconstrainedTestSuite(command: string): boolean {
  const trimmed = command.trim()
  if (!trimmed) return false

  // Unconstrained npm test (without arguments or slice flags)
  // Matches: npm test, npm run test, npm run test:all, pnpm test, yarn test, bun test
  if (/^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|test:all)(\s+--)?\s*$/.test(trimmed)) {
    return true
  }

  // Unconstrained pytest (without -k, -m, or specific test path)
  if (/^(python3?\s+-m\s+)?pytest\s*$/.test(trimmed)) {
    return true
  }

  // Unconstrained vitest or jest (without file path or filter)
  if (/^(npx\s+)?(vitest|jest)(\s+run)?\s*$/.test(trimmed)) {
    return true
  }

  // Unconstrained cargo test
  if (/^cargo\s+test\s*$/.test(trimmed)) {
    return true
  }

  return false
}

/**
 * Evaluate an OpenCode V2 permission evaluation event.
 * If safe to auto-allow, sets `event.effect = 'allow'`.
 */
export function evaluateAutoPermission(
  event: AutoPermissionEvent,
  options: AutoPermissionOptions = {},
): AutoPermissionResult {
  const env = options.env ?? process.env
  if (!autoPermissionsEnabled(env)) {
    return { decision: 'disabled' }
  }

  if (event.effect === 'deny') {
    return { decision: 'preserve-deny' }
  }

  if (event.effect === 'allow') {
    return { decision: 'preserve-allow' }
  }

  const action = String(event.action ?? '')
    .toLowerCase()
    .trim()
  const agent = String(event.agent ?? '')
    .toLowerCase()
    .trim()

  // 1. Native Pantheon tools and Todo tools are always auto-allowed
  if (
    action === 'todowrite' ||
    action === 'todoread' ||
    action === 'pantheon_deepwork' ||
    action.startsWith('pantheon_')
  ) {
    event.effect = 'allow'
    return { decision: 'allow', reason: 'pantheon-native-tool' }
  }

  // 2. Read-only agents are strictly prohibited from mutating tools or shell
  if (READ_ONLY_AGENTS.has(agent)) {
    if (['edit', 'write', 'hashline_edit', 'bash', 'shell'].includes(action)) {
      event.effect = 'deny'
      event.message = `Pantheon auto-permissions denied: read-only agent '${agent}' cannot execute mutating action '${action}'`
      return { decision: 'deny', reason: 'read-only-role-violation' }
    }
  }

  // 3. Read-only inspection tools are safe within workspace (excluding network/external URLs)
  if (['read', 'glob', 'grep', 'webfetch', 'question'].includes(action)) {
    const firstResource =
      Array.isArray(event.resources) && typeof event.resources[0] === 'string'
        ? event.resources[0]
        : ''
    if (firstResource.startsWith('http://') || firstResource.startsWith('https://')) {
      return { decision: 'passthrough' }
    }
    event.effect = 'allow'
    return { decision: 'allow', reason: 'safe-read-action' }
  }

  // 4. Shell commands
  if (action === 'bash' || action === 'shell') {
    const rawCmd =
      Array.isArray(event.resources) && typeof event.resources[0] === 'string'
        ? event.resources[0]
        : ''

    if (rawCmd) {
      if (isDangerousCommand(rawCmd)) {
        event.effect = 'deny'
        event.message =
          'Pantheon auto-permissions denied: destructive or privilege-escalating command'
        return { decision: 'deny', reason: 'dangerous-command' }
      }

      if (isUnconstrainedTestSuite(rawCmd)) {
        event.effect = 'ask'
        event.message =
          'Pantheon test-economy: unconstrained test suite detected in dev loop. ' +
          'Use a focused test slice (sub-10s) or provide scope justification.'
        return {
          decision: 'unconstrained-suite',
          reason: 'unconstrained-test-suite-forbidden-in-dev-loop',
        }
      }

      if (isSafeDevCommand(rawCmd)) {
        event.effect = 'allow'
        return { decision: 'allow', reason: 'safe-dev-command' }
      }
    }
  }

  // 5. File mutations for implementation agents
  if (['edit', 'write', 'hashline_edit'].includes(action)) {
    if (!READ_ONLY_AGENTS.has(agent)) {
      event.effect = 'allow'
      return { decision: 'allow', reason: 'implementer-workspace-edit' }
    }
  }

  return { decision: 'passthrough' }
}
