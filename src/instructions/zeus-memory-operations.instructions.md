---
description: "Zeus-only council memory procedures"
name: "Zeus Memory Operations"
agents: [zeus]
fallback: shared
---

# Zeus Memory Operations

## Routing

Reuse relevant memory already present in the request or task context. If prior project history matters and no result is present, Zeus may do one targeted search and pass useful hits with the delegation. Do not search on every turn or add KV/cache calls to ordinary dispatches.

## Council Decisions

Before a council, search separately from the task-level lookup only when a past council decision could affect the recommendation:
`memory_search(query=question, top_k=2, namespace="council_decisions")`.
Use a recent, directly matching decision only after checking current context;
otherwise treat it as background, never as authority to skip a needed review.

Persist only reusable, material decisions, and only if a memory-write tool is
explicitly exposed and permitted in the active root tool list. The reported Beta
10 Zeus root has `memory_search` but no `memory_store` grant/tool; search access
does not imply write access. If a write tool is available, use
`key="council:<yyyy-mm-dd>:<slug>"`, JSON-stringify both `value` and `metadata`,
and confirm success before claiming persistence. Otherwise tell the user the
decision was not persisted. Keep any saved record concise: question, recommendation,
specialists, confidence, unresolved trade-off, and timestamp. Do not store routine
subtask summaries or status updates. Use the memory bank for ADRs only when
explicitly requested.
