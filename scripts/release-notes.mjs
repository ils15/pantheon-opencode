#!/usr/bin/env node
/**
 * release-notes.mjs — generate release notes from conventional commits
 *
 * Bridges the conventional-commit pipeline (commitlint: 12 types / 40 scopes)
 * to the CHANGELOG / release-body content. Reads `git log <lastTag>..HEAD`
 * (subject + body per commit), groups commits by type, and prints markdown
 * ready to paste into the [Unreleased] CHANGELOG section.
 *
 * Groups (section order — Breaking first, highest visibility):
 *   💥 Breaking         `BREAKING CHANGE` footer or `type!:` / `type(scope)!:`
 *                       (precedence — a breaking commit never also appears in
 *                       its type group)
 *   ✨ Features         feat
 *   🐞 Fixed            fix
 *   ⚡ Performance      perf
 *   🛡️ Security         security
 *   📚 Documentation    docs
 *   🔧 Maintenance      chore | refactor | test | ci | build | style | revert
 *                       (unknown conventional types also land here)
 *
 * Skipped: merge commits ("Merge ..."), empty-subject commits (trivial
 * chores), and non-conventional subjects (grandfathered history only).
 *
 * Bullet format:
 *   - **<scope>** — <subject without the type(scope): prefix>   (scope present)
 *   - **<subject>**                                              (no scope)
 *
 * Usage:
 *   node scripts/release-notes.mjs            # lastTag..HEAD (stable tags only)
 *   node scripts/release-notes.mjs --draft    # last 30 commits, no tag lookup
 *
 * Exit code is 0 whenever output can be generated (empty output means no
 * groupable commits since the range). stdout is pure markdown — diagnostics
 * go to stderr.
 *
 * getLastTag() intentionally duplicates scripts/versioning.mjs getLatestTag()
 * (that module is a CLI, not importable). Keep both in sync when changing
 * the stable-tag filter.
 */

