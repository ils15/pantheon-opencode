/**
 * whats-new-highlights.ts — release highlights for the one-time "What's new"
 * window, extracted from the CHANGELOG.md shipped with the plugin copy.
 *
 * The section-finding logic is an inline replica of scripts/changelog-extract.mjs
 * `extractSection` (pinned by a parity test in tests/tui-whats-new.test.mjs):
 * the copied plugin ships only dist/ + package.json (+ CHANGELOG.md, copied by
 * both installers), so it cannot reach scripts/ at runtime — the same reason
 * the preset resolver is mirrored in index.tsx/index-v2.tsx rather than
 * imported. The script's CLI main is NOT replicated; the plugin only needs the
 * pure extraction.
 *
 * Everything is reduced to bounded plain text: no markdown syntax artifacts,
 * at most WHATS_NEW_MAX_ITEMS bullets. Missing CHANGELOG.md, an unknown
 * version or an empty section all resolve to an empty highlight set — the
 * window simply does not show (fail-open, like the rest of the plugin).
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Hard cap on bullets shown in the window (the remainder is counted). */
export const WHATS_NEW_MAX_ITEMS = 12

/** Prefix of the "+N more" line appended when the bullet budget is exceeded. */
export const WHATS_NEW_MORE_PREFIX = '… +'

/** H3 subsection headings are kept as plain-text group labels. */
export interface WhatsNewGroup {
  heading: string | null
  items: string[]
}

export interface WhatsNewHighlights {
  /** Normalized version the highlights belong to (null when not found). */
  version: string | null
  found: boolean
  groups: WhatsNewGroup[]
  /** Total bullets in the section, before the WHATS_NEW_MAX_ITEMS cut. */
  totalItems: number
  /** True when totalItems exceeded WHATS_NEW_MAX_ITEMS. */
  truncated: boolean
}

export const EMPTY_HIGHLIGHTS: WhatsNewHighlights = {
  version: null,
  found: false,
  groups: [],
  totalItems: 0,
  truncated: false,
}

/** Escape regex metacharacters so a version like 1.0.0 matches literally. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Extract the body of a version section from changelog text — inline replica
 * of scripts/changelog-extract.mjs `extractSection` (see that file for the
 * full contract: `## [<version>] - YYYY-MM-DD`, leading `v` and the date
 * optional, `## [Unreleased]` never matched).
 */
export function extractSection(
  changelogText: string,
  version: string,
): { found: boolean; body: string | null } {
  const normalized = String(version).trim().replace(/^v/i, '')
  if (!normalized || /^unreleased$/i.test(normalized)) return { found: false, body: null }

  const escaped = escapeRegExp(normalized)
  // Single-line heading: `## [v?1.2.1]` optionally followed by ` - YYYY-MM-DD`.
  // [ \t] (not \s) keeps the match from crossing newlines; the lookahead
  // requires end-of-line or whitespace so `[1.0.0-beta]` can never match `1.0.0`.
  const headingRe = new RegExp(
    `^##[ \\t]+\\[v?${escaped}\\](?:[ \\t]*-[ \\t]*\\d{4}-\\d{2}-\\d{2})?(?=[ \\t]|$)`,
    'm',
  )
  const match = headingRe.exec(changelogText)
  if (!match) return { found: false, body: null }

  // Advance past the heading line (match.index may point mid-line).
  const newline = changelogText.indexOf('\n', match.index)
  const start = newline === -1 ? changelogText.length : newline + 1

  // Body ends at the next `## [` heading or end of text.
  const nextHeading = /^##[ \t]+\[/m.exec(changelogText.slice(start))
  const end = nextHeading ? start + nextHeading.index : changelogText.length

  return { found: true, body: changelogText.slice(start, end).trim() }
}

/**
 * Reduce one markdown line to plain text: links keep their label, emphasis
 * and inline-code markers are dropped, HTML comment fragments are removed,
 * and whitespace collapses. Deliberately simple — the input is our own
 * CHANGELOG (lint-capped at 200 chars per bullet), not hostile input.
 */
