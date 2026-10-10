---
description: "Zeus-only council memory procedures"
name: "Zeus Memory Operations"
agents: [zeus]
fallback: shared
---

# Zeus Memory Operations

## Routing

Use the task-start memory result for context and static agent descriptions for routing. Do not add KV/cache calls to ordinary dispatches.

## Council Decisions

Before a council, search separately from the required task-start search:
`memory_search(query=question, top_k=2, namespace="council_decisions")`.
Use a recent, directly matching decision only after checking current context;
otherwise treat it as background, never as authority to skip a needed review.

Persist only reusable, material decisions. Use
`key="council:<yyyy-mm-dd>:<slug>"`; JSON-stringify both `value` and
`metadata` for `memory_store(namespace="council_decisions", ...)`. Keep the
record concise: question, recommendation, specialists, confidence, unresolved
trade-off, and timestamp. Use `default` for routine summaries and @mnemosyne
for ADRs.
