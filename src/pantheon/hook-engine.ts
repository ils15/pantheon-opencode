/**
 * In-process replacements for the three bash hooks the V2 tool guards used to
 * spawn per tool call (`scan-secrets.sh`, `on-subagent-delegation-start.sh`,
 * `on-subagent-delegation-stop.sh`).
 *
 * Why: the shell path cost one `bash` spawn per tool call plus two more per
 * delegation (each of those also spawning `python3` to derive JSON fields), on
 * the hot path of every tool execution. The logic is pure string processing —
 * pattern matching and log-line formatting — so it runs in this process with
 * identical observable behavior: same exit-code contract (0 allow / 1 advisory
 * / 2 block), same masked `[SECRET SCAN]` trail, same `delegations.log`
 * JSON lines, same LOG_DIR resolution order.
 *
 * What deliberately does NOT move here: `format-multi-language.sh` still
 * spawns when it can actually format (it shells out to formatters itself);
 * the in-process gate only skips the spawn for tool calls the script would
 * no-op anyway. `HOOK_TIMEOUT_MS` does not apply — these functions are
 * synchronous and bounded by the payload size, not by a child process.
 *
 * Fail-closed parity: an in-process scanner has no "missing script" failure,
 * but an unexpected internal error still refuses to produce a trustworthy
 * verdict — it returns exit-code 1 WITHOUT the `[SECRET SCAN]` marker, which
 * the existing classifier (plugin `evaluateSecretScanResult`) reads as
 * fail-closed, exactly as a broken child path always did.
 *
 * @module pantheon/hook-engine
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { HookPayload, HookResult } from '../plugins/hook-runner.ts'

/** Mirrors the scanner trail marker the classifier keys the advisory on. */
export const SECRET_SCAN_MARKER = '[SECRET SCAN]'

// Provider-specific markers are assembled at runtime so this scanner is not
// self-matched by the repository secret scan (the shell script's own trick).
const BIFROST_TOKEN_PREFIX = `${'sk'}${'-bf-'}`
const BIFROST_HEADER_NAME = `${'x'}${'-bf-'}${'vk'}`

/**
 * High-confidence token formats. MIRRORS `HIGH_CONFIDENCE_PATTERNS` in
 * scripts/hooks/scan-secrets.sh and `SECRET_MASK_RE` in src/plugin.ts
 * (V2 log masking); the drift is asserted by tests.
 */
const HIGH_CONFIDENCE_RES: readonly RegExp[] = Object.freeze([
  /AKIA[0-9A-Z]{16}/i,
  /gh[pousr]_[A-Za-z0-9_]{36,}/i,
  /glpat-[A-Za-z0-9_-]{20}/i,
  /sk-[a-zA-Z0-9]{20,}/i,
  /sk_live_[a-zA-Z0-9]{20,}/i,
  /sk_test_[a-zA-Z0-9]{20,}/i,
  /xox[baprs]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24}/i,
  /bearer\s+[a-zA-Z0-9_.-]{20,}/i,
  /eyJ[A-Za-z0-9_-]*\.eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]/,
])
const BIFROST_TOKEN_RE = new RegExp(`${BIFROST_TOKEN_PREFIX}[A-Za-z0-9_-]{8,}`, 'i')

/**
 * KEY/header names without a recognizable token value — advisory only, never
 * blocks (the script's LOW_CONFIDENCE_PATTERNS, including the Bifrost header).
 */
const LOW_CONFIDENCE_RES: readonly RegExp[] = Object.freeze([
  /[a-zA-Z0-9_-]*api[_-]?key[a-zA-Z0-9_-]*\s*[:=]\s*["']?[a-zA-Z0-9_-]{16,}["']?/,
  /[a-zA-Z0-9_-]*password[a-zA-Z0-9_-]*\s*[:=]\s*["'][^"']{8,}["']/,
  /[a-zA-Z0-9_-]*secret[a-zA-Z0-9_-]*\s*[:=]\s*["'][^"']{8,}["']/,
])
const BIFROST_HEADER_RE = new RegExp(BIFROST_HEADER_NAME, 'i')

/** First 4 + last 4 chars (len > 8), else '****' — mirrors `mask_secret`. */
export function maskSecretMatch(match: string): string {
  return match.length <= 8 ? '****' : `${match.slice(0, 4)}****${match.slice(-4)}`
}

function firstMatch(input: string, pattern: RegExp): string | null {
  const found = input.match(pattern)
  return found === null ? null : found[0]
}

/**
 * Known read-only tools: their INPUT cannot carry a secret out of the user's
 * machine (paths, patterns, ids), so scanning them was pure latency. The gate
 * is a DENYLIST — any tool this list has never heard of keeps getting scanned
 * (fail-closed for unknown names).
 */
const READ_ONLY_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'list',
  'question',
  'session_list',
  'session_read',
  'worktree_list',
  'subagent_list',
])

export function secretScanApplies(tool: unknown): boolean {
  if (typeof tool !== 'string') return true
  const normalized = tool.trim().toLowerCase()
  if (normalized === '') return true
  return !READ_ONLY_TOOLS.has(normalized)
}

/** The serialized tool input the shell scanner received as `$1`/stdin. */
function scannerInput(payload: HookPayload): string {
  if (typeof payload === 'string') return payload
  if (payload === null || payload === undefined) return ''
  const record = payload as Record<string, unknown>
  const input = record.tool_input ?? record.input ?? payload
  if (typeof input === 'string') return input
  try {
    return JSON.stringify(input)
  } catch {
    return ''
  }
}

/**
 * Run the secret scan in-process and return the same {@link HookResult} shape
 * the shell runner produced. Exit 0 → allow; 1 → advisory (marker present);
 * 2 → block. An internal error returns exit 1 WITHOUT the marker, which the
 * classifier maps to fail-closed.
 */
