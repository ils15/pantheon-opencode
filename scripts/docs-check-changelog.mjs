#!/usr/bin/env node
/**
 * Keep a Changelog structural check for CHANGELOG.md.
 *
 * Fails on:
 *   - a version heading with the wrong shape;
 *   - any emoji H2 except the generated `🆕 What's New` and `🐞 Fixed` headings;
 *   - a MAINTAINED section ([Unreleased] or the newest stable version) that
 *     violates the canonical section format — allowed H3 set and order, the
 *     What's New window contract (≤6 bullets, ≤140 chars, bold lead),
 *     bullet shapes, empty subsections, and placeholders. The rules live in
 *     scripts/changelog-format.mjs, shared with the release gate, so CI
 *     catches at PR time exactly what the release would fail on.
 *
 * Historical sections are archived records: only their version-heading shape
 * and the emoji-H2 rule are enforced.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractSection } from './changelog-extract.mjs'
import { splitSections, validateSection } from './changelog-format.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CHANGELOG = process.argv[2] ? process.argv[2] : join(ROOT, 'CHANGELOG.md')
const EMOJI_H2 =
  /^##\s+(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3)/u
const ALLOWED_GENERATED_H2 = /^##\s+(?:🆕 What's New|🐞 Fixed)\s*$/
const STABLE_VERSION_HEADING = /^## \[v?(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$/
// Historical headings may carry a pre-release suffix, a month-only date, or a
// "(candidate)" marker.
const HISTORICAL_VERSION_HEADING =
  /^## \[v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\](?: - \d{4}-\d{2}(?:-\d{2})?)?(?: \(candidate\))?$/
const UNRELEASED_HEADING = /^## \[Unreleased\]$/
const LOOKS_LIKE_VERSION = /^##\s+(?:\[?v?\d+\.\d+)/

function newestStableVersion(lines) {
  for (const line of lines) {
    const match = STABLE_VERSION_HEADING.exec(line)
    if (match) return match[1]
  }
  return null
}

function main() {
  const text = readFileSync(CHANGELOG, 'utf8')
  const lines = text.split(/\r?\n/)
  const findings = []
  const newest = newestStableVersion(lines)

  if (newest === null) {
    console.error('CHANGELOG.md: no stable version heading found')
    process.exitCode = 1
    return
  }

  // File-level pass: heading shapes and the emoji-H2 rule (all sections).
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const lineNo = i + 1
    if (!line.startsWith('## ')) continue

    if (EMOJI_H2.test(line) && !ALLOWED_GENERATED_H2.test(line)) {
      findings.push(`${lineNo}: emoji H2 is not allowed (${line.trim()})`)
      continue
    }
    if (UNRELEASED_HEADING.test(line)) continue
    if (STABLE_VERSION_HEADING.test(line)) continue
    if (HISTORICAL_VERSION_HEADING.test(line)) continue
    if (line.startsWith('## [') || LOOKS_LIKE_VERSION.test(line)) {
      findings.push(`${lineNo}: version heading has the wrong shape (${line.trim()})`)
    }
  }

  // Maintained sections: the canonical format (shared with the release gate).
  // An empty [Unreleased] is legitimate — nothing is pending yet.
  const unreleased = splitSections(text).find((section) => section.name === 'Unreleased')
  if (unreleased?.body.trim()) {
    for (const violation of validateSection(unreleased.body, {
      label: '[Unreleased]',
      allowLeadingComment: true,
    })) {
      findings.push(violation)
    }
  }
  const newestBody = extractSection(text, newest)
  if (newestBody?.found && newestBody.body) {
    for (const violation of validateSection(newestBody.body, { label: `[v${newest}]` })) {
      findings.push(violation)
    }
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
