# Pantheon Roadmap

This roadmap records customer-visible themes, maintenance boundaries, and readiness conditions for stable releases. Internal tracking identifiers, per-item evidence bundles, and per-commit history are intentionally not part of this page.

## Current State: 2.2.0 Stable (`v2.2.0`) & 2.1.x Maintenance (`v2.1.6`)

The `2.2.0` release consolidates the **100% Native OpenCode 2.x (`@opencode/plugin`) Architecture**, eliminating legacy V1/V2 split nomenclature, moving durable memory/persistence/goal/codemap operations in-process via `node:sqlite` FTS5, making the core execution roster (`@hermes`, `@demeter`, `@aphrodite`) **polyglot and stack-agnostic**, and delivering all **5 Orchestration Evolution Pillars** alongside the interactive **TUI Mission Control Cockpit** (`Overview`, `Swarm`, `Flightdeck`).

The `2.1.x` release series delivered the canonical Deepwork plan architecture, interactive native Question Gate enforcement, unrestricted `.pantheon/` and worktree access for analytical agents, bilingual documentation portals, live session Todo synchronization, observable test slicing, risk-based validation protocols, unified local/external skill discovery, deepwork resilience normalization, and workspace auto-permissions.

See [Compatibility](docs/COMPATIBILITY.md) for supported hosts and the [releases page](https://github.com/ils15/pantheon-opencode/releases) for published packages.

---

## 2.2.0 Deliveries (Native Quality, Pillars 1–5 & Cockpit)

1. **Clean `./server` vs `./tui` Bundle Separation & Zero-Init Provisioning**
   - Decoupled `./server` (`src/plugin/index.js`) from `./tui` (`src/plugins/tui/dist/tui.js`) so the server plugin loads in pure Node without pulling `@opentui/solid` into the host runtime.
   - Auto-provisioned all core/specialist agents (`ctx.agent.transform`) and canonical `/pantheon-*` slash commands (`ctx.command.transform`) with `AGENTS.global.md` reference registration (`ctx.reference.transform`) and KV-cache-preserving session instructions (`ctx.session.instructions.entry.put`).
2. **29 In-Process Native TypeScript Tools & SQLite FTS5 Persistence**
   - Registered 30 native plugin tools in-process (`memory_*`, `context_*`, `goal_*`, `code_*`, `ast_search`, `ast_rewrite`, `hashline_edit`, `shell`, `todowrite`/`todoread`, `pantheon_cost`, `pantheon_model`, `pantheon_skill_search`, `pantheon_deepwork`, `pantheon_step_ledger`, `pantheon_agent_forge`, `pantheon_local_decision`, `pantheon_review_verdict`, and `pantheon_worktree`) backed by `node:sqlite` WAL + FTS5 BM25 ranking and worktree-shared `.pantheon/` state.
3. **Pillar 1 — Post-Edit LSP Diagnostics Bridge & Structural AST Tools (`ast_search`, `ast_rewrite`)**
   - Hooked `execute.after` diagnostics into TypeScript (`tsc --noEmit`), Pyright (`--outputjson`), and optional stdio LSP framing (`PANTHEON_LSP_SERVER`) emitting `'lsp:diagnostics'`.
   - Exposed comment-aware, dependency-free `ast_search` and `ast_rewrite` tools with workspace path confinement and pre-write edit guardrail checks.
4. **Pillar 2 — Atomic Git Checkpointing & Sub-Session Step Runner (`ctx.session.create`)**
   - Wired isolated temp `GIT_INDEX_FILE` snapshots (`captureGitCheckpoint` / `restoreGitCheckpoint`), SHA-256 execution receipts (`pantheon_step_ledger`), and automatic rollback on `themis:reflex:escalated`.
   - Added `runAtomicStepSubSession` using `ctx.session.create` / `prompt` / `wait` / `remove` for single-step isolated execution.
5. **Pillar 3 — Native Worktree Orchestration (`ctx.worktree.transform`) & Typed Review Verdict (`pantheon_review_verdict`)**
   - Registered `ctx.worktree.transform` (`create`, `remove`, `list`) enforcing sibling `.pantheon-worktrees/<repo>/<task>` isolation.
   - Exposed `pantheon_review_verdict` emitting `'review:verdict'` and triggering bounded `ctx.session.synthetic` remediation turns (max 2) when `@themis` emits `BLOCK`.
6. **Pillar 4 — Mandatory Fault-Localization & Reproduction Gate**
   - Enforces a failing `record_reproduction` (`exitCode !== 0`) on `taskType: 'bugfix'` steps before unlocking production file edits (`edit`/`hashline_edit`/`ast_rewrite`) for `@hermes` or `@talos`, while allowing `RED` test creation first.
7. **Pillar 5 — Interactive `/pantheon-forge` Wizard & Stack Auto-Detection**
   - Added `/pantheon-forge` command, `detect_stack` action in `pantheon_agent_forge`, and `--project` stack hints in `bin/pantheon-init.mjs` (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`).
8. **TUI Mission Control Cockpit, `/pantheon-artifacts`, & Telemetry**
   - Built the native `@opentui/solid` `/pantheon-cockpit` dialog with `Overview`, `Swarm` (concurrency Gantt + semantic stream), and `Flightdeck` (Gate Matrix + event log) tabs accessible via `1–3` / `Tab`, plus `/pantheon-artifacts` with Unicode Mermaid rendering and Sidebar/Home links.

---

## Architecture Implementation Summary (v2.2.0)

| Architectural Pillar | Core Mechanism | Status in Pantheon `2.2.0` |
|---|---|---|
| **Structural Editing & Diagnostics** | `hashline_edit`, `execute.after` diagnostics + LSP bridge, `ast_search` / `ast_rewrite` | **Delivered (`v2.2.0`)** — `lsp-diagnostics.ts`, `ast-tools.ts`, `execute-after.ts`. |
| **Step-Ledger & Sub-Session Isolation** | SHA-256 receipts, isolated `ctx.session.create` runner, temp-index git checkpoints & auto-rollback | **Delivered (`v2.2.0`)** — `step-ledger.ts`, `step-runner.ts`, `git-checkpoint.ts`, `themis-reflex.ts`. |
| **Spec-First Review & Worktree Isolation** | `>>` Prompt Refinery, sibling `.pantheon-worktrees/` orchestration, `pantheon_review_verdict` + `ctx.session.synthetic` | **Delivered (`v2.2.0`)** — `worktree-orchestrator.ts`, `review-verdict.ts`, `plugin.ts`. |
| **Graph Localization & Reproduction Gates** | `code_index`/`code_query`/`code_neighbors` auto-pruning, failing `RED` test gate for bugfixes | **Delivered (`v2.2.0`)** — `codemap-tools.ts`, `reproduction-gate.ts`, `swe-eval-harness.ts`. |
| **Polyglot Core & Domain Extensibility** | Polyglot `@hermes`/`@demeter`/`@aphrodite`, `pantheon_agent_forge`, `/pantheon-forge`, deterministic stack detector | **Delivered (`v2.2.0`)** — `stack-detector.ts`, `agent-forge-tool.ts`, `commands/pantheon-forge.md`. |

---

## 2.1.x Maintenance & Active Deliveries

Active development on the `2.1.x` line focuses on operational smoothness and developer ergonomics:

### 2.1.6 Deliveries & Resilience
1. **Deepwork Resilient Normalization & Self-Healing**
   - Tolerant normalization for legacy Deepwork structures (array phases, single-object plans, missing timestamps, and malformed task records).
   - Decision slug normalization matching decisions irrespective of namespace prefixing.
   - Automatic fallback plan generation on unrecoverable syntax corruption, preventing unhandled agent loop failures.
2. **Tool Execution Workspace Root Binding**
   - Structural directory binding in `pantheon_execute` and `pantheon_command_runner` ensuring shell commands and scripts run from the active project workspace root (`toolContext.directory`), eliminating silent script failures when invoked from subdirectories.
3. **Strict JSON Schema Flattening**
   - Replaced complex nested `$ref` definitions with flat scalar schemas across all decision and plan tools, guaranteeing compatibility with strict OpenAI/Anthropic/Gemini function calling engines.
4. **Sequential Skill Installation Chaining**
   - Updated Zeus handoff protocol to chain multi-skill installation atomically with `&&` (`npx skills add <s1> -a opencode -y && npx skills add <s2> -a opencode -y`), preventing silent argument dropping by package managers.
5. **Fail-Fast Anti-Mocking Doctrine**
   - Strict architectural ban on dummy mock servers occupying real service ports; agents must fail fast with actionable root causes rather than mock upstream dependencies.
6. **Decoupled Background Server Processes**
   - Standardized persistent server lifecycles using `setsid nohup <cmd> > <log> 2>&1 &` (or `disown`), preventing process termination upon shell turn exits.
7. **Automated Project Git Initialization**
   - Automated `git init -q` in `pantheon-opencode init --project` when initializing projects without an existing `.git` directory.
8. **Native Vision Fallback Guidance**
   - Updated `pantheon-vision` MCP gateway error handling to include HTTP status codes and provide immediate guidance to OpenCode's native `vision_describe` tool.

### 2.1.5 Deliveries & Tool Hardening (Issue #444)
1. **Risk-Based Validation Protocol (Issue #444)**
   - Multi-tier validation protocol distinguishing narrow test slices (<10s), package-level integration suites, and mandatory repository CI gates.
   - Suite escalation strictly gated on explicit risk triggers (cross-module boundaries, breaking contract changes, auth/security boundary changes, or database migrations).
   - Observable task receipts in `subtask_summary` explicitly reporting `validation_scope` and deferred `pending_validation` (CI pipeline gates).
   - Anti-fatigue mandate: ban on removing tests solely to accelerate execution; failure/fix loops rerun only failed tests without repeating passing checks.
2. **Tool Execution Resilience & CLI Alignment**
   - Added `execute` fallback tool alias in V2 to execute workspace commands and scripts directly via `/bin/bash`, preventing `SyntaxError: Assigning to rvalue. Code must be plain JavaScript written as a program body` when models call `execute` with CLI commands or scripts.
   - Enforced CLI execution mandate in agent instructions: CLI utilities (`opencode-quota`, `git`, `npm`, `node`, `pytest`, `cargo`, `bash`) must run via `shell`/`bash`, not JavaScript eval.
   - Added anti-panic rule forbidding speculative recursive `glob`/`grep` in `~/.config` on execution errors.
   - Whitelisted `opencode-quota` in auto-permissions `SAFE_DEV_BINARIES` and installer bash permissions.
3. **Unified Skill Discovery & Local/External Coexistence**
   - Upgraded `pantheon_skill_search` with dynamic filesystem scanning (`scanInstalledSkills`), discovering project skills in `.opencode/skills/` and `.agents/skills/`, global skills, and internal Pantheon built-in skills.
   - Skill search results report `path`, `scope` (`internal | project | global`), and mark already-downloaded skills as `installed: true` with zero-network instant discovery.
   - Zeus coordination briefs include explicit skill paths (`Skill: <name> (Path: .opencode/skills/<name>/SKILL.md)`) and mandate specialist reading of `SKILL.md` prior to code generation.

### 2.1.4 Deliveries & Hardening
1. **Global Install Hygiene & PATH Shadowing Detection (Issue #424)**
   - Doctor check (H2b) detects PATH shadowing, version drift, and dangling binary symlinks across multiple global npm prefixes (`~/.npm-global`, `~/.nvm`, etc.).
   - Version skew validation in `resolveStablePantheonRoot` prevents `_npx` from silently registering a stale global package.
   - `sanitizeNpmEnv` cleanses `npm_config_allow_scripts` and `npm_config_approve_scripts` from nested lifecycle calls, preventing `EALLOWSCRIPTS` failures during TUI sync.
2. **Strict Test Slice Filter Ordering (Issue #442)**
   - Reordered `--test-name-pattern` flag ahead of the test file path in `scripts/test-slice.mjs` invocations so Node's native test runner enforces regex filters during failure/fix loops.
3. **Repository Internal & Traversal Exclusion in Permissions and Guards (Issue #441)**
   - Enforced deterministic path checks in `auto-permissions.ts` and `zeusReadGuard` denying `.git/**`, `node_modules/**`, and path traversal, backing prompt rules with structural security boundaries.
4. **Universal Session Todo Tool Availability (Issue #439)**
   - Granted `todowrite` and `todoread` across all 14 specialist agent manifests in `src/agents/roster.json` and registered tool capabilities, enabling seamless session task tracking.
5. **Session Auto-Discovery for Zen Vision (Issue #440)**
   - Automated OpenCode session ID discovery from environment (`OPENCODE_SESSION_ID`) and SQLite `opencode.db` (`session_v2`) for `vision_describe`, resolving orchestration vision calls cleanly.

### 2.1.3 Deliveries
1. **Observable & Enforceable Test Slicing (Anti-Fatigue Guard — Issue #437)**
   - Hard negative constraint in `AGENTS.md` and agent prompts forbidding unconstrained repository test suites (`npm test`, full `pytest`) during incremental implementation loops.
   - Intelligent auto-permissions gate intercepting unconstrained full-suite commands (`npm test`, bare `pytest`) in dev loops to prevent silent token burn and multi-minute stalls.
   - Repository-first selector discovery and diff-aware slice engine via `scripts/test-slice.mjs` (`npm run test:slice`).
   - Failure/fix loop mandate: specialists rerun only failed tests without repeating unchanged passing checks.
   - Observable task receipt contract in agent summaries reporting command, target count, duration (<10s), and selection rationale.
   - Bounded static/lint fallback for mapping gaps instead of escalating to global suites.
2. **Workspace Auto-Permissions (Scope Governance)**
   - Eliminate permission prompt fatigue during autonomous specialist runs.
   - Intelligent auto-approval of safe development commands (`node`, `python3`, `pytest`, `npm`, local test runners) within the workspace boundary while maintaining fail-closed blocks on destructive commands, privilege escalation (`sudo`), and read-only role violations.
3. **Live TUI Todo Activation & Complete Todo Suite (`todowrite` + `todoread`)**
   - Direct integration between `@zeus`/`@athena` coordination and the OpenCode V2 session todo tools.
   - Restored `todoread` to inspect active session tasks programmatically alongside `todowrite` (matching `opencode-todolist`).
   - Active plans and multi-step checklists automatically mirror to the Pantheon TUI sidebar Todo panel in real-time.
4. **Declarative Agent Roster Generator & Forge**
   - Centralized typed schema and manifest (`src/agents/roster.json`) driving all 14 specialist prompts (`src/agents/*.md`).
   - Mechanical compiler (`scripts/build-roster.mjs`) with `--check` CI gate, eliminating copy-paste drift and ensuring frontmatter conformance.
5. **Runtime Resilience & Guard Refinements**
   - Added `shell` tool execution alias in V2 to eliminate `No tool named "shell" is currently available`.
   - Refined `zeusReadGuard` to allow project-level metadata and configuration globbing (`*`, `**/package.json`) while strictly defending source code trees.

---

## Transitioned to Delivered (`2.2.0`)

100% of the workstreams chartered under `Road to 2.2.0` and the `2.3.0` evolution backlog are now shipped in **`v2.2.0`**:

1. **Delivered — High-Density TUI Mission Control Cockpit (`/pantheon-cockpit` · `Overview`, `Swarm`, `Flightdeck`) + Flightdeck Visual Replay Export**
   - Implemented natively using OpenCode's `@opentui/solid` UI engine (`1–3` / `Tab`, clickable Home `◈ Cockpit` link) with one-click / `x` **Flightdeck Replay Trace Export** writing Mermaid `sequenceDiagram` + Gantt reports into `.pantheon/reports/` for viewing in `/pantheon-artifacts`.
   - Specification reference: [TUI Mission Control Cockpit Design](docs/design/tui-mission-control-cockpit.md).
2. **Delivered — Step-Ledger Execution Mode (`pantheon_step_ledger` + `runAtomicStepSubSession` + Git Checkpoints)**
   - Enforces SHA-256 verification receipts, isolated `ctx.session.create` sub-sessions per atomic step, and temp-index git snapshots with automatic rollback on `themis:reflex:escalated`.
3. **Delivered — Multi-Provider Model Overrides, Jev Decision Router & Multi-IDE TCP LSP Proxy Pooling**
   - `pantheon_local_decision` + `pantheon_model` + `PantheonBus` structured telemetry (`'lsp:diagnostics'`, `'review:verdict'`, `'step:rollback'`, `'reproduction:gate'`, `'themis:reflex:escalated'`).
   - Post-edit diagnostics support `tsc --noEmit`, `pyright`, stdio LSP (`PANTHEON_LSP_SERVER`), and pooled TCP multi-IDE LSP sockets (`PANTHEON_LSP_TCP_ENDPOINTS`).
4. **Delivered — Persistent Multi-Repo Knowledge Federation & Polyglot Custom Specialist Forge**
   - Read-only cross-repository FTS5 memory lookup (`PANTHEON_FEDERATED_REPOS` / `~/.pantheon/federation.json`) with provenance in `memory_search` and `memory_stats`.
   - Stack auto-detection (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`) and least-privilege specialist scaffolding via `/pantheon-forge` and `pantheon_agent_forge`.
5. **Delivered — Deep Scope Governance & Reproduction Gates**
   - Symlink-confined workspace path guards, role-based execution restrictions, pre-edit failing test gates (`record_reproduction`) for bugfixes, and `ctx.worktree.transform` sibling isolation.

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
