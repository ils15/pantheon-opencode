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
Phase 0: SCOPING
  └─ Zeus + Athena define scope, phases, acceptance criteria → PLAN.md

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

> ⚠️ Bypasses human review gates. Tier 1 gates (plan, commit, deploy) still require approval.

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
