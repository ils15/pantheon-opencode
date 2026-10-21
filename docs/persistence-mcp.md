# Pantheon Persistence MCP

**Server:** `pantheon-persistence`
**Script:** `scripts/mcp_persistence.py`
**Dependencies:** `mcp==2.2.0`, standalone `fastmcp==4.0.10`, and project path
helpers; SQLite/FTS5 storage uses the Python standard library.

The installer launches `scripts/mcp_persistence.py`; it is kept byte-identical
to the canonical `src/mcp/mcp_persistence.py` and gated by
`tests/test_mcp_scripts_sync.py`. There is no `.pantheon/mcp-registry.yml` in
this checkout or installer path. The human-readable registry is
[`mcp-tools.md`](mcp-tools.md); actual tool availability comes from server
registration, while per-agent grants are derived from canonical agent
`mcp_tools` frontmatter by `scripts/install/opencode.mjs`.

The server exposes six tools for SQLite-backed session checkpoints and manual
session goals. Checkpoints support TTL-based read filtering; there is no search
tool. `pantheon-memory` is the separate FTS5-backed durable-knowledge service.

## Purpose

- **Session checkpoints** — explicitly save bounded state for later resumption
- **Execution state** — retain phase and progress details at meaningful boundaries
- **TTL** — expired checkpoint entries are filtered on reads; there is no automatic purge
- **Manual session goals** — track a session goal without automatic continuation

## Architecture

```
pantheon-persistence MCP
├── Global DB: ~/.config/opencode/persistence/global.db
└── Project DB: .pantheon/persistence/project.db
```

Resolution precedence: explicit `--project-db`, then `PANTHEON_PROJECT`, then
the runtime target directory (the parent of the installed `scripts/` directory).
An explicit relative `--project-db` is resolved against the runtime root;
when `PANTHEON_PROJECT` is used, it must be absolute and a relative value is
rejected.
Without either override, the database is
`<runtime>/.pantheon/persistence/project.db` for a global install or
`<project>/.opencode/.pantheon/persistence/project.db` for a project install.
With `PANTHEON_PROJECT`, it is `<PANTHEON_PROJECT>/.pantheon/persistence/project.db`.
Timestamped migration backups live beside the selected DB. For the runtime
default, uninstall/reinstall may replace that runtime target directory, so move
any backup you need outside it first.

- **Global**: dados cross-projeto (cache de agentes, preferências)
- **Project**: dados específicos do projeto atual

## Tools (6)

The server exposes exactly these six MCP tools. `scope` defaults to `"project"`;
use `"global"` for checkpoint APIs. Manual goal tools have no scope or project
argument and use the Persistence deployment DB. The SQLite KV table remains an
internal implementation detail used by `context_save` and `context_get`; its
former management/search tools and the former context list/statistics/rehydration
operations are not registered.

| Tool | Signature | Description / return value |
|---|---|---|
| `context_save` | `context_save(slug, key, content, session_id, ttl?, scope?, revision?)` | Saves a bounded session checkpoint and atomically updates `latest` for checkpoint keys. |
| `context_get` | `context_get(slug, key?, session_id?, legacy?, scope?)` | Reads raw context content from the session-qualified namespace, or the legacy namespace only with explicit opt-in. |
| `goal_create` | `goal_create(title, description?)` | Creates the single active manual goal for the current OpenCode session. |
| `goal_get` | `goal_get(goal_id?)` | Reads that session's active goal or, if none is active, its latest completed goal. |
| `goal_update` | `goal_update(goal_id, expected_version, title?, description?, clear_description?)` | Edits user fields with optimistic version checking; status and timestamps are server-owned. |
| `goal_done` | `goal_done(goal_id, expected_version)` | Marks the current-session goal done; repeated completion is idempotent. |

## Manual Session Goals

These four tools are a direct, manual feature of the existing
`pantheon-persistence` MCP server. They do not add a native V2 plugin proxy or
another goal database. Goals are partitioned by OpenCode session ID inside the
Persistence deployment database; in a global install, projects share this same
database. Goal operations never accept a project path, session ID, generic scope,
or global-scope selector from model tool arguments.

FastMCP 4.0.10 handlers read the current session ID from request
`Context.request_context.meta["ai.opencode/sessionID"]`. Missing, malformed, or
invalid metadata fails closed. The session ID is only a correlation/scope key,
not authentication. The supported trust boundary is OpenCode v2.0.30-mediated
local stdio. Same-user independent clients that bypass OpenCode, host bypasses,
or compromised OpenCode configuration are outside this trust model; do not
expose this server over HTTP or another network transport.

