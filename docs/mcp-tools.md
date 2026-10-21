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
| `pantheon://eval` | Latest plugin/skill certification scores from the `plugin_eval` namespace |
| `pantheon://eval/{plugin}` | Latest certification report for one plugin/skill |

**Used by:** ALL agents. Common reads: `routing` (zeus, athena), `agents/{name}` (any), `skills/{name}` (implementers), `memory-bank/{path}` (aphrodite, mnemosyne), and eval reports when needed.

`pantheon://memory-bank/{path}` reads project files on demand; it does not
auto-load them. The eval resources are registered by this server and read the
global Memory SQLite database (`PANTHEON_HOME` / `XDG_CONFIG_HOME` override the
default `~/.config/opencode/memory/memory.db`) in the `plugin_eval` namespace.
This namespace is not an access-control boundary: clients that can read the
resources server can read the reports, and unfiltered `memory_search` calls can
match entries from `plugin_eval` too.

**Call pattern:**
```
read_mcp_resource(server="pantheon-resources", uri="pantheon://routing")
```

---

### pantheon-memory (persistent storage)

Lexical memory with SQLite FTS5 (BM25). The canonical source,
`src/mcp/memory_mcp.py`, registers **9 tools**: 6 `memory_*` tools for storing,
searching, recalling, forgetting, listing, and inspecting entries, plus 3
`code_*` codemap operations. `scripts/memory_mcp.py` is a compatibility
entrypoint that delegates to this canonical implementation. The runtime
installer copies the canonical source into the installed scripts directory;
`install-mcp.mjs` prefers that installed script and falls back to the source-tree
entrypoint when running from a checkout. Keyword retrieval only — no embedding
or vector index. The Memory server registers no resources.

| Tool | Signature | Description | Who uses it |
|------|-----------|-------------|-------------|
| `memory_store` | `(value, namespace?: "default", key?, metadata?: "{}")` | Store a reusable memory entry (FTS5 index updated by trigger); metadata is a JSON string | Mnemosyne when durable context is warranted and write access is granted |
| `memory_search` | `(query, namespace?, top_k?: 5, decay_days?)` | FTS5 BM25 keyword search (stopwords dropped, 4+ char terms prefix-matched); optional freshness decay via `decay_days` (default off). Empty results mean nothing matched; structured errors mean the memory store could not be read. | Coordinator or specialist only when prior project context is relevant |
| `memory_recall` | `(key, namespace?: "default")` | Exact recall of an entry by key within a namespace | Exact-key lookup when needed |
| `memory_forget` | `(id?, key?, namespace?: "default")` | Delete an entry by ID or key (FTS index cleaned via trigger) | mnemosyne only |
| `memory_list` | `(namespace?, prefix?, limit?: 50)` | List entries chronologically with namespace and key-prefix filters | Mnemosyne — explicit maintenance |
| `memory_stats` | `()` | Database statistics: totals, namespaces, disk usage | Mnemosyne — explicit maintenance |
| `code_index` | `(path?, force?)` | Index codebase files into a knowledge graph (hash-based skip) | No agent — blocked by design |
| `code_query` | `(query, type?, limit?: 10)` | Search code entities via FTS5 | apollo, athena |
| `code_neighbors` | `(entity_id, depth?: 1)` | Graph neighbors of a code entity (BFS depth 1-3) | apollo, athena |

### `memory_search` result and error contract

A successful search returns an array; no matches (including an empty or
all-stopword query) return `[]`. A failure to open or read the memory store
returns this JSON object as normal tool result content:

```json
{"error":{"type":"MemorySearchError","message":"Memory search failed while reading the SQLite FTS index or stored entries. Check the memory store and FTS index, then retry."}}
```

The `type` is `DatabaseUnavailableError` when the database cannot be opened or
`MemorySearchError` when search reads fail. The `message` is sanitized and does
not contain filesystem paths, SQL, or raw exception text. MCP `isError` remains
`false` because this is a returned data envelope, not a protocol-level tool
exception. Callers should parse the returned JSON content and distinguish an
array (including `[]`, a successful search) from an object with an `error` key
(a failed search); do not use `isError` or an empty array alone to detect this
failure.

Apollo and Athena receive only the read-only code map operations
(`code_query`, `code_neighbors`). No agent is granted `code_index`; its
server-side path-confinement guard remains defense in depth.

These are exact per-agent `mcp_tools.pantheon-memory` frontmatter grants:

