import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import {
  createV2SkillSearchDefinition,
  executeSkillSearch,
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
