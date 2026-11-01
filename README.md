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

Direct `init` uses the same component defaults in TTY and headless runs:
`agents`, `skills`, `instructions`, `commands`, and `plugins`. `runtime` and
`prompts` are opt-in. A TTY run selects components and target, shows a preview,
then asks once for final authorization (default **no**). Without a TTY, `init`
is preview-only unless `--yes` explicitly authorizes the apply; `--yes` skips
prompts but still prints the preview and checks for drift.

`npm run setup` is a separate repository setup wrapper. On detected OpenCode V2
it reviews the global config before installer init: legacy permission rules can
be migrated after explicit review. Config migration and installer changes are
preflighted before one final authorization; `--yes` alone does not authorize
setup writes, and headless/CI setup remains preview-only. Direct
`npx pantheon-opencode init` does not run that V2 config-migration review. See
the [installation guide](docs/INSTALLATION.md) for layer handling, conflict
choices, backups, and recovery.
Existing native V2 `permissions` arrays remain authoritative. Unsafe MCP
wildcard policies and ineffective `ask` rules require explicit resolution;
third-party flat MCP entries in `opencode.jsonc` must be converted to
`mcp.servers` or removed before V2 setup.

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
- **A selective, advisory decision router** with structured local results and
  deterministic per-turn skill/specialist recommendations when enabled. V2 adds
  only local advisory prompt behavior; direct-provider egress is inactive. The
  explicit, Zeus-only `pantheon_jev_decide` advisory tool additionally calls the
  host's native Decisions API (TypeSafe Jev via OpenCode Console or a configured
  decision model) when the user has enabled a native candidate, recorded egress
  consent, and confirmed budget caps — it never dispatches agents, runs skills,
  or changes permissions. This does not change separately documented quota and
  Vision integrations. See the
  [router reference](docs/reference/local-decision-router.md) and the
  [V2 native Decisions status](docs/reference/v2-native-decisions.md).
- **An optional TUI** with a dispatch sidebar block and a full-width
  `/dispatch` panel. The V2 TUI also provides a quota overview in the
  sidebar/footer and a `/quota` details panel. Quota display is enabled by
  default; the sidebar keeps Todo and places quota immediately after Dispatch
  (header/version → Session → Context → Git → Todo → Dispatch → quota).
  Status stays in the native sidebar footer. Use `E` to disable quota or `M`
  to switch between remaining and used. The `/quota` panel has **Usage, Limits,
  Plugin, and Settings** tabs. Usage charts cover 7, 15, 30 days, or Total and
  plot recorded daily token usage and model totals rather than filling gaps with
  invented data. The panel identifies the active chat model; a partial-data
  warning appears only when the quota snapshot is actually partial.
  Session-reported spend is shown separately. The active context estimate uses
  the active model's input price times pre-cache context tokens, applies no cache
  discount, and is explicitly not billable.
  Quota windows show text amounts and status, not provider progress gauges. They
  show a local countdown and the provider-reported reset date/time in UTC when
  valid timing is available; missing timing is not inferred. After expiry the UI
  shows “aguardando atualização” until refreshed data arrives.
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
  The V2 quota RPC shows providers when OpenCode lists an active supported
  connection and Pantheon can locally resolve a nonblank credential. OpenCode
  Go also supports `OPENCODE_API_KEY` and effective `opencode-go`/`opencode`
  provider settings. This is not proof that the provider accepted the
  credential; failed requests and unsupported adapters can remain visible as
  unavailable. OpenCode Go checks a selected Console OAuth login first when
  available, then uses the first available API key if no Console login exists
  or its request fails; a Console 404 or a successful response without an
  access object reports no Go subscription and does not fall back.
  The API-key route follows OpenCode Quota's supported Go usage endpoint. See
  the
  [quota provider coverage table](docs/tui-v2-quota-providers.md) for limits and
  troubleshooting.


  Quota status requests are separate from the decision subsystem and continue to use
  their documented provider APIs. Removing decision-provider transport does not
  disable these quota requests.
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
The [local decision router](docs/reference/local-decision-router.md) provides a
default-off standalone local API (`PANTHEON_LOCAL_DECISION_ROUTER=1`), the
separate manual `pantheon_local_decision` advisory tool, and deterministic
per-turn local recommendations when the user-level `enabled` preference is on.
The prompt hook may add an advisory marker and narrow an existing `prompt.skills`
array only when identifiable skill IDs overlap the local selection; this never
dispatches child sessions or changes permissions or approvals. Per-turn selection
uses no provider egress: the formerly documented direct-provider route remains
historical/inactive, and legacy consent, caps, period, provider selection, or
credentials cannot activate it. Native child-session dispatch remains separate.

