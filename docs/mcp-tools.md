# MCP Tool Registry

Canonical reference for Pantheon agents. Lists every tool across the 5 native MCP servers, with signatures, descriptions, and which agents use them.

> **Agent tip:** OpenCode exposes an MCP tool as `{server}_{tool}`. See
> [Naming in OpenCode](#naming-in-opencode) below.

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
[`src/mcp/memory_mcp.py`](https://github.com/ils15/pantheon-opencode/blob/main/src/mcp/memory_mcp.py), registers **9 tools**: 6 `memory_*` tools for storing,
searching, recalling, forgetting, listing, and inspecting entries, plus 3
`code_*` codemap operations. `scripts/memory_mcp.py` is a compatibility
entrypoint that delegates to this canonical implementation. The runtime
installer copies the canonical source into the installed scripts directory;
`install-mcp.mjs` prefers that installed script and falls back to the source-tree
entrypoint when running from a checkout. Keyword retrieval only — no embedding
or vector index. The Memory server registers no resources.

| Tool | Signature | Description | Who uses it |
|------|-----------|-------------|-------------|
| `memory_store` | `(value, namespace?: "default", key?, metadata?: "{}", ttl_seconds?)` | Store a reusable memory entry (FTS5 index updated by trigger); `metadata` is a JSON string. Over-cap writes are rejected, never truncated (see [entry cap and expiry](#entry-cap-expiry-and-purge-contract)). `ttl_seconds` gives the entry a lifetime; on success returns `{id, namespace, key, status, expires_at}`, where `expires_at` is `null` when the entry does not expire | Mnemosyne when durable context is warranted and write access is granted |
| `memory_search` | `(query, namespace?, top_k?: 5, decay_days?, include_expired?: false)` | FTS5 BM25 keyword search (stopwords dropped, 4+ char terms prefix-matched); `top_k` is clamped to 1–50. Expired entries are filtered in SQL before `LIMIT`, so they cannot consume a candidate slot; `include_expired=true` opts back in. Optional freshness decay via `decay_days` (default off) only re-ranks, it does not expire. Empty results mean nothing matched; structured errors mean the memory store could not be read. | Coordinator or specialist only when prior project context is relevant |
| `memory_recall` | `(key, namespace?: "default")` | Exact recall of an entry by key within a namespace, including `expires_at`. Expiry is ignored on purpose: an expired entry is still returned (see [entry cap and expiry](#entry-cap-expiry-and-purge-contract)) | Exact-key lookup when needed |
| `memory_forget` | `(id?, key?, namespace?: "default", expired_only?: false)` | Delete an entry by ID or key (FTS index cleaned via trigger), or purge every expired entry with `expired_only=true` — the only path that removes expired rows. Returns `{deleted, purged, expired_only}` on the purge path; not combinable with `id`/`key` | Mnemosyne only — expiry purge is explicit maintenance |
| `memory_list` | `(namespace?, prefix?, limit?: 50)` | List entries chronologically with namespace and key-prefix filters; `limit` is clamped to 1–500. Still lists expired entries, because this maintenance view is how they are inspected before purging | Mnemosyne — explicit maintenance |
| `memory_stats` | `()` | Database statistics: `total_entries`, `namespaces`, `db_size_bytes`, `db_size_human`, plus payload-size accounting — `max_entry_bytes` (cap in force), `warning_threshold_bytes` (half the cap, minimum 1 byte), `total_bytes` (summed serialized entry bytes), `oversized_entries` (count above the warning threshold) and `largest_entries` (up to 5 `{namespace, key, bytes}`) | Mnemosyne — explicit maintenance |
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

### Entry cap, expiry and purge contract

**Size.** A write is rejected when the serialized entry — `value`, `metadata`,
`namespace` and `key` as UTF-8 — exceeds the per-entry cap: 65,536 bytes
(64 KiB) by default, the same bound the Persistence MCP applies to checkpoint
content. Set `PANTHEON_MEMORY_MAX_ENTRY_BYTES` in the memory server's
environment to change the cap; it is read on every write, accepts any positive
integer, and an unparseable or non-positive value falls back to 64 KiB. An
over-cap write is rejected, never truncated — a shortened memory is silent data
loss — and the error states the actual size, the cap in force, and that
variable with an actionable value. The per-entry size behind `memory_stats`
(`total_bytes` and `largest_entries[].bytes`) is measured the same way, so
`oversized_entries` and the write guard agree.

**Expiry.** `memory_store(ttl_seconds=...)` accepts 1 to 31,536,000 seconds
(365 days) and stores an ISO-8601 UTC `expires_at`. Omitting it stores `NULL`,
meaning "never expires" — which is how every entry written before TTL support
behaves. An entry is expired when `expires_at` is non-null and at or before the
current UTC time.

**What expiry changes.** `memory_search` excludes expired entries by default and
filters them in SQL before `LIMIT`, so an expired row cannot consume one of the
candidate slots; `include_expired=true` returns them. `memory_recall` and
`memory_list` still expose expired entries: `null` is already the answer for a
key that does not exist, so hiding an expired entry from exact recall would make
"expired" indistinguishable from "never existed", and the maintenance listing is
how an operator inspects them before purging. `decay_days` is unrelated to
expiry — it only multiplies BM25 scores by a freshness factor.

**Explicit purge.** No read deletes a row. `memory_forget(expired_only=true)`
deletes every entry whose `expires_at` has passed, across all namespaces,
returns `{deleted, purged, expired_only}`, is idempotent (`purged: 0` once
drained), cannot be combined with `id`/`key`, and never touches entries with a
`NULL` expiry.

**Older databases.** A `memory.db` created before TTL support is upgraded on
open: the server checks `PRAGMA table_info(memories)` and runs
`ALTER TABLE memories ADD COLUMN expires_at TEXT` only when the column is
missing, then creates its index with `IF NOT EXISTS`. A second open is a no-op,
no row is rewritten or dropped, and no migration command is required from the
user.

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
[Memory](MEMORY.md#manual-session-goals) for details.

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
| `pantheon_cost` | `days?: 1..365` (default `7`), `session?: <root session id>`, `refreshPricing?: boolean` | Read-only token totals and USD cost by agent and phase, by model, and by session, in a rolling `days × 24-hour` window from query time. It is not a calendar-day or session window. |

Prices come from the public `models.dev` catalog (USD per 1M tokens: input,
output, cache read and cache write), cached at
`<configDir>/cache/models-dev.json`, where `<configDir>` follows the usual
resolution — `PANTHEON_HOME`, else `$XDG_CONFIG_HOME/opencode`, else
`~/.config/opencode`. A tool call reads that cache and never waits on the
network: a missing or older-than-24 h cache is refreshed in the background with a
3 s timeout and the report says the prices it used are stale. Only
`refreshPricing: true` waits for that bounded refresh, and it is how new prices
are forced. `PANTHEON_COST_OFFLINE=1` forbids every network request on every
path: the lazy background refresh is not scheduled, and `refreshPricing: true`
is refused outright — the report then says `Pricing: REFUSED`, names this
variable, and makes no request at all. An unknown or
ambiguous model, or cache tokens with no published cache rate, read `—` and are
excluded from the total, which then says `(partial)` — a model the catalog prices
at zero stays `$0.00`, because an unknown model is never reported as free.
Passing `session` scopes the whole report to that root session plus its
descendant sessions, resolved through the `parent_id` links already in the
database. Costs are catalog list prices, not a provider invoice; on V2 the phase
can be `unknown`; and the `node:sqlite` CLI-fallback path still reports tokens
only, with the report saying so.

### Cost backend and attribution

`pantheon_cost` prefers a read-only `node:sqlite` connection to the selected
`opencode.db` ([`src/pantheon/cost-command.ts`](https://github.com/ils15/pantheon-opencode/blob/main/src/pantheon/cost-command.ts)). When `node:sqlite` is
unavailable in the host runtime — for example under Bun — the tool falls back to
spawning `node scripts/cost.mjs` as a read-only subprocess. The fallback
resolves a real Node binary, `PANTHEON_NODE` first and then `node` on `PATH`,
verifies that it supports `node:sqlite` (Node >= 22.5), and runs the script with
an argument array, never through a shell. If neither source resolves, the tool
returns `status: UNSUPPORTED`. Database failures return a contract status such
as `UNAVAILABLE` or `CORRUPT_DATA` and include diagnostic detail, including
captured stderr when available.

| Variable | Default | Purpose |
|---|---|---|
| `PANTHEON_NODE` | `node` from `PATH` | Node >= 22.5 binary used only for the `node:sqlite` capability in the CLI fallback. An explicit path must exist and be executable, otherwise the tool fails fast |
| `PANTHEON_COST_OFFLINE` | unset | Set to `1` to forbid every network request, including `refreshPricing: true`. The report uses the cached catalog only, an explicit refresh is refused with a `Pricing: REFUSED` notice naming this variable, and no socket is opened |
| `PANTHEON_COST_DB` | unset | Absolute path to the database, checked before `OPENCODE_DB` |
| `OPENCODE_DB` | unset | Absolute path to the database, checked before the XDG default |

The database is resolved by path in this order: an explicit `dbPath` from the
tool caller, `PANTHEON_COST_DB`, `OPENCODE_DB`, then the XDG default
`opencode.db`. There is no per-version filename in that chain: `opencode-v2.db`
is not a host 2.x database — it is a name a sandbox gives its own state
database through `OPENCODE_DB`.

The v1/v2 distinction is the **detected schema**, not the file name. The report
looks for the `message` and `session_message` tables and reads whichever the
open database actually holds, because a migrated database carries both families
at once. `PANTHEON_OPENCODE_VERSION=v1|v2` selects no file: it only narrows an
already-detected set to one table family, and fails fast when the value is
invalid or the requested family is not there. A database carrying neither table
returns `CORRUPT_DATA`; a ledger that exists but yields no readable tokens
returns `UNSUPPORTED`, never a successful empty report.

The report always includes `## Cost by agent` and adds `## Cost by model` and
`## Cost by session` tables. A session row covers that session alone; passing
`session:<id>` sums the root session and its descendants. An unpriced row reads
`—` and is excluded from the total, which then says `(partial)`.

---

## Naming in OpenCode

Pantheon runs only on OpenCode, which exposes an MCP tool as
`{server}_{tool}` — for example `pantheon-memory_memory_recall`. The older
multi-platform naming examples were removed with multi-platform support in
v1.0.

> **In the Code Mode `execute` sandbox the visible catalog is a subset, not the
> registry above.** Resolve a hidden tool by calling `search()` for its exact path
> and then invoking that path **literally** — passing the whole path string as a
> single key fails even though `search()` returned it.

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
