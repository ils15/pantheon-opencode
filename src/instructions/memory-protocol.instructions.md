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
**Call `memory_search()` at task start before any file reads.**
- Use domain-specific context matching your agent's focus area
- Single call per task, not per turn
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


## Delegation Cache

Para otimizar decisoes de delegacao e reduzir gasto de tokens:

1. **memory_search(task_prompt, top_k=2)** antes de aplicar a arvore de roteamento
2. Se score > 0.85 → reutiliza agente + background_mode do cache
3. Se score ≤ 0.85 → aplica regras estaticas e memory_store() com:
   - key: deleg:<task_type>
   - value: {agent, background, pattern}
   - metadata: {type: "decision", score: N}

4. **kv_store("deleg:<pattern>", ...)** para padroes recorrentes de delegacao
5. **kv_get("deleg:<pattern>")** para reusar decisoes ja tomadas

Isso elimina ~300 tokens de reasoning por delegacao quando o cache acerta.

## Council Decisions Namespace

Council synthesis decisions are persisted in a dedicated `council_decisions` namespace for precedent fast-path retrieval:

### Write Path
After every `/pantheon` council synthesis completes, Zeus stores:
```
memory_store({
  namespace: "council_decisions",
  key: "council:<yyyy-mm-dd>:<slug>",
  value: {
    question: "original question",
    specialists: ["@agent1", "@agent2"],
    recommendation: "final recommendation",
    confidence: "High|Medium|Low",
    agreements: ["point1", "point2"],
    divergences: [{"issue": "...", "resolution": "..."}],
    response_rate: "X of Y",
    themis_audit: "approved|issues"
  },
  metadata: {
    type: "council_decision",
    specialist_count: N,
    model_tier_used: "premium|default|fast"
  }
})
```

### Read Path (Precedent Fast-Path)
Before dispatching a new council, Zeus runs:
```
memory_search(question, top_k=2, namespace="council_decisions")
```

Result interpretation:
| Score | Age | Action |
|-------|-----|--------|
| > 0.85 | < 30 days | Return precedent as fast-path answer. Skip council dispatch entirely. |
| > 0.85 | >= 30 days | Return with warning "Reavaliar se contexto mudou" + proceed with council |
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
