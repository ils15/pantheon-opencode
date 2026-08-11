/**
 * Hashline core (Wave 2, PR #46) — tagged-line formatting, ref parsing, and
 * mismatch diagnostics shared by the read enhancer and the hashline_edit tool.
 *
 * A "ref" is the stable anchor used by hashline_edit: `{line}#{tag}` where
 * the tag is the 2-char sha256 hash of the line content. Ref format:
 *   ^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})$
 *
 * @module hashline/core
 */

import { HASHLINE_DICT, hashTag } from './xxhash.ts'

/** A ref string: line number + 2-char tag (e.g. "12#XJ"). */
export const HASHLINE_REF_RE = /^([0-9]+)#([ZPMQVRWSNKTXJBYH]{2})$/

/** Matches an already-tagged line (`12#XJ|content`) — idempotency guard. */
const TAGGED_LINE_RE = new RegExp(`^\\s*[0-9]+#[${HASHLINE_DICT}]{2}\\|`)

/** A resolved line match used in mismatch diagnostics. */
export interface LineMatch {
  /** 1-based line number. */
  line: number
  /** The tag ACTUALLY computed for the line content. */
  tag: string
  /** The raw line content (for the excerpt). */
  content?: string | undefined
}

/**
 * Format a line as a hashline-tagged line: `{lineNo}#{tag}|{content}`.
 * This is the format the read enhancer emits and the edit tool consumes.
 */
export function formatTaggedLine(lineNo: number, content: string): string {
  return `${lineNo}#${hashTag(content, lineNo)}|${content}`
}

/**
 * Whether a line is already hashline-tagged (idempotency check). Used by the
 * read enhancer to avoid re-tagging and by tests to verify the format.
 */
export function isTaggedLine(line: string): boolean {
  return TAGGED_LINE_RE.test(line)
}

/**
 * Build the "Did you mean" suggestion for a mismatched ref: the corrected
 * ref is the ACTUAL line number + ACTUAL tag, e.g. `Did you mean "12#XJ"?`.
 */
export function suggestLineForHash(lineNo: number, tag: string): string {
  return `Did you mean "${lineNo}#${tag}"?`
}

/**
 * Build the full mismatch error text for the hashline_edit tool (returned
 * as error-as-text, never thrown, never partially written):
 *
 *   hashline_edit: ref "12#QQ" does not match /path/file at line 12 (tag "XJ")
 *
 *   >>>12#XJ|actual line content
 *    ...   13#AB|next line
 *
 *   Did you mean "12#XJ"?
 *
 * The excerpt is a RE-TAGGED view of the original `lines` around the target
 * line (±2 lines of context), with the mismatched line marked `>>>` and
 * carrying its ACTUAL tag.
 */
export function buildMismatchError(
  file: string,
  ref: string,
  actual: LineMatch,
  lines: readonly string[],
): string {
  const start = Math.max(1, actual.line - 2)
  const end = Math.min(lines.length, actual.line + 2)
  const excerpt: string[] = []
  for (let i = start; i <= end; i++) {
    const content = lines[i - 1] ?? ''
    const tag = i === actual.line ? actual.tag : hashTag(content, i)
    const marker = i === actual.line ? '>>>' : '   '
    excerpt.push(`${marker}${i}#${tag}|${content}`)
  }
  return [
    `hashline_edit: ref "${ref}" does not match ${file} at line ${actual.line} (tag "${actual.tag}")`,
    '',
    excerpt.join('\n'),
    '',
    suggestLineForHash(actual.line, actual.tag),
  ].join('\n')
}
