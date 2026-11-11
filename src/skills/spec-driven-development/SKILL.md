---
name: spec-driven-development
description: "Define requirements via spec-first before code — PRD, edge cases, acceptance criteria"
---

# Spec-Driven Development

Do not write code before understanding the problem.

## Workflow
1. Interview: Extract requirements with iterative questions to resolve ambiguity.
2. PRD: Document core requirements: objective, personas, user flows, business rules, and acceptance criteria.
3. Edge Cases: Map invalid inputs, concurrency, API failures, and empty states.
4. Technical Spec: Document architectural decisions: components, data models, API contracts, and deployment.
5. Approval: Present the complete plan to the user before writing code. When planning was executed in a subagent, return the full plan to the orchestrator so it displays in the main conversation before requesting approval.

## Anti-Patterns
- Jumping straight into implementation without requirements.
- Assuming requirements without confirmation.
- Overly verbose specifications (5+ pages) — keep specs concise and actionable.

## Output
`spec.md` at project root or `.pantheon/deepwork/<feature>/PLAN.md` — used as input for planning.
