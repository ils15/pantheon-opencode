#!/usr/bin/env node
/**
 * validate-routing.mjs — Validate routing.yml consistency
 *
 * Checks:
 * - All 18 canonical agents present in routing.yml
 * - All routing.yml agents have canonical files
 * - Skills referenced exist in skills/
 * - Handoffs reference valid agents
 * - Routing matrix references valid agents
 *
 * Usage:
 *   node scripts/validate-routing.mjs
 *   node scripts/validate-routing.mjs --verbose   # show all entries checked
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { validatePresetDefs } from '../src/pantheon/presets.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const VERBOSE = process.argv.includes('--verbose')

let exitCode = 0
let checks = 0
let failures = 0

function check(condition, message) {
  checks++
  if (!condition) {
    console.error(`  ❌ ${message}`)
    failures++
    exitCode = 1
  } else if (VERBOSE) {
    console.log(`  ✅ ${message}`)
  }
}

function warn(message) {
  console.warn(`  ⚠️  ${message}`)
}

// Load routing.yml
const routingPath = join(ROOT, 'src', 'routing.yml')
if (!existsSync(routingPath)) {
  console.error('❌ routing.yml not found')
  process.exit(1)
}
const routing = yaml.load(readFileSync(routingPath, 'utf8'))

console.log('🔍 Validating routing.yml...\n')

// A1. Agents in routing.yml must have canonical files
const routingAgents = Object.keys(routing.agents || {})
console.log(`  Agents in routing.yml: ${routingAgents.length}`)

// Get canonical agent files
const agentsDir = join(ROOT, 'src', 'agents')
const canonicalFiles = readdirSync(agentsDir)
  .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
  .map((f) => f.replace('.md', ''))
  .sort()

console.log(`  Canonical agent files: ${canonicalFiles.length}`)

for (const name of routingAgents) {
  if (name === 'zen' || name === 'zeus_copilot') continue // legacy aliases, skip
  check(canonicalFiles.includes(name), `Agent "${name}" in routing.yml has no canonical file`)
}

// A2. Canonical files must be in routing.yml
for (const name of canonicalFiles) {
  check(routingAgents.includes(name), `Canonical agent "${name}" missing from routing.yml`)
}

// B. Skill validation
const srcSkillsDir = join(ROOT, 'src', 'skills')
const dotSkillsDir = join(ROOT, '.opencode', 'skills')
const existingSkills = []
for (const dir of [srcSkillsDir, dotSkillsDir]) {
  if (existsSync(dir)) {
    for (const d of readdirSync(dir)) {
      const skillDir = join(dir, d)
      try {
        if (existsSync(join(skillDir, 'SKILL.md')) && !existingSkills.includes(d)) {
          existingSkills.push(d)
        }
      } catch {
        /* skip */
      }
    }
  }
}
console.log(`\n  Skills found: ${existingSkills.length} (src/skills/ + .opencode/skills/)`)

for (const [name, info] of Object.entries(routing.agents || {})) {
  const agentSkills = info.skills || []
  for (const skill of agentSkills) {
    if (!existingSkills.includes(skill)) {
      warn(`Agent "${name}" references skill "${skill}" but skills/${skill}/SKILL.md not found`)
    }
  }
}

// C. Handoff validation
console.log(
  `\n  Handoff definitions: ${Object.keys(routing.handoffs || {}).length} agents with handoffs`,
)

for (const [agentName, handoffs] of Object.entries(routing.handoffs || {})) {
  for (const [key, handoff] of Object.entries(handoffs)) {
    // Skip if handoff is just a string (auto-generated)
    if (typeof handoff !== 'object') continue
    const targetAgent = handoff.agent
    check(
      routingAgents.includes(targetAgent),
      `Handoff "${agentName}/${key}" references unknown agent "${targetAgent}"`,
    )
  }
}

// D. Routing matrix validation
console.log(`\n  Routing matrix entries: ${(routing.routing_matrix || []).length}`)

