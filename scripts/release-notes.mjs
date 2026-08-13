#!/usr/bin/env node
/**
 * release-notes.mjs — generate release notes from conventional commits
 *
 * Bridges the conventional-commit pipeline (commitlint: 12 types / 40 scopes)
 * to the CHANGELOG / release-body content. Reads `git log <lastTag>..HEAD`
 * (subject + body per commit), groups commits by type, and prints markdown
 * ready to paste into the [Unreleased] CHANGELOG section.
 *
 * Groups (section order — user-facing first):
 *   🆕 What's New      feat | perf | docs
 *                       (docs are user-facing — no dedicated group)
 *   🐞 Fixed           fix | security
 *   ⚠️ Known Issues    manual — CLI flag `--known-issues "text"` (repeatable);
 *                       the group is OMITTED when the flag is absent (never
 *                       emitted empty)
 *   ✅ Closed Issues   issue refs parsed from commit BODIES (%b):
 *                       `Closes #N` / `Fixes #N` / `Resolves #N` — one
 *                       bullet `- #N - <subject>` per referenced issue
 *                       (deduped); the group is OMITTED when no refs exist
 *
 * Omitted (internal, never user-facing): chore | refactor | test | ci |
 * build | style | revert (unknown conventional types too).
 *
 * Breaking: `BREAKING CHANGE` footer or `type!:` / `type(scope)!:` — the
 * commit keeps its type bucket and the bullet is prefixed with 💥
 * (e.g. `- 💥 **scope** — subject`). No dedicated Breaking group.
 *
 * Skipped: merge commits ("Merge ..."), empty-subject commits (trivial
 * chores), and non-conventional subjects (grandfathered history only).
 *
 * Bullet format:
 *   - **<scope>** — <subject without the type(scope): prefix>   (scope present)
 *   - **<subject>**                                              (no scope)
 *
 * Usage:
 *   node scripts/release-notes.mjs                          # lastTag..HEAD
 *   node scripts/release-notes.mjs --draft                  # last 30 commits
 *   node scripts/release-notes.mjs --known-issues "widget API is unstable"
 *                                                           # manual ⚠️ entry
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
 * Parse issue references from a commit body: `Closes #N`, `Fixes #N` or
 * `Resolves #N` (case-insensitive). Returns the numbers in order of
 * appearance; empty when the body references nothing.
 *
 * @param {string} body - the raw commit body (may be '')
 * @returns {number[]}
 */
