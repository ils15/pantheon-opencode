/**
 * delegation-matrix.test.mjs — Validate Phase B1 delegation matrix
 *
 * Enforces the "Zeus strict + read-only exceptions" policy:
 * - Only zeus can have permission.task with "*": allow
 * - can_delegate: true only for zeus, athena (→apollo), hermes (→apollo)
 * - All other 13 agents have permission.task deny
 * - subagent_can_delegate_to only references existing agents
 *
 * Run: node --test tests/pantheon/delegation-matrix.test.mjs
 */

import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..')
const AGENTS_DIR = join(ROOT, 'src', 'agents')
const ROUTING_PATH = join(ROOT, 'src', 'routing.yml')

// ─── Helpers ──────────────────────────────────────────────────────────

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

function getAgentNames() {
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .map((f) => f.replace('.md', ''))
    .sort()
}

function loadRouting() {
  return yaml.load(readFileSync(ROUTING_PATH, 'utf8'))
}

// ─── Expected matrix ──────────────────────────────────────────────────

const EXPECTED_MODE = {
  zeus: 'primary',
  athena: 'all',
  hermes: 'all',
  themis: 'all',
  aphrodite: 'all',
  demeter: 'all',
  apollo: 'subagent',
  gaia: 'subagent',
  prometheus: 'all',
  hephaestus: 'all',
  nyx: 'all',
  iris: 'all',
  talos: 'all',
  mnemosyne: 'all',
}

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

const EXPECTED_CAN_DELEGATE = {
  zeus: true,
  athena: true,
  hermes: true,
  themis: false,
  aphrodite: false,
  demeter: false,
  apollo: false,
  gaia: false,
  prometheus: false,
  hephaestus: false,
  nyx: false,
  iris: false,
  talos: false,
  mnemosyne: false,
}

const EXPECTED_SUBAGENT_CAN_DELEGATE_TO = {
  zeus: [
    'athena',
    'apollo',
    'hermes',
    'aphrodite',
    'demeter',
    'themis',
    'prometheus',
    'hephaestus',
    'nyx',
    'iris',
    'mnemosyne',
    'talos',
  ],
  athena: ['apollo'],
  hermes: ['apollo'],
  apollo: [],
  mnemosyne: [],
  talos: [],
  themis: [],
  aphrodite: [],
  demeter: [],
  prometheus: [],
  hephaestus: [],
  nyx: [],
  gaia: [],
  iris: [],
}

// ─── Tests ────────────────────────────────────────────────────────────

const agentNames = getAgentNames()
const routing = loadRouting()
const routingAgentNames = Object.keys(routing.agents || {})

test('all 14 agents have canonical .md files', () => {
  assert.equal(agentNames.length, 14, `Expected 14 agents, got ${agentNames.length}: ${agentNames}`)
})

test('all 14 agents are in routing.yml', () => {
  for (const name of agentNames) {
    assert.ok(routingAgentNames.includes(name), `Agent "${name}" missing from routing.yml`)
  }
})

test('all agents have valid frontmatter with permission.task', () => {
  for (const name of agentNames) {
    const fm = parseFrontmatter(join(AGENTS_DIR, `${name}.md`))
    assert.ok(fm, `Agent "${name}" has no valid frontmatter`)
    assert.ok(fm.permission, `Agent "${name}" missing permission in frontmatter`)
    assert.ok(fm.permission.task, `Agent "${name}" missing permission.task in frontmatter`)
  }
})

// ─── permission.task matrix ───────────────────────────────────────────

for (const name of agentNames) {
  test(`permission.task for ${name}: ${JSON.stringify(EXPECTED_TASK_PERMISSIONS[name])}`, () => {
    const fm = parseFrontmatter(join(AGENTS_DIR, `${name}.md`))
    const actual = fm.permission.task
    const expected = EXPECTED_TASK_PERMISSIONS[name]

    // Check key set matches
    const actualKeys = Object.keys(actual).sort()
    const expectedKeys = Object.keys(expected).sort()
    assert.deepEqual(
      actualKeys,
      expectedKeys,
      `${name} permission.task keys: expected [${expectedKeys}], got [${actualKeys}]`,
    )

    // Check each value matches
    for (const [key, val] of Object.entries(expected)) {
      assert.equal(
        actual[key],
        val,
        `${name} permission.task.${key}: expected "${val}", got "${actual[key]}"`,
      )
    }
  })
}

