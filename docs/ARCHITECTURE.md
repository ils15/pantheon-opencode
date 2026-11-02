# Architecture

**Audience:** developers extending Pantheon and anyone who wants to know how the
pieces fit. Setup is in [Installation](INSTALLATION.md); user-facing 2.x behavior
is in [OpenCode 2.x](opencode.md).

## Agent flow

Pantheon replaces the single-agent coding loop with a conductor and
specialists.

```text
User request
    │
    ▼
  Zeus ──► Athena (plan) ──► implementation specialists ──► Themis (review)
    │                              │
    ├──► Apollo (discovery)        ├──► Hermes (backend)
    ├──► Iris (GitHub)             ├──► Aphrodite (frontend)
    ├──► Mnemosyne (memory)        ├──► Demeter (database)
    └──► Talos (hotfix)            ├──► Prometheus (infrastructure)
                                   ├──► Hephaestus (AI pipelines)
                                   ├──► Nyx (observability)
                                   └──► Gaia (remote sensing, read-only)
```

Zeus orchestrates but never implements. He routes bounded work to one
specialist and adds planning, discovery, parallel work, and review when scope
and risk call for them. `/pantheon-deepwork` is the checkpointed workflow for
heavy multi-phase work. The canonical agent files live in `src/agents/*.md`;
[Agents & Skills](agents/README.md) indexes them.

The quality gates are qualitative, not file/line thresholds: self-contained work
stays inline; one bounded specialist task goes to one agent; independent fronts
may use separate root dispatches. Themis reviews material and sensitive changes
— auth, security, data/schema, and anything that changes behavior broadly. See
[Permissions, Gates & Delegation](PERMISSIONS-QUALITY-DELEGATION.md).

## Delegation mechanics

Pantheon delegates through the host's native child-session engine. The callable
tool is `subagent` in the reported root runtime; host/API documentation calls
the same mechanism `task()`. Tool availability, background options, and
completion observability are properties of the active runtime, not of Pantheon.
The former `pantheon_delegate` tool and the V1 delegation engine were removed.

Every root dispatch carries a concise handoff brief: objective/result, bounded
scope and acceptance criteria, only the relevant inputs, constraints and safety
gates, expected deliverable and return format, and verification. Do not copy the
full conversation or unrelated history.

Return contracts are role-specific:

| Caller | Return format |
|---|---|
| Implementation agent | `## subtask_summary` with files, summary, tests, blockers |
| Investigation (`apollo`) | Structured findings: bullets, paths with line numbers, snippets ≤3 lines |
| Planner (`athena`) | The complete Markdown plan, never a summary or a pointer |
| Council specialist | `## specialist_response` |

Delegated work gets at most one retry after an initial transient failure. When
no completion/status tool is exposed, prefer synchronous dispatch or wait for a
host notification; do not assume polling, cancellation, job tracking, or
board-based recovery.

On OpenCode 2.x, the plugin additionally enforces a caller/target matrix for
Pantheon-managed `subagent` requests when the host exposes
`ctx.permission.hook`. It matches the permission source's session, message, and
tool-call ids to a short-lived record from `tool.execute.before`, then requires
the host session to have no `parentID`. Missing, stale, replayed, or mismatched
origins fail closed. If the hook is unavailable, host permissions remain in
control. The matrix itself is documented in
[Permissions, Gates & Delegation](PERMISSIONS-QUALITY-DELEGATION.md).

## What the plugin registers

2.0 removed the V1 plugin line; there is a single generation. The section below
describes the current contract (the removed V1 shape is kept as a historical
note at the end).

### The 2.x plugin

Registered under the plural `plugins` key as the `<installed>/src/plugin`
directory. `src/plugin/index.ts` re-exports the real entry at `src/plugin.ts`.
The registration path is `registerToolHooks` in `src/plugin.ts`, fed by
`createToolDefinitions` in `src/pantheon/tools.ts`.

Three unconditional tools:

- `hashline_edit` — `src/pantheon/tools.ts`
- `pantheon_cost` — `src/pantheon/tools.ts`
- `pantheon_model` — `src/pantheon/tools.ts`

Up to two host-dependent tools:

- `vision_describe` — added only when `ctx.model.list` is a function
  (`src/plugin.ts`; definition at `src/pantheon/native-vision.ts`).