export function runSecretScanInProcess(payload: HookPayload): HookResult {
  try {
    const input = scannerInput(payload)
    if (input === '') return { code: 0, stdout: '', stderr: '', signal: null, timedOut: false }

    const stderr: string[] = []
    let high: string | null = null
    for (const pattern of [...HIGH_CONFIDENCE_RES, BIFROST_TOKEN_RE]) {
      const match = firstMatch(input, pattern)
      if (match !== null) {
        stderr.push(
          `${SECRET_SCAN_MARKER} High-confidence secret detected: ${maskSecretMatch(match)} (pattern: ${pattern.source})`,
        )
        high ??= match
      }
    }
    let low = false
    for (const pattern of [...LOW_CONFIDENCE_RES, BIFROST_HEADER_RE]) {
      const match = firstMatch(input, pattern)
      if (match !== null) {
        stderr.push(
          `${SECRET_SCAN_MARKER} Potential secret detected (low confidence): ${maskSecretMatch(match)} (pattern: ${pattern.source})`,
        )
        low = true
      }
    }

    if (high !== null) {
      stderr.push(
        `${SECRET_SCAN_MARKER} High-confidence hardcoded secret detected. Tool call will be BLOCKED.`,
      )
      return {
        code: 2,
        stdout: '',
        stderr: `${stderr.join('\n')}\n`,
        signal: null,
        timedOut: false,
      }
    }
    if (low) {
      stderr.push(
        `${SECRET_SCAN_MARKER} Possible secret detected. Remove it and use environment variables or a vault.`,
      )
      return {
        code: 1,
        stdout: '',
        stderr: `${stderr.join('\n')}\n`,
        signal: null,
        timedOut: false,
      }
    }
    return { code: 0, stdout: '', stderr: '', signal: null, timedOut: false }
  } catch {
    // Fail-closed: a verdict we cannot trust denies. Exit 1 with no marker.
    return {
      code: 1,
      stdout: '',
      stderr: 'in-process secret scan failed',
      signal: null,
      timedOut: false,
    }
  }
}

// ─── Delegation audit log ───────────────────────────────────────────────

/** Same resolution order as the shell scripts' LOG_DIR block. */
export function resolveDelegationLogDir(
  env: Record<string, string | undefined> = process.env,
): string {
  if (env.LOG_DIR) return env.LOG_DIR
  if (env.XDG_STATE_HOME) return join(env.XDG_STATE_HOME, 'pantheon', 'hooks')
  if (env.PANTHEON_HOME) return join(env.PANTHEON_HOME, 'logs', 'agent-sessions')
  if (env.PANTHEON_PROJECT) return join(env.PANTHEON_PROJECT, 'logs', 'agent-sessions')
  return join('logs', 'agent-sessions')
}

function delegationTimestamp(now: number): string {
  return `${new Date(now).toISOString().slice(0, 19)}Z`
}

/** Append one JSON audit line; best-effort, never throws. */
export function appendDelegationAuditLine(line: Record<string, unknown>): boolean {
  try {
    const dir = resolveDelegationLogDir()
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'delegations.log'), `${JSON.stringify(line)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** Build the `SubagentStart` audit line (same fields as the shell script). */
export function delegationStartLine(fields: {
  agent: string
  task: string
  sessionID: string
  delegationID: string
  now: number
}): Record<string, unknown> {
  return {
    event: 'SubagentStart',
    timestamp: delegationTimestamp(fields.now),
    agent: fields.agent,
    task: fields.task === '' ? fields.agent : fields.task,
    session_id: fields.sessionID,
    delegation_id: fields.delegationID,
  }
}

/** Build the `SubagentStop` audit line (same fields, duration as a number). */
export function delegationStopLine(fields: {
  agent: string
  status: string
  reason: string
  task: string
  sessionID: string
  result: unknown
  delegationID: string
  taskID: string
  durationMs: number | null
  now: number
}): Record<string, unknown> {
  return {
    event: 'SubagentStop',
    timestamp: delegationTimestamp(fields.now),
    agent: fields.agent,
    status: fields.status,
    reason: fields.reason,
    task: fields.task === '' ? fields.agent : fields.task,
    session_id: fields.sessionID,
    result: fields.result ?? null,
    delegation_id: fields.delegationID,
    ...(fields.taskID === '' ? {} : { task_id: fields.taskID }),
    ...(fields.durationMs === null ? {} : { duration_ms: fields.durationMs }),
  }
}

// ─── Formatter applicability gate ───────────────────────────────────────

/** Extensions `format-multi-language.sh` actually formats; others no-op. */
const FORMATTABLE_EXTENSIONS = new Set([
  '.py',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yml',
  '.yaml',
  '.toml',
])

function formattablePath(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false
  const dot = value.lastIndexOf('.')
  if (dot <= value.lastIndexOf('/')) return false
  return FORMATTABLE_EXTENSIONS.has(value.slice(dot).toLowerCase())
}

/**
 * Whether `format-multi-language.sh` would do anything for this tool call.
 * The script no-ops for every other tool; skipping the spawn for those is the
 * whole point of this gate.
 */
export function formatterApplies(tool: string, input: unknown): boolean {
  const normalized = tool.trim().toLowerCase()
  if (normalized === 'edit' || normalized === 'write' || normalized === 'hashline_edit') {
    if (input !== null && typeof input === 'object') {
      return formattablePath((input as Record<string, unknown>).file_path)
    }
    return false
  }
  if (normalized === 'bash') {
    // The script scans the command for rewritten paths; the conservative gate
    // lets bash through unchanged (rare, and correctness beats micro-gains).
    return true
  }
  return false
}
