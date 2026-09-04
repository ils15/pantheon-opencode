# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

<!-- Add new changes here. Running `node scripts/versioning.mjs apply` will
     move this section to a versioned entry and reset the template below. -->

## 🆕 What's New

## 🐞 Fixed
- **fix(deepseek): image input support** — fail-closed for known text-only providers when model is undefined (#58)

## ⚠️ Known Issues

## ✅ Closed Issues

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

## 🆕 What's New

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

## 🐞 Fixed

- memory_search doc drift: freshness decay was documented but not implemented — now real via `decay_days`.
- scripts/ copies stale vs src/mcp/ canonical sources (missing routing project fallback, stale comments).
- .pantheon/mcp-registry.yml listed non-existent tools (memory_compress, memory_expand, list_agents) and missed pantheon-vision.

## [1.3.5] - 2026-08-21

## 🆕 What's New

- **PT patterns para delegação (routing.yml)** — adiciona 5 padrões PT (`procure`/`busque`/`encontre`/`localize`/`pesquise`) ao `intent_gate` research → apollo, corrigindo detecção de intenção para prompts em português (PR #61).
- **Zeus read guard (delegation-enforce.ts + plugin.ts)** — `ZEUS_READ_DENY_PATTERNS` bloqueia `src`/`tests`/`scripts`/`glob`/`grep` por Zeus via `tool.execute.before` (primeiro guard da cadeia); `ALLOWED_PATHS` libera `.md` e `.pantheon/memories`; 10 casos de teste em `tests/pantheon/delegation-enforce.test.ts`; `apollo.md`/`gaia.md` com `visible:false` e `tools.task:false` para depth-1 (PR #61).

## 🐞 Fixed

- **session-guard + retry helper (session-guard.ts + zeus-delegate-with-retry.ts)** — guard de `session_id` e helper `zeusDelegateWithRetry` com retry/backoff para delegações; `goal-loop.ts`/`todo-enforcer.ts`/`todo-preserve.ts`/`delegation.ts` ajustados (PR #61).
- **validate doctor filter (scripts/doctor.mjs)** — `isValidAgentFile` verifica frontmatter YAML (`name`/`description`/`mode`) para filtrar `README.md` e docs não-agente de `getCanonicalAgentNames`/`deriveInstalledAgentFiles`; evita contagem espúria no `doctor` (PR #61).
- **README move (src/agents → docs/agents)** — move `README.md` para fora de `src/agents` para evitar agente espúrio; `docs/agents/README.md` criado (PR #61).
- **TUI GC aliasless (src/plugins/tui)** — GC de delegações live sem alias para evitar estado `delegating` preso; `src/plugins/tui/src/index.tsx` + `dist/` atualizados (PR #61).
- **routing fallback opencode-go (src/pantheon/presets.mjs + routing.yml)** — fallback do preset default para `opencode-go` quando API key do provider ausente; `resolveChildModel` com fallback para `opencode/deepseek-v4-flash-free` (PR #61).
- **install README guard (scripts/install/*)** — `shared.mjs`/`opencode.mjs`/`agents-md.mjs` impedem cópia de `README.md` para diretório de agentes; `package.json` ajustado (PR #61).

## [v1.3.4] - 2026-08-11

## 🆕 What's New

- **Compaction summary V2** (preservation directive + mission/todo/delegation sections): `buildCompactionContext` is now async and accepts goal/todo sources — `PANTHEON_COMPACTION_DIRECTIVE` prefix section (emitted before any other section, skipped on totally-empty state), `<mission_context>` with active goals (id/objective/status), `<todo_context>` with pending (not completed/cancelled) todos; delegation blocks byte-for-byte unchanged; failing/disabled sources are skipped fail-open (logged to hooks.log)
- **Post-compaction todo preservation**: TodoPreserver captures the session's todo list on `experimental.session.compacting`, activates the snapshot on `session.compacted`, and rewrites the first post-compaction `todowrite` with the exact pre-compaction list — additive + fail-open (every step degrades to a logged warn, never throws in a hook)
- **Post-compaction state re-assertion**: re-asserts session state after compaction so the rebuilt context reflects the live board
- **Historical (superseded) agentModels wiring from routing.yml**: the old release wired `options.agentModels` from the first preset. Current behavior requires an explicitly active profile and omits child models otherwise.
- **Preemptive compaction threshold logic** (dormant/experimental): threshold-based preemptive compaction — not active by default
- **File-first logging**: `createPantheonLogger` — console echo opt-in via `PANTHEON_HOOKS_LOG=1`, everything routed to `.pantheon/logs/hooks.log` (silences TUI console pollution)
- **Real-time Delegations TUI panel**: sidebar panel sourced from `api.client.session.children` — shows `pantheon_delegate` children (board alias tag) AND native `task()` children (`[task]` tag, distinct info color); animated states (DELEGATING/WORKING/READING RESULT/DONE/DONE (TIMED OUT)/ERROR/CANCELLED) with a 140ms spinner; click-to-navigate into the child session; all-sessions history via `.pantheon/delegations/` reports; `panel: children=N md=N events=N` diagnostics in hooks.log
- **README docs**: 1.3.4 compaction + delegation features documented
- **Zero chat-notification policy**: removed the `chat.message` injection channel for delegation signals — completion visibility lives in the board `[unread]` marker, `pantheon_delegation_read`, TUI toasts and compaction carry-forward, never in the chat transcript

## 🐞 Fixed

- **Delegate dispatch with missing provider API key** (P1): `resolveChildModel` never checked whether the resolved model's provider had a configured API key — a child dispatched to a keyless provider (e.g. gpt-5.6-luna/opencode-go) died instantly with `AI_LoadAPIKeyError`. Auto-resolved models (agentModels/preset) whose provider key is missing now fall back to `opencode/deepseek-v4-flash-free`; explicit caller models are respected (warned); when nothing is usable the tool returns a clear error TEXT and registers NO job on the board
- **delegations.log typing**: `task_id` was always `""` (now omitted when empty) and `duration_ms` was logged as a STRING (now parsed to a number, null when unset), breaking downstream aggregation
- **Idle-flush log duplication**: `flushIdleReminders` echoed the reminder body joined with `" | "` while chat.message delivery echoed the same body with `"\n"` — the identical line appeared twice; idle-flush is now an audit summary (count + aggregated line count), content logged exactly once at chat-reminder delivery
- **TUI console log pollution**: console output in the plugin/hooks rendered directly into the opencode TUI; now env-gated, log-file only by default

### Tests

- No aggregate test result was recorded in the original 1.3.4 release notes; the factual test counts that were documented remain attached to their individual changes above.


## [v1.3.3] - 2026-08-11

## 🆕 What's New

- **Todo continuation enforcer**: auto-continues sessions with incomplete todos on `session.idle` (4 guards: board-running, in-flight, exponential cooldown, max-failures cap) + kill-switch `PANTHEON_TODO_ENFORCER=off`
- **Hashline hash-anchored edits**: `hashline_edit` tool with sha256-truncated line tags, additive read enhancer, validate-before-write with `>>>` mismatch hints + Did-you-mean suggestions; blocked in read-only sessions
- **Full-auto goal loop** (opt-in `full_auto.enabled: false`): `pantheon_goal_create/update/get` tools, atomic GoalStore, priority idle dispatcher (goal suppresses enforcer), max 25 continuations
- **Dispatch retry-on-empty**: classifies empty results (mode 1: 0 tokens; mode 2: reasoning without text) with cap-1 automatic retry
- **Cost tracking**: JSONL ledger + `pantheon_cost` command reading opencode.db (zero-dep, node:sqlite → scripts/cost.mjs fallback)
- **Themis phase reviews** route to deepseek-v4-flash (pro reserved for final release gate); Athena stays premium (council red-line)
- **Routing config**: `background_delegation`, `todo_enforcer`, `hashline`, `full_auto` sections

## 🐞 Fixed

- **Delegation killer**: chat.message hook injected reminders with empty messageID on the subagent promptAsync path — opencode schema rejected it, killing every background delegation in ~20ms (found by live E2E smoke)
- **Delegation child model routing**: child sessions now inherit the routed model (explicit arg → routing.yml agent entry → active preset) instead of falling back to the key-gated default (E2E: AI_LoadAPIKeyError without an active preset)
- **Installer `resolveInstalledPlugin`** mapped only `src/plugins/*` — `src/plugin.ts` resolved to the dev path, breaking global installs on non-dev machines and leaking the dev path (release-blocking)
- **Todo enforcer invasiveness**: skips injection when native background children are active (`session.children`) and within 30s of user activity
- **Hashline**: atomic write (tmp+rename), path containment guard, documented seed separator

## [v1.3.2] - 2026-08-09

## 🆕 What's New

- **Sandbox validation**: added the `sandbox` doctor profile and regression coverage for npm tarball contents, installed hook resolution, doctor status handling, MCP runtime smoke checks, and related CLI/install contracts.
- **Package portability**: distributed configuration no longer retains checkout-specific machine paths; managed hooks are resolved from the installed package during install/sync.
- **Doctor contract**: exit statuses now distinguish success (`0`), advisory warnings (`1`), and blocking errors (`>=2`).

## 🐞 Fixed

- **Global installation diagnostics**: clarified the distinction between advisory doctor warnings and blocking failures.

[v1.3.2]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.3.2

## [v1.3.1] - 2026-08-08

## 🆕 What's New

- **Release validation coverage**: hook-runner spawn/timeout/SIGKILL handling with process-group cleanup; scanner fixtures that avoid accidental false positives; doctor `global`, `lite`, and `sandbox` profiles with explicit PASS/WARN/ERROR/SKIP statuses; `run-test.sh` exit semantics; and sandbox validation coverage.
- Local validation logs are ignored via `logs/` because they are generated diagnostics, not release artifacts or source files.

## [v1.3.0] - 2026-08-06

## 🆕 What's New

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

## 🐞 Fixed

- Council toast idle-flush race condition

## [v1.2.2] - 2026-08-05

## 🆕 What's New

- **`pantheon prune`** (#22): legacy cleanup command — XDG-aware config resolution, `--dry-run` default (list only), `--apply` removes stale `opencode.json.bak*` backups (age threshold), `--apply --remove-dirs` for legacy dirs with dead configs; old global `pantheon` installs are suggested for manual `npm uninstall -g pantheon`, never removed (npm-managed)
- **Release pipeline standardization** (PR #28): single source of truth for version in `scripts/versioning.mjs` (sem-tag aware); CHANGELOG repair (normalized broken `[5.0.0]` heading → `[1.0.0]`, stripped `[v` prefixes across 3.x history, added `[Unreleased]`); `release.yml` redesigned with idempotent gates (skips publish when version already exists); new `scripts/changelog-extract.mjs` and `scripts/version-check.mjs` (+ test suites) so release bodies use real changelog sections; commitlint extended to cover pushes; pre-commit gate added; `cliff.toml` (git-cliff) removed; `docs/RELEASING.md` added; ADR-0007
- **Test wiring + install docs** (PR #31): `test:security` extended with `test_doctor_layers`; Node test suite wired via `npm run test:node` (`node --test tests/*.mjs` — prune, hook-runner, plugin-log-policy, install/vision contracts, changelog/version checks) into CI; global-install sandbox documented in AGENTS.md / INSTALLATION.md
- Dead `src/mcp/requirements-mcp-core.txt` catalog duplicate (YAGNI — the installer uses `requirements-mcp.txt`)

## 🐞 Fixed

- **Reliable global install** (PR #26): hooks plugin recreated (`pantheon-hooks.ts` + `hook-runner.ts` with stdin JSON protocol, version-proof); MCP install made hermetic (absolute paths); packaging fix (`files[]` += `src/plugins/**`, `scripts/hooks/**`, self-reference removed, pinned `@opencode-ai/plugin` 1.18.11); `import uuid` hotfix in `scripts/mcp_persistence_server.py`
- **Installer/plugin packaging paths** (PR #31): hooks plugin registered via `resolveInstalledPlugin` so the config points at the INSTALLED package path, never the developer's absolute path (#30); TUI registered with absolute dist path in `tui.json` (#32 — relative path caused NpmInstallFailedError); TUI reads its installed package version via `import.meta.url` (works from any cwd)
- **Idempotent init** (#19): `subagent_depth` merged into the always-run config merge — run #1 already produces the final config (previously only the SECOND init added it); honest re-run stats (`routing.yml` no longer counted as created every run)
- **Layered doctor** (#18): B.6 smoke JSON-RPC `initialize` + F venv/deps check with pinned requirements
- **Pinned MCP dependencies** (#21): exact pins in `src/mcp/requirements-*.txt` (`mcp==1.29.0`, `fastmcp==3.4.6`, `pyyaml==6.0.3`, `sqlite-vec==0.1.9`, `fastembed==0.8.0`, `httpx==0.28.1`) — reproducible venv installs
- **Silent hooks by default**: audit hooks no longer echo to the console on success (`PANTHEON_HOOKS_LOG=1` re-enables the debug echo; log FILES `sessions.log`/`delegations.log` continue to be written)

## [v1.2.1] - 2026-08-03

## 🆕 What's New

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

## 🐞 Fixed

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

## 🆕 What's New

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

## 🐞 Fixed

- Council fixes: UUID session isolation in context checkpoints, pre-compaction state save trigger, flash summary quality floor (<10 chars → fallback to Zeus), agents recall `context_get(slug, 'latest')` on startup
- CI: push triggers removed — validation workflows (CI, commitlint, CodeQL, hotfix, docs) now run on `pull_request` only, eliminating perma-pending duplicate checks

[v1.2.0]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.2.0

## [v1.0.0] - 2026-07-24

## 🆕 What's New

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

## 🆕 What's New

- New release system — beta releases from PR labels, stable from main push (auto-release and beta-release workflows unified)
- Interactive TUI mode for installer (Fases 1+2) — redesigned sidebar with context progress bar, live session data via events + API
- Session-scoped context checkpoints in persistence (index, stats, auto-purge, `delete_namespace`); fallback chains, auto CI retry (2x), token tracking
- Slash commands consolidated from 16 to 5; redundant model configs removed (agents inherit the default model)

## 🐞 Fixed

- Council: UUID session isolation in context checkpoints, pre-compaction state save, flash summary quality floor, agents recall `context_get(slug, 'latest')` on startup
- TUI plugin/CI: OpenCode crash from missing plugin deps, version detection with git fallback, commitlint scopes, workflow YAML/MCP path repairs; `datetime.UTC` → `timezone.utc` for Python < 3.11

[v1.1.1]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.1.1

## [v1.1.0] - 2026-07-26

## 🆕 What's New

- Council synthesis Fase 1+2 — Modo Desempate com Evidência + BackgroundJobBoard (#2)
- Beta release workflow added (from develop)

[v1.1.0]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.1.0

## [v1.0.7] - 2026-07-26

## 🐞 Fixed

- Installer: fixed `writeFileSync` not defined error

[v1.0.7]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.0.7

## [v1.0.6] - 2026-07-26

## 🆕 What's New

- 7 new skills (codemap, simplify, reflect, worktrees, verification-planning, loop-engineering, clonedeps) + 7 matching commands; `background_subagents` enabled by default in canonical config
- Release pipeline: quality gates, tag creation, pre-release, hotfix support
- CI simplified from 10 to 6 workflows; agent/skill restructuring — 12 redundant instructions removed, unused commands dropped, gaia archived then restored

## 🐞 Fixed

- CI/commitlint config (YAML syntax, header-max-length, ignores function, scopes); 45 stale references cleaned across 18 files; invalid `opencode.json` fields removed; installer copies `routing.yml`; YAML frontmatter regenerated for 9 agents

[v1.0.6]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.0.6

## [v1.0.5] - 2026-07-26

## 🐞 Fixed

- CI auto-release with OIDC trusted publisher + npm v12 (Node 22 upgrade, clean publish)
- `doctor.mjs` paths + simplified `prepublishOnly`

[v1.0.5]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.0.5

## [v1.0.2] - 2026-07-25

## 🆕 What's New

- TUI plugin: copy logic, stale skill cleanup, `tui.json` dedup; advanced plugin with version detection and 14 commands
- Agents migrated from deprecated `tools:` to OpenCode `permission:` model; legacy multi-platform tests removed (OpenCode-only conformance); docs modernized (OpenCode-only, unified commands)

## 🐞 Fixed

- Hardcoded version fallback replaced with package.json version; routing aligned with actual skills (vscode platform removed)

[v1.0.2]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.0.2

## [v1.0.1] - 2026-07-24

## 🆕 What's New

- Installer: unified setup flow, removed lifecycle install, fixed entry points

[v1.0.1]: https://github.com/ils15/pantheon-opencode/releases/tag/v1.0.1

## [v3.19.2] - 2026-07-21

## 🆕 What's New

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

## 🐞 Fixed

- 157 dangling instruction references across 6 platforms
- YAML frontmatter in all 14 agents (broken by previous sed edits)
- OpenCode platform detection (was missing `platform/opencode/opencode.json`)

## [v3.19.0] - 2026-07-21

## 🆕 What's New

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

## 🐞 Fixed

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

## 🆕 What's New

- Inline compression triggers (C8/C9/C11): implementation agents (Hermes, Aphrodite, Demeter, Hephaestus, Prometheus) now declare `context-compression` skill and have a concise `## Inline Compression` section covering CRITICAL/HIGH subtask summaries, pre-delegation large blocks, and phase boundaries/handoffs
- `tests/test_code_mode_args.py`: TDD coverage for the new `args` parameter forwarding
- `context-compression` SKILL.md: real C8–C11 trigger definitions added; redundant C10 noted as OpenCode-native cross-reference; L1/L3 contradiction resolved (L1 = inline compress via MCP, L2 = batch promotion at gates)
- Agent `.md` files: `context-compression` added to `skills:` frontmatter for all 5 implementation agents
- `instructions/artifact-protocol.instructions.md`: scrub documented as automatic via MCP layer

## 🐞 Fixed

- `execute_code_script` now forwards CLI arguments to subprocess — `compress-inline.py` is reachable via MCP (fixes argparse code 2 error)
- Unified scrubber: 3 divergent implementations consolidated into single canonical `scripts/scrub-secrets.py`, imported by both `memory_mcp_server.py` and `compress-inline.py` via `importlib` (hyphenated filename cannot be statically imported)
- OpenAI key regex standardized across all consumers to `sk-[A-Za-z0-9\-_]{10,}`

## [v3.17.0] - 2026-07-11

## 🆕 What's New

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

## 🐞 Fixed

- TUI plugin path in tui.json (was pointing to non-existent file)
- OpenCode MCP config format (command must be array + cwd)
- Release pipeline: version mismatch between package.json and plugin.json
- `mcp_resources_server.py` memory-bank path resolution

## [v3.16.0] - 2026-07-10

## 🆕 What's New

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

## 🐞 Fixed

- memory_sessions dead code (always returned empty results)
- install-mcp.mjs filename: dash → underscore
- .github/plugin/plugin.json: removed deleted streaming-patterns reference
- memory_mcp_server.py: F821 undefined name, missing except block

## [v3.15.0] - 2026-06-26

## 🆕 What's New

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

## 🐞 Fixed

- **Import Path in Vector Memory Scripts:** `sys.path` now correctly points to parent of `vector_memory/` package, enabling both direct execution and `python -m` usage

## [v3.14.1] - 2026-06-21

## 🆕 What's New

- **Pantheon-Context MCP Experiment:** Removed entire `scripts/pantheon-context-mcp/` directory (server.py, scoring.py, summarizer.py, tests — 12 files, ~1,200 lines)
- **Stale Agent References:** Stripped `pantheon-context` tool references from all 14 agent files, `.mcp.json`, `opencode.json`, `ROADMAP.md`
- **Auto-Release CI:** Removed `.github/workflows/auto-release.yml` (triggered broken v3.14.0 release on every push to main)
- **TUI Sidebar Plugin:** Rewrote from flat file to npm-style directory (`plugins/pantheon-tui/` with `index.tsx`, `package.json`, `dist/tui.tsx`). New features: real context usage bar (color thresholds 70%/90%), collapsible command guide (16 `/pantheon` commands), manual compress button, Python version display, collapsible agent registry

## 🐞 Fixed

- **Install Script:** `scripts/install/opencode.mjs` now correctly copies npm-style plugin directory and registers in `tui.json` (not `opencode.json` — TUI plugins use separate registration)
- **CI Release Pipeline:** Added `dry_run` input to manual release workflow, removed auto-merge from release PRs, fixed duplicate steps

## [v3.14.0] - 2026-06-20

## 🆕 What's New

- **Codebase Audit:** Comprehensive 5-agent scan — 48 issues found, all resolved
- **Mermaid Diagrams:** 5 new diagrams — TDD Cycle (stateDiagram-v2), Artifact Lifecycle (flowchart), Council Synthesis (sequenceDiagram), Architecture (flowchart), Delegation Flow (flowchart)
- **Python Infrastructure:** Added `[build-system]`, project deps (FastAPI 0.110+, SQLAlchemy 2.0+, Alembic 1.13+, Pydantic 2.7+), ruff expanded to 11 rule groups, coverage (`fail_under=80`), mypy strict
- **Alembic Scaffolding:** `alembic.ini` with env var interpolation, async `env.py`, Mako template, models base with `AsyncAttrs` + `TimestampMixin`
- **SQLAlchemy 2.0 Mixins:** `UUIDPrimaryKeyMixin`, `IntegerPrimaryKeyMixin`, `SoftDeleteMixin`, `ActivatableMixin`
- **Frontend Scaffolding:** `biome.json` (1.9.4), `tsconfig.json` (strict mode, ES2022), npm scripts (test, lint, typecheck, build, dev)
- **Docker Infrastructure:** Multi-stage Dockerfile (build + runtime, non-root), docker-compose.yml (PostgreSQL 16 + API), `.env.example`
- **Database Standards:** Async SQLAlchemy 2.0 patterns, connection pooling, migration testing, disaster recovery + 2 Mermaid diagrams
- **Documentation Quality:** "When NOT to Use" sections on all 7 main agents, English-only throughout, ROADMAP.md updated

## 🐞 Fixed

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

## 🆕 What's New

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

## 🐞 Fixed

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

## 🆕 What's New

- **agents:** Add anti-stall resilience and orchestration improvements ([7a61b69](https://github.com/ils15/pantheon/commit/7a61b69))
- **agents:** Add /pantheon-status command with version badge + agent registry ([984ec65](https://github.com/ils15/pantheon/commit/984ec65))
- **platform:** Add Pantheon TUI sidebar plugin for OpenCode ([09253c1](https://github.com/ils15/pantheon/commit/09253c1))
- **release:** Sync version to v3.11.0 ([1a9fb64](https://github.com/ils15/pantheon/commit/1a9fb64))

## 🐞 Fixed

- **ci:** Sync platform files and add mcp-security skill to pass CI ([a27a245](https://github.com/ils15/pantheon/commit/a27a245))

## [v3.9.0] - 2026-05-28

[compare changes](https://github.com/ils15/pantheon/compare/v3.8.4...v3.9.0)

## 🆕 What's New

- Setup changelogen + git-cliff for auto-releases ([ce4ee22](https://github.com/ils15/pantheon/commit/ce4ee22))
- Cleanup commands, fix subtask agent, add Context7 tools, improve sync script ([da6ed7c](https://github.com/ils15/pantheon/commit/da6ed7c))

## 🐞 Fixed

- Add missing closing brace for github configuration in opencode.json ([a63c522](https://github.com/ils15/pantheon/commit/a63c522))
- Address PR review sync and mapping feedback ([c550049](https://github.com/ils15/pantheon/commit/c550049))
- Sync version to 3.8.4, fix versioning.mjs apply bug, add version check script ([141a6b1](https://github.com/ils15/pantheon/commit/141a6b1))
- Add CHANGELOG entry for v3.8.4 to fix CI validate failure ([58cc0f5](https://github.com/ils15/pantheon/commit/58cc0f5))
- **ci:** Auto-release cria PR com auto-merge ao invés de push direto pra main ([e4f78c9](https://github.com/ils15/pantheon/commit/e4f78c9))

[v3.19.0]: https://github.com/ils15/pantheon/compare/v3.18.0...v3.19.0
