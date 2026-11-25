# Overview: how Pantheon routes work

> Originally published in the root README. Setup lives in [Installation](INSTALLATION.md);
> internals in [Architecture](ARCHITECTURE.md).

Pantheon is a companion for [OpenCode](https://opencode.ai/) that helps you move
from an idea to a reviewed, verified change. Eight canonical agents (plus
`spawn_ephemeral` slice archetypes) share one streamlined workflow: plan,
implement, check, review, and record what mattered.
You stay in charge of every decision and every merge.

```mermaid
flowchart LR
    U["You"] --> Z["Zeus<br/>orchestrator"]
    Z -->|"delegates"| S["8 specialists + ephemeral<br/>hermes · aphrodite · demeter · themis …"]
    Z -->|"ambiguous route"| J["Jev decision router<br/>typed · budgeted · reversible"]
    J -->|"orders · ranks · verifies"| S
    S -->|"last resort"| M["Native MCP<br/>memory · persistence · vision<br/>code-mode · resources"]
    Z --> G["J1 risk gate<br/>off / shadow / warn / enforce"]
    G -->|"high risk"| H["Human approval"]
```

**The escalation ladder every agent follows**: session context first → free local
selector → one typed Jev decision when genuinely ambiguous → native MCP call only as
the last resort for state the session cannot reconstruct.

```mermaid
flowchart LR
    R["rough request"] --> T0{"clear &<br/>bounded?"}
    T0 -->|yes| X["execute directly"]
    T0 -->|"vague /<br/>multi-concern"| T1["Tier 1 — internal<br/>minimal adjust ≤15 lines<br/>(silent, no approval)"]
    T1 --> T2q{">> given?"}
    T2q -->|yes| T2["Tier 2 — full contract<br/>6 sections, confirm-or-adjust"]
    T2q -->|no| X
```

**Skill discovery runs a trust cascade** — canonical first, popularity never
compensates for provenance:

```mermaid
flowchart LR
    L["installed pool<br/>(always first)"] -->|"gap"| C1["anthropics/skills<br/>canonical"]
    C1 -->|"no fit"| C2["skills.sh<br/>install-count signal"]
    C2 -->|"no fit"| C3["GitHub raw<br/>widest, weakest"]
    C3 --> J["Jev orders<br/>the candidates"]
    J --> P["YOU review<br/>and run the install"]
```

---

## Why use it

- **Fast-Track execution:** Bounded micro-edits (<= 2 files, <= 50 lines) bypass all heavy ceremony and verify in < 10 seconds.
- **Mandatory test slicing:** Sub-second targeted test execution instead of running sluggish repository-wide test suites during dev loops.
- **Execution proof receipts:** Cryptographic SHA-256 fingerprinting on modified files and test slice exit codes prevents false-positive task reports.
- **KV-cache prefix optimization:** Strict invariant-first prompt layering maximizes LLM cache hits (up to 90% cost and latency savings).
- **Reactive event bus & zero polling:** Process-wide in-memory event bus delivers instant updates across jobs and agents without disk polling.
- **Themis local reflex loops:** Specialist self-healing resolves isolated lint and test slice discrepancies before escalating to Zeus.
- **Assertive council (`/pantheon`):** Parallel specialist consultations resolved decisively via domain authority and JEV multi-criteria decisions without endless debate turns.
- **You stay in charge:** Pantheon supports your judgment; it never silently alters permissions or runs unapproved destructive actions.
- **Non-destructive upgrades:** Updating Pantheon (`pantheon-opencode update`) refreshes skills, MCPs, and instructions while strictly preserving all user models, presets, permissions, and custom configs.

---

## Next

- [Execution modes](guides/execution-modes.md) — Fast-Track, Council and Deepwork in detail
- [Settings & TUI window](SETTINGS.md) — gates, presets, updates, personalization
- [Agent Capability Matrix](AGENT-CAPABILITY-MATRIX.md) — what each of the 14 agents can and cannot do
