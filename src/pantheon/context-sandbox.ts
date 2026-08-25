/**
 * Tool Output Sandboxing — Context Window Optimization (v2 P0)
 *
 * Truncates oversized tool outputs before they flood the context window.
 * Pure truncation with metadata — no tiktoken, no LLM summarization (YAGNI).
 *
 * Hook: tool.execute.after — intercepts read/grep/glob/webfetch outputs.
 *
 * @module pantheon/context-sandbox
 */

export interface ToolExecuteAfterInput {
  tool: string
  sessionID: string
  callID: string
  args?: unknown
}

export interface ToolExecuteAfterOutput {
  title?: string
  output: string
  metadata?: Record<string, unknown>
}

export type ToolExecuteAfterHandler = (
  input: ToolExecuteAfterInput,
  output: ToolExecuteAfterOutput,
) => Promise<void>

export interface SandboxToolLimits {
  read: { maxLines: number; keepHead: number; keepTail: number }
  grep: { maxResults: number; keepTop: number }
  glob: { maxFiles: number; keepTop: number }
  webfetch: { maxChars: number; keepHead: number }
}

export interface ContextSandboxConfig {
  enabled: boolean
  limits: SandboxToolLimits
}

/** Default limits — sensatos, cobrem 80% do problema com ~30 LOC. */
export const DEFAULT_LIMITS: SandboxToolLimits = {
  read: { maxLines: 200, keepHead: 50, keepTail: 10 },
  grep: { maxResults: 20, keepTop: 10 },
  glob: { maxFiles: 50, keepTop: 20 },
  webfetch: { maxChars: 5000, keepHead: 2000 },
}

export const DEFAULT_CONFIG: ContextSandboxConfig = {
  enabled: true,
  limits: DEFAULT_LIMITS,
}

// ─── Pure sandbox functions ──────────────────────────────────────────────

/**
 * Sandbox truncation for `read` tool output.
 * Input is expected to be line-numbered read output (e.g. "1: foo").
 * If lines > maxLines, keep head + marker + tail.
 */
export function sandboxRead(output: string, limits = DEFAULT_LIMITS.read): string {
  const lines = output.split('\n')
  // trailing empty after final newline is not a real line — drop it for counting
  const effectiveCount =
    lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
  if (effectiveCount <= limits.maxLines) return output

  const head = lines.slice(0, limits.keepHead)
  const tail =
    limits.keepTail > 0
      ? lines.slice(Math.max(limits.keepHead, effectiveCount - limits.keepTail), effectiveCount)
      : []
  const hidden = effectiveCount - head.length - tail.length
  const marker = `[TRUNCATED: ${hidden} lines hidden — showing ${head.length} head + ${tail.length} tail of ${effectiveCount} total lines]`

  // Preserve trailing newline semantics of original if present
  const hadTrailingNewline = output.endsWith('\n')
  const parts = [...head, marker, ...tail]
  let result = parts.join('\n')
  if (hadTrailingNewline) result += '\n'
  return result
}

/**
 * Sandbox truncation for `grep` tool output.
 * Each non-empty line is considered a match. Keeps top N, drops tail.
 */
export function sandboxGrep(output: string, limits = DEFAULT_LIMITS.grep): string {
  const lines = output.split('\n')
  const effectiveCount =
    lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
  // Count non-empty? spec says 20 results — treat every line as result for simplicity,
  // but filter obvious empties: if effective count includes empty trailing, already handled.
  // Use effectiveCount as result count.
  if (effectiveCount <= limits.maxResults) return output

  const head = lines.slice(0, limits.keepTop)
  const hidden = effectiveCount - head.length
  const marker = `[TRUNCATED: Showing ${head.length} of ${effectiveCount} matches — ${hidden} more hidden. Use more specific pattern.]`
  const hadTrailingNewline = output.endsWith('\n')
  let result = [...head, marker].join('\n')
  if (hadTrailingNewline) result += '\n'
  return result
}

/**
 * Sandbox truncation for `glob` tool output.
 * Each line is a file path. Keeps top N.
 */
export function sandboxGlob(output: string, limits = DEFAULT_LIMITS.glob): string {
  const lines = output.split('\n')
  const effectiveCount =
    lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
  if (effectiveCount <= limits.maxFiles) return output

  const head = lines.slice(0, limits.keepTop)
  const hidden = effectiveCount - head.length
  const marker = `[TRUNCATED: showing ${head.length} of ${effectiveCount} files — ${hidden} more hidden]`
  const hadTrailingNewline = output.endsWith('\n')
  let result = [...head, marker].join('\n')
  if (hadTrailingNewline) result += '\n'
  return result
}

/**
 * Sandbox truncation for `webfetch` tool output.
 * Character-based: keep head chars, drop rest.
 */
export function sandboxWebfetch(output: string, limits = DEFAULT_LIMITS.webfetch): string {
  if (output.length <= limits.maxChars) return output
  const head = output.slice(0, limits.keepHead)
  const hidden = output.length - head.length
  const marker = `\n[TRUNCATED: Content truncated — showing first ${head.length} of ${output.length} chars, ${hidden} chars hidden]\n`
  return head + marker
}

/**
 * Dispatch sandbox truncation by tool name. Pure function — no I/O.
 * Unknown tools pass through unchanged.
 */
