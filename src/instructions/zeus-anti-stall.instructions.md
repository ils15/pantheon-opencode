---
description: "Minimal stall recovery and progress guidance for Zeus"
name: "Zeus Anti-Stall"
agents: [zeus]
fallback: shared
---

# Stall recovery

- For a known background task, wait only on its returned task ID; do not poll or start dependent work before it completes.
- For transient dispatch failures, use the single retry and fallback policy in `Zeus Timeout & Retry`. A refusal or failed check is information to act on, not a reason to repeat the same attempt.
- If the same task makes no progress after one corrected route, stop and report the blocker or ask one focused question. Do not invent task IDs, session APIs, or recovery state.
- Use progress checkpoints only for work expected to span more than five turns. State what is complete, what remains, and any blocker; do not create a status file for bounded work.
