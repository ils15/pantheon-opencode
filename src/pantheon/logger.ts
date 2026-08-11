/**
 * Pantheon plugin logger — silence-by-default TUI policy (shared with
 * pantheon-hooks, see src/plugins/pantheon-hooks.ts L42-58).
 *
 * WHY: `console.log`/`console.error` in an opencode plugin writes to the
 * process stdout/stderr, which the TUI renders DIRECTLY into the terminal —
 * the user-visible "lixo" (e.g. `[Pantheon Plugin] Board terminal: ...` in
 * the TUI footer). Every Pantheon module therefore routes its logs through
 * this helper:
 *
 *   1. ALWAYS append one ISO-stamped, module-prefixed line to the
 *      project-local `.pantheon/logs/hooks.log` (same file pantheon-hooks
 *      uses, so the plugin trail stays auditable on disk);
 *   2. echo to the console ONLY when `PANTHEON_HOOKS_LOG=1` (or any truthy
 *      value — same env var pantheon-hooks uses; read at creation time).
 *
 * All channels are best-effort and fire-and-forget: a logging failure must
 * never break the plugin, and an unhandled rejection could itself pollute
 * the TUI, so writes are swallowed.
 *
 * Pure TypeScript — zero external deps beyond Node.js builtins (fs/path).
 *
 * @module logger
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface PantheonLoggerOptions {
  /** Module tag prefixed to every line (e.g. 'pantheon-plugin'). */
  module: string
  /**
   * Env gate for the console echo — truthy means echo in addition to the
   * log file. Defaults to `process.env.PANTHEON_HOOKS_LOG` (read at
   * creation), matching the pantheon-hooks policy. Injectable for tests.
   */
  env?: string | undefined
  /**
   * Project directory — the log lands at `<logDir>/.pantheon/logs/hooks.log`.
   * Defaults to `process.cwd()` (opencode runs plugins with cwd = project,
   * consistent with the plugin's other relative `.pantheon/...` paths).
   */
  logDir?: string | undefined
}

export interface PantheonLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

const LOG_LEVELS = ['info', 'warn', 'error'] as const
type LogLevel = (typeof LOG_LEVELS)[number]

/** Console method per level — info maps to console.log (the only console touch). */
const CONSOLE_METHODS: Record<LogLevel, 'log' | 'warn' | 'error'> = {
  info: 'log',
  warn: 'warn',
  error: 'error',
}

/** Serialize a log arg — Errors to stack/message, never "[object Object]". */
function formatArg(arg: unknown): string {
  if (arg instanceof Error) return arg.stack ?? arg.message
  if (typeof arg === 'string') return arg
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

/**
 * Append one ISO-stamped line to the hooks.log. Multi-line messages are
 * split so EVERY line carries the stamp (pantheon-hooks appendHookLog
 * pattern). Throws only on IO failure — callers swallow.
 */
async function appendToLog(logPath: string, prefix: string, args: unknown[]): Promise<void> {
  const body = [prefix, ...args.map(formatArg)].join(' ')
  const stamp = new Date().toISOString()
  const lines = body
    .split('\n')
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .map((p) => `[${stamp}] ${p}`)
  if (lines.length === 0) return
  await mkdir(dirname(logPath), { recursive: true })
  await appendFile(logPath, `${lines.join('\n')}\n`, 'utf8')
}

/**
 * Create a module logger. Every level writes to the log file ALWAYS and
 * echoes to the console only when the env gate is truthy. Fire-and-forget:
 * returns void, never throws.
 */
export function createPantheonLogger(options: PantheonLoggerOptions): PantheonLogger {
  const echo = (options.env ?? process.env.PANTHEON_HOOKS_LOG ?? '').trim() !== ''
  const logPath = join(options.logDir ?? process.cwd(), '.pantheon', 'logs', 'hooks.log')

  const write = (level: LogLevel, message: string, args: unknown[]): void => {
    void appendToLog(logPath, `[${options.module}] ${message}`, args).catch(() => {
      // Best-effort file log — never break the plugin over logging.
    })
    if (echo) {
      // Opt-in debug echo (PANTHEON_HOOKS_LOG=1). Off by default: console
      // output in a plugin renders into the opencode TUI (the pollution bug).
      const consoleMethod = CONSOLE_METHODS[level]
      console[consoleMethod](`[${options.module}] ${message}`, ...args)
    }
  }

  return {
    info: (message, ...args) => write('info', message, args),
    warn: (message, ...args) => write('warn', message, args),
    error: (message, ...args) => write('error', message, args),
  }
}
