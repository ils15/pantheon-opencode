# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).


## [Unreleased]

<!-- Add new changes here.
     Canonical sections (docs/RELEASING.md): ### 🆕 What's New (curated highlights, ≤6 bullets ≤140 chars) →
     ### Added / Changed / Deprecated / Removed / Fixed / Security → ### ⚠️ Known Issues / ### ✅ Closed Issues.
     `node scripts/versioning.mjs apply --notes` pre-fills the generated sections from conventional commits.
     Running apply will move this section to a versioned entry and reset the template below. -->

### Fixed

- **agents** — relaxed search boundaries in `@apollo`, `@themis`, `@athena`, and `@zeus` to permit reading active worktrees (`.pantheon-worktrees/**`) and Deepwork plans (`.pantheon/deepwork/**`).

## [v2.1.1] - 2026-11-13

### 🆕 What's New

- **Interactive Question Gate**: Native OpenCode `question` tool strictly enforced for all open decisions in planning, with marked defaults.
- **Runnable Real-World Examples**: Complete production examples (`examples/saas-dashboard` & `examples/cli-tool`) with automated test suites.
- **Comprehensive Docs & Wiki**: Modernized guides portal (`docs/guides/`), interactive Mermaid capability matrix, and GitHub Wiki mirror.
- **V2 Legacy Cleanup**: Removed obsolete "V2" naming clutter across internal policy markers, visual context tags, tape scripts, and docs.

### Added

- **docs** — modern guide collection (`first-project.md`, `deepwork.md`, `vision.md`, `cookbook.md`), bilingual README tables, and interactive Mermaid decision diagrams.
- **examples** — `saas-dashboard` (React 19 + Fastify + CSV streaming + canonical Deepwork plan) and `cli-tool` (repo health checker CLI with tests).
- **wiki** — comprehensive GitHub Wiki mirror in `wiki/` (`Home.md`, `Agent-Matrix.md`, `Deepwork-Guide.md`, `Pantheon-Vision.md`, `FAQ.md`).

### Changed

- **agents** — updated `@zeus`, `@athena`, and `prompt-refinery` to forbid dumping open questions into chat; required interactive `question` tool with marked `(Recomendado)` defaults.
- **core** — renamed internal markers to `<!-- pantheon-policy -->` and `<!-- pantheon-visual-context -->`; cleaned up legacy V2 file names.

## [v2.1.0] - 2026-11-12

### 🆕 What's New

- **Deepwork Canonical Plan**: Structured JSON ground truth (`plan.json`) and append-only event log with Mermaid DAG and zero HTML.
- **Vision Modernization**: Configurable Vision Model row in TUI Settings synced to `opencode-vision.json` and explicit `vision_describe`.
- **Project Skill Decision**: Proactive interactive question gate for external skills, strictly isolated into `.agents/skills/`.
- **TUI Settings Polish**: Full pt-BR localization across tabs, formatted status badges, and resolved title collision in Changelog tab.

### Added

- **deepwork** — canonical JSON-driven plan architecture, `pantheon_deepwork` tool, fail-first acceptance criteria, native `question` gates, and Mermaid DAG projections.
- **vision** — configurable vision model in TUI Settings (`Preset` tab), `.opencode/opencode-vision.json` support in Python MCP server, and explicit `vision_describe` guidance.
- **skills** — proactive interactive question gate for 1-click project-scoped installation (`.agents/skills/`) with execution delegated to `@hermes`/`@talos`.
- **tui** — Portuguese localization across tabs, rich system metadata in About tab, and formatted status badges (`< ativado >`, `< desativado >`).

### Changed

- **agents** — updated Zeus rules in `src/agents/zeus.md` and prompts to forbid manual terminal commands and enforce project-isolated `.agents/skills/`.

### Fixed

- **vision** — eliminate prompt context clutter and raw HTML comment dumps (`<!-- pantheon-v2-visual-context -->`), ensuring models invoke `vision_describe`.
- **tui** — resolved title collision visual bug in Changelog tab by splitting on delimiters and omitting empty middle box for highlight rows.

## [v2.0.4] - 2026-11-12

### 🆕 What's New

- **Container & JupyterHub Support**: Auto-detect environments and relax directory trust checks via `PANTHEON_ALLOW_GROUP_WRITABLE=1`.
- **Decision Router Diagnostics**: New Section L in `doctor` validating router configuration and fault-tolerant CLI diagnostics.
- **Reactive Event Bus**: Zero-latency in-memory event bus replacing disk file polling for background job status updates.
- **Themis Local Reflex**: Self-healing loop enabling implementers to remediate lint and test slice issues without coordinator.
- **Execution Proof Receipts**: Cryptographic verification receipts with SHA-256 fingerprinting for completed agent subtasks.
- **Prefix Cache & Prompt Diet**: Deterministic prompt layering and distilled instructions maximizing KV-cache hit rate.

### Added

- **routing** — add `PANTHEON_ALLOW_GROUP_WRITABLE` environment variable and auto-detection for container environments (JupyterHub, Docker, Kubernetes).
- **doctor** — add Section L to `scripts/doctor.mjs` checking Decision Router configuration trust and budget ledger accessibility.
- **orchestration** — in-memory `PantheonBus` event dispatcher with zero-latency reactive notifications for background job lifecycles.
- **orchestration** — `ThemisReflexController` bounding inline implementer self-healing to 2 retries before escalating to Zeus.
- **orchestration** — `createExecutionReceipt` and `verifyExecutionReceipt` with SHA-256 content hashes and verifiable test slices.
- **orchestration** — `buildPrefixCachedPrompt` aligning agent prompts with provider KV-cache prefix retention specifications.

### Changed

- **agents** — distilled system prompts for Talos and Apollo stripping generic MCP governance to maximize fast-path throughput.

### Removed

- **cli** — remove obsolete V1 legacy wizard documentation and comments in `model-command.ts`.

### Fixed

- **routing** — relax `assertTrustedDirectoryChain` and `validateDirectoryTrust` to accept root/sticky ownership and permitted group-writable ancestors.
- **cli** — wrap `readUserDecisionRouterConfig` in `status` and `doctor` commands to report clean errors instead of crashing.
- **jev** — surface specific failure details for `CONFIG_UNAVAILABLE` in `runGatedNativeJevCall`.


## [v2.0.3] - 2026-11-11

### 🆕 What's New

- **Simplified TUI Architecture**: Plain-language labels for Jev Assistant, Operation Mode, Cloud API Access, and Safety Gate.
- **Two-Tier Architecture Planning**: Concise 1-page visual summary in chat with full technical blueprint saved to disk.
- **Interactive Question Prompts**: Native question tool integration for prompt refinery disambiguation and plan approval gates.

### Changed

- **tui** — align row labels and group titles across Decision, Autonomy, and J1 Safety in PT-BR and EN.
- **planning** — decouple Athena plan into chat-friendly Executive Decision Contract and disk-based deep technical blueprint.
- **agents** — grant native question tool to Zeus and Athena for interactive UI choices and confirmation dialogs.


## [v2.0.2] - 2026-11-11

### 🆕 What's New

- **Timezone Locale Auto-Detection**: Auto-detects Portuguese in Brazil (America/Sao_Paulo) even when Linux LANG defaults to C.UTF-8.
- **Reactive Settings Live Preview**: Immediate real-time preview of language and layout changes across settings tabs before saving.
- **Bilingual TUI Tab**: Localized layout presets, separator glyphs, bar shapes, and status toggles for PT-BR and EN.

### Fixed

- **tui** — auto-detect pt-BR via Intl timezone (America/Sao_Paulo and Brazilian states) when LANG/LC_ALL is C.UTF-8.
- **tui** — use reactive tuiPrefs signal in settings tabs to enable instant live preview of language switching.
- **tui** — fully localize TUI tab row labels, groups, and explanatory notes in Portuguese.


## [v2.0.1] - 2026-11-11

### 🆕 What's New

- **Bilingual TUI Settings**: Portuguese (pt-BR) and English (en) with system locale auto-detection and manual toggle in the TUI menu.
- **Decision Model Selector**: Interactive selector in TUI settings to cycle across all remote Jev models without manual JSON editing.
- **Modernized Council Synthesis**: Domain Authority table, Mermaid arbitration diagram, and immediate action checklist.
- **Modernized Strategic Planning**: Sub-10s test slicing, Mermaid workflow diagram, impact matrix, and rollback blueprint.
- **Demystified J1 Safety Ladder**: Plain-language descriptions for execution modes (shadow, enforce, off) and safety limits.

### Added

- **tui** — bilingual dictionary and locale resolution helper (PT-BR / EN) in settings-i18n.ts.
- **tui** — language preference in TuiPrefs with cycling options (auto, pt-BR, en) and live preview.
- **tui** — unit test suite in tests/tui-settings-i18n.test.mjs validating locale and tab rendering.
- **routing** — permanent interactive target selector cycler row in the Decision tab across all modes.

### Changed

- **council** — modernized Zeus council synthesis with Domain Authority matrix and Mermaid graph.
- **planning** — modernized Athena strategic planning template with sub-10s test slicing.
- **tui** — humanized settings labels for Decision Router, Selection mode, Egress, and J1 Ladder.
- **tui** — localized Autonomy tab notes for Goal Loop continuation, budgets, and risk gradient.

## [v1.7.0] - 2026-11-07

### 🆕 What's New

- **Typed decision router with a real budget**: delegation, skills, ORDER, rank, verify, review modes — budgeted, reconciled, ~$0.000025/call.
- **J1 risk gate with a ladder**: off / shadow / warn / enforce — high-risk calls demand explicit human approval, never bypassed.
- **agent-forge**: forge an OpenCode agent on demand — interview, draft, confirm, write to project or user scope.
- **Skill discovery with a trust cascade**: Anthropic catalog → skills.sh → raw GitHub; Jev ranks; you install.
- **prompt-refinery in three tiers**: clear requests pass; vague ones get a silent internal adjust; full contract is `>>`-gated.
- **Last version supporting the OpenCode V1 contract (1.19.x)** — the next minor targets OpenCode 2.x only.

### Added

- **routing** — `mode: "order"` on `pantheon_jev_decide`: real top-K ordering of 2-4 candidates with a per-candidate fit score (an ordinal on the 2..10 rubric, never a probability).
- **routing** — `mode: "verify"` accepts optional `state` evidence the claims are judged against; verdicts PASS / UNVERIFIABLE / FAIL with BLOCK fail-closed on missing or refused answers.
- **routing** — rank accepts up to 20 candidates (typesafe_rank contract) and `CANDIDATE_INVALID` names the accepted range.
- **routing** — the input envelope is enforced on EVERY path (explicit, presets, review, rank, verify): schemaVersion required, unknown keys rejected with the exact cause.
- **routing** — review accepts criteria objects (`{id, description}`) alongside strings; refusals carry the `CRITERIA_SHAPE` detail.
- **routing** — `CALLER_NOT_ALLOWED` names the remedy: allowlist via `PANTHEON_JEV_SPECIALIST_CALLERS` or route through Zeus.
- **skills** — `agent-forge`: forge an OpenCode agent on demand — interview, canonical draft, confirm, write to project or user scope; never overwrites.
- **skills** — prompt-refinery in three tiers with the trust-cascade discovery ranking.
- **install** — decision-layer extras (J1/J3 shadow gates, specialist callers) ship pre-checked in the interactive setup.

### Changed

- **routing** — the J1 escalation ladder: off / shadow / warn / enforce via `PANTHEON_J1_RISK_SCORE`, with `PANTHEON_J1_ENFORCE_THRESHOLD` (default 0.8).
- **routing** — enforce denies a high-risk call with the HANDOFF CONTRACT: the agent presents the refused call for your manual decision; your approval mints a hash-pinned, TTL-bounded pass.
- **routing** — `CALLER_NOT_ALLOWED` names the remedy (allowlist via `PANTHEON_JEV_SPECIALIST_CALLERS` or route through Zeus).
- **skills** — the discovery ladder ranks candidates with Jev `mode: "order"` and documents the trust tiers; `mattpocock/skills` referenced for the GitHub tier.
- **agents** — nyx back to observability & cost analytics (chaos/fuzz secondary); prometheus without the observability words; mnemosyne and talos descriptions aligned to the catalog.
- **agents** — plan-persistence contract: Athena returns the plan, Zeus persists PLAN.md.
- **install** — decision-layer extras ship pre-checked; the installer heals the stale agent-source poison in BOTH configs (.json + .jsonc), repairing orphan commas.
- **docs** — README with mermaid diagrams (escalation ladder, refine tiers, trust cascade); COMPATIBILITY table updated for the 1.7.x line.

### Deprecated

- **OpenCode V1 contract (1.19.x)** — supported through this release, deprecated afterward: the next minor targets OpenCode 2.x only.

### Removed

- **The lexical skills prefilter** — replaced by the full-catalog offer (the filter dropped the exact skill the state described).
- **The Console Jev free-variant route** and the legacy PR+SHA beta-version scheme.

### Fixed

- **routing** — "Agent not found: zeus": the installer heals the stale cwd-relative agent-source field in both configs (root cause of the vanished roster).
- **routing** — N4 USAGE_UNRECONCILED 100%: dead — field-verified reconcile on the OpenRouter route.
- **routing** — the dead-route holds freezing budgets: released with the schema v4 archive.
- **routing** — D1/D2 of the local router: gateStatus influences the decision (GATE_OPEN); artifact-management reachable via material-requirement.
- **tui** — the version embed ships at the release version (the package gate now fails a stale TUI dist).
- **doctor** — recognizes the installer's own V2 shape (`{ package, options }`).

### Security

- The input envelope is closed on every path; hostile-prose scans cover criteria, claims and candidates; gate messages never echo tool input; approvals are hash-pinned to the exact refused call.

---

## [Unreleased]

<!-- Add new changes here.
     Canonical sections (docs/RELEASING.md): ### 🆕 What's New (curated highlights, ≤6 bullets ≤140 chars) →
     ### Added / Changed / Deprecated / Removed / Fixed / Security → ### ⚠️ Known Issues / ### ✅ Closed Issues.
     `node scripts/versioning.mjs apply --notes` pre-fills the generated sections from conventional commits.
     Running apply will move this section to a versioned entry and reset the template below. -->

## [v2.0.0] - 2026-11-11

### 🆕 What's New

- **OpenCode 2.x Architecture**: Official 2.0 release dedicated to OpenCode 2.x, removing legacy V1 shims for low latency.
- **Fast-Path Direct Dispatch**: Zeus executes direct implementation requests in 1 turn without mandatory planning or approval cascades.
- **Native Subagent Execution**: Parallel background subagents (task(background: true)) for non-blocking test and build workflows.
- **Implementer Tool Grants**: Added native glob, grep, and bash access across all implementers to eliminate discovery round-trips.
- **Prompt Diet & English Unification**: Condensed agent prompts by up to 70% and standardized instructions across all agents to English.
- **Full TUI Settings Suite**: Fullscreen settings overlay (/pantheon-settings) with Autonomy, Decision, TUI, and Doctor tabs.

### Added

- **agents** — Fast-Path Direct Implementation in Zeus routing direct coding requests immediately to domain specialists in 1 turn.
- **agents** — Native glob, grep, and bash permissions granted to implementers (Talos, Prometheus, Demeter, Hermes, Aphrodite).
- **agents** — Parallel background execution guidance for tests and builds using task(background: true).
- **tui** — Full-screen settings overlay (/pantheon-settings) with tabs for Autonomy, Decision, TUI Personalization, and Doctor.
- **tui** — Autonomy tab managing persisted goal loops, cooldown periods, and continuation caps.
- **tui** — Decision tab configuring Jev routing model, candidate selection mode, provider status, and egress consent.
- **skills** — In-process pantheon_skill_search with 24h query cache and test-slicing skill for fast bounded runs under 100ms.
- **routing** — Named-behavior overrides registered in routing.yml with pure loader and quarantine fallback.

### Changed

- **agents** — Condensed Hermes, Zeus, and Apollo prompts by up to 70%, eliminating tutorial boilerplate and saving >8,000 tokens per turn.
- **instructions** — Standardized all agent instructions and repository headers to English with zero-emoji enforcement.
- **install** — Native opencode plugin add pantheon-opencode flow, lean init, and automated sibling opencode.jsonc sync.
- **skills** — Progressive disclosure architecture separating core instructions (<120 lines) from references/.
- **council** — Assertive synthesis protocol with Domain Authority precedence and JEV arbitration.

### Removed

- 💥 **host** — Removed OpenCode V1 runtime contract, shims, and legacy bridge per ADR-0014.
- **install** — Removed interactive init wizard in favor of one-shot preview and /pantheon-settings configuration.

### Fixed

- **tools** — Replaced legacy shell permissions with native OpenCode V2 bash across all implementers.
- **tui** — Resolved tab squish and footer overlap on narrow viewports in settings window using flexWrap.
- **tui** — Fixed settings navigation loss and cyclic route structure errors when closing dialogs.
- **install** — Fixed missing pantheon tools caused by opencode.jsonc overriding opencode.json.
- **vision** — Reconciled temp-dir restart orphans and crash strays with disk cap.

## [v2.0.0-rc.2] - 2026-11-11

### 🆕 What's New

- **Token optimization**: Unified English instructions and condensed Zeus prompt to 73 lines with fast 1-turn bypass.
- **OpenCode V2 permissions**: Replaced legacy shell permissions with native bash across all implementers.
- **TUI settings stability**: Fullscreen settings view with flexWrap tabs and footer to prevent compression and overlap.
- **Sibling config sync**: Automated opencode.jsonc synchronization during install to guarantee pantheon tools.
- **Pruning CLI**: Added --deepwork and --worktrees flags to scripts/prune.mjs with clean reporting.

### Changed

- **agents** — Zeus prompt condensed to 73 lines with fast bypass and bounded read permissions.
- **agents** — Themis, Apollo, Athena, Hermes, and Zeus instructions standardized to English.
- **agents** — Cleaned emojis from all instruction headers and tables across src/instructions/.
- **install** — opencode.mjs synchronizes pantheon-opencode into sibling opencode.jsonc.
- **tui** — src/plugins/tui/src/pantheon-settings.tsx wrapped tabs and footer with flexWrap and capped dialog maxHeight.
- **scripts** — scripts/prune.mjs added findStaleDeepwork and findStaleWorktrees with zero emojis.

### Fixed

- **tools** — Fixed "No tool named 'shell' is currently available" by updating agent permission frontmatters to `bash: allow`.
- **tui** — Fixed squished tab labels and footer button overlap under narrow viewport widths.
- **install** — Fixed missing pantheon tools caused by opencode.jsonc overriding opencode.json.

## [v2.0.0-rc.1] - 2026-11-10

### 🆕 What's New

- **Release Candidate 1**: Inaugurating the RC series for Pantheon on OpenCode 2.x with verified production performance and low latency.
- **Agent token compaction**: Cleaned duplicated backend code from Prometheus and Apollo, reducing turn overhead by 8,150 tokens (-44.3%).
- **Pragmatism directive**: Eliminates bureaucratic deadlocks by authorizing safe diagnostic operations across Zeus, Themis, and Apollo.
- **Batched Suite TDD & test-slicing**: Full multi-endpoint suites implemented cohesively with deterministic test slicing in <100ms.
- **Proactive skill discovery**: Native skill search tool with 24h query caching and automated domain recommendations without shell access.
- **Live JEV verification**: 16/16 scorecard pass rate across local and remote providers ($0.0000238/decision) verified in sandbox app.

### Added

- **skills** — test-slicing (src/skills/test-slicing/SKILL.md): focused test execution with 10s budget and log noise suppression.
- **skills** — fast-path-execution (src/skills/fast-path-execution/SKILL.md): direct dispatch to specialists for bounded fixes.
- **skills** — batched-suite-tdd pattern added to tdd-with-agents: eliminates turn-inflation by validating multi-endpoint modules in a single sliced run.
- **tools** — pantheon_skill_search (src/pantheon/skill-search-tool.ts): in-process discovery tool querying local and external skills without shell permissions.
- **scripts** — in-memory search query cache with 24-hour TTL in scripts/skill-search.mjs to avoid redundant external CLI processes and latency.
- **sandbox** — full telemetry and simulation suite in ~/pantheon-sandbox/project-v2/app with native HTTP server, UI dashboard, and latency benchmarking.
- **tests** — regression tests in tests/tui-prefs.test.mjs (12 tests) and unit tests in tests/pantheon/skill-search-tool.test.ts.

### Changed