for (const entry of routing.routing_matrix || []) {
  check(
    routingAgents.includes(entry.primary_agent),
    `Routing matrix "${entry.category}" references unknown primary agent "${entry.primary_agent}"`,
  )

  for (const parallel of entry.parallel_with || []) {
    check(
      routingAgents.includes(parallel),
      `Routing matrix "${entry.category}" references unknown parallel agent "${parallel}"`,
    )
  }
}

// E. Subagent delegation validation
console.log(`\n  Subagent delegation rules:`)

for (const [name, info] of Object.entries(routing.agents || {})) {
  const delegates = info.subagent_can_delegate_to || []
  for (const target of delegates) {
    check(
      routingAgents.includes(target),
      `Agent "${name}" can delegate to unknown agent "${target}"`,
    )
  }
}

// F. Model preset validation
const presetDefs = routing.presets || {}
console.log(`\n  Model presets: ${Object.keys(presetDefs).length} defined`)

const presetKnownAgents = routingAgents.filter((a) => a !== 'zen' && a !== 'zeus_copilot')
const presetValidation = validatePresetDefs(presetDefs, { agents: presetKnownAgents })
for (const err of presetValidation.errors) {
  check(false, `Preset ${err}`)
}
for (const w of presetValidation.warnings) {
  warn(`Preset ${w}`)
}
console.log(`  Presets defined: ${Object.keys(presetDefs).length}`)

// G. Delegation Matrix Invariants (B1 — Zeus strict + read-only exceptions)
console.log(`\n  Delegation matrix invariants:`)

// G1. can_delegate: true only for zeus, athena (→apollo), hermes (→apollo)
const CAN_DELEGATE_AGENTS = ['zeus', 'athena', 'hermes']
for (const [name, agentInfo] of Object.entries(routing.agents || {})) {
  if (agentInfo.can_delegate === true) {
    check(
      CAN_DELEGATE_AGENTS.includes(name),
      `Agent "${name}" has can_delegate: true but is not in allowed list [${CAN_DELEGATE_AGENTS}]`,
    )
  }
}

// G3. subagent_can_delegate_to only references existing agents
for (const [name, agentInfo] of Object.entries(routing.agents || {})) {
  const delegates = agentInfo.subagent_can_delegate_to || []
  for (const target of delegates) {
    check(
      routingAgents.includes(target),
      `Agent "${name}" can_delegate_to unknown agent "${target}"`,
    )
  }
}

// G4. athena and hermes can only delegate to apollo (read-only exception)
for (const agentName of ['athena', 'hermes']) {
  const agentInfo = routing.agents[agentName]
  if (agentInfo) {
    const delegates = agentInfo.subagent_can_delegate_to || []
    check(
      delegates.length <= 1 && delegates[0] === 'apollo',
      `Agent "${agentName}" subagent_can_delegate_to must be [apollo] only, got [${delegates}]`,
    )
  }
}

// G5. Frontmatter permission.task invariants
const AGENT_FILES_DIR = join(ROOT, 'src', 'agents')
const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/

function parseFrontmatter(filePath) {
  const content = readFileSync(filePath, 'utf8')
  const match = content.match(FRONTMATTER_RE)
  if (!match) return null
  try {
    return yaml.load(match[1])
  } catch {
    return null
  }
}

// G5a. Frontmatter mode must match routing.yml task eligibility.
const frontmatterByAgent = new Map()
for (const agentName of canonicalFiles) {
  frontmatterByAgent.set(agentName, parseFrontmatter(join(AGENT_FILES_DIR, `${agentName}.md`)))
}

for (const [name, agentInfo] of Object.entries(routing.agents || {})) {
  const fm = frontmatterByAgent.get(name)
  if (!fm) continue

  if (name === 'zeus') {
    check(fm.mode === 'primary', 'Agent "zeus" must use mode primary')
  } else if (agentInfo.can_receive_delegation === true) {
    const expectedMode = agentInfo.user_invocable === true ? 'all' : 'subagent'
    check(
      fm.mode === expectedMode,
      `Agent "${name}" mode must be "${expectedMode}" for routing.yml eligibility, got "${fm.mode}"`,
    )
  }
}

