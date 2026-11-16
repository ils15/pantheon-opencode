/**
 * Skill search tool surface for Pantheon OpenCode V2.
 *
 * Implements the skill provenance search design from
 * `docs/reference/skill-search-design.md`:
 *
 * 1. Tier 1 (Installed): Searches local Pantheon skill catalog in-memory.
 * 2. Tier 2 (Canonical): Searches Anthropic catalog (curated).
 * 3. Tier 3 (Ecosystem): Searches skills.sh and GitHub code search.
 *
 * Fail-open and safe by design: never throws, reports provenance tiers,
 * and leaves the install decision to the user (`npx skills add ...`).
 *
 * @module pantheon/skill-search-tool
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error scripts/skill-search.mjs is a plain Node ESM script without bundled .d.ts
import { searchSkillSources } from '../../scripts/skill-search.mjs'
import { PANTHEON_SKILL_CATALOG } from './pantheon-decision-catalog.ts'
import { resolveToolCwd } from './tool-context.ts'
import type { V2ToolDef } from './tools.ts'

export interface SkillSearchResult {
  readonly skill: string
  readonly description?: string
  readonly source: 'installed' | 'anthropic' | 'skills-sh' | 'github'
  readonly installed: boolean
  readonly installs?: number | null
  readonly url?: string
  readonly installCommand?: string | null
  readonly path?: string | null
  readonly scope?: 'internal' | 'project' | 'global'
}

export interface InstalledSkillRecord {
  readonly id: string
  readonly description: string
  readonly path: string
  readonly scope: 'internal' | 'project' | 'global'
}

export function extractSkillMetadata(
  content: string,
  fallbackName: string,
): { name: string; description: string } {
  let name = fallbackName
  let description = ''
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  const yaml = fmMatch?.[1]
  if (yaml) {
    const nameMatch = yaml.match(/^name:\s*["']?([^"'\r\n]+)["']?/m)
    if (nameMatch?.[1]) name = nameMatch[1].trim()
    const descMatch = yaml.match(/^description:\s*["']?([^"'\r\n]+)["']?/m)
    if (descMatch?.[1]) description = descMatch[1].trim()
  }
  if (!description) {
    const withoutFm = content.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').trim()
    const lines = withoutFm.split('\n')
    for (const l of lines) {
      const trimmed = l.trim()
      if (trimmed && !trimmed.startsWith('#')) {
        description = trimmed.slice(0, 160)
        break
      }
    }
  }
  return { name, description }
}

export function scanInstalledSkills(
  cwd: string = process.cwd(),
): Map<string, InstalledSkillRecord> {
  const map = new Map<string, InstalledSkillRecord>()

  // 1. Built-in Pantheon catalog (internal base)
  for (const entry of PANTHEON_SKILL_CATALOG) {
    map.set(entry.id.toLowerCase(), {
      id: entry.id,
      description: entry.description,
      path: `src/skills/${entry.id}/SKILL.md`,
      scope: 'internal',
    })
  }

  const scanDir = (baseDir: string, scope: 'project' | 'global') => {
    try {
      if (!existsSync(baseDir)) return
      const entries = readdirSync(baseDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        const skillName = entry.name
        if (skillName.startsWith('.')) continue
        const skillMd = join(baseDir, skillName, 'SKILL.md')
        if (existsSync(skillMd)) {
          try {
            const raw = readFileSync(skillMd, 'utf8')
            const { name, description } = extractSkillMetadata(raw, skillName)
            const id = (name || skillName).trim()
            map.set(id.toLowerCase(), {
              id,
              description: description || skillName,
              path: skillMd,
              scope,
            })
          } catch {
            // ignore unreadable files
          }
        }
      }
    } catch {
      // ignore directory errors
    }
  }

  // 2. Global directories
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  scanDir(join(xdgConfig, 'opencode', 'skills'), 'global')
  scanDir(join(homedir(), '.agents', 'skills'), 'global')

  // 3. Project directories (override global/internal)
  scanDir(join(cwd, '.opencode', 'skills'), 'project')
  scanDir(join(cwd, '.agents', 'skills'), 'project')
  scanDir(join(cwd, 'skills'), 'project')

  return map
}

export interface SkillSearchOutput {
  readonly ok: boolean
  readonly query: string
  readonly count: number
  readonly results: readonly SkillSearchResult[]
  readonly failures: readonly string[]
}

const TOOL_DESCRIPTION =
  'Advisory discovery tool for skills. Queries installed Pantheon skills and external ' +
  'registries (Anthropic catalog, skills.sh, GitHub). Returns matched skill IDs, ' +
  'descriptions, install counts, and provenance tiers. Zeus uses this to recommend ' +
  'project-scoped skills (.agents/skills/) before proactively prompting the user via the question tool.'

const SKILL_SEARCH_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['query'],
  properties: {
    query: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      description: 'Search terms to discover skills (e.g. "docker", "fastapi", "testing")',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: 20,
      default: 5,
      description: 'Maximum number of results to return across all sources (default 5)',
    },
    sources: {
      type: 'array',
      items: {
        type: 'string',
        enum: ['installed', 'anthropic', 'skills-sh', 'github'],
      },
      description:
        'Sources to search. Defaults to ["installed", "anthropic", "skills-sh"]. ' +
        'Pass ["installed"] for local-only search without network egress.',
    },
  },
}

export interface SkillScore {
  readonly score: number
  readonly matchedTokens: number
}

/**
 * Score relevance of a skill against query tokens.
 *
 * Uses word-boundary and segment matching with tiered weighting:
 * - Exact ID match: 20 pts
 * - Exact segment match in hyphenated/slashed ID: 12 pts
 * - Prefix match on ID segment (>=4 chars): 6 pts
 * - Exact word match in description: 5 pts
 * - Prefix match on description word (>=4 chars): 2 pts
 * - Multi-token synergy bonus: + (matchedTokens * 5) pts
 *
 * Substrings inside words (e.g. "rate" inside "generates" or "migrate")
 * receive ZERO points, completely eliminating false-positive lexical bleed.
 */
