# Pantheon Roadmap

This roadmap records customer-visible themes and the readiness conditions for a
stable release. Internal tracking identifiers, per-item evidence bundles, and
per-commit history are intentionally not part of this page.

## Road to 1.6.0 stable

Release readiness is organized as three workstreams. They may run in parallel
when independent; the release gate depends on the first two.

1. **Product and agent-workflow contract** — define what the product promises
   and how agents plan, implement, review, and hand off work.
2. **Runtime and distribution validation** — prove that the package, installer,
   plugins, and MCP servers fulfill that contract on the explicitly supported
   host matrix. The compatibility matrix and a single candidate identity connect
   this work to the rest.
3. **Stable release and evidence gate** — freeze an exact candidate, then
   validate tests, compatibility, installation, package contents, changelog, and
   metadata. A release is considered only when every applicable gate is
   explicitly `PASS`.

A missing result, or a result marked `WARN`, `SKIP`, `NOT_TESTED`, or
`AMBIENTAL`, is not a `PASS`. Unresolved risks are blockers or must be accepted
explicitly — never approved silently.

The 1.6.0 candidate in this checkout is **not published and not release-ready**.
The manifests express the version being prepared. See
[Compatibility](docs/COMPATIBILITY.md) for supported hosts and the
[releases page](https://github.com/ils15/pantheon-opencode/releases) for what is
actually published.

## What 1.6.0 delivers

- **One installation, one plugin generation.** The installer selects V1 or V2
  from the host and never registers both. See
  [Compatibility](docs/COMPATIBILITY.md#how-the-generation-is-selected).
- **A real V2 plugin surface.** Host-native tools, session hooks, read-only
  enforcement, a delegation-matrix hook when the host exposes it, and the
  `execute.after` result chain. See [OpenCode V2](docs/opencode-v2.md) and
  [Architecture](docs/ARCHITECTURE.md).
- **MCP servers on a pinned runtime.** Five local servers on MCP SDK 2.2.0 and
  FastMCP 4.0.10, with isolated Python environments. See [MCP](docs/MCP.md).
- **Memory that stays bounded.** A 64 KiB per-entry cap, optional TTL, explicit
  purge, and an opt-in V2 injection path. See [Memory](docs/MEMORY.md).
- **Cost that answers money questions.** USD by agent and phase, by model, and
  by session, with an offline gate that refuses every network request. See
  [MCP Tools](docs/mcp-tools.md#cost-backend-and-attribution).
- **Context pruning before summarization.** Repeated tool output is replaced by
  placeholders, without deleting or reordering messages. See
  [OpenCode V2](docs/opencode-v2.md#context-pruning).
- **A dispatch surface.** An aggregated sidebar block and a full-width
  `/dispatch` panel built from the same collector. See
  [OpenCode V2](docs/opencode-v2.md#dispatch-sidebar-block).
- **Installer resilience and update.** Backups, restore, reconcile, drift
  detection, and a supported `update` path. See
  [Installation](docs/INSTALLATION.md).

## Support boundary

**1.6.x is the last Pantheon line that supports an OpenCode 1.X host.** From 1.7
onward Pantheon targets OpenCode 2 only. OpenCode 2 support — including the
2.1.x line — is already present in 1.6.x, so the 1.7 change is the removal of
the V1 path. See [Compatibility](docs/COMPATIBILITY.md#end-of-life-and-known-issues).

## Next iteration themes

These are customer-visible outcomes, not internal task identifiers. Ordering is
by risk, not by promised date.

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
- Confirm the V2 `execute.after` guard and empty-result handling on the live
  host matrix, without overstating what a canary proves.

### Correctness of guidance

- Make `memory_search` state plainly that retrieval is lexical.
- Keep `memory_store` and `context_save` signatures in the documentation
  identical to the shipped server.
- Label Apollo findings as portable or environment-specific so a local
  observation is not promoted to a durable fact.
- Clarify the Nyx role and make Mnemosyne usable outside this repository.

### Architecture hygiene

- Remove duplicated version-system logic from the installer.
- Add a boundary test for the phase-name limit.
- Reduce Wave 0 output size without losing required context.
- Serialize edits to a shared file so two agents cannot silently overwrite each
  other.
- Decide whether V2 should expose board/goal equivalents, and state the answer
  honestly rather than implying parity.

### Validation

- Gate `routing.yml` model identifiers against the provider catalog, so a model
  name is not treated as a fact of the project.
- Extend the permission and compatibility checks to every host row before a
  stable release.

## Delivered and supported

- Dual-generation installation with a single selected contract.
- V2 tools, hooks, guards, and the bounded-read path where the host supports it.
- Five MCP servers with per-agent allowlists and deny-by-default behavior.
- Memory, persistence, code-mode, and vision surfaces documented from behavior.
- Cost reporting in USD, with per-model and per-session attribution.
- Installer backup, restore, reconcile, uninstall, and drift detection.
- A release process that publishes only through explicit dispatch and
  fail-closed gates.

## Historical note

Earlier roadmap revisions tracked individual defects with internal identifiers
and commit references. Those records remain in the repository history. This
page keeps the themes and the readiness rule; it does not restate the internal
log.
