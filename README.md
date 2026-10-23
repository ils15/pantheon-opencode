# Pantheon

**A clearer way to work with OpenCode on real software projects.** Pantheon
brings planning, implementation, review, and documentation into one guided
experience. It is an OpenCode plugin and installer for developers and teams who
want useful structure without giving up control of their code.

[Português (Brasil)](README.pt-BR.md) ·
[Repository](https://github.com/ils15/pantheon-opencode) · [MIT License](LICENSE)

[![Version](https://img.shields.io/github/v/release/ils15/pantheon-opencode?label=version)](https://github.com/ils15/pantheon-opencode/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/ils15/pantheon-opencode/ci.yml?branch=main&label=CI)](https://github.com/ils15/pantheon-opencode/actions)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.22650136.svg)](https://doi.org/10.5281/zenodo.22650136)

## What is it?

Pantheon is a companion for [OpenCode](https://opencode.ai/) that helps you move
from an idea to a reviewed change. Fourteen specialized agents share one
workflow: plan, implement, check, review, and record what mattered. You stay in
charge of every decision and every merge.

## Why use it?

- **Less context switching:** keep planning and building in the same workflow.
- **More deliberate changes:** ask for reviews and checks before calling work
  finished.
- **A repeatable starting point:** use the same setup across projects and
  collaborators.
- **You stay in charge:** Pantheon supports your judgment; it does not replace
  it.
- **Right-sized coordination:** bounded work goes to one specialist; planning,
  discovery, parallel work, and review are added when scope and risk call for
  them. `/pantheon-deepwork` remains the checkpointed workflow for heavy
  multi-phase work.

## Start in 2 minutes

Requirements: [OpenCode](https://opencode.ai/docs/) **1.19.x** (V1) or **OpenCode
2.x** (V2), and Node.js **>=26.4.0** for the CLI and tooling. **OpenCode 2.0.22
is known broken**; see [Compatibility](docs/COMPATIBILITY.md).

From the project where you want to use Pantheon:

```bash
npx pantheon-opencode init
opencode
```

Then describe the outcome you want:

```text
/pantheon Add CSV export to the reports page, including tests and a review.
```

When you ask for a plan, Athena returns it to Zeus, who displays it in the main
conversation before asking for approval — never as a plan hidden in a child
agent's conversation.

Restart OpenCode after installing or changing the plugin generation. The
installer selects one generation per installation; V1 and V2 plugins are never
registered together.

Installer flags, exit codes, saved plans, backup and restore, uninstall,
reconcile, and MCP pins are in the [installation guide](docs/INSTALLATION.md).
For the first ten minutes only — `init` → restart → `/dispatch` → first result —
see [Quick Start](docs/QUICKSTART.md).

## What's included?

- **14 specialized agents** with one orchestrator, implementation specialists,
  a quality gate, and supporting roles.
- **20 skills** and reusable instructions for planning, building, reviewing,
  and documenting work.
- **5 local MCP servers** for project memory, persistence, resources, confined
  script execution, and vision.
- **An optional TUI** with a dispatch sidebar block and a full-width
  `/dispatch` panel.

Memory is used selectively: the coordinator searches once only when project
history could affect a task, then passes relevant results to specialists. Store
one concise, reusable outcome at task completion when it will matter later;
routine child summaries stay in the handoff. See [Memory](docs/MEMORY.md).

## Compatibility

OpenCode **1.19.x** (V1 plugin) and **OpenCode 2.x** (V2 plugin) are supported.
**OpenCode 2.0.22 is known broken.** From 1.7 onward the line drops the V1
contract and targets OpenCode 2 only.

The support policy, the known-broken exception, and the verified-version
evidence have exactly one home: [Compatibility](docs/COMPATIBILITY.md).

## Delegation

Pantheon delegates through the host's native child-session engine: `subagent`
in the user-reported root runtime, referred to as `task()` in host/API
documentation. Tool availability, background support, and completion
observability are runtime-dependent; when completion is not observable, use
synchronous dispatch or wait for a host notification.

Every root dispatch carries a concise handoff brief — objective, bounded scope,
relevant inputs, constraints, expected return format, and verification. Work is
routed qualitatively — uncertainty, domain expertise, dependencies, risk, and
verification — not by fixed file or line thresholds. Return
contracts are role-specific: implementation uses `## subtask_summary`,
investigation returns structured findings, Athena returns the complete plan,
and council responses use `## specialist_response`. Delegated work gets at most
one retry after a transient failure, and Pantheon never claims deterministic
fan-in or job recovery without an exposed mechanism.

The delegation model, caller/target matrix, and approval gates are documented
in [Architecture](docs/ARCHITECTURE.md) and
[Permissions, Gates & Delegation](docs/PERMISSIONS-QUALITY-DELEGATION.md).

## Documentation

| Start here | Go deeper |
|---|---|
| [Installation](docs/INSTALLATION.md) | [Architecture](docs/ARCHITECTURE.md) |
| [Quick Start](docs/QUICKSTART.md) | [MCP](docs/MCP.md) · [MCP tools](docs/mcp-tools.md) |
| [Upgrading](docs/UPGRADING.md) | [Memory](docs/MEMORY.md) |
| [Compatibility](docs/COMPATIBILITY.md) | [OpenCode V2](docs/opencode-v2.md) |
| [Agents & Skills](docs/agents/README.md) | [Platforms](docs/PLATFORMS.md) |
| [Release Process](docs/RELEASING.md) | [Branch Protection](docs/BRANCH-PROTECTION.md) |
| [Model Routing](docs/reference/model-routing.md) | [Env Vars](docs/reference/env-vars.md) · [Code Mode](docs/reference/code-mode.md) |
| [Contributing](CONTRIBUTING.md) | [Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) |

## Status

The manifests in this checkout express the version being prepared, not a
confirmed publication. Check the npm `beta` dist-tag for what is actually
published. See [Compatibility](docs/COMPATIBILITY.md) for the supported hosts
and [releases](https://github.com/ils15/pantheon-opencode/releases) for the
latest published changes.

## What's new

See the [GitHub release](https://github.com/ils15/pantheon-opencode/releases)
and [CHANGELOG.md](CHANGELOG.md) for the changes in 1.6.0.

## Contribute

Ideas, bug reports, documentation improvements, and code contributions are
welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull
request. That file also defines the documentation rule: one home per fact, with
a short list of facts that must not be duplicated.

## Citation and DOI

Pantheon is released under the [MIT License](LICENSE). Cite the
[Zenodo concept DOI](https://doi.org/10.5281/zenodo.22650136), which always
resolves to the latest archived release; each release also has its own version
DOI. Citation metadata is in [CITATION.cff](CITATION.cff).

Canonical repository: <https://github.com/ils15/pantheon-opencode>

---

[Leia em português (Brasil)](README.pt-BR.md)