export function scoreSkillMatch(
  id: string,
  description: string,
  queryTokens: readonly string[],
): SkillScore {
  const idLower = id.toLowerCase()
  const descLower = description.toLowerCase()
  const idTokens = idLower.split(/[^a-z0-9]+/).filter(Boolean)
  const descWords = descLower.split(/[^a-z0-9]+/).filter(Boolean)

  let score = 0
  let matchedTokens = 0

  for (const t of queryTokens) {
    let tokenScore = 0

    if (idLower === t) {
      tokenScore += 20
    } else if (idTokens.includes(t)) {
      tokenScore += 12
    } else if (
      idTokens.some((w) => w.length >= 4 && t.length >= 4 && (w.startsWith(t) || t.startsWith(w)))
    ) {
      tokenScore += 6
    }

    if (descWords.includes(t)) {
      tokenScore += 5
    } else if (
      descWords.some((w) => w.length >= 4 && t.length >= 4 && (w.startsWith(t) || t.startsWith(w)))
    ) {
      tokenScore += 2
    }

    if (tokenScore > 0) {
      score += tokenScore
      matchedTokens += 1
    }
  }

  if (matchedTokens > 1) {
    score += matchedTokens * 5
  }

  return { score, matchedTokens }
}

export function executeSkillSearch(
  input: Record<string, unknown>,
  options: { cwd?: string } = {},
): SkillSearchOutput {
  const query = typeof input.query === 'string' ? input.query.trim() : ''
  if (query.length === 0) {
    return { ok: false, query: '', count: 0, results: [], failures: ['query must be non-empty'] }
  }

  const limit =
    typeof input.limit === 'number' && Number.isFinite(input.limit)
      ? Math.max(1, Math.min(20, Math.floor(input.limit)))
      : 5

  const rawSources = Array.isArray(input.sources) ? input.sources : undefined
  const sources = new Set<string>(
    rawSources?.filter((s): s is string => typeof s === 'string') ?? [
      'installed',
      'anthropic',
      'skills-sh',
    ],
  )

  const failures: string[] = []

  const cwd = options.cwd ?? process.cwd()
  const installedMap = scanInstalledSkills(cwd)

  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1)

  const scoredResults: Array<SkillSearchResult & { score: number }> = []

  // 1. Tier 1: Installed skills (Pantheon catalog + local filesystem .opencode/skills and .agents/skills)
  if (sources.has('installed') && tokens.length > 0) {
    const minThreshold = tokens.length > 1 ? 5 : 2
    for (const entry of installedMap.values()) {
      const { score } = scoreSkillMatch(entry.id, entry.description, tokens)
      if (score >= minThreshold) {
        scoredResults.push({
          skill: entry.id,
          description: entry.description,
          source: 'installed',
          installed: true,
          installs: null,
          installCommand: null,
          path: entry.path,
          scope: entry.scope,
          score,
        })
      }
    }
  }

  // 2. External tiers (Anthropic, skills.sh, GitHub)
  const externalSources = ['anthropic', 'skills-sh', 'github'].filter((s) => sources.has(s))

  if (externalSources.length > 0 && scoredResults.length < limit) {
    try {
      const extLimit = limit - scoredResults.length
      const extRes = searchSkillSources(query, {
        limit: extLimit,
        sources: externalSources,
      })

      if (Array.isArray(extRes.failures)) {
        failures.push(...extRes.failures)
      }

      if (Array.isArray(extRes.entries)) {
        const minThreshold = tokens.length > 1 ? 5 : 2
        for (const entry of extRes.entries) {
          const bareName = (
            entry.skill.includes('@') ? entry.skill.split('@')[1] : entry.skill
          ).toLowerCase()
          const isInstalled =
            installedMap.has(entry.skill.toLowerCase()) || installedMap.has(bareName)
          const installedRecord =
            installedMap.get(entry.skill.toLowerCase()) || installedMap.get(bareName)

          const { score } = scoreSkillMatch(entry.skill, entry.skill, tokens)
          if (score < minThreshold && !isInstalled) {
            continue
          }

          if (
            scoredResults.some(
              (r) =>
                r.skill.toLowerCase() === entry.skill.toLowerCase() ||
                (bareName && r.skill.toLowerCase() === bareName),
            )
          ) {
            continue
          }

          scoredResults.push({
            skill: entry.skill,
            description: entry.skill,
            source: entry.source as 'anthropic' | 'skills-sh' | 'github',
            installed: isInstalled,
            installs: entry.installs ?? null,
            ...(entry.url ? { url: entry.url } : {}),
            installCommand: isInstalled ? null : `npx skills add ${entry.skill} -a opencode -y`,
            path: isInstalled && installedRecord ? installedRecord.path : null,
            ...(isInstalled && installedRecord ? { scope: installedRecord.scope } : {}),
            score: score || 1,
          })
        }
      }
    } catch (err) {
      failures.push(
        `external skill search error: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  scoredResults.sort((a, b) => b.score - a.score)
  const bounded: SkillSearchResult[] = scoredResults
    .slice(0, limit)
    .map(({ score: _, ...item }) => item)

  return {
    ok: true,
    query,
    count: bounded.length,
    results: bounded,
    failures,
  }
}

export function createV2SkillSearchDefinition(defaultDir?: string): V2ToolDef {
  return {
    name: 'pantheon_skill_search',
    description: TOOL_DESCRIPTION,
    input: SKILL_SEARCH_INPUT_SCHEMA,
    output: {},
    execute: async (input: Record<string, unknown>, context?: unknown) => {
      const cwd = resolveToolCwd(context, defaultDir)
      return {
        output: JSON.stringify(executeSkillSearch(input, { cwd }), null, 2),
      }
    },
  }
}
