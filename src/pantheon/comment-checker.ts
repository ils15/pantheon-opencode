/**
 * Comment Checker — detects trivial/auto-generated comments that make code
 * look machine-produced rather than human-written.
 *
 * Used by @themis (Layer 1: Surface review) to flag comments that add no
 * information value and signal AI-generated code.
 */

/** Regex patterns matching trivial, uninformative comments. */
export const TRIVIAL_PATTERNS: readonly RegExp[] = [
  /#\s*increment\s+\w+/i,
  /#\s*decrement\s+\w+/i,
  /#\s*set\s+\w+/i,
  /#\s*loop\s+over/i,
  /#\s*(initialize|init)\s+\w+/i,
  /#\s*(return|yield)\s+\w+/i,
]

export interface CommentCheckResult {
  /** Number of trivial comments found (0 = clean). */
  score: number
  /** Human-readable descriptions of each flagged comment. */
  flags: string[]
}

/**
 * Scan source code for trivial comments that add no information value.
 *
 * Returns a score (count of trivial comments) and a list of flags describing
 * each match. A score of 0 means no trivial comments were detected.
 */
export function checkCommentDensity(source: string): CommentCheckResult {
  const flags: string[] = []
  const lines = source.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    for (const pattern of TRIVIAL_PATTERNS) {
      if (pattern.test(line)) {
        const trimmed = line.trim()
        flags.push(`Line ${i + 1}: trivial comment — "${trimmed}"`)
        break // one flag per line, even if multiple patterns match
      }
    }
  }

  return { score: flags.length, flags }
}
