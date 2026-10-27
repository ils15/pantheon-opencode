import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { load } from 'js-yaml'
import {
  deriveNativeSkillPermissions,
  mergeAgentSkillPermissions,
} from '../scripts/install/opencode.mjs'
import { parseFrontmatter, ROOT } from '../scripts/install/shared.mjs'

const AGENTS_DIR = join(ROOT, 'src', 'agents')
const SKILLS_DIR = join(ROOT, 'src', 'skills')
const SKILL_FRONTMATTER_KEYS = new Set([
  'name',
  'description',
  'license',
  'compatibility',
  'metadata',
])

function readFrontmatter(path) {
  const parsed = parseFrontmatter(readFileSync(path, 'utf8'))
  assert.ok(parsed, `${path} must have YAML frontmatter`)
  return parsed.fm
}

test('every agent skill grant resolves to one installed skill and every skill is assigned', () => {
  const skillIds = new Set(
    readdirSync(SKILLS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => entry.name !== 'README.md')
      .map((entry) => entry.name),
  )
  const assigned = new Set()
  const agentSkills = new Map()
  const agentFiles = readdirSync(AGENTS_DIR).filter(
    (name) => name.endsWith('.md') && name !== 'README.md',
  )

  for (const filename of agentFiles) {
    const agent = readFrontmatter(join(AGENTS_DIR, filename))
    assert.ok(Array.isArray(agent.skills), `${filename} must declare its allowed skills`)
    assert.equal(new Set(agent.skills).size, agent.skills.length, `${filename} repeats a skill`)
    agentSkills.set(filename.replace(/\.md$/, ''), [...agent.skills].sort())
    for (const skill of agent.skills) {
      assert.ok(skillIds.has(skill), `${filename} references missing skill ${skill}`)
      assigned.add(skill)
    }
  }

  assert.deepEqual(
    [...skillIds].filter((skill) => !assigned.has(skill)),
    [],
  )

  const routing = load(readFileSync(join(ROOT, 'src', 'routing.yml'), 'utf8'))
  for (const [agent, skills] of agentSkills) {
    assert.deepEqual(
      [...(routing.agents?.[agent]?.skills ?? [])].sort(),
      skills,
      `src/routing.yml skill inventory for ${agent} must match canonical agent frontmatter`,
    )
  }
})

test('skill metadata uses the OpenCode V2 frontmatter contract', () => {
  const skillDirectories = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  for (const id of skillDirectories) {
    const path = join(SKILLS_DIR, id, 'SKILL.md')
    const skill = readFrontmatter(path)
    assert.equal(skill.name, id, `${id}/SKILL.md name must match the directory ID`)
    assert.equal(typeof skill.description, 'string', `${id}/SKILL.md needs a selection description`)
    assert.ok(skill.description.trim().length > 0, `${id}/SKILL.md description must not be blank`)
    for (const key of Object.keys(skill)) {
      assert.equal(
        SKILL_FRONTMATTER_KEYS.has(key),
        true,
        `${id}/SKILL.md uses unsupported ${key} metadata`,
      )
    }
  }
})

test('agent skill permissions default deny and grant only declared IDs', () => {
  assert.deepEqual(deriveNativeSkillPermissions(['memory-bank', 'simplify']), {
    '*': 'deny',
    'memory-bank': 'allow',
    simplify: 'allow',
  })
  assert.throws(() => deriveNativeSkillPermissions(['missing skill']), /skill ID is invalid/i)
  assert.throws(() => deriveNativeSkillPermissions(['simplify', 'simplify']), /duplicate skill/i)
  assert.throws(
    () => mergeAgentSkillPermissions({ skill: { '*': 'allow' } }, ['simplify']),
    /only through the skills list/i,
  )
})
