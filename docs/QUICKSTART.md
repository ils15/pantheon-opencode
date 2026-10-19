# Pantheon Quick Start

## What is Pantheon

A multi-agent framework for **OpenCode**. It provides 14 specialized agents,
TDD enforcement, Themis quality gates, and persistent memory MCP. The current
release candidate is **v1.6.0-beta.15**, compatible with OpenCode 2.

## Installation

### Quick install (recommended)

```bash
# Interactive TTY setup (Clack component/location prompts, then progress display)
npx pantheon-opencode init

# Headless mode — for CI and scripts (non-interactive apply requires --yes)
npx pantheon-opencode init --headless --yes
```

Flags:
- `--interactive` — force interactive TUI even if piped
- `--headless` — force non-interactive (default for CI)
- `-y` / `--yes` — skip confirmations, use defaults; **required for a non-interactive apply**
- `--project` — install locally in `./.opencode/`
- `--no-mcp` — skip Python/MCP setup

### Non-interactive apply requires `--yes`

Without a TTY, `init` prints the plan and **changes nothing** unless `--yes`
(alias `-y`) is passed. It never prompts and never guesses.

```bash
npx pantheon-opencode init --headless          # prints the plan, applies nothing
npx pantheon-opencode init --headless --yes    # applies
```

Exit codes:

| Code | Meaning |
|------|---------|
| `0` | success, or plan-only / declined (nothing applied) |
| `1` | failure |
| `2` | apply requested without authorization (non-interactive, no `--yes`) |
| `3` | drift detected (Phase 4) |
| `130` | canceled |

For MCP servers (memory, persistence) and TUI plugin:

```bash
npm run setup
```

```bash
# Verify installation
npm run doctor
```

### Prerequisites

- **Node.js >=26.4.0** for Pantheon's CLI, installer, and Node-based tooling
- **OpenCode v1.18.4+**
- **Python 3.11+** (optional, for MCP servers)

The package's Node floor does not imply a universal OpenCode host runtime:
official OpenCode V2.0.31 has a Bun runtime path and a separate Node build pinned
to 26.4.0; no Bun minimum is asserted. `node:sqlite` >=22.5 is a separate
optional `pantheon_cost` capability threshold, not the package support floor.


## Delegated Agents and Background Mode

OpenCode V2 documents the native `subagent` tool. Its availability depends on
the active host/runtime; check the tools exposed in the current session. A
foreground call waits for the child result. With `background: true`, the call
returns immediately, the parent is notified when the child finishes, and the
response includes a `sessionID` that can be used to continue that child. See
the [OpenCode V2 tools documentation](https://opencode.ai/v2/docs/tools).

`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` is not a universal prerequisite.
It is an experimental gate for some runtimes and is set by Pantheon's
`npm run start` launcher; use it only when the target runtime documents and
requires it. The setting does not make a missing tool available.

```bash
# Only when the active runtime documents and requires this experimental gate
export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
opencode
```

## Highlights

- **OpenCode-only** — unified, simplified, no multi-platform fragmentation
- **Global install** — `npx pantheon-opencode init` works from any directory
- **Delegation waves** — Pantheon's workflow may organize up to 5 agents per
  wave; this is an organizational policy, not an OpenCode API concurrency guarantee
- **8 slash commands** — Pantheon workflow, model, audit, vision, and goal tools
- **Themis 3-layer review** — heuristic scanner + deep review + verification planning
- **Persistent MCP memory** — SQLite FTS5 (BM25) keyword search, no embeddings

## Usage

| Command | Description |
|---------|-------------|
| `/pantheon` | Multi-perspective synthesis (Council) |
| `/pantheon-audit` | Heuristic and quality/security audit |
| `/pantheon-consolidate` | Consolidate memory as Mnemosyne |
| `/pantheon-deepwork` | Multi-phase task with persisted checkpoints |
| `/pantheon-focus` | Set a conversation-only session goal |
| `/pantheon-model` | Inspect or configure per-agent models |
| `/pantheon-optimize` | Project context optimization |
| `/pantheon-vision` | Vision configuration |

Full details: [INSTALLATION.md](INSTALLATION.md) for setup, [ARCHITECTURE.md](ARCHITECTURE.md) for system design.
