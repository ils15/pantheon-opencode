# Per-Agent MCP Reference

How each Pantheon agent uses the 5 built-in MCP servers (including
pantheon-persistence and pantheon-vision) plus the optional third-party servers.

---

## Native Per-Agent Allowlist

The installer reads `mcp_tools` from each canonical file in `src/agents/` and
generates native per-agent permissions for OpenCode V1 and V2. For each
Pantheon MCP server it denies the wildcard first, then allows the declared
tools. Undeclared Pantheon servers default to deny; unrelated user MCP servers
are untouched. In V2, per-agent rules hide tools from that agent without
disconnecting the MCP server.

| Agent | Resources | Code-mode | Memory | Persistence | Vision |
|-------|-----------|-----------|--------|-------------|--------|
| **zeus** | all | — | search | save/get checkpoint | — |
| **athena** | all | — | search | — | — |
| **apollo** | all | — | search | — | — |
| **hermes** | all | execute script | search | — | — |
| **aphrodite** | all | execute script | search | — | describe/OCR/analyze |
| **demeter** | all | execute script | search | — | — |
| **themis** | all | execute script | search | — | — |
| **prometheus** | all | execute script | search | — | — |
| **hephaestus** | all | execute script | search | — | — |
| **nyx** | all | execute script | search | — | — |
| **gaia** | all | — | recall | — | describe/OCR/analyze |
| **iris** | all | — | recall | — | — |
| **mnemosyne** | all | execute script | explicit memory tools | — | — |
| **talos** | all | execute script | recall | — | — |

`pantheon-vision` remains connected for the host but is available only to agents
that handle image workflows. Checkpoints are limited to `context_save` and
`context_get` on Zeus; native compaction remains OpenCode's context-pressure
path.

---

## pantheon-resources Usage by Agent

| Agent | Resources Used | When | Purpose |
|-------|---------------|------|---------|
| **zeus** | `pantheon://routing`, `pantheon://deepwork/{slug}`, `pantheon://agents` | Orchestration | Read routing rules, check deepwork plan/status |
| **athena** | `pantheon://routing`, `pantheon://agents`, `pantheon://skills/{name}` | Planning | Understand delegation rules, load agent roles |
| **apollo** | `pantheon://agents`, `pantheon://skills` | Discovery | Identify agents to search for, load domain skills |
| **hermes** | `pantheon://agents`, `pantheon://skills` | Implementation | Read backend skill instructions |
| **aphrodite** | `pantheon://memory-bank/{path}` | Frontend work | Read memory bank for architecture context |
| **demeter** | `pantheon://agents`, `pantheon://routing` | Database work | Understand delegation flow for handoffs |
| **themis** | `pantheon://agents` | Review | Verify agent capabilities match reviewed code |
| **prometheus** | `pantheon://agents`, `pantheon://routing` | Infrastructure | Check deployment routing constraints |
| **hephaestus** | `pantheon://agents`, `pantheon://skills` | AI pipelines | Load RAG pipeline skill instructions |
| **nyx** | `pantheon://routing` | Monitoring | Read routing rules for anomaly detection |
| **gaia** | `pantheon://agents` | Remote sensing | Verify agent capabilities |
| **iris** | `pantheon://agents` | GitHub ops | Reference agent names for PR/issue |
| **mnemosyne** | `pantheon://memory-bank/{path}` | Documentation | Read and write memory bank files |
| **talos** | `pantheon://agents`, `pantheon://skills` | Hotfixes | Quick reference to agent files |

---

## pantheon-code-mode Usage by Agent

