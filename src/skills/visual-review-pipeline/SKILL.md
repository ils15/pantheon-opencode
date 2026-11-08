---
name: visual-review-pipeline
description: "Automated visual review pipeline — Playwright screenshots, self-analysis, fix loop, escalation. Used by Aphrodite for UI verification."
---

# Visual Review Pipeline

Automated visual review: Aphrodite captures screenshots via Playwright MCP → Self-analyzes for visual issues → Addresses findings in a loop.

This pipeline enforces structured JSON output, iteration limits, and escalation criteria to prevent infinite fix loops.

---

## Loop Contract

```
Aphrodite implements UI
    ↓
Playwright screenshot (browser/screenshotPage)
    ↓
Aphrodite self-analyzes (layout, contrast, responsive, accessibility)
    ↓
├─ verdict: pass → proceed to Themis review
├─ verdict: fail + iteration < 3 → fix → re-capture
└─ verdict: fail + iteration = 3 → Zeus escalation
```

## Findings Contract (format safety — keep in core)

Aphrodite must return findings in this exact structure:

```json
{
  "verdict": "pass | fail | warn",
  "iteration": 1,
  "max_iterations": 3,
  "issues": [
    {
      "id": "VIS-001",
      "category": "layout",
      "severity": "high",
      "description": "Sidebar overflows on viewport width < 768px",
      "screenshot_region": "left-panel at x:0,y:0 width:300px",
      "recommendation": "Add responsive breakpoint to collapse sidebar below 768px"
    }
  ],
  "summary": "One-line summary of overall visual state",
  "pass_if_fixed": ["VIS-001", "VIS-002"]
}
```

## Iteration Rules

1. **Minimum progress:** Each iteration fixes at least one `pass_if_fixed` issue
2. **No regression:** Fixes must not introduce new issues
3. **Track state:** Include iteration count in findings JSON
4. **Early exit:** If `verdict` is `pass`, stop iterating
5. **Immediate escalation:** If zero issues fixed in an iteration, escalate to Zeus

## Escalation Criteria

Zeus must be invoked when:
1. **3 iterations exhausted** — issues cannot be resolved within the pipeline
2. **Backend/data dependency** — issue requires API changes, data model updates, or backend fixes
3. **Architectural issue** — problem stems from component architecture, not CSS/styling
4. **Zero progress** — no `pass_if_fixed` issues resolved in an iteration
5. **Conflicting fixes** — resolving one issue introduces another

## MCP Requirements

### Playwright MCP (Required)
- Use `browser/screenshotPage` for full-page captures
- Use `browser/snapshot` for accessibility tree context
- Fallback: If Playwright MCP is unavailable, skip with warning:
  ```
  ⚠️ Playwright MCP unavailable — visual review skipped.
  Install Playwright MCP server to enable visual review pipeline.
  ```
For UI implementation review, Aphrodite self-reviews.

---

## Routing

| Action / trigger | Reference |
|---|---|
| Running the capture → analyze → fix loop, writing the escalation message, or wiring integrations | [references/workflow-steps.md](references/workflow-steps.md) |
| Classifying findings fields, issue categories, or severity levels | [references/findings-schema.md](references/findings-schema.md) |

A missing reference interrupts the action — read nothing in its place, never improvise from memory.
