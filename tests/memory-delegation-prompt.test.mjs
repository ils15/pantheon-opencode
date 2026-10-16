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
const architectureGuide = readPrompt('../docs/ARCHITECTURE.md')
const memoryGuide = readPrompt('../docs/MEMORY.md')
const mcpGuide = readPrompt('../docs/mcp-tools.md')
const agentMcpGuide = readPrompt('../docs/AGENT-MCP.md')
const memoryInstaller = readPrompt('../scripts/install-mcp.mjs')
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
  assert.match(zeus, /pantheon-persistence:\s*\[context_save, context_get\]/i)
  assert.doesNotMatch(zeus, /kv_(?:get|store|search)/i)
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
  assert.match(
    contextCompression,
    /does not create an automatic compression, memory, or checkpoint workflow/i,
  )
  assert.match(contextCompression, /Create a persistence checkpoint only when the user asks/i)
})

test('memory documentation describes the current low-call policy and current API', () => {
  assert.match(memoryGuide, /## Low-call policy/)
  assert.doesNotMatch(memoryGuide, /memory_(?:compress|expand|consolidate|link|traverse)/)
  assert.match(mcpGuide, /not the default cache for agent handoffs/i)
})

test('memory docs and prompts state the current storage, privacy, and grant contracts', () => {
  assert.match(memoryGuide, /SQLite `memory\.db`[\s\S]*entries have no TTL/i)
  assert.match(memoryGuide, /FTS5\/BM25[\s\S]*no embedding[\s\S]*model or vector search/i)
  assert.match(memoryGuide, /session-qualified context checkpoints default to 4h/i)
  assert.match(memoryGuide, /_tasks\/[`]? records may be Git-ignored/i)
  assert.match(memoryGuide, /automatic secret scrubbing\/redaction is not guaranteed/i)
  assert.match(
    memoryGuide,
    /Namespace is an organizational\/search filter, not an access-control boundary[\s\S]*searches without a namespace filter can return matches from any namespace/i,
  )
  assert.doesNotMatch(architectureGuide, /Written by:\s*Any agent, automatically/i)

  assert.match(mnemosyne, /automatic regex scrubbing\/redaction is not guaranteed/i)
  assert.doesNotMatch(mnemosyne, /memory_store` MCP server applies regex scrub/i)
  assert.match(
    memoryProtocol,
    /Zeus[^\n]*`memory_search`[^\n]*no durable writes/i,
    'Zeus must not be assumed to have Mnemosyne’s durable-memory grants',
  )
  assert.match(
    memoryProtocol,
    /Mnemosyne[^\n]*`memory_store`/i,
    'Mnemosyne’s distinct durable-memory grant must remain explicit',
  )
  assert.match(memoryProtocol, /Never store secrets, credentials, or tokens/i)
  assert.match(zeus, /pantheon-memory:\s*\[memory_search\]/i)
  assert.match(zeusMemoryOps, /temporary `context_save`[\s\S]*not durable memory[\s\S]*writes/i)
  assert.match(mcpGuide, /inspect the active tool grants\/catalog/i)
  assert.match(zeusMemoryOps, /Inspect the active tool grants\/catalog/i)
  assert.doesNotMatch(mcpGuide, /In this session, the Zeus root exposes/i)
  assert.doesNotMatch(zeusMemoryOps, /The Zeus root\s+in this session exposes/i)

  assert.match(agentMcpGuide, /installed per-agent allowlists[\s\S]*not[\s\S]*guarantee/i)
  assert.match(memoryInstaller, /SQLite memory with FTS5\/BM25 keyword search/i)
  assert.match(memoryInstaller, /no embedding\/vector search/i)
  assert.doesNotMatch(memoryInstaller, /semantic search|knowledge graph|compression|verification/i)
})

test('Mnemosyne MCP allowlist names only the registered memory tools', () => {
  const memoryTools = mnemosyne.match(/pantheon-memory:\n((?:\s+- [\w_]+\n)+)/)?.[1]
  assert.ok(memoryTools, 'Mnemosyne must declare an explicit pantheon-memory allowlist')

  const names = [...memoryTools.matchAll(/^\s+- ([\w_]+)$/gm)].map((match) => match[1])
  assert.deepEqual(names, [
    'memory_recall',
    'memory_store',
    'memory_search',
    'memory_forget',
    'memory_list',
    'memory_stats',
  ])
})