test('only zeus has permission.task "*": allow', () => {
  for (const name of agentNames) {
    const fm = parseFrontmatter(join(AGENTS_DIR, `${name}.md`))
    const starRule = fm.permission.task['*']
    if (starRule === 'allow') {
      assert.equal(name, 'zeus', `Agent "${name}" has "*": allow — only zeus is permitted`)
    }
  }
})

// ─── mode matrix ──────────────────────────────────────────────────────

for (const name of agentNames) {
  test(`mode for ${name}: ${EXPECTED_MODE[name]}`, () => {
    const fm = parseFrontmatter(join(AGENTS_DIR, `${name}.md`))
    assert.equal(
      fm.mode,
      EXPECTED_MODE[name],
      `${name} mode: expected "${EXPECTED_MODE[name]}", got "${fm.mode}"`,
    )
    if (['athena', 'hermes', 'aphrodite', 'demeter'].includes(name)) {
      assert.equal(fm.mode, 'all', `${name} must be task-eligible with mode all`)
      assert.equal(routing.agents[name].user_invocable, true)
      assert.equal(routing.agents[name].can_receive_delegation, true)
    }
  })
}

// ─── routing.yml can_delegate ─────────────────────────────────────────

for (const name of agentNames) {
  test(`routing.yml can_delegate for ${name}: ${EXPECTED_CAN_DELEGATE[name]}`, () => {
    const agentInfo = routing.agents[name]
    assert.ok(agentInfo, `Agent "${name}" not in routing.yml`)
    assert.equal(
      agentInfo.can_delegate,
      EXPECTED_CAN_DELEGATE[name],
      `${name} can_delegate: expected ${EXPECTED_CAN_DELEGATE[name]}, got ${agentInfo.can_delegate}`,
    )
  })
}

// ─── routing.yml subagent_can_delegate_to ─────────────────────────────

for (const name of agentNames) {
  if (!EXPECTED_SUBAGENT_CAN_DELEGATE_TO[name]) continue

  test(`routing.yml subagent_can_delegate_to for ${name}`, () => {
    const agentInfo = routing.agents[name]
    assert.ok(agentInfo, `Agent "${name}" not in routing.yml`)
    const actual = (agentInfo.subagent_can_delegate_to || []).sort()
    const expected = EXPECTED_SUBAGENT_CAN_DELEGATE_TO[name].sort()
    assert.deepEqual(
      actual,
      expected,
      `${name} subagent_can_delegate_to: expected [${expected}], got [${actual}]`,
    )
  })
}

// ─── subagent_can_delegate_to references valid agents ─────────────────

test('all subagent_can_delegate_to targets exist in routing.yml', () => {
  for (const [name, agentInfo] of Object.entries(routing.agents || {})) {
    const delegates = agentInfo.subagent_can_delegate_to || []
    for (const target of delegates) {
      assert.ok(
        routingAgentNames.includes(target),
        `Agent "${name}" can_delegate_to unknown agent "${target}"`,
      )
    }
  }
})

// ─── read-only exception constraint ───────────────────────────────────

test('athena can only delegate to apollo (read-only exception)', () => {
  const athenaInfo = routing.agents.athena
  const delegates = athenaInfo.subagent_can_delegate_to || []
  assert.deepEqual(delegates, ['apollo'], 'athena subagent_can_delegate_to must be [apollo] only')
})

test('hermes can only delegate to apollo (read-only exception)', () => {
  const hermesInfo = routing.agents.hermes
  const delegates = hermesInfo.subagent_can_delegate_to || []
  assert.deepEqual(delegates, ['apollo'], 'hermes subagent_can_delegate_to must be [apollo] only')
})

// ─── background_delegation.read_only_agents ───────────────────────────

test('read_only_agents includes apollo and gaia', () => {
  const roa = routing.background_delegation?.read_only_agents || []
  assert.ok(roa.includes('apollo'), 'read_only_agents must include apollo')
  assert.ok(roa.includes('gaia'), 'read_only_agents must include gaia')
})