| Agent(s) | Exact `pantheon-memory` grant |
|----------|-------------------------------|
| Apollo, Athena | `[memory_search, code_query, code_neighbors]` |
| Mnemosyne | `[memory_recall, memory_store, memory_search, memory_forget, memory_list, memory_stats]` |
| Aphrodite, Demeter, Hephaestus, Hermes, Nyx, Prometheus, Themis, Zeus | `[memory_search]` |
| Gaia, Iris, Talos | `[memory_recall]` |

Only Apollo and Athena receive `code_query` and `code_neighbors`; no agent
receives any other `code_*` tool, including `code_index`. Zeus and all other
agents receive no `code_*` tools. These are tools on `pantheon-memory`, not Code
Mode, and do not include `execute_code_script`.

**Lean call pattern:**
```
# Only when prior history can change the work; pass useful hits to child agents.
memory_search(query="existing auth patterns", top_k=2)

# Store once at the top level only if the result is reusable in a later session.
memory_store(value="Refresh tokens rotate on every use", key="decision-42")
```

The `plugin_eval` namespace shares this Memory database. Eval scripts write
certification entries there; the `pantheon-resources` server exposes them via
`pantheon://eval` and `pantheon://eval/{plugin}`. Namespaces organize queries
but do not enforce access: unfiltered Memory searches can include eval entries,
and access to the resource URIs follows access to the resources server.

The table describes server capabilities, not per-agent grants. Agent allowlists
and runtime tool exposure can differ; inspect the active tool grants/catalog
before relying on a tool. Temporary `context_save`/`context_get` checkpoints are
not durable-memory writes. Use only tools exposed and permitted in the active
context, and never claim a memory decision was persisted unless `memory_store`
succeeds.

`memory_store` writes submitted values and metadata; automatic secret
scrubbing/redaction is not guaranteed. Do not store secrets, credentials, or
tokens.

Do not search at every agent start, repeat a task-level search in each child, or
store routine phase/test summaries. Use `memory_recall` only when an exact key
is already known; do not search and then immediately recall the same entry.

---

### pantheon-persistence (session checkpoints + manual goals)

The MCP server exposes exactly **6 tools**. SQLite's KV table remains an internal
implementation detail used by checkpoint storage; the former KV management,
search, context-list/statistics, rehydration, and session-summary tools are not
registered.

Use `pantheon-memory` for durable knowledge. Persistence stores explicit
session-scoped checkpoints and manual goals; it is **not the default cache for agent handoffs**.
Expired checkpoints are filtered on reads, not automatically purged.

| Tool | Signature | Description | Who uses it |
|------|-----------|-------------|-------------|
| `context_save` | `(slug, key, content, session_id, ttl?, scope?, revision?)` | Save a bounded session checkpoint and update its latest pointer | Zeus |
| `context_get` | `(slug, key?, session_id?, legacy?, scope?)` | Read session-qualified checkpoint content | Zeus |
| `goal_create` | `(title, description?)` | Create the caller session's active manual goal | Zeus |
| `goal_get` | `(goal_id?)` | Read the caller session's active or latest completed goal | Zeus |
| `goal_update` | `(goal_id, expected_version, title?, description?, clear_description?)` | Edit goal fields with optimistic version checking | Zeus |
| `goal_done` | `(goal_id, expected_version)` | Complete the caller session's goal | Zeus |

