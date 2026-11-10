---
name: fast-path-execution
description: "Fast-track execution protocol for bounded micro-edits (<= 2 files). Zero council overhead, direct specialist dispatch, inline verification."
---

# Fast-Path Execution

> **Bounded changes do not require a multi-agent council. Bypass planning, discovery, and review overhead for direct specialist execution with inline verification.**

---

## Eligibility Criteria (Fast-Track)

A task qualifies for the Fast-Path if **ALL** of the following hold:
- **Scope:** Touches $\le 2$ source files and $\le 50$ lines of diff.
- **Risk:** Zero database schema migrations, zero auth/credential changes, zero breaking API contract modifications.
- **Clarity:** The problem and solution are clear (bug fix, typo, CSS adjustment, localized refactor).

If ANY condition is violated, route via **Deep-Track** (Athena planning $\to$ Specialist $\to$ Themis gate).

---

## Fast-Path Protocol

```
User Request
     │
     ▼
[Zeus Assessment: <= 2 files?]
     ├── YES ──► Dispatch directly to Specialist (@talos / @hermes / @aphrodite)
     │                 │
     │                 ▼
     │           [Implement change + Targeted Test Slice]
     │                 │
     │                 ▼
     │           [Test passes?] ── YES ──► Report completion directly to User
     │                 │
     │                NO (unexpected regression)
     │                 │
     ▼                 ▼
[Deep-Track: Council / Athena / Themis Review]
```

---

## Execution Rules

1. **Zero-Council:** Do NOT call `pantheon_jev_decide`, local selector, or Athena planning for an obvious route. Dispatch directly via native `subagent`.
2. **Dedicated Lane:**
   - Small bug, typo, isolated CSS: dispatch to `@talos` (hotfix express lane).
   - Backend logic, single endpoint: dispatch to `@hermes`.
   - Frontend component, style: dispatch to `@aphrodite`.
3. **Inline Verification:** The specialist runs the sliced test (`test-slicing`), verifies GREEN, and completes the turn without requesting `@themis` review.
4. **Hard Escalation Boundary:** If the fix unexpectedly breaks unrelated tests, touches 3+ files, or uncovers architectural debt, abort Fast-Path immediately and escalate to `@zeus` for Deep-Track orchestration.
