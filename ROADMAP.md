# Pantheon Roadmap

This roadmap records customer-visible themes and the readiness conditions for a
stable release. Internal tracking identifiers, per-item evidence bundles, and
per-commit history are intentionally not part of this page.

## Road to 2.0.0 stable

Release readiness is organized as three workstreams. They may run in parallel
when independent; the release gate depends on the first two.

1. **Contract and naming consolidation** — finish the V1 removal on the whole
   user-facing surface: one plugin generation, canonical module names, the
   native host install path, and documentation that describes a single
   contract.
2. **Runtime and distribution validation** — prove that the package, installer,
   plugins, and MCP servers fulfill that contract on the explicitly supported
   host family (OpenCode 2.x, excluding the known-broken 2.0.22). The
   compatibility policy and a single candidate identity connect this work to
   the rest.
3. **Stable release and evidence gate** — freeze an exact candidate, then
   validate tests, compatibility, installation, package contents, changelog,
   and metadata. A release is considered only when every applicable gate is
   explicitly `PASS`.

A missing result, or a result marked `WARN`, `SKIP`, `NOT_TESTED`, or
`AMBIENTAL`, is not a `PASS`. Unresolved risks are blockers or must be accepted
explicitly — never approved silently.

The 2.0.0 candidate in this checkout is **not published and not release-ready**.
The manifests express the version being prepared. See
[Compatibility](docs/COMPATIBILITY.md) for supported hosts and the
[releases page](https://github.com/ils15/pantheon-opencode/releases) for what is
actually published.

## Registered decisions

These are the decisions the 2.0 cycle records, so the next contributor does not
relitigate them:

- **2.0 is the complete removal of the OpenCode V1 contract plus canonical
  nomenclature.** One plugin generation. The surface is named without a
  generation suffix: `src/plugin.ts` is the entry, the `src/plugin/` directory
  is what the host loads, `pantheon-opencode/plugin` is the package export, and
  the TUI ships `./tui` and `./server` exports. There is no dual-generation
  installer, no generation selector, and no fallback to a removed contract.
- **The Python MCP servers remain.** The five local servers are the documented
  memory, persistence, resources, code-mode, and vision surface. Migration to a
  host-native primitive happens only where the host proves that primitive; a
  host capability that merely exists is not a reason to move a working server.
- **Goals are exposed; the board is not.** This answers the earlier hygiene
  item about board/goal parity honestly: durable manual goals are the
  Persistence MCP `goal_*` tools, granted to Zeus and partitioned by session.
  The BackgroundJobBoard is not re-created on the 2.x surface, and no
  board-equivalent UI is promised.
- **Progressive disclosure with hard failure is the skill default.** A skill
  ships a bounded `SKILL.md` core plus pinned `references/`; the lock records
  every reference digest; a cited-but-missing reference fails the build, and a
  missing reference interrupts the action instead of being improvised from
  memory.
- **Overrides are a named layer.** `routing.yml` declares the behaviors
  registry, the only override surface. Project overrides win per id over
  global, schema errors name the file and the id, unknown ids surface in
  `doctor`, and security-critical behavior is deliberately not overridable.
- **Structural evals run in CI.** Golden positive/negative cases exercise the
  real generators (managed-region carving, zero-overlap artifacts, agent-scoped
  instruction routing) in the regular node test tier, not as an ad-hoc script.
- **instruction-forge is the doctrine skill** — the first client of the
  references/ mechanism and the template the other skills are expected to
  converge on.

## What 2.0 delivers

- **One installation, one contract.** The installer writes the plural `plugins`
  registration with the plugin directory and refuses a host it cannot confirm
  as OpenCode 2.x. See
  [Compatibility](docs/COMPATIBILITY.md#the-host-gate).
- **A canonical surface.** Generation-suffixed module names are gone from the
  shipped surface and from the environment variables (`PANTHEON_V2_*` became
  `PANTHEON_*`). See [Architecture](docs/ARCHITECTURE.md).
- **The native install path.** The host's own plugin flow — an npm or git
  package added through the host, or a directory under `.opencode/plugins/` —
  is the recommended way to load the plugin; the installer remains the setup
  path for agents, skills, instructions, commands, MCP, and the TUI. See
  [Installation](docs/INSTALLATION.md).
- **Skills that disclose progressively and fail hard.** The six heaviest skills
  carry pinned references, the lock verifies them, and the decision catalog
  mirrors the skill directory. See [Agents & Skills](docs/agents/README.md).
- **A typed decision router with an advisory risk ladder.** The Jev decision
  router answers `ask`/`rank`/`verify` questions; the J1 gate, J3 escalation,
  and J4 review scoring are opt-in or shadow surfaces documented from measured
  behavior. See the
  [router reference](docs/reference/local-decision-router.md) and
  [Native Decisions (Jev)](docs/reference/native-decisions.md).
- **MCP servers on a pinned runtime.** Five local servers with isolated Python
  environments. See [MCP](docs/MCP.md).
- **Memory that stays bounded.** A 64 KiB per-entry cap, optional TTL, explicit
  purge, and an opt-in injection path. See [Memory](docs/MEMORY.md).
- **Cost that answers money questions.** USD by agent and phase, by model, and
  by session, with an offline gate that refuses every network request. See
  [MCP Tools](docs/mcp-tools.md#cost-backend-and-attribution).
- **A dispatch surface.** An aggregated sidebar block and a full-width
  `/dispatch` panel built from the same collector. See
  [OpenCode 2.x](docs/opencode.md#dispatch-sidebar-block).
- **Installer resilience and update.** Backups, restore, reconcile, drift
  detection, and a supported `update` path. See
  [Installation](docs/INSTALLATION.md).

## Support boundary

**1.7.x is the last Pantheon line that supports an OpenCode 1.X host.** From
2.0 onward Pantheon requires OpenCode 2.x; the V1 contract is removed, not
deprecated. See
[Compatibility](docs/COMPATIBILITY.md#end-of-life-and-known-issues).

## Next iteration themes

These are customer-visible outcomes, not internal task identifiers. Ordering is
by risk, not by promised date — no date on this page is a commitment.

### Safety and permissions

- Validate the requested scope against the agent's permissions before a
  dispatch, instead of discovering the mismatch after the child starts.
- Protect a file read by the secret scanner's policy, closing the remaining gap
  where a read can expose a secret the scanner would block in a write.
- Ensure the installer resolves a Python interpreter that satisfies the
  documented `>=3.11` floor, and keep the installer hint consistent with the
  documentation.

### Runtime reliability

- Preserve the child session identity when a dispatch is aborted, so a retry
  does not orphan work.
- Make a dead MCP server recoverable: when the process returns, its tools should
  reappear in the same session without a full restart.
- Keep the tool-path matcher from suggesting the exact string it rejected.
- Confirm the `execute.after` guard and empty-result handling on the live host
  matrix, without overstating what a canary proves.

### Correctness of guidance

- Make `memory_search` state plainly that retrieval is lexical.
- Keep `memory_store` and `context_save` signatures in the documentation
  identical to the shipped server.
- Label Apollo findings as portable or environment-specific so a local
  observation is not promoted to a durable fact.
- Clarify the Nyx role and make Mnemosyne usable outside this repository.

### Architecture hygiene

- Add a boundary test for the phase-name limit.
- Reduce Wave 0 output size without losing required context.
- Serialize edits to a shared file so two agents cannot silently overwrite each
  other.

### Validation

- Gate `routing.yml` model identifiers against the provider catalog, so a model
  name is not treated as a fact of the project.
- Extend the permission and compatibility checks to every supported host minor
  before a stable release.

## Delivered and supported

- Single-contract installation for OpenCode 2.x, with backup, restore,
  reconcile, uninstall, and drift detection.
- The host-native tool, hook, and guard surface, including the bounded-read
  path where the host supports it.
- Five MCP servers with per-agent allowlists and deny-by-default behavior.
- Memory, persistence, code-mode, and vision surfaces documented from behavior.
- Cost reporting in USD, with per-model and per-session attribution.
- 23 skills with progressive disclosure, the behaviors registry, and
  instruction-forge as the doctrine skill.
- Structural instruction evals and the release process that publishes only
  through explicit dispatch and fail-closed gates.

## Historical note

Earlier roadmap revisions tracked individual defects with internal identifiers
and commit references, and carried the dual-generation themes of the 1.6 line.
Those records remain in the repository history. This page keeps the themes and
the readiness rule; it does not restate the internal log.
