#!/usr/bin/env node
/**
 * Keep a Changelog structural check for CHANGELOG.md.
 *
 * Fails on:
 *   - a version heading with the wrong shape;
 *   - an H3 outside {Added, Changed, Deprecated, Removed, Fixed, Security}
 *     inside the maintained sections ([Unreleased] and [v1.6.0]);
 *   - a bullet over 200 characters in those sections;
 *   - an empty subsection under [Unreleased];
 *   - any `## 🆕|🐞|⚠️|✅` H2 anywhere;
 *   - a missing Deprecated or Removed block in [v1.6.0].
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
const CURRENT_VERSION_HEADING = /^## \[v1\.6\.0\] - \d{4}-\d{2}-\d{2}$/
// Historical headings may carry a pre-release suffix, a month-only date, or a
// "(candidate)" marker. The current version above is held to the exact shape.
const HISTORICAL_VERSION_HEADING =
  /^## \[v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\](?: - \d{4}-\d{2}(?:-\d{2})?)?(?: \(candidate\))?$/
const UNRELEASED_HEADING = /^## \[Unreleased\]$/
const LOOKS_LIKE_VERSION = /^##\s+(?:\[?v?\d+\.\d+)/

function charCount(text) {
  return [...text].length
}

function main() {
  const lines = readFileSync(CHANGELOG, 'utf8').split(/\r?\n/)
  const findings = []
  const maintainedH3 = new Map() // section name -> Map<h3, empty>

  let section = null // { name, maintained }
  let currentH3 = null
  let currentH3Empty = false

  const headingsFor = (name) => {
    if (!maintainedH3.has(name)) maintainedH3.set(name, new Map())
    return maintainedH3.get(name)
  }

  const commitH3 = () => {
    if (section?.maintained && currentH3 !== null) {
      headingsFor(section.name).set(currentH3, currentH3Empty)
    }
    currentH3 = null
    currentH3Empty = false
  }

  const closeSection = () => {
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
      if (CURRENT_VERSION_HEADING.test(line)) {
        section = { name: '1.6.0', maintained: true }
        headingsFor('1.6.0')
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

    if (section?.maintained && currentH3 !== null) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('<!--')) currentH3Empty = false
    }

    if (section?.maintained && line.startsWith('- ') && charCount(line) > MAX_BULLET) {
      findings.push(
        `${lineNo}: bullet is ${charCount(line)} chars (max ${MAX_BULLET}): ${line.slice(0, 60)}…`,
      )
    }
  }
  closeSection()

  for (const [heading, empty] of headingsFor('Unreleased')) {
    if (empty) findings.push(`[Unreleased] has an empty "${heading}" subsection`)
  }

  const v160 = headingsFor('1.6.0')
  if (!v160.has('Deprecated')) findings.push('[v1.6.0] is missing the Deprecated block')
  if (!v160.has('Removed')) findings.push('[v1.6.0] is missing the Removed block')

  if (findings.length === 0) {
    console.log(`docs:check-changelog OK — ${lines.length} lines, no findings.`)
    return
  }

  for (const finding of findings) console.error(`CHANGELOG.md:${finding}`)
  console.error(`\ndocs:check-changelog failed — ${findings.length} finding(s).`)
  process.exitCode = 1
}

main()
