# Artifact Management — High-Density Templates

Companion reference for `SKILL.md`. Contains templates for architectural plans, executive reports, and ADRs.

---

## 1. Architectural Plan (`.pantheon/deepwork/<slug>/PLAN.md`)

Produced by `@athena`. Opens with an immediate Mermaid diagram and follows with dense, actionable phases:

```markdown
# Architectural Plan: [Feature / Refactor Title]

> [!NOTE]
> High-level context, background problem, and target outcome.

> [!IMPORTANT]
> Non-negotiable safety constraints, auth boundaries, or database schema requirements.

## 1. Visual Execution Flow

\`\`\`mermaid
flowchart TD
  A["Requirement"] --> B["Phase 1: Backend (@hermes)"]
  B --> C{"Lint & Slice Test Gate"}
  C -- PASS --> D["Phase 2: Frontend (@aphrodite)"]
  D --> E["Phase 3: Security & Code Audit (@themis)"]
\`\`\`

## 2. Quantitative Baseline & Impact

| Dimension | Before | Target | Verification Method |
|---|---|---|---|
| Latency | ~150s | < 2s | Sliced test runner |
| Token Overhead | ~20k | < 8k | Context telemetry |
| Affected Files | — | 3 files | Git diff check |

## 3. Implementation Phases

### Phase 1: Core Implementation (@hermes)
- **Target Files:** `src/server/auth.ts`, `tests/auth.test.ts`
- **Actions:** RED -> GREEN -> REFACTOR implementation of the auth handler.
- **Validation Gate:** `node --test tests/auth.test.ts`
- **Exit Criteria:** All tests green; no Biome/Ruff lint warnings.

### Phase 2: Interface & Client (@aphrodite)
- **Target Files:** `src/ui/login.tsx`
- **Actions:** Connect UI state to new auth endpoint; ensure WCAG AA keyboard access.
- **Validation Gate:** `npx biome check src/ui/login.tsx`

## 4. Risks & Contingency

| Identified Risk | Impact | Contingency / Mitigation |
|---|---|---|
| Breaking change to legacy clients | High | Preserve backwards-compatible endpoint alias for 1 release |
| Token spike in subagent cascade | Medium | Use direct specialist dispatch without intermediate hops |
```

---

## 2. Executive Report & Analysis (`.pantheon/reports/<YYYY-MM-DD>-<topic>.md`)

Produced by `@apollo` (deep discovery) or `@themis` (quality/security audits):

```markdown
# Executive Report: [Analysis Topic]

> [!NOTE]
> Summary of findings and systemic conclusions.

> [!TIP]
> Key optimization opportunities and quick wins.

## 1. Architecture / System Topology

\`\`\`mermaid
graph LR
  Client["Client Host"] --> Gateway["Decision Router"]
  Gateway --> Specialist["Domain Specialist"]
\`\`\`

## 2. Metrics & Comparison

| Metric | Current State | Target / Proposed | Delta (%) |
|---|---|---|---|
| Test Latency | 150.000ms | 50ms | -99.9% |
| Initial Context | 19.877 tokens | 7.500 tokens | -62.2% |

## 3. Findings & Evidence
- Detailed finding 1 with exact file citations.
- Detailed finding 2 with reproducible evidence.

## 4. Prioritized Recommendations
1. Actionable item 1 (low effort, high impact)
2. Actionable item 2 (medium effort)
```

---

## 3. Architectural Decision Record (`docs/adr/<NNN>-<slug>.md`)

Produced by `@mnemosyne`:

```markdown
# ADR-[NNN]: [Decision Title]

**Date:** YYYY-MM-DD
**Status:** [Proposed | Accepted | Superseded]

> [!IMPORTANT]
> Decision impacts: [Core systems / architecture / protocols].

## Context
What problem was being solved? What forces or constraints applied?

## Decision
What was decided? Which approach was chosen over the alternatives?

## Alternatives Considered
- **Alternative A:** [Reason rejected]
- **Alternative B:** [Reason rejected]

## Consequences
- **Positive:** [Benefits gained]
- **Negative / Trade-offs:** [Costs or constraints accepted]
```
