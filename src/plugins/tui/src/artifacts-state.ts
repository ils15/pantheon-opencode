/**
 * artifacts-state.ts — Pure scanner, formatter, and paginator for Pantheon
 * Markdown artifacts (`.pantheon/deepwork/<slug>/*.md`, `.pantheon/reports/*.md`,
 * `docs/adr/*.md`, `.pantheon/memory-bank/adr/*.md`).
 *
 * Zero JSX and zero host dependencies so the full scanning, formatting, and
 * pagination logic is directly unit-testable in Node.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { renderMermaidToUnicode } from './mermaid-ascii.ts'

export type ArtifactKind = 'plan' | 'report' | 'adr'

export interface PantheonArtifactEntry {
  readonly id: string
  readonly kind: ArtifactKind
  readonly badge: string
  readonly title: string
  readonly path: string
  readonly relPath: string
  readonly modifiedMs: number
  readonly lineCount: number
  readonly bytes: number
}

export const ARTIFACT_PAGE_SIZE = 16
export const ARTIFACT_LINE_WIDTH = 76

const GFM_ALERT_RE = /^>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i

function resolveArtifactRoots(workspaceDir: string): string[] {
  const roots: string[] = []
  const seen = new Set<string>()
  const pushRoot = (candidate: string) => {
    try {
      if (!existsSync(candidate)) return
      const real = realpathSync(candidate)
      if (!seen.has(real)) {
        seen.add(real)
        roots.push(real)
      }
    } catch {
      /* ignore inaccessible root */
    }
  }

  pushRoot(workspaceDir)
  try {
    let cur = resolve(workspaceDir)
    for (let depth = 0; depth < 24; depth += 1) {
      const dotGit = join(cur, '.git')
      if (existsSync(dotGit)) {
        const st = statSync(dotGit)
        if (st.isFile()) {
          const content = readFileSync(dotGit, 'utf8')
          const match = /^gitdir:\s*(.+)$/m.exec(content)
          if (match?.[1]) {
            const gitDir = resolve(cur, match[1].trim())
            const commonFile = join(gitDir, 'commondir')
            const commonGitDir = existsSync(commonFile)
              ? resolve(gitDir, readFileSync(commonFile, 'utf8').trim())
              : basename(dirname(gitDir)) === 'worktrees'
                ? dirname(dirname(gitDir))
                : null
            if (commonGitDir && basename(commonGitDir) === '.git') {
              pushRoot(dirname(commonGitDir))
            }
          }
        }
        break
      }
      const parent = dirname(cur)
      if (parent === cur) break
      cur = parent
    }
  } catch {
    /* fail-open */
  }
  return roots
}

function extractTitle(content: string, fallbackFile: string): string {
  for (const line of content.split(/\r?\n/)) {
    const match = /^#\s+(.+?)\s*$/.exec(line.trim())
    if (match?.[1]) return match[1].trim()
  }
  return fallbackFile.replace(/\.md$/i, '')
}

function addArtifactFile(
  out: PantheonArtifactEntry[],
  seenPaths: Set<string>,
  root: string,
  filePath: string,
  kind: ArtifactKind,
): void {
  try {
    const real = realpathSync(filePath)
    if (seenPaths.has(real)) return
    const st = statSync(real)
    if (!st.isFile()) return
    const raw = readFileSync(real, 'utf8')
    const lineCount = raw === '' ? 0 : raw.split(/\r?\n/).length
    const relPath = relative(root, real).replace(/\\/g, '/')
    const badge = kind === 'plan' ? 'PLAN' : kind === 'report' ? 'REPORT' : 'ADR'
    seenPaths.add(real)
    out.push({
      id: real,
      kind,
      badge,
      title: extractTitle(raw, basename(real)),
      path: real,
      relPath,
      modifiedMs: st.mtimeMs,
      lineCount,
      bytes: st.size,
    })
  } catch {
    /* skip unreadable file */
  }
}