On hosts that expose the V2.2.5 native Decisions API
(`ctx.experimental.generate.decisions`) and the model catalog, the Zeus-only
`pantheon_jev_decide` tool offers explicit, on-demand typed decisions (choice,
score, predicate) answered by the Jev decision model. Every call passes the full
gate chain — enabled config with egress consent, exactly one cap-valid native
candidate in the budget ledger, the host permission kill-switch on
`decision.egress`, and a bounded request preparer — and settles the reservation
from the host-reported cost before returning advisory-only answers. A host
without the native API simply does not register the tool.

The installer may retain a legacy target-specific preference; it does not control
runtime routing. `npx pantheon-opencode decision-router ...` manages stored
user-level preferences and budget state: `enabled` gates the local per-turn
recommendation only; provider-selection and budget/consent state do not activate
egress. The separate SQLite ledger has no default caps. Installation does not
contact a model provider or inspect credentials. The published CLI imports
committed ESM bundles:
`npm run build:decision-router` regenerates them and `npm run check:decision-router`
(the `prepack`/`prepublishOnly` drift gate) fails when any is stale. The
`pantheon-opencode/local-decision-router` subpath itself is TypeScript source, so
it loads only in the host runtime or under a transpiler such as `tsx`.

Decision-layer commands are separated by effect. `decision-router help`,
`status`, `preview` and `holds` are read-only: they never create, migrate, or
write the config or the SQLite ledger, and neither does `setup` without
`--apply`. `select` records a preference and can never enable anything — moving
the target also revokes consent recorded for the previous one. `setup` prints a
**computed diff of the target artifacts** (snapshot + SHA-256 per file, compared
against the exact bytes the writer would produce); `setup --apply` is the form
that writes, and a second run reports `0 create · 0 update`. It is deliberately
not the installer's "Change plan", which announced 112 creates for an apply that
created nothing. `setup --target <dir>` also reconciles the
`.pantheon/install-state.json` provider/consent record with the user-level config;
that record is derived from the config and never asserts consent the config lacks.
Neither path creates a backup: installer backup sets accumulate once per
application and contain credential-bearing material (API keys/tokens), so no
extra copy is made. Installer file-ownership tracking is partial and asymmetric —
`file_inventory` indexes 53 PROJECT artifacts and no GLOBAL ones (F-15); the
106-project / 107-global denominators are derived from the 213-artifact total and
are not separately indexed — so this preview compares the decision-layer
artifacts it owns, not "everything the installer touched".

The old OpenAI/TypeSafe per-turn provider adapters and endpoint descriptions are
retained as historical, inert code; no legacy consent, cap, period, provider, or
permission setting wires them into the production prompt hook. The captured-hook
boundary test supplies an isolated synthetic consent/provider config and fake
test-only credential, verifies a local recommendation marker, and verifies zero
native Decisions or global `fetch` calls. This is an offline regression check of
that hook, not a claim about unexercised network paths or a live-provider test.
Measured surface coverage is
reported honestly rather than implied: P7 runs behind `PANTHEON_V2_P7_LOOP` with
an **advisory** execution cap (never described as enforcement), P2 is
**advisory-only** (an empirical no-op on the default path), P9 was measured on
top-level **and child** sessions with `reason:"overflow"` still unmeasured, and
P8 is **advisory: not activatable by measurement** — its declared rules match no
delivered permission payload, so it narrows nothing (PROBE-F).

### The V2 decision layer is declared in full and wired in part

The V2 decision layer declares eleven integration points (P1–P11) over three
decision primitives — `ask`, `rank`, and `verify` — and a deterministic policy
that decides which point may run. **Seven of the eleven have a production call
site: two behind flags that are off by default, five in shadow.**

- **P7 (loop)** is wired to `session.execution.succeeded` behind
  `PANTHEON_V2_P7_LOOP`, which is off. It writes each observation to an
  in-memory, bounded telemetry collector that the plugin never reads back and
  exposes only to tests, so "records" here does not mean an operator-visible log.
