# Pantheon Memory

Pantheon has three separate context stores. Use the smallest one that fits:

| Store | Lifetime | Use |
|---|---|---|
| `pantheon-memory` MCP | SQLite `memory.db`; entries have no TTL and remain until explicitly forgotten | Reusable project facts and decisions |
| `pantheon-persistence` MCP | Separate SQLite store; session-qualified context checkpoints default to 4h (heartbeat: 5m) | Explicit checkpoints and temporary key/value data |
| `.pantheon/memory-bank/` | Project files in the working tree; Git tracking depends on repository ignore/commit policy | Human-reviewed project context and ADRs |

These stores are not automatically synchronized. In particular, compaction's
TODO preservation is process-local and does not write to `pantheon-persistence`.
The `context_*` persistence tools are optional MCP checkpoints, not automatic
compaction hooks. They are separate from durable `pantheon-memory` entries:
checkpoint namespaces include the session ID, with the defaults shown above.
See the [persistence reference](persistence-mcp.md).

Pantheon does not implement OpenCode-style `/memories/repo/` or
`/memories/session/` stores or automatic loading from those paths. Durable
entries are stored through the `pantheon-memory` MCP tools. Project documents
under `.pantheon/memory-bank/` remain files and are read explicitly, including
through `pantheon://memory-bank/{path}` from `pantheon-resources`; that resource
is on-demand, not auto-loaded.

## Memory MCP

The server stores entries in SQLite and indexes them with FTS5/BM25. Retrieval
is lexical: a query must share words with stored content; there is no embedding
model or vector search. The default namespace is `default`; use a named
namespace when entries have a distinct owner or purpose. Stored entries have no
TTL; `decay_days` only changes search ranking and does not expire data.
Namespace is an organizational/search filter, not an access-control boundary;
searches without a namespace filter can return matches from any namespace.

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
- Never store secrets, credentials, or tokens. `memory_store` stores submitted
  values and metadata; automatic secret scrubbing/redaction is not guaranteed,
  so omit sensitive content or redact it before storage.
- Do not claim automatic persistence or recovery: a store is durable only after
  `memory_store` reports success.

Memory Bank files are not automatically synchronized or cross-clone persistent.
In particular, `.pantheon/memory-bank/_tasks/` records may be Git-ignored;
whether any Memory Bank file is shared depends on the repository's ignore and
commit policy.

For the full tool catalog and persistence signatures, see
[MCP tools](mcp-tools.md) and [Persistence MCP](persistence-mcp.md).
