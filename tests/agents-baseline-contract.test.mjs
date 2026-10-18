import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  generateAgentPrompt,
  logicalLineCount,
  readInstructions,
} from '../scripts/build-agents-md.mjs'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const generated = read('../AGENTS.md')
const globalArtifact = read('../AGENTS.global.md')
const antiStall = read('../src/instructions/zeus-anti-stall.instructions.md')
const timeoutRetry = read('../src/instructions/zeus-timeout-retry.instructions.md')
const returnContract = read('../src/instructions/agent-return-format.instructions.md')
const councilSynthesis = read('../src/instructions/zeus-council-synthesis.instructions.md')
const routing = read('../src/routing.yml')
const subtaskPrompt = read('../prompts/subtask.prompt.md')
const contextCompression = read('../src/skills/context-compression/SKILL.md')
const zeusPrompt = read('../src/agents/zeus.md')
const aphroditePrompt = read('../src/agents/aphrodite.md')

function instructionBody(source) {
  return source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trim()
}

test('language standards remain available only in their matching agent prompts', () => {
  const instructions = readInstructions()
  const hermes = generateAgentPrompt('hermes', read('../src/agents/hermes.md'), instructions)
  const aphrodite = generateAgentPrompt(
    'aphrodite',
    read('../src/agents/aphrodite.md'),
    instructions,
  )
  assert.ok(
    hermes.includes(instructionBody(read('../src/instructions/backend-standards.instructions.md'))),
  )
  assert.ok(
    aphrodite.includes(
      instructionBody(read('../src/instructions/frontend-standards.instructions.md')),
    ),
  )
  assert.ok(!generated.includes('Backend Development Standards (Hermes)'))
  assert.ok(!generated.includes('Frontend Development Standards (Aphrodite)'))
  assert.ok(!globalArtifact.includes('Backend Development Standards (Hermes)'))
  assert.ok(!globalArtifact.includes('Frontend Development Standards (Aphrodite)'))
})

test('generated artifacts stay inside the beta-10 carved byte budget', () => {
  const bytes = Buffer.byteLength(generated, 'utf8')
  assert.ok(bytes < 4_000, `project AGENTS.md is ${bytes} bytes (carved, want < 4KB)`)
  const globalBytes = Buffer.byteLength(globalArtifact, 'utf8')
  assert.ok(globalBytes < 14_000, `AGENTS.global.md is ${globalBytes} bytes (want < 14KB)`)
  // The stale double-copy baseline was ~23.4KB across both artifacts.
  assert.ok(
    bytes + globalBytes < 16_000,
    `combined artifact payload is ${bytes + globalBytes} bytes (was ~23.4KB duplicated)`,
  )
})

test('generated line counts use LF boundaries without assuming a final newline', () => {
  assert.equal(logicalLineCount('one\ntwo\n'), 2)
  assert.equal(logicalLineCount('one\ntwo'), 2)
  assert.equal(logicalLineCount('one'), 1)
  assert.equal(logicalLineCount(''), 0)
  assert.equal(logicalLineCount(generated), 36)
  assert.equal(logicalLineCount(globalArtifact), 206)
})

test('Zeus can call the least-privilege Pantheon vision tool for diagnostics', () => {
  assert.match(zeusPrompt, /pantheon-vision:\s*\[vision_describe\]/)
  assert.doesNotMatch(zeusPrompt, /pantheon-vision:\s*all/)
  assert.match(zeusPrompt, /vision_describe:\s*allow/)
  assert.match(aphroditePrompt, /vision_describe:\s*allow/)
})

test('Zeus forwards visual context to implementation agents without discarding unrelated work', () => {
  assert.match(zeusPrompt, /image|screenshot/i)
  assert.match(zeusPrompt, /vision_describe/)
  assert.match(zeusPrompt, /For UI work, delegate to @aphrodite and include the image reference/i)
  assert.match(zeusPrompt, /include[\s\S]*image[\s\S]*delegat/i)
  assert.match(zeusPrompt, /preserv[\s\S]*(?:unrelated|existing)[\s\S]*(?:change|work)/i)
  assert.match(zeusPrompt, /not[\s\S]*(?:authorize|permission)[\s\S]*delete/i)
  assert.match(aphroditePrompt, /supplied image\/screenshot/i)
  assert.match(aphroditePrompt, /preserve unrelated existing work/i)
})

