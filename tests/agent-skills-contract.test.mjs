import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { load } from 'js-yaml'

const ROOT = process.cwd()

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return null
  return { fm: load(match[1]) ?? {} }
}

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

/**
 * The progressive-disclosure budget: a SKILL.md core may be 120 CONTENT lines.
 *
 * Content lines, not newline occurrences. `text.split('\n').length` returns one
 * more than `wc -l` for every newline-terminated file an editor writes, so the
 * precedent expression made the effective budget 119 lines and failed a
 * 120-line core that satisfied the rule. The rule always said 120, and that is
 * what is measured here; the boundary test below pins both sides, and the
 * failure message reports the same count the assertion judged.
 */
const CORE_BUDGET_LINES = 120

/** Count lines that carry content: a trailing newline terminates, never adds, a line. */
function countContentLines(text) {
  if (text === '') return 0
  return text.replace(/\r?\n$/, '').split('\n').length
}

/** Assert one core's line budget; returns the measured count so callers can pin it. */
function assertCoreBudget(id, body) {
  const lines = countContentLines(body)
  assert.ok(
    lines <= CORE_BUDGET_LINES,
    `${id}/SKILL.md is ${lines} lines — over the ${CORE_BUDGET_LINES}-line core budget; ` +
      'move depth to references/ and route it',
  )
  return lines
}

/** A synthetic core of `count` content lines, newline-terminated like a real file. */
function syntheticCore(count) {
  return `${Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n')}\n`
}

test('SKILL.md cores stay under the progressive-disclosure budget (120 lines)', () => {
  const ids = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  for (const id of ids) {
    assertCoreBudget(id, readFileSync(join(SKILLS_DIR, id, 'SKILL.md'), 'utf8'))
  }
})

test('the budget is 120 CONTENT lines: a trailing newline does not buy a line', () => {
  // The exact case that exposed the off-by-one: 120 content lines, terminated.
  assert.equal(assertCoreBudget('synthetic-120', syntheticCore(120)), 120)
  // CRLF checkouts and foreign editors must measure identically.
  assert.equal(
    assertCoreBudget('synthetic-120-crlf', syntheticCore(120).replaceAll('\n', '\r\n')),
    120,
  )
})

test('121 content lines fails, and the message reports 121', () => {
  assert.throws(
    () => assertCoreBudget('synthetic-121', syntheticCore(121)),
    (error) => {
      assert.match(error.message, /synthetic-121\/SKILL\.md is 121 lines/)
      assert.match(error.message, /120-line core budget/)
      return true
    },
  )
})

test('the decision catalog mirrors the skill directory (one entry per skill)', async () => {
  const { PANTHEON_SKILL_CATALOG } = await import('../src/pantheon/pantheon-decision-catalog.ts')
  const onDisk = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
  const inCatalog = PANTHEON_SKILL_CATALOG.map((entry) => entry.id).sort()
  assert.deepEqual(
    inCatalog,
    onDisk,
    'PANTHEON_SKILL_CATALOG must carry exactly one entry per skill directory',
  )
})
