# MCP Tool Registry

Canonical reference for Pantheon agents. Lists every tool across the 5 native MCP servers, with signatures, descriptions, and which agents use them.

> **Agent tip:** Tool names are platform-dependent. See [Platform Naming Conventions](#platform-naming-conventions) below to map these names to your runtime.

---

## Servers

Pantheon provides 5 native MCP servers. See below for full tool registries.

### pantheon-resources (read-only)

Read-only resource server. No tools — read resources directly via `pantheon://` URIs using `read_mcp_resource`.

| Resource URI | Description |
|---|---|
| `pantheon://agents` | List all 14 agent definitions (YAML frontmatter) |
| `pantheon://agents/{name}` | Single agent config by name (case-insensitive) |
| `pantheon://routing` | Full `routing.yml` — delegation rules, handoff contracts |
| `pantheon://skills` | List all skills with descriptions |
| `pantheon://skills/{name}` | Specific skill `SKILL.md` content |
| `pantheon://deepwork/{slug}` | Deepwork `PLAN.md` |
| `pantheon://deepwork/{slug}/status` | Deepwork `STATUS.md` (defaults to IN_PROGRESS) |
| `pantheon://memory-bank/{path}` | Any file under `.pantheon/memory-bank/` (path traversal blocked) |
| `pantheon://code-mode/scripts` | List all available code-mode scripts |
| `pantheon://code-mode/scripts/{name}` | View script content by name |
| `pantheon://memory/sessions` | List all memory sessions with counts and timestamps |
| `pantheon://memory/status` | Memory server stats: entries, sessions, disk usage |

**Used by:** ALL agents. Common reads: `routing` (zeus, athena), `agents/{name}` (any), `skills/{name}` (implementers), `memory-bank/{path}` (aphrodite, mnemosyne).

**Call pattern:**
```
read_mcp_resource(server="pantheon-resources", uri="pantheon://routing")
```

---

### pantheon-memory (persistent storage)

Lexical memory with SQLite FTS5 (BM25). **9 tools**: 6 `memory_*` for storing, searching, recalling, forgetting, listing, and inspecting memories across namespaces, plus 3 `code_*` codemap tools. Keyword retrieval only — no embedding or vector index.

| Tool | Signature | Description | Who uses it |
|------|-----------|-------------|-------------|
| `memory_store` | `(value, namespace?: "default", key?, metadata?: "{}")` | Store a memory entry (FTS5 index updated by trigger) | Implementers: hermes, aphrodite, demeter, prometheus, hephaestus, nyx, mnemosyne, zeus |
| `memory_search` | `(query, namespace?, top_k?: 5, decay_days?)` | FTS5 BM25 keyword search (stopwords dropped, 4+ char terms prefix-matched); optional freshness decay via `decay_days` (default off) | apollo, themis, mnemosyne |
| `memory_recall` | `(key, namespace?: "default")` | Exact recall of an entry by key within a namespace | ALL agents — session continuity |
| `memory_forget` | `(id?, key?, namespace?: "default")` | Delete an entry by ID or key (FTS index cleaned via trigger) | mnemosyne only |
| `memory_list` | `(namespace?, prefix?, limit?: 50)` | List entries chronologically with namespace and key-prefix filters | apollo, zeus — discovery |
| `memory_stats` | `()` | Database statistics: totals, namespaces, disk usage | nyx, zeus — maintenance |
| `code_index` | `(path?, force?)` | Index codebase files into a knowledge graph (hash-based skip) | apollo, athena, zeus |
| `code_query` | `(query, type?, limit?: 10)` | Search code entities via FTS5 | apollo, athena |
| `code_neighbors` | `(entity_id, depth?: 1)` | Graph neighbors of a code entity (BFS depth 1-3) | apollo, athena |

**Call pattern:**
```
memory_store(value="Decided to use refresh token rotation", key="decision-42")
memory_search(query="existing auth patterns", top_k=5)
memory_recall(key="decision-42")
```

---

### pantheon-persistence (KV store + FTS5 search)

Lightweight key-value store with SQLite FTS5, TTL-based expiration, and namespace isolation. Zero external dependencies (stdlib only). **14 tools**: 8 `kv_*`/`purge_*` key-value tools plus 6 `context_*` checkpoint tools (`context_save`, `context_get`, `context_list`, `context_stats`, `context_rehydrate`, `context_session_summary`). The table below lists the `kv_*` subset; see [persistence-mcp.md](persistence-mcp.md) for the `context_*` reference.

| Tool | Signature | Description | Who uses it |
|------|-----------|-------------|-------------|
| `kv_store` | `(namespace, key, value, ttl?, scope?)` | Store a key-value pair with optional TTL (seconds) | ALL agents — cache, session state |
| `kv_get` | `(namespace, key, scope?)` | Retrieve a value by namespace + key (auto-filters expired) | ALL agents — read cached data |
| `kv_delete` | `(namespace, key, scope?)` | Remove a key-value pair | zeus, talos — cleanup tasks |
| `kv_list` | `(namespace, prefix?, scope?, limit?)` | List keys in a namespace with optional prefix filter | apollo, zeus — discovery |
| `kv_search` | `(query, namespace?, scope?, limit?)` | FTS5 full-text search with BM25 ranking | mnemosyne, zeus — find across namespaces |
| `purge_expired` | `(scope?, dry_run?)` | Purge expired TTL entries with deletelog audit trail | mnemosyne, zeus — maintenance |

**Call pattern:**
```
kv_store(namespace="cache-apollo", key="api-response", value="...", ttl=3600)
kv_get(namespace="cache-apollo", key="api-response")
kv_search(query="auth token refresh")
purge_expired(scope="project", dry_run=True)
```

---

### pantheon-code-mode (script execution)

Confined automation scripts from `.pantheon/code-mode/`. One tool, 30s timeout, `.sh` and `.py` only.

| Tool | Signature | Description | Who uses it |
|------|-----------|-------------|-------------|
| `execute_code_script` | `(script_name: str, args?: list[str])` | Run a script from `.pantheon/code-mode/` and return output | Agents with `bash: allow` (zeus, hermes, aphrodite, demeter, themis, prometheus, hephaestus, talos) |

**NOT available to:** athena, apollo, gaia, iris, nyx, mnemosyne (no bash access).

**Use cases by agent:**
| Agent | Typical scripts |
|-------|----------------|
| zeus | Orchestration sequences |
| hermes | `pytest`, `ruff check`, `ruff format` |
| aphrodite | `npm test`, `biome check` |
| demeter | `alembic upgrade head && pytest` |
| themis | Lint/quality check scripts during review |
| prometheus | Docker builds, CI/CD pipeline scripts |
| talos | Automated hotfix sequences, batch fixes |

**Call pattern:**
```
execute_code_script("lint-and-test.sh", args=["backend/"])
```

---

### pantheon-vision (image analysis)

The local vision server accepts local paths, `file:` URIs, data URIs, and HTTP(S)
image URLs. The plugin first tries its configured native gateway, then falls
back to this MCP. Bifrost is not a default dependency; use it only through an
explicit `PANTHEON_VISION_TOOL` or `imageAnalysisTool` setting.

| Tool | Signature | Description |
|------|-----------|-------------|
| `vision_describe` | `(path: str, prompt?: str)` | Describe image content, visible text, layout, and objects |
| `vision_ocr` | `(path: str)` | Extract visible text while preserving line formatting |
| `vision_analyze` | `(path: str)` | Return image metadata, description, and OCR as JSON |

**Permission:** `ask` is recommended because images or remote URLs are sent to
the configured gateway. The server reads `PANTHEON_OPENCODE_API_KEY` or
`OPENCODE_API_KEY`, then the OpenCode auth store; no API key is stored in the
repository configuration.

---

## Platform Naming Conventions

Each platform exposes MCP tools with different naming. The same tool `memory_recall` from server `pantheon-memory` gets different names:

| Platform | Naming Pattern | Example for `memory_recall` |
|----------|---------------|-----------------------------|
| **OpenCode** | `{server}_{tool}` | `pantheon-memory_memory_recall` |
| **** | `mcp__{server}__{tool}` | `mcp__pantheon-memory__memory_recall` |
| **** | `<use_mcp_tool>` XML | `<use_mcp_tool><server_name>pantheon-memory</server_name><tool_name>memory_recall</tool_name></use_mcp_tool>` |
| **** | Original name | `memory_recall` (injected via schema) |
| **** | Original name | `memory_recall` (injected via schema) |
| **Continue** | Original name | `memory_recall` (injected via schema) |
| ** ** | Original name | `memory_recall` (injected via schema) |

---

## Permission Tiers

| Server | Recommended Tier | Rationale |
|--------|-----------------|-----------|
| pantheon-resources | `allow` | Read-only, same trust boundary as repo |
| pantheon-code-mode | `ask` | Executes scripts — needs user confirmation |
| pantheon-memory | `allow` | Read/write within agent sandbox, no system access |
| pantheon-persistence | `allow` | SQLite KV, same trust boundary as repo |
| pantheon-vision | `ask` | Sends image input to the configured vision gateway |

---

## Security Notes

- **pantheon-resources** — path traversal protection on `memory-bank/{path}`
- **pantheon-code-mode** — only `.sh`/`.py` in `.pantheon/code-mode/`, 30s timeout, no `../` escape
- **pantheon-memory** — all data in `~/.pantheon/memory/memory.db`, no system-level access
- **pantheon-persistence** — SQLite KV in `~/.pantheon/persistence/`, TTL auto-purge, namespace isolation
- **pantheon-vision** — 25 MB image cap, supported-format validation, safe errors, and API-key redaction

See `skill: mcp-security` for complete rules.