function parseIssueRefs(body) {
  return [...body.matchAll(/\b(?:Closes|Fixes|Resolves)\s+#(\d+)\b/gi)].map((m) => Number(m[1]))
}

/**
 * Parse one "subject|body" record into a conventional-commit entry.
 * Returns null for records that must be skipped: merge commits ("Merge ..."),
 * non-conventional subjects, and empty-subject (trivial) commits.
 *
 * @param {string} line
 * @returns {{type: string, scope: string|null, subject: string,
 *            breaking: boolean, refs: number[]}|null}
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
    refs: parseIssueRefs(body),
  }
}

/**
 * Conventional type → final release-note group. Types missing from this map
 * (chore, refactor, test, ci, build, style, revert, unknown) are internal
 * and omitted from the notes.
 */
const TYPE_GROUPS = {
  feat: 'whatsNew',
  perf: 'whatsNew',
  docs: 'whatsNew',
  fix: 'fixed',
  security: 'fixed',
}

/**
 * Group parsed commits into the final release-note sections. Breaking
 * commits keep their type bucket (the 💥 marker is applied at render time);
 * internal types are dropped; issue refs from ANY commit body feed
 * closedIssues (deduped, first occurrence wins). Entries keep git log order.
 *
 * @param {Array<ReturnType<typeof parseCommitLine>>} entries
 * @param {{knownIssues?: string[]|string|null}} [options]
 *   knownIssues — manual Known Issues entries (CLI --known-issues). Omitted
 *   (empty array) when not provided.
 * @returns {{whatsNew: Array, fixed: Array, knownIssues: string[],
 *            closedIssues: Array<{ref: number, subject: string}>}}
 */
export function groupCommits(entries, options = {}) {
  const { knownIssues = [] } = options
  const groups = {
    whatsNew: [],
    fixed: [],
    knownIssues: Array.isArray(knownIssues) ? [...knownIssues] : knownIssues ? [knownIssues] : [],
    closedIssues: [],
  }
  const seenRefs = new Set()
  for (const entry of entries) {
    if (!entry) continue
    const bucket = TYPE_GROUPS[entry.type]
    if (bucket) groups[bucket].push(entry)
    for (const ref of entry.refs) {
      if (seenRefs.has(ref)) continue
      seenRefs.add(ref)
      groups.closedIssues.push({ ref, subject: entry.subject })
    }
  }
  return groups
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** One bullet: `- **<scope>** — <subject>`; without a scope the whole
 *  subject becomes the bold summary. Breaking bullets get a 💥 prefix. */
function bullet(entry) {
  const prefix = entry.breaking ? '💥 ' : ''
  return entry.scope
    ? `- ${prefix}**${entry.scope}** — ${entry.subject}`
    : `- ${prefix}**${entry.subject}**`
}

/** One Closed Issues bullet: `- #N - <subject>` (subject may be absent). */
function closedIssueBullet({ ref, subject }) {
  return subject ? `- #${ref} - ${subject}` : `- #${ref}`
}

/** Section order — user-facing first, Known Issues then Closed Issues. */
const MARKDOWN_SECTIONS = [
  ['whatsNew', "🆕 What's New"],
  ['fixed', '🐞 Fixed'],
  ['knownIssues', '⚠️ Known Issues'],
  ['closedIssues', '✅ Closed Issues'],
]

/** Render one entry for its section (strings for Known Issues). */
function renderEntry(key, entry) {
  if (key === 'knownIssues') return `- ${entry}`
  if (key === 'closedIssues') return closedIssueBullet(entry)
  return bullet(entry)
}

/**
 * Render grouped commits as emoji-sectioned markdown (the CLI stdout and the
 * CHANGELOG body). Returns '' when there is nothing to report.
 *
 * @param {ReturnType<typeof groupCommits>} groups
 * @returns {string}
 */
export function renderMarkdown(groups) {
  const blocks = []
  for (const [key, heading] of MARKDOWN_SECTIONS) {
    if (!groups[key]?.length) continue
    blocks.push(`## ${heading}\n${groups[key].map((entry) => renderEntry(key, entry)).join('\n')}`)
  }
  return blocks.join('\n\n')
}

/**
 * Render grouped commits for a CHANGELOG version entry. Used by
 * `versioning.mjs apply --notes` to pre-fill the promoted [Unreleased] entry.
 * Emits the SAME final emoji groups as renderMarkdown — the CHANGELOG uses
 * the emoji format.
 *
 * @param {ReturnType<typeof groupCommits>} groups
 * @returns {string}
 */
export function renderChangelog(groups) {
  return renderMarkdown(groups)
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** Collect every `--known-issues <text>` value from argv (repeatable). */
function parseKnownIssues(argv) {
  const issues = []
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--known-issues' && argv[i + 1]) {
      issues.push(argv[i + 1])
      i += 1
    }
  }
  return issues
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  const args = process.argv.slice(2)
  const draft = args.includes('--draft')
  const knownIssues = parseKnownIssues(args)
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
  const groups = groupCommits(raw.map(parseCommitLine), { knownIssues })
  const markdown = renderMarkdown(groups)
  const sectionCount = Object.values(groups).filter((g) => g.length).length

  if (raw.length === 0) {
    console.error(`release-notes: no commits to group${since ? ` since ${since}` : ''}`)
  } else {
    console.error(`release-notes: ${raw.length} commits grouped into ${sectionCount} section(s)`)
  }

  if (markdown) process.stdout.write(`${markdown}\n`)
}
