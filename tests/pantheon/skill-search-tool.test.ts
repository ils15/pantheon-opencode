import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createV2SkillSearchDefinition,
  executeSkillSearch,
  extractSkillMetadata,
  scanInstalledSkills,
} from '../../src/pantheon/skill-search-tool.ts'

test('executeSkillSearch returns installed local skills matching query', () => {
  const result = executeSkillSearch({ query: 'testing', sources: ['installed'] })
  assert.equal(result.ok, true)
  assert.ok(result.count > 0)
  assert.ok(result.results.some((r) => r.skill === 'tdd-with-agents'))
  assert.ok(result.results.some((r) => r.skill === 'test-slicing'))
  for (const item of result.results) {
    assert.equal(item.source, 'installed')
    assert.equal(item.installed, true)
    assert.equal(item.installCommand, null)
  }
})

test('extractSkillMetadata parses YAML frontmatter and fallbacks', () => {
  const withFm =
    '---\nname: my-fastapi-skill\ndescription: Modern FastAPI patterns and conventions\n---\n# Docs'
  assert.deepEqual(extractSkillMetadata(withFm, 'fallback'), {
    name: 'my-fastapi-skill',
    description: 'Modern FastAPI patterns and conventions',
  })

  const withoutFm = '# Skill Title\nThis is a skill for Docker deployment and containerization.'
  assert.deepEqual(extractSkillMetadata(withoutFm, 'docker-deploy'), {
    name: 'docker-deploy',
    description: 'This is a skill for Docker deployment and containerization.',
  })
})

test('scanInstalledSkills and executeSkillSearch discover on-disk project skills in .opencode/skills and .agents/skills', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'pantheon-skill-discovery-'))
  try {
    const opencodeSkillDir = join(tmp, '.opencode', 'skills', 'custom-fastapi')
    mkdirSync(opencodeSkillDir, { recursive: true })
    writeFileSync(
      join(opencodeSkillDir, 'SKILL.md'),
      '---\nname: custom-fastapi\ndescription: Enterprise FastAPI endpoints and validation\n---\nBody',
    )

    const agentsSkillDir = join(tmp, '.agents', 'skills', 'prisma-orm')
    mkdirSync(agentsSkillDir, { recursive: true })
    writeFileSync(
      join(agentsSkillDir, 'SKILL.md'),
      '---\nname: prisma-orm\ndescription: Prisma ORM database models and migrations\n---\nBody',
    )

    const scanned = scanInstalledSkills(tmp)
    assert.ok(scanned.has('custom-fastapi'))
    assert.equal(scanned.get('custom-fastapi')?.scope, 'project')
    assert.ok(scanned.has('prisma-orm'))
    assert.equal(scanned.get('prisma-orm')?.scope, 'project')

    const resFastapi = executeSkillSearch(
      { query: 'fastapi', sources: ['installed'] },
      { cwd: tmp },
    )
    assert.ok(resFastapi.ok)
    const match = resFastapi.results.find((r) => r.skill === 'custom-fastapi')
    assert.ok(match, 'custom-fastapi must be discovered from .opencode/skills/')
    assert.equal(match.installed, true)
    assert.equal(match.source, 'installed')
    assert.equal(match.installCommand, null)
    assert.ok(match.path?.includes('custom-fastapi'))

    const resPrisma = executeSkillSearch({ query: 'prisma', sources: ['installed'] }, { cwd: tmp })
    assert.ok(resPrisma.ok)
    const matchPrisma = resPrisma.results.find((r) => r.skill === 'prisma-orm')
    assert.ok(matchPrisma, 'prisma-orm must be discovered from .agents/skills/')
    assert.equal(matchPrisma.installed, true)
    assert.equal(matchPrisma.source, 'installed')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
})

test('executeSkillSearch rejects empty or blank query', () => {
  const result = executeSkillSearch({ query: '   ' })
  assert.equal(result.ok, false)
  assert.equal(result.count, 0)
  assert.ok(result.failures.length > 0)
})

test('executeSkillSearch bounds limit between 1 and 20', () => {
  const result = executeSkillSearch({ query: 'test', limit: 2, sources: ['installed'] })
  assert.equal(result.ok, true)
  assert.ok(result.count <= 2)
})

test('createV2SkillSearchDefinition exports compliant V2ToolDef', async () => {
  const def = createV2SkillSearchDefinition()
  assert.equal(def.name, 'pantheon_skill_search')
  assert.ok(def.description.length > 20)
  assert.ok(typeof def.input === 'object')
  assert.ok(typeof def.output === 'object')
  assert.equal(typeof def.execute, 'function')

  const res = (await def.execute({ query: 'test', sources: ['installed'] }, {})) as {
    output: unknown
  }
  assert.ok(res !== null && typeof res === 'object' && 'output' in res)
})
