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

  const results: SkillSearchResult[] = []
  const failures: string[] = []

  const cwd = options.cwd ?? process.cwd()
  const installedMap = scanInstalledSkills(cwd)

  // 1. Tier 1: Installed skills (Pantheon catalog + local filesystem .opencode/skills and .agents/skills)
  if (sources.has('installed')) {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2)

    if (tokens.length > 0) {
      for (const entry of installedMap.values()) {
        const idLower = entry.id.toLowerCase()
        const descLower = entry.description.toLowerCase()
        const matchScore = tokens.reduce((score, t) => {
          const stem = t.length > 4 ? t.slice(0, 4) : t
          return (
            score +
            (idLower.includes(t) ||
            descLower.includes(t) ||
            idLower.includes(stem) ||
            descLower.includes(stem)
              ? 1
              : 0)
          )
        }, 0)

        if (matchScore > 0) {
          results.push({
            skill: entry.id,
            description: entry.description,
            source: 'installed',
            installed: true,
            installs: null,
            installCommand: null,
            path: entry.path,
            scope: entry.scope,
          })
        }
      }
    }
  }

  // 2. External tiers (Anthropic, skills.sh, GitHub)
  const externalSources = ['anthropic', 'skills-sh', 'github'].filter((s) => sources.has(s))

  if (externalSources.length > 0 && results.length < limit) {
    try {
      const extLimit = limit - results.length
      const extRes = searchSkillSources(query, {
        limit: extLimit,
        sources: externalSources,
      })

      if (Array.isArray(extRes.failures)) {
        failures.push(...extRes.failures)
      }

      if (Array.isArray(extRes.entries)) {
        for (const entry of extRes.entries) {
          const bareName = (
            entry.skill.includes('@') ? entry.skill.split('@')[1] : entry.skill
          ).toLowerCase()
          const isInstalled =
            installedMap.has(entry.skill.toLowerCase()) || installedMap.has(bareName)
          const installedRecord =
            installedMap.get(entry.skill.toLowerCase()) || installedMap.get(bareName)

          const pushItem: SkillSearchResult = {
            skill: entry.skill,
            description: entry.skill,
            source: entry.source as 'anthropic' | 'skills-sh' | 'github',
            installed: isInstalled,
            installs: entry.installs ?? null,
            ...(entry.url ? { url: entry.url } : {}),
            installCommand: isInstalled ? null : `npx skills add ${entry.skill} -a opencode -y`,
            path: isInstalled && installedRecord ? installedRecord.path : null,
            ...(isInstalled && installedRecord ? { scope: installedRecord.scope } : {}),
          }
          results.push(pushItem)
        }
      }
    } catch (err) {
      failures.push(
        `external skill search error: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  const bounded = results.slice(0, limit)
  return {
    ok: true,
    query,
    count: bounded.length,
    results: bounded,
    failures,
  }
}

export function createV2SkillSearchDefinition(): V2ToolDef {
  return {
    name: 'pantheon_skill_search',
    description: TOOL_DESCRIPTION,
    input: SKILL_SEARCH_INPUT_SCHEMA,
    output: {},
    execute: async (input: Record<string, unknown>, context?: unknown) => {
      const cwd = (context as { directory?: string } | undefined)?.directory || process.cwd()
      return {
        output: JSON.stringify(executeSkillSearch(input, { cwd }), null, 2),
      }
    },
  }
}