There is one active goal per session. A completed goal stays in history, and a
new goal can be created after completion. Titles and optional descriptions are
editable; use `clear_description=true` to clear a description. Status,
timestamps, and monotonically increasing version are server-owned. `goal_get`
returns the version to pass as `expected_version` to update/done; stale writes
return a conflict instructing the caller to refresh. `goal_done` cannot reopen a
goal and repeated completion is idempotent. Outputs contain only the goal ID,
editable text, status, timestamps, and version—not the session ID, database
path, or SQL.

### Goal permissions and configuration changes

The canonical agent frontmatter is the source of agent MCP grants. Zeus alone
receives `goal_create`, `goal_get`, `goal_update`, and `goal_done`; all other
agents are denied these tools. Goals are session-scoped and cannot be read across
sessions: Athena and Themis cannot read Zeus's goal from child sessions, and as
root they cannot create a goal in their own session because only Zeus receives
`goal_create`. The installer
derives exact native per-tool permissions and defaults undeclared bundled MCP
tools to deny. Run the controlled installer/init flow and restart the host to
apply changed grants, then verify the effective generated permissions; grants
are not promised to hot-reload. The generated V1 and V2 fixture configurations
are covered by installer tests. No real global configuration was changed for
this implementation.

### V1/V2 separation and migration status

`src/pantheon/goal-store.ts` remains the V1 automatic goal-loop authority and
its behavior is unchanged. These Persistence MCP goals are an independent
manual record: there is no migration/import from V1, dual-write, automatic
continuation, prompt reinjection, evaluator, loop, board, TUI/RPC integration,
or `ctx.storage` use. The V2 plugin's own goal tools remain unsupported; this
manual MCP surface is not V2 plugin parity.

The goal schema is versioned and additive. Persistence startup creates the
database file and bootstraps the existing KV schema, but performs **no
goal-table DDL**. If the goal schema is absent, other Persistence tools remain
available and goal operations fail closed until an explicit migration. Stop
the Persistence MCP server before the authoritative dry-run and keep it stopped
for the entire migration. A concurrent writer that interferes with backup or
safety verification causes the check to abort; it does not proceed on uncertain
state. Before opening SQLite, the dry-run reports the resolved DB path,
existence, size (including WAL bytes), and whether `-wal`/`-shm` sidecars exist.
If either sidecar already exists, it opens with plain read-only mode so committed
WAL state is visible. If neither exists, it uses `immutable=1` so it cannot
create sidecars beside the inspected DB, including when its directory is
read-only. If it cannot determine the goal-table state, it prints `unknown`,
exits with status 2, and says to stop and investigate; `unknown` is not a healthy
result. The dry-run also warns to stop the server for an authoritative check.

The command directory and interpreter depend on installation type. Preview a
global install with
`<runtime>/.venv/bin/python3 <runtime>/scripts/mcp_persistence.py --migrate-goals --dry-run`;
preview a project install with
`<project>/.venv/bin/python3 <project>/.opencode/scripts/mcp_persistence.py --migrate-goals --dry-run`.
Remove `--dry-run` only after human approval. The simplest reliable source of
truth for the interpreter is `command[0]` in `opencode.json` for
`pantheon-persistence`. Relative `--project-db` paths are resolved against the
runtime root; resolution precedence is explicit `--project-db`, then
`PANTHEON_PROJECT`, then the runtime target directory, never the operator's
shell cwd. The CLI cannot independently witness the server process's database
binding, so the human must confirm the target (for example, by comparing it with
the DB open in the server process) before approval. Stop the server before the
authoritative dry-run and keep it stopped for the entire migration.

Before changing schema, the command creates an adjacent, timestamped full copy
of the Persistence DB using SQLite's backup API (including WAL state and all KV
data), sets mode `0600`, flushes it, then compares it read-only with the source
before applying DDL transactionally. An already-current schema creates no
backup. Verification remains structural (SQLite integrity, page count, object
names, row counts, and schema version); content-digest verification and backup
retention automation are explicitly deferred. Until retention automation is
implemented, the operator must prune backups manually. If a migration-history
row exists but `pantheon_goals` is missing, stop the server and preserve the
current DB. A human operator should
restore a verified backup or recover the missing schema, reconcile any newer KV
writes if needed, and only then approve rerunning the migration. The tests use
synthetic temporary databases only; no real database was migrated. The schema
downgrade helper refuses to drop populated goal data; preserve/export goals
before any external teardown. An empty goal schema remains reversible.

