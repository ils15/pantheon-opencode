import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  copyAgentPrompts,
  generateAgentPrompt,
  generateAgentsMd,
  parseInstruction,
  readInstructions,
} from '../scripts/build-agents-md.mjs'

const instructions = readInstructions()
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

test('applyTo remains a file glob and never acts as an agent selector', () => {
  const backend = instructions.find(
    (instruction) => instruction.file === 'backend-standards.instructions.md',
  )
  assert.equal(backend.applyTo, '**/*.py')
  assert.deepEqual(backend.agents, ['hermes'])
  assert.equal(backend.fallback, 'shared')
  assert.equal(backend.appliesToAgent('hermes'), true)
  assert.equal(backend.appliesToAgent('aphrodite'), false)

  const fileOnly = parseInstruction(`---\nname: Python-only example\napplyTo: "**/*.py"\n---\nRule`)
  assert.equal(fileOnly.applyTo, '**/*.py')
  assert.deepEqual(fileOnly.agents, [])
  assert.equal(fileOnly.appliesToAgent('hermes'), false)
  assert.ok(!generateAgentsMd([fileOnly]).includes('Python-only example'))
  assert.ok(!generateAgentPrompt('hermes', 'Hermes prompt', [fileOnly]).includes('Rule'))
})

test('shared AGENTS baseline excludes agent-scoped and language-specific instructions', () => {
  const baseline = generateAgentsMd(instructions)
  assert.ok(baseline.includes('YAGNI Principles'))
  assert.ok(!baseline.includes('INLINE COUNCIL SYNTHESIS'))
  assert.ok(!baseline.includes('Backend Development Standards (Hermes)'))
  assert.ok(!baseline.includes('Frontend Development Standards (Aphrodite)'))
})

