<h1 align="center">Pantheon</h1>

<p align="center">
  <strong>Multi-agent orchestration for OpenCode.</strong><br>
  Plan, implement, review, and document software with specialized agents,
  persistent memory, and explicit quality gates.
</p>

<p align="center">
  <a href="README.pt-BR.md">Português (Brasil)</a> ·
  <a href="https://github.com/ils15/pantheon-opencode/releases/tag/v1.4.3">v1.4.3</a> ·
  <a href="LICENSE">MIT License</a>
</p>

<p align="center">
  <a href="https://github.com/ils15/pantheon-opencode/actions"><img src="https://img.shields.io/github/actions/workflow/status/ils15/pantheon-opencode/ci.yml?branch=main&label=CI" alt="CI"></a>
  <a href="https://github.com/ils15/pantheon-opencode"><img src="https://img.shields.io/badge/agents-14-purple" alt="14 agents"></a>
  <a href="https://github.com/ils15/pantheon-opencode"><img src="https://img.shields.io/badge/skills-21-orange" alt="21 skills"></a>
  <a href="https://github.com/ils15/pantheon-opencode"><img src="https://img.shields.io/badge/commands-7-red" alt="7 commands"></a>
</p>

## What it does

Pantheon is an OpenCode plugin and installer that coordinates 14 specialized
agents. Zeus orchestrates the work; planning, implementation, review, memory,
GitHub operations, and other concerns are assigned to focused agents instead
of one generalist context.

The repository currently contains 21 reusable skills and 7 slash-command
definitions. Counts in this README are derived from `src/agents/`,
`src/skills/`, and `commands/`.

## Quick start

Requirements: Node.js 18+, OpenCode 1.18.4+, and Python 3.11+ when MCP servers
are enabled.

```bash
cd your-project
npx pantheon-opencode init
npm run doctor
opencode
```

For MCP setup, run `npm run setup`. See the [installation guide](docs/INSTALLATION.md)
for interactive and headless options.

## Documentation

- [Installation](docs/INSTALLATION.md) · [Quick start](docs/QUICKSTART.md)
- [Agent reference](docs/agents/README.md) · [Skills reference](src/skills/README.md)
- [Architecture](docs/ARCHITECTURE.md) · [MCP tools](docs/mcp-tools.md)
- [Release process](docs/RELEASING.md) · [Contributing](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)

Documentation is maintained in English as the canonical language. The
[Brazilian Portuguese README](README.pt-BR.md) provides an accessible overview
and points to the same detailed guides.

## Beta releases

A pull request labeled exactly `release:beta` triggers the beta path in the
`Release` workflow. It publishes a prerelease to npm with the `beta` dist-tag
and creates a GitHub prerelease; ordinary pushes do not publish beta versions.
Beta recovery is available only through an explicit workflow dispatch with all
required recovery inputs. See [docs/RELEASING.md](docs/RELEASING.md) for the
versioning, validation, and recovery details.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Changes
are validated by CI; stable releases are published only through the explicit
GitHub Actions `Release` workflow dispatch described in
[docs/RELEASING.md](docs/RELEASING.md).


### Zenodo release integration

`.github/workflows/zenodo.yml` runs only for a published GitHub Release or a
manual dispatch with explicit production confirmation. Configure the protected
`zenodo-production` environment with the `ZENODO_TOKEN` secret and the
non-secret variables `ZENODO_DEPOSITIONS_URL`, `ZENODO_FILES_URL_TEMPLATE`,
`ZENODO_PUBLISH_URL_TEMPLATE` (the exact endpoints documented by the selected
Zenodo instance, using `{id}` where applicable), and `ZENODO_CREATOR_NAME`.
The workflow intentionally does not assume Zenodo Cloud versus Sandbox
endpoints; verify these values against the instance API before enabling the
environment. It validates the tag and manifests, accepts an optional
`CITATION.cff`, records the deposition ID in release notes, and never invents a DOI.

## Project limits

Pantheon is an OpenCode plugin and installer, not a hosted orchestration service.
It does not provide model access, API keys, quotas, or guarantees about external
providers and optional MCP services. Those services require their own accounts,
credentials, availability, and configuration. Agents can also produce mistakes;
review the generated work and keep the repository's quality gates enabled.

## License and citation

Pantheon is distributed under the [MIT License](LICENSE). Citation metadata is
available in [CITATION.cff](CITATION.cff).

Canonical repository: <https://github.com/ils15/pantheon-opencode>
