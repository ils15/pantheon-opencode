# Pantheon Roadmap

This roadmap records customer-visible themes, maintenance boundaries, and readiness conditions for stable releases. Internal tracking identifiers, per-item evidence bundles, and per-commit history are intentionally not part of this page.

## Current State: 2.0.x Stable

The 2.0.0 through 2.0.4 releases delivered the complete consolidation onto OpenCode 2.x, the unified Jev decision router, in-memory reactive event dispatch, fast-path reflex loops, prompt caching optimizations, and cryptographic execution receipts.

See [Compatibility](docs/COMPATIBILITY.md) for supported hosts and the [releases page](https://github.com/ils15/pantheon-opencode/releases) for published packages.

---

## 2.0.x Maintenance Policy: Feature Freeze

Starting with **2.0.4** and continuing until the **2.1.0** minor milestone, the `2.0.x` line is placed under an **explicit feature freeze**.

### The Rule
- **No new features or architectural capabilities will be introduced in `2.0.x`.**
- All active development on `2.0.x` is restricted strictly to:
  1. **Bug fixes** in existing tools, agents, commands, and plugins.
  2. **Security and permission hardening** (e.g., secret-scanner enforcement, file system boundaries).
  3. **Runtime reliability and container compatibility** (e.g., JupyterHub, Docker, Kubernetes file trust edge cases).
  4. **Test flakiness, CI gate resilience, and documentation correctness**.

### Priority Maintenance Focus for 2.0.x Patches
- **Concurrency integrity**: Serialize concurrent file modifications across subagents to eliminate silent overwrite race conditions.
- **MCP process resilience**: Enable graceful in-session recovery of interrupted or dead MCP server processes without requiring a complete OpenCode host restart.
- **Read-boundary secret scanning**: Ensure the secret scanner policy inspects file read operations with the same strictness applied to write operations.
- **TUI state stability**: Eliminate edge cases in TUI viewport sizing, timezone detection, and real-time event subscription cleanup.

---

## Road to 2.1.0 Minor Milestone

The `2.1.0` release will be the next minor feature cycle. It introduces structural enhancements designed to lower token consumption, scale multi-agent coordination, and eliminate runtime overhead.

### 2.1.0 Workstreams & Themes

1. **Step-Ledger Execution Mode**
   - Execute complex workflows via atomic, single-step sub-sessions.
   - Each sub-session opens strictly with the active step's summary, objective, ledger key, and completion contract.
   - Gated progress: a step may transition to `done` only when a verification command exited 0 since the last file mutation.
   - Eliminates cascading context buildup, targeting up to 40x context token savings on large tasks.

2. **Dynamic Multi-Model & Fallback Routing (Jev)**
   - Introduce provider-aware fallback policies in the Jev Decision Router.
   - Dynamically route low-complexity or high-volume tasks across providers (Gemini, Claude, GPT) with automated retry on quota exhaustion (HTTP 429) or transient degradation.
   - Integrated with the in-memory event bus (`PantheonBus`) for real-time observability of routing decisions and token spend.

3. **Declarative Roster Generator & Forge**
   - Centralize agent definitions into a typed role-and-capability manifest.
   - Mechanically compile specialist system prompts and tool grants from declarative configurations, eliminating copy-paste drift and ensuring frontmatter conformance.

4. **Pre-Dispatch Scope Governance**
   - Validate file-tree bounds, command allowlists, and tool grants *before* spawning a child subagent.
   - Prevents execution aborts caused by late-discovered permission mismatches.

5. **Mechanized Code Quality Doctrine**
   - Enforce coding standards and anti-pattern detection through deterministic linters and test harnesses rather than advisory prompt instructions.
   - Zero tolerance for verbal-only coaxing: every rule must fire a machine-verifiable gate.

---

## Anti-Slop Audit Doctrine

Every candidate theme for 2.x is evaluated against a strict standard: **a proposal contributes when and only when it changes behavior through a deterministic gate that fires**.

Prose that merely asks an LLM nicely to adhere to conventions is the weakest tier of enforcement and is rejected as "slop". Enforceable engineering requires:
- Structural assertions in CI.
- Automated static checks, linters, or cryptographic receipts.
- Fail-closed execution boundaries.

---

## What 2.0.x Delivered (Consolidated Record)

- **One installation, one contract**: The OpenCode V1 contract was removed; the plural `plugins` format on OpenCode 2.x is canonical. See [Compatibility](docs/COMPATIBILITY.md#the-host-gate).
- **The native install path**: Recommended plugin installation via host package management alongside the installer for agents, skills, instructions, commands, MCP, and TUI. See [Installation](docs/INSTALLATION.md).
- **High-speed reactive orchestration**: In-memory typed event bus (`PantheonBus`) with zero-latency background job tracking.
- **Themis local reflex loop**: Bounded autonomous self-healing for fast-path implementers without coordinator round-trips.
- **Cryptographic execution receipts**: SHA-256 fingerprinting of modified files and verification slices for delegated subagent tasks.
- **Deterministic KV-cache prompt layering**: Prompt prefix stabilization maximizing provider KV-cache retention and lowering token latency.
- **Container and JupyterHub resilience**: Relaxed directory trust chains for group-writable systems (`PANTHEON_ALLOW_GROUP_WRITABLE=1`).
- **Five isolated Python MCP servers**: Pinned runtime environments with per-agent tool allowlists. See [MCP](docs/MCP.md).
- **Skills with progressive disclosure**: Bounded `SKILL.md` cores with digest-locked `references/`. See [Agents & Skills](docs/agents/README.md).
- **Typed Decision Router (Jev)**: Structural risk ladder with `ask`/`rank`/`verify` semantics. See [Native Decisions (Jev)](docs/reference/native-decisions.md).
- **Plain-language TUI & 2-tier planning**: Intuitive Portuguese/English labels and concise executive decision summaries with disk-persisted blueprints.
