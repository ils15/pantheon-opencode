#!/usr/bin/env node
/**
 * changelog-format.mjs — canonical CHANGELOG/release-body format validator
 *
 * The canonical section format (docs/RELEASING.md) is the hybrid: curated
 * `### 🆕 What's New` highlights on top, Keep a Changelog `### ` subsections
 * in fixed order, `### ⚠️ Known Issues` / `### ✅ Closed Issues` last.
 * Every GitHub release body is the verbatim extraction of its CHANGELOG
 * section, so validating the section validates the release.
 *
 * Exports:
 *   CANONICAL_SECTIONS — the approved heading order (frozen).
 *   splitSections(text) — all `## [name]` sections in file order.
 *   validateSection(body, {label, allowLeadingComment}) — violation strings.
 *
 * Consumers: scripts/release-gates.mjs (gate e fails the release),
 * scripts/docs-check-changelog.mjs (CI shift-left on maintained sections).
 *
 * Exit code / stdout behavior exists only for direct-run diagnostics
 * (`node scripts/changelog-format.mjs <version>`); the workflow consumes the
 * exported functions, not the CLI.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Approved subsection order — What's New first, Known/Closed Issues last. */
export const CANONICAL_SECTIONS = Object.freeze([
  "🆕 What's New",
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
  '⚠️ Known Issues',
  '✅ Closed Issues',
])

const SECTION_INDEX = new Map(CANONICAL_SECTIONS.map((name, index) => [name, index]))

/** What's New is the TUI window contract: at most 6 bullets of ≤140 chars. */
export const MAX_WHATS_NEW_BULLETS = 6
export const MAX_WHATS_NEW_BULLET = 140
/** KaC sections allow long-wrapped bullets, but not unbounded ones. */
export const MAX_BULLET = 200

/** Added/Changed/Fixed are scope-driven: every bullet names its scope. */
const STRICT_SHAPE_SECTIONS = new Set(['Added', 'Changed', 'Fixed'])

