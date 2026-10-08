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

## Delegation Cache Instructions

Reuse the required task-start result for routing; never issue a second task FTS search. Consult KV entries, but use the same result even on a cache hit. Score > 0.85: consider the cached agent and `background_mode`. On cache miss (≤0.85), use static rules and persist with `memory_store()` and `kv_store`:
- key: `deleg:<task_type>`; value: `JSON.stringify({agent, background, pattern})`
- metadata: `JSON.stringify({type: "decision", score: N})`
- Use `kv_store(namespace="deleg", key="deleg:<pattern>", value=...)` for recurring patterns and `kv_get(namespace="deleg", key="deleg:<pattern>")` to read them.

Both `value` and `metadata` are JSON-encoded strings. A raw metadata object is rejected (`metadata must be a JSON object encoded as a string`); serialize it with `JSON.stringify({...})` before calling the tool.

## Council Decisions Namespace

Persist completed `/pantheon` decisions in `council_decisions` for precedent retrieval.

### Write path
Use `key="council:<yyyy-mm-dd>:<slug>"`; JSON-stringify both `value` and `metadata` before `memory_store()`:
```json
{
  "question": "original question", "specialists": ["@agent1"],
  "recommendation": "...", "confidence": "High|Medium|Low",
  "agreements": ["..."], "divergences": [{"issue": "...", "resolution": "..."}],
  "response_rate": "X of Y", "themis_audit": "approved|issues",
  "precedent_used": false, "timestamp": "<ISO-8601>"
}
```
Metadata contains `{type: "council_decision", specialist_count: N, model_tier_used: "premium|default|fast"}`. Both arguments must be serialized strings; raw objects are invalid.

### Read path and maintenance
Before a new council, make this separate search in addition to the required task-start search:
`memory_search(query=question, top_k=2, namespace="council_decisions")`.

| Score | Age | Action |
|---|---|---|
| > 0.85 | < 30 days | Return precedent verbatim with a re-evaluate-context warning; skip dispatch. |
| > 0.85 | ≥ 30 days | Include warning and dispatch fresh council. |
| 0.5–0.85 | any | Give precedent as context and dispatch. |
| < 0.5 | any | Ignore; dispatch fresh council. |

Keep decisions long-term (no TTL or 365 days). Flag entries >90 days as stale, never delete them automatically; purge only by explicit namespace cleanup when superseded by ADRs. Use `default` for routine summaries, `session` for progress, and @mnemosyne for ADRs.
