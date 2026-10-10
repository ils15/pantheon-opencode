---
description: "Universal memory protocol rules for all Pantheon agents with agent-specific overrides"
name: "Memory Protocol"
agents: ["*"]
---

# 🧠 Memory Protocol — Universal Rules

These rules apply to all agents; each agent file may add domain-specific rules.

## Universal Rules

### Task-start search
**Before any file reads, call exactly once at task start:** `memory_search(query=task_prompt, top_k=2)`.
- Reuse the same result for task context and delegation routing. A KV cache hit does not skip this search or trigger another task FTS search.
- Council-precedent lookup is separate. Use domain-relevant context; do not issue another task-memory search for routing.
- Agents have read-only memory access: only `memory_search()` is available.

### Summary persistence and WAL
`memory_store()` is called automatically by Zeus when an agent returns a `subtask_summary`; include a clear `summary`. This is the only persistence path, for implementers and read-only agents alike.
Before storing, Zeus writes `.pantheon/memory-wal/<agent>/<timestamp>.json` with `{agent, phase, summary, files_changed, status, timestamp}`. The WAL precedes storage, is recovered next session if storage fails, and expires after 7 days.

### Relevance and permanent records
Skip `memory_search()` results below 0.3 relevance. Delegate ADR-level architecture decisions, significant trade-offs, and pattern changes to @mnemosyne; routine summaries use auto-store.
