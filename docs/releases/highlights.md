# v2.x release highlights

> Originally published in the root README. The canonical, complete history is in
> [CHANGELOG.md](https://github.com/ils15/pantheon-opencode/blob/main/CHANGELOG.md); this
> page keeps the user-facing highlights that used to sit in the README.

## v2.2.0

- **29 Native TypeScript Tools & All Roadmap Pillars:** FTS5 memory + multi-repo read-only federation (`PANTHEON_FEDERATED_REPOS`), checkpoints (`context_*`), durable goals (`goal_*`), structural codemap + AST (`code_*`, `ast_search`, `ast_rewrite`), post-edit LSP diagnostics (`tsc`/`pyright`/stdio + pooled TCP `PANTHEON_LSP_TCP_ENDPOINTS`), atomic Step-Ledger git checkpoints + `ctx.session.create` runner (`pantheon_step_ledger`), native `ctx.worktree.transform` isolation, typed `pantheon_review_verdict` + `ctx.session.synthetic` remediation, bugfix `RED` reproduction gates, and `/pantheon-forge` stack detection.
- **High-Density TUI Mission Control Cockpit (`/pantheon-cockpit`) & Flightdeck Replay Export:** 3-page `@opentui/solid` cockpit (`Overview`, `Swarm` Gantt + stream, `Flightdeck` Gate Matrix + `x` Mermaid replay export to `.pantheon/reports/`) navigable via `1–3`/`Tab` and Home links, alongside `/pantheon-artifacts`, Sidebar domain counters, `↑ vX.Y.Z` update badges, and `Native Tools (29)` in **About**.
- **Shared `.pantheon/` Store Across Git Worktrees & Confinement:** Linked git worktrees automatically resolve back to the main repository's `.pantheon/` store (`PANTHEON_ISOLATE_WORKTREE_MEMORY=1` opts out); deleted files auto-prune from the codemap; `hashline_edit` and `ast_search`/`ast_rewrite` enforce workspace symlink confinement.
- **Anti-Stale Cache & Bundle Protections:** `Legacy & Drift` scans and removes stale coexisting OpenCode plugin caches (`~/.cache/opencode/npm/pantheon-opencode*`), and `version:check` / `package:validate` fail fast if `dist/tui.js` embeds a stale version.

## v2.1.6

- **Deepwork Resilient Normalization:** Full support for multi-decision plans, single-option policy constraints, string criteria auto-inference, and agent handle normalization with atomic plan locking.
- **Fail-Fast Anti-Mocking Rule:** Strict standard forbidding ad-hoc mock servers on production ports to mask missing dependencies; agents fail fast with explicit diagnostics.
- **Project Tool Working Directory:** Dynamic binding of shell tools to the project workspace instead of falling back to `$HOME`.
- **Atomic Skill Installation:** Sequential `&&` chaining for `npx skills add` commands preventing silent omissions when installing multiple skills.
- **Project Bootstrap Git Init:** `init --project` automatically initializes an empty Git repo when absent, enabling worktree and branch isolation out of the box.
- **Decoupled Background Processes:** Mandatory `setsid nohup <cmd> > <log> 2>&1 &` (or `disown`) for background servers surviving subshell termination.

## v2.1.5

- **Risk-Based Validation Protocol (#444):** Explicit multi-tier protocol distinguishing focused test slices (<10s), package integration suites, and mandatory repository CI gates. Escalation to broad suites requires explicit triggers (cross-module, breaking contracts, auth, DB migrations).
- **Tool Execution Resilience & Fallback:** Added `execute` fallback tool alias executing commands directly in `/bin/bash`, preventing `SyntaxError: Assigning to rvalue` when models call `execute` with CLI commands or scripts.
- **CLI Execution Mandate:** Enforced CLI execution via `shell`/`bash` for binaries like `opencode-quota` with an anti-panic ban on speculative recursive `glob`/`grep` in `~/.config`.
- **Validation Scope Transparency (#444):** `subtask_summary` observable receipts report `validation_scope` and deferred `pending_validation` repository CI pipeline gates.

## v2.1.4

- **Global Install Shadowing & PATH Hygiene (#424):** Doctor check (H2b) detects multiple global binaries, dangling symlinks, and prefix skew. Version skew validation prevents `_npx` from binding to older global packages.
- **Strict Test Slice Ordering (#442):** Reordered `--test-name-pattern` flag ahead of the test file path in `scripts/test-slice.mjs` so Node's native test runner filters tests during failure/fix loops.
- **Security Boundaries on Internal Folders (#441):** Hardened `auto-permissions` and `zeusReadGuard` to exclude `.git/` and `node_modules/` from autonomous reads.
- **Universal Session Todo Tool Availability (#439):** Granted `todowrite` and `todoread` across all 14 specialist agent manifests.
- **Session Auto-Discovery for Zen Vision (#440):** Automated active session discovery from environment (`OPENCODE_SESSION_ID`) and SQLite `opencode.db` (`session_v2`) for `vision_describe`.

## v2.0.1

- **Bilingual TUI Settings (PT-BR / EN):** Visual localization for Decision Router, Autonomy & Budgets, and J1 Safety Gate tabs, with intelligent system locale auto-detection (`LANG` / `LC_ALL`) and manual preference cycling (`auto`, `pt-BR`, `en`).
- **Interactive Decision Model Selector:** Permanently accessible selector row in `/pantheon-settings` to cycle across all 6 remote decision models without manual JSON configuration.
- **Modernized Council Synthesis (`/pantheon`):** Rich synthesis artifacts featuring Domain Authority breakdown, Mermaid arbitration diagrams, and immediate action checklists.
- **Modernized Strategic Planning (`/pantheon-deepwork`):** Athena plans now enforce mandatory sub-10s test slicing, execution dependency diagrams, blast radius impact matrix, and rollback blueprints.
- **Demystified J1 Safety Ladder:** Plain-language descriptions for J1 execution modes (`shadow`, `enforce`, `off`), making telemetry and protection gates clear.

## v2.0.0-rc.1

- **Release Candidate Series Inauguration:** Production-ready multi-agent orchestration for OpenCode 2.x.
- **Agent Token Compaction (-44.3%):** Removed duplicated backend code in Apollo/Prometheus, saving 8,150 tokens per turn (~29.3M tokens/month).
- **Pragmatism & Anti-Pedantry Directive:** Safe diagnostic operations are authorized without bureaucratic gates, ending agent sluggishness.
- **Batched Suite TDD & Test-Slicing:** Cohesive multi-endpoint testing and sub-100ms targeted test execution.
- **Proactive Skill Discovery & Query Caching:** Cached skill lookups (24h TTL) and automated recommendation for external tools.
- **Live JEV Scorecard & Sandbox Web App:** 16/16 pass rate ($0.0000238/decision) verified with an end-to-end sandbox application.