test('Zeus-only operations stay scoped and council procedure loads on demand', () => {
  const shared = generateAgentsMd(instructions)
  const zeus = generateAgentPrompt('zeus', '## Zeus prompt', instructions)
  const hermes = generateAgentPrompt('hermes', '## Hermes prompt', instructions)
  const council = read('../src/skills/council-synthesis/SKILL.md')
  const zeusSource = read('../src/agents/zeus.md')

  assert.doesNotMatch(shared, /## Zeus Memory Operations/)
  assert.doesNotMatch(shared, /## Council Decisions/)
  assert.doesNotMatch(shared, /Council Specialist Response Format/)
  assert.match(zeus, /## Zeus Memory Operations/)
  assert.match(zeus, /## Council Decisions/)
  assert.match(zeusSource, /council-synthesis/)
  assert.doesNotMatch(zeus, /INLINE COUNCIL SYNTHESIS/)
  assert.match(council, /Council synthesis/)
  assert.doesNotMatch(hermes, /## Zeus Memory Operations|## Council Decisions/)
  assert.doesNotMatch(zeusSource, /context_(?:save|get)/)
  assert.doesNotMatch(
    council,
    /board\.(?:registerLaunch|markReconciled|recoverRunningJobs|formatForPrompt)/,
  )
  for (const agent of ['aphrodite', 'hermes', 'demeter', 'hephaestus']) {
    assert.doesNotMatch(read(`../src/agents/${agent}.md`), /context_get\(/)
  }
})

test('agent prompts get only their explicit instructions and a safe shared fallback', () => {
  const hermes = generateAgentPrompt('hermes', '## Hermes prompt', instructions)
  assert.ok(hermes.includes('Backend Development Standards (Hermes)'))
  assert.ok(hermes.includes('Apply only when a target workspace file matches `**/*.py`'))
  assert.ok(!hermes.includes('Frontend Development Standards (Aphrodite)'))
  assert.ok(!hermes.includes('INLINE COUNCIL SYNTHESIS'))
  assert.equal(generateAgentPrompt('hermes', hermes, instructions), hermes)

  const aphrodite = generateAgentPrompt('aphrodite', '## Aphrodite prompt', instructions)
  assert.ok(aphrodite.includes('Frontend Development Standards (Aphrodite)'))
  assert.ok(!aphrodite.includes('Backend Development Standards (Hermes)'))

  const zeus = generateAgentPrompt('zeus', '## Zeus prompt', instructions)
  assert.ok(read('../src/agents/zeus.md').includes('council-synthesis'))
  assert.ok(!zeus.includes('INLINE COUNCIL SYNTHESIS'))
  assert.ok(zeus.includes('Stall recovery'))
  assert.ok(zeus.includes('fallback chain'))
  assert.ok(zeus.includes('retry that agent once'))
  assert.equal((zeus.match(/DelegationCacheDecision/g) ?? []).length, 0)
  assert.ok(!zeus.includes('Backend Development Standards (Hermes)'))
  assert.doesNotMatch(zeus, /GoalLoop/)

  const antiStall = read('../src/instructions/zeus-anti-stall.instructions.md')
  const frontend = read('../src/instructions/frontend-standards.instructions.md')
  const timeout = read('../src/instructions/zeus-timeout-retry.instructions.md')
  const themis = read('../src/agents/themis.md')
  assert.match(antiStall, /expected to span more than five turns/)
  assert.match(frontend, /Strict mode always/)
  assert.match(frontend, /Keyboard navigation support/)
  assert.match(frontend, /Test changed behavior proportionally/)
  assert.match(timeout, /transient dispatch failure/)
  assert.match(timeout, /preserve specialist competence, Themis review, and human approval/)
  assert.match(timeout, /chain is exhausted, report what failed and stop/i)
  assert.doesNotMatch(
    timeout,
    /Timeout Behavior by Agent Role|Session Reuse Check|TIMEOUT TRACKING/,
  )
  assert.match(themis, /applicable coverage requirements/)
  assert.match(themis, /BLOCK_INTENT/)

  const unknown = generateAgentPrompt('unknown', '## Unmapped prompt', instructions)
  assert.match(
    unknown,
    /No agent-specific instructions are assigned; follow the shared rules in AGENTS\.md/,
  )
  assert.ok(!unknown.includes('Backend Development Standards'))
  assert.ok(!unknown.includes('INLINE COUNCIL SYNTHESIS'))
  assert.equal(generateAgentPrompt('unknown', unknown, instructions), unknown)
})

test('agent-specific instructions are present in the actual installed agent prompt', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-selective-instructions-'))
  try {
    const srcAgents = new URL('../src/agents/', import.meta.url).pathname
    copyAgentPrompts(srcAgents, join(target, '.opencode', 'agents'))
    const installedHermes = readFileSync(join(target, '.opencode', 'agents', 'hermes.md'), 'utf8')
    const installedZeus = readFileSync(join(target, '.opencode', 'agents', 'zeus.md'), 'utf8')
    assert.ok(installedHermes.includes('Backend Development Standards (Hermes)'))
    assert.ok(installedHermes.includes('Apply only when a target workspace file matches `**/*.py`'))
    assert.ok(!installedHermes.includes('INLINE COUNCIL SYNTHESIS'))
    assert.ok(installedZeus.includes('council-synthesis'))
    assert.ok(!installedZeus.includes('INLINE COUNCIL SYNTHESIS'))
    assert.ok(installedZeus.includes('retry that agent once'))
    assert.ok(!installedZeus.includes('Backend Development Standards (Hermes)'))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('instruction-only refresh updates existing agents without creating missing ones', () => {
  const target = mkdtempSync(join(tmpdir(), 'pantheon-selective-refresh-'))
  const installed = join(target, 'agents')
  mkdirSync(installed)
  writeFileSync(join(installed, 'hermes.md'), 'old Hermes prompt\n')
  try {
    const srcAgents = new URL('../src/agents/', import.meta.url).pathname
    copyAgentPrompts(srcAgents, installed, false, true)
    const hermes = readFileSync(join(installed, 'hermes.md'), 'utf8')
    assert.ok(hermes.includes('Backend Development Standards (Hermes)'))
    assert.ok(!readFileSync(join(installed, 'hermes.md'), 'utf8').includes('old Hermes prompt'))
    assert.ok(!existsSync(join(installed, 'zeus.md')))
  } finally {
    rmSync(target, { recursive: true, force: true })
  }
})

test('generated Zeus prompt avoids duplicating canonical memory and stall protocols', () => {
  const zeusSource = read('../src/agents/zeus.md')
  assert.doesNotMatch(zeusSource, /^## Memory Protocol$/m)
  assert.doesNotMatch(zeusSource, /^## TODO Enforcer \(Auto-Retry\)$/m)
  assert.doesNotMatch(zeusSource, /^## Delegation Cache Instructions$/m)
  assert.doesNotMatch(zeusSource, /DelegationCacheDecision/)
})

test('timeout instructions use routing as canonical without synthetic timer loops', () => {
  const timeout = read('../src/instructions/zeus-timeout-retry.instructions.md')
  const routing = read('../src/routing.yml')
  assert.match(
    timeout,
    /`routing\.yml` defines the concurrency limit, retry count, and canonical fallback chains/,
  )
  assert.match(routing, /fallback_chains:\s*[\s\S]*?hermes:\s*\n\s*- talos\s*\n\s*- athena/)
  assert.match(timeout, /none is configured or the chain is exhausted[\s\S]*stop/i)
  assert.match(timeout, /Do not simulate per-agent timers/)
})

test('stall guidance avoids invented task IDs and recovery APIs', () => {
  const antiStall = read('../src/instructions/zeus-anti-stall.instructions.md')
  const zeusSource = read('../src/agents/zeus.md')
  assert.match(antiStall, /Do not invent task IDs, session APIs, or recovery state/)
  assert.doesNotMatch(zeusSource, /context_(?:save|get)/)

  const skill = read('../src/skills/auto-continue/SKILL.md')
  assert.match(skill, /only when `context_save` and `context_get` are explicitly present/)
  assert.match(skill, /JSON\.stringify\(state\)/)
  assert.match(skill, /omit the key rather than passing a string/)

  const persistence = read('../docs/persistence-mcp.md')
  assert.match(persistence, /JSON-encoded string/)
  assert.match(persistence, /`goal` is optional/)
  assert.match(persistence, /`tail` is an array/)
})