Goal tools are Zeus-only because goals are session-scoped and cannot be read
across sessions. Athena and Themis run in child sessions and cannot read Zeus's
goal; as root they cannot create a goal in their own session because only Zeus
has `goal_create`. Manual goals do not enable automatic continuation and do not
replace the V1 `GoalStore`. See
[Persistence MCP](persistence-mcp.md#manual-session-goals) for details.

---

### pantheon-code-mode (script execution)

Confined automation scripts from `.pantheon/code-mode/`. One tool, 30s timeout, `.sh` and `.py` only.

The server also registers `pantheon://code-mode/scripts` and
`pantheon://code-mode/scripts/{name}` resources; these are not part of
`pantheon-resources`.

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
| `vision_describe` | `(path: str, prompt?: str, session_id?: str)` | Describe image content, visible text, layout, and objects |
| `vision_ocr` | `(path: str, session_id?: str)` | Extract visible text while preserving line formatting |
| `vision_analyze` | `(path: str, session_id?: str)` | Return image metadata, description, and OCR as JSON |

**Permission:** `ask` is recommended because images or remote URLs are sent to
the configured gateway. The server reads `PANTHEON_OPENCODE_API_KEY` or
`OPENCODE_API_KEY`, then the OpenCode auth store; no API key is stored in the
repository configuration.

---

## OpenCode plugin tools

These tools are provided by the OpenCode plugin, not by one of the five native
MCP servers listed above.

| Tool | Arguments | What it reports |
|------|-----------|-----------------|
| `pantheon_model` | `action?: status\|show\|set\|reset`, plus action-specific agent/model/effort and optional `scope: project` | V2 manual overrides are **project-only**: status reads project configuration, and the agent transform applies only explicit project per-agent model/variant overrides; global files are neither read nor applied. `set`/`reset` reject `scope: global` and any `confirm`/`authorize_global` fields before writing. Global overrides require separate explicit human authorization in a future surface and are not supported by this tool; flags in the same tool call are not approval. V2 ignores static preset markers and `PANTHEON_MODEL_PRESET`, leaving host defaults intact otherwise. Invalid or malformed project overrides preserve the host model and expose warnings via status. The V2 server plugin has no documented toast or other proactive user-visible notification API during transform, so no toast/proactive warning is promised. V1 behavior remains legacy. |
| `pantheon_cost` | `days?: 1..365` (default `7`) | Read-only token totals by agent and phase in a rolling `days × 24-hour` window from query time. It is not a calendar-day or session window. |

`pantheon_cost` is not grouped by session, task, model, or provider; on V2 the
phase can be `unknown`. It reports token counts, not dollars, so it cannot prove
monetary savings or a model-specific usage delta. Its aggregate is not a
per-session or per-task ledger.

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

> **In the Code Mode `execute` sandbox the visible catalog is a subset, not the
> registry above.** Resolve a hidden tool by calling `search()` for its exact path
> and then invoking that path **literally** — passing the whole path string as a
> single key fails even though `search()` returned it (see **P1-10** in
> [ROADMAP.md](../ROADMAP.md)).

---

## Permission Tiers

OpenCode MCP tool grants authorize an agent to call the server tools exposed to
it. They are not an OS-level sandbox and do not constrain the MCP process's
permissions under the host user's OS account. The API/data boundary is therefore
not limited to the repository: granted `pantheon-memory` tools operate on the
user's global Memory database (`~/.config/opencode/memory/memory.db` by default;
`PANTHEON_HOME` / `XDG_CONFIG_HOME` can override the root). `code_query` and
`code_neighbors` read that global database's code index. Its `code_files` table
has no project column, so results can include entities from any project
previously indexed on this machine; these grants do not provide per-project
isolation. No agent is granted `code_index`; its server-side path-confinement
guard is defense in depth, not a project-isolation boundary for query results.
Granted `pantheon-persistence` checkpoint tools can operate on the
user's global database (`~/.config/opencode/persistence/global.db` by default)
or the active project database (`.pantheon/persistence/project.db`), according
to the scopes exposed by those tools. Manual goal tools use the Persistence
deployment database and partition by session ID; a global install shares it
across projects. Grants gate calls to registered MCP operations; they do not
restrict the process's underlying OS permissions.

| Server | Recommended Tier | Rationale |
|--------|-----------------|-----------|
| pantheon-resources | `allow` | Read-only, same trust boundary as repo |
| pantheon-code-mode | `ask` | Executes scripts — needs user confirmation |
| pantheon-memory | Per-agent exact `mcp_tools` lists above | Host grants authorize only each listed tool; they are not an OS sandbox, and Memory data/index records use the user-global database |
| pantheon-persistence | per-agent exact tools | Checkpoint tools can use the user-global or project database; manual goals are session-scoped in the deployment database, shared across projects in a global install |
| pantheon-vision | `ask` | Sends image input to the configured vision gateway |

---

## Security Notes

- **pantheon-resources** — path traversal protection on `memory-bank/{path}`
- **pantheon-code-mode** — only `.sh`/`.py` in `.pantheon/code-mode/`, 30s timeout, no `../` escape
- **pantheon-memory** — SQLite data in `~/.config/opencode/memory/memory.db` by default (`PANTHEON_HOME` / `XDG_CONFIG_HOME` can override it); agent tool grants determine which tools are available
- **pantheon-persistence** — checkpoint database at `~/.config/opencode/persistence/global.db` by default; project scope uses `.pantheon/persistence/project.db`. `PANTHEON_HOME` / `XDG_CONFIG_HOME` override the global root.
- **pantheon-vision** — 25 MB image cap, supported-format validation, safe errors, and API-key redaction

See `skill: mcp-security` for complete rules.

## Unreachable by any agent

These tools are registered by the runtime sources but no bundled agent grants them. This is intentional pending a future evidence-based grant; the list is verified against the MCP decorators and agent frontmatter by `tests/agent-mcp-grants.test.mjs`.

| Server | Exposed tools with no agent grant |
|--------|-----------------------------------|
| pantheon-code-mode | `approve_code_script` |
| pantheon-memory | `code_index` |
