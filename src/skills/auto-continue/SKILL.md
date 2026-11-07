---
name: auto-continue
description: "Auto-continue through todos with idle detection and safety gates. Use for multi-step orchestration."
---

# Auto-Continue Mode

Disciplined automatic continuation through multi-step tasks. Eliminates unnecessary pauses while preserving mandatory safety gates.

---

## Core Principle

> **Auto-continue through unambiguous work. Stop only at real decision points.**

---

## Risk-Proportional Gates

| Gate | Trigger | What happens |
|---|---|---|
| **GATE 0 — Explicit Council** | User explicitly invokes council and it returns `AWAITING_APPROVAL` | Stop and follow the approval the council requests; do not launch a council automatically for ordinary implementation. |
| **GATE 1 — Plan Approval** | A plan was requested or scope/risk makes planning necessary | Ask before implementation only when the plan introduces a material choice or risk; omit this gate for a bounded, clear fix. |
| **GATE 2 — Risk Review** | Auth/security, data/schema/migration, API contract, production configuration, or other material risk | Themis review and human approval before sensitive or irreversible action. For a trivial, isolated, reversible edit, provide a concise result instead of manufacturing a review phase. |
| **GATE 3 — Git / External Action** | Commit, push, merge, production deploy, destructive operation, global configuration, or broad permission change | Always stop for explicit human approval. Full-auto never authorizes these actions by implication. |

An explicit `AWAITING_APPROVAL` from an invoked council remains a hard stop. Authentication/security and data/schema changes retain their review and approval gates even in full-auto.

---

## Auto-Continue Rules

**Continue automatically when:**
- Next todo is a direct consequence of the current one
- Action is reversible (file edits, tests, linting)
- Scope is within the user's explicitly authorized task (a prior plan is not required for a small clear fix)
- No new ambiguity has emerged

**Stop and ask when:**
- A todo requires a decision not covered by the plan
- An unexpected error changes the approach
- A dependency is missing or broken
- Remaining context is too thin to carry the task through — write an explicit handoff instead
- The task reaches a sensitive gate in the table above; full-auto does not override it

### Full-auto Authorization

Full-auto may continue only within a task and scope the user explicitly authorized. It may run reversible edits and proportionate verification; it must stop for auth/security, data/schema changes with risk, destructive or global changes, broad permissions, deploy, push, or merge. Never infer permission to expand the scope from a full-auto request.

---

## Implementation Pattern

```
1. Create a checklist only for multi-step work; a one-step fix needs no todo ceremony
2. Use native todo operations only when a todo-write tool is visible in the active session; otherwise keep the checklist explicit in the conversation
3. Mark work complete in the available checklist as soon as it is done
4. Do not claim that the native todo list was updated when no todo-write tool is exposed
5. Do NOT ask "should I continue?" between clear steps
6. Stop at any applicable risk gate; do not require a plan/review gate for a low-risk edit
7. After gate approval, resume with next todo
```

**Never batch-complete checklist items.** Mark each completed as soon as done; do not imply a tool call occurred unless it did.

---

## Safety Checks Before Continuing

- [ ] Previous step completed successfully (tests pass, no errors)
- [ ] Next step is within approved plan scope
- [ ] No new blocking issues emerged
- [ ] Remaining context can carry the next step, or an explicit handoff will be written

---

## Checkpoint content contract (format safety — keep in core)

When checkpointing via `context_save`: `content=JSON.stringify(state)` and an
explicit `session_id`; `state` must be an OBJECT (its `goal`/`phase`/
`delegations`/`heartbeat` values are objects, `tail` is an array); if the
optional `goal` is unset, omit the key rather than passing a string
placeholder.

---

## Details under demand

The cooldown templates, timeout/retry enforcement (the single authority is
`src/instructions/zeus-timeout-retry.instructions.md` — force-fed via AGENTS.md),
tracking-table format, worked examples and the checkpoint rules live in
`references/auto-continue-details.md` — read it ONLY when a delegation times out,
you need a cooldown template, or you are about to checkpoint.
