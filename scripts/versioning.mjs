#!/usr/bin/env node
/**
 * versioning.mjs — Pantheon release versioning helper
 *
 * Commands:
 *   recommend            Analyze commits and suggest next version bump type
 *   apply [type]         Bump manifests + move [Unreleased] → [vX.Y.Z] in CHANGELOG
 *                        type: patch | minor | major | auto (default: auto)
 *                        --beta: bump the committed beta line instead
 *   beta                 Alias for `apply --beta`
 *   changelog [ver]      (Internal) Insert a versioned section into CHANGELOG
 *                        Normally called by `apply`; can be run standalone.
 *   status               Show current version, latest tag, and pending bump type
 *
 * Design: the release signal is "package.json version > latest git tag" for
 * stable, and "package.json version is a committed X.Y.Z-beta.N" for beta.
 * Developers (or AI agents) call `apply` (or `apply --beta` / `beta`) to bump
 * the manifests and promote CHANGELOG.md, then push. The dispatch-only release
 * workflow reads the committed version and creates the release. No version
 * bumping ever happens inside GitHub Actions.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  commitPreparedUpdates,
  prepareInventoryVersion,
  SEMVER_PATTERN,
  validateInventory,
} from './manifest-inventory.mjs'
import { nextBetaVersion } from './release-beta-version.mjs'
import { collectEntries, groupCommits, parseCommitLine, renderChangelog } from './release-notes.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const CHANGELOG_PATH = join(ROOT, 'CHANGELOG.md')

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function runGit(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
}

function getLatestTag() {
  // Stable tags only: strict vX.Y.Z with NO pre-release suffix.
  // The loose glob `v[0-9]*.[0-9]*.[0-9]*` ALSO matches v1.2.0-beta.9.*
  // (the trailing `*` swallows the -beta suffix), which would poison the
  // version gate — so filter strictly before sorting.
  const tags = runGit(['tag', '-l', 'v*'])
    .split('\n')
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
  tags.sort((left, right) => compareStable(left.slice(1), right.slice(1)))
  return tags.at(-1) || 'v0.0.0'
}

function getCurrentVersion() {
  return validateInventory(ROOT).sourceVersion
}

// ---------------------------------------------------------------------------
// Semver helpers
// ---------------------------------------------------------------------------

function bumpVersion(version, type) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version)
  if (!match) throw new Error(`cannot bump invalid semver: ${version}`)
  if (!['major', 'minor', 'patch'].includes(type)) throw new Error(`invalid bump type: ${type}`)
  const [major, minor, patch] = match.slice(1).map(Number)
  switch (type) {
    case 'major':
      return `${major + 1}.0.0`
    case 'minor':
      return `${major}.${minor + 1}.0`
    default:
      return `${major}.${minor}.${patch + 1}`
  }
}

function compareStable(left, right) {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

function analyzeConventionalCommits(since) {
  const log = runGit(['log', `${since}..HEAD`, '--format=%s'])
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

function prepareManifests(newVersion) {
  if (!SEMVER_PATTERN.test(newVersion)) throw new Error(`invalid version: ${newVersion}`)
  const inventory = validateInventory(ROOT, { allowVersionDivergence: true })
  return { inventory, updates: prepareInventoryVersion(inventory, newVersion) }
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
  return body.replace(/<!--/g, '&lt;!--').replace(/--(?:!?)>/g, '--&gt;')
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

function prepareUnreleased(newVersion, dateStr, notesBody = null) {
  if (!SEMVER_PATTERN.test(newVersion)) throw new Error(`invalid changelog version: ${newVersion}`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error(`invalid changelog date: ${dateStr}`)
  if (notesBody !== null && typeof notesBody !== 'string') {
    throw new Error('generated release notes must be text')
  }
  const content = readFileSync(CHANGELOG_PATH, 'utf-8')

  const unreleasedHeader = '## [Unreleased]'
  const idx = content.indexOf(unreleasedHeader)
  if (idx === -1) throw new Error('CHANGELOG.md is missing the [Unreleased] section')

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

  if (notesBody === null && realLines.length === 0) return { changed: false, content }

  if (notesBody !== null && realLines.length > 0) {
    console.log('  --notes replaces the manual [Unreleased] content')
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

  if (!updated.includes('## [Unreleased]') || !updated.includes(newVersionHeader)) {
    throw new Error('prepared CHANGELOG.md failed structural validation')
  }
  return { changed: true, content: updated, notesGenerated: notesBody !== null }
}

function contentHasUnreleased() {
  return readFileSync(CHANGELOG_PATH, 'utf8').includes('## [Unreleased]')
}

function commitPreparedRelease(manifestPlan, changelogPlan) {
  const updates = [...manifestPlan.updates]
  if (changelogPlan.changed) {
    updates.push({ path: CHANGELOG_PATH, content: changelogPlan.content })
  }
  commitPreparedUpdates(updates)
  for (const document of manifestPlan.inventory.documents) {
    console.log(`  ✓ ${document.entry.file} → ${manifestPlan.version}`)
  }
  if (changelogPlan.changed) {
    console.log(
      changelogPlan.notesGenerated
        ? `  ✓ CHANGELOG: [Unreleased] → [v${manifestPlan.version}] (notes generated from commits)`
        : `  ✓ CHANGELOG: [Unreleased] → [v${manifestPlan.version}]`,
    )
  }
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

  case 'beta':
  case 'apply': {
    const args = process.argv.slice(3)
    const useNotes = args.includes('--notes')
    const useBeta = command === 'beta' || args.includes('--beta')

    // Beta: advance the committed X.Y.Z-beta.N line and promote the
    // [Unreleased] CHANGELOG section into [vX.Y.Z-beta.N], exactly like the
    // stable path. The committed manifest is the single source of truth — no
    // npm lookup, no git lookup, and no runtime version computation.
    if (useBeta) {
      if (!contentHasUnreleased())
        throw new Error('CHANGELOG.md is missing the [Unreleased] section')
      const current = getCurrentVersion()
      const newVersion = nextBetaVersion(current)
      const date = new Date().toISOString().slice(0, 10)
      console.log(`Bumping ${current} → ${newVersion} (beta)`)
      const changelogPlan = prepareUnreleased(newVersion, date)
      const manifestPlan = prepareManifests(newVersion)
      commitPreparedRelease({ ...manifestPlan, version: newVersion }, changelogPlan)
      console.log(`\nDone. Commit the version inventory and CHANGELOG as v${newVersion}.`)
      console.log(`Tag v${newVersion} will be created by the release workflow after merge to main.`)
      break
    }

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
      if (!body) return null
      console.log(`  --notes generated from ${raw.length} commits`)
      return body
    }

    if (!contentHasUnreleased()) throw new Error('CHANGELOG.md is missing the [Unreleased] section')
    if (current !== latestVer) {
      console.log(
        `package.json (${current}) is ahead of latest tag (${latestTag}); synchronizing inventory.`,
      )
      const date = new Date().toISOString().slice(0, 10)
      const notesBody = generateNotes()
      const changelogPlan = prepareUnreleased(current, date, notesBody)
      const manifestPlan = prepareManifests(current)
      commitPreparedRelease({ ...manifestPlan, version: current }, changelogPlan)
      console.log(`Tag v${current} will be created by the release workflow after merge to main.`)
      break
    }

    const bumpType = type === 'auto' ? analyzeConventionalCommits(latestTag) : type
    const newVersion = bumpVersion(current, bumpType)
    const date = new Date().toISOString().slice(0, 10)

    console.log(`Bumping ${current} → ${newVersion} (${bumpType})`)
    const notesBody = generateNotes()
    const changelogPlan = prepareUnreleased(newVersion, date, notesBody)
    const manifestPlan = prepareManifests(newVersion)
    commitPreparedRelease({ ...manifestPlan, version: newVersion }, changelogPlan)
    console.log(`\nDone. Commit the version inventory and CHANGELOG as v${newVersion}.`)
    console.log(`Tag v${newVersion} will be created by the release workflow after merge to main.`)
    break
  }

  // Legacy standalone command — kept for backward compat
  case 'changelog': {
    const version = arg || getCurrentVersion()
    const date = new Date().toISOString().slice(0, 10)
    const changelogPlan = prepareUnreleased(version, date)
    if (changelogPlan.changed) {
      commitPreparedUpdates([{ path: CHANGELOG_PATH, content: changelogPlan.content }])
      console.log(`  ✓ CHANGELOG: [Unreleased] → [v${version}]`)
    }
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
                       --beta: advance the committed X.Y.Z-beta.N line and
                       promote [Unreleased] → [vX.Y.Z-beta.N] in CHANGELOG
  beta                 Alias for 'apply --beta'
  changelog [version]  Promote [Unreleased] → [vX.Y.Z] without bumping

Release flow (stable):
  1. node scripts/versioning.mjs apply [minor]
  2. Commit the version inventory and CHANGELOG.
  3. Push after review; CI and the dispatch-only release workflow create the tag.

Release flow (beta):
  1. node scripts/versioning.mjs apply --beta   (or: node scripts/versioning.mjs beta)
  2. Commit the version inventory and CHANGELOG.
  3. Dispatch the release workflow with release_channel=beta.
`)
}
