# TUI Mission Control Cockpit — Design Specification (v2.2.0)

This document specifies the architecture, visual design, and implementation plan for the **High-Density TUI Mission Control Cockpit**, scheduled as the cornerstone deliverable for Pantheon `v2.2.0`.

---

## 1. Vision & Motivation

Pantheon is a multi-agent orchestration framework where `@zeus` dispatches specialized domain agents (`@athena`, `@hermes`, `@demeter`, `@aphrodite`, `@themis`). As orchestrations scale across tens of turns and millions of tokens, developers face critical visibility gaps:

1. **Token Velocity & Cost Predictability**: Developers need real-time awareness of context gauge saturation, token burn rate, cache hit efficiency, and per-turn incremental cost.
2. **Subagent Concurrency & Hierarchy**: Traditional linear stdout obscures multi-agent delegation. Developers cannot easily see which agents run in parallel, which are stalled, or who called what tool.
3. **MCP Health & Reliability**: Out-of-band MCP failures (such as server timeouts or crashed stdio bridges) should be visible immediately rather than diagnosed after turn failures.
4. **Governance & Gate Transparency**: Safety checks, TDD status (`RED` → `GREEN`), and decision approvals (`Jev` / human-in-the-loop) must be tracked visibly in a unified dashboard.

The Mission Control Cockpit solves these challenges with a 3-tab terminal UI built on **Ink** (React for CLI), optimized for high information density, low latency, and zero terminal flicker.

---

## 2. Three-Page Cockpit Architecture

The Cockpit is organized into three specialized pages navigable via `Tab` / `Shift+Tab` or direct numeric keys (`1`, `2`, `3`).

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Demo · CSV export with tests                          ● active      15:59:39 │
│ coder · claude-opus-5-5 high · /home/demo/projects/csv-export   s session ? help │
├──────────────────────────────────────────────────────────────────────────────┤
│ [1 Overview]               [2 Swarm]                  [3 Flightdeck]         │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

### Page 1: `Overview` — Resource & Infrastructure Telemetry

The `Overview` page provides macro-level observability into LLM token consumption, connected MCP server health, and system execution topology.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Token meter                                           39 steps · 4 subagents │
│   ▃▅█▇▆▅▄▃▂ ▂▃▅▆▇█                                      average ───          │
│   █████████ ▄▅█████████                                 lead █  subagent █   │
│ Context: 199k / 1.0M [█████░░░░░░░░░░░░░░░] 20% · cache 195k read · 193/406 t/s│
│ Cost: $3.52 total · +$0.42 this turn · in 4k · out 880 · reasoning 220       │
├──────────────────────────────────────────────────────────────────────────────┤
│ MCP Status Grid                                 8/9 connected · 1 need action│
│  • chrome-devtools Connected          • context7    Connected                │
│  • filesystem      Connected          • github      Connected (38s ago)      │
│  • gitlab          Connected (38s ago)• linear      Connected                │
│  • obsidian        Connected          • slack       Connected                │
│  • sentry          Error Request timed out (highlighted red)                │
│  Last calls: github.search_code ✓ · gitlab.get_merge_request ✓               │
├──────────────────────────────────────────────────────────────────────────────┤
│ Work Map (Topology)                             nothing running · x3 prompt  │
│                                                                              │
│  [ Gates (x1 3) ] ─── [ You (3) ] ─── [ Model (40) ]                         │
│           │                   │               │                              │
│  [ Skills (1) ] ──────── [ OPENCODE ] ─── [ Memory (1) ]                     │
│           │                opus 5.5           │                              │
│  [ Agents (4) ] ───────── [ 20% ctx ] ─── [ Files (x1 6) ]                   │
│           │                                   │                              │
│  [ Browser (1) ] ─────── [ Network (x1 3) ] ─── [ Shell (2) ]                │
│                                                                              │
│ Answer ready 6.7s ago                                                        │
├──────────────────────────────────────────────────────────────────────────────┤
│ 1-3 pages · tab next · <-> station · q quit                   locked session │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### Key Components:
- **Token Meter**: Unicode block-chart histogram comparing lead orchestrator steps against subagent steps. Tracks context saturation percentage, cache hit ratios, tokens/second velocity, and reasoning token overhead.
- **MCP Status Grid**: Real-time probe of all 5 Pantheon MCP servers (`code-mode`, `memory`, `persistence`, `resources`, `vision`) plus host tools. Displays latency, last successful call receipts, and highlighted error banners for degraded servers.
- **Work Map**: ASCII topology diagram illustrating real-time interaction between OpenCode, model calls, memory bank, active agents, filesystem mutations, shell executions, and permission gates.

---

### Page 2: `Swarm` — Multi-Agent Orchestration & Concurrency

