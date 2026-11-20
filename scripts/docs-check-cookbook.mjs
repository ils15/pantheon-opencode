#!/usr/bin/env node
/**
 * docs-check-cookbook.mjs — enforce parity between Pantheon's shipped
 * commands, TUI surfaces, core native workflows, package minor version,
 * and both Practical Cookbooks (docs/guides/cookbook.md & docs/pt-BR/guides/cookbook.md).
 *
 * Exits 1 when either cookbook drifts behind code or version bumps.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const REQUIRED_CORE_MARKERS = [
  'ast_search',
  'ast_rewrite',
  'hashline_edit',
  'pantheon_step_ledger',
  'pantheon_worktree',
  'pantheon_review_verdict',
  'detect_stack',
  'pantheon_agent_forge',
  'memory_search',
  'APPROVE',
  'APPROVE_WITH_NOTES',
  'BLOCK',
]

export const STALE_COOKBOOK_PATTERNS = [
  {
    pattern: /\bPASS_WITH_NOTES\b/,
    reason: 'obsolete verdict label PASS_WITH_NOTES (use APPROVE / APPROVE_WITH_NOTES / BLOCK)',
  },
]

function extractServerCommands(pluginSource) {
  const blockMatch = /const CANONICAL_SLASH_COMMANDS[^=]*=\s*\[([\s\S]*?)\n\]/.exec(pluginSource)
  if (!blockMatch) return []
  return [...blockMatch[1].matchAll(/\bname:\s*['"]([a-z0-9-]+)['"]/g)].map((m) => m[1])
}

function extractTuiCommands(tuiIndexSource) {
  const start = tuiIndexSource.indexOf('function PantheonSettingsCommandLayer')
  if (start === -1) return []
  const slice = tuiIndexSource.slice(start, start + 2500)
  return [...slice.matchAll(/slash:\s*\{\s*name:\s*['"]([a-z0-9-]+)['"]/g)].map((m) => m[1])
}

function expectedMinorTag(version) {
  const match = /^(\d+)\.(\d+)\./.exec(String(version ?? '').trim())
  return match ? `v${match[1]}.${match[2]}` : null
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function checkCookbookDocument(label, content, { expectedTag, commands, coreMarkers }) {
  const findings = []
  if (!expectedTag) {
    findings.push(`${label}: could not determine package.json major.minor version`)
  } else {
    const tagMarker = `<!-- pantheon:cookbook-version ${expectedTag} -->`
    if (!content.includes(tagMarker)) {
      findings.push(
        `${label}: missing current minor sync marker '${tagMarker}' — review and update recipes for ${expectedTag}`,
      )
    }
  }

  for (const cmd of commands) {
    const cmdRe = new RegExp(`/${escapeRegExp(cmd)}(?![a-z0-9-])`)
    if (!cmdRe.test(content)) {
      findings.push(`${label}: missing documented command /${cmd}`)
    }
  }

  for (const marker of coreMarkers) {
    const markerRe = new RegExp(`\\b${escapeRegExp(marker)}\\b`)
    if (!markerRe.test(content)) {
      findings.push(`${label}: missing v2.2+ core workflow/tool marker '${marker}'`)
    }
  }

  for (const rule of STALE_COOKBOOK_PATTERNS) {
    if (rule.pattern.test(content)) {
      findings.push(`${label}: contains ${rule.reason}`)
    }
  }

  return findings
}

export function checkCookbookParity(rootDir = ROOT) {
  const findings = []
  const pkgPath = join(rootDir, 'package.json')
  const pluginPath = join(rootDir, 'src', 'plugin.ts')
  const tuiPath = join(rootDir, 'src', 'plugins', 'tui', 'src', 'index.tsx')
  const enPath = join(rootDir, 'docs', 'guides', 'cookbook.md')
  const ptPath = join(rootDir, 'docs', 'pt-BR', 'guides', 'cookbook.md')

  if (!existsSync(pkgPath)) {
    return { findings: ['package.json missing'], discoveredCommands: [], expectedTag: null }
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const expectedTag = expectedMinorTag(pkg.version)

  const serverCommands = existsSync(pluginPath)
    ? extractServerCommands(readFileSync(pluginPath, 'utf8'))
    : []
  const tuiCommands = existsSync(tuiPath) ? extractTuiCommands(readFileSync(tuiPath, 'utf8')) : []
  const discoveredCommands = [...new Set([...serverCommands, ...tuiCommands])]

  if (discoveredCommands.length === 0) {
    findings.push(
      'Unable to discover any canonical slash commands in src/plugin.ts or TUI index.tsx',
    )
  }

  for (const [label, filePath] of [
    ['docs/guides/cookbook.md', enPath],
    ['docs/pt-BR/guides/cookbook.md', ptPath],
  ]) {
    if (!existsSync(filePath)) {
      findings.push(`${label}: file missing`)
      continue
    }
    const content = readFileSync(filePath, 'utf8')
    findings.push(
      ...checkCookbookDocument(label, content, {
        expectedTag,
        commands: discoveredCommands,
        coreMarkers: REQUIRED_CORE_MARKERS,
      }),
    )
  }

  return { findings, discoveredCommands, expectedTag }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href

if (isDirectRun) {
  const { findings, discoveredCommands, expectedTag } = checkCookbookParity(ROOT)
  if (findings.length > 0) {
    console.error(`docs:check-cookbook failed (${findings.length} finding(s)):`)
    for (const finding of findings) {
      console.error(`  - ${finding}`)
    }
    process.exitCode = 1
  } else {
    console.log(
      `docs:check-cookbook OK — EN + pt-BR cookbooks match ${expectedTag} (${discoveredCommands.length} commands, ${REQUIRED_CORE_MARKERS.length} core markers).`,
    )
  }
}