const PLACEHOLDER_RE = /\b(?:TODO|TBD|FIXME|XXX)\b/
const HEADING_RE = /^(#{1,6}) (.+?)\s*$/
const SECTION_HEADING_RE = /^## \[([^\]]+)\]/
const BULLET_RE = /^- /
/** Strict shape: `- **scope** — text` (scoped) or `- **subject**` (unscoped),
 *  with the optional 💥 breaking prefix. */
const STRICT_BULLET_RE = /^- (?:💥 )?\*\*[^*]+\*\*(?: — \S|$)/
/** What's New shape: any bold lead (`- **summary**` + `:` or ` — ` detail). */
const WHATS_NEW_BULLET_RE = /^- \*\*[^*]+\*\*/
const CLOSED_ISSUE_BULLET_RE = /^- #\d+(?: - |$)/

/** Emoji-safe character count (What's New bullets contain emoji-adjacent text). */
function charCount(text) {
  return [...text].length
}

/**
 * Split changelog text into its `## [name]` sections, in file order.
 *
 * Names keep the heading spelling minus a leading `v` ("1.7.0",
 * "0.1.0-beta.2", "Unreleased"). Each body is everything after the heading
 * line up to the next `## [` heading, trimmed. Content outside any section
 * (the file preamble) is ignored.
 *
 * @param {string} changelogText - full CHANGELOG.md content
 * @returns {Array<{name: string, body: string}>}
 */
export function splitSections(changelogText) {
  const sections = []
  const lines = String(changelogText).split(/\r?\n/)
  let current = null // { name, lines: string[] }

  const close = () => {
    if (current) sections.push({ name: current.name, body: current.lines.join('\n').trim() })
    current = null
  }

  for (const line of lines) {
    const match = SECTION_HEADING_RE.exec(line)
    if (match) {
      close()
      current = { name: match[1].replace(/^v/, ''), lines: [] }
      continue
    }
    if (current) current.lines.push(line)
  }
  close()
  return sections
}

// ---------------------------------------------------------------------------
// validateSection
// ---------------------------------------------------------------------------

/**
 * One parsed content line inside a subsection.
 * @typedef {{kind: 'bullet'|'continuation'|'prose', text: string}} Line
 */

/**
 * Validate one section body against the canonical format. Returns every
 * violation found, each prefixed with `label`. An empty violations array
 * means the body is canonical.
 *
 * Rules (docs/RELEASING.md "The canonical section format"):
 *   - only `### ` subsections from CANONICAL_SECTIONS, in order, no dupes;
 *   - no H1/H2/H4+ headings inside the section;
 *   - no content before the first `###` (leading HTML comment tolerated with
 *     `allowLeadingComment` — the [Unreleased] template);
 *   - no empty subsections;
 *   - What's New: ≤6 bullets, each ≤140 chars, bold summary lead;
 *   - Added/Changed/Fixed bullets: `- **scope** — text` (💥 prefix allowed);
 *   - Closed Issues bullets: `- #N - subject`;
 *   - no bullet over 200 chars (continuations included);
 *   - no TODO/TBD/FIXME/XXX placeholders.
 *
 * @param {string} body - section body (no `## [` heading line)
 * @param {{label?: string, allowLeadingComment?: boolean}} [options]
 * @returns {string[]}
 */
export function validateSection(body, options = {}) {
  const { label = 'section', allowLeadingComment = false } = options
  const violations = []
  const fail = (message) => violations.push(`${label}: ${message}`)

  if (!String(body).trim()) {
    fail('section is empty')
    return violations
  }

  const lines = String(body).split(/\r?\n/)

  // Leading HTML comment (the [Unreleased] template) is skipped when allowed.
  let index = 0
  if (allowLeadingComment) {
    while (index < lines.length && lines[index].trim() === '') index += 1
    if (index < lines.length && lines[index].includes('<!--')) {
      while (index < lines.length && !lines[index].includes('-->')) index += 1
      if (index < lines.length) index += 1
    }
  }

  // Heading-level tracking across the whole body.
  let sawFirstH3 = false
  const seen = new Map() // name -> count
  let lastIndex = -1

  // Subsection aggregation.
  let current = null // { name, strict, closed, bullets: string[][], prose: string, raw: string, placeholderReported }
  let bullet = null // string[] parts (first part keeps the "- " marker)

  const flushBullet = () => {
    if (current && bullet) current.bullets.push(bullet)
    bullet = null
  }

  const closeSection = () => {
    flushBullet()
    if (!current) return
    if (current.bullets.length === 0 && current.prose.trim() === '') {
      fail(`"${current.name}" subsection is empty`)
    }
    // Placeholders are checked on the raw content: strict-section prose is
    // already a shape violation, but naming the placeholder is the useful half.
    if (PLACEHOLDER_RE.test(current.raw) && !current.placeholderReported) {
      current.placeholderReported = true
      fail(`placeholder marker (TODO/TBD/FIXME/XXX) in "${current.name}"`)
    }
    if (current.name === "🆕 What's New") {
      if (current.bullets.length > MAX_WHATS_NEW_BULLETS) {
        fail(`What's New has ${current.bullets.length} bullets (max ${MAX_WHATS_NEW_BULLETS})`)
      }
      for (const parts of current.bullets) {
        const text = parts.join(' ').replace(/^- /, '')
        if (!WHATS_NEW_BULLET_RE.test(parts[0])) {
          fail("What's New bullet must open with a bold summary (**...**)")
        }
        if (charCount(text) > MAX_WHATS_NEW_BULLET) {
          fail(`What's New bullet is ${charCount(text)} chars (max ${MAX_WHATS_NEW_BULLET})`)
        }
      }
    } else if (current.strict) {
      for (const parts of current.bullets) {
        if (!STRICT_BULLET_RE.test(parts[0])) {
          fail(
            `"${current.name}" bullet must open with a bold scope (- **scope** — text / - **subject**): ${parts[0].slice(0, 60)}`,
          )
        }
      }
    } else if (current.closed) {
      for (const parts of current.bullets) {
        const text = parts.join(' ')
        if (!CLOSED_ISSUE_BULLET_RE.test(text.trimEnd())) {
          fail(`"${current.name}" bullet must match the - #N - subject shape: ${text.slice(0, 60)}`)
        }
      }
    }
    for (const parts of current.bullets) {
      const text = parts.join(' ').replace(/^- /, '')
      if (charCount(text) > MAX_BULLET) {
        fail(`bullet is ${charCount(text)} chars (max ${MAX_BULLET}): ${text.slice(0, 60)}…`)
      }
    }
    current = null
  }

  const openSection = (name) => {
    closeSection()
    seen.set(name, (seen.get(name) ?? 0) + 1)
    if (!SECTION_INDEX.has(name)) {
      fail(`H3 "${name}" is not in the canonical set (${CANONICAL_SECTIONS.join(', ')})`)
    } else {
      const index = SECTION_INDEX.get(name)
      if (seen.get(name) > 1) {
        fail(`H3 "${name}" is duplicated`)
      } else if (lastIndex !== -1 && index <= lastIndex) {
        fail(
          `H3 "${name}" is out of canonical order (must follow "${CANONICAL_SECTIONS[lastIndex]}")`,
        )
      }
      lastIndex = index
    }
    sawFirstH3 = true
    current = {
      name,
      strict: STRICT_SHAPE_SECTIONS.has(name),
      closed: name === '✅ Closed Issues',
      bullets: [],
      prose: '',
      raw: '',
      placeholderReported: false,
    }
  }

  for (; index < lines.length; index += 1) {
    const line = lines[index]
    const trimmed = line.trim()

    if (trimmed === '') {
      flushBullet()
      continue
    }

    const heading = HEADING_RE.exec(line)
    if (heading) {
      const level = heading[1].length
      if (level === 3) {
        openSection(heading[2].trim())
      } else {
        fail(`H${level} inside the section (only ### subsections are allowed): ${trimmed}`)
      }
      continue
    }

    if (!sawFirstH3) {
      fail(`content before the first ### heading: ${trimmed.slice(0, 60)}`)
      // Report once, then keep scanning for headings without spamming.
      while (index + 1 < lines.length && !HEADING_RE.test(lines[index + 1])) index += 1
      continue
    }

    if (!current) continue // heading already reported; nothing to attach content to

    if (BULLET_RE.test(trimmed)) {
      flushBullet()
      bullet = [trimmed]
      current.raw += ` ${trimmed}`
      continue
    }
    if (bullet) {
      bullet.push(trimmed)
      current.raw += ` ${trimmed}`
      continue
    }
    // Prose paragraph in a strict section is a shape violation; loose
    // sections (Deprecated/Removed/Security/Known Issues) tolerate it.
    if (current.strict) {
      fail(
        `"${current.name}" content must be bullets (- **scope** — text): ${trimmed.slice(0, 60)}`,
      )
      current.raw += ` ${trimmed}`
    } else {
      current.prose += ` ${trimmed}`
      current.raw += ` ${trimmed}`
    }
  }
  closeSection()

  return violations
}

// ---------------------------------------------------------------------------
// CLI (diagnostics only — consumers import the functions above)
// ---------------------------------------------------------------------------

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  const version = process.argv[2]
  const changelogPath =
    process.argv[4] && process.argv[3] === '--changelog'
      ? process.argv[4]
      : join(ROOT, 'CHANGELOG.md')
  if (!version) {
    console.error('Usage: node scripts/changelog-format.mjs <version> [--changelog <path>]')
    process.exitCode = 2
  } else {
    let text
    try {
      text = readFileSync(changelogPath, 'utf-8')
    } catch {
      console.error(`changelog-format: cannot read ${changelogPath}`)
      process.exitCode = 1
    }
    if (text !== undefined) {
      const section = splitSections(text).find((s) => s.name === version.replace(/^v/, ''))
      if (!section) {
        console.error(`changelog-format: section [${version}] not found in ${changelogPath}`)
        process.exitCode = 1
      } else {
        const violations = validateSection(section.body, { label: `v${section.name}` })
        if (violations.length === 0) {
          console.log(`changelog-format: [${section.name}] is canonical.`)
        } else {
          for (const violation of violations) console.error(violation)
          console.error(`changelog-format: ${violations.length} violation(s) in [${section.name}].`)
          process.exitCode = 1
        }
      }
    }
  }
}