- **P8 (guardrail)** is wired to `permission.evaluate` behind
  `PANTHEON_V2_P8_GUARDRAIL`, which is off. C8 is closed **by measurement**, and
  the measurement is negative: PROBE-F delivered 24 real `permission.evaluate`
  events and every declared rule matched none of them (a valid `action` token and
  a top-level `sessionID` are always present), the host resolves an unrecognised
  effect as `ask` and proceeds, and `permission.evaluate.egress` is unreachable
  (a tool declaring it is never advertised to the provider). As declared, P8 does
  not narrow. The flag stays off.
- **P1 and P2** are registered on `session.hook('prompt')` in **shadow**. They
  observe the same admission payload through a projection that carries only
  `prompt.agents` and `prompt.skills`: no text, no file bytes, no metadata, no
  mutation, no throw. Every record says `effect: none` and goes to an in-memory,
  bounded collector the plugin never reads back (test-visible only).
- **P3** is wired at its declared `tool.invoke` in **shadow**: the
  `pantheon_local_decision` tool hands the adapter its own input, whose schema
  requires `complexity` and `gateStatus`. It records a classification when the
  tool is invoked — never a permanent `complexity.invalid` refusal from a payload
  that cannot carry the vector — and applies nothing.
- **P9** is wired at its declared `session.hook('compaction')` in **shadow**, on
  the carrier that was actually measured: the top-level `sessionID` and the
  `system` part array. It records the decision key and the payload shape and
  pushes nothing — the injected compaction context is unchanged — and a payload
  whose only session id is a nested `session.id` (a field the 2.2.5 host never
  sends) produces no decision at all. The same shape was measured in a **child**
  session (PROBE-G: hook fires 3/3, child `sessionID` at top level, `system` an
  array of 4), so no child-specific branch exists. `reason:"overflow"` was not
  inducible and is not designed for. No measured surface carries the memory
  candidate list it would retain or discard, so its record states that absence
  rather than a retention or a priority.
- **P11** is wired inside `ctx.tool.transform` in **shadow**: it reads the draft
  the host hands that callback and calls none of its mutators. Shadow has no
  responder, so it records the validated `choice` question over the draft ids —
  never a selection.

**The other four — P4, P5, P6 and P10 — are library code with no production call
site.** Nothing constructs or registers them outside the per-point test suites —
the offline harness imports no adapter module. P6 and P10 declared the prompt
hook, but that payload never carries council candidates or counsellor claims, so
they stay unwired instead of recording a refusal from a surface that cannot feed
them. P4 ranks a memory candidate array and the measured `context` payload
carries `system` text parts, not candidates; P5 verifies a declared
`{ requirements, responses }` pair and the `execute.after` event carries
neither. On a host they do not read the turn, record no telemetry and have no
switch to turn off, because nothing registers them.

"Shadow" therefore means no behavioural change, not a claim of effect: the five
shadow points read a narrow slice of their surface and decide nothing from it,
and the two flag-gated points are off. No activation flag is set in a default
install.

The CLI separates effects: `npx pantheon-opencode decision-router help`, `status`,
`preview` and `holds` never write, `setup` writes only under `--apply`, `preview`
is an alias of `setup`, and `select` records a preference without enabling
anything. Egress stays opt-in and off, and only the explicit `enable`, `consent`,
`caps` and `period` actions can change that; no read-only command can.

What the layer does **not** do today, stated as measured rather than implied:

- **P2 (skills) is advisory-only and does not filter.** It is an empirical no-op
  on the default path, because the host sends `prompt.skills` absent. Effective
  project-skill filtering was cancelled by measurement, not emulated, and no
  token reduction is claimed.
- **P7 (loop) is behind `PANTHEON_V2_P7_LOOP`, off by default, and does not
  enforce loop limits.** It counts executions and writes an `effect: none`
  observation to an in-memory collector that nothing reads back. Its
  12-execution cap is **advisory**: no measured host surface signals a new user
  turn, so nothing is claimed to reset the streak.
- **P9 (compaction) is measured in top-level and child sessions.** PROBE-G fired
  the hook in a real child 3/3 with the child's `sessionID` at top level and the
  same payload shape. `reason: "overflow"` was **not inducible** in 6 error
  shapes — the host retried and completed, and the one failure-recovery
  compaction was persisted as `reason:"auto"` — so that path stays unmeasured;
  the checkpoint reinjection inside a child was not exercised, and the `messages`
  channel remains UNKNOWN. The memory candidate list is not available on any
  measured surface, so the wired P9 record names that absence and claims no
  retention or priority.
