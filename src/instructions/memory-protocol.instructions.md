---
description: "Universal memory protocol rules for all Pantheon agents with agent-specific overrides"
name: "Memory Protocol"
applyTo: "agents/*.agent.md"
---

# 🧠 Memory Protocol — Universal Rules

These rules apply to ALL Pantheon agents. Agent-specific overrides are defined
in each agent's `## 🧠 Memory Protocol` section.

## Universal Rules

### 1. Pre-Work Read-Only Recall
**Before any file reads, call exactly once at task start:** `memory_search(query=task_prompt, top_k=2)`.
- Retain and reuse that same result as task context and as input to delegation routing.
- A KV cache hit does not skip the task-start search or trigger another FTS search; Zeus still uses the same result for both context and routing.
- Council-precedent lookup is a separate, explicitly scoped search and remains unchanged.
- Use domain-specific context matching your agent's focus area
- Do not issue another task-memory search for routing during the same task
- Agents have **read-only** memory access — only `memory_search()` is available

### 2. Auto-Store by Zeus on Subtask Summary
**`memory_store()` is called AUTOMATICALLY by Zeus when you return a subtask_summary.**
- Include a clear `summary` field in your return — no explicit `memory_store()` call needed
- This is the **ONLY** persistence path: agent → subtask_summary → Zeus → memory_store
- Zeus persists ALL agent returns (implementers and read-only agents alike)

### 3. Write-Ahead Log (WAL)
Before Zeus calls `memory_store()`, it writes a write-ahead log to:
```
.pantheon/memory-wal/<agent>/<timestamp>.json
```
- WAL format: `{ agent, phase, summary, files_changed, status, timestamp }`
- WAL is written **before** the store operation — if store crashes, WAL is recovered on next session start
- WAL files are ephemeral (auto-cleaned after 7 days)

### 4. Relevance Threshold
**Skip search results if relevance score < 0.3.**
- Prevents noise from unrelated past entries
- Applies to `memory_search()` results only

### 5. Permanent Documentation
**ADR-level decisions → delegate to `@mnemosyne`.**
- Use for: architecture decisions, significant trade-offs, pattern changes
- Not for: routine task summaries (handled by Auto-Store)

## Per-Agent Overrides

Each agent file defines overrides in its `## 🧠 Memory Protocol` section:
- Domain-specific `memory_search()` context string
- Read-only access via `memory_search()` only — no `memory_store` for subagents
- Agent-specific rules (session-end, sprint close, quick-index, etc.)


## Delegation Cache Instructions

Instrucoes para o comportamento do cache de roteamento:

1. Reutilize o resultado da busca task-start obrigatoria descrita acima para contexto da tarefa e para decidir o roteamento; nao execute uma segunda busca FTS.
2. Consulte o KV quando houver uma entrada de cache, mas mesmo em KV hit use o mesmo resultado task-start como entrada para o roteamento.
3. Se score > 0.85 → considere agente + background_mode do resultado cacheado
4. Se score ≤ 0.85 (cache miss) → aplique regras estaticas e grave a decisao tanto com `memory_store()` quanto com `kv_store()` usando os contratos de cache existentes:
   - key: deleg:<task_type>
   - value: JSON.stringify({agent, background, pattern})
   - metadata: JSON.stringify({type: "decision", score: N})

   `value` E `metadata` sao JSON-encoded strings — o runtime exige que o
   chamador serialize os dois. Objeto cru em `metadata` e rejeitado pelo
   `BeforeValidator` do servidor com `metadata must be a JSON object encoded
   as a string (got object). json.dumps it first. Example: metadata='{"type":
   "decision", "score": 0.9}'`.

5. **kv_store(namespace="deleg", key="deleg:<pattern>", value=...)** para padroes recorrentes de delegacao
6. **kv_get(namespace="deleg", key="deleg:<pattern>")** para consultar decisoes ja tomadas, sem substituir a busca task-start obrigatoria

## Council Decisions Namespace

Council synthesis decisions are persisted in a dedicated `council_decisions` namespace for precedent fast-path retrieval:

### Write Path
After every `/pantheon` council synthesis completes, Zeus stores:
```
memory_store({
  namespace: "council_decisions",
  key: "council:<yyyy-mm-dd>:<slug>",
  value: JSON.stringify({
    question: "original question",
    specialists: ["@agent1", "@agent2"],
    recommendation: "final recommendation",
    confidence: "High|Medium|Low",
    agreements: ["point1", "point2"],
    divergences: [{"issue": "...", "resolution": "..."}],
    response_rate: "X of Y",
    themis_audit: "approved|issues",
    precedent_used: false,
    timestamp: "<ISO-8601>"
  }),
  metadata: JSON.stringify({
    type: "council_decision",
    specialist_count: N,
    model_tier_used: "premium|default|fast"
  })
})
```
`value` is JSON-serialized before storing (the MCP `memory_store.value` argument is a string).
`metadata` works the same way — it is a JSON object encoded as a **string**, so pass
`JSON.stringify({...})`. A raw object is rejected with `metadata must be a JSON object
encoded as a string (got object). json.dumps it first. Example: metadata='{"type":
"decision", "score": 0.9}'` (enforced by a `BeforeValidator` in
`memory_mcp.py`). **Both `value` and `metadata` must be serialized by the caller.**

### Read Path (Precedent Fast-Path)
Before dispatching a new council, Zeus runs this separate council-precedent search in addition to the task-start search:
```
memory_search(query=question, top_k=2, namespace="council_decisions")
```

Result interpretation:
| Score | Age | Action |
|-------|-----|--------|
| > 0.85 | < 30 days | Return precedent verbatim (note "⚠️ Decisão de [data] — reavaliar se contexto mudou") as fast-path answer. Skip council dispatch entirely. |
| > 0.85 | >= 30 days | Return with warning "Reavaliar se contexto mudou — decisão tem mais de 30 dias" + proceed with council |
| 0.5 - 0.85 | Any | Include as context for specialists but still dispatch council |
| < 0.5 | Any | Ignore, proceed with fresh council |

### TTL & Maintenance
- Council decisions are LONG-TERM (no TTL or TTL = 365 days)
- Stale decisions (age > 90 days) should be flagged but NOT deleted — they remain as historical record
- Purge only via explicit namespace cleanup when decisions are superseded by ADRs

### When NOT to Use
- Routine task summaries → use `default` namespace (auto-store by Zeus)
- Sprint/progress tracking → use `session` namespace
- ADR-level architecture decisions → delegate to @mnemosyne for permanent documentation
