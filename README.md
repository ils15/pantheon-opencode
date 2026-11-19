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
# Primary (Recommended) — native OpenCode 2.x plugin (works in any directory, no init required)
opencode plugin add pantheon-opencode

# Check health, updates & clean legacy/stale caches inside OpenCode:
#   /pantheon-settings -> Updates (or Legacy & Drift Cleanup), /pantheon-updates, /pantheon-whats-new

# Deprecated legacy CLI fallback (optional Python MCP runtime only):
# npm install -g pantheon-opencode && pantheon-opencode init --yes
```

## Usage

Inside OpenCode, dispatch the orchestrator or a workflow:

```text
@zeus: Add CSV export to the reports page
/pantheon-deepwork "Implement OAuth2 PKCE authentication flow"
```

`@zeus` routes to the polyglot specialists (`@hermes` for backend/APIs, `@aphrodite` for UI,
`@demeter` for data/migrations, `@talos` for fast fixes, `@themis` for review); `/pantheon`
arbitrates architectural choices across specialists; `/pantheon-deepwork` runs a multi-phase
plan with `pantheon_step_ledger` mechanical receipts and gates; and `pantheon_agent_forge`
creates custom project-specific domain specialists in `.opencode/agents/<name>.md` on demand.
You approve each gate and you run every commit.

The OpenCode 2.x TUI surfaces live native-tool domain counters (`mem`, `ctx`, `code`, `edit`,
`shell`), live child activity and attention badges (`?` / `!`) in `Dispatch` and `/dispatch`,
the interactive **Mission Control Cockpit** (`/pantheon-cockpit` · `Overview`, `Swarm`,
`Flightdeck`), `/pantheon-artifacts` for plans/reports/ADRs, interactive `/pantheon-forge` stack
detection, and the full **29-tool native inventory** in `/pantheon-settings` → **About** (including
post-edit LSP diagnostics, `ast_search`/`ast_rewrite`, `pantheon_review_verdict`, bugfix `RED`
reproduction gates, and `ctx.worktree.transform` sibling worktrees). Git worktrees automatically
share the main repository's `.pantheon/memory`, checkpoints, and goals store (set
`PANTHEON_ISOLATE_WORKTREE_MEMORY=1` to keep a worktree's memory store isolated).

## Structure

```
src/agents/       14 canonical polyglot agent definitions (roster.json + build-roster)
src/pantheon/     native TypeScript tools, Agent Forge, Step-Ledger, FTS5 memory, codemap, receipts
src/skills/       25 skills loaded on demand
src/mcp/          native Node.js MCP bridge (pantheon-mcp-server.mjs)
src/plugins/      OpenCode plugin + high-density TUI sidebar & settings
scripts/          installer, doctor, test-slice, release tooling
bin/              pantheon-opencode CLI
docs/             bilingual documentation portal
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
| [Artifacts & `/pantheon-artifacts`](docs/ARTIFACTS.md) | [Release highlights](docs/releases/highlights.md) |
| [CHANGELOG](CHANGELOG.md) | [Architecture](docs/ARCHITECTURE.md) |

Runnable examples: [SaaS performance dashboard](examples/saas-dashboard/) and
[repo health CLI](examples/cli-tool/). Contributing:
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE). Cite via Zenodo concept DOI
[10.5281/zenodo.22650136](https://doi.org/10.5281/zenodo.22650136)
([CITATION.cff](CITATION.cff)).
