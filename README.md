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
- **Right-sized coordination:** bounded work goes to the correct specialist;
  planning, discovery, parallel work, and review are added when scope and risk
  call for them. `/pantheon-deepwork` remains the checkpointed workflow for
  heavy multi-phase work.

## Start in 2 minutes

Requirements: [OpenCode 1.18.4+](https://opencode.ai/docs/) and Node.js
26.4.0+ for the Pantheon CLI, installer, and Node-based tooling. For which
OpenCode generation each Pantheon release line supports, see
[Compatibility and support policy](#compatibility-and-support-policy).

Pantheon declares `engines.node` as `>=26.4.0`; Node 22, Node 24, and Node
26.0–26.3 are not supported by this release. This package floor does not imply
that every OpenCode host runs on Node: official OpenCode V2.0.31 has a Bun
runtime path and a separate Node build pinned to Node 26.4.0. No Bun minimum is
asserted here. The optional `pantheon_cost` SQLite backend has its own capability
threshold, `node:sqlite` on Node >= 22.5; that feature threshold does not lower
Pantheon's package or CLI support floor.

With npm's default configuration, an unsupported Node version may produce an
`EBADENGINE` warning during install. Pantheon's postinstall then skips Node-based
sync without changing OpenCode configuration, and the CLI itself exits with a
clear error before setup. If needed, switch using a user-managed version
manager—no system-wide install is required:

```bash
nvm install 26.4.0 && nvm use 26.4.0
# or: fnm install 26.4.0 && fnm use 26.4.0
# or: volta install node@26.4.0
```

From the project where you want to use Pantheon:

```bash
npx pantheon-opencode init
opencode
```

In a TTY, the interactive setup uses Clack prompts to choose components and a
global or project location before reviewing the apply. Canceling writes nothing.
`--yes`, `--headless`, `--dry-run`, and non-TTY workflows retain their existing
behavior. The installer guides you through the available setup. For optional MCP servers,
project-local installation, or non-interactive setup, see the
[installation guide](docs/INSTALLATION.md).

In the interactive **V1 model setup**, the profile choices are **Inherit**,
**OpenCode Go**, **OpenAI**, and **Anthropic**. OpenCode Go saves the internal
`go-hybrid` profile (premium routes for Zeus, Athena, Themis, and Hephaestus;
the existing fast Go routes for the other agents). Anthropic uses
`anthropic/claude-sonnet-5-5`; configure `ANTHROPIC_API_KEY` in your environment
yourself. The installer does not read or validate API keys or contact provider
catalogs. Legacy `go-free`, `go-fast`, and `go-premium` presets remain available
for existing saved settings and explicit `--preset` use. V2 continues to ignore
static presets and uses explicit per-agent model overrides instead.

In an interactive TTY setup summary, Pantheon recommends the persistent
external worktree location
`<project-parent>/.pantheon-worktrees/<exact-repository-directory-basename>/<task>`
(for example, `/home/user/.pantheon-worktrees/My Project/feature-name`). Use the
project directory's exact basename, including spaces; do not normalize it into
a slug. This is guidance for future agent work only; Pantheon does not create
Git worktrees or directories automatically. See the shipped
[worktrees skill](src/skills/worktrees/SKILL.md) for the agent workflow.

A non-interactive apply requires `--yes` (alias `-y`): without a TTY and
without `--yes`, `init` prints the change plan and applies nothing. Exit codes:
`0` success or plan/no-apply, `1` failure, `2` apply requested without
authorization, `3` drift (a planned target changed before apply), `130` canceled.

Preview with `init --dry-run`. To review and apply across separate invocations,
save a versioned plan and then explicitly authorize it:

```bash
npx pantheon-opencode init --dry-run --project --no-mcp --components agents \
  --save-plan .pantheon-install-plan.json
npx pantheon-opencode init --apply-plan .pantheon-install-plan.json --yes
npx pantheon-opencode init --dry-run --json  # machine-readable preview on stdout
```

Saved plans use mode `0600`, contain operation metadata and fingerprints rather
than generated file contents, and are bound to their original target and plan
file path. Applying rechecks the package source and destination snapshots; drift
aborts before writes. Saved plans do not support `--force`/`--clean`, and
machine-readable previews reject those options because clean performs bulk removal.
A dry-run skips probing the OpenCode host to avoid host-side writes; when no version hint
is configured, it assumes V1 and reports that advisory. Pass
`--opencode-version v1|v2` to preview a specific generation.
Saving an artifact is supported on Linux, Darwin, FreeBSD, OpenBSD, and NetBSD
when the required descriptor paths and filesystem flags are usable. Cross-platform
behavior has not been fully tested; unsupported platforms fail closed rather
than risk writing through a replaced parent directory.
Previews describe managed-file operations, not every bulk or external effect
(such as Python environment setup). The `postinstall`/`sync-tui` step also only
refreshes TUI artifacts and is outside this approval flow.

Before the first managed-file write, `init` saves an exact backup set under
`.pantheon/backups/<timestamp>/` (directory `0700`, files `0600`, the 5 most
recent kept); it is a byte-for-byte copy and therefore also contains any API
keys or tokens already present in your files — it is never printed. Recover with
`pantheon-opencode restore [--project] [--yes]`. There is no automatic rollback;
an interrupted apply is recoverable from the backup in the same way.
To remove Pantheon-managed files, review with
`pantheon-opencode uninstall --project --dry-run` (or `--global`) before applying
with `--force`. The opt-in `--purge-data` removes only a verified install-state
file and never removes recovery backups; see the installation guide for details.
New installs also record a versioned per-file ownership inventory. Review stale,
unchanged installer-owned files with `pantheon-opencode reconcile --project --dry-run`
(or `--global --dry-run`); preview is read-only, and apply requires `--apply --yes` or a
saved reviewed plan. Legacy files without inventory, modified files, and
symlinks are preserved for manual review. An explicit `--target PATH` uses project
layout; combine it with `--global` to select the flat global layout. See the
[installation guide](docs/INSTALLATION.md).
The bundled Python MCP servers use the pinned MCP SDK 2.2.0 and standalone
FastMCP 4.0.10 runtime; see the [MCP guide](docs/MCP.md).
The installer also turns each agent's `mcp_tools` allowlist into native
per-agent permissions for OpenCode V1 and V2; see the
[agent MCP reference](docs/AGENT-MCP.md).

## A simple example

Once OpenCode is running, describe the outcome you want:

```text
/pantheon Add CSV export to the reports page, including tests and a review.
```

Pantheon helps turn that request into a plan and a sequence of reviewed steps.
When you ask for a plan or start `/pantheon-deepwork`, Athena returns the full
plan to Zeus, who displays it in the main conversation before asking for
approval. The approval prompt will not point to a plan hidden in a child-agent
conversation.

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

Memory is used selectively: the coordinator searches once only when project
history could affect a task, then passes relevant results to specialists. Store
one concise, reusable outcome at task completion when it will matter later;
routine child summaries and phase updates stay in the current handoff. The
session-checkpoint tools are separate, optional persistence APIs and are not
called automatically by compaction hooks. See [Memory usage](docs/MEMORY.md).

## Status

Candidate version: the manifests in this checkout express the version being
prepared, not a confirmed publication. A beta is published only after the
Release workflow completes successfully. To check which version is actually
published, consult the npm `beta` dist-tag. Pantheon is designed for OpenCode
and depends on the availability and configuration of OpenCode and any optional
services you choose to use. Check the
[releases](https://github.com/ils15/pantheon-opencode/releases) and
[changelog](CHANGELOG.md) for the latest published changes.

## Compatibility and support policy

> ### ⚠️ 1.6.x is the LAST line that supports OpenCode 1.X
>
> **OpenCode 1.X support ends after the 1.6 line.** From **1.7 onward, every
> release is a breaking change targeting OpenCode 2.** A 1.6.x install is the
> last one that runs on an OpenCode 1.X host; do not plan an upgrade across the
> 1.6 → 1.7 boundary while your host is still on OpenCode 1.X.

| Pantheon line | OpenCode 1.X host | OpenCode 2 host |
|---|---|---|
| **1.6.x** (current line) | **Supported.** V1 plugin contract | Supported, reduced surface — V2 contract |
| **1.7 and later** | **Not supported.** Breaking change | Target of the 1.7+ work |

Both columns of the 1.6.x row are real, and they are not the same claim. Read
[the plugin contract](#opencode-v1v2--dual-version-160-beta1) for what each
generation actually registers.

### What "supported on OpenCode 1.X" concretely means

On the 1.6 line, an OpenCode 1.X host gets the **V1 plugin**:
`src/plugin.ts` plus `src/plugins/pantheon-hooks.ts`, registered under the
singular `plugin` config key. That surface registers 6 tools
(`hashline_edit`, the 3 `pantheon_goal_*` tools, `pantheon_cost`,
`pantheon_model`), the BackgroundJobBoard lifecycle, the V1 event/tool hooks and
the V1 compaction path. It is selected automatically: the generation gate
(`--opencode-version`, else `OPENCODE_VERSION`, else a `OPENCODE_BIN` basename of
`opencode2`, else a `--version` probe where major ≥ 2 selects V2) resolves a 1.X
host to V1.

The two generations are exclusive. The installer strips Pantheon references from
both config shapes and registers only the selected one, so a 1.X host never
loads the V2 plugin and a V2 host never loads the V1 plugin. Forcing V2 on a 1.X
host is an unsupported mixed/wrong-generation configuration, not a supported mode.

### What the OpenCode 2 path is — and is not

**Not inert.** The V2 path (`src/plugin-v2`, registered as a directory because
the V2 loader rejects bare file paths) registers real tools with real
`input`/`output` schemas via `ctx.tool.transform()`, 5 event subscriptions,
session hooks and tool/permission hooks that enforce read-only sessions and the
caller→target delegation matrix. The matrix applies only to Pantheon-managed
targets: Zeus may delegate to any registered agent; Athena and Hermes may target
Apollo only; other Pantheon callers and unknown callers are denied. Child
sessions cannot delegate to Pantheon agents. Calls between native/custom agents
remain under host permissions. The V2 path never adds an allow grant or
overrides an explicit host deny; missing or mismatched identity fails closed
for the attempted Pantheon delegation. The 3 goal tools remain unsupported and
are reported as `goal-tools`.

When the host successfully registers V2's permission hook, Pantheon does not
trust `permission.evaluate.agent` by itself for a Pantheon target. It matches
the permission source's session, message and tool-call IDs to a short-lived
record from the host's `tool.execute.before` event, then requires the host
session to have no `parentID` before applying the matrix. This admits valid
root dispatches and denies child-session dispatches; missing, stale, replayed
or mismatched origins are denied. OpenCode v2.0.29 runtime evidence is in
[`bench/results/f4a-v229-admission-identity-2026-10-14.md`](bench/results/f4a-v229-admission-identity-2026-10-14.md).

**Partial, with the exercised host version made explicit.** The V2 tool canary
started against `opencode 2.0.22`, a version that no npm channel publishes.
The current F4A rerun now uses the installable **OpenCode v2.0.29** binary and
passes 18/18 checks with permission probes: the real plugin registers and runs
its tools, admits the valid Zeus→Apollo root dispatch, rejects an invalid edge
before child creation, and rejects a matrix-valid dispatch from a child. The
remaining V2 surface still has unsupported goal tools and registration-only
session/compaction hooks, so the 1.6 line is not full V2 feature parity.

### Verified against which OpenCode versions

| What | Verified against | How |
|---|---|---|
| V1 plugin + generation gate | The OpenCode 1.18.x line. This package pins `@opencode-ai/plugin` and `@opencode-ai/sdk` to `1.18.33`; the highest published `opencode-ai` host package (the one shipping the `opencode` binary) is `1.18.34` | Dependency pin (`package.json`); generation-gate unit tests over injected host banners; installer end-to-end tests asserting the emitted `opencode.json` shape |
| V2 plugin tool surface | OpenCode v2.0.29 | `tests/canary/plugin-v2-tool-canary.test.mjs`, driving the real plugin through `opencode serve`; F4A permission canary passes 18/18 |
| V2 native subagent admission | OpenCode v2.0.29 | `tests/canary/run-v2-permission-proof.sh`; identity, root/child checks and permission-before-child ordering are recorded in [`bench/results/f4a-v229-admission-identity-2026-10-14.md`](bench/results/f4a-v229-admission-identity-2026-10-14.md) |
| Exact 1.X host version the 1.6 line is exercised against end-to-end | **Unverified.** No V1 host leg exists: the sandbox runner is V2-only and `--run v1` is rejected | — |

## Delegation (root `subagent`; host/API `task()`)

The host's child-session engine is referred to as native `task()` in API and
implementation documentation. In the user-reported Beta 10 Zeus-root runtime,
the callable dispatch tool was `subagent`; `task()` was not exposed as a root
tool. Treat the API name and examples below as host/API terminology, not a
guaranteed root-tool name or signature. The active runtime determines the
`subagent` schema, background options, and completion observability. The former
custom `pantheon_delegate` tool and the V1 delegation engine (`delegation.ts`,
`delegate-manager.ts` and supporting modules) were removed; there is no
Pantheon-specific delegation tool surface to configure. See
[ADR-0011](.pantheon/memory-bank/adr/0011-delegation-engine-contract.md) for the
historical engine contract.

This beta.8 candidate combines native per-agent MCP permissions for OpenCode V1
and V2, V2 delegation-permission alignment, simpler memory/compression
instructions, and a sandbox check that proves the installed package matches
this checkout instead of silently accepting stale npm-cached code. The isolated
sandbox launcher also pins the OpenCode background service to its dedicated
loopback port, rather than colliding with another OpenCode installation. The Zeus
prompt reuses one task-start memory-search result for context and routing;
runtime call counts and latency have not been measured. A beta.7 V2 dispatch
failed because the permission hook passed a bare string to `ctx.session.get`
instead of the V2 input object `{ sessionID }`; beta.8 corrects the call and
adds contract tests for the success and failure cases. The user subsequently
reported a successful Hermes liveness delegation in the active session, but
freshly restarting and testing the beta.8 sandbox remains the end-to-end gate.
The original report also included a separate `GET /api/session/{id}/permission`
404; the session ID exists in the beta7-candidate database but not the default
global database. Both OpenCode services were running, so the 404 in the global
log may come from the other instance; this remains an end-to-end verification
item.

Delegated work gets at most one retry after an initial transient failure. If no
completion/status tool is exposed, prefer synchronous `subagent` dispatch or
wait for a host-provided completion notification; do not assume polling,
cancellation, job tracking, or board-based recovery. If the runtime does not
make completion observable, report that limitation. The configured fallback or
escalation chain still applies.

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
| `PANTHEON_NODE` | `node` from `PATH` | Path to a Node.js >= 22.5 binary used only for the `node:sqlite` capability in the CLI fallback; this is not the Pantheon package support floor. An explicit path must exist and be executable, otherwise the tool fails fast instead of ignoring the override |

Tool interpretation matters: `pantheon_model status` reports configuration, not the model serving a completion. V2 manual model overrides are project-only; global override files are neither read nor applied, and global mutation is unsupported until a future surface can obtain separate explicit human authorization. V2 ignores static presets and applies only explicit per-agent project model/variant overrides, leaving the host default unchanged otherwise; V1 preset behavior remains legacy pending compatibility decisions. `pantheon_cost` is a rolling token aggregate, not a session-level or monetary cost report. See the [OpenCode plugin tool notes](docs/mcp-tools.md#opencode-plugin-tools) for details and measurement limits.


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
| Runtime contract | Pantheon V1 plugin: 6 tools (`hashline_edit`, the 3 goal tools, `pantheon_cost`, `pantheon_model`), event/tool hooks and V1 compaction handling | Full V2 plugin: 3 orchestration tools plus `vision_describe` when the model catalog is available, 5 event subscriptions, session hooks (`prompt`, `context`), a read-only-enforcing tool `execute.before` hook, plus configuration transforms |
| V1 APIs | Registered | Own tool definitions via `ctx.tool.transform()` — not the V1 plugin path |

The V2 plugin provides 3 orchestration tools (`hashline_edit`, `pantheon_cost`,
`pantheon_model`), 5 event subscriptions (`session.created`, `session.idle`,
`session.deleted`, `session.error`, `session.compacted`), session hooks
(`prompt`, `context`),
and a tool `execute.before` hook that enforces read-only sessions. The 3 goal
tools are **not**
registered on V2: the goal loop needs a `GoalStore`, a `GoalLoopClient` and a
`BackgroundJobBoard`, none of which the V2 `PluginContext` exposes, so the gap
is reported as the `goal-tools` unsupported-feature marker. Use the V1
contract if you need the goal loop.

V2 also registers `vision_describe` when `ctx.model.list()` is available. It
checks the live catalog for image input, prefers the paid OpenCode Go
`opencode-go/mimo-v2.6-flash` model (free-tier models are excluded from automatic
selection — the direct gateway rejects them with HTTP 403, they only work from
inside OpenCode; an explicit `PANTHEON_VISION_MODEL`/config/preset pin is still
honored, so its 403 surfaces as an actionable error rather than a silent
substitution), and
sends the image directly to the authenticated OpenCode Zen endpoint. The request
carries the live session id as the Zen-only `x-opencode-session` header the
gateway requires (never sent to a non-Zen provider, and never logged). OpenCode
credentials come from
`opencode auth login` or `PANTHEON_OPENCODE_API_KEY`; if no supported model or
credentials are available, the tool returns an explicit error instead of a
fabricated description. This path works without the optional V1 bridge.
The V2 prompt hook also preserves image attachment references and tells Zeus
to inspect relevant visual context and pass the reference plus concise findings
to Aphrodite. Inline image bytes are not copied into persisted prompt text, and
an image does not authorize deleting or reverting unrelated work.

The chat-turn native path picks its vision model in a fixed precedence: the
`PANTHEON_VISION_MODEL` env var, then `visionModel` in `opencode-vision.json`,
then the active preset's `vision.model`, then automatic discovery in the host
provider catalog (`GET /config/providers`), then the built-in default. Discovery
is conservative and paid-only: it keeps only image-capable entries
(`capabilities.input.image`) whose provider is a trusted Zen provider or whose
`npm` package is OpenAI-compatible (`@ai-sdk/openai-compatible` /
`@ai-sdk/openai`), EXCLUDES free-tier entries (`-free` id or `cost.input <= 0`
— the direct gateway rejects them with HTTP 403), picks the cheapest remaining
entry, and caches the catalog for 60
seconds per process; an incompatible model simply falls through to the vision
MCP tool. The base URL comes from the catalog entry's `api.url`, and the legacy
Zen endpoints remain the no-catalog fallback. Credentials follow the endpoint:
for a Zen endpoint the shared `PANTHEON_OPENCODE_API_KEY` / `OPENCODE_API_KEY`
env keys are tried first, then the OpenCode auth store (the resolved provider
first, then the legacy `opencode-go` / `opencode` entries); for a non-Zen
endpoint only that provider's own auth-store entry is used — the shared env keys
and the legacy Zen entries are never attached to a non-Zen base URL. An
explicitly configured, qualifying vision model always wins over discovery — a
pin that does not qualify (non-Zen, text-only, or absent from the catalog) is
discarded and the automatic selection takes over. `pantheon-opencode init`
offers an optional vision step in interactive TTY sessions — automatic discovery
is the default and writes nothing; pinning merges `visionModel` into the global
`opencode-vision.json`; non-interactive runs never prompt and never write.
The `/pantheon-vision` command adds a model picker: `vision-status.mjs --list`
enumerates image-capable candidates — labelling whether the source is the live
host catalog or an offline `opencode models` heuristic, plus `free`/`paid` and
credential presence per provider (never the token) — and `--set` pins the chosen
`provider/model` with the same atomic merge.

The user's question is injected into the vision prompt on both the native and V2
paths, trimmed and capped at 2000 characters; the same image asked a different
question gets a fresh description, while an identical re-ask inside the cache
TTL reuses the stored text. Native describes are robust by design: the timeout
scales from a 20-second base at roughly 10 seconds per MB of payload up to a
300-second ceiling, and a zero-dependency EXIF-orientation check (JPEG) adds a
textual hint so the vision model describes a rotated or mirrored image upright —
detection only, pixels are never rewritten, and the orientation is folded into
the cache key.

Vision degrades through an explicit chain — native → vision MCP tool → local.
When native is unavailable and the vision MCP tool is absent, the image is
replaced by deterministic local extraction: dimensions, format and size from the
PNG/JPEG/GIF/WebP header, dominant colors for RGB/RGBA PNG, and OCR only when a
`tesseract` binary is on `PATH`. It never fabricates content — the degradation is
stated explicitly. The `vision_describe` and `vision_ocr` MCP tools degrade to
that local mode when no gateway credential is configured, with no new
dependencies. (`vision_analyze` requires a gateway credential and returns an
explicit error instead.)
Deliberate trade-offs, recorded so they are not reversed by accident: Pantheon
describes each image once and keeps the text in history (council 2026-08-03)
rather than preserving the original image for per-turn re-observation;
describe-always favors zero added latency over an on-demand `describe_image`
tool. Multi-turn sanitization (`experimental.chat.messages.transform`) is a
mandatory invariant — it guarantees `image_url` / `FilePart` payloads never
reach a text-only provider and is not configurable. Bifrost stays opt-in and
never the default, per the credential incident in [SECURITY.md](SECURITY.md).

The V2 `execute.before` hook is the read-only enforcement point for that
surface: the host includes the active agent on the event, a read-only agent
(`apollo`, `gaia`) registers its session, and the shared
`createEnforcementGuard` throws to deny `edit`, `write`, `bash`, `task`,
`hashline_edit` and `pantheon_model`. It does **not** rely on the V1
`tool.execute.before` hook, which lives in `src/plugin.ts` and is not loaded
when only `plugin-v2` is configured. When the host registers the
`permission.evaluate` hook, it enforces the V2 caller/target matrix for
Pantheon-managed native `subagent` requests. If hook registration is
unavailable, the matrix is unavailable and the host remains in control.
Native-only resources pass through unchanged to OpenCode's permission policy;
mixed native/Pantheon and multi-target requests are denied. Pantheon matches
the permission source's session, message and tool-call IDs to a short-lived
record from `tool.execute.before`, cross-checks the captured host caller against
`permission.evaluate.agent`, and confirms the session has no `parentID`.
`permission.evaluate.agent` alone is not trusted because
`ctx.permission.assert` accepts a caller-supplied agent. Missing, stale,
replayed or mismatched origins fail closed, and explicit host denies remain
final. On OpenCode v2.0.29, a runtime canary admits Zeus→Apollo from a root,
denies a matrix-valid Athena→Apollo call from a child and rejects an invalid
edge before child creation; see the
[`F4A evidence`](bench/results/f4a-v229-admission-identity-2026-10-14.md).
V2 `execute.after` runs the completed-result chain:
`task-result-guard` → `context-sandbox` → `read-enhancer`.

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

`auto` is the default. `--version v1|v2|auto` is accepted as the older
selector spelling when used after `init`. `auto` resolves the generation from
the host in this order: an explicit `OPENCODE_VERSION=v1|v2` wins; otherwise an
`OPENCODE_BIN` path ending in `opencode2` selects V2; otherwise the host
binary is asked for its `--version` and a major of 2 or more selects V2. Every
other case — an unreadable probe, an unparseable banner, or a banner whose
version-like tokens contradict each other with no tool name to break the tie —
warns once and falls back to V1, because a plural `plugins` directory entry on
an unknown 1.x host loses the plugin entirely.

The probe prefers the token that follows the tool name, so a runtime token
ahead of it (`node v22.1.0 (opencode 1.18.33)`) or a trailing build date
(`opencode v1.18.33 built 2026.10.04`) cannot flip the generation. The
installer removes Pantheon references from both config shapes before writing
only the selected Pantheon registration. Third-party entries are not converted
or claimed by this rule.

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

> **Read [Compatibility and support policy](#compatibility-and-support-policy)
> before upgrading across a line boundary.** 1.6.x is the last line that
> supports an OpenCode 1.X host; 1.7+ is breaking-change territory targeting
> OpenCode 2. Within the 1.6 line, `update` is the supported path.

One command keeps an existing installation current:

```bash
# Install globally first; update refuses local, workspace, and npx copies.
npm install -g pantheon-opencode@beta
pantheon-opencode update            # npm beta channel + config refresh
pantheon-opencode update --stable   # stable channel instead
```

`update` compares your installed version with the npm dist-tag, runs
`npm install -g pantheon-opencode@<channel>`, then re-runs `init --yes
--headless` so config merges, the venv and MCP entries match the new package.
Two freshness guarantees back it up:

- **Postinstall artifact sync** — after any `npm install`, copy-only artifacts
  (agents, skills, AGENTS.md, commands, MCP scripts, code-mode payload) are
  refreshed into the existing config dir automatically; you never have to
  re-run `init` just for file copies. The global config dir receives the
  repo-agnostic **global artifact** (`AGENTS.global.md`: agent table + shared
  rules), while each project's own `AGENTS.md` carries only project-specific
  setup — the two are carved to be disjoint (beta-10 latency work), so no rule
  is paid for twice per session. Installs are conservative: content outside
  the generated managed region (user house rules) is preserved verbatim, a
  legacy fully-generated `AGENTS.md` upgrades in place, and any merge is
  reported with a warning.
- **Drift detection** — the installer stamps the installed version in
  `.pantheon/install-state.json` and `doctor` warns when the package is newer
  than the last sync, pointing at `update`. `doctor` also detects **plugin
  version drift** (issue #158): when `opencode.json` registers a plugin path
  inside a `node_modules/pantheon-opencode` copy whose `package.json` version
  differs from the running package, it warns that the registered tool surface
  is stale. Re-running `init`/`update` realigns the registration onto the
  current package.

`init` also gained `--components agents,skills,...` (narrow install),
`--clean` (alias of `--force`), `--opencode-version auto`, preflight checks for
python3/npm before any file is written, and a non-fatal Python runtime: if the
venv fails, the install completes but MCP entries are omitted (with a warning)
instead of pointing at a broken interpreter. Before the first modifying write,
`init` preserves, byte-for-byte, every regular file it can modify or remove
inside the config dir (including files a `--clean` run deletes) under
`.pantheon/backups/<timestamp>/` (directory `0700`, files `0600`, kept 5 deep);
bulk directories
(`.venv`, the plugin's `node_modules`) and out-of-target global files
(`tui.json` copies elsewhere, the global `opencode-vision.json`) are listed in
the manifest as `notRevertible` rather than silently omitted. The exact-set
warning is printed once and never echoes file contents. Restore with
`pantheon-opencode restore [--project] [--yes]` (the old `opencode.json.bak`
sidecar is gone; the global vision config keeps its own `.bak`). Installer
messages auto-detect pt-BR via `LANG`/`LC_ALL`.

## Migrating to 1.5.x (from 1.4.x)

1.5.0 removed the custom `pantheon_delegate` tool (and the V1 delegation
engine) in favor of the host child-session engine; see
[Delegation (`subagent` / host API `task()`)](#delegation-root-subagent-hostapi-task). In the
reported Beta 10 runtime Zeus dispatches through `subagent`; `task()` remains
host/API terminology, not a guaranteed root tool. Two things change on
an existing install:

1. **The tool disappears from the plugin surface.** `pantheon_delegate` is no
   longer registered by `src/plugin.ts` or `src/plugin-v2.ts`. Agents now
   delegate through the dispatch tool actually exposed by the active runtime —
   no Pantheon-specific delegation tool configuration is needed.
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

For a candidate whose release section already exists, maintain its notes with
`node scripts/versioning.mjs changelog <version>`; this merges `[Unreleased]`
into that version without advancing the package version.

Release validation keeps each manifest with its lockfile: the root
`package.json` + `package-lock.json` and the TUI
`src/plugins/tui/package.json` + `src/plugins/tui/package-lock.json`. Both use
`npm ci --ignore-scripts`; an `npm ci` failure blocks the run and there is no
`npm install` fallback. A release carries one `.tgz` tarball, computes the
SHA-256 of that same artifact, and binds the tarball and GitHub release to the
full `TARGET_SHA`; a second pack is not interchangeable.

CI also rebuilds the TUI with `npm run build --prefix src/plugins/tui` and
checks every packaged `dist` artifact byte-for-byte against its checked-in
version, including final newlines. The build includes separate V1 and native
OpenCode V2 TUI entrypoints; `init` selects the entrypoint and sidebar slot API
for the host generation in use.

## Sandbox validation (V2)

`scripts/test-opencode-v2-sandbox.sh` validates the globally installed
package as a real user inside an isolated sandbox (own `HOME`, npm prefix and
venv) — never the dev environment. It checks the OpenCode V2 leg: the binary,
MCP connectivity, `doctor`, and — with `--prompts` — a prompt battery covering
the `pantheon://agents` resource, memory store/recall, filesystem writes and
agent delegation. The gate is fail-closed: every required check must return an
explicit PASS; timeouts, auth/network/provider failures and missing
prerequisites block the run.

The runner defaults to the current stable `@opencode/cli` package and its
`opencode2` alias; set `OPENCODE_V2_SPEC` only when a test needs a different
host build. This keeps Pantheon beta testing separate from the OpenCode CLI
release channel.

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
~/pantheon-sandbox/start-pantheon.sh              # interactive TUI in that isolated beta sandbox
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

## Latency benchmark (bench/)

`bench/` measures end-to-end session latency of the installed `opencode` CLI
with the repo's V2 plugin — the baseline every performance change in a release
must be compared against. It runs two scenarios N times each, interleaved
(non-interactive, one fresh sandbox directory per run), collects per-run
metrics from `opencode.db` in READ-ONLY mode (tokens root + child sessions
without double counting, tool calls per name, child-session count) and hook
timings from the `[bench]` lines the plugin appends to `hooks.log`:

```bash
node bench/bin/bench.mjs            # 5 runs per scenario (A and B), ~1h
BENCH_MODEL=opencode-go/glm-5.3-flash node bench/bin/bench.mjs   # pin a model
node bench/bin/bench.mjs --runs 1   # smoke: one run per scenario
```

Results land in `bench/results/<label>-<git-sha>.json` (median + p80 +
failures per scenario); the label defaults to `baseline` and the harness
refuses to overwrite an existing result, so the run identity lives in the file
name. Scenario A performs real web research, so its variance is
network-dependent and recorded per run.

### Measurement profiles (explicit, never inferred)

Instructions are injected from two surfaces: the global config dir and the
project directory. The harness states which one it exercises, because a
result only means anything in the profile where the change acts:

| `--profile` | Global `AGENTS.md` | Project `AGENTS.md` | Use |
|---|---|---|---|
| `host` (default) | host config dir (or `--global-agents`) | none — run dirs stay empty | the host's real, unmodified injection |
| `double-injection` | host config dir (or `--global-agents`) | `--project-agents`, written into every run dir | the in-repo profile where global+project overlap |

The default measures scenarios A and B. Use `--scenarios B` to isolate the F1
one-shot claim; the selected scenario still runs N times (`--runs 5` by
default).

```bash
# candidate arm: the carved global artifact + the carved project artifact
node bench/bin/bench.mjs --runs 5 --scenarios B --profile double-injection \
  --global-agents AGENTS.global.md --project-agents AGENTS.md --label f1-candidate
```

Each arm records, per run and read from the db, the identity (path, bytes,
sha256) of every instruction file the session actually loaded
(`instruction_state` + `instruction_blob`) — the fidelity proof that what was
measured is what was generated. A claim may only rest on a run whose
provenance shows the intended global **and** project artifacts were loaded.

### Signal vs noise

Wall time is a lead, not a criterion: same-day spread reaches ~8× in scenario
A and ~13× in B. An effect is **confirmed** only when it exceeds the same-day
spread (or demands a larger N); otherwise it is recorded as **inconclusive**.
Prefer token medians, which are far more stable. Scenario A's wall is not a
claim metric — it performs real web research, so network variance dominates.

### First-request proxy and F1 evidence

The injected instruction payload only lands on the first request, so the
tree-total `tokens.input` (summed over every turn) is dominated by
session-length variance. Each run also records `firstRequest` — the first
assistant row's `tokens.input` + `tokens.cache.read` — the proxy that isolates
the payload.

An interleaved OpenCode v2.0.29 run (C1/K1…C5/K5, N=5/arm) measured
first-request context at 17555 tokens for control and 15489 for candidate
(**−2066, −11.8%**; within-arm spread 14 tokens in each arm). D4 confirmed
22350 B loaded for control and 13400 B for candidate (−8950 B, −40.0%); the
pre-registered correctness oracle passed 5/5 in both arms. Themis accepted F1
with **PASS_WITH_NOTES**. The first-request effect is confirmed against
within-arm spread. Tree-total input fell from a median 47594 to 38253
tokens, but ranges overlap and the ≤30k hypothesis was not met. Wall medians
were 30.078 s and 24.130 s, with high spread; tree-total input and wall remain
**inconclusive**. No wall-time or monetary-cost gain is claimed. Details and
per-run records: `bench/results/f1-di-v229-interleaved-2026-10-14.md`.
The earlier sequential pair remains supporting-only in
`bench/results/f1-di-v229-clean-2026-10-14.md`. Earlier exploratory runs are
retained separately in `bench/results/f1-double-injection.md` and
`bench/results/f1-di-v229-preliminary-2026-10-14.md`.

### Explicit root specialist result (F3a)

For the bounded one-shot scenario B, explicitly starting Talos as the root
produced the oracle-passing artifact in 5/5 runs with no child session or
`subagent` call. In the same-day paired sample, Talos used 16,171 median input
tokens per run versus 33,301 for Zeus (−51.4%); this is a descriptive result
for this task, model, and configuration, not a general routing or monetary
savings claim. Wall time is inconclusive: medians were 30.347 s and 31.893 s,
the ranges overlap widely, and Talos had the higher p80. No automatic
LLM-selected root routing is introduced by this result.

A final integration check after F4A/F3b initially completed 4/5 Talos artifacts.
Talos's prompt now says to finish named files with native `write`/`edit` tools
and not confuse MCP tool discovery with the host's native tool catalog. The
failure remains recorded in
[`beta10-final-integration-2026-10-15.md`](bench/results/beta10-final-integration-2026-10-15.md).
A new pre-registered cohort on that prompt passed the artifact oracle in 5/5
Talos runs with zero children or `subagent` calls. Its first-request context
proxy was 9,675 tokens versus 13,009 for Zeus (−25.6%, confirmed against the
same-arm spread). Tree-total input is descriptive, and wall time remains
inconclusive. See the [follow-up report](bench/results/beta10-final-integration-followup-2026-10-15.md)
and [raw run record](bench/results/beta10-final-integration-followup-20261015.json).

The v2.0.29 harness requires explicit agent and fixture selection, and proves
global plus project instruction provenance for each run:

```bash
BENCH_MODEL=opencode-go/glm-5.3-flash node bench/bin/bench.mjs \
  --scenario B --runs 5 --profile double-injection \
  --global-agents AGENTS.global.md --project-agents AGENTS.md \
  --agents-dir src/agents --skills-dir src/skills \
  --root-agent talos --control-root-agent zeus --paired \
  --out bench/results/phase3-root-paired-20261014.json
```

Themis reviewed the harness and evidence (**PASS_WITH_NOTES**). Full method,
oracle audit, limitations, and per-run data are in
`bench/results/f3a-root-paired-2026-10-14.md` and
`bench/results/phase3-root-paired-20261014.json`.

### Bounded workspace reads (F3b)

On OpenCode v2.0.29, the V2 plugin can expose `pantheon_bounded_read` when the
host provides its native permission and session APIs. Only a root Zeus session
can use it. Each call asks the host for `read` permission to one exact
workspace-relative file, with an empty save scope; content is read only after
approval and is scanned by the existing fail-closed secret scanner. Limits are
two calls and two distinct files, 400 lines and 32 KiB per assistant message.
Traversal, symlinks, directories, sensitive scopes, recognized binary/media
formats, and scanner failures are rejected. This is scoped to a local workspace
without concurrent writers; it does not claim adversarial filesystem isolation
or whole-file binary classification. The host-backed evidence is in
[`bench/results/f3b-v229-bounded-read-2026-10-15.md`](bench/results/f3b-v229-bounded-read-2026-10-15.md).


## Plugin V2 TypeScript coverage

`npm run coverage:plugin-v2` runs the `tests/pantheon/*.test.ts` suite with
Node's source-mapped native coverage and enforces an 80% line-coverage minimum
for `src/plugin-v2.ts` only. It requires Node `>=26.4.0`; branch and function
coverage are reported but are not gates. This is not a repository-wide coverage
claim.

Env overrides:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PANTHEON_SANDBOX_ROOT` | `~/pantheon-sandbox` | Sandbox root (refused if unsafe for `--reset`) |
| `OPENCODE_V1_SPEC` | `opencode-ai@1.18.18` | Configures the V1 plugin only; the V2-only sandbox runner does not consume or support it |
| `OPENCODE_V2_SPEC` | `@opencode/cli@latest` | npm spec providing the `opencode2` binary |
| `PANTHEON_SANDBOX_MODEL` | `opencode-go/mimo-v2.5` | Model used by init and prompts |
| `PANTHEON_PROMPT_TIMEOUT` | `300` | Per-prompt timeout in seconds |

Exit codes: `0` no real failures · `1` real failure (see `prompts-report.md`
in the sandbox root) · `2` usage error · `3` sandbox not prepared.

### Intentional memory MCP divergence

`scripts/memory_mcp.py` and `src/mcp/memory_mcp.py` are
intentionally different. The standalone `scripts/` copy keeps the lightweight
`memory_*` contract; the installed `src/mcp/` copy additionally exposes the
optional codemap schema and `code_index`, `code_query`, and `code_neighbors`.
The other shared MCP copies remain identical. Do not overwrite one memory copy
with the other.

### Task-result guard

A `task-result-guard` intercepts host/API child-session dispatch calls where the
child session returns an empty or missing result. In the reported Beta 10 Zeus
root, dispatch is exposed as `subagent`; host/API `task()` terminology does not
guarantee a root tool by that name. Instead of surfacing a silent
`completed` with no payload (which confuses the orchestrator), the guard now
raises an explicit error. This catches the common free-tier failure mode where a
child session exceeds the uncached-prefill token budget (`BackendAdmissionRejected`)
and returns nothing. Background dispatch and status/fan-in facilities are
runtime-dependent. The reported Beta 10 Zeus root did not expose `task_status`;
use synchronous `subagent` dispatch or wait for a host-provided completion
notification when no status tool is visible. Do not claim deterministic fan-in
or job recovery without an exposed, verified mechanism.


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

### Reproducible benchmark evidence

The beta2 benchmark records reported token usage separately from its
character-based fallback estimate; source bytes and logical line counts remain
provenance data and are never converted into tokens. Cross-report comparisons
require matching model/config provenance and reported OpenCode usage. Offline
fixture responses are mocked: their reported values are labeled separately,
excluded from `actual` usage, and blocked from comparative metrics and GEPA.
Fixture quality outcomes test the offline contract; they are not evaluation
evidence.
Reproduce the
checked-in AGENTS.md history manifest with
`python3 -m benchmarks.beta2.provenance --output benchmarks/beta2/fixtures/agent-baseline-provenance.json`.
For OpenCode benchmark runs, provide `--model` and `--config-sha256` so reports
can be compared safely.

### Project-level `opencode.json`

The published package carries no `opencode.json` template. `init` still writes
your project's `opencode.json` itself, and the few product defaults an install
seeds — `default_agent: zeus` and `permission.skill` — come from the installer
code, not from a packaged file. Contributors who keep a project-level
`opencode.json` for their own OpenCode sessions should leave it untracked —
`.git/info/exclude` per clone, or a shared `.gitignore` decision — rather than
versioning it.

## Citation and DOI

Pantheon is released under the [MIT License](LICENSE). Cite the
[Zenodo concept DOI](https://doi.org/10.5281/zenodo.22650136), which always
resolves to the latest archived release; each release also has its own version
DOI. Citation metadata is also available in [CITATION.cff](CITATION.cff).

Canonical repository: <https://github.com/ils15/pantheon-opencode>

---

[Leia em português (Brasil)](README.pt-BR.md)
