import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const zeus = read('../src/agents/zeus.md')
const timeoutRetry = read('../src/instructions/zeus-timeout-retry.instructions.md')
const routing = read('../src/routing.yml')
const autoContinue = read('../src/skills/auto-continue/SKILL.md')
const artifacts = read('../src/skills/artifact-management/SKILL.md')
const tdd = read('../src/skills/tdd-with-agents/SKILL.md')
const generated = read('../AGENTS.md')
const implementers = ['hermes', 'aphrodite', 'demeter', 'hephaestus', 'prometheus'].map((agent) =>
  read(`../src/agents/${agent}.md`),
)

test('small bounded changes use direct, proportionate execution', () => {
  assert.match(zeus, /trabalho delimitado ao especialista/i)
  assert.match(zeus, /não force planejamento/i)
  assert.match(zeus, /Nunca dispare council para correção pequena/i)
  assert.match(artifacts, /trivial|bounded/i)
  assert.match(artifacts, /read-only/i)
  assert.match(tdd, /micro|small|proportionate/i)
  assert.match(tdd, /focused test|targeted test/i)
})

test('sensitive work keeps human approval and specialist review gates', () => {
  const policy = `${zeus}\n${autoContinue}\n${routing}`
  assert.match(policy, /auth(?:entication)?|security/i)
  assert.match(policy, /schema|data integrity/i)
  assert.match(policy, /global|destructive/i)
  assert.match(policy, /push|merge/i)
  assert.match(policy, /Themis|review/i)
  assert.match(policy, /human|user approval/i)
})

test('implementers investigate only as needed and verify proportionally', () => {
  for (const source of implementers) {
    assert.match(source, /as needed|when necessary|only when/i)
    assert.match(source, /focused|targeted|relevant/i)
    assert.match(source, /auth|security|schema|data/i)
  }
})

test('automatic execution is bounded and never bypasses sensitive actions', () => {
  assert.match(autoContinue, /full-auto/i)
  assert.match(autoContinue, /never auto|never automate|must not be automated/i)
  assert.match(routing, /retry_count:\s*1\b/)
  assert.match(timeoutRetry, /never retry the same chain automatically/i)
  assert.match(
    timeoutRetry,
    /(?:refusal|recusa)[\s\S]*?(?:no retry|don't retry|do not retry|não gera retry)/i,
  )
})

test('quality/cost claims require measurement rather than projected percentages', () => {
  // The selective lean merge scoped frontend standards to @aphrodite, so the
  // changed-behavior phrase now lives in the frontend source rather than in the
  // shared baseline. The shared baseline must still require proportional,
  // measured checks and must never promise a projected coverage percentage.
  const frontend = read('../src/instructions/frontend-standards.instructions.md')
  assert.match(frontend, /test changed behavior proportionally/i)
  assert.match(generated, /use focused checks for micro-edits/i)
  assert.doesNotMatch(generated, /coverage minimum:\s*80%/i)
  assert.match(implementers[4], /quality deltas only after an A\/B evaluation/i)
  assert.match(implementers[4], /never combine unrelated tier savings/i)
})
