/** Conservative content budget; the host sidebar slot does not report its runtime width. */
export const SIDEBAR_CONTENT_WIDTH = 34

export const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** A grapheme the host draws two cells wide: emoji presentation, an extended
 *  pictograph (a bare `❤` counts too, exactly as the host's `emoji-regex`
 *  does) and a regional-indicator pair (a flag). */
const EMOJI_GLYPH = /\p{Emoji_Presentation}|\p{Extended_Pictographic}|\p{Regional_Indicator}/u
/** VS16 asks for emoji presentation; without it `1` is one cell, with it the
 *  keycap sequence is drawn as one two-cell glyph. */
const EMOJI_PRESENTATION_SELECTOR = '\uFE0F'
/** Unicode default-ignorable code points carry no width of their own. */
const IGNORABLE_GLYPH = /^\p{Default_Ignorable_Code_Point}$/u
/** East Asian Wide/Fullwidth ranges — two cells, never the ambiguous width
 *  (the host measures ambiguous as narrow, so `▸`/`✓`/`—` stay one cell).
 *  Generated from the host's own measurement (`string-width` over every code
 *  point, emoji excluded), so this table can be regenerated verbatim when the
 *  host upgrades its Unicode data instead of being hand-edited. */
const CELL_WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115e],
  [0x2329, 0x232a],
  [0x2630, 0x2637],
  [0x268a, 0x268f],
  [0x2e80, 0x2e99],
  [0x2e9b, 0x2ef3],
  [0x2f00, 0x2fd5],
  [0x2ff0, 0x302f],
  [0x3031, 0x303c],
  [0x303e, 0x303e],
  [0x3041, 0x3096],
  [0x3099, 0x30ff],
  [0x3105, 0x312f],
  [0x3131, 0x3163],
  [0x3165, 0x318e],
  [0x3190, 0x31e5],
  [0x31ef, 0x321e],
  [0x3220, 0x3247],
  [0x3250, 0x3296],
  [0x3298, 0x3298],
  [0x329a, 0xa48c],
  [0xa490, 0xa4c6],
  [0xa960, 0xa97c],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe52],
  [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x16ff0, 0x16ff6],
  [0x17000, 0x18cda],
  [0x18cff, 0x18d20],
  [0x18d80, 0x18df2],
  [0x18e00, 0x19191],
  [0x191a0, 0x191d2],
  [0x1aff0, 0x1aff3],
  [0x1aff5, 0x1affb],
  [0x1affd, 0x1affe],
  [0x1b000, 0x1b128],
  [0x1b132, 0x1b132],
  [0x1b150, 0x1b152],
  [0x1b155, 0x1b155],
  [0x1b164, 0x1b168],
  [0x1b170, 0x1b2fb],
  [0x1d300, 0x1d356],
  [0x1d360, 0x1d376],
  [0x1f200, 0x1f200],
  [0x1f210, 0x1f219],
  [0x1f21b, 0x1f22e],
  [0x1f230, 0x1f231],
  [0x1f23b, 0x1f23b],
  [0x1f240, 0x1f248],
  [0x1f260, 0x1f265],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
]

/** One code point the terminal draws no cell for: control characters, the
 *  zero-width joiners/marks, combining marks and variation selectors. */
function isZeroWidthCodePoint(code: number, glyph: string): boolean {
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true
  if (code >= 0x200b && code <= 0x200f) return true
  if (code === 0xfeff) return true
  if (code >= 0x300 && code <= 0x36f) return true
  if (code >= 0x1ab0 && code <= 0x1aff) return true
  if (code >= 0x1dc0 && code <= 0x1dff) return true
  if (code >= 0x20d0 && code <= 0x20ff) return true
  if (code >= 0xfe00 && code <= 0xfe0f) return true
  if (code >= 0xfe20 && code <= 0xfe2f) return true
  if (code >= 0xe0100 && code <= 0xe01ef) return true
  if (code >= 0xd800 && code <= 0xdfff) return true // a lone surrogate
  return IGNORABLE_GLYPH.test(glyph)
}

function isWideCodePoint(code: number): boolean {
  for (const [low, high] of CELL_WIDE_RANGES) {
    if (code < low) return false
    if (code <= high) return true
  }
  return false
}

/** Cells one grapheme occupies. */
function graphemeWidth(segment: string): number {
  if (EMOJI_GLYPH.test(segment)) return 2
  // A lone VS16 carries no width; after a base it asks for emoji presentation.
  if (segment.length > 1 && segment.includes(EMOJI_PRESENTATION_SELECTOR)) return 2
  let width = 0
  for (const glyph of segment) {
    const code = glyph.codePointAt(0) ?? 0
    if (isZeroWidthCodePoint(code, glyph)) continue
    width += isWideCodePoint(code) ? 2 : 1
  }
  return width
}

/** Terminal cells `value` occupies — the unit every column in this plugin is
 *  measured in. Mirrors the host (that is how `@opentui/core` sizes a text
 *  run): emoji count as two cells, East Asian Wide/Fullwidth as two, East
 *  Asian Ambiguous as one, combining marks and variation selectors as none.
 *  Pure. */
export function cellWidth(value: string): number {
  let width = 0
  for (const { segment } of GRAPHEMES.segment(value)) width += graphemeWidth(segment)
  return width
}
