import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const readPrompt = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const zeus = readPrompt('../src/agents/zeus.md')
const mnemosyne = readPrompt('../src/agents/mnemosyne.md')
const memoryProtocol = readPrompt('../src/instructions/memory-protocol.instructions.md')
const zeusMemoryOps = readPrompt('../src/instructions/zeus-memory-operations.instructions.md')
const zeusAntiStall = readPrompt('../src/instructions/zeus-anti-stall.instructions.md')
const sessionAgents = ['aphrodite', 'demeter', 'hephaestus', 'hermes'].map((agent) =>
  readPrompt(`../src/agents/${agent}.md`),
)
const autoContinue = readPrompt('../src/skills/auto-continue/SKILL.md')
const contextCompression = readPrompt('../src/skills/context-compression/SKILL.md')
const memoryGuide = readPrompt('../docs/MEMORY.md')
const mcpGuide = readPrompt('../docs/mcp-tools.md')
const generatedAgents = readPrompt('../AGENTS.md')

test('memory retrieval and storage are selective rather than automatic', () => {
  assert.match(memoryProtocol, /Search only when prior project history could change the outcome/i)
  assert.match(memoryProtocol, /Zeus searches at most once/i)
  assert.match(memoryProtocol, /Reuse supplied results/i)
  assert.match(memoryProtocol, /one concise, reusable top-level result/i)
  assert.doesNotMatch(memoryProtocol, /Before any file reads, call exactly once/i)
  assert.doesNotMatch(memoryProtocol, /memory_store\(\).*automatically by Zeus.*subtask_summary/i)
  assert.doesNotMatch(memoryProtocol, /memory-wal|Delegation Cache Instructions|kv_store/i)

  assert.match(zeusMemoryOps, /Reuse relevant memory already present/i)
  assert.match(zeusMemoryOps, /Do not search on every turn or add KV\/cache calls/i)
  assert.match(
    zeusMemoryOps,
    /memory_search\(query=question, top_k=2, namespace="council_decisions"\)/,
  )
  assert.match(zeusMemoryOps, /JSON-stringify both `value` and[\s\S]*`metadata`/i)
  assert.doesNotMatch(zeusMemoryOps, /kv_(?:get|store|search)/)
  assert.doesNotMatch(zeus, /pantheon-persistence|kv_(?:get|store|search)/i)
  assert.match(zeus, /Não use KV compartilhado para contar profundidade/i)
  assert.doesNotMatch(mnemosyne, /Called automatically by Zeus when any agent returns/i)
  assert.match(mnemosyne, /Never auto-index a `subtask_summary`/i)
  for (const agent of sessionAgents) {
    assert.doesNotMatch(agent, /When dispatched by Zeus, call context_get/i)
  }
  assert.doesNotMatch(generatedAgents, /memory_search\(query=task_prompt|memory-wal/i)

  assert.match(zeus, /no máximo um especialista auxiliar/i)
  assert.doesNotMatch(zeus, /deleg:depth/)
  assert.doesNotMatch(zeus, /memory_recall\(\)/, 'do not direct generic no-key recall')
})

test('prompts avoid unsupported token-savings claims', () => {
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
})

test('checkpoint use avoids a redundant read after successful save', () => {
  assert.match(autoContinue, /only when `context_save` and `context_get` are explicitly/i)
  assert.match(autoContinue, /content=`?JSON\.stringify\(state\)/i)
  assert.match(autoContinue, /needs no immediate `context_get`/i)
  assert.match(autoContinue, /only when resuming or when the save result is uncertain/i)
  assert.match(
    zeusAntiStall,
    /only for long-running or multi-phase work when `context_save` and `context_get` are available/i,
  )
  assert.match(zeusAntiStall, /Do not retrieve it after every dispatch/i)
  assert.match(contextCompression, /não usa o persistence MCP/i)
  assert.match(contextCompression, /sem integração com os hooks de compactação/i)
})

test('memory documentation describes the current low-call policy and current API', () => {
  assert.match(memoryGuide, /## Low-call policy/)
  assert.doesNotMatch(memoryGuide, /memory_(?:compress|expand|consolidate|link|traverse)/)
  assert.match(mcpGuide, /not the default cache for agent handoffs/i)
})
