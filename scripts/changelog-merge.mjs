/**
 * Merge pending [Unreleased] notes into an already-promoted version section.
 * This supports release candidates whose versioned changelog section exists
 * before the final beta changes are ready, without creating a duplicate entry
 * or advancing the package version.
 */

const UNRELEASED_TEMPLATE = `

<!-- Add new changes here. Running \`node scripts/versioning.mjs apply\` will
     move this section to a versioned entry and reset the template below. -->

## 🆕 What's New

## 🐞 Fixed

## ⚠️ Known Issues

## ✅ Closed Issues
`

const TEMPLATE_COMMENT = /<!-- Add new changes here\.[\s\S]*?reset the template below\. -->/g
const ESCAPED_TEMPLATE_COMMENT =
  /&lt;!-- Add new changes here\.[\s\S]*?reset the template below\. --&gt;/g

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findSection(lines, heading) {
  const matches = []
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === heading) matches.push(index)
  }
  if (matches.length > 1) throw new Error(`CHANGELOG.md has duplicate section: ${heading}`)
  if (matches.length === 0) return null
  const start = matches[0]
  let end = start + 1
  while (end < lines.length && !/^## \[/.test(lines[end])) end += 1
  return { start, end }
}

function parseBody(body) {
  const withoutComments = body.replace(TEMPLATE_COMMENT, '').replace(ESCAPED_TEMPLATE_COMMENT, '')
  const lines = withoutComments.split('\n')
  const preamble = []
  const sections = new Map()
  let current = null

  for (const line of lines) {
    const heading = /^## (.+)$/.exec(line)
    if (heading) {
      current = heading[1]
      if (!sections.has(current)) sections.set(current, [])
      continue
    }
    if (current === null) preamble.push(line)
    else sections.get(current).push(line)
  }

  const meaningful = (items) => items.join('\n').trim().length > 0
  for (const [heading, content] of sections) {
    if (!meaningful(content)) sections.delete(heading)
    else {
      sections.set(
        heading,
        content
          .join('\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim()
          .split('\n'),
      )
    }
  }
  return {
    preamble: preamble.join('\n').trim(),
    sections,
  }
}

function mergeBodies(existingBody, pendingBody) {
  const existing = parseBody(existingBody)
  const pending = parseBody(pendingBody)
  const preamble = [existing.preamble, pending.preamble].filter(Boolean).join('\n\n')
  const sections = new Map(existing.sections)

  for (const [heading, content] of pending.sections) {
    if (!sections.has(heading)) {
      sections.set(heading, content)
      continue
    }
    const previous = sections.get(heading)
    const previousText = previous.join('\n').trim()
    const pendingText = content.join('\n').trim()
    sections.set(heading, [`${previousText}\n\n${pendingText}`])
  }

  const rendered = []
  if (preamble) rendered.push(preamble)
  for (const [heading, content] of sections) {
    if (rendered.length > 0) rendered.push('')
    rendered.push(`## ${heading}`, '', content.join('\n').trim())
  }
  return rendered.join('\n').trim()
}

/**
 * Merge [Unreleased] into an existing exact version heading, preserving its
 * date and existing notes. Returns null when the version section does not yet
 * exist so the caller can use the normal promotion path.
 *
 * @param {string} changelogText complete changelog
 * @param {string} version semantic version, with or without a leading v
 * @returns {{changed: boolean, content: string}|null}
 */
export function mergeUnreleasedIntoVersion(changelogText, version) {
  const normalized = String(version).trim().replace(/^v/i, '')
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(normalized)) {
    throw new Error(`invalid changelog version: ${version}`)
  }

  const lines = changelogText.split('\n')
  const unreleased = findSection(lines, '## [Unreleased]')
  if (!unreleased) throw new Error('CHANGELOG.md is missing the [Unreleased] section')

  const escaped = escapeRegExp(normalized)
  const targetPattern = new RegExp(`^## \\[v?${escaped}\\](?: - \\d{4}-\\d{2}-\\d{2})?$`)
  const targetMatches = []
  for (let index = 0; index < lines.length; index += 1) {
    if (targetPattern.test(lines[index])) targetMatches.push(index)
  }
  if (targetMatches.length > 1) {
    throw new Error(`CHANGELOG.md has duplicate version sections: ${normalized}`)
  }
  if (targetMatches.length === 0) return null

  const target = findSection(lines, lines[targetMatches[0]])
  if (!target) throw new Error(`CHANGELOG.md is missing version section: ${normalized}`)

  const pendingBody = lines.slice(unreleased.start + 1, unreleased.end).join('\n')
  const existingBody = lines.slice(target.start + 1, target.end).join('\n')
  const mergedBody = mergeBodies(existingBody, pendingBody)
  const afterTarget = [lines[target.start], '', mergedBody].join('\n').trimEnd()
  const updatedLines = [
    ...lines.slice(0, target.start),
    afterTarget,
    ...(target.end < lines.length ? [''] : []),
    ...lines.slice(target.end),
  ]
    .join('\n')
    .split('\n')
  const updatedUnreleased = findSection(updatedLines, '## [Unreleased]')
  if (!updatedUnreleased) throw new Error('merged CHANGELOG.md lost the [Unreleased] section')
  const content = [
    ...updatedLines.slice(0, updatedUnreleased.start),
    `## [Unreleased]${UNRELEASED_TEMPLATE}`,
    ...updatedLines.slice(updatedUnreleased.end),
  ].join('\n')

  return { changed: content !== changelogText, content }
}
