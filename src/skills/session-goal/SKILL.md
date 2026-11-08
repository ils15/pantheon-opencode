---
name: session-goal
description: "Pin session objectives to prevent scope creep. Use for alignment across long multi-agent sessions."
---

# Session Goal — Alignment Anchor

Use this skill to pin a session objective at the start of a long or complex session. All subsequent todos, delegation decisions, and verification steps must align with the pinned goal.

---

## Usage

Invoke via the `/pantheon-focus` command (a conversation-only goal anchor):

```
/pantheon-focus Implement JWT authentication with refresh token rotation
```

Or state it explicitly at the start of a session:

```
SESSION GOAL: Add product review feature with backend, frontend, and database layers.
All work in this session must serve this goal.
```

---

## What Pinning a Goal Does

1. **Focuses todos** — every todo added must relate to the goal
2. **Focuses delegation** — Zeus only invokes agents relevant to the goal
3. **Focuses verification** — Themis checks that implementations serve the goal
4. **Surfaces drift** — if a task drifts from the goal, flag it before proceeding

## Goal Format

Pin four components — `GOAL`, `SCOPE`, `SUCCESS CRITERIA`, `OUT OF SCOPE`. Full template and worked example: [references/goal-format.md](references/goal-format.md).

---

## Alignment Check Pattern

Before each major delegation or decision, run this quick check:

> "Does this task directly serve the pinned goal?"
> - **Yes** → proceed
> - **Partial** → flag the out-of-scope portion and ask for clarification
> - **No** → defer to a future session, note it as a separate task

---

## Cross-Session Continuity

The V2 plugin does not register the V1 `pantheon_goal_*` tools. `/pantheon-focus`
only anchors the current conversation and must not be described as surviving
compaction or a new session. For multi-phase work that needs persistent
checkpoints, use `/pantheon-deepwork`; otherwise ask before writing a goal to a
project file.

Pantheon does not implement a `/memories/session/` filesystem store. The V1
goal tools are deprecated legacy manual record tools: stored goals are not
automatically continued in the current build. Durable manual goals are
available through the separate Persistence MCP `goal_*` surface in this branch;
do not present it as released or as part of the V2 plugin. `/pantheon-focus`
remains a non-persistent conversation anchor.

---

## When to Update the Goal

- When the user explicitly redirects the session
- When a phase completes and the next phase has a different scope
- When an unexpected blocker changes the scope

Never silently drift from the goal — always confirm with the user before changing it.

---

## Routing

| Action / trigger | Reference |
|---|---|
| Pinning a goal and needing the full template or a worked example | [references/goal-format.md](references/goal-format.md) |
| Deciding whether a follow-up delegation reuses an agent session or starts fresh (reuse criteria, signaling, `task_id` tracking) | [references/session-reuse.md](references/session-reuse.md) |

A missing reference interrupts the action — read nothing in its place, never improvise from memory.
