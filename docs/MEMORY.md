# Pantheon Memory

Pantheon has three separate context stores. Use the smallest one that fits:

| Store | Lifetime | Use |
|---|---|---|
| `pantheon-memory` MCP | SQLite `memory.db`; entries are capped at 64 KiB serialized by default and expire only when stored with `ttl_seconds` (expired entries are hidden from search and purged explicitly) | Reusable project facts and decisions |
| `pantheon-persistence` MCP | Separate SQLite store; session-qualified context checkpoints default to 4h (heartbeat: 5m) | Explicit checkpoints and temporary key/value data |
| `.pantheon/memory-bank/` | Project files in the working tree; Git tracking depends on repository ignore/commit policy | Human-reviewed project context and ADRs |

These stores are not automatically synchronized. In particular, compaction's
TODO preservation is process-local and does not write to `pantheon-persistence`.
The `context_*` persistence tools are optional MCP checkpoints, not automatic
compaction hooks. They are separate from durable `pantheon-memory` entries:
checkpoint namespaces include the session ID, with the defaults shown above.
See [Persistence checkpoints](#persistence-checkpoints) and
[Manual session goals](#manual-session-goals).

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
namespace when entries have a distinct owner or purpose.
Namespace is an organizational/search filter, not an access-control boundary;
searches without a namespace filter can return matches from any namespace.

Two limits keep the store from growing without bound:

- **Size.** A write is refused when the serialized entry — `value`, `metadata`,
  `namespace` and `key` as UTF-8 — exceeds the per-entry cap: 65,536 bytes
  (64 KiB) by default, the same bound the Persistence MCP applies to checkpoint
  content. Over-cap entries are rejected, never truncated, because a shortened
  memory is silent data loss; the error states the actual size, the cap, and the
  environment variable that raises it. Set
  `PANTHEON_MEMORY_MAX_ENTRY_BYTES=<bytes>` in the memory server's environment
  to change the cap (read per write; any positive integer, and an invalid value
  falls back to 64 KiB).
  `memory_stats` reports `total_bytes`, `max_entry_bytes`,
  `warning_threshold_bytes` (half the cap, minimum 1 byte),
  `oversized_entries` (entries over that threshold) and up to
  five `largest_entries` with namespace, key and bytes.
- **Expiry.** `memory_store(ttl_seconds=...)` gives an entry a lifetime
  (1 second to 365 days). Entries stored without it never expire, which is how
  every older entry behaves. `memory_search` hides expired entries by default
  (`include_expired=True` shows them); `memory_recall` still returns an expired
  entry by exact key, because `None` would be indistinguishable from an entry
  that never existed. `memory_list`, the maintenance view, also still shows
  expired rows. Nothing deletes an expired row implicitly:
  `memory_forget(expired_only=True)` is the explicit purge and reports how many
  rows it removed. `decay_days` only changes search ranking; it does not expire
  data.

Opening an existing database adds the `expires_at` column automatically when it
is missing; the `ALTER TABLE` is guarded by a column check, so a second open is a
no-op and existing rows keep working (NULL means "never expires").

| Tool | Use |
|---|---|
| `memory_search(query, namespace?, top_k?, decay_days?, include_expired?)` | Find relevant entries; use `top_k=2` for task context; expired entries are hidden unless `include_expired=True` |
| `memory_recall(key, namespace?)` | Fetch an entry when its exact key is already known (ignores expiry) |
| `memory_store(value, namespace?, key?, metadata?, ttl_seconds?)` | Store a concise, reusable fact or decision; `ttl_seconds` makes it expire |
| `memory_forget(id?, key?, namespace?, expired_only?)` | Remove an entry by ID or key, or purge every expired entry with `expired_only=True` |
| `memory_list(namespace?, prefix?, limit?)` | Inspect entries during explicit maintenance |
| `memory_stats()` | Inspect counts, disk usage, payload bytes and the largest entries during explicit maintenance |

`metadata` must be a JSON object encoded as a string, for example:
`metadata='{"type":"decision"}'`. A key is unique within its namespace;
duplicate keys fail rather than silently replacing the old entry.

The installed source also exposes the optional `code_index`, `code_query`, and
`code_neighbors` codemap tools. The installer uses `src/mcp/memory_mcp.py` as
the canonical runtime source; the standalone `scripts/memory_mcp.py` copy is
intentionally lighter. Keep their differences deliberate.

## Ambient injection on V2 (opt-in, default off)

On its own, this store is pull-only: an entry is recalled only when the agent
decides to call `memory_search`. The OpenCode V2 plugin has a per-request
`context` hook, so an install can have the top entries ride along instead. It is
opt-in and **default `false`** — nothing changes until it is enabled in the V2
plugin options:

```json
{
  "plugins": [
    { "package": "<installed>/src/plugin-v2", "options": { "memory_injection": { "enabled": true } } }
  ]
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Opt in. Disabled means the hook's `system` output is byte-identical to the policy-only output |
| `maxEntries` | `3` | Entries per payload (1–10) |
| `maxChars` | `1200` | Total character budget for the injected part (100–8000) |
| `namespace` | unset | Namespace filter. Unset means no filter, exactly like `memory_search(query)` without `namespace`; `"default"` narrows to the storage default |

How it reads: `$PANTHEON_HOME/memory/memory.db` (`PANTHEON_HOME` →
`$XDG_CONFIG_HOME/opencode` → `~/.config/opencode`) with `node:sqlite` in
read-only mode. It writes no row and migrates nothing, and it does not open a
second writer against the MCP server's store; the only filesystem effect is the
`-shm`/`-wal` index sidecars SQLite itself creates for a read-only WAL
connection.

What it selects: entries ranked by FTS5 BM25 for the session's FIRST user
message, using the same terms/stopwords/prefix rules as `memory_search`. Terms
are quoted with embedded quotes doubled, so a prompt cannot inject query syntax.
Expired entries are excluded; a store written before TTL support (no
`expires_at` column) is read without that filter instead of being rejected. The
budget is split evenly between the entries, so one long memory cannot starve the
others, and a shortened entry ends with `…[truncated]`.

Once per session: the payload is computed on the first request, cached
(64 sessions), and re-added verbatim on later requests. The
`<!-- pantheon-memory-context:v1 -->` marker keeps a second pass from
duplicating it, so the system prompt does not grow per request.

Fail-open: no `node:sqlite` in the runtime, a missing or unreadable database, an
unexpected schema, no user message, no searchable term, or an empty result all
mean "no injection" — never an error in the session. A broken store logs one
line per session in `hooks.log`, and so does the one case that used to be
invisible: the feature is enabled but the host sent no usable `system` array, so
there is nothing to inject into (`skip=no-system`). An invalid
`memory_injection` block is reported once per process, naming the ignored keys
and the accepted ones, while the defaults apply.

What that line may contain: for `skip=error` it carries only a stable
classification (`code=ERR_SQLITE_ERROR`), never the message body — an FTS error
echoes the failing statement, and that statement carries the `MATCH` expression
built from your first message. Set `PANTHEON_MEMORY_INJECTION_DEBUG=1` to append
the raw message when debugging locally; that is off by default because it can
copy memory text and prompt fragments into the log file.

Injection adds context, not authority: entries are data the model may read, and
an injected entry never grants a permission.

## Persistence checkpoints

The `pantheon-persistence` MCP server exposes exactly six tools:
`context_save`, `context_get`, `goal_create`, `goal_get`, `goal_update`, and
`goal_done`. The KV table is internal checkpoint storage; the former KV
management/search and context list/statistics/rehydration/summary operations are
not registered.

| Tool | Signature | Use |
|---|---|---|
| `context_save` | `context_save(slug, key, content, session_id, ttl?, scope?, revision?)` | Save a bounded session checkpoint and atomically update `latest` |
| `context_get` | `context_get(slug, key?, session_id?, legacy?, scope?)` | Read a session-qualified checkpoint; `key` defaults to `latest` |
| `goal_create` | `goal_create(title, description?)` | Create the single active manual goal for the session |
| `goal_get` | `goal_get(goal_id?)` | Read the active goal, or the latest completed one |
| `goal_update` | `goal_update(goal_id, expected_version, title?, description?, clear_description?)` | Edit user fields with optimistic version checking |
| `goal_done` | `goal_done(goal_id, expected_version)` | Mark the goal done; repeated completion is idempotent |

`scope` defaults to `"project"`; use `"global"` for checkpoint APIs. Checkpoints
use the namespace `checkpoint:{slug}:{session_id}`. `session_id` is required and
is never generated or inferred from `slug`; the legacy unqualified namespace is
available only through `legacy=true` on `context_get`.

`context_save` commits the checkpoint and its raw `latest` pointer in one SQLite
`BEGIN IMMEDIATE` transaction. Caller `revision` values are monotonic; an older
or equal revision returns `status: "stale"` without overwriting. Without a
caller revision, persistence assigns a monotonic revision under the write lock.

`content` is a JSON-encoded string, not a raw object: callers pass
`JSON.stringify(state)`. The decoded top level must be an object; inside it,
`goal`, `phase`, `delegations` (with `in_flight`), and `heartbeat` are objects
and `tail` is an array. `goal` is optional — omit it rather than sending a
placeholder. Invalid JSON or shape fails closed. Save-side bounds are:

- `content`: at most 65,536 UTF-8 bytes.
- `tail`: at most 100 strings, each at most 4,096 UTF-8 bytes, at most 65,536
  UTF-8 bytes in aggregate.
- `ttl`: an integer from 1 to 31,536,000 seconds. Omitted values default to 300
  seconds for `heartbeat` and 14,400 seconds for other context keys.

Over-limit data is rejected, not truncated; shorten it or omit the optional
`tail`.

## Manual session goals

The four `goal_*` tools are a direct, manual feature of the Persistence MCP;
they do not add a V2 plugin proxy or another goal database. Canonical agent
frontmatter grants them only to Zeus. All other agents are denied.

Goals are partitioned by OpenCode session id inside the Persistence deployment
database; in a global install, projects share that database. FastMCP 4.0.10
handlers read the session id from
`Context.request_context.meta["ai.opencode/sessionID"]`. Missing, malformed, or
invalid metadata fails closed. The session id is a correlation/scope key, not
authentication. The supported trust boundary is OpenCode 2.x-mediated local
stdio (measured on 2.0.30); do not expose the server over HTTP or another
network transport.

There is one active goal per session. A completed goal stays in history and a
new one can be created after completion. Status, timestamps, and a monotonically
increasing version are server-owned. Pass the version from `goal_get` as
`expected_version`; a stale write returns a conflict. `goal_done` cannot reopen a
goal, and repeated completion is idempotent. Outputs contain only the goal id,
editable text, status, timestamps, and version — not the session id, database
path, or SQL.

These are manual records only. They do not migrate or replace the V1
`src/pantheon/goal-store.ts` authority, write to it, or trigger continuation,
reinjection, an evaluator, loop, board, TUI/RPC, or `ctx.storage`. The V1 JSON
store at `.pantheon/goals/*.json` is untouched and not imported. The V2 plugin's
own goal tools remain unsupported.

A pristine Persistence **project** database is initialized with both the
checkpoint and goal schemas. If the project database already contains user
schema, startup performs no goal-schema DDL. Users who do not use the goal tools
need do nothing; only users who want them on an existing project database need
the explicit, human-run migration. When the schema is absent, the goal tools
fail closed and return the exact command
`<venv-python> <installed-script> --migrate-goals`. Skipping migration leaves
checkpoint tools working and goal tools unavailable, without data loss.

The migration target is the Persistence **project** database only — never
`global.db`, and never the V1 goal store. Before changing schema it makes and
verifies an adjacent, timestamped full copy with mode `0600`; an already-current
schema needs no backup. To migrate safely:

1. Stop the Persistence server and keep it stopped.
2. Read the configured `pantheon-persistence` MCP entry. Use its `command[0]`
   interpreter and resolve the script against `cwd`; preserve `PANTHEON_PROJECT`
   if set. An explicit `--project-db` takes precedence over `PANTHEON_PROJECT`,
   which takes precedence over the runtime target.
3. Run the returned command with `--migrate-goals --dry-run` and confirm the
   resolved path is the intended project database.
4. Run the same command without `--dry-run`.

The migration is idempotent. If the schema is inconsistent (for example, a
migration row without its table, or a table missing an index), stop and recover
from a verified backup rather than rerunning blindly. Backups live beside the
selected database; a runtime-default directory may be replaced by
uninstall/reinstall, so move backups you need outside it. Retention is manual.

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

For the full tool catalog, see [MCP tools](mcp-tools.md). MCP server setup and
allowlists are in [MCP](MCP.md).
