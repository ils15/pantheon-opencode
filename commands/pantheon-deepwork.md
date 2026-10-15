---
description: "Start a heavy multi-phase task with persisted checkpoints, phased specialist dispatch, and Themis review gates. Progress saved to .pantheon/deepwork/ for resumability."
agent: "zeus"
---
# /pantheon-deepwork — Heavy Task Workflow

Structured, checkpointed workflow for complex multi-step tasks spanning multiple agents and sessions. Progress persisted to `.pantheon/deepwork/<task-slug>/`. Each phase gated by Themis.

| Use When | Don't Use When |
|---|---|
| 10+ turns or multi-session | Simple fixes (→ @talos) |
| Multi-agent dependencies | Single-file changes (→ /subtask) |
| Costly context loss | < 5 turns (→ normal delegation) |

## Workflow

```
Phase 0: PLAN AND APPROVAL
  └─ @athena returns the complete, detailed Markdown plan to Zeus
  └─ Zeus publishes the full plan as a normal message in the main conversation (not only in the child-agent transcript)
  └─ GATE 1: open the approval UI only after that plan message is visible; never bundle or reverse the two
  └─ If the runtime cannot guarantee that order, ask for approval in plain text after the plan and wait
  └─ Wait for explicit approval or requested changes
  └─ For requested changes, redisplay the entire revised plan and repeat Gate 1
  └─ Do not start discovery or implementation before approval
  └─ After approval, persist the approved plan as PLAN.md through the artifact workflow

Phase 1: DISCOVERY
  └─ @apollo maps relevant codebase areas → DISCOVERY.md

Phase 2-N: IMPLEMENTATION (parallel per phase)
  └─ @hermes, @aphrodite, @demeter, @hephaestus, @prometheus
  └─ Output: IMPL-phase-<N>-<agent>.md

GATE after each phase:
  └─ @themis reviews output → FAIL (fix + resubmit) or PASS (continue)

Phase FINAL: VERIFICATION
  └─ @themis full integration review → REVIEW.md
  └─ All tests pass, coverage >80%
```

## Checkpoints

```
Usage:  --resume <slug> | --status <slug> | --list

.pantheon/deepwork/<slug>/
├── PLAN.md  DISCOVERY.md  IMPL-phase-*-*.md  phase-*-review.md  REVIEW.md  STATUS.md
```

## Full-Auto Mode (`--full-auto`)

> ⚠️ Automates only eligible review gates. Gate 1 and commit/deploy gates still require approval.

`--full-auto` does not hide the plan or skip Gate 1: Zeus still displays the
complete plan in the main conversation and waits for explicit approval before
discovery or implementation. It only affects the later gates described below.

**Themis auto-approves non-blocking reviews** — only stops on **BLOCKING** verdict. No waiting between phases. Checkpoints saved at every boundary.

```
/pantheon-deepwork --full-auto "Refactor auth service to use JWT"
/pantheon-deepwork --full-auto --resume auth-jwt
```

## Anti-Stall

- **Stall Detection** — 3 turns no progress → escalate
- **Phase Reminder** — continue only independent work after dispatch
- **Progress Checkpoint** — every 5 turns, summarize completed vs remaining
- **Delegate Retry** — failures retried once with rephrased prompt

## Usage

```
/pantheon-deepwork "Add user authentication with OAuth2"           # Start new session
/pantheon-deepwork --resume auth-oauth2                            # Resume interrupted
/pantheon-deepwork --status auth-oauth2                            # Show progress
/pantheon-deepwork --list    /pantheon-deepwork --archive <slug>    # List / archive
/pantheon-deepwork --full-auto "Refactor auth"                     # Themis auto-approve
/pantheon-deepwork --full-auto --resume auth-refactor              # Resume full-auto
```

## Safety

- All progress persisted — work is never lost
- Each phase gated by Themis — quality enforced at every step
- Explicit resume required — no auto-continue without intent (unless `--full-auto`)
- `.pantheon/deepwork/` is gitignored — no accidental commits
