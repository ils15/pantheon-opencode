/**
 * Command Normalizer (Fase 1) — deterministic `python` → `python3` rewrite.
 *
 * Ubuntu 20.04+ ships only `python3` (PEP 394); the bare `python` command does
 * not exist. Agents frequently emit `python` instead of `python3`, so every
 * `bash` command is normalized BEFORE execution via the `tool.execute.before`
 * hook. Unlike the read-only enforcement guard (which THROWS to deny), this
 * guard REWRITES the command in place and lets it run.
 *
 * The rewrite is anchored to the regex below — it only matches `python` as a
 * standalone command token (start of line or after a shell delimiter), never
 * as a substring. This is what keeps `pip install python-dateutil` intact.
 *
 * @module command-normalizer
 */

// Matches `python` as a command token: at the start of the command or after a
// shell delimiter (`;`, `&`, `|`, `(`, `)`, or a quote), followed by
// whitespace or end. Quotes are included so `bash -c "python foo"` (a common
// bypass) is normalized too. Deliberately NOT `\bpython\b` — that would
// corrupt `python-dateutil` in `pip install python-dateutil` (the `-` is a
// word boundary).
const PYTHON_NORMALIZE_RE = /(^|[\s;&|()"'])python([\s]|$)/g

/** Result of normalizing a command string. */
export interface NormalizeResult {
  /** The command with `python` → `python3` applied (unchanged if no match). */
  normalized: string
  /** Whether any rewrite actually happened. */
  wasRewritten: boolean
}

/** Whether the command invokes `python -c` (arbitrary eval — flagged as risk). */
const PYTHON_C_RE = /(^|[\s;&|()"'])python([\s]+)-c([\s]|$)/

/**
 * Normalize a bash command string, rewriting standalone `python` tokens to
 * `python3`. Pure function — no side effects, safe to unit test directly.
 */
export function normalizePythonCommand(command: string): NormalizeResult {
  // Reset lastIndex first — the regex is global and `.test()` advances it.
  PYTHON_NORMALIZE_RE.lastIndex = 0
  const wasRewritten = PYTHON_NORMALIZE_RE.test(command)
  PYTHON_NORMALIZE_RE.lastIndex = 0
  const normalized = command.replace(PYTHON_NORMALIZE_RE, '$1python3$2')
  return { normalized, wasRewritten }
}

/** Whether the command contains a `python -c` invocation (arbitrary eval). */
export function isPythonCEval(command: string): boolean {
  PYTHON_C_RE.lastIndex = 0
  return PYTHON_C_RE.test(command)
}

/** Minimal logger surface the guard needs (matches plugin logger shape). */
export interface NormalizerLogger {
  warn(message: string): void
}

/** Options for createCommandNormalizer(). */
export interface CommandNormalizerOptions {
  /** Audit sink for rewrites and `python -c` warnings. */
  logger?: NormalizerLogger
}

/**
 * Build the `tool.execute.before` handler that rewrites `bash` commands.
 * Only the `bash` tool is touched; every other tool passes through untouched.
 * The rewrite mutates `output.args.command` so the normalized command is what
 * actually executes. Never throws — normalization must not break a session.
 */
export function createCommandNormalizer(
  options: CommandNormalizerOptions = {},
): (input: { tool: string; sessionID: string }, output?: { args?: unknown }) => Promise<void> {
  const logger = options.logger

  return async (input, output): Promise<void> => {
    if (input.tool !== 'bash') return
    if (output?.args === null || typeof output?.args !== 'object') return

    const args = output.args as Record<string, unknown>
    const command = args.command
    if (typeof command !== 'string' || command.trim() === '') return

    const { normalized, wasRewritten } = normalizePythonCommand(command)

    if (isPythonCEval(command)) {
      logger?.warn(
        `[command-normalizer] WARNING python -c detected: session=${input.sessionID} command="${command}"`,
      )
    }

    if (wasRewritten) {
      args.command = normalized
      logger?.warn(
        `[command-normalizer] python→python3 rewritten: session=${input.sessionID} ` +
          `original="${command}" normalized="${normalized}"`,
      )
    }
  }
}
