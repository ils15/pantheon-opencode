# Pantheon Quick Start

## What is Pantheon

A multi-agent framework for **OpenCode**. 14 specialized agents with TDD enforcement, quality gates (Themis 3-layer review), and persistent memory MCP. **v1.0** — single entry point, background subagents, 14 commands.

## Installation

### Quick install (recommended)

```bash
npx pantheon-opencode init
```

This installs agents globally to `~/.config/opencode/agents/`. For project-local install, add `--project`.

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

## v1.0 Highlights

- **OpenCode-only** — unified, simplified, no multi-platform fragmentation
- **Global install** — `npx pantheon-opencode init` works from any directory
- **Background subagents** — up to 5 agents in parallel
- **14 commands** — all start with `/pantheon-`
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
