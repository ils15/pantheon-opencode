#!/usr/bin/env node
/**
 * changelog-extract.mjs — print a version section from CHANGELOG.md
 *
 * The release workflow needs the CHANGELOG entry for the version it is about
 * to tag. This script extracts the body of `## [<version>] - YYYY-MM-DD`
 * (leading `v` tolerated, date optional) and prints it to stdout. When the
 * section is missing it exits 1, so the workflow fails loudly: "add the
 * section in the version-bump PR".
 *
 * Usage:
 *   node scripts/changelog-extract.mjs 1.2.1
 *   node scripts/changelog-extract.mjs v1.2.1 --changelog /path/to/CHANGELOG.md
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_CHANGELOG = join(dirname(fileURLToPath(import.meta.url)), '..', 'CHANGELOG.md')

/** Escape regex metacharacters so a version like 1.0.0 matches literally. */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Extract the body of a version section from changelog text.
 *
 * Finds the heading `## [<version>] - YYYY-MM-DD` (leading `v` and the date
 * are optional) and returns everything after the heading line up to the next
 * `## [` heading (or end of text). The `## [Unreleased]` heading is never
 * matched, even when asked for explicitly.
 *
 * @param {string} changelogText - full CHANGELOG.md content
 * @param {string} version - e.g. "1.2.1" or "v1.2.1"
 * @returns {{found: boolean, body: string|null}} body is null when not found
 */
export function extractSection(changelogText, version) {
  const normalized = String(version).trim().replace(/^v/i, '')
  if (!normalized || /^unreleased$/i.test(normalized)) {
    return { found: false, body: null }
  }

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

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  const args = process.argv.slice(2)
  let changelogPath = DEFAULT_CHANGELOG
  let version = null

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--changelog') {
      changelogPath = args[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--changelog=')) {
      changelogPath = arg.slice('--changelog='.length)
      continue
    }
    version = arg
  }

  if (!version) {
    console.error('Usage: node scripts/changelog-extract.mjs <version> [--changelog <path>]')
    process.exitCode = 2
  } else {
    let text
    try {
      text = readFileSync(changelogPath, 'utf-8')
    } catch {
      console.error(`changelog-extract: cannot read ${changelogPath}`)
      process.exitCode = 1
    }

    if (text !== undefined) {
      const { found, body } = extractSection(text, version)
      if (!found) {
        console.error(`changelog-extract: section [${version}] not found in ${changelogPath}`)
        console.error('Add the section in the version-bump PR — the release workflow requires it.')
        process.exitCode = 1
      } else {
        process.stdout.write(`${body}\n`)
        process.exitCode = 0
      }
    }
  }
}