export function sandboxOutput(
  tool: string,
  output: string,
  limits: SandboxToolLimits = DEFAULT_LIMITS,
): string {
  if (typeof output !== 'string' || output.length === 0) return output
  const normalized = tool.trim().toLowerCase()
  switch (normalized) {
    case 'read':
      return sandboxRead(output, limits.read)
    case 'grep':
      return sandboxGrep(output, limits.grep)
    case 'glob':
      return sandboxGlob(output, limits.glob)
    case 'webfetch':
    case 'fetch':
    case 'web_fetch':
      return sandboxWebfetch(output, limits.webfetch)
    default:
      return output
  }
}

// ─── Plugin hook factory ───────────────────────────────────────────────

/**
 * Resolve sandbox config from opencode.json `context_sandbox` block.
 * Fail-open: any missing/invalid field falls back to defaults.
 */
export function resolveSandboxConfig(raw?: unknown): ContextSandboxConfig {
  if (raw === null || raw === undefined || typeof raw !== 'object')
    return { ...DEFAULT_CONFIG, limits: { ...DEFAULT_LIMITS } }
  const obj = raw as Record<string, unknown>
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : true
  const limitsRaw = obj.limits as Record<string, unknown> | undefined

  const limits: SandboxToolLimits = {
    read: {
      maxLines:
        typeof limitsRaw?.read === 'object' &&
        limitsRaw.read !== null &&
        typeof (limitsRaw.read as Record<string, unknown>).maxLines === 'number'
          ? ((limitsRaw.read as Record<string, unknown>).maxLines as number)
          : DEFAULT_LIMITS.read.maxLines,
      keepHead:
        typeof limitsRaw?.read === 'object' &&
        limitsRaw.read !== null &&
        typeof (limitsRaw.read as Record<string, unknown>).keepHead === 'number'
          ? ((limitsRaw.read as Record<string, unknown>).keepHead as number)
          : DEFAULT_LIMITS.read.keepHead,
      keepTail:
        typeof limitsRaw?.read === 'object' &&
        limitsRaw.read !== null &&
        typeof (limitsRaw.read as Record<string, unknown>).keepTail === 'number'
          ? ((limitsRaw.read as Record<string, unknown>).keepTail as number)
          : DEFAULT_LIMITS.read.keepTail,
    },
    grep: {
      maxResults:
        typeof limitsRaw?.grep === 'object' &&
        limitsRaw.grep !== null &&
        typeof (limitsRaw.grep as Record<string, unknown>).maxResults === 'number'
          ? ((limitsRaw.grep as Record<string, unknown>).maxResults as number)
          : DEFAULT_LIMITS.grep.maxResults,
      keepTop:
        typeof limitsRaw?.grep === 'object' &&
        limitsRaw.grep !== null &&
        typeof (limitsRaw.grep as Record<string, unknown>).keepTop === 'number'
          ? ((limitsRaw.grep as Record<string, unknown>).keepTop as number)
          : DEFAULT_LIMITS.grep.keepTop,
    },
    glob: {
      maxFiles:
        typeof limitsRaw?.glob === 'object' &&
        limitsRaw.glob !== null &&
        typeof (limitsRaw.glob as Record<string, unknown>).maxFiles === 'number'
          ? ((limitsRaw.glob as Record<string, unknown>).maxFiles as number)
          : DEFAULT_LIMITS.glob.maxFiles,
      keepTop:
        typeof limitsRaw?.glob === 'object' &&
        limitsRaw.glob !== null &&
        typeof (limitsRaw.glob as Record<string, unknown>).keepTop === 'number'
          ? ((limitsRaw.glob as Record<string, unknown>).keepTop as number)
          : DEFAULT_LIMITS.glob.keepTop,
    },
    webfetch: {
      maxChars:
        typeof limitsRaw?.webfetch === 'object' &&
        limitsRaw.webfetch !== null &&
        typeof (limitsRaw.webfetch as Record<string, unknown>).maxChars === 'number'
          ? ((limitsRaw.webfetch as Record<string, unknown>).maxChars as number)
          : DEFAULT_LIMITS.webfetch.maxChars,
      keepHead:
        typeof limitsRaw?.webfetch === 'object' &&
        limitsRaw.webfetch !== null &&
        typeof (limitsRaw.webfetch as Record<string, unknown>).keepHead === 'number'
          ? ((limitsRaw.webfetch as Record<string, unknown>).keepHead as number)
          : DEFAULT_LIMITS.webfetch.keepHead,
    },
  }
  return { enabled, limits }
}

/**
 * Create the `tool.execute.after` handler that sandboxes oversized outputs.
 * The handler mutates `output.output` in-place and tags metadata when truncated.
 * Fail-open: never throws.
 */
export function createContextSandbox(
  config: ContextSandboxConfig = DEFAULT_CONFIG,
): ToolExecuteAfterHandler {
  // Capture mutable reference — caller (plugin config hook) may update limits live
  const cfgRef = config
  return async (input: ToolExecuteAfterInput, output: ToolExecuteAfterOutput): Promise<void> => {
    try {
      if (!cfgRef.enabled) return
      if (typeof output.output !== 'string') return
      const before = output.output
      const after = sandboxOutput(input.tool, before, cfgRef.limits)
      if (after !== before) {
        output.output = after
        output.metadata = {
          ...(output.metadata ?? {}),
          truncated: true,
          sandbox: input.tool.toLowerCase(),
        }
      }
    } catch {
      // never break the tool result
    }
  }
}
