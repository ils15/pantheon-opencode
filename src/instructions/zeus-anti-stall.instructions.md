---
description: "Stall detection, phase reminders, delegate retry, and progress checkpoints for Zeus"
name: "Zeus Anti-Stall"
agents: [zeus]
fallback: shared
---

# ANTI-STALL & STALL DETECTION

Proactively detect and recover from stalled states without waiting for user intervention.

## Stall Detection Protocol

| Symptom | Detection Rule | Recovery Action |
|---------|---------------|-----------------|
| Silent loop | 3+ consecutive turns with no tool call AND no visible progress | Output `[STALL_DETECTED]`, re-read task, or escalate with 3 concrete options |
| Delegation black hole | No result or host completion notification after timeout | Stop dependent work; follow `## Timeout & Retry Enforcement` |
| Circular delegation | Same specialist re-dispatched for same task 2+ times without progress | Dispatch to different specialist OR escalate to user |
| Idle after completion | Background tasks completed but no synthesis/next step for 2+ turns | Summarize completed results and propose next action |
| Context thrash | Re-reading same files repeatedly without new action | Stop re-reading and proceed with action |

## Phase Reminder & Delegate Retry

Prefer synchronous `subagent` delegation unless background completion is observable through the host. Do not invoke `task_status`, `cancel_task`, or board methods unless exposed; do not advance dependent work until a result arrives; continue only on non-overlapping independent work.
When a delegation has a transient dispatch failure (timeout, crash, or empty response), check known causes first and allow at most one corrected retry per agent/task. Do not retry a scope refusal or a failed test/validation; reroute only when the correct specialist is clear, otherwise diagnose or escalate.

## Progress Checkpoint

For long-running or multi-phase tasks expected to run > 5 turns only:
- After turn 5: output `[CHECKPOINT] Completed so far: [summary]. Remaining: [list].`
- After turn 10: re-evaluate; if < 50% done, consider splitting or escalating.

## Heartbeat & Checkpoint Integration

Use checkpoints only for long-running or multi-phase work when `context_save` and `context_get` are available. Never add persistence calls for a bounded task.
Save once at a meaningful boundary using `content=JSON.stringify(state)` and an explicit session ID; `state` must be an object with object-valued `phase`/`goal`/`delegations`/`heartbeat` fields and an array `tail`, and omit an unset `goal`. A successful save needs no immediate read. Checkpoints expire after 4h.
Read a checkpoint only when resuming a workflow with a known session ID. Do not retrieve it after every dispatch; carry ordinary handoffs in the task context.
