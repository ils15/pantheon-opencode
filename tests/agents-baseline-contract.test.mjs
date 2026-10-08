import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const generated = read('../AGENTS.md')
const antiStall = read('../src/instructions/zeus-anti-stall.instructions.md')
const timeoutRetry = read('../src/instructions/zeus-timeout-retry.instructions.md')
const returnContract = read('../src/instructions/agent-return-format.instructions.md')
const routing = read('../src/routing.yml')
const subtaskPrompt = read('../prompts/subtask.prompt.md')

function instructionBody(source) {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
}

test('generated shared baseline preserves backend and frontend standards', () => {
  for (const path of [
    '../src/instructions/backend-standards.instructions.md',
    '../src/instructions/frontend-standards.instructions.md',
  ]) {
    assert.ok(
      generated.includes(instructionBody(read(path))),
      `${path} must remain available in generated AGENTS.md`,
    )
  }
})

test('generated baseline stays within the approved Tier 1 byte reduction', () => {
  const bytes = Buffer.byteLength(generated, 'utf8')
  assert.ok(bytes >= 28_555 && bytes <= 30_751, `generated AGENTS.md is ${bytes} bytes`)
})

test('delegation retry guidance uses one retry before protected fallbacks', () => {
  assert.match(routing, /background_delegation:[\s\S]*?retry_count:\s*1\b/)
  assert.match(antiStall, /one retry after the initial attempt/i)
  assert.match(timeoutRetry, /one retry after the initial attempt/i)
  assert.doesNotMatch(timeoutRetry, /\b[2-9] retries\b/i)
  assert.match(timeoutRetry, /retry fails[\s\S]*fallback/i)
  assert.match(timeoutRetry, /fallbacks fail[\s\S]*escalat/i)
  assert.match(subtaskPrompt, /one retry after the initial attempt/i)
  assert.match(subtaskPrompt, /fallback[\s\S]*escalat/i)
})

test('subtask prompt preserves the canonical required return contract', () => {
  const requiredFields = [
    'files_changed',
    'summary',
    'tests',
    'coverage',
    'tokens',
    'status',
    'blockers',
  ]

  for (const field of requiredFields) {
    assert.match(returnContract, new RegExp(`\\*\\*${field}:\\*\\*`))
    assert.match(subtaskPrompt, new RegExp(`\\*\\*${field}:\\*\\*`))
  }

  assert.match(returnContract, /If this agent used `memory_recall` or `memory_search`/)
  assert.match(
    subtaskPrompt,
    /If you used `memory_recall` or `memory_search`[\s\S]*relevant.*memory.*context/i,
  )
  assert.doesNotMatch(subtaskPrompt, /\*\*tokens:\*\*[^\n]*optional/i)
})
