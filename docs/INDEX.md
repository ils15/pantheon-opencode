# Pantheon Documentation Index

> **A multi-agent orchestration framework** — 14 specialized agents, OpenCode, 14 skills.

---

## Quick Navigation

| If you need... | Go here |
|---|---|
| **What is Pantheon?** | [README.md](../README.md) |
| **Quick start / Install** | [INSTALLATION.md](INSTALLATION.md) |
| **Which platform to pick** | [PLATFORMS.md](PLATFORMS.md) |
| **Agent reference** | [AGENTS.md](../AGENTS.md) |
| **MCP tiers & tools** | [mcp-tools.md](mcp-tools.md), [mcp-user-guide.md](mcp-user-guide.md) |
| **Release process** | [RELEASING.md](RELEASING.md) |
| **Contributing** | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| **Changelog** | [CHANGELOG.md](../CHANGELOG.md) |
| **MCP Tool Registry** | [mcp-tools.md](mcp-tools.md) |
| **MCP User Guide** | [mcp-user-guide.md](mcp-user-guide.md) |
| **MCP Tiers** | `.pantheon/tiers.json` |

---

## Architecture at a Glance

**Pantheon** replaces the single-agent coding trap with **specialized agents**:
- **Zeus** orchestrates the workflow (plan → implement → review → deploy)
- **Athena** plans architecture; **Apollo** discovers code; **Hermes/Aphrodite/Demeter/Prometheus** implement
- **Themis** reviews every phase (mandatory quality gate); **Mnemosyne** documents decisions
- **Iris** manages GitHub; **Talos** handles hotfixes; **Gaia** analyzes remote sensing

All agents live as **canonical `.agent.md` files** in `src/agents/` and are deployed via the installer.

---

## Platform Support

Pantheon v1.0 is **OpenCode-only**. See [PLATFORMS.md](PLATFORMS.md) for details.

---

## Where to Find What

| Concern | Location |
|---|---|
| Agent definitions (edit here) | `agents/*.agent.md` |
| Platform configs (auto-generated) | `platform/<name>/agents/` |
| Shared skills | `skills/<name>/SKILL.md` |
| Standards & instructions | `instructions/*.instructions.md` |
| Prompt templates | `prompts/*.prompt.md` |
| GitHub Actions workflows | `.github/workflows/` |
| CI/CD hooks | `scripts/hooks/` |
| MCP tool registry (canonical) | [docs/mcp-tools.md](mcp-tools.md) |
| MCP user guide (adding custom MCPs) | [docs/mcp-user-guide.md](mcp-user-guide.md) |
| MCP tiers (none/essential/recommended/full) | `.pantheon/tiers.json` |
| MCP recommendations per project type | [docs/mcp-recommendations.md](mcp-recommendations.md) |
| Project memory (sprints, decisions) | `.pantheon/memory-bank/` |
| Plugin manifests | `plugin.json`, `.github/plugin/plugin.json` |

---

## Platform Configuration

Pantheon runs exclusively on **OpenCode**. Platform configuration lives under `platform/opencode/`.

For installation instructions, see [INSTALLATION.md](INSTALLATION.md).
