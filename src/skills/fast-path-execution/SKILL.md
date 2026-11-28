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

### Execution Guardrails (TRIGGER / VERIFY / ON FAILURE)

Prose cannot fail, so it cannot gate. Each rule below is written in three parts:
the **TRIGGER** that makes it apply, the **VERIFY** command that produces
evidence, and the **ON FAILURE** action. If a rule has no verifier it is not a
rule; if you cannot run the verifier, the gate is decorative and you must not
trust the green it reports.

#### G1 — Never change required status checks or branch protection while `main` is red

- **TRIGGER:** Any edit to required status checks / branch protection, or to a `REQUIRED_CHECKS` constant.
- **VERIFY:** `env -u GITHUB_TOKEN -u GH_TOKEN gh run list --branch main --workflow CI --limit 1 --json conclusion,headSha` — `conclusion` must be `success` and `headSha` must be the current tip of `main`.
- **ON FAILURE:** Revert the protection edit. Land the fix that makes `main` green first, then re-apply. Protection changed on a red `main` freezes every PR until it is reverted.

#### G2 — One worktree per specialist

- **TRIGGER:** Two agents, or two branches, writing concurrently.
- **VERIFY:** Every specialist's receipt carries `git rev-parse --show-toplevel`. Two receipts must never show the same path, and none may show the primary checkout. `node scripts/guardrails.mjs` reports duplicate branches, colliding paths and dirty lanes.
- **ON FAILURE:** Halt the later writer, re-dispatch it into its own worktree (`<project-parent>/.pantheon-worktrees/<repo>/<task>`), and re-verify the commit it claims exists.

#### G3 — Never derive policy from config you do not control

- **TRIGGER:** A gate whose behaviour depends on a file it does not own (`.gitignore`, a user config, `core.hooksPath`, a generated directory).
- **VERIFY:** Prove the gate denies by default with that file absent — a test that runs it with no `.gitignore` / no config and asserts rejection.
- **ON FAILURE:** Move the policy inside the gate (deny-by-default floor), keep the external file as corroboration only, then re-run the absent-file test.

#### G4 — A gate needs a reachability test

- **TRIGGER:** Any hook, workflow, or pre-commit gate.
- **VERIFY:** A test that proves the runner actually invokes it — a temp `git worktree add` plus a real `git commit` for hooks, or the gate's own command inside the workflow for CI. `node scripts/guardrails.mjs` additionally checks that `git rev-parse --git-path hooks` resolves, the directory exists, and `commit-msg` + `pre-commit` are executable.
- **ON FAILURE:** The gate is decorative. Fix the wiring before trusting any green it reports; never stack new assertions on top of an unreached gate.

#### G5 — A complete gate = mapping + message contract + whole file

- **TRIGGER:** Before opening a PR.
- **VERIFY:** (a) run the repo's file→test selector for **every** changed file (`npm run test:slice` / `node scripts/test-slice.mjs`), (b) `npx commitlint --from origin/main --to HEAD`, (c) the **entire** test file that contains any tripped assertion — never a `--test-name-pattern` slice of it.
- **ON FAILURE:** Add the missing file→test mapping or fix the message/contract, then re-run all three. A gate whose slice was never proven is not evidence.

Squash merges make `git branch --merged` useless for cleanup: a squashed head is not an ancestor of `main`, so the merged listing never shows it. Delete branches by the PR's head SHA, not by an ancestry query.

---

## Lean Problem Solving

Applies to every problem, not only bounded micro-edits.

- **One owner per problem.** One specialist owns diagnose → fix → focused verification → PR → merge. No handoff mid-problem.
- **The orchestrator does not re-verify.** The specialist returns a receipt; re-running the same check is duplicate cost, not diligence.
- **Recon only when the specialist cannot gather the fact.** A read-only agent is for broad multi-query discovery — never for reading one file or checking one status.
- **Approval only for irreversible or policy actions.** Gate: npm publish, git tag, branch-protection change, secret change, destructive git. Reversible repo changes (docs, tests, workflow tweaks, dependency refreshes) proceed without a gate.
- **Merge authority is granted up front.** "Merge when green" means the specialist merges its own PR and reports the SHA. Blocking a green PR on a human is a bug.
- **One worktree per specialist, always.** Never two agents in one checkout; path `<project-parent>/.pantheon-worktrees/<repo>/<task>`. The verifier is guardrail **G2**.
- **Batch convergent work.** Two PRs needing the same lockfile/artifact rebuild become one superseding PR, not two fixes.
- **Learn the environment once, gate it never by memory.** Record recurring facts under "Recorded environment facts" instead of rediscovering them per session — but a fact that gates something is not a fact, it is a guardrail: it moves to G1–G5 with a TRIGGER, a VERIFY command and an ON FAILURE action.

Receipt format: `[PASS|FAIL] <cmd> (targets, duration)`, e.g. `[PASS] pytest tests/test_x.py -k test_y (2 tests, 1.4s)`.

### Recorded environment facts

> Facts only. Each line must be checkable by a command, and none of them may
> carry a gate: gates live in G1–G5 above, because a fact cannot fail.

- Ambient `GITHUB_TOKEN`/`GH_TOKEN` lack the `workflow` scope. Run push/PR/merge as `env -u GITHUB_TOKEN -u GH_TOKEN gh ...`; a `.github/workflows/**` edit needs a token that has that scope.
- `AGENTS.md` is generated: edit the project sections in `scripts/build-agents-md.mjs`, then `npm run build:agents-md`.
- Any skill edit requires `npm run skills:lock`; `validate-routing` fails on a stale digest.