import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Commit window used by --draft (and as fallback when no stable tag exists). */
export const DRAFT_RANGE = 30

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function run(cmd) {
  try {
    return execSync(cmd, { cwd: ROOT, encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

/**
 * Latest stable tag: strict vX.Y.Z with NO pre-release suffix. The loose
 * glob `v*` also matches v1.2.0-beta.9.<sha>; pre-release tags must never
 * poison the version gate or the notes range, so filter strictly.
 */
export function getLastTag() {
  const tag = run("git tag -l 'v*' | grep -E '^v[0-9]+\\.[0-9]+\\.[0-9]+$' | sort -V | tail -1")
  return tag || 'v0.0.0'
}

function tagExists(tag) {
  return run(`git rev-parse --verify --quiet ${tag}`) !== ''
}

/**
 * Collect `subject|body` records for a git range.
 *
 * Records are separated with %x1e because %b (raw body) may contain
 * newlines; each record keeps its multi-line body intact. The `|` inside a
 * body is preserved (parsing splits on the FIRST `|`, right after %s).
 *
 * @param {{since?: string|null, draft?: boolean}} [opts]
 *   since — lower-bound tag for the range (default null)
 *   draft — use the last DRAFT_RANGE commits instead of a tag range
 * @returns {string[]} raw "subject|body" records
 */
export function collectEntries({ since = null, draft = false } = {}) {
  // Single-quoted: execSync goes through a shell, and the `|` inside the
  // format string is a literal separator (subject|body), not a shell pipe.
  const fmt = "'--format=%x1e%s|%b'"
  // Without a valid `since` we cannot build a tag range — fall back to the
  // draft window (also covers --draft, which must not read tags at all).
  const range = draft || !since ? `-n ${DRAFT_RANGE}` : `${since}..HEAD`
  const out = run(`git log ${range} ${fmt}`)
  if (!out) return []
  return out
    .split('\x1e')
    .map((record) => record.trim())
    .filter(Boolean)
}

// ---------------------------------------------------------------------------
// Parsing / grouping (pure functions, tested in tests/release-notes.test.mjs)
// ---------------------------------------------------------------------------

/**
 * Parse one "subject|body" record into a conventional-commit entry.
 * Returns null for records that must be skipped: merge commits ("Merge ..."),
 * non-conventional subjects, and empty-subject (trivial) commits.
 *
 * @param {string} line
 * @returns {{type: string, scope: string|null, subject: string, breaking: boolean}|null}
 */
export function parseCommitLine(line) {
  const [subjectPart, ...bodyParts] = line.split('|')
  const subject = subjectPart.trim()
  if (!subject || /^Merge\b/i.test(subject)) return null

  const body = bodyParts.join('|')
  const match = /^([a-z]+)(?:\(([^)]+)\))?(!)?:\s*(.*)$/i.exec(subject)
  if (!match) return null
  const [, type, scope, bang, rest] = match
  const cleanSubject = rest.trim()
  if (!cleanSubject) return null

  return {
    type: type.toLowerCase(),
    scope: scope || null,
    subject: cleanSubject,
    breaking: Boolean(bang) || /BREAKING CHANGE/i.test(body),
  }
}

const TYPE_GROUPS = {
  feat: 'features',
  fix: 'fixed',
  docs: 'docs',
  perf: 'performance',
  security: 'security',
}

/**
 * Group parsed commits into release-note sections. Breaking commits take
 * precedence over their type group; unknown conventional types land in
 * maintenance. Entries keep git log order.
 *
 * @param {Array<ReturnType<typeof parseCommitLine>>} entries
 * @returns {{breaking: Array, features: Array, fixed: Array, docs: Array,
 *            performance: Array, security: Array, maintenance: Array}}
 */
export function groupCommits(entries) {
  const groups = {
    breaking: [],
    features: [],
    fixed: [],
    docs: [],
    performance: [],
    security: [],
    maintenance: [],
  }
  for (const entry of entries) {
    if (!entry) continue
    const bucket = entry.breaking ? 'breaking' : (TYPE_GROUPS[entry.type] ?? 'maintenance')
    groups[bucket].push(entry)
  }
  return groups
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** One bullet: `- **<scope>** — <subject>`; without a scope the whole
 *  subject becomes the bold summary. */
function bullet(entry) {
  return entry.scope ? `- **${entry.scope}** — ${entry.subject}` : `- **${entry.subject}**`
}

/** Section order — Breaking first (highest visibility), then type groups. */
const MARKDOWN_SECTIONS = [
  ['breaking', '💥 Breaking'],
  ['features', '✨ Features'],
  ['fixed', '🐞 Fixed'],
  ['performance', '⚡ Performance'],
  ['security', '🛡️ Security'],
  ['docs', '📚 Documentation'],
  ['maintenance', '🔧 Maintenance'],
]

/**
 * Render grouped commits as emoji-sectioned markdown (the CLI stdout).
 * Returns '' when there is nothing to report.
 *
 * @param {ReturnType<typeof groupCommits>} groups
 * @returns {string}
 */
export function renderMarkdown(groups) {
  const blocks = []
  for (const [key, heading] of MARKDOWN_SECTIONS) {
    if (!groups[key]?.length) continue
    blocks.push(`## ${heading}\n${groups[key].map(bullet).join('\n')}`)
  }
  return blocks.join('\n\n')
}

/** Keep-a-Changelog subsection order for versioned CHANGELOG entries. */
const CHANGELOG_SECTIONS = [
  ['added', '### Added', (g) => g.features],
  [
    'changed',
    '### Changed',
    (g) => [
      ...(g.breaking ?? []),
      ...(g.performance ?? []),
      ...(g.docs ?? []),
      ...(g.maintenance ?? []),
    ],
  ],
  ['fixed', '### Fixed', (g) => g.fixed],
  ['security', '### Security', (g) => g.security],
]

/**
 * Render grouped commits as Keep-a-Changelog subsections
 * (### Added / Changed / Fixed / Security). Used by
 * `versioning.mjs apply --notes` to pre-fill the promoted [Unreleased] entry.
 *
 * @param {ReturnType<typeof groupCommits>} groups
 * @returns {string}
 */
export function renderChangelog(groups) {
  const blocks = []
  for (const [, heading, pick] of CHANGELOG_SECTIONS) {
    const entries = pick(groups)
    if (!entries?.length) continue
    blocks.push(`${heading}\n${entries.map(bullet).join('\n')}`)
  }
  return blocks.join('\n\n')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  const draft = process.argv.includes('--draft')
  let since = null

  if (draft) {
    console.error(`release-notes: draft mode — last ${DRAFT_RANGE} commits (no tag lookup)`)
  } else {
    since = getLastTag()
    if (!tagExists(since)) {
      since = null
      console.error('release-notes: no stable vX.Y.Z tag — falling back to draft mode')
    } else {
      console.error(`release-notes: ${since}..HEAD`)
    }
  }

  const raw = collectEntries({ since, draft: since === null })
  const groups = groupCommits(raw.map(parseCommitLine))
  const markdown = renderMarkdown(groups)
  const sectionCount = Object.values(groups).filter((g) => g.length).length

  if (raw.length === 0) {
    console.error(`release-notes: no commits to group${since ? ` since ${since}` : ''}`)
  } else {
    console.error(`release-notes: ${raw.length} commits grouped into ${sectionCount} section(s)`)
  }

  if (markdown) process.stdout.write(`${markdown}\n`)
}
