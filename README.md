# Pantheon

A multi-agent orchestration plugin for OpenCode that carries a request from plan to
reviewed change with 14 specialized agents, enforced TDD and explicit human approval
gates — for developers and teams who want structure without giving up control of the code.

[Português (Brasil)](README.pt-BR.md) · [Repository](https://github.com/ils15/pantheon-opencode) · [MIT License](LICENSE)

[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A526.4.0-339933)](package.json)
[![OpenCode](https://img.shields.io/badge/opencode-2.x-black)](https://opencode.ai/)
[![Docs](https://img.shields.io/badge/docs-portal-indigo)](https://ils15.github.io/pantheon-opencode/)

## What it is

One agent planning, writing, testing, reviewing and documenting at the same time gives you
fragmented context and skipped tests. Pantheon splits that work across specialists that
share a single workflow: Zeus orchestrates, Athena plans, the implementation agents write,
Themis reviews, and every phase stops for your approval. Bounded micro-edits skip the
ceremony and verify in seconds; heavy multi-phase work runs as a checkpointed plan that
resumes across sessions. It is an OpenCode plugin plus installer — no separate runtime, no
auto-merge, no silent permission changes.

Every dispatch carries a concise handoff brief — objective, bounded scope, relevant inputs,
constraints, expected return format and verification — and work is routed **qualitatively**,
by uncertainty, domain expertise, dependencies, risk and verification, not by fixed file or
line thresholds.

## Installation

Requirements: [OpenCode](https://opencode.ai/docs/) **2.x** and Node.js **≥ 26.4.0**
([compatibility](docs/COMPATIBILITY.md)).

```bash
# Option A — as an OpenCode plugin (global or project)
opencode plugin add pantheon-opencode

# Option B — global CLI install with full MCP tooling
npm install -g pantheon-opencode@beta
pantheon-opencode init --yes

# Verify the install
pantheon-opencode doctor

# Later: update without losing models, presets or permissions
pantheon-opencode update
```

## Usage

Inside OpenCode, dispatch the orchestrator or a workflow:

```text
@zeus: Add CSV export to the reports page
/pantheon-deepwork "Implement OAuth2 PKCE authentication flow"
```

`@zeus` routes to the specialists; `/pantheon` arbitrates architectural choices across
specialists; `/pantheon-deepwork` runs a multi-phase plan with checkpoints and gates. You
approve each gate and you run every commit.

## Structure

```
src/agents/       14 canonical agent definitions
src/skills/       skills loaded on demand
src/mcp/          local MCP servers (memory, persistence, resources, code-mode, vision)
src/plugins/      OpenCode plugin + TUI
scripts/          installer, doctor, test-slice, release tooling
bin/              pantheon-opencode CLI
docs/             documentation (also published as the docs portal)
examples/         runnable reference projects
tests/            Node and TypeScript test suites
```

## Documentation

| Start here | Go deeper |
|---|---|
| [Docs portal](https://ils15.github.io/pantheon-opencode/) | [Architecture](docs/ARCHITECTURE.md) |
| [Quick Start](docs/QUICKSTART.md) | [Overview and routing ladders](docs/OVERVIEW.md) |
| [Installation](docs/INSTALLATION.md) | [Execution modes](docs/guides/execution-modes.md) |
| [First project end-to-end](docs/guides/first-project.md) | [Agent Capability Matrix](docs/AGENT-CAPABILITY-MATRIX.md) |
| [Settings & TUI window](docs/SETTINGS.md) | [Permissions, gates & delegation](docs/PERMISSIONS-QUALITY-DELEGATION.md) |
| [v2.x highlights](docs/releases/v2-highlights.md) | [CHANGELOG](CHANGELOG.md) |

Runnable examples: [SaaS performance dashboard](examples/saas-dashboard/) and
[repo health CLI](examples/cli-tool/). Contributing:
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE). Cite via Zenodo concept DOI
[10.5281/zenodo.22650136](https://doi.org/10.5281/zenodo.22650136)
([CITATION.cff](CITATION.cff)).
