# Pantheon

**A clearer way to work with OpenCode on real software projects.** Pantheon
brings planning, implementation, review, and documentation into one guided
experience. It is an OpenCode plugin and installer for teams and developers who
want useful structure without giving up control of their code.

[Português (Brasil)](README.pt-BR.md) ·
[Repository](https://github.com/ils15/pantheon-opencode) · [MIT License](LICENSE)

[![Version](https://img.shields.io/github/v/release/ils15/pantheon-opencode?label=version)](https://github.com/ils15/pantheon-opencode/releases/tag/v1.5.0)
[![CI](https://img.shields.io/github/actions/workflow/status/ils15/pantheon-opencode/ci.yml?branch=main&label=CI)](https://github.com/ils15/pantheon-opencode/actions)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.22306637.svg)](https://doi.org/10.5281/zenodo.22306637)

## What is it?

Pantheon is a companion for [OpenCode](https://opencode.ai/) that helps you
move from an idea to a reviewed change. It gives your coding sessions a shared
way to plan work, make progress, check results, and keep useful project context.

## Why use it?

- **Less context switching:** keep planning and building in the same workflow.
- **More deliberate changes:** ask for reviews and checks before calling work
  finished.
- **A repeatable starting point:** use the same setup across projects and
  collaborators.
- **You stay in charge:** Pantheon supports your decisions; it does not replace
  your judgment or your review of generated code.

## Start in 2 minutes

Requirements: [OpenCode 1.18.4+](https://opencode.ai/docs/) and Node.js 18+.

From the project where you want to use Pantheon:

```bash
npx pantheon-opencode init
opencode
```

The installer guides you through the available setup. For optional MCP servers,
project-local installation, or non-interactive setup, see the
[installation guide](docs/INSTALLATION.md).

## A simple example

Once OpenCode is running, describe the outcome you want:

```text
/pantheon Add CSV export to the reports page, including tests and a review.
```

Pantheon helps turn that request into a plan and a sequence of reviewed steps.

## Who is it for?

Pantheon is for developers, maintainers, and teams using OpenCode who want a
more consistent way to tackle small fixes and larger changes. It is especially
useful when a project benefits from written decisions, repeatable checks, and a
clear handoff between stages of work.

## What’s included?

- A guided installer for making Pantheon available to OpenCode.
- Reusable instructions and commands for planning, building, reviewing, and
  documenting work.
- Project memory that helps preserve relevant context between sessions.
- Optional integrations for common development tasks.

## Status

Current release: **v1.5.0**. Pantheon is designed for OpenCode and depends on
the availability and configuration of OpenCode and any optional services you
choose to use. Check the [releases](https://github.com/ils15/pantheon-opencode/releases)
and [changelog](CHANGELOG.md) for the latest changes.


## What's new in 1.5.0

- OpenCode-only installer: platform guides consolidated into a single
  [OpenCode guide](docs/platforms/opencode.md).
- New `uninstall` CLI with project and global scopes and ownership checks:
  `node scripts/uninstall.mjs --project|--global [--dry-run] [--force]`.
- Hardened MCP resources: fixed `pantheon://agents` listing and added
  symlink/traversal protection for resource paths.
- OpenCode V2 compatibility: `plugins` / `mcp.servers.enabled` config merge
  and PWD-correct stdio MCP launch.
- Expanded `doctor` and install health checks.
- Sandbox validator for global installs (`scripts/test-opencode-v1-v2-sandbox.sh`)
  covering OpenCode V1/V2 side by side — see
  [Sandbox validation](#sandbox-validation-v1v2).
- A `--prompts` installer flag is planned for a future release.

## OpenCode V1/V2 — Dual Version (1.5.0)

Pantheon has two **exclusive** OpenCode plugin contracts. Ordinary OpenCode
configuration may be shared, but the Pantheon plugin registration is selected
per installation; V1 and V2 Pantheon plugins must never be registered together.

| | V1 | V2 |
|---|---|---|
| OpenCode config key | singular `plugin` | plural `plugins` |
| Pantheon registration | `src/plugin.ts` plus `src/plugins/pantheon-hooks.ts` | `pantheon-opencode/plugin-v2` (`src/plugin-v2.ts`) |
| Runtime contract | Legacy Pantheon plugin, including `pantheon_delegate`, read/list tools, event/tool hooks and V1 compaction handling | Full V2 plugin: 9 orchestration tools, 4 event subscriptions, session hooks (`prompt`, `context`), tool hooks (`execute.before`/`after`), plus configuration transforms |
| V1 APIs | Registered | Own tool definitions via `ctx.tool.transform()` — not the V1 plugin path |

The V2 plugin provides 9 orchestration tools (`pantheon_delegate`,
`pantheon_delegation_read`, `pantheon_delegation_list`, `hashline_edit`,
`pantheon_goal_create`, `pantheon_goal_get`, `pantheon_goal_update`,
`pantheon_cost`, `pantheon_model`), 4 event subscriptions (`session.created`,
`session.idle`, `session.error`, `session.compacted`), session hooks (`prompt`,
`context`), and tool hooks (`execute.before`, `execute.after`). The only
unsupported V2 feature is `legacy-hooks` (the V1-specific delegate API surface).

The package exposes both contracts as importable exports: `pantheon-opencode/plugin`
(V1), `pantheon-opencode/plugin-v2` (V2) and `pantheon-opencode/v2-bridge`
(optional interop), so a host can load either contract explicitly.

The V1→V2 bridge (`src/pantheon/v2-bridge.ts`) enables optional interop:
V1 infrastructure singletons (BackgroundJobBoard, DelegationClient, GoalStore,
TodoEnforcer, VisionHandler) are passed through V2 `ctx.options`. The bridge is
optional — V2 works standalone with graceful degradation.

Select the contract explicitly when installing:

```bash
npx pantheon-opencode init --opencode-version v1
npx pantheon-opencode init --opencode-version v2
npx pantheon-opencode init --opencode-version auto
```

`--version v1|v2|auto` is accepted as the older selector spelling when used
after `init`. `auto` is conservative, not general platform autodetection:
`OPENCODE_VERSION=v1|v2` wins; otherwise an `OPENCODE_BIN` ending in
`opencode2` selects V2; every other case selects V1. The installer removes
Pantheon references from both config shapes before writing only the selected
Pantheon registration. Third-party entries are not converted or claimed by
this rule.

The V1-only `pantheon_cost` report can select its database with
`PANTHEON_OPENCODE_VERSION=v1` or `v2` (`opencode.db` or `opencode-v2.db`).
`PANTHEON_COST_DB=/absolute/path/to/opencode.db` takes precedence over the
version selector, and an explicit `dbPath` supplied by the tool caller takes
precedence over both. The resolver never probes the other version's database
and reports an actionable error when the selected DB is missing or has an
incompatible schema.

The installer still writes the compatibility settings required by the selected
OpenCode host, such as `experimental.subagent_depth`; this does not convert a
V1 plugin into V2 or provide V2 with V1 hooks.

## Beta releases

A pull request labeled exactly `release:beta` triggers the beta release path. See [docs/RELEASING.md](docs/RELEASING.md) for validation and recovery details.

## Sandbox validation (V1/V2)

`scripts/test-opencode-v1-v2-sandbox.sh` validates the globally installed
package as a real user inside an isolated sandbox (own `HOME`, npm prefix and
venv) — never the dev environment. It checks OpenCode V1 (`opencode`) and V2
(`opencode2`) side by side: binaries, MCP connectivity, `doctor`, and — with
`--prompts` — a prompt battery covering the `pantheon://agents` resource,
memory store/recall, filesystem writes and agent delegation. Environmental
failures (network, provider auth, Docker) are classified as `AMBIENTAL` and
never fail the run; only real failures do.

```bash
scripts/test-opencode-v1-v2-sandbox.sh --prepare          # tarball + install + init in the sandbox
scripts/test-opencode-v1-v2-sandbox.sh --run v1 --prompts # base validation + prompt battery (V1)
scripts/test-opencode-v1-v2-sandbox.sh --run v2           # base validation only (V2)
scripts/test-opencode-v1-v2-sandbox.sh --prompts          # prompt battery for both versions
scripts/test-opencode-v1-v2-sandbox.sh --reset            # wipe the sandbox root
```

Modes are combinable (e.g. `--prepare --run v1 --prompts`). Binaries are
resolved strictly inside the sandbox npm prefix — a non-prepared sandbox fails
fast instead of silently testing the host installation.

Env overrides:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PANTHEON_SANDBOX_ROOT` | `~/pantheon-sandbox` | Sandbox root (refused if unsafe for `--reset`) |
| `OPENCODE_V1_SPEC` | `opencode-ai@1.18.18` | npm spec providing the `opencode` binary |
| `OPENCODE_V2_SPEC` | `@opencode-ai/cli@beta` | npm spec providing the `opencode2` binary |
| `PANTHEON_SANDBOX_MODEL` | `opencode-go/mimo-v2.5` | Model used by init and prompts |
| `PANTHEON_PROMPT_TIMEOUT` | `300` | Per-prompt timeout in seconds |

Exit codes: `0` no real failures · `1` real failure (see `prompts-report.md`
in the sandbox root) · `2` usage error · `3` sandbox not prepared.

## Documentation

- [Installation](docs/INSTALLATION.md) · [Quick start](docs/QUICKSTART.md)
- [Architecture](docs/ARCHITECTURE.md) · [MCP tools](docs/mcp-tools.md)
- [Platforms](docs/PLATFORMS.md) · [Upgrading](docs/UPGRADING.md)
- [Agent reference](docs/agents/README.md) · [Skills reference](src/skills/README.md)
- [Release process](docs/RELEASING.md) · [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

## Contribute

Ideas, bug reports, documentation improvements, and code contributions are
welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue
or pull request.

## Citation and DOI

Pantheon is released under the [MIT License](LICENSE). For the published v1.4.3
record, use the [Zenodo DOI](https://doi.org/10.5281/zenodo.22306637); citation
metadata is also available in [CITATION.cff](CITATION.cff).

Canonical repository: <https://github.com/ils15/pantheon-opencode>

---

[Leia em português (Brasil)](README.pt-BR.md)