The `Swarm` page provides micro-level execution tracking across specialist agents, showing delegation trees, parallel execution timelines, and granular activity streams.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● 1 active · ✓ 3 done · ✗ 1 failed · 23 calls                    15:58 → now │
├──────────────────────────────────────────────────────────────────────────────┤
│ Orchestration                                        lead on top · started by 4│
│ ▾ @zeus             deepseek-v4.1-flash    thinking              18 calls 9s │
│   ├─ @athena        deepseek-v4.1-flash    14k tokens   ✓ done    1 call  12s│
│   ├─ @demeter       deepseek-v4.1-flash    56k tokens   ✓ done    2 calls 18s│
│   ├─ @hermes        deepseek-v4.1-flash   279k tokens   ✓ done    6 calls 45s│
│   ├─ @aphrodite     deepseek-v4.1-flash   354k tokens   ✓ done    8 calls 62s│
│   └─ @themis        deepseek-v4.1-flash   148k tokens   ● active  3 calls 24s│
│ ↑↓ select · enter shows the agent's calls and answer                         │
├──────────────────────────────────────────────────────────────────────────────┤
│ Timeline (Concurrency)                                           overlap 54s │
│  @zeus       [─────────────────────────────────────────────────────────────►]│
│  @athena         [████████]                                                  │
│  @demeter                 [████████████]                                     │
│  @hermes                          [████████████████████]                     │
│  @aphrodite                       [████████████████████████████]             │
│  @themis                                                  [████████████►]    │
├──────────────────────────────────────────────────────────────────────────────┤
│ Activity                                                        newest first │
│  15:59:48  @themis     shell      pytest tests/api/test_webhooks.py -v     ✓ │
│  15:59:47  @aphrodite  write      src/components/WebhookTable.tsx          ✓ │
│  15:59:45  @aphrodite  read       src/types/webhook.ts                     ✓ │
│  15:59:24  @hermes     shell      alembic upgrade head                     ✓ │
│  15:59:22  @themis     gate       J1 verification gate                     ✓ │
│  15:59:19  @hermes     edit       src/main.py                     ✗ mismatch │
│  15:59:17  @zeus       handoff    dispatch @hermes for worker.py           ✓ │
├──────────────────────────────────────────────────────────────────────────────┤
│ 1-3 pages · tab next · ↑↓ select · enter detail · q quit                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### Key Components:
- **Orchestration Tree**: Hierarchical specialist tree mapping Pantheon's pantheon of agents (`@zeus`, `@athena`, `@demeter`, `@hermes`, `@aphrodite`, `@themis`). Each node displays model ID, accumulated tokens, call count, elapsed time, and status.
- **Concurrency Timeline (Gantt Chart)**: Real-time visual representation of subagent execution overlap, instantly surfacing concurrency bottlenecks or deadlocks.
- **Activity Stream**: Formatted event stream documenting every tool invocation with exact timestamp, responsible agent, action category, target path/command, and outcome indicator (`✓`, `✗ error`, `✗ denied`).

---

### Page 3: `Flightdeck` — Governance, Safety Gates & Unified Logs

