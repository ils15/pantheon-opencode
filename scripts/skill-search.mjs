#!/usr/bin/env node
/**
 * skill-search.mjs — read-only search over the open skills ecosystem
 * (skills.sh via the `skills` CLI) for the discovery pipeline documented in
 * `docs/reference/native-decisions.md` and `src/agents/zeus.md`.
 *
 * The ladder this tool serves: installed skills first (one Jev
 * `mode: "skills"` call answers over the local pool); only when nothing fits
 * does the agent search the ecosystem, rank what came back with one typed
 * Jev choice question, and PROPOSE the project-scoped install to the user —
 * Pantheon never installs, and third-party skills are untrusted instructions.
 *
 * The `skills find` CLI prints ANSI-colored human text; this wrapper strips
 * the escapes and emits the parseable contract (`owner/repo@skill`,
 * install count, skills.sh URL) as JSON — the same contract the agent-side
 * inline parse follows. Read-only: it never adds, updates, or removes
 * skills, and no credentials cross it.
 *
 * Usage:
 *   node scripts/skill-search.mjs "<query>" [--limit 5] [--owner <owner>] [--raw]
 */

import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const FIND_TIMEOUT_MS = 60_000
const DEFAULT_LIMIT = 5
/** SGR escape sequences are matched via the ESC codepoint (lint-clean, same semantics). */
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const SKILL_LINE =
  /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+)\s+([\d.,]+)\s*([KM]?)\s+installs$/
const URL_LINE = /^└?\s*(https:\/\/skills\.sh\/\S+)$/

/** Distinct query tokens the name actually matches (0 = no lexical tie). */
export function nameMatchScore(name, tokens) {
  const lower = String(name).toLowerCase()
  const unique = [...new Set(tokens)]
  return unique.reduce((score, token) => score + (lower.includes(token) ? 1 : 0), 0)
}

/** '578.8K' / '1.2M' / '489' → absolute integer installs (K=1e3, M=1e6). */
export function parseInstallCount(digits, suffix) {
  const base = Number(String(digits).replaceAll(',', ''))
  if (!Number.isFinite(base)) return null
  if (suffix === 'K') return Math.round(base * 1_000)
  if (suffix === 'M') return Math.round(base * 1_000_000)
  return Math.round(base)
}

/** Remove SGR escape sequences so the text lines become parseable. */
export function stripAnsi(text) {
  return String(text).replace(ANSI_SGR, '')
}

/**
 * Parse `skills find` output into ordered entries {skill, installs, url?}.
 * `limit` (default 5) caps the result; entries keep the CLI's printed order
 * (the ecosystem's own ranking), never re-sorted here.
 */
export function parseSkillSearchOutput(raw, { limit = DEFAULT_LIMIT } = {}) {
  const lines = stripAnsi(raw)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  const found = []
  for (const line of lines) {
    const skillMatch = line.match(SKILL_LINE)
    if (skillMatch !== null) {
      if (found.length >= limit) continue
      found.push({
        skill: skillMatch[1],
        installs: parseInstallCount(skillMatch[2], skillMatch[3]),
        url: undefined,
      })
      continue
    }
    const urlMatch = line.match(URL_LINE)
    if (urlMatch !== null && found.length > 0) {
      const last = found[found.length - 1]
      if (last.url === undefined) last.url = urlMatch[1]
    }
  }
  return found
}