- **agents** — Apollo and Prometheus token compaction: removed 203 duplicated lines of Hermes backend code, saving 5,500 tokens per turn.
- **agents** — pragmatism directive: injected safe diagnostic authorization across Zeus, Themis, and Apollo to end analysis paralysis.
- **agents** — Athena visual planning: adopted modern linear phase structure, ASCII progress diagrams, and 3-tier refinement.
- **agents** — proactive skill discovery protocol in Zeus to propose ready-to-run package installations for specialized domains.
- **council** — assertive synthesis in zeus-council-synthesis.instructions.md with Domain Authority precedence and JEV arbitration.
- **install** — forward --project, --no-mcp, and --verbose in scripts/update.mjs to refresh configuration non-destructively.
- **hooks** — optimized format-multi-language.sh to parse tool inputs in a single Python inline execution instead of 3 subprocess spawns.
- **scripts** — lowered timeouts in scripts/skill-search.mjs from 60s/30s to 15s/10s for fast fail-open behavior.
- **docs** — streamlined README.md and README.pt-BR.md, trimming obsolete sections and detailing three visual execution tracks.

### Fixed

- **tui** — resolved TypeError on undefined prefs.layout.preset in src/plugins/tui/src/tui-prefs.ts.
- **agents** — fixed Zeus unable to search external skills under shell deny by providing in-process pantheon_skill_search tool.
- **tests** — dynamically bound catalog length in tests/pantheon/jev-decisions.test.ts.
- **bench** — fixed cost extraction bug in scripts/jev-live-probe.mjs and generated live scorecard in bench/results/j2-live-scorecard-2026-11-10.md.
- **sandbox** — fixed OpenCode 2.2+ runtime log detection in scripts/test-opencode-sandbox.sh.

### Security

- The input envelope is closed on every path; strict shell-deny boundary preserved with in-process tools without arbitrary command execution.

## [v2.0.0-beta.6] - 2026-11-10

### Added

- **tui** — the Autonomy tab: goal loop reachable (persisted mission, cooldown, continuation cap via `options.goal_loop`), decision budgets in-window, and the decision gradient documented
- **tui** — the Decision tab configures WHICH Jev: selection mode, explicit provider/model target, egress consent toggle, and per-provider key STATUS (values never enter the window)
- **tui** — a TUI tab: personalize sidebar lines/blocks, Context detail rows, gauge style, footer lines — durable storage, applied live
- **skills** — prompt-refinery: diagnose-first loop, blocking questions for materially-different readings (Jev `choice` when active), response format, self-check
- **skills** — skill-search ranks lexical relevance before the canonical boost ('webapp-testing' buried 'contract-testing')

### Changed

- **install** — a TTY `init` is banner → preview → ONE authorization; runtime config lives in `/pantheon-settings` or explicit flags

### Fixed

- **tui** — settings closes again: composer mode layers ate escape/q, and close-with-staged dialog was invisible on a route page
- **tui** — navigate-back threw "cyclic structures" (live route object): routes sanitized to the plain store shape
- **tui** — header showed vunknown: the version embed is authoritative now
- **tui** — Decision budgets write live; goal-loop caps bounded (1..200, cooldown ≥1s)
- **install** — every boot toasted "Plugin failed: …/src/plugin-v2": the dead 1.7-era bridge path is pruned on registration
## [v2.0.0-beta.5] - 2026-11-09

### Added

- **tui** — settings gains a **TUI** tab: sidebar header lines/blocks, Context detail rows, gauge style (`both/bar/percent/off`), footer lines — durable storage, live on save

### Changed

- **install** — the interactive wizard is removed: a TTY `init` is banner → preview → ONE authorization (default no); runtime config lives in `/pantheon-settings` or explicit flags

## [v2.0.0-beta.4] - 2026-11-09

### Added

- **tui** — the settings window becomes a full-screen tabbed window (the OpenCode Quota shape): a tab header (`1-9`/`tab`), grouped setting rows with `←/→` value cyclers, a note column, and draft semantics — `ctrl+s` saves staged changes through the per-surface guards, `ctrl+r` resets the tab, `esc` with staged changes confirms before discarding, and every refusal (corrupt overrides, missing egress consent) surfaces in a warning notice line
- **tui** — the settings surface moves to the host's router page: true full-screen, opens from the home route and sessions (`ui.router.register` + `navigate({type:'plugin'})`, the bundled opencode.diffs pattern); hosts without it fall back to the dialog with the same commands

### Fixed

- **tui** — settings navigation no longer loses keys to the dispatch panel: the settings keymap layers register once at setup with priority 1, and the dispatch panel's layer sleeps while a Pantheon settings surface is open (the beta.2 "navigation stopped working" field report, diagnosed from the host binary's conflict-resolution order)

## [v2.0.0-beta.3] - 2026-11-09

### Fixed

- **update** — the global-install guard refused npm's own symlinked bin layout: `prefix/bin/pantheon-opencode` is a symlink into the package, so `pantheon-opencode update` answered the checkout refusal on every symlink-creating install. The running side follows links now; `npm link` stays refused (the installed entry itself must be a regular directory).


 Running `node scripts/versioning.mjs apply` will
## [v2.0.0-beta.2] - 2026-11-09

### Added

- **tui** — the settings window becomes a sectioned window (`tab` cycles sections): Gates & Overrides, Decision Model, Model Preset, J1 Risk Gate, Updates, Doctor, About
- **tui** — Decision Model section: enable/disable the decision router live — the runtime re-reads the config on every gated call; egress consent stays CLI-owned and enabling remote candidates without it is refused
- **tui** — Model Preset section: activate any routing.yml preset globally (atomic write, `.bak` backup); `none` deletes the marker; a project marker wins every runtime candidate list and shows read-only
- **tui** — J1 Risk Gate status section: ladder mode, enforce threshold, effective gate state — the env-only config is displayed, never written (a file surface is a runtime-plugin change, deferred)
- **tui** — Updates section: channel classification (prerelease suffix → `beta`), last-check state, and a `Check now` action against the registry dist-tag matching the running channel; a stable install is never advertised a beta
- **tui** — Doctor section: install-version drift (H2), Node floor, overrides-file validation (K), decision-config health — file-derived checks only; process/network checks stay in `pantheon-opencode doctor`

### Changed

- **tui** — the typecheck gate points at real files: the old includes referenced deleted V2 entries, so nothing had been type-checked since the rewrite; the settings modules typecheck under the repo's strict settings and update-notice's latent violations are fixed

### Fixed

- **tui** — the settings window is closable again: `dialog.clear()` inside the host's dismissal path re-entered the dialog stack and left the window permanent (beta.1 field report)
- **tui** — overrides state guards: a corrupt global overrides file refuses writes instead of silently dropping the other entries on the next toggle; `replace` entries survive disable (content preserved) and restore on re-enable; project-file entries show a `(project)` marker and are not togglable from the window

## [v2.0.0-beta.1] - 2026-11-08

### Added

- **skills** — progressive disclosure across the corpus: `references/` + Routing tables, 120-line core budget, lock pins every reference; instruction-forge doctrine skill
- **routing** — named-behavior overrides: registry in routing.yml, pure loader, installer skip/replace, doctor validation with --fix quarantine
- **validate** — structural instruction evals (tests/eval) in the regular node tier; the secret-mask parity pins the single TypeScript copy
- **install** — native plugin-add happy path (`opencode plugin add pantheon-opencode`); npx init demoted to the 1.x migration path
- **routing** — Jev choice ceiling 32 with reserved host-skill slots (host skills always ride, field report beta.15)
- **tui** — `/pantheon-settings` window (palette: `Pantheon: Settings`): keyboard-first toggles for the runtime gates, writing the global `pantheon-overrides.json` the installer and doctor consume

### Changed

- **plugin** — one generation, canonical names: src/plugin.ts, decision-* modules, tui/server TUI, PANTHEON_* env vars
- **installer** — the probe must confirm OpenCode 2.x before any write; the singular plugin key is legacy cleanup; version-gate tests speak the refusal contract
- **doctor** — named-behavior override validation (check K) with --fix quarantine; the report names its source database

### Fixed

- **vision** — temp-dir reconciliation: restart orphans in `pantheon-vision` become visible to the LRU disk cap again, and crash strays (`.tmp-<pid>`) are swept age-guarded

### Removed

- **plugin** — the OpenCode V1 contract (1.19.x hosts): V1 plugin, bridge, hooks, goal-loop lifecycle, tool-ceiling, presets application
- **validate** — the v1-permission canary proofs and the dual-generation test branches

### Security

- vision-local mime detection linearized (js/polynomial-redos); budget child scripts pass data via argv (js/bad-code-sanitization); the egress endpoint assertion parses URLs
## [v1.7.0-beta.1] - 2026-11-07

## 🆕 What's New
- **`mode: "order"`** no Jev: ordenação real de 2-4 candidatos com score por candidato (rank escolhe vencedor; order classifica a shortlist).
- **J1 approval gate** com escada off/shadow/warn/enforce: chamada de risco alto exige APROVAÇÃO EXPLÍCITA do usuário (hash-pinned, TTL 15min) — nunca contorno.
- **`agent-forge`**: cria um agente OpenCode sob demanda — entrevista, rascunho canônico, confirmação, gravação em escopo projeto/global.
- **prompt-refinery em 3 níveis**: pedido claro passa intacto; ajuste mínimo interno (≤15 linhas); contrato completo só com `>>`.
- **Descoberta de skills com cascata de confiança**: catálogo canônico Anthropic → skills.sh → GitHub cru, ranqueado por Jev order; instalação só pelo usuário.
- **Correções do campo**: criteria-objeto no review, banda UNVERIFIABLE no verify com evidência (`state`), jsonc heal (o veneno que sumia com o roster), D3 PT-starvation,CRITERIA_SHAPE com remedio, verify band edges.
- **Jev REAL**: 275 decisões reconciliadas, $0.0068 acumulado (~$0.000025/decisão).


 - 2026-11-07

## 🆕 What's New
- **skills** — the three-tier refine — minimal adjust default, full contract via >> only
- **skills** — the refinement tiers — internal minimal adjust, >> full contract
- **routing** — the pre-stable cost inventory
- **skills** — the enhancer references and project-convention priority
- **skills** — the three-tier refine — minimal adjust default, full contract via >> only
- **routing** — the external-ref regressions
- **routing** — the criteria object form and the fixture-vs-work rule
- **install** — the deterministic refine trigger
- **skills** — agent-forge on-demand agents and the order-mode discovery ladder
- **routing** — the J1 approval gate — explicit ask, hash-pinned pass
- **routing** — the J1 enforce handoff contract — risk hands off to the human
- **routing** — the order mode (top-K ordering) and the noul rename
- **routing** — the J1 escalation ladder (off/shadow/warn/enforce) and the caller-refusal remedy
- **skills** — the prompt-refinery contract and the nyx observability restore
- **install** — one coherent setup summary — inline warnings, project-only worktree box, flags hint
- **routing** — the beta.12 field acceptance record
- **tui** — the paginated What's New window with the curated summary contract

## 🐞 Fixed
- **install** — the jsonc heal repairs orphan commas
- **config** — the jsonc heal and the venv-aware test:ci
- **validate** — the V2 package probe
- **routing** — the local-router D3 PT fallback and the D4 polarity docs
- **install** — heal the cwd-relative agent source field — the Agent-not-found root cause
- **routing** — the beta.13 field report — verify evidence, popularity parser, stable plugin root
- **routing** — the field-report corrections — descriptions ride, envelope everywhere, rank 20, gate influence
## [v1.6.3-beta.28] - 2026-11-07

## 🆕 What's New
- auto-continue split: core 2,656→1,003 tokens, the cooldown/timeout/checkpoint details moved to references/ (read under demand). The checkpoint contract is intact — the test follows the move.
- prompt-refinery tiers finalized: Tier 1 is an INTERNAL minimal adjust (the user sees the work begin, no approval ceremony; generous scope when the request demands); the six-section contract is EXCLUSIVELY the >> prefix; clarifying questions ride the native question tool.
- Descriptions trimmed keeping triggers (mnemosyne, agent-forge, prompt-refinery); skill-creator referenced in agent-forge.

## [v1.6.3-beta.27] - 2026-11-07

## 🆕 What's New
- prompt-refinery em TRÊS níveis com custo controlado por limite de saída (não por tier de modelo): pedido claro passa intacto; o sinal determinístico dispara o AJUSTE MÍNIMO (≤15 linhas — PT corrigido, estrutura leve); o contrato completo de seis seções é EXCLUSIVO do prefixo `>>`. Referências incorporadas: prompt-enhancer (opt-in, cap, fail-open) e prompt-improver (nudges self-cancel-cheap, clarificação com opções). Falha = fail-open; convenções do projeto têm prioridade sobre defaults.

## [v1.6.3-beta.26] - 2026-11-07

## 🆕 What's New
- The installer heals the stale agent-`source` field in the sibling opencode.jsonc too — the field that kept the roster invisible outside the config dir even after the .json heal (field beta.25: sessions fell back to the default agent and pantheon_jev_decide was nowhere).
- `test:ci` prefers the repo venv when present, so the Python tier runs the pinned fastmcp/mcp instead of whatever the system python has.

## [v1.6.3-beta.25] - 2026-11-06

## 🆕 What's New
- The external-research regressions: three refiner fixtures (cited-scenario analyzes, direct-vague contracts, bounded-fix executes), skills review hardened (origin/adoption are signals, dangerous content blocks regardless of popularity), and the order score documented as an ORDINAL on the 2..10 rubric — never a probability.
- The beta.24 battery #10 exact PT payload is a regression test now (the CRITERIA_SHAPE fix holds under its exact shape).

## [v1.6.3-beta.24] - 2026-11-06

## 🆕 What's New
- Refinement is now DETERMINISTIC: the local router computes `refineRecommended` from pure text rules (multi-concern, no acceptance criteria — PT+EN; one-liners never refine; explicit criteria suppress). No Jev, no model judgment, zero cost — badly structured prompts get the refine signal before they can degrade processing, and zeus treats the signal as obligatory.

## [v1.6.3-beta.23] - 2026-11-06

## 🆕 What's New
- Doctor recognizes the installer's own V2 shape again (`{ package, options }` was never probed — a healthy config read as "no V2 generation registered").
- TUI version embed rebuilt (the footer no longer says beta.15).
- The prompt-refinery contract is bound to the FIRST turn: no reads, no dispatches before it (field evidence: discovery-first burned a delegation and still ended in the same questions).

## [v1.6.3-beta.22] - 2026-11-06

## 🆕 What's New
- `agent-forge` skill: ask for a dedicated agent ("cria um agente de reviews de PR") and Pantheon interviews you, drafts the canonical agent file (least-privilege permissions, registered-tools-only grants, the governance ladder), confirms, and writes it project- or user-scoped — the host loads it on the next session.
- Skill discovery now ranks with Jev `mode: "order"`: the top cascade candidates return a full descending ordering with fit scores, not a single winner. `mattpocock/skills` joins the GitHub tier as a known-good reference repo.

## [v1.6.3-beta.21] - 2026-11-06

## 🆕 What's New
- The J1 enforce block is now an APPROVAL GATE: a high-risk call is denied with an ask — the agent questions the user under a `j1-approval-<hash>` marker; an affirmative answer mints a hash-pinned, TTL-bounded (15 min), session-scoped pass for that exact call, and the retry executes (and records). No observed answer, no pass — fail-closed.
- QA beta.20 fixes: verify verdict band precedence (0.35–0.65 UNVERIFIABLE inclusive; PASS strictly above), order maps scores back to the caller's candidate ids, `=shadow` no longer reads as off, scorecard count/cost honesty.

## [v1.6.3-beta.20] - 2026-11-06

## 🆕 What's New
- The J1 enforce block is now a HANDOFF CONTRACT: a high-risk call is denied with instructions to present it to the user for a MANUAL decision — no executing, no working around; the message names the levers (threshold, mode, rerun without the risky step).

## [v1.6.3-beta.19] - 2026-11-06

## 🆕 What's New
- Local router D3 fixed: a PT-BR delegation no longer starves on skills — when the English-lexical prefilter matches nothing but the agent is known, the agent's curated delegation-relevant grants feed the turn (same domain, EN fed / PT starved was the four-report-old field bug).
- D4: the complexity dimensions' polarity is documented where it bit — higher = riskier/less contained (boundedness:2 is POORLY bounded), aggregate label = max(dimensions).

## [v1.6.3-beta.18] - 2026-11-06

## 🆕 What's New
- `mode: "order"`: ORDER 2-4 candidates by fit — one score question per candidate, the descending ordering with per-candidate scores comes back (nulls visible, last, never guessed). Rank picks a winner; order ranks the shortlist.
- The review questions are self-documenting now: `quality` (score) and `needs_review` (predicate) — "noul" was the decision model's internal archetype leaking into user-visible payloads.

## [v1.6.3-beta.17] - 2026-11-05

## 🆕 What's New
- The J1 gate is now a ladder: off / shadow / warn / enforce (PANTHEON_J1_RISK_SCORE). Enforce awaits the bounded gate and DENIES a high-risk tool call in-session, with the threshold configurable (PANTHEON_J1_ENFORCE_THRESHOLD, default 0.8). Shadow stays the default-on behavior.
- CALLER_NOT_ALLOWED refusals now teach the fix: allowlist the caller via PANTHEON_JEV_SPECIALIST_CALLERS or ask Zeus to route.
- Plan persistence contract: Athena returns the plan as her response; Zeus persists PLAN.md — no more refused write attempts on deepwork plans.

## [v1.6.3-beta.16] - 2026-11-05

## 🆕 What's New
- `prompt-refinery` skill: a vague multi-part request is refined into a structured contract (objective, slices, acceptance criteria, open questions with defaults) shown for confirm-or-adjust BEFORE executing — one planning turn on the session model.
- Skills mode offers the full local catalog + host skills — the lexical prefilter could drop the exact skill you described (codemap → none 0.88). candidateSource still reports the pool.
- nyx returns to observability & cost analytics (owner intent), prometheus drops those words — the routing you expected now matches the catalog.

## [v1.6.3-beta.15] - 2026-11-05

## 🆕 What's New
- "Agent not found" fixed: the installer stops writing the cwd-relative agent `source` provenance and heals it away from existing installs — the host 2.2.5 resolved it against the session cwd and the whole roster vanished outside the config dir.

## [v1.6.3-beta.14] - 2026-11-05

## 🆕 What's New
- pantheon-tui loads on every boot again: the server stub now exports the definition object host 2.2.5 requires (was ~3 load failures per boot, forever).
- verify accepts optional `state` evidence and reports UNVERIFIABLE for the 0.35–0.65 band — false and "could not tell" are no longer the same verdict.
- The skills-search popularity parser reads K/M counts — the most popular results no longer vanish from the skills.sh tier.
- The installer never leaves the plugin registered into the volatile npx cache (the intermittent plugin-death root cause); the preflight also covers pure-V2 configs now.
- prometheus's description names observability/tracing — the reform's domain split is now visible to the router.

## [v1.6.3-beta.13] - 2026-11-05

## 🆕 What's New
- One coherent setup summary: a single closing block instead of two competing "Next steps" lists.
- Warnings restate their text inline — no more hunting for what scrolled past.
- The worktree guidance box is project-only (a global install from $HOME showed a nonsense path).
- The banner now prints the exact `source` line for the decision-layer flags file — the silent-off gap fixed.

## [v1.6.3-beta.12] - 2026-11-05

## 🆕 What's New
- Delegation answers are domain-aware again: agent descriptions ride with every choice — live probe 5/5 exact (FastAPI→hermes, WCAG→aphrodite, Alembic→demeter, security→themis, poem→none).
- The input envelope is enforced on EVERY path now: presets, review, rank and verify all refuse missing/unknown keys with the exact cause.
- Rank accepts up to 20 candidates (typesafe_rank contract) and names the accepted range on refusal.
- Skills results report where the candidates came from (`candidateSource`), ending silent prefilter misses.
- The local router respects open gates: review/approval required → abstain (`GATE_OPEN`), never route around.

## [v1.6.3-beta.11] - 2026-11-05

### 🆕 What's New
- Measured MCP usage policy across the roster — governance ladder byte-identical in all 13 specialists.
- Skill-discovery pipeline with the trust cascade: Anthropic catalog → skills.sh → GitHub; Jev ranks, you install.
- Dead-route holds release (ledger schema v4) — the fix for budgets frozen by removed routes.
- Roster reform: nyx re-scoped to chaos & adversarial, talos aligned to hotfix, domain docs per agent.
- Jev validated end to end in the field: N4 dead, verify field-verified, sandbox 28/28.

### Added

