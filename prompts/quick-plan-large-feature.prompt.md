---
name: "Quick Plan - Large Feature"
description: "Rapid planning for large/complex features using bounded research (5 min max)"
---

# Quick Planning for Large Features (Fast Path)

## Problem This Solves
Planning for large sites has been slow (30+ min). This prompt ensures **5-minute plans** for even complex features.

## When to Use This Prompt

✅ **USE THIS when**:
- User: "@athena Plan: Add customer dashboard with analytics"
- User: "@athena Plan: Implement multi-tenant architecture"
- User: "@athena Design: Microservices migration strategy"
- Any Feature with >3 implementation phases

❌ **DO NOT USE** for:
- Small bug fixes (use default plan-architecture.prompt)
- Single-component changes

---

## Your Workflow (5 Minutes)

### Minute 0-2: Quick Codebase Scan
```
Goal: Understand current structure (don't aim for comprehensive)

Search only relevant questions; run searches in parallel when they are
independent and the runtime supports it (otherwise sequence them):
  1. "Find main modules/routers related to [Feature]"
  2. "Find existing models/schemas for [Feature]"
  3. (OPTIONAL) "How is [similar feature] currently implemented?"

While searching: Review Memory Bank if it has content
  - .pantheon/memory-bank/00-project.md (project scope)
  - .pantheon/memory-bank/00-project.md (existing patterns)
```

### Minute 2-4: Synthesis
```
From searches, extract:
  - What exists? (reuse?)
  - What's missing? (build?)
  - What pattern fits? (async? repository? caching?)
  - What are risks? (scale? complexity? performance?)

⚠️ If unclear: record the uncertainty as an "Open Question" for Zeus and
continue with an explicit assumption or bounded alternative.
```

### Minute 4-5: Plan Creation
```
Create a complete plan with 3-5 actionable phases:

Format:
  📋 Plan: [Feature Name]
  🎯 Goal: [One sentence outcome]
  📦 Scope and assumptions: [What is included; state assumptions]
  📂 Affected files or areas: [Known paths/areas; mark unknowns]
  🔗 Dependencies: [Required ordering or external dependencies]

  1️⃣ Phase: [Name] → @agent
     - Actions and expected outcome
     - Key files/areas: [list or explicitly unknown]
     - Depends on: [phase/dependency or none]

  2️⃣ Phase: [Name] → @agent
     ...

  ✅ Verification and tests: [Focused checks for each behavior]
  ⚠️ Risks: [Risks and mitigations]
  🤔 Open Questions / unknowns: [Unresolved facts; don't block the handoff]
  🎯 Acceptance criteria: [Observable completion conditions]
```

Return the complete Markdown plan to Zeus.

---

## Decision: Direct vs. Delegate

At minute 2-3, assess:

```
Are the main risks and dependencies understood well enough to plan?

YES → Create plan immediately (skip delegates)
NO  → Check whether broad discovery would materially change the plan
       YES → Delegate bounded discovery to @apollo if it fits the time budget
       NO  → Document unknowns as "Open Questions" and proceed with a bounded plan
```

---

## Red Flags (Plan is incomplete)

🚩 **More than 3 open questions**
→ State the highest-impact unknowns, their consequences, and any safe assumptions in the plan.

🚩 **Can't identify affected modules**
→ Use bounded Apollo discovery when likely to change the plan and within the time budget; otherwise mark affected areas unknown.

🚩 **Risk assessment uncertain**
→ Document risk/unknowns clearly in plan

🚩 **Implementation unclear**
→ Break the work into smaller phases or sub-features and state dependencies and scope assumptions.

---

## Examples

### Example 1: Customer Dashboard (Medium Complexity)
```
Time: 0:00 - User: "Plan: Add customer analytics dashboard"

Time: 0:00-2:00 - Search:
  S1: "Find customer-related routers and models"
  S2: "How are forms/charts rendered in existing UI?"
  S3: (OPTIONAL) "What analytics libraries are available?"

Time: 2:00 - Understanding: 85% coverage
  ✓ Found customer routes, models, existing charts
  ✓ Know Frontend (React) + Backend (FastAPI) structure
  ✓ Slight uncertainty: Analytics data aggregation approach

Time: 2:00-4:00 - Plan:
  Phase 1: Backend analytics API (@hermes)
  Phase 2: Dashboard component (@aphrodite)
  Phase 3: Data aggregation query (@demeter)

  Unresolved unknown: Real-time vs. daily snapshots; describe the impact of each option.

Time: 4:00-5:00 - Return the complete plan, verification, assumptions, and open question to Zeus.
  Zeus publishes it and handles user approval in the main conversation.
```

### Example 2: Multi-Tenant Architecture (High Complexity)
```
Time: 0:00 - User: "Plan: Make platform multi-tenant"

Time: 0:00-2:00 - Search:
  S1: "Find all authentication/authorization code"
  S2: "Find database schema (how is organization data structured?)"
  S3: (OPTIONAL BOUNDED DISCOVERY) "How are other features accessing org context?"

Time: 2:00 - Assessment:
  - Understand current auth: 70%
  - Understand DB structure: 80%
  - Tenant isolation strategy remains unknown

Time: 2:15 - Decision:
  → If bounded Apollo discovery can materially reduce risk within the time budget, run it.
  → Otherwise, record tenant isolation as an open question with its security/data-isolation impact.
  → Athena returns the complete plan and unresolved unknowns to Zeus.
  → Zeus publishes the plan and obtains user approval in the main conversation.
```

---

## Non-Negotiable Rules

✅ **You MUST stop at 5 minutes**
Even if uncertain. Plan with 80% knowledge, document unknowns.

✅ **No re-planning**
One cycle per request. If Zeus discovers plan gaps, that's a new planning request.

✅ **Synthesize, don't explore**
Fast 1-2 min search, then make decisions with the knowledge you have.

✅ **Output only in chat**
Return the complete plan to Zeus; do not create artifacts unless the user explicitly requested them.

---

## Plan Handoff

The child session returns the complete Markdown plan to Zeus, including its
assumptions, verification, risks, acceptance criteria, and unresolved unknowns.
Zeus publishes the full plan in the main conversation and obtains user approval
there before implementation. The child session ends with the plan; it does not
open a user-facing decision or approval gate.

---

## Measuring Success

A "good" quick plan:
- ✅ Takes 5 minutes
- ✅ Has 3-5 phases
- ✅ <3 open questions
- ✅ Clear risk assessment
- ✅ Leads to smooth 1-pass implementation (no major revisions)
