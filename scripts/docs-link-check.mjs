#!/usr/bin/env node
/**
 * Documentation link checker.
 *
 * Validates every Markdown link inside `docs/`:
 *   - relative `.md` targets exist and stay inside `docs/` (a link that leaves
 *     `docs/` would 404 on the published site);
 *   - `#anchors` match a heading slug in the target file;
 *   - external URLs, mail links, and bare anchors are ignored.
 *
 * Exits 1 when any finding is reported, 0 otherwise.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const DOCS_ROOT = resolve(SCRIPT_DIR, '..', 'docs')

const LINK_PATTERN = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g
const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/

/** Collect Markdown files under docs/, skipping nothing by default. */
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

/** Remove fenced code blocks so examples are not parsed as links. */
function stripFences(source) {
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
  return kept.join('\n')
}

/** Approximate the slug Python-Markdown/mkdocs produces for a heading. */
function slugify(text) {
  return text
    .replace(/<[^>]+>/g, '')
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
    if (count > 0) {
      // Accept the underscore variant too; renderers differ.
      anchors.add(`${base}_${count}`)
    }
  }
  return anchors
}

function lineOf(source, index) {
  return source.slice(0, index).split(/\r?\n/).length
}

function normalizeTarget(raw) {
  let target = raw.trim()
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
  // Drop an optional Markdown title: (path "title")
  target = target.replace(/\s+["'(].*$/, '')
  return target
}

function main() {
  const files = collectMarkdown(DOCS_ROOT)
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

  for (const file of files) {
    const raw = readCached(file)
    const source = stripFences(raw)
    for (const match of source.matchAll(LINK_PATTERN)) {
      const target = normalizeTarget(match[1])
      if (!target) continue
      if (EXTERNAL.test(target)) continue

      const [pathPart, fragment] = target.split('#')
      const line = lineOf(source, match.index)

      if (pathPart === '') {
        if (fragment && !anchorsCached(file).has(fragment)) {
          findings.push(`${relative(process.cwd(), file)}:${line}: missing anchor #${fragment}`)
        }
        continue
      }

      const resolved = resolve(dirname(file), pathPart)
      const relToDocs = relative(DOCS_ROOT, resolved)
      if (relToDocs === '' || relToDocs.startsWith('..') || relToDocs.startsWith(`..${sep}`)) {
        findings.push(
          `${relative(process.cwd(), file)}:${line}: link leaves docs/: ${pathPart} ` +
            '(use an absolute GitHub URL for repository files)',
        )
        continue
      }

      let stat
      try {
        stat = statSync(resolved)
      } catch {
        findings.push(`${relative(process.cwd(), file)}:${line}: missing target ${pathPart}`)
        continue
      }

      if (fragment && extname(resolved).toLowerCase() === '.md' && stat.isFile()) {
        if (!anchorsCached(resolved).has(fragment)) {
          findings.push(
            `${relative(process.cwd(), file)}:${line}: missing anchor #${fragment} in ${pathPart}`,
          )
        }
      }
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

main()
