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
├── Global DB: <OpenCode user config>/persistence/global.db
└── Project DB: <runtime>/.pantheon/persistence/project.db
```

Resolution precedence: explicit `--project-db`, then `PANTHEON_PROJECT`, then
the runtime target directory (the parent of the installed `scripts/` directory).
To resolve the same target as the server, inspect the `pantheon-persistence`
entry in `opencode.json`: `command[0]` is its interpreter and `cwd` anchors a
relative script argument such as `scripts/mcp_persistence.py`. An explicit
relative `--project-db` is resolved against that runtime root; when
`PANTHEON_PROJECT` is used, it must be an absolute project root and a relative
value is rejected. Without either override, the database is
`<runtime>/.pantheon/persistence/project.db` for a global install or
`<project>/.opencode/.pantheon/persistence/project.db` for a project install.
With `PANTHEON_PROJECT`, it is
`<PANTHEON_PROJECT>/.pantheon/persistence/project.db`. Migration backups live
beside the selected DB. For the runtime-default target, uninstall/reinstall may
replace that runtime target directory, so move any backup you need outside it
first.

- **Global**: dados cross-projeto (cache de agentes, preferências)
- **Project**: dados específicos do projeto atual

## Tools (6)

The server exposes exactly these six MCP tools. `scope` defaults to `"project"`;
use `"global"` for checkpoint APIs. Manual goal tools have no scope or project
argument and use the configured Persistence project DB, never `global.db`. The
SQLite KV table is internal checkpoint storage used by `context_save` and
`context_get`; its
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

### Fresh databases and existing-database migration

A new/pristine Persistence **project** database is initialized with both the KV
checkpoint schema and the manual goal schema when Persistence starts. If the
project database already contains any user schema, startup performs **no
goal-schema DDL** and does not alter its existing goal schema. The global DB is
never goal-initialized. Users who do not use the manual goal tools do nothing;
only users who want those tools on an existing project database need to run the
explicit migration. When the schema is absent, the goal tools themselves fail
closed and return the exact command
`<venv-python> <installed-script> --migrate-goals`, with global-install and
project-install command forms.

The migration target is the Persistence **project** DB only — never
`global.db`, and never the V1 goal store at `.pantheon/goals/*.json`. The V1 JSON
store is untouched and is not imported. If migration is skipped, goal tools
return a clear fail-closed error while checkpoint tools continue working; no
data is lost and no corruption is caused by leaving the goal schema absent.

To migrate an existing DB safely:

1. Stop the Persistence server and keep it stopped through both commands.
2. Read the configured `pantheon-persistence` MCP entry. Use its `command[0]`
   interpreter and resolve the script argument against `cwd`; preserve the same
   `PANTHEON_PROJECT` value, if set. An explicit `--project-db` takes precedence
   over `PANTHEON_PROJECT`, which takes precedence over the runtime target. A
   relative `--project-db` is relative to the runtime root, and
   `PANTHEON_PROJECT` must be absolute.
3. First run a dry-run and confirm its resolved path is the intended project
   DB. Add `--dry-run` to the exact command returned by the goal tools. For a
   global install the command shape is
   `<runtime>/.venv/bin/python3 <runtime>/scripts/mcp_persistence.py
   --migrate-goals --dry-run`. For a project install it is
   `<project>/.venv/bin/python3
   <project>/.opencode/scripts/mcp_persistence.py --migrate-goals --dry-run`.
   Use the actual configured interpreter from `command[0]`, and do not proceed
   if the dry-run target differs from the server's project DB.
4. After confirming the dry-run, run the same command with `--dry-run` removed.
   This is a human-run migration step; startup applies the goal schema only to a
   pristine database and never alters an existing goal schema.

The migration is idempotent. Before changing schema it makes and verifies an
adjacent, timestamped full copy of the Persistence DB (including KV data and WAL
state) with mode `0600`; an already-current schema needs no backup. Backups live
beside the selected DB. For a runtime-default target, uninstall/reinstall may
replace that directory, so move any backup you need outside it. Backup
retention is manual, so prune or move old backups yourself. If the schema is
inconsistent (for example, a migration row without its table or a table missing
an index), stop and recover from a verified backup rather than blindly
rerunning the migration. The schema downgrade helper refuses to drop populated
goal data; preserve/export goals before any external teardown.

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
