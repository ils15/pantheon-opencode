# v2.x release highlights

> Originally published in the root README. The canonical, complete history is in
> [CHANGELOG.md](https://github.com/ils15/pantheon-opencode/blob/main/CHANGELOG.md); this
> page keeps the user-facing highlights that used to sit in the README.

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
