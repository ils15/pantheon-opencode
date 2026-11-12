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

export function executeSkillSearch(input: Record<string, unknown>): SkillSearchOutput {
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

  // 1. Tier 1: Installed Pantheon catalog (in-memory, instant, zero-network)
  if (sources.has('installed')) {
    const tokens = query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2)

    if (tokens.length > 0) {
      for (const entry of PANTHEON_SKILL_CATALOG) {
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
          results.push({
            skill: entry.skill,
            description: entry.skill,
            source: entry.source as 'anthropic' | 'skills-sh' | 'github',
            installed: false,
            installs: entry.installs ?? null,
            url: entry.url,
            installCommand: `npx skills add ${entry.skill} -a opencode -y`,
          })
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
    execute: async (input: Record<string, unknown>) => ({
      output: JSON.stringify(executeSkillSearch(input), null, 2),
    }),
  }
}
