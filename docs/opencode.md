# OpenCode 2.x

OpenCode 2 gets the Pantheon **plugin**: host-native tools, hooks, and a
native TUI surface. This page covers what a user sees. The plugin contract,
tool-by-tool registration, and the delegation matrix are in
[Architecture](ARCHITECTURE.md); supported hosts and evidence are in
[Compatibility](COMPATIBILITY.md).

## The host gate

The installer must confirm the host is OpenCode 2.x before writing. There is
no generation to select and no fallback: `OPENCODE_VERSION=v2` pins the
answer, an `OPENCODE_BIN` basename of `opencode2` is an explicit operator
hint, and otherwise a `--version` probe decides. A confirmed 1.x host, a
failed probe, or an unreadable version is a hard refusal before any write.
The resolution order and the exact refusal behavior live in
[Compatibility](COMPATIBILITY.md#the-host-gate). One plugin is registered; a
host never loads two Pantheon plugins.

## Tools

The plugin registers **30 native TypeScript tools** through `ctx.tool.transform()`
with zero external Python dependency, automatically available in any workspace via
`opencode plugin add pantheon-opencode` (check the live inventory in `/pantheon-settings`
→ **About**):

- **Memory, context, federation & goals:** `memory_store`, `memory_recall`, `memory_search`,
  `memory_forget`, `memory_list`, `memory_stats`, `context_save`, `context_get`, `goal_create`,
  `goal_get`, `goal_update`, and `goal_done` — FTS5-backed persistence under `.pantheon/`
  that automatically shares the main repository root across linked git worktrees
  (override with `PANTHEON_ISOLATE_WORKTREE_MEMORY=1`), plus optional read-only multi-repo
  federation (`PANTHEON_FEDERATED_REPOS` / `~/.pantheon/federation.json`). `goal_update` uses `notes`
  to append progress entries.
- **Structural codemap & AST rewriting:** `code_index`, `code_query`, `code_neighbors`,
  `ast_search`, and `ast_rewrite` — symbol/relation graph with automatic orphan pruning
  plus comment-aware AST matching/rewriting (`$VAR` / `$$$ARGS`) confined to workspace bounds.
- **Mechanical gates, atomic steps & agent forge:** `pantheon_step_ledger` (`init_step`,
  `record_reproduction`, `record_mutation`, `record_verification`, `rollback_step`,
  `complete_step`, `status` with isolated temp-index git checkpoints and bugfix `RED` gates,
  plus `dependsOn` prerequisites — see [Step dependencies](#step-dependencies-and-readiness)),
  `pantheon_review_verdict` (typed `@themis` verdict + bounded `ctx.session.synthetic` remediation),
  `pantheon_deepwork`, `pantheon_agent_forge` (including `detect_stack`), and `pantheon_skill_search`.
- **Editing, LSP diagnostics, telemetry & routing:** `hashline_edit` (workspace-confined
  relative paths + post-edit TypeScript/Pyright/stdio + pooled TCP LSP proxy via `PANTHEON_LSP_TCP_ENDPOINTS`),
  `shell`, `todowrite`/`todoread`, `pantheon_cost`, `pantheon_model`, and `pantheon_local_decision` (Zeus-only advisory selector).
- **Native worktree orchestration & commands:** `ctx.worktree.transform` (`create`, `remove`,
  `list`) in `.pantheon-worktrees/<repo>/<task>`, plus **9 slash commands** including
  `/pantheon-forge` and `/pantheon-cockpit`.
- **Host-conditional tools:** `vision_describe` when the host exposes its model catalog,
  and `pantheon_bounded_read` when the host exposes its permission and session APIs
  (root Zeus sessions only).

## Step dependencies and readiness

A step may declare prerequisites with `dependsOn`:

```json
{
  "action": "init_step",
  "stepKey": "b-tests",
  "objective": "Add the ledger dependency tests",
  "agent": "hermes",
  "dependsOn": ["a-schema"]
}
```

- **Validation is mechanical.** Unknown keys (`dependency_not_found`, naming every
  offending key), self-dependencies (`self_dependency`), and cycles
  (`cycle_detected` with the canonical path, e.g. `a -> c -> b -> a`) are refused;
  duplicates are deduped. A dangling dependency is never silently dropped.
- **States.** `init_step` stores `pending` when any dependency is not `done`, and
  `in_progress` otherwise — so steps without `dependsOn` behave exactly as before.
  A `pending` step becomes `in_progress` when `execute_step`/`spawn_ephemeral`
  launches it.
- **Readiness.** `ready(k) = state(k) === 'pending' && dependsOn(k).length > 0 &&
  every dependency is done`. Completing the last dependency emits `step:unlocked`
  for each newly-ready dependent, and `status` returns
  `graph: { waves, cycles, ready, unmet, dangling }` — `waves` are the parallel
  launch levels (`[[a], [b, c]]` for two independent branches).
- **Refusals.** `execute_step`/`spawn_ephemeral` refuse with `dependencies_unmet`
  (`unmet: [...]`) or `step_blocked` (`blockedBy`) and create no sub-session.
- **Rollback cascade.** `rollback_step` refuses (`dependents_done`) while a
  transitive dependent is `done`. `cascade: true` blocks dependents with
  `blockedBy` + an explicit `cascadeReason`, emits `step:blocked`, and returns the
  invalidated `receiptId`s. The reflex-escalation path applies the same cascade.
- **Concurrency.** The ledger is a single JSON file, so every mutation goes through
  `updateStepLedger`: lock file `.pantheon/ledger/.step-ledger.lock`
  (`open(..., 'wx')`, 20 × 25 ms retry, stale-break after 10 s) plus a
  per-process `*.tmp.<pid>` file and `renameSync`. Parallel waves never overwrite
  each other's entries.

## Per-agent MCP permissions

The installer reads each agent's `mcp_tools` allowlist and generates native
per-agent permissions. On OpenCode 2.x the host evaluates a
`permissions` rule whose action is `<server>_*` (or `<server>_<tool>`) with
effect `deny`/`allow`. The legacy `permission.mcp.<server>` key is not an
action the host evaluates; the installer translates `allow`/`deny` into the
former. `ask` is not expressible for MCP on that host — it hides the tool
instead of prompting, so the installer emits no rule and warns.

An existing native `permissions` array remains authoritative. The installer
does not append its legacy default grants to that array; it seeds those defaults
only when the config has no native `permissions` array yet.

Deny-by-default, the entrypoints, and custom-server setup are in [MCP](MCP.md).

## Dispatch sidebar block

The native sidebar shows the Pantheon version, active preset/source, git
state, a `Context` block with thousands-separated tokens and `<percent>% used of
<window>` (blue ≤25%, green ≤50%, yellow ≤90%, red above), `$<spent> spent`, and
a muted `cache <n>% · <n.n> tok/s` line.

One aggregated `Dispatch` block covers the whole child set:

- header `◈ Dispatch · <n> rodando · $<cost>`, summing every child, live and
  finished;
- one row per live child (`⠸ <agent>·<kind>[·<verb>][?|!] $<cost> <duration>`,
  newest first, three then `… +N rodando`), surfacing real-time activity verbs
  (`edit`, `code`, `bash`, `ask`, `err`) and attention badges (`?` waiting for
  permission/question, `!` error);
- finished children rolled up per agent: `✓ <total> · $<sum> · <M> agentes`
  (plus `· <F> falhas` when any child failed), up to three
  `<agent> ×<count>·<kind>  $<sum>` rows and `… +K  $<sum>` beyond — never one
  row per session.

The `·<kind>` suffix says why the child exists: `coun`/`plan`/`revw`/`eph`/`swm`/
`disc` from an explicit `[council]`/`[plan]`/`[review]`/`[ephemeral]`/`[swarm]`/`[discovery]`
prefix on the `subagent` description, otherwise from the agent
(`athena`→plan, `themis`→revw, `apollo`→disc, anything else→`oth`).
`council` is never inferred from an agent. A `~` after the kind marks a
background child.

The block stays within eight lines and is omitted entirely when the session has
no child. It is added with `append` claims: the native prompt footer keeps its
own line, and Pantheon only appends `▸<preset> · ✦<n> ativos` while delegations
are running.

![Pantheon sidebar with the aggregated Dispatch block](assets/tui/session-sidebar.png)

*OpenCode 2.3.2 · pantheon-opencode 2.2.0 — live session capture (`Dispatch` roll-up per agent, token telemetry, and git status).*

## `/dispatch` panel

`/dispatch` (also in the palette as *Pantheon: Dispatch*) opens
`pantheon.dispatch` in the host's `session.panel` slot: a full-width view of the
same delegation tree, rendered from the same collector as the sidebar block, so
a child is never listed twice.

The header is `◈ Dispatch — <session>` (+ `[fullscreen]`) with counters for the
whole tree (`2 rodando · 70 concluídos · 1 falha · $3.59`; a zero counter is
omitted) over one row per child — `⠋ hermes     plan   $0.09  14m34s` — running
first, then most recent activity, with `✓`/`✗`/`○`/`?` for
completed/failed/interrupted/unknown. The detail pane shows the selected child's
title or spawning description, short id, model, in/out/reasoning/cache tokens,
kind evidence, and parent id; `—` means the host did not publish it.

Panels at least 72 columns put the detail beside the list; narrower ones stack
it under the list and truncate per column. Keys are namespaced and bound
(`k`/`up`, `j`/`down`, `home`, `end`, `pageup`, `pagedown`, `enter`, `f`,
`escape`/`q`) and live inside the panel claim, so they stay inert while the
panel is not focused. The list is paged at ten rows and selection is held by
session id.

The panel reads only host-cached state — no session sync, no child
`message.list`, no HTTP — and its 80 ms spinner tick exists only while the panel
is open with something running. Opening it requires an open session; otherwise
Pantheon toasts `Open a session to view Dispatch` instead of inventing a
route. Jumping from a row to the child session is a documented TODO: no
`session` router destination is verified for a child id.

![Full-width /dispatch panel showing child tree and detail pane](assets/tui/dispatch-panel.png)

*OpenCode 2.3.2 · pantheon-opencode 2.2.0 — live `[fullscreen]` `/dispatch` panel capture.*

## Plan before approval

When you ask for a plan or start `/pantheon-deepwork`, Athena returns the full
plan to Zeus, who displays it in the main conversation before asking for
approval. The approval prompt never points to a plan hidden in a child agent's
conversation.

<!-- media: opencode-v2-plan-approval
     alt: "Plan-approval turn: the full plan rendered in the main conversation above the approval question"
     source: docs/assets/tui/plan-approval.gif (recorded from docs/assets/tui/plan-approval.tape)
     status: pending — no image committed; the fenced sketch below is illustrative
-->

<!-- illustrative, not a screenshot; real capture pending -->

```text
Zeus · teampro

  ## Plan: MCP permission audit

  1. Read every agent allowlist in src/agents/*.md
  2. Compare it with the `permissions` rules pantheon-init emits
  3. Report drift and update docs/MCP.md where a rule is undocumented
  4. Verify with npm run test:node and npm run docs:lint

  Files: docs/MCP.md, src/agents/*.md, scripts/install/*.mjs
  Risks: an `ask` rule cannot be expressed for MCP on this host

  Approve this plan? (yes / no)
```

*Illustrative layout — not a screenshot.* The plan is printed in the main
conversation before the question, so approval never refers to a child's view.

*OpenCode 2.x · pantheon-opencode 2.2.0*

## Context pruning

The `compaction` hook performs dynamic context pruning on the
provider-bound message array immediately before summarization, so old tool
output is not re-summarized into permanent context.

- It rewrites tool parts only.
- An invocation repeated with the same tool name and normalized arguments keeps
  its most recent result verbatim; every earlier successful body becomes a
  `[pantheon-prune:v1 …]` placeholder.
- Error results are never rewritten. A group is pruned only when its newest
  invocation carries a successful result.
- Arguments of failed calls are blanked after two turns while the error text
  stays visible.
- The last four turns and a protected tool list (`subagent`, `task`, `skill`)
  are never touched.
- The marker makes a second pass a no-op, and a pass estimated below 200 tokens
  does nothing.

The hook log records savings for changed passes and the first occurrence of
each fixed no-op reason (`no-candidates` or `below-threshold`) per session and
hook site. These entries contain counts and estimated tokens only; tool content
and arguments are not logged.

The array is mutated in place: no message is deleted or reordered, `system` is
untouched, and an unexpected shape fails open without throwing. The same engine
is available per request only when the plugin entry sets
`options.context_pruner.enabled` to `true` (default `false`), because
per-request pruning invalidates the provider prompt cache. `keepTurns`,
`purgeAfterTurns`, `protectedTools`, `minSavingsTokens`, and `charsPerToken`
tune it.

`init` writes the entry in its object form (`{ "package": …, "options": { … } }`),
so there is a place to put that key without guessing the syntax — a bare-string
entry leaves the host with no options at all. The context-pruner option and
default are listed in the README's *Plugin options* table. Memory retrieval
uses the `pantheon-memory` MCP only when an agent explicitly calls
`memory_search`; see [Memory](MEMORY.md#recall-and-compaction-policy).

## Session goals

Durable manual goals are registered as native plugin tools (`goal_create`, `goal_get`,
`goal_update`, and `goal_done`), backed by the shared `.pantheon/` store across
worktrees. They are granted to Zeus, scoped cleanly, and never continue a session
automatically. See [Memory](MEMORY.md#manual-session-goals).

## Task-result guard

The `execute.after` chain runs `task-result-guard` → `context-sandbox` →
`read-enhancer`. The guard intercepts native child-session dispatch where the
child returns an empty or missing result. Instead of surfacing a silent
`completed` with no payload, it raises an explicit error. This catches the
common free-tier failure mode where a child exceeds the uncached-prefill token
budget and returns nothing.

Background dispatch and status/fan-in facilities are runtime-dependent. When no
status tool is visible, use synchronous `subagent` dispatch or wait for a
host-provided completion notification; do not claim deterministic fan-in or job
recovery without an exposed, verified mechanism.

## Unsupported features

The plugin reports these gaps through `getUnsupportedFeatures()` (the seed in
`src/pantheon/unsupported.mjs`):

- Adapter scope choices: `legacy-hooks` (the hook surface of the removed V1
  plugin line), `catalog-transform`, `integration-transform`,
  `skill-transform`, `goal-tools` (the goal loop needs infrastructure the
  host's plugin context does not expose).
- Host-domain gaps: `idle-todo-enforcer` (the enforcer is constructed only when
  the host's `session` domain exposes `todo`/`messages`/`children`/`promptAsync`;
  the measured 2.x domain does not), `tool-ceiling` (no
  `message.updated` producer for the host-reported budget, so the
  `<tool_ceiling>` block is not injected), `todo-restore` (no todo API to
  snapshot across compaction), and `board-transitions` (the shared board is
  reachable through the injected board, but the writers — terminal audit,
  idle reports, dispatch mirror — lived in the removed generation's event hook
  and `pantheon-hooks.ts`).

Everything else the removed generation wired is here: the Zeus read guard, the
compaction context, vision history sanitization, the post-write formatter, and
the delegation audit trail (start/stop records joined on `delegation_id`).
Idle dispatch is wired but **conditional** — it reaches an enforcer only where
`idle-todo-enforcer` is not in the seed, which is why that marker is listed
above. `pantheon_bounded_read` applies the same code-root restriction as the
read guard: `src/`, `tests/` and `scripts/` are refused; docs, config, the
memory bank and `.pantheon/` remain readable.