The `Flightdeck` page acts as the operational nerve center for safety governance, pending approvals, and centralized execution logs.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ MAIN                                              claude-opus-5-5 · high     │
│ ctx [█████░░░░░░░░░░░░░░░░░░░] 24% · 239k/1.0M · cost $3.68 · 35 calls · 0.6s│
│ turn running 21s · advisors: 1 · @themis running 11s                         │
├──────────────────────────────────────────────────────────────────────────────┤
│ GATE (Safety & Approvals)                                          34 checks │
│  ■■■■■■■■■■■■■■■■■■■■■■■■■■■■■  □□□  ▣  ■                                    │
│  29 allowed · 3 approved by you · 1 waiting · 1 denied                       │
│  [g] file: 13 · shell: 5 · other: 16 · dimmed = in subagent                  │
│  waiting: shell git push origin feature/webhook-resilience                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ AGENTS (Active Progress)                                   2 / 4 running     │
│  1 @themis     [████████████████████████░░░░░░░░] 11s                        │
│  2 @aphrodite  [████████████████░░░░░░░░░░░░░░░░] 8s                         │
│  3 @hermes     [████████████████████████████████] done 45s                   │
│  4 @demeter    [████████████████████████████████] done 18s                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ TURN                                                                 running │
│  21s · 4 agents · 2 edits · 0 errors · +$0.160                               │
├──────────────────────────────────────────────────────────────────────────────┤
│ LOG (Semantic Stream)                         all agents · enter filters     │
│  16:00:01  ✎ edit    src/main.py                                            │
│  15:59:58  ⚙ @zeus:  Reconciliation complete with deepwork plan              │
│  15:59:56  ✎ write   tests/test_resilience.py                                │
│  15:59:52  ⚙ @themis:Verifying lease expiration under concurrent load       │
│  15:59:19  ! edit:   Could not find target block in src/worker.py            │
│  15:59:17  ✗ shell:  git push denied by J1 gate                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ 1-3 pages · ↑↓ select · enter detail · g gate · q quit                       │
└──────────────────────────────────────────────────────────────────────────────┘
```

#### Key Components:
- **Gate Matrix**: Visual contribution-grid of all permission, security, and TDD checks. Highlights approvals awaiting human input (`waiting: shell ...`) and denied actions.
- **Agent Progress Gauges**: Real-time progress bars for active specialist workers.
- **Turn Telemetry**: Incremental turn metrics tracking duration, agent count, file mutations, and step cost.
- **Unified Semantic Log**: Compact, readable log merging actions from all agents, with immediate root-cause syntax/runtime error highlighting.

---

## 3. Technical Implementation Architecture

### 3.1 Directory Structure

The Cockpit will reside in `src/plugins/tui/src/cockpit/`:

```
src/plugins/tui/src/cockpit/
├── CockpitApp.tsx                 # Root coordinator with 3-tab router and keybindings
├── pages/
│   ├── OverviewPage.tsx           # Page 1: Token meter, MCP grid, Work Map
│   ├── SwarmPage.tsx              # Page 2: Orchestration tree, Gantt timeline, Activity stream
│   └── FlightdeckPage.tsx         # Page 3: Gate matrix, Agent gauges, Unified log
├── components/
│   ├── TokenHistogram.tsx         # Unicode block histogram renderer
│   ├── ContextBar.tsx             # Context saturation gauge
│   ├── McpGrid.tsx                # Health & latency grid for MCP servers
│   ├── TopologyMap.tsx            # ASCII / box-drawing system topology
│   ├── AgentTree.tsx              # Interactive collapsible specialist tree
│   ├── ConcurrencyTimeline.tsx    # Gantt chart horizontal concurrency bar
│   ├── ActivityStreamTable.tsx    # Tabular tool call feed
│   ├── GateMatrix.tsx             # Block-grid permission & safety visualizer
│   └── SemanticLog.tsx            # High-density filtered log viewer
└── state/
    ├── cockpit-state.ts           # Centralized reactive state store
    ├── bus-bridge.ts              # Event listener bridging PantheonBus & OpenCode events
    └── mcp-health-monitor.ts      # Non-blocking MCP health poller
```

### 3.2 State Management & Event Sources

1. **PantheonBus & OpenCode Event Bridge**:
   - `session_start`, `session_stop`, `subagent_start`, `subagent_stop` events update the `OrchestrationTree` and `ConcurrencyTimeline`.
   - `tool_call` and `tool_result` events feed the `ActivityStream` and `SemanticLog`.
2. **Deepwork Plan Sync**:
   - Reads `plan.json` and streams `journal.ndjson` transitions directly into the Swarm tree, ensuring TUI state always matches Deepwork state.
3. **Decision Router & Gate Matrix**:
   - Tracks `pantheon_jev_decide` and `pantheon_local_decision` evaluations, categorizing decisions into `allowed`, `approved`, `waiting`, and `denied`.
4. **MCP Health Polling**:
   - Employs a non-blocking 15-second heartbeat to query MCP socket status and latency without stalling user interactions or TUI render loops.

---

## 4. Deliverable Roadmap (v2.2.0)

| Phase | Target Deliverable | Scope |
|---|---|---|
| **Phase 1** | **`Swarm` Cockpit (Page 2)** | Subagent tree (`@zeus` → specialists), Gantt timeline, activity table, interactive agent inspection. |
| **Phase 2** | **`Flightdeck` Cockpit (Page 3)** | Gate matrix, approval prompt shortcuts, turn telemetry, unified error-highlighting log. |
| **Phase 3** | **`Overview` Cockpit (Page 1)** | Token histogram, MCP status grid, box-drawing topology map, context window gauge. |
| **Phase 4** | **Polish & Integration** | Tab keyboard routing (`Tab`, `1-3`, `g`), zero-flicker Ink render tuning, test suite. |

---

## 5. Verification & Acceptance Criteria

1. **Host Compatibility**: Operates seamlessly across OpenCode 2.x terminal hosts without requiring external GUI frameworks.
2. **Performance Budget**: Renders at 60 FPS in standard VT100 / xterm-256color terminals; CPU utilization under 1.5% during active turns.
3. **Strict Non-Blocking Contract**: MCP health checks and background event streams must never block interactive keystrokes or UI responsiveness.
4. **Test Coverage**: 100% unit test coverage for state reducers (`cockpit-state.test.ts`) and snapshot rendering checks for all 3 pages.
