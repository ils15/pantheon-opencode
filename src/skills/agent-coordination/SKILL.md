---
name: agent-coordination
description: "Coordinate two or more specialists for substantial multi-phase work. Skip for questions, bounded fixes, and one-agent tasks."
context: fork
globs: []
alwaysApply: false
---

# Agent coordination

Load only when the work genuinely needs multiple specialists or dependent phases. For the default routing, retry, and safety rules, follow Zeus and `pantheon://routing`.

## Lean coordination

1. State the desired outcome and split only work with distinct ownership or dependencies. Ask @athena to plan only when scope, architecture, or acceptance criteria are materially unclear.
2. Assign each bounded task to the most specific configured specialist. Include relevant context, expected result, and focused verification; do not make @apollo rediscover context the implementer can inspect directly.
3. Dispatch independent tasks together only when native background delegation is enabled. Otherwise use normal `task()` calls. Do not create waves for a single task or poll without a returned task ID.
4. Collect summaries once, resolve dependencies, and report evidence, remaining risk, and blockers. Add @themis, artifacts, or user approval only where the task's risk or requested workflow requires them.

## Boundaries

- Zeus coordinates; implementation agents inspect, edit, and verify their assigned scope.
- Preserve auth/security, data/schema, destructive-action, production, and permission gates.
- Do not commit, push, merge, deploy, or broaden scope without explicit authorization.
- Model selection comes from the active configured preset; do not invent a model tier or price.
