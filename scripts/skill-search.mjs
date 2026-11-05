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
const SKILL_LINE = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+@[A-Za-z0-9._-]+)\s+(\d+)\s+installs$/
const URL_LINE = /^└?\s*(https:\/\/skills\.sh\/\S+)$/

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
      found.push({ skill: skillMatch[1], installs: Number(skillMatch[2]), url: undefined })
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
  return { ok: true, entries: parseSkillSearchOutput(raw, { limit }), raw }
}

function main(args = process.argv.slice(2)) {
  const get = (flag) => {
    const i = args.indexOf(flag)
    return i >= 0 ? args[i + 1] : undefined
  }
  const query = args.find((a) => !a.startsWith('--'))
  if (query === undefined) {
    console.error(
      'usage: node scripts/skill-search.mjs "<query>" [--limit 5] [--owner <owner>] [--raw]',
    )
    process.exit(1)
  }
  const result = searchSkills(query, {
    limit: Number(get('--limit') ?? DEFAULT_LIMIT),
    owner: get('--owner'),
  })
  if (!result.ok) {
    console.error(result.error)
    process.exit(1)
  }
  if (args.includes('--raw')) {
    console.log(result.raw)
    return
  }
  console.log(JSON.stringify(result.entries, null, 1))
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) main()
