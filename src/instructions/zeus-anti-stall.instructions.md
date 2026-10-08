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
| Delegation black hole | Agent dispatched but no response after 2x the timeout from routing.yml | Log the hang, cancel via `cancel_task`, then follow the fallback chain in `## ⏱️ Timeout & Retry Enforcement` |
| Circular delegation | Same specialist re-dispatched for same task 2+ times without progress | Break cycle: dispatch to different specialist OR escalate to user |
| Idle after completion | All background tasks completed but no synthesis/next step for 2+ turns | Force synthesis: summarize all completed results and propose next action |
| Context thrash | Re-reading same files repeatedly without new action | Stop re-reading. State: "Already have context on [file]. Proceeding with [action]." |

## Phase Reminder

After dispatching background specialists, you MUST:
1. DO NOT poll running jobs or consume their partial output
2. DO NOT advance dependent work until terminal results arrive
3. Continue orchestration ONLY on non-overlapping independent work
4. If nothing independent remains, briefly report what was launched and WAIT

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

Use **pantheon-persistence** (`checkpoint:<slug>`, 4h TTL), not checkpoint files/scripts.

Check a heartbeat for stale state during long sessions; save one after anti-stall recovery.

### Checkpoint / Pre-Compaction
Checkpoint only long-running or multi-phase work, when context loss is plausible; never add it for a one-off command or bounded fix. Save current phase and remaining tasks before a consequential dispatch and before compaction. Use `context_save` with an object-valued `phase`; see `skill: auto-continue` for the payload. Checkpoints expire after 4h.

### Context Retrieval
For a real next phase, retrieve the latest checkpoint and apply remaining tasks/gotchas; do not create checkpoints just to retrieve context for a bounded task.

### Long-Session Progress
For long-lived multi-phase work, update an existing/requested progress record every 5 turns with completed and pending work and blockers. Do not create STATUS.md for a bounded task.