// G5b. Zeus targets must exist, receive delegation, and never be primary.
for (const targetEntry of routing.delegation?.zeus || []) {
  const target = typeof targetEntry === 'string' ? targetEntry : targetEntry.target
  const targetInfo = routing.agents[target]
  const targetFm = frontmatterByAgent.get(target)
  check(targetInfo !== undefined, `Zeus delegation target "${target}" must exist`)
  if (targetInfo && targetFm) {
    check(
      targetInfo.can_receive_delegation === true && targetFm.mode !== 'primary',
      `Zeus delegation target "${target}" must not be mode primary and must receive delegation`,
    )
  }
}

// G5c. Every subagent delegation target must exist and be eligible.
for (const [name, agentInfo] of Object.entries(routing.agents || {})) {
  for (const target of agentInfo.subagent_can_delegate_to || []) {
    const targetInfo = routing.agents[target]
    const targetFm = frontmatterByAgent.get(target)
    check(targetInfo !== undefined, `Agent "${name}" can_delegate_to unknown agent "${target}"`)
    if (targetInfo && targetFm) {
      check(
        targetInfo.can_receive_delegation === true && targetFm.mode !== 'primary',
        `Agent "${name}" can_delegate_to target "${target}" is not eligible`,
      )
    }
  }
}

// Expected permission.task matrix
const EXPECTED_TASK_PERMISSIONS = {
  zeus: { '*': 'allow' },
  athena: { '*': 'deny', apollo: 'allow' },
  hermes: { '*': 'deny', apollo: 'allow' },
  themis: { '*': 'deny' },
  aphrodite: { '*': 'deny' },
  demeter: { '*': 'deny' },
  apollo: { '*': 'deny' },
  gaia: { '*': 'deny' },
  prometheus: { '*': 'deny' },
  hephaestus: { '*': 'deny' },
  nyx: { '*': 'deny' },
  iris: { '*': 'deny' },
  talos: { '*': 'deny' },
  mnemosyne: { '*': 'deny' },
}

for (const agentName of canonicalFiles) {
  const fmPath = join(AGENT_FILES_DIR, `${agentName}.md`)
  const fm = parseFrontmatter(fmPath)
  if (!fm) {
    check(false, `Agent "${agentName}" has no valid frontmatter`)
    continue
  }

  // G5a. permission.task must exist
  const hasTask = fm.permission?.task
  check(hasTask, `Agent "${agentName}" missing permission.task in frontmatter`)

  if (!hasTask) continue

  // G5b. Only zeus may have "*": allow
  const starRule = fm.permission.task['*']
  if (starRule === 'allow') {
    check(
      agentName === 'zeus',
      `Agent "${agentName}" has permission.task "*": allow — only zeus is allowed`,
    )
  }

  // G5c. Verify exact expected permissions
  const expected = EXPECTED_TASK_PERMISSIONS[agentName]
  if (expected) {
    const actual = fm.permission.task
    const actualKeys = Object.keys(actual).sort()
    const expectedKeys = Object.keys(expected).sort()
    check(
      JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
      `Agent "${agentName}" permission.task keys mismatch: expected [${expectedKeys}], got [${actualKeys}]`,
    )
    for (const [key, val] of Object.entries(expected)) {
      check(
        actual[key] === val,
        `Agent "${agentName}" permission.task.${key}: expected "${val}", got "${actual[key]}"`,
      )
    }
  }
}

// Summary
console.log(`\n${'='.repeat(50)}`)
const status = failures === 0 ? '✅ PASSED' : `❌ FAILED (${failures}/${checks} checks failed)`
console.log(` ${status}`)
console.log(` ${checks} total checks${VERBOSE ? ', see verbose output above' : ''}`)
if (!VERBOSE && failures > 0) {
  console.log(' Run with --verbose to see all passing checks.')
}
console.log('')

process.exit(exitCode)