The `tests/test_persistence_goals.py` suite requires the pinned
`fastmcp==4.0.10` and `mcp==2.2.0` runtime versions. Install those test
dependencies from `src/mcp/requirements-mcp.txt`; the suite fails with this
action when FastMCP is older rather than reporting confusing transport errors.

## Context Checkpoint Tools

Session-scoped checkpoint storage for deepwork phases, heartbeat, and reasoning state.
Session-scoped entries use `checkpoint:{slug}:{session_id}`. `session_id` is
required and is never generated or inferred from `slug`; this prevents a reused
slug from recovering another session. The legacy unqualified namespace is
available only through the explicit `legacy=true` opt-in on `context_get`.

`context_save` commits the checkpoint and its raw `latest` pointer in one SQLite
`BEGIN IMMEDIATE` transaction. Optional caller `revision` values are monotonic;
an older or equal revision returns `status: "stale"` and does not overwrite
the stored value. Without a caller revision, persistence assigns a monotonic
revision while holding the write lock. This is last-writer-wins for callers
that omit revisions; the schema has no separate CAS column and no migration is
performed.

On save, the UTF-8 encoded `content` string is limited to 65,536 bytes. An
optional `tail` may contain at most 100 strings, each at most 4,096 UTF-8 bytes,
with at most 65,536 UTF-8 bytes in aggregate across the tail strings. These
save-side bounds are validated before writing; over-limit content or tail data
is rejected with the failed limit and allowed bound. Tail entries are never
automatically truncated or dropped: shorten/remove entries or omit the optional
`tail` field when appropriate. A host or UI may wrap the tool error text, so
inspect the returned tool error for the specific limit.

`content` is a JSON-encoded string, not a raw
object: callers pass `JSON.stringify(state)`, and the decoded top level must be
an object. Inside it, `goal`, `phase`, `delegations` (with `in_flight`), and
`heartbeat` are objects and `tail` is an array — passing one of them as a bare
string is rejected as an invalid checkpoint shape. `goal` is optional: when it
is not set, omit the key rather than sending a string placeholder. Invalid JSON
or an invalid checkpoint shape fails closed. Explicit TTLs are validated as integers from 1 to 31,536,000
seconds; omitted `context_save.ttl` uses the key policy (300 seconds for
`heartbeat`, 14,400 seconds for other context keys).

### context_save
Save a context checkpoint for a session/phase.

`context_save(slug, key, content, session_id, ttl?, scope?, revision?)`
- `slug`: session identifier (e.g. "auth-refactor")
- `key`: checkpoint key (e.g. "phase:3", "latest", "heartbeat")
- `content`: JSON-serializable string (`JSON.stringify` of an object whose
  `goal`/`phase`/`delegations`/`heartbeat` values are objects and `tail` is an
  array; at most 65,536 UTF-8 bytes total; an included `tail` has at most 100
  strings, at most 4,096 UTF-8 bytes per string, and at most 65,536 UTF-8 bytes
  across all strings; omit an unset optional `goal` rather than passing a
  string)
- `session_id`: required opaque session identifier
- `ttl`: optional integer from 1 to 31,536,000 seconds; omitted values default
  to heartbeat 300s and 14,400s for latest, tail, and other context keys
- `revision`: optional positive monotonic revision for stale-write rejection
- Updates `latest` for checkpoint keys, but not operational `heartbeat`/`tail`
- Returns status, namespace, session_id, ttl, and revision
- Over-limit content/tail values are rejected, not truncated. Error details
  identify the actual value and allowed bound; shorten/remove tail entries or
  omit the optional `tail` field when it is the relevant limit

### context_get
Retrieve a context checkpoint by slug and key.

`context_get(slug, key?, session_id?, legacy?, scope?)`
- `key`: defaults to "latest" (most recent checkpoint)
- `session_id`: required for session-scoped reads
- `legacy=true`: explicit opt-in for `checkpoint:{slug}` compatibility reads
- Returns raw content string or `null` if expired/not found

## Comparison with pantheon-memory

| Aspect | persistence (this) | memory |
|--------|-------------------|--------|
| Storage | SQLite KV | SQLite + FTS5 |
| Search | Not exposed (internal SQLite KV) | FTS5 BM25 (keyword, sem stopwords) |
| TTL | ✅ Por entrada | ❌ Nenhum |
| Namespace | ✅ Coluna + scope | ✅ Coluna `namespace` |
| Dependencies | MCP SDK 2.2 + FastMCP 4 + stdlib SQLite/FTS5 | MCP SDK 2.2 + FastMCP 4 + stdlib SQLite/FTS5 |
| Tools | 6 | 9 |
