# OpenCode V2

OpenCode 2 gets the Pantheon **V2 plugin**: host-native tools, V2 hooks, and a
native TUI surface. This page covers what a user sees. The plugin contract,
tool-by-tool registration, and the delegation matrix are in
[Architecture](ARCHITECTURE.md); supported hosts and evidence are in
[Compatibility](COMPATIBILITY.md).

## Generation detection

The installer selects one generation per installation. `auto` is the default
and reads the host; `--opencode-version v1|v2|auto` overrides it. The resolution
order and the exact fallback behavior live in
[Compatibility](COMPATIBILITY.md#how-the-generation-is-selected). V1 and V2
plugins are never registered together.

## Tools on V2

The V2 plugin registers tools through `ctx.tool.transform()`, not through the V1
plugin path. The exact list per generation, with source locators, is in
[Architecture](ARCHITECTURE.md#what-each-generation-registers). In user terms:

- `hashline_edit` edits files by line-tag anchors instead of raw line numbers.
- `pantheon_cost` reports tokens and USD by agent, model, and session.
- `pantheon_model` shows, sets, or resets per-agent project-scoped model
  overrides.
- `vision_describe` appears when the host exposes its model catalog.
- `pantheon_bounded_read` appears when the host exposes its permission and
  session APIs, and only in a root Zeus session.

The three legacy goal tools are not registered on V2. Use the Persistence MCP
`goal_*` tools for durable manual goals; see [Memory](MEMORY.md#manual-session-goals).

## Per-agent MCP permissions

The installer reads each agent's `mcp_tools` allowlist and generates native
per-agent permissions for both generations. On OpenCode 2.x the host evaluates a
`permissions` rule whose action is `<server>_*` (or `<server>_<tool>`) with
effect `deny`/`allow`. The V1-shaped `permission.mcp.<server>` key is not an
action the host evaluates; the installer translates `allow`/`deny` into the
former. `ask` is not expressible for MCP on that host — it hides the tool
instead of prompting, so the installer emits no rule and warns.

Deny-by-default, the entrypoints, and custom-server setup are in [MCP](MCP.md).

## Dispatch sidebar block

The native V2 sidebar shows the Pantheon version, active preset/source, git
state, a `Context` block with thousands-separated tokens and `<percent>% used of
<window>` (blue ≤25%, green ≤50%, yellow ≤90%, red above), `$<spent> spent`, and
a muted `cache <n>% · <n.n> tok/s` line.

One aggregated `Dispatch` block covers the whole child set:

- header `◈ Dispatch · <n> rodando · $<cost>`, summing every child, live and
  finished;
- one row per live child (`⠸ <agent>·<kind> $<cost> <duration>`, newest first,
  three then `… +N rodando`);
- finished children rolled up per agent: `✓ <total> · $<sum> · <M> agentes`
  (plus `· <F> falhas` when any child failed), up to three
  `<agent> ×<count>·<kind>  $<sum>` rows and `… +K  $<sum>` beyond — never one
  row per session.

The `·<kind>` suffix says why the child exists: `coun`/`plan`/`revw`/`hot`/
`disc` from an explicit `[council]`/`[plan]`/`[review]`/`[hotfix]`/`[discovery]`
prefix on the `subagent` description, otherwise from the agent
(`athena`→plan, `themis`→revw, `talos`→hot, `apollo`→disc, anything else→`oth`).
`council` is never inferred from an agent. A `~` after the kind marks a
background child.

The block stays within eight lines and is omitted entirely when the session has
no child. It is added with `append` claims: the native prompt footer keeps its
own line, and Pantheon only appends `▸<preset> · ✦<n> ativos` while delegations
are running.

<!-- media: opencode-v2-dispatch-sidebar
     alt: "Pantheon V2 sidebar with the aggregated Dispatch block: two live child rows and a finished roll-up"
     source: docs/assets/tui/v2-sidebar.gif (recorded from docs/assets/tui/v2-sidebar.tape)
     status: pending — no image committed; the fenced sketch below is illustrative
-->

<!-- illustrative, not a screenshot; real capture pending -->

```text
Pantheon v1.6.0
▸ teampro · anthropic
Sessão: MCP permission audit

▤ Context
142.6K tokens
▰▰▰▰▰▰▰▰▱▱▱▱ 71% of 200K
$4.12 spent
cache 92% · 42.3 tok/s

◈ Dispatch · 2 rodando · $3.49
⠸ prometheus·plan $0.09 14m34s
⠸ apollo·disc $0.03 1m12s
✓ 70 · $3.40 · 9 agentes
prometheus   × 12·plan   $1.20
hermes       × 31        $1.44
athena       ×  9·plan   $0.76
```

*Illustrative layout — not a screenshot.* Live children lead the block; finished
children collapse into one roll-up per agent, never one row per session.

*OpenCode 2.x · pantheon-opencode 1.6.0*

## `/dispatch` panel

`/dispatch` (also in the palette as *Pantheon: Dispatch*) opens
`pantheon.dispatch` in the host's `session.panel` slot: a full-width view of the
same delegation tree, rendered from the same collector as the sidebar block, so
a child is never listed twice.

The header is `◈ Dispatch — <session>` (+ `[fullscreen]`) with counters for the
whole tree (`2 rodando · 70 concluídos · 1 falha · $3.59`; a zero counter is
omitted) over one row per child — `⠋ prometheus   plan   $0.09  14m34s` — running
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
Pantheon toasts `Abra uma sessão para ver o Dispatch` instead of inventing a
route. Jumping from a row to the child session is a documented TODO: no
`session` router destination is verified for a child id.

<!-- media: opencode-v2-dispatch-panel
     alt: "Full-width /dispatch panel mid-run: child list, tree counters and the selected child's detail pane"
     source: docs/assets/tui/dispatch-panel.gif (recorded from docs/assets/tui/dispatch-panel.tape)
     status: pending — no image committed; the fenced sketch below is illustrative
-->

<!-- illustrative, not a screenshot; real capture pending -->

```text
◈ Dispatch — MCP permission audit
2 rodando · 70 concluídos · 1 falha · $3.59
──────────────────────────────────────────────────────────────────────
▸ ⠋ prometheus   plan   $0.09  14m34s    MCP permission audit
  ✓ hermes       oth    $0.44   2m10s    ses_ab12cd · anthropic/claude-sonnet-4.5
  ✓ apollo       disc   $0.12   1m02s    in 12.4K · out 430 · r 120 · cache 8.0K/1.0K
  ✗ athena       plan   $0.01     48s    kind plan (prefixo) · parent ses_9f31aa
  ✓ zeus         plan   $0.07   3m21s
  ✓ demeter      oth    $0.05   1m45s

1-10 de 71 · k/up j/down mover · enter detalhe · f fullscreen · escape/q fechar
```

*Illustrative layout — not a screenshot.* Above 72 columns the detail sits beside
the list; narrower panels stack it underneath and truncate per column.

*OpenCode 2.x · pantheon-opencode 1.6.0*

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

*OpenCode 2.x · pantheon-opencode 1.6.0*

## Context pruning

The V2 `compaction` hook performs dynamic context pruning on the
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

The array is mutated in place: no message is deleted or reordered, `system` is
untouched, and an unexpected shape fails open without throwing. The same engine
is available per request only when the V2 plugin entry sets
`options.context_pruner.enabled` to `true` (default `false`), because
per-request pruning invalidates the provider prompt cache. `keepTurns`,
`purgeAfterTurns`, `protectedTools`, `minSavingsTokens`, and `charsPerToken`
tune it.

## Memory injection

`pantheon-memory` is pull-only: an agent recalls an entry only when it calls
`memory_search`. An install can instead have the most relevant entries ride
along on the first request. It is opt-in and off by default:

```json
{
  "plugins": [
    { "package": "<installed>/src/plugin-v2", "options": { "memory_injection": { "enabled": true } } }
  ]
}
```

The payload is computed once per session, bounded by `maxEntries` and
`maxChars`, and re-added verbatim with a marker so the system prompt grows once,
not per request. Every failure injects nothing and never throws. The full
selection, ranking, failure, and logging rules are in
[Memory](MEMORY.md#ambient-injection-on-v2-opt-in-default-off).

## Session goals

Durable manual goals are Persistence MCP tools, not V2 plugin tools:
`goal_create`, `goal_get`, `goal_update`, and `goal_done`. They are granted only
to Zeus, partitioned by OpenCode session id, and never continue a session
automatically. See [Memory](MEMORY.md#manual-session-goals).

## Task-result guard

The V2 `execute.after` chain runs `task-result-guard` → `context-sandbox` →
`read-enhancer`. The guard intercepts native child-session dispatch where the
child returns an empty or missing result. Instead of surfacing a silent
`completed` with no payload, it raises an explicit error. This catches the
common free-tier failure mode where a child exceeds the uncached-prefill token
budget and returns nothing.

Background dispatch and status/fan-in facilities are runtime-dependent. When no
status tool is visible, use synchronous `subagent` dispatch or wait for a
host-provided completion notification; do not claim deterministic fan-in or job
recovery without an exposed, verified mechanism.

## Unsupported V2 features

The V2 plugin reports these gaps through `getUnsupportedFeatures()`:

- Adapter scope choices: `legacy-hooks` (the V1-specific hook surface),
  `catalog-transform`, `integration-transform`, `skill-transform`,
  `goal-tools` (the goal loop needs V1 infrastructure the V2 context does not
  expose).
- Host-domain gaps: `idle-todo-enforcer` (the enforcer is constructed only when
  the host's `session` domain exposes `todo`/`messages`/`children`/`promptAsync`;
  the measured 2.x domain does not), `tool-ceiling` (no
  `message.updated` producer for the host-reported budget, so the
  `<tool_ceiling>` block is not injected), `todo-restore` (no todo API to
  snapshot across compaction), and `board-transitions` (the shared board is
  reachable through the injected bridge, but the writers — terminal audit,
  idle reports, dispatch mirror — live in V1's event hook and
  `pantheon-hooks.ts`).

Everything else the V1 plugin wires is on V2: the Zeus read guard, the
compaction context, vision history sanitization, the post-write formatter, and
the delegation audit trail (start/stop records joined on `delegation_id`).
Idle dispatch is wired but **conditional** — it reaches an enforcer only where
`idle-todo-enforcer` is not in the seed, which is why that marker is listed
above. `pantheon_bounded_read` applies the same code-root restriction as the
read guard: `src/`, `tests/` and `scripts/` are refused; docs, config, the
memory bank and `.pantheon/` remain readable. If bridge construction fails, the
plugin keeps running without one and appends the runtime marker `v1-bridge`.