export function scanPantheonArtifacts(workspaceDir: string): PantheonArtifactEntry[] {
  if (!workspaceDir || !existsSync(workspaceDir)) return []
  const roots = resolveArtifactRoots(workspaceDir)
  const out: PantheonArtifactEntry[] = []
  const seenPaths = new Set<string>()

  for (const root of roots) {
    // 1. Deepwork plans & reports under .pantheon/deepwork/<slug>/*.md
    const deepworkDir = join(root, '.pantheon', 'deepwork')
    if (existsSync(deepworkDir)) {
      try {
        for (const entry of readdirSync(deepworkDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const slugDir = join(deepworkDir, entry.name)
          for (const file of readdirSync(slugDir, { withFileTypes: true })) {
            if (!file.isFile() || !file.name.endsWith('.md')) continue
            const kind: ArtifactKind = file.name.startsWith('VERIFICATION') ? 'report' : 'plan'
            addArtifactFile(out, seenPaths, root, join(slugDir, file.name), kind)
          }
        }
      } catch {
        /* ignore */
      }
    }

    // 2. Executive & audit reports under .pantheon/reports/*.md
    const reportsDir = join(root, '.pantheon', 'reports')
    if (existsSync(reportsDir)) {
      try {
        for (const file of readdirSync(reportsDir, { withFileTypes: true })) {
          if (!file.isFile() || !file.name.endsWith('.md')) continue
          addArtifactFile(out, seenPaths, root, join(reportsDir, file.name), 'report')
        }
      } catch {
        /* ignore */
      }
    }

    // 3. Architecture Decision Records under docs/adr/*.md and .pantheon/memory-bank/adr/*.md
    for (const adrDir of [
      join(root, 'docs', 'adr'),
      join(root, '.pantheon', 'memory-bank', 'adr'),
    ]) {
      if (!existsSync(adrDir)) continue
      try {
        for (const file of readdirSync(adrDir, { withFileTypes: true })) {
          if (!file.isFile() || !file.name.endsWith('.md')) continue
          if (file.name.toLowerCase() === 'readme.md') continue
          addArtifactFile(out, seenPaths, root, join(adrDir, file.name), 'adr')
        }
      } catch {
        /* ignore */
      }
    }
  }

  return out.sort((a, b) => b.modifiedMs - a.modifiedMs || a.relPath.localeCompare(b.relPath))
}

function wrapLine(text: string, width: number): string[] {
  const max = Number.isInteger(width) && width >= 20 ? width : ARTIFACT_LINE_WIDTH
  if (text.length <= max) return [text]
  const rows: string[] = []
  let rest = text
  while (rest.length > max) {
    let split = rest.lastIndexOf(' ', max)
    if (split < Math.floor(max * 0.4)) split = max
    rows.push(rest.slice(0, split).trimEnd())
    rest = rest.slice(split).trimStart()
  }
  if (rest.length > 0) rows.push(rest)
  return rows
}

function simplifyLinks(line: string): string {
  return line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, target: string) => {
    if (target.startsWith('file://')) {
      const clean = target.replace(/^file:\/\//, '')
      const hashIdx = clean.indexOf('#')
      const pathPart = hashIdx >= 0 ? clean.slice(0, hashIdx) : clean
      const anchor = hashIdx >= 0 ? clean.slice(hashIdx) : ''
      const base = basename(pathPart)
      return base === label ? `${label}${anchor}` : `${label} (${base}${anchor})`
    }
    return label
  })
}

export function formatArtifactLines(
  markdown: string,
  width: number = ARTIFACT_LINE_WIDTH,
): string[] {
  const max = Number.isInteger(width) && width >= 20 ? width : ARTIFACT_LINE_WIDTH
  const out: string[] = []
  let inMermaid = false
  let mermaidBuffer: string[] = []
  let inCode = false
  let activeAlert: string | null = null

  for (const rawLine of markdown.split(/\r?\n/)) {
    const trimmed = rawLine.trim()

    if (/^```mermaid/i.test(trimmed)) {
      inMermaid = true
      inCode = true
      mermaidBuffer = []
      continue
    }
    if (/^```/.test(trimmed)) {
      if (inCode) {
        if (inMermaid) {
          const rendered = renderMermaidToUnicode(mermaidBuffer, max)
          out.push(rendered.header)
          for (const dLine of rendered.lines) out.push(dLine)
          mermaidBuffer = []
        }
        inCode = false
        inMermaid = false
        out.push('')
      } else {
        inCode = true
        const lang = trimmed.slice(3).trim()
        out.push(lang ? `[Code: ${lang}]` : '[Code]')
      }
      continue
    }
    if (inCode) {
      if (inMermaid) {
        mermaidBuffer.push(rawLine)
      } else {
        out.push(...wrapLine(`  ${trimmed}`, max))
      }
      continue
    }

    const alertMatch = GFM_ALERT_RE.exec(trimmed)
    if (alertMatch?.[1]) {
      activeAlert = alertMatch[1].toUpperCase()
      out.push(`[${activeAlert}]`)
      continue
    }
    if (trimmed.startsWith('>')) {
      const body = simplifyLinks(trimmed.replace(/^>\s?/, ''))
      const prefix = activeAlert ? '  ' : '> '
      if (body === '') continue
      out.push(...wrapLine(`${prefix}${body}`, max))
      continue
    }
    activeAlert = null

    if (trimmed === '---' || trimmed === '***') {
      out.push('─'.repeat(Math.min(max, 64)))
      continue
    }
    if (trimmed === '') {
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      continue
    }

    const cleaned = simplifyLinks(rawLine).replace(/\*\*/g, '')
    const hMatch = /^(#{1,3})\s+(.+)$/.exec(cleaned.trim())
    if (hMatch?.[1] && hMatch[2]) {
      const level = hMatch[1].length
      const heading = level === 1 ? hMatch[2].toUpperCase() : hMatch[2]
      if (out.length > 0 && out[out.length - 1] !== '') out.push('')
      out.push(...wrapLine(level === 1 ? heading : `${'· '.repeat(level - 1)}${heading}`, max))
      continue
    }

    const bulletMatch = /^[-*]\s+(.+)$/.exec(cleaned.trim())
    if (bulletMatch?.[1]) {
      out.push(...wrapLine(`• ${bulletMatch[1]}`, max))
      continue
    }

    out.push(...wrapLine(cleaned.trimEnd(), max))
  }

  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return out
}

export function paginateArtifactLines(
  lines: readonly string[],
  pageSize: number = ARTIFACT_PAGE_SIZE,
): string[][] {
  const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : ARTIFACT_PAGE_SIZE
  if (lines.length === 0) return [[]]
  const pages: string[][] = []
  for (let i = 0; i < lines.length; i += size) {
    pages.push(lines.slice(i, i + size))
  }
  return pages
}

export function artifactKindLabel(kind: ArtifactKind, isPt = false): string {
  if (kind === 'plan') return isPt ? 'Plano' : 'Plan'
  if (kind === 'report') return isPt ? 'Relatório' : 'Report'
  return 'ADR'
}
