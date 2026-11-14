#!/usr/bin/env node
/**
 * build-roster.mjs — Declarative Roster Generator.
 *
 * Compiles specialist agent markdown files (`src/agents/*.md`) mechanically
 * from the single source of truth: `src/agents/roster.json`.
 *
 * Eliminates copy-paste drift, ensures frontmatter conformance, and enables
 * centralized governance over permissions, model reasoning effort, and skills.
 *
 * Usage:
 *   node scripts/build-roster.mjs          # compiles all agents
 *   node scripts/build-roster.mjs --check  # verifies zero drift; exits 1 if stale
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const ROSTER_PATH = join(ROOT, 'src', 'agents', 'roster.json')
const AGENTS_DIR = join(ROOT, 'src', 'agents')

export function formatFrontmatter(agent) {
  const lines = ['---']

  if (agent.name) lines.push(`name: ${agent.name}`)
  if (agent.description) {
    lines.push(`description: ${JSON.stringify(agent.description)}`)
  }
  if (agent.mode) lines.push(`mode: ${agent.mode}`)
  if (agent.reasoning_effort) lines.push(`reasoning_effort: ${agent.reasoning_effort}`)
  if (agent.temperature !== undefined && agent.temperature !== null) {
    lines.push(`temperature: ${agent.temperature}`)
  }

  if (agent.permission && Object.keys(agent.permission).length > 0) {
    lines.push('permission:')
    for (const [key, val] of Object.entries(agent.permission)) {
      if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
        lines.push(`  ${key}:`)
        for (const [subKey, subVal] of Object.entries(val)) {
          const formattedSubVal =
            typeof subVal === 'string' && subVal.includes('*') ? `"${subVal}"` : subVal
          const formattedSubKey = subKey.includes('*') ? `"${subKey}"` : subKey
          lines.push(`    ${formattedSubKey}: ${formattedSubVal}`)
        }
      } else {
        lines.push(`  ${key}: ${val}`)
      }
    }
  }

  if (agent.mcp_tools && Object.keys(agent.mcp_tools).length > 0) {
    lines.push('mcp_tools:')
    for (const [server, tools] of Object.entries(agent.mcp_tools)) {
      if (Array.isArray(tools)) {
        if (server === 'pantheon-memory' && tools.length > 2) {
          lines.push(`  ${server}:`)
          for (const t of tools) {
            lines.push(`    - ${t}`)
          }
        } else {
          lines.push(`  ${server}: [${tools.join(', ')}]`)
        }
      } else {
        lines.push(`  ${server}: ${tools}`)
      }
    }
  }

  if (Array.isArray(agent.skills) && agent.skills.length > 0) {
    lines.push('skills:')
    for (const skill of agent.skills) {
      lines.push(`  - ${skill}`)
    }
  }

  lines.push('---')
  return lines.join('\n')
}

export function generateAgentMarkdown(agent) {
  const fm = formatFrontmatter(agent)
  const body = (agent.body ?? '').trim()
  return `${fm}\n\n${body}\n`
}

export function buildRoster({ check = false } = {}) {
  if (!existsSync(ROSTER_PATH)) {
    console.error(`Roster manifest not found at ${ROSTER_PATH}`)
    process.exit(1)
  }

  const raw = readFileSync(ROSTER_PATH, 'utf8')
  const manifest = JSON.parse(raw)
  const agents = manifest.agents ?? {}
  const agentKeys = Object.keys(agents).sort()

  let hasDrift = false

  for (const key of agentKeys) {
    const agent = agents[key]
    const targetFile = join(AGENTS_DIR, `${key}.md`)
    const expected = generateAgentMarkdown(agent)

    if (check) {
      if (!existsSync(targetFile)) {
        console.error(`[DRIFT] Missing agent file: ${targetFile}`)
        hasDrift = true
        continue
      }
      const actual = readFileSync(targetFile, 'utf8')
      if (actual.trim() !== expected.trim()) {
        console.error(`[DRIFT] Content mismatch in: ${key}.md`)
        hasDrift = true
      }
    } else {
      writeFileSync(targetFile, expected, 'utf8')
    }
  }

  if (check) {
    if (hasDrift) {
      console.error('\n❌ Roster drift detected. Run `npm run build:roster` to synchronize.')
      process.exit(1)
    } else {
      console.log(`[OK] All ${agentKeys.length} agents are synchronized with roster.json.`)
    }
  } else {
    console.log(`[OK] Successfully compiled ${agentKeys.length} agents from roster.json.`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check')
  buildRoster({ check })
}
