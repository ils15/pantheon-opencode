---
name: implement-feature
description: "Implement a feature with TDD and risk-based specialist routing"
agent: zeus
tools: ['search', 'usages', 'edit', 'runCommands', 'runTasks']
---

# Implement Feature with TDD (Zeus Orchestration)

See `prompts/orchestrate-with-zeus.prompt.md` for the full master orchestration workflow.

## Proportional Workflow

- For a clear, bounded, reversible, low-risk task, dispatch once to the correct
  specialist. The specialist inspects relevant context, implements with TDD
  when behavior changes, verifies, and returns a concise result. Do not require
  routine planning, separate discovery, review, or artifacts.
- Use @athena for an explicitly requested plan or when scope, dependencies, risk,
  or uncertainty justify one. Use @apollo only when broad/unfamiliar discovery
  materially reduces uncertainty; straightforward searches stay with the
  specialist who will do the work.
- Route implementation by domain: @hermes for backend, @aphrodite for frontend,
  @demeter for database/schema, @hephaestus for AI pipelines, and @prometheus
  for infrastructure. Run work in parallel only when slices are independent
  and the active runtime supports it; sequence dependent work. Do not impose a
  fixed root-concurrency cap.
- Use @themis for auth/security, data/schema, destructive, production-impacting,
  material user-visible/API changes, or another required repository gate. A
  trivial isolated edit needs no separate review phase.
- Create durable artifacts only when requested or when following a planned
  multi-phase workflow. `/pantheon-deepwork` remains the checkpointed workflow
  for heavy multi-agent/multi-session tasks. Deployment is a separate requested
  scope, not an automatic final phase.

## Success Criteria
- Focused tests and applicable repository quality gates pass
- Required security/data/material review is complete
- User-facing documentation reflects any new behavior
- Deployment happens only when explicitly in scope and authorized
