/**
 * whats-new-open.ts — the show-once decision for the "What's new" window.
 *
 * Plain data in, plain data out: the entrypoints (index.tsx / index-v2.tsx)
 * resolve the running version and the shipped CHANGELOG.md, then hand this
 * module a `show` callback that renders the view data through the host's
 * dialog API. Keeping the decision JSX-free makes the whole one-time flow
 * testable offline (node strips the types natively) — the Solid glue lives in
 * whats-new.tsx.
 *
 * Contract (pinned by tests/tui-whats-new.test.mjs):
 *   - shows at most once per version: dismissal marks the version seen;
 *   - nothing to show (no version, missing CHANGELOG, empty section) → no
 *     window AND no pin — the next start may still show it;
 *   - never throws on its own inputs; I/O failures inside the state module
 *     are fail-open there.
 */
import {
  EMPTY_HIGHLIGHTS,
  extractHighlights,
  type WhatsNewHighlights,
  whatsNewLines,
  whatsNewTitle,
} from './whats-new-highlights.ts'
import { markSeenWhatsNew, shouldShowWhatsNew } from './whats-new-state.ts'

/** Muted footer hint teaching the dismiss bind. */
export const WHATS_NEW_CLOSE_HINT = 'esc/q close'

/** Hint variant when the highlights span more than one page. */
export const WHATS_NEW_PAGES_HINT = 'esc/q close · n next · p back'

/** The CHANGELOG pointer shown under the highlights (the window summarizes; the file is complete). */
export const WHATS_NEW_MORE_HINT = 'Full CHANGELOG: CHANGELOG.md in package'

/** Rows per page — bounded so no changelog can overflow the terminal. */
export const WHATS_NEW_PAGE_SIZE = 14

/** Hard-wrap one display line into rows of at most `width` columns (>= 10). */
export function wrapWhatsNewLine(line: string, width: number): string[] {
  const bounded = Number.isInteger(width) && width > 10 ? width : 76
  const text = String(line)
  if (text.length <= bounded) return [text]
  const rows: string[] = []
  let rest = text
  while (rest.length > bounded) {
    rows.push(rest.slice(0, bounded))
    rest = rest.slice(bounded)
  }
  if (rest.length > 0) rows.push(rest)
  return rows
}

/** Slice display lines into fixed-size pages (>= 1 page, empty-safe). */
export function paginateWhatsNewLines(
  lines: string[],
  pageSize: number = WHATS_NEW_PAGE_SIZE,
): string[][] {
  const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : WHATS_NEW_PAGE_SIZE
  if (lines.length === 0) return [[]]
  const pages: string[][] = []
  for (let i = 0; i < lines.length; i += size) pages.push(lines.slice(i, i + size))
  return pages
}

/** Everything the window needs to render — no host types, no JSX. */
export interface WhatsNewViewData {
  version: string
  title: string
  lines: string[]
  /** Fixed-size pages of `lines` (single page when the highlights are short). */
  pages: string[][]
  hint: string
}

export type WhatsNewShowFn = (render: () => WhatsNewViewData, onClose: () => void) => void

export interface WhatsNewOpenInput {
  /** Running Pantheon version (null when unresolvable → no window). */
  version: string | null
  /** Path of the seen-version state file (see whats-new-state.ts). */
  statePath: string
  /** Shipped CHANGELOG.md content, or null when unreadable. */
  changelogText: string | null
  /** Host dialog opener; `onClose` fires on host dismissal (ESC / chrome). */
  show: WhatsNewShowFn
}

/**
 * Open the one-time window when the version changed and highlights exist.
 * Returns true when the window was shown; the caller's `onClose` callback
 * (both host-initiated and local close binds) must funnel into marking seen.
 */
export async function openWhatsNew(input: WhatsNewOpenInput): Promise<boolean> {
  const { version, statePath, changelogText, show } = input
  if (typeof version !== 'string' || version.trim() === '') return false
  if (!(await shouldShowWhatsNew(version, statePath))) return false

  const highlights: WhatsNewHighlights = changelogText
    ? extractHighlights(changelogText, version)
    : { ...EMPTY_HIGHLIGHTS }
  const lines = whatsNewLines(highlights)
  if (lines.length === 0) return false

  const pages = paginateWhatsNewLines(lines)
  const data: WhatsNewViewData = {
    version,
    title: whatsNewTitle(version),
    lines,
    pages,
    hint: pages.length > 1 ? WHATS_NEW_PAGES_HINT : WHATS_NEW_CLOSE_HINT,
  }
  show(
    () => data,
    () => {
      void markSeenWhatsNew(version, statePath)
    },
  )
  return true
}
