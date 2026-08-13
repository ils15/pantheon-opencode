#!/usr/bin/env node
/**
 * versioning.mjs — Pantheon release versioning helper
 *
 * Commands:
 *   recommend            Analyze commits and suggest next version bump type
 *   apply [type]         Bump manifests + move [Unreleased] → [vX.Y.Z] in CHANGELOG
 *                        type: patch | minor | major | auto (default: auto)
 *   changelog [ver]      (Internal) Insert a versioned section into CHANGELOG
 *                        Normally called by `apply`; can be run standalone.
 *   status               Show current version, latest tag, and pending bump type
 *
 * Design: the release signal is "package.json version > latest git tag".
 * Developers (or AI agents) call `apply` to bump + update CHANGELOG, then push.
 * The auto-release workflow detects the version bump and creates the release.
 * No version bumping ever happens inside GitHub Actions.
 */

import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectEntries, groupCommits, parseCommitLine, renderChangelog } from './release-notes.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const MANIFEST_FILES = [
  // 'platform/forge.json' removed in v1.0 — directory no longer exists
  'pyproject.toml',
  'package.json',
  'plugin.json',
  'src/plugins/tui/package.json',
]

const CHANGELOG_PATH = join(ROOT, 'CHANGELOG.md')

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

function getLatestTag() {
  // Stable tags only: strict vX.Y.Z with NO pre-release suffix.
  // The loose glob `v[0-9]*.[0-9]*.[0-9]*` ALSO matches v1.2.0-beta.9.*
  // (the trailing `*` swallows the -beta suffix), which would poison the
  // version gate — so filter strictly before sorting.
  const tag = run("git tag -l 'v*' | grep -E '^v[0-9]+\\.[0-9]+\\.[0-9]+$' | sort -V | tail -1")
  return tag || 'v0.0.0'
}

function getCurrentVersion() {
  return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version
}

// ---------------------------------------------------------------------------
// Semver helpers
// ---------------------------------------------------------------------------

function bumpVersion(version, type) {
  const [major, minor, patch] = version.split('.').map(Number)
  switch (type) {
    case 'major':
      return `${major + 1}.0.0`
    case 'minor':
      return `${major}.${minor + 1}.0`
    default:
      return `${major}.${minor}.${patch + 1}`
  }
}

function analyzeConventionalCommits(since) {
  const log = run(`git log ${since}..HEAD --format="%s"`)
  if (!log) return 'patch'
  let bump = 'patch'
  for (const msg of log.split('\n').filter(Boolean)) {
    if (/BREAKING CHANGE/i.test(msg) || /^[a-z]+!/i.test(msg)) return 'major'
    if (/^feat/i.test(msg)) bump = 'minor'
  }
  return bump
}

// ---------------------------------------------------------------------------
// Manifest updater
// ---------------------------------------------------------------------------

