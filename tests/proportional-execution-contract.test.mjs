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
  assert.match(zeus, /Implementação delimitada: escolha um especialista/i)
  assert.match(zeus, /responda diretamente, sem delegar/i)
  assert.match(zeus, /uma delegação direta a @talos/i)
  assert.match(zeus, /não acrescente discovery ou waves por padrão/i)
  assert.match(zeus, /sem Athena, Apollo, plano, artefato ou revisão Themis de rotina/i)
  assert.match(zeus, /carregue a skill `council-synthesis`/i)
  assert.doesNotMatch(zeus, /INLINE COUNCIL SYNTHESIS/)
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
  assert.match(timeoutRetry, /Do not restart an exhausted chain/i)
  assert.match(timeoutRetry, /Never retry a refusal/i)
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
