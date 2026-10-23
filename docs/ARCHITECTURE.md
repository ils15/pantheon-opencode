# Architecture

**Audience:** developers extending Pantheon and anyone who wants to know how the
pieces fit. Setup is in [Installation](INSTALLATION.md); user-facing V2 behavior
is in [OpenCode V2](opencode-v2.md).

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

On OpenCode V2, the plugin additionally enforces a caller/target matrix for
Pantheon-managed `subagent` requests when the host exposes
`ctx.permission.hook`. It matches the permission source's session, message, and
tool-call ids to a short-lived record from `tool.execute.before`, then requires
the host session to have no `parentID`. Missing, stale, replayed, or mismatched
origins fail closed. If the hook is unavailable, host permissions remain in
control. The matrix itself is documented in
[Permissions, Gates & Delegation](PERMISSIONS-QUALITY-DELEGATION.md).

## What each generation registers

The two plugin generations are exclusive. Each installation registers exactly
one of them.

### V1

Registered under the singular `plugin` key as `src/plugin.ts` plus
`src/plugins/pantheon-hooks.ts`. The tool map is declared in
`src/plugin.ts:409-421`:

- `hashline_edit`
- `pantheon_goal_create`
- `pantheon_goal_update`
- `pantheon_goal_get`
- `pantheon_cost`
- `pantheon_model`

Six tools. V1 also registers the BackgroundJobBoard lifecycle, V1 event/tool
hooks, and the V1 compaction path.

### V2

Registered under the plural `plugins` key as the `<installed>/src/plugin-v2`
directory. `src/plugin-v2/index.ts` re-exports the real entry at
`src/plugin-v2.ts`. The registration path is `registerV2Tools` in
`src/plugin-v2.ts:476-519`, fed by `createV2ToolDefinitions` in
`src/pantheon/v2-tools.ts:437-480`.

Three unconditional tools:

- `hashline_edit` — `src/pantheon/v2-tools.ts:440`
- `pantheon_cost` — `src/pantheon/v2-tools.ts:452`
- `pantheon_model` — `src/pantheon/v2-tools.ts:466`

Up to two host-dependent tools:

- `vision_describe` — added only when `ctx.model.list` is a function
  (`src/plugin-v2.ts:492-495`; definition at `src/pantheon/v2-vision.ts:532`).
- `pantheon_bounded_read` — added only when the `tool.execute.before` hook
  registered and the host exposes the permission and session APIs
  (`src/plugin-v2.ts:1846-1852`; definition at
  `src/pantheon/v2-bounded-read.ts:451`). Root Zeus sessions only.

The three goal tools are absent from V2 because the goal loop needs V1
infrastructure the V2 `PluginContext` does not expose. The gap is reported as
`goal-tools`.

V2 also wires five event subscriptions (`session.created`, `session.idle`,
`session.deleted`, `session.error`, `session.compacted`), session hooks
(`prompt`, `context`, `compaction`), a read-only-enforcing `execute.before`
hook, an `execute.after` chain (`task-result-guard` → `context-sandbox` →
`read-enhancer`), and a `permission.evaluate` hook when the host exposes it.

## Installer and config model

Canonical sources in `src/` are read by the installer and written into the
target config. There is no runtime generation step.

- The installer writes `opencode.json`, never `opencode.jsonc`. A host may merge
  a sibling `.jsonc`; see
  [Compatibility](COMPATIBILITY.md#config-registration-and-the-hosts-config-merge).
- It strips Pantheon references from both config shapes before writing the
  selected generation, so a V1 and a V2 Pantheon plugin never coexist.
- Third-party plugin and MCP entries are preserved and never converted.
- A versioned per-file ownership inventory records what the installer owns, so
  `reconcile` can find stale, unchanged installer files.

The package exposes both contracts as importable exports:
`pantheon-opencode/plugin` (V1), `pantheon-opencode/plugin-v2` (V2), and
`pantheon-opencode/v2-bridge` (optional interop). The bridge passes V1
infrastructure singletons through V2 `ctx.options`; V2 works standalone with
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
