# Pantheon

**A clearer way to work with OpenCode on real software projects.** Pantheon
brings planning, implementation, review, and documentation into one guided
experience. It is an OpenCode plugin and installer for teams and developers who
want useful structure without giving up control of their code.

[Português (Brasil)](README.pt-BR.md) ·
[Repository](https://github.com/ils15/pantheon-opencode) · [MIT License](LICENSE)

[![Version](https://img.shields.io/github/v/release/ils15/pantheon-opencode?label=version)](https://github.com/ils15/pantheon-opencode/releases/latest)
[![CI](https://img.shields.io/github/actions/workflow/status/ils15/pantheon-opencode/ci.yml?branch=main&label=CI)](https://github.com/ils15/pantheon-opencode/actions)
[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.22650136.svg)](https://doi.org/10.5281/zenodo.22650136)

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

Requirements: [OpenCode 1.18.4+](https://opencode.ai/docs/) and Node.js
22.22.2+ (or 24.15.0+ / 26+).

Pantheon declares `engines.node` as `^22.22.2 || ^24.15.0 || >=26.0.0`. The
floor reflects what the dependency tree actually needs — the transitive
`ini@7` rejects earlier 22.x/24.x builds with `EBADENGINE` — and odd-numbered
Node releases (23, 25) are out of range. The `pantheon_cost` tool also needs
`node:sqlite`, which requires Node >= 22.5; `doctor` warns when the running
runtime cannot load it.

From the project where you want to use Pantheon:

```bash
npx pantheon-opencode init
opencode
```

The installer guides you through the available setup. For optional MCP servers,
project-local installation, or non-interactive setup, see the
[installation guide](docs/INSTALLATION.md).
The bundled Python MCP servers use the pinned MCP SDK 2.2.0 and standalone
FastMCP 4.0.10 runtime; see the [MCP guide](docs/MCP.md).

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

Candidate version: the manifests in this checkout express the version being
prepared, not a confirmed publication. A beta is published only after the
Release workflow completes successfully. To check which version is actually
published, consult the npm `beta` dist-tag. Pantheon is designed for OpenCode
and depends on the availability and configuration of OpenCode and any optional
services you choose to use. Check the
[releases](https://github.com/ils15/pantheon-opencode/releases) and
[changelog](CHANGELOG.md) for the latest published changes.

## Delegation (native `task()`)

Pantheon delegates exclusively through OpenCode's native `task()` child-session
engine. The former custom `pantheon_delegate` tool and the V1 delegation engine
(`delegation.ts`, `delegate-manager.ts` and supporting modules) were removed;
there is no Pantheon-specific delegation tool surface to configure. See
[ADR-0011](.pantheon/memory-bank/adr/0011-delegation-engine-contract.md) for the
historical engine contract.

## Cost tool backend

`pantheon_cost` prefers a read-only `node:sqlite` backend against the selected
`opencode.db`. When `node:sqlite` is unavailable in the host runtime (for
example under Bun), the tool falls back to spawning `node scripts/cost.mjs` as
a read-only subprocess. The fallback resolves a real Node.js binary —
`PANTHEON_NODE` first, then `node` on `PATH` — verifies it supports
`node:sqlite` (Node.js >= 22.5), and runs the script with an argument array,
never a shell. If neither source resolves, the tool returns `status:
UNSUPPORTED`. Database failures return a contract status such as `UNAVAILABLE`
or `CORRUPT_DATA` and include diagnostic detail, including captured stderr when
available.

| Variable | Default | Purpose |
|----------|---------|---------|
| `PANTHEON_NODE` | `node` from `PATH` | Path to a Node.js >= 22.5 binary used by the CLI fallback; an explicit path must exist and be executable, otherwise the tool fails fast instead of ignoring the override |


## Code-mode execution (explicit opt-in)

Scripts run through the `pantheon-code-mode` MCP server (`execute_code_script`)
only when they are explicitly approved. Approval is recorded in
`.pantheon/code-mode/manifest.json` with the SHA-256 of each script:

```json
{
  "version": 1,
  "scripts": {
    "example-sync.sh": "<sha256>"
  }
}
```

- **No manifest → nothing executes.** A missing manifest returns
  `INVALID_STATE`; scripts are never run implicitly.
- **Not listed → `CONFLICT`.** The script must be approved first.
- **Hash mismatch → `CORRUPT_DATA`.** The SHA-256 of the file on disk must
  match the manifest entry, so edits after approval are detected.

Session persistence is provided by the persistence MCP server. The bundled
code-mode payload contains execution helpers only and does not export or back
up a database.

Approve or re-approve a script with the `approve_code_script` MCP tool:

```
approve_code_script("checkpoint-session.sh")
```

The installer seeds the manifest with the SHA-256 of every bundled script, so
shipped scripts stay approved across installs. Re-run `approve_code_script`
after intentionally editing a script. Status codes follow the shared nine-code
contract (`OK`, `UNSUPPORTED`, `UNAVAILABLE`, `INVALID_INPUT`, `INVALID_STATE`,
`CONFLICT`, `CORRUPT_DATA`, `TIMEOUT`, `ESCALATE`); with `json_output=true`,
results carry a `status` field.

Code-mode resolves project-first: `.opencode/.pantheon/code-mode` is preferred,
then `.pantheon/code-mode`. `PANTHEON_PROJECT` overrides the working directory,
and the installed MCP uses `cwd: "."` so OpenCode supplies the workspace. A
global directory is used only when no usable project directory is available;
once a project directory is selected, a missing or corrupt manifest fails
closed instead of falling back. `doctor` validates the manifest and every
script's SHA-256 without regenerating it.

The local `.pantheon/code-mode/eval-*.py` helpers and any Promptfoo/evaluation
assets are development-only inputs and are excluded from the npm tarball and
from the runtime manifest. `src/mcp/eval_store.py` is different: it is a
shipped runtime dependency of the MCP resources server, not an evaluation
asset, so it remains packaged.


## What's new in 1.6.0-beta.1

- First beta compatible with the OpenCode 2 plugin contract.
- Removed the legacy vector-memory pipeline while preserving SQLite FTS5/BM25
  keyword search and the `code_*` codemap tools.
- CI and release validation are fail-closed; `doctor` checks and the V2-only
  sandbox validator cover the OpenCode 2 installation path.

## OpenCode V1/V2 — Dual Version (1.6.0-beta.1)

This is the first beta compatible with OpenCode 2. Pantheon has two **exclusive** OpenCode
plugin contracts. Ordinary OpenCode
configuration may be shared, but the Pantheon plugin registration is selected
per installation; V1 and V2 Pantheon plugins must never be registered together.

| | V1 | V2 |
|---|---|---|
| OpenCode config key | singular `plugin` | plural `plugins` |
| Pantheon registration | `src/plugin.ts` plus `src/plugins/pantheon-hooks.ts` | `<installed>/src/plugin-v2` directory (`index.ts` re-exports `src/plugin-v2.ts`) |
| Runtime contract | Pantheon V1 plugin: 6 tools (`hashline_edit`, the 3 goal tools, `pantheon_cost`, `pantheon_model`), event/tool hooks and V1 compaction handling | Full V2 plugin: 3 tools (`hashline_edit`, `pantheon_cost`, `pantheon_model`), 4 event subscriptions, session hooks (`prompt`, `context`), a read-only-enforcing tool `execute.before` hook, plus configuration transforms |
| V1 APIs | Registered | Own tool definitions via `ctx.tool.transform()` — not the V1 plugin path |

The V2 plugin provides 3 orchestration tools (`hashline_edit`, `pantheon_cost`,
`pantheon_model`), 4 event subscriptions (`session.created`, `session.idle`,
`session.error`, `session.compacted`), session hooks (`prompt`, `context`),
and a tool `execute.before` hook that enforces read-only sessions. The 3 goal
tools are **not**
registered on V2: the goal loop needs a `GoalStore`, a `GoalLoopClient` and a
`BackgroundJobBoard`, none of which the V2 `PluginContext` exposes, so the gap
is reported as the `goal-tools` unsupported-feature marker. Use the V1
contract if you need the goal loop.

The V2 `execute.before` hook is the read-only enforcement point for that
surface: the host includes the active agent on the event, a read-only agent
(`apollo`, `gaia`) registers its session, and the shared
`createEnforcementGuard` throws to deny `edit`, `write`, `bash`, `task`,
`hashline_edit` and `pantheon_model`. It does **not** rely on the V1
`tool.execute.before` hook, which lives in `src/plugin.ts` and is not loaded
when only `plugin-v2` is configured. The companion `execute.after` hook and the
`permission.evaluate` hook are registration points with no V2-side behaviour,
and the V1 caller/target delegation matrix for native `task()` is not enforced
on V2.

Every V2 tool declares an `output` schema. OpenCode 2.0.x requires the
declaration and the resolved result to agree in both directions, so an
undeclared tool — or one that returns `output` without declaring it — fails on
every call. Unsupported V2 features are `legacy-hooks` (the V1-specific hook
surface), `catalog-transform`, `integration-transform`, `skill-transform` and
`goal-tools`.

The package exposes both contracts as importable exports: `pantheon-opencode/plugin`
(V1), `pantheon-opencode/plugin-v2` (V2) and `pantheon-opencode/v2-bridge`
(optional interop), so a host can load either contract explicitly.

The V1→V2 bridge (`src/pantheon/v2-bridge.ts`) enables optional interop:
V1 infrastructure singletons (BackgroundJobBoard, GoalStore,
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

The `pantheon_cost` report resolves its database by PATH, in this order: an
explicit `dbPath` supplied by the tool caller, then
`PANTHEON_COST_DB=/absolute/path/to/opencode.db`, then `OPENCODE_DB`, then the
XDG default `opencode.db`. There is no per-version filename in that chain:
`opencode-v2.db` is not a host 2.x database — it is the name a sandbox gives
its own state database through `OPENCODE_DB`.

The v1/v2 distinction is the DETECTED SCHEMA, not the file name. The report
looks for the `message` and `session_message` tables and reads whichever the
open database actually holds, because a migrated database carries both
families at once. `PANTHEON_OPENCODE_VERSION=v1|v2` selects no file: it only
narrows an already-detected set to one table family, and fails fast when the
value is neither `v1` nor `v2` or when the requested family is not there. Left
unset, every detected family is read. A database carrying neither table comes
back as an actionable error (`CORRUPT_DATA`), and a ledger that exists but
yields no readable tokens as `UNSUPPORTED` — never as a successful empty
report.

The installer still writes the compatibility settings required by the selected
OpenCode host, such as `experimental.subagent_depth`; this does not convert a
V1 plugin into V2 or provide V2 with V1 hooks.

Pantheon does not set a step ceiling on agents. On OpenCode 2 the `steps`
field is optional and has no default: absent means the host applies no native
limit. A config written before this change still carries the old value, and the
V2 install path strips it from every agent Pantheon manages — an agent you
define yourself is never touched, and the retiring V1 singular `agent` block
is left alone. Run the installer once to clear a stale value from an existing
config:

```bash
npx pantheon-opencode init --opencode-version=v2
```

Context control is not a Pantheon setting. Whatever budget an agent runs
against comes from the compaction settings of the OpenCode host you are
running, and Pantheon does not define them.

When a V1 `agent` block and a V2 `agents` block are both present — which is
what an installed `opencode.json` carries — the V1→V2 conversion merges them
instead of letting one replace the other. The V2 block is the base, the
framework-managed fields from the V1 block overwrite, and your own fields are
preserved, matching the precedence the installer already applies elsewhere.
Key order does not matter.

## Updating between releases (beta.5+)

One command keeps an existing installation current:

```bash
# Without a global install, ALWAYS pin the dist-tag — plain `npx
# pantheon-opencode` resolves `latest`, which is the stable release (1.4.3):
npx pantheon-opencode@beta update            # npm beta channel + config refresh
npx pantheon-opencode@beta update --stable   # stable channel instead

# With a global install, use the global bin (defaults to the beta channel):
pantheon-opencode update
```

`update` compares your installed version with the npm dist-tag, runs
`npm install -g pantheon-opencode@<channel>`, then re-runs `init --yes
--headless` so config merges, the venv and MCP entries match the new package.
Two freshness guarantees back it up:

- **Postinstall artifact sync** — after any `npm install`, copy-only artifacts
  (agents, skills, AGENTS.md, commands, MCP scripts, code-mode payload) are
  refreshed into the existing config dir automatically; you never have to
  re-run `init` just for file copies.
- **Drift detection** — the installer stamps the installed version in
  `.pantheon/install-state.json` and `doctor` warns when the package is newer
  than the last sync, pointing at `update`. `doctor` also detects **plugin
  version drift** (issue #158): when `opencode.json` registers a plugin path
  inside a `node_modules/pantheon-opencode` copy whose `package.json` version
  differs from the running package, it warns that the registered tool surface
  is stale. Re-running `init`/`update` realigns the registration onto the
  current package.

`init` also gained `--components agents,skills,...` (narrow install),
`--clean` (alias of `--force`), `--opencode-version auto`, atomic config
writes with an `opencode.json.bak` backup, preflight checks for python3/npm
before any file is written, and a non-fatal Python runtime: if the venv fails,
the install completes but MCP entries are omitted (with a warning) instead of
pointing at a broken interpreter. Installer messages auto-detect pt-BR via
`LANG`/`LC_ALL`.

## Migrating to 1.5.x (from 1.4.x)

1.5.0 removed the custom `pantheon_delegate` tool (and the V1 delegation
engine) in favor of OpenCode's native `task()`; see
[Delegation (native `task()`)](#delegation-native-task). Two things change on
an existing install:

1. **The tool disappears from the plugin surface.** `pantheon_delegate` is no
   longer registered by `src/plugin.ts` or `src/plugin-v2.ts`. Agents now
   delegate through `task()` only — no configuration is needed.
2. **A lockfile-pinned copy can keep the old tool alive.** `npm install` is
   lockfile-authoritative: a `package-lock.json` pinned to `1.4.1` (which
   satisfies `^1.4.1`) is never re-resolved, so a project's
   `node_modules/pantheon-opencode` can stay on 1.4.x while the published
   package moved on. The plugin path your `opencode.json` registers keeps
   pointing at that stale copy, and you keep running the obsolete tool surface
   — including `pantheon_delegate` — with no warning.

The fix is a realignment + a detector:

```bash
# Realign the registered plugin path onto the current package (rewrites any
# node_modules/pantheon-opencode reference in opencode.json):
npx pantheon-opencode@latest init --yes --headless
# or, with a global install:
pantheon-opencode update

# Then verify no drift remains:
npx pantheon-opencode@latest doctor
```

`doctor` now reports a **Plugin Version Drift** warning (section H3) when the
registered plugin points into an installed copy whose version differs from the
running package, naming both versions and the removal (`pantheon_delegate` in
1.5.0). A healthy install reports no warning.

## Releases

Publication is authorized **only** by an explicit `workflow_dispatch` of the
`Release` workflow (`release_channel` input selects beta or stable). PR labels,
pushes, merges, and tags never publish anything, and every validation gate is
fail-closed: only an explicit PASS authorizes release evidence. See
[docs/RELEASING.md](docs/RELEASING.md) for validation and recovery details.

Release validation keeps each manifest with its lockfile: the root
`package.json` + `package-lock.json` and the TUI
`src/plugins/tui/package.json` + `src/plugins/tui/package-lock.json`. Both use
`npm ci --ignore-scripts`; an `npm ci` failure blocks the run and there is no
`npm install` fallback. A release carries one `.tgz` tarball, computes the
SHA-256 of that same artifact, and binds the tarball and GitHub release to the
full `TARGET_SHA`; a second pack is not interchangeable.

## Sandbox validation (V2)

`scripts/test-opencode-v2-sandbox.sh` validates the globally installed
package as a real user inside an isolated sandbox (own `HOME`, npm prefix and
venv) — never the dev environment. It checks the OpenCode V2 leg: the binary,
MCP connectivity, `doctor`, and — with `--prompts` — a prompt battery covering
the `pantheon://agents` resource, memory store/recall, filesystem writes and
agent delegation. The gate is fail-closed: every required check must return an
explicit PASS; timeouts, auth/network/provider failures and missing
prerequisites block the run.

"V2" here refers only to the hook canary observed against an OpenCode v2.0.18
host, where at least one tested hook callback fired; it does not establish
compatibility with the stable `@opencode/plugin@2.0.18` SDK or full 2.x
contract. This branch still pins transitional `@opencode-ai/plugin@1.18.30`.
On hosts where both `opencode` and `opencode2` exist, the latter is typically
a shim that execs the same binary, so an older side-by-side comparison proved
nothing about the binary itself. The project is V2-exclusive, so there is a
single leg.

```bash
scripts/test-opencode-v2-sandbox.sh --prepare     # tarball + install + init in the sandbox
scripts/test-opencode-v2-sandbox.sh --run v2      # base validation only
scripts/test-opencode-v2-sandbox.sh --prompts     # base validation + prompt battery
scripts/test-opencode-v2-sandbox.sh --rehydrate   # offline context rehydration/session-summary probe
scripts/test-opencode-v2-sandbox.sh --hooks       # V2 hook callback canary
scripts/test-opencode-v2-sandbox.sh --rehydrate --hooks # run both canaries
scripts/test-opencode-v2-sandbox.sh --reset       # wipe the sandbox root
```

Modes are combinable (e.g. `--prepare --run v2 --prompts`). `--rehydrate` runs
offline `context_rehydrate` and `context_session_summary` probes. `--hooks` runs
a V2 hook canary against the sandbox binary to check that hook callbacks fire;
it does not test transform callback effects or prove Pantheon's
`execute.before` security enforcement. With the probe-only `--rehydrate --hooks`
pair (without `--run`, `--prompts`, or `--cost`), the hooks canary still runs if
rehydration fails, and the command returns a failing status afterward. These
are test/sandbox canaries, not proof of Pantheon security enforcement. Binaries
are resolved strictly inside the sandbox npm prefix — a non-prepared sandbox
fails fast instead of silently testing the host installation. The sandbox is
always built from the checkout this script lives in; it never infers a
repository from a sibling directory.

This validates the prepared isolated sandbox only. A PASS is not proof of
support for every real host or for host configurations that were not exercised.

## Plugin V2 TypeScript coverage

`npm run coverage:plugin-v2` runs the `tests/pantheon/*.test.ts` suite with
Node's source-mapped native coverage and enforces an 80% line-coverage minimum
for `src/plugin-v2.ts` only. It requires Node `v24.15.0`; branch and function
coverage are reported but are not gates. This is not a repository-wide coverage
claim.

Env overrides:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PANTHEON_SANDBOX_ROOT` | `~/pantheon-sandbox` | Sandbox root (refused if unsafe for `--reset`) |
| `OPENCODE_V1_SPEC` | `opencode-ai@1.18.18` | Configures the V1 plugin only; the V2-only sandbox runner does not consume or support it |
| `OPENCODE_V2_SPEC` | `@opencode-ai/cli@beta` | npm spec providing the `opencode2` binary |
| `PANTHEON_SANDBOX_MODEL` | `opencode-go/mimo-v2.5` | Model used by init and prompts |
| `PANTHEON_PROMPT_TIMEOUT` | `300` | Per-prompt timeout in seconds |

Exit codes: `0` no real failures · `1` real failure (see `prompts-report.md`
in the sandbox root) · `2` usage error · `3` sandbox not prepared.

### Intentional memory MCP divergence

`scripts/memory_mcp_server.py` and `src/mcp/memory_mcp_server.py` are
intentionally different. The standalone `scripts/` copy keeps the lightweight
`memory_*` contract; the installed `src/mcp/` copy additionally exposes the
optional codemap schema and `code_index`, `code_query`, and `code_neighbors`.
The other shared MCP copies remain identical. Do not overwrite one memory copy
with the other.

### Task-result guard

A `task-result-guard` intercepts calls to the native `task()` tool where the
child session returns an empty or missing result. Instead of surfacing a silent
`completed` with no payload (which confuses the orchestrator), the guard now
raises an explicit error. This catches the common free-tier failure mode where a
child session exceeds the uncached-prefill token budget (`BackendAdmissionRejected`)
and returns nothing. Prefer `background=true` dispatches with an explicit
`task_status(wait=true)` fan-in so large payloads are collected deterministically.


## Configuration (environment variables)

The `pantheon-memory` MCP server needs no configuration: search is SQLite FTS5
(BM25) only, all stdlib, with no embedding model, no vector index, and no
`sqlite-vec`/`fastembed` dependency. Other environment variables are documented
in the sections above.


## Documentation

### Local evaluations

Promptfoo/evaluation experiments are local-only: place them under
`evals/promptfoo/`, which is gitignored and excluded from npm packaging,
package evidence, CI tests, coverage, and release gates. Publish reviewed
findings as documentation, not the local harness, datasets, outputs, or
credentials.

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

Pantheon is released under the [MIT License](LICENSE). Cite the
[Zenodo concept DOI](https://doi.org/10.5281/zenodo.22650136), which always
resolves to the latest archived release; each release also has its own version
DOI. Citation metadata is also available in [CITATION.cff](CITATION.cff).

Canonical repository: <https://github.com/ils15/pantheon-opencode>

---

[Leia em português (Brasil)](README.pt-BR.md)