export function stripMarkdown(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)/g, '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Strip the leading H3 marker (`### Added` → `Added`). */
function stripHeading(text: string): string {
  return text.replace(/^#{1,6}[ \t]+/, '').trim()
}

/**
 * Extract the release highlights for `version`: H3 subsection headings as
 * group labels and their bullets as sanitized plain text, bounded to
 * WHATS_NEW_MAX_ITEMS bullets. A missing section, a bullet-less section or a
 * blank changelog all return EMPTY_HIGHLIGHTS (no window).
 */
export function extractHighlights(changelogText: string, version: string): WhatsNewHighlights {
  const { found, body } = extractSection(changelogText ?? '', version ?? '')
  if (!found || !body) return { ...EMPTY_HIGHLIGHTS }

  const groups: WhatsNewGroup[] = []
  let totalItems = 0
  let truncated = false

  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('<!--')) continue

    if (/^#{1,6}[ \t]/.test(line)) {
      const heading = stripMarkdown(stripHeading(line))
      if (heading === '') continue
      if (groups.at(-1)?.items.length === 0) groups.pop() // empty group boundary
      groups.push({ heading, items: [] })
      continue
    }

    if (totalItems >= WHATS_NEW_MAX_ITEMS) {
      // Keep scanning only to count the remainder for the "+N more" line.
      if (/^[-*][ \t]/.test(line)) totalItems += 1
      continue
    }

    const isBullet = /^[-*][ \t]/.test(line)
    const continuation = (groups.at(-1)?.items.length ?? 0) > 0
    if (!isBullet && !continuation) continue // prose between groups — not a highlight

    const content = stripMarkdown(isBullet ? line.replace(/^[-*][ \t]+/, '') : line)
    if (content === '') continue
    const group = groups.at(-1)
    if (group === undefined) {
      groups.push({ heading: null, items: [content] })
    } else if (isBullet || group.items.length === 0) {
      group.items.push(content)
    } else {
      group.items[group.items.length - 1] = `${group.items.at(-1)} ${content}`.trim()
    }
    if (isBullet) totalItems += 1
  }

  const kept = groups.filter((group) => group.items.length > 0)
  truncated = totalItems > WHATS_NEW_MAX_ITEMS
  return {
    version: found ? String(version).trim().replace(/^v/i, '') : null,
    found,
    groups: kept,
    totalItems,
    truncated,
  }
}

/** Window title — mirrors the sidebar's `Pantheon v<version>` convention. */
export function whatsNewTitle(version: string): string {
  return `O que há de novo — Pantheon v${String(version).trim().replace(/^v/i, '')}`
}

/** Flat display lines for the window: group headings, `• ` bullets, `+N more`. */
export function whatsNewLines(highlights: WhatsNewHighlights): string[] {
  const lines: string[] = []
  for (const group of highlights.groups) {
    if (group.heading !== null) lines.push(group.heading)
    for (const item of group.items) lines.push(`• ${item}`)
  }
  if (highlights.truncated) {
    const hidden = Math.max(0, highlights.totalItems - WHATS_NEW_MAX_ITEMS)
    if (hidden > 0) lines.push(`${WHATS_NEW_MORE_PREFIX}${hidden} mais`)
  }
  return lines
}

/**
 * Candidate CHANGELOG.md locations for a bundle, first readable wins:
 *   1. the plugin copy root (`<configDir>/plugins/pantheon-tui/CHANGELOG.md`,
 *      shipped by both installers next to package.json);
 *   2. the package root (dev checkout; also an npm-package install when the
 *      bundle runs from `<pkg>/src/plugins/tui/dist/`).
 */
export function changelogCandidates(bundlePath: string): string[] {
  const dist = dirname(bundlePath)
  const copyRoot = dirname(dist)
  // The second leg targets the package root: src/plugins/tui → plugins → src
  // → package root (dev checkout / npm-package install). On an installed copy
  // the same three levels land on the XDG base, where no CHANGELOG lives —
  // harmless, the copy-root candidate is the one the installers ship.
  const packageRoot = dirname(dirname(dirname(copyRoot)))
  return [join(copyRoot, 'CHANGELOG.md'), join(packageRoot, 'CHANGELOG.md')]
}

/** Read the first existing candidate; null when none is readable (no window). */
export async function readChangelogForBundle(bundleUrl: string): Promise<string | null> {
  try {
    const bundlePath = fileURLToPath(bundleUrl)
    for (const candidate of changelogCandidates(bundlePath)) {
      try {
        return await readFile(candidate, 'utf8')
      } catch {}
    }
    return null
  } catch {
    return null
  }
}

/** Build-time embedded version (tsdown `define` in tsdown.config.ts). */
declare const __PANTHEON_VERSION__: string | undefined

/** The ambient build-time version, or null outside a tsdown build. */
export function embeddedVersion(): string | null {
  return typeof __PANTHEON_VERSION__ !== 'undefined' && __PANTHEON_VERSION__
    ? __PANTHEON_VERSION__
    : null
}

/**
 * Resolve the running Pantheon version for the what's-new window: the plugin
 * copy's own package.json first (the copy root two levels above the bundle,
 * then the package root four levels above — the same legs as the V1 sidebar's
 * detectVersion try 0a/0b), falling back to the tsdown build embed. Null when
 * nothing resolves → no window (fail-open).
 */
export async function resolveRunningVersion(
  bundleUrl: string,
  embedded: string | null = embeddedVersion(),
): Promise<string | null> {
  try {
    const bundlePath = fileURLToPath(bundleUrl)
    const dist = dirname(bundlePath)
    for (const root of [dirname(dist), dirname(dirname(dirname(dist)))]) {
      try {
        const raw = await readFile(join(root, 'package.json'), 'utf8')
        const parsed = JSON.parse(raw) as { version?: unknown }
        if (typeof parsed.version === 'string' && parsed.version.trim() !== '') {
          return parsed.version
        }
      } catch {}
    }
  } catch {
    /* fall through to the embed */
  }
  return embedded
}
