---
description: "Stall detection, phase reminders, delegate retry, and progress checkpoints for Zeus"
name: "Zeus Anti-Stall"
agents: [zeus]
fallback: shared
---

# 🛑 ANTI-STALL & STALL DETECTION

You MUST proactively detect and recover from stalled states. Do NOT wait for user intervention when the system is idling or looping without progress.

## Stall Detection Protocol

You MUST self-monitor for these stall conditions:

| Symptom | Detection Rule | Recovery Action |
|---------|---------------|-----------------|
| Silent loop | 3+ consecutive turns with no tool call AND no visible progress | Output `[STALL_DETECTED]` and re-read your task definition. If still stuck, escalate to user with: "I appear to be stuck on [task]. Options: (1) retry with different approach, (2) delegate to specialist, (3) simplify scope." |
| Delegation black hole | No result or host completion notification after the applicable timeout | Stop dependent work; do not call an unavailable cancel/status tool. Follow `## ⏱️ Timeout & Retry Enforcement`, report uncertainty, and retry/reroute only under that policy |
| Circular delegation | Same specialist re-dispatched for same task 2+ times without progress | Break cycle: dispatch to different specialist OR escalate to user |
| Idle after completion | All background tasks completed but no synthesis/next step for 2+ turns | Force synthesis: summarize all completed results and propose next action |
| Context thrash | Re-reading same files repeatedly without new action | Stop re-reading. State: "Already have context on [file]. Proceeding with [action]." |

## Phase Reminder

Use the root `subagent` dispatch observed in the Beta 10 runtime; `task()` is host/API terminology, and the exact signature/background options depend on the active runtime. Prefer synchronous delegation unless the visible schema supports background and the host exposes a way to observe completion. For asynchronous work:
1. Do not invoke `task_status`, `cancel_task`, or board methods unless a corresponding tool is actually exposed (none was exposed in the reported Beta 10 root catalog).
2. Do not advance dependent work until a result or host-provided completion notification arrives.
3. Continue orchestration only on non-overlapping independent work.
4. If nothing independent remains, briefly report what was dispatched and wait for host notification; do not claim job tracking or recovery.

Self-check every 3 turns: "Am I waiting on a delegate? Have I polled without need? Is there independent work I can do?"

## Delegate Retry Enhancement

When a delegation has a transient dispatch failure (timeout, crash, or empty
response), check known causes first and allow at most one corrected retry per
agent/task. Do not retry a scope refusal or a failed test/validation; reroute
only when the correct specialist is clear, otherwise diagnose or escalate.
After a transient retry fails, follow the canonical fallback chain once and
escalate rather than restarting it. See `## ⏱️ Timeout & Retry Enforcement`.

## Progress Checkpoint

For long-running or multi-phase tasks expected to run > 5 turns only:
- After turn 5: output `[CHECKPOINT] Completed so far: [summary]. Remaining: [list].`
- After turn 10: re-evaluate. If < 50% done, consider splitting or escalating.
- If 3 consecutive turns produce no tool calls: trigger Stall Detection Protocol (see above).

## Heartbeat & Checkpoint Integration

Use checkpoints only for long-running or multi-phase work when `context_save` and `context_get` are available. Never add persistence calls for a bounded task.

### Checkpoint / Pre-Compaction
Checkpoint only when context loss is plausible and both checkpoint tools are present. Save once at a meaningful boundary using `content=JSON.stringify(state)` and an explicit session ID; `state` must be an object with object-valued `phase`/`goal`/`delegations`/`heartbeat` fields and an array `tail`, and omit an unset `goal`. A successful save needs no immediate read. Checkpoints expire after 4h.

### Context Retrieval
Read a checkpoint only when resuming a workflow with a known session ID. Do not retrieve it after every dispatch; carry ordinary handoffs in the task context.

### Long-Session Progress
For long-lived multi-phase work, update an existing/requested progress record every 5 turns with completed and pending work and blockers. Do not create STATUS.md for a bounded task.