/** Run the ecosystem search once and return parsed entries. */
export function searchSkills(query, { limit = DEFAULT_LIMIT, owner, spawn = spawnSync } = {}) {
  const args = ['skills', 'find', String(query)]
  if (owner !== undefined) args.push('--owner', String(owner))
  const result = spawn('npx', args, {
    encoding: 'utf8',
    timeout: FIND_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.error !== undefined) {
    return { ok: false, error: `skills search failed to start: ${result.error.message}` }
  }
  const raw = `${result.stdout ?? ''}`
  if (result.status !== 0 && raw.trim() === '') {
    return { ok: false, error: `skills search exited ${result.status}` }
  }
  const entries = parseSkillSearchOutput(raw, { limit })
  // Field finding (beta.13 §9): skills.sh intermittently answers "No skills
  // found" (exit 0) for queries that succeed on retry — an empty result is
  // AMBIGUOUS between "nothing exists" and "degraded". Retry once on empty;
  // when still empty the callers treat it as not-found (the cascade moves on).
  if (entries.length === 0) {
    const retry = spawn('npx', args, {
      encoding: 'utf8',
      timeout: FIND_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const retryRaw = `${retry.stdout ?? ''}`
    const retried = parseSkillSearchOutput(retryRaw, { limit })
    if (retried.length > 0)
      return { ok: true, entries: retried, raw: retryRaw, emptyIsAmbiguous: false }
    return { ok: true, entries: [], raw, emptyIsAmbiguous: true }
  }
  return { ok: true, entries, raw, emptyIsAmbiguous: false }
}

const GITHUB_TIMEOUT_MS = 30_000
const ANTHROPIC_SKILLS_REPO = 'anthropics/skills'

/**
 * Tier 1: the canonical Anthropic catalog. Highest trust (curated upstream),
 * checked first so the canonical `pdf`/`docx`/`xlsx`/`mcp-builder` skills
 * outrank the third-party clones that skills.sh's ranking can surface.
 * Matches query tokens against catalog entry names; returns one entry per
 * matched name.
 */
export function searchAnthropicCatalog(query, { limit = DEFAULT_LIMIT, spawn = spawnSync } = {}) {
  const result = spawn(
    'gh',
    ['api', `repos/${ANTHROPIC_SKILLS_REPO}/contents/skills`, '--jq', '.[].name'],
    { encoding: 'utf8', timeout: GITHUB_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  if (result.error !== undefined || result.status !== 0) {
    return { ok: false, error: 'anthropic catalog lookup failed (gh api)' }
  }
  const tokens = String(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2)
  const names = String(result.stdout ?? '')
    .split('\n')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
  // Field finding (beta.5 battery): the canonical boost must not bury the
  // literal match — a single weak token hit ('webapp-testing' for a
  // 'contract testing' query) ranked above a two-token third-party match.
  // Within the tier, order by match quality; the merge sorts cross-tier.
  const scored = names.map((name) => ({
    name,
    score: nameMatchScore(name, tokens),
  }))
  const matched = scored
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.name)
  return {
    ok: true,
    entries: matched.slice(0, limit).map((name) => ({
      skill: `${ANTHROPIC_SKILLS_REPO}@${name}`,
      installs: null,
      url: `https://github.com/${ANTHROPIC_SKILLS_REPO}/tree/main/skills/${name}`,
      source: 'anthropic',
    })),
  }
}

/**
 * Tier 3: raw GitHub code search over every `SKILL.md` (the widest net —
 * orders of magnitude beyond the skills.sh index, and the weakest trust:
 * every hit is unreviewed third-party instructions).
 */
export function searchGithubSkills(query, { limit = DEFAULT_LIMIT, spawn = spawnSync } = {}) {
  const terms = String(query)
    .split(/\s+/)
    .filter((term) => term.length > 1)
    .slice(0, 3)
    .map((term) => encodeURIComponent(term))
    .join('+')
  if (terms === '') return { ok: true, entries: [] }
  const result = spawn(
    'gh',
    ['api', `search/code?q=filename:SKILL.md+${terms}&per_page=${Math.min(limit, 10)}`],
    { encoding: 'utf8', timeout: GITHUB_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  if (result.error !== undefined || result.status !== 0) {
    return { ok: false, error: 'github code search failed (gh api)' }
  }
  let parsed
  try {
    parsed = JSON.parse(String(result.stdout ?? '{}'))
  } catch {
    return { ok: false, error: 'github code search returned non-JSON output' }
  }
  const items = Array.isArray(parsed.items) ? parsed.items : []
  return {
    ok: true,
    entries: items.slice(0, limit).map((item) => {
      const repo = String(item?.repository?.full_name ?? 'unknown/repo')
      const path = String(item?.path ?? 'SKILL.md')
      const name = path.split('/')[Math.max(0, path.split('/').length - 2)] ?? 'skill'
      return {
        skill: `${repo}@${name}`,
        installs: null,
        url: `https://github.com/${repo}/blob/main/${path}`,
        source: 'github',
      }
    }),
  }
}

/**
 * The trust cascade: anthropic (canonical) → skills-sh (install-count
 * signal, unreviewed) → github (widest, least trusted). Tier order is the
 * recommendation order; callers may narrow with `sources`.
 */
export const SKILL_SEARCH_SOURCES = Object.freeze(['anthropic', 'skills-sh', 'github'])

export function searchSkillSources(
  query,
  { limit = DEFAULT_LIMIT, owner, sources = SKILL_SEARCH_SOURCES, spawn = spawnSync } = {},
) {
  const perTier = Math.max(1, Math.ceil(limit / sources.length))
  const out = []
  const failures = []
  for (const source of sources) {
    const result =
      source === 'anthropic'
        ? searchAnthropicCatalog(query, { limit: perTier, spawn })
        : source === 'skills-sh'
          ? searchSkills(query, { limit: perTier, owner, spawn })
          : source === 'github'
            ? searchGithubSkills(query, { limit: perTier, spawn })
            : { ok: false, error: `unknown source: ${source}` }
    if (result.ok) out.push(...result.entries.map((entry) => ({ ...entry, source })))
    else failures.push(`${source}: ${result.error}`)
  }
  // Cross-tier order: lexical relevance first (the canonical boost must not
  // bury the literal match — field finding, beta.5 battery: 'webapp-testing'
  // outranked 'contract-testing' for a 'contract testing' query), then the
  // trust cascade, then install count.
  const tokens = String(query)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2)
  const tierWeight = (source) => SKILL_SEARCH_SOURCES.indexOf(source)
  const installsWeight = (entry) =>
    typeof entry.installs === 'number' ? -entry.installs : Number.MAX_SAFE_INTEGER
  const skillName = (entry) => String(entry.skill).split('@').at(-1) ?? ''
  out.sort((left, right) => {
    const lScore = nameMatchScore(skillName(left), tokens)
    const rScore = nameMatchScore(skillName(right), tokens)
    if (lScore !== rScore) return rScore - lScore
    const tier = tierWeight(left.source) - tierWeight(right.source)
    if (tier !== 0) return tier
    return installsWeight(left) - installsWeight(right)
  })
  return { ok: failures.length < sources.length, entries: out.slice(0, limit), failures }
}

function main(args = process.argv.slice(2)) {
  const get = (flag) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  const query = args.find((a) => !a.startsWith('--'))
  if (query === undefined) {
    console.error(
      'usage: node scripts/skill-search.mjs "<query>" [--limit 5(total, merged across tiers)] [--sources anthropic,skills-sh,github] [--owner <owner>] [--raw]',
    )
    process.exit(1)
  }
  const sourcesArg = get('--sources')
  const sources =
    sourcesArg === undefined
      ? SKILL_SEARCH_SOURCES
      : sourcesArg
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
  const result = searchSkillSources(query, {
    limit: Number(get('--limit') ?? DEFAULT_LIMIT),
    owner: get('--owner'),
    sources,
  })
  if (args.includes('--raw')) {
    const skillsSh = result.entries.filter((e) => e.source === 'skills-sh')
    console.log(JSON.stringify(skillsSh, null, 1))
    return
  }
  if (result.failures.length > 0) {
    for (const failure of result.failures) console.error(`warning: ${failure}`)
  }
  if (result.entries.length === 0 && result.failures.length === sources.length) {
    console.error('all sources failed')
    process.exit(1)
  }
  console.log(JSON.stringify(result.entries, null, 1))
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) main()
