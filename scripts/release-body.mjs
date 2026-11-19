#!/usr/bin/env node
/**
 * release-body.mjs — compose GitHub Release notes from optional curated release docs
 * plus the canonical CHANGELOG.md section.
 *
 * Usage:
 *   node scripts/release-body.mjs --version 2.2.0 --channel stable \
 *     --changelog-notes release-notes.md --repo owner/name --ref v2.2.0 --out release-notes.md
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_RELEASES_DIR = join(ROOT, 'docs', 'releases')
const EXTERNAL_URL_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i
const FENCE_RE = /^\s*(`{3,}|~{3,})/
const INLINE_LINK_RE = /(!?)\[([^\]]*)\]\(([^)\n]+)\)/g

function toPosixRelative(fromDir, rootDir, targetPath) {
  const abs = resolve(fromDir, targetPath)
  const rel = relative(rootDir, abs).replace(/\\/g, '/')
  if (!rel || rel.startsWith('..')) return null
  return rel
}

function splitTargetAndTitle(rawTarget) {
  const trimmed = rawTarget.trim()
  const titleMatch = /^(\S+)(\s+["'(].*)$/.exec(trimmed)
  if (titleMatch) {
    return { dest: titleMatch[1], suffix: titleMatch[2] }
  }
  return { dest: trimmed, suffix: '' }
}

function rewriteSegmentUrls(segment, sourceDir, repoRoot, repo, ref) {
  return segment.replace(INLINE_LINK_RE, (full, bang, label, rawTarget) => {
    const { dest, suffix } = splitTargetAndTitle(rawTarget)
    if (!dest || EXTERNAL_URL_RE.test(dest)) return full
    const hashIdx = dest.indexOf('#')
    const pathPart = hashIdx === -1 ? dest : dest.slice(0, hashIdx)
    const fragment = hashIdx === -1 ? '' : dest.slice(hashIdx)
    if (!pathPart) return full

    const repoRel = toPosixRelative(sourceDir, repoRoot, pathPart)
    if (!repoRel) return full

    const encodedPath = repoRel.split('/').map(encodeURIComponent).join('/')
    const baseUrl =
      bang === '!'
        ? `https://raw.githubusercontent.com/${repo}/${ref}/${encodedPath}`
        : `https://github.com/${repo}/blob/${ref}/${encodedPath}${fragment}`
    return `${bang}[${label}](${baseUrl}${suffix})`
  })
}

function rewriteLineOutsideInlineCode(line, sourceDir, repoRoot, repo, ref) {
  const parts = line.split(/(`[^`\n]*`)/g)
  return parts
    .map((part) =>
      part.startsWith('`') && part.endsWith('`')
        ? part
        : rewriteSegmentUrls(part, sourceDir, repoRoot, repo, ref),
    )
    .join('')
}

/**
 * Rewrite relative Markdown links & images in a curated release doc into absolute
 * GitHub blob/raw URLs bound to `ref`, leaving code blocks and inline code intact.
 */
export function rewriteReleaseDocUrls(markdown, { sourceDir, repoRoot, repo, ref }) {
  const lines = String(markdown).split(/\r?\n/)
  const out = []
  let inFence = false
  let fenceChar = ''

  for (const line of lines) {
    const fenceMatch = FENCE_RE.exec(line)
    if (fenceMatch) {
      const char = fenceMatch[1][0]
      if (!inFence) {
        inFence = true
        fenceChar = char
      } else if (char === fenceChar) {
        inFence = false
      }
      out.push(line)
      continue
    }
    out.push(inFence ? line : rewriteLineOutsideInlineCode(line, sourceDir, repoRoot, repo, ref))
  }

  return out.join('\n')
}

/**
 * Compose the GitHub Release body.
 *
 * Only non-recovery stable releases with an existing `docs/releases/vX.Y.Z.md`
 * expand into the curated release page + canonical changelog ledger; all other
 * invocations preserve `changelogNotes` verbatim.
 */
export function composeReleaseBody({
  version,
  channel = 'stable',
  recovery = false,
  changelogNotes,
  repoRoot = ROOT,
  releasesDir = DEFAULT_RELEASES_DIR,
  repo = 'ils15/pantheon-opencode',
  ref,
}) {
  const normalized = String(version ?? '')
    .trim()
    .replace(/^v/i, '')
  const canonical = `${String(changelogNotes ?? '').trim()}\n`
  if (!normalized || recovery || channel === 'beta') {
    return canonical
  }

  const releaseDocPath = join(releasesDir, `v${normalized}.md`)
  if (!existsSync(releaseDocPath)) {
    return canonical
  }

  const effectiveRef = ref || `v${normalized}`
  const curated = rewriteReleaseDocUrls(readFileSync(releaseDocPath, 'utf8'), {
    sourceDir: releasesDir,
    repoRoot,
    repo,
    ref: effectiveRef,
  }).trim()

  return [
    curated,
    '',
    '---',
    '',
    '<details>',
    `<summary><strong>Full Keep a Changelog Ledger (v${normalized})</strong></summary>`,
    '',
    canonical.trim(),
    '',
    '</details>',
    '',
  ].join('\n')
}

function parseArgs(argv) {
  const opts = {
    channel: 'stable',
    recovery: false,
    repoRoot: ROOT,
    releasesDir: DEFAULT_RELEASES_DIR,
    repo: 'ils15/pantheon-opencode',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--recovery') {
      opts.recovery = true
      continue
    }
    const next = argv[i + 1]
    if (arg === '--version') {
      opts.version = next
      i += 1
    } else if (arg === '--channel') {
      opts.channel = next
      i += 1
    } else if (arg === '--changelog-notes') {
      opts.changelogNotesPath = next
      i += 1
    } else if (arg === '--repo-root') {
      opts.repoRoot = next
      i += 1
    } else if (arg === '--releases-dir') {
      opts.releasesDir = next
      i += 1
    } else if (arg === '--repo') {
      opts.repo = next
      i += 1
    } else if (arg === '--ref') {
      opts.ref = next
      i += 1
    } else if (arg === '--out') {
      opts.out = next
      i += 1
    }
  }
  return opts
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  const opts = parseArgs(process.argv.slice(2))
  if (!opts.version || !opts.changelogNotesPath) {
    console.error(
      'Usage: node scripts/release-body.mjs --version <v> --changelog-notes <file> [--channel stable|beta] [--recovery] [--repo <owner/name>] [--ref <tag>] [--out <file>]',
    )
    process.exit(2)
  }
  const changelogNotes = readFileSync(opts.changelogNotesPath, 'utf8')
  const composed = composeReleaseBody({ ...opts, changelogNotes })
  if (opts.out) {
    writeFileSync(opts.out, composed, 'utf8')
  } else {
    process.stdout.write(composed)
  }
}