test('delegation retry guidance uses one retry before protected fallbacks', () => {
  assert.match(routing, /background_delegation:[\s\S]*?retry_count:\s*1\b/)
  assert.match(antiStall, /at most one corrected retry per\s+agent\/task/i)
  assert.match(antiStall, /transient dispatch failure/i)
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

  assert.match(returnContract, /If memory affected the result, state the takeaway briefly/i)
  const subtaskSummarySection = subtaskPrompt
    .split('## Subtask Summary Format\n')[1]
    ?.split('\n---')[0]
  assert.ok(subtaskSummarySection, 'subtask prompt must include its summary section')
  assert.ok(
    subtaskSummarySection.includes(
      'If memory affected the result, state the takeaway briefly; do not repeat the entry or task context.',
    ),
  )
  const returnMemoryContextField = returnContract
    .split('\n')
    .find((line) => line.startsWith('**memory_context:**'))
  assert.ok(returnMemoryContextField, 'return contract must include memory_context')
  assert.ok(returnMemoryContextField.includes('(optional;'), 'memory_context must be optional')
  const memoryContextGuidance = returnContract.split('## Memory Context\n')[1]?.split('\n## ')[0]
  assert.ok(memoryContextGuidance, 'return contract must include its Memory Context section')
  assert.match(memoryContextGuidance, /optional machine-readable `memory_context`/i)
  assert.match(
    memoryContextGuidance,
    /belongs to `## subtask_summary` only when that return format applies/i,
  )
  assert.match(
    memoryContextGuidance,
    /does not change the Apollo\/Athena structured-findings format or the council specialist-response contract/i,
  )
  assert.ok(
    returnMemoryContextField.includes('"refs"') && returnMemoryContextField.includes('"takeaway"'),
  )
  assert.match(
    memoryContextGuidance,
    /omit the field entirely when memory did not affect the result/i,
  )
  assert.match(memoryContextGuidance, /both its refs and takeaway must be non-sensitive/i)
  assert.match(memoryContextGuidance, /no secrets or irrelevant memory content/i)
  const subtaskMemoryContextField = subtaskPrompt
    .split('\n')
    .find((line) => line.startsWith('**memory_context:**'))
  assert.ok(subtaskMemoryContextField, 'subtask return contract must include memory_context')
  assert.ok(
    subtaskMemoryContextField.includes('(optional;'),
    'subtask memory_context must be optional',
  )
  assert.doesNotMatch(subtaskPrompt, /\*\*tokens:\*\*[^\n]*optional/i)
})

test('council agreement is derived from visible responses, not first-round guesses', () => {
  assert.match(
    councilSynthesis,
    /dispatch in parallel when the observed tool\/runtime supports it/i,
  )
  assert.match(councilSynthesis, /synchronous or sequential dispatch is also valid/i)
  assert.match(
    councilSynthesis,
    /first-round prompts independent[\s\S]*do not include other specialists' responses/i,
  )
  assert.match(councilSynthesis, /Zeus groups their actual substantive positions by issue/i)
  assert.match(
    councilSynthesis,
    /agreement from those positions, not from speculative or self-reported `agreement_signals`/i,
  )
  assert.match(councilSynthesis, /agreement_rate = agreeing_pairs \/ total_comparable_pairs/i)
  assert.match(councilSynthesis, /n\*\(n-1\)\/2/i)
  assert.match(councilSynthesis, /every unordered pair of specialists/i)
  assert.match(
    councilSynthesis,
    /a pair agrees only when its substantive positions[\s\S]*compatible/i,
  )
  assert.match(councilSynthesis, /unanimity is 100%, all pairs in divergence is 0%/i)
  assert.match(councilSynthesis, /exclude issues with fewer than two comparable positions/i)
  assert.match(
    councilSynthesis,
    /denominator is zero[\s\S]*indeterminate[\s\S]*(?:never|do not)[\s\S]*trigger rebuttal/i,
  )
  assert.match(councilSynthesis, /below 50%[\s\S]*only if no agent timed out[\s\S]*rebuttal/i)
  assert.match(councilSynthesis, /divergences[\s\S]*attribute each side to its agent/i)
  assert.match(
    councilSynthesis,
    /consensus and agreements are derived by Zeus from compared substantive positions/i,
  )
  assert.doesNotMatch(councilSynthesis, /first-round specialists are dispatched in parallel/i)
  assert.match(returnContract, /Omit `agreement_signals` or write `none` in the first round/i)
  assert.match(returnContract, /whether dispatch is parallel or synchronous\/sequential/i)
  assert.match(returnContract, /without peer responses/i)
  assert.doesNotMatch(returnContract, /First-round dispatches run in parallel/i)
  assert.match(returnContract, /never speculate or self-reference/i)
  assert.match(returnContract, /count alone as evidence or proof of confidence/i)
  assert.match(
    returnContract,
    /Equal self-reported counts[\s\S]*do not by themselves prove fabrication/i,
  )
})

test('context compression relies on native compaction and explicit checkpoints', () => {
  assert.match(contextCompression, /native compaction/i)
  assert.match(contextCompression, /only when the user asks/i)
  assert.match(contextCompression, /context_save/)
  assert.match(contextCompression, /context_get/)
  assert.doesNotMatch(
    contextCompression,
    /compress-inline\.py|execute_code_script|priority scoring/i,
  )

  for (const agent of ['aphrodite', 'demeter', 'hephaestus', 'hermes', 'prometheus']) {
    const source = read(`../src/agents/${agent}.md`)
    assert.doesNotMatch(source, /compress-inline\.py|Inline Compression/)
  }
})