- `pantheon_bounded_read` — added only when the `tool.execute.before` hook
  registered and the host exposes the permission and session APIs
  (`src/plugin.ts`; definition at `src/pantheon/bounded-read.ts`). Root Zeus
  sessions only.

The three goal tools are absent because the goal loop needs infrastructure the
2.x `PluginContext` does not expose. The gap is reported as `goal-tools`.

The plugin also wires five event subscriptions (`session.created`,
`session.idle`, `session.deleted`, `session.error`, `session.compacted`),
session hooks (`prompt`, `context`, `compaction`), a read-only-enforcing
`execute.before` hook (the same handler denies the orchestrator
`read`/`glob`/`grep` of source, tests and scripts), an `execute.after` chain
(`task-result-guard` → `context-sandbox` → `read-enhancer` → formatter +
delegation audit), and a `permission.evaluate` hook when the host exposes it.
The legacy bridge is built in the entry itself (`installBridge`), so idle
dispatch reaches the todo enforcer whenever the host's `session` domain
supports it.

### Historical note: the removed V1 generation

Until 2.0 the package also shipped a V1 plugin registered under the singular
`plugin` key (`src/plugin.ts` + `src/plugins/pantheon-hooks.ts`) with six tools
(the three above plus `pantheon_goal_create/update/get`) and the
BackgroundJobBoard lifecycle. 2.0 removed that line; its identities remain
RECOGNIZED for migration only (see
[Compatibility](COMPATIBILITY.md#config-registration-and-the-hosts-config-merge)).

## Installer and config model

Canonical sources in `src/` are read by the installer and written into the
target config. There is no runtime generation step.

- The installer writes `opencode.json`, never `opencode.jsonc`. A host may merge
  a sibling `.jsonc`; see
  [Compatibility](COMPATIBILITY.md#config-registration-and-the-hosts-config-merge).
- It strips Pantheon references from both config shapes before writing the
  current registration, so two Pantheon plugins never coexist.
- Third-party plugin and MCP entries are preserved and never converted.
- A versioned per-file ownership inventory records what the installer owns, so
  `reconcile` can find stale, unchanged installer files.

The package exposes the current contracts as importable exports:
`pantheon-opencode/plugin` (canonical since the 2.0 rename) and
`pantheon-opencode/bridge` (optional interop). `pantheon-opencode/plugin-v2`
remains as a DEPRECATED alias to `./plugin` so configs written before the
rename keep loading (removed in 2.1). The bridge passes legacy infrastructure
singletons through the host `ctx.options`; the plugin works standalone with
graceful degradation.

## Memory and context stores

Pantheon has three separate stores, documented once in [Memory](MEMORY.md):

- `pantheon-memory` — durable SQLite entries with FTS5/BM25 keyword search.
- `pantheon-persistence` — session checkpoints and manual session goals.
- `.pantheon/memory-bank/` — human-reviewed project files, read on demand.

They are not synchronized. MCP tool availability depends on the active agent's
grants; namespaces are organizational filters, not access-control boundaries.

## MCP entrypoints

Five local Python stdio servers, declared in `scripts/install-mcp.mjs:74-78`
and registered at `:196-301`:

| Server | Entrypoint |
|---|---|
| `pantheon-resources` | `scripts/mcp_resources.py` |
| `pantheon-code-mode` | `scripts/code_mode.py` |
| `pantheon-memory` | `scripts/memory_mcp.py` |
| `pantheon-persistence` | `scripts/mcp_persistence.py` |
| `pantheon-vision` | `src/mcp/pantheon_vision.py` |

The entrypoints were renamed away from the shared `*_server.py` token; the
installer heals stale paths using the mapping in
`scripts/install/config-migration.mjs:700-706`. Setup and allowlists are in
[MCP](MCP.md).

## Design principles

- **One home per fact.** The support matrix, installer mechanics, release
  process, and benchmark evidence each live in exactly one page.
- **Configuration plus a thin runtime.** Agent behavior lives in Markdown
  (`src/agents/*.md`, `src/instructions/*.instructions.md`,
  `src/skills/*/SKILL.md`); the installed plugin supplies orchestration, tools,
  and guards.
- **Fail closed on identity and permissions; fail open on presentation.** A
  malformed permission origin denies the delegation. A malformed compaction
  payload leaves the message array untouched.