- **P8 (guardrail) is not activatable by measurement.** PROBE-F delivered 24 real
  `permission.evaluate` events: the payload is
  `["sessionID","agent","action","resources","metadata","source","effect"]` with
  `effect` an own writable data property pre-populated by the host, and a written
  `deny` **is** honoured. But neither declared rule can match a delivered payload
  (valid `action` token, `sessionID` always present), the host lets an
  unrecognised effect resolve as `ask` and execute, and
  `permission.evaluate.egress` is unreachable — so the current rule set matches
  nothing and does not narrow. The point is recorded as **advisory**, not as
  awaiting review, and the inertness is the measured verdict rather than a design
  claim. `execute.before` remains the only hard barrier.
- **The embeddings-versus-BM25 comparison has not been run.** The environment is
  offline with no embedding model available, so BM25 remains the baseline and no
  gain or loss in retrieval or tokens is claimed in either direction.

Calibration that was run: the offline harness
(`npx tsx tests/pantheon/v2-decision-harness.test.ts`) executed 264 synthetic
cases — 132 normal, 66 refusal, 66 adversarial — across the eleven points, with
24 cases per point and the suite asserting at least 20 cases, 5 refusals and 5
adversarial cases per point. All 264 cases passed on 2026-10-31. This harness is
the only place all eleven points are exercised in one run, but it imports no
adapter module: it iterates the registry and exercises the shared primitives,
while the adapters are covered by their per-point suites
(`v2-decision-p1.test.ts` … `v2-decision-p11.test.ts`). Passing it says nothing
about whether a point is registered in a host.
The harness measures contracts (admission, refusal, shadow no-op, telemetry
redaction, offline discipline, registry integrity), **not** token use, quality,
latency or any effect inside a host turn. Numbers and unmeasured surfaces are
recorded in the [router reference](docs/reference/local-decision-router.md).

## Documentation

| Start here | Go deeper |
|---|---|
| [Installation](docs/INSTALLATION.md) | [Architecture](docs/ARCHITECTURE.md) |
| [Quick Start](docs/QUICKSTART.md) | [MCP](docs/MCP.md) · [MCP tools](docs/mcp-tools.md) |
| [Upgrading](docs/UPGRADING.md) | [Memory](docs/MEMORY.md) |
| [Compatibility](docs/COMPATIBILITY.md) | [OpenCode V2](docs/opencode-v2.md) |
| [Agents & Skills](docs/agents/README.md) | [Platforms](docs/PLATFORMS.md) |
| [Release Process](docs/RELEASING.md) | [Branch Protection](docs/BRANCH-PROTECTION.md) |
| [Model Routing](docs/reference/model-routing.md) | [Local Decision Router](docs/reference/local-decision-router.md) · [Offline Evaluation Protocol](docs/reference/offline-evaluation.md) · [Env Vars](docs/reference/env-vars.md) · [Code Mode](docs/reference/code-mode.md) |
| [Contributing](CONTRIBUTING.md) | [Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md) |

Memory writes through `pantheon-memory` are serialized, and failed writes are
reported as failures rather than as stored entries. Eval resources wait for
SQLite locks and close their connections; project-specific resources resolve
the current project root per request while preserving the trusted
`PANTHEON_HOME` fallback. See [Memory](docs/MEMORY.md) for store separation and
[MCP tools](docs/mcp-tools.md) for details.

The release install gate's tool canary loads the installed tarball's V2 plugin
entry under OpenCode 2.0.30 and verifies `hashline_edit` registration, Code Mode
visibility, and a bounded edit in an isolated project. It does not prove npm
publication or compatibility with untested host versions; details are in the
[release process](docs/RELEASING.md).

Generate beta release notes from commits since the latest prior beta tag with
`node scripts/versioning.mjs apply --beta --notes`. See the [release
procedure](docs/RELEASING.md) for details.
After the version bump, verify and rebuild the TUI workspace from the repository
root with `npm run typecheck --workspace=src/plugins/tui` and
`npm run build --workspace=src/plugins/tui`.
The maintainer-only `release` scope is excluded from public notes and their
Closed Issues references; see the [release-notes policy](docs/RELEASING.md#release-notes).

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
