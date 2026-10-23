#!/usr/bin/env node
/**
 * Keep a Changelog structural check for CHANGELOG.md.
 *
 * Fails on:
 *   - a version heading with the wrong shape;
 *   - an H3 outside {Added, Changed, Deprecated, Removed, Fixed, Security}
 *     inside the maintained sections ([Unreleased] and the newest stable
 *     version section);
 *   - a bullet over 200 characters (including continuation lines) in those
 *     sections;
 *   - an empty subsection under [Unreleased];
 *   - any `## 🆕|🐞|⚠️|✅` H2 anywhere;
 *   - a missing Deprecated or Removed block in the newest stable version.
 *
 * Historical sections are archived records: only their version-heading shape
 * and the emoji-H2 rule are enforced. The 200-character and H3 rules apply to
 * the maintained sections, where the new record is authored.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHANGELOG = process.argv[2] ? process.argv[2] : join(ROOT, 'CHANGELOG.md')
const MAX_BULLET = 200
const ALLOWED_H3 = new Set(['Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security'])
const EMOJI_H2 = /^##\s+(?:🆕|🐞|⚠️|✅)/
const STABLE_VERSION_HEADING = /^## \[v?(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/
// Historical headings may carry a pre-release suffix, a month-only date, or a
// "(candidate)" marker.
const HISTORICAL_VERSION_HEADING =
  /^## \[v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\](?: - \d{4}-\d{2}(?:-\d{2})?)?(?: \(candidate\))?$/
const UNRELEASED_HEADING = /^## \[Unreleased\]$/
const LOOKS_LIKE_VERSION = /^##\s+(?:\[?v?\d+\.\d+)/

function charCount(text) {
  return [...text].length
}

function newestStableVersion(lines) {
  for (const line of lines) {
    const match = STABLE_VERSION_HEADING.exec(line)
    if (match) return match[1]
  }
  return null
}

function main() {
  const lines = readFileSync(CHANGELOG, 'utf8').split(/\r?\n/)
  const findings = []
  const maintainedH3 = new Map() // section name -> Map<h3, empty>
  const newest = newestStableVersion(lines)

  if (newest === null) {
    console.error('CHANGELOG.md: no stable version heading found')
    process.exitCode = 1
    return
  }

  let section = null // { name, maintained }
  let currentH3 = null
  let currentH3Empty = false
  let currentBullet = null // { lineNo, parts: string[] }
  let inComment = false

  const headingsFor = (name) => {
    if (!maintainedH3.has(name)) maintainedH3.set(name, new Map())
    return maintainedH3.get(name)
  }

  const flushBullet = () => {
    if (currentBullet === null) return
    if (section?.maintained) {
      const text = currentBullet.parts.join(' ')
      if (charCount(text) > MAX_BULLET) {
        findings.push(
          `${currentBullet.lineNo}: bullet is ${charCount(text)} chars (max ${MAX_BULLET}): ${text.slice(0, 60)}…`,
        )
      }
    }
    currentBullet = null
  }

  const commitH3 = () => {
    if (section?.maintained && currentH3 !== null) {
      headingsFor(section.name).set(currentH3, currentH3Empty)
    }
    currentH3 = null
    currentH3Empty = false
  }

  const closeSection = () => {
    flushBullet()
    commitH3()
    section = null
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const lineNo = i + 1

    if (line.startsWith('## ')) {
      closeSection()

      if (EMOJI_H2.test(line)) {
        findings.push(`${lineNo}: emoji H2 is not allowed (${line.trim()})`)
        continue
      }
      if (UNRELEASED_HEADING.test(line)) {
        section = { name: 'Unreleased', maintained: true }
        headingsFor('Unreleased')
        continue
      }
      const stable = STABLE_VERSION_HEADING.exec(line)
      if (stable) {
        const name = stable[1]
        section = { name, maintained: name === newest }
        if (section.maintained) headingsFor(name)
        continue
      }
      if (HISTORICAL_VERSION_HEADING.test(line)) {
        const name = line.slice(4, line.indexOf(']')).replace(/^v/, '')
        section = { name, maintained: false }
        continue
      }
      if (line.startsWith('## [') || LOOKS_LIKE_VERSION.test(line)) {
        findings.push(`${lineNo}: version heading has the wrong shape (${line.trim()})`)
      }
      // A plain legacy H2 (historical sections) or the wrong-shape heading.
      continue
    }

    if (line.startsWith('### ')) {
      if (section?.maintained) {
        flushBullet()
        commitH3()
        const name = line.slice(4).trim()
        currentH3 = name
        currentH3Empty = true
        if (!ALLOWED_H3.has(name)) {
          findings.push(`${lineNo}: H3 "${name}" is not in the allowed set`)
        }
      }
      continue
    }

    if (!section?.maintained) continue

    if (inComment) {
      if (line.includes('-->')) inComment = false
      continue
    }
    if (line.includes('<!--')) {
      if (!line.includes('-->')) inComment = true
      continue
    }

    if (line.trim() === '') {
      flushBullet()
      continue
    }

    if (line.startsWith('- ')) {
      flushBullet()
      currentBullet = { lineNo, parts: [line] }
      if (currentH3 !== null) currentH3Empty = false
      continue
    }

    if (currentBullet !== null) {
      currentBullet.parts.push(line.trim())
      if (currentH3 !== null) currentH3Empty = false
      continue
    }

    if (currentH3 !== null) currentH3Empty = false
  }
  closeSection()

  for (const [heading, empty] of headingsFor('Unreleased')) {
    if (empty) findings.push(`[Unreleased] has an empty "${heading}" subsection`)
  }

  const newestHeadings = headingsFor(newest)
  if (!newestHeadings.has('Deprecated')) {
    findings.push(`[v${newest}] is missing the Deprecated block`)
  }
  if (!newestHeadings.has('Removed')) {
    findings.push(`[v${newest}] is missing the Removed block`)
  }

  if (findings.length === 0) {
    console.log(`docs:check-changelog OK — ${lines.length} lines, no findings.`)
    return
  }

  for (const finding of findings) console.error(`CHANGELOG.md:${finding}`)
  console.error(`\ndocs:check-changelog failed — ${findings.length} finding(s).`)
  process.exitCode = 1
}

main()
