# Pantheon Memory

Pantheon has three separate context stores. Use the smallest one that fits:

| Store | Lifetime | Use |
|---|---|---|
| `pantheon-memory` MCP | Durable until explicitly forgotten | Reusable project facts and decisions |
| `pantheon-persistence` MCP | TTL-based or session-scoped | Explicit checkpoints and temporary key/value data |
| `.pantheon/memory-bank/` | Versioned in Git | Human-reviewed project context and ADRs |

These stores are not automatically synchronized. In particular, compaction's
TODO preservation is process-local and does not write to `pantheon-persistence`.
The `context_*` persistence tools are optional MCP checkpoints, not automatic
compaction hooks. See the [persistence reference](persistence-mcp.md).

## Memory MCP

The server stores entries in SQLite and indexes them with FTS5/BM25. Retrieval
is lexical: a query must share words with stored content; there is no embedding
model or vector search. The default namespace is `default`; use a named
namespace when entries have a distinct owner or purpose.

| Tool | Use |
|---|---|
| `memory_search(query, namespace?, top_k?, decay_days?)` | Find relevant entries; use `top_k=2` for task context |
| `memory_recall(key, namespace?)` | Fetch an entry when its exact key is already known |
| `memory_store(value, namespace?, key?, metadata?)` | Store a concise, reusable fact or decision |
| `memory_forget(id?, key?, namespace?)` | Remove an entry by ID or key |
| `memory_list(namespace?, prefix?, limit?)` | Inspect entries during explicit maintenance |
| `memory_stats()` | Inspect counts and database size during explicit maintenance |

`metadata` must be a JSON object encoded as a string, for example:
`metadata='{"type":"decision"}'`. A key is unique within its namespace;
duplicate keys fail rather than silently replacing the old entry.

The installed source also exposes the optional `code_index`, `code_query`, and
`code_neighbors` codemap tools. The installer uses `src/mcp/memory_mcp.py` as
the canonical runtime source; the standalone `scripts/memory_mcp.py` copy is
intentionally lighter. Keep their differences deliberate.

## Low-call policy

- Search only when project history could change the answer or implementation.
  Skip it for self-contained questions and small, obvious fixes.
- In delegated work, search at most once at the coordinator level and include
  useful results with the task. A specialist searches separately only if that
  context is missing and relevant.
- Do not search and then immediately recall the same result. Use `memory_recall`
  only when the exact key is known without a search.
- Store no routine child summaries, phase updates, test logs, or temporary
  state. At most one concise, top-level reusable outcome should be stored when
  it will matter in a later session.
- Do not claim automatic persistence or recovery: a store is durable only after
  `memory_store` reports success.

For the full tool catalog and persistence signatures, see
[MCP tools](mcp-tools.md) and [Persistence MCP](persistence-mcp.md).
