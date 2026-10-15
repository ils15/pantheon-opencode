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

Use these detailed recovery rules only for this long-running or multi-phase
workflow. Ordinary tasks do not create checkpoints or dispatch councils by
default.

### Stall Detection

| Symptom | Detection rule | Recovery |
|---|---|---|
| Silent loop | 3+ consecutive turns with no tool call and no visible progress | Output `[STALL_DETECTED]`, re-read the task, then state the next concrete step or ask the user if blocked. |
| Delegation black hole | No response after 2× the configured specialist timeout | Record the hang, cancel the task, then use the canonical fallback chain. |
| Circular delegation | Same specialist is re-dispatched for the same task 2+ times without progress | Choose another configured specialist or escalate. |
| Idle after completion | All background tasks are terminal but there is no synthesis/next step for 2+ turns | Synthesize completed work and state the next step. |
| Context thrash | Same files are repeatedly re-read without new action | Stop rereading and proceed from the evidence already collected. |

### Background Phase Reminder

After dispatching background specialists:

1. Do not poll running jobs or consume partial output.
2. Do not advance dependent work until terminal results arrive.
3. Continue only independent work while tasks run.
4. If nothing independent remains, report the launched work and wait for its
   terminal results.

Self-check every 3 turns: confirm whether a delegate is still running, whether
there is independent work, and whether a dependency is ready.

### Delegate Retry

For a transient dispatch failure (timeout, crash, or empty response), check
known causes and allow at most one corrected retry per agent/task. Do not retry a
scope refusal or a failed test/validation. Reroute only when the right fallback
is clear; otherwise diagnose or escalate. After a corrected retry fails, follow
the canonical fallback chain once and escalate rather than restarting it. See
`## ⏱️ Timeout & Retry Enforcement`.

### Progress Checkpoint

For work expected to exceed five turns:

- After turn 5, report completed work and remaining work.
- After turn 10, re-evaluate progress and whether the work should be split or
  escalated.
- Every 5 turns on a long-lived task, update the existing progress record with
  completed work, pending work, and blockers.

Use persistence checkpoints only when both `context_save` and `context_get` are
available and context loss is plausible. Save once at a meaningful boundary
using `content=JSON.stringify(state)` and an explicit session ID. The decoded
state must be an object with object-valued `phase`/`goal`/`delegations`/
`heartbeat` fields and an array `tail`; omit an unset `goal`. A successful save
needs no immediate read. Retrieve a checkpoint only when resuming a known
session. Do not retrieve it after every dispatch. Do not add checkpoints to
bounded tasks.

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
