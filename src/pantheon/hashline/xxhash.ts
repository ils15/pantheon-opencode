/**
 * Hashline tag computation (Wave 2, PR #46) — sha256-truncated per-line tags.
 *
 * Pure `node:crypto` — zero vendored xxhash, zero deps. A 2-char tag is
 * derived from the FIRST byte of the sha256 digest, mapped through a 16-char
 * alphabet (16² = 256 possible tags — the same alphabet as the reference
 * implementation for ecosystem familiarity).
 *
 * Seeding rule:
 *   - Lines containing at least one letter/digit (`/[\p{L}\p{N}]/u`) use
 *     seed 0 → the tag depends ONLY on the content, so identical content
 *     yields the same tag anywhere in the file (stable anchors for moving
 *     lines).
 *   - Blank / symbol-only lines use the LINE NUMBER as seed → otherwise all
 *     blank lines would share one tag and could never be anchored uniquely.
 *
 * @module hashline/xxhash
 */

import { createHash } from 'node:crypto'

/** 16-char tag alphabet — same as the reference hashline (ecosystem familiarity). */
export const HASHLINE_DICT = 'ZPMQVRWSNKTXJBYH'

/** Lines that carry at least one letter or digit hash by content alone. */
const ALNUM_RE = /[\p{L}\p{N}]/u

/**
 * Normalize a line before hashing: strip the trailing `\r` (CRLF inputs) and
 * trim trailing whitespace so cosmetic edits do not change the tag.
 */
export function normalizeLine(line: string): string {
  return line.replace(/\r$/, '').trimEnd()
}

/**
 * Compute the 2-char hashline tag for `line` at 1-based `lineNumber`.
 *
 * @param line Raw line content (may include trailing newline artifacts).
 * @param lineNumber 1-based line number (seeds blank/symbol lines only).
 * @returns Two uppercase chars from HASHLINE_DICT.
 */
export function hashTag(line: string, lineNumber: number): string {
  const normalized = normalizeLine(line)
  const seed = ALNUM_RE.test(normalized) ? 0 : lineNumber
  // The `\u0000` NUL between seed and content disambiguates the
  // seed/content concatenation: without it, seed 1 + content "2" and
  // seed 12 + content "" would collide into the same digest input. NUL
  // never occurs in real source lines, so it is a safe separator.
  const digest = createHash('sha256').update(`${seed}\u0000${normalized}`).digest()
  const first = digest[0] ?? 0
  return HASHLINE_DICT.charAt(first >> 4) + HASHLINE_DICT.charAt(first & 0x0f)
}
