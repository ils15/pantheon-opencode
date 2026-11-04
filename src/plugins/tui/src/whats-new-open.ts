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

/** Muted footer hint teaching the dismiss bind (Portuguese, like the sidebar). */
export const WHATS_NEW_CLOSE_HINT = 'esc/q fechar'

/** Everything the window needs to render — no host types, no JSX. */
export interface WhatsNewViewData {
  version: string
  title: string
  lines: string[]
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

  const data: WhatsNewViewData = {
    version,
    title: whatsNewTitle(version),
    lines,
    hint: WHATS_NEW_CLOSE_HINT,
  }
  show(
    () => data,
    () => {
      void markSeenWhatsNew(version, statePath)
    },
  )
  return true
}
