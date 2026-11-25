---
name: artifact-management
description: "Structured high-density artifacts for architectural plans, deepwork, executive reports, and ADRs."
---

# Artifact Management

Structured, high-density visual artifacts for planned, multi-phase, or materially risky implementation work. Artifacts are not a prerequisite for simple bounded fixes or read-only investigation.

---

## Artifact Storage Locations

Artifacts must not pollute the project root. The Pantheon ecosystem persists artifacts across three standard destinations:

| Artifact Type | Target Path | Produced By | Lifecycle |
|---|---|---|---|
| Architectural Plan & Deepwork | `.pantheon/deepwork/<slug>/PLAN.md` | @athena | Durable across task/sprint |
| Executive Report & Analysis | `.pantheon/reports/<YYYY-MM-DD>-<topic>.md` | @apollo / @themis | Permanent for audit/history |
| Architectural Decision Record (ADR) | `docs/adr/<NNN>-<slug>.md` | @iris (or `spawn_ephemeral` `memory-adr`) | Permanent repository asset |

Note: Files in `.pantheon/deepwork/` are gitignored by default, while `.pantheon/reports/` and `docs/adr/` can be tracked in version control.

---

## High-Density Visual Artifact Standard (5 Core Blocks)

When generating plans, executive reports, or ADRs, agents must format documents using high density, visual clarity, and concrete data:

### 1. GitHub-Flavored Markdown (GFM) Alerts
Use alerts to highlight background context, efficiency gains, and safety gates (never nest or place alerts consecutively):
- `> [!NOTE]` Background context, technical assumptions, and architecture decisions.
- `> [!TIP]` Performance optimizations, token footprint savings, and latency wins.
- `> [!IMPORTANT]` Mandatory requirements, verification gates, and human approval checkpoints.
- `> [!WARNING]` Potential breaking changes, deprecation notices, or environment constraints.
- `> [!CAUTION]` High-risk actions that could cause data loss or security vulnerabilities.

### 2. Native Mermaid Diagrams
Include a visual flowchart (`flowchart TD` / `graph LR` / `sequenceDiagram` / `stateDiagram-v2` / `erDiagram`) visualizing the execution graph, agent handoffs, and verification gates before code changes begin. Quote node labels containing parentheses or brackets (e.g., `B["Phase 1 (@hermes)"]`) and avoid HTML tags inside labels so both CLI and OpenCode Desktop render cleanly.

### 3. Quantitative Diagnostics, Clickable Links & No Chat Duplication
Provide real metrics and direct navigation rather than vague prose:
- Tokens / context footprint (before vs after) and sliced test latency.
- Clickable file links using basenames and line ranges (`[tool.ts](file:///abs/path/to/tool.ts#L12-L40)`) for instant jump in OpenCode Desktop and readable paths in CLI.
- **No chat duplication:** after saving an artifact, link to it and present only the concise executive decision summary (≤ 15 lines) and approval gate in chat instead of repeating the full document.

### 4. Sliced Actionable Phases
Every implementation phase lists:
- Assigned specialist (`@hermes`, `@aphrodite`, `@demeter`, etc.)
- Specific affected files (exact paths, no vague placeholders)
- Exact verification command (e.g. `node --test tests/foo.test.mjs`, `pytest -k ...`)
- Clear exit criteria and acceptance checklist

### 5. Risk & Contingency Matrix
Map concrete risks directly to their contingency actions:
- Specific technical risk -> immediate remediation action.

---

## Proportional Use

- Create PLAN/IMPL/REVIEW artifacts for planned multi-phase work or when risk, auditability, or an explicit request needs a durable phase trail.
- A bounded, reversible fix should be investigated only as far as needed, implemented, verified with focused checks, and returned as a concise summary. Do not create PLAN, IMPL, or REVIEW artifacts for it.
- Read-only lookup or trivial discovery needs no DISC artifact; use one only when findings are broad enough to be reused or drive a material decision.
- The absence of an artifact never waives Themis review or human approval for auth/security, data/schema/migrations, production-impacting work, or sensitive actions.
- Zeus does not implement or write artifacts directly; he coordinates the specialist agents who generate and review them.

---

## Routing

| Action / trigger | Reference |
|---|---|
| Templates for PLAN, REPORT, and ADR | [references/artifact-templates.md](references/artifact-templates.md) |