- **agents** — The roster reform, measured: the governance ladder (session context → free local selector → one typed Jev question → MCP last resort, with the durable-store, milestone-checkpoint and one-pass-vision rules) now sits byte-identical in all 13 specialist agents, pinned by `tests/agent-mcp-policy.test.mjs`; nyx is re-scoped to its intended chaos & adversarial identity (its observability body duplicated prometheus and left fuzzing uncovered — the observability material moved to prometheus); mnemosyne's description names its memory-MCP curation ownership; the live scorecard's talos scenario now matches the real hotfix-express-lane identity. Post-reform live scorecard: 14/16 exact, 8/8 on the zero-dispatch agents.
- **skills** — The skill-discovery pipeline: installed pool first (one Jev `mode: "skills"`), then one read-only search across the trust cascade — the canonical `anthropics/skills` catalog first (so `pdf`/`docx`/`mcp-builder` outrank the clones popularity ranking surfaces), the skills.sh index with install counts, then raw GitHub `SKILL.md` code search (8,480 hits where the index offered three) — via `scripts/skill-search.mjs` emitting tier-ordered `{skill, installs, url, source}` JSON, pinned by `tests/skill-search.test.mjs`, then one typed Jev choice question ranking the candidates (only names/counts/descriptions cross — skill contents are untrusted), then the winning candidate is PROPOSED to the user with the project-scoped install command. Pantheon never installs; the review is the user's. The ladder is documented in `docs/reference/native-decisions.md` and carried in `zeus.md`.
- **routing** — `decision-router holds release --provider <dead> --reason "<why>"`: the administrative correction for holds of routes that no longer exist (they can never reconcile and froze budget forever — the mechanical story behind the mid-month Jev die-offs). Ledger schema v4 adds the immutable `released_holds` archive; live providers are refused, their holds roll off with the period. First field application: the 10 `jev-free` fossils of the removed free route released, $1.00 of reserved budget freed.
- **mcp** — `bench/mcp-usage-audit.mjs`: the measured native-MCP usage audit (transcript, memory db, persistence kv, bench lines → dated report in `bench/results/`; reports are local-only, they carry bounded session excerpts). First run measured the whole field history: 5.7k memory touches, 2.5k persistence, 84 vision — the verdicts and cost model live in `docs/mcp-tools.md`.

- **agents** — The 14-agent domain-artifact analysis (docs/agents/README.md): each specialist owns its domain's durable file — aphrodite keeps docs/ui/conventions.md current whenever the project has a graphical surface, demeter docs/data, hermes docs/api, prometheus docs/infra — read-first, propose-when-missing, update-only-what-you-changed; new exclusive per-agent tools fail the measured bar (grants already enforce the exclusivity that pays).


### Changed

- **agents** — The zeus usage policy is measured, not decorative: `memory_store` takes durable, reusable facts only (session narration goes to a checkpoint or nowhere; per-project namespaces; update instead of duplicate), checkpoints fire at milestones only (never per turn, never re-saving an unchanged key), and vision runs one pass per image (zeus and aphrodite) — each vision call is real gateway spend. The contradictory store phrases that produced the narration excess are gone, pinned by `tests/agent-mcp-policy.test.mjs`.

## [v1.6.3-beta.10] - 2026-11-04

### Fixed

- **routing** — The Jev input envelope is enforced: schemaVersion is required (SCHEMA_VERSION_INVALID) and unknown keys are rejected (UNKNOWN_INPUT_KEYS) — the declared contract is now the enforced contract (field report N2/N3).

<!-- beta.7–beta.9 were landed together in 548fc6d; separate commits for these releases are absent from repository history. Per-beta attribution follows that commit’s grouped changelog snapshot. -->

## [v1.6.3-beta.9] - 2026-11-04

### Changed

- **agents** — The live scorecard now runs the full 13-specialist catalog (was a 5-agent sample); first full-catalog run: 6 exact hits, 2 domain-adjacent judgment calls, measured per agent.
- **agents** — Zeus gains consolidated MCP call-timing rules: when to recall, when to store, when to checkpoint, when vision fires, and the escalation order (local selector -> Jev -> MCP last resort).

## [v1.6.3-beta.8] - 2026-11-04

### Added

- **routing** — The v3.1 **rank** and **verify** primitives on `pantheon_jev_decide`: `mode: "rank"` picks the winner among up to 8 candidates with a fit score (the host answers one scalar per question, so full ordering is impossible — documented); `mode: "verify"` checks 1–4 claims as predicate questions with **BLOCK fail-closed**. Hostile inputs rejected. Zeus-only, same gate chain.

## [v1.6.3-beta.7] - 2026-11-04

### Added

- **routing** — `jev-live-probe.mjs`: the operator-run live measurement tool. `--ping` only resolves the configured route locally (exit 0 when valid; no provider call); `--scorecard` runs the 16 configured live scenarios against that route and writes the dated scorecard into `bench/results/`. First live run: 7/8 correct specialist picks via OpenRouter.

## [v1.6.3-beta.6] - 2026-11-04

### Added

- **install** — The setup wizard gains a **decision-layer step**: the shadow gates (`PANTHEON_J1_RISK_SCORE`, `PANTHEON_J3_ESCALATION`) and the specialist-caller allowlist (`athena,themis`) become first-class setup choices, written to `~/.config/pantheon/decision-flags.env` (source it from your shell profile). All advisory/shadow; none change behavior by default. Part of the ratified setup modernization.

## [v1.6.3-beta.5] - 2026-11-04

### Fixed

- **routing** — The ledger model-key slash fix (vendor ids like `typesafe/jev-1.13`) re-landed after being silently lost in a branch reset: the shipped beta.4 refused the OpenRouter model key with `invalid-model`. Field-verified end to end on the user's host: `advisory:true`, real Jev answer via OpenRouter at $0.00003/decision.
- **install** — The Jev wizard shows the full live route matrix with credential-state hints (checked hint when `OPENCODE_API_KEY`/`TYPESAFE_API_KEY`/`CLOUDFLARE_API_TOKEN` is in the shell; the exact export when not).

## [v1.6.3-beta.4] - 2026-11-04

### Added

- **routing** — `decision-router setup-model cloudflare-workers-jev/clef --account-id=<id>` provisions the Cloudflare Workers AI custom provider entry (accountId + `models.clef`, type `"decision"`); the token rides `CLOUDFLARE_API_TOKEN` in the host environment. Docs record the OpenAI Decisions protocol and the what's-new TUI window as deliberately unwired candidates.

## [v1.6.3-beta.3] - 2026-11-04

### Fixed

- **routing** — The OpenRouter-hosted Jev route settles end to end: the usage-evidence validator and the budget ledger now admit the `openrouter` accounting provider and vendor-slash model ids (`typesafe/jev-1.13`). Field-verified on the user's host: Zeus → `pantheon_jev_decide` (mode skills) → real Jev answer via the stored OpenRouter credential, $0.00003 per decision, usage reconciled.

## [v1.6.3-beta.2] - 2026-11-04

### Removed

- **routing** — The Console Jev **free variant** route (`opencode-console-jev-free` / `jev-1.13-free`) is removed from the matrix, the wizard, and the ledger: the free tier is rate-limited hard enough to 429 mid-work (field-measured), which is exactly the failure mode a decision route must not have. Existing configs selecting it degrade to skip with a fix hint pointing at the Zen-credited route (`OPENCODE_API_KEY`) or the TypeSafe direct route.

## [v1.6.3-beta.1] - 2026-11-04

### Added

- **routing** — The decision-provider matrix expands to the host-embedded decision modules confirmed in the 2.2.5 binary: `openrouter-jev` (OpenRouter-hosted `typesafe/jev-1.13`), `vercel-gateway-jev` (Vercel AI Gateway `typesafe-ai/jev`), and `cloudflare-workers-jev` (Workers AI `clef`; needs a custom entry with your accountId). Route resolution stays config-only; `doctor` gains route-aware rows per provider.
- **routing** — Specialist caller allowlist: `PANTHEON_JEV_SPECIALIST_CALLERS` (CSV, default empty = Zeus only) lets named agents call `pantheon_jev_decide` with explicit typed questions; preset modes stay orchestrator-owned. The permission assertion and the success output carry the real caller; caps and the `decision.egress` kill-switch are enforced per call regardless of caller.
- **routing** — `DECISION_CALL_FAILED` surfaces the provider reason class, integer status and retry window (rate limits now self-explain); `QUESTIONS_INVALID` carries a per-cause `detail` token (ten causes, one each); the tool description states the required-fields contract on its surface.

### Fixed

- **routing** — The TypeSafe provisioner writes a **complete** custom provider entry: the `@ai-sdk/openai-compatible` adapter, the `api.typesafe.ai/v1` baseURL, and an `apiKey` env reference (`{env:TYPESAFE_API_KEY}` — the key itself never lands in the config file). Field evidence: a models-only entry is inert because models.dev has no typesafe-ai entry, so `/connect` and `opencode auth login` cannot supply it and the decisions call 404s. `doctor` now warns when the entry lacks the apiKey; the activation path is `export TYPESAFE_API_KEY=...` + restart.

## [v1.6.2] - 2026-11-03

### Added

- **routing** — The Jev uplift: the native `pantheon_jev_decide` route works end to end (Console free variant field-verified), and TypeSafe direct is one `decision-router setup-model` command away.
- **routing** — `decision-router doctor` is route-aware: Console routes pass host-native without a catalog probe; the TypeSafe route is checked against the provider entry.
- **hooks** — J1 risk-score advisory gate (shadow): one Jev risk-score + intent observation per exfil-capable tool call when `PANTHEON_J1_RISK_SCORE` is on; never blocks; zero user content.
- **hooks** — J3 turn-complexity escalation (shadow): cheap-vs-main per delegate dispatch with local rails, behind `PANTHEON_J3_ESCALATION`; the override is proven, never applied in shadow.
- **routing** — J4 `mode: "review"` quality scoring: one round-trip quality + needs-review predicate for delegated results, on demand; the result never leaves the machine.
- **routing** — The offline J2 skill-selection scorecard harness ships in `bench/results/` (29 scenarios, replies faked, honest negatives).
- **install** — `init` sweeps stale `pantheon-opencode` copies from the npm cache's `_npx/` after a successful install (failures retry on the next init).

### Deprecated

- **install** — `--opencode-version v1` keeps its deprecation warning on this line; Pantheon 2.0 refuses it outright.

### Removed

- **tui** — The native `/quota` panel, the sidebar quota block, usage history, go-key diagnostics, and the `pantheon.quota` RPC; see the community replacement below.
- **tui** — `/quota-go-check` and the undocumented `PANTHEON_TRUSTED_BL_EXECUTABLE` env var.
- **docs** — The quota replacement is documented in `docs/tui-v2-quota-providers.md`: `@slkiser/opencode-quota`.

### Fixed

- **routing** — Three field-measured causes of a dead `pantheon_jev_decide` are fixed: the detached `model.list()` call, the wrapped `{ data: [...] }` shape, and the catalog-presence gate.
- **routing** — Decision models are not chat models: route resolution reads config only; the visible `pantheon-decision-router:v1` prompt marker is suppressed.
- **agents** — Zeus's decision-routing instructions no longer reference the removed `/quota-go-check` command.

## [v1.6.2-beta.17] - 2026-11-03

### Added

- **routing** — J2 skill-selection scorecard harness: an offline, rerunnable, dated scorecard (29 synthetic scenarios including adversarial injection and refusal shapes, every Jev reply faked — zero network) measuring the P2 prefilter and the skills preset against expected picks, with honest negatives recorded in `bench/results/`. Activation gate: two consecutive scorecards, separately reviewed.
- **hooks** — J3 turn-complexity escalation policy (shadow): when `PANTHEON_J3_ESCALATION` is on, delegate dispatches get one Jev complexity classification resolved cheap-vs-main through a pure policy with independent local rails (risk-word states never downgrade, user-pinned models always win, oversize context never downgrades, uncertainty resolves to main). Structurally shadow-only — the wiring cannot reach the override mechanism (contract-test enforced); the mechanism itself is proven by direct tests for the separately reviewed activation. Default off.
- **routing** — J4 output quality scoring: a new `mode: "review"` on `pantheon_jev_decide` scores a delegated result against caller-named criteria (one round-trip: quality score + needs-human-review predicate). The request carries no result content — only delegate id, result kind, shape metrics, and bounded criteria. Advisory flag only; nothing blocks. On demand (Zeus-only, same consent/caps/permission chain).

## [v1.6.2-beta.16] - 2026-11-03

### Added

- **hooks** — J1 risk-score advisory gate (shadow): when `PANTHEON_J1_RISK_SCORE` is on, exfil-capable tool calls get one Jev risk-score + intent-predicate observation through the same gate chain as `pantheon_jev_decide` (consent, budget caps, `decision.egress` permission). Shadow only — the verdict is always observed, never enforced; nothing blocks or delays (2s abandon, fail-open on every failure mode). The request carries zero user content: tool name token, scope class, input hash only. Default off.

## [v1.6.2-beta.15] - 2026-11-03

### Added

