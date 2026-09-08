# Pantheon Persistence MCP

**Server:** `pantheon-persistence`
**Script:** `scripts/mcp_persistence_server.py`
**Dependencies:** `mcp.server.fastmcp` and project path helpers; SQLite/FTS5
storage uses the Python standard library.

A lightweight key-value store with SQLite + FTS5, TTL, and namespaces.
Separate from `pantheon-memory` (vector/ChromaDB).

## Purpose

- **Cache entre agentes** — compartilhar descobertas rápidas sem ir pro ChromaDB
- **Estado de execução** — steps de jobs, progresso, checkpoints
- **Dados efêmeros com TTL** — cache que expira sozinho
- **Dados locais** — tokens temporários, debug info (evita ir pro GitHub)

## Architecture

```
pantheon-persistence MCP
├── Global DB: ~/.config/opencode/persistence/global.db
└── Project DB: .pantheon/persistence/project.db
```

- **Global**: dados cross-projeto (cache de agentes, preferências)
- **Project**: dados específicos do projeto atual

## Tools (14)

The server exposes these 14 MCP tools. `scope` defaults to `"project"`; use
`"global"` for the global database.

| Tool | Signature | Description / return value |
|---|---|---|
| `kv_store` | `kv_store(namespace, key, value, ttl?, scope?)` | Stores or replaces a key-value pair. Returns `status`, `namespace`, and `key`. |
| `kv_get` | `kv_get(namespace, key, scope?)` | Retrieves a value, returning `null` when missing or expired. |
| `kv_stats` | `kv_stats(scope?)` | Returns `scope`, `total_entries`, `expired_entries`, per-namespace counts, and `db_size_bytes`. |
| `kv_delete` | `kv_delete(namespace, key, scope?)` | Deletes one key-value pair and returns `status: deleted` or `status: not_found`. |
| `kv_list` | `kv_list(namespace, prefix?, scope?, limit?)` | Lists up to `limit` keys (default 100), values, timestamps, and expiry data. |
| `kv_search` | `kv_search(query, namespace?, scope?, limit?)` | Performs FTS5 search over keys and values, optionally filtered by namespace; returns ranked matches. |
| `purge_expired` | `purge_expired(scope?, dry_run?)` | Purges expired TTL entries, optionally as a dry run, and records deleted keys in the deletelog. |
| `kv_delete_namespace` | `kv_delete_namespace(namespace, scope?, older_than_days?)` | Deletes all entries in a namespace, optionally restricted by age; returns the deleted count. |
| `context_save` | `context_save(slug, key, content, session_id, ttl?, scope?, revision?)` | Saves a bounded session checkpoint and atomically updates `latest` for checkpoint keys. |
| `context_get` | `context_get(slug, key?, session_id?, legacy?, scope?)` | Reads raw context content from the session-qualified namespace, or the legacy namespace only with explicit opt-in. |
| `context_list` | `context_list(slug, session_id?, legacy?, scope?)` | Lists up to 50 context keys with creation and expiry timestamps. |
| `context_stats` | `context_stats(slug, session_id?, legacy?, scope?)` | Returns context counts, expired entries, active bytes, and latest TTL remaining. |
| `context_rehydrate` | `context_rehydrate(slug, session_id, scope?)` | Rebuilds deterministic mission, phase, delegation, and tail blocks from the exact session checkpoint. |
| `context_session_summary` | `context_session_summary(slug, session_id, scope?)` | Builds a deterministic Tier 2 session-end summary for the exact session. |

### kv_stats
Return storage statistics with total entries, expired count, per-namespace breakdown, and DB file size.

`kv_stats(scope?)`
- `scope`: "project" (default) or "global"
- Returns `{"scope": ..., "total_entries": N, "expired_entries": N, "namespaces": {...}, "db_size_bytes": N}`

### kv_store
Store a key-value pair with optional TTL.

`kv_store(namespace, key, value, ttl?, scope?)`
- `ttl`: `null` = forever; an explicit TTL must be an integer from 1 to
  31,536,000 seconds (365 days)
- `scope`: "project" (default) or "global"
- Auto-purges expired entries when namespace exceeds 500 items
- Returns `{"status": "stored", "namespace": ns, "key": k}`

### kv_get
Retrieve a value by namespace + key.

`kv_get(namespace, key, scope?)`
- Auto-filters expired entries (SQL-level)
- Returns value string or null

### kv_delete
Remove an entry.

`kv_delete(namespace, key, scope?)`
- Returns `{"status": "deleted"}` or `{"status": "not_found"}`

### kv_list
List entries in a namespace with optional prefix filter.

`kv_list(namespace, prefix?, scope?, limit?)`
- Returns array of `{key, value, created_at, expires_at}`
- Respects TTL (expired items not returned)

### kv_search
Full-text search across all namespaces using SQLite FTS5.

`kv_search(query, namespace?, scope?, limit?)`
- BM25-ranked results
- Terms are sanitized and quoted for injection safety
- Returns array of `{namespace, key, value, created_at, score}`

### kv_delete_namespace
Delete all entries in a namespace. Optionally filter by age.

`kv_delete_namespace(namespace, scope?, older_than_days?)`
- `older_than_days`: if set, only delete entries older than N days
- Returns `{"deleted": count}`

### purge_expired
Remove expired entries and rotate deletelog.

`purge_expired(scope?, dry_run?)`
- Soft-delete with deletelog audit trail
- dry_run previews without purging
- Deletelog rotates at 1MB (keeps last 3)

## Context Checkpoint Tools

