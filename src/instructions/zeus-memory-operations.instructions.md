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

Persist only reusable, material decisions. Use
`key="council:<yyyy-mm-dd>:<slug>"`; JSON-stringify both `value` and
`metadata` for `memory_store(namespace="council_decisions", ...)`. Keep the
record concise: question, recommendation, specialists, confidence, unresolved
trade-off, and timestamp. Do not store routine subtask summaries or status
updates. Use the memory bank for ADRs only when explicitly requested.
