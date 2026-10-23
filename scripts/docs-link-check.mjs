#!/usr/bin/env node
/**
 * Documentation link checker.
 *
 * Scans README.md and docs/**\/*.md and validates every Markdown link and
 * image:
 *   - relative targets exist;
 *   - links inside docs/ stay inside docs/ (a link that leaves docs/ would 404
 *     on the published site; use an absolute GitHub URL instead);
 *   - `#anchors` match a heading slug in the target Markdown file;
 *   - reference-style links resolve through their `[ref]: target` definition;
 *   - image targets exist;
 *   - external URLs, mail links, and bare anchors are ignored.
 *
 * Exits 1 when any finding is reported, or when zero files were scanned.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(SCRIPT_DIR, '..')
const DOCS_ROOT = join(ROOT, 'docs')
const README = join(ROOT, 'README.md')

const INLINE_LINK = /(?<!!)\[([^\]]*)\]\(([^)]+)\)/g
const INLINE_IMAGE = /!\[([^\]]*)\]\(([^)]+)\)/g
const REFERENCE_LINK = /(?<!!)\[([^\]]*)\]\[([^\]]*)\]/g
const REFERENCE_IMAGE = /!\[([^\]]*)\]\[([^\]]*)\]/g
const REFERENCE_DEFINITION = /^\s{0,3}\[([^\]]+)\]:\s*(\S+)/
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/

function collectMarkdown(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) out.push(...collectMarkdown(full))
    else if (extname(entry).toLowerCase() === '.md') out.push(full)
  }
  return out
}

function isInside(child, parent) {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${sep}`))
}

/** Remove fenced code blocks and inline code so examples are not parsed. */
function stripCode(source) {
  const lines = source.split(/\r?\n/)
  let inFence = false
  let fence = ''
  const kept = []
  for (const line of lines) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line)
    if (match) {
      if (!inFence) {
        inFence = true
        fence = match[1][0]
      } else if (match[1][0] === fence) {
        inFence = false
      }
      kept.push('')
      continue
    }
    kept.push(inFence ? '' : line)
  }
  return kept.join('\n').replace(/`[^`\n]*`/g, (match) => ' '.repeat(match.length))
}

/**
 * Remove HTML tags in one pass.
 *
 * A single regex strip can leave a tag intact when the input nests angle
 * brackets (`<scr<b>ipt>`), so this walks the string once:
 *   - a `<` outside a tag opens one;
 *   - a `>` outside quotes closes the innermost open tag;
 *   - a `<` inside a tag opens a nested level, so a malformed construct is
 *     dropped whole instead of leaving a fragment of its name behind;
 *   - `>` inside a quoted attribute does not close the tag;
 *   - an unbalanced `<` flushes the buffered text as literal input.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripTags(text) {
  let output = ''
  let tag = ''
  let depth = 0
  let quote = null

  for (const char of text) {
    if (depth === 0) {
      if (char === '<') {
        depth = 1
        tag = '<'
      } else {
        output += char
      }
      continue
    }

    tag += char
    if (quote !== null) {
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
    } else if (char === '<') {
      depth += 1
    } else if (char === '>') {
      depth -= 1
      if (depth === 0) tag = ''
    }
  }

  // No matching `>`: the buffered text was never a tag, so keep it literally.
  if (depth > 0) output += tag
  return output
}

/** Approximate the slug Python-Markdown/mkdocs produces for a heading. */
export function slugify(text) {
  return stripTags(text)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .toLowerCase()
    .replace(/[^\w\s-]/gu, '')
    .trim()
    .replace(/[-\s]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
}

/** Build the set of anchors a file exposes, including duplicate suffixes. */
function anchorsOf(source) {
  const anchors = new Set()
  const seen = new Map()
  let inFence = false
  let fence = ''
  for (const line of source.split(/\r?\n/)) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fenceMatch) {
      if (!inFence) {
        inFence = true
        fence = fenceMatch[1][0]
      } else if (fenceMatch[1][0] === fence) {
        inFence = false
      }
      continue
    }
    if (inFence) continue
    const heading = HEADING.exec(line)
    if (!heading) continue
    const base = slugify(heading[2])
    if (!base) continue
    const count = seen.get(base) ?? 0
    seen.set(base, count + 1)
    anchors.add(count === 0 ? base : `${base}-${count}`)
    if (count > 0) anchors.add(`${base}_${count}`)
  }
  return anchors
}

function lineOf(source, index) {
  return source.slice(0, index).split(/\r?\n/).length
}

function normalizeTarget(raw) {
  let target = raw.trim()
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
  target = target.replace(/\s+["'(].*$/, '')
  return target
}

function referenceDefinitions(source) {
  const definitions = new Map()
  for (const line of source.split(/\r?\n/)) {
    const match = REFERENCE_DEFINITION.exec(line)
    if (match) definitions.set(match[1].trim().toLowerCase(), match[2].trim())
  }
  return definitions
}

function main() {
  const files = []
  if (existsSync(README)) files.push(README)
  if (existsSync(DOCS_ROOT)) files.push(...collectMarkdown(DOCS_ROOT))

  if (files.length === 0) {
    console.error('docs:lint failed — no Markdown files were scanned')
    process.exitCode = 1
    return
  }

  const sourceCache = new Map()
  const anchorCache = new Map()
  const readCached = (file) => {
    if (!sourceCache.has(file)) sourceCache.set(file, readFileSync(file, 'utf8'))
    return sourceCache.get(file)
  }
  const anchorsCached = (file) => {
    if (!anchorCache.has(file)) anchorCache.set(file, anchorsOf(readCached(file)))
    return anchorCache.get(file)
  }

  const findings = []

  const checkTarget = (file, pathPart, fragment, line, kind) => {
    const resolved = resolve(dirname(file), pathPart)
    const display = relative(ROOT, file)

    if (file !== README && !isInside(resolved, DOCS_ROOT)) {
      findings.push(
        `${display}:${line}: ${kind} leaves docs/: ${pathPart} ` +
          '(use an absolute GitHub URL for repository files)',
      )
      return
    }
    if (file === README && !isInside(resolved, ROOT)) {
      findings.push(`${display}:${line}: ${kind} leaves the repository: ${pathPart}`)
      return
    }

    let stat
    try {
      stat = statSync(resolved)
    } catch {
      findings.push(`${display}:${line}: missing ${kind} target ${pathPart}`)
      return
    }

    if (fragment && extname(resolved).toLowerCase() === '.md' && stat.isFile()) {
      if (!anchorsCached(resolved).has(fragment)) {
        findings.push(`${display}:${line}: missing anchor #${fragment} in ${pathPart}`)
      }
    }
  }

  for (const file of files) {
    const raw = readCached(file)
    const source = stripCode(raw)
    const definitions = referenceDefinitions(source)

    // Inline links and images.
    for (const match of source.matchAll(INLINE_LINK)) {
      const target = normalizeTarget(match[2])
      if (!target || EXTERNAL.test(target)) continue
      const [pathPart, fragment] = target.split('#')
      const line = lineOf(source, match.index)
      if (pathPart === '') {
        if (fragment && !anchorsCached(file).has(fragment)) {
          findings.push(`${relative(ROOT, file)}:${line}: missing anchor #${fragment}`)
        }
        continue
      }
      checkTarget(file, pathPart, fragment, line, 'link')
    }

    for (const match of source.matchAll(INLINE_IMAGE)) {
      const target = normalizeTarget(match[2])
      if (!target || EXTERNAL.test(target)) continue
      const [pathPart] = target.split('#')
      checkTarget(file, pathPart, undefined, lineOf(source, match.index), 'image')
    }

    // Reference-style links and images.
    for (const match of source.matchAll(REFERENCE_LINK)) {
      const label = (match[2].trim() || match[1].trim()).toLowerCase()
      const rawTarget = definitions.get(label)
      if (rawTarget === undefined) {
        findings.push(
          `${relative(ROOT, file)}:${lineOf(source, match.index)}: undefined reference [${label}]`,
        )
        continue
      }
      const target = normalizeTarget(rawTarget)
      if (!target || EXTERNAL.test(target)) continue
      const [pathPart, fragment] = target.split('#')
      checkTarget(file, pathPart, fragment, lineOf(source, match.index), 'link')
    }

    for (const match of source.matchAll(REFERENCE_IMAGE)) {
      const label = (match[2].trim() || match[1].trim()).toLowerCase()
      const rawTarget = definitions.get(label)
      if (rawTarget === undefined) {
        findings.push(
          `${relative(ROOT, file)}:${lineOf(source, match.index)}: undefined image reference [${label}]`,
        )
        continue
      }
      const target = normalizeTarget(rawTarget)
      if (!target || EXTERNAL.test(target)) continue
      const [pathPart] = target.split('#')
      checkTarget(file, pathPart, undefined, lineOf(source, match.index), 'image')
    }
  }

  if (findings.length === 0) {
    console.log(`docs:lint OK — ${files.length} Markdown files, no findings.`)
    return
  }

  for (const finding of findings) console.error(finding)
  console.error(`\ndocs:lint failed — ${findings.length} finding(s) in ${files.length} files.`)
  process.exitCode = 1
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) main()
