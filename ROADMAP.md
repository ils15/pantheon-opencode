# Pantheon Roadmap

This roadmap records customer-visible themes, maintenance boundaries, and readiness conditions for stable releases. Internal tracking identifiers, per-item evidence bundles, and per-commit history are intentionally not part of this page.

## Current State: 2.1.x Stable (v2.1.2)

The `2.1.x` release series delivered the canonical Deepwork plan architecture, interactive native Question Gate enforcement, unrestricted `.pantheon/` and worktree access for analytical agents, bilingual documentation portals, and live session Todo synchronization.

See [Compatibility](docs/COMPATIBILITY.md) for supported hosts and the [releases page](https://github.com/ils15/pantheon-opencode/releases) for published packages.

---

## 2.1.x Maintenance & Active Deliveries

Active development on the `2.1.x` line focuses on operational smoothness and developer ergonomics:

### 2.1.3 Immediate Enhancements
1. **Live TUI Todo Activation & Complete Todo Suite (`todowrite` + `todoread`)**
   - Direct integration between `@zeus`/`@athena` coordination and the OpenCode V2 session todo tools.
   - Restored `todoread` to inspect active session tasks programmatically alongside `todowrite` (matching `opencode-todolist`).
   - Active plans and multi-step checklists automatically mirror to the Pantheon TUI sidebar Todo panel in real-time.
2. **Declarative Agent Roster Generator & Forge**
   - Centralized typed schema and manifest (`src/agents/roster.json`) driving all 14 specialist prompts (`src/agents/*.md`).
   - Mechanical compiler (`scripts/build-roster.mjs`) with `--check` CI gate, eliminating copy-paste drift and ensuring frontmatter conformance.
3. **Observable & Enforceable Test Slicing (Anti-Fatigue Guard — Issue #437)**
   - Hard negative constraint in `AGENTS.md` and agent prompts forbidding unconstrained repository test suites (`npm test`, full `pytest`) during incremental implementation loops.
   - Intelligent auto-permissions gate intercepting unconstrained full-suite commands (`npm test`, bare `pytest`) in dev loops to prevent silent token burn and multi-minute stalls.
   - Repository-first selector discovery and diff-aware slice engine via `scripts/test-slice.mjs` (`npm run test:slice`).
   - Failure/fix loop mandate: specialists rerun only failed tests without repeating unchanged passing checks.
   - Observable task receipt contract in agent summaries reporting command, target count, duration (<10s), and selection rationale.
   - Bounded static/lint fallback for mapping gaps instead of escalating to global suites.
4. **Workspace Auto-Permissions (Scope Governance)**
   - Eliminate permission prompt fatigue during autonomous specialist runs.
   - Intelligent auto-approval of safe development commands (`node`, `python3`, `pytest`, `npm`, local test runners) within the workspace boundary while maintaining fail-closed blocks on destructive commands, privilege escalation (`sudo`), and read-only role violations.

---

## Road to 2.2.0 Minor Milestone

The `2.2.0` release will be the next minor architectural cycle. It introduces structural enhancements designed to lower token consumption, scale multi-agent coordination, and eliminate runtime overhead.

### 2.2.0 Workstreams & Themes

1. **Step-Ledger Execution Mode**
   - Execute complex workflows via atomic, single-step sub-sessions.
   - Each sub-session opens strictly with the active step's summary, objective, ledger key, and completion contract.
   - Gated progress: a step may transition to `done` only when a verification command exited 0 since the last file mutation.
   - Eliminates cascading context buildup, targeting up to 40x context token savings on large tasks.

2. **Dynamic Multi-Model & Fallback Routing (Jev)**
   - Introduce provider-aware fallback policies in the Jev Decision Router.
   - Dynamically route low-complexity or high-volume tasks across providers (Gemini, Claude, GPT) with automated retry on quota exhaustion (HTTP 429) or transient degradation.
   - Integrated with the in-memory event bus (`PantheonBus`) for real-time observability of routing decisions and token spend.

3. **Dynamic Capability Synthesizer & Role Morphing**
   - On-the-fly ephemeral specialist generation based on task profile.
   - Compiles ad-hoc bounded sub-specialists dynamically from the declarative roster base with tailored tool allowlists.

4. **Deep Scope Governance & Sandboxing**
   - Pre-flight validation of file-tree bounds, command allowlists, and tool grants *before* spawning a child subagent.
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

## What 2.1.x Delivered (Consolidated Record)

- **Canonical Deepwork Plan Architecture**: Structured JSON ground truth (`plan.json`) and append-only event log (`journal.ndjson`) with Mermaid DAG rendering.
- **Interactive Question Gate**: Native OpenCode `question` tool strictly enforced for open architectural trade-offs, requiring marked `(Recomendado)` defaults instead of unstructured chat questions.
- **Search & Worktree Freedom**: Removed all search and read barriers on `.pantheon/` and active worktrees across `@apollo`, `@themis`, `@athena`, and `@zeus`.
- **Declarative Agent Roster Generator**: Single typed manifest (`src/agents/roster.json`) mechanically compiling all 14 specialist prompts with `--check` CI gates.
- **Complete Session Todo Suite (`todowrite` + `todoread`)**: Full programmatic session task management, mirroring active deepwork plans directly into the TUI sidebar Todo block.
- **Strict Test Slicing Mandate**: Eliminated dev-loop agent stalls and context blowups by strictly prohibiting unconstrained test suites (`npm test`) during implementation and enforcing sub-10s targeted slices.
- **Workspace Auto-Permissions**: Seamless auto-approval for routine dev commands within the workspace, ending prompt fatigue.
- **Bilingual Documentation Portal**: Comprehensive English and Portuguese documentation with interactive SVG Mermaid diagrams and production recipes.

---

## What 2.0.x Delivered (Historical Foundation)

- **One installation, one contract**: The OpenCode V1 contract was removed; the plural `plugins` format on OpenCode 2.x is canonical.
- **High-speed reactive orchestration**: In-memory typed event bus (`PantheonBus`) with zero-latency background job tracking.
- **Themis local reflex loop**: Bounded autonomous self-healing for fast-path implementers without coordinator round-trips.
- **Cryptographic execution receipts**: SHA-256 fingerprinting of modified files and verification slices for delegated subagent tasks.
- **Deterministic KV-cache prompt layering**: Prompt prefix stabilization maximizing provider KV-cache retention.
- **Five isolated Python MCP servers**: Pinned runtime environments with per-agent tool allowlists.
- **Typed Decision Router (Jev)**: Structural risk ladder with `ask`/`rank`/`verify` semantics.
