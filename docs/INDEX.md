# Pantheon Documentation

Pantheon is a multi-agent orchestration framework for **OpenCode**: 14
specialized agents, 20 skills, and one guided workflow from plan to reviewed
change. This page is the map. Each fact has one home; pages link to it instead
of repeating it.

## Start here

| If you want to… | Read |
|---|---|
| Install Pantheon, or review installer flags, backups, and uninstall | [Installation](INSTALLATION.md) |
| Reach a first result in ten minutes | [Quick Start](QUICKSTART.md) |
| Move an existing install to 1.6.0, or plan for 1.7+ | [Upgrading](UPGRADING.md) |
| Know which OpenCode and Node versions are supported | [Compatibility](COMPATIBILITY.md) |

## Understand the system

| Topic | Page |
|---|---|
| Agent flow, delegation mechanics, and the V1/V2 plugin contract | [Architecture](ARCHITECTURE.md) |
| The 14 agents and their canonical files | [Agents & Skills](agents/README.md) |
| Permission layers, quality gates, and delegation rules | [Permissions, Gates & Delegation](PERMISSIONS-QUALITY-DELEGATION.md) |
| OpenCode V2 behavior: detection, tools, Dispatch, pruning, goals | [OpenCode V2](opencode-v2.md) |

## Operate

| Topic | Page |
|---|---|
| MCP setup, entrypoints, allowlists, and pins | [MCP](MCP.md) |
| Every shipped MCP tool, including `pantheon_cost` | [MCP Tools](mcp-tools.md) |
| Memory stores, TTL, size caps, and session goals | [Memory](MEMORY.md) |
| Platform overview (OpenCode-only) | [Platforms](PLATFORMS.md) |

## Reference

| Topic | Page |
|---|---|
| Model routing analysis and per-agent fallbacks | [Model Routing](reference/model-routing.md) |
| Environment variables that change behavior | [Environment Variables](reference/env-vars.md) |
| Confined script execution and approval manifests | [Code Mode](reference/code-mode.md) |

## Project

| Topic | Page |
|---|---|
| Release mechanics, gates, and tags | [Release Process](RELEASING.md) |
| `main` branch protection | [Branch Protection](BRANCH-PROTECTION.md) |
| Customer-visible roadmap themes | [Roadmap](https://github.com/ils15/pantheon-opencode/blob/main/ROADMAP.md) |
| How to contribute, and the documentation rule | [Contributing](https://github.com/ils15/pantheon-opencode/blob/main/CONTRIBUTING.md) |
| Published changes | [Changelog](https://github.com/ils15/pantheon-opencode/blob/main/CHANGELOG.md) |

## Where things live

| Concern | Location |
|---|---|
| Agent definitions (edit here) | `src/agents/*.md` |
| Shared skills | `src/skills/<name>/SKILL.md` |
| Standards and instructions | `src/instructions/*.instructions.md` |
| Prompt templates | `prompts/*.prompt.md` |
| Slash commands | `commands/*.md` |
| MCP tool registry (canonical) | `src/mcp/` |
| Project memory (sprints, decisions) | `.pantheon/memory-bank/` |

Pantheon runs exclusively on OpenCode. Installation instructions are in
[Installation](INSTALLATION.md).
