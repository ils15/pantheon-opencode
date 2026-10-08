import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const readPrompt = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const zeus = readPrompt('../src/agents/zeus.md')
const memoryProtocol = readPrompt('../src/instructions/memory-protocol.instructions.md')
const generatedAgents = readPrompt('../AGENTS.md')
const taskStartSearch = 'memory_search(query=task_prompt, top_k=2)'

test('memory/delegation prompts reuse one task-start search and preserve required gates', () => {
  const taskSearchCount = generatedAgents.split(taskStartSearch).length - 1
  assert.equal(taskSearchCount, 1, 'the task-start FTS query belongs to shared core exactly once')
  assert.doesNotMatch(zeus, /memory_search\(query=task_prompt/)
  assert.match(memoryProtocol, /Before any file reads, call exactly once at task start/i)
  assert.match(memoryProtocol, /same result.*task context.*delegation routing/i)
  assert.match(memoryProtocol, /KV cache hit.*does not skip.*search/i)
  assert.match(memoryProtocol, /cache miss[\s\S]*memory_store[\s\S]*kv_store/i)
  assert.match(memoryProtocol, /memory_store\(\).*AUTOMATICALLY by Zeus.*subtask_summary/i)

  assert.match(zeus, /depth >= 2.*NAO delegar, ESCALAR para o usuario/)
  assert.match(zeus, /depth - 1/)
  assert.match(
    memoryProtocol,
    /memory_search\(query=question, top_k=2, namespace="council_decisions"\)/,
  )
  assert.equal(
    (
      generatedAgents.match(
        /memory_search\(query=question, top_k=2, namespace="council_decisions"\)/g,
      ) ?? []
    ).length,
    1,
  )

  assert.doesNotMatch(zeus, /memory_recall\(\)/, 'do not direct generic no-key recall')
  assert.doesNotMatch(zeus, /memory_store\(\).*apos cada fase/i)
  assert.doesNotMatch(zeus, /memory_store\(\).*after each phase/i)
})

test('delegation cache wording makes no unsupported token-savings claims', () => {
  const prompts = `${memoryProtocol}\n${zeus}\n${generatedAgents}`
  const unsupportedSavingsClaims = [
    /otimiza(?:r|ção)\s+(?:a\s+)?decis(?:ão|ões)\s+de\s+deleg(?:ação|ações)[^\n]*tokens?/i,
    /reduzir\s+(?:o\s+)?gasto\s+de\s+tokens?/i,
    /otimiza(?:ção|r)\s+de\s+tokens?/i,
    /(?:save|saves|saving|savings)\s+(?:\w+\s+){0,3}tokens?/i,
    /(?:runtime|tempo de execu(?:ção|cao))[^\n]*(?:improv|melhor|faster|mais rápido)/i,
  ]

  for (const claim of unsupportedSavingsClaims) {
    assert.doesNotMatch(
      prompts,
      claim,
      `unsupported token-savings wording must not return: ${claim}`,
    )
  }

  assert.match(memoryProtocol, /^## Delegation Cache Instructions$/m)
  assert.doesNotMatch(zeus, /^## Delegation Cache Instructions$/m)
})
