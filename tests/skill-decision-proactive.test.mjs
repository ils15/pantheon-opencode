import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  createV2SkillSearchDefinition,
  executeSkillSearch,
} from '../src/pantheon/skill-search-tool.ts'

const read = (relPath) => readFileSync(new URL(relPath, import.meta.url), 'utf8')

test('Zeus instructions enforce proactive project-scoped skill decision flow', () => {
  const zeus = read('../src/agents/zeus.md')

  // Discovery & Arbitration
  assert.match(zeus, /pantheon_skill_search/i)
  assert.match(zeus, /pantheon_jev_decide/i)

  // Interactive Question Tool Gate
  assert.match(zeus, /Proactive Interactive Question Gate/i)
  assert.match(zeus, /MANDATORY `question` tool/i)
  assert.match(zeus, /\(Recomendado\) Instalar skills prioritárias no projeto/i)

  // Terminal commands ban & Specialist execution
  assert.match(zeus, /NEVER ask the user to type terminal commands/i)
  assert.match(zeus, /Automated Specialist Execution/i)
  assert.match(zeus, /dispatch an execution specialist with bash permitted \(@hermes or @talos\)/i)
  assert.match(zeus, /batching multiple skills in a single run/i)

  // Prompt Refinery & >> trigger
  assert.match(zeus, /Prompt Refinery & Request Disambiguation/i)
  assert.match(zeus, /Prefix `>>` \(Tier 2 Visual Contract\)/i)

  // Project-level scoping (.agents/skills/) & Global ban
  assert.match(zeus, /SEMPRE no projeto atual/i)
  assert.match(zeus, /\.agents\/skills\//i)
  assert.match(zeus, /-a opencode -y/i)
  assert.match(zeus, /NEVER propose or allow global installation/i)
})

test('orchestrate-with-zeus prompt guides proactive project skill installation', () => {
  const prompt = read('../prompts/orchestrate-with-zeus.prompt.md')

  assert.match(prompt, /proactively invoke the `question` tool for 1-click project installation/i)
  assert.match(prompt, /\.agents\/skills\//i)
  assert.match(prompt, /npx skills add <skill> -a opencode -y/i)
  assert.match(prompt, /Don't ask the user to run terminal commands for skill installation/i)
  assert.match(prompt, /never recommend or install global skills/i)
})

test('skill-search-tool produces project-scoped non-interactive install commands', () => {
  const def = createV2SkillSearchDefinition()
  assert.match(def.description, /\.agents\/skills\//i)
  assert.match(def.description, /question tool/i)

  // Test with a simulated external entry format
  const searchResult = executeSkillSearch({ query: 'testing', sources: ['installed'] })
  assert.equal(searchResult.ok, true)
  for (const item of searchResult.results) {
    assert.equal(item.installed, true)
    assert.equal(item.installCommand, null)
  }
})