function updateManifests(newVersion) {
  for (const file of MANIFEST_FILES) {
    const path = join(ROOT, file)
    try {
      const raw = readFileSync(path, 'utf-8')
      if (file.endsWith('.toml')) {
        // TOML: replace version = "X.Y.Z"
        const updated = raw.replace(/^(version\s*=\s*")[^"]+(")/m, `$1${newVersion}$2`)
        writeFileSync(path, updated)
        console.log(`  ✓ ${file} → ${newVersion}`)
      } else {
        // JSON
        const content = JSON.parse(raw)
        content.version = newVersion
        writeFileSync(path, `${JSON.stringify(content, null, 2)}\n`)
        console.log(`  ✓ ${file} → ${newVersion}`)
      }
    } catch {
      console.log(`  ⚠ ${file} not found — skipped`)
    }
  }
}

// ---------------------------------------------------------------------------
// CHANGELOG updater
//
// Finds the [Unreleased] section and:
//   1. Strips empty subsections (### Added, ## 🆕 What's New, ...)
//   2. Renames [Unreleased] → [vX.Y.Z] - date
//   3. Inserts a fresh empty [Unreleased] template above it
//
// `notesBody` (from `apply --notes`) replaces the manual body of the
// promoted entry with release notes generated from conventional commits
// (rendered via release-notes.mjs renderChangelog — the final emoji groups
// 🆕/🐞/⚠️/✅). When notesBody is provided the empty-[Unreleased] early
// return is bypassed.
// ---------------------------------------------------------------------------

// A section header that adds no user-facing content: the legacy
// Keep-a-Changelog ### subsections and the emoji release-note groups.
const EMPTY_SECTION_HEADER =
  /^(?:### \w|## 🆕 What's New|## 🐞 Fixed|## ⚠️ Known Issues|## ✅ Closed Issues)/

/**
 * Neutralize HTML comment delimiters in body content derived from commit
 * messages before it is written into CHANGELOG.md. CodeQL's changelog-
 * injection rule flags interpolating untrusted markdown into a file that
 * also carries HTML comments: a `-->` in a commit subject (surfaced via
 * `apply --notes`) would terminate the template comment early and let the
 * surrounding markdown render as HTML. Escaping BOTH delimiters keeps the
 * emitted body inert regardless of the input commit messages.
 */
function sanitizeCommentDelimiters(body) {
  return body.replace(/<!--/g, '&lt;!--').replace(/-->/g, '--&gt;')
}

// Any markdown header — used to find the end of a section's content.
const ANY_HEADER = /^(?:### |## )/

/**
 * Remove empty subsections from a changelog body: a recognized section
 * header with no content (non-blank, non-header lines) before the next
 * header or end of body is dropped together with its trailing blank lines.
 */
function stripEmptySections(body) {
  const lines = body.split('\n')
  const keep = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (!EMPTY_SECTION_HEADER.test(line)) {
      keep.push(line)
      continue
    }
    let j = i + 1
    let hasContent = false
    while (j < lines.length && !ANY_HEADER.test(lines[j])) {
      if (lines[j].trim()) hasContent = true
      j += 1
    }
    if (hasContent) {
      keep.push(line)
      continue
    }
    // Empty section: drop the header and any blank lines up to the next
    // header so the section leaves no empty gap.
    while (i + 1 < lines.length && lines[i + 1].trim() === '') i += 1
  }
  return keep.join('\n').replace(/\n{3,}/g, '\n\n')
}

function promoteUnreleased(newVersion, dateStr, notesBody = null) {
  const content = readFileSync(CHANGELOG_PATH, 'utf-8')

  const unreleasedHeader = '## [Unreleased]'
  const idx = content.indexOf(unreleasedHeader)
  if (idx === -1) {
    console.log('  ⚠ [Unreleased] section not found in CHANGELOG — skipping')
    return false
  }

  // Find the end of [Unreleased]: next ## header or end of file
  const afterHeader = idx + unreleasedHeader.length
  const nextSectionIdx = content.indexOf('\n## [', afterHeader)
  const unreleasedBody =
    nextSectionIdx === -1 ? content.slice(afterHeader) : content.slice(afterHeader, nextSectionIdx)

  // Check if the [Unreleased] section has any real content (non-empty lines
  // that aren't just section headers or comments). HTML comments (the
  // template hint) are removed first — they span multiple lines.
  let bodyWithoutComments = unreleasedBody
  let previousBody
  do {
    previousBody = bodyWithoutComments
    bodyWithoutComments = bodyWithoutComments.replace(/<!--[\s\S]*?-->/g, '')
  } while (bodyWithoutComments !== previousBody)
  const realLines = bodyWithoutComments
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('###') && !l.startsWith('## '))

  if (notesBody === null && realLines.length === 0) {
    console.log('  ℹ [Unreleased] is empty — CHANGELOG not modified')
    return false
  }

  if (notesBody !== null && realLines.length > 0) {
    console.log(
      '  ⚠ --notes replaces the manual [Unreleased] content — review the diff before committing',
    )
  }

  // Strip lines that are just empty subsections (### X or ## 🆕/🐞/⚠️/✅
  // followed by blank lines then another header or end)
  const cleanedBody =
    notesBody !== null ? `\n\n${notesBody}` : stripEmptySections(unreleasedBody).trimEnd()
  // Sanitize the WRITTEN body only (never the strip pass): commit-derived
  // notes can carry `<!--` / `-->`, which CodeQL flags as changelog
  // injection when interpolated next to the template's HTML comment.
  const writtenBody = sanitizeCommentDelimiters(cleanedBody)

  const newTemplate = `\n\n<!-- Add new changes here. Running \`node scripts/versioning.mjs apply\` will\n     move this section to a versioned entry and reset the template below. -->\n\n## 🆕 What's New\n\n## 🐞 Fixed\n\n## ⚠️ Known Issues\n\n## ✅ Closed Issues`
  const newVersionHeader = `## [v${newVersion}] - ${dateStr}`

  const before = content.slice(0, idx)
  const after = nextSectionIdx === -1 ? '' : content.slice(nextSectionIdx)

  const updated = `${before + unreleasedHeader + newTemplate}\n\n${newVersionHeader}${writtenBody}${after}`

  writeFileSync(CHANGELOG_PATH, updated)
  console.log(
    notesBody !== null
      ? `  ✓ CHANGELOG: [Unreleased] → [v${newVersion}] (notes generated from commits)`
      : `  ✓ CHANGELOG: [Unreleased] → [v${newVersion}]`,
  )
  return true
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const command = process.argv[2]
const arg = process.argv[3]

switch (command) {
  case 'status': {
    const latestTag = getLatestTag()
    const current = getCurrentVersion()
    const latestVer = latestTag.replace(/^v/, '')
    const bump = analyzeConventionalCommits(latestTag)
    const next = bumpVersion(current, bump)
    const needsRelease = current !== latestVer

    console.log(`Current version  : ${current}`)
    console.log(`Latest git tag   : ${latestTag}`)
    console.log(
      `Release pending  : ${needsRelease ? `YES — tag ${latestTag} < pkg ${current}` : 'NO — already tagged'}`,
    )
    console.log(`Recommended bump : ${bump}`)
    console.log(`Next version     : ${next}`)
    break
  }

  case 'recommend': {
    const latestTag = getLatestTag()
    const bump = analyzeConventionalCommits(latestTag)
    const current = getCurrentVersion()
    console.log(bumpVersion(current, bump))
    break
  }

  case 'apply': {
    const args = process.argv.slice(3)
    const useNotes = args.includes('--notes')
    const type = args.find((a) => !a.startsWith('--')) || 'auto'
    const latestTag = getLatestTag()
    const current = getCurrentVersion()
    const latestVer = latestTag.replace(/^v/, '')

    // `apply --notes` pre-fills the promoted [Unreleased] entry with release
    // notes generated from conventional commits (release-notes.mjs). Default
    // stays manual — the flag is opt-in.
    const generateNotes = () => {
      if (!useNotes) return null
      const since = latestTag === 'v0.0.0' ? null : latestTag
      const raw = collectEntries({ since, draft: since === null })
      const body = renderChangelog(groupCommits(raw.map(parseCommitLine)))
      if (!body) {
        console.log('  ⚠ --notes: no groupable commits — manual [Unreleased] content used')
        return null
      }
      console.log(`  ℹ --notes: release notes generated from ${raw.length} commits`)
      return body
    }

    // If package.json is already ahead of the latest tag, someone bumped
    // without tagging — warn and use the current version as-is. Tags are
    // workflow-owned, so there is nothing to create here.
    if (current !== latestVer) {
      console.log(`⚠ package.json (${current}) already ahead of latest tag (${latestTag}).`)
      console.log(`  Syncing all manifests to ${current} and promoting CHANGELOG.`)
      updateManifests(current)
      const date = new Date().toISOString().slice(0, 10)
      promoteUnreleased(current, date, generateNotes())
      console.log(`Tag v${current} will be created by the release workflow after merge to main.`)
      break
    }

    const bumpType = type === 'auto' ? analyzeConventionalCommits(latestTag) : type
    const newVersion = bumpVersion(current, bumpType)
    const date = new Date().toISOString().slice(0, 10)

    console.log(`Bumping ${current} → ${newVersion} (${bumpType})`)
    updateManifests(newVersion)
    promoteUnreleased(newVersion, date, generateNotes())
    console.log(`\nDone. Commit with: git add -A && git commit -m "chore(release): v${newVersion}"`)

    // Tags are owned by the release workflow — never create them locally.
    // A local tag on a pre-merge commit drifts from the merged main state
    // (the untagged-v1.2.1 root cause) and would desync the version gate.
    console.log(`Tag v${newVersion} will be created by the release workflow after merge to main.`)
    break
  }

  // Legacy standalone command — kept for backward compat
  case 'changelog': {
    const version = arg || getCurrentVersion()
    const date = new Date().toISOString().slice(0, 10)
    promoteUnreleased(version, date)
    break
  }

  default:
    console.log(`Usage: node scripts/versioning.mjs <command>

Commands:
  status               Show current version, latest tag, release status
  recommend            Print recommended bump type (patch/minor/major)
  apply [type]         Bump manifests + move [Unreleased] → [vX.Y.Z]
                       type: patch | minor | major | auto (default: auto)
                       --notes: pre-fill the promoted entry with release
                       notes generated from conventional commits
  changelog [version]  Promote [Unreleased] → [vX.Y.Z] without bumping

Release flow:
  1. node scripts/versioning.mjs apply [minor]
  2. git add -A && git commit -m "chore(release): vX.Y.Z"
  3. git push     ← CI passes → auto-release fires because pkg > tag
`)
}