Session-scoped checkpoint storage for deepwork phases, heartbeat, and reasoning state.
Session-scoped entries use `checkpoint:{slug}:{session_id}`. `session_id` is
required and is never generated or inferred from `slug`; this prevents a reused
slug from recovering another session. The legacy unqualified namespace is
available only through the explicit `legacy=true` opt-in on read/list/stats.

`context_save` commits the checkpoint and its raw `latest` pointer in one SQLite
`BEGIN IMMEDIATE` transaction. Optional caller `revision` values are monotonic;
an older or equal revision returns `status: "stale"` and does not overwrite
the stored value. Without a caller revision, persistence assigns a monotonic
revision while holding the write lock. This is last-writer-wins for callers
that omit revisions; the schema has no separate CAS column and no migration is
performed.

Content is bounded to 64 KiB. Structured checkpoint JSON is an object with
bounded `goal`, `phase`, `delegations.in_flight`, `tail`, and `heartbeat`
fields. Rehydrated values are untrusted data: output blocks include an
informational label and escape markup/control delimiters without executing or
rewriting the stored value. Invalid JSON or an invalid checkpoint shape fails
closed; recovery never scans sibling keys. Explicit TTLs are validated as
integers from 1 to 31,536,000 seconds; omitted `context_save.ttl` uses the
key policy (300 seconds for `heartbeat`, 14,400 seconds for other context
keys).

### context_save
Save a context checkpoint for a session/phase.

`context_save(slug, key, content, session_id, ttl?, scope?, revision?)`
- `slug`: session identifier (e.g. "auth-refactor")
- `key`: checkpoint key (e.g. "phase:3", "latest", "heartbeat")
- `content`: JSON-serializable string
- `session_id`: required opaque session identifier
- `ttl`: optional integer from 1 to 31,536,000 seconds; omitted values default
  to heartbeat 300s and 14,400s for latest, tail, and other context keys
- `revision`: optional positive monotonic revision for stale-write rejection
- Updates `latest` for checkpoint keys, but not operational `heartbeat`/`tail`
- Returns status, namespace, session_id, ttl, and revision

### context_get
Retrieve a context checkpoint by slug and key.

`context_get(slug, key?, session_id?, legacy?, scope?)`
- `key`: defaults to "latest" (most recent checkpoint)
- `session_id`: required for session-scoped reads
- `legacy=true`: explicit opt-in for `checkpoint:{slug}` compatibility reads
- Returns raw content string or `null` if expired/not found

### context_list
List all checkpoints for a session slug.

`context_list(slug, session_id?, legacy?, scope?)`
- `session_id`: required for session-scoped reads
- `legacy=true`: explicit opt-in for the unqualified legacy namespace
- Returns keys, created_at, expires_at
- Ordered by most recent first, max 50

### context_stats
Return storage statistics for a session's context.

`context_stats(slug, session_id?, legacy?, scope?)`
- `session_id`: required for session-scoped reads
- `legacy=true`: explicit opt-in for the unqualified legacy namespace
- Returns slug, namespace, entry_count, expired_entries, total_bytes, ttl_remaining_seconds
- `entry_count` and `total_bytes` include only currently active entries;
  `expired_entries` remains a separate metric

### context_rehydrate

`context_rehydrate(slug, session_id, scope?)`
- `session_id` is required; missing/blank values fail closed
- Reads only the exact session-qualified `latest` entry
- Malformed/oversized JSON returns `null`; no sibling fallback is attempted
- Rebuilds deterministic goal/phase/delegation/tail blocks and refreshes an
  unexpired heartbeat conditionally (heartbeat default TTL: 300s)
- Fallback tail JSON must be an array of at most 100 strings, each at most
  4,096 bytes and with a total payload at most 64 KiB; invalid or oversized
  fallback data is ignored fail-closed, and output is capped at 10 nonblank
  lines
- Honors `PANTHEON_COMPACTION=off`

### context_session_summary

`context_session_summary(slug, session_id, scope?)`
- `session_id` is required; no slug discovery fallback
- Deterministic summary of the exact session; honors
  `PANTHEON_SESSION_END_SUMMARY=off`


## TTL Lifecycle

```python
# Cache que expira em 1 hora
kv_store(namespace="cache-apollo", key="api-response", value="...", ttl=3600)

# Dado permanente (sobrescreve sem perder created_at)
kv_store(namespace="config", key="db-url", value="postgres://...")

# Busca: expirados são invisíveis automaticamente
result = kv_get(namespace="cache-apollo", key="api-response")  # None se expirou

# Limpeza manual (opcional — TTL já filtra na leitura)
purge_expired(scope="project")
```

## Naming Conventions

| Namespace | Purpose | TTL |
|-----------|---------|-----|
| `cache-{agent}` | Descobertas temporárias | 300-3600s |
| `session-{id}` | Estado de sessão | 7200s |
| `job-{id}` | Progresso de job | 86400s |
| `config` | Config persistente | null |
| `local-only` | Dados sensíveis | 3600s |

## Comparison with pantheon-memory

| Aspect | persistence (this) | memory |
|--------|-------------------|--------|
| Storage | SQLite KV | ChromaDB vector |
| Search | FTS5 (exato/keyword) | Cosine similarity (semântico) |
| TTL | ✅ Por entrada | ❌ Nenhum |
| Namespace | ✅ Coluna + scope | ✅ Session + category |
| Dependencies | FastMCP + stdlib SQLite/FTS5 | sqlite-vec + fastembed |
| Tools | 14 | 6 |
| Source lines | 1,514 (`src/mcp`) | 769 (`src/mcp`) |
