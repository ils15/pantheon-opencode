---
name: subtask
description: "Delegate a bounded child task to a specialist agent and get a structured result back — use for isolated, well-scoped work within a larger session"
agent: zeus
tools: ['agent', 'search']
---

# Subtask — Bounded Delegation (Zeus)

## Task

$input

---

## Delegation Protocol

1. **Parse the request** — identify the target agent and the task scope.
2. **Confirm isolation** — the subtask must be self-contained (no unresolved dependencies on other in-progress work).
3. **Delegate with a structured brief:**
   - Agent: who receives the task
   - Scope: exactly what to do (no more, no less)
   - Inputs: files, context, or data the agent needs
   - Output format: what structured result to return
   - Constraints: time/token limits, what NOT to change

4. **Receive the result** — summarize what was done and any decisions made.
5. **Integrate** — connect the result back into the parent session context.

---

## Subtask Brief Format

```
SUBTASK BRIEF
Agent: <target agent>
Scope: <specific task>
Inputs: <files or context>
Expected output: <structured result format>
Constraints: <what not to touch, time limit>
```

---

## When to Use

- You need a focused investigation without polluting the main context
- A specialist agent can complete the work independently
- You want an auditable, isolated result before integrating

## When NOT to Use

- The task depends on unfinished work in the same session
- The task is trivial (< 2 steps) — just do it inline
- The task requires continuous back-and-forth — use a direct agent instead

---

## Subtask Summary Format

Every worker MUST end with this canonical return contract. All listed fields are required; use `X% (if applicable)` for coverage and `null` when there are no blockers.

```
## subtask_summary
**files_changed:** [list of file paths, one per line]
**summary:** What was done, in 2-3 sentences
**tests:** ✅ All passing / ⚠️ X failing / ❌ Not run (reason)
**coverage:** X% (if applicable)
**tokens:** ~N input / ~M output (estimated)
**status:** complete | partial (reason) | escalated (reason)
**blockers:** [list any blockers or null]
```

If memory affected the result, state the takeaway briefly; do not repeat the entry or task context.

---

## Timeout & Retry

Subtasks default to a 120s timeout. `background_delegation.retry_count: 1` means one retry after the initial attempt.

```
When a subtask times out:
  1. Wait 30s (cooldown)
  2. Make the single retry
  3. If it fails, use one direct task() fallback (with the same one-retry limit)
  4. If that fallback fails, escalate; do not restart the subtask or fallback chain
```

---

## Timeout Parcial (Partial Results)

For long-running subtasks where partial results are acceptable, set `partial_ok: true`:

```
SUBTASK BRIEF
Agent: apollo
Scope: Scan all route files for auth patterns
Partial OK: true
Timeout: 60s
```

If the worker times out but has already found some results, it returns:

```
## subtask_summary
**status:** partial (timed out after scanning 2 of 5 files)
**summary:** Found authentication patterns in auth.py and login.py; 3 files remain.
...
```

Zeus uses the partial results and re-delegates the remaining scope.

---

## Subtask vs Task Decision Tree

```
Is the task bounded (single scope, < 10 lines)?
  ├── YES → Does it need Themis review or artifact tracking?
  │   ├── NO → Use SUBTASK (fast, lightweight)
  │   └── YES → Use TASK (full artifact cycle)
  └── NO → Use TASK (full orchestration phase)
```

Use subtask as a **performance optimization** — skip ceremony when the risk is low and the scope is narrow.
