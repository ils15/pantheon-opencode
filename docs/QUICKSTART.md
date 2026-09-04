# Pantheon Quick Start

## What is Pantheon

A multi-agent framework for **OpenCode**. It provides 14 specialized agents,
TDD enforcement, Themis quality gates, and persistent memory MCP. The current
release is **v1.4.3**.

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

- **Node.js 18+**
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
- **7 commands** — all start with `/pantheon-`
- **Themis 3-layer review** — heuristic scanner + deep review + verification planning
- **Persistent MCP memory** — sqlite-vec + fastembed

## Usage

| Command | Description |
|---------|-------------|
| `/pantheon` | Multi-perspective synthesis (Council) via inline agents |
| `/pantheon-audit` | Code review + security audit |
| `/pantheon-bg` | List background tasks |
| `/pantheon-consolidate` | Consolidate memory |
| `/pantheon-deepwork` | Heavy multi-phase task with persisted checkpoints |
| `/pantheon-doc` | Generate documentation |
| `/pantheon-focus` | Pin a session goal |
| `/pantheon-forget` | Compress/consolidate memories |
| `/pantheon-hash` | Hash edit verification |
| `/pantheon-optimize` | Context optimization & token audit |
| `/pantheon-remember` | Store in memory |
| `/pantheon-search` | Search memory |
| `/pantheon-status` | Show system health and agent status |
| `/pantheon-todo` | Create and maintain task list |

Full details: [INSTALLATION.md](INSTALLATION.md) for setup, [ARCHITECTURE.md](ARCHITECTURE.md) for system design.
