---
name: fast-path-execution
description: "Fast-track and lean execution protocol. Bounded micro-edits (<= 2 files) skip council overhead; every problem gets one owner, no orchestrator re-verification, approval gates only for irreversible actions, and one worktree per specialist."
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
     ├── YES ──► Dispatch directly to Specialist (@hermes / @aphrodite / spawn_ephemeral hotfix)
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
   - Small bug, typo, isolated CSS: dispatch to `@hermes` (or `pantheon_step_ledger(action="spawn_ephemeral", role="hotfix")`).
   - Backend logic, single endpoint: dispatch to `@hermes`.
   - Frontend component, style: dispatch to `@aphrodite`.
3. **Inline Verification:** The specialist runs the sliced test (`test-slicing`), verifies GREEN, and completes the turn without requesting `@themis` review.
4. **Hard Escalation Boundary:** If the fix unexpectedly breaks unrelated tests, touches 3+ files, or uncovers architectural debt, abort Fast-Path immediately and escalate to `@zeus` for Deep-Track orchestration.

---

## Lean Problem Solving

Applies to every problem, not only bounded micro-edits.

- **One owner per problem.** One specialist owns diagnose → fix → focused verification → PR → merge. No handoff mid-problem.
- **The orchestrator does not re-verify.** The specialist returns a receipt; re-running the same check is duplicate cost, not diligence.
- **Recon only when the specialist cannot gather the fact.** A read-only agent is for broad multi-query discovery — never for reading one file or checking one status.
- **Approval only for irreversible or policy actions.** Gate: npm publish, git tag, branch-protection change, secret change, destructive git. Reversible repo changes (docs, tests, workflow tweaks, dependency refreshes) proceed without a gate.
- **Merge authority is granted up front.** "Merge when green" means the specialist merges its own PR and reports the SHA. Blocking a green PR on a human is a bug.
- **One worktree per specialist, always.** Never two agents in one checkout; path `<project-parent>/.pantheon-worktrees/<repo>/<task>`.
- **Batch convergent work.** Two PRs needing the same lockfile/artifact rebuild become one superseding PR, not two fixes.
- **Learn the environment once.** Record recurring facts under "Recorded environment facts" instead of rediscovering them per session.

Receipt format: `[PASS|FAIL] <cmd> (targets, duration)`, e.g. `[PASS] pytest tests/test_x.py -k test_y (2 tests, 1.4s)`.

### Recorded environment facts

- Ambient `GITHUB_TOKEN`/`GH_TOKEN` lack the `workflow` scope. Run push/PR/merge as `env -u GITHUB_TOKEN -u GH_TOKEN gh ...`; a `.github/workflows/**` edit needs a token that has that scope.
- `AGENTS.md` is generated: edit the project sections in `scripts/build-agents-md.mjs`, then `npm run build:agents-md`.
- Any skill edit requires `npm run skills:lock`; `validate-routing` fails on a stale digest.
- Never change required status checks or branch protection while `main` is red — it freezes every PR until reverted.
