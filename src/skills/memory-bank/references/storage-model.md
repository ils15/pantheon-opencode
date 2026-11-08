# Memory Bank — Storage Model

Detail companion for `SKILL.md`. Read on demand when you need where a memory
system physically stores data, who owns it, or its lifetime. Golden rules,
who-writes-what, and maintenance policy stay in `SKILL.md`.

---

## Actual Storage Model

| System | Where | Owner | Lifetime | Purpose |
|--------|-------|-------|----------|---------|
| **Durable Memory** | `pantheon-memory` MCP (SQLite `memory.db`) | Agents with the relevant tool grant | No entry TTL; retained until explicitly forgotten | Reusable facts and decisions |
| **Persistence** | `pantheon-persistence` MCP | Agents with the relevant tool grant | Optional, separate checkpoint/KV store; checkpoint TTLs apply | Explicit session/workflow checkpoints and temporary state |
| **Memory Bank** | `.pantheon/memory-bank/` | Team | Files persist in the working tree; Git tracking depends on repository ignore/commit policy | Project context: architecture, patterns, progress, ADRs |

Pantheon does not implement `/memories/repo/` or `/memories/session/` stores.
Memory Bank files are read explicitly or on demand through
`pantheon://memory-bank/{path}` from `pantheon-resources`; they are not
auto-loaded. Memory namespaces are organizational filters, not access-control
boundaries, and tools are available only when the active agent is granted them.