- **routing** — `decision-router setup-model typesafe-jev/...` now provisions the TypeSafe host provider entry itself (the same additive `providers.typesafe-ai` merge the installer's `--decision-model` path performs), so the TypeSafe direct route is one command plus your own sign-in.
- **routing** — `doctor` checks are route-aware: the Console routes pass as host-native without any catalog probe (decision models are not chat models and never appear in `opencode models`), and the TypeSafe route is verified against the provider entry with a provisioning fix hint.

## [v1.6.2-beta.14] - 2026-11-03

### Fixed

- **routing** — The native Jev route no longer consults the host chat catalog. Decision models are not chat models: on a measured 2.2.5 host the catalog carries 561 entries and zero jev models, while the decisions API answers the exact same model ref directly (`jev-1.13-free` -> real answer at $0.00; the paid `jev-1.13` without a Zen workspace -> the host's own 404). The catalog-presence gate was a wrong assumption that sandbox mocks reinforced; route resolution is now config + budget admission, with consent, caps and the host permission assertion unchanged as the safety gates. `ROUTE_UNRESOLVED` and its inner verdicts are gone from the surface. Field-verified end to end: Zeus -> `pantheon_jev_decide` (mode skills) -> real Jev answer, usage reconciled.
- **routing** — The `decision-router setup-model` checklist no longer tells users to verify the model in the host catalog (it is not there by design).

## [v1.6.2-beta.13] - 2026-11-03

### Added

- **install** — `init` now sweeps stale `pantheon-opencode` copies out of the npm cache's `_npx/` after a successful install (only the package subtree; unrelated packages and the just-installed copy survive). Field evidence: a 1.6.1 npx copy beside the registered 1.6.2-beta.12 made a bare `npx pantheon-opencode doctor` report the registered plugin as outdated, and old copies accumulate forever because npm never prunes them. Removal failures are swallowed and retried by the next init.
- **routing** — `ROUTE_UNRESOLVED` refusals now carry the inner verdict in `detail` (`MODEL_NOT_IN_CATALOG`, `AMBIGUOUS_MODEL`, `MODEL_NOT_DECISION`): the class alone does not tell whether the configured decision model is absent from the host catalog or present but not decision-typed, and those have different fixes. Field-measured on 2.2.5: a host catalog without the Console Jev model (no OpenCode Console credential) reports `MODEL_NOT_IN_CATALOG`.

## [v1.6.2-beta.12] - 2026-11-03

### Added

- **routing** — `ROUTE_UNRESOLVED` refusals now carry the inner verdict in `detail` (`MODEL_NOT_IN_CATALOG`, `AMBIGUOUS_MODEL`, `MODEL_NOT_DECISION`): the class alone does not tell whether the configured decision model is absent from the host catalog or present but not decision-typed, and those have different fixes. Field-measured on 2.2.5: a host catalog without the Console Jev model (no OpenCode Console credential) reports `MODEL_NOT_IN_CATALOG`.

## [v1.6.2-beta.11] - 2026-11-03

### Fixed

- **routing** — `pantheon_jev_decide` now accepts the host's wrapped catalog shape. The 2.2.5 host returns `{ data: [...] }` from `model.list()`, not a bare array; requiring an array turned every real session into `CATALOG_UNAVAILABLE` (field evidence: the sanitized `detail: TypeError` under beta.10 once the receiver binding landed). Same tolerance as the vision surface, which already unwrapped the page object.

## [v1.6.2-beta.10] - 2026-11-03

### Added

- **routing** — Jev refusals carry the sanitized error CLASS in a `detail` field (`TypeError`, `RangeError`, …): enough to tell a detached-call failure from a host-side data failure, while the message (which can carry paths or provider detail) never reaches the chat.

### Changed

- **tui** — The native quota surface is removed: the `/quota` panel, the sidebar quota block, usage history, the go-key diagnostics, and the `pantheon.quota` RPC no longer ship. The recommended community plugin [`@slkiser/opencode-quota`](https://github.com/slkiser/opencode-quota) covers provider quota and usage (OpenCode 2.0.26+; an `npx` installer path exists for 1.x hosts) — see [Quota & usage](docs/tui-v2-quota-providers.md). `pantheon_cost` and the sidebar `Context` block are unaffected.
- **routing** — The visible `&lt;!-- pantheon-decision-router:v1 … --&gt;` marker is no longer appended to the prompt: the host chat rendered the HTML comment to the user. The router keeps running (shadow observation, telemetry, budget, presets); measured evidence showed every prompt mutation was a no-op (F-24, F-08/F-09), so no behavioral routing is lost.
- **agents** — Zeus's decision-routing instructions no longer reference the removed `/quota-go-check` command.

### Fixed

- **routing** — The native Jev runtime now invokes host methods with their owning domain as receiver. `model.list()` was called detached from the host object and threw on real sessions, surfacing only as `CATALOG_UNAVAILABLE`; the canary always exercised the bound call and never caught it. `decisions()` and `skill.list()` are bound the same way, with a contract test that fails on any detached call.

## [v1.6.2-beta.9] - 2026-11-02

### Added

- **install** — `init --decision-model typesafe-jev/jev-1.14.0` merges the TypeSafe provider entry additively into the user's `opencode.json`; only the sign-in remains.

### Changed

- **agents** — Every agent frontmatter declares terminal permissions under `shell:` — the action a measured 2.2.5 host actually evaluates (canary-recorded evidence: a `shell` deny is enforced while `bash` falls through unruled).
- **agents** — Deny intents keep a `bash:` twin; the former `bash:`-only keys never matched, which made specialists' terminal grants inconsistent.
- **agents** — Zeus must never ask the user to type terminal commands: terminal work dispatches to a bash-capable specialist.
- **install** — `--opencode-version v1` is refused with a deprecation message front-running the 2.0 removal of the legacy plugin line.
- **docs** — New [Skill provenance search](docs/reference/skill-search-design.md) investigation (three tiers, Jev as typed ranker; deliberately unwired).
- **docs** — Measured MCP numbers in [Performance](docs/reference/performance.md) (fastmcp startup, FTS5 memory, vision deps).

### Added

- **install** — The wizard's decision-model question now configures the real route (consent + caps + period in one write): Console Jev, the free variant, or TypeSafe direct.
- **install** — Choosing TypeSafe direct merges the `providers.typesafe-ai` entry additively into the user's opencode.json; only the sign-in remains.
- **install** — Legacy metadata spellings degrade to skip with a hint; direct OpenAI has no native Decisions route.
- **install** — The capability notice prints only under `--verbose`.

### Changed

- **performance** — The in-process secret scan is gated to exfil-capable tools (shell, file writes, web); read-only tools skip it, unknown names stay scanned (fail-closed).
- **agents** — Zeus must never ask the user to type terminal commands: terminal work dispatches to a bash-capable specialist.

## [v1.6.2-beta.8] - 2026-11-02

### Added

- **install** — Added `init --decision-model <provider>/<model> --decision-monthly-usd N --decision-per-decision-usd N` to activate the Jev decision route during installation (the same chain as `decision-router setup-model`; `--decision-no-consent` refuses consent), and the post-install next steps now include the optional decision-model path in English and Portuguese.

### Changed

- **performance** — The per-tool-call secret scan and the per-dispatch delegation audit now run in-process (`v2-hook-engine.ts`): same patterns, masked trail, exit-code contract, fail-closed classifier, and `delegations.log` artifacts — without the former one `bash` child per tool call and two more per delegation (each also spawning `python3`). Post-write formatting spawns only when the tool call touched a formattable file.
- **agents** — Specialist prompts carry two-tier verification (small bounded fix → change plus one targeted proof; material change → full discipline), replacing the unconditional TDD mandate in Hermes; Aphrodite and Talos gained the same tier note.
- **docs** — New Performance and tuning reference (measured hook costs, prompt budget, decision latency, context-growth knob) and an INSTALLATION section for the Jev decision-model flow.

## [v1.6.2-beta.7] - 2026-11-02

### Added

- **install** — Added `decision-router setup-model <provider>/<model> --monthly-usd N --per-decision-usd N`: one command performs selection, enablement, egress consent, user/provider/model caps, and budget-period confirmation, then prints the verification checklist (`--no-consent` configures everything except consent).
- **install** — Added `decision-router doctor`: read-only diagnosis of the whole native decision route (config, consent, selection, budget admission, unresolved holds, best-effort host-catalog probe) printing the exact command to run for each failing gate.

### Changed

- **agents** — Modernized the Zeus system prompt: pruned stale release-history sections, kept the operational guards, and granted `pantheon_jev_decide` in the agent permission frontmatter so new installs get the advisory tool without manual config edits.
- **docs** — Documented ready-to-copy decision-provider examples (TypeSafe direct, OpenRouter-hosted Jev) with the catalog caveat that the flat `opencode models` list can omit decision-typed models.
- **agents** — Zeus routing policy now prefers one typed `pantheon_jev_decide` call for genuinely ambiguous routing and skill stacking, with `pantheon_local_decision` as the offline fallback.
- **docs** — Documented the skill-discovery loop (find, review, install, decide) and mapped the candidate MCP-gating expansions as deliberately unwired.

## [v1.6.2-beta.6] - 2026-11-01

### Added

- **routing** — Added the Zeus-only `pantheon_jev_decide` advisory tool: 1–4 typed questions (choice, score, predicate) answered by the Jev decision model through the host's native Decisions API; it registers only on hosts exposing that API and never dispatches agents, runs skills, or changes permissions.
- **routing** — Added native route selection from the user-level decision-router config (OpenCode Console `jev-1.13` and custom `typesafe-ai` decision models) with a frozen provider→host mapping; direct OpenAI is refused and never substituted.
- **routing** — Added host-reported settlement: the budget reservation reconciles from the host-reported DecisionResult cost (a reported zero releases the hold), and a failed or unreconciled call stays fail-closed.
- **routing** — Added catalog presets to `pantheon_jev_decide`: `mode: "skills"` stacks the locally prefiltered skill shortlist (whole-catalog fallback) and `mode: "delegation"` picks a specialist, both single typed calls with `none` always offered.
- **routing** — Extended the `skills` preset to decide over installed host skills (`ctx.skill.list()`) in addition to the Pantheon catalog: any Agent-Skills-format skill installed in the host becomes stackable without a Pantheon change. Installs stay manual and reviewed; Pantheon never installs or updates skills.
- **docs** — Documented the native gate chain, routes, and verification boundary in one reference (`docs/reference/native-decisions.md`) and indexed the decision-layer references in the docs nav; added a real-host canary assertion for the new tool's registration.

### Changed

- **security** — Removed the direct-fetch decision-provider path entirely (runner, payload protocol, fetch-path usage verifier, per-turn provider cache): Pantheon owns no transport, and the only egress is the host's native layer behind the enabled/consent/budget/permission chain. The per-turn prompt hook stays local-only.
- **security** — The budget ledger now treats a host-reported zero cost as a real zero (releasing the hold) while still freezing user/provider/model buckets when actual cost exceeds the reservation.
- **docs** — Consolidated the decision-status narrative to one source of truth per surface, corrected stale env-var rows (no decision credential is read on any production path), and removed an orphan planning note (the tracked deepwork note stays: it is the checkout fixture the resources server resolves against).

## [v1.6.2-beta.5] - 2026-11-01

## 🆕 What's New
- **routing** — wire decision points to their declared host surfaces in shadow (#304)
- **routing** — add V2 decision layer with measured-shape adapters (#303)

## 🐞 Fixed
- **mcp** — harden memory and resource MCP reliability (#306)
## [v1.6.2-beta.4] - 2026-10-31

### Added

- **install** — Added a user-level `decision-router` admin CLI for enablement, selection, consent, per-user/provider/model caps, and period confirmation; config is private and non-secret.
- **install** — Added `decision-router holds` to list unresolved reservations without reserving, reconciling, releasing, or pruning.
- **docs** — Added an offline protocol for separately evaluating agent routing and task complexity; no benchmark results or provider selection are claimed.
- **routing** — Added a default-off, local-only recommendation API for exact canonical agent roles and structured complexity dimensions; it does not dispatch agents or change gates.
- **routing** — Added a private V2 per-turn selector: allowlisted skills, at most one specialist, one call per session/message, and deterministic local fallback.
- **routing** — Added a private fixed-endpoint adapter for `gpt-6-luna` and `jev-1.14.0` with no caller-supplied transport, retry, or fan-out; Console/Free and Bifrost stay ineligible.
- **routing** — Provider contract tests run under the real `tsx` runner (`npm run test:ts`) for the exact payload, gate denials, usage reconciliation, and one call per turn; no live call was made.
- **routing** — Added a user-level `enabled` switch, canonical provider/model matrix, and a single ledger mapping; provider egress also requires the host `permission.assert` gate.
- **routing** — Added a user-scoped SQLite ledger with explicit UTC reservations and no default caps. Admission caps are local safeguards, not invoice guarantees.
- **docs** — `decision-router status`/`holds` are read paths: `status` may create the SQLite ledger, and both may migrate it, but neither reserves, reconciles, releases, or prunes.
- **docs** — The `local-decision-router` subpath is TypeScript source needing the host runtime or a transpiler; the published CLI uses the committed ESM bundle.

### Changed

- **security** — Decision egress is fail-closed: a missing gate, cap, period, or credential means zero requests; V1 stays local-only.
- **release** — `prepack` now runs the `check:decision-router` drift gate, so a stale ledger bundle cannot be packed or published.

### Fixed

- **install** — `decision-router caps user` without flags now reports `Both --monthly-usd and --per-decision-usd are required` as a one-line usage error instead of a stack trace.
- **routing** — `permission.assert` denial (thrown or returned, including the host's `Permission denied: decision.egress` message) means zero requests; an explicit `deny` rule is the kill-switch.
- **routing** — Egress trusts the user-level config; `permission.assert` is only the host kill-switch. A v2.2.0 canary showed an unruled assertion resolves allow and `evaluate` runs only on that path.
- **routing** — A cached provider decision re-reads the user-level config/consent gate before reuse, so revoking consent takes effect without waiting for cache expiry.
- **security** — The prompt hook reuses one decision per turn and never logs or persists the raw request; payloads stay allowlisted.
- **security** — Credential rejection now requires a token boundary and structured `sk-` prefixes, so prose such as `task-force-*` or `disk-usage-*` is no longer treated as a key.
- **routing** — Reusing a cached provider decision does not re-prompt the same permission gate; a different or missing gate is still evaluated and denies fail-closed.
- **docs** — Clarified that `decision-router holds` performs no reservation, reconciliation, release, or pruning, while opening an existing ledger may apply a forward-only schema migration.

## [v1.6.2-beta.3] - 2026-10-29

### Changed

- **install** — Direct `init` uses matching TTY/headless component defaults; Python runtime and prompt templates are opt-in, and `--yes` suppresses prompts without skipping preview or drift checks.
- **install** — Runtime health checks verify SQLite FTS5 capability and fail when it is unavailable.

### Fixed

- **install** — Explicit restore decline exits successfully; missing authorization fails closed, while cancellation exits `130`. Post-write interrupts and runtime failures record the selected target and partial/degraded state.
- **install** — Migration schema version is tracked separately from the installed package version and remains idempotent across prerelease package versions.

## [v1.6.2-beta.2] - 2026-10-28

### Added

- **TUI** — `/quota` adds recorded usage history for 7, 15, 30 days, and Total, with daily and per-model token summaries plus a clearly non-billable catalog estimate.
- **quota** — OpenCode Go usage uses the canonical endpoint and falls back to the configured API key when its Console OAuth request fails.

### Fixed

- **quota** — Future-dated usage rows are excluded from rolling windows and Total.

## [v1.6.2-beta.1] - 2026-10-27

### Changed

- **agents** — V2 compiles declared skills into per-agent allowlists; metadata, routing, and installed skills are checked for drift.
- **memory** — Recall stays an explicit `memory_search` MCP call, session checkpoints are reserved for cross-session handoff, and native OpenCode compaction owns active-history summarization.
- **prompts** — Manual prompt templates use named `{{UPPER_SNAKE_CASE}}` inputs; slash commands keep OpenCode's native `$ARGUMENTS` expansion.
- **install** — V2 MCP entries use the native `disabled` field and migrate legacy `enabled` values.
- **install** — Existing native V2 permission arrays remain authoritative; legacy defaults are seeded only when no V2 array exists.

### Removed

- **plugin** — Removed ambient V2 memory injection and its debug environment variable; the legacy `memory_injection` option is ignored if preserved in an existing config.

## [v1.6.1] - 2026-10-24

### Added

- **docs** — Corrected code-mode tool signatures and agent grants, polished 1.6.x docs with translations/evidence links, and fixed the docs-site entry point (#270).

### Changed

- **plugin** — V2 wires the read guard and bridge and restores supported context, image-history, formatter, and delegation-audit behavior (#264–#267).
- **plugin** — V2 reports host gaps `idle-todo-enforcer`, `todo-restore`, `tool-ceiling`, and `board-transitions` instead of claiming full parity.
- **install** — V2 notices report the resolved state path and shared V1/V2 state, not database isolation or a service port; capability output distinguishes the static seed and includes it in `--json`.
- **install** — SIGINT during blocking `spawnSync` may still be swallowed; cancellation is deterministic during awaited phases.

### Fixed

- **plugin** — V1/V2 Zeus read guards normalize paths, resolve symlink targets, deny resolution failures, and align code-root checks with `pantheon_bounded_read` (#282).
- **plugin** — `pantheon_cost` sums per-model prices for multi-model agents and reconciles partial/unpriced usage with model totals (#260).
- **install** — Cancel/decline names the stopped step and records the run; Ctrl-C exits 130 during awaited phases (#261, #262).
- **install** — Fresh V2 installs write options-bearing plugin entries; migration moves only loadable entries and warns about sibling `opencode.jsonc` (#268, #269).

### Security

- **deps** — Patched `zod` 4.6.6, `fastmcp` 4.1.2, `undici` 6.29.1/8.12.3, and `fast-uri` 3.1.9 to clear reported advisories (#275; PR #283).
- The guard does not pin an inode or make check/open atomic, so concurrent workspace writers can race it; it is a policy boundary, not isolation from hostile local processes.

### Deprecated

### Removed

## [v1.6.0] - 2026-10-22

### Added

- OpenCode 1.19.x and 2.x support with `auto` generation detection; OpenCode 2.0.22 is known broken.
- Per-agent MCP permissions on both generations; omitted servers and undeclared tools are denied by default.
- `pantheon_cost` now reports USD by agent, model and session, accepts `session` scope, and has a hard offline gate that refuses `refreshPricing`.
- Opt-in V2 memory injection can add the most relevant entries to the request context; it is off by default.
- V2 compaction prunes repeated tool output before summarization, keeping the newest result and recent turns.
- The V2 sidebar aggregates child work in a `Dispatch` block, and `/dispatch` opens a full-width panel over the same data.
- The installer previews each file before apply, detects drift, keeps an exact backup, and provides `restore`, `reconcile` and `uninstall`.
- A pristine project database now starts with both checkpoint and goal schemas; startup never adds goal DDL to an existing database.
- Migrating an existing database for the manual goal tools is an explicit step: dry-run first, server stopped, target confirmed, verified `0600` backup.
- When the goal schema is absent, the goal tools return the exact migration command.

### Changed

- V2 installs no longer duplicate global and project instruction context, reducing the first-request payload.
- Memory entries are capped at 64 KiB, can expire via `ttl_seconds`, and `memory_search` returns typed errors when the store is unreadable.
- Node.js 26.4.0 is the package floor; the `node:sqlite` cost backend keeps its separate >=22.5 threshold.
- Plan approval always shows the full plan in the main conversation, never a pointer into a child session.

### Deprecated

- V1 `pantheon_goal_create`, `pantheon_goal_update` and `pantheon_goal_get` are soft-deprecated; stored goals no longer continue a session automatically.

**Upgrade required:** `npm install -g pantheon-opencode@beta && pantheon-opencode update` — see [UPGRADING.md](docs/UPGRADING.md).

### Removed

- Twelve Persistence KV and context-management tools are unregistered; checkpoints and manual goals remain.
- The legacy vector/embedding memory path is removed; SQLite FTS5/BM25 search and the `code_*` tools remain.
- The V2 goal tools are removed and replaced by the manual Persistence `goal_*` tools.
- `steps` is no longer written into managed agents; the host applies no native step ceiling by default.
- The maintainer's `opencode.json` and `.opencode/` are no longer shipped in the package.

**Upgrade required:** `npm install -g pantheon-opencode@beta && pantheon-opencode update` — see [UPGRADING.md](docs/UPGRADING.md).

### Fixed

- V2 plugin tools now execute instead of reporting a false success, and every tool declares the `output` schema the host requires.
- An empty child dispatch result is surfaced as an error instead of a silent completed call.
- Scoped `pantheon_cost` reports with no matching rows render an empty report instead of `UNSUPPORTED`.
- Sub-cent costs render as `< $0.0001`; a real zero stays `$0.00`.
- Cache-only assistant turns count as readable cost usage.
- A session-scoped cost request on the CLI fallback returns `UNSUPPORTED` instead of an unscoped total.

### Security

- Three permission holes are closed: `hashline_edit` no longer bypasses `edit: deny`, and the V2 read-only guard and secret scan are active.

Pre-release history (1.6.0-beta.*) is archived in [docs/internal/changelog-prereleases.md](docs/internal/changelog-prereleases.md).

## [v1.5.2] - 2026-09-22

## Fixed
- **install** — guard undefined collection in init (#174)
- **release** — compare Zenodo file checksum in the format the API returns (#173)
## [v1.5.1] - 2026-09-22

## Fixed
- **agents** — declare explicit read: allow for zeus
- **ci** — drop fastembed from CI, keep pytest collection green (#163)
- **plugin** — detect registered-plugin version drift after pantheon_delegate removal (#169)
- **config** — correct node floor and warn on unsupported runtime (#168)
- **mcp** — degrade gracefully when fastembed import fails (#165)
- **mcp** — drop dead toon_codec module from published package (#167)
- **tui** — remove dead pantheon_delegate refs after v1.5.0 V1 removal (#166)
- **mnemosyne** — grant scoped write to memory-bank and deepwork paths (#164)

## Closed Issues
- #94 - drop fastembed from CI, keep pytest collection green (#163)
- #158 - detect registered-plugin version drift after pantheon_delegate removal (#169)
- #114 - correct node floor and warn on unsupported runtime (#168)
- #160 - correct node floor and warn on unsupported runtime (#168)
- #159 - degrade gracefully when fastembed import fails (#165)
- #162 - drop dead toon_codec module from published package (#167)
- #161 - remove dead pantheon_delegate refs after v1.5.0 V1 removal (#166)
- #111 - grant scoped write to memory-bank and deepwork paths (#164)

## [v1.5.0] - 2026-09-16

### Added

- **Delegação nativa**: `task()` é agora o único canal de delegação — motor legado
  de dispatch removido por completo, simplificando o fluxo de subagents.
- **Painel Delegations (TUI)**: painel funcional com status em tempo real, cores
  por estado (running/completed/failed), janela de recência 24h, ordenação
  newest-first e spinner fluido com timer independente (80ms/frame).
- **Read-only enforcement**: sessões read-only bloqueiam `write`, `edit`,
  `pantheon_delegate` e qualquer mutação — garantindo sandboxing efetivo.
- **CI/CD**: Dependabot alerts, CodeQL analysis, SHA pins em actions, gitleaks
  v3 para detecção de secrets, e workflow de release dispatch-only.

### Fixed

- **Painel Delegations vazio (crítico)**: canal `session.children` da TUI
  chamava API com shape v1 num cliente v2 — placeholder `{sessionID}` não era
  substituído, causando ~181k erros/s e painel vazio. Corrigido
  `safeSessionPath`/`buildChildrenPath`.
- **Stale busy**: children com status `busy` stale (>30min sem atualização)
  agora são classificadas como `completed` (não `running`).
- **Board corruption**: testes que importam o plugin sem isolamento agora fazem
  `chdir` para projeto temporário — sem mais entradas fantasma no board real.
- **Signal leak**: timer independente do spinner separado do poll de dados,
  evitando bloqueio visual durante operações longas.

### Closed Issues

- 38% dos testes consolidados (de ~1200 para ~744) com cobertura mantida.
- 17 módulos mortos removidos, reduzindo superfície de manutenção.
- OWASP Top 10 audit e input validation em todos os endpoints.

## [v1.5.0-beta.20] - 2026-09-16


## Fixed

- **Fixed — painel Delegations**: children com status `busy` stale (>30min sem
  atualização) agora são classificadas como `completed` (não `running`). O
  opencode mantém entradas `busy` no mapa de status para sessões já concluídas;
  o TUI agora detecta e marca como done.
## [v1.5.0-beta.19] - 2026-09-16


## Added

- **Improved — painel Delegations**: status ausente de children antigas agora é
  `done` (não `running`); grace 60s para sessões recém-criadas; janela de
  recência 24h (filtra histórico); ordenação newest-first; ceiling esconde
  antigos.
- **Improved — animação**: spinner ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏ agora tem timer
  independente (80ms/frame), separado do poll de dados — fluido, não mais
  "travado".
## [v1.5.0-beta.18] - 2026-09-16


## Fixed

- **Painel Delegations voltou a funcionar (crítico):** o canal
  `session.children` da TUI chamava a API com a shape v1 (`{ path: { id } }`)
  num cliente **v2** que espera `{ sessionID }`; o placeholder não era
  substituído (`/session/%7BsessionID%7D/children`), o host rejeitava cada
  poll (~181k erros/s) e o painel ficava vazio ("No delegations"). Corrigido
  `safeSessionPath`/`buildChildrenPath` para `{ sessionID }`, removidos os
  `as any` que escondiam o mismatch, + teste de regressão exato. Auditoria
  confirmou que só a TUI (v2) estava errada (o `plugin.ts` usa SDK v1 de
  propósito).
- **Higiene de testes:** testes que importam o plugin sem isolamento agora
  fazem `chdir` para um projeto temporário antes do import — não criam mais
  entradas no board real (fim dos estados fantasma em desenvolvimento).

## [v1.5.0-beta.17] - 2026-09-15


## Added

- **Delegação nativa no host:** o motor `pantheon_delegate` foi removido
  (~3,9k linhas) junto com as tools `pantheon_delegate`,
  `pantheon_delegation_read` e `pantheon_delegation_list`; a delegação agora usa
  o **`task()` nativo** do host (child sessions). 16 arquivos de teste obsoletos
  removidos.
- **TUI — painel Delegations lê a sessão nativa:** o painel passa a derivar de
  `session.children` + `session.status` + md (o arquivo de board deixou de ser
  fonte). Mantidas as cores de status, retenção, ceiling, filtro de sessão e
  guards.
- **Camada fina preservada:** `task-result-guard` (verified completion de child
  vazio), `native-task-status` e guards de enforcement.

## Fixed

- **Read-only enforcement re-apontado para sessões nativas:** aplicado no
  público via hook `chat.params` e `hashline_edit` bloqueado para `apollo`/`gaia`,
  fechando o bypass aberto após a remoção do motor de delegação.
- **Docs/comentários limpos:** referências aos módulos removidos atualizadas,
  incluindo nits de comentário em `tests/pantheon/tui-delegations.test.ts` e
  `src/pantheon/session-id.ts`.

## [v1.5.0-beta.16] - 2026-09-15


## Added

- **Modernização CI/supply-chain:** 22 actions SHA-pinadas; `gitleaks-action` v3
  (fix crítico — a v2 morria com Node 20 em 2026-09-16) com CLI 8.30.1; cache
  npm/pip; Dependabot; CodeQL `+python` e `codeql-config`; permissões reduzidas
  no `docs.yml`; job `version-check` fundido no `validate`; `upload-artifact` v7
  e `download-artifact` v8.
- **Lean:** ~17 módulos mortos removidos de `src/pantheon/`, docs/scripts
  obsoletos, `teste/`/`testes/`, `Dockerfile`/`docker-compose` (de outro projeto)
  e caches; ~38% dos arquivos de teste removidos/consolidados; testes mínimos
  readicionados para os módulos vivos (tool-ceiling, native-probe).
- **Instructions:** deduplicação das instruções compartilhadas — contexto menor
  sem perder nenhuma regra.

## Fixed

- **2 flakes determinísticos eliminados:** TTL do MCP persistence
  (`test_ttl_expiry_real_time`) e `logger.test.mjs` deixaram de depender de
  timing/carga do host.
- **Refs stale corrigidas:** referências de versão/ambiente atualizadas para
  Node 22+.

## [v1.5.0-beta.15] - 2026-09-15


## Added

- **Delegation `read` devolve o relatório completo:** o retorno de `read` passa a
  ler o relatório integral do disco (com cap configurável e marker explícito de
  truncamento) em vez do recibo resumido — o conteúdo é o mesmo tanto no caminho
  nativo quanto no legado, com paridade garantida entre eles.
- **`sanitizeReceiptText` UTF-8-safe:** a sanitização de recibos deixou de corromper
  caracteres multibyte; acentuação e demais codepoints UTF-8 são preservados no
  caminho nativo e no legado.
- **TUI — cor de status na row inteira:** cada linha do painel Delegations passa a
  ser pintada pelo estado — vermelho = falha, verde = concluído, amarelo = em
  andamento — com o glyph mantido como canal redundante para acessibilidade.

## Fixed

- **TUI — painel Delegations só da sessão ativa:** o painel deixa de renderizar
  rows cross-session/órfãs que causavam "Session not found" ao clicar; a lista
  agora cobre apenas a sessão ativa, mantendo a retenção de concluídas (2 min)
  e falhas (10 min).
- **Guards de estado e navegação órfã:** transições prematuras para `done` são
  bloqueadas e a navegação defensiva ignora alvos órfãos, evitando seleção
  inválida no painel.
- **Isolamento do board nos testes:** testes que importam o plugin real agora
  isolam o BackgroundJobBoard, eliminando o fantasma "preserve this running
  delegation"; o board real foi limpo.
- **Lean no core:** 17 módulos mortos de `src/pantheon/` removidos, ~38% dos
  arquivos de teste removidos/consolidados e docs/scripts órfãos limpos, com
  testes mínimos readicionados para os módulos vivos (tool-ceiling, native-probe).
- **Flake de TTL determinístico:** `test_ttl_expiry_real_time` deixou de competir
  com a truncagem de microssegundos do SQLite — o teste agora espera o início de
  um segundo limpo antes do store e usa margem sobre o TTL, eliminando o flake
  dependente de carga (test-only).

## [v1.5.0-beta.14] - 2026-09-14


## Added

- **Ordenação active-first:** delegações ativas aparecem antes das concluídas,
  falhas e canceladas no painel TUI.
- **Overflow active:** quando há mais delegações ativas que o teto visível, o
  excedente ativo permanece representado na linha de overflow.

## Fixed

- **Retenção visual:** concluídas permanecem visíveis por 2 min e falhas por
  10 min antes de saírem do painel; canceladas seguem a retenção configurada.

## Known Issues

- **Stale running warning:** jobs em estado `running` além do limite esperado
  recebem um aviso visual de stale no painel.
## [v1.5.0-beta.13] - 2026-09-14


## Added

- **TUI status-only — rows simplificadas:** cada linha do painel Delegations passa
  a ser `{glyph} {alias} {elapsed}` + `desc` muted — um glyph de status, uma única
  identidade e o tempo decorrido, com a descrição em tom muted. São 4 glyphs
  (running animado, completed, error, cancelled/retry), sem toggle
  `[Sessão]`/`[Tudo]`, sem prefixos `nat:`/`pan:` e sem losango ◇/◆.
- **Header `active`/`done`/`failed`:** o cabeçalho do painel resume apenas esses
  três contadores sobre a lista completa (todas as sessões), sem `nat:`/`pan:`.
- **Ceiling 8:** no máximo 8 linhas visíveis (live-first); o excedente colapsa em
  uma única linha `… +N more`.
- **Board read (jobs de todas as sessões):** o painel lê o BackgroundJobBoard
  (`.pantheon/board/state.json`), então jobs `pantheon_delegate` de qualquer
  sessão aparecem — não só os filhos nativos da sessão focada.
- **118 testes TUI delegations:** `tests/pantheon/tui-delegations.test.ts` com
  118/118 passando, cobrindo rows status-only, header active/done/failed, ceiling
  e board read cross-session.

## Fixed

- **Sanitização de dead code:** removidos helpers, tipos e estado órfãos do
  painel Delegations (toggle de escopo `[Sessão]`/`[Tudo]`, prefixos curtos
  `nat:`/`pan:`, glyphs por estado e paginação de arquivo morto) que sobraram do
  refactor status-only.
- **Board merge preserva sessão conhecida:** um record do board com
  `parentSessionID` vazio não sobrescreve mais a sessão já atribuída à linha.
## [v1.5.0-beta.12] - 2026-09-14


## Added

- **TUI lê o board (4º canal):** o painel Delegations passa a ler o
  BackgroundJobBoard via `readBoardState()` — jobs `pantheon_delegate` de todas
  as sessões aparecem, não só os filhos nativos da sessão focada.
- **Toggle [Sessão]/[Tudo] + chips:** `[Sessão]` (default) mostra só a sessão
  focada, `[Tudo]` mostra jobs de todas as sessões; chips clicáveis no header.
- **Raw `dist/tui.tsx` removido (bundle-only):** o dist passa a carregar só o
  bundle compilado (`tui.js`); o fonte raw sai do pacote publicado.
- **117 testes TUI delegations:** `tests/pantheon/tui-delegations.test.ts` com
  117/117 passando, cobrindo board-read, split ativo/recente e toggle de escopo.
## [v1.5.0-beta.11] - 2026-09-14


## Added

- **Glyphs da FSM real no painel Delegations:** cada estado do BackgroundJobBoard
  tem agora um glifo Unicode geométrico próprio — `⠋` running (spinner 1s),
  `⟳` retry, `⚠` stale/startup, `✓` completed, `✕` error, `−` cancelled. Forma e
  cor são canais independentes: as linhas seguem legíveis sem cor e sem Nerd Font.
- **Prefixo `nat:` / `pan:` documentado:** `docs/INSTALLATION.md` passa a
  descrever os prefixos curtos das linhas nativas (`nat:<agent>`) e do board
  (`pan:<alias>`) e o par de glyphs ◇/◆.
- **`scripts/dev-tui.sh` (dev local sem publish):** instala, builda e registra o
  caminho absoluto do repo em `.opencode/tui.json` (gitignored) com hint de
  restart — sem tocar `opencode.json` e sem publicar.
- **104 testes TUI delegations:** `tests/pantheon/tui-delegations.test.ts` com
  104/104 passando, cobrindo glifos/marker/tone dos estados reais da FSM.

## Fixed

- **Doctor F.2 (`hasUsableScripts`):** a resolução do diretório code-mode agora
  exige um `.py`/`.sh` regular (paridade com `_has_usable_scripts` do MCP), então
  um overlay de projeto vazio não mascara mais uma instalação que traz scripts.
- **`publish:next` órfão removido:** nenhum workflow usava o script (o release
  publica via `--tag beta`); removido do `package.json` para eliminar o dist-tag
  `next` obsoleto da linha de publicação.
## [v1.5.0-beta.10] - 2026-09-14


## Added

- **TUI delegations com prefixos curtos `nat:` / `pan:`:** cada linha do painel passa
  a usar `nat:<agent>` para child nativo do `task()` (sem report no board) ou
  `pan:<alias>` para linha `pantheon_delegate` (ex. `pan:apo-1`) — os prefixos curtos
  liberam largura no sidebar estreito.
- **Glyph de 2 canais (◇/◆):** ◇ vazado (info/cyan) para child nativo e ◆ preenchido
  (cor de estado) para linha do board — forma e cor são canais independentes, então o
  split segue legível mesmo sem cor.
- **Header resumido:** `(N active · M done · nat:K pan:M)` calculado sobre a lista
  completa (active + recent + archived), no lugar do antigo `(N native + M pantheon)`.
- **Elapsed em caixa fixa:** rótulo alinhado à direita em largura 8 e SEMPRE
  renderizado, então um job ativo sem descrição nunca perde o timer.
- **100 testes TUI delegations:** `tests/pantheon/tui-delegations.test.ts` com 100/100
  passando (tsc + biome OK), acima dos 93 da beta.9.

## Fixed

- **`appendFile` sem import (log do painel volta a escrever):** o log em arquivo do
  painel parou de escrever silenciosamente porque `appendFile` era chamado sem import
  (ReferenceError engolido pelo `catch` vazio); o import foi restaurado e o `catch`
  agora reporta a falha (gated por echo) em vez de sumir.
- **Truncamento grapheme-safe:** descrições truncam em fronteiras de grapheme
  (`Intl.Segmenter` com fallback `Array.from`) em 44 graphemes, sem cortar emoji ou
  sequências ZWJ ao meio (mojibake).
- **Linhas stale-running ficam em Active:** um job stale ainda é um job vivo (estado do
  backend inalterado), então não é mais arquivado — o que escondia a linha lançada.
- **Spinner/animação de 140ms → 1000ms:** o tick rápido piscava sem adicionar informação.
- **Dead code removido:** conectores de árvore (`isNestedDelegation` /
  `delegationTreePrefix`) e campos `parentTaskID`/`childCount` removidos —
  `session.children` só devolve filhos diretos, então nenhuma linha nested era
  produzida (BACKLOG).
## [v1.5.0-beta.9] - 2026-09-14

<!-- Add new changes here. Running `node scripts/versioning.mjs apply` will

## Added

- **TUI delegations nativas (gated):** painel Delegations renderiza N delegações native + M pantheon com tag [native], live task em tempo real, click navega para sessão. Implementado em `src/plugins/tui/src/index.tsx` com dist rebuildado.
- **93 testes TUI delegations:** suite `tests/pantheon/tui-delegations.test.ts` com 93/93 passando (tsc + biome OK).
- **E2E beta.8 PASS (referência):** baseline E2E da beta.8 mantido como referência de estabilidade para beta.9.

## Fixed

- Removido diretório `testyes/` (artefato de teste).
- Truncado `hooks.log` para baseline limpo de beta.9.

## [v1.5.0-beta.8] - 2026-09-13

<!-- Add new changes here. Running `node scripts/versioning.mjs apply` will

## Fixed

- **Board persistence is corruption- and concurrency-safe:** state writes now go
  through a UNIQUE temp file (per-process, per-write counter + random suffix), are
  `fsync`ed, then renamed over the destination with bounded ENOENT retries, and
  read-modify-write cycles on the same state path are serialized. This closes the
  window where two writers could interleave and corrupt `state.json` or race the
  rename.
- **Corrupt board state is quarantined and salvaged:** a malformed `state.json` is
  moved aside to `<state>.corrupt-<ts>`, a clear error is logged, and every complete
  record that can be parsed is salvaged and returned instead of throwing — so
  delete/prune/recover callers cannot get stuck in a retry loop.
- **P1-1 — no orphan `.signal.json` on reconcile:** reconcile now deletes any
  still-pending wake signal instead of re-writing it. Reconcile is an
  acknowledgment, not a new terminal transition, so the finalize→reconcile cycle
  no longer leaves a stale `<alias>.signal.json` with `state:"reconciled"` behind.
- **Unresolved `{sessionID}` template guard:** the TUI/runtime can hand the plugin
  the unsubstituted literal `{sessionID}` (or `%7BsessionID%7D`) when no session is
  focused; the plugin now refuses placeholder session ids at the delegation,
  bootstrap-probe, and activity-sample boundaries instead of forwarding them to the
  session API (which rejected every call).
- **Delegation lookup scoped to the calling session:** `pantheon_delegation_read`
  resolves exact task IDs first (must belong to the caller's session), then alias
  matches within that session (exactly one required). Cross-session and ambiguous
  aliases now return explicit errors instead of the generic "Unknown delegation".


## [v1.5.0-beta.7] - 2026-09-13


## Added

- **Cost CLI fallback + `PANTHEON_NODE`:** `pantheon_cost` falls back to a
  read-only `node scripts/cost.mjs` subprocess when `node:sqlite` is
  unavailable in the host runtime (for example under Bun). The fallback
  resolves a real Node.js binary — `PANTHEON_NODE` first, then `node` on
  `PATH` — probes it for `node:sqlite` support (Node.js >= 22.5), and runs it
  with an argument array, never a shell. Previously the tool returned
  `status: UNSUPPORTED` with no fallback.
- **Delegation engine contract (ADR-0011):** legacy `pantheon_delegate` remains
  the default engine through v1.5.x; native delegation is opt-in and
  experimental via `PANTHEON_DELEGATE_MODE=native` until v1.6. See
  [ADR-0011](https://github.com/ils15/pantheon-opencode/pull/126) (Proposed).

## Fixed

- **Legacy read-only bypass on retry (P0):** a retried delegation now
  re-applies read-only enforcement (the same rule as the initial child) and
  registers the retry session, closing the bypass where a retried child could
  write despite `read_only: true` or being a read-only agent.
- **Kill-switch scope (P0):** `PANTHEON_DELEGATION=off` now also disables the
  legacy engine, not only the native manager — the legacy delegate/read/list
  tools throw as documented.
- **Delegation signal leak (P1):** the legacy finalize path now deletes the
  auto-wake signal file, so terminal delegations no longer leave stale
  `.signal.json` artifacts behind.
- **Crash recovery is durable (P1):** `recoverRunningJobs` persists the
  `error` state, marks the job `terminalUnreconciled`, and emits the terminal
  signal plus notification for every reaped job instead of updating memory
  only.
- **Atomic concurrency (P1):** `registerLaunch` validates
  `maxConcurrentPerAgent` before any mutation, so concurrent dispatches cannot
  both claim the last slot. A refused launch tears down the orphan child
  session (read-only unregister plus `session.delete`) and the retry path
  re-validates the same limit.
- **Legacy board hygiene (P1):** the legacy finalize path now runs
  `pruneCompleted` and `enforceEntryCap`, matching the native manager and
  preventing unbounded board growth.
- **Resilient V2 events:** a native child refused by the per-agent limit is
  logged and skipped instead of aborting the rest of the event handler.
## [v1.5.0-beta.6] - 2026-09-12


## Added

- **Delegation panel v2:** live tool activity per running delegation
  (`↳ bash npm test` — what the child is doing right now), a paginated
  `Archived (n)` section for terminal reports beyond the recent 8, and a
  distinct `retry` state (⟳ marker, RETRYING label) instead of lumping
  retries into running.

## Fixed

- **Stale plugin refs from old installs:** the installer now prunes
  `pantheon-opencode` plugin references pointing at other installed copies of
  the package (older nvm prefixes, npx cache hashes). Previously every init
  accumulated refs from past installs and the oldest — without the newest
  fixes — won the plugin load race, silently disabling native-task
  mirroring. Third-party plugins sharing the same file names remain
  protected.
- **Docs:** `@beta` dist-tag guidance on all npx commands — plain
  `npx pantheon-opencode` resolves the stable release and silently downgrades
  the installed TUI copy.
## [v1.5.0-beta.5] - 2026-09-12


## Added

- **Native background tasks in the delegation panel:** tasks dispatched via
  the native `task(background=true)` tool are now mirrored onto the shared
  BackgroundJobBoard, so the TUI delegation panel tracks them while running
  and the existing finalize path writes their terminal report.
- **`pantheon-opencode update`:** one command updates the global package
  (beta or stable channel) and re-runs init to refresh config, venv and MCP
  entries. The installer stamps the installed version and `doctor` warns when
  the package is newer than the last sync.
- **Always-fresh artifacts:** the package postinstall now refreshes all
  copy-only artifacts (agents, skills, AGENTS.md, commands, MCP scripts,
  code-mode payload) into existing installations on every `npm install`; a CI
  gate rebuilds the TUI bundle and fails if the committed `dist/` is stale.
- **More resilient installer:** preflight checks for python3/npm before any
  file is written, atomic `opencode.json` writes with a `.bak` backup,
  non-fatal Python runtime setup (a venv failure now omits MCP entries with a
  warning instead of pointing at a broken interpreter), `--components` /
  `--clean` / `--opencode-version auto` flags, unknown-flag warnings and
  pt-BR/EN message auto-detection via `LANG`.
- **Roadmap zerado:** o plano ativo não tem mais itens pendentes. Sprints
  nunca implementados dos planos v1.0/v1.0+ foram removidos; o contrato atual
  passou a documentar o code-mode (manifest SHA-256, resolução project-first).

## Fixed

- **Code-mode project resolution (#112):** the MCP now resolves project code-mode
  scripts before global scripts, honors `PANTHEON_PROJECT`, and fails closed on
  project manifest errors; the installer sets `cwd: "."`.
- **Code-mode manifest doctor check (#113):** `doctor` validates manifest shape,
  script membership, and SHA-256 hashes without regenerating the manifest.
## [v1.5.0-beta.4] - 2026-09-11


## Added

- **Native delegation contract (B3-05):** adds the nine-code `NativeTaskStatus` contract, a session-lazy cached capability probe, atomic board registration for native children, strict `PANTHEON_DELEGATE_MODE=native` without fallback/failover/retry, and status in delegation receipts.

- **Cost backend (B3-06):** `pantheon_cost` now uses a single read-only `node:sqlite` backend; the CLI fallback was removed. The common contract reports `UNSUPPORTED` when `node:sqlite` is unavailable and `CORRUPT_DATA`/`UNAVAILABLE` with diagnostic details on stderr; includes a sandbox probe.

- **Tool ceiling (B3-07):** C9/tool ceiling is fed only by real host data from `message.updated` plus `config.providers()`; lexical fallback is removed. Hosts without the capability report `UNSUPPORTED`, malformed data reports `CORRUPT_DATA`, and malformed events are guarded defensively.

- **Code-mode explicit installation (B3-08):** `pantheon-code-mode` no longer executes scripts implicitly. A script runs only when listed in `.pantheon/code-mode/manifest.json` with a matching SHA-256; the installer seeds the manifest for bundled scripts and a new `approve_code_script` tool opts in or refreshes a script. Missing manifest reports `INVALID_STATE`, unlisted scripts `CONFLICT`, and hash mismatches `CORRUPT_DATA`.

## Fixed

- **ECIGLOBAL fix (sync-tui):** `npm install -g` no longer fails with ECIGLOBAL — `scripts/sync-tui.mjs` now sanitizes `npm_config_*` global-context vars (case-insensitive) from the nested `npm ci` environment.
- **npm tarball inclusion:** CHANGELOG.md is now included in the npm tarball
  (added to the `files` allowlist in `package.json`).

- **Task Result Guard**: native `task()` empty results are now detected and
  converted to explicit errors in the `tool.execute.after` hook. Previously,
  when a provider rejected a child session (e.g. `BackendAdmissionRejected`
  from free-tier admission control), the error was silently swallowed — the
  child completed with empty output and the parent LLM proceeded as if the
  task succeeded. The guard replaces empty `task()` output with an error
  message so the parent sees a failure. (`task-result-guard.ts`)
## [v1.5.0-beta.3] - 2026-09-10


### Changed

- **CI fail-closed:** `ci.yml` no longer falls back from `npm ci` to
  `npm install`, and pytest/audit failures are no longer swallowed. The
  workflow now runs lint, typecheck, `test:ts`, Python tests, Node tests and
  `npm audit`/`pip-audit` as blocking gates.
- **Release authorization is dispatch-only:** `release.yml` no longer triggers
  on PR labels or any `pull_request` event. Publication is
  authorized only by an explicit `workflow_dispatch`; the `release_channel`
  input (`stable` default, `beta`) selects the channel. Beta versions are
  committed sequential `X.Y.Z-beta.N` (bumped via
  `node scripts/versioning.mjs apply --beta`); no runtime version computation.
- **Sandbox gate is PASS-only:** `test-opencode-v1-v2-sandbox.sh` no longer
  classifies failures as `AMBIENTAL`/`NOT_TESTED`, has no prompt retry, and
  treats missing binaries/projects/probes, timeouts and auth/network/provider
  failures as blocking. Exit 0 now requires an explicit PASS on every check.
- **Validation policy is PASS-only:** `doctor` exit != 0 (including legacy
  exit 1 warnings), unknown or non-numeric statuses block validation;
  WARN/SKIP/AMBIENTAL/NOT_TESTED never produce exit 0.
- **No npm install fallback in TUI/install paths:** `sync-tui.mjs` and the
  plugin installer propagate `npm ci` failures instead of falling back to
  `npm install`; `PANTHEON_ALLOW_NPM_INSTALL_FALLBACK` is not supported.
- **Lockfile-backed installs:** the root (`package.json` + `package-lock.json`)
  and TUI (`src/plugins/tui/package.json` + `src/plugins/tui/package-lock.json`)
  are validated independently with `npm ci --ignore-scripts`. A failure blocks
  the run; there is no `npm install` fallback.
- **Release artifact identity:** each release carries one `.tgz` tarball and
  the SHA-256 of that same file from validation through publication. The
  tarball and release metadata are bound to the full `TARGET_SHA`; repacking is
  not an equivalent artifact.
- **Intentional MCP divergence:** `scripts/memory_mcp_server.py` keeps the
  lightweight `memory_*` contract while `src/mcp/memory_mcp_server.py` also
  exposes the optional codemap tools. The other shared MCP copies remain
  identical; this pair is not to be overwritten by synchronization.
- **Sandbox scope:** a PASS from the prepared isolated sandbox is not proof of
  support for every real host or untested host configuration.

### Breaking Changes

- Release automation requires a manual `workflow_dispatch`; labeling a PR no
  longer publishes anything.
- The sandbox validator exits non-zero when environmental checks cannot run
  (missing binaries, provider auth, timeouts) instead of reporting them as
  non-blocking.
- `PANTHEON_ALLOW_NPM_INSTALL_FALLBACK` has no effect; `npm ci` failures now
  fail the install/sync step.
## [1.5.0] - 2026-09-01 (candidate)

### Changed

- **MCP flat map:** the installer and config migration keep MCP servers as the
  named top-level map — the `mcp.servers` wrapper is rejected by OpenCode
  1.18.18 (`Missing key mcp.servers.enabled`). Legacy wrapped entries are
  unwrapped and `disabled` flags are normalized back to `enabled`.
- **Deterministic plugin installs:** the TUI plugin ships its lockfile and
  installs with `npm ci --omit=dev`; failures are propagated without an
  `npm install` fallback.
- **Uninstall CLI:** new `node scripts/uninstall.mjs --project|--global` with
  ownership checks, `--dry-run` and `--force`.
- **OpenCode-only:** platform guides consolidated into a single OpenCode
  guide; Pantheon 1.5.0 targets OpenCode exclusively.
- **OpenCode V2 plugin:** the V2 contract registers 9 orchestration tools
  (`pantheon_delegate`, `pantheon_delegation_read`, `pantheon_delegation_list`,
  `hashline_edit`, `pantheon_goal_create`, `pantheon_goal_get`,
  `pantheon_goal_update`, `pantheon_cost`, `pantheon_model`), 4 event
  subscriptions, session hooks (`prompt`, `context`) and tool hooks
  (`execute.before`, `execute.after`).

## [v1.4.3] - 2026-09-03

### Changed

- Synchronized the 1.4.3 release version across `package.json`,
  `package-lock.json`, `plugin.json`, `pyproject.toml`, and the TUI package.

## [v1.4.2] - 2026-08-27

### Changed
- Synchronized release metadata across project manifests.
## [1.4.1] - 2026-08-26 (candidate)

### Changed

- **Delegation output:** removed the legacy delegate echo path. Terminal visibility now uses the board, list/read tools, file-only audit logs, and TUI toasts; chat transcript delivery remains disabled.
- **Model inheritance:** child sessions no longer receive a hardcoded `model` or `small_model`. Only an explicitly active routing profile (or an explicit delegate model) supplies an override; otherwise OpenCode inherits the parent model.
- **Compaction carry-forward:** context is written through `output.context` during `experimental.session.compacting`, before `session.compacted` runs, preserving the correct lifecycle order without chat injection.

### Fixed

- **Empty child output:** a child marked completed without assistant or tool output now becomes an explicit error: `Child session produced no assistant or tool output`.
- **Terminal toast delivery:** toast delivery is resilient to missing or failing TUI clients, is gated by `PANTHEON_TOASTS`, and deduplicates repeated terminal events for the same delegation.
- **Chat noise:** removed the remaining transcript/reminder delivery paths for delegation completion and compaction state.

### Tests

- Added regression coverage for delegate output validation, terminal-toast gating/deduplication, native model inheritance, and compaction context ordering.
- Updated the relevant Node/TypeScript tests and installation/model-routing checks; global-install behavior remains validated through the isolated sandbox when run.
- Release verification caveat: `npm test` reported 240 passing tests and 1 environmental failure (`fork: Resource temporarily unavailable`); rerun on a host with sufficient process resources before treating the candidate as fully verified.

## [1.4.0] - 2026-08-25

### Added

- **Codebase knowledge graph:** added the `pantheon-memory` codemap module with code entities, relations, file hashes, FTS5 search, and `code_index`, `code_query`, and `code_neighbors` tools for Python and TypeScript codebases.
- **Context-window optimization:** added `tool.execute.after` output sandboxing for `read`, `grep`, `glob`, and `webfetch`, with truncation markers and lower per-session output volume.

### Fixed

- **Installed TUI version display:** version detection now checks the installed TUI package before the development-tree package, fixing null versions in global installs and the sandbox.
- **Bash command portability:** normalized `python` commands to `python3` where the host does not provide a `python` executable.

### Tests

- The release entry records the implementation and coverage reported by the session; no additional release-level test result is asserted here.

## [1.3.7] - 2026-08-24

### Added

- **Stale-running detector:** the job board warns about entries running for more than 30 minutes without activity, and the Markdown parser rejects synthetic `running` states.
- **TUI auto-update:** postinstall synchronization and a runtime version check keep the installed TUI files current.

### Fixed

- **Stale delegate display:** corrected stale-running entries in the TUI delegation view.
- **Orphan cleanup:** connected `finalizeIdleChildrenWithoutMd` to the periodic 30-second scan at plugin initialization.

### Tests

- Closed issue #68 covering the TUI stale-state and auto-update fixes.

[v1.4.3]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.4.3
[1.4.0]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.4.0
[1.3.7]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.3.7
[1.3.6]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.3.6


## [1.3.6] - 2026-08-22

### Added

- **Recency decay in `memory_search` (src/mcp/memory_mcp_server.py)** — new `decay_days` param (default `None`, backward compatible) applies a freshness half-life `2^(-days_since_created/decay_days)` to RRF-fused scores, so older memories rank lower when enabled. `_rrf_fuse` accepts an optional `created_at_map`; tool description and docs updated (docs/MEMORY.md, docs/MCP.md, docs/mcp-tools.md).
- **Themis Comment Checker (src/agents/themis.md)** — Layer 1 review now flags generated code that is indistinguishable from human-written: excessive/obvious comments (`// increment i`, `# set x to 5`), commented-out dead code, and boilerplate headers.
- **Doc drift fixes** — MEMORY.md/MCP.md/mcp-tools.md now describe the real sqlite-vec + fastembed implementation (6 tools) instead of the stale ChromaDB 14-tool design; freshness decay documented as opt-in via `decay_days`.
- **scripts/ resynced with src/mcp/** — `mcp_resources_server.py` (routing project fallback), `code_mode_server.py` (comment drift), `memory_mcp_server.py`, `mcp_persistence_server.py`, `_pantheon_paths.py` regenerated from canonical source; tests now point at `src.mcp.*` so they exercise canonical code.
- **mcp-registry.yml synced** — real tool names (`memory_store/search/recall/forget/list/stats`, `kv_*`, `execute_code_script`, `vision_*`) + `pantheon-vision` server added.
- **Persistence MCP server test suite (tests/test_mcp_persistence_server.py)** — 32 tests covering kv_store/kv_get (incl. TTL expiry), kv_list, kv_search (FTS5), kv_delete, kv_delete_namespace, purge_expired (dry_run + deletelog), context_save/get/list/stats (latest pointer, session isolation) and namespace/scope isolation — the only previously untested MCP server now has full coverage.
- **CRITICAL TTL expiry fix (src/mcp/mcp_persistence_server.py)** — ISO `expires_at` timestamps (with `T` separator) compared lexicographically against SQLite's space-separated `datetime('now')` were ALWAYS greater on the same date, so TTL entries never expired (kv_get never returned None, purge_expired never purged, the 4h checkpoint TTL never fired). All 9 comparison sites now normalize via `datetime(expires_at)` — restoring the crash-recovery checkpoint path.
- **`_resolve_db_path` fix (src/mcp/mcp_persistence_server.py)** — with an explicit `--project-db`, deletelog writes and db_size stats pointed at the repo's real project.db instead of the actual DB path; the resolved path is now tracked at init.
- **Code-mode script metadata (src/mcp/code_mode_server.py)** — optional comment-style YAML frontmatter (`# ---` delimiters) on scripts: `description`, `timeout` (per-script override, seconds), `allowed_args` (arg allowlist). Exposed via `pantheon://code-mode/scripts/{name}` and the new `json_output=true` structured result (stdout/stderr/exit_code/duration_ms/timed_out/metadata). Malformed/missing frontmatter fails open. Documented in `.pantheon/code-mode/README.md`.
- **Per-script timeout override (src/mcp/code_mode_server.py)** — frontmatter `timeout` overrides the 30s default in the subprocess `wait_for`; kill-on-timeout preserved (tested: `timeout: 2` script killed at ~2s).
- **`_parse_iso_ts` UTC fix (src/mcp/memory_mcp_server.py)** — legacy naive timestamps from `DEFAULT (datetime('now'))` (`YYYY-MM-DD HH:MM:SS`, no TZ) are now assumed UTC instead of local timezone before `.timestamp()`, keeping freshness decay correct.
- **StepCapTracker permanent-per-process documented (src/pantheon/step-cap.ts)** — counters accumulate for the process lifetime and are intentionally not reset on success/session end; `reset()` remains a tested utility. Documented in routing.yml + README.
- **High-level R1 integration tests (tests/pantheon/zeus-delegate-with-retry.test.ts)** — `zeusDelegateWithRetry` with retryPolicy/cooldown: policy-driven retry-then-success (empty → 1 retry → recovered content), 0-retry escalate, and cooldown skip.
- **R4 per-agent step caps (src/pantheon/step-cap.ts + src/routing.yml)** — every routed agent gets a `max_steps` budget (explore 25, reviewer 25, oracle 15, hermes 40, zeus 60, …); at the cap the delegation is forced to summarize-and-stop via `buildStopInstruction`/`cappedSummary`; counters are permanent-per-process by design.
- **O5 permission.task globs (src/pantheon/permission-globs.ts)** — allow/deny glob rules controlling which subagents may be delegated; deny rules remove the target from Zeus's task tool entirely (`delegation-enforce`), with matching filtering in finalize and the agent-list description.
- **plugin-eval certification suite (.pantheon/code-mode/)** — `eval-static.py` (structural checks: frontmatter/secrets/file refs), `eval-llm-judge.py` (LLM quality layer), `eval-monte-carlo.py` (simulated-run reliability, exits 1 below 75%), `eval-run.py` (orchestrator emitting one report JSON; below-threshold layers still score), plus `eval_store` persistence and `pantheon://eval` resources exposing latest certification scores.

### Fixed

- memory_search doc drift: freshness decay was documented but not implemented — now real via `decay_days`.
- scripts/ copies stale vs src/mcp/ canonical sources (missing routing project fallback, stale comments).
- .pantheon/mcp-registry.yml listed non-existent tools (memory_compress, memory_expand, list_agents) and missed pantheon-vision.


### Tests

- The entry records the persistence, integration, and certification test coverage explicitly listed above; no aggregate release-level result was available in the source notes.


## [1.3.6-beta] - 2026-08-21

## Added

- **Recency decay in `memory_search` (src/mcp/memory_mcp_server.py)** — new `decay_days` param (default `None`, backward compatible) applies a freshness half-life `2^(-days_since_created/decay_days)` to RRF-fused scores, so older memories rank lower when enabled. `_rrf_fuse` accepts an optional `created_at_map`; tool description and docs updated (docs/MEMORY.md, docs/MCP.md, docs/mcp-tools.md).
- **Themis Comment Checker (src/agents/themis.md)** — Layer 1 review now flags generated code that is indistinguishable from human-written: excessive/obvious comments (`// increment i`, `# set x to 5`), commented-out dead code, and boilerplate headers.
- **Doc drift fixes** — MEMORY.md/MCP.md/mcp-tools.md now describe the real sqlite-vec + fastembed implementation (6 tools) instead of the stale ChromaDB 14-tool design; freshness decay documented as opt-in via `decay_days`.
- **scripts/ resynced with src/mcp/** — `mcp_resources_server.py` (routing project fallback), `code_mode_server.py` (comment drift), `memory_mcp_server.py`, `mcp_persistence_server.py`, `_pantheon_paths.py` regenerated from canonical source; tests now point at `src.mcp.*` so they exercise canonical code.
- **mcp-registry.yml synced** — real tool names (`memory_store/search/recall/forget/list/stats`, `kv_*`, `execute_code_script`, `vision_*`) + `pantheon-vision` server added.
- **Persistence MCP server test suite (tests/test_mcp_persistence_server.py)** — 32 tests covering kv_store/kv_get (incl. TTL expiry), kv_list, kv_search (FTS5), kv_delete, kv_delete_namespace, purge_expired (dry_run + deletelog), context_save/get/list/stats (latest pointer, session isolation) and namespace/scope isolation — the only previously untested MCP server now has full coverage.
- **CRITICAL TTL expiry fix (src/mcp/mcp_persistence_server.py)** — ISO `expires_at` timestamps (with `T` separator) compared lexicographically against SQLite's space-separated `datetime('now')` were ALWAYS greater on the same date, so TTL entries never expired (kv_get never returned None, purge_expired never purged, the 4h checkpoint TTL never fired). All 9 comparison sites now normalize via `datetime(expires_at)` — restoring the crash-recovery checkpoint path.
- **`_resolve_db_path` fix (src/mcp/mcp_persistence_server.py)** — with an explicit `--project-db`, deletelog writes and db_size stats pointed at the repo's real project.db instead of the actual DB path; the resolved path is now tracked at init.
- **Code-mode script metadata (src/mcp/code_mode_server.py)** — optional comment-style YAML frontmatter (`# ---` delimiters) on scripts: `description`, `timeout` (per-script override, seconds), `allowed_args` (arg allowlist). Exposed via `pantheon://code-mode/scripts/{name}` and the new `json_output=true` structured result (stdout/stderr/exit_code/duration_ms/timed_out/metadata). Malformed/missing frontmatter fails open. Documented in `.pantheon/code-mode/README.md`.
- **Per-script timeout override (src/mcp/code_mode_server.py)** — frontmatter `timeout` overrides the 30s default in the subprocess `wait_for`; kill-on-timeout preserved (tested: `timeout: 2` script killed at ~2s).
- **`_parse_iso_ts` UTC fix (src/mcp/memory_mcp_server.py)** — legacy naive timestamps from `DEFAULT (datetime('now'))` (`YYYY-MM-DD HH:MM:SS`, no TZ) are now assumed UTC instead of local timezone before `.timestamp()`, keeping freshness decay correct.
- **StepCapTracker permanent-per-process documented (src/pantheon/step-cap.ts)** — counters accumulate for the process lifetime and are intentionally not reset on success/session end; `reset()` remains a tested utility. Documented in routing.yml + README.
- **High-level R1 integration tests (tests/pantheon/zeus-delegate-with-retry.test.ts)** — `zeusDelegateWithRetry` with retryPolicy/cooldown: policy-driven retry-then-success (empty → 1 retry → recovered content), 0-retry escalate, and cooldown skip.
- **R4 per-agent step caps (src/pantheon/step-cap.ts + src/routing.yml)** — every routed agent gets a `max_steps` budget (explore 25, reviewer 25, oracle 15, hermes 40, zeus 60, …); at the cap the delegation is forced to summarize-and-stop via `buildStopInstruction`/`cappedSummary`; counters are permanent-per-process by design.
- **O5 permission.task globs (src/pantheon/permission-globs.ts)** — allow/deny glob rules controlling which subagents may be delegated; deny rules remove the target from Zeus's task tool entirely (`delegation-enforce`), with matching filtering in finalize and the agent-list description.
- **plugin-eval certification suite (.pantheon/code-mode/)** — `eval-static.py` (structural checks: frontmatter/secrets/file refs), `eval-llm-judge.py` (LLM quality layer), `eval-monte-carlo.py` (simulated-run reliability, exits 1 below 75%), `eval-run.py` (orchestrator emitting one report JSON; below-threshold layers still score), plus `eval_store` persistence and `pantheon://eval` resources exposing latest certification scores.

## Fixed

- memory_search doc drift: freshness decay was documented but not implemented — now real via `decay_days`.
- scripts/ copies stale vs src/mcp/ canonical sources (missing routing project fallback, stale comments).
- .pantheon/mcp-registry.yml listed non-existent tools (memory_compress, memory_expand, list_agents) and missed pantheon-vision.

## [1.3.5] - 2026-08-21

## Added

- **PT patterns para delegação (routing.yml)** — adiciona 5 padrões PT (`procure`/`busque`/`encontre`/`localize`/`pesquise`) ao `intent_gate` research → apollo, corrigindo detecção de intenção para prompts em português (PR #61).
- **Zeus read guard (delegation-enforce.ts + plugin.ts)** — `ZEUS_READ_DENY_PATTERNS` bloqueia `src`/`tests`/`scripts`/`glob`/`grep` por Zeus via `tool.execute.before` (primeiro guard da cadeia); `ALLOWED_PATHS` libera `.md` e `.pantheon/memories`; 10 casos de teste em `tests/pantheon/delegation-enforce.test.ts`; `apollo.md`/`gaia.md` com `visible:false` e `tools.task:false` para depth-1 (PR #61).

## Fixed

- **session-guard + retry helper (session-guard.ts + zeus-delegate-with-retry.ts)** — guard de `session_id` e helper `zeusDelegateWithRetry` com retry/backoff para delegações; `goal-loop.ts`/`todo-enforcer.ts`/`todo-preserve.ts`/`delegation.ts` ajustados (PR #61).
- **validate doctor filter (scripts/doctor.mjs)** — `isValidAgentFile` verifica frontmatter YAML (`name`/`description`/`mode`) para filtrar `README.md` e docs não-agente de `getCanonicalAgentNames`/`deriveInstalledAgentFiles`; evita contagem espúria no `doctor` (PR #61).
- **README move (src/agents → docs/agents)** — move `README.md` para fora de `src/agents` para evitar agente espúrio; `docs/agents/README.md` criado (PR #61).
- **TUI GC aliasless (src/plugins/tui)** — GC de delegações live sem alias para evitar estado `delegating` preso; `src/plugins/tui/src/index.tsx` + `dist/` atualizados (PR #61).
- **routing fallback opencode-go (src/pantheon/presets.mjs + routing.yml)** — fallback do preset default para `opencode-go` quando API key do provider ausente; `resolveChildModel` com fallback para `opencode/deepseek-v4-flash-free` (PR #61).
- **install README guard (scripts/install/*)** — `shared.mjs`/`opencode.mjs`/`agents-md.mjs` impedem cópia de `README.md` para diretório de agentes; `package.json` ajustado (PR #61).

## [v1.3.4] - 2026-08-11

## Added

- **Compaction summary V2** (preservation directive + mission/todo/delegation sections): `buildCompactionContext` is now async and accepts goal/todo sources — `PANTHEON_COMPACTION_DIRECTIVE` prefix section (emitted before any other section, skipped on totally-empty state), `<mission_context>` with active goals (id/objective/status), `<todo_context>` with pending (not completed/cancelled) todos; delegation blocks byte-for-byte unchanged; failing/disabled sources are skipped fail-open (logged to hooks.log)
- **Post-compaction todo preservation**: TodoPreserver captures the session's todo list on `experimental.session.compacting`, activates the snapshot on `session.compacted`, and rewrites the first post-compaction `todowrite` with the exact pre-compaction list — additive + fail-open (every step degrades to a logged warn, never throws in a hook)
- **Post-compaction state re-assertion**: re-asserts session state after compaction so the rebuilt context reflects the live board
- **Historical (superseded) agentModels wiring from routing.yml**: the old release wired `options.agentModels` from the first preset. Current behavior requires an explicitly active profile and omits child models otherwise.
- **Preemptive compaction threshold logic** (dormant/experimental): threshold-based preemptive compaction — not active by default
- **File-first logging**: `createPantheonLogger` — console echo opt-in via `PANTHEON_HOOKS_LOG=1`, everything routed to `.pantheon/logs/hooks.log` (silences TUI console pollution)
- **Historical (superseded by 1.5.0):** the 1.3.4 TUI delegation panel described every report-less child as native `task()` work with a `[task]` tag. Current behavior keeps child origin unclassified unless explicit provenance is available.
- **README docs**: 1.3.4 compaction + delegation features documented
- **Zero chat-notification policy**: removed the `chat.message` injection channel for delegation signals — completion visibility lives in the board `[unread]` marker, `pantheon_delegation_read`, TUI toasts and compaction carry-forward, never in the chat transcript

## Fixed

- **Delegate dispatch with missing provider API key** (P1): `resolveChildModel` never checked whether the resolved model's provider had a configured API key — a child dispatched to a keyless provider (e.g. gpt-5.6-luna/opencode-go) died instantly with `AI_LoadAPIKeyError`. Auto-resolved models (agentModels/preset) whose provider key is missing now fall back to `opencode/deepseek-v4-flash-free`; explicit caller models are respected (warned); when nothing is usable the tool returns a clear error TEXT and registers NO job on the board
- **delegations.log typing**: `task_id` was always `""` (now omitted when empty) and `duration_ms` was logged as a STRING (now parsed to a number, null when unset), breaking downstream aggregation
- **Idle-flush log duplication**: `flushIdleReminders` echoed the reminder body joined with `" | "` while chat.message delivery echoed the same body with `"\n"` — the identical line appeared twice; idle-flush is now an audit summary (count + aggregated line count), content logged exactly once at chat-reminder delivery
- **TUI console log pollution**: console output in the plugin/hooks rendered directly into the opencode TUI; now env-gated, log-file only by default

### Tests

- No aggregate test result was recorded in the original 1.3.4 release notes; the factual test counts that were documented remain attached to their individual changes above.


## [v1.3.3] - 2026-08-11

## Added

- **Todo continuation enforcer**: auto-continues sessions with incomplete todos on `session.idle` (4 guards: board-running, in-flight, exponential cooldown, max-failures cap) + kill-switch `PANTHEON_TODO_ENFORCER=off`
- **Hashline hash-anchored edits**: `hashline_edit` tool with sha256-truncated line tags, additive read enhancer, validate-before-write with `>>>` mismatch hints + Did-you-mean suggestions; blocked in read-only sessions
- **Full-auto goal loop:** `pantheon_goal_create/update/get` tools, atomic GoalStore, priority idle dispatcher (active goal suppresses enforcer), max 25 continuations. The loop is disabled by the hard-coded plugin defaults; `routing.yml` documents defaults and guards but does not enable it.
- **Dispatch retry-on-empty**: classifies empty results (mode 1: 0 tokens; mode 2: reasoning without text) with cap-1 automatic retry
- **Cost tracking**: JSONL ledger + `pantheon_cost` command reading opencode.db (zero-dep, node:sqlite → scripts/cost.mjs fallback)
- **Themis phase reviews** route to deepseek-v4-flash (pro reserved for final release gate); Athena stays premium (council red-line)
- **Routing config**: `background_delegation`, `todo_enforcer`, `hashline`, `full_auto` sections

## Fixed

- **Delegation killer**: chat.message hook injected reminders with empty messageID on the subagent promptAsync path — opencode schema rejected it, killing every background delegation in ~20ms (found by live E2E smoke)
- **Delegation child model routing**: child sessions now inherit the routed model (explicit arg → routing.yml agent entry → active preset) instead of falling back to the key-gated default (E2E: AI_LoadAPIKeyError without an active preset)
- **Installer `resolveInstalledPlugin`** mapped only `src/plugins/*` — `src/plugin.ts` resolved to the dev path, breaking global installs on non-dev machines and leaking the dev path (release-blocking)
- **Todo enforcer invasiveness**: skips injection when native background children are active (`session.children`) and within 30s of user activity
- **Hashline**: atomic write (tmp+rename), path containment guard, documented seed separator

## [v1.3.2] - 2026-08-09

## Added

- **Sandbox validation**: added the `sandbox` doctor profile and regression coverage for npm tarball contents, installed hook resolution, doctor status handling, MCP runtime smoke checks, and related CLI/install contracts.
- **Package portability**: distributed configuration no longer retains checkout-specific machine paths; managed hooks are resolved from the installed package during install/sync.
- **Doctor contract**: exit statuses now distinguish success (`0`), advisory warnings (`1`), and blocking errors (`>=2`).

## Fixed

- **Global installation diagnostics**: clarified the distinction between advisory doctor warnings and blocking failures.

[v1.3.2]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.3.2

## [v1.3.1] - 2026-08-08

## Added

- **Release validation coverage**: hook-runner spawn/timeout/SIGKILL handling with process-group cleanup; scanner fixtures that avoid accidental false positives; doctor `global`, `lite`, and `sandbox` profiles with explicit PASS/WARN/ERROR/SKIP statuses; `run-test.sh` exit semantics; and sandbox validation coverage.
- Local validation logs are ignored via `logs/` because they are generated diagnostics, not release artifacts or source files.

## [v1.3.0] - 2026-08-06

## Added

- **Non-invasive TUI notifications**: hook failures no longer write to `console.error` (TUI pollution) — non-zero exits route to three non-TUI channels: deduped TUI toast (`client.tui.showToast`), structured `client.app.log` entry (service `pantheon-hooks`), and `.pantheon/logs/hooks.log` file append; `PANTHEON_HOOKS_LOG=1` opt-in preserved, routed to log channels only
- **Delegation lifecycle toasts**: 🚀 `<agent> em execução` / ✅ `<agent> concluiu` with anti-spam (2000ms rate limiter + 3-agents-in-6s aggregation into a single summary toast)
- **PANTHEON_TOASTS gate**: `off|errors|delegations|all` (default `delegations`), read once at plugin load; gates TUI display only, log channels always write; council toasts included in the default set
- **Olympians groups**: wave→Olympians naming, 10s detection window, group completion
- **Hybrid secret blocking**: high-confidence tokens blocked (throw), low-confidence advisory-only; `maskSecret()` redaction applied across hook outputs
- **Honest delegation telemetry**: `delegation_id`/`task_id`/`duration_ms` fields, `dispatched` status for background agents, JSON round-trip stop hook (no TSV corruption)
- **Bash exit-code monitoring**: `metadata.exit` → individual error notifications
- **Talos scope enforcement**: session→agent map, native permission denies, content guard
- `PANTHEON_HOOKS_LOG` opt-in with ISO timestamps per line
- Routing disambiguation (project vs system docs), refusal taxonomy, delegation cache telemetry
- Secret-scan hygiene: wildcard notation for credential references (no literal keys in versioned docs/comments)
- README: hooks testing docs + `PANTHEON_TOASTS` table with council; AGENTS.md adds "PRs always update the README" convention

## Fixed

- Council toast idle-flush race condition

## [v1.2.2] - 2026-08-05

## Added

- **`pantheon prune`** (#22): legacy cleanup command — XDG-aware config resolution, `--dry-run` default (list only), `--apply` removes stale `opencode.json.bak*` backups (age threshold), `--apply --remove-dirs` for legacy dirs with dead configs; old global `pantheon` installs are suggested for manual `npm uninstall -g pantheon`, never removed (npm-managed)
- **Release pipeline standardization** (PR #28): single source of truth for version in `scripts/versioning.mjs` (sem-tag aware); CHANGELOG repair (normalized broken `[5.0.0]` heading → `[1.0.0]`, stripped `[v` prefixes across 3.x history, added `[Unreleased]`); `release.yml` redesigned with idempotent gates (skips publish when version already exists); new `scripts/changelog-extract.mjs` and `scripts/version-check.mjs` (+ test suites) so release bodies use real changelog sections; commitlint extended to cover pushes; pre-commit gate added; `cliff.toml` (git-cliff) removed; `docs/RELEASING.md` added; ADR-0007
- **Test wiring + install docs** (PR #31): `test:security` extended with `test_doctor_layers`; Node test suite wired via `npm run test:node` (`node --test tests/*.mjs` — prune, hook-runner, plugin-log-policy, install/vision contracts, changelog/version checks) into CI; global-install sandbox documented in AGENTS.md / INSTALLATION.md
- Dead `src/mcp/requirements-mcp-core.txt` catalog duplicate (YAGNI — the installer uses `requirements-mcp.txt`)

## Fixed

- **Reliable global install** (PR #26): hooks plugin recreated (`pantheon-hooks.ts` + `hook-runner.ts` with stdin JSON protocol, version-proof); MCP install made hermetic (absolute paths); packaging fix (`files[]` += `src/plugins/**`, `scripts/hooks/**`, self-reference removed, pinned `@opencode-ai/plugin` 1.18.11); `import uuid` hotfix in `scripts/mcp_persistence_server.py`
- **Installer/plugin packaging paths** (PR #31): hooks plugin registered via `resolveInstalledPlugin` so the config points at the INSTALLED package path, never the developer's absolute path (#30); TUI registered with absolute dist path in `tui.json` (#32 — relative path caused NpmInstallFailedError); TUI reads its installed package version via `import.meta.url` (works from any cwd)
- **Idempotent init** (#19): `subagent_depth` merged into the always-run config merge — run #1 already produces the final config (previously only the SECOND init added it); honest re-run stats (`routing.yml` no longer counted as created every run)
- **Layered doctor** (#18): B.6 smoke JSON-RPC `initialize` + F venv/deps check with pinned requirements
- **Pinned MCP dependencies** (#21): exact pins in `src/mcp/requirements-*.txt` (`mcp==1.29.0`, `fastmcp==3.4.6`, `pyyaml==6.0.3`, `sqlite-vec==0.1.9`, `fastembed==0.8.0`, `httpx==0.28.1`) — reproducible venv installs
- **Silent hooks by default**: audit hooks no longer echo to the console on success (`PANTHEON_HOOKS_LOG=1` re-enables the debug echo; log FILES `sessions.log`/`delegations.log` continue to be written)

## [v1.2.1] - 2026-08-03

## Added

- **Model routing presets + interactive picker**: 4 presets (go-deepseek, go-premium, go-fast, go-free), zero-mutation default (injects only when `active-preset.json` exists), `set-tier` CLI in `bin/pantheon-init.mjs` with API-key fail-fast, interactive picker in `scripts/install/model-picker.mjs` (atomic write + .bak), `validate-routing.mjs` preset validation, packaging fix so `src/pantheon/**` ships in the tarball
- 4 new provider families — go-claude (Anthropic), go-openai, go-olympus, go-muses presets + `CAPABILITY_TABLE` (+11 entries: glm-5.1/5.2, kimi-k2.6, qwen3.7-max/plus, minimax-m2.7/m2.5, bare deepseek-v4-pro/flash, big-pickle, nemotron-3-ultra-free, north-mini-code-free)
- **Vision routing**: per-turn multimodal fallback for image turns (`vision:` key per preset, `chat.message` hook), later evolved to native gateway vision (mimo-v2.5) with MCP-tool fallback, image-history normalization, description cache (sha256, TTL 30min) + intent-calibrated prompts, temp-image dedup/LRU
- Canonical `pantheon-vision` MCP stdio server (`src/mcp/pantheon_vision_server.py`)
- TUI: vendored todo-progress + usage-bar (v1.1.0, MIT attribution), active model preset shown in sidebar (30s refresh), OpenCode Go/Zen usage quota tracking (5h/7d/1m dollar windows, `[opencodego]` toml config)
- **Unified `release.yml`**: single workflow handles beta (PR label) + stable (main push) with version-exists check
- Secret scanning: fail-closed CI gates (gitleaks + custom scan), pre-commit hooks, secret-scan regression tests
- docs: model routing presets documented (presets, commands, env vars)
- Preset lineup refactored 8 → 6: go-deepseek routed via OpenCode Zen, go-fast via OpenCode Go, olympus/muses renamed go-premium/go-free — all presets now via OpenCode/Anthropic/OpenAI providers, `PANTHEON_DEEPSEEK_API_KEY` removed
- Vision routing consolidated and legacy duplicates removed
- commitlint: CodeQL auto-fix ignore pattern, body-max-line-length disabled, `security` type allowed, plugin/vision/presets/hooks scopes added; tsconfig dropped path aliases (+ `opencode.d.ts` ambient types)
- install: pantheon-vision registered, `doctor.mjs` hardened
- PR template added in English; coverage artifacts gitignored
- CI workflow triggers synced with base develop; `release.yml` gained `workflow_dispatch` with `pr_number` input
- Stale release workflows (release-beta.yml / release-stable.yml leftovers) brought back by merge
- TUI todo-progress bar (redundant with native TODO + sidebar), v1.1.1
- Duplicate `scripts/scrub_secrets.py` (canonical is `scrub-secrets.py`)

## Fixed

- Plugin export as function for opencode 1.18.11 API (object export failed to load; hooks.config mutates config in place)
- Vision pipeline: plugin boot failure (legacy loader), MCP tool ID (`pantheon_vision_vision_describe`), gateway 401 (provider prefix stripped from model ID), temp-file race (age-guarded cleanup, dir never removed), image stripping at source (deepseek-v4-flash declared image-capable), gateway-aware qwen interception, MCP availability verified, refcounted shared temp images, file URLs decoded via `fileURLToPath`, temp image permissions restricted
- Default vision fallbacks: mimo-v2.5 (multimodal, cheaper) then minimax-m3 (qwen3.7-plus 500 on Go gateway); silent hook logs
- `import uuid` in `mcp_persistence_server.py` (context_save NameError)
- commitlint failures + typecheck narrowing; active preset applied in config hook
- CI: `workflow_dispatch` treated as stable release; empty env block removed; `NODE_AUTH_TOKEN` restored (OIDC Trusted Publisher not configured on npm); `github_pat_` self-match in secret scan; fast-uri upgraded to patched version
- Security: hardcoded provider credentials removed, preset error logging sanitized (CodeQL), dist artifacts untracked
- install: project MCP commands point at real venv

[v1.2.1]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.2.1

## [v1.2.0] - 2026-07-30

## Added

- **Fallback chains + auto CI retry**: per-agent fallback chains (hermes→talos→athena, apollo→athena→hermes, etc.), CI retry 1 → 2 with exponential backoff + fallback agent, token tracking in `subtask_summary`, `fallback_chains` section in routing.yml
- Zeus Fusion-style delegation enforced — `edit:deny`, `bash:deny`, never touches files
- Persistence performance: index on (namespace, expires_at) — O(n)→O(log n) TTL queries, `kv_stats` tool, opportunistic auto-purge (>500 entries), FTS soft-delete trigger (fixes phantom results), `re.escape()` query safety, `kv_delete_namespace` bulk cleanup
- **Context checkpoint tools**: `context_save`, `context_get`, `context_list`, `context_stats` — session-scoped state in `checkpoint:{slug}` namespace, auto-TTL 4h, replaces file-based `checkpoint_session.py`
- New release system: beta from PR label (release-beta.yml), stable from main push (release-stable.yml)
- docs: `RELEASE.md` — beta from PR label, stable from main push
- **Slash commands consolidated 16 → 5** — kept `/pantheon`, `/audit`, `/deepwork`, `/optimize`, `/consolidate`; deleted 11 (cancel, focus, forget, install, reflect, remember, search, sketch, status, update, verify) with Apollo audit verifying alternative coverage (ADR-006)
- Removed redundant model configs — agents inherit default deepseek-v4-flash
- Persistence docs updated for new tools and auto-purge behavior
- commitlint scopes completed; auto-release skipped when version already exists

## Fixed

- Council fixes: UUID session isolation in context checkpoints, pre-compaction state save trigger, flash summary quality floor (<10 chars → fallback to Zeus), agents recall `context_get(slug, 'latest')` on startup
- CI: push triggers removed — validation workflows (CI, commitlint, CodeQL, hotfix, docs) now run on `pull_request` only, eliminating perma-pending duplicate checks

[v1.2.0]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.2.0

## [v1.0.0] - 2026-07-24

## Added

- **OpenCode-only**: Removed all multi-platform support (Claude Code, Cursor, Windsurf, Cline, Continue.dev, VS Code Copilot). Pantheon v1.0 is exclusively for OpenCode.
- **Global installation**: `npx pantheon-opencode init` installs agents globally to `~/.config/opencode/agents/`. Optional `--project` flag for project-local install.
- **Background subagents**: Native OpenCode `task(background=true)` + `task_status()` delegation. Max 5 concurrent subagents. Requires `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`.
- **Shared instructions**: Behavioral rules moved to `.instructions.md` files loaded via `instructions/*.instructions.md`. Eliminated duplicate rules between agents and instructions.
- **TUI sidebar plugin**: Custom sidebar showing Pantheon version, sessions, commands, agents, config, and memory stats.
- **Agent routing optimized**: Zeus routing decision tree prohibits `general`/`explore` subagent types. Each domain maps to a specialist.
- Instructions tokens reduced 10.3k → 7.5k (-18%)
- Zeus.md reduced 431 → 144 lines
- Skills reduced to 14 (from 40), with merged content
- `skills-lock.json` regenerated (40 → 14 entries)
- 6 platform-specific installers (claude, cline, continue, copilot, cursor, windsurf)
- 6 platform-specific docs files
- Legacy scripts: `pantheon-install.mjs`, `pantheon-update.mjs`
- `platform/opencode/agents/` (agents now in `src/agents/`)
- `auto-continue-template.md`
- `checkpoint-standards.instructions.md`
- Updated command list: 14 → 11 commands
- Added: `/pantheon-bg`, `/pantheon-doc`
- Removed: install, update, cancel, sketch, consolidate

[v1.0.0]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.0.0

## [v1.1.1] - 2026-07-30

## Added

- New release system — beta releases from PR labels, stable from main push (auto-release and beta-release workflows unified)
- Interactive TUI mode for installer (Fases 1+2) — redesigned sidebar with context progress bar, live session data via events + API
- Session-scoped context checkpoints in persistence (index, stats, auto-purge, `delete_namespace`); fallback chains, auto CI retry (2x), token tracking
- Slash commands consolidated from 16 to 5; redundant model configs removed (agents inherit the default model)

## Fixed

- Council: UUID session isolation in context checkpoints, pre-compaction state save, flash summary quality floor, agents recall `context_get(slug, 'latest')` on startup
- TUI plugin/CI: OpenCode crash from missing plugin deps, version detection with git fallback, commitlint scopes, workflow YAML/MCP path repairs; `datetime.UTC` → `timezone.utc` for Python < 3.11

[v1.1.1]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.1.1

## [v1.1.0] - 2026-07-26

## Added

- Council synthesis Fase 1+2 — Modo Desempate com Evidência + BackgroundJobBoard (#2)
- Beta release workflow added (from develop)

[v1.1.0]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.1.0

## [v1.0.7] - 2026-07-26

## Fixed

- Installer: fixed `writeFileSync` not defined error

[v1.0.7]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.0.7

## [v1.0.6] - 2026-07-26

## Added

- 7 new skills (codemap, simplify, reflect, worktrees, verification-planning, loop-engineering, clonedeps) + 7 matching commands; `background_subagents` enabled by default in canonical config
- Release pipeline: quality gates, tag creation, pre-release, hotfix support
- CI simplified from 10 to 6 workflows; agent/skill restructuring — 12 redundant instructions removed, unused commands dropped, gaia archived then restored

## Fixed

- CI/commitlint config (YAML syntax, header-max-length, ignores function, scopes); 45 stale references cleaned across 18 files; invalid `opencode.json` fields removed; installer copies `routing.yml`; YAML frontmatter regenerated for 9 agents

[v1.0.6]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.0.6

## [v1.0.5] - 2026-07-26

## Fixed

- CI auto-release with OIDC trusted publisher + npm v12 (Node 22 upgrade, clean publish)
- `doctor.mjs` paths + simplified `prepublishOnly`

[v1.0.5]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.0.5

## [v1.0.2] - 2026-07-25

## Added

- TUI plugin: copy logic, stale skill cleanup, `tui.json` dedup; advanced plugin with version detection and 14 commands
- Agents migrated from deprecated `tools:` to OpenCode `permission:` model; legacy multi-platform tests removed (OpenCode-only conformance); docs modernized (OpenCode-only, unified commands)

## Fixed

- Hardcoded version fallback replaced with package.json version; routing aligned with actual skills (vscode platform removed)

[v1.0.2]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.0.2

## [v1.0.1] - 2026-07-24

## Added

- Installer: unified setup flow, removed lifecycle install, fixed entry points

[v1.0.1]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.0.1

## [v3.19.2] - 2026-07-21

## Added

- `_pantheon_paths.py` — shared path resolution (`PANTHEON_HOME`, `PANTHEON_PROJECT`)
- `pantheon-persistence` MCP — KV store with SQLite FTS5, TTL, namespaces, 6 tools
- `pantheon-memory` rewritten — sqlite-vec + fastembed (ONNX, ~50MB) replaces chromadb + torch (~1.4GB)
- Hybrid semantic search: vector cosine + FTS5 BM25 via RRF fusion
- `.pantheon/mcp-registry.yml` — canonical MCP registry + auto-propagation
- Simplified installer: `install:lite` (agents only), `install:full` (everything), `install:runtime` (MCP infra)
- `scripts/install/venv.mjs` — auto .venv creation + pip install of lightweight deps
- `scripts/install/health-check.mjs` — 6 post-install validations
- `scripts/install/migrate.mjs` — upgrade path v3.10 → v3.18 → v3.19.0 → v3.19.2
- MCP servers patched for global install (no more `__file__.parent.parent`)
- **Dependencies reduced from ~1.4GB to ~50MB** — removed chromadb, sentence-transformers, torch
- `memory_mcp_server.py`: 1,344→584 lines, 14→6 tools (memory_store, memory_search, memory_recall, memory_forget, memory_list, memory_stats)
- `routing.yml`: 1,102→482 lines (-56%), deleted 22 dead handoffs, routing_matrix
- `internet-search` skill: 519→130 lines, tool-agnostic (context7/websearch/webfetch)
- Memory Protocol: shared `instructions/memory-protocol.instructions.md`, 14 agents with 2-4 line overrides
- Agent YAML frontmatter fixed across all 14 agents (broken `...` separators, skills indent)
- All platform configs updated with persistence MCP entries
- `opencode.json` generated with correct deploy paths (cwd = deploy target)
- chromadb + sentence-transformers + torch (~1.4GB dependency chain)
- `scripts/requirements-mcp-memory.txt`
- 9 duplicate instructions (now skills on-demand)
- `multi-model-routing` from prometheus (deleted skill)

## Fixed

- 157 dangling instruction references across 6 platforms
- YAML frontmatter in all 14 agents (broken by previous sed edits)
- OpenCode platform detection (was missing `platform/opencode/opencode.json`)

## [v3.19.0] - 2026-07-21

## Added

- Memory Persistence Protocol (ADR-006) — agents now have mandatory `memory_recall()` pre-work (top_k=3, skip if score<0.3) and `memory_store()` post-work (2 lines max, importance 0.4-0.9)
- Session-end auto-save script (`.pantheon/code-mode/session-end-save.py`) — exports Vector DB entries with importance ≥0.4 at session close (ChromaDB direct read + client-side filtering)
- `session_end_save` handoff in routing.yml for Mnemosyne session close trigger
- `tools.agent: true` for Apollo, Talos, and Gaia canonical agent files
- Recall Conflict Protocol (ADR-006 v1.1) — 5 rules for when recalled memory conflicts with current action (log, prefer freshness, escalate ADRs, score threshold, audit trail)
- New skills synced: `file-prompts`, `plan-architecture`, `streaming-patterns`, `token-audit`, `wisdom-accumulation`
- All 14 agent files updated with `## 🧠 Memory Protocol` section (both canonical `/agents/` and OpenCode `.config/opencode/agents/`)
- Zeus now auto-stores `memory_store()` directly on agent return — no Mnemosyne middleman
- Steps optimization in opencode.json: zeus(25→35), aphrodite(25→30), hermes(20→25), themis(20→25), demeter(20→25), mnemosyne(10→8), iris(15→10), nyx(15→12), athena(15→12)
- README.md badges updated to v3.19.0, skills count 43→40
- 9 duplicate instructions deleted — now only skills on-demand (tdd-standards, code-quality-checks, code-review-standards, database-standards, artifact-protocol, mcp-security, memory-bank-standards, infra-standards, auto-continue-safety-gates)
- Always-loaded instructions: 19→10 files (~5.7K→~3K tokens/session, -47%)
- Agent platform copies updated across 6 platforms (Claude, Cursor, Windsurf, Continue, Cline — .clinerules)
- `routing.yml` artifact paths: `docs/memory-bank/`→`.pantheon/memory-bank/`
- 5 orphan skills linked to agents: wisdom-accumulation→zeus, plan-architecture→athena, file-prompts+streaming-patterns→hermes, token-audit→nyx
- `prompts/orchestrate-with-zeus`: fixed 3 instances of ATHENA→APHRODITE for frontend delegation
- `prompts/focus.prompt.md`: stale `/memories/session/` path → `.pantheon/memory-bank/.tmp/`
- `prompts/mirrords.prompt.md`: tool names updated to current API
- `commands/pantheon-install.md`: stale doc ref and platform count fixed
- `commands/pantheon-update.md`: example version bumped to 3.19.0
- `pyproject.toml`: removed all backend/fastapi/alembic dependencies (no longer maintained)
- `platform/forge.json`: version bumped to 3.19.0
- `alembic/` — stale DB scaffolding (never completed)
- `backend/` — stale FastAPI database engine (half-finished)
- `docs/memory-bank/` — stale duplicate (should have been purged in v3.17.0)
- `docs/TUTORIAL-PLUGIN-PT.md` — Portuguese tutorial for disabled plugin
- `plugins-disabled/` — stale pantheon-tui-plugin
- `release_notes.md` — lowercase, redundant with CHANGELOG
- 4 obsolete skills: `conversational-ai-design`, `multi-model-routing`, `prompt-improver`, `prompt-injection-security`
- `__pycache__` and `.mypy_cache` build artifacts
- Full documentation audit: 10+ doc files cleaned, versions reconciled, stale content purged
- Memory Persistence Protocol documented as ADR-006
- `.config/opencode/` fully synced from canonical Pantheon (14 agents + 10 instructions)

## Fixed

- 33 dangling `docs/memory-bank/` references fixed across platform configs (`.claude/`, `.cursor/`, `.windsurf/`, `.continue/`, `.clinerules/`, `.github/`, `memories/`, `platform/`, `template/`, `.opencode/skills/`, `.tests/`)
- `.pantheon/memory-bank/.tmp/` added to `.gitignore`
- `docs/RELEASING.md` version reference — v3.8.4 → v3.19.0
- `docs/UPGRADING.md` — removed obsolete Agora migration guide, added v3.19 Memory Protocol section
- `docs/mcp-recommendations.md` — removed Exa MCP references (removed in v3.15.0)
- `docs/platforms/opencode.md` — removed stale "agora" references
- `docs/AGENT-MCP.md` — removed Exa reference
- CHANGELOG duplicate v3.9.0 entries removed
- `template/CLAUDE.md` — `agora`→`zeus` for council dispatch
- `.github/instructions/auto-continue-safety-gates`: "Agora Council"→"Council"
- `.tests/test-all.sh`: removed stale chiron.agent.md test
- Skills count reconciled across all docs: 40
- `docs/INDEX.md` skills count: 45→40

## [v3.18.0] - 2026-07-15

(no changes)

## [v3.17.1] - 2026-07-14

## Added

- Inline compression triggers (C8/C9/C11): implementation agents (Hermes, Aphrodite, Demeter, Hephaestus, Prometheus) now declare `context-compression` skill and have a concise `## Inline Compression` section covering CRITICAL/HIGH subtask summaries, pre-delegation large blocks, and phase boundaries/handoffs
- `tests/test_code_mode_args.py`: TDD coverage for the new `args` parameter forwarding
- `context-compression` SKILL.md: real C8–C11 trigger definitions added; redundant C10 noted as OpenCode-native cross-reference; L1/L3 contradiction resolved (L1 = inline compress via MCP, L2 = batch promotion at gates)
- Agent `.md` files: `context-compression` added to `skills:` frontmatter for all 5 implementation agents
- `instructions/artifact-protocol.instructions.md`: scrub documented as automatic via MCP layer

## Fixed

- `execute_code_script` now forwards CLI arguments to subprocess — `compress-inline.py` is reachable via MCP (fixes argparse code 2 error)
- Unified scrubber: 3 divergent implementations consolidated into single canonical `scripts/scrub-secrets.py`, imported by both `memory_mcp_server.py` and `compress-inline.py` via `importlib` (hyphenated filename cannot be statically imported)
- OpenAI key regex standardized across all consumers to `sk-[A-Za-z0-9\-_]{10,}`

## [v3.17.0] - 2026-07-11

## Added

- Pantheon TUI Plugin overhaul: sidebar modernization, clickable commands, dynamic Python version
- MCP Config section in TUI: list active plugins, MCP status, auto-compaction toggle
- Memory section in TUI: show memory entries count
- MCP templates for 6 platforms (Claude, Cline, Cursor, Windsurf, Continue, Copilot)
- `scripts/init-pantheon-mcp.sh` — automated MCP setup
- `docs/INSTALLATION.md` — MCP installation guide
- `docs/MIGRATION-MEMORY-BANK.md` — migration guide for memory bank to .pantheon/
- Memory bank moved from `docs/memory-bank/` → `.pantheon/memory-bank/` (fully local, gitignored)
- `.pantheon/` is now the standard for all local/generated artifacts
- OpenCode MCP format fixed: command as array + cwd
- All platform templates updated with pantheon-code-mode MCP
- `.mcp.json` moved from root to `platform/mcp/mcp-template.json`
- Version synchronization: `versioning.mjs` now handles all manifests (package.json, plugin.json, pyproject.toml, forge.json)
- Updated 65+ source files with new .pantheon/ paths
- `docs/memory-bank/` from git history (fully purged via filter-repo)

## Fixed

- TUI plugin path in tui.json (was pointing to non-existent file)
- OpenCode MCP config format (command must be array + cwd)
- Release pipeline: version mismatch between package.json and plugin.json
- `mcp_resources_server.py` memory-bank path resolution

## [v3.16.0] - 2026-07-10

## Added

- MCP Resources Support: pantheon://agents, skills, routing, deepwork, memory-bank
- Code Mode MCP Adapter: confined script execution from .pantheon/code-mode/
- YOLO Mode / Auto-Approve: permission tiers for trusted MCP servers
- Reasoning Effort per Agent: high / medium / low in routing.yml + 14 agent frontmatter
- Unified Memory MCP Server: 14 tools, ChromaDB + sentence-transformers, 79 tests
- Knowledge graph: memory_link + memory_traverse (BFS traversal)
- RTK-style output filters: dedup, group, truncate on memory_store
- Freshness decay (30-day half-life) + importance boost + claim verification
- Agent MCP Integration: all 14 agents with MCP Capabilities + routing.yml capabilities
- Documentation: MCP.md (238l), MEMORY.md (471l), AGENT-MCP.md (197l)
- Skills audit: 5 orphan skills deleted, quality-gate skill created
- Platform sync: pantheon-memory added as Tier 1 MCP in install-mcp.mjs
- docs/mcp-recommendations.md expanded to 422 lines (browser MCPs, infra MCPs, 3-7 rule)
- memory_cleanup: 3-char minimum prefix guard
- memory_export: restricted to ~/.pantheon/exports/ with path traversal check
- Content size limit: 100KB max, 500 char category

## Fixed

- memory_sessions dead code (always returned empty results)
- install-mcp.mjs filename: dash → underscore
- .github/plugin/plugin.json: removed deleted streaming-patterns reference
- memory_mcp_server.py: F821 undefined name, missing except block

## [v3.15.0] - 2026-06-26

## Added

- **Level 3 Vector Memory:** 5 scripts (`schema.py`, `index.py`, `query.py`, `rebuild.py`, `cli.py`) with dual indexing (FTS5 + optional sqlite-vec embeddings), 8/8 tests passing, 120 entries indexed from memory bank
- **Two-Tier Persistence Model:** Tier 1 auto-index (`quick_index()`) saves background agent results instantly into Vector Memory; Tier 2 full compression (ZZ artifact + memory bank update) only on Themis APPROVED
- **Inline quick_index():** New function in `index.py` indexes subtask_summary dicts directly (no file scanning), idempotent via content_hash, auto-tags from keywords
- **Context Compression Trigger:** Section in `zeus.agent.md` with test script `scripts/test-context-compression.sh` — validates all 5 checks (prerequisites, mocks, structure, secrets, output)
- **Background Agent Dispatch:** Pattern documented in `zeus.agent.md` and `orchestration-workflow/SKILL.md` — OpenCode v1.16.2+ background agents with auto-persist
- **Auto-Continue Canonical Name:** "relentless" → "auto-continue" across 43 files (skills, commands, agent files, platform copies)
- **Tools Format:** 14 agents converted from YAML array (`- tool`) to object format (`tool: true`)
- **quick_index path fix:** Scripts now add `scripts/` (parent of vector_memory package) to sys.path instead of their own directory
- **Platform Skill Directories:** 211 stale skill files removed from 6 platform dirs (`.clinerules/skills/`, `.claude/skills/`, `.cursor/skills/`, `.windsurf/skills/`, `.continue/skills/`, `platform/*/`) — OpenCode v1.16.0+ discovers skills natively from `~/.config/opencode/skills/`
- **Exa MCP Server:** `exa-mcp-server` removed from `opencode.json` (redundant with OpenCode native websearch)
- **`vector_memory` config key:** Removed from both project and global `opencode.json` (not recognized by OpenCode v1.17.x)
- **NOTE0010:** Pantheon v3 Roadmap — 5-phase vision from FTS5 to Plugin Architecture
- **TASK-016:** Level 3 Implementation Plan — 24 tasks across 5 phases
- **01-active-context.md:** Updated with deepwork v3.15 changes and Two-Tier model

## Fixed

- **Import Path in Vector Memory Scripts:** `sys.path` now correctly points to parent of `vector_memory/` package, enabling both direct execution and `python -m` usage

## [v3.14.1] - 2026-06-21

## Added

- **Pantheon-Context MCP Experiment:** Removed entire `scripts/pantheon-context-mcp/` directory (server.py, scoring.py, summarizer.py, tests — 12 files, ~1,200 lines)
- **Stale Agent References:** Stripped `pantheon-context` tool references from all 14 agent files, `.mcp.json`, `opencode.json`, `ROADMAP.md`
- **Auto-Release CI:** Removed `.github/workflows/auto-release.yml` (triggered broken v3.14.0 release on every push to main)
- **TUI Sidebar Plugin:** Rewrote from flat file to npm-style directory (`plugins/pantheon-tui/` with `index.tsx`, `package.json`, `dist/tui.tsx`). New features: real context usage bar (color thresholds 70%/90%), collapsible command guide (16 `/pantheon` commands), manual compress button, Python version display, collapsible agent registry

## Fixed

- **Install Script:** `scripts/install/opencode.mjs` now correctly copies npm-style plugin directory and registers in `tui.json` (not `opencode.json` — TUI plugins use separate registration)
- **CI Release Pipeline:** Added `dry_run` input to manual release workflow, removed auto-merge from release PRs, fixed duplicate steps

## [v3.14.0] - 2026-06-20

## Added

- **Codebase Audit:** Comprehensive 5-agent scan — 48 issues found, all resolved
- **Mermaid Diagrams:** 5 new diagrams — TDD Cycle (stateDiagram-v2), Artifact Lifecycle (flowchart), Council Synthesis (sequenceDiagram), Architecture (flowchart), Delegation Flow (flowchart)
- **Python Infrastructure:** Added `[build-system]`, project deps (FastAPI 0.110+, SQLAlchemy 2.0+, Alembic 1.13+, Pydantic 2.7+), ruff expanded to 11 rule groups, coverage (`fail_under=80`), mypy strict
- **Alembic Scaffolding:** `alembic.ini` with env var interpolation, async `env.py`, Mako template, models base with `AsyncAttrs` + `TimestampMixin`
- **SQLAlchemy 2.0 Mixins:** `UUIDPrimaryKeyMixin`, `IntegerPrimaryKeyMixin`, `SoftDeleteMixin`, `ActivatableMixin`
- **Frontend Scaffolding:** `biome.json` (1.9.4), `tsconfig.json` (strict mode, ES2022), npm scripts (test, lint, typecheck, build, dev)
- **Docker Infrastructure:** Multi-stage Dockerfile (build + runtime, non-root), docker-compose.yml (PostgreSQL 16 + API), `.env.example`
- **Database Standards:** Async SQLAlchemy 2.0 patterns, connection pooling, migration testing, disaster recovery + 2 Mermaid diagrams
- **Documentation Quality:** "When NOT to Use" sections on all 7 main agents, English-only throughout, ROADMAP.md updated

## Fixed

- **Dead Agent Purge:** Removed ~150+ references to Echo, Chiron, Argus, Agora across 67+ files (agents, platforms, instructions, skills)
- **Portuguese→English:** `docs/platforms/README.md` fully translated, `agents/prometheus.agent.md` mixed-language fixed
- **QUICKSTART.md:** Removed duplicate Nyx entry in agent table
- **`00-project.md`:** Fixed Argus in architecture diagram, corrected skill path, fixed Portuguese text
- **Prometheus Self-Contradiction:** Fixed "MUST NOT deploy (that's @prometheus)" — copy-paste bug from Chiron merge
- **Hephaestus Echo Dead Code:** Removed 25-line Echo section that was copy-pasted verbatim
- **`seo-config.ts`:** Renamed to `.md` (was Markdown disguised as TypeScript)
- **`agent-return-format.instructions.md`:** Fixed Agora reference in artifact table
- **`skills/README.md`:** Count corrected from 37→42, stale Chiron/Echo refs updated

## [v3.13.0] - 2026-06-20

## Added

- **Level 2 Context Compression** — priority scoring engine (5 deterministic dimensions: Impact, Risk, Novelty, Blockers, Downstream relevance), semantic summarization templates per agent-pair, budget allocation (100-line cap, priority-greedy), cross-reference mechanism (D/E/M/C IDs with auto-generated `_xref/index.md`), ZZ artifact format for phase-to-phase context injection, `context-compression` skill (Level 2)
- **New prompts**: `prompts/semantic-summarize.md` for agent-pair aware semantic summarization
- **New scripts**: `scripts/scrub-secrets.py` for security scrubbing of compressed content
- **Missing infra**: `docs/memory-bank/_xref/_next_id.json` with full key names (decisions/entities/milestones/tasks)
- **Safety preflight**: `can_compress()` guard prevents compression of in-progress/escalated/blocked/NEEDS_REVISION artifacts
- **Atomic write protocol**: .tmp + fsync + rename with validation for corruption prevention
- **14 agent `.agent.md` files** — stripped non-OpenCode frontmatter (`tools:`, `handoffs:`, `agents:`, `color:`, `hidden:`, `mcpServers:`). All agents now use only OpenCode-recognized fields
- **Agent count unified** — all files consistently say "14 agents" (removed chiron, echo, argus from counts)
- **`instructions/artifact-protocol.instructions.md`** — updated with ZZ artifact format, compression lifecycle, atomic write protocol, budget guardrails
- **`instructions/memory-bank-standards.instructions.md`** — updated with compression and recovery section, cross-reference docs
- **Context compression** — Level 1 replaced entirely by Level 2 (priority-scored summaries with downstream-aware field masks)
- **All 7 platforms regenerated** — commands (pantheon-status, ping) and agents synced across OpenCode, Claude Code, Cursor, Windsurf, Cline, Continue, Copilot
- **TUI Plugin** — moved to `plugins-disabled/`, removed from OpenCode config (temporary removal)
- **`packages/tui-plugin/`** — source files removed from active tree
- **`plugins/pantheon-tui-plugin/`** — secondary plugin source removed
- **`platform/opencode/.opencode/package.json`** — stale TUI config removed
- **Stale agent references** — chiron, echo, argus, agora references cleaned from 40+ files across platforms, docs, tests, commands
- **Missing skill references** — `code-discipline`, `architecture-diagrams` removed from agent references (never existed as skills)
- **Platform Conformance Matrix** — 6/6 plataformas passando com 0 falhas
- **CI validate** — passing
- **Sync Check** — passing
- **Auto Release** — published at v3.13.0

## Fixed

- **CHANGELOG.md** — removed 4 duplicate v3.12.1 entries and empty v3.12.2 section
- **Frontmatter consistency** — all 14 agents now parse cleanly with OpenCode YAML frontmatter
- **Cross-platform agent count** — 14 everywhere (was inconsistent: some files said 18, some said 14)
- **`.opencode/plugins/pantheon-hooks.ts`** — local OpenCode plugin que executa os 10 hooks de validação via tool.execute.before/after/event
- **`sync-platform.sh`** — step 3.6 não synca mais TUI plugin; step 3.7 synca o pantheon-hooks.ts globalmente
- **`.gitignore`** — `.opencode/plugins/` agora versionado; `platform/opencode/.opencode/{commands,skills}` ignorados
- **`opencode-hooks-plugin` npm** — removido do config (nunca foi publicado como pacote npm)
- **`@agora` redirects** — substituídos por `@zeus` em 5 platform files
- **Stale docs references** — Chiron, Echo removidos de README.md, QUICKSTART.md, platforms docs; TUI marcado como desativado; hooks docs atualizados de `.github/hooks/` para `scripts/hooks/`; skill count corrigido para 42
- **Canonical skills** — referências a Chiron em agent-coordination e database-optimization atualizadas para "Model Selection" e "model tier"
- **`tools:` field restored to all 14 canonical agents** — re-adicionado de v3.12.2 para o sync engine + conformance tests validarem toolMap keys
- **Stale skills removed** — `relentless-mode`, `review-work` (sem fonte canônica) removidos de .clinerules/skills, platform/claude, platform/cline, platform/continue, platform/cursor
- **Stale commands removed** — `cancel-relentless`, `token-audit` (sem fonte canônica em commands/) removidos de .clinerules/commands, .continue/commands, .cursor/commands e platform sources
- **wisdom-accumulation cleaned from platforms** — nenhum agente referenciava o skill; removido de platform dirs via sync --clean
- **All platforms sync:check** — 0 stale files across 7 platforms

## [v3.12.0] - 2026-06

[compare changes](https://github.com/ils15/pantheon/compare/v3.11.0...v3.12.0)

## Added

- **agents:** Add anti-stall resilience and orchestration improvements ([7a61b69](https://github.com/ils15/pantheon/commit/7a61b69))
- **agents:** Add /pantheon-status command with version badge + agent registry ([984ec65](https://github.com/ils15/pantheon/commit/984ec65))
- **platform:** Add Pantheon TUI sidebar plugin for OpenCode ([09253c1](https://github.com/ils15/pantheon/commit/09253c1))
- **release:** Sync version to v3.11.0 ([1a9fb64](https://github.com/ils15/pantheon/commit/1a9fb64))

## Fixed

- **ci:** Sync platform files and add mcp-security skill to pass CI ([a27a245](https://github.com/ils15/pantheon/commit/a27a245))

## [v3.9.0] - 2026-05-28

[compare changes](https://github.com/ils15/pantheon/compare/v3.8.4...v3.9.0)

## Added

- Setup changelogen + git-cliff for auto-releases ([ce4ee22](https://github.com/ils15/pantheon/commit/ce4ee22))
- Cleanup commands, fix subtask agent, add Context7 tools, improve sync script ([da6ed7c](https://github.com/ils15/pantheon/commit/da6ed7c))

## Fixed

- Add missing closing brace for github configuration in opencode.json ([a63c522](https://github.com/ils15/pantheon/commit/a63c522))
- Address PR review sync and mapping feedback ([c550049](https://github.com/ils15/pantheon/commit/c550049))
- Sync version to 3.8.4, fix versioning.mjs apply bug, add version check script ([141a6b1](https://github.com/ils15/pantheon/commit/141a6b1))
- Add CHANGELOG entry for v3.8.4 to fix CI validate failure ([58cc0f5](https://github.com/ils15/pantheon/commit/58cc0f5))
- **ci:** Auto-release cria PR com auto-merge ao invés de push direto pra main ([e4f78c9](https://github.com/ils15/pantheon/commit/e4f78c9))

[v3.19.0]: https://github.com/ils15/pantheon/compare/v3.18.0...v3.19.0
