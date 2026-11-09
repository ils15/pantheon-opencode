#!/usr/bin/env node
/**
 * release-retrofit.mjs — one-off standardization of the existing GitHub
 * releases onto the canonical format (docs/RELEASING.md).
 *
 * Two actions per release:
 *   1. Title  → always `Pantheon <tag>` (the workflow-set format). Applies to
 *      EVERY release, pre-releases included.
 *   2. Body   → stable releases whose tag carries a `## [<version>]` section
 *      in that tag's CHANGELOG.md get the section republished verbatim —
 *      restoring the invariant "release body == CHANGELOG section at the tag"
 *      that the release workflow now enforces on every re-run. Pre-releases
 *      and tags without a section are left untouched (archived records).
 *
 * Dry-run by default: prints the planned actions and exits. `--apply` backs
 * every current release (title + body) up to release-retrofit-backup.json in
 * the repo root, then edits. The backup is the undo path — delete it only
 * after reviewing the results, and never commit it.
 *
 * Usage:
 *   node scripts/release-retrofit.mjs            # dry-run
 *   node scripts/release-retrofit.mjs --apply    # backup + edit via gh
 *
 * Requires: gh authenticated for the repo, tags fetched
 * (`git fetch --tags` if a tag is missing locally).
 */

import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { extractSection } from './changelog-extract.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BACKUP_PATH = join(ROOT, 'release-retrofit-backup.json')
const STABLE_TAG = /^v\d+\.\d+\.\d+$/

function git(args, { quiet = false } = {}) {
  try {
    return execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf-8' }).trim()
  } catch (error) {
    if (quiet) return ''
    throw new Error(`git ${args} failed: ${error.message}`)
  }
}

function gh(args) {
  return execSync(`gh ${args}`, { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
}

/** Every release: one JSON line per item ({tag, name, body, prerelease}). */
function fetchReleases() {
  const repo = git('remote get-url origin')
    .replace(/^git@github\.com:/, '')
    .replace(/\.git$/, '')
  const out = gh(
    `api "repos/${repo}/releases?per_page=100" --paginate -q '.[] | {tag: .tag_name, name, body: (.body // ""), prerelease}'`,
  )
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

function sectionAtTag(tag) {
  if (git(`rev-parse --verify --quiet ${tag}^{commit}`, { quiet: true }) === '') {
    return { found: false, reason: 'tag not fetched locally (git fetch --tags)' }
  }
  let changelog
  try {
    changelog = git(`show ${tag}:CHANGELOG.md`)
  } catch {
    return { found: false, reason: 'no CHANGELOG.md at tag' }
  }
  const { found, body } = extractSection(changelog, tag)
  if (!found || !body) return { found: false, reason: 'no section in the tag CHANGELOG' }
  return { found: true, body }
}

function main() {
  const apply = process.argv.includes('--apply')
  const releases = fetchReleases()
  const planned = []
  let titles = 0
  let bodies = 0

  for (const release of releases) {
    const expectedTitle = `Pantheon ${release.tag}`
    const titleAction = release.name === expectedTitle ? null : `${release.name} → ${expectedTitle}`
    let bodyAction = 'keep'
    let bodySource = ''

    if (STABLE_TAG.test(release.tag)) {
      const section = sectionAtTag(release.tag)
      if (section.found) {
        bodySource = `CHANGELOG @ ${release.tag} (${section.body.length} bytes)`
        if (release.body.replace(/\s+$/, '') !== section.body.replace(/\s+$/, '')) {
          bodyAction = 'REWRITE'
        }
      } else {
        bodySource = section.reason
      }
    } else {
      bodySource = 'pre-release: title only'
    }

    if (titleAction) titles += 1
    if (bodyAction === 'REWRITE') bodies += 1
    planned.push({ ...release, expectedTitle, titleAction, bodyAction, bodySource })
  }

  for (const action of planned) {
    const title = action.titleAction ?? 'ok'
    console.log(
      `${action.tag.padEnd(20)} title: ${title.padEnd(46)} body: ${action.bodyAction.padEnd(7)} ${action.bodySource}`,
    )
  }
  console.log(`\n${planned.length} release(s): ${titles} title edit(s), ${bodies} body rewrite(s).`)

  if (!apply) {
    console.log('dry-run — re-run with --apply to execute (a backup is written first).')
    return
  }

  if (titles + bodies === 0) {
    console.log('nothing to do.')
    return
  }

  writeFileSync(BACKUP_PATH, `${JSON.stringify(planned, null, 2)}\n`)
  console.log(`backup written: ${BACKUP_PATH}`)

  for (const action of planned) {
    if (!action.titleAction && action.bodyAction !== 'REWRITE') continue
    const flags = []
    if (action.titleAction) flags.push(`--title "${action.expectedTitle}"`)
    if (action.bodyAction === 'REWRITE') {
      const notesPath = join(tmpdir(), `release-retrofit-${action.tag}.md`)
      writeFileSync(notesPath, `${sectionBody(action)}\n`)
      flags.push(`--notes-file "${notesPath}"`)
    }
    gh(`release edit ${action.tag} ${flags.join(' ')}`)
    console.log(`edited ${action.tag}`)
  }
  console.log('done — verify with `gh release list` and `gh release view <tag>`.')
}

/** Resolve the section body for an action at apply time (single lookup). */
function sectionBody(action) {
  const section = sectionAtTag(action.tag)
  if (!section.found) throw new Error(`${action.tag}: section vanished between dry-run and apply`)
  return section.body
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) main()
