# Pantheon Quick Start

## What is Pantheon

A multi-agent framework for **OpenCode**. It provides 14 specialized agents,
TDD enforcement, Themis quality gates, and persistent memory MCP. The current
release is **v1.6.0-beta.1**, the first beta compatible with OpenCode 2.

## Installation

### Quick install (recommended)

```bash
# Interactive (default TTY) — component selection, progress spinners
npx pantheon-opencode init

# Headless mode — for CI and scripts
npx pantheon-opencode init --headless
```

Flags:
- `--interactive` — force interactive TUI even if piped
- `--headless` — force non-interactive (default for CI)
- `-y` / `--yes` — skip confirmations, use defaults
- `--project` — install locally in `./.opencode/`
- `--no-mcp` — skip Python/MCP setup

For MCP servers (memory, persistence) and TUI plugin:

```bash
npm run setup
```

```bash
# Verify installation
npm run doctor
```

### Prerequisites

- **Node.js 22+**
- **OpenCode v1.18.4+**
- **Python 3.11+** (optional, for MCP servers)


## Background Subagents

Pantheon dispatches agents in parallel via OpenCode's background subagent system.
To enable, set before launching OpenCode:

```bash
export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true
opencode
```

Or add to your shell profile (`~/.zshrc` or `~/.bashrc`):
```bash
echo 'export OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true' >> ~/.zshrc
```

## Highlights

- **OpenCode-only** — unified, simplified, no multi-platform fragmentation
- **Global install** — `npx pantheon-opencode init` works from any directory
- **Background subagents** — up to 5 agents in parallel
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