| Agent | Use Case | When |
|-------|----------|------|
| **zeus** | — | Delegates script work to an implementation agent |
| **athena** | — | Planning and research |
| **apollo** | — | Read-only discovery |
| **hermes** | Run `pytest`, `ruff check`, `ruff format` | After implementation, before handoff to Themis |
| **aphrodite** | Run `npm test`, `biome check` | After implementation, before handoff |
| **demeter** | Run `pytest` on migration tests | After migration implementation |
| **themis** | Run lint/quality check scripts during review | Code review phase |
| **prometheus** | Deploy scripts, Docker builds, CI triggers | Infrastructure phase |
| **hephaestus** | Run evaluation scripts for AI pipelines | Post-implementation |
| **nyx** | Run observability scripts | Monitoring work |
| **mnemosyne** | Run approved memory scripts | Explicit memory tasks |
| **talos** | Automated hotfix sequences, batch fixes | Rapid repair |

Agents not listed (**gaia**, **iris**) do not receive `pantheon-code-mode`
tools from the installed per-agent configuration.

---

## pantheon-memory Usage by Agent

Memory is opportunistic, not a per-agent startup checklist. Zeus searches once
only when prior project context could change the task, then passes useful hits
to the selected specialist. A specialist searches separately only when no
relevant result was handed off and historical context is needed. Zeus stores at
most one concise, reusable top-level outcome; routine child results and phase
updates are not persisted. Mnemosyne handles explicit memory maintenance.

For actual signatures and the separation between durable memory, TTL KV, and
session checkpoints, see [Memory](MEMORY.md) and [Persistence MCP](persistence-mcp.md).

---

## Third-Party MCP Usage

### context7 (Library Documentation)

Used by **11 agents** for up-to-date library docs:

| Agent | Libraries |
|-------|-----------|
| **hermes** | FastAPI, Pydantic, SQLAlchemy |
| **aphrodite** | React, Next.js, Tailwind |
| **demeter** | SQLAlchemy, Alembic |
| **hephaestus** | LangChain, LangGraph |
| **themis** | Pydantic, FastAPI (security review context) |
| **athena** | General (any framework during planning) |
| **prometheus** | Docker, Docker Compose |
| **gaia** | Scientific Python (rasterio, xarray, numpy) |
| **nyx** | OpenTelemetry |
| **apollo** | General (any library during discovery) |
| **zeus** | General (any library during orchestration) |

> **Note:** Exa MCP was removed in v3.15.0. Use the built-in `websearch` tool instead.

### playwright (Browser Automation)

Used by **3 agents**:

| Agent | Use Case |
|-------|----------|
| **aphrodite** | Visual review pipeline — screenshots, accessibility snapshots |
| **themis** | Visual regression checking during review |
| **hermes** | API response verification via browser (edge cases) |

---

## Source Metadata

Each canonical agent file declares Pantheon tool access in `mcp_tools`:

```yaml
mcp_tools:
  pantheon-resources: all
  pantheon-memory: [memory_search]
  pantheon-persistence: [context_save, context_get]
```

### Rules

- `all` allows every tool from that named Pantheon server.
- A list allows only those tool names; an empty list denies every tool there.
- A server omitted from an agent's metadata is denied for that agent.
- These rules are generated into V1 `permission` objects and V2 `permissions` arrays.
- V1 `permission.task` rules are translated to V2's native `subagent` action.
- Third-party MCP permissions remain the user's configuration.

---

## Security Notes

| Server | Risk Level | Notes |
|--------|-----------|-------|
| **pantheon-resources** | Low | Read-only. Same trust boundary as repository |
| **pantheon-code-mode** | Medium | Executes scripts. Permission: `ask` (user confirms each execution) |
| **pantheon-memory** | Low | Read/write within agent sandbox. No system access |
| **pantheon-persistence** | Low | Namespaced local SQLite KV with FTS5 and TTL |
| **pantheon-vision** | Medium | Sends image data or URLs to the configured OpenCode vision gateway; permission: `ask` |
| **context7** | Low | Read-only library documentation. No auth needed |
| ~~exa~~ | *Removed in v3.15.0* | Use `websearch` tool instead |
| **playwright** | Medium | Runs headless Chromium. Permission: `ask` recommended |

See `skill: mcp-security` for complete MCP security rules.
