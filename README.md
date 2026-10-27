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
- **Right-sized coordination:** bounded work goes to one specialist, who
  gathers the needed context. Planning, separate discovery, parallel work, and
  review are added when scope and risk call for them. `/pantheon-deepwork`
  remains the checkpointed workflow for heavy multi-phase work.

## Start in 2 minutes

Requirements: [OpenCode](https://opencode.ai/docs/) **1.19.x** (V1) or **OpenCode
2.x** (V2), and Node.js **>=26.4.0** for the CLI and tooling. **OpenCode 2.0.22
is known broken**; see [Compatibility](docs/COMPATIBILITY.md).

From the project where you want to use Pantheon:

```bash
npx pantheon-opencode init
opencode
```

For the optional full setup flow, run `npm run setup`. On detected OpenCode V2,
it reviews the global config before installer init: legacy permission rules can
be migrated after explicit review. Verified Pantheon plugin/MCP entries are
reported; JSONC entries move only when order and overrides stay safe, otherwise
the user must choose to keep them in place or abort. Config migration and
installer changes are preflighted before one final authorization; `--yes` alone
does not authorize writes. Overlapping MCP wildcard policies that could allow
  an action after a denial are blocked, and ineffective MCP `ask` rules matching
configured or installer-seeded servers require an explicit outcome.
Existing native V2 `permissions` arrays stay authoritative; Pantheon does not
append legacy default grants to them.
Flat third-party MCP entries in `opencode.jsonc` block V2 setup until manually
converted to `mcp.servers` or removed; nested third-party servers are preserved.
Headless/CI/non-TTY runs are preview-only and do not invoke writing init (V1
included). See the [installation guide](docs/INSTALLATION.md) for layer handling,
conflict choices, backups, and recovery.

Global `init` and `setup` use `$XDG_CONFIG_HOME/opencode` when
`XDG_CONFIG_HOME` is absolute; otherwise they use `~/.config/opencode`.
Relative `XDG_CONFIG_HOME` values are rejected before writes.

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
  `/dispatch` panel. The V2 TUI also provides a quota overview in the
  sidebar/footer and a `/quota` details panel. Quota display is enabled by
  default; the sidebar keeps Todo and places quota immediately after Dispatch
  (header/version → Session → Context → Git → Todo → Dispatch → quota).
  Status stays in the native sidebar footer. Use `E` to disable quota or `M`
  to switch between remaining and used. Quota windows show a local countdown and
  the provider-reported reset date/time in UTC when valid timing is available;
  missing timing is not inferred. After expiry the UI shows “aguardando
  atualização” until refreshed data arrives. Empty quota gauges use a visible
  track even when no usage is reported.
  When a quota status request fails, the UI preserves the last valid
  snapshot, marks it stale, and shows the failure cause as `Erro: <causa>`
  in the sidebar and `/quota` panel (plus a `Último erro` line) instead
  of a blind "Status indisponível"; the cause is logged as
  `[pantheon-tui quota]`.
  Usage severity uses warning color from 60% consumed and error color above 85%.
  Session costs, provider balances and selected-key usage retain their distinct
  labels and reported periods. Long values and states continue onto additional
  lines within the sidebar's fixed 34-column content budget.
  The installer selects the `plugins` component by default; in interactive setup
  you can change the component selection. A component-scoped install includes
  the TUI only when `plugins` is selected.
  The V2 quota RPC shows providers only when OpenCode lists an active supported
  connection and Pantheon can locally resolve a nonblank credential. This is
  not proof that the provider accepted the credential; failed requests and
  unsupported adapters can remain visible as unavailable. OpenCode Go checks
  the selected Console OAuth login first, then uses an active OpenCode Go API
  key (or its legacy OpenCode key alias) only when the Console request fails; a
  Console 404 or a successful response without an access object reports no Go
  subscription and does not fall back.
  The route contract remains unofficial; see the
  [quota provider coverage table](docs/tui-v2-quota-providers.md) for limits and
  troubleshooting.
  `/quota-go-check` is a separate manual, confirmation-gated diagnostic: one
  GET to `https://opencode.ai/zen/go/v1/usage` with the configured Go API key
  (not OAuth), at most one attempt per plugin runtime. It never refreshes quota,
  follows redirects or retries. Only HTTP 401 bodies are inspected, up to 4096
  bytes, for an own top-level JSON `error` property; its value is never inspected.
  Results contain only a safe category, optional HTTP status, coarse content type,
  and (for 401) whether that structure is present, absent, or unavailable.
  No error code, type, message, body, request ID, or byte count is displayed;
  a 401 rejection's cause remains unknown. `success` means
  HTTP success only—not a stable quota contract or parsed quota correctness.
  Require Themis security review before using this diagnostic.

Vision requests to OpenCode Zen require a valid active session and are rejected
before image fetching or model-catalog lookup when the session is missing or
invalid. The Python vision MCP keeps its local metadata/OCR fallback when no
gateway credential is configured. In the V2 plugin, an explicit Vision model
pin that is unavailable or ineligible returns an actionable error rather than
silently switching models; remove the pin to use automatic model discovery.

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

### V2 plugin options

The OpenCode V2 host hands a plugin its `options` only from the object form of
the entry. `init` writes that form for the optional per-request context pruner;
memory retrieval stays an explicit `memory_search` MCP call.

```json
{
  "plugins": [
    {
      "package": "/path/to/pantheon-opencode/src/plugin-v2",
      "options": {
        "context_pruner": { "enabled": true }
      }
    }
  ]
}
```

Keep the `package` value `init` wrote and add keys inside `options`; custom
options survive a re-run. The context pruner is off unless `enabled` is
literally `true`.

| Option | Default | Effect |
|---|---|---|
| `options.context_pruner.enabled` | `false` | Prune old turns from the request payload and at compaction. Off by default because per-request pruning invalidates the provider prompt cache. |

`context_pruner` also accepts `keepTurns`, `purgeAfterTurns`, `protectedTools`,
`minSavingsTokens` and `charsPerToken`. Unknown keys are ignored with a
one-time warning in the hook log, so a typo cannot silently change behaviour. Run
`npx pantheon-opencode doctor` to see whether the installed entry can receive
options at all. An old `memory_injection` option may remain in an existing
config because user options are preserved, but the plugin no longer reads it.
Full rules: [OpenCode V2](docs/opencode-v2.md) and [Memory](docs/MEMORY.md).

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

The release install gate's tool canary loads the installed tarball's V2 plugin
entry under OpenCode 2.0.30 and verifies `hashline_edit` registration, Code Mode
visibility, and a bounded edit in an isolated project. It does not prove npm
publication or compatibility with untested host versions; details are in the
[release process](docs/RELEASING.md).

## Status

The manifests in this checkout express the version being prepared, not a
confirmed publication. Check the npm `beta` dist-tag for what is actually
published. See [Compatibility](docs/COMPATIBILITY.md) for the supported hosts
and [releases](https://github.com/ils15/pantheon-opencode/releases) for the
latest published changes.

## What's new

See the [GitHub release](https://github.com/ils15/pantheon-opencode/releases)
and [CHANGELOG.md](CHANGELOG.md) for the changes in 1.6.1.

## Contribute

Ideas, bug reports, documentation improvements, and code contributions are
welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull
request. That file also defines the documentation rule: one home per fact, with
a short list of facts that must not be duplicated.

For code changes, run the smallest relevant check and expand it to match the
change's risk. `npm test` is the full repository suite; see
[CONTRIBUTING.md](CONTRIBUTING.md) for when to use it.

## Citation and DOI

Pantheon is released under the [MIT License](LICENSE). Cite the
[Zenodo concept DOI](https://doi.org/10.5281/zenodo.22650136), which always
resolves to the latest archived release; each release also has its own version
DOI. Citation metadata is in [CITATION.cff](CITATION.cff).

Canonical repository: <https://github.com/ils15/pantheon-opencode>

---

[Leia em português (Brasil)](README.pt-BR.md)
