---
description: "Dispatch a question to 2-4 specialist agents via inline Zeus council"
agent: zeus
---
# /pantheon — Council Synthesis

**What:** Dispatches the question to 2-3 specialist agents **in parallel** via `task()`, then synthesizes their responses into a single recommendation with resolved divergences.
**Usage:** `/pantheon <question>`
**When:** Architecture trade-offs, technology selection, security assessments, multi-stakeholder concerns
**Returns:** Structured synthesis with recommendation, confidence level, resolved divergences

Dispatch, specialist selection, and synthesis follow the canonical `## Zeus Council Synthesis` protocol (Steps 0–9: precedent fast-path, dispatch, confidence cross-validation, rebuttal, tie-break, Themis audit, persist). Send ALL `task()` calls in a single message; each specialist returns the `## specialist_response` structure from `## Agent Return Format`.

## Question:
$ARGUMENTS
